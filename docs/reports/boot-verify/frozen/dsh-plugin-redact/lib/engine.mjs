#!/usr/bin/env node
/**
 * zsplice — DSH 会话日志（session.vN.jsonl.zstd）的原地脱敏 / 剪除工具。
 * 默认只输出结构统计，永不打印解码出来的文本。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 格式与不可违背的读取端约束（源码依据：@deepseek-ai/dsh-session-persistence-jsonl
 * 与 dsh-session-format-v1-to-v2 / -v2-to-v3）
 *
 *  1. 文件 = 一串各自独立、各自带校验和的 Zstandard 帧的简单拼接。
 *  2. 第 0 帧只含 1 行：{"type":"session",...} 头部行。
 *  3. 之后每帧 = 一次持久化追加批次 = 1..N 行 JSONL 事件，一行一个事件。
 *  4. **每一行的 seq 必须等于它的 0-based 行号**（v1-to-v2/lib/index.js:243
 *     `if (event.seq !== eventCount) throw ...`；v3 解码器复用同一实现）。
 *     => 删除**中间**任意一行都会让整份日志被判为损坏而拒绝打开。
 *     => 只有「删除末尾若干行」是安全的（引用一律向后指）。
 *  5. 行内不能出现未知字段；未知事件类型必须带 "ignorable": true。
 *  6. 帧边界本身无语义：未触碰的帧可以**原字节保留**。
 *
 * 因此本工具的默认策略是 **原地改写，绝不删行**：
 *   - substitutions / setFields / blankLines 都保持每行的 seq、type、time 不变，
 *     所以密集 seq、surface 引用、tool 调用配对、turn 语法全部不受影响。
 *   - dropLines 仅在两种情况放行：正好是后缀，或显式提供 renumber: true
 *     （后者会重编号并对所有向后引用做重映射，遇到悬空引用会拒绝执行）。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 用法（用 Node 22 运行）：
 *   node zsplice.mjs inspect  <log> [--frames] [--match-file <f> | --match <s>]
 *   node zsplice.mjs paths    <log> --line <n> [--no-keys]
 *   node zsplice.mjs verify   <log>
 *   node zsplice.mjs plan     <log> --plan <plan.json>            # 试算，不写文件
 *   node zsplice.mjs apply    <log> --plan <plan.json> [--out <f>] [--apply]
 *   node zsplice.mjs cut      <log> --drop <spec> [--renumber] [--apply]
 *   node zsplice.mjs graph    <sessionsRoot>
 *
 * <spec> 形如 "812" / "812-830" / "812,900,1024-1100"；行号是逻辑 JSONL 行号（1 = 头部行）。
 *
 * plan.json（字段皆可省略）：
 * {
 *   "substitutions": [ { "find": "原文字", "replace": "[已移除]", "path": "", "lines": "800-900" } ],
 *   "setFields":     [ { "line": 812, "path": "data.message.content.0.text", "value": "[已移除]" } ],
 *   "blankLines":    "812-830",
 *   "dropLines":     "1000-1005",
 *   "renumber":      false,
 *   "keepTorn":      false
 * }
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ============================================================ 常量 / 小工具

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528，与 DSH 一致
const CHECKSUM_OPTIONS = { params: [undefined, undefined] } // 占位，见下方 init
CHECKSUM_OPTIONS.params = { [zlib.constants.ZSTD_c_checksumFlag]: 1 }

/** 绝不允许被改写或清空的键：它们承载结构、顺序与交叉引用。 */
const PROTECTED_KEYS = new Set([
  'type',
  'seq',
  'time',
  'surfaceOp',
  'sourceEventSeqs',
  'toolCallId',
  'callId',
  'role',
  'id',
])

/** 引擎级拒绝：抛出而不是 process.exit —— 插件与 CLI 跑在同一个进程里，
 *  直接退出会连宿主一起杀掉。退出码由 CLI 顶层统一处理。 */
export class RedactError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RedactError'
  }
}

const die = (msg) => {
  throw new RedactError(msg)
}

/** JSON.parse 的报错在 Node 20+ 会带上输入片段；这里剥掉，避免任何文本泄漏。 */
const safeJsonError = (err) => {
  const raw = String(err && err.message ? err.message : err)
  const pos = raw.match(/position (\d+)/)
  if (pos) return `JSON 解析失败（position ${pos[1]}）`
  return `JSON 解析失败（${raw.split(/["'`]/)[0].trim().slice(0, 48)}）`
}

// ======================================================= 帧扫描（复刻 DSH 逻辑）

export function scanFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`帧魔数非法 @ 字节 ${offset}（不是本格式或已损坏）`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`帧头保留位被置位 @ 字节 ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`块类型保留值 @ 字节 ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

export const decodeFrame = (buffer, range) => zlib.zstdDecompressSync(buffer.subarray(range.start, range.end))

/** 把明文按 0x0A 切成行切片（start/end 为帧内明文偏移）。 */
export function splitLines(buf) {
  const out = []
  let from = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push({ start: from, end: i + 1, newline: true })
      from = i + 1
    }
  }
  if (from < buf.length) out.push({ start: from, end: buf.length, newline: false })
  return out
}

// ============================================================== 行号 / 路径

function specToSet(spec, total) {
  const set = new Set()
  const items = Array.isArray(spec) ? spec.flatMap((s) => String(s).split(',')) : String(spec).split(',')
  for (const item of items) {
    const p = item.trim()
    if (!p) continue
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(p)
    if (!m) die(`行号片段无法解析: ${p}`)
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    if (a < 1 || b < a) die(`行号区间非法: ${p}`)
    if (b > total) die(`行号 ${b} 超出总行数 ${total}`)
    for (let i = a; i <= b; i++) set.add(i)
  }
  return set
}

const pathParts = (p) => (p === '' || p === undefined ? [] : String(p).split('.').filter((s) => s !== ''))

function getAt(root, parts) {
  let cur = root
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return { found: false }
    if (Array.isArray(cur)) {
      const i = Number(part)
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { found: false }
      cur = cur[i]
    } else {
      if (!Object.hasOwn(cur, part)) return { found: false }
      cur = cur[part]
    }
  }
  return { found: true, value: cur }
}

function setAt(root, parts, value) {
  if (parts.length === 0) die('setFields[].path 不能为空')
  if (PROTECTED_KEYS.has(parts[parts.length - 1])) {
    die(`不允许改写结构键 ${parts[parts.length - 1]}（会破坏 seq/类型/交叉引用）`)
  }
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (cur === null || typeof cur !== 'object') return false
    if (Array.isArray(cur)) {
      const n = Number(part)
      if (!Number.isInteger(n) || n < 0 || n >= cur.length) return false
      cur = cur[n]
    } else {
      if (!Object.hasOwn(cur, part)) return false
      cur = cur[part]
    }
  }
  const last = parts[parts.length - 1]
  if (Array.isArray(cur)) {
    const n = Number(last)
    if (!Number.isInteger(n) || n < 0 || n >= cur.length) return false
    cur[n] = value
    return true
  }
  if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, last)) return false
  cur[last] = value
  return true
}

/** 递归处理所有字符串值；path 前缀限定；PROTECTED_KEYS 下的字符串一律跳过。 */
function walkStrings(node, trail, visit) {
  if (typeof node === 'string') return visit(node, trail)
  if (Array.isArray(node)) return node.map((v, i) => walkStrings(v, [...trail, String(i)], visit))
  if (node !== null && typeof node === 'object') {
    const out = {}
    for (const k of Object.keys(node)) {
      if (PROTECTED_KEYS.has(k) || (trail.length > 0 && PROTECTED_KEYS.has(trail[trail.length - 1]))) {
        out[k] = node[k]
        continue
      }
      out[k] = walkStrings(node[k], [...trail, k], visit)
    }
    return out
  }
  return node
}

const underPath = (trail, limit) => limit.length === 0 || limit.every((seg, i) => trail[i] === seg)

// ============================================================== 逻辑行视图

export function loadLog(file) {
  const buffer = fs.readFileSync(file)
  const { frames, tornStart } = scanFrames(buffer)
  const frameViews = []
  const index = new Map()
  let logical = 0
  for (let fi = 0; fi < frames.length; fi++) {
    const range = frames[fi]
    let plain
    try {
      plain = decodeFrame(buffer, range)
    } catch (err) {
      die(`第 ${fi} 帧解码/校验和失败（字节 ${range.start}-${range.end}）: ${err.message}`)
    }
    const lines = splitLines(plain).map((l) => {
      logical += 1
      index.set(logical, { frame: fi, start: l.start, end: l.end, newline: l.newline })
      return { logical, ...l }
    })
    frameViews.push({ range, plain, lines, checksum: (buffer.readUInt8(range.start + 4) & 4) !== 0 })
  }
  return { buffer, frames, tornStart, frameViews, index, totalLines: logical }
}

// ================================================================ 手术引擎

/** 把向后引用重映射到删除后的新 seq；引用被删行即视为悬空。 */
function remapRefs(row, deltaOf, dropped, where) {
  // seq 是「事件行自 0 起」的编号，对应文件里的 行号-1
  const map = (v) => {
    if (!Number.isInteger(v) || v < 0) return v
    if (dropped.has(v + 1)) {
      die(`${where} 引用了被删除的第 ${v + 2} 行（seq ${v}）：请改用 blankLines 原地清空该行，而不是删除它`)
    }
    return v - deltaOf(v + 1)
  }
  let changed = false
  const so = row.surfaceOp
  if (so !== null && typeof so === 'object' && so.op === 'replace') {
    const s = map(so.startSeq)
    const e = map(so.endSeq)
    if (s !== so.startSeq || e !== so.endSeq) {
      row.surfaceOp = { ...so, startSeq: s, endSeq: e }
      changed = true
    }
  }
  if (Array.isArray(row.sourceEventSeqs)) {
    const next = row.sourceEventSeqs.map(map)
    if (next.some((v, i) => v !== row.sourceEventSeqs[i])) {
      row.sourceEventSeqs = next
      changed = true
    }
  }
  const d = row.data
  if (d !== null && typeof d === 'object') {
    if (Array.isArray(d.shadowedSeqs)) {
      const next = d.shadowedSeqs.map(map)
      if (next.some((v, i) => v !== d.shadowedSeqs[i])) {
        d.shadowedSeqs = next
        changed = true
      }
    }
    if (d.shadowedRange !== null && typeof d.shadowedRange === 'object') {
      const r = d.shadowedRange
      const s = Number.isInteger(r.start) ? map(r.start) : r.start
      const e = Number.isInteger(r.end) ? map(r.end) : r.end
      if (s !== r.start || e !== r.end) {
        d.shadowedRange = { ...r, start: s, end: e }
        changed = true
      }
    }
  }
  return changed
}

/**
 * @returns {{out: Buffer, stats: object, notes: string[]}}
 */
export function applyPlan(buffer, plan) {
  const { frames, tornStart } = scanFrames(buffer)
  const framePlains = frames.map((r) => decodeFrame(buffer, r))
  const lines = []
  for (let fi = 0; fi < framePlains.length; fi++) {
    for (const l of splitLines(framePlains[fi])) lines.push({ frame: fi, ...l })
  }
  const total = lines.length
  if (total === 0) die('日志里没有任何完整行')

  const rawOf = (i) => framePlains[lines[i].frame].subarray(lines[i].start, lines[i].end).toString('utf8').replace(/\n$/, '')
  const parseRow = (i) => {
    try {
      return JSON.parse(rawOf(i))
    } catch (err) {
      die(`第 ${i + 1} 行不是合法 JSON，无法改写: ${safeJsonError(err)}`)
    }
  }

  // ---- 计划解析
  const dropSet = plan.dropLines === undefined ? new Set() : specToSet(plan.dropLines, total)
  const blankSet = plan.blankLines === undefined ? new Set() : specToSet(plan.blankLines, total)
  if (dropSet.has(1) || blankSet.has(1)) die('不能删除或清空第 1 行（头部），否则整份日志不可读')

  const setByLine = new Map()
  for (const e of plan.setFields ?? []) {
    if (!Number.isInteger(e.line) || e.line < 1 || e.line > total) die(`setFields[].line 非法: ${e.line}`)
    if (e.line === 1) die('不允许改写第 1 行（头部）')
    if (!setByLine.has(e.line)) setByLine.set(e.line, [])
    setByLine.get(e.line).push(e)
  }
  const subs = (plan.substitutions ?? []).map((s) => {
    if (typeof s.find !== 'string' || s.find.length === 0) die('substitutions[].find 必须是非空字符串')
    return {
      find: s.find,
      replace: s.replace ?? '',
      limit: pathParts(s.path),
      lines: s.lines === undefined ? null : specToSet(s.lines, total),
    }
  })

  // ---- 删除合法性判定
  const dropIdx = new Set([...dropSet].map((n) => n - 1))
  const notes = []
  let deltaOf = () => 0
  if (dropIdx.size > 0) {
    const sorted = [...dropIdx].sort((a, b) => a - b)
    const isSuffix = sorted.every((v, i) => v === total - sorted.length + i)
    if (!isSuffix && plan.renumber !== true) {
      die(
        '拒绝执行：删除中间行会让每行 seq 不再等于自己的行号，读取端会判定整份日志损坏（seq gap）。\n' +
          '      要抹掉内容请改用 blankLines（原地清空该行全部文本，结构不变）或 substitutions/setFields；\n' +
          '      确实要删除请加 "renumber": true，本工具会重编号并重映射所有向后引用（遇到悬空引用仍会拒绝）。',
      )
    }
    const prefix = new Array(total)
    let acc = 0
    for (let i = 0; i < total; i++) {
      prefix[i] = acc
      if (dropIdx.has(i)) acc += 1
    }
    deltaOf = (seq) => (Number.isInteger(seq) && seq >= 0 && seq < total ? prefix[seq] : 0)
    if (!isSuffix) notes.push('已启用 renumber：所有行的 seq 与向后引用都已按删除量重映射')
    notes.push(`将删除 ${dropIdx.size} 行${isSuffix ? '（后缀，安全）' : '（中间，已重编号）'}`)
  }

  const touchedLines = new Set([...dropSet, ...blankSet, ...setByLine.keys()])
  for (const s of subs) {
    if (s.lines) {
      for (const n of s.lines) touchedLines.add(n)
    } else {
      // 全局替换：必须把每个事件行都标记为「可能改动」，否则整帧会被原样保留，
      // 替换会静默失效（第 1 行是头部，永不参与）。
      for (let n = 2; n <= total; n++) touchedLines.add(n)
    }
  }

  // ---- 逐帧重建
  const stats = { dropped: 0, blanked: 0, setFields: 0, substitutions: 0, renumbered: 0, rewrittenFrames: 0, keptFrames: 0, removedFrames: 0 }
  const chunks = []
  for (let fi = 0; fi < frames.length; fi++) {
    const frameLines = lines.map((l, i) => ({ ...l, idx: i })).filter((l) => l.frame === fi)
    const touched = frameLines.some((l) => touchedLines.has(l.idx + 1) || (dropIdx.size > 0 && plan.renumber === true && l.idx >= Math.min(...dropIdx)))
    if (!touched) {
      chunks.push(buffer.subarray(frames[fi].start, frames[fi].end))
      stats.keptFrames += 1
      continue
    }
    const parts = []
    for (const l of frameLines) {
      const logical = l.idx + 1
      if (dropIdx.has(l.idx)) {
        stats.dropped += 1
        continue
      }
      const edits = setByLine.get(logical)
      const lineSubs = subs.filter((s) => s.lines === null || s.lines.has(logical))
      const blank = blankSet.has(logical)
      const needsRenumber = dropIdx.size > 0 && plan.renumber === true
      if (edits === undefined && lineSubs.length === 0 && !blank && !needsRenumber) {
        parts.push(framePlains[fi].subarray(l.start, l.end))
        continue
      }
      let row = parseRow(l.idx)
      let changed = false

      for (const e of edits ?? []) {
        const parts2 = pathParts(e.path)
        if (!getAt(row, parts2).found) die(`第 ${logical} 行上找不到路径 ${e.path}（用 paths 子命令查看结构）`)
        if (!setAt(row, parts2, e.value)) die(`第 ${logical} 行路径 ${e.path} 写入失败`)
        stats.setFields += 1
        changed = true
      }

      if (lineSubs.length > 0) {
        for (const s of lineSubs) {
          let hits = 0
          row = walkStrings(row, [], (str, trail) => {
            if (!underPath(trail, s.limit)) return str
            if (!str.includes(s.find)) return str
            hits += str.split(s.find).length - 1
            return str.split(s.find).join(s.replace)
          })
          stats.substitutions += hits
          if (hits > 0) changed = true
        }
      }

      if (blank) {
        const ph = typeof plan.blankPlaceholder === 'string' ? plan.blankPlaceholder : '[已移除]'
        row = walkStrings(row, [], () => ph)
        stats.blanked += 1
        changed = true
      }

      if (needsRenumber) {
        // seq 是「事件行自 0 起」的编号，对应 行号-1；头部行不参与
        const oldSeq = row.seq
        row.seq = l.idx - 1 - deltaOf(l.idx)
        if (row.seq !== oldSeq) {
          stats.renumbered += 1
          changed = true
        }
        if (remapRefs(row, deltaOf, dropIdx, `第 ${logical} 行`)) changed = true
      }

      parts.push(changed ? Buffer.from(JSON.stringify(row) + '\n', 'utf8') : framePlains[fi].subarray(l.start, l.end))
    }
    if (parts.length === 0) {
      stats.removedFrames += 1
      continue
    }
    chunks.push(zlib.zstdCompressSync(Buffer.concat(parts), CHECKSUM_OPTIONS))
    stats.rewrittenFrames += 1
  }

  const tornKept = plan.keepTorn === true
  if (tornStart !== undefined && tornKept) chunks.push(buffer.subarray(tornStart))

  const out = Buffer.concat(chunks)
  const check = inspectBuffer(out)
  if (check.parseErrors !== 0 || !check.headerOk || check.fatal !== undefined) {
    die(`内部自检失败，已放弃输出（${check.fatal ?? `解析失败 ${check.parseErrors} 行`}）`)
  }
  // 密集 seq 自检：这是读取端最硬的一条约束
  const seqProblems = checkSeqDensity(out)
  if (seqProblems !== null) die(`内部自检失败：${seqProblems}`)

  return { out, stats, notes, tornStart, tornKept }
}

/** 逐行检查 seq === 行号（0-based），返回首个问题的描述或 null。 */
export function checkSeqDensity(buffer) {
  const { frames } = scanFrames(buffer)
  let i = 0
  for (const r of frames) {
    let plain
    try {
      plain = decodeFrame(buffer, r)
    } catch {
      return `帧解码失败`
    }
    for (const l of splitLines(plain)) {
      let row
      try {
        row = JSON.parse(plain.subarray(l.start, l.end).toString('utf8'))
      } catch {
        return `第 ${i + 1} 行不是合法 JSON`
      }
      if (i > 0 && row.seq !== i - 1) return `第 ${i + 1} 行的 seq 是 ${row.seq}，应为 ${i - 1}（读取端会判定为损坏）`
      i += 1
    }
  }
  return null
}

/** 结构自检：只返回统计，不返回文本。 */
export function inspectBuffer(buffer) {
  const { frames, tornStart } = scanFrames(buffer)
  let lines = 0
  let parseErrors = 0
  let headerOk = false
  let noNewlineTail = 0
  const checksumFrames = frames.filter((r) => (buffer.readUInt8(r.start + 4) & 4) !== 0).length
  for (let fi = 0; fi < frames.length; fi++) {
    let plain
    try {
      plain = decodeFrame(buffer, frames[fi])
    } catch {
      return { frames: frames.length, tornStart, lines, parseErrors: parseErrors + 1, headerOk, noNewlineTail, checksumFrames, fatal: `帧 ${fi} 解码失败` }
    }
    for (const l of splitLines(plain)) {
      lines += 1
      if (!l.newline) noNewlineTail += 1
      try {
        const obj = JSON.parse(plain.subarray(l.start, l.end).toString('utf8'))
        if (lines === 1) headerOk = !!obj && obj.type === 'session' && typeof obj.id === 'string'
      } catch {
        parseErrors += 1
      }
    }
  }
  return { frames: frames.length, tornStart, lines, parseErrors, headerOk, noNewlineTail, checksumFrames }
}

// ============================================================== 结构打印

function describe(node, trail, out, showKeys) {
  const p = trail.join('.') || '(根)'
  if (typeof node === 'string') out.push(`${p}  =  string(len=${node.length})`)
  else if (typeof node === 'number') out.push(`${p}  =  number`)
  else if (typeof node === 'boolean' || node === null) out.push(`${p}  =  ${String(node)}`)
  else if (Array.isArray(node)) {
    out.push(`${p}  =  array(len=${node.length})`)
    if (node.length > 0) describe(node[0], [...trail, '0'], out, showKeys)
  } else if (typeof node === 'object') {
    const keys = Object.keys(node)
    out.push(`${p}  =  object(${showKeys ? keys.join(', ') : 'keys=' + keys.length})`)
    for (const k of keys) describe(node[k], [...trail, k], out, showKeys)
  }
}

// ==================================================================== 命令

function cmdInspect(args) {
  const file = args._[0] ?? die('缺少日志路径')
  const log = loadLog(file)
  console.log(`文件           : ${path.resolve(file)}`)
  console.log(`字节数         : ${log.buffer.length}`)
  console.log(`完整帧数       : ${log.frames.length}`)
  console.log(`尾部残帧起点   : ${log.tornStart === undefined ? '无' : log.tornStart + ' 字节处（读取端会自动修复）'}`)
  console.log(`逻辑总行数     : ${log.totalLines}（第 1 行 = 头部；事件行 seq 应等于其行号-1）`)
  console.log(`无校验和的帧   : ${log.frameViews.filter((f) => !f.checksum).length}`)
  if (args.frames) {
    console.log('')
    console.log('帧号   字节区间              明文字节   行数  逻辑行区间')
    for (let i = 0; i < log.frameViews.length; i++) {
      const f = log.frameViews[i]
      const first = f.lines.length ? f.lines[0].logical : 0
      const last = f.lines.length ? f.lines[f.lines.length - 1].logical : 0
      console.log(
        `${String(i).padStart(4)}   ${String(f.range.start + '-' + f.range.end).padEnd(18)}  ` +
          `${String(f.plain.length).padStart(8)}   ${String(f.lines.length).padStart(4)}  ${first}-${last}`,
      )
    }
  }
  const matchSpec = args['match-file'] ?? args.match
  if (typeof matchSpec === 'string') {
    const needle = fs.existsSync(matchSpec) ? fs.readFileSync(matchSpec, 'utf8').replace(/\r?\n$/, '') : matchSpec
    if (needle.length === 0) die('匹配串为空')
    const needleBuf = Buffer.from(needle, 'utf8')
    const hits = []
    const byFrame = new Map()
    for (let fi = 0; fi < log.frameViews.length; fi++) {
      for (const l of log.frameViews[fi].lines) {
        if (log.frameViews[fi].plain.subarray(l.start, l.end).includes(needleBuf)) {
          hits.push(l.logical)
          byFrame.set(fi, (byFrame.get(fi) ?? 0) + 1)
        }
      }
    }
    console.log('')
    console.log(`命中行数       : ${hits.length}`)
    console.log(`命中行号       : ${hits.join(',') || '-'}`)
    console.log(`涉及帧         : ${[...byFrame.entries()].map(([k, v]) => `${k}(${v})`).join(' ') || '-'}`)
  }
}

function cmdPaths(args) {
  const file = args._[0] ?? die('缺少日志路径')
  const line = Number(args.line ?? die('缺少 --line <n>'))
  const log = loadLog(file)
  const loc = log.index.get(line) ?? die(`行号 ${line} 不存在`)
  const view = log.frameViews[loc.frame]
  const raw = view.plain.subarray(loc.start, loc.end).toString('utf8').replace(/\n$/, '')
  let obj
  try {
    obj = JSON.parse(raw)
  } catch (err) {
    die(`第 ${line} 行不是合法 JSON: ${safeJsonError(err)}`)
  }
  const out = []
  describe(obj, [], out, args['no-keys'] !== true)
  console.log(`行 ${line}（帧 ${loc.frame}，字节 ${raw.length}）的结构（只列路径与类型，不列值）：`)
  for (const l of out) console.log('  ' + l)
}

function cmdVerify(args) {
  const file = args._[0] ?? die('缺少日志路径')
  const buf = fs.readFileSync(file)
  const r = inspectBuffer(buf)
  const seq = r.fatal === undefined ? checkSeqDensity(buf) : null
  console.log(`文件           : ${path.resolve(file)}`)
  console.log(`完整帧数       : ${r.frames}`)
  console.log(`带校验和的帧   : ${r.checksumFrames}`)
  console.log(`尾部残帧起点   : ${r.tornStart === undefined ? '无' : r.tornStart + ' 字节处'}`)
  console.log(`总行数         : ${r.lines}`)
  console.log(`JSON 解析失败  : ${r.parseErrors}`)
  console.log(`seq 密集性     : ${seq === null ? '通过（seq 等于行号-1）' : seq}`)
  console.log(`首行是合法头部 : ${r.headerOk ? '是' : '否'}`)
  const ok = r.parseErrors === 0 && r.headerOk && r.fatal === undefined && seq === null
  console.log(`结论           : ${ok ? '结构自洽，读取端可打开' : '存在问题：' + (r.fatal ?? seq ?? '见上')}`)
  process.exit(ok ? 0 : 2)
}

function readPlan(args) {
  const pf = args.plan ?? die('缺少 --plan <plan.json>')
  try {
    return JSON.parse(fs.readFileSync(pf, 'utf8'))
  } catch (err) {
    die(`plan 文件不是合法 JSON: ${safeJsonError(err)}`)
  }
}

function cmdPlan(args) {
  const file = args._[0] ?? die('缺少日志路径')
  const plan = readPlan(args)
  plan.keepTorn = plan.keepTorn ?? args['keep-torn'] === true
  const buffer = fs.readFileSync(file)
  const { out, stats, notes } = applyPlan(buffer, plan)
  console.log('试算结果（未写任何文件）')
  console.log(`字节 原 / 新   : ${buffer.length} / ${out.length}`)
  console.log(`保留帧(原字节) : ${stats.keptFrames}`)
  console.log(`重写帧 / 移除帧: ${stats.rewrittenFrames} / ${stats.removedFrames}`)
  console.log(`删除行 / 清空行: ${stats.dropped} / ${stats.blanked}`)
  console.log(`路径改写 / 替换: ${stats.setFields} / ${stats.substitutions}`)
  console.log(`重编号行数     : ${stats.renumbered}`)
  for (const n of notes) console.log(`提示           : ${n}`)
  console.log('自检           : 通过（JSON 全部可解析、头部合法、seq 密集）')
}

function cmdApply(args) {
  const file = args._[0] ?? die('缺少日志路径')
  const plan = readPlan(args)
  plan.keepTorn = plan.keepTorn ?? args['keep-torn'] === true
  const buffer = fs.readFileSync(file)
  const { out, stats, notes } = applyPlan(buffer, plan)
  const target = typeof args.out === 'string' ? args.out : file + '.new'
  fs.writeFileSync(target, out)
  console.log(`原文件 / 新文件: ${path.resolve(file)}`)
  console.log(`               : ${path.resolve(target)}`)
  console.log(`字节 原 / 新   : ${buffer.length} / ${out.length}`)
  console.log(`保留帧 / 重写帧: ${stats.keptFrames} / ${stats.rewrittenFrames}（移除 ${stats.removedFrames}）`)
  console.log(`删除 / 清空    : ${stats.dropped} / ${stats.blanked} 行`)
  console.log(`路径改写 / 替换: ${stats.setFields} / ${stats.substitutions}`)
  console.log(`重编号行数     : ${stats.renumbered}`)
  for (const n of notes) console.log(`提示           : ${n}`)
  if (args.apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${file}.quarantine-${stamp}`
    fs.copyFileSync(file, backup)
    fs.renameSync(target, file)
    console.log(`隔离备份       : ${path.resolve(backup)}`)
    console.log('已就地替换     : 是')
    console.log('注意           : 隔离备份仍含原文；确认无误后请自行删除它')
  } else {
    console.log('已就地替换     : 否（先检查 .new，确认后再加 --apply）')
  }
}

function cmdCut(args) {
  const file = args._[0] ?? die('缺少日志路径')
  const plan = { dropLines: args.drop ?? die('缺少 --drop <行号>') }
  if (args.renumber === true) plan.renumber = true
  if (args['keep-torn'] === true) plan.keepTorn = true
  const buffer = fs.readFileSync(file)
  const { out, stats, notes } = applyPlan(buffer, plan)
  const target = typeof args.out === 'string' ? args.out : file + '.new'
  fs.writeFileSync(target, out)
  console.log(`字节 原 / 新   : ${buffer.length} / ${out.length}`)
  console.log(`删除行         : ${stats.dropped}（重编号 ${stats.renumbered}）`)
  for (const n of notes) console.log(`提示           : ${n}`)
  if (args.apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${file}.quarantine-${stamp}`
    fs.copyFileSync(file, backup)
    fs.renameSync(target, file)
    console.log(`隔离备份       : ${path.resolve(backup)}`)
    console.log('已就地替换     : 是')
  } else {
    console.log(`输出           : ${path.resolve(target)}（加 --apply 才就地替换）`)
  }
}

function cmdGraph(args) {
  const root = args._[0] ?? die('缺少 sessions 根目录')
  const rows = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^session(\.v\d+)?\.jsonl\.zstd$/.test(e.name)) rows.push(p)
    }
  }
  walk(root)
  console.log('id                                     parent                                 seeded  origin     depth  文件')
  for (const p of rows) {
    try {
      const buf = fs.readFileSync(p)
      const { frames } = scanFrames(buf, 1)
      if (frames.length === 0) continue
      const plain = decodeFrame(buf, frames[0])
      const nl = plain.indexOf(0x0a)
      const h = JSON.parse(plain.subarray(0, nl === -1 ? plain.length : nl).toString('utf8'))
      console.log(
        `${String(h.id).padEnd(38)} ${String(h.parentSession ?? '').padEnd(38)} ` +
          `${String(h.isSeeded === true).padEnd(7)} ${String(h.origin ?? '-').padEnd(10)} ` +
          `${String(h.delegationDepth).padStart(5)}  ${p}`,
      )
    } catch (err) {
      console.log(`(头部读取失败) ${p} → ${err.message}`)
    }
  }
}

// ===================================================================== CLI

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else {
        args[key] = next
        i += 1
      }
    } else args._.push(a)
  }
  return args
}

export function main() {
  try {
    runCli()
  } catch (err) {
    console.error(`错误: ${err && err.message ? err.message : err}`)
    process.exit(1)
  }
}

function runCli() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  switch (command) {
    case 'inspect':
      cmdInspect(args)
      break
    case 'paths':
      cmdPaths(args)
      break
    case 'verify':
      cmdVerify(args)
      break
    case 'plan':
      cmdPlan(args)
      break
    case 'apply':
      cmdApply(args)
      break
    case 'cut':
      cmdCut(args)
      break
    case 'graph':
      cmdGraph(args)
      break
    default:
      console.log(
        [
          'zsplice — DSH 会话日志原地脱敏 / 剪除',
          '',
          '  inspect <log> [--frames] [--match-file <f>]   结构 / 命中行定位（不打印文本）',
          '  paths   <log> --line <n> [--no-keys]          某行的 JSON 结构（只有路径与类型）',
          '  verify  <log>                                 结构 + seq 密集性自检',
          '  plan    <log> --plan <plan.json>              试算，不写文件',
          '  apply   <log> --plan <plan.json> [--apply]    执行（默认写 <log>.new）',
          '  cut     <log> --drop <行号> [--renumber]      删行（中间行必须加 --renumber）',
          '  graph   <sessionsRoot>                        各会话头部谱系',
          '',
          '核心约束：每行 seq 必须等于它的行号-1，所以「删除中间行」会让整份日志打不开。',
          '要抹掉内容请优先用 blankLines / substitutions / setFields（原地改写，结构不变）。',
        ].join('\n'),
      )
      process.exit(command === undefined ? 0 : 1)
  }
}

const invokedDirectly = (() => {
  try {
    if (process.argv[1] === undefined) return false
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
  } catch {
    return false
  }
})()
if (invokedDirectly) main()

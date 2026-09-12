/**
 * dsh-plugin-redact — 在 dsh-tui 内原地脱敏 / 回退 DSH 会话日志。
 *
 * 设计约束（全部由读取端源码决定，改代码前请先读 lib/engine.mjs 顶部注释）：
 *   - 会话日志是「独立校验和 zstd 帧」的拼接，第 0 帧只有 header 行。
 *   - 每一行的 seq 必须等于它的行号-1（v1-to-v2/lib/index.js:243）。因此
 *     **删除中间行 = 整份日志打不开**；脱敏的正解是「原地改写，行数不变」。
 *   - 原地改写保持行数、类型、seq、交叉引用全部不变，所以对读取端是透明的。
 *
 * 安全默认：
 *   - 绝不打印被处理的文本（只输出行号与计数）。
 *   - 默认拒绝改写在用的当前会话（写句柄仍持有着它），除非显式 --allow-live。
 *   - 就地替换前先写隔离备份 *.quarantine-<时间戳>。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { applyPlan, inspectBuffer, checkSeqDensity, scanFrames, decodeFrame, splitLines, loadLog, verifyLog } from './lib/engine.mjs'

export const name = 'dsh-redact'
/** 只消费 commands 服务，不发布任何服务，因此不需要 isolate realm。 */
export const inject = ['commands']

/** scan 最多列出多少个命中行号（渲染端总共只有 200 格，列多了会挤掉后面的提示）。 */
const OUTPUT_LIMIT = 8
/**
 * 命令结果的渲染上限：dsh-tui 用 cleanRenderText(text, COMMAND_RESULT_CELLS=200)
 * （lib/types/dsh-adapter/sanitize.js）把结果**压成单行**并按 200 显示格截断。
 * 也就是说：换行会被吃掉、超出部分直接被砍。
 * ⇒ 所有面向用户的输出都必须「短 + 重要信息在前」，不能依赖多行排版。
 */
const RESULT_CELLS = 200
/** 估算显示格宽：CJK / 全角按 2 格。 */
const cells = (s) => {
  let n = 0
  for (const ch of s) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return n
}

/** 把一段文本按显示格预算截断，超出部分用 … 收尾（自己截比被渲染端乱砍好）。 */
const clamp = (s, budget = RESULT_CELLS) => {
  // 预算 <= 0 表示「一点都不显示」。必须在这里短路：否则循环第一步就 break，
  // 会返回一个只剩 '…' 的字符串 —— argsCells: 0 关不掉命令行就是这个原因。
  if (budget <= 0) return ''
  if (cells(s) <= budget) return s
  let out = ''
  for (const ch of s) {
    if (cells(out + ch) > budget - 1) break
    out += ch
  }
  return out + '…'
}

/** 统一的返回收敛：保证任何一条输出都不会被渲染端截断在关键信息之前。
 *  handler 可能是 async（pick 走对话框），所以要能穿透 Promise。 */
const clampResult = (r) =>
  r !== null && typeof r === 'object' && typeof r.then === 'function'
    ? r.then(clampResult)
    : r !== null && typeof r === 'object' && typeof r.text === 'string'
      ? { ...r, text: clamp(r.text) }
      : r

const humanBytes = (n) => (n < 0 ? '?' : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`)

/** 压成单行并截断到显示格预算（只用于元数据；控制字符一律换成空格）。 */
function oneLine(s, maxCells = 120) {
  const flat = String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clamp(flat, maxCells)
}

/**
 * 收集当前会话 surface 上的 tool/result 节点，最新在前。
 * 只产出**元数据**：行号 / 轮次 / 工具名 / 体积 / 工具调用的命令行（截断）。
 * 绝不产出结果正文——但命令行是「认出这是哪一条」的关键，且通常本身不敏感。
 */
function collectNodes(session, argsCells = 120) {
  const surface = session.surface
  if (surface === undefined || surface.nodes === undefined) return { error: '当前会话没有可用的 surface' }
  // tool/result 事件不带工具名与命令行，用 message.source.callId 去 tool/call 事件里对出来
  const callInfo = new Map()
  const lastSeq = typeof session.seq === 'number' ? session.seq : 0
  for (let i = 0; i <= lastSeq; i++) {
    const ev = session.eventAt(i)
    if (ev !== undefined && ev.type === 'tool/call' && typeof ev.data?.callId === 'string') {
      callInfo.set(ev.data.callId, {
        name: ev.data.name,
        args: typeof ev.data.arguments === 'string' ? ev.data.arguments : '',
      })
    }
  }
  const items = []
  for (const seq of [...surface.nodes]) {
    const event = session.eventAt(seq)
    if (event === undefined || event.type !== 'tool/result') continue
    let bytes = -1
    try {
      bytes = JSON.stringify(event.data.message).length
    } catch {
      bytes = -1
    }
    const info = callInfo.get(event.data?.message?.source?.callId)
    items.push({
      line: seq + 2,
      seq,
      bytes,
      // 轮次直接来自 tool/result 事件本身，用它把「第几条」和你在界面上看到的对话对起来
      turn: typeof event.data?.turn === 'number' ? event.data.turn : undefined,
      tool: info?.name ?? '(未知工具)',
      args: info?.args && argsCells > 0 ? oneLine(info.args, argsCells) : '',
    })
  }
  items.sort((a, b) => b.seq - a.seq)
  return { items }
}

const dshHome = () => process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** 在 <root>/<project>/<sessionId>/ 下选出编号最高的 canonical 日志。 */
function resolveLog(root, sessionId) {
  if (!fs.existsSync(root)) return { error: `会话根目录不存在: ${root}` }
  const hits = []
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const dir = path.join(root, project.name, sessionId)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      const m = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(f)
      if (m) hits.push({ file: path.join(dir, f), version: m[1] === undefined ? 0 : Number(m[1]) })
    }
  }
  if (hits.length === 0) return { error: `找不到会话 ${sessionId} 的日志` }
  hits.sort((a, b) => b.version - a.version)
  return { file: hits[0].file, version: hits[0].version }
}

function listSessions(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const pdir = path.join(root, project.name)
    for (const s of fs.readdirSync(pdir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const dir = path.join(pdir, s.name)
      for (const f of fs.readdirSync(dir)) {
        const m = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(f)
        if (!m) continue
        const st = fs.statSync(path.join(dir, f))
        out.push({ id: s.name, version: m[1] === undefined ? 0 : Number(m[1]), bytes: st.size, file: path.join(dir, f) })
      }
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

/** 判断逻辑行号是否落在 "812" / "800-900" / "1,5-7" 这类行号限定里。 */
const inSpec = (spec, n) => {
  for (const part of String(spec).split(',')) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim())
    if (m === null) continue
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    if (n >= a && n <= b) return true
  }
  return false
}

/** 用 plan 里的 find 做定位，只返回行号与计数，绝不返回文本。 */
function locate(file, plan) {
  const buf = fs.readFileSync(file)
  const { frames } = scanFrames(buf)
  const needles = []
  for (const s of plan.substitutions ?? []) {
    if (typeof s.find === 'string' && s.find.length > 0) needles.push({ buf: Buffer.from(s.find, 'utf8'), lines: s.lines })
  }
  const rows = []
  let logical = 0
  for (const r of frames) {
    const plain = decodeFrame(buf, r)
    for (const l of splitLines(plain)) {
      logical += 1
      const seg = plain.subarray(l.start, l.end)
      // 与 apply 保持同一语义：带 lines 限定的替换只在该区间内生效
      const hits = needles.filter((n) => (n.lines === undefined || inSpec(n.lines, logical)) && seg.includes(n.buf)).length
      if (hits > 0) rows.push(logical)
    }
  }
  return { lines: rows, rowCount: logical, scoped: needles.some((n) => n.lines !== undefined) }
}

/**
 * 删派生缓存（<id>.json / <id>.json.bak.*）。
 *
 * F5：这里**绝不能抛异常**——它在 commitRewrite 成功之后被调用，一旦抛出去，用户看到的
 * 是「命令失败/崩溃」，而盘上的日志其实已经被改写、并且已经多出一份含原文的隔离备份。
 * 所以：(1) 每个删除动作都单独 try/catch；(2) 只删普通文件（对目录调用非递归 rmSync 会
 * EISDIR）；(3) 失败信息交回调用方并入**成功**文案。
 * @returns {{removed: string[], failures: string[]}}
 */
function purgeCache(cacheRoot, sessionId) {
  const removed = []
  const failures = []
  const dir = path.join(cacheRoot, 'session_projcache', 'sessions')
  let entries = []
  try {
    if (fs.existsSync(dir)) entries = fs.readdirSync(dir)
  } catch (err) {
    return { removed, failures: [`无法列出缓存目录：${err.message}`] }
  }
  for (const f of entries) {
    if (f !== `${sessionId}.json` && !f.startsWith(`${sessionId}.json.bak.`)) continue
    const p = path.join(dir, f)
    try {
      if (!fs.statSync(p).isFile()) continue // 目录 / 其它非普通文件一律不动
      fs.rmSync(p, { force: true })
      removed.push(p)
    } catch (err) {
      failures.push(`${f}: ${err.message}`)
    }
  }
  return { removed, failures }
}

/** 把 purgeCache 的结果并进单行文案：失败也要说，但绝不改变命令的成败。 */
const purgeNote = (purge) =>
  `缓存清理 ${purge.removed.length}` + (purge.failures.length > 0 ? `（失败 ${purge.failures.length}：${purge.failures[0]}）` : '')

/** 那些本工具不动、但同样可能残留文本的位置；只报告路径，不读取内容。 */
function otherCopies(sessionId) {
  // F5 的同类约束：这些只是「提示」用的探测，任何一步失败都不允许把已经成功的改写变成异常
  try {
    const out = []
    const legacy = path.join(dshHome(), 'storages', 'session_projcache.json')
    if (fs.existsSync(legacy)) out.push(`${legacy}（旧版聚合缓存，若删掉单会话缓存它会回灌，建议一并删除）`)
    const tmp = os.tmpdir()
    for (const p of [path.join(os.homedir(), '.dsh-tui', 'history.jsonl'), path.join(os.homedir(), '.dsh-tui', 'session-index.json')]) {
      if (fs.existsSync(p)) out.push(p)
    }
    if (fs.existsSync(tmp)) {
      for (const f of fs.readdirSync(tmp)) {
        if (f.startsWith('dsh-spill-') || f.startsWith('dsh-subprocess-')) out.push(path.join(tmp, f))
      }
    }
    return out
  } catch {
    return []
  }
}

const parsePlan = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { error: `计划文件无法解析: ${file}（${err.message.split('\n')[0]}）` }
  }
}

/**
 * 会话内「立刻隐藏」：照抄 @deepseek-ai/dsh-compaction-tool-result-pruner 的
 * pruneSession 形状（lib/index.js:137-194），只把「体积超预算」换成「命中规则」。
 *
 * 为什么这样做是对的：
 *   - 追加一个 surfaceOp:{op:'replace'} 的替换节点，会把被遮蔽的节点移出
 *     session.surface，而 agent-loop 每个请求都从 session.deriveMessages() 重新推导，
 *     所以**下一轮请求立即看不到原文**，不需要重启。
 *   - 替换节点仍然是一个合法的 tool/result（只换正文），所以 tool 调用配对、
 *     引用、turn 语法全部不变。
 *   - 遮蔽价签事件 compaction/prune 必须与替换**紧邻**且价格由 tokenMeter 算出，
 *     否则 token-meter 会对不上的 armed claim 抛错；拿不到 tokenMeter 时就不发它
 *     （只有 replace 也是合法的，只是折叠时零增量）。
 *
 * 注意：这**不删除磁盘字节**，只把内容移出模型视野。要真正从盘上抹掉仍需
 * /redact apply 重写日志文件。
 */
function hideInSession(ctx, session, plan, placeholder, commit, lineSpec) {
  const needles = (plan.substitutions ?? [])
    .map((s) => s.find)
    .filter((s) => typeof s === 'string' && s.length > 0)
  const byLines = typeof lineSpec === 'string' && lineSpec.length > 0
  if (!byLines && needles.length === 0) return { error: '计划里没有 substitutions[].find，也没有给 --lines，无法定位要隐藏的内容' }

  const surface = session.surface
  if (surface === undefined || surface.nodes === undefined) return { error: '当前会话没有可用的 surface，无法会话内隐藏' }

  const targets = []
  for (const seq of [...surface.nodes]) {
    const event = session.eventAt(seq)
    if (event === undefined || event.type !== 'tool/result') continue
    if (byLines) {
      // seq 是「事件行自 0 起」的编号，对应日志里的 行号-2
      if (inSpec(lineSpec, seq + 2)) targets.push({ seq, event })
      continue
    }
    let text
    try {
      text = JSON.stringify(event.data.message)
    } catch {
      continue
    }
    if (needles.some((n) => text.includes(n))) targets.push({ seq, event })
  }
  if (targets.length === 0) return { hidden: 0, seqs: [] }
  if (!commit) return { hidden: 0, planned: targets.map((t) => t.seq) }

  const meter = ctx.get('tokenMeter')
  const canPrice = meter !== undefined && typeof meter.estimateMessage === 'function'
  const landed = []
  for (const { seq, event } of targets) {
    const data = event.data
    if (data === null || typeof data !== 'object' || data.message === null || typeof data.message !== 'object') {
      return { error: `第 ${landed.length + 1} 个节点（seq ${seq}）的消息形态不受支持（data.message 不是对象），未做改动`, landed }
    }
    const outer = data.message.content
    let nextOuter = outer
    if (Array.isArray(outer) && outer.length > 0 && outer[0] !== null && typeof outer[0] === 'object' && 'content' in outer[0]) {
      const inner = outer[0].content
      const nextInner =
        typeof inner === 'string'
          ? placeholder
          : Array.isArray(inner)
            ? inner.map((b) => (b !== null && typeof b === 'object' && b.type === 'text' ? { ...b, text: placeholder } : b))
            : inner
      nextOuter = [{ ...outer[0], content: nextInner }, ...outer.slice(1)]
    } else if (Array.isArray(outer)) {
      nextOuter = outer.map((b) => (b !== null && typeof b === 'object' && b.type === 'text' ? { ...b, text: placeholder } : b))
    }
    const message = { ...data.message, content: nextOuter }
    // F10：替换结果与原文**逐字节相同**说明这个节点的消息形态我们看不懂（content 不是数组、
    // 或数组里没有任何 text 块）。旧实现照样回「已隐藏 N 个节点」，而模型下一轮仍然看得到原文。
    let identical
    try {
      identical = JSON.stringify(message) === JSON.stringify(data.message)
    } catch {
      identical = true // BigInt / 循环引用：同样无法证明替换有效
    }
    if (identical) {
      return { error: `第 ${landed.length + 1} 个节点（seq ${seq}）的消息形态不受支持（content 里没有可替换的文本块），未做改动`, landed }
    }
    try {
      if (canPrice) {
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: meter.estimateMessage(data.message),
        })
      }
      const replacement = session.append('tool/result', { ...data, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      landed.push({ seq, replacementSeq: replacement.seq })
    } catch (err) {
      return { error: `第 ${landed.length + 1} 个节点替换失败：${err.message}`, landed }
    }
  }
  return { hidden: landed.length, landed, priced: canPrice }
}

/**
 * 逐帧扫行，只留下回退边界判定需要的东西（F7）。
 * 旧实现（readRows）把**每一行**都 JSON.parse 成对象留在内存里，紧跟着 applyPlan 又整份
 * 解压一次；大日志下这是尖峰内存的主要来源。这里解析完一行就丢掉，只记 turn/end 行号与
 * 继承型 end-seed 的行号。绝不打印内容。
 */
function scanRowFlags(file) {
  const log = loadLog(file)
  const turnEnds = []
  const inheritedEndSeeds = new Set()
  for (const view of log.frameViews) {
    for (const l of view.lines) {
      let row
      try {
        row = JSON.parse(view.plain.subarray(l.start, l.end).toString('utf8'))
      } catch {
        continue // 读不动的行与回退边界无关（applyPlan 会另行拒绝）
      }
      if (row?.type === 'turn/end') turnEnds.push(l.logical)
      else if (row?.type === 'session/end-seed' && row.data?.inherited === true) inheritedEndSeeds.add(l.logical)
    }
  }
  return { turnEnds, inheritedEndSeeds, total: log.totalLines }
}

/**
 * 计算「回退最近 n 轮」要截断到哪一行。
 * 删除**后缀**是唯一无需重编号就安全的删除方式（引用一律向后指）。
 */
function planRollback(file, n) {
  const { turnEnds, inheritedEndSeeds, total } = scanRowFlags(file)
  if (turnEnds.length === 0) return { error: '日志里没有 turn/end 边界，无法按轮回退' }
  if (n < 1) return { error: '回退轮数必须 >= 1' }
  if (n >= turnEnds.length) {
    return { error: `只找到 ${turnEnds.length} 个完整轮次，不能回退 ${n} 轮（至少要保留 1 轮）` }
  }
  const keepTurns = turnEnds.length - n
  const boundary = turnEnds[keepTurns - 1]
  const dropFrom = boundary + 1
  // 保护：种入型会话的 inherited end-seed 标记不能被截掉，否则读取端会拒绝整份日志
  for (const line of inheritedEndSeeds) {
    if (line >= dropFrom) return { error: '截断会移除继承型 session/end-seed 标记，读取端会判定为损坏，已拒绝' }
  }
  return {
    totalTurns: turnEnds.length,
    keepTurns,
    removeTurns: n,
    boundaryLine: boundary,
    dropFrom,
    dropLines: `${dropFrom}-${total}`,
    droppedRows: total - boundary,
  }
}

/** 找出最新的隔离备份，用于撤销一次脱敏。 */
function findQuarantine(file) {
  const dir = path.dirname(file)
  const base = path.basename(file) + '.quarantine-'
  const hits = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base))
    .map((f) => ({ name: f, path: path.join(dir, f), st: fs.statSync(path.join(dir, f)) }))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
  return hits
}

/** 文件修订号：并发追加检测用。 */
const revisionOf = (file) => {
  const st = fs.statSync(file)
  return `${st.size}:${st.mtimeMs}:${st.ctimeMs}`
}

/** 目录 fsync（尽力而为；Windows 上打开目录会失败，属正常，不影响判定）。 */
function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* Windows / 某些文件系统不支持对目录 fsync：忽略 */
  }
}

/** 把整个 buffer 写到 fd 的 offset 处，短写时继续写；返回实际写入字节数。 */
function writeAllSync(fd, buf, offset) {
  let written = 0
  while (written < buf.length) {
    const n = fs.writeSync(fd, buf, written, buf.length - written, offset + written)
    if (!Number.isInteger(n) || n <= 0) break
    written += n
  }
  return written
}

/**
 * 落盘。活跃会话用**同路径原地覆盖**（而不是改名替换）：改名可能与此刻正在发生的追加
 * 句柄相撞（Windows 上尤其明显），且后端每批追加都是重新 open(path,'a') 写 EOF。
 *
 * F4 的顺序（写/截断窗口）：
 *   - 先用 `ftruncate` 把文件截短到 out.length，再写：任何时刻文件都是 out 的前缀，
 *     被打断只可能留下「尾部被截短」的日志（读取端本来就按崩溃尾容忍），
 *     而不是旧实现的「新头 + 旧帧」混合体（扫描器会在帧边界处硬拒绝）。
 *   - 当 out 比原文件**更长**时不能用 ftruncate 先截（那会先把尾部补 0，一旦中断就是
 *     「完整帧边界 + 0」的硬损坏），此时直接写满长度，写完复查文件长度即可。
 *   - 打开 fd 之后、写入之前再比一次修订号；写完校验 bytesWritten 与文件长度；最后 fsync。
 *
 * F6：写失败时如果目标文件**一个字节都没动**，就把刚复制出来的隔离备份删掉（它只是
 * 原文的重复副本）；一旦动过目标文件就保留备份并在错误里点名（此时它是唯一完整的原文）。
 *
 * @returns {string} 隔离备份路径
 */
function commitRewrite(file, out, live, expectedRevision) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.quarantine-${stamp}`
  fs.copyFileSync(file, backup)
  let touched = false // 目标文件是否已被改动（决定失败时能否删掉备份）
  try {
    if (live) {
      const fd = fs.openSync(file, 'r+')
      try {
        // 从「读取 + 修订号比对」到真正打开 fd 之间仍有窗口：在这里再查一次
        if (expectedRevision !== undefined && revisionOf(file) !== expectedRevision) {
          throw new Error('日志在本次读取之后被追加过（可能有并发写入）。已放弃写入，以免覆盖新事件。')
        }
        const size = fs.fstatSync(fd).size
        if (out.length <= size) {
          touched = true
          fs.ftruncateSync(fd, out.length) // 先截断：中断只会留下 out 的前缀（=可容忍的崩溃尾）
        }
        const written = writeAllSync(fd, out, 0)
        if (written !== out.length) throw new Error(`写入不完整（${written}/${out.length} 字节），文件可能被截短`)
        const finalSize = fs.fstatSync(fd).size
        if (finalSize !== out.length) {
          throw new Error(`写入期间日志被并发追加（文件 ${finalSize} 字节 ≠ 预期 ${out.length} 字节）：已保留追加内容，但该批次可能与改写后的布局错位`)
        }
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } else {
      const tmp = `${file}.redact-tmp`
      try {
        fs.writeFileSync(tmp, out)
        // 必须是可写 fd：Windows 上对只读 fd 调 fsync 会 EPERM
        const fd = fs.openSync(tmp, 'r+')
        try {
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        fs.renameSync(tmp, file)
        touched = true
        fsyncDir(path.dirname(file))
      } catch (err) {
        // 没装上就把它清掉，别在会话目录里留半成品（tmp 里是**脱敏后**的内容，不是原文）
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          /* 清理失败不影响判定 */
        }
        throw err
      }
    }
  } catch (err) {
    if (!touched) {
      // 目标文件没动过：备份只是原文的重复副本，删掉它，别在会话目录里留一份没人知道的原文
      try {
        fs.rmSync(backup, { force: true })
      } catch {
        err.redactBackup = backup
      }
      err.redactTouched = false
    } else {
      err.redactBackup = backup
      err.redactTouched = true
    }
    throw err
  }
  return backup
}

/** 写盘失败时的统一文案：关键信息（备份是否还在、日志有没有被改动）必须排在 200 格之内。 */
function writeFailure(err) {
  return err.redactBackup === undefined
    ? `写入失败（日志未被改动，已删除刚生成的隔离备份）：${err.message}`
    : `写入失败（隔离备份 ${path.basename(err.redactBackup)} 仍含原文）：${err.message}`
}

function usage() {
  // 单行：错误提示同样会被渲染端压平并截断，多行排版在这里没有意义。
  return (
    '用法：/redact list|nodes|pick|verify|purge|undo（可加 --session <id>） · ' +
    'scan|plan|apply <计划.json> · hide <序号|计划.json|--lines 行号> · rollback <轮数> · ' +
    '写操作需 --commit；匹配文本写在计划文件里，别写命令行'
  )
}

export function apply(ctx, config = {}) {
  // 本包不导出 Schemastery `Config`：profile 以 link: 安装时，包自身的真实路径向上找不到
  // node_modules，@deepseek-ai/schemastery 不可解析（实测 ERR_MODULE_NOT_FOUND）。
  // 所以在这里做等价的前置校验——配置类型不对就**立刻抛错**，而不是等用户执行 /redact 才炸
  // （dsh-app-boot 会把任何 FAILED 行升级为致命错误，早失败 = 早看见）。
  //
  // 但 `null` 例外：YAML 里把 `config:` 留空就会传进 null，那是「用默认值」而不是「配错了」。
  // 三个字段都有默认值，所以按空对象处理；否则一个空 config 会中止整个 profile 的启动。
  const cfg = config === null || config === undefined ? {} : config
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('dsh-redact: invalid config: expected an object')
  }
  const asPath = (value, key, fallback) => {
    if (value === undefined) return fallback
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`dsh-redact: invalid config: $.${key} must be a non-empty string`)
    }
    return value
  }
  const root = asPath(cfg.root, 'root', path.join(dshHome(), 'sessions'))
  const cacheRoot = asPath(cfg.cacheRoot, 'cacheRoot', path.join(dshHome(), 'storages'))
  const placeholder = asPath(cfg.placeholder, 'placeholder', '[已移除]')
  // 列表里要不要显示工具调用的命令行：它是「认出这是哪一条」的关键，但也可能含敏感查询词。
  // 0 = 完全不显示；默认 120 显示格。
  const argsCells = cfg.argsCells === undefined ? 120 : cfg.argsCells
  if (!Number.isInteger(argsCells) || argsCells < 0) {
    throw new Error('dsh-redact: invalid config: $.argsCells must be a non-negative integer')
  }
  // 对话框超时 = 面板卡住时界面不可操作的最长时间。
  // 原来设 120s 是个**错误赌注**：对话框一旦成为 store 里的活动请求，聊天键盘就会被让出去
  //（Chat.js「挂起时聊天键盘让出」）；若此时面板没被渲染（例如有 approval 面板占位，
  // Chat.js 明载「有 approval 面板时对话框不显示但仍挂起」），就没人能应答 →
  // 界面一直卡到超时。默认压到 15 秒（够读完一页并选择），并允许设 0 彻底禁用对话框。
  const dialogTimeoutMs = cfg.dialogTimeoutMs === undefined ? 15000 : cfg.dialogTimeoutMs
  if (!Number.isInteger(dialogTimeoutMs) || dialogTimeoutMs < 0) {
    throw new Error('dsh-redact: invalid config: $.dialogTimeoutMs must be a non-negative integer')
  }
  // pick 的模态对话框**默认关闭**。根因调查已证实：把 promise 停进 TuiDialogStore 会让
  // Chat 无条件让出键盘（Chat.js:2566）、输入框停用；而面板唯一挂载点（Chat.js:3585）
  // 会被 approval 面板无提示压掉，approval 又没有超时 —— 于是「有审批挂着时敲 pick」
  // 必然锁住键盘，且 Ctrl+C 都退不出（exitOnCtrlC: false），只能等超时。
  // 唯一结构上安全的做法是别把 promise 停进去，所以默认走 nodes + hide <序号>。
  const allowDialogs = cfg.allowDialogs === undefined ? false : cfg.allowDialogs
  if (typeof allowDialogs !== 'boolean') {
    throw new Error('dsh-redact: invalid config: $.allowDialogs must be a boolean')
  }
  // 未知键只告警不拒绝：与平台自身的 config 语义一致（Schemastery 保留未知键），
  // 避免一个手滑的键名直接把整个 profile 的启动打断。
  const known = new Set(['root', 'cacheRoot', 'placeholder', 'argsCells', 'dialogTimeoutMs', 'allowDialogs'])
  const unknown = Object.keys(cfg).filter((k) => !known.has(k))
  if (unknown.length > 0) {
    ctx.logger?.warn?.(`dsh-redact: ignoring unknown config key(s): ${unknown.join(', ')}`)
  }
  /** 每个会话最近一次 /redact nodes 的结果，供 /redact hide <序号> 引用。 */
  const lastNodes = new Map()

  // 保持同步：只有 pick 分支异步（要 await 对话框），其余分支返回普通对象。
  // 命令运行时对两者都用 Promise.resolve() 等待，所以混用是安全的。
  const handler = (invocation) => {
    // 支持引号包裹的参数（路径常含空格）：先按引号/空白切分，再剥掉外层引号
    const argv = (invocation.rawInput.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) =>
      (t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2) ? t.slice(1, -1) : t,
    )
    const cmd = (argv.shift() ?? 'list').toLowerCase()
    const flags = {}
    const positional = []
    for (let i = 0; i < argv.length; i++) {
      if (argv[i].startsWith('--')) {
        const key = argv[i].slice(2)
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) flags[key] = true
        else {
          flags[key] = next
          i += 1
        }
      } else positional.push(argv[i])
    }
    const current = invocation.agent?.session?.id
    const targetId = typeof flags.session === 'string' ? flags.session : current

    if (cmd === 'list') {
      const all = listSessions(root)
      if (all.length === 0) return { kind: 'success', text: `没有找到任何会话日志（root=${root}）` }
      const human = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`)
      const tail = ' 用 /redact nodes 看当前会话'
      const head = `共 ${all.length} 个会话（按体积）：`
      let used = cells(head) + cells(tail)
      const parts = []
      for (const s of all) {
        const seg = `${s.id.slice(0, 8)} ${human(s.bytes)}${s.id === current ? '(当前)' : ''}`
        if (used + cells(seg) + 3 > RESULT_CELLS) break
        parts.push(seg)
        used += cells(seg) + 3
      }
      const more = all.length > parts.length ? ` …另${all.length - parts.length}个` : ''
      return { kind: 'success', text: `${head}${parts.join(' ｜ ')}${more}${tail}` }
    }

    if (cmd === 'verify') {
      if (targetId === undefined) return { kind: 'error', text: '无法确定目标会话，请加 --session <id>' }
      const found = resolveLog(root, targetId)
      if (found.error !== undefined) return { kind: 'error', text: found.error }
      let r
      let seq
      let refs
      try {
        const buf = fs.readFileSync(found.file)
        r = inspectBuffer(buf)
        seq = r.fatal === undefined ? checkSeqDensity(buf) : null
        // 与 apply 的总闸同一份判定：引用字段（含盘上游程形式）也按读取端语义回放
        refs = verifyLog(buf)
      } catch (err) {
        // scanFrames 对「帧魔数损坏」是直接抛错，必须在这里接住，否则会打到宿主
        return { kind: 'error', text: `日志无法解析：${err.message}` }
      }
      const ok = r.parseErrors === 0 && r.headerOk && r.fatal === undefined && seq === null && refs.ok
      const id8 = targetId.slice(0, 8)
      return {
        kind: ok ? 'success' : 'error',
        text: ok
          ? `✓ ${id8} · 帧 ${r.frames} · 行 ${r.lines} · 头部合法 · seq 密集 · 引用合法 · 读取端可打开`
          : `✗ ${id8} · 帧 ${r.frames} · 行 ${r.lines} · 问题：${refs.ok ? (r.fatal ?? seq ?? `解析失败 ${r.parseErrors} 行`) : refs.reason}`,
      }
    }

    if (cmd === 'purge') {
      if (targetId === undefined) return { kind: 'error', text: '无法确定目标会话，请加 --session <id>' }
      const purge = purgeCache(cacheRoot, targetId)
      const others = otherCopies(targetId)
      return {
        kind: 'success',
        text:
          `已清理缓存 ${purge.removed.length} 个${purge.failures.length > 0 ? `（失败 ${purge.failures.length}：${purge.failures[0]}）` : ''} · ${targetId.slice(0, 8)}` +
          (others.length > 0 ? ` · 仍有 ${others.length} 处本工具不动：${others[0]}${others.length > 1 ? ' 等' : ''}` : ''),
      }
    }

    if (cmd === 'rollback') {
      const n = Number(positional[0] ?? '1')
      if (!Number.isInteger(n) || n < 1) return { kind: 'error', text: `用法：/redact rollback <轮数> [--session <id>] [--commit] · ${usage()}` }
      if (targetId === undefined) return { kind: 'error', text: '无法确定目标会话，请加 --session <id>' }
      const found = resolveLog(root, targetId)
      if (found.error !== undefined) return { kind: 'error', text: found.error }
      let info
      try {
        info = planRollback(found.file, n)
      } catch (err) {
        return { kind: 'error', text: `无法读取日志：${err.message}` }
      }
      if (info.error !== undefined) return { kind: 'error', text: info.error }
      const head =
        `会话 ${targetId.slice(0, 8)} · 共 ${info.totalTurns} 轮 · 回退 ${info.removeTurns} 轮 → 保留 ${info.keepTurns} 轮` +
        ` · 删 ${info.droppedRows} 行（自第 ${info.dropFrom} 行起截断）`
      if (flags.commit !== true) return { kind: 'success', text: `${head} · 试算未写盘，加 --commit 执行` }
      if (targetId === current && flags['allow-live'] !== true) {
        // 单行且把「出路」放在最前：渲染端只给 200 格，多行会被截断到看不见 --allow-live
        return {
          kind: 'error',
          text: `拒绝截断在用会话 ${targetId.slice(0, 8)} · 加 --allow-live 可在本会话内执行（之后需重开会话） · 或切到其它会话后执行 rollback ${n} --session ${targetId.slice(0, 8)}`,
        }
      }
      let revAtRead
      let buf2
      try {
        revAtRead = revisionOf(found.file)
        buf2 = fs.readFileSync(found.file)
      } catch (err) {
        return { kind: 'error', text: `无法读取日志：${err.message}` }
      }
      let result
      try {
        result = applyPlan(buf2, { dropLines: info.dropLines })
      } catch (err) {
        return { kind: 'error', text: `未执行：${err.message}` }
      }
      const live = targetId === current
      if (live && result.tornStart !== undefined) {
        return {
          kind: 'error',
          text: `拒绝 --allow-live：日志尾部有未完成残帧（起点 ${result.tornStart} 字节），写句柄缓存着按改写前布局算出的截断偏移，下次追加会静默损坏 · 请关闭该会话后再执行`,
        }
      }
      let revNow
      try {
        revNow = revisionOf(found.file)
      } catch (err) {
        return { kind: 'error', text: `未执行：无法重新读取文件状态（${err.message}）` }
      }
      if (revNow !== revAtRead) {
        return { kind: 'error', text: '未执行：日志在本次读取之后被追加过（可能有并发写入）。请稍后重试。' }
      }
      let backup
      try {
        backup = commitRewrite(found.file, result.out, live, revNow)
      } catch (err) {
        return { kind: 'error', text: writeFailure(err) }
      }
      const purge = purgeCache(cacheRoot, targetId)
      return {
        kind: 'success',
        text:
          `${head} · 备份 ${path.basename(backup)}（仍含原文，确认无误后自行删除） · ${purgeNote(purge)}` +
          (targetId === current ? ' · 重开会话后生效' : ' · 下次打开该会话即为回退后状态'),
      }
    }

    if (cmd === 'undo') {
      if (targetId === undefined) return { kind: 'error', text: '无法确定目标会话，请加 --session <id>' }
      const found = resolveLog(root, targetId)
      if (found.error !== undefined) return { kind: 'error', text: found.error }
      let backups
      try {
        backups = findQuarantine(found.file)
      } catch (err) {
        return { kind: 'error', text: `无法读取备份目录：${err.message}` }
      }
      if (backups.length === 0) return { kind: 'error', text: `没有找到 ${path.basename(found.file)} 的隔离备份，无法撤销` }
      const newest = backups[0]
      let currentBytes = 0
      try {
        currentBytes = fs.statSync(found.file).size
      } catch {
        /* 日志缺失也允许恢复 */
      }
      const head = `${targetId.slice(0, 8)} · 备份 ${newest.name}（${newest.st.size}B）· 当前 ${currentBytes}B`
      if (flags.commit !== true) return { kind: 'success', text: `${head} · 试算未写盘，加 --commit 恢复` }
      if (targetId === current && flags['allow-live'] !== true) {
        return {
          kind: 'error',
          text: `拒绝恢复在用会话 ${targetId.slice(0, 8)}（写句柄仍持有该日志） · 加 --allow-live 可在本会话内执行（之后需重开会话） · 或切到其它会话后执行 /redact undo --session ${targetId}`,
        }
      }
      // F3：装回去之前先校验备份。旧实现只看大小与 mtime 就直接覆盖——一份截断的备份会被
      // 读取端当成「崩溃尾」静默少读事件（用户看不出少了什么），中间损坏的备份则让整个会话硬打不开。
      let backupBytes
      try {
        backupBytes = fs.readFileSync(newest.path)
      } catch (err) {
        return { kind: 'error', text: `备份不可读：${err.message} · 当前日志未改动` }
      }
      const check = verifyLog(backupBytes)
      const refuse = (why) =>
        ({
          kind: 'error',
          text:
            `拒绝恢复：备份 ${newest.name} ${why} · 当前日志未改动（${currentBytes}B）` +
            ' · 可改用更早的 .quarantine-* 或 .before-undo-* 备份手工恢复',
        })
      if (!check.ok) return refuse(`不合格（${check.reason}）`)
      // 帧边界处的截断不会留下残帧，却会静默少事件：备份的事件数绝不可能少于当前日志
      // （apply 不改事件数，rollback 只会变少），所以这是一个可靠的交叉检查。
      if (check.tornStart !== undefined) return refuse(`尾部有未完成残帧（字节 ${check.tornStart}），可能少了一批事件`)
      let currentEvents
      try {
        const live = verifyLog(fs.readFileSync(found.file))
        currentEvents = live.tornStart === undefined ? live.lines - 1 : undefined
      } catch {
        currentEvents = undefined
      }
      if (currentEvents !== undefined && check.lines - 1 < currentEvents) {
        return refuse(`只有 ${check.lines - 1} 个事件，少于当前日志的 ${currentEvents} 个`)
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const aside = `${found.file}.before-undo-${stamp}`
      const tmp = `${found.file}.redact-tmp`
      try {
        // 先把健康日志另存为 .before-undo-*（日志缺失时跳过），再用「临时文件 + rename」安装备份，
        // 而不是 copyFileSync 直接覆盖：rename 是原子的，中断不会留下半截日志。
        if (fs.existsSync(found.file)) fs.copyFileSync(found.file, aside)
        fs.writeFileSync(tmp, backupBytes)
        const fd = fs.openSync(tmp, 'r+')
        try {
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        fs.renameSync(tmp, found.file)
        fsyncDir(path.dirname(found.file))
      } catch (err) {
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          /* 清理失败不影响判定 */
        }
        return { kind: 'error', text: `恢复失败：${err.message} · 原日志可能仍是改写后状态` }
      }
      const purge = purgeCache(cacheRoot, targetId)
      return {
        kind: 'success',
        text: `${head} · 已恢复（已校验） · 撤销前状态另存 ${path.basename(aside)} · ${purgeNote(purge)}`,
      }
    }

    // pick：在 TUI 面板里用方向键选节点（多行、可选中），而不是靠 200 格的单行通知。
    // tuiDialogs 是 TUI 行提供的服务，**软探测**（不写进 inject，否则本行会一直等它）；
    // 契约保证请求不合法时只 warning + 返回 undefined，不会把插件或 TUI 带下去。
    if (cmd === 'pick') {
      // 唯一异步的分支：包成 IIFE，使 handler 整体维持同步签名。
      return (async () => {
        const session = invocation.agent?.session
      if (session === undefined) return { kind: 'error', text: '当前没有可用的会话' }
      // 先判「默认关闭」：这是本子命令唯一安全的默认。理由见 apply() 里 allowDialogs 的注释。
      if (allowDialogs !== true) {
        return {
          kind: 'error',
          text: 'pick 的模态对话框默认关闭（它会让 TUI 键盘卡住，且 approval 挂起时必然复现）· 用 /redact nodes 看编号，再 /redact hide <序号> --commit · 确要启用请设 allowDialogs: true 并自行承担风险',
        }
      }
      if (dialogTimeoutMs === 0) {
        return { kind: 'error', text: '对话框已被配置禁用（dialogTimeoutMs: 0）· 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件' }
      }
      const dialogs = ctx.get('tuiDialogs')
      if (dialogs === undefined || typeof dialogs.select !== 'function') {
        return { kind: 'error', text: '当前前端没有对话框服务 tuiDialogs · 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件' }
      }
      const collected = collectNodes(session, argsCells)
      if (collected.error !== undefined) return { kind: 'error', text: collected.error }
      const items = collected.items
      // 同 nodes：拒绝必须先于空列表判断，否则空 surface 时传别的会话会返回成功
      if (targetId !== undefined && targetId !== current) {
        return { kind: 'error', text: 'pick 只作用于当前会话；其它会话请用 /redact apply 重写日志。' }
      }
      if (items.length === 0) return { kind: 'success', text: '当前会话的 surface 上没有 tool/result 节点' }
      const options = items.slice(0, 60).map((it, i) => ({
        id: String(i + 1),
        // 行号给「精确」，轮次给「认出是哪一轮对话」，description 给命令行 —— 面板是多行的，都看得见
        label: `[${i + 1}] 行 ${it.line} 轮 ${it.turn ?? '-'} · ${it.tool} · ${humanBytes(it.bytes)}`,
        ...(it.args === '' ? {} : { description: it.args }),
      }))
      let pickedId
      // 宿主在 try/catch 之外还有一道「准入」守卫：若本行 fiber 在 dsh-tui 适配器安装
      // composition-root tracker 之前就已 ACTIVE，每次 select 都会只写一条 logger warning
      // 并**直接返回取消值** —— 面板不弹，用户只看到「已取消」。
      // 人按 Esc 不可能在几十毫秒内完成，所以用耗时把这种静默失败识别出来。
      const tSelect = Date.now()
      try {
        pickedId = await dialogs.select({
          // 标题压到 ~90 格以内：契约上限是 120 格，长分支原本只剩 13 格余量
          title:
            items.length > options.length
              ? `选择要隐藏的节点（共 ${items.length} 个，仅列最新 ${options.length} 个；其余用 /redact hide <序号>）`
              : `选择要隐藏的节点（共 ${items.length} 个，最新在前）`,
          options,
          timeoutMs: dialogTimeoutMs,
        })
      } catch (err) {
        return { kind: 'error', text: `对话框调用失败：${err.message}` }
      }
      if (pickedId === undefined) {
        const waited = Date.now() - tSelect
        if (waited < 50) {
          return {
            kind: 'error',
            text: `对话框没有弹出（${waited}ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件`,
          }
        }
        return { kind: 'success', text: '已取消' }
      }
      const idx = Number(pickedId)
      const target = Number.isInteger(idx) ? items[idx - 1] : undefined
      if (target === undefined) return { kind: 'error', text: `无效的选择：${pickedId}` }
      let confirmed = false
      // 同 select：确认框也可能因准入竞态而立刻返回 false
      const tConfirm = Date.now()
      try {
        confirmed = await dialogs.confirm({
          title: `隐藏 [${idx}] 行 ${target.line} · ${target.tool} · ${humanBytes(target.bytes)}？`,
          message: '隐藏后从下一轮请求起模型不再看到它（磁盘字节仍在）。该节点会被永久遮蔽，无法还原。',
          confirmLabel: '隐藏',
          cancelLabel: '取消',
          timeoutMs: dialogTimeoutMs,
        })
      } catch (err) {
        return { kind: 'error', text: `对话框调用失败：${err.message}` }
      }
      if (confirmed !== true) {
        const waited = Date.now() - tConfirm
        if (waited < 50) {
          return { kind: 'error', text: `确认框没有弹出（${waited}ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact hide <序号> --commit` }
        }
        return { kind: 'success', text: '已取消' }
      }
      const res = hideInSession(ctx, session, {}, placeholder, true, String(target.line))
      if (res.error !== undefined) return { kind: 'error', text: res.error }
      if (res.hidden === 0) return { kind: 'error', text: '未命中节点，未做改动' }
        return {
          kind: 'success',
          text: `已隐藏 [${idx}] 行 ${target.line} · ${target.tool} · 下一轮请求起模型不再看到 · 磁盘字节仍在（会话关闭后用 apply 清理）`,
        }
      })()
    }

    if (cmd === 'nodes') {
      const session = invocation.agent?.session
      if (session === undefined) return { kind: 'error', text: '当前没有可用的会话' }
      const collected = collectNodes(session, argsCells)
      if (collected.error !== undefined) return { kind: 'error', text: collected.error }
      const items = collected.items
      // 守卫必须排在「空列表早返回」之前：否则 surface 为空时传别的会话会返回成功，
      // 用户会以为「那个会话没有节点」，而不是「这个命令根本不看别的会话」。
      if (targetId !== undefined && targetId !== current) {
        return { kind: 'error', text: 'nodes 只能列出当前会话的节点（surface 是活会话的内存状态） · 其它会话请用 /redact apply 处理其日志' }
      }
      if (items.length === 0) return { kind: 'success', text: '当前会话的 surface 上没有 tool/result 节点' }
      lastNodes.set(session.id, { items, newestSeq: items[0]?.seq ?? -1 })
      const human = humanBytes

      // --full / full：通知被压成单行且只有 200 格，装不下长列表，所以把完整清单写到文件
      if (flags.full === true || positional[0] === 'full') {
        // 用完整会话 id 并做路径安全化：只取前 8 字会让两个会话写到同一个文件互相覆盖
        const safeId = String(session.id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)
        const outFile = path.join(os.tmpdir(), `dsh-redact-nodes-${safeId}.txt`)
        const body = items
          .map((it, i) => {
            const turn = it.turn === undefined ? '-' : it.turn
            // 命令行是「认出这是哪一条」的关键；结果正文一律不出现
            const what = it.args === '' ? '' : `  ${it.args}`
            return `[${i + 1}] 轮 ${turn}  ${it.tool}  ${human(it.bytes)}  行 ${it.line}${what}  → /redact hide ${i + 1} --commit`
          })
          .join('\n')
        try {
          fs.writeFileSync(outFile, `会话 ${session.id}\n共 ${items.length} 个 tool/result 节点（最新在前）\n\n${body}\n`, 'utf8')
        } catch (err) {
          return { kind: 'error', text: `写入清单失败：${err.message}` }
        }
        return { kind: 'success', text: `完整清单已写入 ${outFile}（共 ${items.length} 条，序号可直接 /redact hide <序号>）` }
      }

      const segOf = (it, idx) => `[${idx}] ${it.line} 轮${it.turn ?? '-'} ${it.tool} ${human(it.bytes)}`
      // 关键：**按显示格预算切块**，而不是按固定条数。
      // 固定 8 条/页时，若一页实际只放得下 3 条，下一页却从第 9 条开始 —— 第 4~8 条永远看不到。
      // 预留足够长的尾串，保证任何一页都不会被渲染端截掉尾巴。
      // 预留必须按**最长可能**的尾串算，否则尾部会被渲染端截掉（漏算「（还有N条）」就会出这个 bug）
      // 只有在用户显式开启 allowDialogs 时才提示 pick —— 否则等于向用户推荐一条会锁键盘的路径
      const canPick = allowDialogs === true && ctx.get('tuiDialogs') !== undefined
      const RESERVE =
        cells(` 续 /redact nodes 99（还有9999条） · ${canPick ? '选择 /redact pick · ' : ''}全文 /redact nodes full · 隐藏 /redact hide <序号>`) + 6
      const chunks = []
      let cursor = 0
      while (cursor < items.length) {
        const chunk = []
        let used = cells(`共 ${items.length} 个 tool/result（最新在前）：`)
        const budget = RESULT_CELLS - RESERVE
        while (cursor < items.length) {
          const seg = segOf(items[cursor], cursor + 1)
          const cost = cells(seg) + 3
          if (chunk.length > 0 && used + cost > budget) break
          chunk.push(seg)
          used += cost
          cursor += 1
        }
        chunks.push(chunk)
      }
      const pages = chunks.length
      const asked = Number(positional[0])
      const page = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, pages) : 1
      const remain = items.length - chunks.slice(0, page).reduce((n, c) => n + c.length, 0)
      const pickHint = canPick ? '选择 /redact pick · ' : ''
      const tail =
        page < pages
          ? ` 续 /redact nodes ${page + 1}（还有${remain}条） · ${pickHint}全文 /redact nodes full · 隐藏 /redact hide <序号>`
          : ` ${pickHint}全文 /redact nodes full · 隐藏 /redact hide <序号>`
      const head = `共 ${items.length} 个 tool/result（最新在前）${pages > 1 ? `第${page}/${pages}页：` : '：'}`
      return { kind: 'success', text: `${head}${chunks[page - 1].join(' ｜ ')}${tail}` }
    }

    if (cmd === 'hide') {
      const session = invocation.agent?.session
      if (session === undefined) return { kind: 'error', text: '当前没有可用的会话' }
      let lineSpec = typeof flags.lines === 'string' ? flags.lines : undefined
      let planFile = positional[0]
      // 「/redact hide 1」直接引用上一次 /redact nodes 的第 1 条：
      // 命令短到不需要复制，绕开通知条无法选中/会被截断的限制。
      if (lineSpec === undefined && planFile !== undefined && /^\d+$/.test(planFile)) {
        const idx = Number(planFile)
        const snap = lastNodes.get(session.id)
        if (snap === undefined) return { kind: 'error', text: '还没有节点列表，请先运行 /redact nodes' }
        // 序号是「列表里的位置」，而列表是**最新在前**：期间只要新落一个 tool/result，
        // 全部序号就会整体位移 —— 不校验就会点错节点（而遮蔽是不可撤销的）。
        const fresh = collectNodes(session, 0)
        const newestNow = fresh.items?.[0]?.seq ?? -1
        if (newestNow !== snap.newestSeq) {
          return { kind: 'error', text: '节点列表已过期（期间有新的工具结果落盘，序号已位移）· 请重新运行 /redact nodes 再选' }
        }
        const list = snap.items
        if (idx < 1 || idx > list.length) return { kind: 'error', text: `序号 ${idx} 超出范围（当前 1-${list.length}）` }
        lineSpec = String(list[idx - 1].line)
        planFile = undefined
      }
      if (planFile === undefined && lineSpec === undefined) {
        return { kind: 'error', text: '用法：/redact hide <序号|plan.json> 或 /redact hide --lines <行号>' }
      }
      if (targetId !== undefined && targetId !== current) {
        return { kind: 'error', text: 'hide 只作用于当前会话；其它会话请用 /redact apply 重写日志。' }
      }
      let plan = {}
      if (planFile !== undefined) {
        plan = parsePlan(planFile)
        if (plan.error !== undefined) return { kind: 'error', text: plan.error }
      }
      const res = hideInSession(ctx, session, plan, placeholder, flags.commit === true, lineSpec)
      if (res.error !== undefined) {
        // F9：半途失败时 landed 里是**已经永久遮蔽**的节点，旧实现把它丢掉了，
        // 用户只看到一句「第 N 个失败」，完全不知道活会话已经被改了一半。
        const landed = res.landed ?? []
        const already =
          landed.length > 0
            ? ` · 已有 ${landed.length} 个节点被永久遮蔽（seq ${landed.map((l) => l.seq).slice(0, 6).join(',')}${landed.length > 6 ? '…' : ''}），该变更已生效且不可撤销，建议重开会话`
            : ''
        return { kind: 'error', text: `${res.error}${already}` }
      }
      if (flags.commit !== true) {
        const seqs = res.planned ?? []
        if (seqs.length === 0) return { kind: 'success', text: '试算：未命中任何 tool/result 节点' }
        return { kind: 'success', text: `试算：将隐藏 ${seqs.length} 个节点（seq ${seqs.slice(0, 6).join(',')}${seqs.length > 6 ? '…' : ''}）· 加 --commit 执行` }
      }
      if (res.hidden === 0) return { kind: 'success', text: '未命中任何 tool/result 节点，未做改动' }
      return {
        kind: 'success',
        text: `已隐藏 ${res.hidden} 个节点 · 下一轮请求起模型不再看到 · 磁盘字节仍在（会话关闭后用 apply 清理）`,
      }
    }

    if (cmd === 'scan' || cmd === 'plan' || cmd === 'apply') {
      const planFile = positional[0]
      if (planFile === undefined) return { kind: 'error', text: `缺少计划文件路径 · ${usage()}` }
      if (targetId === undefined) return { kind: 'error', text: '无法确定目标会话，请加 --session <id>' }
      const found = resolveLog(root, targetId)
      if (found.error) return { kind: 'error', text: found.error }
      const plan = parsePlan(planFile)
      if (plan.error) return { kind: 'error', text: plan.error }

      if (cmd === 'scan') {
        let found2
        try {
          found2 = locate(found.file, plan)
        } catch (err) {
          // 与 verify/plan/apply 保持一致：损坏日志要返回结果，不能把异常抛到 handler 外
          return { kind: 'error', text: `日志无法解析：${err.message}` }
        }
        const { lines, rowCount, scoped } = found2
        return {
          kind: 'success',
          text:
            `会话 ${targetId.slice(0, 8)} · 共 ${rowCount} 行 · 命中 ${lines.length} 行` +
            (lines.length > 0 ? `：${lines.slice(0, OUTPUT_LIMIT).join(',')}${lines.length > OUTPUT_LIMIT ? `…共${lines.length}` : ''}` : '') +
            (scoped ? ' · 已按 substitutions[].lines 限定' : '') +
            ' · 未改动任何文件',
        }
      }

      plan.blankPlaceholder = placeholder
      const live = targetId === current
      let revAtRead
      let buf
      try {
        revAtRead = revisionOf(found.file)
        buf = fs.readFileSync(found.file)
      } catch (err) {
        return { kind: 'error', text: `无法读取日志：${err.message}` }
      }

      if (cmd === 'apply' && targetId === current && flags['allow-live'] !== true) {
        return {
          kind: 'error',
          text: `拒绝改写在用会话 ${targetId.slice(0, 8)}（写句柄仍持有该日志） · 加 --allow-live 可在本会话内执行（之后需重开会话） · 或切到其它会话后执行 /redact apply <计划.json> --session ${targetId.slice(0, 8)}`,
        }
      }

      let result
      try {
        result = applyPlan(buf, plan)
      } catch (err) {
        return { kind: 'error', text: `未执行：${err.message}` }
      }
      const { out, stats, notes } = result
      // 单行统计：渲染端只给 200 格，多行会被压平再砍掉，关键信息必须在最前
      const stat =
        `行 删${stats.dropped}/空${stats.blanked}/改${stats.setFields}/换${stats.substitutions}` +
        (stats.renumbered > 0 ? `/重编号${stats.renumbered}` : '') +
        ` · 帧 留${stats.keptFrames}/写${stats.rewrittenFrames}` +
        (stats.removedFrames > 0 ? `/移除${stats.removedFrames}` : '')
      const id8 = targetId.slice(0, 8)

      if (cmd === 'plan') {
        return { kind: 'success', text: `试算 OK（未写盘） · ${id8} · ${stat} · 自检通过` }
      }

      if (live && flags['allow-live'] === true && result.tornStart !== undefined) {
        return {
          kind: 'error',
          text: `拒绝 --allow-live：日志尾部有未完成残帧（起点 ${result.tornStart} 字节），写句柄缓存着按改写前布局算出的截断偏移，下次追加会静默损坏 · 请关闭该会话后再执行（去掉 --allow-live）`,
        }
      }
      let revNow
      try {
        revNow = revisionOf(found.file)
      } catch (err) {
        return { kind: 'error', text: `未执行：无法重新读取文件状态（${err.message}）` }
      }
      if (revNow !== revAtRead) {
        return { kind: 'error', text: '未执行：日志在本次读取之后被追加过（可能有并发写入）。请稍后重试，以免覆盖掉新事件。' }
      }
      let backup
      try {
        backup = commitRewrite(found.file, out, live, revNow)
      } catch (err) {
        return { kind: 'error', text: writeFailure(err) }
      }
      // F5：purgeCache 在写盘成功之后跑，它自己绝不抛异常（失败并入成功文案）
      const purge = purgeCache(cacheRoot, targetId)
      const others = otherCopies(targetId)
      return {
        kind: 'success',
        // 顺序即优先级：渲染端只保留前 200 格，备份与「仍含原文」的提醒必须排在被截掉之前
        text:
          `已脱敏 ${id8} · 备份 ${path.basename(backup)}（仍含原文，确认无误后自行删除）` +
          ` · ${stat} · ${purgeNote(purge)}` +
          (live ? ' · 重开会话后内存历史才更新' : '') +
          (others.length > 0 ? ` · 另有 ${others.length} 处需自行处理（见文档 安全模型）` : ''),
      }
    }

    return { kind: 'error', text: `未知子命令 ${cmd} · ${usage()}` }
  }

  ctx.commands.register({
    name: 'redact',
    description: '原地脱敏 / 回退会话日志内容（不打印被处理文本）',
    input: { hint: '[list|nodes|pick|scan|hide|plan|apply|verify|purge|rollback|undo] [plan.json] [--lines <n>] [--session <id>] [--commit]' },
    recordInput: false,
    handler: (invocation) => clampResult(handler(invocation)),
  })
}

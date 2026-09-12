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
import { applyPlan, inspectBuffer, checkSeqDensity, scanFrames, decodeFrame, splitLines, loadLog } from './lib/engine.mjs'

export const name = 'dsh-redact'
/** 只消费 commands 服务，不发布任何服务，因此不需要 isolate realm。 */
export const inject = ['commands']

const OUTPUT_LIMIT = 12
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

function purgeCache(cacheRoot, sessionId) {
  const removed = []
  const dir = path.join(cacheRoot, 'session_projcache', 'sessions')
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f === `${sessionId}.json` || f.startsWith(`${sessionId}.json.bak.`)) {
        fs.rmSync(path.join(dir, f), { force: true })
        removed.push(path.join(dir, f))
      }
    }
  }
  return removed
}

/** 那些本工具不动、但同样可能残留文本的位置；只报告路径，不读取内容。 */
function otherCopies(sessionId) {
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
    const outer = data?.message?.content
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

/** 读出全部行（内存内），用于回退边界判定；绝不打印内容。 */
function readRows(file) {
  const log = loadLog(file)
  const rows = []
  for (const view of log.frameViews) {
    for (const l of view.lines) {
      const raw = view.plain.subarray(l.start, l.end).toString('utf8')
      try {
        rows.push({ logical: l.logical, row: JSON.parse(raw) })
      } catch {
        rows.push({ logical: l.logical, row: null })
      }
    }
  }
  return { rows, total: log.totalLines }
}

/**
 * 计算「回退最近 n 轮」要截断到哪一行。
 * 删除**后缀**是唯一无需重编号就安全的删除方式（引用一律向后指）。
 */
function planRollback(file, n) {
  const { rows, total } = readRows(file)
  const turnEnds = rows.filter((r) => r.row?.type === 'turn/end').map((r) => r.logical)
  if (turnEnds.length === 0) return { error: '日志里没有 turn/end 边界，无法按轮回退' }
  if (n < 1) return { error: '回退轮数必须 >= 1' }
  if (n >= turnEnds.length) {
    return { error: `只找到 ${turnEnds.length} 个完整轮次，不能回退 ${n} 轮（至少要保留 1 轮）` }
  }
  const keepTurns = turnEnds.length - n
  const boundary = turnEnds[keepTurns - 1]
  const dropFrom = boundary + 1
  // 保护：种入型会话的 inherited end-seed 标记不能被截掉，否则读取端会拒绝整份日志
  const droppedRows = rows.filter((r) => r.logical >= dropFrom)
  if (droppedRows.some((r) => r.row?.type === 'session/end-seed' && r.row?.data?.inherited === true)) {
    return { error: '截断会移除继承型 session/end-seed 标记，读取端会判定为损坏，已拒绝' }
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

/**
 * 落盘。活跃会话用**同路径原地覆盖**（open 'r+' → write → ftruncate → fsync），
 * 而不是改名替换：改名可能与此刻正在发生的追加句柄相撞（Windows 上尤其明显），
 * 且后端每批追加都是重新 open(path,'a') 写 EOF，覆盖写不会与它冲突。
 */
function commitRewrite(file, out, live) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.quarantine-${stamp}`
  fs.copyFileSync(file, backup)
  if (live) {
    const fd = fs.openSync(file, 'r+')
    try {
      fs.writeSync(fd, out, 0, out.length, 0)
      fs.ftruncateSync(fd, out.length)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } else {
    const tmp = `${file}.redact-tmp`
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, file)
  }
  return backup
}

function usage() {
  return [
    '用法：',
    '  /redact list                            列出会话（id / 版本 / 字节数）',
    '  /redact scan <plan.json> [--session <id>]   只定位命中行号，不改动任何文件',
    '  /redact nodes                           列出当前会话 tool/result 节点（行号+体积，不显示正文）',
    '  /redact hide <plan.json> [--commit]         当前会话内立刻隐藏（按 find 匹配）',
    '  /redact hide --lines <行号> [--commit]      当前会话内立刻隐藏（按行号，无需写出内容）',
    '  /redact plan <plan.json> [--session <id>]   试算，不写文件',
    '  /redact apply <plan.json> [--session <id>] [--allow-live]   执行并写隔离备份',
    '  /redact verify [--session <id>]             结构 + seq 密集性自检',
    '  /redact purge [--session <id>]              删除该会话的派生缓存',
    '  /redact rollback <轮数> [--session <id>] [--commit]   按轮回退：截断到最后 N 轮之前',
    '  /redact undo [--session <id>] [--commit]    撤销上一次脱敏：从最新隔离备份恢复',
    '',
    '四个动作的区别：',
    '  hide     = 只把内容移出模型视野（磁盘字节仍在，立即可用，无需重启）',
    '  apply    = 真正重写日志字节（需要该会话未被占用，或用 --allow-live）',
    '  rollback = 撤回已经发生的对话（后缀截断，最安全的一种删除）',
    '  undo     = 撤销我自己的脱敏（从隔离备份还原）',
    '匹配文本写在 plan.json 里（不要写在命令行上，避免进入输入历史）。',
  ].join('\n')
}

export function apply(ctx, config = {}) {
  const root = config.root ?? path.join(dshHome(), 'sessions')
  const cacheRoot = config.cacheRoot ?? path.join(dshHome(), 'storages')
  const placeholder = typeof config.placeholder === 'string' ? config.placeholder : '[已移除]'
  /** 每个会话最近一次 /redact nodes 的结果，供 /redact hide <序号> 引用。 */
  const lastNodes = new Map()

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
      try {
        const buf = fs.readFileSync(found.file)
        r = inspectBuffer(buf)
        seq = r.fatal === undefined ? checkSeqDensity(buf) : null
      } catch (err) {
        // scanFrames 对「帧魔数损坏」是直接抛错，必须在这里接住，否则会打到宿主
        return { kind: 'error', text: `日志无法解析：${err.message}` }
      }
      const ok = r.parseErrors === 0 && r.headerOk && r.fatal === undefined && seq === null
      return {
        kind: ok ? 'success' : 'error',
        text: [
          `会话 ${targetId}（v${found.version}）`,
          `帧 ${r.frames} / 行 ${r.lines} / 解析失败 ${r.parseErrors} / 头部合法 ${r.headerOk ? '是' : '否'}`,
          `seq 密集性：${seq ?? '通过'}`,
          ok ? '结论：读取端可正常打开' : `结论：有问题 —— ${r.fatal ?? seq}`,
        ].join('\n'),
      }
    }

    if (cmd === 'purge') {
      if (targetId === undefined) return { kind: 'error', text: '无法确定目标会话，请加 --session <id>' }
      const removed = purgeCache(cacheRoot, targetId)
      const others = otherCopies(targetId)
      return {
        kind: 'success',
        text: [
          `已删除 ${removed.length} 个派生缓存文件（会话 ${targetId}）`,
          ...removed.map((p) => `  ${p}`),
          others.length > 0 ? '以下位置可能仍含该会话文本，本工具不会自动改动：' : '',
          ...others.map((p) => `  ${p}`),
        ].filter(Boolean).join('\n'),
      }
    }

    if (cmd === 'rollback') {
      const n = Number(positional[0] ?? '1')
      if (!Number.isInteger(n) || n < 1) return { kind: 'error', text: `用法：/redact rollback <轮数> [--session <id>] [--commit]\n\n${usage()}` }
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
      const head = [
        `会话 ${targetId}：共 ${info.totalTurns} 个完整轮次`,
        `回退 ${info.removeTurns} 轮 → 保留 ${info.keepTurns} 轮，从第 ${info.dropFrom} 行起截断（共 ${info.droppedRows} 行会被删除）`,
      ]
      if (flags.commit !== true) return { kind: 'success', text: [...head, '试算，未改任何文件。加 --commit 执行。'].join('\n') }
      if (targetId === current && flags['allow-live'] !== true) {
        return {
          kind: 'error',
          text: [
            `拒绝截断当前正在使用的会话 ${targetId}：写句柄仍持有该日志。`,
            `安全做法：切到其它会话后执行 /redact rollback ${n} --session ${targetId}`,
            '确实要在本会话内执行，请加 --allow-live，并在之后重开会话以重新加载历史。',
          ].join('\n'),
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
          text: [
            `拒绝 --allow-live：日志末尾有未完成的残帧（起点 ${result.tornStart} 字节）。`,
            '写句柄缓存着「按改写前布局算出的截断偏移」，下次追加可能造成静默损坏。请关闭该会话后再执行。',
          ].join('\n'),
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
        backup = commitRewrite(found.file, result.out, live)
      } catch (err) {
        return { kind: 'error', text: `写入失败：${err.message}` }
      }
      const removed = purgeCache(cacheRoot, targetId)
      return {
        kind: 'success',
        text: [
          ...head,
          `已就地截断，隔离备份：${backup}`,
          `已清理派生缓存 ${removed.length} 个`,
          targetId === current ? '请重开会话以重新加载历史。' : '该会话下次打开时即为回退后的状态。',
          '确认无误后请删除隔离备份（它仍含原文）。',
        ].join('\n'),
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
      const head = [`找到 ${backups.length} 个隔离备份，最新一个：`, `  ${newest.name}  ${newest.st.size}B  ${newest.st.mtime.toISOString()}`, `当前日志：${currentBytes}B`]
      if (flags.commit !== true) return { kind: 'success', text: [...head, '试算，未改任何文件。加 --commit 恢复（当前状态会先另存为 .before-undo-<时间戳>）。'].join('\n') }
      if (targetId === current && flags['allow-live'] !== true) {
        return {
          kind: 'error',
          text: [
            `拒绝恢复当前正在使用的会话 ${targetId}：写句柄仍持有该日志。`,
            `安全做法：切到其它会话后执行 /redact undo --session ${targetId}`,
            '确实要在本会话内执行，请加 --allow-live，并在之后重开会话。',
          ].join('\n'),
        }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const aside = `${found.file}.before-undo-${stamp}`
      try {
        fs.copyFileSync(found.file, aside)
        fs.copyFileSync(newest.path, found.file)
      } catch (err) {
        return { kind: 'error', text: `恢复失败：${err.message}` }
      }
      const removed = purgeCache(cacheRoot, targetId)
      return {
        kind: 'success',
        text: [...head, '已从隔离备份恢复。', `撤销前状态另存：${aside}`, `已清理派生缓存 ${removed.length} 个`].join('\n'),
      }
    }

    if (cmd === 'nodes') {
      const session = invocation.agent?.session
      if (session === undefined) return { kind: 'error', text: '当前没有可用的会话' }
      const surface = session.surface
      if (surface === undefined || surface.nodes === undefined) return { kind: 'error', text: '当前会话没有可用的 surface' }

      // tool/result 本身不带工具名，用 message.source.callId 去 tool/call 事件里对出来，
      // 这样一眼能认出「哪条命令产生的输出」。
      const toolNames = new Map()
      const lastSeq = typeof session.seq === 'number' ? session.seq : 0
      for (let i = 0; i <= lastSeq; i++) {
        const ev = session.eventAt(i)
        if (ev !== undefined && ev.type === 'tool/call' && typeof ev.data?.callId === 'string') {
          toolNames.set(ev.data.callId, ev.data.name)
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
        const callId = event.data?.message?.source?.callId
        items.push({ line: seq + 2, seq, bytes, tool: toolNames.get(callId) ?? '(未知工具)' })
      }
      if (items.length === 0) return { kind: 'success', text: '当前会话的 surface 上没有 tool/result 节点' }

      // 倒序：最新在前。刚触发风控的几乎总是最近那条。
      items.sort((a, b) => b.seq - a.seq)
      lastNodes.set(session.id, items)
      const human = (n) => (n < 0 ? '?' : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`)
      // 单行、紧凑、最新在前，并按显示格预算逐步收敛：
      // 渲染端只给 200 格且会吃掉换行，所以宁可少列几条，也不能让关键行号被截掉。
      const tail = ' 隐藏用 /redact hide <序号>'
      const budget = RESULT_CELLS - cells(tail) - 4
      const parts = []
      let used = 0
      let shownCount = 0
      const head = `共 ${items.length} 个 tool/result（最新在前）：`
      used = cells(head)
      for (const it of items) {
        const seg = `[${shownCount + 1}] ${it.line} ${it.tool} ${human(it.bytes)}`
        const cost = cells(seg) + 3
        if (used + cost > budget) break
        parts.push(seg)
        used += cost
        shownCount += 1
      }
      const more = items.length > shownCount ? ` …另${items.length - shownCount}个` : ''
      return {
        kind: 'success',
        text: `${head}${parts.join(' ｜ ')}${more}${tail}`,
      }
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
        const list = lastNodes.get(session.id)
        if (list === undefined) return { kind: 'error', text: '还没有节点列表，请先运行 /redact nodes' }
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
      if (res.error !== undefined) return { kind: 'error', text: res.error }
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
      if (planFile === undefined) return { kind: 'error', text: `缺少计划文件路径\n\n${usage()}` }
      if (targetId === undefined) return { kind: 'error', text: '无法确定目标会话，请加 --session <id>' }
      const found = resolveLog(root, targetId)
      if (found.error) return { kind: 'error', text: found.error }
      const plan = parsePlan(planFile)
      if (plan.error) return { kind: 'error', text: plan.error }

      if (cmd === 'scan') {
        const { lines, rowCount, scoped } = locate(found.file, plan)
        return {
          kind: 'success',
          text: [
            `会话 ${targetId}：共 ${rowCount} 行，命中 ${lines.length} 行`,
            lines.length > 0 ? `命中行号：${lines.slice(0, OUTPUT_LIMIT).join(',')}${lines.length > OUTPUT_LIMIT ? ` …（共 ${lines.length}）` : ''}` : '未命中任何内容',
            scoped ? '（已有 substitutions[].lines 限定，此处只报限定区间内的命中，与 apply 语义一致）' : '',
            '（只定位，未改动任何文件）',
          ].filter(Boolean).join('\n'),
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
          text: [
            `拒绝改写当前正在使用的会话 ${targetId}：它的写句柄仍持有该日志，就地替换可能让后续追加失败。`,
            '安全做法：切到另一个会话（或先退出该会话）后执行 ——',
            `  /redact apply ${planFile} --session ${targetId}`,
            '确实要在本会话内改写，请显式加 --allow-live，并在此后重启该会话以重新加载历史。',
          ].join('\n'),
        }
      }

      let result
      try {
        result = applyPlan(buf, plan)
      } catch (err) {
        return { kind: 'error', text: `未执行：${err.message}` }
      }
      const { out, stats, notes } = result
      const summary = [
        `字节 ${buf.length} → ${out.length}`,
        `帧：保留 ${stats.keptFrames} / 重写 ${stats.rewrittenFrames} / 移除 ${stats.removedFrames}`,
        `行：删除 ${stats.dropped} / 清空 ${stats.blanked} / 路径改写 ${stats.setFields} / 字符串替换 ${stats.substitutions} / 重编号 ${stats.renumbered}`,
        ...notes,
      ]

      if (cmd === 'plan') {
        return { kind: 'success', text: [`试算通过（未写任何文件）`, ...summary, '自检：JSON 可解析、头部合法、seq 密集'].join('\n') }
      }

      if (live && flags['allow-live'] === true && result.tornStart !== undefined) {
        return {
          kind: 'error',
          text: [
            `拒绝 --allow-live：日志末尾有未完成的残帧（起点 ${result.tornStart} 字节）。`,
            '此时写句柄缓存着一个「按改写前布局算出的截断偏移」，下次追加会按它截断，可能造成静默损坏。',
            '请在会话关闭后再执行（去掉 --allow-live）。',
          ].join('\n'),
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
        backup = commitRewrite(found.file, out, live)
      } catch (err) {
        return { kind: 'error', text: `写入失败：${err.message}` }
      }
      const removed = purgeCache(cacheRoot, targetId)
      const others = otherCopies(targetId)
      return {
        kind: 'success',
        text: [
          `已就地脱敏：${found.file}`,
          ...summary,
          `隔离备份：${backup}`,
          `已清理派生缓存 ${removed.length} 个`,
          others.length > 0 ? '仍需你自行处理的位置：' : '',
          ...others.map((p) => `  ${p}`),
          '确认无误后请删除隔离备份（它仍含原文）。',
          live ? '日志文件已脱敏：磁盘与之后任何冷读/新打开视图立即生效。' : '',
          live ? '但该会话仍在运行，其内存历史与后续 provider 请求仍持有旧文本——请重开会话以丢弃内存中的旧文本。' : '',
          live ? '运行中的进程会继续向同一文件追加（只追加增量帧，不受本次改写影响）。' : '',
          live ? '本次脱敏不会撤回已经发送给模型提供方的历史请求。' : '',
        ].filter(Boolean).join('\n'),
      }
    }

    return { kind: 'error', text: `未知子命令 ${cmd}\n\n${usage()}` }
  }

  ctx.commands.register({
    name: 'redact',
    description: '原地脱敏 / 回退会话日志内容（不打印被处理文本）',
    input: { hint: '[list|nodes|scan|hide|plan|apply|verify|purge|rollback|undo] [plan.json] [--lines <n>] [--session <id>] [--commit]' },
    recordInput: false,
    handler,
  })
}

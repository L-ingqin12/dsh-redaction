#!/usr/bin/env node
/**
 * handler.selftest.mjs — dsh-plugin-redact 的「插件 handler 层 + 引擎边角」自测。
 *
 * 与 session-surgery/selftest.mjs 的分工：
 *   - 那份测的是 zsplice CLI / 引擎主路径（帧扫描、原地改写、后缀与中间删行…）；
 *   - 这份测的是 index.js 的 apply(ctx, config) + 命令 handler（list/scan/plan/apply/
 *     verify/purge、--session / --allow-live、各类错误路径），外加引擎里旧测试没覆盖的
 *     边角（嵌套 blankLines、跨帧全局替换、renumber 的引用重映射与悬空引用）。
 *   两者有少量重叠（中间行删除、损坏文件），但断言角度不同（这里断言 handler 返回值）。
 *
 * 隐私约束（本文件自身遵守，也就是被测对象的承诺）：
 *   - 绝不读取、解压、打印任何真实会话内容或缓存：不碰 ~/.dsh/sessions、~/.dsh/storages、
 *     任何真实 *.jsonl.zstd。
 *   - 全部夹具都是本文件现场造的合成日志，落在 mkdtemp 出来的临时目录里，跑完即删。
 *   - 进程内把 DSH_HOME 指向该临时目录，使插件的 otherCopies() 只探查临时目录。
 *
 * 运行（Node >= 22.15，需要 zlib zstd）：
 *   node test/handler.selftest.mjs    （需要 Node >= 22.15；无 DSH 也可跑）
 * 任何断言失败 → 退出码 1；逐条打印 PASS/FAIL，末尾打印 "N/M 通过"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ─────────────────────────────────────────────────────────── 断言框架（最先就位）

let TOTAL = 0
let PASSED = 0
const FAILED = []

function check(name, ok, detail = '') {
  TOTAL += 1
  if (ok) PASSED += 1
  else FAILED.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
function section(title) {
  console.log(`\n=== ${title} ===`)
}
/** 只打印观察，不计入断言（用于记录「看起来是真 bug」的行为）。 */
function observe(msg) {
  console.log(`  [观察·不计入断言] ${msg}`)
}

// ─────────────────────────────────────────── 全局安全网：拦下被测代码的 process.exit
// 引擎的错误路径是 die() = console.error + process.exit(1)，不是 throw。
// 若放任不管，任何一个没被 trapExit 包住的失败路径都会把整个套件悄悄带走（只剩半截输出）。
// 所以整个运行期把 process.exit 换成抛异常，只有最后收尾时才用真正的 exit。
const REAL_EXIT = process.exit.bind(process)
class EngineExit extends Error {
  constructor(code) {
    super(`被测代码调用了 process.exit(${code})`)
    this.code = code
  }
}
/** 记录每一次「被测代码想退出进程」的调用，供第 10 节的探针做忠实判定。 */
const EXIT_CALLS = []
process.exit = (code) => {
  EXIT_CALLS.push(code ?? 0)
  throw new EngineExit(code ?? 0)
}

// ─────────────────────────────────────────────────────────── 隔离环境

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-redact-handler-selftest-'))
const FAKE_HOME = path.join(TMP, 'fake-dsh-home')
const SESS_ROOT = path.join(TMP, 'sessions')
const CACHE_ROOT = path.join(TMP, 'storages')
const EDGE_ROOT = path.join(TMP, 'edge-sessions')
const PLANS = path.join(TMP, 'plans')
for (const d of [FAKE_HOME, SESS_ROOT, CACHE_ROOT, EDGE_ROOT, PLANS]) fs.mkdirSync(d, { recursive: true })
// 必须在 apply() 之前设置：插件用它算 dshHome()（otherCopies 只探查路径，不读内容）。
process.env.DSH_HOME = FAKE_HOME

const plugin = await import(pathToFileURL(path.join(HERE, '..', 'index.js')).href)
const engine = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'engine.mjs')).href)

// 记录被测版本（插件是活文件，报告里必须能对上到底是哪一版通过/失败）
const PLUGIN_SRC = fs.readFileSync(path.join(HERE, '..', 'index.js'))
const PLUGIN_REV = `${PLUGIN_SRC.length}B sha256:${crypto.createHash('sha256').update(PLUGIN_SRC).digest('hex').slice(0, 12)}`
console.log(`被测插件 index.js：${PLUGIN_REV}`)
console.log(`被测引擎 engine.mjs：${fs.readFileSync(path.join(HERE, '..', 'lib', 'engine.mjs')).length}B`)
console.log(`临时夹具目录：${TMP}（跑完即删）`)

// ─────────────────────────────────────────────────────────── 合成夹具工具

const PH = '[已移除]'
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const zframe = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM)
const headerLine = (id) => JSON.stringify({ type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 })
/** 高熵文本，让「压缩后字节数」随行数单调增长（list 排序才可预测）。 */
const entropy = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex')

/**
 * 造一份合成日志：<root>/<project>/<id>/session.v<version>.jsonl.zstd
 * batches: 每帧一个数组 = 该帧的事件行；seq/time 由本函数统一分配（seq = 事件行 0-based 序号）。
 */
function writeLog({ root = SESS_ROOT, project = 'proj-alpha', id, version = 1, batches }) {
  const dir = path.join(root, project, id)
  fs.mkdirSync(dir, { recursive: true })
  const frames = [zframe(headerLine(id) + '\n')]
  let seq = 0
  for (const batch of batches) {
    const lines = batch.map((extra) => {
      const row = { ...extra }
      row.type = row.type ?? 'test/event'
      row.time = row.time ?? 1000 + seq
      row.seq = seq
      seq += 1
      return JSON.stringify(row)
    })
    frames.push(zframe(lines.join('\n') + '\n'))
  }
  const file = path.join(dir, `session.v${version}.jsonl.zstd`)
  const buf = Buffer.concat(frames)
  fs.writeFileSync(file, buf)
  return { dir, file, buf, frameCount: frames.length, eventRows: seq }
}

/** 解码整份日志（帧 → 明文本行），只用于断言，不打印内容。 */
function decodeBuffer(buf) {
  const { frames } = engine.scanFrames(buf)
  const plains = []
  const rows = []
  frames.forEach((r, fi) => {
    const plain = engine.decodeFrame(buf, r)
    plains.push(plain)
    for (const l of engine.splitLines(plain)) {
      const raw = plain.subarray(l.start, l.end).toString('utf8')
      rows.push({ frame: fi, raw, json: JSON.parse(raw) })
    }
  })
  return { buf, frames, plains, rows, text: rows.map((r) => r.raw).join('') }
}
const decodeFile = (file) => decodeBuffer(fs.readFileSync(file))

/** 目录树快照：path → "size@mtimeMs"。用于断言「一个字节都没动」。 */
function snapshot(dir) {
  const map = new Map()
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const st = fs.statSync(p)
        map.set(p, `${st.size}@${st.mtimeMs}`)
      }
    }
  }
  walk(dir)
  return map
}
function sameSnapshot(a, b) {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}
function diffSnapshot(a, b) {
  const out = []
  for (const [k, v] of a) if (b.get(k) !== v) out.push(`${path.basename(k)}: ${v} → ${b.get(k) ?? '(消失)'}`)
  for (const k of b.keys()) if (!a.has(k)) out.push(`${path.basename(k)}: 新增`)
  return out.join('; ')
}

/** 只收 stderr，不动 process.exit：用于「引擎确实调用了 exit」的忠实观测。 */
function captureStderr(fn) {
  const realErr = console.error
  const errs = []
  console.error = (...a) => {
    errs.push(a.map((x) => String(x)).join(' '))
  }
  try {
    return { value: fn(), errs }
  } catch (e) {
    return { value: e, errs }
  } finally {
    console.error = realErr
  }
}

class ExitTrap extends Error {}
/**
 * 引擎的错误路径走的是 die() = console.error + process.exit(1)（不是 throw）。
 * 直接把进程退掉的话整个套件就没了，所以这里临时把 process.exit 换成抛异常，
 * 顺便收走 stderr。只用于「被测代码确实会 exit」的用例。
 */
function trapExit(fn) {
  const realExit = process.exit
  const realErr = console.error
  const errs = []
  process.exit = (code) => {
    const e = new ExitTrap('exit')
    e.code = code
    throw e
  }
  console.error = (...a) => {
    errs.push(a.map((x) => String(x)).join(' '))
  }
  let value
  let exited = false
  let threw = null
  try {
    value = fn()
  } catch (e) {
    if (e instanceof ExitTrap) exited = true
    else threw = e
  } finally {
    process.exit = realExit
    console.error = realErr
  }
  return { value, exited, threw, errs, code: exited ? 1 : undefined }
}

/** 只翻转「块载荷区」（保留帧头与块头）：帧边界仍可扫描，但解码/校验和必然失败。 */
function corruptFramePayload(buf, frameIndex) {
  const out = Buffer.from(buf)
  const { frames } = engine.scanFrames(out)
  const f = frames[frameIndex]
  const descriptor = out.readUInt8(f.start + 4)
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const blockHeader = f.start + 4 + 1 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  const payloadStart = blockHeader + 3
  for (let i = payloadStart; i < f.end; i++) out[i] ^= 0xa5 // 末尾 4 字节校验和一并翻掉
  return out
}

let planSeq = 0
function writePlan(obj, name) {
  const file = path.join(PLANS, name ?? `plan-${++planSeq}.json`)
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
  return file
}
const quarantineFiles = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.quarantine-'))
const tmpFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.redact-tmp'))

/** 装配插件：假 Cordis 上下文，只记录 commands.register 收到的 def。
 *  services 用来喂 ctx.get(name)：pick/nodes 走 tuiDialogs 软探测，故意不写进 inject。 */
function mount(overrides = {}, services = undefined) {
  let def = null
  let regs = 0
  const ctx = { commands: { register(d) { regs += 1; def = d } }, get: (name) => services?.[name] }
  plugin.apply(ctx, { root: SESS_ROOT, cacheRoot: CACHE_ROOT, placeholder: PH, ...overrides })
  return {
    def,
    regs,
    call: (rawInput, sessionId) =>
      def.handler({ rawInput, agent: sessionId === undefined ? {} : { session: { id: sessionId } } }),
    /** 需要传「会话对象」（surface/eventAt/append）时用它，pick/nodes 用得上。 */
    callRaw: (rawInput, agent) => def.handler({ rawInput, agent }),
  }
}

/** 用「原样 config」装配插件（含 null / undefined / 数组等形态），收走 ctx.logger.warn 并捕获抛错。
 *  专门用来锁「空 config 不会中止 boot」与「非法配置立刻抛 invalid config」。 */
function mountWithConfig(config, services = undefined) {
  let def = null
  let regs = 0
  const warns = []
  const logger = { warn: (m) => warns.push(String(m)), info: () => {}, error: () => {} }
  let error = null
  try {
    plugin.apply({ commands: { register(d) { regs += 1; def = d } }, get: (n) => services?.[n], logger }, config)
  } catch (e) {
    error = e
  }
  return {
    def,
    regs,
    warns,
    error,
    call: (rawInput, sessionId) => def.handler({ rawInput, agent: sessionId === undefined ? {} : { session: { id: sessionId } } }),
  }
}

/** 显示格宽：CJK / 全角按 2 格（与 index.js 的 cells() 同一算法，用于校验 200 格预算）。 */
const cellsOf = (s) => {
  let n = 0
  for (const ch of s) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return n
}

/** 假 TUI 对话框服务：把每次请求原样收下来，便于断言请求形状；可注入返回值或异常。
 *
 *  `delayMs` 用来区分两种「取消」：
 *   - 立即返回取消值 = 宿主没弹出面板（准入竞态，插件会识别成 error）；
 *   - 延迟 > 50ms 返回 = 真人按键取消（插件回「已取消」）。
 *  插件用耗时区分这两者，所以测真人取消必须给延迟。
 */
function mkDialogs({ select, confirm, delayMs = 0, confirmDelayMs } = {}) {
  const calls = { select: [], confirm: [] }
  const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : undefined)
  return {
    calls,
    async select(req) {
      calls.select.push(req)
      if (select instanceof Error) throw select
      await wait(delayMs)
      return typeof select === 'function' ? select(req) : select
    },
    async confirm(req) {
      calls.confirm.push(req)
      if (confirm instanceof Error) throw confirm
      await wait(confirmDelayMs ?? delayMs)
      return typeof confirm === 'function' ? confirm(req) : confirm
    },
  }
}

/** 合成一个「surface 上有 count 个 tool/result 节点」的假会话（带 tool/call 配对，便于工具名与命令行对账）。
 *  argsFor(k) 决定第 k 个节点的命令行（默认给每个节点一条可区分的命令行）。 */
function mkNodeSession(id, count, argsFor = (k) => JSON.stringify({ cmd: `tool-${k}`, q: `Q-${k}` })) {
  const events = new Map()
  const nodes = []
  for (let k = 0; k < count; k++) {
    const callSeq = k * 2
    const resultSeq = k * 2 + 1
    events.set(callSeq, { type: 'tool/call', data: { turn: k + 1, step: 1, callId: `call-${k}`, name: `tool-${k}`, arguments: argsFor(k) } })
    events.set(resultSeq, {
      type: 'tool/result',
      data: {
        turn: k + 1,
        step: 1,
        message: { role: 'tool', source: { callId: `call-${k}` }, content: [{ type: 'tool-result', content: [{ type: 'text', text: `TOXIC-OUTPUT-${k}` }] }] },
      },
    })
    nodes.push({ seq: resultSeq, line: resultSeq + 2, tool: `tool-${k}`, turn: k + 1, args: argsFor(k) })
  }
  const appended = []
  return {
    id,
    seq: count * 2,
    surface: { nodes: nodes.map((n) => n.seq) },
    /** 测试侧账本，按 seq 升序；collectNodes 返回的是它的倒序（最新在前）。 */
    nodes,
    eventAt: (s) => events.get(s),
    append: (type, data, opts) => {
      appended.push({ type, data, opts, seq: 900 + appended.length })
      return { seq: 900 + appended.length }
    },
    appended,
  }
}

const CURRENT = 'live-cur-0001'
const main = mount()
const invoke = (rawInput, sessionId = CURRENT) => main.call(rawInput, sessionId)
const invokeNoSession = (rawInput) => main.call(rawInput)

// ═══════════════════════════════════════════════════════════════════ 用例

async function run() {
  // ───────────────────────────────────────────────────── 0. 命令注册
  section('0. 命令注册（假 ctx）')
  check('apply() 恰好注册 1 个命令', main.regs === 1, `实际 ${main.regs}`)
  check('命令名是 redact', main.def?.name === 'redact', String(main.def?.name))
  check('recordInput=false（匹配串不进输入历史）', main.def?.recordInput === false)
  check('handler 是函数', typeof main.def?.handler === 'function')
  const hint = main.def?.input?.hint ?? ''
  check('input.hint 列出六个必备子命令', ['list', 'scan', 'plan', 'apply', 'verify', 'purge'].every((c) => hint.includes(c)), hint)
  // pick 是唯一异步分支（要 await 对话框），但 handler 本身必须保持同步：
  // 一旦整体改成 async，所有同步调用都会拿到 Promise，下面 150+ 条断言会集体失效。
  const syncProbe = main.call('list', CURRENT)
  check('非 pick 分支同步返回（handler 未被 async 化）', syncProbe !== null && typeof syncProbe?.then !== 'function' && typeof syncProbe?.kind === 'string', typeof syncProbe)

  // ───────────────────────────────────────────────────── 0b. config 校验（空 config 不得中止 boot）
  section('0b. config 校验（null / undefined / {} 等价；非法值立刻抛 invalid config）')
  const DEF_ROOT = path.join(FAKE_HOME, 'sessions') // config 缺省时的 root
  const DEF_CACHE = path.join(FAKE_HOME, 'storages') // config 缺省时的 cacheRoot
  // 此时 DEF_ROOT 还不存在 → list 的空结果会把生效的 root 原样回显出来，正好当「回落默认」的证据
  const cfgNull = mountWithConfig(null)
  const cfgUndef = mountWithConfig(undefined)
  const cfgEmpty = mountWithConfig({})
  const cfgNullList = cfgNull.call('list', 'someone-else')
  const cfgUndefList = cfgUndef.call('list', 'someone-else')
  const cfgEmptyList = cfgEmpty.call('list', 'someone-else')
  check('apply(ctx, null) 注册成功且 root 回落默认', cfgNull.error === null && cfgNull.regs === 1 && cfgNullList.text.includes(DEF_ROOT), cfgNullList.text)
  check('apply(ctx, undefined) 注册成功且 root 回落默认', cfgUndef.error === null && cfgUndef.regs === 1 && cfgUndefList.text.includes(DEF_ROOT), cfgUndefList.text)
  check('apply(ctx, {}) 注册成功且 root 回落默认', cfgEmpty.error === null && cfgEmpty.regs === 1 && cfgEmptyList.text.includes(DEF_ROOT), cfgEmptyList.text)
  check('★ null / undefined / {} 三者完全等价（空 config 不会中止 boot）', cfgNullList.text === cfgUndefList.text && cfgUndefList.text === cfgEmptyList.text, cfgNullList.text)

  const cfgBogus = mountWithConfig({ bogus: 1 })
  check(
    '未知键只 warn 不抛错（经 ctx.logger.warn）',
    cfgBogus.error === null && cfgBogus.regs === 1 && cfgBogus.warns.some((w) => w.includes('bogus')),
    cfgBogus.warns.join(' | ') || '(没有任何 warn)',
  )
  for (const [name, bad, key] of [
    ['root 为空字符串', { root: '' }, '$.root'],
    ['root 只有空白字符', { root: '   ' }, '$.root'],
    ['placeholder 为 null', { placeholder: null }, '$.placeholder'],
    ['root 是数字', { root: 12345 }, '$.root'],
    ['config 是数组', [1, 2], 'expected an object'],
    ['dialogTimeoutMs 为 -1', { dialogTimeoutMs: -1 }, '$.dialogTimeoutMs'],
    ['dialogTimeoutMs 为 1.5', { dialogTimeoutMs: 1.5 }, '$.dialogTimeoutMs'],
    ["dialogTimeoutMs 为 '5000'", { dialogTimeoutMs: '5000' }, '$.dialogTimeoutMs'],
    ['dialogTimeoutMs 为 null', { dialogTimeoutMs: null }, '$.dialogTimeoutMs'],
    ['argsCells 为 -1', { argsCells: -1 }, '$.argsCells'],
    ['argsCells 为 1.5', { argsCells: 1.5 }, '$.argsCells'],
    ["argsCells 为 '60'", { argsCells: '60' }, '$.argsCells'],
  ]) {
    const m = mountWithConfig(bad)
    check(
      `${name} → 抛 invalid config（${key}）且不注册命令`,
      m.error !== null && /invalid config/.test(m.error.message) && m.error.message.includes(key) && m.regs === 0,
      m.error?.message ?? '(未抛错)',
    )
  }
  // 默认值的行为证据：在默认 root/cacheRoot 下造夹具，用 apply(ctx, null) 那个 mount 走一遍
  writeLog({ root: DEF_ROOT, project: 'proj-cfg', id: 'cfg-0001', batches: [[{ data: { text: 'CFG-SECRET-1' } }, { data: { text: 'keep-me' } }]] })
  const defCacheDir = path.join(DEF_CACHE, 'session_projcache', 'sessions')
  fs.mkdirSync(defCacheDir, { recursive: true })
  const defCacheFile = path.join(defCacheDir, 'cfg-0001.json')
  fs.writeFileSync(defCacheFile, '{"synthetic":true}')
  const cfgPurge = cfgNull.call('purge --session cfg-0001', 'someone-else')
  check('默认 cacheRoot 生效（purge 命中 <DSH_HOME>/storages）', !fs.existsSync(defCacheFile) && /已清理缓存\s*1\s*个/.test(cfgPurge.text), cfgPurge.text)
  const cfgPlanFile = writePlan({ blankLines: '3' }, 'cfg-plan.json')
  const cfgApply = cfgNull.call(`apply ${cfgPlanFile} --session cfg-0001`, 'someone-else')
  const cfgApplied = decodeFile(path.join(DEF_ROOT, 'proj-cfg', 'cfg-0001', 'session.v1.jsonl.zstd'))
  check('默认 root 与默认 placeholder 生效（写入 [已移除]）', cfgApply.kind === 'success' && cfgApplied.rows[2].json.data.text === PH, cfgApply.text)

  // ───────────────────────────────────────────────────── 1. list
  section('1. list（当前会话标记 + 单行 / 200 显示格预算）')
  const LIVE_SECRET = 'LIVE-NEEDLE-7788'
  for (let i = 1; i <= 14; i++) {
    const id = `sess-${String(i).padStart(2, '0')}`
    writeLog({
      project: i % 2 ? 'proj-alpha' : 'proj-beta',
      id,
      batches: [Array.from({ length: i * 3 }, (_, k) => ({ data: { text: entropy(`${id}-${k}`) } }))],
    })
  }
  // 当前会话：行数最多 → 压缩后字节数最大 → 必然出现在前 12 行里
  writeLog({
    id: CURRENT,
    batches: [Array.from({ length: 60 }, (_, k) => ({ data: { text: k === 3 ? LIVE_SECRET : entropy(`cur-${k}`) } }))],
  })
  writeLog({ project: 'proj-alpha', id: 'sess-secret', batches: [[{ data: { text: LIVE_SECRET } }]] })

  const listed = invoke('list')
  check('list → kind:success', listed.kind === 'success', listed.kind)
  check('list 报告会话总数 16', listed.text.includes('共 16 个会话'), listed.text.split('\n')[0])
  // 渲染端（dsh-tui cleanRenderText，200 显示格）会把换行压平并截断，
  // 所以所有输出都必须是单行、短、重要信息在前。
  check('★ list 输出为单行', !listed.text.includes('\n'), JSON.stringify(listed.text.slice(0, 50)))
  check('★ list 输出 <=200 显示格', [...listed.text].length <= 200, `字符 ${[...listed.text].length}`)
  const segs = listed.text.split(' ｜ ')
  const entries = segs.filter((s) => /^[\w-]+ [\d.]+(?:B|KB|MB)(?:\(当前\))?$/.test(s.trim()))
  check('list 列出会话条目且不超过显示格预算', entries.length >= 3 && entries.length <= 12, `实际 ${entries.length}`)
  check('list 标注被截断的剩余数量', /…另\d+个/.test(listed.text), segs.at(-1))
  const marked = segs.filter((s) => s.includes('(当前)'))
  const markedId = marked[0]?.match(/([\w-]+) [\d.]+(?:B|KB|MB)\(当前\)/)?.[1]
  check('当前会话被标记，且只有一条被标记', marked.length === 1 && markedId === CURRENT.slice(0, 8), `${markedId ?? '(无)'} vs ${CURRENT.slice(0, 8)}`)
  check('list 打印人类可读体积', /[\d.]+(?:B|KB|MB)/.test(listed.text))
  check('★ list 不回显任何日志内容', !listed.text.includes(LIVE_SECRET))

  // ───────────────────────────────────────────────────── 2. scan
  section('2. scan（只给行号与计数，绝不回显被搜索的字面量）')
  const SCAN_NEEDLE = 'SCAN-NEEDLE-771'
  writeLog({
    id: 'scan-0001',
    batches: [
      [{ data: { text: `alpha ${SCAN_NEEDLE} tail` } }, { data: { text: 'beta ordinary' } }],
      [{ data: { text: 'gamma' } }, { data: { text: `delta ${SCAN_NEEDLE}` } }],
      [{ data: { text: 'epsilon' } }],
    ],
  })
  const scanPlan = writePlan({ substitutions: [{ find: SCAN_NEEDLE, replace: PH }] }, 'scan-plan.json')
  const beforeScan = snapshot(TMP)
  const scanned = invoke(`scan ${scanPlan} --session scan-0001`, 'someone-else')
  check('scan → kind:success', scanned.kind === 'success', scanned.kind)
  check('scan 报告总行数与命中行数（单行）', /共\s*6\s*行\s*·\s*命中\s*2\s*行/.test(scanned.text) && !scanned.text.includes('\n'), scanned.text)
  check('scan 给出命中行号 2,5', /命中\s*2\s*行：2,5(?=\s|·|$)/.test(scanned.text), scanned.text)
  check('★ scan 输出不含被搜索的字面量', !scanned.text.includes(SCAN_NEEDLE))
  check('scan 输出不含命中行的任何正文', !scanned.text.includes('ordinary') && !scanned.text.includes('epsilon'))
  check('scan 明确声明未改动文件（单行）', /未改动任何文件/.test(scanned.text) && !scanned.text.includes('\n'), scanned.text)
  check('scan 真的没动任何文件（size+mtime）', sameSnapshot(beforeScan, snapshot(TMP)), diffSnapshot(beforeScan, snapshot(TMP)))

  writeLog({
    id: 'scan-many',
    batches: [Array.from({ length: 14 }, (_, k) => ({ data: { text: `m${k} ${SCAN_NEEDLE}` } }))],
  })
  const scannedMany = invoke(`scan ${scanPlan} --session scan-many`, 'someone-else')
  check('scan 命中 >8 行时只列 8 个行号并标注总数（单行）', /命中\s*14\s*行：(?:\d+,){7}\d+…共14\b/.test(scannedMany.text) && !scannedMany.text.includes('\n'), scannedMany.text)
  check('scan 截断时同样不回显字面量', !scannedMany.text.includes(SCAN_NEEDLE))

  // ───────────────────────────────────────────────────── 3. plan（试算不写盘）
  section('3. plan（dry run，一个字节都不写）')
  const planLog = writeLog({
    id: 'plan-0001',
    batches: [
      [{ data: { text: 'PLAN-SECRET-A' } }, { data: { text: 'keep-1' } }],
      [{ data: { text: 'PLAN-SECRET-B' } }],
    ],
  })
  const dryPlan = writePlan(
    {
      substitutions: [{ find: 'PLAN-SECRET', replace: PH, lines: '2' }],
      setFields: [{ line: 3, path: 'data.text', value: PH }],
      blankLines: '4',
    },
    'dry-plan.json',
  )
  const beforeDry = snapshot(TMP)
  const dry = invoke(`plan ${dryPlan} --session plan-0001`, 'someone-else')
  check('plan → kind:success 且声明未写盘（单行）', dry.kind === 'success' && /试算\s*OK（未写盘）/.test(dry.text) && !dry.text.includes('\n'), dry.text)
  // 数字是硬事实（清空 1 行 / 路径改写 1 处 / 字符串替换 1 处 / 未删行），措辞与分隔符可以变。
  check(
    'plan 输出统计与自检结论',
    /删\s*0\b/.test(dry.text) && /空\s*1\b/.test(dry.text) && /改\s*1\b/.test(dry.text) && /换\s*1\b/.test(dry.text) && /自检通过/.test(dry.text),
    dry.text,
  )
  check('plan 输出不含被处理的正文', !dry.text.includes('PLAN-SECRET') && !dry.text.includes('keep-1'))
  check('★ plan 未改动任何文件（size+mtime 全等）', sameSnapshot(beforeDry, snapshot(TMP)), diffSnapshot(beforeDry, snapshot(TMP)))
  check('plan 未留下隔离备份 / .redact-tmp', quarantineFiles(planLog.dir).length === 0 && tmpFiles(planLog.dir).length === 0)

  // ───────────────────────────────────────────────────── 4. apply（真写盘 + 隔离备份）
  section('4. apply（就地脱敏、隔离备份、行数与 seq 不变）')
  const A_SECRET = 'APPLY-SECRET-42'
  const A_SECRET2 = 'APPLY-SECRET-99'
  const applyLog = writeLog({
    id: 'apply-0001',
    batches: [
      [{ data: { text: `one ${A_SECRET}` } }, { data: { text: 'two plain' } }], // 行 2,3
      [{ data: { text: `three ${A_SECRET2}` } }], // 行 4
      [{ data: { text: `four ${A_SECRET}` } }, { data: { text: 'five plain' } }, { data: { text: 'six blank-me' } }], // 行 5,6,7
    ],
  })
  const beforeApply = decodeFile(applyLog.file)
  const beforeSeq = beforeApply.rows.slice(1).map((r) => r.json.seq)
  // apply 也应顺手清掉该会话的派生缓存
  const applyCacheDir = path.join(CACHE_ROOT, 'session_projcache', 'sessions')
  fs.mkdirSync(applyCacheDir, { recursive: true })
  const applyCache = path.join(applyCacheDir, 'apply-0001.json')
  const applyCacheBak = path.join(applyCacheDir, 'apply-0001.json.bak.1699999999')
  fs.writeFileSync(applyCache, '{"synthetic":true}')
  fs.writeFileSync(applyCacheBak, '{"synthetic":true}')

  const applyPlanFile = writePlan(
    {
      substitutions: [{ find: A_SECRET, replace: PH }],
      setFields: [{ line: 4, path: 'data.text', value: PH }],
      blankLines: '7',
    },
    'apply-plan.json',
  )
  const applied = invoke(`apply ${applyPlanFile} --session apply-0001`, 'someone-else')
  check('apply → kind:success', applied.kind === 'success', applied.kind)
  check(
    'apply 输出统计（替换 2 / 清空 1 / 路径改写 1 / 未删行，单行）',
    /已脱敏/.test(applied.text) && /删\s*0\b/.test(applied.text) && /空\s*1\b/.test(applied.text) && /改\s*1\b/.test(applied.text) && /换\s*2\b/.test(applied.text) && !applied.text.includes('\n'),
    applied.text,
  )
  check('apply 输出帧统计（保留 1 / 重写 3）与备份文件名', /帧\s*留\s*1\s*\/\s*写\s*3/.test(applied.text) && /备份\s+\S*\.quarantine-\S+/.test(applied.text), applied.text)
  check('★ apply 输出不回显被脱敏的正文', !applied.text.includes(A_SECRET) && !applied.text.includes(A_SECRET2))
  check('apply 声明已清理派生缓存 2 个（单行）', /缓存清理\s*2\b/.test(applied.text) && !applied.text.includes('\n'), applied.text)

  const afterBuf = fs.readFileSync(applyLog.file)
  check('★ 日志文件确实变了', !afterBuf.equals(applyLog.buf), `${applyLog.buf.length}B → ${afterBuf.length}B`)
  const quars = quarantineFiles(applyLog.dir)
  check('生成了 1 个 .quarantine-<时间戳> 兄弟文件', quars.length === 1, quars.join(','))
  check('隔离备份名带 ISO 时间戳', new RegExp(`\\.quarantine-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$`).test(quars[0] ?? ''), quars[0])
  check('★ 隔离备份内容 = 原始字节', quars.length === 1 && fs.readFileSync(path.join(applyLog.dir, quars[0])).equals(applyLog.buf))
  check('apply 未留下 .redact-tmp', tmpFiles(applyLog.dir).length === 0)
  check('apply 清掉了本会话派生缓存', !fs.existsSync(applyCache) && !fs.existsSync(applyCacheBak))

  const afterApply = decodeFile(applyLog.file)
  check('★ 行数不变（7 行）', afterApply.rows.length === beforeApply.rows.length && afterApply.rows.length === 7, `${beforeApply.rows.length} → ${afterApply.rows.length}`)
  check('★ 每行 seq 不变且仍等于行号-1', JSON.stringify(afterApply.rows.slice(1).map((r) => r.json.seq)) === JSON.stringify(beforeSeq) && afterApply.rows.slice(1).every((r, i) => r.json.seq === i))
  check('★ checkSeqDensity 仍然通过', engine.checkSeqDensity(afterBuf) === null, engine.checkSeqDensity(afterBuf) ?? '')
  const inspAfter = engine.inspectBuffer(afterBuf)
  check('结构自检：4 帧 / 解析失败 0 / 头部合法', inspAfter.frames === 4 && inspAfter.parseErrors === 0 && inspAfter.headerOk === true)
  check('★ 被搜索的字面量已从日志中消失', !afterApply.text.includes(A_SECRET) && !afterApply.text.includes(A_SECRET2))
  check('全局替换在第 2 行与第 5 行都生效', afterApply.rows[1].json.data.text === `one ${PH}` && afterApply.rows[4].json.data.text === `four ${PH}`, afterApply.rows[1].json.data.text)
  check('setFields 改写第 4 行', afterApply.rows[3].json.data.text === PH)
  check('blankLines 清空第 7 行全部字符串', afterApply.rows[6].json.data.text === PH)
  check('清空未破坏 type/seq/time', afterApply.rows[6].json.type === 'test/event' && afterApply.rows[6].json.seq === 5 && afterApply.rows[6].json.time === 1005)
  check('未命中的第 3 行与第 6 行原样保留', afterApply.rows[2].json.data.text === 'two plain' && afterApply.rows[5].json.data.text === 'five plain')
  check('未触碰的第 0 帧（头部）原字节保留', afterApply.buf.subarray(afterApply.frames[0].start, afterApply.frames[0].end).equals(applyLog.buf.subarray(beforeApply.frames[0].start, beforeApply.frames[0].end)))

  // ───────────────────────────────────────────────────── 5. 在用会话拒绝
  section('5. 在用（当前）会话：默认拒绝，--allow-live 放行')
  const liveDir = path.join(SESS_ROOT, 'proj-alpha', CURRENT)
  const liveFile = path.join(liveDir, 'session.v1.jsonl.zstd')
  const liveBefore = fs.readFileSync(liveFile)
  const liveStat = fs.statSync(liveFile)
  const livePlan = writePlan({ substitutions: [{ find: LIVE_SECRET, replace: PH }] }, 'live-plan.json')

  const refused = invoke(`apply ${livePlan} --session ${CURRENT}`) // current === target
  check('apply 当前会话 → kind:error', refused.kind === 'error', refused.kind)
  // BUG-α 修复后：拒绝信息是**单行**，且可执行出路（--allow-live / 换会话执行）必须排在 200 格之内
  check(
    '拒绝信息说明原因并给出可执行的出路（单行，出路在前）',
    !refused.text.includes('\n') &&
      /拒绝改写在用会话/.test(refused.text) &&
      refused.text.includes('--allow-live') &&
      /\/redact apply .* --session /.test(refused.text) &&
      refused.text.indexOf('--allow-live') < 120,
    refused.text,
  )
  check('★ 拒绝后日志一个字节都没动', fs.readFileSync(liveFile).equals(liveBefore) && fs.statSync(liveFile).mtimeMs === liveStat.mtimeMs)
  check('拒绝后没有留下隔离备份 / .redact-tmp', quarantineFiles(liveDir).length === 0 && tmpFiles(liveDir).length === 0)
  const refusedImplicit = invoke(`apply ${livePlan}`) // 未写 --session，落到当前会话
  check(
    '未写 --session（默认落到当前会话）同样拒绝',
    refusedImplicit.kind === 'error' && !refusedImplicit.text.includes('\n') && /拒绝改写在用会话/.test(refusedImplicit.text) && refusedImplicit.text.includes('--allow-live'),
    refusedImplicit.text,
  )

  const allowed = invoke(`apply ${livePlan} --session ${CURRENT} --allow-live`)
  check('--allow-live → kind:success', allowed.kind === 'success', allowed.text.split('\n')[0])
  const liveAfter = fs.readFileSync(liveFile)
  check('放行后日志确实被改写', !liveAfter.equals(liveBefore))
  check('放行后留下含原始字节的隔离备份', quarantineFiles(liveDir).some((f) => fs.readFileSync(path.join(liveDir, f)).equals(liveBefore)))
  check('放行后行数仍为 61 且 seq 密集', decodeFile(liveFile).rows.length === 61 && engine.checkSeqDensity(liveAfter) === null)
  check('放行后字面量已消失', !decodeFile(liveFile).text.includes(LIVE_SECRET))

  // ───────────────────────────────────────────────────── 6. 错误路径
  section('6. 错误路径（返回 kind:error、消息有用、什么都不改）')
  writeLog({ id: 'err-0001', batches: [[{ data: { text: 'ERR-ROW-1' } }, { data: { text: 'ERR-ROW-2' } }]] })
  const missingPlan = path.join(PLANS, 'never-written.json')
  const badJsonPlan = writePlan('{ "substitutions": [ ', 'bad-plan.json')
  const beforeErr = snapshot(TMP)
  const ghostRoot = path.join(TMP, 'no-such-root')
  const ghost = mount({ root: ghostRoot })

  const errCases = [
    ['缺计划文件位置参数', invoke('apply --session err-0001', 'someone-else'), '缺少计划文件路径'],
    ['计划文件不存在', invoke(`scan ${missingPlan} --session err-0001`, 'someone-else'), '无法解析'],
    ['计划 JSON 不可解析', invoke(`plan ${badJsonPlan} --session err-0001`, 'someone-else'), '无法解析'],
    ['未知子命令', invoke('frobnicate'), '未知子命令'],
    ['未知会话 id', invoke('verify --session no-such-session-xyz', 'someone-else'), '找不到会话'],
    ['既无 --session 也无当前会话', invokeNoSession('verify'), '无法确定目标会话'],
    ['不存在的 root（scan）', ghost.call(`scan ${scanPlan} --session err-0001`, 'someone-else'), '会话根目录不存在'],
    ['不存在的 root（apply）', ghost.call(`apply ${scanPlan} --session err-0001`, 'someone-else'), '会话根目录不存在'],
    ['不存在的 root（verify）', ghost.call('verify --session err-0001', 'someone-else'), '会话根目录不存在'],
  ]
  for (const [name, res, needle] of errCases) {
    check(`${name} → kind:error`, res.kind === 'error', res.kind)
    check(`${name} → 消息含「${needle}」`, typeof res.text === 'string' && res.text.includes(needle), String(res.text).split('\n')[0])
  }
  const multiLineErrs = errCases.filter(([, res]) => res.text.includes('\n')).map(([name]) => name)
  check('★ 错误路径输出同样受单行契约约束（含用法提示的那些）', multiLineErrs.length === 0, multiLineErrs.join(' / ') || '全部单行')
  check('★ 以上错误路径都没有改动任何文件', sameSnapshot(beforeErr, snapshot(TMP)), diffSnapshot(beforeErr, snapshot(TMP)))

  // ───────────────────────────────────────────────────── 7. verify
  section('7. verify（好日志通过 / 损坏日志报错）')
  writeLog({ id: 'verify-ok', batches: [[{ data: { text: 'ok-1' } }], [{ data: { text: 'ok-2' } }]] })
  const vOk = invoke('verify --session verify-ok', 'someone-else')
  check('verify 好日志 → kind:success', vOk.kind === 'success', vOk.kind)
  check('verify 输出结构统计（帧 3 / 行 3 / 头部合法，单行）', /帧\s*3\b/.test(vOk.text) && /行\s*3\b/.test(vOk.text) && /头部合法/.test(vOk.text) && !vOk.text.includes('\n'), vOk.text)
  check('verify 输出 seq 密集性与结论（单行）', /seq 密集/.test(vOk.text) && /读取端可打开/.test(vOk.text) && !vOk.text.includes('\n'), vOk.text)
  check('verify 不回显日志内容', !vOk.text.includes('ok-1') && !vOk.text.includes('ok-2'))

  const victim = writeLog({ id: 'verify-bad', batches: [[{ data: { text: 'bad-1' } }], [{ data: { text: 'bad-2' } }], [{ data: { text: 'bad-3' } }]] })
  const corrupted = corruptFramePayload(fs.readFileSync(victim.file), 1) // 头帧之后的第 1 帧
  fs.writeFileSync(victim.file, corrupted)
  check('（前置）损坏后帧边界仍可扫描（4 帧）', engine.scanFrames(corrupted).frames.length === 4)
  check('（前置）损坏帧确实解不开', engine.inspectBuffer(corrupted).fatal !== undefined, engine.inspectBuffer(corrupted).fatal ?? '')
  const vBad = invoke('verify --session verify-bad', 'someone-else')
  check('★ verify 损坏日志 → kind:error', vBad.kind === 'error', vBad.kind)
  check('verify 报出帧解码失败', vBad.text.includes('解码失败'), vBad.text.split('\n')[1])
  check('verify 结论为「有问题」（✗ + 问题：+ 解码失败，单行）', /✗/.test(vBad.text) && /问题：/.test(vBad.text) && /解码失败/.test(vBad.text) && !vBad.text.includes('\n'), vBad.text)

  // ───────────────────────────────────────────────────── 8. purge
  section('8. purge（删派生缓存，不误伤别的会话）')
  const cacheDir = path.join(CACHE_ROOT, 'session_projcache', 'sessions')
  fs.mkdirSync(cacheDir, { recursive: true })
  const PURGE_ID = 'purge-0001'
  const pMain = path.join(cacheDir, `${PURGE_ID}.json`)
  const pBak = path.join(cacheDir, `${PURGE_ID}.json.bak.1699999999`)
  const kMain = path.join(cacheDir, 'keep-0002.json')
  const kBak = path.join(cacheDir, 'keep-0002.json.bak.1699999998')
  const pSimilar = path.join(cacheDir, `${PURGE_ID}.jsonx`) // 前缀相似，不该被误删
  for (const f of [pMain, pBak, kMain, kBak, pSimilar]) fs.writeFileSync(f, '{"synthetic":true}')
  const purged = invoke(`purge --session ${PURGE_ID}`, 'someone-else')
  check('purge → kind:success', purged.kind === 'success', purged.kind)
  check('purge 报告删除 2 个文件（单行）', /已清理缓存\s*2\s*个/.test(purged.text) && !purged.text.includes('\n'), purged.text)
  check('★ purge 删掉 <id>.json', !fs.existsSync(pMain))
  check('★ purge 删掉 <id>.json.bak.*', !fs.existsSync(pBak))
  check('无关会话的缓存幸存', fs.existsSync(kMain) && fs.existsSync(kBak))
  check('前缀相似的其它文件不被误删', fs.existsSync(pSimilar))
  const purgeNoTarget = invokeNoSession('purge')
  check('purge 无目标会话 → kind:error', purgeNoTarget.kind === 'error' && purgeNoTarget.text.includes('无法确定目标会话'))

  // ───────────────────────────────────────────────────── 8b. hide（会话内即隐，可能是新增子命令）
  section('8b. hide（会话内 surface 替换；若本版没有该子命令则跳过）')
  const HIDE_NEEDLE = 'HIDE-SECRET-313'
  const hidePlanFile = writePlan({ substitutions: [{ find: HIDE_NEEDLE, replace: PH }] }, 'hide-plan.json')
  const hideProbe = invoke(`hide ${hidePlanFile} --session ${CURRENT}`)
  if (hideProbe.kind === 'error' && hideProbe.text.includes('未知子命令')) {
    console.log('  (本版插件没有 hide 子命令：跳过 8b，其余用例不受影响)')
  } else {
    const mkSession = () => {
      const appended = []
      // 真实消息形状（dsh-llm/lib/types/message.d.ts:22-25）：tool/result 的 message 是
      // role:'user' + source:{kind:'tool',callId}，不是 role:'tool'；user/message 的 data
      // 就是消息本身。夹具写错形状正是 F1/F2 能从绿色套件里溜过去的原因。
      const toolMsg = (id, callId, content) => ({
        id,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content }],
      })
      const events = new Map([
        [1, { type: 'tool/result', data: { message: toolMsg('r1', 'c1', [{ type: 'text', text: `结果含 ${HIDE_NEEDLE} 明文` }]) } }],
        [2, { type: 'user/message', data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `用户也提到 ${HIDE_NEEDLE}` }] } }],
        [3, { type: 'tool/result', data: { message: toolMsg('r3', 'c3', `纯字符串 ${HIDE_NEEDLE}`) } }],
        [4, { type: 'tool/result', data: { message: toolMsg('r4', 'c4', '无关内容') } }],
      ])
      return {
        id: CURRENT,
        surface: { nodes: [1, 2, 3, 4] },
        eventAt: (seq) => events.get(seq),
        append: (type, data, opts) => {
          appended.push({ type, data, opts })
          return { seq: 900 + appended.length }
        },
        appended,
      }
    }
    const beforeHide = snapshot(TMP)
    const hideSession = mkSession()
    const dryHide = main.def.handler({ rawInput: `hide ${hidePlanFile}`, agent: { session: hideSession } })
    check('hide 默认只试算 → kind:success', dryHide.kind === 'success', dryHide.kind)
    check('hide 试算只圈 tool/result 表面节点，跳过 user/message', /将隐藏 2 个节点/.test(dryHide.text) && dryHide.text.includes('1,3'), dryHide.text)
    check('★ hide 试算不回显被隐藏的正文', !dryHide.text.includes(HIDE_NEEDLE))
    check('hide 试算不写入会话（append 未被调用）', hideSession.appended.length === 0)
    check('hide 试算不碰磁盘', sameSnapshot(beforeHide, snapshot(TMP)), diffSnapshot(beforeHide, snapshot(TMP)))

    const commitHide = main.def.handler({ rawInput: `hide ${hidePlanFile} --commit`, agent: { session: hideSession } })
    check('hide --commit → kind:success', commitHide.kind === 'success', commitHide.text.split('\n')[0])
    check('hide --commit 追加 2 个 tool/result 替换节点', hideSession.appended.length === 2 && hideSession.appended.every((a) => a.type === 'tool/result'), `实际 ${hideSession.appended.length}`)
    check(
      '★ 替换节点带 surfaceOp{replace} 与 sourceEventSeqs',
      JSON.stringify(hideSession.appended.map((a) => a.opts)) ===
        JSON.stringify([
          { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] },
          { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] },
        ]),
      JSON.stringify(hideSession.appended.map((a) => a.opts)),
    )
    const hideBodies = hideSession.appended.map((a) => JSON.stringify(a.data))
    check('★ 替换后的正文不再含原字面量，且已换成占位符', hideBodies.every((b) => !b.includes(HIDE_NEEDLE)) && hideBodies.every((b) => b.includes(PH)))
    check('hide 不删磁盘字节（只在内存 surface 上遮蔽）', sameSnapshot(beforeHide, snapshot(TMP)))
    check(
      'hide --session 指向别的会话 → kind:error',
      main.def.handler({ rawInput: `hide ${hidePlanFile} --session some-other`, agent: { session: mkSession() } }).kind === 'error',
    )
    check('hide 没有会话对象 → kind:error', main.def.handler({ rawInput: `hide ${hidePlanFile}`, agent: {} }).text.includes('没有可用的会话'))
    const noFindPlan = writePlan({ blankLines: '2' }, 'hide-nofind.json')
    check(
      'hide 计划里没有 substitutions[].find → kind:error',
      main.def.handler({ rawInput: `hide ${noFindPlan}`, agent: { session: mkSession() } }).text.includes('没有 substitutions'),
    )
    check(
      'hide 计划文件不存在 → kind:error',
      main.def.handler({ rawInput: `hide ${path.join(PLANS, 'nope.json')}`, agent: { session: mkSession() } }).text.includes('无法解析'),
    )
  }

  // ───────────────────────────────────────────────────── 8c. pick（TUI 对话框选择）
  section('8c. pick（tuiDialogs 软探测、选中映射、取消与异常路径）')
  const pickSession = mkNodeSession(CURRENT, 5)
  const newestFirst = pickSession.nodes.slice().reverse() // collectNodes 最新在前
  const pickDialogs = mkDialogs({ select: '2', confirm: true })
  const picker = mount({ allowDialogs: true }, { tuiDialogs: pickDialogs, tokenMeter: { estimateMessage: () => 42 } })
  const beforePick = snapshot(TMP)

  const pickedRaw = picker.callRaw('pick', { session: pickSession })
  check('pick 返回 Promise（只有该分支异步，handler 仍同步）', pickedRaw !== null && typeof pickedRaw?.then === 'function', String(typeof pickedRaw))
  const picked = await pickedRaw
  check('pick 确认后 → kind:success', picked.kind === 'success', picked.text)
  check(
    'select 请求形状正确（title 非空 / timeoutMs / options 数组）',
    pickDialogs.calls.select.length === 1 &&
      typeof pickDialogs.calls.select[0].title === 'string' &&
      pickDialogs.calls.select[0].title.length > 0 &&
      // 默认 15 秒：面板没渲染时界面被让出键盘，超时就是「卡死」的上限，所以不能设太长
      pickDialogs.calls.select[0].timeoutMs === 15000 &&
      Array.isArray(pickDialogs.calls.select[0].options),
    JSON.stringify(pickDialogs.calls.select[0] ?? null).slice(0, 140),
  )
  const pickOpts = pickDialogs.calls.select[0].options
  check('options id 为 1..N 且覆盖全部节点', pickOpts.length === 5 && pickOpts.every((o, i) => o.id === String(i + 1)), `options=${pickOpts.length}`)
  check(
    'options label 指向对应节点的行号与工具名',
    pickOpts[0].label.includes(`行 ${newestFirst[0].line}`) && pickOpts[0].label.includes(newestFirst[0].tool) && pickOpts[1].label.includes(`行 ${newestFirst[1].line}`),
    pickOpts[1].label,
  )
  check('★ 每个 option 的 label 都含「行 L 轮 T」且与节点账本一致', pickOpts.every((o, i) => o.label.includes(`行 ${newestFirst[i].line} 轮 ${newestFirst[i].turn}`)), pickOpts[1].label)
  // argsCells 默认 120：命令行进 description（面板是多行的，看得见），空则**不设该字段**而不是空串
  const descOf = (o) => ('description' in o ? o.description : undefined)
  check(
    '★ argsCells 默认 120 → description 等于该节点的命令行',
    pickOpts.every((o, i) => descOf(o) === newestFirst[i].args),
    `${JSON.stringify(descOf(pickOpts[1]))} vs ${JSON.stringify(newestFirst[1].args)}`,
  )
  const noArgsDialogs = mkDialogs({ select: '1', confirm: true })
  await mount({ allowDialogs: true }, { tuiDialogs: noArgsDialogs }).callRaw('pick', { session: mkNodeSession(CURRENT, 3, () => '') })
  check(
    '无命令行时不设 description 字段（不是空串）',
    noArgsDialogs.calls.select[0].options.every((o) => !('description' in o)) && noArgsDialogs.calls.select[0].options[0].label.includes('轮 '),
    JSON.stringify(noArgsDialogs.calls.select[0].options[0]),
  )
  const truncDialogs = mkDialogs({ select: '1', confirm: true })
  await mount({ argsCells: 10, allowDialogs: true }, { tuiDialogs: truncDialogs }).callRaw('pick', { session: mkNodeSession(CURRENT, 2, () => JSON.stringify({ cmd: 'rg', q: 'X'.repeat(200) })) })
  const truncDesc = truncDialogs.calls.select[0].options[0].description ?? ''
  check('★ 超长命令行被截断到 argsCells 预算内', cellsOf(truncDesc) <= 10 && truncDesc.endsWith('…'), `${JSON.stringify(truncDesc)} cells=${cellsOf(truncDesc)}`)
  const ctrlDialogs = mkDialogs({ select: '1', confirm: true })
  await mount({ allowDialogs: true }, { tuiDialogs: ctrlDialogs }).callRaw('pick', { session: mkNodeSession(CURRENT, 2, () => '--q\u0007A\u0007\u0007B\n\nC') })
  const ctrlDesc = ctrlDialogs.calls.select[0].options[0].description ?? ''
  check('★ 命令行里的控制字符被换成空格、空白被压平', ctrlDesc === '--q A B C' && !/[\u0000-\u001f]/.test(ctrlDesc), JSON.stringify(ctrlDesc))
  // argsCells: 0 的契约是「完全不显示命令行」—— 这是隐私开关，必须真的什么都不显示
  const zeroArgsDialogs = mkDialogs({ select: '1', confirm: true })
  await mount({ argsCells: 0, allowDialogs: true }, { tuiDialogs: zeroArgsDialogs }).callRaw('pick', { session: mkNodeSession(CURRENT, 2) })
  check(
    '★ argsCells=0 → option 完全不显示命令行（不设 description，而不是留个占位符）',
    zeroArgsDialogs.calls.select[0].options.every((o) => !('description' in o)),
    JSON.stringify(zeroArgsDialogs.calls.select[0].options[0]),
  )
  const pickConfirm = pickDialogs.calls.confirm[0]
  check(
    'confirm 请求形状正确（隐藏 / 取消 / 超时 / message 非空）',
    pickConfirm?.confirmLabel === '隐藏' && pickConfirm?.cancelLabel === '取消' && pickConfirm?.timeoutMs === 15000 && typeof pickConfirm?.message === 'string' && pickConfirm.message.length > 0,
    JSON.stringify(pickConfirm ?? null).slice(0, 140),
  )
  // dialogTimeoutMs 可配：设多少两处请求都得是多少
  const t40kDialogs = mkDialogs({ select: '1', confirm: true })
  await mount({ dialogTimeoutMs: 40000, allowDialogs: true }, { tuiDialogs: t40kDialogs }).callRaw('pick', { session: mkNodeSession(CURRENT, 3) })
  check('dialogTimeoutMs=40000 → select.timeoutMs 跟着变', t40kDialogs.calls.select[0].timeoutMs === 40000, String(t40kDialogs.calls.select[0].timeoutMs))
  check('dialogTimeoutMs=40000 → confirm.timeoutMs 跟着变', t40kDialogs.calls.confirm[0]?.timeoutMs === 40000, String(t40kDialogs.calls.confirm[0]?.timeoutMs))
  // 0 = 彻底禁用对话框：直接报错，且一次都不许调用对话框（调用就会让键盘被让出 → 卡死）
  const disabledDialogs = mkDialogs({ select: '1', confirm: true })
  const disabledSession = mkNodeSession(CURRENT, 3)
  const disabled = await mount({ dialogTimeoutMs: 0, allowDialogs: true }, { tuiDialogs: disabledDialogs }).callRaw('pick', { session: disabledSession })
  check('dialogTimeoutMs=0 → pick 返回 error 且文案说明已被禁用', disabled.kind === 'error' && disabled.text.includes('已被配置禁用'), disabled.text)
  check(
    '★ dialogTimeoutMs=0 → select / confirm 一次都没被调用（否则就是「面板没弹出却让出键盘」的老问题）',
    disabledDialogs.calls.select.length === 0 && disabledDialogs.calls.confirm.length === 0,
    `select=${disabledDialogs.calls.select.length} confirm=${disabledDialogs.calls.confirm.length}`,
  )
  check('dialogTimeoutMs=0 只禁对话框，nodes 仍可用', mount({ dialogTimeoutMs: 0 }, {}).callRaw('nodes', { session: mkNodeSession(CURRENT, 3) }).kind === 'success')
  check('★ 选中的 id 被映射回正确节点的行号', pickConfirm.title.includes(`[2] 行 ${newestFirst[1].line}`) && pickConfirm.title.includes(newestFirst[1].tool), pickConfirm?.title)
  check(
    '★ 价签与 surface 替换紧邻，且指向同一 seq',
    pickSession.appended.length === 2 &&
      pickSession.appended[0].type === 'compaction/prune' &&
      pickSession.appended[1].type === 'tool/result' &&
      JSON.stringify(pickSession.appended[0].data.shadowedSeqs) === JSON.stringify([newestFirst[1].seq]) &&
      pickSession.appended[0].data.shadowedRange.start === newestFirst[1].seq &&
      pickSession.appended[0].data.shadowedRange.end === newestFirst[1].seq &&
      pickSession.appended[0].data.shadowedTokenCount === 42,
    JSON.stringify(pickSession.appended.map((a) => a.type)),
  )
  check(
    '★ surfaceOp 与 sourceEventSeqs 指向被选中的那个节点',
    pickSession.appended[1].opts.surfaceOp.op === 'replace' &&
      pickSession.appended[1].opts.surfaceOp.startSeq === newestFirst[1].seq &&
      pickSession.appended[1].opts.surfaceOp.endSeq === newestFirst[1].seq &&
      JSON.stringify(pickSession.appended[1].opts.sourceEventSeqs) === JSON.stringify([newestFirst[1].seq]),
    JSON.stringify(pickSession.appended[1].opts),
  )
  check(
    '★ 替换后正文换成占位符且不含原文',
    JSON.stringify(pickSession.appended[1].data).includes(PH) && !JSON.stringify(pickSession.appended[1].data).includes('TOXIC-OUTPUT'),
  )
  check('★ pick 返回文案不含正文，且单行', !picked.text.includes('TOXIC-OUTPUT') && /已隐藏 \[2\] 行 \d+/.test(picked.text) && !picked.text.includes('\n'), picked.text)
  check('pick 不碰磁盘', sameSnapshot(beforePick, snapshot(TMP)), diffSnapshot(beforePick, snapshot(TMP)))

  // options 上限 60
  const bigPickSession = mkNodeSession(CURRENT, 70)
  const bigPickDialogs = mkDialogs({ select: undefined, confirm: true, delayMs: 80 })
  const bigPick = await mount({ allowDialogs: true }, { tuiDialogs: bigPickDialogs }).callRaw('pick', { session: bigPickSession })
  check(
    'options 数量上限 60（会话里有 70 个节点）',
    bigPickDialogs.calls.select[0].options.length === 60 && bigPickDialogs.calls.select[0].title.includes('70'),
    `options=${bigPickDialogs.calls.select[0].options.length} · title=${bigPickDialogs.calls.select[0].title}`,
  )
  // G2：>60 个节点时必须诚实说明「只列了一部分」，否则用户以为列表就是全部
  check(
    '★ 70 个节点时 title 说明「共 70 个、仅列最新 60 个」',
    bigPickDialogs.calls.select[0].title.includes('共 70 个') && bigPickDialogs.calls.select[0].title.includes('仅列最新 60 个'),
    bigPickDialogs.calls.select[0].title,
  )
  const smallPickDialogs = mkDialogs({ select: undefined })
  await mount({ allowDialogs: true }, { tuiDialogs: smallPickDialogs }).callRaw('pick', { session: mkNodeSession(CURRENT, 19) })
  check(
    '19 个节点（未超上限）时 title 不出现「仅列最新」',
    smallPickDialogs.calls.select[0].title.includes('共 19 个') && !smallPickDialogs.calls.select[0].title.includes('仅列最新'),
    smallPickDialogs.calls.select[0].title,
  )
  check('select 返回 undefined（延迟，= 真人按 Esc）→ success「已取消」且零改动', bigPick.kind === 'success' && bigPick.text.includes('已取消') && bigPickSession.appended.length === 0 && bigPickDialogs.calls.confirm.length === 0, bigPick.text)

  // 准入竞态的真实表现：宿主没接纳本行时面板不弹，select 会**立即**返回取消值。
  // 人不可能在 50ms 内按 Esc，所以这种「秒回取消」必须报成 error，否则用户只看到「已取消」而不知道功能根本没工作。
  const fastCancelSession = mkNodeSession(CURRENT, 3)
  const fastCancel = await mount({ allowDialogs: true }, { tuiDialogs: mkDialogs({ select: undefined }) }).callRaw('pick', { session: fastCancelSession })
  check(
    '★ select 立即返回取消（<50ms）→ error 说明面板没弹出，而非静默「已取消」',
    fastCancel.kind === 'error' && /没有弹出/.test(fastCancel.text) && fastCancelSession.appended.length === 0,
    fastCancel.text,
  )
  const fastConfirmSession = mkNodeSession(CURRENT, 3)
  const fastConfirm = await mount({ allowDialogs: true }, { tuiDialogs: mkDialogs({ select: '1', confirm: false }) }).callRaw('pick', { session: fastConfirmSession })
  check(
    '★ confirm 立即返回取消（<50ms）→ error 说明确认框没弹出且零改动',
    fastConfirm.kind === 'error' && /确认框没有弹出/.test(fastConfirm.text) && fastConfirmSession.appended.length === 0,
    fastConfirm.text,
  )

  // confirm 返回 false
  const noConfirmSession = mkNodeSession(CURRENT, 3)
  const noConfirmDialogs = mkDialogs({ select: '1', confirm: false, delayMs: 80 })
  const noConfirm = await mount({ allowDialogs: true }, { tuiDialogs: noConfirmDialogs }).callRaw('pick', { session: noConfirmSession })
  check('confirm 返回 false（延迟，= 真人取消）→ success「已取消」且零改动', noConfirm.kind === 'success' && noConfirm.text.includes('已取消') && noConfirmSession.appended.length === 0, noConfirm.text)

  // allowDialogs 默认 false：即使对话框服务在，也必须拒绝，且一次都不能调用
  const defOffDialogs = mkDialogs({ select: '1', confirm: true })
  const defOffSession = mkNodeSession(CURRENT, 3)
  const defOff = await mount({}, { tuiDialogs: defOffDialogs }).callRaw('pick', { session: defOffSession })
  check(
    '★ 默认 allowDialogs=false → pick 拒绝且一次都没调用对话框',
    defOff.kind === 'error' && defOff.text.includes('allowDialogs: true') && defOffDialogs.calls.select.length === 0 && defOffDialogs.calls.confirm.length === 0 && defOffSession.appended.length === 0,
    defOff.text,
  )
  check(
    '★ allowDialogs=false 时 nodes 不推荐 /redact pick',
    // 用 CURRENT 而不是 NODES_ID：后者在本行之后才定义（TDZ）
    !mount({}, { tuiDialogs: mkDialogs({}) }).callRaw('nodes', { session: mkNodeSession(CURRENT, 20) }).text.includes('/redact pick'),
  )

  // 无 tuiDialogs（软探测失败）：开了 allowDialogs 才走得到这一步
  const noSvcSession = mkNodeSession(CURRENT, 3)
  const noSvc = await mount({ allowDialogs: true }, {}).callRaw('pick', { session: noSvcSession })
  check(
    '无 tuiDialogs → kind:error 并指路 nodes / nodes full',
    noSvc.kind === 'error' && noSvc.text.includes('tuiDialogs') && noSvc.text.includes('/redact nodes') && noSvc.text.includes('/redact nodes full'),
    noSvc.text,
  )
  check('无 tuiDialogs 时不动会话', noSvcSession.appended.length === 0)
  const badSvcSession = mkNodeSession(CURRENT, 3)
  const badSvc = await mount({ allowDialogs: true }, { tuiDialogs: { confirm: async () => true } }).callRaw('pick', { session: badSvcSession })
  check('tuiDialogs 存在但 select 不是函数 → kind:error', badSvc.kind === 'error' && badSvc.text.includes('tuiDialogs') && badSvcSession.appended.length === 0, badSvc.text)

  // select / confirm 抛异常
  const throwSelectSession = mkNodeSession(CURRENT, 3)
  let escapedSelect = null
  let throwSelectRes
  try {
    throwSelectRes = await mount({ allowDialogs: true }, { tuiDialogs: mkDialogs({ select: new Error('面板已关闭') }) }).callRaw('pick', { session: throwSelectSession })
  } catch (e) {
    escapedSelect = e
  }
  check(
    'select 抛异常 → kind:error 且不逃出 handler',
    escapedSelect === null && throwSelectRes.kind === 'error' && throwSelectRes.text.includes('对话框调用失败') && throwSelectRes.text.includes('面板已关闭'),
    escapedSelect === null ? throwSelectRes.text : `逃逸异常：${escapedSelect.message}`,
  )
  check('select 抛异常时零改动', throwSelectSession.appended.length === 0)
  const throwConfirmSession = mkNodeSession(CURRENT, 3)
  let escapedConfirm = null
  let throwConfirmRes
  try {
    throwConfirmRes = await mount({ allowDialogs: true }, { tuiDialogs: mkDialogs({ select: '1', confirm: new Error('确认框崩了') }) }).callRaw('pick', { session: throwConfirmSession })
  } catch (e) {
    escapedConfirm = e
  }
  check(
    'confirm 抛异常 → kind:error 且不逃出 handler',
    escapedConfirm === null && throwConfirmRes.kind === 'error' && throwConfirmRes.text.includes('对话框调用失败'),
    escapedConfirm === null ? throwConfirmRes.text : `逃逸异常：${escapedConfirm.message}`,
  )
  check('confirm 抛异常时零改动', throwConfirmSession.appended.length === 0)

  // 无效选择 / 无会话 / 跨会话
  const badIdSession = mkNodeSession(CURRENT, 3)
  const badIdDialogs = mkDialogs({ select: '99', confirm: true })
  const badId = await mount({ allowDialogs: true }, { tuiDialogs: badIdDialogs }).callRaw('pick', { session: badIdSession })
  check('选中越界序号 → kind:error 且零改动', badId.kind === 'error' && /无效的选择/.test(badId.text) && badIdSession.appended.length === 0 && badIdDialogs.calls.confirm.length === 0, badId.text)
  const nanSession = mkNodeSession(CURRENT, 3)
  const nan = await mount({ allowDialogs: true }, { tuiDialogs: mkDialogs({ select: 'abc', confirm: true }) }).callRaw('pick', { session: nanSession })
  check('选中非数字 → kind:error 且零改动', nan.kind === 'error' && /无效的选择/.test(nan.text) && nanSession.appended.length === 0, nan.text)
  const noSession = await picker.callRaw('pick', {})
  check('pick 无会话对象 → kind:error', noSession.kind === 'error' && noSession.text.includes('没有可用的会话'), noSession.text)
  const crossSession = mkNodeSession(CURRENT, 3)
  const cross = await picker.callRaw(`pick --session some-other`, { session: crossSession })
  check('pick --session 指向别的会话 → kind:error 且零改动', cross.kind === 'error' && cross.text.includes('只作用于当前会话') && crossSession.appended.length === 0, cross.text)

  // ───────────────────────────────────────────────────── 8d. nodes（分页 / full 导出）
  section('8d. nodes（按显示格预算分页、full 导出、尾部提示）')
  const NODES_ID = 'npage-0001'
  const nodesSession = mkNodeSession(NODES_ID, 20)
  const nodePages = []
  for (let pageNo = 1, guard = 0; guard < 40; pageNo += 1, guard += 1) {
    const r = main.callRaw(`nodes ${pageNo}`, { session: nodesSession })
    nodePages.push(r)
    if (!r.text.includes(`续 /redact nodes ${pageNo + 1}`)) break
  }
  const seenIdx = []
  // 容忍可选的「轮N」段落：格式加了识别信息后仍然能抽出序号，不必随格式改测试
  for (const p of nodePages) for (const m of p.text.matchAll(/\[(\d+)\]\s+\d+\s+(?:轮\S+\s+)?\S+\s+[\d.?]+(?:B|KB)/g)) seenIdx.push(Number(m[1]))
  const sortedIdx = seenIdx.slice().sort((a, b) => a - b)
  check('nodes 分页不止一页（按显示格切块，而非固定条数）', nodePages.length > 1, `${nodePages.length} 页`)
  check(
    '★ 逐页翻到底：序号 1..20 全覆盖、无缺口、无重复',
    seenIdx.length === 20 && new Set(seenIdx).size === 20 && sortedIdx[0] === 1 && sortedIdx.at(-1) === 20,
    `覆盖 ${seenIdx.length} 条：${sortedIdx.join(',')}`,
  )
  check('nodes 每页都是单行', nodePages.every((p) => !p.text.includes('\n')))
  const nodesNewestFirstPages = nodesSession.nodes.slice().reverse()
  const nodeSegs = []
  for (const p of nodePages) {
    for (const m of p.text.matchAll(/\[(\d+)\]\s+(\d+)\s+轮([\d-]+)\s+(\S+)\s+([\d.?]+(?:B|KB))/g)) nodeSegs.push({ idx: Number(m[1]), line: Number(m[2]), turn: m[3], tool: m[4] })
  }
  check(
    '★ nodes 每条都带「轮 T」，且行号/轮次/工具与节点账本一一对应',
    nodeSegs.length === 20 &&
      nodeSegs.every((s) => {
        const n = nodesNewestFirstPages[s.idx - 1]
        return n !== undefined && s.line === n.line && s.turn === String(n.turn) && s.tool === n.tool
      }),
    nodeSegs.length > 0 ? `[${nodeSegs[0].idx}] 行 ${nodeSegs[0].line} 轮 ${nodeSegs[0].turn} ${nodeSegs[0].tool}` : '(没解析到条目)',
  )
  check('nodes 每页都 ≤200 显示格', nodePages.every((p) => cellsOf(p.text) <= 200), `最大 ${Math.max(...nodePages.map((p) => cellsOf(p.text)))} 格`)
  check('nodes 每页尾部完整（以「隐藏 /redact hide <序号>」结尾）', nodePages.every((p) => p.text.endsWith('隐藏 /redact hide <序号>')), nodePages[0].text.slice(-40))
  check(
    'nodes 翻页导航正确（中间页有续页提示，末页没有）',
    nodePages[0].text.includes('续 /redact nodes 2') && /（还有\d+条）/.test(nodePages[0].text) && !nodePages.at(-1).text.includes('续 /redact nodes'),
    nodePages[0].text.slice(-70),
  )
  check('nodes 页号超出时收敛到最后一页', main.callRaw('nodes 99', { session: nodesSession }).text === nodePages.at(-1).text, main.callRaw('nodes 99', { session: nodesSession }).text.slice(0, 40))
  check('★ nodes 不回显任何正文', nodePages.every((p) => !p.text.includes('TOXIC-OUTPUT')))
  const nodesWithDialogs = mount({ allowDialogs: true }, { tuiDialogs: mkDialogs({}) }).callRaw('nodes', { session: mkNodeSession(NODES_ID, 20) }).text
  check('tuiDialogs 可用时尾部多出「选择 /redact pick」', nodesWithDialogs.includes('选择 /redact pick · ') && nodesWithDialogs.endsWith('隐藏 /redact hide <序号>'), nodesWithDialogs.slice(-70))
  check('tuiDialogs 不可用时尾部不含 pick 提示', !nodePages[0].text.includes('/redact pick'), nodePages[0].text.slice(-70))

  const fullRes = main.callRaw('nodes full', { session: nodesSession })
  const fullPath = /(\S+?\.txt)/.exec(fullRes.text)?.[1]
  check('nodes full → success 且给出临时 txt 路径', fullRes.kind === 'success' && typeof fullPath === 'string' && fullPath.startsWith(os.tmpdir()), fullRes.text)
  const fullLines = fs.existsSync(fullPath ?? '') ? fs.readFileSync(fullPath, 'utf8').split('\n').filter((l) => /^\[\d+\]/.test(l)) : []
  check('nodes full 文件存在、条目数正确', fs.existsSync(fullPath ?? '') && fullLines.length === 20 && fullRes.text.includes('共 20 条'), `条目 ${fullLines.length}`)
  check(
    'nodes full 每行含 → /redact hide <n> --commit（序号可直接用）',
    fullLines.length === 20 && fullLines.every((l, i) => l.includes(`→ /redact hide ${i + 1} --commit`)),
    fullLines[0] ?? '(空)',
  )
  check('nodes full 的文件不含正文', !fullLines.join('').includes('TOXIC-OUTPUT'))
  const nodesNewestFirst = nodesSession.nodes.slice().reverse() // collectNodes 最新在前
  check(
    '★ nodes full 每行都含轮次、行号与命令行（认出是哪一条）',
    fullLines.length === 20 && fullLines.every((l, i) => l.includes(`轮 ${nodesNewestFirst[i].turn}`) && l.includes(`行 ${nodesNewestFirst[i].line}`) && l.includes(nodesNewestFirst[i].args)),
    fullLines[0] ?? '(空)',
  )
  check('argsCells 默认 120 → nodes full 含完整命令行', fullLines[0]?.includes(nodesNewestFirst[0].args) === true, fullLines[0] ?? '(空)')
  // argsCells=0 的契约是「完全不显示命令行」：这是隐私开关，文件里也必须一点痕迹都不留
  const zeroFullRes = mount({ argsCells: 0 }, {}).callRaw('nodes full', { session: mkNodeSession('npage-zero', 3) })
  const zeroFullPath = /(\S+?\.txt)/.exec(zeroFullRes.text)?.[1]
  const zeroFullLines = fs.existsSync(zeroFullPath ?? '') ? fs.readFileSync(zeroFullPath, 'utf8').split('\n').filter((l) => /^\[\d+\]/.test(l)) : []
  check(
    '★ argsCells=0 → nodes full 完全不写命令行（也不留占位符）',
    zeroFullLines.length === 3 && zeroFullLines.every((l) => l.includes('行 ') && l.includes('轮 ') && !l.includes('{"cmd"') && !l.includes('…')),
    zeroFullLines[0] ?? '(空)',
  )
  fs.rmSync(zeroFullPath, { force: true })
  fs.rmSync(fullPath, { force: true }) // 用完删掉临时导出文件

  // G1：surface 是活会话的内存状态，传别的会话必须显式拒绝（用非空节点夹具才能走到守卫）
  const g1Session = mkNodeSession('nodes-g1-0001', 3)
  const g1Plain = main.callRaw('nodes', { session: g1Session })
  const beforeG1 = snapshot(TMP)
  const g1Other = main.callRaw('nodes --session some-other-session', { session: g1Session })
  check(
    '★ nodes --session <别的会话> → kind:error 且说明只列当前会话',
    g1Other.kind === 'error' && g1Other.text.includes('只能列出当前会话'),
    g1Other.text,
  )
  check('★ nodes 拒绝时的输出与不带 flag 不再相同（G1 回归陷阱）', g1Plain.kind === 'success' && g1Other.text !== g1Plain.text, `plain=${g1Plain.text.slice(0, 36)}`)
  check('nodes 被拒绝时零改动', g1Session.appended.length === 0 && sameSnapshot(beforeG1, snapshot(TMP)), diffSnapshot(beforeG1, snapshot(TMP)))
  const g1Full = main.callRaw('nodes full --session some-other-session', { session: g1Session })
  check('nodes full --session <别的会话> 同样被拒绝且不写文件', g1Full.kind === 'error' && g1Full.text.includes('只能列出当前会话') && sameSnapshot(beforeG1, snapshot(TMP)), g1Full.text)

  // G3：导出文件名用完整（安全化后的）会话 id —— 前 8 字相同的会话不能互相覆盖
  const dupA = mkNodeSession('dupid-0000000001', 3)
  const dupB = mkNodeSession('dupid-0000000002', 5)
  const fullA = main.callRaw('nodes full', { session: dupA })
  const fullB = main.callRaw('nodes full', { session: dupB })
  const pathA = /(\S+?\.txt)/.exec(fullA.text)?.[1]
  const pathB = /(\S+?\.txt)/.exec(fullB.text)?.[1]
  check(
    '★ 前 8 字相同的两个会话导出到不同文件（路径含完整 id）',
    typeof pathA === 'string' && typeof pathB === 'string' && pathA !== pathB && pathA.includes('dupid-0000000001') && pathB.includes('dupid-0000000002'),
    `${pathA} vs ${pathB}`,
  )
  const linesA = fs.existsSync(pathA ?? '') ? fs.readFileSync(pathA, 'utf8').split('\n').filter((l) => /^\[\d+\]/.test(l)) : []
  const linesB = fs.existsSync(pathB ?? '') ? fs.readFileSync(pathB, 'utf8').split('\n').filter((l) => /^\[\d+\]/.test(l)) : []
  check('★ 两个导出文件各自存在且条目数正确（3 / 5）', linesA.length === 3 && linesB.length === 5, `A=${linesA.length} B=${linesB.length}`)
  const evilFull = main.callRaw('nodes full', { session: mkNodeSession('../../evil-0001', 2) })
  const evilPath = /(\S+?\.txt)/.exec(evilFull.text)?.[1]
  check(
    '★ 含路径分隔符的会话 id 不会逃出 tmpdir（路径安全化）',
    typeof evilPath === 'string' && path.dirname(evilPath) === os.tmpdir() && path.basename(evilPath).startsWith('dsh-redact-nodes-'),
    evilPath,
  )
  for (const p of [pathA, pathB, evilPath]) fs.rmSync(p, { force: true }) // 读完都删掉

  // ───────────────────────────────────────────────────── 9. 引擎边角
  section('9a. blankLines 命中嵌套对象 / 数组')
  const edgeA = writeLog({
    root: EDGE_ROOT,
    id: 'edge-a',
    batches: [
      [
        {
          role: 'assistant',
          heading: 'EDGE-A-TITLE',
          data: {
            id: 'keep-id',
            toolCallId: 'keep-call',
            callId: 'keep-call-2',
            role: 'keep-role',
            text: 'EDGE-A 顶层文本',
            nums: [1, 2, 3],
            flags: [true, false, null],
            nested: { deep: { leaf: 'EDGE-A-DEEP' }, list: ['EDGE-A-L1', { inner: 'EDGE-A-L2' }, 7] },
            empty: {},
            emptyArr: [],
            count: 42,
            ratio: 1.5,
            ok: false,
            nil: null,
            strArr: ['EDGE-A-ARR'],
          },
        },
      ],
    ],
  })
  const aRes = engine.applyPlan(edgeA.buf, { blankLines: '2', blankPlaceholder: PH })
  const aRows = decodeBuffer(aRes.out)
  const aRow = aRows.rows[1].json
  check('9a 行数不变', aRows.rows.length === 2, `实际 ${aRows.rows.length}`)
  check('9a type / seq / time 原样', aRow.type === 'test/event' && aRow.seq === 0 && aRow.time === 1000)
  check('9a 顶层字符串被替换', aRow.heading === PH)
  check('9a 深层嵌套对象字符串被替换', aRow.data.nested.deep.leaf === PH)
  check('9a 数组内字符串被替换', aRow.data.nested.list[0] === PH)
  check('9a 数组内对象的字符串被替换', aRow.data.nested.list[1].inner === PH)
  check('9a 字符串数组被替换', aRow.data.strArr[0] === PH)
  check('9a data.text 被替换', aRow.data.text === PH)
  check('9a 受保护键 role 原样（顶层与嵌套）', aRow.role === 'assistant' && aRow.data.role === 'keep-role')
  check('9a 受保护键 id / toolCallId / callId 原样', aRow.data.id === 'keep-id' && aRow.data.toolCallId === 'keep-call' && aRow.data.callId === 'keep-call-2')
  check('9a 数字数组原样', JSON.stringify(aRow.data.nums) === '[1,2,3]')
  check('9a 布尔 / null 数组原样', JSON.stringify(aRow.data.flags) === '[true,false,null]')
  check('9a 数组内数字原样', aRow.data.nested.list[2] === 7)
  check('9a 数字 / 浮点 / 布尔 / null 原样', aRow.data.count === 42 && aRow.data.ratio === 1.5 && aRow.data.ok === false && aRow.data.nil === null)
  check('9a 空对象 / 空数组原样', JSON.stringify(aRow.data.empty) === '{}' && JSON.stringify(aRow.data.emptyArr) === '[]')
  check('★ 9a 输出中不再有任何原文', !aRows.text.includes('EDGE-A'))
  check('9a stats：blanked=1 / 行数不变 / seq 密集', aRes.stats.blanked === 1 && engine.checkSeqDensity(aRes.out) === null)

  section('9b. 全局替换（无 lines 字段）跨多帧生效')
  const G = 'GLOBAL-X'
  const edgeB = writeLog({
    root: EDGE_ROOT,
    id: 'edge-b',
    batches: [
      [{ data: { text: `${G} 一` } }, { data: { text: 'plain-keep' } }],
      [{ data: { text: `${G} 二` } }],
      [{ data: { text: `${G} 三` }, other: { nested: `${G} 四` } }],
    ],
  })
  const bRes = engine.applyPlan(edgeB.buf, { substitutions: [{ find: G, replace: PH }] })
  const bOut = decodeBuffer(bRes.out)
  const bFrameHasPh = bOut.plains.map((p) => p.includes(PH))
  const bFrameHasSecret = bOut.plains.map((p) => p.includes(G))
  check('9b 全局替换命中 4 处', bRes.stats.substitutions === 4, `实际 ${bRes.stats.substitutions}`)
  check('★ 9b 替换不止落在一帧里', bFrameHasPh.filter(Boolean).length >= 2, `含占位符的帧：${bFrameHasPh.map((v, i) => (v ? i : null)).filter((v) => v !== null).join(',')}`)
  check('9b 三个事件帧全部被改写', bFrameHasPh.filter(Boolean).length === 3)
  check('★ 9b 任何一帧都不再含原字面量', bFrameHasSecret.every((v) => !v))
  check('9b 头部帧原字节保留', bOut.buf.subarray(bOut.frames[0].start, bOut.frames[0].end).equals(edgeB.buf.subarray(0, decodeBuffer(edgeB.buf).frames[0].end)))
  check('9b 帧统计：保留 1 / 重写 3', bRes.stats.keptFrames === 1 && bRes.stats.rewrittenFrames === 3, `保留 ${bRes.stats.keptFrames} / 重写 ${bRes.stats.rewrittenFrames}`)
  check('9b 行数与 seq 不变', bOut.rows.length === 5 && engine.checkSeqDensity(bRes.out) === null, `行数 ${bOut.rows.length}`)
  check('9b 同帧内未命中行原样保留', bOut.rows[2].json.data.text === 'plain-keep')

  section('9c. 后缀 dropLines：无需 renumber')
  const edgeC = writeLog({
    root: EDGE_ROOT,
    id: 'edge-c',
    batches: [[{ data: { text: 'c0' } }, { data: { text: 'c1' } }], [{ data: { text: 'c2' } }], [{ data: { text: 'c3-DROP' } }]],
  })
  const cRes = engine.applyPlan(edgeC.buf, { dropLines: '5' })
  const cOut = decodeBuffer(cRes.out)
  check('9c 后缀删除放行', cRes.stats.dropped === 1, `dropped=${cRes.stats.dropped}`)
  check('9c 提示说明是安全后缀', cRes.notes.some((n) => n.includes('后缀')), cRes.notes.join(' | '))
  check('9c 行数 5 → 4', cOut.rows.length === 4)
  check('★ 9c 被删内容消失', !cOut.text.includes('c3-DROP'))
  check('★ 9c seq 仍密集', engine.checkSeqDensity(cRes.out) === null)
  check('9c 未触碰帧原字节保留（帧 0..2）', [0, 1, 2].every((i) => cOut.buf.subarray(cOut.frames[i].start, cOut.frames[i].end).equals(edgeC.buf.subarray(decodeBuffer(edgeC.buf).frames[i].start, decodeBuffer(edgeC.buf).frames[i].end))))

  section('9d. 中间 dropLines：无 renumber 必须拒绝')
  const beforeC = fs.readFileSync(edgeC.file)
  const d = trapExit(() => engine.applyPlan(edgeC.buf, { dropLines: '3' }))
  check('★ 9d 中间行删除被拒绝（抛 RedactError，不杀宿主进程）', d.exited === false && d.threw instanceof Error, `exited=${d.exited} threw=${d.threw?.message ?? '无'}`)
  // 引擎级拒绝已从 process.exit 改为 throw（否则会连带杀掉宿主 DSH 进程），
  // 因此理由现在从抛出的错误里取，而不是 stderr。
  const dMsg = [d.errs.join('\n'), d.threw?.message ?? ''].join('\n')
  check('9d 拒绝理由点明 seq gap 并给出 3 条出路', dMsg.includes('拒绝执行') && dMsg.includes('renumber') && dMsg.includes('blankLines') && dMsg.includes('substitutions'))
  check('9d 拒绝信息不泄漏日志正文', !dMsg.includes('c1') && !dMsg.includes('c2'))
  check('9d 拒绝后文件未变', fs.readFileSync(edgeC.file).equals(beforeC))

  section('9e. renumber：向后引用重映射 / 悬空引用拒绝')
  const refRow = () => ({
    data: { text: 'e4', shadowedSeqs: [3, 4], shadowedRange: { start: 2, end: 4 } },
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 },
    sourceEventSeqs: [0, 2, 3],
  })
  const edgeE = writeLog({
    root: EDGE_ROOT,
    id: 'edge-e',
    batches: [
      [{ data: { text: 'e0' } }, { data: { text: 'e1-DROP' } }],
      [{ data: { text: 'e2' } }, { data: { text: 'e3' } }],
      [refRow()],
      [{ data: { text: 'e5' } }],
    ],
  })
  const eRes = engine.applyPlan(edgeE.buf, { dropLines: '3', renumber: true })
  const eOut = decodeBuffer(eRes.out)
  const eTarget = eOut.rows[4].json // 删除第 3 行后，原第 6 行成为第 5 行（index 4）
  check('9e 中间删除 + renumber 放行', eRes.stats.dropped === 1 && eOut.rows.length === 6, `dropped=${eRes.stats.dropped} 行数=${eOut.rows.length}`)
  check('9e 提示说明已重编号', eRes.notes.some((n) => n.includes('renumber')), eRes.notes.join(' | '))
  check('★ 9e 本行 seq 被重编号 4 → 3', eTarget.seq === 3, String(eTarget.seq))
  check('★ 9e surfaceOp {0,3} → {0,2}', eTarget.surfaceOp?.op === 'replace' && eTarget.surfaceOp.startSeq === 0 && eTarget.surfaceOp.endSeq === 2, JSON.stringify(eTarget.surfaceOp))
  check('★ 9e sourceEventSeqs [0,2,3] → [0,1,2]', JSON.stringify(eTarget.sourceEventSeqs) === '[0,1,2]', JSON.stringify(eTarget.sourceEventSeqs))
  check('9e data.shadowedSeqs [3,4] → [2,3]', JSON.stringify(eTarget.data.shadowedSeqs) === '[2,3]', JSON.stringify(eTarget.data.shadowedSeqs))
  check('9e data.shadowedRange {2,4} → {1,3}', eTarget.data.shadowedRange?.start === 1 && eTarget.data.shadowedRange?.end === 3, JSON.stringify(eTarget.data.shadowedRange))
  check('9e 重编号行数 = 4', eRes.stats.renumbered === 4, String(eRes.stats.renumbered))
  check('★ 9e 重编号后 seq 仍密集', engine.checkSeqDensity(eRes.out) === null)
  check('9e 被删行消失、其余行原样', !eOut.text.includes('e1-DROP') && ['e0', 'e2', 'e3', 'e5'].every((s) => eOut.text.includes(`"${s}"`)))
  check('9e 第 0 帧（头部）原字节保留', eOut.buf.subarray(eOut.frames[0].start, eOut.frames[0].end).equals(edgeE.buf.subarray(0, decodeBuffer(edgeE.buf).frames[0].end)))

  const danglingRow = () => ({ data: { text: 'f4' }, sourceEventSeqs: [0, 1, 4] })
  const edgeF = writeLog({
    root: EDGE_ROOT,
    id: 'edge-f',
    batches: [
      [{ data: { text: 'f0' } }, { data: { text: 'f1-DROP' } }],
      [{ data: { text: 'f2' } }, { data: { text: 'f3' } }],
      [danglingRow()],
      [{ data: { text: 'f5' } }],
    ],
  })
  const f = trapExit(() => engine.applyPlan(edgeF.buf, { dropLines: '3', renumber: true }))
  check('★ 9e 引用被删行 → 拒绝执行（抛 RedactError）', f.exited === false && f.threw instanceof Error, `exited=${f.exited} threw=${f.threw?.message ?? '无'}`)
  const fMsg = [f.errs.join('\n'), f.threw?.message ?? ''].join('\n')
  check('9e 悬空引用报错指明行号与 seq', /引用了被删除的第 3 行（seq 1）/.test(fMsg), fMsg.split('\n')[0])
  check('9e 悬空引用报错给出 blankLines 替代方案', fMsg.includes('blankLines'))
  check('9e 悬空引用报错不泄漏正文', !fMsg.includes('f1-DROP') && !fMsg.includes('f2'))

  // ───────────────────────────────────── 10. 观察（不计入断言）
  section('10. BUG 观察（只记录，不计入断言；套件不因此失败）')

  // 探针 A：引擎级拒绝应当 throw（RedactError）而不是 process.exit，否则会杀掉宿主进程
  const headPlan = writePlan({ blankLines: '1' }, 'bug-blank-head.json')
  const aMark = EXIT_CALLS.length
  const probeA = captureStderr(() => invoke(`apply ${headPlan} --session err-0001`, 'someone-else'))
  const aExitCodes = EXIT_CALLS.slice(aMark)
  if (aExitCodes.length > 0) {
    observe(`探针A：非法计划（blankLines=1）仍在调用 process.exit(${aExitCodes.join(',')})；引擎的 die 必须 throw，否则会杀掉宿主进程。`)
  } else {
    observe(`探针A：非法计划返回 ${JSON.stringify(probeA.value)}，未调用 process.exit —— 引擎 die 已是 throw（BUG-1 已修）。`)
  }

  // 探针 B：帧魔数损坏 → verify 是否自己接住 scanFrames 的 throw
  const magicLog = writeLog({ id: 'verify-magic', batches: [[{ data: { text: 'm0' } }], [{ data: { text: 'm1' } }]] })
  const origMagic = fs.readFileSync(magicLog.file)
  const magicFrames = engine.scanFrames(origMagic).frames
  const brokenMagic = Buffer.from(origMagic)
  brokenMagic[magicFrames[1].start] ^= 0xff
  fs.writeFileSync(magicLog.file, brokenMagic)
  let probeB
  try {
    probeB = invoke('verify --session verify-magic', 'someone-else')
  } catch (e) {
    probeB = e
  }
  if (probeB instanceof Error) {
    observe(`探针B：verify 遇到帧魔数损坏的日志时抛出未捕获异常「${probeB.message}」——应当返回 kind:'error'。`)
  } else {
    observe(`探针B：帧魔数损坏时 verify 返回 ${JSON.stringify(probeB)}（BUG-2 已修：scanFrames 的 throw 被接住）。`)
  }

  // 探针 C：root 不存在时 list 返回 success（对 list 而言可能合理，仅记录）
  const ghostList = mount({ root: path.join(TMP, 'no-such-root') }).call('list', 'someone-else')
  observe(`探针C：root 不存在时 list 返回 kind=${ghostList.kind}，文本「${ghostList.text}」`)

  // 探针 D：scan 到底遵不遵守 substitutions[].lines
  // 关键在「可区分」：同一份日志里命中行是第 2 行和第 5 行，计划只圈第 2 行 —— 遵守则 1 行，忽略则 2 行。
  const linesScoped = writePlan({ substitutions: [{ find: SCAN_NEEDLE, replace: PH, lines: '2' }] }, 'bug-lines-scope.json')
  const unscopedScan = invoke(`scan ${scanPlan} --session scan-0001`, 'someone-else')
  const scopedScan = invoke(`scan ${linesScoped} --session scan-0001`, 'someone-else')
  const hitCount = (t) => Number(/命中\s*(\d+)\s*行/.exec(t)?.[1] ?? -1)
  observe(`探针D：无 lines → 命中 ${hitCount(unscopedScan.text)} 行；lines='2' → 命中 ${hitCount(scopedScan.text)} 行「${scopedScan.text}」`)
  observe(
    hitCount(scopedScan.text) === 1 && hitCount(unscopedScan.text) === 2
      ? '        结论：scan 遵守 substitutions[].lines（区间外的第 5 行已不再计入）'
      : '        结论：scan 未遵守 substitutions[].lines，两次命中数相同',
  )

  // 探针 E：结构性损坏（帧魔数）下，scan 是否仍把异常抛出 handler
  const magicScan = writeLog({ id: 'scan-magic', batches: [[{ data: { text: 'mm0' } }], [{ data: { text: 'mm1' } }]] })
  const origScanMagic = fs.readFileSync(magicScan.file)
  const brokenScanMagic = Buffer.from(origScanMagic)
  brokenScanMagic[engine.scanFrames(origScanMagic).frames[1].start] ^= 0xff
  fs.writeFileSync(magicScan.file, brokenScanMagic)
  let probeE
  try {
    probeE = invoke(`scan ${scanPlan} --session scan-magic`, 'someone-else')
  } catch (e) {
    probeE = e
  }
  observe(
    probeE instanceof Error
      ? `探针E：scan 在结构性损坏的日志上抛出未捕获异常「${probeE.message}」；verify/plan/apply/rollback 都返回 kind:'error'，只有 scan 的 locate() 没被 try/catch 包住。`
      : `探针E：scan 在结构性损坏的日志上返回 ${JSON.stringify(probeE)}（已能友好报错）`,
  )

  // 探针 F：拒绝路径的可用性 —— 必须是「单行 + 出路（--allow-live）排在预算内」。
  // 曾因多行拼接被 clamp 到 200 格截断，用户看不到 --allow-live 这条生路；现在回归检查这一点。
  const refusedProbe = invoke(`apply ${livePlan} --session ${CURRENT}`)
  const fCells = cellsOf(refusedProbe.text)
  const fOk = !refusedProbe.text.includes('\n') && refusedProbe.text.includes('--allow-live') && fCells <= 200
  observe(`探针F：apply 在用会话拒绝：显示格 ${fCells} · 含换行 ${refusedProbe.text.includes('\n')} · 含 --allow-live ${refusedProbe.text.includes('--allow-live')}`)
  observe(
    fOk
      ? '        结论：单行且在 200 格内，出路完整可见（此前的截断问题已修）'
      : '        结论：用户看不到完整出路（被压平/截断）—— 需要改成单行并把出路排在前面',
  )

  // 原探针 G1（nodes 静默忽略 --session）与 G2（pick 60 上限无提示）已被修复，
  // 现在由第 8c / 8d 节的正式断言把守（G1 回归陷阱 + title 诚实提示），这里不再重复观察。
}

// ═══════════════════════════════════════════════════════════════════ 收尾

let crashed = null
try {
  await run()
} catch (e) {
  crashed = e
  const where = e instanceof EngineExit ? '被测代码在断言之外调用了 process.exit（引擎的 die 路径）' : '套件未捕获异常'
  check(where, false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不影响判定 */
  }
}

// 失败通道自证：SELFTEST_PROVE_FAIL=1 时故意插一条必然失败的断言，
// 用来现场证明「任何 FAIL → 退出码 1」这条要求真的成立。
if (process.env.SELFTEST_PROVE_FAIL === '1') {
  check('（自证）故意失败：验证 FAIL 呈报与退出码', false, '刻意注入，正常运行时不会出现')
}

if (FAILED.length > 0) {
  console.log('\n失败用例：')
  for (const name of FAILED) console.log(`  - ${name}`)
}
if (crashed !== null) console.log(`\n崩溃原因：${crashed?.stack ?? crashed}`)
console.log(`\n${PASSED}/${TOTAL} 通过`)
console.log(`被测 index.js：${PLUGIN_REV}`)
REAL_EXIT(PASSED === TOTAL && crashed === null ? 0 : 1)

/**
 * Standalone probe for the dsh-tui `tuiDialogs` contract.
 *
 * Runs the REAL files in place:
 *   - dsh-tui/lib/types/dsh-adapter/dialogs.js  (TuiDialogRuntime + TuiDialogStore)
 *   - %USERPROFILE%/dsh-plugin-redact/index.js (the plugin under review)
 * on a REAL cordis root (Context from the cordis the dsh CLI ships).
 *
 * Nothing under ~/.dsh/sessions, ~/.dsh/storages or any *.jsonl.zstd is read:
 * every session is synthesised in memory.
 */
import { Context, Service, LoggerService } from '@deepseek-ai/cordis'

const TUI_DIALOGS =
  'file:///%USERPROFILE%/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/dialogs.js'
const REDACT = 'file:///%USERPROFILE%/dsh-plugin-redact/index.js'

const dialogsMod = await import(TUI_DIALOGS)
const TuiDialogRuntime = dialogsMod.default
const { getHostDialogStore, TuiDialogStore, DIALOG_DEFAULT_TIMEOUT_MS, INPUT_CELLS } = dialogsMod
const redact = await import(REDACT)

const results = {}
function rec(key, value) {
  results[key] = value
  console.log('### ' + key + ' => ' + JSON.stringify(value))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------------------------------------------------------- spies -- */
const timerDelays = []
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function (fn, ms, ...rest) {
  timerDelays.push(ms)
  return realSetTimeout(fn, ms, ...rest)
}
const realDelays = () => timerDelays.filter((d) => d !== 4)
const warns = []
const realWarn = LoggerService.prototype.warn
LoggerService.prototype.warn = function (...args) {
  warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  return realWarn.apply(this, args)
}
const drainWarns = () => warns.splice(0, warns.length)

/* ------------------------------------------------------- synthetic data -- */
function makeSession(specs) {
  const events = new Map()
  const nodes = []
  let seq = 0
  for (const spec of specs) {
    const callId = 'call-' + seq
    events.set(seq, { type: 'tool/call', data: { callId, name: spec.tool } })
    seq += 1
    events.set(seq, {
      type: 'tool/result',
      data: {
        message: { role: 'user', source: { callId }, content: [{ type: 'text', text: 'X'.repeat(spec.bytes) }] },
      },
    })
    nodes.push(seq)
    seq += 1
  }
  const appended = []
  return {
    id: 'synthetic-session-0000',
    seq: seq - 1,
    appended,
    eventAt: (i) => events.get(i),
    surface: { nodes: new Set(nodes) },
    append(type, data, opts) {
      const s = seq
      seq += 1
      events.set(s, { type, data })
      appended.push({ seq: s, type, opts })
      return { seq: s }
    },
  }
}
const specs = (n, tool = 'Bash', bytes = 2048) =>
  Array.from({ length: n }, (_, i) => ({ tool: typeof tool === 'function' ? tool(i) : tool, bytes }))
/** The plugin's own CJK-aware cell estimator (index.js:34). */
const cells = (s) => {
  let n = 0
  for (const ch of s) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return n
}

/* --------------------------------------------------------------- helpers -- */
function mount(root, plugin, config) {
  const fiber = root.plugin(plugin, config)
  return typeof fiber?.await === 'function' ? fiber.await() : Promise.resolve(fiber)
}
class FakeCommands extends Service {
  constructor(ctx) {
    super(ctx, 'commands')
  }
  register(def) {
    this.def = def
    return () => {
      this.def = undefined
    }
  }
}
const fakeCommandsPlugin = { name: 'fake-commands', apply: (ctx) => void ctx.plugin(FakeCommands) }
const dialogsRow = { name: 'extensions-like-row', apply: (ctx) => void ctx.plugin(TuiDialogRuntime) }
const callerRows = {}
const callerRow = (key) => ({
  name: key,
  apply(ctx) {
    callerRows[key] = {
      ctx,
      // The plugin reads the service INSIDE the handler (index.js:811), i.e.
      // long after every row mounted — so the probe reads it late too.
      get dialogs() {
        return ctx.get('tuiDialogs')
      },
      propAccess() {
        try {
          return ['ok', typeof ctx.tuiDialogs]
        } catch (e) {
          return ['THREW', e.message]
        }
      },
    }
  },
})

async function buildApp({ withDialogs = true, callerFirst = false, callerKey = 'caller', redactFirst = false, commandsFirst = false, entryInject } = {}) {
  const root = new Context()
  const redactRow = { name: 'dsh-redact', inject: entryInject ?? redact.inject, apply: redact.apply }
  const redactConfig = { root: 'C:/nonexistent-probe-root', cacheRoot: 'C:/nonexistent-probe-cache' }
  const pending = []
  if (commandsFirst) await mount(root, fakeCommandsPlugin)
  else pending.push(mount(root, fakeCommandsPlugin))
  const row = callerRow(callerKey)
  if (callerFirst) pending.push(mount(root, row))
  if (redactFirst) pending.push(mount(root, redactRow, redactConfig))
  if (withDialogs) pending.push(mount(root, dialogsRow))
  if (!callerFirst) pending.push(mount(root, row))
  if (!redactFirst) pending.push(mount(root, redactRow, redactConfig))
  await Promise.all(pending)
  return root
}

async function waitSnapshot(store, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const snap = store.getSnapshot()
    if (snap !== null) return snap
    await sleep(4)
  }
  return null
}
/** Read a pending select/confirm answer without parking the probe forever. */
async function settleOrReport(promise, store, action) {
  const snap = await waitSnapshot(store)
  if (snap === null) {
    const value = await promise
    return { snapshot: null, value, warns: drainWarns() }
  }
  if (action.kind === 'cancel') store.cancel(snap.key)
  else if (action.kind === 'decide') store.decide(snap.key, action.value)
  // kind 'none': leave it parked (used for timeout tests)
  return { snapshot: snap, value: await promise, warns: drainWarns() }
}

/* ============================================ PART 1: runtime-level tests == */
rec('version', { DIALOG_DEFAULT_TIMEOUT_MS, INPUT_CELLS, modExports: Object.keys(dialogsMod).sort() })

{
  const root = await buildApp({ callerKey: 'caller' })
  const late = callerRows['caller']
  const rootService = root.get('tuiDialogs')
  const store = getHostDialogStore(rootService)

  rec('p0.rootContextGet', { type: typeof rootService, select: typeof rootService?.select })
  rec('p0.propAccessWithoutInject', late.propAccess())
  rec('p1.looseRowGetAfterMount', { type: typeof late.dialogs, methods: ['select', 'confirm', 'input'].filter((m) => typeof late.dialogs[m] === 'function') })
  rec('p1.hostStoreUnwrapped', store instanceof TuiDialogStore)

  // p0b: caller row mounted BEFORE the service row (order sensitivity)
  {
    drainWarns()
    const rootEarly = await buildApp({ callerFirst: true, callerKey: 'early' })
    const earlyStore = getHostDialogStore(rootEarly.get('tuiDialogs'))
    const res = await settleOrReport(
      callerRows['early'].dialogs.select({ title: 'T', options: [{ id: '1', label: 'L' }] }),
      earlyStore,
      { kind: 'decide', value: '1' },
    )
    rec('p0b.looseRowMountedBeforeServiceRow', { value: res.value, sawDialog: res.snapshot !== null, warns: res.warns })
  }

  // p0c: the ROOT context is not a plugin activation
  drainWarns()
  const rootCall = await rootService.select({ title: 'T', options: [{ id: '1', label: 'L' }], timeoutMs: 120000 })
  rec('p0c.callFromRootContext', { value: rootCall, timerDelays: realDelays(), warns: drainWarns() })

  // p0d: WHICH guard is order-dependent? (requirePluginCaller / bindCallerEffect)
  {
    const hostAccess = await import(
      'file:///%USERPROFILE%/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/host-access.js'
    )
    const rootEarly = await buildApp({ callerFirst: true, callerKey: 'early2' })
    const probeGuard = (tag, ctx, service) => {
      let req
      try {
        hostAccess.requirePluginCaller(ctx, 'probe', service)
        req = 'OK'
      } catch (e) {
        req = 'THREW: ' + e.message
      }
      let bound
      try {
        bound = hostAccess.bindCallerEffect(ctx, () => {}, () => {})
      } catch (e) {
        bound = 'THREW: ' + e.message
      }
      return { tag, requirePluginCaller: req, bindCallerEffect: bound }
    }
    rec('p0d.guards', [
      probeGuard('row-mounted-before-service-row', callerRows['early2'].ctx, rootEarly.get('tuiDialogs')),
      probeGuard('row-mounted-after-service-row', late.ctx, rootService),
    ])
  }

  // --- 1a. valid select, answered
  drainWarns()
  timerDelays.length = 0
  const p1 = late.dialogs.select({
    title: '选择要隐藏的 tool/result 节点（共 3 个，最新在前）',
    options: [
      { id: '1', label: '[1] 行 10 · Bash · 2.0KB' },
      { id: '2', label: '[2] 行 8 · Grep · 1.0KB' },
    ],
    timeoutMs: 120000,
  })
  const snap1 = await waitSnapshot(store)
  rec('p1a.snapshot', snap1)
  rec('p1a.timerDelaysMs', realDelays())
  store.decide(snap1.key, '2')
  rec('p1a.resolved', await p1)
  rec('p1a.warns', drainWarns())

  // --- 1b. Esc cancel + default timeout
  timerDelays.length = 0
  drainWarns()
  const r1b = await settleOrReport(
    late.dialogs.select({ title: 'T', options: [{ id: '1', label: 'L' }] }),
    store,
    { kind: 'cancel' },
  )
  rec('p1b.escCancel', { value: r1b.value, timerDelaysMs: realDelays(), warns: r1b.warns })

  // --- 1c. caller-supplied timeout honoured (short one, observable)
  timerDelays.length = 0
  const t0 = Date.now()
  const r1cValue = await late.dialogs.select({ title: 'T', options: [{ id: '1', label: 'L' }], timeoutMs: 250 })
  rec('p1c.timeout250', {
    value: r1cValue,
    elapsedMs: Date.now() - t0,
    timerDelaysMs: realDelays(),
    queueEmptyAfterwards: store.getSnapshot() === null,
    warns: drainWarns(),
  })

  // --- 1d. upper bound: 25h request
  timerDelays.length = 0
  const r1d = await settleOrReport(
    late.dialogs.select({ title: 'T', options: [{ id: '1', label: 'L' }], timeoutMs: 25 * 60 * 60 * 1000 }),
    store,
    { kind: 'cancel' },
  )
  rec('p1d.timeout25h', { timerDelaysMs: realDelays() })

  // --- 1e. bogus timeoutMs values
  for (const [tag, v] of [['zero', 0], ['negative', -5], ['string', '5000'], ['nan', NaN], ['infinity', Infinity]]) {
    timerDelays.length = 0
    const r = await settleOrReport(
      late.dialogs.select({ title: 'T', options: [{ id: '1', label: 'L' }], timeoutMs: v }),
      store,
      { kind: 'cancel' },
    )
    rec('p1e.timeoutMs.' + tag, realDelays())
  }

  // --- 1f. empty options
  drainWarns()
  const r1f = await late.dialogs.select({ title: 'T', options: [] })
  rec('p1f.emptyOptions', { value: r1f, warns: drainWarns() })

  // --- 1g. missing / blank title
  drainWarns()
  const r1g = {
    selectNoTitle: await late.dialogs.select({ options: [{ id: '1', label: 'L' }] }),
    selectBlankTitle: await late.dialogs.select({ title: '   ', options: [{ id: '1', label: 'L' }] }),
    confirmNoTitle: await late.dialogs.confirm({ message: 'm' }),
  }
  rec('p1g.noTitle', { ...r1g, warns: drainWarns() })

  // --- 1h. 200 options -> cap
  drainWarns()
  const big = Array.from({ length: 200 }, (_, i) => ({ id: String(i + 1), label: 'opt ' + (i + 1) }))
  const r1h = await settleOrReport(late.dialogs.select({ title: 'T', options: big }), store, { kind: 'cancel' })
  rec('p1h.optionCap', {
    sent: 200,
    rendered: r1h.snapshot.options.length,
    first: r1h.snapshot.options[0].id,
    last: r1h.snapshot.options[r1h.snapshot.options.length - 1].id,
  })

  // --- 1i. option validation: bad ids / bad labels are DROPPED
  drainWarns()
  const r1i = await settleOrReport(
    late.dialogs.select({
      title: 'T',
      options: [
        { id: 7, label: 'numeric id' },
        { id: '', label: 'empty id' },
        { id: 'ok', label: '' },
        { id: 'ctl', label: '\u0000\u0007\u001b[31m' },
        { id: 'good', label: '  a   b  ' },
        { id: 'ver batim', label: 'keep id verbatim' },
        { id: 'desc', label: 'with description', description: 'D'.repeat(500) },
      ],
    }),
    store,
    { kind: 'cancel' },
  )
  rec('p1i.optionValidation', {
    sent: 7,
    rendered: r1i.snapshot.options.length,
    options: r1i.snapshot.options.map((o) => ({
      id: o.id,
      label: o.label,
      descLen: o.description === undefined ? null : o.description.length,
    })),
    warns: r1i.warns,
  })

  // --- 1j. control chars / whitespace / cell caps
  const long = '中'.repeat(200)
  const r1j = await settleOrReport(
    late.dialogs.select({
      title: long + 'TAIL',
      options: [
        { id: 'w', label: 'A\u001b[31mB\u001b[0mC' },
        { id: 'x', label: 'a\u0000b\u0007c\u009fd' },
        { id: 'y', label: 'x\ny\tz' },
        { id: 'z', label: '  p   q  ' },
        { id: 'cjk', label: '行 12 · 中文工具 · 1.0KB' },
      ],
    }),
    store,
    { kind: 'cancel' },
  )
  rec('p1j.sanitized', {
    titleChars: [...r1j.snapshot.title].length,
    titleEndsEllipsis: r1j.snapshot.title.endsWith('…'),
    labels: r1j.snapshot.options.map((o) => o.label),
  })

  // --- 1k. non-scalar title
  drainWarns()
  const r1k = {
    selectObjectTitle: await late.dialogs.select({ title: { a: 1 }, options: [{ id: '1', label: 'L' }] }),
    confirmArrayTitle: await late.dialogs.confirm({ title: ['x'] }),
  }
  rec('p1k.nonScalarTitle', { ...r1k, warns: drainWarns() })

  // --- 1l. confirm: true / false / cancel / no message
  drainWarns()
  timerDelays.length = 0
  const c1 = settleOrReport(
    late.dialogs.confirm({
      title: '隐藏 [1] 行 100 · Bash · 2.0KB？',
      message: '隐藏后从下一轮请求起模型不再看到它（磁盘字节仍在）。该节点会被永久遮蔽，无法还原。',
      confirmLabel: '隐藏',
      cancelLabel: '取消',
      timeoutMs: 120000,
    }),
    store,
    { kind: 'decide', value: true },
  )
  const cs1 = await waitSnapshot(store)
  rec('p1l.confirmSnapshotWithLabels', cs1)
  rec('p1l.confirmTimerMs', realDelays())
  store.decide(cs1.key, true)
  rec('p1l.confirmTrue', await c1)

  const r1l2 = await settleOrReport(late.dialogs.confirm({ title: 'Q', message: 'M' }), store, { kind: 'decide', value: false })
  rec('p1l.confirmFalse', { value: r1l2.value, snapshot: { confirmLabel: r1l2.snapshot.confirmLabel, cancelLabel: r1l2.snapshot.cancelLabel, message: r1l2.snapshot.message } })

  const r1l3 = await settleOrReport(late.dialogs.confirm({ title: 'Q' }), store, { kind: 'cancel' })
  rec('p1l.confirmNoMessageCancel', { value: r1l3.value, snapshot: r1l3.snapshot })

  // --- 1m. non-string labels
  const r1m = await settleOrReport(
    late.dialogs.confirm({ title: 'Q', confirmLabel: { evil: 1 }, cancelLabel: 42 }),
    store,
    { kind: 'cancel' },
  )
  rec('p1m.confirmNonStringLabels', {
    confirmLabel: r1m.snapshot.confirmLabel,
    cancelLabel: r1m.snapshot.cancelLabel,
    value: r1m.value,
  })

  // --- 1n. non-object request
  drainWarns()
  const r1n = {
    selectUndefined: await late.dialogs.select(undefined),
    selectNull: await late.dialogs.select(null),
    selectNumber: await late.dialogs.select(42),
    confirmUndefined: await late.dialogs.confirm(undefined),
  }
  rec('p1n.nonObjectRequest', { ...r1n, warns: drainWarns() })

  // --- 1o. teardown while pending
  const p12 = late.dialogs.select({ title: 'T', options: [{ id: '1', label: 'L' }] })
  await waitSnapshot(store)
  const before = await Promise.race([p12.then((v) => ({ value: v })), sleep(20).then(() => 'still-pending')])
  store.settleAll()
  rec('p1o.teardown', { before, after: await p12 })

  // --- 1p. two parallel dialogs are queued FIFO
  const pa = late.dialogs.select({ title: 'A', options: [{ id: 'a', label: 'a' }] })
  const pb = late.dialogs.select({ title: 'B', options: [{ id: 'b', label: 'b' }] })
  await sleep(20)
  const first = store.getSnapshot()
  store.decide(first.key, 'a')
  await sleep(20)
  const second = store.getSnapshot()
  store.decide(second.key, 'b')
  rec('p1p.fifo', { first: first.title, second: second.title, a: await pa, b: await pb })
}

/* ================================== PART 2: the real plugin's `pick` flow == */
async function runPick({ nodes, answer, confirmAnswer, confirmAction, dropService = false, redactFirst = false, commandsFirst = false, entryInject }) {
  const root = await buildApp({ withDialogs: !dropService, redactFirst, commandsFirst, entryInject })
  const commands = root.get('commands')
  const def = commands.def
  const session = makeSession(nodes)
  drainWarns()
  timerDelays.length = 0
  const promise = Promise.resolve(def.handler({ rawInput: 'pick', agent: { session } }))
  const store = dropService ? null : getHostDialogStore(root.get('tuiDialogs'))
  const snap = store ? await waitSnapshot(store) : null
  const observed = snap === null ? null : { kind: snap.kind, title: snap.title, optionCount: snap.options.length, options: snap.options }
  if (snap !== null) {
    if (answer === 'cancel') store.cancel(snap.key)
    else store.decide(snap.key, answer)
  }
  let snap2 = null
  if (snap !== null && answer !== 'cancel' && (confirmAnswer !== undefined || confirmAction !== undefined)) {
    snap2 = await waitSnapshot(store)
    if (snap2 !== null) {
      if (confirmAction === 'cancel') store.cancel(snap2.key)
      else store.decide(snap2.key, confirmAnswer)
    }
  }
  const result = await promise
  return {
    observed,
    confirmSnapshot:
      snap2 === null ? null : { title: snap2.title, message: snap2.message, confirmLabel: snap2.confirmLabel, cancelLabel: snap2.cancelLabel },
    timerMs: realDelays(),
    warns: drainWarns(),
    result,
    appended: session.appended.map((a) => a.type),
  }
}

// 2a. happy path
rec('p2a.happyPath', await runPick({ nodes: specs(3), answer: '2', confirmAnswer: true }))

// 2b. Esc on select
{
  const r = await runPick({ nodes: specs(3), answer: 'cancel' })
  rec('p2b.escOnSelect', { result: r.result, warns: r.warns })
}

// 2c. confirm cancelled
{
  const r = await runPick({ nodes: specs(3), answer: '1', confirmAction: 'cancel' })
  rec('p2c.confirmCancelled', { result: r.result, confirmSnapshot: r.confirmSnapshot, warns: r.warns })
}

// 2d. 200 nodes -> plugin caps at 60
{
  const r = await runPick({ nodes: specs(200), answer: '1', confirmAnswer: true })
  rec('p2d.200nodes', {
    title: r.observed.title,
    titleCells: cells(r.observed.title),
    titleTruncatedByRuntime: r.observed.title.endsWith('…'),
    optionCount: r.observed.optionCount,
    first: r.observed.options[0],
    last: r.observed.options[r.observed.options.length - 1],
    result: r.result,
    warns: r.warns,
  })
}

// 2e. 60 nodes: real cell widths
{
  const r = await runPick({ nodes: specs(60), answer: '1', confirmAnswer: true })
  rec('p2e.widths', {
    title: r.observed.title,
    titleCells: cells(r.observed.title),
    longestLabelCells: Math.max(...r.observed.options.map((o) => cells(o.label))),
    anyLabelTruncated: r.observed.options.some((o) => o.label.endsWith('…')),
    titleTruncated: r.observed.title.endsWith('…'),
  })
}

// 2f. hostile tool names
{
  const r = await runPick({
    nodes: [
      { tool: 'Ba\u0007sh', bytes: 2048 },
      { tool: 'A\u001b[31mB\u001b[0mC', bytes: 10 },
      { tool: 'T'.repeat(200), bytes: 999999 },
      { tool: '中文工具名'.repeat(10), bytes: 5 },
    ],
    answer: '4',
    confirmAnswer: true,
  })
  rec('p2f.hostileToolNames', {
    title: r.observed.title,
    options: r.observed.options,
    confirmTitle: r.confirmSnapshot?.title,
    confirmMessage: r.confirmSnapshot?.message,
    result: r.result,
    warns: r.warns,
  })
}

// 2g. big sizes / line numbers
{
  const r = await runPick({ nodes: specs(60, 'Bash', 20 * 1024 * 1024), answer: '1', confirmAnswer: true })
  rec('p2g.labelSample', r.observed.options.slice(0, 3))
}

// 2h. service absent (soft probe falls back)
{
  const r = await runPick({ nodes: specs(3), answer: '1', dropService: true })
  rec('p2h.noService', { result: r.result })
}

// 2i. no nodes
{
  const r = await runPick({ nodes: [], answer: '1' })
  rec('p2i.noNodes', { result: r.result, observed: r.observed })
}

// 2j. the redact row activates BEFORE the extensions row (mount-order skew)
{
  const r = await runPick({ nodes: specs(3), answer: '1', confirmAnswer: true, redactFirst: true })
  rec('p2j.redactRowMountedBeforeServiceRow', { sawDialog: r.observed !== null, result: r.result, warns: r.warns })
}

// 2k. worst case: `commands` already active, redact row created BEFORE the service row
{
  const r = await runPick({ nodes: specs(3), answer: '1', confirmAnswer: true, redactFirst: true, commandsFirst: true })
  rec('p2k.commandsPrewarmedRedactFirst', { sawDialog: r.observed !== null, result: r.result, warns: r.warns })
}

// 2l. FIX CANDIDATE: entry-level inject [commands, tuiDialogs], redact row first
{
  const r = await runPick({
    nodes: specs(3),
    answer: '1',
    confirmAnswer: true,
    redactFirst: true,
    commandsFirst: true,
    entryInject: ['commands', 'tuiDialogs'],
  })
  rec('p2l.entryInjectFix', { sawDialog: r.observed !== null, result: r.result, warns: r.warns })
}

// 2m. the fix's cost: entry-level inject with NO service row -> the row parks
{
  const root = new Context()
  await mount(root, fakeCommandsPlugin)
  const fiber = root.plugin(
    { name: 'dsh-redact', inject: ['commands', 'tuiDialogs'], apply: redact.apply },
    { root: 'C:/nonexistent-probe-root', cacheRoot: 'C:/nonexistent-probe-cache' },
  )
  await sleep(300)
  rec('p2m.entryInjectWithoutServiceRow', {
    fiberState: fiber?.state,
    commandRegistered: root.get('commands')?.def !== undefined,
  })
}

console.log('\n=== JSON ===')
console.log(JSON.stringify(results, null, 1))

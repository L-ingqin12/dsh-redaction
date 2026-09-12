/**
 * Repro 1 — the REAL TuiDialogStore (imported from the deployment, not copied)
 * driven with a parked request and NO decide/cancel, i.e. exactly the state the
 * user was in: the plugin is awaiting, the store holds an active snapshot.
 *
 * Question answered: what does the CALLER observe over time, and what does the
 * UI see? Also measures the 15 s bound end to end.
 */
const url = 'file:///%USERPROFILE%/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/dialogs.js'
const { TuiDialogStore, DIALOG_DEFAULT_TIMEOUT_MS } = await import(url)

const t0 = Date.now()
const rel = () => `${String(Date.now() - t0).padStart(6)}ms`

const log = (...a) => console.log(`[${rel()}]`, ...a)

// ── A. park a request the way /redact pick does (timeoutMs: 15000) ──────────
const store = new TuiDialogStore()
let emissions = 0
store.subscribe(() => { emissions += 1 })

const options = [1, 2, 3].map(i => ({ id: String(i), label: `[${i}] 行 ${100 + i} 轮 7 · bash · 1.2KB` }))
const snapshot = {
  kind: 'select',
  title: '选择要隐藏的节点（共 3 个，最新在前）',
  options,
}

const events = []
const callStarted = rel()
let settledAt = null
let settledWith = Symbol('pending')

const p = store.ask(snapshot, undefined, 15000)
p.then(v => { settledAt = rel(); settledWith = v })

log('A. store.ask(select, timeoutMs=15000) called')
log('   getSnapshot().key      =', store.getSnapshot()?.key)
log('   getSnapshot().kind     =', store.getSnapshot()?.kind)
log('   queue length           =', store.queue.length, ' active!=null =', store.active !== null)
log('   listeners (renderers)  =', store.listeners.size)

// ── B. "renderer absent": nobody ever calls decide()/cancel() ───────────────
// poll the observable surface at a few points
const marks = [0, 250, 1000, 5000, 14000, 15200]
let last = 0
for (const m of marks) {
  await new Promise(r => setTimeout(r, m - last))
  last = m
  const snap = store.getSnapshot()
  log(`B. t=${m}ms  snapshot=${snap === null ? 'null' : snap.key + '/' + snap.kind}` +
      `  stillPending=${settledAt === null}  emissions=${emissions}`)
}

// let the timeout settle
await p.catch(() => {})
log(`C. promise settled: value=${String(settledWith)} at ${settledAt} (asked at ${callStarted})`)
log('   getSnapshot() after settle =', store.getSnapshot())
log('   total store emissions      =', emissions)

// ── D. correct-key guard: a decided-but-unrendered dialog is NOT closable ──
log('')
log('D. stale-key behaviour (the panel that was never mounted cannot close it)')
const store2 = new TuiDialogStore()
let v2 = 'pending'
const p2 = store2.ask({ kind: 'select', title: 'T', options }, undefined, 60000)
p2.then(v => { v2 = v })
const activeKey = store2.getSnapshot().key
log('   active key =', activeKey)
store2.decide('dlg-does-not-exist', '1')   // e.g. a stale/never-mounted panel's Enter
log('   after decide(<wrong key>) -> still pending:', v2 === 'pending', ' snapshot:', store2.getSnapshot()?.key)
store2.cancel('dlg-does-not-exist')
log('   after cancel(<wrong key>) -> still pending:', v2 === 'pending')
// prove the correct key does work (await the microtask so v2 is up to date)
store2.cancel(activeKey)
await p2
log('   after cancel(<correct key>) -> settled with:', String(v2), '(promise observed)')

// ── E. queued request burns its timeout while it is NOT active ─────────────
log('')
log('E. FIFO + per-request timers (a queued request times out before it is ever shown)')
const store3 = new TuiDialogStore()
const seen = []
const pA = store3.ask({ kind: 'select', title: 'A', options }, undefined, 60000)
const pB = store3.ask({ kind: 'select', title: 'B', options }, undefined, 300)
pA.then(v => seen.push(['A', v]))
pB.then(v => seen.push(['B', v]))
log('   active =', store3.getSnapshot()?.title, ' queued =', store3.queue.length)
await new Promise(r => setTimeout(r, 400))
log('   after 400ms: B settled as', JSON.stringify(seen.find(s => s[0] === 'B')?.[1]),
    '| active is still', store3.getSnapshot()?.title)
log('   -> B was cancelled by ITS OWN timer, never shown at all')
store3.settleAll()

log('')
log('F. default timeout when the caller omits one:', DIALOG_DEFAULT_TIMEOUT_MS, 'ms')
process.exit(0)

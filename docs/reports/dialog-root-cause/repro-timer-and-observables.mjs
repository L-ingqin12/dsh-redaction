/**
 * Repro 3 — the "will the 15 s bound really fire?" question, plus the exact
 * settlement path. Uses the REAL TuiDialogStore.
 *
 * Also probes whether the plugin could have pre-flighted: enumerate every
 * observable the plugin-facing `ctx.tuiDialogs` proxy exposes.
 */
const url = 'file:///' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/dialogs.js'
const { TuiDialogStore, TuiDialogRuntime, DIALOG_DEFAULT_TIMEOUT_MS } = await import(url)

// ── G. does the timer fire when the event loop is busy? ────────────────────
const store = new TuiDialogStore()
const t0 = Date.now()
let settled = 'pending'
store.ask({ kind: 'select', title: 'T', options: [{ id: '1', label: 'a' }] }, undefined, 15000)
  .then(v => { settled = `${v} @ ${Date.now() - t0}ms` })

// Block the loop in the middle of the window, the way a big synchronous
// session rewrite would.
await new Promise(r => setTimeout(r, 3000))
const busyUntil = Date.now() + 4000
let spins = 0
while (Date.now() < busyUntil) spins += 1
console.log(`G. blocked the event loop for ~${Date.now() - t0 - 3000}ms (${spins} spins)`)
await new Promise(r => setTimeout(r, 12000))
console.log('   settled:', settled, '-> a busy loop delays, never cancels, the timer')

// ── H. what the plugin can actually see on the service ────────────────────
console.log('')
console.log('H. plugin-facing observables on ctx.tuiDialogs')
console.log('   prototype methods :', Object.getOwnPropertyNames(TuiDialogRuntime.prototype).join(', '))
console.log('   -> no getSnapshot / no pendingCount / no isRendered / no availability')
console.log('   DIALOG_DEFAULT_TIMEOUT_MS =', DIALOG_DEFAULT_TIMEOUT_MS)

// ── I. the store's subscriber count IS the renderer signal — but host-only ─
console.log('')
console.log('I. the store DOES know: listeners is the set of mounted renderers')
const s2 = new TuiDialogStore()
console.log('   listeners with nobody subscribed :', s2.listeners.size)
s2.subscribe(() => {})
console.log('   listeners with one subscriber    :', s2.listeners.size)
console.log('   -> but `listeners` is only reachable through the live store instance,')
console.log('      which the plugin surface does not expose (dialogs.js:305 hostDialogStores')
console.log('      WeakMap; getHostDialogStore is not in package.json exports).')

process.exit(0)

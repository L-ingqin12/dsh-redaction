/**
 * Repro 2 — the RENDER-vs-KEYBOARD divergence, evaluated over the real guard
 * predicates transcribed verbatim from
 *   .../dsh-tui/lib/types/screens/Chat.js
 * with every predicate's file:line recorded next to it.
 *
 * This is a transcription, not a headless mount of Chat: `Chat` is not in the
 * package's export map (package.json "exports" has no ./screens/* subpath), and
 * the component needs a full TUI channel, theme host and stdout. Where a value
 * cannot be derived statically it is marked as such.
 */

// ── render site: Chat.js:3585 (prompt slot / `_jsxs(Box, …)` children) ──────
//   approvalPanelNode !== null ? approvalPanelNode
//   : dialogSnapshot !== null ? <ExtensionDialog …/>            <-- the ONLY mount
//   : …
function dialogIsMounted(s) {
  return s.approvalPanelNode === null && s.dialogSnapshot !== null
}

// ── the eight early returns that precede that site (Chat.js:3360–3469) ──────
// 3360 if (interruptPanel !== null && screenOpen)   interruptPanel = approval ?? question
// 3378 if (pluginScene !== undefined)
// 3388 if (agentViewOpen)
// 3408 if (browserOpen)
// 3421 if (treeOpen)
// 3430 if (settingsOpen)
// 3436 if (subagentDetailId !== null)
// 3452 if (jobsPanelOpen)
// 3464 if (subagentDashboardOpen)
// 3492 if (sceneOpen)                                (trajectory scene)
const EARLY_RETURNS = [
  ['Chat.js:3360 interruptPanel&&screenOpen', s => s.approvalPanelNode !== null && s.screenOpen],
  ['Chat.js:3378 pluginScene', s => s.pluginScene === true],
  ['Chat.js:3388 agentViewOpen', s => s.agentViewOpen === true],
  ['Chat.js:3408 browserOpen', s => s.browserOpen === true],
  ['Chat.js:3421 treeOpen', s => s.treeOpen === true],
  ['Chat.js:3430 settingsOpen', s => s.settingsOpen === true],
  ['Chat.js:3436 subagentDetailId', s => s.subagentDetailId === true],
  ['Chat.js:3452 jobsPanelOpen', s => s.jobsPanelOpen === true],
  ['Chat.js:3464 subagentDashboardOpen', s => s.subagentDashboardOpen === true],
  ['Chat.js:3492 sceneOpen', s => s.sceneOpen === true],
]

function dialogReachable(s) {
  for (const [label, guard] of EARLY_RETURNS) if (guard(s)) return label
  return null
}

// ── keyboard guard: Chat.js:2566 ───────────────────────────────────────────
//   if (questionSnapshot !== null || approvalSnapshot !== null
//       || dialogSnapshot !== null) return
// preceded by helpOpen (2560), wheel (2500), page (2537) and the whole-screen
// guards at 2453–2482.
function chatYieldsEveryKey(s) {
  if (s.dialogSnapshot === null) return false
  return true // :2566 — unconditional for the remaining key chain
}

// PromptInput's own listener is registered with { isActive: !suspended }
// (PromptInput.js:2456) and `suspended` is
//   promptReplacementOpen = approvalPanelNode !== null || dialogSnapshot !== null
//   || overlay.kind === 'tips' || expanded recap || btw !== null
//   || questionPanelNode !== null                         (Chat.js:3478-3483)
function promptInputListenerIsLive(s) {
  return !(s.approvalPanelNode !== null || s.dialogSnapshot !== null
    || s.tipsOpen === true || s.expandedRecap === true || s.btw !== null
    || s.questionPanelNode !== null)
}

// The ONLY component that can settle the parked request is the panel mounted at
// :3585; its handlers are useInput(..., { isActive: true })
// (ExtensionDialog.js:87, :131, :249).
function panelCanSettle(s) {
  return dialogIsMounted(s)
}

function row(label, s) {
  const blocked = dialogReachable(s)
  const mounted = !blocked && dialogIsMounted(s)
  const yields = chatYieldsEveryKey(s)
  const prompt = promptInputListenerIsLive(s)
  const anyListener = mounted || prompt
  return {
    label,
    dialogMounted: mounted,
    renderSuppressedBy: blocked,
    chatYieldsAllKeys: yields,
    promptInputLive: prompt,
    LIVE_LISTENER: anyListener,
    deadlock: s.dialogSnapshot !== null && !anyListener,
  }
}

const cases = [
  ['ideal: dialog parked, nothing else up',
    { approvalPanelNode: null, questionPanelNode: null, dialogSnapshot: { key: 'dlg-1' }, screenOpen: false }],

  ['A1 approval panel already showing (approvalSnapshot !== null)',
    { approvalPanelNode: { k: 'ap' }, questionPanelNode: null, dialogSnapshot: { key: 'dlg-1' }, screenOpen: false }],

  ['A2 approval + a whole screen up (interrupt lane, Chat.js:3360)',
    { approvalPanelNode: { k: 'ap' }, questionPanelNode: null, dialogSnapshot: { key: 'dlg-1' }, screenOpen: true }],

  ['B1 user clicks a subagent chip while the dialog is parked (agentView)',
    { approvalPanelNode: null, questionPanelNode: null, dialogSnapshot: { key: 'dlg-1' }, screenOpen: false, agentViewOpen: true }],

  ['B2 /sessions browser opened while parked (mouse route)',
    { approvalPanelNode: null, questionPanelNode: null, dialogSnapshot: { key: 'dlg-1' }, screenOpen: false, browserOpen: true }],

  ['B3 settings screen while parked',
    { approvalPanelNode: null, questionPanelNode: null, dialogSnapshot: { key: 'dlg-1' }, screenOpen: false, settingsOpen: true }],

  ['B4 jobs panel while parked',
    { approvalPanelNode: null, questionPanelNode: null, dialogSnapshot: { key: 'dlg-1' }, screenOpen: false, jobsPanelOpen: true }],

  ['B5 plugin scene opened while parked',
    { approvalPanelNode: null, questionPanelNode: null, dialogSnapshot: { key: 'dlg-1' }, screenOpen: false, pluginScene: true }],

  ['C no dialog parked (control)',
    { approvalPanelNode: null, questionPanelNode: null, dialogSnapshot: null, screenOpen: false }],

  ['D approval panel up, NO dialog (control: normal approval UX)',
    { approvalPanelNode: { k: 'ap' }, questionPanelNode: null, dialogSnapshot: null, screenOpen: false }],
]

console.log('label'.padEnd(66), 'mounted', 'suppressedBy'.padEnd(42), 'chatYields', 'promptLive', 'DEADLOCK')
console.log('-'.repeat(165))
const rows = cases.map(([label, s]) => row(label, s))
for (const r of rows) {
  console.log(
    r.label.padEnd(66),
    String(r.dialogMounted).padEnd(7),
    String(r.renderSuppressedBy ?? '-').padEnd(42),
    String(r.chatYieldsAllKeys).padEnd(10),
    String(r.promptInputLive).padEnd(10),
    r.deadlock ? 'YES' : 'no',
  )
}

console.log('')
const dead = rows.filter(r => r.deadlock)
console.log(`DEADLOCK states found: ${dead.length}`)
for (const r of dead) console.log('  -', r.label)

// Kill-switch check: does the 15 s timer reach a deadlocked state?
console.log('')
console.log('Timer reachability: `ask(..., timeoutMs=15000)` arms setTimeout(pending.onAbort, 15000)')
console.log('(dialogs.js:100-102) for EVERY accepted request, including one that never renders.')
console.log('TuiDialogRuntime.timeoutOf (dialogs.js:211-215) clamps any request to')
console.log('DIALOG_DEFAULT_TIMEOUT_MS=30000 (dialogs.js:40) when timeoutMs is absent or <= 0,')
console.log('so via the service surface a parked dialog ALWAYS has a timer.')
console.log('=> the deadlock is bounded, not permanent. Repro 1 measured the bound at ~15010ms.')

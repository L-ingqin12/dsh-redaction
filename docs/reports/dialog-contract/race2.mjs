/**
 * ONE run per process, everything COLD — the faithful version of the
 * activation race inside a fresh dsh-tui boot.
 *
 * Row order matches the composed profile (dsh-base → dsh-tui → dsh-plugin-*):
 *   1. commands   : real cold import of @deepseek-ai/dsh-commands
 *   2. workspaces : real cold import of dsh-tui's FIRST tracker-installing row
 *                   (dsh-adapter/workspaces.js, compositionRoot at line 37)
 *   3. redact     : the real plugin row, inject: ['commands']
 * All three entries are created in ONE synchronous batch, like the Loader's
 * group.create() (cordis-plugin-loader/src/config/group.ts:71).
 *
 * Run: node --import ./register.mjs ./race2.mjs [installer]
 */
import { Context, Service, LoggerService } from '@deepseek-ai/cordis'

const INSTALLER = process.argv[2] ?? 'workspaces'
const DSH =
  'file:///%USERPROFILE%/nodejs-x64/node-v22.21.0-win-x64/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
const TUI_LIB =
  'file:///%USERPROFILE%/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/'
const COMMANDS_MOD = DSH + 'dsh-commands/lib/index.js'
const INSTALLER_MOD = TUI_LIB + (INSTALLER === 'workspaces' ? 'workspaces.js' : 'dsh-adapter/dialogs.js')
const DIALOGS_MOD = TUI_LIB + 'dsh-adapter/dialogs.js'
const HOST_ACCESS = TUI_LIB + 'dsh-adapter/host-access.js'
const REDACT = 'file:///%USERPROFILE%/dsh-plugin-redact/index.js'

const redact = await import(REDACT)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class FakeCommands extends Service {
  constructor(ctx) {
    super(ctx, 'commands')
  }
  register(def) {
    this.def = def
    return () => {}
  }
}

function makeSession(n) {
  const events = new Map()
  const nodes = []
  let seq = 0
  for (let i = 0; i < n; i++) {
    const callId = 'c' + seq
    events.set(seq, { type: 'tool/call', data: { callId, name: 'Bash' } })
    seq++
    events.set(seq, {
      type: 'tool/result',
      data: { message: { role: 'user', source: { callId }, content: [{ type: 'text', text: 'X'.repeat(2000) }] } },
    })
    nodes.push(seq)
    seq++
  }
  return {
    id: 'synthetic-race',
    seq: seq - 1,
    eventAt: (i) => events.get(i),
    surface: { nodes: new Set(nodes) },
    append: () => ({ seq: seq++ }),
  }
}

const t0 = Date.now()
const marks = {}
const warns = []
const originalWarn = LoggerService.prototype.warn
LoggerService.prototype.warn = function (...args) {
  warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  return originalWarn.apply(this, args)
}

const root = new Context()
let redactCtx
const commandsRow = {
  id: 'commands',
  apply: async (ctx) => {
    await import(COMMANDS_MOD)
    marks.commandsImported = Date.now() - t0
    ctx.plugin(FakeCommands)
    marks.commandsProvided = Date.now() - t0
  },
}
const installerRow = {
  id: 'dsh-tui-workspaces',
  apply: async (ctx) => {
    const mod = await import(INSTALLER_MOD)
    marks.installerImported = Date.now() - t0
    ctx.plugin(mod.default ?? mod)
    marks.trackerRowStarted = Date.now() - t0
  },
}
const redactRow = {
  id: 'dsh-redact',
  inject: process.env.RACE_FIX === '1' ? ['commands', 'tuiDialogs'] : redact.inject,
  apply: (ctx, config) => {
    marks.redactApplying = Date.now() - t0
    redactCtx = ctx
    return redact.apply(ctx, config)
  },
}
// The dsh-tui-extensions row (mounted after workspaces in the real bundle).
const dialogsRow = {
  id: 'dsh-tui-extensions',
  apply: async (ctx) => {
    const mod = await import(DIALOGS_MOD)
    marks.dialogsImported = Date.now() - t0
    ctx.plugin(mod.default)
  },
}

const settle = (f) => (typeof f?.await === 'function' ? f.await() : Promise.resolve(f))
const f1 = root.plugin(commandsRow)
const f2 = root.plugin(installerRow)
const f2b = root.plugin(dialogsRow)
const f3 = root.plugin(redactRow, { root: 'C:/nonexistent', cacheRoot: 'C:/nonexistent' })
await Promise.all([settle(f1), settle(f2), settle(f2b), settle(f3)])
marks.allActive = Date.now() - t0

// Is the redact row admitted to the dsh-tui host guards?
let trusted = null
try {
  const hostAccess = await import(HOST_ACCESS)
  trusted = hostAccess.bindCallerEffect(redactCtx, () => {}, () => {})
} catch (e) {
  trusted = 'THREW ' + e.message
}

const { getHostDialogStore } = await import(DIALOGS_MOD)
const store = getHostDialogStore(root.get('tuiDialogs'))
const def = root.get('commands')?.def
let sawDialog = false
let result = null
if (def !== undefined && store !== undefined) {
  const promise = Promise.resolve(def.handler({ rawInput: 'pick', agent: { session: makeSession(3) } }))
  const deadline = Date.now() + 600
  while (Date.now() < deadline) {
    if (store.getSnapshot() !== null) {
      sawDialog = true
      store.cancel(store.getSnapshot().key)
      break
    }
    await sleep(4)
  }
  result = (await promise).text
}

console.log(
  JSON.stringify({
    installer: INSTALLER,
    marks,
    trusted,
    sawDialog,
    result,
    warn: warns.find((w) => w.includes('tuiDialogs')) ?? null,
  }),
)

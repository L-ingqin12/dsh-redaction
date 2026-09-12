/**
 * Does the redact row activate (and get admitted to the dsh-tui host guards)
 * before ANY dsh-tui adapter module installs the composition-root tracker?
 *
 * It recreates the boot shape of the real profile as closely as a standalone
 * process can:
 *   layer 1 (dsh-base):  the `commands` row  — cold import of the real package
 *   layer 2 (dsh-tui):   the extensions row  — cold import of the real module
 *   layer 3 (redact):    the real plugin row, `inject: ['commands']`
 * All three are created in ONE synchronous batch, exactly like the Loader's
 * group.create() (cordis-plugin-loader/src/config/group.ts:71).
 *
 * Run: node --import ./register.mjs ./race.mjs [runs] [dialogs|extensions]
 */
import { Context, Service, LoggerService } from '@deepseek-ai/cordis'

const ARGS = process.argv.slice(2)
const RUNS = Number(ARGS[0] ?? 5)
const INSTALLER = ARGS[1] ?? 'dialogs'

const DSH =
  'file:///' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/nodejs-x64/node-v22.21.0-win-x64/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
const TUI_LIB =
  'file:///' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/'
const COMMANDS_MOD = DSH + 'dsh-commands/lib/index.js'
const INSTALLER_MOD = INSTALLER === 'extensions' ? TUI_LIB + 'extensions.js' : TUI_LIB + 'dsh-adapter/dialogs.js'
const DIALOGS_MOD = TUI_LIB + 'dsh-adapter/dialogs.js'
const REDACT = 'file:///' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/dsh-plugin-redact/index.js'

// Only the tiny local plugin is pre-imported; the dsh-tui adapter module must
// stay COLD so its import cost is the real one.
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

const { getHostDialogStore } = await import(DIALOGS_MOD) // cached later; same URL

const outcomes = []
for (let run = 0; run < RUNS; run++) {
  const t0 = Date.now()
  const marks = {}
  const warns = []
  const originalWarn = LoggerService.prototype.warn
  LoggerService.prototype.warn = function (...args) {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    return originalWarn.apply(this, args)
  }

  const root = new Context()
  const commandsRow = {
    id: 'commands',
    name: 'commands',
    apply: async (ctx) => {
      await import(COMMANDS_MOD)
      marks.commandsImported = Date.now() - t0
      ctx.plugin(FakeCommands)
    },
  }
  const installerRow = {
    id: 'dsh-tui-extensions',
    name: 'dsh-tui-extensions',
    apply: async (ctx) => {
      const mod = await import(INSTALLER_MOD)
      marks.installerImported = Date.now() - t0
      if (process.env.RACE_NOSLEEP !== '1') await sleep(0)
      marks.installerStarted = Date.now() - t0
      ctx.plugin(mod.default ?? mod)
    },
  }
  const redactRow = { id: 'dsh-redact', name: 'dsh-redact', inject: redact.inject, apply: redact.apply }

  const installerFirst = process.env.RACE_INSTALLER_FIRST === '1'
  const first = installerFirst ? installerRow : commandsRow
  const second = installerFirst ? commandsRow : installerRow
  const f1 = root.plugin(first)
  const f2 = root.plugin(second)
  const f3 = root.plugin(redactRow, { root: 'C:/nonexistent', cacheRoot: 'C:/nonexistent' })
  const settle = (f) => (typeof f?.await === 'function' ? f.await() : Promise.resolve(f))
  await Promise.all([settle(f1), settle(f2), settle(f3)])
  marks.allActive = Date.now() - t0

  const commands = root.get('commands')
  const def = commands?.def
  const store = getHostDialogStore(root.get('tuiDialogs'))
  marks.sawService = root.get('tuiDialogs') !== undefined

  let sawDialog = false
  let result = null
  if (def !== undefined && store !== undefined) {
    const promise = Promise.resolve(def.handler({ rawInput: 'pick', agent: { session: makeSession(3) } }))
    const deadline = Date.now() + 400
    while (Date.now() < deadline) {
      if (store.getSnapshot() !== null) {
        sawDialog = true
        store.cancel(store.getSnapshot().key)
        break
      }
      await sleep(5)
    }
    result = (await promise).text
  }
  LoggerService.prototype.warn = originalWarn
  outcomes.push({
    run,
    marks,
    sawDialog,
    result,
    warn: warns.find((w) => w.includes('tuiDialogs')) ?? null,
  })
}

const saw = outcomes.filter((o) => o.sawDialog).length
console.log('installer=' + INSTALLER)
console.log(JSON.stringify(outcomes, null, 1))
console.log(`dialogs shown: ${saw}/${RUNS}`)

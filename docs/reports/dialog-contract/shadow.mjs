/**
 * The ONE throw path in TuiDialogRuntime: assertCapabilityShadowPolicy() is
 * called BEFORE the try/catch (dialogs.js:217, 251). Run this with and without
 * DSH_TUI_ADAPTER_MODE to see the difference.
 */
import { Context, Service } from '@deepseek-ai/cordis'

const TUI_LIB =
  'file:///%USERPROFILE%/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/'
const dialogsMod = await import(TUI_LIB + 'dsh-adapter/dialogs.js')
const TuiDialogRuntime = dialogsMod.default

const root = new Context()
let CALLER
await root.plugin({
  name: 'svc-row',
  apply: (ctx) => void ctx.plugin(TuiDialogRuntime),
}).await()
await root.plugin({
  name: 'caller-row',
  apply: (ctx) => {
    CALLER = ctx
  },
}).await()

const out = { env: process.env.DSH_TUI_ADAPTER_MODE ?? null }
for (const [name, call] of [
  ['select', () => CALLER.get('tuiDialogs').select({ title: 'T', options: [{ id: '1', label: 'L' }], timeoutMs: 200 })],
  ['confirm', () => CALLER.get('tuiDialogs').confirm({ title: 'T', timeoutMs: 200 })],
  ['input', () => CALLER.get('tuiDialogs').input({ title: 'T', timeoutMs: 200 })],
]) {
  try {
    const value = await call()
    out[name] = { kind: 'resolved', value }
  } catch (e) {
    out[name] = { kind: 'THREW', sync: true, message: e.message }
  }
}
console.log(JSON.stringify(out))

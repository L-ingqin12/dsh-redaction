// Probe 1: can we import the REAL dialogs.js module (and therefore the real
// TuiDialogStore / TuiDialogRuntime) from outside the TUI package?
const url = 'file:///' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/dialogs.js'
try {
  const mod = await import(url)
  console.log('IMPORT OK')
  console.log('exports:', Object.keys(mod).join(', '))
  console.log('DIALOG_DEFAULT_TIMEOUT_MS =', mod.DIALOG_DEFAULT_TIMEOUT_MS)
  console.log('getHostDialogStore typeof =', typeof mod.getHostDialogStore)
  console.log('TuiDialogStore typeof =', typeof mod.TuiDialogStore)
  console.log('TuiDialogRuntime typeof =', typeof mod.TuiDialogRuntime)
} catch (err) {
  console.log('IMPORT FAILED:', err.code || '', err.message)
  console.log((err.stack || '').split('\n').slice(0, 6).join('\n'))
}

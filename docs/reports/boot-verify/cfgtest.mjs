// Throwaway: force-test BOTH branches of dsh-plugin-content-policy's Config export.
// Branch is selected by whether the bare specifier '@deepseek-ai/schemastery'
// resolves from the COPY's own real path (Node resolves realpath by default).
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const which = process.argv[2] // 'a' or 'b'

const mod = await import(pathToFileURL(path.join(HERE, which, 'dsh-plugin-content-policy', 'index.js')).href)
const C = mod.Config

const branch = C['~standard']?.vendor === 'dsh-plugin-content-policy' ? 'FALLBACK (built-in Standard Schema)' : 'REAL Schemastery'

// Which bare specifier resolution did the copy see?
let schemaReach
try {
  await import(pathToFileURL(path.join(HERE, which, 'probe-schemastery-resolve.mjs')).href)
  schemaReach = 'unexpected'
} catch { schemaReach = 'n/a' }

const validate = (input) => {
  try {
    const r = C['~standard'].validate(input)
    if ('then' in r) return { async: true }
    if (r.issues) return { issues: r.issues.map((i) => `${i.message}${i.path ? ` @${i.path.join('.')}` : ''}`) }
    return { value: r.value }
  } catch (e) {
    return { threw: `${e.name}: ${e.message}` }
  }
}

const CASES = [
  ['undefined', undefined],
  ['{}', {}],
  ['LIVE profile config {enabled:true,rules:[]}', { enabled: true, rules: [] }],
  ['{maxScannedBytes: Infinity}', { maxScannedBytes: Infinity }],
  ['{maxScannedBytes: 0}', { maxScannedBytes: 0 }],
  ['{maxScannedBytes: 1.5}', { maxScannedBytes: 1.5 }],
  ['{onBudgetExceeded:"nope"}', { onBudgetExceeded: 'nope' }],
  ['{enabled:"yes"}', { enabled: 'yes' }],
  ['{rules:[{id:"r",match:"x"}]}', { rules: [{ id: 'r', match: 'x' }] }],
  ['{rules:[{match:"x"}]}', { rules: [{ match: 'x' }] }],
  ['{rules:"notarray"}', { rules: 'notarray' }],
  ['{strip:[{id:"s",path:"content"}]}', { strip: [{ id: 's', path: 'content' }] }],
  ['{strip:[{id:"s",maxChars:10}]}', { strip: [{ id: 's', maxChars: 10 }] }],
  ['{stripDefaults:true,strip:[]}', { stripDefaults: true, strip: [] }],
  ['{onStripRefused:"skip"}', { onStripRefused: 'skip' }],
  ['{onStripRefused:"boom"}', { onStripRefused: 'boom' }],
  ['{bogus:1}', { bogus: 1 }],
  ['null', null],
  ['[]', []],
  ['"str"', 'str'],
  // --- revision 0.2.0 additions ---
  ['{strip:"notarray"}', { strip: 'notarray' }],
  ['{strip:{}}', { strip: {} }],
  ['{stripDefaults:"yes"}', { stripDefaults: 'yes' }],
  ['{stripDefaults:undefined}', { stripDefaults: undefined }],
  ['{onStripRefused:undefined}', { onStripRefused: undefined }],
  ['{strip:[{id:"s",path:"sources.*.snippet",maxChars:40}]}', { strip: [{ id: 's', path: 'sources.*.snippet', maxChars: 40 }] }],
  ['{strip:[{id:"s",path:"content",maxChars:1.5}]}', { strip: [{ id: 's', path: 'content', maxChars: 1.5 }] }],
  ['{strip:[{id:"s",path:"content",maxChars:0}]}', { strip: [{ id: 's', path: 'content', maxChars: 0 }] }],
  ['{stripDefaults:true,strip:[{id:"s",path:"content"}]}', { stripDefaults: true, strip: [{ id: 's', path: 'content' }] }],
]

console.log(`### branch=${which} -> ${branch}`)
for (const [label, input] of CASES) {
  const r = validate(input)
  console.log(`\n-- ${label}`)
  if (r.value !== undefined) {
    console.log('   VALUE:', JSON.stringify(r.value))
  } else if (r.issues) {
    console.log('   ISSUES:', r.issues.join(' | '))
  } else {
    console.log('   ', JSON.stringify(r))
  }
}
console.log('\n### module-level exports:', Object.keys(mod).sort().join(','))

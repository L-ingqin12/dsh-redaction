// Throwaway: order-insensitive divergence table between the REAL-Schemastery branch
// and the FALLBACK branch (the one production actually uses) of dsh-plugin-content-policy 0.2.0.
import fs from 'node:fs'

const parse = (file) => {
  const out = new Map()
  let cur = null
  for (const line of fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n')) {
    const m = /^-- (.+)$/.exec(line)
    if (m) { cur = m[1]; out.set(cur, { value: undefined, issues: undefined, threw: undefined }); continue }
    if (cur === null) continue
    const v = /^   VALUE: (.*)$/.exec(line)
    const i = /^   ISSUES: (.*)$/.exec(line)
    const t = /^    \{"threw":(.*)\}$/.exec(line)
    if (v) out.get(cur).value = v[1]
    else if (i) out.get(cur).issues = i[1]
    else if (t) out.get(cur).threw = t[1]
  }
  return out
}

const A = parse(process.argv[2])
const B = parse(process.argv[3])
const kind = (s) => (s.threw !== undefined ? 'THREW' : s.issues !== undefined ? 'ISSUES' : 'VALUE')
const val = (s) => { try { return JSON.parse(s.value) } catch { return s.value } }

// Structural deep comparison that ignores key insertion order.
const deepDiff = (a, b, path = '') => {
  const diffs = []
  if (a === b) return diffs
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b
  if (ta !== tb) return [`${path || '$'}: type ${ta} vs ${tb}`]
  if (ta === 'array') {
    if (a.length !== b.length) return [`${path || '$'}: length ${a.length} vs ${b.length}`]
    for (let i = 0; i < a.length; i += 1) diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`))
    return diffs
  }
  if (ta === 'object') {
    const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort()
    if (ka.join(',') !== kb.join(',')) diffs.push(`${path || '$'}: key set [${ka}] vs [${kb}]`)
    for (const k of ka) if (kb.includes(k)) diffs.push(...deepDiff(a[k], b[k], `${path}.${k}`))
    return diffs
  }
  return [`${path || '$'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`]
}

const lines = []
let identical = 0; let bothReject = 0; let realDiff = 0; let threw = 0; let structural = 0
for (const [label, a] of A) {
  const b = B.get(label)
  const ka = kind(a); const kb = kind(b)
  if (a.threw || b.threw) { threw += 1; lines.push(`THREW        ${label}  A=${a.threw} B=${b.threw}`); continue }
  if (ka !== kb) { structural += 1; lines.push(`STRUCTURAL   ${label}  A:${ka} B:${kb}`); continue }
  if (ka === 'ISSUES') { bothReject += 1; continue }
  const d = deepDiff(val(a), val(b))
  if (d.length === 0) { identical += 1; continue }
  realDiff += 1
  lines.push(`DIFF         ${label}\n               - ${d.join('\n               - ')}`)
}

const report = [
  `cases compared                 : ${A.size}`,
  `identical (order-insensitive)  : ${identical}`,
  `both reject (wording differs)  : ${bothReject}`,
  `STRUCTURAL (accept vs reject)  : ${structural}`,
  `THREW in either branch         : ${threw}`,
  `value/shape DIFFERENCES        : ${realDiff}`,
  '',
  '--- detail ---',
  ...(lines.length ? lines : ['(none)']),
  '',
  '--- production (fallback) defaults for the whole config ---',
  JSON.stringify(val(B.get('undefined')), null, 1),
  '',
  '--- new 0.2.0 fields, fallback branch ---',
  ...['strip', 'stripDefaults', 'onStripRefused'].map((k) => {
    let seen = 0; let missing = 0; const vals = new Set()
    for (const [, s] of B) {
      if (kind(s) !== 'VALUE') continue
      const o = val(s)
      seen += 1
      if (!(k in o)) missing += 1; else vals.add(JSON.stringify(o[k]))
    }
    return `${k.padEnd(16)} present in ${seen - missing}/${seen} accepted configs; observed=${[...vals].join(' | ')}`
  }),
  '',
  '--- non-array rules / strip in the fallback branch ---',
  ...['{rules:"notarray"}', '{strip:"notarray"}', '{strip:{}}'].map((c) => {
    const s = B.get(c)
    return `${c.padEnd(22)} -> ${kind(s)}${s.threw ? ' ' + s.threw : ' :: ' + (s.issues ?? '')}`
  }),
].join('\n')

fs.writeFileSync(process.argv[4], report)
console.log(report)

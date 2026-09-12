// Throwaway read-only scan: would healProfilesModuleFallback's ensureSymlink() throw on the
// CURRENT state of $DSH_HOME/profiles/node_modules ?  (throw condition: an entry that exists,
// is NOT a symlink/junction, and is not a dsh-managed module proxy)
import fs from 'node:fs'
import path from 'node:path'

const root = '%USERPROFILE%\\.dsh\\profiles\\node_modules'
let real = []
let links = []
let broken = []
let scopedReal = []

const check = (full, name) => {
  const st = fs.lstatSync(full)
  if (!st.isSymbolicLink()) return { name, kind: st.isDirectory() ? 'REAL-DIR' : 'REAL-FILE' }
  let target = null
  try { target = fs.readlinkSync(full) } catch {}
  let resolves = false
  try { resolves = fs.existsSync(fs.realpathSync(full)) } catch {}
  return { name, kind: 'LINK', target, resolves }
}

for (const e of fs.readdirSync(root, { withFileTypes: true })) {
  const full = path.join(root, e.name)
  if (e.name.startsWith('@')) {
    if (!fs.lstatSync(full).isSymbolicLink()) {
      for (const c of fs.readdirSync(full, { withFileTypes: true })) {
        const r = check(path.join(full, c.name), `${e.name}/${c.name}`)
        if (r.kind === 'LINK') { links.push(r); if (!r.resolves) broken.push(r) } else { real.push(r); scopedReal.push(r) }
      }
    } else {
      const r = check(full, e.name)
      links.push(r); if (!r.resolves) broken.push(r)
    }
    continue
  }
  const r = check(full, e.name)
  if (r.kind === 'LINK') { links.push(r); if (!r.resolves) broken.push(r) } else real.push(r)
}

console.log('root               =', root)
console.log('total entries      =', links.length + real.length)
console.log('symlinks/junctions =', links.length)
console.log('NON-symlink entries=', real.length, real.length ? '  <-- ensureSymlink() WOULD THROW for install-closure names' : '')
for (const r of real) console.log('   ', r.kind, r.name)
console.log('broken links       =', broken.length)
for (const r of broken) console.log('   ', r.name, '->', r.target)

// The same check for the two plugin links inside the profile itself
const prof = '%USERPROFILE%\\.dsh\\profiles\\dsh-tui\\node_modules'
for (const n of ['dsh-plugin-redact', 'dsh-plugin-content-policy']) {
  const full = path.join(prof, n)
  const st = fs.lstatSync(full)
  const target = fs.readlinkSync(full)
  console.log(`profile/${n}: isSymlink=${st.isSymbolicLink()} target=${target} resolves=${fs.existsSync(fs.realpathSync(full))}`)
}

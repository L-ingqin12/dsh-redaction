import fs from "node:fs"
const mod = await import("file:///%USERPROFILE%/dsh-plugin-redact/index.js")
const orig = fs.writeSync
let seen = 0
fs.writeSync = (...a) => { seen++; return orig(...a) }
const os = await import("node:os"); const path = await import("node:path")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "patch-"))
fs.writeFileSync(path.join(root, "x"), "hello")
fs.writeSync(fs.openSync(path.join(root, "x"), "r+"), Buffer.from("zz"), 0, 2, 0)
fs.writeSync = orig
console.log("patch works, intercepted:", seen)
fs.rmSync(root, { recursive: true, force: true })

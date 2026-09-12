// Cold-import cost of one module, in a fresh process: the deciding factor for
// the row-activation race. Usage: node --import ./register.mjs ./timing.mjs <spec>
const spec = process.argv[2]
const t0 = Date.now()
await import(spec)
console.log(Date.now() - t0)

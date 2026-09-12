// Maps the bare peer dependency `@deepseek-ai/cordis` onto the copy the dsh CLI
// actually provides at runtime, so the REAL dsh-tui files can be imported
// in place (nothing is copied or modified).
const CORDIS =
  'file:///' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/nodejs-x64/node-v22.21.0-win-x64/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/cordis') {
    return { url: CORDIS, shortCircuit: true, format: 'module' }
  }
  return nextResolve(specifier, context)
}

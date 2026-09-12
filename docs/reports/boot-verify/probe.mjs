// Throwaway boot-safety probe. Mirrors the real `dsh` profile boot path:
//   boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl)
// with NO bareModuleBaseUrl, exactly like profile-boot.js does.
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const DSHDIR = '%USERPROFILE%/nodejs-x64/node-v22.21.0-win-x64/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const appBoot = await import(pathToFileURL(`${DSHDIR}/dsh-app-boot/lib/index.js`).href)
const { boot, loadOptionalPatches } = appBoot

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, 'root.yml')
const scenario = process.argv[2] ?? 'real'
const TIMEOUT_MS = Number(process.argv[3] ?? 8000)

const seen = { commands: [], defs: {}, configs: {} }

const prepare = (ctx) => {
  ctx.provide('tools', {
    get: () => undefined,
    list: () => [],
  })
  // `rowInjectAdditive` deliberately withholds `commands` to discriminate
  // "row inject augments the plugin's static inject" from "row inject replaces it".
  if (scenario !== 'rowInjectAdditive') {
    ctx.provide('commands', {
      register: (def) => {
        seen.commands.push(def?.name)
        if (def?.name !== undefined) seen.defs[def.name] = def
        return () => {}
      },
    })
  }
}

const redactPatch = loadOptionalPatches('dsh', '%USERPROFILE%/dsh-plugin-redact/cordis.patch.yml') ?? []
const policyPatch = loadOptionalPatches('dsh', '%USERPROFILE%/dsh-plugin-content-policy/cordis.patch.yml') ?? []
const spillPatch = [{ id: 'spill-policy', config: { maxInlineBytes: 4000 } }]

// The row-level inject now living in the REAL profile patch layer.
const PROFILE_PATCH = '%USERPROFILE%/.dsh/profiles/dsh-tui/cordis.patch.yml'
const profilePatches = loadOptionalPatches('dsh', PROFILE_PATCH) ?? []
const redactRowPatch = profilePatches.filter((p) => p.id === 'dsh-redact')
if (redactRowPatch.length !== 1) throw new Error(`expected exactly one dsh-redact patch, got ${redactRowPatch.length}`)

const ins = (row) => [{ insert: [row] }]

const SCENARIOS = {
  // 1. both REAL rows, real configs (incl. the !!js dshHomePath expressions)
  real: [...redactPatch, ...policyPatch, ...spillPatch],
  // 2. real rows + a local echo row that reports its resolved config
  realEcho: [
    ...redactPatch,
    ...policyPatch,
    ...ins({ id: 'x-echo', name: './fix-echo.mjs', config: { fromJs: { __jsExpr: "dshHomePath('sessions')" }, plain: 42 } }),
  ],
  // 3. module throws during import()
  throwImport: ins({ id: 'x-throw-import', name: './fix-throw-import.mjs' }),
  // 4. apply() throws
  throwApply: ins({ id: 'x-throw-apply', name: './fix-throw-apply.mjs' }),
  // 5. top-level await that never settles
  hang: ins({ id: 'x-hang', name: './fix-hang.mjs' }),
  // 6. bare specifier that cannot be resolved
  missing: ins({ id: 'x-missing', name: 'dsh-plugin-does-not-exist-xyz' }),
  // 7. injects a service that is never provided
  pending: ins({ id: 'x-pending', name: './fix-pending.mjs' }),
  // 8. content-policy with a config the exported schema should reject
  badConfig: [...ins({ id: 'dsh-content-policy', name: 'dsh-plugin-content-policy', config: { enabled: 'yes', rules: [] } })],
  // 9. content-policy with rules whose maxScannedBytes is invalid -> apply() throws
  badApply: [
    ...ins({
      id: 'dsh-content-policy',
      name: 'dsh-plugin-content-policy',
      config: { enabled: true, maxScannedBytes: 0, rules: [{ id: 'r', match: 'x', action: 'replace' }] },
    }),
  ],
  // 10. content-policy with a duplicate rule id -> compileRules should report a problem
  dupRules: [
    ...ins({
      id: 'dsh-content-policy',
      name: 'dsh-plugin-content-policy',
      config: { enabled: true, rules: [{ id: 'r', match: 'x' }, { id: 'r', match: 'y' }] },
    }),
  ],
  // 11. redact row with a config that has the wrong shape (root as a number)
  redactBadShape: [...ins({ id: 'dsh-redact', name: 'dsh-plugin-redact', config: { root: 12345, placeholder: 7, cacheRoot: null } })],
  // 12. real redact row with NO tuiDialogs service in the tree at all
  dialogsAbsent: [...redactPatch],
  // 13. tuiDialogs row mounted BEFORE the redact row
  dialogsBefore: [...ins({ id: 'x-dialogs', name: './fix-dialogs.mjs' }), ...redactPatch],
  // 14. tuiDialogs row mounted AFTER the redact row
  dialogsAfter: [...redactPatch, ...ins({ id: 'x-dialogs', name: './fix-dialogs.mjs' })],
  // 15. redact config shape boundaries (apply() self-validates now)
  redactNoConfig: [...ins({ id: 'dsh-redact', name: 'dsh-plugin-redact' })],
  redactNullConfig: [...ins({ id: 'dsh-redact', name: 'dsh-plugin-redact', config: null })],
  redactEmptyConfig: [...ins({ id: 'dsh-redact', name: 'dsh-plugin-redact', config: {} })],
  redactPartialConfig: [...ins({ id: 'dsh-redact', name: 'dsh-plugin-redact', config: { placeholder: '[X]' } })],
  redactUnknownKey: [...ins({ id: 'dsh-redact', name: 'dsh-plugin-redact', config: { bogus: 1 } })],
  redactEmptyStringRoot: [...ins({ id: 'dsh-redact', name: 'dsh-plugin-redact', config: { root: '' } })],
  redactNullPlaceholder: [...ins({ id: 'dsh-redact', name: 'dsh-plugin-redact', config: { placeholder: null } })],

  // --- 3rd round: row-level inject from the REAL profile patch layer ---
  // 16. real rows + the real profile patch (row inject: [commands, tuiDialogs]) + a dialogs provider
  realProfilePatch: [
    ...redactPatch,
    ...policyPatch,
    ...ins({ id: 'x-dialogs', name: './fix-dialogs.mjs' }),
    ...redactRowPatch,
  ],
  // 17. same, but NO tuiDialogs provider anywhere in the tree
  profilePatchNoDialogs: [...redactPatch, ...redactRowPatch],
  // 18. same, but the provider only supplies tuiDialogs AFTER a 300ms async apply
  profilePatchLateDialogs: [
    ...redactPatch,
    ...ins({ id: 'x-late-dialogs', name: './fix-late-dialogs.mjs' }),
    ...redactRowPatch,
  ],
  // 19. additive check: row inject lists ONLY tuiDialogs, so `commands` comes from the
  //     module's own static inject. If row-level inject were a REPLACE, this would activate.
  rowInjectAdditive: [
    ...redactPatch,
    { id: 'dsh-redact', inject: ['tuiDialogs'] },
    ...ins({ id: 'x-dialogs', name: './fix-dialogs.mjs' }),
  ],
  // 20-22. self-disable guard: keep the inject but let the row opt out when the
  //        provider row is missing (same !!js idiom as the shipped agent-presets row).
  guardNoProvider: [
    ...redactPatch,
    ...ins({ id: 'x-dialogs', name: './fix-dialogs.mjs' }),
    { id: 'x-dialogs', disabled: true },
    {
      id: 'dsh-redact',
      inject: ['commands', 'tuiDialogs'],
      disabled: { __jsExpr: "![...ctx.loader.entries()].some(e => e.options.name === './fix-dialogs.mjs' && !e.disabled)" },
    },
  ],
  guardProviderBefore: [
    ...redactPatch,
    ...ins({ id: 'x-dialogs', name: './fix-dialogs.mjs' }),
    {
      id: 'dsh-redact',
      inject: ['commands', 'tuiDialogs'],
      disabled: { __jsExpr: "![...ctx.loader.entries()].some(e => e.options.name === './fix-dialogs.mjs' && !e.disabled)" },
    },
  ],
  guardProviderAfter: [
    ...ins({ id: 'x-dialogs', name: './fix-dialogs.mjs' }),
    ...redactPatch,
    {
      id: 'dsh-redact',
      inject: ['commands', 'tuiDialogs'],
      disabled: { __jsExpr: "![...ctx.loader.entries()].some(e => e.options.name === './fix-dialogs.mjs' && !e.disabled)" },
    },
  ],
}

const patches = scenario === 'redactCfgFile'
  ? [...ins({ id: 'dsh-redact', name: 'dsh-plugin-redact', config: JSON.parse(readFileSync(path.join(HERE, 'cfgcase.json'), 'utf8')) })]
  : SCENARIOS[scenario]
if (patches === undefined) throw new Error(`unknown scenario ${scenario}`)

const started = Date.now()
let ctx
try {
  ctx = await Promise.race([
    boot('dsh', ROOT, patches, prepare),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`__HANG__ after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
  ])
  const entries = [...ctx.loader.entries()].map((e) => ({
    id: e.options.id,
    name: e.options.name,
    state: e.fiber?.state,
    disabled: e.disabled,
  }))
  console.log(JSON.stringify({
    scenario,
    outcome: 'BOOT_OK',
    ms: Date.now() - started,
    commandsRegistered: seen.commands,
    entries,
  }, null, 0))
  if (scenario === 'realEcho') {
    console.log('echo file:', path.join(HERE, 'echo.json'))
  }
  if (scenario.startsWith('dialogs') || scenario.startsWith('profilePatch') || scenario.startsWith('realProfilePatch')) {
    // Drive redact's REAL captured handler down its `pick` branch (the soft-probe site).
    const def = seen.defs['redact']
    const session = { id: 's1', seq: -1, surface: { nodes: [] }, eventAt: () => undefined }
    let res
    try {
      res = await def.handler({ rawInput: 'pick', agent: { session } })
    } catch (error) {
      res = { THREW: `${error.name}: ${error.message}` }
    }
    console.log('  pick-branch ->', JSON.stringify(res))
    let rootGet
    try {
      rootGet = typeof ctx.get('tuiDialogs')
    } catch (error) {
      rootGet = `THREW ${error.message}`
    }
    console.log('  ctx.get("tuiDialogs") seen from the ROOT ctx ->', rootGet)
  }
  await ctx.fiber.dispose()
  process.exit(0)
} catch (error) {
  const hang = String(error?.message ?? error).startsWith('__HANG__')
  console.log(JSON.stringify({
    scenario,
    outcome: hang ? 'BOOT_NEVER_SETTLED' : 'BOOT_ABORTED',
    ms: Date.now() - started,
    errorName: error?.name,
    message: String(error?.message ?? error).slice(0, 1200),
    cause: String(error?.cause?.message ?? '').slice(0, 600),
  }, null, 0))
  process.exit(hang ? 3 : 2)
}

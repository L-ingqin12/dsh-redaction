/**
 * The stable, versioned configuration schema of the redaction policy engine.
 *
 * Every field is optional and carries a schema-level default, so:
 *   - the bundle patch can insert the row with an empty `config:` and it mounts;
 *   - a YAML patch that replaces the row's `config` need only restate the
 *     fields it changes (a patch replaces the whole object, so the defaults are
 *     what keep a partial override coherent);
 *   - `Config.toJSON()` is the schema envelope a settings UI renders, which is
 *     what lets the same document be edited in YAML or in a form.
 *
 * Schema-version discipline: `schemaVersion` is the policy document's own
 * version, independent of the package version and of the DSH format version.
 * Bump it only for a breaking change to the shape below.
 *
 * @module @yourorg/dsh-redaction/config
 */
import z from '@deepseek-ai/schemastery'

/** Enforcement posture for the whole engine. */
export const MODES = ['enforce', 'dry-run', 'off']
/** What to do when the engine itself fails while scanning. */
export const ON_ERROR = ['fail-closed', 'fail-open']
/** Per-rule action. */
export const ACTIONS = ['redact', 'mask', 'hash', 'tokenize', 'drop', 'deny']
/** How much of a match to keep. */
export const AUDIT_LEVELS = ['full', 'metadata', 'none']

/**
 * One detector. `kind` selects the engine; the remaining keys are
 * kind-specific and validated in `apply()` (compiling a RegExp is not
 * expressible in Schemastery, and a bad pattern must fail the mount loudly
 * rather than silently disable a rule).
 */
export const Detector = z.intersect([
  z.object({
    /** Stable identifier referenced by `rules[].when.detectors` and by the ledger. */
    id: z.string().required(),
    /** Detection engine. */
    kind: z.union(['regex', 'entropy', 'builtin']).required(),
    /** Human-readable purpose, surfaced in the ledger and in diagnostics. */
    description: z.string().default(''),
    /** detector-specific confidence tag carried into the ledger. */
    confidence: z.union(['low', 'medium', 'high']).default('medium'),
  }),
  z.union([
    z.object({
      kind: z.const('regex'),
      /** JavaScript regular expression source. Compiled once at mount. */
      pattern: z.string().required(),
      /** RegExp flags; `g` is implied and added if absent. */
      flags: z.string().default('g'),
    }),
    z.object({
      kind: z.const('builtin'),
      /** One of the shipped detectors, e.g. `private-key-pem`, `jwt`, `credit-card`. */
      name: z.string().required(),
    }),
    z.object({
      kind: z.const('entropy'),
      /** Shannon bits per character above which a run is treated as a secret. */
      minBitsPerChar: z.number().default(3.5),
      /** Minimum run length, in characters. */
      minLength: z.number().default(20),
      /** Character classes that form a run. */
      alphabet: z.union(['base64', 'hex', 'alnum']).default('base64'),
    }),
  ]),
])

/** How a matched span is rewritten. */
export const Then = z.object({
  /** `redact` replaces; `mask` keeps a prefix/suffix; `hash`/`tokenize` are stable
   * one-way substitutions; `drop` removes the whole content block; `deny` blocks
   * the call (only meaningful on the `toolArgs` surface). */
  action: z.union(ACTIONS).default('redact'),
  /**
   * Replacement template. `{detector}` and `{rule}` interpolate; `{digest}`
   * interpolates the truncated digest when the action is `hash`/`tokenize`.
   * Must not itself match any detector in the same rule set — the engine
   * verifies this at mount and refuses a self-matching template.
   */
  replacement: z.string().default('[REDACTED:{detector}]'),
  /** Characters kept verbatim before the replacement (mask only). */
  keepPrefix: z.number().default(0),
  /** Characters kept verbatim after the replacement (mask only). */
  keepSuffix: z.number().default(0),
  /** Mask character (mask only). */
  maskChar: z.string().default('*'),
  /** Denial text shown to the model (deny only). */
  reason: z.string().default('Blocked by the redaction policy.'),
})

/** Which content a rule applies to. */
export const When = z.object({
  /** Detector ids this rule reacts to; `['*']` means every registered detector. */
  detectors: z.array(z.string()).default(['*']),
  /** Tool names (exact or `fnmatch`-style `*`). Empty means every tool. */
  tools: z.array(z.string()).default([]),
  /** Agent/session labels this rule is limited to. Empty means every agent. */
  agents: z.array(z.string()).default([]),
  /** Only apply on these surfaces. Empty means every enabled surface. */
  surfaces: z.array(z.union(['userInput', 'toolResults', 'ptcLog', 'toolArgs'])).default([]),
})

/** One rule. Order matters: the first rule whose `when` matches a span owns it. */
export const Rule = z.object({
  id: z.string().required(),
  description: z.string().default(''),
  when: When.default({}),
  then: Then.default({}),
  audit: z.object({
    level: z.union(AUDIT_LEVELS).default('metadata'),
  }).default({}),
})

/**
 * Content the scanner cannot read as text. A redaction engine that silently
 * passes an image through is claiming a guarantee it cannot make, so the
 * default is an explicit, auditable decision rather than an accident.
 */
export const Media = z.object({
  images: z.union(['passthrough', 'strip', 'deny']).default('passthrough'),
  files: z.union(['passthrough', 'strip', 'deny']).default('passthrough'),
  binary: z.union(['passthrough', 'strip', 'deny']).default('strip'),
})

/** Append-only audit ledger, served by the storage-domain layer. */
export const Audit = z.object({
  enabled: z.boolean().default(true),
  /** Domain name opened through `ctx.storageDomain.open(...)`. */
  domain: z.string().default('dsh_redaction_ledger'),
  /**
   * Chain each record to its predecessor by hash. This is the property that
   * makes the control auditable rather than merely present: a row that was
   * deleted from a later patch layer leaves a visible gap.
   */
  hashChain: z.boolean().default(true),
  /**
   * Store only a keyed digest of the matched text, never the text. Default on:
   * an audit trail that quotes the secret it caught is a second copy of the
   * secret.
   */
  recordDigestOnly: z.boolean().default(true),
  /** Record match offsets and lengths (reveals shape, not content). */
  recordSpans: z.boolean().default(true),
  /** Days to retain ledger records; `0` keeps forever. */
  retentionDays: z.number().default(90),
  /** Optional directory for periodic ledger exports. */
  exportPath: z.union([z.string(), z.const(null)]).default(null),
})

/**
 * Remedial mode. Deliberately NOT a mutation of the live log: the persistence
 * service is append-only, refuses a non-contiguous batch, and never rewrites an
 * event, so a mounted plugin has no legal way to scrub history in place. The
 * supported outcomes are a redacted DERIVATIVE artifact and an offline CLI.
 */
export const Remedial = z.object({
  enabled: z.boolean().default(false),
  /** `derive` writes a new redacted session; `export` writes a redacted bundle;
   * `in-place-cli` is refused here and only available through `dsh-redact scrub`. */
  strategy: z.union(['derive', 'export']).default('derive'),
  /** Sessions to remediate; empty means "all stored sessions". */
  sessionIds: z.array(z.string()).default([]),
  /** ISO-8601 lower bound on session creation time. */
  since: z.union([z.string(), z.const(null)]).default(null),
  /** Never write unless this is explicitly false. */
  dryRun: z.boolean().default(true),
})

/** Scan budget and overflow behaviour on the hot path. */
export const Limits = z.object({
  /** Per-content scan ceiling in UTF-8 bytes; the remainder is governed by `onOverflow`. */
  maxScanBytes: z.number().default(1048576),
  /** `fail-closed` treats an over-budget content as a match and blocks it. */
  onOverflow: z.union(['fail-closed', 'fail-open', 'truncate']).default('fail-closed'),
  /** Maximum replacements applied to one content block before giving up. */
  maxReplacementsPerBlock: z.number().default(1000),
})

/** Everything the engine can say to a human or to the model. */
export const Notify = z.object({
  /** Append a short system notice to the step when a redaction happened. */
  userVisible: z.boolean().default(true),
  /** Tell the model that content was redacted (keeps it from retrying blindly). */
  modelVisible: z.boolean().default(false),
})

/** The complete plugin config, as written under a row's `config:` key. */
export const Config = z.object({
  /** Policy document version. */
  schemaVersion: z.number().default(1),
  mode: z.union(MODES).default('enforce'),
  onError: z.union(ON_ERROR).default('fail-closed'),

  surfaces: z.object({
    /** `agent/pre-step` — the last point before the accepted user batch is committed. */
    userInput: z.boolean().default(true),
    /** `tools/post-execute` — the model-facing and durable projection of a tool result. */
    toolResults: z.boolean().default(true),
    /** `tools/ptc-dispatch-log` — the durable copy of a `run_code` sub-call result. */
    ptcLog: z.boolean().default(true),
    /**
     * `tools/pre-execute` — detect only. The registry documents that arguments
     * are already logged and presented by the time this waterfall runs, so no
     * listener may rewrite them; the strongest available action is deny/ask.
     */
    toolArgs: z.boolean().default(true),
  }).default({}),

  detectors: z.array(Detector).default([]),
  rules: z.array(Rule).default([]),
  media: Media.default({}),
  audit: Audit.default({}),
  remedial: Remedial.default({}),
  limits: Limits.default({}),
  notify: Notify.default({}),
})

export default Config

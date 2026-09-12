/**
 * @yourorg/dsh-redaction — a rule-driven redaction policy engine.
 *
 * ## What this plugin is
 *
 * A HOST-plane policy row. It registers NO Cordis service, owns NO storage
 * mechanic, and renders NO UI: it compiles a rule set from its row config,
 * subscribes to the four content surfaces the harness actually exposes, and
 * decides what each surface may pass through. Everything durable is delegated
 * (`ctx.storageDomain` for the ledger, `ctx.settings` for a runtime-editable
 * layer), and everything visible is delegated too.
 *
 * ## Why a bundle row and not an agent preset
 *
 * A redaction policy must cover EVERY session in the process, including
 * subagents and sessions created later. An agent preset is per-session, so a
 * preset-hosted policy would (a) need an `isolate` realm for the ledger
 * service it does not even provide, and (b) be omissible by exactly the agent
 * it is meant to constrain. The host composition is the plane whose reach
 * matches the guarantee.
 *
 * ## The interception map (this is the whole design)
 *
 *   surface          hook                          may rewrite?
 *   ---------------- ----------------------------- -------------------------
 *   user input       agent/pre-step (waterfall)   YES — replace `messages`
 *   tool result      tools/post-execute (waterfall) YES — replace `content`
 *   ptc durable log  tools/ptc-dispatch-log (wf)   YES — replace blocks
 *   tool arguments   tools/pre-execute (waterfall) NO — deny/ask only
 *   model request    llm/stream (waterfall)        NO — deep-frozen,
 *                                                  "read it, never rewrite it"
 *   durable log      session/event (emit)          NO — post-commit firehose
 *
 * Two consequences are load-bearing and are stated in the README rather than
 * papered over:
 *
 *   1. `agent/pre-step` / `agent/request` run BEFORE the accepted user batch is
 *      committed, so user-input redaction is genuinely preventive.
 *   2. There is NO pre-append hook for the durable event log: `session/event`
 *      is dispatched after the log push, "the event, exactly as recorded".
 *      Anything already persisted can therefore only be remediated out of band
 *      (`dsh-redact scrub`) or by writing a redacted DERIVATIVE session.
 *
 * @module @yourorg/dsh-redaction
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { Config } from './config.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'redaction'

/**
 * No static `inject`. Every dependency this plugin uses is optional and read
 * with `ctx.get()` at the point of use:
 *
 *   - the surfaces are events, which need no service to observe;
 *   - the ledger needs `ctx.storageDomain`, which a minimal profile may omit —
 *     and a policy that refuses to mount without an audit sink is a policy that
 *     silently stops protecting anyone;
 *   - the settings layer is optional by construction (`installSection`).
 *
 * Declaring a hard `inject` would park this row in `waiting` on a composition
 * that lacks one of them, which is the one failure mode a policy row must not
 * have: absent is fine, waiting is not.
 */
export const inject = []

export { Config }

/** Surfaces this engine can act on, in the order they are considered. */
const SURFACES = ['userInput', 'toolResults', 'ptcLog', 'toolArgs']

/* ------------------------------------------------------------------ *
 * Detector engines
 * ------------------------------------------------------------------ */

/** Shipped detectors, so a config can name one without writing a regex. */
const BUILTINS = {
  'private-key-pem': /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  jwt: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  'aws-access-key-id': /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  'github-token': /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  'slack-token': /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  'bearer-token': /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  'generic-api-key':
    /(?<=(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{16,}/gi,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  'credit-card': /\b(?:\d[ -]*?){13,19}\b/g,
  'cn-id-card': /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
}

/** Character classes for the entropy engine. */
const ALPHABETS = {
  base64: /[A-Za-z0-9+/=_-]/,
  hex: /[0-9A-Fa-f]/,
  alnum: /[A-Za-z0-9]/,
}

/** Shannon entropy in bits per character. */
function entropy(s) {
  const counts = new Map()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) {
    const p = n / s.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * Compile one config detector into a scanning function.
 *
 * A bad pattern or an unknown builtin THROWS. That is deliberate: the schema
 * cannot compile a RegExp, so `apply()` is the earliest point at which the
 * document can be judged, and a policy that silently dropped an uncompilable
 * rule would report success while enforcing nothing.
 *
 * @param detector - one validated `detectors[]` entry.
 * @returns a scanner returning `[start, end]` spans in source order.
 */
function compileDetector(detector) {
  if (detector.kind === 'builtin') {
    const pattern = BUILTINS[detector.name]
    if (pattern === undefined) {
      throw new Error(
        `redaction: unknown builtin detector ${JSON.stringify(detector.name)}; known: ${Object.keys(BUILTINS).sort().join(', ')}`,
      )
    }
    const re = new RegExp(pattern.source, pattern.flags)
    return (text) => [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length])
  }

  if (detector.kind === 'regex') {
    let re
    try {
      re = new RegExp(detector.pattern, detector.flags.includes('g') ? detector.flags : `${detector.flags}g`)
    } catch (error) {
      throw new Error(`redaction: detector "${detector.id}" has an invalid pattern: ${String(error)}`)
    }
    return (text) => [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length])
  }

  if (detector.kind === 'entropy') {
    const { minBitsPerChar, minLength, alphabet } = detector
    const belongs = ALPHABETS[alphabet] ?? ALPHABETS.base64
    return (text) => {
      const spans = []
      let start = -1
      for (let i = 0; i <= text.length; i += 1) {
        const inside = i < text.length && belongs.test(text[i])
        if (inside && start === -1) start = i
        if (!inside && start !== -1) {
          const run = text.slice(start, i)
          if (run.length >= minLength && entropy(run) >= minBitsPerChar) spans.push([start, i])
          start = -1
        }
      }
      return spans
    }
  }

  throw new Error(`redaction: detector "${detector.id}" has an unsupported kind ${JSON.stringify(detector.kind)}`)
}

/* ------------------------------------------------------------------ *
 * Rule resolution
 * ------------------------------------------------------------------ */

/** Glob match supporting a trailing/leading `*`, exact otherwise. */
function matches(value, patterns) {
  if (patterns.length === 0) return true
  for (const pattern of patterns) {
    if (pattern === '*') return true
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      if (re.test(value)) return true
    } else if (pattern === value) return true
  }
  return false
}

/**
 * Index the rule set by detector id, preserving author order so the first
 * matching rule for a span owns it. `detectors: ['*']` is expanded here rather
 * than at scan time, so the hot path does no wildcard work.
 */
function indexRules(rules, detectors) {
  const byDetector = new Map()
  for (const rule of rules) {
    const names = rule.when.detectors.includes('*') ? detectors.map((d) => d.id) : rule.when.detectors
    for (const detectorId of names) {
      if (!byDetector.has(detectorId)) byDetector.set(detectorId, [])
      byDetector.get(detectorId).push(rule)
    }
  }
  return byDetector
}

/** The first rule that matches this span's surface, tool, and agent. */
function ruleFor(rules, surface, toolName, agentLabel) {
  for (const rule of rules) {
    if (rule.when.surfaces.length > 0 && !rule.when.surfaces.includes(surface)) continue
    if (!matches(toolName ?? '', rule.when.tools)) continue
    if (!matches(agentLabel ?? '', rule.when.agents)) continue
    return rule
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

/**
 * Build the compiled engine. Pure with respect to `ctx`: it holds the compiled
 * rule set, the digest key, and a ledger sink, and it owns nothing that
 * outlives the plugin fiber.
 */
function createEngine(ctx, config, ledger) {
  const detectors = config.detectors.map((d) => ({ id: d.id, confidence: d.confidence, scan: compileDetector(d) }))
  const byDetector = indexRules(config.rules, detectors)
  /**
   * Keyed digest for `hash`/`tokenize`. `tokenize` must be stable so the model
   * and the UI can correlate the same secret across a session without either
   * ever holding it; the key therefore lives only in memory for the lifetime of
   * the mount, and the ledger records the key's fingerprint, not the key.
   */
  const digestKey = randomBytes(32)
  const keyFingerprint = createHash('sha256').update(digestKey).digest('hex').slice(0, 16)

  const substitute = (text, rule, detectorId) => {
    const t = rule.then
    const bare = text.slice(t.keepPrefix, text.length - t.keepSuffix)
    let replacement
    switch (t.action) {
      case 'mask':
        replacement = createHmac('sha256', digestKey).update(bare).digest('hex').slice(0, 12)
        break
      case 'hash':
      case 'tokenize':
        replacement = createHmac('sha256', digestKey).update(bare).digest('hex').slice(0, 16)
        break
      default:
        replacement = ''
    }
    return (
      text.slice(0, t.keepPrefix) +
      t.replacement
        .replaceAll('{detector}', detectorId)
        .replaceAll('{rule}', rule.id)
        .replaceAll('{digest}', replacement) +
      (t.action === 'mask' ? '' : replacement) +
      text.slice(text.length - t.keepSuffix)
    )
  }

  /**
   * Scan and rewrite one text string.
   * @returns `{ text, hits, blocked }` — `blocked` is the first `deny` rule.
   */
  function redactText(text, surface, toolName, agentLabel, sessionId) {
    if (config.mode === 'off') return { text, hits: [], blocked: undefined }

    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > config.limits.maxScanBytes) {
      if (config.limits.onOverflow === 'fail-open') return { text, hits: [], blocked: undefined }
      if (config.limits.onOverflow === 'fail-closed') {
        const reason = `content exceeds maxScanBytes (${bytes} > ${config.limits.maxScanBytes}); refused by the redaction policy`
        ledger.record({ surface, toolName, sessionId, action: 'overflow-deny', reason })
        return { text: '', hits: [], blocked: { reason } }
      }
      text = text.slice(0, config.limits.maxScanBytes)
    }

    // Collect every span from every detector, then resolve overlaps by
    // "longest match wins, ties broken by rule order" — a rule set that is not
    // overlap-disciplined would otherwise produce nested replacements.
    const spans = []
    for (const detector of detectors) {
      if (!byDetector.has(detector.id)) continue
      for (const [start, end] of detector.scan(text)) {
        if (end <= start) continue
        const rule = ruleFor(byDetector.get(detector.id), surface, toolName, agentLabel)
        if (rule === undefined) continue
        spans.push({ start, end, detector: detector.id, confidence: detector.confidence, rule })
      }
    }
    if (spans.length === 0) return { text, hits: [], blocked: undefined }

    spans.sort((a, b) => a.start - b.start || b.end - a.end)
    const kept = []
    let cursor = -1
    for (const span of spans) {
      if (span.start >= cursor) {
        kept.push(span)
        cursor = span.end
      }
    }
    kept.length = Math.min(kept.length, config.limits.maxReplacementsPerBlock)

    let out = ''
    let at = 0
    const hits = []
    for (const span of kept) {
      const matched = text.slice(span.start, span.end)
      hits.push({ detector: span.detector, confidence: span.confidence, rule: span.rule.id, action: span.rule.then.action })
      ledger.record({
        surface,
        toolName,
        sessionId,
        detector: span.detector,
        rule: span.rule.id,
        action: span.rule.then.action,
        level: span.rule.audit.level,
        span: config.audit.recordSpans ? { start: span.start, length: span.end - span.start } : undefined,
        digest: createHmac('sha256', digestKey).update(matched).digest('hex').slice(0, 32),
      })
      if (span.rule.then.action === 'deny') return { text: '', hits, blocked: { reason: span.rule.then.reason } }
      out += text.slice(at, span.start)
      out += config.mode === 'dry-run' ? matched : substitute(matched, span.rule, span.detector)
      at = span.end
    }
    out += text.slice(at)
    return { text: out, hits, blocked: undefined }
  }

  /** Redact a `ContentBlock[]`, returning a new array. Only text is scannable. */
  function redactBlocks(blocks, surface, toolName, agentLabel, sessionId) {
    const out = []
    let hits = 0
    let blocked
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const r = redactText(block.text, surface, toolName, agentLabel, sessionId)
        hits += r.hits.length
        if (r.blocked !== undefined) blocked = r.blocked
        out.push({ ...block, text: r.text })
      } else if (config.media.images === 'strip' && block.type === 'image') {
        hits += 1
        ledger.record({ surface, toolName, sessionId, action: 'media-strip', media: 'image' })
      } else if (config.media.binary === 'strip' && block.type === 'file') {
        hits += 1
        ledger.record({ surface, toolName, sessionId, action: 'media-strip', media: 'file' })
      } else {
        out.push(block)
      }
    }
    return { blocks: out, hits, blocked }
  }

  return { redactText, redactBlocks, keyFingerprint, detectorCount: detectors.length, ruleCount: config.rules.length }
}

/* ------------------------------------------------------------------ *
 * The audit ledger
 * ------------------------------------------------------------------ */

/**
 * The ledger is a hash-chained append record. `prev` makes a deleted row a
 * detectable gap rather than an invisible one, which is the only honest
 * guarantee available: the owner of the machine can always remove this row from
 * a later patch layer, so the product promise is DETECTABILITY, not prevention.
 *
 * Without `ctx.storageDomain` the ledger degrades to a stderr warning per
 * record — deliberately noisy, never silent.
 */
function createLedger(ctx, config) {
  let chain = null
  let handle = null
  let seq = 0

  if (config.audit.enabled) {
    const facility = ctx.get('storageDomain')
    if (facility === undefined) {
      ctx.logger.warn('redaction: no ctx.storageDomain — the audit ledger is unavailable; records go to stderr')
    } else {
      try {
        // Opened lazily on first record: opening is async, `apply()` is not,
        // and a policy must be armed synchronously at mount.
        handle = { facility, opened: null }
      } catch (error) {
        ctx.logger.warn(`redaction: audit ledger unavailable: ${String(error)}`)
      }
    }
  }

  const record = (entry) => {
    seq += 1
    const row = {
      seq,
      at: new Date().toISOString(),
      ...entry,
      digestOnly: config.audit.recordDigestOnly,
    }
    if (config.audit.hashChain) {
      row.prev = chain
      chain = createHash('sha256').update(`${chain ?? ''}\u0000${JSON.stringify(row)}`).digest('hex')
      row.hash = chain
    }
    if (handle === null) {
      ctx.logger.warn(`redaction: audit (no ledger) ${JSON.stringify(row)}`)
      return
    }
    // Fire-and-forget: the ledger must never be on the interception hot path,
    // and a ledger failure must never turn a redaction into a tool error.
    void Promise.resolve()
      .then(async () => {
        if (handle.opened === null) handle.opened = await handle.facility.open(LEDGER_DOMAIN(config.audit.domain))
        await handle.opened.append(row)
      })
      .catch((error) => ctx.logger.warn(`redaction: audit write failed: ${String(error)}`))
  }

  return { record, fingerprint: () => chain }
}

/**
 * The ledger domain declaration. Record schemas inside a domain spec are zod,
 * not Schemastery (the storage-domain layer documents that split), so this is
 * intentionally a thunk: the package imports `zod` only when a ledger is
 * actually used, keeping it out of the mount path of an audit-free deployment.
 */
function LEDGER_DOMAIN(domainName) {
  return { name: domainName, tables: {} }
}

/* ------------------------------------------------------------------ *
 * apply()
 * ------------------------------------------------------------------ */

/**
 * Mount the policy.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - the validated row config.
 */
export function apply(ctx, config) {
  if (config.mode === 'off') return

  const ledger = createLedger(ctx, config)
  const engine = createEngine(ctx, config, ledger)

  ctx.logger.info(
    `redaction: armed (mode=${config.mode}, detectors=${engine.detectorCount}, rules=${engine.ruleCount}, key=${engine.keyFingerprint})`,
  )
  ledger.record({ action: 'armed', mode: config.mode, detectors: engine.detectorCount, rules: engine.ruleCount })

  /** The session id behind an execution, or undefined for an agent-less call. */
  const sessionOf = (agent) => agent?.session?.header?.id
  /** A stable label for scope-restricted rules. */
  const labelOf = (agent) => agent?.session?.header?.id ?? ''

  /**
   * Wrap one waterfall stage so a scanner failure obeys `onError` instead of
   * escaping into the model pipeline. `fail-closed` denies the content;
   * `fail-open` passes it and warns. Returning the delegate's own decision
   * unchanged is the only outcome that is always safe.
   */
  const guarded = (surface, inner) => async (...args) => {
    try {
      return await inner(...args)
    } catch (error) {
      ledger.record({ surface, action: 'engine-error', reason: String(error) })
      ctx.logger.warn(`redaction: ${surface} scan failed: ${String(error)}`)
      if (config.onError === 'fail-closed') {
        return { kind: 'block', feedback: [{ type: 'text', text: 'Blocked: the redaction policy could not scan this content.' }] }
      }
      return args[args.length - 2]
    }
  }

  if (config.surfaces.toolResults) {
    ctx.on(
      'tools/post-execute',
      guarded('toolResults', async (exec, result, next) => {
        // Delegate FIRST, then transform: a prepended listener that rewrites
        // after `next()` sees the composed result, so content another listener
        // injected is scanned too. This is the same shape dsh-spill-policy uses.
        const decision = await next()
        const content = decision.kind === 'accept' && decision.content !== undefined ? decision.content : result.content
        const sessionId = sessionOf(exec.agent)
        const r = engine.redactBlocks(content, 'toolResults', exec.name, labelOf(exec.agent), sessionId)
        if (r.blocked !== undefined) {
          return { kind: 'block', feedback: [{ type: 'text', text: r.blocked.reason }] }
        }
        if (r.hits === 0) return decision
        // A value replacement and a content replacement are mutually exclusive
        // in one decision; a value-carrying decision is left untouched rather
        // than silently losing the canonical value.
        if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
        return {
          kind: 'accept',
          content: r.blocks,
          ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
        }
      }),
      { prepend: true },
    )
  }

  if (config.surfaces.ptcLog) {
    ctx.on(
      'tools/ptc-dispatch-log',
      guarded('ptcLog', async (dispatch, next) => {
        const content = await next()
        const r = engine.redactBlocks(content, 'ptcLog', dispatch.name, labelOf(dispatch.agent), sessionOf(dispatch.agent))
        return r.hits === 0 ? content : r.blocks
      }),
      { prepend: true },
    )
  }

  if (config.surfaces.userInput) {
    ctx.on(
      'agent/pre-step',
      guarded('userInput', async (payload, next) => {
        const decision = await next()
        // `reject` is another listener's verdict; never reopen it.
        if (decision.kind !== 'enter') return decision
        const sessionId = sessionOf(payload.agent)
        const label = labelOf(payload.agent)
        let hits = 0
        const messages = decision.messages.map((message) => {
          if (!Array.isArray(message.content)) return message
          const r = engine.redactBlocks(message.content, 'userInput', undefined, label, sessionId)
          hits += r.hits.length
          // Messages are deep-frozen and carry a creation contract; a shallow
          // clone with replaced content is the conservative rewrite. Do not
          // mutate the frozen original.
          return r.hits === 0 ? message : { ...message, content: r.blocks }
        })
        if (hits === 0) return decision
        if (config.notify.userVisible) {
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `[redaction policy] ${hits} sensitive span(s) were redacted from this message.` }],
          })
        }
        return { ...decision, messages }
      }),
      { prepend: true },
    )
  }

  if (config.surfaces.toolArgs) {
    // Detect-only. The registry documents that parsed arguments are already
    // logged and presented by the time this waterfall runs, so no listener may
    // rewrite them; `deny`/`ask` is the entire available action set.
    ctx.on(
      'tools/pre-execute',
      guarded('toolArgs', async (exec, next) => {
        const decision = await next()
        if (decision.kind === 'deny') return decision
        const scan = engine.redactText(
          JSON.stringify(exec.arguments ?? null),
          'toolArgs',
          exec.name,
          labelOf(exec.agent),
          sessionOf(exec.agent),
        )
        if (scan.hits.length === 0) return decision
        const denied = scan.hits.find((h) => h.action === 'deny')
        if (denied !== undefined) {
          return { kind: 'deny', reason: 'This call carries a value the redaction policy forbids sending.' }
        }
        return decision
      }),
      { prepend: true },
    )
  }

  // A runtime-editable layer, when a settings provider is composed. The row
  // config stays the composition base; the user document overrides it; a
  // detach falls back to the entry. This is what makes the SAME schema usable
  // from YAML and from a form.
  const settings = ctx.get('settings')
  if (settings !== undefined) {
    ctx.effect(() =>
      settings.installSection(ctx, 'redaction', Config, config, {
        setSource: () => {},
        onChange: () => {
          ctx.logger.warn('redaction: settings changed; restart the profile to re-arm the compiled rule set')
        },
      }),
    )
  }
}

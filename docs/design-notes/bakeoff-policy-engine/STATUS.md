# Archived design artifact — NOT a shipped package

This directory holds a **design-bakeoff output**, not a maintained package. It was produced early in the project, before the mechanisms below had been verified against the real runtime. It is kept only as a record of the design space that was explored.

**Do not install, publish, or copy from it.**

Why it is archived rather than shipped:

1. **Its core redaction mechanism is wrong.** Its README and code intercept `tools/post-execute` and replace the result's `content`. Later verification against the real registry (`dsh-tools/lib/index.js`, `createSuccessResult` / `normalizeDispatchResult`) established that replacing only `content` leaves the original text in the result's `meta`, which is then persisted verbatim into the `tool/result` event (`dsh-agent-loop/lib/index.js`). The correct approach — rewriting the result **`value`** so both `content` and `presentationMeta` are re-derived — is what the shipped packages use.
2. **Its hook table includes surfaces that cannot transform.** Rows such as `llm/stream` ("read it, never rewrite it") and `session/event` (post-commit, "exactly as recorded") are correctly marked as non-rewriting, but the package's own framing implies more coverage than the platform actually allows.
3. **It was never tested.** No suite, no synthetic fixtures, no boot verification. The shipped packages carry 248 + 54 + 78 + 34 assertions and a real-reader oracle.
4. **Its identity is a placeholder** (`@yourorg/dsh-redaction`, `author: Your Name <you@example.com>`, a `github.com/yourorg/...` URL).

For the maintained packages see [`packages/`](../../../packages) and the knowledge base under [`docs/`](../../).

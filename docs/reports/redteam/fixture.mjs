/**
 * Red-team fixture helpers. 100% synthetic data in a temp dir.
 * Uses the REAL DSH codec/backend (from the nodejs-x64 install, outside .dsh)
 * so that "does DSH accept this log" is answered by DSH's own code.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

export const LIB = '' + (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/nodejs-x64/node-v22.21.0-win-x64/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
export const imp = (p) => import(pathToFileURL(LIB + p).href)

export const ROOT = path.join(os.tmpdir(), 'rt-redact', 'root')
export const ZOPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
export const frame = (t) => zlib.zstdCompressSync(Buffer.from(t, 'utf8'), ZOPTS)

export const {
  Session,
} = await imp('dsh-session/lib/index.js')
export const { sessionFormatCatalog } = await imp('dsh-session-format-catalog/lib/index.js')
export const JsonlSessionPersistence = (await imp('dsh-session-persistence-jsonl/lib/index.js')).default
export const { Context } = await imp('cordis/lib/index.js')

/** Write <root>/_no-cwd/<id>/session.v3.jsonl.zstd from in-memory events. */
export function writeLog(id, header, events, { rows, framesPerFrame = 3, dir = ROOT } = {}) {
  const headerRow = JSON.stringify(sessionFormatCatalog.encodeCurrentHeader(header, 0)) + '\n'
  const body = rows ?? events.map((e) => JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(e)) + '\n')
  const frames = [frame(headerRow)]
  for (let i = 0; i < body.length; i += framesPerFrame) frames.push(frame(body.slice(i, i + framesPerFrame).join('')))
  const d = path.join(dir, '_no-cwd', id)
  fs.mkdirSync(d, { recursive: true })
  const file = path.join(d, 'session.v3.jsonl.zstd')
  fs.writeFileSync(file, Buffer.concat(frames))
  return file
}

/** Write an already-encoded log (rows = array of JSON strings w/o newline). */
export function writeRawLog(id, header, rows, { framesPerFrame = 3, dir = ROOT } = {}) {
  const headerRow = JSON.stringify(sessionFormatCatalog.encodeCurrentHeader(header, 0)) + '\n'
  const frames = [frame(headerRow)]
  for (let i = 0; i < rows.length; i += framesPerFrame) {
    frames.push(frame(rows.slice(i, i + framesPerFrame).map((r) => r + '\n').join('')))
  }
  const d = path.join(dir, '_no-cwd', id)
  fs.mkdirSync(d, { recursive: true })
  const file = path.join(d, 'session.v3.jsonl.zstd')
  fs.writeFileSync(file, Buffer.concat(frames))
  return file
}

export function headerFor(id, extra = {}) {
  return { version: 3, id, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0, ...extra }
}

/** Decode a synthetic log to plain rows (only ever our own synthetic data). */
export function decodeRows(file) {
  const buf = fs.readFileSync(file)
  return decodeRowsBuf(buf)
}
export function decodeRowsBuf(buf) {
  const out = []
  let off = 0
  while (off < buf.length) {
    if (buf.readUInt32LE(off) !== 0xfd2fb528) break
    // find frame end by trial decompression over the remaining suffix is O(n^2);
    // instead reuse the engine's scanner for the framing only.
    break
  }
  return out
}

/** Real backend: does DSH accept this log?  returns {ok, error, events} */
export async function backendOpen(id, root = ROOT) {
  const backend = new JsonlSessionPersistence(new Context(), { root })
  try {
    const handle = await backend.open(id, 'write')
    try {
      const cold = await handle.read(0, undefined)
      return { ok: true, events: cold.events }
    } finally {
      await handle.close()
    }
  } catch (e) {
    return { ok: false, error: `${e.constructor.name}: ${String(e.message).split(' (raw log')[0]}` }
  }
}

export const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })

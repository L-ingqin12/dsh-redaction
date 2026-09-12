/**
 * real-reader.mjs — 测试用「真实 DSH 读取端」助手。
 *
 * 为什么必须用它：
 *   红队报告的元发现是——旧夹具写出的是**读取端不合法的日志**（例如把 tool/result 的
 *   message 写成 `role:'tool'`，而真实形状是 `role:'user'` + `source:{kind:'tool',callId}`，
 *   见 dsh-llm/lib/types/message.d.ts:22-25）。于是「引擎自检通过」被当成了「DSH 打得开」，
 *   F1（sourceEventSeqs 游程未重映射）与 F2（session/title.messageSeqs 悬空）就是在
 *   一片绿色的套件里溜过去的。
 *
 * 所以这里的每个夹具都直接调用 **DSH 自己的编解码器 / 会话对象 / 持久化后端**：
 *   - 夹具用真实 `Session` + `sessionFormatCatalog` 编码 → 结构由 DSH 保证；
 *   - 判据用真实 `JsonlSessionPersistence.open()` → 「能不能打开」由 DSH 回答。
 *
 * 隐私：只处理本进程自己造的合成数据，落在 mkdtemp 出来的临时目录，不碰 ~/.dsh。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

/** DSH 安装目录（与用户 profile 无关）。可用 DSH_REDACT_DSH_LIB 覆盖。 */
export const DSH_LIB =
  process.env.DSH_REDACT_DSH_LIB ??
  path.join(
    process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? '.',
    'profiles',
    'node_modules',
    '@deepseek-ai',
  ) + path.sep

export function imp(rel) {
  const file = DSH_LIB + rel
  if (!fs.existsSync(file)) {
    throw new Error(
      `找不到真实 DSH 包 ${file}：本套件的判据是真实读取端，不能降级为「跳过」。` +
        '请设置 DSH_REDACT_DSH_LIB 指向 @deepseek-ai 目录。',
    )
  }
  return import(pathToFileURL(file).href)
}

export const { Session } = await imp('dsh-session/lib/index.js')
export const { sessionFormatCatalog } = await imp('dsh-session-format-catalog/lib/index.js')
export const { Context } = await imp('cordis/lib/index.js')
export const JsonlSessionPersistence = (await imp('dsh-session-persistence-jsonl/lib/index.js')).default

export const ZOPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
export const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZOPTS)

export const headerFor = (id, extra = {}) => ({ version: 3, id, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0, ...extra })

/** 把已编码的行数组写成真实格式的日志（第 0 帧=头部行，之后每帧若干行）。 */
export function writeRawLog(root, project, id, header, rows, { framesPerFrame = 3 } = {}) {
  const dir = path.join(root, project, id)
  fs.mkdirSync(dir, { recursive: true })
  const frames = [frame(JSON.stringify(sessionFormatCatalog.encodeCurrentHeader(header, 0)) + '\n')]
  for (let i = 0; i < rows.length; i += framesPerFrame) {
    frames.push(frame(rows.slice(i, i + framesPerFrame).map((r) => r + '\n').join('')))
  }
  const file = path.join(dir, 'session.v3.jsonl.zstd')
  fs.writeFileSync(file, Buffer.concat(frames))
  return { file, dir, bytes: Buffer.concat(frames) }
}

/** 用真实 Session 构造会话，落成实际后端能打开的日志。 */
export function writeSessionLog(root, project, id, header, build, options) {
  const session = Session.create(id, undefined, header, undefined)
  build(session)
  const rows = session.snapshotEvents().map((e) => JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(e)))
  return { session, ...writeRawLog(root, project, id, header, rows, options) }
}

/** 真实后端：这份日志 DSH 打得开吗？返回 {ok, events, error}。 */
export async function backendOpen(root, id, access = 'write') {
  const backend = new JsonlSessionPersistence(new Context(), { root })
  try {
    const handle = await backend.open(id, access)
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

/** 真实 title 不变式：用它复核 session/title 行（dsh-session-title/lib/types/invariant.js）。 */
export async function titleInvariantError(events) {
  const { apply: install } = await imp('dsh-session-title/lib/types/invariant.js')
  let captured
  install({ invariants: { register: (_n, f) => { captured = f } }, sessions: { list: () => [] }, on: () => {} })
  const synthetic = { snapshotEvents: () => events, eventAt: (seq) => events[seq + 1] }
  try {
    captured({ sessions: { list: () => [synthetic] }, on: () => {} }, (m) => { throw new Error(m) })
    return undefined
  } catch (e) {
    return e.message
  }
}

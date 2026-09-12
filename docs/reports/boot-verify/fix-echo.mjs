import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export const name = 'x-echo'
export function apply(ctx, config) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  writeFileSync(path.join(here, 'echo.json'), JSON.stringify(config, null, 2))
}

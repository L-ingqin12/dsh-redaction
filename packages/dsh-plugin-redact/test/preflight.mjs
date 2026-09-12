// 起飞前检查：模块可导入、命令可注册、list 子命令可跑通（只读目录元数据，不读内容）。
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const mod = await import(new URL('../index.js', import.meta.url).href)
console.log('导出名        :', Object.keys(mod).join(', '))
console.log('name          :', mod.name)
console.log('inject        :', JSON.stringify(mod.inject))
console.log('apply 是函数  :', typeof mod.apply === 'function')

let captured = null
const ctx = { commands: { register(def) { captured = def } }, get: () => undefined }
// 只用 os.homedir()，不碰 USERPROFILE —— 后者在 Linux/macOS 上不存在。
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

mod.apply(ctx, {
  root: path.join(DSH_HOME, 'sessions'),
  cacheRoot: path.join(DSH_HOME, 'storages'),
  placeholder: '[已移除]',
})

console.log('已注册命令    :', captured?.name)
console.log('描述          :', captured?.description)
console.log('hint          :', captured?.input?.hint)
console.log('recordInput   :', captured?.recordInput)
console.log('handler 是函数:', typeof captured?.handler)

const out1 = await captured.handler({ rawInput: '', agent: { session: { id: 'current-session-id' } } })
console.log('\n--- /redact list ---')
console.log(out1.kind)
console.log(out1.text.split('\n').slice(0, 5).join('\n'))

const out2 = await captured.handler({ rawInput: 'verify --session does-not-exist-xyz', agent: { session: { id: 'cur' } } })
console.log('\n--- 未知会话 ---')
console.log(out2.kind, '|', out2.text)

const out3 = await captured.handler({ rawInput: 'nonsense', agent: { session: { id: 'cur' } } })
console.log('\n--- 未知子命令 ---')
console.log(out3.kind, '|', out3.text.split('\n')[0])

const out4 = await captured.handler({ rawInput: 'apply', agent: { session: { id: 'cur' } } })
console.log('\n--- 缺计划文件 ---')
console.log(out4.kind, '|', out4.text.split('\n')[0])

// hide：无 surface 的假会话应给出明确错误，而不是抛异常
import fs from 'node:fs'
fs.writeFileSync(new URL('./tmp-plan.json', import.meta.url), JSON.stringify({ substitutions: [{ find: 'ZZZ-NOT-PRESENT', replace: '[已移除]' }] }))
const planPath = fileURLToPath(new URL('./tmp-plan.json', import.meta.url))

const out5 = await captured.handler({ rawInput: `hide "${planPath}"`, agent: { session: { id: 'cur' } } })
console.log('\n--- hide（会话无 surface） ---')
console.log(out5.kind, '|', out5.text)

const out6 = await captured.handler({ rawInput: '', agent: undefined })
console.log('\n--- 无 agent ---')
console.log(out6.kind, '|', out6.text.split('\n')[0])
fs.rmSync(new URL('./tmp-plan.json', import.meta.url), { force: true })

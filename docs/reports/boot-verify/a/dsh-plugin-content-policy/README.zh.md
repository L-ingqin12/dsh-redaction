# dsh-plugin-content-policy

**预防式**内容策略：在 DSH 的工具结果被规范化、落盘、进入下一次 provider 请求**之前**改写它。

它是 `dsh-plugin-redact`（事后补救：原地脱敏已经写进 `session.vN.jsonl.zstd` 的日志）的**事前对应物**：
redact 擦掉已经留下的东西，本插件让不该留下的东西**根本没机会留下**。

两条互补的策略，挂在**同一条**接缝上（`tools/execute`），顺序固定为 **先 strip、后正则**：

| 策略 | 配置 | 认识内容吗？ | 适用场景 |
| --- | --- | --- | --- |
| **内容改写** | `rules[]` | 认识：你给字面量/正则，命中即替换 | 你已经知道要挡什么（手机号、密钥、内部域名…） |
| **结构最小化** | `strip[]`（+ `stripDefaults`） | **不认识**：只按字段路径整段丢弃/截断 | 事先**无法枚举**的载荷（公开检索回来的任意段落），对策是"让它根本不进来" |

---

## 1. 为什么必须发生在 append 之前

一次 `session.append('tool/result', …)` 有两个后果，而且它们是**同一份数据**：

| 后果 | 证据 |
| --- | --- |
| 它成为持久日志里的一行 | `dsh-agent-loop/lib/index.js:703-712`（`session.append("tool/result", { turn, step, message, …result.meta })`） |
| 它是**将来每一次请求**里那条工具结果消息 | `dsh-session/lib/index.js:216`：`deriveEventMessage` 对 `tool/result` 直接 `return event.data.message`；请求由 `session.deriveMessages()` 折叠同一批事件得到 |

所以"事后脱敏"永远慢一步：内容在写入的那一刻就已经同时进了日志和（下一次请求的）上下文。
本插件把自己插在 `tools/execute` 瀑布里 —— 那是结果**被规范化之前**唯一的改写点。

尤其要注意**两条通道**：`web_search` 把同一段 `snippet` 同时放进渲染文本（`content`）和
`presentationMeta`（持久化 meta）。只换 `content` 会漏掉 meta，见接缝表第 6、7 行。

---

## 2. 接缝表（每条都对着 shipped 源码核过）

| # | 接缝 | 源码位置 | 本插件怎么用 |
| --- | --- | --- | --- |
| 1 | `tools/execute` 瀑布 | 声明：`dsh-tools/lib/types/index.d.ts:49` | **主接缝**：包装器返回值会被注册表重新规范化 |
| 2 | 返回值规范化 | `dsh-tools/lib/index.js:3213-3214`（`waterfall('tools/execute', …)` → `normalizeDispatchResult`） | 我们返回的对象就是下游 `tools/post-execute` 看到的 `result` |
| 3 | 同一性快路径 | `dsh-tools/lib/index.js:3448`（`canonicalResults.get(result) === exec.token` ⇒ 原样返回） | 无改动时**按引用返回原结果** ⇒ 零开销、不二次渲染 |
| 4 | 成功结果从 `value` 重新派生 content | `dsh-tools/lib/index.js:3458` → `:3422`（`createSuccessResult` → `tool.output.render(exec.arguments, value)`） | 我们**改写 `value`**，content 由注册表自己重算 |
| 5 | 成功结果从 `value` 重新派生 meta | `dsh-tools/lib/index.js:3428-3436`（`presentationMeta(exec.arguments, value)`） | 同上：meta 也自动跟着 value 变 |
| 6 | 只换 content 会留下旧 meta | `dsh-tools/lib/index.js:3401-3405`（`{...result, content}` 展开保留 `meta`） | **这是本插件改写 value 而不是 content 的原因** |
| 7 | meta 会被持久化 | `dsh-agent-loop/lib/index.js:708`（`...result.meta !== void 0 ? { meta: result.meta } : {}`） | 只换 content ⇒ 命中文本仍随 meta 落盘 |
| 8 | 同一段文本双通道的真实例子 | `dsh-tool-web/lib/index.js:62-79`（snippet 进 content）与 `:103-124`（同一 snippet 进 presentationMeta） | `web_search` 是最典型的"只擦 content 不够"案例 |
| 9 | 失败结果不能替换 value | `dsh-tools/lib/index.js:3392`（`tools/post-execute cannot replace the value of a failed result`） | 失败结果只能重建 content；strip 对它不生效 |
| 10 | 失败结果的 content/meta 逐字复制 | `dsh-tools/lib/index.js:3449-3455` | 返回自己的 `{ isError: true, error, content }` 并**省略 meta** ⇒ meta 被丢弃 |
| 11 | 失败结果持久化时的约束 | `dsh-session/lib/index.js:241-248`（`error` 存在时要求 `message.content[0].isError === true`） | 由 `createToolResultMessage` 依据 `result.isError` 生成，天然满足 |
| 12 | 参数在工具体运行前就已落盘 | `dsh-agent-loop/lib/index.js:586`（`appendToolCall`）早于 `:588`（`prepare`/`dispatch`） | 所以"阻断"**不能**阻止参数入库，只能阻止执行（见第 6 节） |
| 13 | `tools/pre-execute` 的 `{kind:'deny'}` | `dsh-tools/lib/index.js:3116-3139` | block 规则：命中参数即拒绝，工具体不运行 |
| 14 | `ctx.tools.guard(fn)` | `dsh-tools/lib/types/index.d.ts:620`（单调守卫） | 未使用：瀑布的 deny 已经终止派发；理由见第 7 节 |
| 15 | `tools/ptc-dispatch-log` 瀑布 | 声明：`dsh-tools/lib/types/index.d.ts:75`；消费：`dsh-tools/lib/index.js:1235-1251` | 兜底改写 `run_code` 子调用的**日志副本** content |
| 16 | 输出 schema 的受支持子集 | `dsh-tools/lib/index.js:33-47`（`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解）、`:195-206` | **只有 `enum`/`const` 能固定一个字符串**；也**没有 `minLength`/`maxLength`**（这是 maxChars 截断安全的前提） |
| 17 | Cordis 的 Config 契约 | `cordis/lib/index.js:955-960`（`runtime.Config["~standard"].validate(config)`）、`:1630`（`Config: plugin.Config`） | 导出的 `Config` 必须实现 Standard Schema |
| 18 | patch 覆盖是**整体替换** | `dsh-app-boot/lib/index.js:70-105`（`target[key] = value`） | 覆盖 `config` 时要把字段写全（第 4 节） |
| 19 | 真空操作默认的约定 | `dsh-spill-policy/lib/index.js:104`（`if (maxInlineBytes === void 0) return`） | 未配置 `rules` **且**未配置 `strip` ⇒ 一个监听器都不注册 |
| 20 | 工具输出 schema 是**编译后**的 | `dsh-tools/lib/index.js:846-847`（`defineTool` 调 `valueSchemaSpecToJsonSchema`）→ `:594-603`（属性级 `required: true` 变成对象级 `required: [...]` 数组） | 所以"哪个键是必需的"可以从 `ctx.tools.get(name).output.schema.required` **直接判定** |
| 21 | 缺 required 字段 ⇒ 值非法 | `dsh-tools/lib/index.js:454-455`（`missing required property "…"`）、`:466-467`（`additionalProperties: false` 的多余键） | strip 拒绝删除 required 键的依据 |
| 22 | 非法 value ⇒ **整条调用变成终态错误** | `dsh-tools/lib/index.js:3417-3418`（`validateJsonSchemaValue` → `throw new ToolOutputError`）、`:3226-3231`（`catch` → `toolErrorResult`）、`:2454-2458`（`INVALID_TOOL_OUTPUT`） | 这就是"宁可响亮失败、也不静默产出非法值"的代价说明 |
| 23 | `web_search` 的 required 只有 3 个 | `dsh-tool-web/lib/index.js:270-298`：`required` 在编译后是 `['sources','truncated']`，`sources[].url` 必需；`content`/`title`/`snippet`/`publishedAt` 可选；`additionalProperties: false` | `stripDefaults` 的两条规则据此选定（丢 `sources.*.snippet` 与 `content`） |
| 24 | `web_search` 的两条投影都是纯函数 | `dsh-tool-web/lib/index.js:62-79`（`formatSearchOutput`，逐处 `!== void 0` 判断）、`:103-124`（`projectSource` + `searchMetaFromValue`） | 删掉可选字段后它们自然"看不见"该字段 ⇒ content 与 meta 同时干净 |
| 25 | ptc 日志副本只有 content 块 | `dsh-tools/lib/index.js:1235-1242`（`shapeDispatchLog({… content: result.content})`） | strip 在这条接缝上**无从下手**（没有 value） |
| 26 | spill 策略只管纯文本结果 | `dsh-spill-policy/lib/index.js:75-83`（`flattenPlainText`：任何非 `text` 块 ⇒ `undefined`）、`:156-172`（`tools/post-execute`，`prepend: true`） | 它**完全不碰** `web_search` 这类结构化结果；这正是 strip 要补的缺口 |
| 27 | spill 策略的落盘预览 | `dsh-spill-policy/lib/index.js:88-101`（头尾预览）、`:114-150`（存 spill 文件） | 全文仍以文件形式留在本地（`ctx.spillStore`），只是不进上下文 |
| 28 | 配置校验失败 = 加载期错误，不是运行期 | `cordis/lib/index.js:955-961`（`resolveConfig` 调 `Config["~standard"].validate` 并 `throw new ValidationError`）、`:939-944`（文案 = `invalid config:` + 每条 `message (at path)`） | 数值约束（`maxScannedBytes` / `maxChars`）因此放在 `Config` 里，报错点紧贴配置本身、且带字段路径 |

### 2.1 Config 的两条轨道：谁在生效，以及它们**真正**的差异

**先说结论：用户实际拿到的是"兜底轨道"那一套。** 插件以 `link:` 方式装进 profile 后，
Node 从包的**真实路径**（插件目录）向上找 `node_modules`，而 `@deepseek-ai/*` 只存在于
DSH 部署安装目录里 —— **从插件目录不可解析**（实测 `ERR_MODULE_NOT_FOUND`）。
所以 `index.js` 先 `try { await import('@deepseek-ai/schemastery') }`：

* 解析得到 ⇒ 导出真正的 Schemastery schema（`~standard.vendor === 'schemastery'`，
  与 shipped 策略插件同形，`dsh --dump-config` / 设置界面能看到 description 与 default）；
* 解析不到 ⇒ 退回本包内置的 Standard Schema 实现
  （`~standard.vendor === 'dsh-plugin-content-policy'`，字段与默认值来自同一张 `FIELDS` 表）。

Cordis 只调用 `Config["~standard"].validate(config)`（`cordis/lib/index.js:955-960`），
两条轨道**约束集合相同**（同一张 `FIELDS` 表 + `strip[].maxChars` 的整数约束），
但**不是逐字节一致**。24 例对照（本项目实测，含全部数值边界、未知键、嵌套默认、类型错）：

| 对照结果 | 计数 | 说明 |
| --- | --- | --- |
| 双方都拒绝、文案不同 | 16 | 拒绝集合**一致**（0 处"一个接受一个拒绝"的结构性分歧），只有文案/语言/路径格式不同 |
| 归一化值逐字节相同 | 0 | 两条轨道的键顺序不同，所以逐字节比对从不相同 |
| 仅键顺序不同（语义完全相同） | 3 | 空配置、`maxScannedBytes: .inf`、`maxScannedBytes: 4096`：兜底按 `FIELDS` 表顺序输出键，Schemastery 把 `rules`/`strip` 排在前面。`--dump-config` 的 JSON 键顺序会不同，功能无差异 |
| 键顺序 + 嵌套默认值 | 3 | 见下表 a |
| 未知键 | 1 | 见下表 b |
| `maxScannedBytes: null` | 1 | 见下表 d（**唯一的接受/拒绝分歧**，且只在这一例） |

真实差异（**读取顺序：兜底轨道的行为才是你需要按的**）：

| # | 差异 | 兜底轨道（生效） | Schemastery 轨道 | 影响 |
| --- | --- | --- | --- | --- |
| a | 嵌套默认值 | **不补**：`rules[].action/replacement/tools`、`strip[].tool` 保持缺省 | 补：`action:'replace'`、`replacement:'[已移除]'`、`tools:[]`、`tool:'*'` | **无功能影响**：`compileRules` / `compileStripRules` 自己会补（`lib/scrub.mjs` 的 `ACTION_REPLACE` / `DEFAULT_REPLACEMENT` / `tool='*'`）。只有 `--dump-config` 的显示不同 |
| b | 未知键 | **丢弃**（校验结果里不会出现） | **保留**（原样带回） | 拼错字段名时：兜底轨道下它**静默消失**、用默认值，`--dump-config` 是唯一的确认手段；Schemastery 轨道下它会出现在 dump 里。这是"以兜底为准"最需要注意的一条 |
| c | 报错文案与路径格式 | 中文、点名字段：`strip 规则的 maxChars 必须是 >= 1 的整数`，`path: ['strip','0']`（到规则一层） | 英文、带 JSON 路径：`$.strip[0].maxChars expected number >= 1 but got 0`，`path: ['strip',0,'maxChars']` | 只是可读性/格式差异，拒绝集合相同 |
| d | `maxScannedBytes: null`（YAML 里写了键但没给值） | **拒绝**：`maxScannedBytes 必须是 >= 1 的整数，或 Infinity（表示不限）` | **按"未配置"处理**，回落默认值 `4194304`（Schemastery 的 nullable→default 语义） | 兜底轨道把明显的配置笔误变成硬错误（更好）；Schemastery 轨道会静默用默认值 |

> 数值约束（`maxScannedBytes` 的"整数且 >= 1 或 `Infinity`"、`strip[].maxChars` 的"整数且 >= 1"）
> 在**两条轨道上都于配置校验阶段**被拒，见 4.1 / 4.3。

其它与最初 brief 不一致、以源码为准的地方：

* **`tools/execute` 刻意不用 `{ prepend: true }`。** brief 建议照搬 `dsh-spill-policy` 的
  `prepend: true` + `next()` 委托；但 `prepend` 会让我们排在 spill 策略**外面**，
  spill 就会先看到**未改写**的结果，并把未改写的超长文本写进 spill 落盘文件。
  改为默认（后注册）顺序后，我们位于 spill 的 `next()` 之内 ⇒ spill 看到的是改写后的结果，
  连落盘的预览里也不会有命中文本。规则形状仍然照搬 shipped 策略插件。
* **阻断走 `tools/pre-execute`，未额外注册 `ctx.tools.guard`。** guard 的价值是"单调拒绝、
  不受监听器顺序影响"；但瀑布里我们返回 `deny` 时同样会直接终止派发（`:3127-3139`），
  再注册一个 guard 只会让同一份参数被扫描两遍。若你所在的环境里有别的监听器会
  `next()` 后丢弃结果、把 deny 吞掉，再考虑补 guard。
* 两条轨道都有测试：兜底轨道在 `test/harness.mjs`，Schemastery 轨道在
  `test/config-schemastery.mjs`（临时探针目录里 link 出 `@deepseek-ai/*` 再 import）。

### 2.2 四条正确性结论与证据（本项目自检时逐条核过）

| 结论 | 证据 | 核对结果 |
| --- | --- | --- |
| ① 改写后的 value **必须**仍满足 `output.schema`；丢可选字段安全，丢 required 字段会让**整条调用**变成错误结果 | `dsh-tools/lib/index.js:3417-3418`（校验并抛 `ToolOutputError`）→ `:3226-3231`（转成终态错误结果）；`:454-455`（缺 required 键的报错文本）；`dsh-tool-web/lib/index.js:270-298`（`web_search` 的 required 只有 `sources`/`truncated`/`sources[].url`） | **符合**。`web_search` 的 `snippet`/`content` 都是可选的，所以 `stripDefaults` 合法；引擎对 required 键**拒绝执行**（默认 `onStripRefused: error` 直接降级为终态错误）。`test/registry-e2e.mjs` 里先用一条"故意返回缺 required 的 value"的监听器把 `INVALID_TOOL_OUTPUT` 实测出来，再证明 strip 走的不是这条路 |
| ② `presentationMeta` 由 value 重新派生 ⇒ 改 value 自动清干净持久化 meta | `dsh-tools/lib/index.js:3458` → `:3428-3436`（`presentationMeta(exec.arguments, value)`）；`dsh-tool-web/lib/index.js:303`（`presentationMeta: (_args, value) => searchMetaFromValue(value)`）与 `:103-124` | **符合**。`test/registry-e2e.mjs` 用**真正 shipped 的 `web_search`**（合成 `ctx.web` 后端，不联网）跑通：`result.meta.sources[0].snippet === undefined`、`meta.answer` 不存在，而 `url`/`truncated` 仍在 |
| ③ 失败结果不能替换 value | `dsh-tools/lib/index.js:3392`、`:3449-3455` | **符合**。strip 只作用于成功结果；失败结果仍走原有路径（正则改 content/error.message；一经重建就不带 meta） |
| ④ 与正则引擎的先后顺序必须明确 | 顺序理由见第 4.6 节 | **已定义：strip 先、正则后**。若反过来，一段 200 KB 的 snippet 会先吃掉扫描预算，strip 反而因 `truncated` 被跳过 —— 该丢的载荷就活下来了 |

---

## 3. 数据流（一次成功调用）

```
模型发起调用
   └─ agent-loop: appendToolCall()            ← 参数在这里就已经落盘（无法阻止）
        └─ tools.execute()
             ├─ tools/pre-execute  ← block 规则在这里 deny（工具体不运行）
             ├─ tools/execute      ← ★ 本插件：await next() 拿到规范化前的 result
             │                        · 成功：① strip 按字段路径丢弃/截断 value
             │                                ② 再对保留下来的字符串叶子跑正则规则
             │                        · 失败：重建 { isError, error, content }，丢弃 meta
             │                                （strip 不适用：失败结果没有 value）
             ├─ normalizeDispatchResult()      ← 校验 value（违约 ⇒ 终态错误）+ 重新 render + presentationMeta
             ├─ tools/post-execute             ← spill 等策略看到的是【已改写/已最小化】的结果
             └─ appendToolResult(tool/result)  ← content（由 value 派生）+ meta（由 value 派生）落盘
```

---

## 4. 配置

### 4.1 顶层字段表

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。`false` ⇒ 与未配置完全一样：不注册任何监听器。 |
| `rules` | Rule[] | `[]` | 内容改写规则，见 4.2。 |
| `strip` | StripRule[] | `[]` | 结构最小化规则，见 4.3。 |
| `stripDefaults` | boolean | `false` | `true` ⇒ 自动在 `strip` **之前**追加内置的 `web_search` 规则（丢掉 `sources.*.snippet` 与 `content` 答案）。 |
| `maxScannedBytes` | number | `4194304`（4 MiB） | 单次调用允许"扫描（正则）/保留（strip 截断）"的 UTF-8 字节上限。**整数且 >= 1**；YAML 写 `.inf`（`Infinity`）表示不限制。0 / 小数 / 负数 / 非数字 / `NaN` / `-Infinity` 都会在**配置校验阶段**被拒（不是等到运行期抛错）。 |
| `onBudgetExceeded` | `'partial'` \| `'error'` | `'partial'` | 预算用尽时的策略，见 4.4。 |
| `onUnsafeValue` | `'keep'` \| `'error'` | `'keep'` | 遇到无法安全遍历的节点时的策略，见 4.4。 |
| `onStripRefused` | `'error'` \| `'skip'` | **`'error'`** | strip 规则无法应用时（目标是 required 字段、`maxChars` 撞上非字符串或 `enum`/`const` 固定值）：`error` = 整条结果降级为终态错误；`skip` = 保留该字段并告警。默认故意是"响亮失败"：静默保留载荷等于策略失效。 |
| `notify` | boolean | `true` | 是否把"已改写/已截断/已最小化"的提示作为 plugin 来源的 user 消息追加给模型。**日志无论开关都只记计数**。 |

`rules: []` 与 `strip: []` **都**为空（或 `enabled: false`）⇒ 插件不注册任何监听器（真·真空操作）。

### 4.2 `rules[]` 字段（内容改写）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string（必填，非空） | — | 稳定标识。日志、通知、拒绝理由里**只**出现它，不出现匹配模式，更不出现命中文本。 |
| `match` | string \| `{ literal }` \| `{ regex, flags }` | — | 三选一。字符串等价于字面量。`regex` 缺少 `g` 时引擎自动补（改写与计数都要求全局匹配）。 |
| `action` | `'replace'` \| `'block'` | `'replace'` | `replace`：改写结果；`block`：命中**调用参数**即拒绝执行。 |
| `replacement` | string | `'[已移除]'` | 替换文本。**按字面量插入**（不做 `$&`/`$1` 展开，否则 `$&` 会把命中文本写回去）。 |
| `tools` | string[] | `[]` | 工具名过滤；空数组 = 所有工具。 |

### 4.3 `strip[]` 字段（结构最小化）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string（必填，非空） | — | 稳定标识，日志/通知里只出现它。与 `rules[].id` 各自独立去重，同 id 重复会拒绝装配。 |
| `tool` | string | `'*'` | 工具名；`'*'` = 所有工具。 |
| `path` | string（必填，非空） | — | **点分字段路径**，`*` 是**独立一段**的数组通配符：`content`、`sources.*.snippet`、`body.content`、`sources.*`。最多 32 段。 |
| `maxChars` | number（可选，**整数且 >= 1**） | — | 给了它 ⇒ **只截断**：目标字符串超过该长度（按 **Unicode 码位**计，不会切断代理对）时，只保留这么长的头部 + `[已省略]`。**不给** ⇒ **整字段丢弃**。0 / 小数 / 负数 / 非数字 在**配置校验阶段**被拒。 |

> **配置错误发生在哪一层。** `maxScannedBytes` 与 `strip[].maxChars` 的数值约束是
> **config 层的**：`Config` 校验（两条轨道）直接给出 issue，Cordis 的 `resolveConfig`
> 会抛 `ValidationError`，文案形如
> `invalid config:\n  - strip 规则的 maxChars 必须是 >= 1 的整数 (at strip.0)`
> （`cordis/lib/index.js:939-944` 组装文案、`:955-961` 校验并抛出）—— 报错点在**加载这一行**
> 的时候，且带字段路径。`apply()` 里还留了一道**兜底防线**（`resolveMaxScannedBytes` /
> `compileStripRules`），只有在你**绕过 Config 直接调用 `apply()`**（例如自己写脚本、
> 或未来有别的调用方）时才会抛错并拒绝装配。做法上：能被 schema 表达的就用 schema 表达，
> schema 表达不了的（正则能否编译、path 语法、id 是否重复）才留到装配期 fail loud。

#### 语义（每一条都有 schema 依据）

* **丢弃**（无 `maxChars`）：把该键从对象里删掉（数组元素用终止段 `*` 时会清空整个数组）。
  目标键在 schema 的 `required` 里 ⇒ **拒绝执行**（删了会让注册表在 `:3418` 抛
  `missing required property`，把一次成功调用变成错误）。`enum`/`const` **不阻止丢弃** ——
  它们约束的是"值"，不是"键是否存在"。
* **截断**（有 `maxChars`）：只对**字符串**生效；字段仍在、仍是字符串，而受支持的 schema
  子集里没有 `minLength`/`maxLength`（`:33-42`），所以**连 required 的字符串字段也可以截断**。
  目标不是字符串 ⇒ 拒绝（`non-string`）；目标被 `enum`/`const` 固定 ⇒ 拒绝（`pinned-value`）。
  长度没超过 `maxChars` ⇒ 一字不动（保持同一性快路径）。
* **目标不存在**：`web_search` 的 `content`/`snippet` 都是可选字段，没有就是没有 —— 记 `missing`，不改任何东西。
* **schema 不可知时**（工具查不到 / 路径不在 `properties` 里）：不误判 required，**放行**。
  真违约的话注册表会抛 `ToolOutputError` ⇒ 整条调用变成终态错误（响亮，不静默）。
* **预算口径**：strip 只对**保留下来**的字节记账（整字段丢弃记 0）。理由很实际：
  丢掉一个 4 MiB 的字段**不需要读取它的内容**，也不该被 `maxScannedBytes` 挡住。
  正则引擎仍按**扫描**的字节记账；两者共用同一个预算对象，`onBudgetExceeded` 对两者统一生效。
* **规则依次作用**：`stripDefaults` 的内置规则在最前，然后按你写的顺序；后一条看到的是前一条的结果。
* **失败结果不参与 strip**（`:3392`、`:3449-3455`）：它没有可替换的 value。
* **只有成功结果的 value 会被 strip**：`tools/ptc-dispatch-log` 那条接缝只拿得到 content 块
  （`:1235-1242`），strip 在那里无从下手（日志副本仍可由正则规则改写）。

### 4.4 预算、降级与"改写不了怎么办"

* **扫描预算**：正则引擎对每个字符串叶子按 UTF-8 字节记账；strip 只对保留的字节记账。
  用尽后**停止扫描/截断**，未处理的部分保持原样。
  * `onBudgetExceeded: 'partial'`（默认）：保留已处理部分的改动 + 一条 warn 日志（`notify` 时还会提示模型）。
    **注意**：它意味着"超出预算的部分不会被检查"，这是本策略唯一会静默放行的情况。
  * `onBudgetExceeded: 'error'`：整条结果降级为**终态错误结果**（`error.info.code = 'CONTENT_POLICY'`），
    原结果一个字节都不落盘。要"宁可失败也不放过"就选它。
* **无法安全遍历**（递归超过 256 层、出现非无损 JSON 节点等）：
  * `onUnsafeValue: 'keep'`（默认）：该子树原样保留，计入日志的 `unsafe` 计数。
  * `onUnsafeValue: 'error'`：整条结果降级为终态错误。
* **strip 规则无法应用**（required 字段 / `maxChars` 对非字符串 / `maxChars` 对 `enum`、`const` 固定值）：
  * `onStripRefused: 'error'`（默认）：整条结果降级为终态错误，理由里只有规则 id、路径与原因码
    （`required-field` / `non-string` / `pinned-value`），**不含任何被处理的内容**。
  * `onStripRefused: 'skip'`：保留该字段、写 warn 日志、并在通知里如实上报"有几处没能应用"。
* **schema 固定的叶子**（正则引擎）：输出 schema 用 `enum`/`const` 固定的字符串**一律不改写**
  （改写必然违约）。这些叶子计入 `pinned` 并在通知里说明。
* **策略自身抛错**：绝不把一次成功的工具调用变成失败 —— 保留原结果并 warn。

### 4.5 `web_search` 的可用示例

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: dsh-content-policy
  config:
    enabled: true
    notify: true
    stripDefaults: true          # ← 一键：丢掉 sources.*.snippet 与 content 答案
```

等价的手写版本（把内置规则展开，便于你按需加 `maxChars` 或改工具名）：

```yaml
- id: dsh-content-policy
  config:
    enabled: true
    strip:
      - id: web-search-snippet
        tool: web_search
        path: sources.*.snippet      # 第三方页面里的任意段落 —— 整段丢弃
      - id: web-search-answer
        tool: web_search
        path: content                # 模型生成的答案 —— 整段丢弃
      - id: web-fetch-body
        tool: web_fetch
        path: body.content
        maxChars: 2000               # body.content 是 required ⇒ 只能截断，不能丢
```

发生了什么（实测于 `test/registry-e2e.mjs`，用的是真正 shipped 的 `web_search`）：

| 通道 | 之前 | 之后 |
| --- | --- | --- |
| `result.value` | `{ content, sources:[{url,title,snippet,publishedAt}], truncated }` | `{ sources:[{url,title,publishedAt}], truncated }`（非法键被删掉，schema 仍合法） |
| `result.content`（出厂 `formatSearchOutput`） | 段落与答案都在 | 只剩 `- [A](https://…) — (2026-02-02)` |
| `result.meta`（出厂 `searchMetaFromValue`） | `sources[].snippet` + `answer` | 只剩 `sources[].url/title/publishedAt` + `truncated` |

要更进一步（连 `title`/`publishedAt` 也不想留）：加
`{ id: drop-title, tool: web_search, path: sources.*.title }`，或在 maxChars 模式下
`{ id: cut-title, tool: web_search, path: sources.*.title, maxChars: 60 }`。
**唯一丢不掉的是 required 的 `sources[].url` 与 `truncated`** —— 需要连它们都不进会话，
就只能用 `block` 规则拒绝这次调用（见 4.2），或者不装配 `web_search`。

### 4.6 顺序：**先 strip，后正则**（为什么）

1. **不能让"该丢的载荷"因为预算而活下来。** 正则引擎按扫描字节记账；如果它先跑，
   一段 200 KB 的 snippet 会先吃掉 `maxScannedBytes`，strip 随后因预算用尽被跳过（`truncated`），
   于是最该消失的东西留了下来。strip 先跑 ⇒ 大字段先出局（丢弃不记账）。
2. **省扫描。** 即将被丢弃的文本没必要再逐处匹配正则。
3. **代价（必须知道）**：**被 strip 掉的字段不再参与正则规则** —— 它们已经不在值里了。
   这正是本策略的意图：对无法预判的文本，宁可整段丢弃，也不试图在它里面做局部改写。
   保留下来的字段照常被正则规则改写。

### 4.7 与 `dsh-spill-policy` 的分工（该用哪个？）

两者**不冲突**，而且经常应该同时开：

| 维度 | `dsh-spill-policy` | 本插件的 `strip` |
| --- | --- | --- |
| 触发条件 | 最终结果 content 的 UTF-8 字节 > `maxInlineBytes`（本机当前 `4000`） | 命中你写的**字段路径** |
| 覆盖的结果形状 | **仅纯文本**：只要结果里有任何非 `text` 块就整体不处理（`dsh-spill-policy/lib/index.js:75-83`） | **结构化 value**：`web_search` 的 `sources[]`/`content`，以及任何带大可选文本字段的工具 |
| 处理方式 | 全文存进会话级 spill 文件，inline 换成头尾预览 + 定位符 | 字段整段丢弃/截断，**不留任何副本** |
| 持久化 meta | 不动 meta（它只重写 content 投影） | meta 由 value 重新派生 ⇒ 自动跟着变干净 |
| 失败结果 / `run_code` 日志副本 | 有专门的 arm（`:174-185`） | 不涉及（失败结果不能替换 value；ptc 接缝只有 content） |
| 你要读全文吗 | 想读：模型可以按定位符去读文件 | 不想读：内容对本次任务没有价值 |
| 组合效果 | 先 strip 掉大字段 ⇒ spill 通常**不会被触发**（结果本来就小了） | 同一结果上两者依次生效：strip 在内层（`tools/execute`），spill 在外层（`tools/post-execute`，`:156-172`） |

**一句话**：量大但你可能要看 ⇒ 调 spill；字段你根本不想要 ⇒ 写 strip 规则。

### 4.8 覆盖配置（重要：patch 是整体替换）

`cordis.patch.yml` 里的 `config:` 是按 id **整体替换**的（`dsh-app-boot/lib/index.js:102-105`），
不是深合并。所以覆盖时要把想保留的字段一并写全：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: dsh-content-policy
  config:
    enabled: true
    maxScannedBytes: 4194304
    onBudgetExceeded: partial       # partial | error
    onUnsafeValue: keep             # keep | error
    onStripRefused: error           # error（默认）| skip
    notify: true
    stripDefaults: true
    strip:
      - id: web-fetch-body
        tool: web_fetch
        path: body.content
        maxChars: 2000
    rules:
      - id: phone
        match: { regex: '1[3-9]\d{9}', flags: g }
        tools: [web_search, web_fetch]      # 留空数组 = 所有工具
      - id: aws-key
        match: { regex: 'AKIA[0-9A-Z]{16}' }
      - id: no-internal-host
        match: { literal: 'internal.example.com' }
        action: block                        # 命中参数即拒绝执行
```

> 注意：`stripDefaults: true` 会引入 id 固定为 `web-search-snippet` / `web-search-answer`
> 的两条规则。自己再写同 id 的规则会因"id 重复"拒绝装配；想改同名字段就换个 id
> （规则依次作用，第二条会看到第一条的结果，字段已被删则记 `missing`）。

---

## 5. 安装与验证

```bash
# 1) 装进某个 profile（相对路径会被锚定到你执行命令时所在的目录）
dsh plugin --profile <name> add ./dsh-plugin-content-policy

# 2) 确认这一层进了组合树（默认配置下你会看到 rules: [] / strip: []，即真空操作）
dsh --profile <name> --dump-config

# 3) 按 4.8 写你自己的 patch，再 dump 一次确认覆盖生效
dsh --profile <name> --dump-config
```

`package.json` 里的 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 就是 profile
把它认成 bundle 层（而不是普通依赖）的依据（`dsh/lib/plugin-*.js:25-33`、`:46-78`）。

**零依赖**：本插件只 import `node:crypto` 与自己的 `./lib/scrub.mjs`。
`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 只是 `optional` peer（用于类型/文档），
不装也不会在 import 阶段失败。

### 自测（4 个文件，全部用合成数据，不读任何真实会话）

```bash
node test/selftest.mjs            # 纯逻辑：正则引擎 + strip 引擎（无 Cordis 依赖）
node test/harness.mjs             # 插件契约（假 ctx：注册行为、返回值形状、降级路径、no-op）
node test/config-schemastery.mjs  # Schemastery 轨道的 Config（临时探针目录；缺安装目录则跳过）
node test/registry-e2e.mjs        # 对【真】@deepseek-ai/dsh-tools 注册表 + 【真】web_search 的端到端
                                  # 需要 DSH 安装目录：DSH_NODE_MODULES=<...>\dsh\node_modules
npm test                          # 依次跑上面四个
```

`test/registry-e2e.mjs` 里的 `web_search` 用例用一个**合成 `ctx.web` 后端**驱动真正 shipped 的
`web_search`（`dsh-tool-web`）：render 与 presentationMeta 都是出厂实现，全程不联网。

---

## 6. 这个插件**防不了**什么（务必读完）

1. **工具调用参数（`tool/call`）拦不住。**
   `dsh-agent-loop/lib/index.js:586` 的 `appendToolCall()` 发生在 `tools/pre-execute`
   **之前**，而且 `PreToolDecision` 的三种取值里没有"改写参数"（`dsh-tools/lib/types/index.d.ts:419-427`
   明确写着 "Input rewriting is excluded because arguments are already logged and presented"）。
   `action: 'block'` 只能拒绝执行、阻止结果产生；**参数本身早已入库**。
   参数里的敏感内容只能用 `dsh-plugin-redact` 事后处理。
2. **已经落盘的内容管不了。** 本插件只在 append 之前生效；历史日志里的内容请用
   `dsh-plugin-redact`（`/redact scan|plan|apply`）。
3. **已经发给 provider 的内容管不了。** 之前请求里出现过的内容已经在对方侧；本插件只影响
   从此刻起的后续请求。**strip 也救不了已经内联进上下文的那一份** —— 它只作用于新产生的结果。
4. **`tool/result` 之外的所有通道都管不了**，包括但不限于：
   * **工具自己写的文件**（`write`/`edit`/`bash` 落盘的任何东西）；
   * **spill 落盘文件**（`ctx.spillStore` 保存的超长结果副本）——本插件通过"在 spill 之内改写"
     让它的**上下文投影**是干净的，但 spill 文件里可能仍有原文（见 `dsh-spill-policy/lib/index.js:114-150`）；
     如果 spill 策略排在**我们之内**（更晚注册的 prepend），顺序就会反过来，见 2.1；
   * **子代理 / workflow 的文本**（`subagent`、`workflow` 的返回值与它们的会话日志）；
   * **模型自己的输出**（assistant 消息）、思考块、以及系统提示；
   * **`user/message`**（用户输入、注入的 context）；
   * **PT START/其他插件自建的事件**（`tool/ptc-dispatch-start` 等：本插件只改写
     `tool/ptc-dispatch` 那条日志副本的 content，而且**只对文本生效**，strip 在这条接缝上没有 value 可用）；
   * **工具自己写的 `finalizeContent`**：它在 `tools/post-execute` **之后**执行
     （`dsh-tools/lib/index.js:3426`、`:3257-3259`），如果某个工具的最后一公里投影是
     从**参数**重新拼 content，那里不受本插件影响（`tools/result` 是只读 emit，改不了）。
5. **strip 只能"整字段"，不能"只删段落里那半句"。** 需要精确切除就写正则规则 ——
   但那就回到"你必须事先能描述它"的前提，对"任意第三方段落"不成立。
6. **丢不掉的字段：required。** `web_search` 的 `sources[].url`/`truncated`、`web_fetch` 的
   `url`/`statusCode`/`body.kind`/`body.content`/`truncated` 都是必需的：整段丢弃会被拒绝，
   只能 `maxChars` 截断（`body.kind` 是 `const`，连截断都不行，会被拒绝）。
   `maxChars` 保留的**头部仍然进了会话** —— 它是"有界"，不是"清零"。
7. **schema 不可知时 strip 只能放行。** 工具查不到（别的 scope / 还没注册 / 没有输出契约）时，
   "这个键必需吗"无法判定。默认选择是放行，真违约时注册表会抛 `ToolOutputError`
   （`:3418`）把整条调用变成错误 —— 你会看到工具报错，而不是静默的非法值。
8. **`onBudgetExceeded: 'partial'`（默认）之内的"漏扫/漏截断"**：见 4.4。
   需要严格语义就设 `onStripRefused: error` + `onBudgetExceeded: error`。
9. **正则回溯风险由规则作者承担。** 引擎不对规则做超时保护；写 `(a+)+$` 这类正则会卡住调用。
   建议规则尽量具体、优先用字面量。
10. **不改写 `enum`/`const` 固定的字符串**（正则引擎）：这类字段里的命中文本会被**保留**（并在通知里计数）。
    这是"不破坏 schema"与"不留存"之间的取舍；需要强约束就把 `onUnsafeValue` 设成 `error`、
    或用 strip 把整个字段丢掉（丢弃不受 enum/const 限制）。
11. **它不加密、不做访问控制**，也不是密钥管理系统：它只是"在写入前把匹配到的文本换掉 / 把字段丢掉"。
    真正的秘密不应该进入工具结果。

---

## 7. 隐私与日志

* 被处理的文本**永远不会**被本插件打印、写日志或放进通知：日志里只有
  `工具名 + 规则 id + 计数 + 字节数`：
  * 正则：`content-policy: web_search 命中 aws×2, pii×1（共 3 处，扫描 4096 字节）`
  * strip：`content-policy: web_search 结构最小化 web-search-snippet×1, web-search-answer×1（丢弃 2 个字段/元素，截断 0 个字段，保留原样 0，目标不存在 0，保留字节 0）`
* 规则"无法应用"时只报**原因码**与**配置里的路径**（路径是你自己写的配置，不是被处理的内容）：
  `required-field` / `non-string` / `pinned-value`。
* 通知（`notify: true`）是形状为 `{ kind: 'plugin', plugin: 'content-policy' }` 的 user 消息，
  文本只含工具名、规则 id、计数与策略说明。
* 拒绝理由（`{ kind: 'deny', reason }`）同样只含规则 id 与计数。
* 终态降级错误带稳定 code：`error.info = { name: 'ContentPolicyError', code: 'CONTENT_POLICY' }`
  （会随 `tool/result` 的 `error` 字段持久化，便于 replay 与路由）。

---

## 8. 目录结构

```
dsh-plugin-content-policy/
├── package.json              # type/main/exports/files + dsh.bundle.patch
├── cordis.patch.yml          # 一个 - insert: 行（默认 rules: [] / strip: []，真空操作）
├── index.js                  # 插件本体：Config（双轨）+ 三条接缝 + strip/正则的编排
├── lib/scrub.mjs             # 纯函数引擎（正则 + 结构最小化；零依赖、零全局对象，可直接单测）
├── test/selftest.mjs         # 纯逻辑自测（合成数据）
├── test/harness.mjs          # 插件契约测试（假 ctx）
├── test/config-schemastery.mjs # Schemastery 轨道的 Config 校验（临时探针目录）
├── test/registry-e2e.mjs     # 对真注册表 + 真 web_search 的端到端测试（合成 web 后端，不联网）
└── README.zh.md
```

## 9. 许可

MIT。

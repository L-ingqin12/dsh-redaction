# dsh-plugin-content-policy

**预防式**内容策略：在 DSH 的工具结果被规范化、落盘、进入下一次 provider 请求**之前**改写它。

它是 `dsh-plugin-redact`（事后补救：原地脱敏已经写进 `session.vN.jsonl.zstd` 的日志）的**事前对应物**：
redact 擦掉已经留下的东西，本插件让不该留下的东西**根本没机会留下**。

规则驱动、内容无关：插件自己不认识任何敏感词，规则由你提供，引擎只负责"定位 + 改写"。

---

## 1. 为什么必须发生在 append 之前

一次 `session.append('tool/result', …)` 有两个后果，而且它们是**同一份数据**：

| 后果 | 证据 |
| --- | --- |
| 它成为持久日志里的一行 | `dsh-agent-loop/lib/index.js:703-712`（`session.append("tool/result", { turn, step, message, …result.meta })`） |
| 它是**将来每一次请求**里那条工具结果消息 | `dsh-session/lib/index.js:216`：`deriveEventMessage` 对 `tool/result` 直接 `return event.data.message`；请求由 `session.deriveMessages()` 折叠同一批事件得到 |

所以"事后脱敏"永远慢一步：内容在写入的那一刻就已经同时进了日志和（下一次请求的）上下文。
本插件把自己插在 `tools/execute` 瀑布里 —— 那是结果**被规范化之前**唯一的改写点。

---

## 2. 接缝表（每条都对着 shipped 源码核过）

| # | 接缝 | 源码位置 | 本插件怎么用 |
| --- | --- | --- | --- |
| 1 | `tools/execute` 瀑布 | 声明：`dsh-tools/lib/types/index.d.ts:49` | **主接缝**：包装器返回值会被注册表重新规范化 |
| 2 | 返回值规范化 | `dsh-tools/lib/index.js:3213-3214`（`waterfall('tools/execute', …)` → `normalizeDispatchResult`） | 我们返回的对象就是下游 `tools/post-execute` 看到的 `result` |
| 3 | 同一性快路径 | `dsh-tools/lib/index.js:3448`（`canonicalResults.get(result) === exec.token` ⇒ 原样返回） | 无命中时**按引用返回原结果** ⇒ 零开销、不二次渲染 |
| 4 | 成功结果从 `value` 重新派生 content | `dsh-tools/lib/index.js:3458` → `:3415-3426`（`createSuccessResult` → `tool.output.render(exec.arguments, value)`） | 我们**改写 `value`**，content 由注册表自己重算 |
| 5 | 成功结果从 `value` 重新派生 meta | `dsh-tools/lib/index.js:3428-3436`（`presentationMeta(exec.arguments, value)`） | 同上：meta 也自动跟着 value 变 |
| 6 | 只换 content 会留下旧 meta | `dsh-tools/lib/index.js:3401-3405`（`{...result, content}` 展开保留 `meta`） | **这是本插件改写 value 而不是 content 的原因** |
| 7 | meta 会被持久化 | `dsh-agent-loop/lib/index.js:708`（`...result.meta !== void 0 ? { meta: result.meta } : {}`） | 只换 content ⇒ 命中文本仍随 meta 落盘 |
| 8 | 同一段文本双通道的真实例子 | `dsh-tool-web/lib/index.js:62-79`（snippet 进 content）与 `:103-124`（同一 snippet 进 presentationMeta） | `web_search` 是最典型的"只擦 content 不够"案例 |
| 9 | 失败结果不能替换 value | `dsh-tools/lib/index.js:3392`（`tools/post-execute cannot replace the value of a failed result`） | 失败结果只能重建 content |
| 10 | 失败结果的 content/meta 逐字复制 | `dsh-tools/lib/index.js:3449-3455` | 返回自己的 `{ isError: true, error, content }` 并**省略 meta** ⇒ meta 被丢弃 |
| 11 | 失败结果持久化时的约束 | `dsh-session/lib/index.js:241-248`（`error` 存在时要求 `message.content[0].isError === true`） | 由 `createToolResultMessage` 依据 `result.isError` 生成，天然满足 |
| 12 | 参数在工具体运行前就已落盘 | `dsh-agent-loop/lib/index.js:586`（`appendToolCall`）早于 `:588`（`prepare`/`dispatch`） | 所以"阻断"**不能**阻止参数入库，只能阻止执行（见第 6 节） |
| 13 | `tools/pre-execute` 的 `{kind:'deny'}` | `dsh-tools/lib/index.js:3116-3139` | block 规则：命中参数即拒绝，工具体不运行 |
| 14 | `ctx.tools.guard(fn)` | `dsh-tools/lib/types/index.d.ts:620`（单调守卫） | 未使用：瀑布的 deny 已经终止派发；理由见第 7 节 |
| 15 | `tools/ptc-dispatch-log` 瀑布 | 声明：`dsh-tools/lib/types/index.d.ts:75`；消费：`dsh-tools/lib/index.js:1235-1251` | 兜底改写 `run_code` 子调用的**日志副本** content |
| 16 | 输出 schema 的受支持子集 | `dsh-tools/lib/index.js:33-47`（`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解）、`:195-206` | **只有 `enum`/`const` 能固定一个字符串** ⇒ 只需跳过这两类叶子，改写就不会破坏 schema |
| 17 | Cordis 的 Config 契约 | `cordis/lib/index.js:955-960`（`runtime.Config["~standard"].validate(config)`）、`:1630`（`Config: plugin.Config`） | 导出的 `Config` 必须实现 Standard Schema |
| 18 | patch 覆盖是**整体替换** | `dsh-app-boot/lib/index.js:70-105`（`target[key] = value`） | 覆盖 `config` 时要把字段写全（第 4 节） |
| 19 | 真空操作默认的约定 | `dsh-spill-policy/lib/index.js:104`（`if (maxInlineBytes === void 0) return`） | 未配置 `rules` ⇒ 一个监听器都不注册 |

### 2.1 与这份 brief 不一致的地方（以源码为准）

* **`tools/execute` 刻意不用 `{ prepend: true }`。** brief 建议照搬 `dsh-spill-policy` 的
  `prepend: true` + `next()` 委托；但 `prepend` 会让我们排在 spill 策略**外面**，
  spill 就会先看到**未改写**的结果，并把未改写的超长文本写进 spill 落盘文件。
  改为默认（后注册）顺序后，我们位于 spill 的 `next()` 之内 ⇒ spill 看到的是改写后的结果，
  连落盘的预览里也不会有命中文本。规则形状仍然照搬 shipped 策略插件。
* **Schemastery 采用双轨导出。** brief 要求"导出 Schemastery `Config`"。实测：
  插件以 `link:` 方式装进 profile 后，Node 从包的真实路径向上找 `node_modules`，
  而 `@deepseek-ai/*` 只存在于 DSH 安装目录里 —— 从插件目录**不可解析**
  （`ERR_MODULE_NOT_FOUND`，已实测）。所以 `index.js` 先 `try { await import('@deepseek-ai/schemastery') }`：
  能解析就用真正的 Schemastery schema；不能解析就退回本包内置的 Standard Schema 实现
  （字段与默认值来自同一张 `FIELDS` 表，不会漂移）。Cordis 只调用 `~standard.validate`，
  两条轨道行为一致。这样插件在任何装配方式下都能加载，而不是在 import 阶段就崩掉。
* **阻断走 `tools/pre-execute`，未额外注册 `ctx.tools.guard`。** guard 的价值是"单调拒绝、
  不受监听器顺序影响"；但瀑布里我们返回 `deny` 时同样会直接终止派发（`:3127-3139`），
  再注册一个 guard 只会让同一份参数被扫描两遍。若你所在的环境里有别的监听器会
  `next()` 后丢弃结果、把 deny 吞掉，再考虑补 guard。

---

## 3. 数据流（一次成功调用）

```
模型发起调用
   └─ agent-loop: appendToolCall()            ← 参数在这里就已经落盘（无法阻止）
        └─ tools.execute()
             ├─ tools/pre-execute  ← block 规则在这里 deny（工具体不运行）
             ├─ tools/execute      ← ★ 本插件：await next() 拿到规范化前的 result
             │                        · 成功：deep-walk result.value 的字符串叶子
             │                        · 失败：重建 { isError, error, content }，丢弃 meta
             ├─ normalizeDispatchResult()      ← 用我们返回的 value 重新 render + presentationMeta
             ├─ tools/post-execute             ← spill 等策略看到的是【已改写】的结果
             └─ appendToolResult(tool/result)  ← content（由 value 派生）+ meta（由 value 派生）落盘
```

---

## 4. 配置

### 4.1 字段表

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。`false` ⇒ 与未配置完全一样：不注册任何监听器。 |
| `rules` | Rule[] | `[]` | 规则列表。**空数组 = 真空操作**。 |
| `maxScannedBytes` | number | `4194304`（4 MiB） | 单次调用允许扫描的 UTF-8 字节上限。正整数；YAML 写 `.inf` 表示不限制。 |
| `onBudgetExceeded` | `'partial'` \| `'error'` | `'partial'` | 预算用尽时的策略，见 4.3。 |
| `onUnsafeValue` | `'keep'` \| `'error'` | `'keep'` | 遇到无法安全遍历的节点时的策略，见 4.3。 |
| `notify` | boolean | `true` | 是否把"已改写/已截断"的提示作为 plugin 来源的 user 消息追加给模型。**日志无论开关都只记计数**。 |

### 4.2 `rules[]` 字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string（必填，非空） | — | 稳定标识。日志、通知、拒绝理由里**只**出现它，不出现匹配模式，更不出现命中文本。 |
| `match` | string \| `{ literal }` \| `{ regex, flags }` | — | 三选一。字符串等价于字面量。`regex` 缺少 `g` 时引擎自动补（改写与计数都要求全局匹配）。 |
| `action` | `'replace'` \| `'block'` | `'replace'` | `replace`：改写结果；`block`：命中**调用参数**即拒绝执行。 |
| `replacement` | string | `'[已移除]'` | 替换文本。**按字面量插入**（不做 `$&`/`$1` 展开，否则 `$&` 会把命中文本写回去）。 |
| `tools` | string[] | `[]` | 工具名过滤；空数组 = 所有工具。 |

### 4.3 预算、降级与"改写不了怎么办"

* **扫描预算**：每个字符串叶子按 UTF-8 字节记账；用尽后**停止扫描**，未扫描的叶子保持原样。
  * `onBudgetExceeded: 'partial'`（默认）：保留已扫描部分的改写结果 + 一条 warn 日志（`notify` 时还会提示模型）。
    **注意**：它意味着"超出预算的部分不会被检查"，这是本策略唯一会静默放行的情况。
  * `onBudgetExceeded: 'error'`：整条结果降级为**终态错误结果**（`error.info.code = 'CONTENT_POLICY'`），
    原结果一个字节都不落盘。要"宁可失败也不放过"就选它。
* **无法安全遍历**（递归超过 256 层、出现非无损 JSON 节点等）：
  * `onUnsafeValue: 'keep'`（默认）：该子树原样保留，计入日志的 `unsafe` 计数。
  * `onUnsafeValue: 'error'`：整条结果降级为终态错误。
* **schema 固定的叶子**：输出 schema 用 `enum`/`const` 固定的字符串**一律不改写**（改写必然违约，
  注册表会在 `:3418` 抛 `ToolOutputError`，把一次成功调用变成错误）。这些叶子计入 `pinned`
  并在通知里说明。受支持的 schema 子集只有 `type/oneOf/properties/required/additionalProperties/items/enum/const`
  （`dsh-tools/lib/index.js:33-47`），所以"会不会破坏 schema"是一个**可判定**的问题，不需要引入校验器。
* **策略自身抛错**：绝不把一次成功的工具调用变成失败 —— 保留原结果并 warn。

### 4.4 覆盖配置（重要：patch 是整体替换）

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
    notify: true
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

---

## 5. 安装与验证

```bash
# 1) 装进某个 profile（相对路径会被锚定到你执行命令时所在的目录）
dsh plugin --profile <name> add ./dsh-plugin-content-policy

# 2) 确认这一层进了组合树（默认配置下你会看到 rules: []，即真空操作）
dsh --profile <name> --dump-config

# 3) 按 4.4 写你自己的 patch，再 dump 一次确认覆盖生效
dsh --profile <name> --dump-config
```

`package.json` 里的 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 就是 profile
把它认成 bundle 层（而不是普通依赖）的依据（`dsh/lib/plugin-*.js:25-33`、`:46-78`）。

**零依赖**：本插件只 import `node:crypto` 与自己的 `./lib/scrub.mjs`。
`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 只是 `optional` peer（用于类型/文档），
不装也不会在 import 阶段失败。

### 自测

```bash
node test/selftest.mjs        # 纯逻辑（合成数据，无 Cordis 依赖）
node test/harness.mjs         # 插件契约（假 ctx：注册行为、返回值形状、降级路径）
node test/registry-e2e.mjs    # 对【真】@deepseek-ai/dsh-tools 注册表的端到端验证
                              # 需要 DSH 安装目录：DSH_NODE_MODULES=<...>\dsh\node_modules
```

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
   从此刻起的后续请求。
4. **`tool/result` 之外的所有通道都管不了**，包括但不限于：
   * **工具自己写的文件**（`write`/`edit`/`bash` 落盘的任何东西）；
   * **spill 落盘文件**（`ctx.spillStore` 保存的超长结果副本）——本插件通过"在 spill 之内改写"
     让它存的是改写后的文本，但如果 spill 策略排在**我们之内**（更晚注册的 prepend），
     顺序就会反过来，见 2.1；
   * **子代理 / workflow 的文本**（`subagent`、`workflow` 的返回值与它们的会话日志）；
   * **模型自己的输出**（assistant 消息）、思考块、以及系统提示；
   * **`user/message`**（用户输入、注入的 context）；
   * **PT START/其他插件自建的事件**（`tool/ptc-dispatch-start` 等：本插件只改写
     `tool/ptc-dispatch` 那条日志副本的 content）；
   * **工具自己写的 `finalizeContent`**：它在 `tools/post-execute` **之后**执行
     （`dsh-tools/lib/index.js:3426`、`:3257-3259`），如果某个工具的最后一公里投影是
     从**参数**重新拼 content，那里不受本插件影响（`tools/result` 是只读 emit，改不了）。
5. **正则回溯风险由规则作者承担。** 引擎不对规则做超时保护；写 `(a+)+$` 这类正则会卡住调用。
   建议规则尽量具体、优先用字面量。
6. **`maxScannedBytes` 之内的"漏扫"**：见 4.3 —— 默认策略下超出预算的部分不会被检查。
   需要严格语义就设 `onBudgetExceeded: error`。
7. **不改写 `enum`/`const` 固定的字符串**：这类字段里的命中文本会被**保留**（并在通知里计数）。
   这是"不破坏 schema"与"不留存"之间的取舍；需要强约束就把 `onUnsafeValue` / 规则设计成
   让该工具整条降级为错误。
8. **它不加密、不做访问控制**，也不是密钥管理系统：它只是"在写入前把匹配到的文本换掉"。
   真正的秘密不应该进入工具结果。

---

## 7. 隐私与日志

* 匹配到的文本**永远不会**被本插件打印、写日志或放进通知：日志里只有
  `工具名 + 规则 id + 计数 + 扫描字节数`（例如 `content-policy: web_search 命中 aws×2, pii×1（共 3 处，扫描 4096 字节）`）。
  正常改写记在 `info`，异常路径（预算用尽、无法遍历、降级为终态错误、策略自身抛错）记在 `warn`。
* 通知（`notify: true`）是形状为 `{ kind: 'plugin', plugin: 'content-policy' }` 的 user 消息，
  文本只含工具名、规则 id、计数与策略说明。
* 拒绝理由（`{ kind: 'deny', reason }`）同样只含规则 id 与计数。
* 终态降级错误带稳定 code：`error.info = { name: 'ContentPolicyError', code: 'CONTENT_POLICY' }`
  （会随 `tool/result` 的 `error` 字段持久化，便于 replay 与路由）。

---

## 8. 目录结构

```
dsh-plugin-content-policy/
├── package.json          # type/main/exports/files + dsh.bundle.patch
├── cordis.patch.yml      # 一个 - insert: 行（默认 rules: []，真空操作）
├── index.js              # 插件本体：Config + 三条接缝
├── lib/scrub.mjs         # 纯函数引擎（零依赖、零全局对象，可直接单测）
├── test/selftest.mjs     # 纯逻辑自测（合成数据）
├── test/harness.mjs      # 插件契约测试（假 ctx）
├── test/registry-e2e.mjs # 对真注册表的端到端测试
└── README.zh.md
```

## 9. 许可

MIT。

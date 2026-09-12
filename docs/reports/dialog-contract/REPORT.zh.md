# dsh-tui `tuiDialogs` 契约核对报告 — `/redact pick`

核对对象（读时哈希）：
- `%USERPROFILE%\dsh-plugin-redact\index.js` — sha256 `C69599C1B9ADB18E296D50ED5F491183EBF2B7BCCF432445F7D78BD13EFCD6E6`，53112 B（**该文件在核对期间被改过两次**：52931→53112；`pick` 分支的请求形状未变，仅行号位移）
- `...\@deepseek-harness-tui\dsh-tui\lib\types\dsh-adapter\dialogs.js` — sha256 `83108BCEFA56C72EA27C182A360232B431EEDE584B6A262496EF160DA6A5CCF3`
- 部署只读：未改任何文件；未读 `~/.dsh/sessions`、`~/.dsh/storages`、任何 `*.jsonl.zstd`；未启动/重启 TUI；所有会话数据为内存合成。

---

## 0. 结论先行

1. **请求形状：完全被接受。** `select` 的 60 个选项（上限 100）、`title`、`id: String(n)`、`label`、`timeoutMs: 120000`，以及 `confirm` 的 `title/message/confirmLabel/cancelLabel`，逐条通过真实运行时的校验，无一条被丢弃、无一条被截断（实测最长 label 26 格、最长标题 107 格 < 120 格上限）。
2. **但可用性有一个"准入竞态"**：`TuiDialogRuntime` 在**校验之外**还有一道宿主守卫 —— 调用方必须是本 composition 中"已登记在册的活跃非 root 激活"（`requirePluginCaller` + `bindCallerEffect`）。若 redact 行的 fiber 在任何 dsh-tui 适配器模块安装 composition-root tracker **之前**进入 ACTIVE，则每次都只写一条 logger warning 并返回取消值 —— **面板根本不弹，`/redact pick` 静默回"已取消"**。离线冷启动模拟中两种结果都复现过（3 行批次 8/8 失败；4 行批次 6/6 成功），真实 boot（~290 行并发导入）无法离线判定 → **重启后必须自测一次**（第 3、6 节）。
3. **唯一会 throw 的路径**：适配器 shadow 策略（`DSH_TUI_ADAPTER_MODE=passive-shadow|replay-shadow`）在 `try/catch` **之外**同步抛错；插件已 try/catch，因此只会显示"对话框调用失败：…"，不会崩、不会带崩 TUI。拆机（teardown）路径不抛错（实测）。
4. `timeoutMs: 120000` 被**原样**使用（上限 24h）；缺省时 30000。无 TUI 消费者时请求一直挂在队列里，直到超时后返回取消值。

---

## 1. 运行时实现：`select` / `confirm` 的确切校验规则

实现：`lib/types/dsh-adapter/dialogs.js`（`TuiDialogRuntime`，`:176-299`）；清洗：`sanitize.js:19-46`；用量：`cleanScalarText` = `dialogs.js:30`。

| 项 | 规则 | 证据 |
|---|---|---|
| 常量 | `TITLE_CELLS=120`、`LABEL_CELLS=120`、`MESSAGE_CELLS=400`、`MAX_OPTIONS=100`、`DIALOG_DEFAULT_TIMEOUT_MS=30000` | dialogs.js:31-40 |
| title | `clean(title, 120)`；为 `''` → select 返回 `undefined`、confirm 返回 `false`，各写一条 warn | dialogs.js:221,237-240,255-259 |
| 非标量 title | `cleanScalarText` 对 object/array/null **返回 `''`**（不 `String()`）→ 走拒绝路径 | sanitize.js:42-46；实测 p1k |
| options 非数组 | 视为 `[]` → 拒绝（不抛） | dialogs.js:222 |
| 选项上限 | `rawOptions.slice(0, 100)` 静默截断（保留**前** 100 个） | dialogs.js:224；实测 p1h：200→100（id 1..100） |
| 选项 id | 必须是**非空字符串**，**原样保留**（不做清洗）；数字 id / 空串 → 该选项被**静默丢弃** | dialogs.js:225-231；实测 p1i |
| 选项 label | `clean(label,120)`；清洗后为空（含"只有控制字符"）→ 该选项被**静默丢弃** | dialogs.js:230-232；实测 p1i |
| 选项 description | `clean(desc,400)`，为空则**整个字段省略** | dialogs.js:233-235；实测 p1i（500 字符 → 400 格） |
| 全部选项被丢弃 / `options: []` | 等同"没有选项" → `Promise.resolve(undefined)` + `warn('…called without a title or options; cancelled')` | dialogs.js:237-240；实测 p1f |
| 控制字符 | 先删完整 ANSI/OSC 序列，再把 C0/C1（`\x00-\x1f\x7f-\x9f`）换成空格，`\s+` 折叠、trim，最后按**显示格**截断并加 `…` | sanitize.js:19-36；实测 p1j：`A ESC[31m B ESC[0m C`→`ABC`，`a\0b\ac\x9fd`→`a b c d`，`x\ny\tz`→`x y z`，200 个"中"+TAIL→60 字符+`…` |
| 宽度上限 | 按终端**显示格**（CJK=2），不是 `length` | sanitize.js:17,27-35 |
| confirm.message | `clean(400)`；`''` 时字段省略（渲染端不显示第二行） | dialogs.js:260,267；实测 p1l |
| confirmLabel/cancelLabel | **被采纳**，不是"必须省略"：`clean(label,120)` 后**总是**放进快照；空串时由渲染端回落到 i18n 默认 | dialogs.js:261-262,268-269；ExtensionDialog.js:103-106；实测 p1l |
| 非字符串 label | 数字/布尔 → `String()` 后清洗（`42`→`"42"`）；对象/数组 → `''` | sanitize.js:42-46；实测 p1m |
| 返回值 | select：只把 **字符串** 当选择，其余（含 cancel/timeout/teardown）→ `undefined`；confirm：`value === true` 才算 true，否则 `false` | dialogs.js:243,271 |
| confirm 默认焦点 | 面板 `focusIndex` 初始为 0 = **确认行**，直接回车即"隐藏" | ExtensionDialog.js:99,129 |

## 2. 失败行为：真的只 warning 不抛错吗？

| 情形 | 结果 | 证据 |
|---|---|---|
| 畸形/被拒绝的请求（缺 title、空 options、全被丢弃、非对象） | **不抛**，返回取消值 + 一条 warn（消息见下） | dialogs.js:237-248,255-276；实测 p1f/p1g/p1k/p1n |
| 无消费者（headless） | 请求入队 → 到超时（默认 30s / 插件传 120s）后 `undefined`；`TuiDialogStore` 无消费者时不报错 | dialogs.js:51-115；Chat.js:235（`extensionDialogs` 缺失时用惰性 store） |
| TUI 拆机（teardown） | `store.settleAll()` 把所有排队+活动请求以 `undefined` 结清，不抛 | dialogs.js:148-157,193；实测 p1o：promise 由 `still-pending` 变为 `undefined` |
| **唯一抛错路径** | `assertCapabilityShadowPolicy('host.dialogs.select'|'confirm'|'input', …)` 位于 `try` **之外**（dialogs.js:217/251/279）；在 `DSH_TUI_ADAPTER_MODE=passive-shadow` / `replay-shadow` 下**同步抛** `dsh-tui: shadow policy denies mutate in <mode> mode` | runtime.js:64-66（=mutate）、279-292、306-317；**实测**（shadow.mjs）：默认 `legacy` 不抛 → 返回取消值；两种 shadow 模式 3/3 同步抛错 |
| 非法 `DSH_TUI_ADAPTER_MODE` | 在**行构造期**就抛（`parseAdapterMode`），导致整个 `dsh-tui-extensions` 行挂载失败 → `ctx.get('tuiDialogs')` 为 `undefined` → 插件走"当前前端没有对话框服务"错误分支 | runtime.js:196-209；实测 |

warn 原文：`dsh-tui: tuiDialogs.select called without a title or options; cancelled` / `…confirm called without a title; cancelled` / 守卫失败时统一为 `dsh-tui: tuiDialogs.select received malformed data; cancelled`。

**插件侧影响**：`index.js:832-844,850-860` 两个 `await` 都在 `try/catch` 内 → shadow 抛错会变成 `{kind:'error', text:'对话框调用失败：…'}`，属于"看得见的失败"。**但准入失败不抛错，只会静默变"已取消"**（见第 3 节）。

## 3. 可达性：`ctx.get('tuiDialogs')` 到底能不能用？

**服务可达性 —— 有保证。** 三条独立证据：

1. 行归属：`package.json` 的 `dsh.profile.bundles = [dsh-base, dsh-tui, dsh-plugin-redact, dsh-plugin-content-policy]`（`profiles/dsh-tui/package.json:11-16`），全部合成到**同一个 cordis root**；没有 `isolate:` 行（唯一 isolate 出现在 preset 注释里）。
2. 注册方式：`dsh-tui-extensions` 行（`cordis.patch.yml:315-322`）的 `apply` 里 `ctx.plugin(TuiDialogRuntime)`（`dsh-adapter/extensions.js:43-51`）→ 服务注册在**同一 root 的 registry**（`Context[symbols.isolate]` 默认 label），任何同 root 的 sibling 行都能解析到。cordis 的 `ctx.get(name)` 会把**调用方 ctx** 绑成服务代理的 `ctx`（cordis `RegistryService.get` → `getTraceable(this.ctx, …)`，`lib/index.js:762-764`），因此与 `ctx.tuiDialogs` 语义一致。
3. 实测（`probe.mjs` p1/p0）：一个**没有 inject** 的 loose sibling 行在 handler 运行期 `ctx.get('tuiDialogs')` 拿到含 `select/confirm/input` 的对象，并且 `getHostDialogStore()` 能解出同一个 store；`Chat` 端渲染的正是这个 store（`dsh-adapter/plugin.js:1441` → `Chat.js:235`）。

**准入（guard）—— 条件性，且是本次唯一的实质风险。** `requirePluginCaller`（`host-access.js:631-652`）要求调用方 fiber 通过 `assertLiveContext`，其中 `trustedFibers.has(fiber)` 是关键（`host-access.js:553`）；该集合只在 `trackCompositionRoot` 装上 `internal/plugin`/`internal/status` 监听**之后**才被填充（`host-access.js:139-180`），而 tracker 是由**第一个构造服务的 dsh-tui 适配器模块**安装的（在本 profile 里最早的是 `dsh-tui-workspaces` 行 → `workspaces.js:37 compositionRoot(ctx)`）。此外 `bindCallerEffect` 失败会让 store **立即**以取消结清（`dialogs.js:103-111`、`host-access.js:418-447`）。

实测（全部在独立探针里跑真实代码）：

| 实验 | 结果 |
|---|---|
| 调用方行**晚于**服务行挂载 | `requirePluginCaller` OK、`bindCallerEffect` true、面板正常（p0d/p1a） |
| 调用方行**早于**服务行挂载 | `requirePluginCaller` 抛 `requires a live Cordis activation context`、`bindCallerEffect` false → 静默取消（p0b/p0d） |
| **root ctx** 直接调用 | 拒绝（"非 root 激活"），静默取消（p0c） |
| 真实插件、`commands` 已就绪且 redact 行先建 | **面板不弹**，返回 `{kind:'success', text:'已取消'}` + 一条 warning（p2k） |
| 冷启动批次 3 行（commands → workspaces[仅装 tracker] → redact） | `bindCallerEffect=false` **8/8** |
| 同进程多轮（模块已缓存）3 行 | 成功 0–1/10；把服务行提前建则 9–10/10 |
| 冷启动批次 4 行（commands → workspaces → dialogs → redact，含当前插件） | `trusted=true`、面板出现 **6/6** |

Loader 是**并发**创建各行的（`cordis-plugin-loader/src/config/group.ts:71` `Promise.allSettled(config.map(...))`），所以"谁先激活"取决于模块导入耗时：隔离测量 `@deepseek-ai/dsh-commands` 61–76 ms、`dsh-tui/workspaces`(首个 tracker 行) 24–30 ms、`dsh-tui/extensions` 181–243 ms、`dsh-tui/plugin-host` 381–421 ms、redact 11–16 ms；但并发竞争下排序会变（批次里实测 commands 与 workspaces 差值 ±5 ms 内翻转）。**结论：服务可达性是"保证"；能否通过准入是"条件性 / 时序相关"，我无法在不启动 TUI 的前提下证明真实 boot 落在哪一侧 —— 明确标记为未直接验证。**

**重启后 5 秒自测法**：`/redact pick`。若立刻（<50 ms）回"已取消"且**没有**出现面板，看日志里是否有 `dsh-tui: tuiDialogs.select received malformed data; cancelled` —— 有 = 输了准入竞态（功能整体不可用）；出现面板 = 一切正常。

## 4. 超时语义

`timeoutOf`（dialogs.js:211-215）：`typeof v === 'number' && Number.isFinite(v) && v > 0` → `min(floor(v), 86_400_000)`，否则 `DIALOG_DEFAULT_TIMEOUT_MS = 30_000`。计时器只在 `timeoutMs > 0` 时挂（store `:100-102`），触发即 `onAbort` → 从队列摘除、活动对话框关闭、promise 结清为 `undefined`（`false`）。

实测：`120000` → `[120000]`（p1a/p2f 的真实插件调用两次都是 120000）；不传 → `[30000]`；`250` → 258 ms 后返回 `undefined` 且队列清空；`25h` → 被夹到 `86400000`；`0 / -5 / '5000' / NaN / Infinity` → 全部落回 `30000`。**没有**比 24h 更低的上限，插件传 120000 完全合规。

无 TUI 消费者（headless / Chat 未挂载）：`ask` 照常入队，`getSnapshot()` 有人读才会渲染；没人读就一直挂到超时，然后插件拿到 `undefined` → 显示"已取消"（这是设计意图：`dialogs.d.ts:54-56` 明说 timeout 是给 headless 兜底的）。

## 5. 桩驱动清单（真实 `TuiDialogRuntime` + 真实插件，`probe.mjs` 全绿）

| 用例 | 驱动方式 | 插件/调用方收到 |
|---|---|---|
| 合法 select | `store.decide(key,'2')` | `'2'` → 插件隐藏 `items[1]`（p2a） |
| Esc 取消 select | `store.cancel(key)` | `undefined` → `{success,'已取消'}`（p1b/p2b） |
| select 超时 | 不驱动，等 250 ms | `undefined`，耗时 258 ms，队列清空（p1c） |
| 空 options | 直接调用 | `undefined` + warn（p1f） |
| 200 个 options | 直接调用 | 快照 100 个（id 1..100）；真实插件只发 60 个（p1h/p2d） |
| label 含控制字符 | 直接调用 | ANSI 删除、C0/C1→空格、折叠 trim；只有控制字符 → 该选项被丢弃（p1i/p1j） |
| confirm true / false / cancel | `decide(key,true/false)` / `cancel(key)` | `true` / `false` / `false`（p1l） |
| 缺 title / 非对象请求 | 直接调用 | 不抛，取消值 + warn（p1g/p1n） |
| teardown 时有挂起请求 | `store.settleAll()` | 全部 `undefined`，不抛（p1o） |
| 两个并发对话框 | 依次 decide | FIFO，A 后 B（p1p） |
| 无服务 | 不挂 dialogs 行 | `{error,'当前前端没有对话框服务 tuiDialogs …'}`（p2h） |
| 无 tool/result 节点 | 空 session | `{success,'…没有 tool/result 节点'}`，不弹面板（p2i） |

驱动脚本：`%TEMP%\dsh-dlg-probe\{register.mjs,hooks.mjs,probe.mjs,race.mjs,race2.mjs,shadow.mjs}`（`hooks.mjs` 只把 `@deepseek-ai/cordis` 映射到 dsh CLI 自带的那一份，其余全部 `import` 部署里的真实文件）。

## 6. 判定：请求形状 OK，但"能不能跑起来"要现场确认

**请求形状：接受。** 没有任何一条规则与插件的调用方式冲突：
- 60 ≤ `MAX_OPTIONS`(100)：不会截断；`id` 用 `String(n)` 正确（数字 id 会被丢）；`label` 只做清洗不做校验；`title` 107 格 < 120；`confirmLabel/cancelLabel` 被采纳（不是必须省略）；两个 `timeoutMs` 合法；`options` 恒为数组。

**必须改 / 建议改 / 保持现状**

- 【必须确认】重启后立刻跑一次 `/redact pick`：面板弹不出来（静默"已取消"+ 日志 warning）= 输了准入竞态。这不是请求形状问题，改字段救不了。
- 【必须改·若上一步失败】给 profile 的 `dsh-redact` 行加**行级 inject**（不是改插件代码）。在 `~/.dsh/profiles/dsh-tui/cordis.patch.yml` 里按 id 覆盖（注意：patch 语义是"整行 config 替换"，字段要写全）：
  ```yaml
  - id: dsh-redact
    inject: [commands, tuiDialogs]      # 行级依赖只用于排序，插件代码本身仍可软探测
    config:
      root: !!js dshHomePath('sessions')
      placeholder: '[已移除]'
      cacheRoot: !!js dshHomePath('storages')
  ```
  已验证有效：即使把 redact 行排到最前、`commands` 已就绪，加上 `tuiDialogs` 行级 inject 后面板 6/6 正常（p2l / race2 RACE_FIX=1）。
  **代价（已实测 p2m）**：如果 `dsh-tui-extensions` 行缺失，该 fiber 会永远停在 PENDING（state 0），命令**完全不注册** —— `/redact` 整个消失，退化成"命令不存在"，而不是"pick 不可用"。若想保留"没有 TUI 也能用"的降级特性，就得接受竞态，或走下面的"建议改"。
- 【建议改】把静默失败变成可诊断失败：`select` 若在 ~50 ms 内就返回 `undefined`（人类按 Esc 不可能这么快），把文案从"已取消"改成"对话框未弹出（宿主未接纳本行，请改用 /redact nodes）"。零成本、不动契约。
- 【建议改】`title` 的长分支已到 107 格（上限 120，余量仅 13 格）：`items.length` 到 6 位数、或将来加词就会吃 `…` 截断。建议压到 ~80 格以内。
- 【保持现状】选项数 60、`id: String(n)`、`label` 组合、`confirmLabel/cancelLabel`、`timeoutMs: 120000`、`try/catch` 包裹 —— 全部与真实契约一致。label 尾巴上的 `· 大小` 会被超长工具名（>~110 格）挤掉，属纯外观退化，不必改。
- 【提示】命令结果文案里会带**原样**的工具名（如 `Ba\u0007sh`，p2f 实测），因为 `cleanRenderText` 只作用于对话框字段；结果文本由渲染端再压成单行并清洗（插件头注释已说明），可接受。

## 7. 未能验证 / 明确标记

1. **真实 dsh-tui 进程里的行激活顺序**：未启动/未重启 TUI，也没有读取在跑进程的内部状态，因此"redact 行 vs 首次 tracker 安装"的真实先后**未经直接观测**；只给出可复现的模拟与"重启后自测法"。
2. 未在真实 TUI 里跑过 `pick`（无 TTY 交互），面板的键位/滚动/layout 只在代码层核对（`ExtensionDialog.js:88-96` 用 `listWindow` 窗口化，方向键可在 60 项间循环；`Chat.js:3585` 在有 approval 面板时对话框**不显示但仍挂起**；`:3701` 挂起时聊天键盘被让出）。
3. 插件文件在核对期间被改过两次，本报告基于 sha256 `C69599…`；若再次改动，第 1 节的结论（形状）仍然成立，但请重跑 `probe.mjs` 复核。

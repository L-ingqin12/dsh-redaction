# dsh-plugin-redact `/redact pick` 界面冻结 —— 根因与「不可能冻结」的设计建议

> 阅读对象：部署维护者。本文只读部署，未修改任何插件文件，未重启 TUI。
> 所有对 TUI 行为的断言都带 `文件:行号`。凡是我无法验证的，都明确标注「未验证」。
> 复现脚本在 `%USERPROFILE%\AppData\Local\Temp\redact-dialog-repro\`（临时目录，直接 `import` 部署里的真实模块）。

## 版本与哈希（结论只对这一版成立）

| 文件 | 大小 | 修改时间 | SHA256 |
|---|---|---|---|
| `dsh-adapter/dialogs.js` | 15334 | 2026-09-12 15:13:28 | `83108BCE…6A5CCF3` |
| `screens/Chat.js` | 216863 | 2026-09-12 15:13:28 | `2EC8C096…F06EEFDA` |
| `dsh-plugin-redact/index.js` | 57054→(调查期间被再次改动) | 2026-09-12 20:29 | 行号已随改动漂移 |

⚠️ **调查过程中 `dsh-plugin-redact/index.js` 被并发修改**（1164 行 → 1168 行）。本文引用的插件行号以最后一次读取为准（`pick` 分支在 846–9xx）。
运行环境：TUI 进程实际跑 Node v22.21.0（从 cordis 的报错栈可见），我的复现脚本跑在 v18.16.1——`TuiDialogStore` 是纯 JS、无版本敏感 API，结论不受影响。

---

## 一、冻结的精确机制

### 1.1 三个必须分开看的部件

**（1）promise 停在 store 里** — `dsh-adapter/dialogs.js:46-115`
`TuiDialogStore.ask()` 把请求推进 FIFO；`:164-169 advance()` 把它提升成 `this.active`；`getSnapshot()`（`:117-119`）返回 `this.active.snapshot ?? null`。
插件的 `dialogs.select({...})` 就是一个**永不主动结束的 promise**：只有 `decide(key,value)`（`:129`）/ `cancel(key)`（`:139`）/ 调用方超时（`:100-102`）/ `AbortSignal`（`:79-99`）/ `settleAll()`（`:148-157`）能结束它。

**（2）键盘被让出** — `screens/Chat.js:2566`
```js
if (questionSnapshot !== null || approvalSnapshot !== null || dialogSnapshot !== null)
    return;
```
这是 Chat 全局 `useInput`（注册于 `Chat.js:2447`）里的一条**无条件让出**：只要有对话框挂起，Chat 后续所有键（Esc / Ctrl+C / Ctrl+D / 所有快捷键）全部不再处理。

**（3）输入框被停用** — `components/PromptInput.js:2456`
```js
}, { isActive: !suspended });
```
`suspended` 来自 `Chat.js:3478-3483 promptReplacementOpen`，其中包含 `dialogSnapshot !== null`。
即：光标还在输入框里闪，但 `PromptInput` 的 `useInput` 是 `isActive: false`，**打字完全没有反应**——这正是「卡死不可操作」的主观体感。

### 1.2 面板唯一的挂载点

`Chat.js:3585`（提示槽 children 的三元链）：

```js
approvalPanelNode !== null ? (approvalPanelNode)
: dialogSnapshot !== null ? (<ExtensionDialog dialog={dialogSnapshot}
        onDecide={v => dialogs.decide(dialogSnapshot.key, v)}
        onCancel={() => dialogs.cancel(dialogSnapshot.key)} key={dialogSnapshot.key} />)
: overlay.kind === 'tips' ? … : … : questionPanelNode !== null ? (questionPanelNode) : null
```

**这是 `ExtensionDialog` 在整个 screens 树里唯一的实例化点**（`grep ExtensionDialog screens/Chat.js` 只有 import 行 28 与挂载行 3585 两处命中）。
→ 只要 `approvalSnapshot !== null`，**插件对话框永远不会挂载**，而 store 里的 `active` 依然存在。

**这是「面板不弹但仍挂起」的确切机制。**

### 1.3 (a) 「active 但未渲染」的全部状态

`Chat.js:3360-3495` 有 **10 条提前 return**，每一条都会让 3585 行整体不执行：

| # | 条件 | 行号 | 对话框是否仍挂起 |
|---|---|---|---|
| 1 | `interruptPanel !== null && screenOpen` | 3360 | ✅ |
| 2 | `pluginScene !== undefined` | 3378 | ✅ |
| 3 | `agentViewOpen` | 3388 | ✅ |
| 4 | `browserOpen` | 3408 | ✅ |
| 5 | `treeOpen` | 3421 | ✅ |
| 6 | `settingsOpen` | 3430 | ✅ |
| 7 | `subagentDetailId !== null` | 3436 | ✅ |
| 8 | `jobsPanelOpen` | 3452 | ✅ |
| 9 | `subagentDashboardOpen` | 3464 | ✅ |
| 10 | `sceneOpen`（轨迹屏） | 3492 | ✅ |
| 11 | `approvalPanelNode !== null`（在三元链里抢在 dialog 前） | 3585 | ✅ |

注意 #1 与 #5 的**不对称**：`interruptPanel` 自己会在有整屏时抢占整屏（3360-3363，注释在 3341-3352），而**对话框没有这条通道**——它只会被顶掉。

另外 `Chat.js:3506-3507` 还有一个次级分歧：`overlay.kind === 'permission'` 且三面板任一非空时，浮层不挂载（弹层消失），而键盘让出依旧生效。

### 1.4 (b)「键盘让出」到底是谁接管了

- 让出者：`Chat.js:2566`（Chat 的全局 `useInput`，注册在先 → 它先跑，先 return）。
- 接管者：**只有挂载在 3585 行的 `ExtensionDialog`**。它的三个子面板都用 `useInput(..., { isActive: true })`：`ExtensionDialog.js:87` / `:131` / `:249`，Esc/Ctrl+C 分支分别在 `:68` / `:114` / `:176` 调用 `onCancel()`。
- `PromptInput` 的监听器 `isActive: !suspended`（`PromptInput.js:2456`）= 停用。
- **除此之外没有任何兜底监听者**。Ctrl+C 也不会退出程序：整个 TUI 用 `exitOnCtrlC: false` 渲染（`dsh-adapter/plugin.js:1536`），App 级 Ctrl+C 退出被关掉（`ink/components/App.js:483-485` 只在 `props.exitOnCtrlC` 为真时生效），Chat 自己的 Ctrl+C 分支（`Chat.js:3250`）在 2566 行就被 return 挡掉了。

→ **面板没挂载时，没有任何组件能看到按键。这就是「不可操作」。**

### 1.5 (c) 是 handler 在 await，还是键盘让出？

**两个都是，而且是同一个根因的两面，不存在「先后」：**

- 键盘让出的判据是 `dialogSnapshot !== null`，而 `dialogSnapshot` 之所以非 null，正是因为 handler 还在 `await` —— **await 是让出的充要条件**。
- 反过来，handler 即使被放弃（比如插件热重载掉），只要 store 里的 `active` 没被清掉，键盘让出**依然成立**。所以修 handler 只能治标，清 store 才能治本。

用户观测到的「界面卡死」是第 1.1 节的 (2)+(3) 同时生效。若面板恰好挂载了，则只有 (3)，表现为「面板在、但输入框打字没反应」——仍然很像卡死。

### 1.6 (d) 15 秒超时真的能恢复输入吗？

**能，但要看清它恢复的是什么。**

路径（全部在 `dialogs.js`）：
```
:100-102  if (timeoutMs !== undefined && timeoutMs > 0)
              pending.timer = setTimeout(pending.onAbort, timeoutMs)
:79-98    onAbort()
            → this.queue.splice / this.active = null
            → pending.settle(undefined)
            → this.advance()          // :164-169
            → this.emit()             // :170-173
→ Chat 的 useSyncExternalStore 订阅者被唤醒（Chat.js:236）
→ dialogSnapshot 变回 null
→ Chat.js:2566 不再 return，PromptInput.js:2456 恢复 isActive: true
→ 下一次按键即被处理
```

实测（真实 `TuiDialogStore`，见下）：**15011 ms / 15026 ms 结算**，事件循环被同步阻塞 4 秒也只是推迟、不会丢。

但有三个必须说清的前提：

1. **store 层面没有「默认超时」这回事。** `ask()` 只认调用方传进来的 `timeoutMs`；不传就是**永久挂起**。默认值 30000 是**服务层**补的：`TuiDialogRuntime.timeoutOf()`（`dialogs.js:211-215`）把「缺失 / 非数 / ≤0」一律映射成 `DIALOG_DEFAULT_TIMEOUT_MS`（`:40 = 30_000`）。插件走的是服务，所以一定有定时器；同理插件配置里的 `dialogTimeoutMs: 0` 也**关不掉**服务层默认值（插件在 852-854 行自己先短路了，这是对的）。
2. **定时器是调用方的，不是 store 的不变量。** 谁直接 `new TuiDialogStore()` 并 `ask(..., undefined, undefined)`，谁就能造出永久挂起。本次事故不是这条路径，但它是同一类风险。
3. **恢复的只是「输入」**，不是插件逻辑。15 秒后 `select` 返回 `undefined`，插件走 888-897 行的「已取消」分支；如果此时 `confirm` 已经排上（不会，插件是串行的），还会再来一轮。

**结论：15 秒是「有界」，不是「修复」。** 而且它把一次交互变成一次 15 秒的全局键盘封锁——用户按 Esc、按 Ctrl+C、打字全部无效。

---

## 二、无 TTY 复现（真实模块）

三个脚本，全部 `import` 部署里的真模块，未复制代码：

- `repro-store.mjs` — 真实 `TuiDialogStore`
- `repro-render-matrix.mjs` — 渲染/键盘判据（**转写**，见下方声明）
- `repro-timer-and-observables.mjs` — 定时器与可观测面

### 2.1 停一个请求、永不 `decide`/`cancel`（节选真实输出）

```
[     4ms] A. store.ask(select, timeoutMs=15000) called
[     4ms]    getSnapshot().key      = dlg-1
[     4ms]    queue length           = 0  active!=null = true
[     4ms]    listeners (renderers)  = 1
[     7ms] B. t=0ms     snapshot=dlg-1/select  stillPending=true  emissions=1
[  5033ms] B. t=5000ms  snapshot=dlg-1/select  stillPending=true  emissions=1
[ 14045ms] B. t=14000ms snapshot=dlg-1/select  stillPending=true  emissions=1
[ 15247ms] B. t=15200ms snapshot=null          stillPending=false emissions=2
[ 15248ms] C. promise settled: value=undefined at 15011ms (asked at 0ms)
```

**调用方观测到的就是「永远 pending，直到超时」**；快照在整段窗口里都非 null → Chat 在这 15 秒里对每一个键都 return。

同一脚本还测到两个次要事实：

```
D. 错误 key 的 decide/cancel 什么都不做（仍挂起）
   after decide(<wrong key>) -> still pending: true
   after cancel(<wrong key>) -> still pending: true
E. 排队中的请求用的是**自己**的定时器
   active = A  queued = 1
   after 400ms: B settled as undefined | active is still A
   -> B 在从未被显示的情况下就被自己的 300ms 定时器取消了
```

D 说明**「只有渲染者能关闭它」**：`decide`/`cancel` 按 key 校验（`dialogs.js:129-146`），没挂载过的面板永远拿不到那个 key。这不是洁癖，是防 ConPTY 把一次 Enter 拆成 CR+LF 而误关后继对话框（注释在 `:120-136`），但副作用就是「唯一能解冻的人是那个没被渲染出来的面板」。

### 2.2 渲染 vs 键盘的分歧矩阵

⚠️ **声明：这不是 headless 挂载真实 Chat。** 原因：`Chat` 不在包的导出表里（`package.json exports` 只有 `.` / `./extensions` / `./scenes` / `./plugin-host` / `./api` …，没有 `./screens/*`），且组件需要完整 channel / themeHost / stdout，没有公开 API 可以无 TTY 挂载。
`repro-render-matrix.mjs` 把 `Chat.js` 里的**判据表达式逐条转写**（每条都标了 `文件:行号`），在状态空间上求值：

```
label                                                          mounted chatYields promptLive DEADLOCK
ideal: dialog parked, nothing else up                          true    true       false      no
A1 approval 面板已显示                                          false   true       false      YES
A2 approval + 整屏（interrupt 通道 3360）                        false   true       false      YES
B1 点 subagent chip（agentView 3388）                           false   true       false      YES
B2 /sessions 浏览器（browserOpen 3408）                          false   true       false      YES
B3 settings 屏（3430）                                          false   true       false      YES
B4 jobs 面板（3452）                                            false   true       false      YES
B5 插件 scene（3378）                                           false   true       false      YES
C 没有对话框挂起（对照）                                          false   false      false      no
D approval 面板、无对话框（对照：正常审批 UX）                        false   false      false      no
```

**7 个死锁态**：`dialogSnapshot !== null` 成立、`ExtensionDialog` 没挂载、`PromptInput` 停用 → 活性监听者为 0。

哪里仍未验证（明确标注）：
- B1–B5 需要「对话框挂起期间又打开了整屏」。键盘路径全被 2566 行挡住，所以**实际可达路径是鼠标**（`MessageList` 的行点击 / `NewMessagesPill` 等 `onClick` 走 `onOpenSubagent`/`onOpenJobs`，见 `Chat.js:3559` 的 `onOpenSubagent`、`onOpenJobs` 传参）**或异步事件**（后台请求触发 `channel.pluginScene`）。**「鼠标点击绕过键盘守卫」这一条我按代码推导，未做端到端点击验证**——但矩阵不依赖它是否可达：A1 只要有一个 approval 挂起就够了。
- A1 的可达性：`ApprovalStore` **没有任何超时**（全文 grep 无 `setTimeout`），只在 abort / 卸载时回收（`approvals.js:8, 312, 344-369, 405-416`），因此「审批面板长期挂着」是稳态。用户完全可能在审批没答的时候输入 `/redact pick`。

### 2.3 事件循环被阻塞时定时器还在吗

```
G. blocked the event loop for ~4010ms (21622644 spins)
   settled: undefined @ 15026ms -> 忙循环只会推迟、不会取消定时器
```

---

## 三、插件能否在弹窗前「探测到渲染者」？

**不能。可靠的前置检查不存在。**

我按四条线索逐个查了：

**(1) `dialogs.select` 的准入守卫**（`host-access.js:631-652 requirePluginCaller`）
它只能证明「本行是一个已登记的活跃非 root 激活」，**证明不了 15 秒后是否会有人渲染**。而且它与渲染无关：准入通过 → 请求进 store → 恰恰是这一动作造成了让出。插件的 `<50ms` 启发式（`index.js:890-895`）抓的是「准入直接被拒」，不是「准入通过但无人渲染」。

**(2) `getHostDialogStore(runtime)`**
它确实存在（`dialogs.js:319-328`），能取到活 store，而 store 的 `listeners`（`:47`，`subscribe()` 于 `:158-163`）**就是「有几个渲染者订阅了」这个信号本身**。
但：
- `dialogs.js:300-304` 明说该模块**故意不是包导出**；`package.json exports` 确认只有 `./extensions` 这个子路径，而它导出的是 `TuiDialogRuntime` / `TuiDialogStore` / `DIALOG_DEFAULT_TIMEOUT_MS`（`lib/types/extensions.js:17`），**不导出 `getHostDialogStore`**。
- 插件面（`ctx.get('tuiDialogs')` 拿到的 traceable proxy）的可见成员只有 `constructor, callContext, timeoutOf, select, confirm, input`（实测枚举 `TuiDialogRuntime.prototype`）——**没有 `getSnapshot` / `pendingCount` / `isRendered` / `availability`**。
- **即便拿到了 `listeners.size` 也没用**：Chat 恒定订阅（`Chat.js:236`），挂载期间订阅数一直是 1，无论面板会不会被渲染。实测已证：`listeners` 在「无人订阅」时是 0、订阅后是 1，与「面板可见性」无关。

**(3) 其他服务的可用性探测**
- `tuiStatus.registerView` 返回 `undefined` 表示被拒（`status.js:290-293` 注释、`:295-360` 实现）——**确实是一个可用的「我是否被宿主接纳」探针**，且与 `tuiDialogs` 共用同一套准入设施。但它只证明服务在、我被接纳，**不证明 Chat 的提示槽正在渲染**。
- `tuiToast.show()` 返回 `false` 说明**没有 sink**（`toast.js:39-41 hasSink()`、`:151`）——这是唯一「真的在生产链路里」的信号，但：① 要花掉一次真实 toast（用户可见的副作用）② sink 接的是 `channel.notify`，非 Chat 屏也在 ③ `hasSink()` 同样不在插件面。
- 我枚举了 `tuiDialogs` / `tuiStatus` / `tuiToast` / `tuiShortcuts` 的公开面，**没有 `ready` / `rendered` / `mounted` / `availability` 之类的信号**。

**(4) 即使探测成功也不够——TOCTOU**
让出条件是**渲染时刻**求值的，而 approval / 整屏可以在 `ask()` 之后任何时刻出现。任何「先探测、再弹窗」的方案都有一个无法关闭的竞态窗口。

**→ 结论：不要试图探测。这条缝的设计前提是「请求一定会被渲染」，而该前提在宿主代码里并不成立。**

---

## 四、有没有「不可能冻结」的非模态方案

先给判据，再逐个缝打分。**冻结的充要条件是「store 里出现 active」**（`dialogs.js:164-169` + `Chat.js:2566`）。所以：

> **不使用 `tuiDialogs` ⇒ 不可能冻结。**

| 缝 | 能否呈现可选列表 | 会否占住键盘 | 会否死锁 | 评价 |
|---|---|---|---|---|
| `tuiDialogs.select/confirm` | ✅ 多行、方向键、description | **会**（`Chat.js:2566`） | **会**（§2.2 七个态） | ❌ 本次事故来源 |
| `tuiToast`（`toast.js:93`） | ❌ 单行 ≤200 格、4s 自动消失、20 次/分限流 | 不会 | 不会 | 只能当「去看文件」的提示 |
| `tuiStatus.set`（`status.js:~180-281`） | ❌ 单行文本 | 不会 | 不会 | ✅ 只读提示可用 |
| `tuiStatus.registerView`（`status.js:295-369`） | ⚠️ 宿主 React 组件，`maxRows` 1–3、全局预算 6 行（`status.js:24-25`） | 不会 | 不会 | ✅ **可显示只读排行/计数**；但**它拿不到按键**，做不了「选择」（除非抢 `tuiShortcuts` 组合键，见下） |
| `tuiShortcuts`（`shortcuts.js:125 register`） | ❌ | 注册是组合键，`dispatch()` 同步、无返回值（`Chat.js:3328-3336` 火后不管） | 不会 | ✅ **可以做成「按键 N 直接执行第 N 条」**，但不适合带上下文的列表选择 |
| settings sections / scenes（`scenes.js:58 open`） | ✅ 能画任意界面 | **scene 是整屏替换**（`Chat.js:3378`），自己有键盘，不夺输入框 | 不会 | ⚠️ 可用但对「选一条日志」过重 |
| `tui/rewind-prompt` 决策事件 | ❌ 它**只由 `/rewind` 流程发起**（`channel.js:381-393 promptRewind`），插件不能主动触发 | — | — | ❌ 不是通用 UI 缝；且属 intercept 类，需 `~/.dsh-tui/extension-grants.json` 显式授权（该文件当前不存在），默认拒绝（`decision-guard.js:7`、`DECISION_EVENT_PERMISSIONS['tui/rewind-prompt']='session.rewind.intercept'`） |
| **完全绕开 TUI**（导出文件 / `present` / transcript 消息） | ✅ 编号清单 | 不会 | **不可能** | ✅✅ **推荐** |

### 推荐的「不可能冻结」设计（且几乎无需新代码）

**把「选择」拆成两次同步命令。**

1. `/redact nodes` —— **已经存在**（`index.js` 的 `nodes` 分支，带 `--full` 落盘到 `%TEMP%\dsh-redact-nodes-<id>.txt`）。它把编号清单打进 transcript，编号即序号。
2. `/redact hide <序号> --commit` —— **也已经存在**（`hide` 分支用 `lastNodes.get(session.id)` 把序号换成行号，`hideInSession(..., lineSpec)`）。
3. **handler 保持同步返回**（`callContext` 目前把 `pick` 包成 async IIFE，见 846-848 行）；**从不触碰 `tuiDialogs`**。

这样：promise 不会停在 store 里 → `dialogSnapshot` 恒为 null → 键盘让出永不触发 → **死锁在结构上不可能**，而不是「15 秒后有界」。

**为弥补「两段式」的可用性缺口，建议加一个持久化令牌（很小的一步，也很值得）：**
把 `lastNodes` 从内存 Map 改成**带 `surfaceEpoch` 的快照**（`{ epoch, items }`，`epoch = session.seq` 或 surface 节点集哈希）。`/redact nodes` 时记录 epoch；`/redact hide <n>` 时若 epoch 已变，就拒绝并提示「列表已过期，请重新运行 /redact nodes」。当前实现里 `lastNodes` 是内存态、且 `line` 由 `seq+2` 推得，跨命令引用存在漂移风险——加 epoch 校验后，两段式不但不会冻结，**语义也比现在更严密**。

**次选（想保留「一次命令内选完」的体验）**：把清单用 `tuiStatus.registerView` 渲染成 3 行富视图（只读、不夺键盘），再用 `tuiShortcuts` 注册 **1–3 号数字键**执行「隐藏第 N 条」。这需要把「候选清单」跨命令保存在插件里（`lastNodes` 已经在了），并且要处理「同时只允许一个待选清单」的语义。它能做到不夺键盘、不死锁，但复杂度明显高于方案 1，收益有限。

**不要做的事**：不要为了「探测渲染者」去深挖 `node_modules` 拿 `getHostDialogStore`。那既依赖非公开导出，又解决不了 §3(4) 的 TOCTOU。

---

## 五、如果用户此刻正卡住，什么能救

按实际有效性排序（全部给代码依据）：

| 手段 | 是否有效 | 依据 |
|---|---|---|
| **等 15 秒** | ✅ **有效，这是唯一无条件的自救** | `dialogs.js:100-102` 定时器 → `:79-98 onAbort` → `:170-173 emit` → `Chat.js:236` 重渲染 → `:2566` 不再让出 → `PromptInput.js:2456` 恢复。实测 15011/15026 ms |
| **Esc / Ctrl+C** | ⚠️ **只有面板真的挂载了才行** | `ExtensionDialog.js:68` / `:114` / `:176` 的 `onCancel()`。面板没挂载时这两个键**没有任何监听者**（`Chat.js:2566` 已让出，`PromptInput.js:2456` 已停用） |
| **Ctrl+C 想退出程序** | ❌ **无效** | TUI 以 `exitOnCtrlC: false` 渲染（`plugin.js:1536`），App 级退出被关（`App.js:483-485`）；Chat 的 Ctrl+C 分支（`Chat.js:3250`）在 `:2566` 被 return 挡掉。只有「渲染出来的面板」里的 Ctrl+C 有语义（取消对话框） |
| **切会话 / `/resume` / 重开会话** | ❌ **无效** | store 属于 `dsh-tui-extensions` 行的运行时，与 agent/session 无关（`dialogs.js:190-193`）；Chat 只是订阅者（`Chat.js:235-236`） |
| **重启 TUI** | ✅ 有效但没必要（要等 15s 就先等等） | 服务卸载 → `ctx.effect(() => () => store.settleAll())`（`dialogs.js:193`）→ `:148-157` 全部结算为 `undefined` |
| **再敲一次 `/redact pick`** | ⚠️ **不会延长**（好消息） | 第二次请求排在队列里，用的是**它自己的**定时器（实测 E 段）；但它会在第一个超时后**立刻变成 active**，于是键盘再被占住新一轮（第二个 15 秒），体感像「一直卡着」 |

**给卡住的用户的一句话**：什么都别按，等 15 秒；超时后回车/输入即可恢复。别按 Ctrl+C，它退不出去也取消不了。

---

## 六、结论与建议（按优先级）

**1️⃣ 应当移除对 `dialogs.select` / `dialogs.confirm` 的依赖（决定性建议）**
不是「默认禁用」，是**删掉这条路径**。理由：即使默认 L0 禁用，只要开关存在，用户在「有 approval 挂起」时打开它就必然复现一次全局键盘封锁；而配置项本身不会告诉用户「现在能不能安全开」。

**2️⃣ 最小改动（可立即执行，仅动插件、不动 TUI）**
- `index.js`：删除 `pick` 分支（846–9xx）里对 `dialogs.select` / `dialogs.confirm` 的两次调用与 async IIFE，让 `/redact pick` 直接返回一条同步提示（指向 `/redact nodes` + `/redact hide <n> --commit`）；或直接删掉 `pick` 子命令。
- `index.js`：删掉 `dialogTimeoutMs` 配置（587–595）与两处渲染提示里的 `canPick` 判断（原 973/996 附近：`ctx.get('tuiDialogs') !== undefined`）——**否则会继续向用户推荐一条已经不可能工作的路径**。
- `cordis.patch.yml:33-38`：`inject` 从 `[commands, tuiDialogs]` 改回 `[commands]`（硬依赖一个不再使用的服务，只会让插件在行缺失时静默 PENDING）；同时删掉 `dialogTimeoutMs` 注释块（20–32）。注意 patch 是**整行 config 替换**，三个字段要写全。
- 改完 **重启 TUI**（`inject` 变化不是热重载能可靠覆盖的）。

**3️⃣ 若要保留「一次选完」的体验**：用 §4 的次选方案（`tuiStatus.registerView` 只读清单 + `tuiShortcuts` 数字键），**不再触碰 `tuiDialogs`**。

**4️⃣ 给 TUI 上游的两个真实缺陷（本次调查的副产品，建议单独提 issue）**
- **tui 侧**：`Chat.js:3585` 让 `approvalPanelNode` 无提示地压掉 `ExtensionDialog`，而 `:2566` 已让出键盘 → 「active 但不可见、不可应答」。要么渲染对话框、要么拒绝 `ask`，不能两者都不做。
- **tui 侧**：`Chat.js:3360` 给 interrupt 面板开了「整屏抢占」通道，却没给对话框开；整屏期间对话框同样被吞。这是同一类不对称。

**判定表（明确表态）**

| 选项 | 结论 |
|---|---|
| 继续用 `dialogs.select` | ❌ **不行**。它把「15 秒全局键盘封锁」做成了一次正常交互的一部分 |
| 默认禁用（`dialogTimeoutMs: 0`） | ⚠️ **不够**。冻结被配置挡住，但机制仍在，且用户会以为「打开就有面板」 |
| 换机制 | ✅ **必须**。换成 §4 的两次同步命令 |
| 删除 `/redact pick` | ✅ **可接受**。功能等价物（`nodes` + `hide <n> --commit`）已经存在且在文档里有 |
| 缩短超时 | ❌ **不是修复**。1 秒和 15 秒都仍然是「按什么都没反应」 |

**一句话**：冻结不是插件的 bug，是「把 promise 停在一个不保证被渲染的 FIFO 里」这件事的必然代价；唯二的安全做法是**别把 promise 停进去**。

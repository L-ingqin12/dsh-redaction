# dsh-plugin-redact

**在 dsh-tui 里，原地脱敏 / 回退 DSH 会话日志（`session.vN.jsonl.zstd`）。**

不需要开新会话、不需要删整条会话、不需要把日志搬家：它在原文件上把指定的字节**改写掉**，并且让日志仍然能被读取端正常打开。

| 项 | 值 |
|---|---|
| 包名 | `dsh-plugin-redact` |
| 版本 | 0.1.0 |
| 许可 | MIT |
| 运行环境 | Node.js **>= 22.15.0**（依赖 `zlib.zstdCompressSync` / `zstdDecompressSync`） |
| TUI 内命令 | `/redact list\|nodes\|pick\|scan\|hide\|plan\|apply\|verify\|purge\|rollback\|undo` |
| 离线 CLI | `dsh-redact inspect\|paths\|verify\|plan\|apply\|cut\|graph` |
| 硬依赖 | 只消费宿主 `commands` 服务（`inject: ['commands']`），不发布任何服务；`/redact pick` 另需 TUI 行的 `tuiDialogs` **并且**要显式打开 `allowDialogs: true`（**默认关闭**，见 §2.5） |

---

## 0. 它解决什么问题

一段工具结果、一条命令输出、一次网页抓取——只要它进了会话，就会被持久化批次写进 `session.vN.jsonl.zstd`，从此**长期躺在磁盘上**：可能长期留在会话历史里被反复读回、被后续上下文继续引用、被索引或导出。内容本身未必是"密钥"：它可能是法律上不该留存的材料，可能是一段凭证，也可能只是**错的、过时的、不该继续影响后续判断的信息**——判断标准由你定，本工具只负责"把已经落盘的这些字节删掉或改写掉，并且不把日志弄坏"。

它做两件事：**改写**（把命中的文本/字段换掉，或把整行清空）和**剪除**（删掉末尾若干行，或在显式重编号的前提下删掉中间行）。改完之后，会话还能照常被打开、回放、继续追加。

还要分清四件不同的事——它们由四个子命令分别负责：

* **`/redact hide`** —— **立刻**把命中的工具结果从**当前会话的模型视野**里遮蔽掉（追加 `surfaceOp: {op:'replace'}` 替换节点）。下一轮请求起模型就看不到它，**不需要重启会话**。**磁盘字节不变。** 定位方式有三种：`plan.json` 里的 `find`、`/redact nodes` 列出的序号、或日志行号（见 §3.1）。想**先看到完整列表再挑**就用 **`/redact pick`**：它在 TUI 自己的面板里多行列出节点、用方向键选择，**不受 200 格单行限制**。面板里每条给的是**序号 / 日志行号 / 轮次 / 工具名 / 体积**，并在条目下方附上该次工具调用的**命令行**（受 `argsCells` 控制，可截断或彻底关掉）——这六类信息合起来才够你认出"是哪一条"（见 §3.2）。**工具结果的正文永远不显示。** ⚠️ `pick` **默认关闭**（`allowDialogs: false`）：模态对话框会让 TUI 让出聊天键盘，approval 面板挂起时必然卡住界面（见 §2.5）。要启用得显式配置；不启用时用 `/redact nodes` 看编号 + `/redact hide <序号> --commit`，功能完全不受影响。
* **`/redact apply`** —— 真正**重写磁盘上的日志字节**（原地改写，行数不变）。它要求该会话没有被占用（否则必须显式 `--allow-live`），所以更适合在会话关闭后用离线 CLI 做。
* **`/redact rollback <轮数>`** —— **撤回已经发生的对话**：按 `turn/end` 边界把最后 N 轮整体截断掉。这是"后缀删除"，也是最安全的一种删除。
* **`/redact undo`** —— **撤销我自己的脱敏**：从最新的隔离备份恢复（**装回前先校验备份**：帧可解码、头部合法、`seq` 密集、引用合法、无残帧；不合格就拒绝并指出可改用的更早备份）。

它们互补：`hide` 先止损（内容不再进入后续上下文）→ 会话关闭后 `apply` 把字节真正抹掉 → 出错了用 `undo` 从隔离备份回退。**只做 `hide` 的话，原文仍然完整地留在磁盘上。**

---

## 1. ⚠️ 先理解这一条：**删除中间行 = 整份日志打不开**

> [!WARNING]
> DSH 读取端有一条不可违背的约束：**每一行的 `seq` 必须等于它的行号减一**（0-based，第 1 行是头部行，不参与）。读取端解码时会逐行校验 `if (event.seq !== eventCount) throw ...`。
>
> 因此：**删除中间任意一行，都会让整份日志被判为损坏而拒绝打开**——不是"少一行"，是"整个会话打不开"。
>
> 反过来，**原地改写是安全的**：行数、行序、`type`、`seq`、`time`、交叉引用全部不变，对读取端完全透明。

所以脱敏的主力手段是**三种原地改写**，删除只是补充：

| 操作 | 做什么 | 结构影响 | 什么时候用 |
|---|---|---|---|
| `substitutions` | 在每个字符串值里替换命中的子串（可用 `path` / `lines` 限定范围） | 无：行数/`seq`/`type` 不变 | 同一段文字散落在多行多处（含工具结果、`meta`、参数回显），想一次性抹掉 |
| `setFields` | 把**某一行**上某个 JSON 路径的值整个换掉 | 无 | 已经用 `paths` 定位到确切位置，只想改那一处，其余保持原样 |
| `blankLines` | 把**这些行里所有字符串值**都换成占位符（默认 `[已移除]`） | 无：`type`/`seq`/`time`/`id` 等结构键不动 | 整行内容都要作废、但必须保留这一行（事件计数、turn 结构、工具调用配对不能少） |
| `dropLines` | **删除**这些行 | ⚠️ 有：行号会变 | 只在**末尾后缀**上安全（引用一律向后指）。删中间行必须同时给 `renumber: true` |
| `renumber` | 允许中间行删除：重编号所有 `seq`，并重映射所有向后引用 | ⚠️ 大 | 确实要"这一行不存在"、且能接受重写 `seq`。遇到**悬空引用**（有行引用了被删的行）时仍然会拒绝执行 |

只想抹掉内容时，优先用前三种；`dropLines` 是"确实要让这一行消失"才用的手段。

---

## 2. 安装

包有两种装法。**方式 A** 是常规做法（包声明了 `dsh.bundle`，装完自动成为该 profile 的一层）；**方式 B** 用于你自己手写行、或不想让它进 `bundles` 列表的场合。

### 2.1 方式 A：作为 bundle 安装（推荐）

```sh
# 从本地目录安装（相对路径先锚定到当前目录，再装进 profile）
dsh plugin --profile <name> add ./dsh-plugin-redact

# 或从 npm / git 安装
dsh plugin --profile <name> add dsh-plugin-redact
dsh plugin --profile <name> add github:<you>/dsh-plugin-redact#<commit>
```

`dsh plugin --profile <name> <args...>` 会先确保 profile 存在，然后把参数**转发给 pnpm**、工作目录就是 profile 目录——所以 `add` / `remove` / `why` / `update` 等 pnpm 动词都可用，并且要求 `pnpm` 在 PATH 上。因为本包声明了：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

安装成功后它会进入该 profile 的 `dsh.profile.bundles`，其 `cordis.patch.yml` 作为一层被应用（`- insert:` 一行 `id: dsh-redact`）。

### 2.2 方式 B：作为普通 profile 行挂载

编辑 `<DSH_HOME>/profiles/<name>/cordis.patch.yml`（这个文件才是用户层；同目录的 `cordis.yml` 是自动生成的空根，不要手改）：

```yaml
# 顶层 YAML 数组；没有 id 的 insert 会把行追加到顶层
- insert:
    - id: dsh-redact
      name: dsh-plugin-redact          # 裸包名：从 <profile>/node_modules 解析
      config:
        root: !!js dshHomePath('sessions')
        cacheRoot: !!js dshHomePath('storages')
        placeholder: '[已移除]'
```

两条必须注意的解析规则：

* **行里的包名必须能从 profile 的 `node_modules` 解析到**。裸包名由 Node 从 **profile 目录**开始向上查找（`<profile>/node_modules`、`<DSH_HOME>/profiles/node_modules` 等），所以要么先 `dsh plugin --profile <name> add ./dsh-plugin-redact`，要么把包装进 profile 的依赖里。**仅仅把包放在任意别的目录、然后用名字引用是找不到的。**
* **Windows 上写绝对本地路径必须是 `file://` URL**。加载器用动态 `import()` 解析 `name`；直接写 `C:\...\index.js` 会被当成协议名 `c:`，报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。用 `pathToFileURL` 生成，并且要指到**入口文件**（不是目录，目录会报 `ERR_UNSUPPORTED_DIR_IMPORT`）：

  ```sh
  node -p "require('node:url').pathToFileURL('C:/Users/me/dsh-plugin-redact/index.js').href"
  # => file:///C:/Users/me/dsh-plugin-redact/index.js
  ```

  也可以写相对路径（`./dsh-plugin-redact/index.js`），它相对**包含它的那个文件**（即 profile 目录）解析。

### 2.3 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `root` | `<DSH_HOME>/sessions` | 会话日志根目录，布局为 `<root>/<项目键>/<会话 id>/session.vN.jsonl.zstd` |
| `cacheRoot` | `<DSH_HOME>/storages` | 派生缓存根，`purge` 只在这里删文件 |
| `placeholder` | `[已移除]` | `blankLines` 清空一行时写入的占位符（`substitutions` 的 `replace` 默认是空字符串，即直接删除） |
| `argsCells` | `120` | 显示**工具调用命令行**的显示格预算（CJK 算 2 格）。命令行是"认出这是哪一条"的关键，但它自己也可能含敏感查询词，所以留了这个开关：**`0` = 完全不显示命令行**（清单文件与面板里一点痕迹都不留，连 `…` 都不会有）。只影响 `nodes full` 写出的清单与 `pick` 选项的 `description`；`nodes` 的单行通知**从不显示命令行**，不受它影响 |
| `dialogTimeoutMs` | `15000` | `pick` 两个对话框的 `timeoutMs`（毫秒）。它是"面板没被渲染时，界面最多不可操作多久"的上界（见 §2.5）；**`0` = 彻底禁用对话框**：`pick` 直接返回错误，**不会调用**对话框服务。默认值曾经是 120000（2 分钟），那是错误赌注——用户实际踩到过这个卡死 |
| `allowDialogs` | `false` | `pick` 的**模态对话框总开关，默认关闭**（理由见 §2.5）：把 promise 停进 `TuiDialogStore` 会让聊天键盘被无条件让出（输入框停用），而面板唯一的挂载点会被 approval 面板无提示压掉、approval 又没有超时——「有审批挂着时敲 pick」必然锁住键盘，连 `Ctrl+C` 都退不出，只能等超时。设 `true` 才启用 `pick`；关着时 `pick` 回一条说明并让你改用 `nodes` + `hide <序号>`。非布尔值直接抛错 |

`<DSH_HOME>` 未设置时取 `~/.dsh`。包自带的 `cordis.patch.yml` 使用部署自带的 `!!js dshHomePath(...)` 助手，和官方 `session-persistence-jsonl` 行完全一致，因此跟着 `DSH_HOME` 走。

**配置校验（在 `apply()` 里同步做，早失败早看见）：**

* **`config:` 留空（YAML 传进 `null`）或未提供（`undefined`）视同 `{}`**，六个字段各自取默认值。这一条是刻意的：否则一个空 `config:` 会中止整个 profile 的启动。
* **仍然拒绝**：非对象（字符串、数组）、以及 `root` / `cacheRoot` / `placeholder` 里**任何非字符串或空字符串**的值。错误长这样：`dsh-redact: invalid config: expected an object`、`dsh-redact: invalid config: $.root must be a non-empty string`。
* **两个数字字段必须是"非负整数"**：`argsCells` / `dialogTimeoutMs` 写成 `-1`、`1.5`、`'5000'`、`null` 都会在启动期抛错，且**不注册命令**：`dsh-redact: invalid config: $.argsCells must be a non-negative integer`、`dsh-redact: invalid config: $.dialogTimeoutMs must be a non-negative integer`。`0` 是合法值，而且有明确含义（分别是"不显示命令行"与"禁用对话框"）。
* **`allowDialogs` 必须是布尔值**：写成 `'true'`、`1`、`null` 都抛 `dsh-redact: invalid config: $.allowDialogs must be a boolean`（不注册命令）；不写就是默认的 `false`。
* **未知键只告警、不拒绝**（与平台自身的 config 语义一致，避免一个手滑的键名打断启动）：`dsh-redact: ignoring unknown config key(s): palceholder, extra`。告警走 `ctx.logger.warn`。
* 本包**不导出 Schemastery 的 `Config`**：以 `link:` 方式安装时，包自身的真实路径向上找不到 `node_modules`，`@deepseek-ai/schemastery` 不可解析（实测 `ERR_MODULE_NOT_FOUND`）。所以上面这套等价校验是在 `apply()` 里手写的。

### 2.4 确认它挂上了

```sh
dsh --profile <name> --dump-config     # 不用启动，直接打印合成后的配置
```

在输出里应该能看到 `id: dsh-redact` 这一行，并标注它来自哪个层。*（`--dump-config` 会顺带重写 profile 里那个空的 `cordis.yml`、并可能修复 `profiles/node_modules` 链接——两者都是幂等的。）*

`patchReload: live` 的 profile 里，改动 `cordis.patch.yml` 会热生效、新命令也会通过 `commands/change` 立刻进入 TUI 的 `/` 菜单；但**改动已经加载过的模块内容不会热更**，需要重启（或换文件名）。首次创建插件文件不需要重启。

### 2.5 `/redact pick` 是**可选项**、默认关闭：要启用得同时做两件事（**安装必读**）

> [!IMPORTANT]
> **`pick` 默认关闭（`allowDialogs: false`），这不是保守，是根因结论。** 把对话框的 promise 停进 TUI 的 `TuiDialogStore`，会让聊天**无条件让出键盘**（`Chat.js:2566`：questionnaire / approval / plugin dialog 挂起时输入框停用）；而对话框面板**唯一**的挂载点（`Chat.js:3585`）会被 approval 面板无提示压掉，approval 又**没有超时**——于是"有审批挂着时敲 `/redact pick`"必然锁住键盘，连 `Ctrl+C` 都退不出（`exitOnCtrlC: false`），只能干等超时。**唯一结构上安全的做法就是别把 promise 停进去**，所以默认路径是 `/redact nodes` 看编号 → `/redact hide <序号> --commit`（功能上没有任何损失）。
>
> 确实要用面板时，需要**两件事同时成立**：
> 1. **配置 `allowDialogs: true`** —— 模态对话框的总开关（默认 `false`）。没打开时 `pick` 直接返回下面这条，**连服务都不会碰**：
>    ```
>    pick 的模态对话框默认关闭（它会让 TUI 键盘卡住，且 approval 挂起时必然复现）· 用 /redact nodes 看编号，再 /redact hide <序号> --commit · 确要启用请设 allowDialogs: true 并自行承担风险
>    ```
> 2. **行级 `inject: [commands, tuiDialogs]`** —— 消除启动时序上的"准入竞态"（下一段）。包内自带的 `cordis.patch.tui.yml` 把这一步和上面那一步都写好了。

**为什么还需要行级 `inject`。** `tuiDialogs` 的运行时在 `try/catch` **之外**还有一道准入守卫：调用方必须是一个**已登记在册的活跃非 root 激活**（`@deepseek-harness-tui/dsh-tui` 的 `lib/types/dsh-adapter/dialogs.js:103-111`：`bindOwnerEffect(...)` 绑定失败就立刻 `pending.onAbort()`，Promise 直接以取消值收场；这份登记由 `TuiDialogRuntime` 构造时的 `compositionRoot(ctx)` 建立，同文件 `:185`）。若本行**早于**第一个安装该 composition-root tracker 的 dsh-tui 适配器模块进入 ACTIVE，每次 `select` / `confirm` 都只写一条 logger warning 就返回——面板不弹，用户只看到"已取消"。**加行级 `inject` 后，Cordis 会等该服务就绪再激活本行**，时序问题消失（实测：最坏顺序下面板从 0/6 变成 6/6 正常）。

**包内自带的那一层是 `cordis.patch.tui.yml`**（随包发布，`exports` 里也能解析到 `dsh-plugin-redact/cordis.patch.tui.yml`），它把行级 `inject` 和 `allowDialogs: true` 都写在那一行里。启用 `pick` 时你要的那一行长这样：

```yaml
# 启用 /redact pick 的那一行（行级 inject + 显式打开对话框）
- insert:
    - id: dsh-redact
      name: dsh-plugin-redact
      inject: [commands, tuiDialogs]
      config:
        root: !!js dshHomePath('sessions')
        placeholder: '[已移除]'
        cacheRoot: !!js dshHomePath('storages')
        allowDialogs: true
```

（包内 `cordis.patch.tui.yml` 里还有大段注释，解释准入守卫、代价、以及为什么**不要**用 `!!js` 的 `disabled` 自禁用守卫来"自动二选一"——`Entry.disabled` 是实时 getter，判据会随挂载进度翻转，实测会让整个 boot 中止。）

三种用法，任选其一：

1. **粘进你自己的 profile 补丁层**（推荐，最直观）：把上面那段 `insert` 复制进 `<DSH_HOME>/profiles/<name>/cordis.patch.yml`（包内文件与上面这段都已经把 `allowDialogs: true` 写在 config 里，照抄时别漏）。
2. **用 `--patch` 直接指到包内那个文件**：
   ```sh
   dsh --profile <name> --patch "C:/path/to/node_modules/dsh-plugin-redact/cordis.patch.tui.yml"
   # Windows 绝对路径要 file:// URL：node -p "require('node:url').pathToFileURL('C:/.../cordis.patch.tui.yml').href"
   ```
   该文件的 config 四字段齐全（含 `allowDialogs: true`），所以这一种用法**一步到位**；`--patch` 的多层会按顺序叠加。
3. **照抄**：只想要面板、不需要这个文件本身时，照抄上面那段即可。

三条实测确认的语义，能省掉不少返工：

* **行级 `inject` 是"追加"而不是"替换"**：模块静态声明的 `commands` 仍然生效（cordis 用 `Inject.resolve(entry.options.inject, fiber.inject)` 合并），所以 `[commands, tuiDialogs]` 里的 `commands` 是**重复声明、无害**——不用纠结要不要二选一。
* **`config` 是整行替换**（patch 命中即整个 config 换掉，不是深合并），所以那一行里要写全你想生效的字段——**这也是为什么 `allowDialogs: true` 必须写在这一行里**，别指望它从别处"继承"过来。
* 套用后可以用 `dsh --profile <name> --dump-config` 确认这一行的 `inject` 与 config（见 §2.4）。

> [!WARNING]
> **代价：只有在确定用 dsh-tui 前端、并且确实要那个面板时才套用这一层。** 若你的 profile 里没有 `tuiDialogs` 的提供者（非 TUI 前端、或 dsh-tui 那一行被 disable / 加载失败），本行会永远停在 PENDING（`state 0`），而启动器会把 PENDING 行升级为致命错误——**整个 profile 起不来**，不是单行静默失败。

**那为什么包自带的默认层 `cordis.patch.yml` 故意不写这个 `inject`？** 因为在**非 TUI profile（例如 web）上 `tuiDialogs` 根本不存在**：写进 `inject` 会让本行一直 PENDING，而 profile 启动把"依赖永远不满足的行"当致命错误——**整个 profile 起不来**。所以默认层保持**优雅降级**。

关闭（默认）与降级时的行为都写得很明确，不会静默失败：

* `allowDialogs !== true` → 上面那条"默认关闭"说明（`kind: error`），不碰对话框服务；
* 开了 `allowDialogs` 但 `dialogTimeoutMs: 0` → `对话框已被配置禁用（dialogTimeoutMs: 0）· 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件`；
* 开了 `allowDialogs` 但前端没有该服务 → `当前前端没有对话框服务 tuiDialogs · 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件`；
* 开了 `allowDialogs`、服务也在，但本行没被宿主接纳（准入竞态）→ 插件**用耗时识别**（人按 Esc 不可能在 50 毫秒内完成）：
  ```
  对话框没有弹出（0ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件
  ```
  二次确认框同理：
  ```
  确认框没有弹出（0ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact hide <序号> --commit
  ```

也就是说：**关着或降级时 `pick` 从不静默失败**——它会把"面板没弹"和"人真的取消了"（耗时长、回 `已取消`）分开报。`nodes` 尾部的 `选择 /redact pick · ` 提示**只在 `allowDialogs: true` 且 `tuiDialogs` 可用时才出现**，免得向你推荐一条已经关掉的路径。

---

## 3. 使用

### 3.1 `/redact` 子命令

`/redact` 只用**会话 id**（`--session <id>`），不用日志路径；不写 `--session` 时默认目标就是**当前会话**。它在 `/` 菜单里的参数提示串是 `[list|nodes|pick|scan|hide|plan|apply|verify|purge|rollback|undo] [plan.json] [--lines <n>] [--session <id>] [--commit]`。

`nodes` / `hide` / `pick` 三个子命令直接读写**活会话的内存 surface**，所以它们**只认当前会话**，`--session` 指向别的会话会直接报错（而不是悄悄显示当前会话）。

| 子命令 | 语法 | 输出 / 行为 |
|---|---|---|
| `list` | `/redact list` | 列出会话（按体积降序），**压成一行**：`共 N 个会话（按体积）：` + 若干段 `<id 前 8 位> <体积>`（人类可读写法，如 `1.5MB` / `805.4KB` / `551B`），段间用 ` ｜ ` 分隔，当前会话在该段末尾标 `(当前)`；按 200 显示格预算逐段收敛，放不下就接 ` …另M个`，末尾固定提示 ` 用 /redact nodes 看当前会话`。⚠️ 会话多到把预算吃满时，连这个末尾提示本身也会被截成 `用 /redact nodes …`。无参数时默认执行它 |
| `scan` | `/redact scan <plan.json> [--session <id>]` | **只定位，单行**：`会话 <id 前 8 位> · 共 N 行 · 命中 M 行：行号列表 · 未改动任何文件`。命中行号最多列 **8** 个，超出直接接 `…共M`（例：`命中 14 行：2,3,4,5,6,7,8,9…共14`）；命中 0 行时没有 `：行号列表` 这一段。计划里带 `substitutions[].lines` 时多一段 ` · 已按 substitutions[].lines 限定`。行数含头部行。⚠️ 它只用 `substitutions[].find` 作为探针：计划里只有 `setFields`/`blankLines` 时它无法定位，会报命中 0 行 |
| `nodes` | `/redact nodes [页号\|full]` | 列出**当前会话** surface 上的 `tool/result` 节点，**最新在前**。每条是 `[序号] 行号 轮T 工具 体积`，例如只有一页时：`共 3 个 tool/result（最新在前）：[1] 7 轮3 tool-2 149B ｜ [2] 5 轮2 tool-1 149B ｜ [3] 3 轮1 tool-0 149B 全文 /redact nodes full · 隐藏 /redact hide <序号>`。**分页**：按**显示格预算**切块（不是固定条数——固定条数会让"装不下的那几条"永远看不到）；多页时 head 变成 `共 N 个 tool/result（最新在前）第1/7页：`，未到底接 ` 续 /redact nodes 2（还有17条） · `，末页没有「续」只有 ` 全文 … · 隐藏 …`；只有一页时不写 `第x/y页`，head 直接以 `：` 收尾。**序号跨页连续**（20 个节点实测 7 页、序号 1..20 无缺口），所以任何一页看到的序号都能直接喂给 `hide`；页号越界自动落到最后一页。`T` 是 `tool/result` 事件**自己的** `data.turn`（拿不到就写 `-`），工具名用该结果的 `message.source.callId` 回到 `tool/call` 事件里对出来（对不上显示 `(未知工具)`）；体积 ≥1KB 写作 `12.3KB`。`nodes full`（或 `--full`）把**完整清单**写到 `%TEMP%\dsh-redact-nodes-<会话 id>.txt`，每行形如 `[1] 轮 3  tool-2  149B  行 7  {"cmd":"very-long-command-line-2","query":"SYNTHETIC-…"}  → /redact hide 1 --commit`（命令行经 `oneLine()` 压平并按 `argsCells` 截断；设 `0` 则整段省略、**不留占位符**），回复 `完整清单已写入 <路径>（共 N 条，序号可直接 /redact hide <序号>）`。**正文永远不显示**（识别元数据的完整说明见 §3.2）；列表按会话记住，供 `/redact hide <序号>` 引用。⚠️ **显式拒绝别的会话**：`nodes 只能列出当前会话的节点（surface 是活会话的内存状态） · 其它会话请用 /redact apply 处理其日志`。当 `allowDialogs: true` 且 `tuiDialogs` 可用时尾部多一段 `选择 /redact pick · `（两者缺一不提示） |
| `pick` | `/redact pick` | **在 TUI 面板里用方向键选**要隐藏的节点——这是「看到完整列表并直接选中」的正解，**不受 200 格单行限制**（对话框由 TUI 自己的 chrome 渲染）。⚠️ **默认关闭**：`pick` 的第一道判断是 `allowDialogs`（**默认 `false`**，见 §2.3/§2.5），关着时直接返回 `pick 的模态对话框默认关闭（它会让 TUI 键盘卡住，且 approval 挂起时必然复现）· 用 /redact nodes 看编号，再 /redact hide <序号> --commit · 确要启用请设 allowDialogs: true 并自行承担风险`，**连对话框服务都不会碰**；第二道是 `dialogTimeoutMs: 0`（回 `对话框已被配置禁用（dialogTimeoutMs: 0）· …`）；第三道才是服务探测（回 `当前前端没有对话框服务 tuiDialogs · …`）。启用后仍然**只给元数据**：先 `select`（多行列表，每条 label 形如 `[2] 行 5 轮 2 · tool-1 · 149B`，该次调用的**命令行**作为这一条的 `description` 显示在下一行；`argsCells: 0` 时整条 `description` 都不设），再 `confirm` 二次确认（标题 `隐藏 [2] 行 5 · tool-1 · 149B？`，正文 `隐藏后从下一轮请求起模型不再看到它（磁盘字节仍在）。该节点会被永久遮蔽，无法还原。`，按钮 `隐藏` / `取消`），确认后执行与 `hide` 相同的 surface 替换。成功：`已隐藏 [2] 行 5 · tool-1 · 下一轮请求起模型不再看到 · 磁盘字节仍在（会话关闭后用 apply 清理）`。**"面板没弹"与"人取消"是分开报的**：**人**取消（Esc / 超时，插件侧耗时 ≥ 50ms）回 `已取消`；`select` 在 **50ms 内**返回取消说明宿主没接纳本行 → `对话框没有弹出（0ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件`；确认框同理 → `确认框没有弹出（0ms 内直接返回取消）· 大概率是宿主未接纳本行（启动时序）· 改用 /redact hide <序号> --commit`（修法见 §2.5）。**只作用于当前会话**（`pick 只作用于当前会话；其它会话请用 /redact apply 重写日志。`）。**一次最多列 60 条**：超过时标题写明 `选择要隐藏的节点（共 70 个，仅列最新 60 个；其余用 /redact hide <序号>）`，不超过时是 `选择要隐藏的节点（共 N 个，最新在前）`。两个对话框都带 `timeoutMs: dialogTimeoutMs`（**默认 15000**）。对话框调用本身抛错回 `对话框调用失败：<原因>`；选到不存在的 id 回 `无效的选择：<id>` |
| `hide` | `/redact hide <序号\|plan.json> [--commit]`、`/redact hide --lines <行号> [--commit]` | **只作用于当前会话**，三种定位方式（见下）：① `<序号>` 引用**最近一次 `/redact nodes`** 的第 N 条；② `<plan.json>` 找出 `data.message` 里含 `substitutions[].find` 的 `tool/result` **表面节点**；③ `--lines <行号>` 按日志行号（就是 `nodes` 打印的那个行号）定位。不加 `--commit` 只试算（`试算：将隐藏 N 个节点（seq 5）· 加 --commit 执行`，或 `试算：未命中任何 tool/result 节点`；不写会话、不碰磁盘）；加 `--commit` 才逐个追加替换节点，并报告 `已隐藏 N 个节点 · 下一轮请求起模型不再看到 · 磁盘字节仍在（会话关闭后用 apply 清理）`（一个都没命中则是 `未命中任何 tool/result 节点，未做改动`）。⚠️ 多个目标**中途失败**时会把已生效的部分如实报出来：`第 2 个节点（seq 2）的消息形态不受支持（content 里没有可替换的文本块），未做改动 · 已有 1 个节点被永久遮蔽（seq 1），该变更已生效且不可撤销，建议重开会话`。**磁盘字节不变**，从下一轮请求起生效 |
| `plan` | `/redact plan <plan.json> [--session <id>]` | **试算，不写任何文件（单行）**：`试算 OK（未写盘） · <id8> · 行 删x/空x/改x/换x · 帧 留x/写x · 自检通过`。统计段只在计数 >0 时才追加 `/重编号x`、`/移除x`（例：`行 删0/空0/改0/换1 · 帧 留1/写3`） |
| `apply` | `/redact apply <plan.json> [--session <id>] [--allow-live]` | **就地执行（单行）**：记录文件修订号 → 读盘 → 试算 → 复查修订号（期间被追加过就整单拒绝）→ 写隔离备份 → 落盘 → 清理派生缓存。成功输出**把备份与「仍含原文」放在最前**（渲染端只保留前 200 格）：`已脱敏 sess-bet · 备份 session.v3.jsonl.zstd.quarantine-<时间戳>（仍含原文，确认无误后自行删除） · 行 删0/空0/改0/换0 · 帧 留1/写1 · 缓存清理 0 · 另有 7 处需自行处理（见文档 安全模型）`；`--allow-live` 且目标是当前会话时多一段 ` · 重开会话后内存历史才更新`。拒绝当前会话时把**出路放在最前**：`拒绝改写在用会话 sess-alp（写句柄仍持有该日志） · 加 --allow-live 可在本会话内执行（之后需重开会话） · 或切到其它会话后执行 /redact apply <计划.json> --session sess-alp`。`--allow-live` 时若日志尾部有**残帧**会拒绝执行（写句柄缓存着按改写前布局算出的截断偏移，可能造成静默损坏） |
| `verify` | `/redact verify [--session <id>]` | **单行自检**。通过：`✓ sess-alp · 帧 4 · 行 9 · 头部合法 · seq 密集 · 引用合法 · 读取端可打开`；不通过：`✗ <id8> · 帧 N · 行 N · 问题：<原因>`（此时 `kind` 也是 `error`；引用类问题报 `refs.reason`，否则报残帧/`seq` gap/解析失败行数）。帧头损坏时返回 `日志无法解析：<原因>` 而不是抛异常 |
| `purge` | `/redact purge [--session <id>]` | **单行**：`已清理缓存 N 个 · <id8>`；若还有本工具不动的副本，追加 ` · 仍有 N 处本工具不动：<第一个路径> 等`（只列路径，不读内容）。删除失败不改变命令成败，只在计数后加 `（失败 N：<第一个原因>）` |
| `rollback` | `/redact rollback <轮数> [--session <id>] [--commit]` | **按轮回退（单行）**：数出日志里的 `turn/end` 边界，把最后 N 轮整体截断（省略轮数时按 1 轮）。默认只试算：`会话 sess-rol · 共 3 轮 · 回退 1 轮 → 保留 2 轮 · 删 2 行（自第 6 行起截断） · 试算未写盘，加 --commit 执行`；加 `--commit` 才落盘，后接 ` · 备份 <文件名>（仍含原文，确认无误后自行删除） · 缓存清理 N`，再按是否当前会话给 ` · 重开会话后生效` 或 ` · 下次打开该会话即为回退后状态`。拒绝当前会话：`拒绝截断在用会话 sess-rol · 加 --allow-live 可在本会话内执行（之后需重开会话） · 或切到其它会话后执行 rollback 1 --session sess-rol`。至少要保留 1 轮；日志里没有 `turn/end` 时直接拒绝 |
| `undo` | `/redact undo [--session <id>] [--commit]` | **撤销上一次脱敏（单行）**：找出该日志**最新**的隔离备份。默认只试算：`sess-bet · 备份 session.v3.jsonl.zstd.quarantine-<时间戳>（271B）· 当前 271B · 试算未写盘，加 --commit 恢复`；加 `--commit` 才恢复，后接 ` · 已恢复（已校验） · 撤销前状态另存 <文件名> · 缓存清理 N`（此前先把**当前状态**另存为 `<log>.before-undo-<时间戳>`）。**装回前先校验备份**：帧可解码、头部合法、`seq` 密集、引用合法、无残帧，且事件数不少于当前日志；不合格则拒绝并**保持当前日志不动**：`拒绝恢复：备份 <文件名> 不合格（<原因>） · 当前日志未改动（185B） · 可改用更早的 .quarantine-* 或 .before-undo-* 备份手工恢复`。拒绝当前会话：`拒绝恢复在用会话 sess-u（写句柄仍持有该日志） · 加 --allow-live 可在本会话内执行（之后需重开会话） · 或切到其它会话后执行 /redact undo --session sess-u` |

#### 输出为什么是单行的（渲染约束）

dsh-tui **不会**直接把命令返回的 `text` 显示出来：它先走 `cleanRenderText(text, COMMAND_RESULT_CELLS)`，其中 `COMMAND_RESULT_CELLS = 200`（在 `@deepseek-harness-tui/dsh-tui` 里，常量在 `lib/types/screens/Chat.js:120`，调用点在同文件 `:1082`），实现在 `lib/types/dsh-adapter/sanitize.js`：

```js
const flat = withoutAnsi.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
if (stringWidth(flat) <= maxCells)
    return flat;
let out = '';
for (const ch of flat) {
    if (stringWidth(out + ch) > maxCells - 1)
        break;
    out += ch;
}
return `${out}…`;
```

两件事同时发生，而且都绕不过去：

1. **所有空白被压平**：`\n`、`\t`、连续空格全部变成一个空格——**多行文本到这里必然变成一行**。
2. **按 200 个显示格截断**，末尾补 `…`。宽度是终端显示格，**CJK 一个字算 2 格**，所以中文输出实际上只有约 100 个汉字的位置。

这是**硬约束，不是风格选择**——渲染端不会因为某个命令想多打几行就放宽。所以本插件干脆自己先做同一件事：`index.js` 里实现了一份同规则的 `clamp(s, 200)`（同样"CJK 算 2 格、超出用 `…` 收尾"），并在命令注册处用 `clampResult()` 包住整个 handler：

```js
handler: (invocation) => clampResult(handler(invocation)),
```

也就是说，**每条输出在离开 handler 之前就已经被收敛到 200 格以内**，不必等渲染端来砍。所以现在所有子命令的正常输出都是**单行**，字段之间用 ` · ` 分隔，最重要的信息在最前（只有少数很长的报错分支内部还是换行拼的，见下）。

结论，请照这个前提使用本工具：

* **不要指望可读的多行排版。** 任何超过 200 格的内容，尾巴一定被砍掉。连 `apply` / `rollback` 的成功输出也可能在备份信息之后就被截断——隔离备份的文件名很长。（这也是成功文案把备份与「仍含原文，确认无误后自行删除」提到最前面的原因。）
* **不要围绕"从通知里复制一长串东西"来设计操作。** 通知是压平 + 截断过的，长路径、长行号既可能已经被截掉，也不好选中。这正是 `hide <序号>` 存在的理由：跑完 `/redact nodes`，隐藏最新那条只要敲 `/redact hide 1 --commit`，**不用从通知里复制任何字符**。
* `list` / `nodes` / `scan` 会在预算内主动少列几条（`…另N个` / `…共M`）：宁可少列，也不让关键的行号被截掉。
* 少数很长的**报错**分支内部仍是用换行拼的字符串；它们一样会被 `clamp` 到 200 格、并在渲染时压成一行，所以你在屏幕上看到的永远是单行。

> [!TIP]
> **唯一的例外是 `/redact pick`，而且它正是为绕开这条约束而生。** 对话框走的是 TUI 自己的面板（`ctx.tuiDialogs`），由 TUI 的 chrome 渲染、TUI 自己掌管键盘，**不经过 `cleanRenderText`**——所以它可以多行、可以用方向键选、不会被压平或截断。要「在完整列表里挑一条」，用 `pick`；要在单行通知里定位，用 `nodes` + `hide <序号>`。两者互补，而且**都不会显示工具结果的正文**（只有序号/行号/轮次/工具/体积，以及 `pick` 里的命令行）。注意 `pick` **默认关闭**（`allowDialogs: false`，见 §2.5），打开后才有这条例外。

细节（都来自实现，不是约定）：

* **`rollback` 与 `undo` 默认都是试算**，必须显式 `--commit` 才落盘；`hide` 同理。`rollback` / `undo` 与 `apply` 一样都**拒绝作用于当前正在使用的会话**，除非显式 `--allow-live`；而 `hide` / `pick` 恰好相反——**它们只作用于当前会话**，`--session` 指向别的会话时直接报错，也不接受 `--allow-live`。

* **`nodes` 是分页的，`nodes full` 是导出。** 它只列**当前会话** surface 上的 `tool/result` 节点，**最新在前**（刚触发风控的几乎总是最近那条）。分页**按显示格预算切块**（不是固定条数）——固定条数会让「装不下的那几条」永远看不到；序号跨页连续，所以 `hide <序号>` 在任何一页看到的序号都能直接用。`nodes full` 把完整清单写到 `%TEMP%\dsh-redact-nodes-<会话 id>.txt`（用**完整** id 做文件名，避免两个会话互相覆盖），每行都带 `→ /redact hide <n> --commit`，命令行按 `argsCells` 截断（`0` = 完全不写命令行）。它**不显示正文**，也不暴露内部 `seq`（`seq` 只出现在 `hide` 的试算与半途失败文案里；清单文件与面板都只用**行号/序号**，因为那才是你能直接喂回命令的东西）。

* **`pick` 是「看到全部再选」的正解，但它默认关闭、且依赖 TUI 行。** 判断顺序是 `allowDialogs`（默认 `false` → 回"默认关闭"说明）→ `dialogTimeoutMs === 0` → `ctx.get('tuiDialogs')`。它软探测该服务——**默认不写进 `inject`**，所以缺这个服务时本插件不会被卡在等待态，只是 `pick` 返回降级提示；代价是启动时序最坏时面板可能静默不弹（插件用 <50ms 的耗时把它识别成专门的报错）。**要真正用上面板，需要 `allowDialogs: true` + 行级 `inject` 两件事**（见 §2.5）。服务契约见 `@deepseek-harness-tui/dsh-tui` 的 `lib/types/dsh-adapter/dialogs.d.ts`：`ctx.tuiDialogs` 是 `TuiDialogRuntime extends Service`，提供 `select` / `confirm` / `input`；每个方法都会**校验请求**（渲染路径上的不可信数据），请求不合法时**只 warning + 返回取消值**（`undefined` / `false`），**绝不抛异常**——「对话框不能把插件或 TUI 带下去」。该文件里 `DIALOG_DEFAULT_TIMEOUT_MS = 30000`（未给 `signal` 与 `timeoutMs` 时的兜底）；本插件对两个对话框都显式传 `timeoutMs: dialogTimeoutMs`（**默认 15000**，原先的 120000 已废弃 —— 理由见 §2.3 与 §2.5）。`select` 返回选中的 `id`，取消时 `undefined`；`confirm` 返回布尔，取消时 `false`；两者本插件都当作「已取消」——但**耗时 < 50ms 的取消不算"人取消"**：那说明宿主没接纳本行（准入竞态），插件会回专门的报错，见 §2.5。另外该运行时对每个请求都有上限（`TITLE_CELLS` / `LABEL_CELLS` = 120 格、`MESSAGE_CELLS` = 400 格、`MAX_OPTIONS` = 100 条），所以插件自己先把标题压在 ~90 格、选项截到 60 条，避免被宿主静默裁掉。

* **匹配文本写进 `plan.json`，不要写在命令行上。** 命令注册时设了 `recordInput: false`，所以 `rawInput` 不会进会话日志；但前端自己的输入历史（`~/.dsh-tui/history.jsonl`）不看这个开关，所以命令行上打出来的字仍可能留下。
* `--session <id>` 是**会话 id**。同一个会话若同时存在 `session.v2.jsonl.zstd` 与 `session.v3.jsonl.zstd`，只会命中**版本号最高**的那一份。
* 目标会话找日志的顺序：遍历 `<root>/<项目>/<id>/`，取 `session.vN.jsonl.zstd` 中版本号最高者；找不到时报 `找不到会话 <id> 的日志`。
* 参数按 `"..."` / `'...'` / 空白切分，**外层引号会被剥掉**——所以含空格的路径用引号包起来即可（`/redact apply "C:\my plans\plan.json"`）。相对路径仍相对宿主进程的工作目录解析，建议一律用绝对路径。
* **`hide` 只处理 `tool/result` 节点**（用户消息、助手消息不参与），替换文本固定用配置里的 `placeholder`，所以**计划里的 `replace` 对 `hide` 无效**。定位方式有三种：
  * `<序号>` —— 引用**本会话最近一次 `/redact nodes`** 的第 N 条，`1` 就是最新那条。这份列表只存在内存里、按会话保存：没跑过 `nodes` 就 `hide 1` 会报 `还没有节点列表，请先运行 /redact nodes`，序号越界报 `序号 99 超出范围（当前 1-2）`，宿主进程重启后失效。
  * `<plan.json>` —— 把 `data.message` 序列化后做子串匹配，只认 `substitutions[].find`（其余键一概不看）。
  * `--lines <行号>` —— 按**日志行号**定位，也就是 `nodes` 打印的那个行号（第 1 行是头部行，事件行 `seq` 对应行号 `seq + 2`）。支持行号串：`--lines 7`、`--lines 3-5`、`--lines 3,5-7`。这一种**完全不需要 plan.json**，所以原文一个字都不用落到任何文件里。
  * 三种都不给时报 `用法：/redact hide <序号|plan.json> 或 /redact hide --lines <行号>`；`--lines` 必须带值（写成 `--lines --commit` 会被当成光杆旗标，等于没给）。`--session` 指向别的会话时报 `hide 只作用于当前会话；其它会话请用 /redact apply 重写日志。`
* `--allow-live` 必须写成**光杆旗标**。写成 `--allow-live yes` 会得到字符串 `'yes'`，不满足 `=== true` 的判断，仍然会被拒绝。
* 未知子命令返回 `未知子命令 <cmd>` 加用法；既没有 `agent` 也没有 `--session` 时报 `无法确定目标会话，请加 --session <id>`。用法串本身也已经改成单行：`用法：/redact list|nodes|pick|verify|purge|undo（可加 --session <id>） · scan|plan|apply <计划.json> · hide <序号|计划.json|--lines 行号> · rollback <轮数> · 写操作需 --commit；匹配文本写在计划文件里，别写命令行`。

### 3.2 识别元数据：怎么认出「是哪一条节点」

用户最常问的一句话是"**根本看不出来是哪条消息需要撤回或修改**"。所以 `nodes` / `nodes full` / `pick` 现在都补齐了同一组识别元数据——**序号 / 日志行号 / 轮次 / 工具名 / 体积 / 该次工具调用的命令行**。工具结果的**正文**永远不出现（这是本工具的承诺），但这六项合起来足够你认出目标。

四个真实样例（全部来自合成夹具，不是真实会话；第 3、4 条例外——`pick` 要先设 `allowDialogs: true` 才会走到对话框）：

```
1) /redact nodes 的单行通知（最新在前；每格 [序号] 行号 轮T 工具 体积）
共 3 个 tool/result（最新在前）：[1] 7 轮3 tool-2 149B ｜ [2] 5 轮2 tool-1 149B ｜ [3] 3 轮1 tool-0 149B 全文 /redact nodes full · 隐藏 /redact hide <序号>

2) /redact nodes full 写出的清单文件（每行一条，末尾直接给出可复制的 hide 命令）
[1] 轮 3  tool-2  149B  行 7  {"cmd":"very-long-command-line-2","query":"SYNTHETIC-SEARCH-TERM-…  → /redact hide 1 --commit
[2] 轮 2  tool-1  149B  行 5  {"cmd":"very-long-command-line-1","query":"SYNTHETIC-SEARCH-TERM-…  → /redact hide 2 --commit

3) /redact pick 的选项：label 是识别信息，description 是命令行（面板里分两行显示）
[1] 行 7 轮 3 · tool-2 · 149B
{"cmd":"tool-2","q":"Q-2"}

4) /redact pick 的二次确认框（把要隐藏的那条再念一遍）
隐藏 [2] 行 5 · tool-1 · 149B？
```

每个字段从哪来（都出自 `index.js` 的 `collectNodes()`）：

| 字段 | 来源 | 拿不到时 |
|---|---|---|
| 序号 `[N]` | `surface.nodes` 里**最新在前**的位次，和 `/redact hide <序号>` 用的是同一套编号 | 一定有 |
| 行号 `<行>` | `tool/result` 事件的 `seq + 2`（第 1 行是头部行，事件 `seq` N = 日志行 N+2）；`--lines <行号>` 认的就是它 | 一定有 |
| 轮次 `<T>` | `tool/result` 事件**自己的** `data.turn`——用它和你界面上看到的"第几轮对话"对上 | 写作 `-` |
| 工具名 | 用 `message.source.callId` 回到 `tool/call` 事件取 `data.name` | `(未知工具)` |
| 体积 | `JSON.stringify(event.data.message).length`，人类可读（`1.5KB` / `551B`） | 序列化失败时 `?` |
| 命令行 | 同一个 `tool/call` 事件的 `data.arguments`（**只有字符串形态才取**，其它形态当作没有），经 `oneLine()`：控制字符→空格、空白压成单行、再按 `argsCells` 显示格截断 | 整段省略（`nodes full` 不留占位符，`pick` 不设 `description`） |

怎么用：**先看轮次**缩小到"哪一轮"，**再看命令行**确认是不是那个动作，**最后用序号**动手（`/redact hide <序号> --commit`），全程不用复制任何东西、也不会把原文带进命令历史。

> [!TIP]
> **命令行是"认出这是哪一条"的关键，但它本身也可能含敏感查询词**——所以有 `argsCells` 这个开关：默认 `120` 显示格，调小更保守，设 `0` **完全不显示命令行**（清单文件与面板里连 `…` 都不会有）。另外注意 `nodes` 的**单行通知从来不含命令行**（只有序号/行号/轮次/工具/体积），所以这个开关只影响 `nodes full` 的清单文件与 `pick` 的 `description`。

> [!NOTE]
> 轮次直接取 `tool/result` 事件**自己的** `data.turn`；只有工具名与命令行需要回查同一 `callId` 的 `tool/call` 事件。另外，`nodes full` 的清单行是"轮次在前、行号在后"（`轮 3  tool-2  149B  行 7  …`），而 `nodes` 通知里是"行号在前、轮次在后"（`[1] 7 轮3 tool-2 149B`）——两处**字段顺序故意不同**：通知的 200 格预算更紧，行号是喂给 `--lines` 的第一手信息，所以排在前面。

### 3.3 `plan.json` 完整字段

同一份计划文件在 TUI 内 `/redact` 和离线 `dsh-redact` 之间完全通用。

| 键 | 类型 | 说明 |
|---|---|---|
| `substitutions` | `[{ find, replace?, path?, lines? }]` | `find` 必须是非空字符串（否则报错）。`replace` 省略时为 `''`，即**直接删掉**。`path` 是点分路径前缀，限定只改这棵子树下的字符串；`lines` 限定行范围。递归处理所有字符串值，但**跳过受保护键** |
| `setFields` | `[{ line, path, value }]` | `line` 是 1-based 逻辑行号（不能是 1）；`path` 必须已存在，否则报 `第 N 行上找不到路径 ...`；写入值可以是任意 JSON 值 |
| `blankLines` | 行号串，如 `"830-834"` | 把这些行里**所有字符串值**换成 `blankPlaceholder`（TUI 内由 `placeholder` 配置提供，默认 `[已移除]`） |
| `dropLines` | 行号串 | 删除这些行。**后缀**直接放行；**中间行**必须同时给 `renumber: true`，否则报错拒绝 |
| `renumber` | `true` / 省略 | 允许中间行删除：重编号 `seq`，并重映射 `surfaceOp.startSeq/endSeq`、`sourceEventSeqs`、`data.shadowedSeqs`、`data.shadowedRange`。引用到被删行时**拒绝执行**并提示改用 `blankLines` |
| `keepTorn` | `true` / 省略 | 默认 `false`：文件尾部若有**残帧**（写到一半的未完成帧），重写时会被丢弃（`inspect` 会用"尾部残帧起点"告诉你有没有）。置 `true` 则原样保留这段残字节 |

行号串格式：`"812"`、`"812-830"`、`"812,900,1024-1100"`（逗号分隔，可混用区间）。行号是 **1-based 的逻辑 JSONL 行号，第 1 行是头部行**。

**受保护键**（`substitutions` 会跳过、`setFields` 拒绝写入）：`type`、`seq`、`time`、`surfaceOp`、`sourceEventSeqs`、`toolCallId`、`callId`、`role`、`id`。它们承载结构、顺序与交叉引用。

**第 1 行（头部行）永远不能被删除、清空或改写。**

> [!WARNING]
> 计划里**写错的键会被静默忽略**（引擎只读上面这几个键）。一个拼错的 `"substitions"` 不会报错，只会什么都不做，让你以为已经抹干净了。**每次执行前都要先试算，执行后都要复验。**

`/redact hide <plan.json>` 只使用 `substitutions[].find`（其余键一概不看），所以同一份计划可以既拿来 `hide`、又拿来 `apply`；而 `hide --lines <行号>` 与 `hide <序号>` 连计划文件都不需要。

### 3.4 一个可用的 `plan.json` 例子

> 下面全部是**占位文本**。真实使用时，把 `find` 换成你要抹掉的那段原文——这份文件本身也是敏感文件，用完请自行删除。

```json
{
  "substitutions": [
    { "find": "PLACEHOLDER-SECRET-VALUE", "replace": "[已移除]" }
  ],
  "setFields": [
    { "line": 812, "path": "data.message.content.0.text", "value": "[已移除]" }
  ],
  "blankLines": "830-834"
}
```

写这份文件的工作流：

1. 先用 `dsh-redact inspect <log> --match-file needle.txt` 找出命中行号（把原文写进 `needle.txt`，**不要写在命令行上**；`inspect` 只输出行号，不会回显文本）。
2. 用 `dsh-redact paths <log> --line 812` 看清该行的 JSON 结构——它只列**路径与类型**（`data.message.content.0.text  =  string(len=26)`），不列值。把它输出的路径填进 `setFields[].path`。
3. 只想按行粗暴作废就用 `blankLines`；想精确定点就用 `setFields`；同一段文字散落多处就用 `substitutions`。

### 3.5 离线 CLI

会话**没有在运行**时，用离线 CLI 更省事（`.mjs` 也可以直接用 `node lib/engine.mjs <子命令>` 运行；`bin` 里注册的名字是 `dsh-redact`）。它接受**日志文件路径**，不是会话 id。

| 子命令 | 语法 | 说明 |
|---|---|---|
| `inspect` | `dsh-redact inspect <log> [--frames] [--match-file <f> \| --match <s>]` | 结构统计：文件/字节数/完整帧数/尾部残帧起点/逻辑总行数/无校验和的帧数；`--frames` 追加逐帧表（帧号、字节区间、明文字节、行数、逻辑行区间）；`--match-file` 或 `--match` 追加命中行数/行号/涉及帧。只输出行号与计数 |
| `paths` | `dsh-redact paths <log> --line <n> [--no-keys]` | 打印该行的 JSON 结构（路径 + 类型 + 长度），不打印值；`--no-keys` 隐藏对象的键名 |
| `verify` | `dsh-redact verify <log>` | 结构 + `seq` 密集性自检。**退出码 0 = 正常，2 = 有问题** |
| `plan` | `dsh-redact plan <log> --plan <plan.json>` | 试算，不写文件 |
| `apply` | `dsh-redact apply <log> --plan <plan.json> [--out <f>] [--apply]` | 默认把结果写到 `<log>.new`（**不动原文件**）；加 `--apply` 才先写隔离备份、再就地替换 |
| `cut` | `dsh-redact cut <log> --drop <行号串> [--renumber] [--apply]` | 删行的快捷方式。⚠️ 中间行必须加 `--renumber`，否则直接报错退出 |
| `graph` | `dsh-redact graph <sessionsRoot>` | 递归扫描该根目录下所有 `session*.jsonl.zstd`，只解头部帧，输出 id / parent / seeded / origin / depth / 文件路径——看清会话谱系，避免漏掉分叉出去的副本 |

每个子命令一个例子：

```sh
# 1) 结构 + 命中定位（不打印文本）
dsh-redact inspect "$LOG" --frames
dsh-redact inspect "$LOG" --match-file ./needle.txt

# 2) 看清某一行能改哪里
dsh-redact paths "$LOG" --line 812

# 3) 结构自检（有问题的文件不要动）
dsh-redact verify "$LOG"

# 4) 试算：只打印统计，不写任何文件
dsh-redact plan "$LOG" --plan ./plan.json

# 5) 执行：先落 <log>.new 供检查；确认后再 --apply 就地替换（会先写隔离备份）
dsh-redact apply "$LOG" --plan ./plan.json
dsh-redact apply "$LOG" --plan ./plan.json --apply

# 6) 删行：中间行必须显式重编号
dsh-redact cut "$LOG" --drop 812
dsh-redact cut "$LOG" --drop 812 --renumber --apply

# 7) 会话谱系
dsh-redact graph "$DSH_HOME/sessions"
```

`plan` / `apply` / `cut` 的执行统计长这样（字段含义见 §1 与 §3.3）：

```
试算结果（未写任何文件）
字节 原 / 新   : 532 / 539
保留帧(原字节) : 1
重写帧 / 移除帧: 3 / 0
删除行 / 清空行: 0 / 1
路径改写 / 替换: 1 / 2
重编号行数     : 0
自检           : 通过（JSON 全部可解析、头部合法、seq 密集）
```

**未被触碰的帧按原字节保留**（连压缩数据都不重新压），只有被改动的帧会重新压缩；被改动的帧会带 zstd 校验和。

> [!WARNING]
> 离线 CLI 与 TUI 内命令有两处**行为差异**，别搞混：
> 1. 它**不知道会话是否在运行**，所以没有 `--allow-live` 这道闸——请自己在会话关闭后再执行。
> 2. 它**不会清理派生缓存**（那是 `/redact apply` 和 `/redact purge` 干的事）。用完记得 `/redact purge --session <id>`，或手动删掉 §4 里列出的缓存文件。

### 3.6 两条推荐流程

**会话没在跑（最安全，首选）**

```sh
dsh-redact verify "$LOG"                          # 1. 先确认文件本身是好的
dsh-redact inspect "$LOG" --match-file needle.txt # 2. 定位命中行
dsh-redact plan "$LOG" --plan plan.json           # 3. 离线试算
dsh-redact apply "$LOG" --plan plan.json          # 4. 落 .new，人工看一眼
dsh-redact apply "$LOG" --plan plan.json --apply  # 5. 就地替换（自动写隔离备份）
dsh-redact verify "$LOG"                          # 6. 复验
# 7. 删掉隔离备份（它仍含原文），再清理派生缓存
```

**会话正在跑（TUI 内）**

```
/redact list                                  # 1. 找到目标会话 id
/redact scan  C:\plans\plan.json --session <id>   # 2. 只定位，不改文件
/redact plan  C:\plans\plan.json --session <id>   # 3. 试算
/redact nodes                                 # 4. 当前会话的 tool/result 列表（最新在前：序号 行号 轮次 工具名 体积；命令行用 nodes full 或 pick 看）
/redact hide 1                                # 5. 试算：隐藏第 1 条（最新那条）——4 个 token，不用复制任何东西
/redact hide 1 --commit                       # 6. 真正遮蔽（下一轮请求起生效，无需重启）
/redact hide --lines 7 --commit               #    或者按日志行号（7 就是 nodes 里打印的行号）
/redact hide  C:\plans\plan.json --commit     #    或者按 plan.json 里的 find 匹配（同样先试算再 --commit）
/redact apply C:\plans\plan.json --session <id>   # 7. 给"没人在用"的会话真正重写磁盘字节
/redact verify --session <id>                     # 8. 复验
/redact purge  --session <id>                     # 9. 清派生缓存（apply 已做过一次，可再确认）
/redact undo   --session <id>                     # 10. 反悔：先试算，确认后加 --commit 从隔离备份恢复
```

第 4～6 步是**专门为"通知被压成一行"设计的**：`nodes` 把序号、行号、轮次、工具名、体积压进一行；`hide <序号>` 只要一个数字就能指到那条节点（见 §3.1 的渲染约束）。**要认出"是哪一条"**——先用轮次对到你界面上的那一轮，再用 `nodes full` 或 `pick` 里的命令行确认动作，最后用序号动手（见 §3.2）。

要注意分工：**对当前会话的 `apply` 一定会被拒绝**（见 §4），所以"我正在用的这个会话"要分两步走——先用 `hide --commit` 立刻让模型看不到（字节仍在盘上），再在会话关闭后用离线 CLI（或 `--allow-live` + 重启）把字节真正抹掉。反过来，`hide` 只认当前会话：别的会话请直接用 `apply`。想撤回的是**整轮对话**而不是某段文本，用 `rollback <轮数>`；想撤回的是**自己刚才那次脱敏**，用 `undo`。

---

## 4. 安全模型

| 闸门 | 具体行为 |
|---|---|
| **绝不打印内容** | `/redact` 与 CLI 只输出**行号与计数**。`inspect --match` 只给命中行号；`paths` 只给路径、类型与长度；JSON 解析失败信息也经过清洗（只保留 `position N`，剥掉 Node 报错里附带的输入片段），避免错误信息把原文漏到终端或日志里 |
| **就地替换前先写隔离备份** | TUI 内：`<log>.quarantine-<时间戳>`（ISO 时间，`:` 和 `.` 换成 `-`）；CLI `--apply`：同样规则。**备份里仍是原文**，确认无误后请自行删除它——本工具不会自动删 |
| **落盘方式** | **非活动会话**：写隔离备份 → 写成 `<log>.redact-tmp` → `fsync` → `rename` 覆盖。**活动会话（`--allow-live`）**：写隔离备份 → `open('r+')` → 写前复查文件修订号 → **先 `ftruncate` 再写**（被打断只会留下"旧日志的前缀"=读取端容忍的短尾，而不是"新头+旧帧"混合体）→ 校验写入字节数 → `fsync` **原地覆盖**——改名替换可能与此刻正在发生的追加句柄相撞（Windows 上尤其明显），而后端每批追加都是重新 `open(path,'a')` 写 EOF，覆盖写不会与它冲突 |
| **写失败时的隔离备份** | 目标文件**一个字节都没动**时，刚复制出来的隔离备份会被删掉（它只是原文的重复副本）；一旦动过目标文件就保留备份，并在错误信息里**点名**它（此时它是唯一完整的原文） |
| **并发追加检测** | `apply` 与 `rollback` 在读取前记录文件修订号（`size:mtimeMs:ctimeMs`），落盘前再取一次；`open` 之后、写入之前**再查一次**；写完后还要求文件长度精确等于输出长度。任何一次对不上就**整单拒绝**（`未执行：日志在本次读取之后被追加过（可能有并发写入）`），以免覆盖掉新事件 |
| **`--allow-live` 的额外闸门** | 活动会话改写时，若日志尾部存在**残帧**，直接拒绝：写句柄缓存着一个"按改写前布局算出的截断偏移"，下次追加会按它截断，可能造成**静默损坏**。请关掉该会话再执行 |
| **`rollback` 的边界保护** | 只在完整的 `turn/end` 边界上截断，且至少要保留 1 轮（日志里没有 `turn/end` 时直接拒绝）；若截断会移除继承型 `session/end-seed` 标记（读取端会判定整份日志损坏），同样拒绝执行 |
| **`undo` 先校验再原子安装** | 装回之前先校验选中的隔离备份（帧可解码、头部合法、`seq` 密集、引用合法、**没有未完成残帧**、事件数不少于当前日志）；不合格就拒绝并指出可改用的更早备份。安装用"临时文件 + `rename`"，而不是直接覆盖 |
| **拒绝改写在用的当前会话** | 目标是当前会话且没给 `--allow-live` 时，`apply` / `rollback` / `undo` 一律直接报错：它的写句柄仍持有该日志，就地替换可能让后续追加失败。报错信息给出安全做法，并要求 `--allow-live` 之后重开会话以重新加载历史 |
| **写盘前内部自检（总闸）** | 输出前**一遍解码**回放读取端语义：JSON 全部可解析、头部合法、**`seq` 密集**、**引用字段合法**（`sourceEventSeqs` 的游程展开规则：`end <` 本行 `seq`、唯一、带区间时严格递增；`surfaceOp` 端点更早；`session/title.messageSeqs` 满足 `dsh-session-title` 的真实不变式）。任何一项不过就放弃输出（`内部自检失败，已放弃输出`），宁可不写也不写坏 |
| **引用字段清单是显式的** | `renumber` 只重映射读取端自己那份清单里的引用（`surfaceOp`、`sourceEventSeqs`、`data.shadowedSeqs`、`data.shadowedRange`、`data.messageSeqs`、`data.sourceEventSeq`）。盘上 `sourceEventSeqs` 的 `[start,end]` 游程会被**展开成每个 seq 逐个映射后再按同一压缩器压缩**；任何清单外的 `*Seq`/`*Seqs` 字段一律**失败关闭**（拒绝执行），宁可拒绝也不写出悬空引用 |
| **头部行与结构键受保护** | 第 1 行不能被删/清空/改写；`type`/`seq`/`time`/`surfaceOp`/`sourceEventSeqs`/`toolCallId`/`callId`/`role`/`id` 这些键不会被 `substitutions` 或 `blankLines` 动到，也不会被 `setFields` 写入 |
| **对话框默认关闭，因为"会让出键盘且可能没人能应答"** | `pick` 的模态对话框**默认关闭**（`allowDialogs: false`）：一旦它成为 TUI store 里的**活动请求**，聊天输入就交出键盘（`Chat.js` 的键盘守卫把 `dialogSnapshot !== null` 与 questionnaire / approval 面板同等对待，`:698-701`、`:2562-2566`，输入框停用）；而面板渲染是有优先级的——**有 approval 面板时对话框不显示但仍挂起**（渲染分支里 `approvalPanelNode !== null` 优先于 `dialogSnapshot`，`:3585`），approval 又**没有超时**，`exitOnCtrlC: false` 意味着连 `Ctrl+C` 都退不出。于是"有审批挂着时敲 `pick`"必然锁键盘，只能等超时。插件因此默认根本不把 promise 停进 store（回一条说明让你用 `nodes` + `hide <序号>`）；确实要用时才 `allowDialogs: true`，并把 `timeoutMs` 压到 **15000**（`dialogTimeoutMs` 可调、设 `0` 再禁用一层），准入竞态的修法见 §2.5 |

### 派生缓存清理（`purge` / `apply` 的一部分）

`/redact purge --session <id>`（`/redact apply` 结束时也会自动做一次）删除：

* `<cacheRoot>/session_projcache/sessions/<id>.json`
* `<cacheRoot>/session_projcache/sessions/<id>.json.bak.*`

### 本工具**故意不动**的位置，需要你自己处理

`purge` 会把这些**路径列出来**（只列路径，不读内容），但不会替你改：

* `<DSH_HOME>/storages/session_projcache.json` —— 旧版**聚合**缓存。删掉单会话缓存后它可能把内容回灌，建议一并删除。
* `~/.dsh-tui/history.jsonl` —— 前端输入历史。
* `~/.dsh-tui/session-index.json` —— 前端会话索引。
* `%TEMP%/dsh-spill-*`、`%TEMP%/dsh-subprocess-*`（POSIX 下是 `$TMPDIR`）—— 溢写与子进程临时文件。

此外，**任何已经离开本机的副本都不在范围内**：写进文件的、导出成报告的、上传到别处的、已经发给模型服务商的——见 §6。

---

## 5. 验证：怎么确认真的抹干净了

三道检查，从"结构没坏"到"内容确实不在"：

**1）TUI 内**

```
/redact verify --session <id>
```

```
✓ <id 前 8 位> · 帧 3 · 行 6 · 头部合法 · seq 密集 · 引用合法 · 读取端可打开
```

一行就是全部输出（见 §3.1 的渲染约束）。不通过时同一位置给的是：

```
✗ <id 前 8 位> · 帧 3 · 行 6 · 问题：<原因>
```

（此时 `kind` 也是 `error`，所以通知会以错误色显示。`<原因>` 是**读取端语义**的判据：引用类问题直接报引用检查的理由，否则报尾部残帧起点 / `seq` 缺口 / 解析失败行数。）

顺带说明这一版的 `verify` 比早期多查一项：`refs = verifyLog(buf)` 会按读取端语义**回放引用字段**（含盘上游程形式），所以通过串里多了 `引用合法`。这修的是「引擎自检说没问题、真实读取端却打不开」的那类缺陷。

**2）离线**

```sh
dsh-redact verify "$LOG"
```

输出字段：文件、完整帧数、带校验和的帧、尾部残帧起点、总行数、JSON 解析失败、`seq 密集性`、首行是合法头部、结论。**退出码 0 = 结构自洽，2 = 存在问题**——可以直接用在脚本里。

**3）内容层面**

用 `inspect --match-file needle.txt` 复扫一次：命中行数应当变成 `0`。它只回显行号，所以复验本身不会把原文再打出来。

### "seq 密集性"是什么意思

会话日志是**一串各自独立、各自带校验和的 Zstandard 帧**的简单拼接：第 0 帧只有 1 行头部行（`{"type":"session",...}`），之后每帧是一次持久化追加批次，含 1..N 行 JSONL 事件，一行一个事件。

**`seq` 密集**指：除第 1 行（头部行）外的每一行，其 `seq` 恰好等于 `行号 - 1`（0-based 计数）。这是读取端最硬的一条约束——它逐行累加 `eventCount` 并断言 `event.seq === eventCount`，一旦不连续就判定整份日志损坏。

`verify` 打出 `· seq 密集 · 引用合法 · 读取端可打开` 的含义就是"这些不变量成立，读取端能正常打开"。它**不**保证内容已经不在了——内容是否还在，要用第 3 步的命中复扫确认。

### 仓库里的自测

五份脚本，全部只用**合成日志**（假内容，不碰任何真实会话），分别覆盖不同层次：

| 脚本 | 断言 | 覆盖什么 |
|---|---|---|
| `test/handler.selftest.mjs` | 248（脚本自己打印 `N/M 通过`） | **插件 handler 层**：命令注册元数据（含 hint 串）、`list`/`nodes`/`pick`/`scan`/`hide`/`plan`/`apply`/`verify`/`purge`/`rollback`/`undo` 的输出与副作用、`--session` 与 `--allow-live`、各类错误路径、`list` 的**单行 + 200 显示格预算**（含 `(当前)` 标记、`…另N个`、人类可读体积）、**`nodes` 的分页/格预算/序号连续/越界落末页/`--full` 导出/拒绝别的会话**、**识别元数据（每条都带「`轮 T`」、与节点账本一一对账；`nodes full` 每行含轮次/行号/命令行；`argsCells` 三态：默认 120 / 自定义 / `0` 完全不显示且不留占位符；控制字符被压成空格）**、**`pick`（`allowDialogs` 默认 `false` 时拒绝且一次都不调用对话框、`nodes` 也不推荐 `pick`；打开后覆盖有/无 `tuiDialogs`、select 与 confirm 的请求形状、人取消 vs 面板没弹的 <50ms 判据、`dialogTimeoutMs` 自定义与 `0`、无效 id / 非数字 id、抛错、60 条上限、`argsCells=0` 时不给 `description`）**、**config 校验（`null`/`undefined`/非对象/空串/未知键；`argsCells` 与 `dialogTimeoutMs` 的负数、小数、字符串、`null`；`allowDialogs` 的非布尔全部拒绝）**、`hide` 的试算与 `--commit`（断言试算文案 `将隐藏 N 个节点`、`surfaceOp`/`sourceEventSeqs` 形状、正文已换占位符、**不删磁盘字节**）、嵌套 `blankLines`、跨帧全局替换、后缀删行、中间删行、`renumber` 的引用重映射与悬空引用拒绝（断言**抛出 `RedactError`**）、头部帧原字节保留 |
| `test/bugfix-regression.mjs` | 54（脚本自己打印 `N/M 通过`） | **回归守卫**（夹具用**真实 `Session` + 真实编解码器**生成，判据含**真实 `JsonlSessionPersistence.open()`**）：夹具本身必须能被真实后端打开、`tool/result` 必须是真实消息形状；非法计划与中间行删除只返回错误、**进程存活**（BUG-1/BUG-1b）、损坏帧返回错误（BUG-2）、`scan` 定位且不泄漏原文、`rollback` 的试算/执行/保留边界/留隔离备份**且输出可打开**、`undo` 的查找/执行/留撤销前快照/**恢复后可打开**/无备份时报错、`apply` 脱敏后**输出仍可打开且事件数不变**、三者对当前会话的拒绝，以及会话内隐藏全线（真实消息形状） |
| `test/hardening.mjs` | 78（脚本自己打印 `N/M 通过`） | **红队报告 F1–F10 的回归套件**，判据是真实读取端：旧夹具形状被真实后端拒绝（元发现）、`sourceEventSeqs` 游程的展开→映射→重新压缩及其"区间中间被删"拒绝、`session/title.messageSeqs` 重映射 + **真实 `dsh-session-title` 不变式**复核、清单外 `*Seq` 字段的失败关闭、总闸对读取端会拒绝的输出逐条拦截、`undo` 对截断/损坏备份的拒绝与原子安装、live 改写的顺序/修订号复查/并发追加不被吞、缓存清理失败不改变命令成败、写失败时隔离备份的删除或点名、2 万行 renumber 不再爆栈、`hide` 半途失败与形态不支持 |
| `test/preflight.mjs` | 无断言（冒烟） | 模块可导入、`name`/`inject`/`apply` 形状、命令能注册（打印 hint 与 `recordInput`）、`list` 能跑通，以及未知会话 / 未知子命令 / 缺计划文件 / 无 agent / 会话无 surface 时 `hide` 的报错文案 |
| `session-surgery/selftest.mjs` | 34（`34/34 通过`） | **引擎 / CLI 主路径**：帧扫描与逐帧统计、命中定位且不回显原文、`paths` 不打印值、三种原地改写生效且行数/帧数/`seq` 不变、未触碰帧原字节保留、中间行删除无 `renumber` 时被拒、带 `renumber` 时放行、后缀删除直接放行、拒绝删除/清空头部行、拒绝改写结构键 `seq`、损坏文件被拒、`verify` 正常退出、`plan` 试算不写文件 |

```sh
# 在 dsh-plugin-redact/ 里
node test/handler.selftest.mjs     # 248/248 通过（退出码 0）
node test/bugfix-regression.mjs    # 54/54 通过（退出码 0）
node test/hardening.mjs            # 78/78 通过（退出码 0）；需要真实 DSH 安装（DSH_REDACT_DSH_LIB 可覆盖路径）
node test/preflight.mjs            # 冒烟检查，只打印观察结果

# 引擎 / CLI 那份在隔壁目录
cd ../session-surgery
node selftest.mjs                  # 34/34 通过
```

本轮实测的输出末两行（`handler.selftest.mjs` 会把**被测文件**的字节数与 sha256 前 12 位一并打印，方便确认"通过的到底是哪一版"）：

```
248/248 通过
被测 index.js：59330B sha256:e1b0ee081042
```

`bugfix-regression.mjs` 与 `hardening.mjs` 会把**真实 DSH 读取端**当作判据：前者用真实 `Session`/`sessionFormatCatalog` 造夹具再用真实 `JsonlSessionPersistence.open()` 复核，后者还额外调用真实 `dsh-session-title` 不变式。**只看引擎自己的自检不足以发现读取端语义缺陷**——旧夹具写成 `role:'tool'`（真实形状是 `role:'user'` + `source:{kind:'tool',callId}`），所以那套绿色的断言曾经放过 `sourceEventSeqs` 游程与 `session/title.messageSeqs` 两类缺陷。

五份都需要 **Node >= 22.15**（zstd API），且都不需要 DSH 在运行。`handler.selftest.mjs` 会把 `DSH_HOME` 指向 `mkdtemp` 出来的临时目录（夹具跑完即删），并打印**被测 `index.js` 的字节数与 sha256 前 12 位**，方便你确认"通过的到底是哪一版"；它还会把 `process.exit` 换成抛异常作为安全网（现在这条路径已经不再触发——引擎改为抛 `RedactError`，它同时把这一点作为"探针"记录下来，见 §6）。

表里没有单列的 `test/real-reader.mjs` **不是套件而是助手模块**：它导出真实 `Session` / `sessionFormatCatalog` / `JsonlSessionPersistence` 的加载与夹具工具（`writeSessionLog` / `backendOpen` / `titleInvariantError`），由 `bugfix-regression.mjs` 与 `hardening.mjs` 引用。直接 `node test/real-reader.mjs` 不会打印任何断言结果——这是它的正常表现，不是失败。找不到真实 DSH 包时它会**抛错而不是跳过**（判据不能降级），可用 `DSH_REDACT_DSH_LIB` 指向 `@deepseek-ai` 目录。

`test/` 里 **`handler.selftest.mjs` 与 `preflight.mjs` 在 `package.json` 的 `files` 列表里**（它们不需要真实 DSH 安装，所以随 npm 包发布，消费者可以自己跑一遍复核）；`bugfix-regression.mjs`、`hardening.mjs`、`real-reader.mjs` **只在源码仓库里**（判据依赖真实 DSH 读取端，找不到会抛错而不是跳过）。`package.json` 没有配置 `scripts`，请直接 `node <文件>` 运行。

---

## 6. 局限（诚实清单）

1. **范围只有会话日志与它的派生缓存。** 覆盖对象是 `<DSH_HOME>/sessions/**/session.vN.jsonl.zstd` 与 `purge` 列出的缓存；其他一概不管。
2. **只处理"版本号最高"的那一份日志。** 同一会话若留有 `session.v2.jsonl.zstd` 等旧版本文件，它们**不会被改写**，原文仍在。请用 `list` / `graph` 确认没有旧版本或分叉副本后，自行处理或删除。
3. **已经离开本机的内容收不回来。** 已经被写进文件、导出成报告、上传到别处、或已经作为请求发给模型服务商的内容，本工具**无法撤回**。它只能修复**本机会话日志里**的副本。
4. **它不阻止内容进入。** 这是事后修复工具：内容先落盘，之后才被抹掉。互补的做法是**预防型策略插件**——在工具结果持久化之前就替换掉它（见下）。
5. **`apply` 对当前会话是"原地覆盖"，不是改名替换。** 加 `--allow-live` 时它走 `open('r+')` → 写入 → `ftruncate` → `fsync` 就地覆盖（改名替换可能与正在追加的句柄相撞，Windows 上尤其明显）；不加则对当前会话一律拒绝。即便如此，**运行中的进程内存里仍持有旧文本**，它后续发给 provider 的请求也仍带着它——成功输出会明确提醒你重开会话，而且**已经发出去的请求收不回来**。当前会话的正确姿势仍然是先用 `hide --commit`（立刻生效、不用重启、不删字节），字节留到会话关闭后再用离线 CLI 抹。
6. **引擎级拒绝现在抛 `RedactError`，不再 `process.exit`（早期版本的缺陷已修复）。** 早期实现用"打印到 stderr + 退出进程"表示致命错误，那会让 `/redact plan|apply` 直接杀掉宿主进程；现在 `die()` 抛 `RedactError`，插件那层 `try/catch` 把它变成普通的 `未执行：<原因>` 错误结果，离线 CLI 则由 `main()` 顶层统一转成 stderr + 退出码 1（对外行为不变）。仓库里的 `test/bugfix-regression.mjs`（BUG-1 / BUG-1b / BUG-2）与 `test/handler.selftest.mjs` 的探针就是针对这条回归的守卫。
7. **`renumber` 会重写结构。** 它会改动所有行的 `seq` 并重映射向后引用；引用了被删行的行会被判为悬空引用而**拒绝执行**——那种情况请改用 `blankLines`。
8. **残帧默认丢弃。** 尾部未写完的帧默认在重写时被丢掉；要保留得在计划里写 `"keepTorn": true`。先看 `inspect` 的"尾部残帧起点"。
9. **未触碰的帧原字节保留，被改动的帧会重新压缩**——因此文件大小会变（可能变大），这是正常的，不代表还有原文。
10. **TUI 内的路径要用引号包住空格**（参数按 `"..."` / `'...'` / 空白切分，外层引号会被剥掉），相对路径相对宿主进程的 cwd 解析——建议用绝对路径。
11. **需要 Node >= 22.15**（zstd API）。
12. **隔离备份是"福也是祸"**：它让你能回退，但它**仍然包含原文**。忘了删，等于没脱敏。
13. **`hide` 不是脱敏。** 它只追加 `surfaceOp` 替换节点把内容移出模型视野，原文仍然完整保存在日志里（它自己的成功输出也会提醒这一点）。它**只处理 `tool/result` 节点**（用户消息、助手消息不参与），替换文本固定用配置里的 `placeholder`（所以计划里的 `replace` 对 `hide` 无效）；定位方式有三种——`<plan.json>` 的 `substitutions[].find`、`/redact nodes` 给的 `<序号>`、或 `--lines <日志行号>`。后两种与 `find` 无关，因此**不需要把原文写进任何文件**。
14. `scan` 遵守 `substitutions[].lines`：只报限定区间内、且 `apply` 真的会改的行，输出里会注明 ` · 已按 substitutions[].lines 限定`。`verify` 遇到帧头损坏的日志会返回 `日志无法解析：<原因>` 而不再抛异常，但要复核这类文件仍建议用离线 `dsh-redact verify`——它以退出码 2 报告问题。
15. **`rollback` 依赖 `turn/end` 事件。** 日志里没有 `turn/end` 就完全无法按轮回退（会直接拒绝），而且至少要保留 1 轮——它不能把整个会话清空。截断会碰到继承型 `session/end-seed` 标记时也会拒绝。
16. **通知永远是一行、最多 200 个显示格，而且插件自己也按这个额度裁剪。** 渲染端（dsh-tui）会压平换行并按 200 格截断——见 §3.1；本插件在 `clampResult()` 里用同一套规则**先裁一遍**，所以每条输出在离开 handler 时就已经 ≤200 格。这是硬约束，不是风格选择：中文一个字占 2 格，约 100 个汉字就把额度用光。**唯一的例外是 `/redact pick`**：它走 TUI 自己的对话框面板，不经过这条渲染路径，所以是多行、可方向键选择的——这也正是它存在的理由。后果要心里有数：`apply` / `rollback` 的成功输出带着很长的隔离备份文件名，尾巴完全可能被截掉；本版已把备份与「仍含原文，确认无误后自行删除」挪到最前面，但**别把"没看到提醒"当成"没有备份"**——备份就在日志旁边，`purge` / `undo` 的输出也会告诉你它的名字。同理，`list` 在会话很多时连末尾的 `用 /redact nodes 看当前会话` 提示都会被截断，`nodes` 因此才要分页。**不要围绕"从通知里复制一长串东西"来设计操作**：要隐藏最新那条，直接敲 `/redact hide 1 --commit`，或者用 `/redact pick`。
17. **`hide <序号>` 依赖内存里的节点列表。** 序号引用的是**本会话最近一次 `/redact nodes`** 的结果，它只存在宿主进程内存里、按会话保存：还没跑过 `nodes`（或进程重启过）就必须先重新 `nodes`，否则报 `还没有节点列表，请先运行 /redact nodes`。不想依赖这份列表，就用 `hide --lines <行号>`（行号你自己知道的话）、`hide <plan.json>`，或直接用 `pick`（它自己重新收集节点，不依赖这份列表）。
18. **少数很长的报错分支内部仍是换行拼的字符串。** 成功路径与短报错都是单行，但"拒绝改写/截断/恢复当前会话"、"拒绝 `--allow-live`：残帧"、"未知子命令"、"缺计划文件"这几条依然用 `\n` 拼接；它们同样先被 `clamp` 到 200 格、再被渲染端压成一行，所以屏幕上仍是一行，只是长句的尾巴可能被砍掉。
19. **`pick` 默认关闭，并且依赖 TUI 行的对话框服务。** 第一道闸是 `allowDialogs`（**默认 `false`**）：关着时 `pick` 直接返回 `pick 的模态对话框默认关闭（它会让 TUI 键盘卡住，且 approval 挂起时必然复现）· 用 /redact nodes 看编号，再 /redact hide <序号> --commit · 确要启用请设 allowDialogs: true 并自行承担风险`，不碰任何服务，其余子命令完全不受影响。打开后才走软探测 `ctx.get('tuiDialogs')`（**默认不写进 `inject`**，所以缺这个服务也不会把插件卡在等待态）：没有该服务时回 `当前前端没有对话框服务 tuiDialogs · 改用 /redact nodes 看列表，或 /redact nodes full 导出到文件`；被 `dialogTimeoutMs: 0` 关掉时回 `对话框已被配置禁用（dialogTimeoutMs: 0）· …`。想真正用上面板，需要 `allowDialogs: true` **和**行级 `inject` 两件事（见 §2.5）；只开前者、不加 `inject` 时，"准入竞态"会让 `select` / `confirm` 在 50ms 内返回取消值——插件用耗时把这种情况单独报出来（`对话框没有弹出（0ms 内直接返回取消）…` / `确认框没有弹出（…）`），不会静默失败。另外服务契约（`@deepseek-harness-tui/dsh-tui` 的 `lib/types/dsh-adapter/dialogs.d.ts`）承诺**请求不合法时只 warning + 返回取消值、绝不抛异常**；本插件对两个对话框都显式给 `timeoutMs: dialogTimeoutMs`（默认 **15000**），超时按「已取消」处理。
20. **`pick` 一次只能选最新 60 条。** 这是插件自己的上限（宿主侧的 `MAX_OPTIONS` 是 100，插件留了余量）：超过时 `select.title` 会写明 `选择要隐藏的节点（共 70 个，仅列最新 60 个；其余用 /redact hide <序号>）`，但**第 61 条及更早的节点无法通过对话框选中**（`options` 的 id 是 `1..60`，它们对应的永远是**最新**的 60 条）。要处理更早的节点，用 `nodes <页号>` 翻到对应页再 `hide <序号>`，或 `nodes full` 导出后照着文件里的序号 `hide`。
21. **`nodes full` 写出的清单文件不会自动清理。** 它落在 `%TEMP%\dsh-redact-nodes-<会话 id>.txt`（POSIX 下是 `$TMPDIR`），文件名用**完整会话 id** 做安全化处理，所以不同会话不会互相覆盖。文件里是**轮次、工具名、体积、日志行号，以及该次工具调用的命令行**（命令行受 `argsCells` 控制，设 `0` 则完全不写）——**不含工具结果正文，也不含内部 `seq`**；但会话 id、工具名与命令行本身仍可能算元数据（命令行尤其可能含查询词），用完请自行删除。本工具不会替你删，也不会在会话结束时清理。
22. **对话框是唯一不受 200 格规则约束的输出，但它默认关着、而且有自己的预算。** 其余所有子命令的输出都在 handler 里被 `clamp()` 先裁到 200 显示格（见 §3.1），而 `pick` 的对话框由 TUI 自己的 chrome 渲染，走的是另一套限制：标题与选项 label 各 **120 格**、确认框正文 **400 格**、一次最多 **100** 个选项（`dialogs.js` 的 `TITLE_CELLS` / `LABEL_CELLS` / `MESSAGE_CELLS` / `MAX_OPTIONS`）。所以插件把选择框标题压在 ~90 格、选项截到 60 条、命令行按 `argsCells` 截断——都是为了让宿主**不要静默裁掉**你需要的识别信息。**而且这条路径默认关闭**（`allowDialogs: false`，理由见 §2.5）：不打开时你看到的全是那条单行说明，识别信息仍然从 `nodes` / `nodes full` 拿。
23. **识别信息本身也是元数据。** `nodes` / `nodes full` / `pick` 会显示**轮次、工具名、体积与工具调用的命令行**（`argsCells` 可关）。这些都不是工具结果的正文，但命令行可能含敏感查询词——要更保守就把 `argsCells` 调小或设 `0`。

### 互补做法：预防型策略插件（拦截工具结果）

本工具是**事后**的。想从源头减少落盘，需要另一个插件挂在工具结果持久化之前。可用的缝是 `tools/execute`（围绕派发的 waterfall：`(exec, next) => Promise<ToolExecutionResult>`，包装器返回替换后的结果），或 `tools/post-execute`（`(exec, result, next) => Promise<PostToolDecision>`，可以接受 / 替换 / 阻断已归一化的结果）。这类插件的现成例子是社区插件 `dsh-secret-redactor`（挂工具结果做掩码），它自己的 README 也承认**持久化日志里仍是原始值**——这正是"预防"与"修复"必须分工的原因。

实现这个缝时有一条**容易写错的关键点**：要替换结果里的**规范值 `value`**，而**不能只替换 `content`**。因为成功结果的 `content` 与 `meta` 都是从 `value` 经工具自己的投影函数（`render` / `presentationMeta`）派生出来的，而 `meta` 会**原样持久化**到 `tool/result` 事件里；只掩码 `content` 的话，原文会从持久化的 `meta` 里漏出来。反过来，替换 `value` 会让两个投影一起重新生成。注意这个接口把二者设成了互斥：同一次决策里同时给 `value` 和 `content` 会直接抛 `TypeError`。

（这一段描述的是 DSH 的工具结果管线本身，不是本包的功能——本包不注册任何工具结果钩子。请以你所用 DSH 版本的类型定义为准。）

---

## 7. 与现有生态的关系：为什么还要一个

DSH 的插件生态里，"历史"类插件不少，但**没有**一个能改写已落盘的会话日志内容。以下都是真实存在的插件（名字取自社区调研，见仓库中的 `dsh-tui-redaction-plugin-survey.md`）：

| 插件 | 它实际做什么 | 为什么不是"原地脱敏" |
|---|---|---|
| `dsh-easyrewrite` | 归档原会话，用"截断到目标消息之前"的同名新会话替换，并自动重发编辑后的文本（仅 Web UI） | 原日志只是被**归档**，没有被擦除；不做子串/工具结果级别的清除 |
| `dsh-conversation-rewind` | 追加一条 `SurfaceOp` 替换标记，把消息从转录与后续模型上下文中隐藏（仅 Web UI） | 只是**从上下文里**移除，磁盘上原样保留 |
| `dsh-message-edit` | 每次编辑/重试都创建一个**新的会话版本**（仅 Web UI） | 明确"不原地改写 Session 事件；历史是 append-only"；旧会话全部保留 |
| `dsh-undo` | `/undo` 追加 `surface/rewind` 事件、`/redo` 追加 `surface/restore` | 追加式设计：消息节点、ID、工具调用关联、日志事件全部保留 |
| `dsh-session-cleaner` | 整会话：归档并**物理删除**日志目录；单条消息：surface 替换 | 消息级"原始事件仍保留在日志与人类转录中"；整会话删除**不可逆、无备份** |
| `dsh-sess` | 用 `ctx.sessionPersistence.locate()` **永久删除冷会话**（仅 Web UI） | 只能整会话删除，没有消息级操作，也没有取消归档 |
| `@anionex/dsh-turn-rewind`、`dsh-shadow-rewind` | 恢复**项目文件**快照 / 分叉出新会话 | 作用于文件与分支，不作用于日志内容 |
| `dsh-secret-redactor` | 挂工具结果做掩码，遮住模型看到的那份文本 | 其 README 明说**持久化日志仍存原始规范值**，"日志级脱敏还在路线图上" |
| `dsh-telemetry-redactor` | 只脱敏**外发遥测**的那一份 | "它从不改写规范会话日志" |
| `dsh-recall`、`dsh-session-index`、`@deepseek-ai/dsh-session-health` | 检索 / 索引 / 多帧 zstd 日志的帧级诊断 | 全是**只读** |

结论（也是调研的结论）：这些插件里**每一个都在保留日志**——append-only 是生态常态。能改变磁盘字节的只有"整会话删除"，而且不可逆、无备份；消息级的都只做 surface 替换。**"打开 `session.vN.jsonl.zstd`，把指定的某段内容改写掉，同时保证日志仍可被读取端正常打开，并留下可回退的备份"——这件事没有现成插件做。**

另外注意：`dsh-tui` 自带的 `/rewind` 也**不是**脱敏。它走的是 session fork：找到目标消息所属轮次的开始事件，分叉出一个分支会话、回放该边界之前的历史，然后把原消息放回输入框。**原 `session.vN.jsonl.zstd` 仍然在磁盘上。** 它改变的是"接下来看到什么"，不是"磁盘上留着什么"——两者互补，不能互相替代。

本插件的定位就是补上这块：**行级、原地、可复验、带隔离备份的日志内容脱敏，并且能从 TUI 里发起。** 它刻意不做整会话删除（那有别的插件）、不做上下文级别的 rewind（TUI 原生已有）。

顺带说明：`/redact hide` 的机制（追加 `surfaceOp` 替换节点，把内容移出模型视野）与 `dsh-conversation-rewind` 属于同一类做法，但本包把它刻意做窄了——只针对 `tool/result` 节点、没有分支树 UI，并把它定位成"先止损"的第一步，配上一个真正改写磁盘字节、可回退的 `apply`。

---

## 8. 发布到 npm / 让别人装上

### 8.1 名字与 scope

* 官方文档**没有**规定命名与 scope。社区惯例是无 scope 的 `dsh-*`（如 `dsh-easyrewrite`、`dsh-shadow-rewind`、`dsh-telemetry-redactor`），或 owner scope 的 `@owner/dsh-*`。
* **不要假定你能用 `@deepseek-ai` 这个 scope。** 已见到的该 scope 包都指向官方或官方相邻的发布者。
* 发布前先占名，避免撞名：

  ```sh
  npm view dsh-plugin-redact    # 404 说明名字可用
  ```

### 8.2 发布前必须做的检查

1. **`files` 必须包含运行时真正会用到的文件**，且 `dsh.bundle.patch` 指向的文件必须在包内可解析。本包的 `files` 已经列全：

   ```json
   "files": ["index.js", "cordis.patch.yml", "cordis.patch.tui.yml", "lib/engine.mjs", "bin/dsh-redact.mjs", "test/handler.selftest.mjs", "test/preflight.mjs", "README.md", "README.zh.md", "LICENSE"]
   ```

   * `index.js` —— 插件入口（`export const name` / `export const inject` / `export function apply`）
   * `cordis.patch.yml` —— `dsh.bundle.patch` 指向的层（**默认层**：只 `inject: ['commands']`、`allowDialogs` 保持默认 `false`，非 TUI 前端也能启动）
   * `cordis.patch.tui.yml` —— **TUI 变体层**：行级 `inject: [commands, tuiDialogs]` + config 里 `allowDialogs: true`（启用 `pick` 所需的全部；用法与代价见 §2.5）。`exports` 里也解析得到：`dsh-plugin-redact/cordis.patch.tui.yml`
   * `lib/engine.mjs` —— 引擎，被 `index.js` 相对引用
   * `bin/dsh-redact.mjs` —— 离线 CLI（`bin.dsh-redact`）
   * `test/handler.selftest.mjs`、`test/preflight.mjs` —— 两份**不需要真实 DSH 安装**的自测脚本，随包发布（见 §5）
   * 两份 README、以及 `LICENSE`（**MIT 全文；本轮新增**，此前 `files` 与包内都缺它）

   `test/bugfix-regression.mjs`、`test/hardening.mjs` 与助手模块 `test/real-reader.mjs` **故意只在仓库里、不进 `files`**：它们把**真实 DSH 读取端**当判据（需要本机装了 `@deepseek-ai/*`），发布出去对消费者没有意义（找不到就抛错）。包里**不要**放进测试夹具、`plan.json`、`needle.txt` 之类的敏感残留（自测脚本自己只造合成夹具、落在 `mkdtemp` 临时目录，所以脚本本身可以安全发布）。
2. **打包预览**，确认没有漏文件、没有把不该发的带进去：

   ```sh
   npm pack --dry-run
   ```

   本轮实测（`dsh-plugin-redact@0.1.0`）：**11 个文件、137.0 kB 打包体积 / 398.1 kB 解包体积**，文件清单为 `LICENSE`、两份 README、`bin/dsh-redact.mjs`、`cordis.patch.tui.yml`、`cordis.patch.yml`、`index.js`、`lib/engine.mjs`、`package.json`、`test/handler.selftest.mjs`、`test/preflight.mjs`。同批的姊妹包 `dsh-plugin-content-policy@0.2.0` 是 **10 个文件 / 61.9 kB**——两个包现在都带 `LICENSE`。
3. `engines.node` 保持 `>=22.15.0`（zstd API 要求）；`peerDependencies`（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-commands`）在本包里是可选的（`peerDependenciesMeta` 标了 `optional`），不给消费者制造安装负担。
4. 包里**不要**包含测试夹具、`plan.json`、`needle.txt` 之类的敏感残留。

### 8.3 发布

```sh
npm login
npm publish                    # 无 scope 包
npm publish --access public    # scoped 包（@you/dsh-plugin-redact）首次发布必须显式公开
```

* 发布到 registry **不是必需的**：官方文档支持 npm 包、`pnpm pack` 出来的 tarball、以及 git 依赖三条路——也就是说，直接 `dsh plugin --profile <name> add ./dsh-plugin-redact` 或 `add github:you/dsh-plugin-redact#<commit>` 也能分发。
* 走 git 分发时，pnpm ≥10 会拒绝执行依赖的 `prepare`，需要消费者把 pnpm 打印出来的那个 key 抄进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 再重试；**发布 npm 包（把文件预先准备好）可以完全避开这件事**。
* 版本号请遵守 semver 并按需 `npm version patch|minor`；消费者用 `dsh plugin --profile <name> update` 升级。

### 8.4 消费者怎么装

```sh
dsh plugin --profile <name> add dsh-plugin-redact          # 从 npm
dsh plugin --profile <name> add ./dsh-plugin-redact        # 本地目录
dsh plugin --profile <name> add github:you/dsh-plugin-redact#<commit>   # commit 固定
dsh --profile <name> --dump-config                         # 确认 dsh-redact 行出现
```

离线 CLI 随包安装（`bin.dsh-redact`），在 profile 目录里可用 `npx dsh-redact` 或直接调用该入口文件。**用 dsh-tui 前端、并且想用 `/redact pick` 面板的话**，装完按 §2.5 套用包内的 `cordis.patch.tui.yml` 即可（它同时给了行级 `inject: [commands, tuiDialogs]` 和 config 里的 `allowDialogs: true`）；不套用也能用，`pick` 只会回一条"默认关闭"的说明并让你走 `nodes` + `hide <序号>`。非 TUI 前端**不要**套用那一层（会让整个 profile 起不来）。

### 8.5 分发时的三条提醒

* **DSH 没有官方插件 registry。** 官方只文档化了 npm / tarball / git 三种分发方式，并明确"不要求发布到 registry"；也不存在官方提交表单或审核步骤。社区目录（如 cordis.run 及其自动生成的 Awesome 列表、`dsh-plugin-verify` 验证仓库、dshfind.com / dsh.so，以及 `dsh-tui-ecosystem` + `dsh-ecosystem-spec` 准入规范）**都是社区自建、各自有各自流程的**，不代表官方背书。
* **第三方插件以受信任的宿主代码运行，不在沙箱里。** 装一个插件就等于用它跑在你机器上的权限执行它的代码；它能读写你的会话日志——本插件正是靠这一点工作的。请像审查任何本机程序一样审查它，发布时也请把你的权限需求写清楚（本包默认层只 `inject: ['commands']`，TUI 变体层额外声明 `tuiDialogs`（见 §2.5），两者都不发布服务、不联网，读写的是你自己指定的 `root` / `cacheRoot`）。
* **README 里不要放真实敏感内容。** 示例、issue、截图、测试夹具都可能长期留在公共记录里——这也是本工具存在的原因。

---

## 9. 许可

MIT。

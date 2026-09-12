# dsh-plugin-redact

**在 dsh-tui 里，原地脱敏 / 回退 DSH 会话日志（`session.vN.jsonl.zstd`）。**

不需要开新会话、不需要删整条会话、不需要把日志搬家：它在原文件上把指定的字节**改写掉**，并且让日志仍然能被读取端正常打开。

| 项 | 值 |
|---|---|
| 包名 | `dsh-plugin-redact` |
| 版本 | 0.1.0 |
| 许可 | MIT |
| 运行环境 | Node.js **>= 22.15.0**（依赖 `zlib.zstdCompressSync` / `zstdDecompressSync`） |
| TUI 内命令 | `/redact list\|nodes\|scan\|hide\|plan\|apply\|verify\|purge\|rollback\|undo` |
| 离线 CLI | `dsh-redact inspect\|paths\|verify\|plan\|apply\|cut\|graph` |
| 硬依赖 | 只消费宿主 `commands` 服务（`inject: ['commands']`），不发布任何服务 |

---

## 0. 它解决什么问题

一段工具结果、一条命令输出、一次网页抓取——只要它进了会话，就会被持久化批次写进 `session.vN.jsonl.zstd`，从此**长期躺在磁盘上**：可能长期留在会话历史里被反复读回、被后续上下文继续引用、被索引或导出。内容本身未必是"密钥"：它可能是法律上不该留存的材料，可能是一段凭证，也可能只是**错的、过时的、不该继续影响后续判断的信息**——判断标准由你定，本工具只负责"把已经落盘的这些字节删掉或改写掉，并且不把日志弄坏"。

它做两件事：**改写**（把命中的文本/字段换掉，或把整行清空）和**剪除**（删掉末尾若干行，或在显式重编号的前提下删掉中间行）。改完之后，会话还能照常被打开、回放、继续追加。

还要分清四件不同的事——它们由四个子命令分别负责：

* **`/redact hide`** —— **立刻**把命中的工具结果从**当前会话的模型视野**里遮蔽掉（追加 `surfaceOp: {op:'replace'}` 替换节点）。下一轮请求起模型就看不到它，**不需要重启会话**。**磁盘字节不变。** 定位方式有三种：`plan.json` 里的 `find`、`/redact nodes` 列出的序号、或日志行号（见 §3.1）。
* **`/redact apply`** —— 真正**重写磁盘上的日志字节**（原地改写，行数不变）。它要求该会话没有被占用（否则必须显式 `--allow-live`），所以更适合在会话关闭后用离线 CLI 做。
* **`/redact rollback <轮数>`** —— **撤回已经发生的对话**：按 `turn/end` 边界把最后 N 轮整体截断掉。这是"后缀删除"，也是最安全的一种删除。
* **`/redact undo`** —— **撤销我自己的脱敏**：从最新的隔离备份恢复。

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

`<DSH_HOME>` 未设置时取 `~/.dsh`。包自带的 `cordis.patch.yml` 使用部署自带的 `!!js dshHomePath(...)` 助手，和官方 `session-persistence-jsonl` 行完全一致，因此跟着 `DSH_HOME` 走。

### 2.4 确认它挂上了

```sh
dsh --profile <name> --dump-config     # 不用启动，直接打印合成后的配置
```

在输出里应该能看到 `id: dsh-redact` 这一行，并标注它来自哪个层。*（`--dump-config` 会顺带重写 profile 里那个空的 `cordis.yml`、并可能修复 `profiles/node_modules` 链接——两者都是幂等的。）*

`patchReload: live` 的 profile 里，改动 `cordis.patch.yml` 会热生效、新命令也会通过 `commands/change` 立刻进入 TUI 的 `/` 菜单；但**改动已经加载过的模块内容不会热更**，需要重启（或换文件名）。首次创建插件文件不需要重启。

---

## 3. 使用

### 3.1 `/redact` 子命令

`/redact` 只用**会话 id**（`--session <id>`），不用日志路径；不写 `--session` 时默认目标就是**当前会话**。它在 `/` 菜单里的参数提示串是 `[list|nodes|scan|hide|plan|apply|verify|purge|rollback|undo] [plan.json] [--lines <n>] [--session <id>] [--commit]`。

| 子命令 | 语法 | 输出 / 行为 |
|---|---|---|
| `list` | `/redact list` | 列出会话（按体积降序），**压成一行**：`共 N 个会话（按体积）：` + 若干段 `<id 前 8 位> <体积>`（人类可读写法，如 `1.5MB` / `805.4KB` / `551B`），段间用 ` ｜ ` 分隔，当前会话在该段末尾标 `(当前)`；按 200 显示格预算逐段收敛，放不下就接 ` …另M个`，末尾固定提示 ` 用 /redact nodes 看当前会话`。无参数时默认执行它 |
| `scan` | `/redact scan <plan.json> [--session <id>]` | **只定位**：`会话 <id>：共 N 行，命中 M 行` + 命中行号（最多 12 个，其余 `…（共 M）`），或 `未命中任何内容`；末尾固定打印 `（只定位，未改动任何文件）`。行数含头部行。⚠️ 它只用 `substitutions[].find` 作为探针：计划里只有 `setFields`/`blankLines` 时它无法定位，会显示"未命中"；`substitutions[].lines` 会被遵守：只报限定区间内的命中，并在输出里注明 `（已有 substitutions[].lines 限定，此处只报限定区间内的命中，与 apply 语义一致）` |
| `nodes` | `/redact nodes` | 列出**当前会话** surface 上的 `tool/result` 节点，**最新在前**，每条一段 `[序号] 行号 工具名 体积`（如 `[1] 7 web_fetch 123B`），段间用 ` ｜ ` 分隔：`共 N 个 tool/result（最新在前）：[1] … ｜ [2] … 隐藏用 /redact hide <序号>`。工具名是用该结果的 `message.source.callId` 回到 `tool/call` 事件里对出来的（对不上显示 `(未知工具)`）；体积 ≥1KB 时写作 `12.3KB`。按 200 显示格预算收敛，放不下就 ` …另N个`。**只显示行号与体积，不显示正文**；这份列表按会话记住，供 `/redact hide <序号>` 引用 |
| `hide` | `/redact hide <序号\|plan.json> [--commit]`、`/redact hide --lines <行号> [--commit]` | **只作用于当前会话**，三种定位方式（见下）：① `<序号>` 引用**最近一次 `/redact nodes`** 的第 N 条；② `<plan.json>` 找出 `data.message` 里含 `substitutions[].find` 的 `tool/result` **表面节点**；③ `--lines <行号>` 按日志行号（就是 `nodes` 打印的那个行号）定位。不加 `--commit` 只试算（`试算：将隐藏 N 个节点（seq 5）· 加 --commit 执行`，或 `试算：未命中任何 tool/result 节点`；不写会话、不碰磁盘）；加 `--commit` 才逐个追加替换节点，并报告 `已隐藏 N 个节点 · 下一轮请求起模型不再看到 · 磁盘字节仍在（会话关闭后用 apply 清理）`（一个都没命中则是 `未命中任何 tool/result 节点，未做改动`）。**磁盘字节不变**，从下一轮请求起生效 |
| `plan` | `/redact plan <plan.json> [--session <id>]` | **试算，不写任何文件**：`试算通过（未写任何文件）` + 字节变化 + 帧/行统计 + `自检：JSON 可解析、头部合法、seq 密集` |
| `apply` | `/redact apply <plan.json> [--session <id>] [--allow-live]` | **就地执行**：记录文件修订号 → 读盘 → 试算 → 复查修订号（期间被追加过就整单拒绝）→ 写隔离备份 → 落盘 → 清理派生缓存，并列出仍需你自行处理的位置。`--allow-live` 时若日志尾部有**残帧**会拒绝执行（写句柄缓存着按改写前布局算出的截断偏移，可能造成静默损坏） |
| `verify` | `/redact verify [--session <id>]` | `会话 <id>（v<版本>）` + `帧 N / 行 N / 解析失败 N / 头部合法 是\|否` + `seq 密集性：通过` + `结论：读取端可正常打开`；帧头损坏时返回 `日志无法解析：<原因>` 而不是抛异常 |
| `purge` | `/redact purge [--session <id>]` | 删除该会话的派生缓存文件并逐个列出，然后列出**本工具不会自动改动**的位置 |
| `rollback` | `/redact rollback <轮数> [--session <id>] [--commit]` | **按轮回退**：数出日志里的 `turn/end` 边界，把最后 N 轮整体截断（省略轮数时按 1 轮）。默认只试算（`会话 <id>：共 T 个完整轮次` + `回退 N 轮 → 保留 K 轮，从第 L 行起截断（共 D 行会被删除）`），加 `--commit` 才落盘。至少要保留 1 轮；日志里没有 `turn/end` 时直接拒绝 |
| `undo` | `/redact undo [--session <id>] [--commit]` | **撤销上一次脱敏**：找出该日志**最新**的隔离备份，默认只试算（列出找到几个备份、最新一个的名字/大小/时间、当前日志字节数）；加 `--commit` 才恢复，并先把**当前状态**另存为 `<log>.before-undo-<时间戳>`，随后清理派生缓存 |

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

1. **所有空白被压平**：`\n`、`\t`、连续空格全部变成一个空格——**多行输出到这里必然变成一行**。
2. **按 200 个显示格截断**，末尾补 `…`。宽度是终端显示格，**CJK 一个字算 2 格**，所以中文输出实际上只有约 100 个汉字的位置。

结论，请照这个前提使用本工具：

* **不要指望可读的多行排版。** 任何超过 200 格的内容，尾巴一定被砍掉。
* **不要围绕"从通知里复制一长串东西"来设计操作。** 通知是压平 + 截断过的，长路径、长行号既可能已经被截掉，也不好选中。这正是 `hide <序号>` 存在的理由：跑完 `/redact nodes`，隐藏最新那条只要敲 `/redact hide 1 --commit`，**不用从通知里复制任何字符**。
* 因此 `list` / `nodes` / `hide` 的输出被**刻意做成"单行 + 重要信息在前"**：宁可少列几条（`…另N个`），也不让关键的行号/序号被截掉。
* `verify` / `plan` / `apply` / `purge` / `rollback` / `undo`，以及用法与报错文本，handler 返回的原始字符串仍然是多行的（换行符还在），但渲染到通知里同样会被压成一行、并在 200 格处截断——所以它们都把最重要的结论放在最前面。

细节（都来自实现，不是约定）：

* **`rollback` 与 `undo` 默认都是试算**，必须显式 `--commit` 才落盘；`hide` 同理。`rollback` / `undo` 与 `apply` 一样都**拒绝作用于当前正在使用的会话**，除非显式 `--allow-live`；而 `hide` 恰好相反——**它只作用于当前会话**，`--session` 指向别的会话时直接报错，也不接受 `--allow-live`。

* **`nodes` 是给 `hide <序号>` 用的。** 它只列**当前会话** surface 上的 `tool/result` 节点，**最新在前**（刚触发风控的几乎总是最近那条），每条一段 `[序号] 行号 工具名 体积`，工具名用该结果的 `message.source.callId` 回到 `tool/call` 事件里对出来。整条输出是一行、按 200 格预算收敛。它**不显示正文**，也不暴露内部 `seq`（`seq` 只出现在 `hide` 的试算结果里）。

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
* 未知子命令返回 `未知子命令 <cmd>` 加用法；既没有 `agent` 也没有 `--session` 时报 `无法确定目标会话，请加 --session <id>`。

### 3.2 `plan.json` 完整字段

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

### 3.3 一个可用的 `plan.json` 例子

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

### 3.4 离线 CLI

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

`plan` / `apply` / `cut` 的执行统计长这样（字段含义见 §1 与 §3.2）：

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

### 3.5 两条推荐流程

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
/redact nodes                                 # 4. 当前会话的 tool/result 列表（最新在前：序号 行号 工具名 体积）
/redact hide 1                                # 5. 试算：隐藏第 1 条（最新那条）——4 个 token，不用复制任何东西
/redact hide 1 --commit                       # 6. 真正遮蔽（下一轮请求起生效，无需重启）
/redact hide --lines 7 --commit               #    或者按日志行号（7 就是 nodes 里打印的行号）
/redact hide  C:\plans\plan.json --commit     #    或者按 plan.json 里的 find 匹配（同样先试算再 --commit）
/redact apply C:\plans\plan.json --session <id>   # 7. 给"没人在用"的会话真正重写磁盘字节
/redact verify --session <id>                     # 8. 复验
/redact purge  --session <id>                     # 9. 清派生缓存（apply 已做过一次，可再确认）
/redact undo   --session <id>                     # 10. 反悔：先试算，确认后加 --commit 从隔离备份恢复
```

第 4～6 步是**专门为"通知被压成一行"设计的**：`nodes` 把序号、行号、工具名、体积压进一行，`hide <序号>` 只要一个数字就能指到那条节点（见 §3.1 的渲染约束）。

要注意分工：**对当前会话的 `apply` 一定会被拒绝**（见 §4），所以"我正在用的这个会话"要分两步走——先用 `hide --commit` 立刻让模型看不到（字节仍在盘上），再在会话关闭后用离线 CLI（或 `--allow-live` + 重启）把字节真正抹掉。反过来，`hide` 只认当前会话：别的会话请直接用 `apply`。想撤回的是**整轮对话**而不是某段文本，用 `rollback <轮数>`；想撤回的是**自己刚才那次脱敏**，用 `undo`。

---

## 4. 安全模型

| 闸门 | 具体行为 |
|---|---|
| **绝不打印内容** | `/redact` 与 CLI 只输出**行号与计数**。`inspect --match` 只给命中行号；`paths` 只给路径、类型与长度；JSON 解析失败信息也经过清洗（只保留 `position N`，剥掉 Node 报错里附带的输入片段），避免错误信息把原文漏到终端或日志里 |
| **就地替换前先写隔离备份** | TUI 内：`<log>.quarantine-<时间戳>`（ISO 时间，`:` 和 `.` 换成 `-`）；CLI `--apply`：同样规则。**备份里仍是原文**，确认无误后请自行删除它——本工具不会自动删 |
| **落盘方式** | **非活动会话**：写隔离备份 → 写成 `<log>.redact-tmp` → `rename` 覆盖。**活动会话（`--allow-live`）**：写隔离备份 → `open('r+')` → 写入 → `ftruncate` → `fsync` **原地覆盖**——改名替换可能与此刻正在发生的追加句柄相撞（Windows 上尤其明显），而后端每批追加都是重新 `open(path,'a')` 写 EOF，覆盖写不会与它冲突 |
| **并发追加检测** | `apply` 与 `rollback` 在读取前记录文件修订号（`size:mtimeMs:ctimeMs`），落盘前再取一次；只要期间被追加过就**整单拒绝**（`未执行：日志在本次读取之后被追加过（可能有并发写入）`），以免覆盖掉新事件 |
| **`--allow-live` 的额外闸门** | 活动会话改写时，若日志尾部存在**残帧**，直接拒绝：写句柄缓存着一个"按改写前布局算出的截断偏移"，下次追加会按它截断，可能造成**静默损坏**。请关掉该会话再执行 |
| **`rollback` 的边界保护** | 只在完整的 `turn/end` 边界上截断，且至少要保留 1 轮（日志里没有 `turn/end` 时直接拒绝）；若截断会移除继承型 `session/end-seed` 标记（读取端会判定整份日志损坏），同样拒绝执行 |
| **`undo` 不覆盖式回退** | 恢复前先把**当前状态**另存为 `<log>.before-undo-<时间戳>`，再从最新隔离备份复制回来——两端都留有副本，撤销本身也可追溯 |
| **拒绝改写在用的当前会话** | 目标是当前会话且没给 `--allow-live` 时，`apply` / `rollback` / `undo` 一律直接报错：它的写句柄仍持有该日志，就地替换可能让后续追加失败。报错信息给出安全做法，并要求 `--allow-live` 之后重开会话以重新加载历史 |
| **写盘前内部自检** | 输出前重新校验：JSON 全部可解析、头部合法、**`seq` 密集**。任何一项不过就放弃输出（`内部自检失败，已放弃输出`），宁可不写也不写坏 |
| **头部行与结构键受保护** | 第 1 行不能被删/清空/改写；`type`/`seq`/`time`/`surfaceOp`/`sourceEventSeqs`/`toolCallId`/`callId`/`role`/`id` 这些键不会被 `substitutions` 或 `blankLines` 动到，也不会被 `setFields` 写入 |

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
会话 <id>（v3）
帧 3 / 行 6 / 解析失败 0 / 头部合法 是
seq 密集性：通过
结论：读取端可正常打开
```

（这是 handler 返回的原始文本；渲染到通知里会被压成一行：`会话 <id>（v3） 帧 3 / 行 6 / 解析失败 0 / 头部合法 是 seq 密集性：通过 结论：读取端可正常打开`。见 §3.1 的渲染约束。）

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

`verify` 报 `seq 密集性：通过` 的含义就是"这个不变量成立，读取端能正常打开"。它**不**保证内容已经不在了——内容是否还在，要用第 3 步的命中复扫确认。

### 仓库里的自测

四份脚本，全部只用**合成日志**（假内容，不碰任何真实会话），分别覆盖不同层次：

| 脚本 | 断言 | 覆盖什么 |
|---|---|---|
| `test/handler.selftest.mjs` | 159（脚本自己打印 `N/M 通过`） | **插件 handler 层**：命令注册元数据、`list`/`scan`/`hide`/`plan`/`apply`/`verify`/`purge` 的输出与副作用、`--session` 与 `--allow-live`、各类错误路径、`list` 的**单行 + 200 显示格预算**（含 `(当前)` 标记、`…另N个`、人类可读体积）、`hide` 的试算与 `--commit`（断言试算文案 `将隐藏 N 个节点`、`surfaceOp`/`sourceEventSeqs` 形状、正文已换占位符、**不删磁盘字节**）、嵌套 `blankLines`、跨帧全局替换、后缀删行、中间删行、`renumber` 的引用重映射与悬空引用拒绝（断言**抛出 `RedactError`**）、头部帧原字节保留 |
| `test/bugfix-regression.mjs` | 48（`48/48 通过`） | **回归守卫**：非法计划与中间行删除只返回错误、**进程存活**（BUG-1/BUG-1b）、损坏帧返回错误（BUG-2）、`scan` 定位且不泄漏原文、`rollback` 的试算/执行/保留边界/留隔离备份、`undo` 的查找/执行/留撤销前快照/无备份时报错、`apply`/`rollback`/`undo` 三者对当前会话的拒绝，以及会话内隐藏全线：`nodes` 单行且 ≤200 格、**最新在前**、`[序号] 行号 工具名 体积`、工具名对得上、不显示正文、不暴露 `seq`，`hide <序号>` 解析与越界报错，`hide --lines` 命中与未命中，`--commit` 的替换节点形状与**紧邻** `compaction/prune` 遮蔽价签 |
| `test/preflight.mjs` | 无断言（冒烟） | 模块可导入、`name`/`inject`/`apply` 形状、命令能注册（打印 hint 与 `recordInput`）、`list` 能跑通，以及未知会话 / 未知子命令 / 缺计划文件 / 无 agent / 会话无 surface 时 `hide` 的报错文案 |
| `session-surgery/selftest.mjs` | 34（`34/34 通过`） | **引擎 / CLI 主路径**：帧扫描与逐帧统计、命中定位且不回显原文、`paths` 不打印值、三种原地改写生效且行数/帧数/`seq` 不变、未触碰帧原字节保留、中间行删除无 `renumber` 时被拒、带 `renumber` 时放行、后缀删除直接放行、拒绝删除/清空头部行、拒绝改写结构键 `seq`、损坏文件被拒、`verify` 正常退出、`plan` 试算不写文件 |

```sh
# 在 dsh-plugin-redact/ 里
node test/handler.selftest.mjs     # 失败退出码 1，末尾打印 N/M 通过
node test/bugfix-regression.mjs    # 回归守卫，48/48 通过
node test/preflight.mjs            # 冒烟检查，只打印观察结果

# 引擎 / CLI 那份在隔壁目录
cd ../session-surgery
node selftest.mjs                  # 34/34 通过
```

四份都需要 **Node >= 22.15**（zstd API），且都不需要 DSH 在运行。`handler.selftest.mjs` 会把 `DSH_HOME` 指向 `mkdtemp` 出来的临时目录（夹具跑完即删），并打印**被测 `index.js` 的字节数与 sha256 前 12 位**，方便你确认"通过的到底是哪一版"；它还会把 `process.exit` 换成抛异常作为安全网（现在这条路径已经不再触发——引擎改为抛 `RedactError`，它同时把这一点作为"探针"记录下来，见 §6）。

`test/` **不在 `package.json` 的 `files` 列表里**，所以这些脚本只存在于源码仓库、不随 npm 包发布；`package.json` 也没有配置 `scripts`，请直接 `node <文件>` 运行。

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
14. `scan` 遵守 `substitutions[].lines`：只报限定区间内、且 `apply` 真的会改的行，输出里会注明 `（已有 substitutions[].lines 限定，此处只报限定区间内的命中，与 apply 语义一致）`。`verify` 遇到帧头损坏的日志现在会返回 `日志无法解析：<原因>` 而不再抛异常，但要复核这类文件仍建议用离线 `dsh-redact verify`——它以退出码 2 报告问题。
15. **`rollback` 依赖 `turn/end` 事件。** 日志里没有 `turn/end` 就完全无法按轮回退（会直接拒绝），而且至少要保留 1 轮——它不能把整个会话清空。截断会碰到继承型 `session/end-seed` 标记时也会拒绝。
16. **通知永远是一行、最多 200 个显示格。** 这是 dsh-tui 的渲染约束（见 §3.1），不是本工具的选择：换行被压成空格，超出部分被砍掉，中文一个字占 2 格。`list` / `nodes` / `hide` 已经按这个前提设计成"单行 + 重要信息在前"，并且会主动丢掉靠后的条目（`…另N个`）。**不要围绕"从通知里复制一长串东西"来设计操作**：要隐藏最新那条，直接敲 `/redact hide 1 --commit`。
17. **`hide <序号>` 依赖内存里的节点列表。** 序号引用的是**本会话最近一次 `/redact nodes`** 的结果，它只存在宿主进程内存里、按会话保存：还没跑过 `nodes`（或进程重启过）就必须先重新 `nodes`，否则报 `还没有节点列表，请先运行 /redact nodes`。不想依赖这份列表，就用 `hide --lines <行号>`（行号你自己知道的话）或 `hide <plan.json>`。

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
   "files": ["index.js", "cordis.patch.yml", "lib/engine.mjs", "bin/dsh-redact.mjs", "README.md", "README.zh.md"]
   ```

   * `index.js` —— 插件入口（`export const name` / `export const inject` / `export function apply`）
   * `cordis.patch.yml` —— `dsh.bundle.patch` 指向的层
   * `lib/engine.mjs` —— 引擎，被 `index.js` 相对引用
   * `bin/dsh-redact.mjs` —— 离线 CLI（`bin.dsh-redact`）
   * 两份 README

   仓库里的 `test/`（`handler.selftest.mjs`、`bugfix-regression.mjs`、`preflight.mjs`，以及构建期的 `patch-engine-error-model.mjs`）**故意不在 `files` 里**，所以自测脚本不会随包发布。想让消费者也能跑自测，再把它们加进去。
2. **打包预览**，确认没有漏文件、没有把不该发的带进去：

   ```sh
   npm pack --dry-run
   ```
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

离线 CLI 随包安装（`bin.dsh-redact`），在 profile 目录里可用 `npx dsh-redact` 或直接调用该入口文件。

### 8.5 分发时的三条提醒

* **DSH 没有官方插件 registry。** 官方只文档化了 npm / tarball / git 三种分发方式，并明确"不要求发布到 registry"；也不存在官方提交表单或审核步骤。社区目录（如 cordis.run 及其自动生成的 Awesome 列表、`dsh-plugin-verify` 验证仓库、dshfind.com / dsh.so，以及 `dsh-tui-ecosystem` + `dsh-ecosystem-spec` 准入规范）**都是社区自建、各自有各自流程的**，不代表官方背书。
* **第三方插件以受信任的宿主代码运行，不在沙箱里。** 装一个插件就等于用它跑在你机器上的权限执行它的代码；它能读写你的会话日志——本插件正是靠这一点工作的。请像审查任何本机程序一样审查它，发布时也请把你的权限需求写清楚（本包只 `inject: ['commands']`，不发布服务、不联网，读写的是你自己指定的 `root` / `cacheRoot`）。
* **README 里不要放真实敏感内容。** 示例、issue、截图、测试夹具都可能长期留在公共记录里——这也是本工具存在的原因。

---

## 9. 许可

MIT。

# dsh-plugin-redact 修复报告（红队 F1–F10 + 元发现）

**范围**：实现 `%USERPROFILE%\dsh-redact-redteam\REPORT-zh.md` 给出的最小修复建议，并用**真实 DSH 读取端**当判据证明修复有效。
**判据**：`@deepseek-ai/dsh-session-persistence-jsonl` 的 `JsonlSessionPersistence.open()`、`dsh-session` 的 `Session`、`dsh-session-format-catalog` 的编解码器、`dsh-session-title` 的真实不变式。**没有**把引擎自己的自检当作「DSH 打得开」的证据。
**数据**：全部为合成日志，落在 `mkdtemp` 临时目录，跑完即删。**未读取/解压/打印任何真实会话内容、缓存或 `*.jsonl.zstd`**，未改动 `%USERPROFILE%\.dsh` 下任何字节（只有插件自身的 `otherCopies()` 会对固定路径做 `existsSync`/`readdir` 探测——那是它的既有行为，不读内容）。

---

## 0. 交付物与最终状态

| 文件 | 变化 |
|---|---|
| `dsh-plugin-redact\lib\engine.mjs` | 34076B → **51755B**（F1 / F2 / 总闸 / F7 引擎侧） |
| `session-surgery\zsplice.mjs` | 与 `engine.mjs` **逐字节相同**（`SequenceEqual` = True，51755B） |
| `dsh-plugin-redact\index.js` | 35446B → **45665B**（F3 / F4 / F5 / F6 / F7 handler 侧 / F9 / F10） |
| `dsh-plugin-redact\test\real-reader.mjs` | **新增**：真实读取端助手（真实 `Session` / 编解码器 / 后端 / title 不变式） |
| `dsh-plugin-redact\test\hardening.mjs` | **新增**：F1–F10 回归套件（78 条断言，判据=真实读取端） |
| `dsh-plugin-redact\test\bugfix-regression.mjs` | 夹具改为**读取端合法**（真实 `Session` 生成）+ 6 条真实后端断言；48 → **54** |
| `dsh-plugin-redact\test\handler.selftest.mjs` | `hide` 夹具的消息形状改为真实形状（断言条数不变，159 → **159**） |
| `dsh-plugin-redact\README.zh.md` | 安全闸门表、`undo` 说明、自测表（含新增套件与实测计数）同步 |

**被测版本（最终字节，`after\` 里的所有输出都由这两个字节的版本产出）**

| 文件 | 字节数 | sha256 前 12 位 |
|---|---|---|
| `lib\engine.mjs` = `session-surgery\zsplice.mjs` | 51755 | `1ea235d3d36b` |
| `index.js` | 45665 | `b8eeb35ea301` |

**最终实跑（串行、无并发夹具干扰）**

| 套件 / 脚本 | 结果 |
|---|---|
| `test\handler.selftest.mjs` | **159/159 通过**（exit 0） |
| `test\bugfix-regression.mjs` | **54/54 通过**（exit 0） |
| `test\hardening.mjs`（新增） | **78/78 通过**（exit 0） |
| `session-surgery\selftest.mjs` | **34/34 通过**（exit 0） |
| 红队 `p1-refs` | F1/F2 的三条「缺陷成立」断言**已翻转**，真实后端**能打开**输出（7 events） |
| 红队 `p2-undo` | A/A2 两条「undo 报告成功」断言**已翻转**（现在拒绝），当前日志零改动 |
| 红队 `p3-hide` | **P3: 未发现半途变更类缺陷**（F9/F10 断言全绿） |
| 红队 `p4-write` | **P4: 未发现问题**（CLI 并发 8 轮：备份被覆盖 0 次，损坏 0 次） |
| 红队 `p5-rollback` | 仅剩红队自己写错的那条正则（见 §5.3） |
| 红队 `p6-scale` | applyPlan 4511→2033ms、峰值 RSS 589.8→417.6MB、1001 帧 2420→490ms、30 万行 renumber **不再 RangeError** |
| 红队 `p7-purge` | **P7: 未发现问题**（D/E/F 三段全绿） |
| 红队 `p8-structural` | **P8: 未破坏可读性**（5/5 PASS，无回归） |

---

## 1. 基线说明（必须先说清楚）

报告的基线是 `index.js 35905B sha256:4fb20cb1…` 与「三套 159/48/34 全绿」。**我接手时磁盘上的 `index.js` 已经是 35446B（sha256:ac8cf65ada8e，mtime 晚于 engine）**，即报告之后被改过一次，后果是：

* `handler.selftest.mjs` 实跑 **158/159**（exit 1）：唯一的失败是
  `拒绝信息说明原因并给出可执行的出路（单行，出路在前）` —— 拒绝文案里的
  `或切到其它会话后执行 apply --session <id>` 少了 `/redact` 前缀，因此
  `/\/redact apply .* --session /` 匹配不上。

**处理**：这不是我引入的，也不是可以「放宽断言」绕过的东西——断言描述的是文案该有的样子（把可执行的完整命令给用户）。我把 `index.js` 的该文案恢复成
`或切到其它会话后执行 /redact apply <计划.json> --session <id8>`（整体 167 显示格 < 200，`--allow-live` 仍在第 38 个字符处），于是 **159/159 全绿，且没有削弱任何断言**。

因此本报告的 before/after 均以「接手时的字节」为基线（before 输出存档在 `%USERPROFILE%\dsh-redact-fix\baseline\`，after 在 `…\after\`）。
唯一的例外：**F7 的 before 数字来自红队报告的实测值**——我接手时磁盘上只有修复后的 `engine.mjs`（没有 git、没有旧副本），无法重跑旧代码；其余每条 finding 我都有自己跑的 before 输出。

---

## 2. 逐条缺陷

### F1（critical）`sourceEventSeqs` 的游程形式没有重映射

**改了什么**（`lib/engine.mjs`）

* 新增形态感知的 `remapRefs`（`:560`）：
  * 全为整数 → 逐项 `map`（**保持整数形态**，不额外改变盘上形状）；
  * 含 `[start,end]` 项 → **把区间展开成每一个 seq**、逐个 `map`，再用与读取端写入路径**同一份** `encodeSeqRanges`（`:154`，逐字等价于 `dsh-session-format-v1-to-v2/lib/index.js:327-342`，也就是 `dsh-session/lib/types/seq-ranges.js:11-27` 的孪生实现）重新压缩；
  * 其它任何形状（长度≠2 的数组、字符串、负数、非安全整数、长度超过日志行数的区间）→ `die()` 拒绝。
  * 关键点：**区间中间的 seq 也会被检查**。旧实现只对区间元素做 `map`（且非整数原样返回），悬空检查 `dropped.has(v+1)` 永远不会触发。
* 悬空检查仍然报出原来的措辞（`引用了被删除的第 N 行（seq M）`），套件 9e/9f 的断言一字未改。

**证据**

```
# before（p1-refs）
      → 改写后该行: seq=4 surfaceOp={"op":"replace","startSeq":1,"endSeq":3} sourceEventSeqs=[[2,4]]
FAIL  (a) DSH 真实后端仍能打开引擎的输出  — SessionPersistenceCorruptionError:
      invalid committed event at line 5: sourceEventSeqs range exceeds its event seq

# after（p1-refs）
      → 改写后该行: seq=4 surfaceOp={"op":"replace","startSeq":1,"endSeq":3} sourceEventSeqs=[[1,3]]
FAIL  (a) 游程 sourceEventSeqs 未被重映射（仍是 [[2,4]]）      ← 这条断言本身在描述缺陷，翻转=修好
PASS  (a) DSH 真实后端仍能打开引擎的输出  — 7 events
```

新增套件里的等价断言（`hardening.mjs`）：
`★ F1 游程被展开→逐项映射→按读取端同一压缩器重新压缩`（`[[1,3]]`）、
`★ F1 引擎输出能被真实后端打开`、`★ F1 区间中间的 seq 被删时拒绝执行`（报错点名 `展开出的 seq 3`）。

### F2 `session/title.data.messageSeqs` 不在引用清单里

**改了什么**（`lib/engine.mjs`）

* 新增**显式引用字段清单** `REF_PATHS`（`:126`），来源是读取端自己唯一权威的那份映射
  （`dsh-session-format-v2-to-v3/lib/types/references.js:623-673` 的 `remapEvent()`）：
  `surfaceOp.startSeq/endSeq`、`sourceEventSeqs`、`data.shadowedSeqs`、`data.shadowedRange.start/end`、
  **`data.messageSeqs`**、**`data.sourceEventSeq`**（`command/done`，报告清单里没写但读取端确实要搬）、以及行自身的 `seq`。
* `remapRefs` 对 `data.messageSeqs` / `data.shadowedSeqs` / `data.sourceEventSeq` / `data.shadowedRange` 做逐个映射；成员不是非负安全整数就拒绝（读取端 `sessionFormatCount` 会同意的形状才算合法）。
* 新增**失败关闭审计** `auditRefFields`（`:214`）：递归扫描每一行，凡是键名以 `seq`/`seqs` 结尾（不分大小写）却不在清单里的字段 → `die()` 并报出**完整路径**。
  * 报告给的正则是 `/(^|_)(seq|seqs)$/i`；它对驼峰完全无效（`messageSeqs`、`shadowedSeqs`、`sourceEventSeq`、`sourceEventSeqs` 一个都匹配不到），审计会形同虚设，所以这里用「以 seq/seqs 结尾」的等价加强版，两种写法都覆盖。
  * 审计只作用于**真正会被重编号的行**（第一个被删行及其之后）。第一个被删行之前的行 seq 不变、引用一律向后指，不可能悬空——所以不必为了审计把整份日志都解析一遍。

**证据**

```
# before（p1-refs）
      → 改写后 session/title: seq=3 messageSeqs=[2]
PASS  (b) messageSeqs 未被重映射（仍是 [2]）            ← 描述缺陷
FAIL  (b) 真实 title 不变式接受改写后的日志  — session/title event 3 message seq 2 must name an earlier human user/message

# after（p1-refs）
      → 改写后 session/title: seq=3 messageSeqs=[1]
FAIL  (b) messageSeqs 未被重映射（仍是 [2]）            ← 翻转=修好
FAIL  (b) 该引用现在指向的不是 user/message（悬空）  — 指向 user/message
PASS  (b) 真实 title 不变式接受改写后的日志  — 通过
```

### F1+F2 总闸：`applyPlan` 的自检改成「按读取端语义回放输出」

**改了什么**（`lib/engine.mjs`）

* 新增 `verifyLog(buffer)`（`:326`）：**一遍解码**同时覆盖
  1. 帧可解码（含校验和）；
  2. 每行 JSON 可解析；
  3. 头部合法（`type:"session"`、非空 `id`、可选的 `version/createdAt/isSeeded/delegationDepth` 形状）；
  4. **seq 密集**（`seq === 行号-1`）；
  5. **引用字段回放**：`sourceEventSeqs` 用 `expandSeqRanges`（`:176`，逐字复刻读取端 `decodeSeqRanges`：整数或 `[start,end]`、端点非负安全整数、`start<=end`、`end <` 本行 `seq`、展开后不超上限、唯一、带区间时严格递增、非空）；`surfaceOp` 必须是 `"append"` 或正好 `{op,startSeq,endSeq}` 且端点 `<` 本行 `seq`；`data.shadowedSeqs`/`data.messageSeqs` 必须是非负安全整数数组且不重复；`data.shadowedRange.start/end`、`data.sourceEventSeq` 必须是计数；
  6. **`session/title` 的真实不变式**（`dsh-session-title/lib/types/invariant.js:19-43`）：`(messageSeqs.length === 0) !== (source.kind === 'user')` 必须为假，且每条 `messageSeqs` 必须 `<` 本行 `seq` 且指向**更早的 `source.kind === 'user'` 的 `user/message`**（用一张按 seq 索引的 `humanUser` 位表，O(行数) 字节）。
* `applyPlan` 把旧的「`inspectBuffer` + `checkSeqDensity`」两次解码换成这一遍（顺带解决了 F7 的重复解码），任何一项不过就 `die('内部自检失败，已放弃输出（…）')`，绝不写盘。
* `index.js` 的 `verify` 子命令与 `undo` 的备份校验复用同一个 `verifyLog`（判据唯一）。

`hardening.mjs` 直接对 `verifyLog` 做了 7 条一票否决断言（游程超界 / 重复引用 / seq 缺口 / 头部非法 / surfaceOp 端点不更早 / title 引用非人类 user/message / 合法日志放行）。

### F3 `undo` 不校验隔离备份就覆盖健康日志

**改了什么**（`index.js`）

* 装回之前：读出备份字节 → `verifyLog` 必须 `ok`；**额外**要求 `tornStart === undefined`（截断在帧边界处的备份不会留残帧，却会**静默少事件**——这是 p2 A 段实测的坏结局）；再做一次交叉检查：备份的事件数**不得少于**当前日志（`apply` 不改事件数、`rollback` 只会变少，所以这条对本工具自己产出的备份恒成立）。
* 任何一条不过 → `kind:'error'`，文案含「**当前日志未改动**（N B）」与「可改用更早的 `.quarantine-*` 或 `.before-undo-*` 备份手工恢复」，并**不做任何写操作**。
* 安装方式从 `copyFileSync(备份 → 日志)` 改为「写 `<log>.redact-tmp` → `fsync` → `renameSync`」，`.before-undo-*` 先存当前状态；失败时清理 tmp。

**证据**

```
# before（p2-undo）
      → 备份被截断: 647 → 323 字节
PASS  A. undo 报告成功（没有校验备份）
PASS  A. 当前日志被坏备份覆盖  — 656 → 323
      → 截断备份被当成崩溃尾读取：ok=true events=3
PASS  A2. 覆盖后 DSH 无法打开该会话（硬损坏）  — corrupt Zstandard session log: frame at byte 290 failed validation

# after（p2-undo）
      → 备份被截断: 634 → 317 字节
FAIL  A. undo 报告成功（没有校验备份）  — 拒绝恢复：备份 …quarantine-… 尾部有未完成残帧（字节 287），可能少了一批事件 · 当前日志未改动（643B） · 可改用更早的 .quarantine-* 或 .before-undo-* 备份手…
FAIL  A. 当前日志被坏备份覆盖  — 643 → 643        ← 零改动
FAIL  A2. undo 报告成功  — 拒绝恢复：备份 … 不合格（第 2 帧解码失败（压缩块或校验和不合法）） · 当前日志未改动（646B）
FAIL  A2. 覆盖后 DSH 无法打开该会话（硬损坏）  — 仍可打开
```

### F4 live 写路径的顺序、修订号复查、短写与 fsync

**改了什么**（`index.js` 的 `commitRewrite`，`:412`）

* `open('r+')` 之后、写入之前**再比一次修订号**（`revisionOf`）；从「读取+比对」到真正拿到 fd 之间的窗口由此关掉。
* 输出比原文件短 → **先 `ftruncate(out.length)` 再写**：在这个窗口里死掉，文件是**旧日志的前缀**（读取端本来就容忍崩溃尾），而不是旧实现的「新头+旧帧」混合体。
  * 输出比原文件长时**故意不用 ftruncate 打头**：`ftruncate` 会先把尾部补 0（洞），一旦中断反而制造「完整帧边界 + 0」的硬损坏；这种情况直接按长度写满，写完复查文件长度即可。
* 写入用 `writeAllSync`（`:385`）循环直到写完，并校验累计字节数 `=== out.length`；写完 `fsync`。
* 写完要求文件长度**精确等于** `out.length`；若更长说明期间有并发追加 → 报错并**保留**追加内容（不 truncate 吃掉它），错误里点名隔离备份。
* 非活动会话路径补上「tmp `fsync` → `rename` → 目录 `fsync`（尽力而为，Windows 上打开目录会失败，忽略）」。

**证据**（`hardening.mjs` 用**打补丁注入真实并发事件**的方式驱动真实 handler，而不是像 p4 那样手工复刻 syscall 序列）

```
PASS  ★ F4(a) 打开 fd 后被并发追加 → 中止写入并报错
      — 写入失败（日志未被改动，已删除刚生成的隔离备份）：日志在本次读取之后被追加过（可能有并发写入）。已放弃写入，以免覆盖新事件。
PASS  ★ F4(a) 并发追加的事件没有被吃掉  — 656 → 727（+71）
PASS  ★ F4(b) 并发追加的帧没有被 ftruncate 吃掉  — 639 → 710（+71）
PASS  ★ F4(b) 检测到写入期间的并发追加并报错
      — 写入失败（隔离备份 …quarantine-… 仍含原文）：写入期间日志被并发追加（文件 710 字节 ≠ 预期 639 字节）：已保留追加内容，但该批次可能与改写后的布局错位
PASS  ★ F4(b) 报错时点名仍含原文的隔离备份（F6）
PASS  ★ F4(c) 截断后崩溃 → 文件是旧日志的前缀，而不是新旧混合体  — 656 → 642（out=642）
PASS  ★ F4(c) 该状态能被真实后端打开（=可容忍的短尾，不是硬损坏）  — 6 events
PASS  ★ F4(d) 文件长度精确等于 out.length（无短写、无残留尾巴）  — 642 vs 642
PASS  ★ F4(d) 改写后真实后端可打开且事件数不变
```

> p4-write 的 A/B 段是**手工复刻旧 syscall 序列**的演示，所以它修复后仍然「PASS 地展示旧顺序的危害」；证明修复的是上面的注入式测试。p4 的 C 段（CLI 并发）修复后依旧全绿。

### F5 `purgeCache` 抛异常把成功变成失败

**改了什么**（`index.js`）

* `purgeCache`（`:139`）整体改为**绝不抛**：列目录失败、单项 `statSync`/`rmSync` 失败都收集成 `failures[]`；**只对普通文件**动手（`statSync(p).isFile()`，目录/其它类型直接跳过，不再对目录调用非递归 `rmSync`）。
* 返回值从 `removed[]` 变成 `{removed, failures}`；四个调用点（`purge` / `rollback` / `undo` / `apply`）统一用 `purgeNote()`（`:164`）把结果并入**成功**文案：`缓存清理 N（失败 M：<原因>）`。
* 同类问题一并收口：`otherCopies()`（`:168`）是纯探测，也整体 try/catch——它在写盘成功之后运行，同样不该把成功变成异常。

**证据**

```
# before（p7-purge）
FAIL  D. 缓存里存在同名目录时 purge 不抛未捕获异常  — SystemError: … EISDIR … target-session.json
FAIL  F. purgeCache 抛错时命令仍返回结果（不是异常逃出）  — 返回 kind=THREW；日志是否已被改写=true

# after（p7-purge）
PASS  D. 缓存里存在同名目录时 purge 不抛未捕获异常  — 已清理缓存 0 个 · target-s · …
PASS  F. purgeCache 抛错时命令仍返回结果（不是异常逃出）  — 已脱敏 rt-post- · … · 缓存清理 0 · …
PASS  F. 若命令报失败，日志不应已被改写（要么都不做，要么都告知）  — kind=success changed=true
```

### F6 写盘失败时留下含原文的隔离备份却不说

**改了什么**（`index.js`）

* `commitRewrite` 记录目标文件是否**已被改动**（`touched`）：
  * 没动过（如 `.redact-tmp` 写不进去、rename 失败）→ **删掉刚建的隔离备份**，错误文案
    `写入失败（日志未被改动，已删除刚生成的隔离备份）：…`；
  * 动过（例如已 truncate 后写失败）→ **保留备份**（此时它是唯一完整的原文），文案
    `写入失败（隔离备份 <名字> 仍含原文）：…`。
* 关键信息放在最前面，避免被渲染端 200 格截断砍掉（第一版就踩了这个坑，实测被截成 `…· 日志未被改动…`）。
* `undo` 自身的失败路径同样会清理 tmp。

**证据**

```
# before（p7-purge E 段）
      → 残留隔离备份 1 个（含原文）
FAIL  E. 写入失败时不留含原文的隔离备份  — 实际 1 个

# after
      → 返回: 写入失败（日志未被改动，已删除刚生成的隔离备份）：EISDIR: …
      → 残留隔离备份 0 个（含原文）
PASS  E. 写入失败时不留含原文的隔离备份  — 实际 0 个
（「目标已改动」的那一半由 hardening 的 F4(b)/F4(c) 断言覆盖：备份保留且被点名）
```

### F7 病态开销

**改了什么**

* `engine.mjs`：一次遍历预计算「帧 → 行」索引（`:657`），删掉每帧 `lines.map().filter()` 的全表复制；`Math.min(...dropIdx)` 换成一次显式循环求 `firstDropIdx`（`:703`）；输出自检从「`inspectBuffer` + `checkSeqDensity`（两次解码）」合并成 `verifyLog` 一遍（`:828`）。
* `index.js`：`readRows`（把每一行 `JSON.parse` 成对象留在内存）改成 `scanRowFlags`（`:304`）——解析完一行就丢，只留 `turn/end` 行号与继承型 `end-seed` 行号两个小集合，`planRollback` 的行为不变。

**证据**（p6-scale。**before 列引自红队报告 §F7 的实测值**——我接手时磁盘上已经只有修复后的 `engine.mjs`，没有留下可复跑的旧副本；**after 列是我在最终字节上重跑同一个脚本的结果**，脚本本身一字未改）

| 指标 | before（红队实测） | after（本次实测） |
|---|---|---|
| `applyPlan`（25.8MB / 26000 行 / 1041 帧，全帧重写） | 4511ms | **2033ms** |
| 峰值 RSS | 589.8MB | **417.6MB** |
| `checkSeqDensity` + `inspectBuffer`（输出被额外解码的两遍） | 340ms + 351ms | 不再发生（合并为一遍自检） |
| 二次方项：1001 帧 / 24000 行 | 2420ms | **490ms** |
| 30 万行 renumber 中间删除 | `RangeError: Maximum call stack size exceeded` | **1979ms 完成** |

`hardening.mjs` 另加：2 万行中间删除 + renumber 在 291ms 内完成、不抛 `RangeError`、输出仍被总闸接受。

### F9 `hide` 多目标半途失败不告诉用户已经改了什么

**改了什么**（`index.js`）

* `hideInSession` 早就在 catch 里带回 `landed`，但 handler 把它丢了。现在 `hide` 的错误分支会追加：
  `· 已有 N 个节点被永久遮蔽（seq a,b,…），该变更已生效且不可撤销，建议重开会话`。
* 报告建议的「先做一次可提交性检查」没有实现——`session.append` 的失败源（磁盘满 / 句柄失效 / 校验失败）无法在不真正提交的情况下预判，硬做一个假检查只会制造虚假的安全感。见 §6。

### F10 `hide` 对无法替换的节点谎报成功

**改了什么**（`index.js`）

* 进入替换前先要求 `data.message` 是对象；算出替换后的 `message` 后，若它与原文 `JSON.stringify` **逐字节相同**（`content` 不是数组、或数组里没有任何 `text` 块；`JSON.stringify` 抛错也算），就返回
  `第 N 个节点（seq S）的消息形态不受支持（…），未做改动`，**不 append、不报成功**；若此前已有节点落地，错误里同样带上「已有 N 个被永久遮蔽」。

**证据**

```
# before（p3-hide C 段）
      → 返回: 已隐藏 1 个节点 · 下一轮请求起模型不再看到 · 磁盘字节仍在
FAIL  C. content 为字符串时不会谎报「已隐藏」

# after
      → 返回: 第 1 个节点（seq 4）的消息形态不受支持（content 里没有可替换的文本块），未做改动
PASS  C. content 为字符串时不会谎报「已隐藏」
（P3: 未发现半途变更类缺陷）
```

### 元发现：夹具不是读取端合法日志（这条和修复本身一样重要）

**改了什么**

* 新增 `test/real-reader.mjs`：用**真实** `Session` + `sessionFormatCatalog` 造夹具，用**真实** `JsonlSessionPersistence.open()` 判定「DSH 打不开」，另外暴露真实 `dsh-session-title` 不变式。
* `test/bugfix-regression.mjs` 的夹具重写：三个完整轮次、`tool/result` 用真实消息形状
  `{ id, role:'user', source:{kind:'tool',callId}, content:[{type:'tool-result',toolCallId,content:[{type:'text'}]}] }`，
  `user/message` 的 `data` 就是消息本身（不再包一层 `message`），并且**夹具本身必须先被真实后端打开**才算数。夹具目录用 `_no-cwd`（真实后端按目录名推导 cwd，没有 `cwd` 的会话必须落在那里）。
* `test/handler.selftest.mjs` 的 `hide` 夹具同样改成真实形状（`role:'tool'` → `role:'user'` + `source.kind:'tool'`）。
* 新增 `test/hardening.mjs`：F1–F10 的回归套件，**判据是真实读取端**。

**这条元发现本身也被断言固定下来**（`hardening.mjs` 第 0 节）：

```
PASS  ★ 旧夹具形状（role:"tool" / user/message 包一层 message）被真实读取端拒绝
      — SessionPersistenceCorruptionError: session event at seq 2 lacks an identified message
PASS  ★ 真实形状的同类夹具可以打开  — 7 events
```

也就是说：**只要夹具不是读取端合法的，「套件全绿」就证明不了任何东西**——F1/F2 就是这样从 159/48/34 全绿里溜过去的。现在 `bugfix-regression.mjs` 里 `★ 夹具：改写前 DSH 真实后端可打开（读取端合法）`、`★ rollback/undo/apply 后 DSH 真实后端可打开` 等 6 条断言把这条规矩固化。

---

## 3. 汇总表：finding → fix → repro before/after → 套件影响

| # | 修复位置 | 复现脚本 before（缺陷） | after（不再复现） | 套件影响 |
|---|---|---|---|---|
| **F1** | `engine.mjs:560` `remapRefs` 形态感知；`:154` `encodeSeqRanges`；区间展开逐个映射 | 后端 `sourceEventSeqs range exceeds its event seq`；输出 `[[2,4]]` | 输出 `[[1,3]]`；**后端 7 events 打开** | handler 159/159（9e/9f 断言未改）；hardening +8；new. |
| **F2** | `engine.mjs:126` `REF_PATHS`、`remapRefs` 补 `messageSeqs`/`sourceEventSeq`、`:214` `auditRefFields` | title 不变式 `message seq 2 must name an earlier human user/message` | `messageSeqs=[1]`，**真实不变式通过**；清单外字段被拒 | handler 159/159；hardening +7 |
| **总闸** | `engine.mjs:326` `verifyLog`，`applyPlan:828` 用它替换两次解码 | 旧自检看不见读取端语义（F1/F2 的输出它都说「通过」） | 6 类「读取端会拒绝」的输出逐条被拦 | hardening +7 |
| **F3** | `index.js:708` 备份校验（含残帧/事件数交叉检查）+ tmp→rename 安装 | 截断备份被装回：`ok=true events=3` 静默丢事件；bitrot 备份 → 会话硬打不开 | **拒绝恢复**，当前日志 643→643 零改动，仍可打开 | bugfix 54/54（undo 正常路径仍绿）；hardening +9 |
| **F4** | `index.js:412` `commitRewrite`：写前复查修订号、先截断后写、`writeAllSync` 校验字节数、长度复查、fsync | p4 A 段手工序列：追加的 71B 帧被抹掉；B 段半写状态 `invalid frame magic` | 注入式测试：并发追加**不被吃掉**并报错；截断后崩溃只留**旧日志前缀**（6 events 可打开） | p4 C 段仍全绿；hardening +9 |
| **F5** | `index.js:139` `purgeCache` 绝不抛 + 只删普通文件；`:164` `purgeNote`；`:168` `otherCopies` 兜底 | `kind=THREW EISDIR`，而日志已被改写 | `kind=success`，目录被跳过，成功文案含缓存清理计数 | handler 8 节全绿；p7 D/F 翻转；hardening +3 |
| **F6** | `index.js:412` `touched` 判定 + `:483` `writeFailure` 文案 | 失败后残留 1 个含原文备份，错误只字不提 | 目标未改动 → **删除备份**并说明；目标已改动 → **保留并点名** | p7 E 翻转；hardening +5 |
| **F7** | `engine.mjs:657/703/828`；`index.js:304` `scanRowFlags` | 4511ms / 589.8MB / 1001 帧 2420ms / 30 万行 RangeError | 2033ms / 417.6MB / 490ms / 1979ms 成功 | 全部套件；hardening +4（含 2 万行 renumber） |
| **F9** | `index.js:854` 错误分支带上 `landed` | 只报「第 2 个节点替换失败」，已改的 1 个节点无人知晓 | `已有 1 个节点被永久遮蔽（seq 4）…建议重开会话` | p3 A 段全绿；hardening +4 |
| **F10** | `index.js:250/276` 形态不支持 → error | `已隐藏 1 个节点`（正文没变） | `…消息形态不受支持（content 里没有可替换的文本块），未做改动` | p3 C 翻转；hardening +2 |
| **元发现** | `test/real-reader.mjs`（新）、`bugfix-regression.mjs` 夹具重写、`handler.selftest.mjs` hide 夹具、`test/hardening.mjs`（新） | 夹具 `role:'tool'`：真实后端 `session event at seq 2 lacks an identified message` | 真实形状夹具 7/16 events 可打开；输出侧 6 条真实后端断言 | bugfix 48→54；handler 夹具修正、断言数不变 |

---

## 4. 断言变更清单（没有一条被削弱）

1. **`handler.selftest.mjs`：条数不变（159）；只改了 `hide` 夹具的消息形状**
   `{role:'tool', source:{callId}}` → `{role:'user', source:{kind:'tool',callId}}`，`user/message` 的 `data` 去掉多余的 `message` 包装。**该节没有任何断言需要改**（`nodes` 的体积断言在 `bugfix` 里，不在这一节）。
2. **`bugfix-regression.mjs`：48 → 54，新增 6 条全部是真实读取端断言**（夹具可打开 / tool-result 真实形状 / rollback 后可打开 / undo 后可打开 / 普通脱敏后可打开 / 脱敏前后事件数一致）。**没有删除任何原有断言。**
3. **`bugfix-regression.mjs`：两条既有断言的「表达方式」变了，语义更强**
   * `nodes [2] 是较早的（seq 2 → 行 4）`：原来硬编码 `134B`，那是 `role:'tool'` 假形状的字节数；改成用夹具里同一个消息对象算出的 `JSON.stringify(...).length`（现在是 181B）。断言仍然是「行号 + 工具名 + 真实体积」，而且是**由夹具推导的真值**，不是放宽。
   * `hide 保持 tool 消息结构` → `hide 保持 tool/result 的真实消息结构`：原来断言 `role === 'tool'`——这**恰恰是被测代码之外的一个假前提**（真实读取端会拒绝这种消息）。现在断言 `role === 'user' && source.kind === 'tool'`，并保留原有的 `turn/step` 与 `source.callId` 配对断言。这是**把断言改成真实不变式**，不是放宽。
4. **`handler.selftest.mjs` 那条原本就失败的断言没有被改**：我改的是 `index.js` 的文案（恢复 `/redact apply <计划.json> --session <id>`），断言原文一字未动。
5. **红队复现脚本一个字都没改**（它们是 before 证据）。它们在修复后仍有「FAIL」，但每一处 FAIL 都是**断言本身在描述缺陷**
   （例如 `(a) 游程 sourceEventSeqs 未被重映射（仍是 [[2,4]]）`）：翻转即证明缺陷不再复现。
   `p1` 3 条、`p2` 5 条（含 F8 那条，见 §6）、`p5` 1 条（红队自己写错的正则，见 §5.3），其余脚本全绿。

---

## 5. 剩余不确定性 / 我没有证明的东西

1. **live 改写「写在半途被打断」的窗口没有完全关闭。** 先 `ftruncate` 再写只能保证：(a) 「已截断、还没写」的窗口里死掉 → 文件是**旧日志的前缀**（可容忍的崩溃尾，已实测可打开）；(b) 写入期间的并发追加**不会被吃掉**（会被检测到并报错）。但**写入 syscall 本身被打断**（写到一半进程死）仍会留下 `新前缀 + 旧尾巴` 的混合体——`write(2)` 对大 buffer 不是原子的，任何「原地覆盖」方案都有这个窗口。要彻底关掉它需要独占写句柄/锁或改名安装，超出报告给的最小修复范围（见 §6）。
   * 附带：`hardening` F4(d) 断言了正常路径下文件长度精确等于输出长度；short-write 循环与长度复查是代码级保证，我没有伪造一次「内核短写」来实测。
2. **`verifyLog` 里 `session/title` 的真实不变式比「裸持久化读取端」更严。** `JsonlSessionPersistence.open()` 本身不看 title 的 `messageSeqs`；这条不变式由 `dsh-session-title` 插件在 `sessions.list()` / `session/created` 时执行。也就是说：**在不装 title 插件的组合里**，一条本来就违反不变式的 title 行会让 `applyPlan` 拒绝执行（而不是照常改写）。取舍：这条检查正是 F2 要求的「真实不变式」，拒绝时错误会点名行号与原因，用户仍可改用 `blankLines`/`substitutions`；而放过它意味着在装 title 的组合里整个会话恢复失败。**这是唯一一处「比裸读取端更严」的判定**，其余判定都严格对齐读取端源码。
3. **`p5-rollback.mjs` 剩余的那 1 条 FAIL 不是缺陷**：`assert('D. 只有顶层 type=turn/end 计入边界（共 2 轮）', /共 2 个完整轮次/.test(r.text))` 期望的是 `共 2 个完整轮次`，而 handler 一直打印 `共 2 轮`（红队报告 §2.2 也自述「除一条我自己写错的正则外全 PASS」）。我没有为了让它变绿去改文案或改脚本。
4. **清单外 `*Seq` 审计的误伤面**：真实会话里若存在某个插件自有的、以 `seq`/`seqs` 结尾的持久化字段，`renumber` 会**拒绝执行**（普通 `blankLines`/`substitutions` 不受影响）。我按 DSH 源码里的键名做了排查（`afterSeq/anchorSeq/messageSeq/...` 绝大多数是 UI/派生状态，不在事件 `data` 里），但无法穷举第三方插件的私有 payload。这是**故意**的失败关闭方向：拒绝执行 ≠ 数据丢失，写出悬空引用才是。
5. **`purgeCache` 的「失败」分支没有在 Windows 上被真正触发过一次**（同名目录那条已被 `isFile()` 过滤掉，不再算失败）。删除失败（文件被独占、权限）与目录列举失败的分支只有代码级保证，p7/hardening 覆盖的是「不再抛异常」这一可观测结论。
6. **p4-write 的 A/B 段修复后依然「PASS」**，因为它们手工复刻的是**旧顺序的 syscall**，不是在调用当前代码。它们仍然是「旧顺序有害」的演示，但**不能**作为「新顺序正确」的证据——后者由 `hardening.mjs` 的注入式 F4 断言承担。这一点我在表格里写明了，免得后人误读。

---

## 6. 我故意没做的事

1. **F8（`undo` 注释承诺「日志缺失也允许恢复」）不在任务范围内**，我没有实现它，也没有删注释。现状：日志缺失时仍会 `找不到会话 … 的日志`（p2 B 段那条 FAIL 保持原样）。要做的话应改成「日志缺失时跳过 `.before-undo-*`、直接把备份 rename 成日志」。
2. **没有改成流式重写**（F7 明确说不要）：`applyPlan`/`loadLog` 仍然把整份解压明文放在内存里。现在 25.8MB 文件 → 417MB 峰值（约 16 倍），比修复前的 23 倍好，但仍是「大日志会吃内存」。真正的解法（逐帧流式、把重活移出事件循环、日志大小上限）超出本次范围。
3. **没有给隔离备份名加 pid/随机后缀**：报告 §2.3 自己说「并发窗口客观存在但我没有复现出来」，属潜在风险而非已确认缺陷；我只在 **F4 的写入路径**加了并发检测，备份名生成保持原样。
4. **没有改 `findQuarantine` 的排序键**（报告 §2.4 记为「脆弱设计」，并明确说无法构造出错序场景）。
5. **没有改 CLI（`engine.mjs` 的 `cmdApply`/`cmdCut`）的失败路径**：它同样先 `copyFileSync` 再 `renameSync`，rename 失败会留下含原文的备份而只在成功路径打印名字。这是 F6 的同类问题，但报告的最小修复建议指向插件 handler 的 `commitRewrite`，而 CLI 是离线工具、`.new` 中间文件仍在、原文件未被改动，风险等级不同。**留作已知未修项。**
6. **没有让 `hide` 做「可提交性预检」**（F9 的半条建议）：`session.append` 的失败无法在不提交的前提下预测；我做的是**如实报告已落地的节点**，这满足任务对该条的要求（「report how many nodes already landed and that those are permanently shadowed」）。
7. **没有跑 `test/preflight.mjs`**：它会把 `list` 指向真实的 `DSH_HOME`（只读目录元数据，不读内容），但本任务要求严格远离 profile，所以我不运行它；它不受本次改动影响（无断言，只打印观察）。
8. **没有动 `~/.dsh` 下的任何东西**，也没有读任何真实日志/缓存/`*.jsonl.zstd`。

---

## 7. 如何复跑

```powershell
$node = '%USERPROFILE%\nodejs-x64\node-v22.21.0-win-x64\node.exe'
# 套件
& $node %USERPROFILE%\dsh-plugin-redact\test\handler.selftest.mjs    # 159/159
& $node %USERPROFILE%\dsh-plugin-redact\test\bugfix-regression.mjs   # 54/54
& $node %USERPROFILE%\dsh-plugin-redact\test\hardening.mjs           # 78/78（真实读取端）
& $node %USERPROFILE%\session-surgery\selftest.mjs                   # 34/34
# 红队复现脚本（务必**串行**跑：它们共用 %TEMP%\rt-redact\root）
foreach ($p in 'p1-refs','p2-undo','p3-hide','p4-write','p5-rollback','p6-scale','p7-purge','p8-structural') {
  & $node "%USERPROFILE%\dsh-redact-redteam\$p.mjs"
}
```

本次实测输出存档：before 在 `%USERPROFILE%\dsh-redact-fix\baseline\`，after 在 `%USERPROFILE%\dsh-redact-fix\after\`（每个脚本一个 `.txt`）。

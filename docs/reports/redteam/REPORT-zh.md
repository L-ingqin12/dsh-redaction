# 红队报告：dsh-plugin-redact（会话日志改写工具）

**结论：找到 5 个「数据丢失 / 不可逆损坏」级缺陷，其中 2 个会让会话**永久打不开**，而工具全程报告成功。**
所有测试均使用**合成日志**（真实 DSH 编解码器/真实 JsonlSessionPersistence 后端 + 假数据），
未读取任何真实会话内容、缓存或 `*.jsonl.zstd`（真实数据）。

被测版本：`lib/engine.mjs` 34076B、`index.js` 35905B（sha256:4fb20cb18bf7，与套件打印一致）。
复现脚本：`%USERPROFILE%\dsh-redact-redteam\*.mjs`（可重复执行；夹具落在 `%TEMP%\rt-redact\`）。

---

## 0. 基线：三套现有测试

| 套件 | 结果 |
|---|---|
| `dsh-plugin-redact\test\handler.selftest.mjs` | **159/159 通过**（exit 0） |
| `dsh-plugin-redact\test\bugfix-regression.mjs` | **48/48 通过**（exit 0） |
| `session-surgery\selftest.mjs` | **34/34 通过**（exit 0） |

**基线的重要保留意见（本身就是缺陷）**：`test\bugfix-regression.mjs` 的夹具**不是读取端合法日志**：
第 30/142 行把 tool/result 消息写成 `{ role:'tool', source:{ callId:'aa' } }`。
真实的 restore 校验是：

```
SessionPersistenceCorruptionError: stored session ... failed validation:
  Error: session event at seq 4 message must have role "user"
  Error: session event at seq 4 message has invalid source
```

（`role` 必须是 `'user'`，`source` 必须是 `{ kind:'tool', callId }` —— `dsh-llm/lib/types/message.d.ts:22-25`）
因此**绿色的套件只证明「引擎自检通过」，不能证明「DSH 打得开」**。下面 F1/F2/F3/F6 四类缺陷
全部能被现有套件放过。本报告用**真实 `JsonlSessionPersistence.open()`** 做判据。

---

## 1. 缺陷排名

### F1 —— 【数据丢失·不可逆】`sourceEventSeqs` 的「游程压缩」形式没有被重映射，导致整份日志被读取端硬拒绝

* **触发**：`/redact apply <plan.json>`，plan 内含 `"renumber": true` 与中间 `dropLines`（或 `cut --renumber`）。
  只要日志里存在**一条** `sourceEventSeqs` 在盘上是游程形式的行（`[[a,b]]`），就会中招。
* **机制**：
  * 盘上格式（不是内存格式）：`dsh-session-format-v1-to-v2/lib/index.js:276` 用
    `decodeSeqRanges(record.sourceEventSeqs, seq)` 读、`:300` 用 `encodeSeqRanges()` 写；
    `dsh-session/lib/types/seq-ranges.js:19-20` 把 **≥3 个连续 seq 压成 `[start,end]` 对**。
  * `engine.mjs:293-299` 只做 `row.sourceEventSeqs.map(map)`，而 `map`（`engine.mjs:276-282`）
    对非整数**原样返回**；`:278` 的悬空检查 `dropped.has(v+1)` 对区间元素也永远不触发。
  * 于是区间里的 seq 停留在旧编号上；解码端 `decodeSeqRanges` 的
    `end >= maxEntries`（maxEntries = 该行自己的新 seq，`:315`）直接抛
    `SessionFormatError: sourceEventSeqs range exceeds its event seq`。
  * `applyPlan` 的自检（`engine.mjs:485-491`）只看 JSON 可解析 + 头部 + seq 密集，**看不见这层语义**。
  * 自然生产者：`compaction/summary` 遮蔽一段连续 surface 节点时，`sourceEventSeqs` 天然是长游程 → 必被压缩。
* **复现**：
  ```
  & "%USERPROFILE%\nodejs-x64\node-v22.21.0-win-x64\node.exe" %USERPROFILE%\dsh-redact-redteam\p1-refs.mjs
  ```
  观察（实测输出）：
  ```
  (a) 落盘 sourceEventSeqs=[[2,4]] surfaceOp={"op":"replace","startSeq":2,"endSeq":4}
  (a) 夹具：改写前 DSH 真实后端可打开  — 8 events
  (a) 引擎接受 renumber 删除（无悬空引用告警）  — dropped=1
  (a) 引擎自检通过（seq 密集 + JSON 可解析）
      → 改写后该行: seq=4 sourceEventSeqs=[[2,4]]（surfaceOp 已正确变成 {1,3}）
  (a) DSH 真实后端仍能打开引擎的输出 — 失败：
      SessionPersistenceCorruptionError: ... invalid committed event at line 5:
      sourceEventSeqs range exceeds its event seq
  ```
* **后果**：会话**永久打不开**（resume 第一步 `persistence.open` 就失败），而工具打印「已就地脱敏」。
  唯一救援是手工用 `.quarantine-*` 覆盖回去。
* **最小修复建议（不实现）**：`remapRefs` 对 `sourceEventSeqs` 的每一项做**形态感知**重映射：
  整数走 `map`，`[start,end]` 展开成两个整数分别 `map` 后再按同一规则重新压缩（或直接退化为整数数组），
  非这两种形态一律 `die()`；并在 `applyPlan` 自检里补一条「按盘上语义回放 `decodeSeqRanges`」的检查
  （`end < 本行 seq`、严格递增、无重复），把读取端会拒绝的输出挡在写盘之前。

### F2 —— 【数据丢失】`session/title.data.messageSeqs` 不在引用清单里，重编号后悬空

* **触发**：同 F1（`renumber` 中间删除），日志里存在 `session/title` 行。
* **机制**：`engine.mjs:300-318` 只处理 `data.shadowedSeqs` / `data.shadowedRange`；
  `dsh-session-title/lib/types/types.d.ts:34-41` 的 `messageSeqs` 是**持久化的 seq 引用**，
  真实不变式 `dsh-session-title/lib/types/invariant.js:19-43` 在 `sessions.list()` / `session/created`
  时逐条校验：`message seq N must name an earlier human user/message`。
* **复现**：`p1-refs.mjs` 第 (b) 段：
  ```
  (b) 改写后 session/title: seq=3 messageSeqs=[2]     ← 没被重映射
  (b) 该引用现在指向的不是 user/message（悬空）  — 指向 assistant/message
  (b) 真实 title 不变式接受改写后的日志 — 失败：
      session/title event 3 message seq 2 must name an earlier human user/message
  ```
* **后果**：装了 title 插件的组合里该会话无法恢复；若指针恰好落在另一条 `user/message` 上，则**静默引用错消息**（无任何报错，标题来源被悄悄改成另一轮对话）。
* **最小修复建议**：把「需要重映射的字段」做成显式清单（`surfaceOp.{startSeq,endSeq}`、`sourceEventSeqs`、
  `data.shadowedSeqs`、`data.shadowedRange.{start,end}`、`data.messageSeqs`），
  并加一条**失败关闭**的审计：对每一行递归查找键名匹配 `/(^|_)(seq|seqs)$/i` 的数值/数值数组字段，
  只要它不在清单里就拒绝执行并报出路径（宁可拒绝，也不能写出悬空引用）。

### F3 —— 【数据丢失/损坏】`undo` 不校验隔离备份就覆盖健康日志

* **触发**：`/redact undo --commit`，而最新的 `.quarantine-*` 是**截断/损坏**的（备份只写了一半、断电、
  或 `copyFileSync` 中途失败都会留下这种文件——`index.js:313-314` 先复制后写入，复制失败时半截文件留在盘上）。
* **机制**：`index.js:528-561` 只 `statSync` 拿大小、按 mtime 排序取最新，然后
  `copyFileSync(found.file, aside)` → `copyFileSync(newest.path, found.file)`。
  **全程没有 `inspectBuffer` / `checkSeqDensity` / 帧校验**。
* **复现**：`p2-undo.mjs`
  ```
  A. 脱敏后日志结构完好（真实后端可打开）
      → 备份被截断: 641 → 320 字节
  A. undo 报告成功（没有校验备份）
  A. 当前日志被坏备份覆盖  — 649 → 320
      → 截断备份被当成崩溃尾读取：ok=true events=3  ← 静默丢事件（原本 7 条）
  A2. undo 报告成功
  A2. 覆盖后 DSH 无法打开该会话 — SessionPersistenceCorruptionError:
      corrupt Zstandard session log: frame at byte 289 failed validation
  ```
* **后果**：两种坏结局——(a) 备份被截断在帧边界附近 → 读取端当成「崩溃尾」**静默少读若干事件**（用户看不出少了什么）；
  (b) 备份中间损坏 → 会话**硬打不开**。健康日志只被塞进 `.before-undo-*`，用户界面既不提示「备份可能是坏的」，
  也不提示怎么恢复。
* **最小修复建议**：装回去之前先校验备份（`inspectBuffer`：`parseErrors===0 && headerOk && fatal===undefined`，
  且 `checkSeqDensity===null`）；不合格就拒绝并提示「备份不可用，你可从 `.before-undo-*` 或更早的备份恢复」。
  另建议 `undo` 不用 `copyFileSync` 覆盖，而用「写临时文件 + rename」，并对新文件 `fsync`。

### F4 —— 【数据丢失】live 原地覆盖：`write → ftruncate` 窗口会吃掉并发追加的事件；崩溃窗口留下硬损坏文件

* **触发**：`/redact apply --allow-live` / `rollback --allow-live`（或 CLI 的 `apply --apply`）作用在**正在运行的会话**上，
  且该会话的写句柄在窗口内追加了一批事件。
* **机制**：`index.js:311-330` `commitRewrite(live=true)` 的顺序是
  `open('r+')` → `writeSync` → **`ftruncateSync(out.length)`** → `fsyncSync`。
  并发保护只有 `index.js:742-750` 的 `revisionOf`（size:mtimeMs:ctimeMs）比对，
  它在 `commitRewrite` **之前**执行 —— 之后到 ftruncate 之间的追加完全没被看见，
  而 ftruncate 会把它们**从文件里抹掉**（同时让后端的内存偏移与实际文件错位）。
* **复现**：`p4-write.mjs`（在完全相同的 syscall 序列中间插入一次 `appendFileSync`）
  ```
  → 写后+追加 = 1337B，ftruncate(1254) 之后 = 1254B（追加的 71B 帧消失）
  PASS A. live 覆盖会在 write→truncate 窗口内吃掉并发追加的帧
  → 之后 DSH 打开：ok=true events=20        ← 静默丢事件，没有任何报错
  == B. 崩溃窗口（write 之后没 truncate）==
  → 半写状态：1271B，帧魔数非法 @ 字节 1254
  → DSH 打开半写文件：ok=false SessionPersistenceCorruptionError: invalid frame magic at byte 1254
  ```
* **附带代码级缺陷**：`index.js:318` **忽略 `fs.writeSync` 的返回值**（短写无法察觉）；
  idle 路径 `index.js:326-327` 的 `renameSync` 之后没有目录 fsync（掉电后目录项可能回滚到改写前，
  脱敏「失效」而不是丢数据——属于泄漏方向）。
* **最小修复建议**：live 路径不要用「先写后截断」。最小改动是**先 `ftruncateSync(fd, out.length)` 再 `writeSync`**：
  被打断只可能留下「尾部被截短」的日志（读取端本来就按崩溃尾容忍），而不是「新头 + 旧帧」的混合体；
  同时 (1) 打开 fd 后、写入前**再比对一次** `revisionOf`，(2) 校验 `writeSync` 返回的 `bytesWritten === out.length`，
  (3) 写完再 fsync 一次 fd 与目录。更稳的做法是在改写期间持有写句柄（或写一个 `.redact-lock`）让后端停下来。

### F5 —— 【数据丢失·误导】`purgeCache` 在**写盘成功之后**抛异常，命令报「失败/崩溃」，而日志已被改写

* **触发**：缓存目录里存在一个**名字恰好是 `<sessionId>.json` 的目录**（或任何让 `rmSync` 抛错的情况），
  然后执行 `/redact apply --commit`（`rollback` / `undo` 同理）。
* **机制**：`index.js:757`（apply）、`:511`（rollback）、`:562`（undo）在 `commitRewrite` 成功后**无保护地**调用
  `purgeCache`；`index.js:120` 的 `fs.rmSync(p, { force: true })` 对目录抛 `EISDIR`，
  异常一路逃出 handler（`purge` 路径同样没有 try/catch，`index.js:431`）。
* **复现**：`p7-purge.mjs` 的 D / F 段
  ```
  D. 返回 kind=THREW  SystemError: Path is a directory: rm returned EISDIR ...\target-session.json
  F. 返回 kind=THREW；日志是否已被改写=true；隔离备份=1 个
  ```
* **后果**：用户看到的是「命令炸了」，但**磁盘上的原始文本已经被脱敏、并且已经多出一份含原文的隔离备份**。
  用户完全不知道改写已经发生（也不知道备份在哪）。这正违反了本插件自己在 BUG-1/BUG-2 里立的规矩：
  「引擎级拒绝要返回 error，不能杀宿主」。
* **最小修复建议**：`purgeCache` 用 try/catch 包住（失败时把「缓存清理失败」并入成功结果的文本），
  并在删除前用 `statSync().isFile()` 过滤，不要对目录调用非递归 `rmSync`。

### F6 —— 【泄漏】写盘失败时留下含**原文**的 `.quarantine-*`，错误信息只字不提

* **触发**：`commitRewrite` 的 `copyFileSync(file, backup)` 成功之后写入失败。
* **机制**：`index.js:313-314` 无条件先备份；失败路径 `index.js:754-756` 只回 `写入失败：...`，
  成功路径里那句「备份仍含原文，确认无误后请自行删除」在失败路径上不会出现。
* **复现**：`p7-purge.mjs` E 段（把 `<log>.redact-tmp` 预建成目录，让 `writeFileSync` 抛 EISDIR）
  ```
  → 返回: 写入失败：EISDIR: illegal operation on a directory, open '...session.v3.jsonl.zstd.redact-tmp'
  → 残留隔离备份 1 个（含原文）
  ```
* **后果**：一次「失败」的操作把敏感原文多复制了一份到会话目录，且无人告知；反复重试会累积。
* **最小修复建议**：失败路径要么删掉刚建的备份，要么在错误文本里显式给出备份路径与「它仍含原文」的提醒。

### F7 —— 【健壮性/DoS】同步阻塞 + 内存放大；每帧全表扫描；`Math.min(...dropIdx)` 栈溢出

* **触发**：大日志（20MB 级）。插件的 handler 是**同步**的，整段跑在宿主事件循环上。
* **复现**：`p6-scale.mjs`
  ```
  == A. 25.8MB 日志（1041 帧 / 26000 行 / 解压后 53.9MB）==
  loadLog        401ms   RSS +69.1MB
  逐行 JSON.parse（readRows/planRollback 的做法） 219ms  RSS +37.6MB
  applyPlan（所有帧重写） 4511ms
  checkSeqDensity 340ms ；inspectBuffer 351ms   ← 输出被完整解码了第二、第三次
  峰值 RSS 589.8MB（文件 25.8MB）                ← 约 23 倍
  == B. 二次方项（行数固定，只改帧数）==
  帧数    11 → 532ms ；帧数 101 → 728ms ；帧数 1001 → 2420ms
  == C. ==
  30 万行 renumber 删除：519ms → RangeError: Maximum call stack size exceeded
  ```
* **机制**：
  * `engine.mjs:406`：**每个帧**都 `lines.map((l,i)=>({...l,idx:i})).filter(...)` —— 全表复制，O(帧数×行数)；
  * `engine.mjs:485-491`：`applyPlan` 先用 `inspectBuffer(out)` 再 `checkSeqDensity(out)`，
    把刚生成的输出**又完整解码两遍**（`scanFrames` 第三遍）；
  * `index.js:241-255` `readRows` 把**所有行都 JSON.parse 成对象**留在内存（rollback 路径），
    紧接着 `index.js:482` 又 `applyPlan` 一次；
  * `engine.mjs:407` `Math.min(...dropIdx)` 用展开运算符，drop 集合超过约 12.5 万项即
    `RangeError: Maximum call stack size exceeded`（被 handler 捕获成 error，属于功能不可用而非数据损坏）。
* **后果**：26000 行的日志就要 **590MB RSS + 4.5 秒独占事件循环**；真实长会话（帧数上万）会直接把宿主卡死或 OOM。
  对一个「运行在用户 agent 进程里」的插件这是可用性级缺陷。
* **最小修复建议**：一次遍历建好「帧→行」索引（`frameLines` 预计算），不要每帧重扫全表；
  把输出自检合并进重建过程（顺手算 seq/JSON 即可，不必再解码三遍）；
  `Math.min` 改成显式循环；`readRows` 改成流式/逐帧处理，并给日志大小设上限或把重活挪出事件循环。

### F8 —— 【健壮性】`undo` 注释承诺「日志缺失也允许恢复」，实现上永远做不到

* `index.js:537-541` 写着 `/* 日志缺失也允许恢复 */`，但 `:527` 的 `resolveLog` 先就返回
  `找不到会话 ... 的日志`；即使绕过，`:557` 的 `fs.copyFileSync(found.file, aside)` 也会 ENOENT。
* 复现：`p2-undo.mjs` B 段 → `B. 日志缺失时 undo 仍能恢复（实现承诺）— 找不到会话 rt-undo-missing 的日志`。
* 建议：要么把注释删掉（承认不支持），要么在日志缺失时跳过 aside 直接落地备份。

### F9 —— 【健壮性】`hide` 多目标失败留下**半变更的活会话**，且不告诉用户已经改了什么

* **触发**：`/redact hide <plan> --commit` 命中多个 tool/result，其中第 N 次 `session.append` 抛错
  （磁盘满、句柄失效、校验失败…）。
* **机制**：`index.js:200-237` 是**逐节点提交**的循环：每轮先 append `compaction/prune` 价签、再 append 替换节点；
  catch（`:233`）只返回 `第 N 个节点替换失败`，而 `landed`（已经改掉的节点）在 `:655-656` 被**丢弃**。
* **复现**：`p3-hide.mjs` A 段（真实 `dsh-session` 的 Session + 第 4 次 append 抛错）
  ```
  → 返回: kind=error text=第 2 个节点替换失败：模拟持久化失败（磁盘满 / 句柄失效）
  → 已提交事件: compaction/prune#7, tool/result#8, compaction/prune#9
  → 活会话里已有节点被改写（半途变更已生效）  — 已隐藏节点数=1
  ```
  即：第 1 个节点**已被永久遮蔽**、第 2 个节点留下**没有配对的价签**，用户只看到一句「第 2 个失败」。
* **最小修复建议**：先对全部目标做一次「可提交性」检查再逐条提交；catch 里把 `landed` 一并回给用户
  （「已隐藏 seq A，第 2 个失败，建议重开会话」），并考虑对已提交的替换做补偿（再发一个 surfaceOp 指回原节点）。

### F10 —— 【泄漏·低】消息形态异常时 `hide` 谎报「已隐藏 N 个节点」

* `index.js:206-219`：当 `data.message.content` 不是数组（或 `content[0]` 没有 `content` 键）时，
  `nextOuter` 原样保留，替换节点与原文**一模一样**，但 `:665` 仍然回「已隐藏 N 个节点 · 下一轮请求起模型不再看到」。
* 复现：`p3-hide.mjs` C 段 → `已隐藏 1 个节点`（实际正文未变）。
* 可达性限制：当前类型 `ToolResultMessage.content` 是 `[ToolResultBlock]` 必填单元组
  （`dsh-llm/lib/types/message.d.ts`），因此**只有非规范/历史/受损日志**才会命中；
  真实的 `Session.append` 也会拒绝这种消息。故降级为低危：属「不该无声成功」，不属于数据丢失。
* 建议：命中未知形态时直接返回 error（「该节点的消息形态不受支持」），不要报告成功。

---

## 2. 攻过但**没能**打穿的部分（含原因）

1. **`purgeCache` 的删除半径**：`..`、`../..`、`*`、`a/b`、`C:/...`、`<sid>.json` 等构造的 session id
   都无法删除缓存目录之外的文件。原因：比较对象是 `readdirSync` 的**目录项名**，目录项不可能含路径分隔符，
   且没有任何 glob 展开；`path.join(dir, f)` 用的就是该目录项名。前缀/兄弟 id（`<sid>-sibling.json`）也不受影响。
   （唯一问题是 F5 那个 EISDIR 异常。）→ `p7-purge.mjs` A/B/C 全 PASS。
2. **`rollback` 的边界逻辑**：末尾未闭合 turn、完全没有尾部 `turn/end`、payload 里出现 `turn/end` 字样、
   `turn/end` 顺序错乱、inherited `session/end-seed` 保护 —— 全部表现正确。原因：边界取
   `turnEnds[keepTurns-1]`，天然落在一条**顶层** `turn/end` 行上，保留前缀必然以 turn 边界结尾；
   读取端对「末尾未闭合 turn」本来就容忍（resume 时会补 closer）；`session/end-seed{inherited:true}`
   被 `index.js:274-276` 显式拒绝截断。→ `p5-rollback.mjs` 除一条我自己写错的正则外全 PASS。
3. **毫秒级隔离备份名碰撞**：同进程连续 40 次 `apply --commit` 产出 **40 个互不覆盖**的备份；
   8 轮「两个 CLI 进程同时 `apply --apply`」也没有出现备份覆盖，最终日志均结构完好。
   结论：**顺序调用下不可能碰撞**（每次 handler 调用的间隔 > 1ms）；并发窗口在代码里客观存在
   （`index.js:312` 的时间戳只有毫秒精度、`copyFileSync` 无独占语义），但我**没有复现出来**，
   因此不作为已证实的缺陷，只作为潜在风险记录（建议备份名追加 pid/随机后缀）。
4. **`copyFileSync` 保留 mtime**（实测 true）→ `findQuarantine`（`index.js:296`）按 mtime 排序，
   排序键其实是「被备份那一刻源日志的 mtime」，而不是操作时刻。我推演过所有由本工具自身产生的时序，
   同 mtime 的两份备份内容必然相同，**无法构造出「取错内容更新/更旧的备份」**；仅记录为脆弱设计
   （排序键应改用文件名里的 ISO 时间戳或 ctime）。
5. **`blankLines` / `substitutions` 命中结构字符串**：`blankLines` 会把 `user/message.source.kind`、
   `tool/call.name`、`tool/call.arguments` 等一起换成 `[已移除]`；`substitutions: find "user"` 会把
   `source.kind` 变成 `[X]`。**但真实读取端全部接受**（7 events 正常打开）——
   校验只管形状不管取值（`dsh-session` 的 `validateSessionEventData` 只针对 request/header 与
   tool/result 的 error 元数据）。所以这是「语义被改坏、日志仍可读」，不是数据丢失。
   → `p8-structural.mjs` 全 PASS。
6. **孤儿 `compaction/prune` 价签是否会打崩 token-meter**：不会。真实折叠函数
   `dsh-token-meter/lib/types/surface-projection.js:37-67` 在任何非 replace 事件上直接丢弃已 armed 的
   claim（`:49-61`），而每个 replace 的生产者都会先追加自己的价签把 claim 重新武装；
   用真实折叠函数重放被半途改写的会话，未抛错、也未产生漂移。→ `p3-hide.mjs` A 段实测「未抛错」。
7. **`hide` 的幂等性**：对已被替换的节点再次 `hide --lines` → `未命中任何 tool/result 节点`（不重复追加、
   不产生 surface 冲突），不会二次改写。
8. **`JSON.stringify` 抛错（BigInt / 循环引用）**：`index.js:190-193` 已 try/catch → 跳过该目标，
   异常不会逃出 handler；且真实 `Session.append` 会拒绝非 JSON 可序列化的数据，日志里不会有这种消息。
9. **CLI 的固定 `.new` 文件名并发**：8 轮双进程并发 `apply --apply` 未出现损坏或备份覆盖（临界区太短）。
   记录为潜在风险，不作为缺陷。
10. **删中间行不带 renumber**：正确拒绝（`engine.mjs:373-379`），后缀删除不带 renumber 正确放行；
    `checkSeqDensity`（`engine.mjs:497-519`）的 `seq === 行号-1` 判定经真实后端交叉验证无误；
    头部行保护（`engine.mjs:347`）、`PROTECTED_KEYS`（`:61-71`）均有效。
11. **`undo` 在日志缺失时**：会安全报错、不动任何文件（问题只是承诺的恢复能力不存在，见 F8）。

---

## 3. 给上游的最小行动清单（按性价比排序）

1. `engine.mjs` `remapRefs`：补 `[start,end]` 游程的重映射 + `data.messageSeqs`；并对未知 `*Seq*` 字段**失败关闭**。（F1/F2）
2. `applyPlan` 自检：增加「按读取端语义回放引用」的检查（`decodeSeqRanges` 的 3 条规则 + surface 引用存在性），
   任何读取端会拒绝的输出都必须 `die()`，不能写盘。（F1/F2 的总闸）
3. `undo`：装回前校验备份（inspect/seq 密度/头部），不合格直接拒绝。（F3）
4. `commitRewrite` live 路径：先 truncate 再 write；写前复查 revision；检查 `bytesWritten`。（F4）
5. `purgeCache` 全部调用点包 try/catch，且只对普通文件调用 `rmSync`。（F5）
6. 失败路径处理隔离备份（删除或在错误文本里点明）。（F6）
7. 性能：预计算 frame→行索引、去掉重复解码、去掉 `Math.min(...set)`。（F7）
8. 测试夹具改成**读取端合法**（`role:'user'` + `source:{kind:'tool',callId}`），
   并把「真实 `JsonlSessionPersistence.open()` 能打开输出」作为套件的断言之一 —— 否则 F1/F2 永远测不出来。

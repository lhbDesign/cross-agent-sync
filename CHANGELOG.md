# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **交接预算：摘要按目标 agent 的上下文自适应裁剪**（`ass brief --budget` / `session_handoff`）。
  `buildBrief` 里原本到处是拍脑袋的硬编码截断（原始目标 600 字、时间线每条 220 字最多 40 条、
  最后一轮 4000 字…），既不随会话规模变化，也不知道下一个 agent 还剩多少上下文。
  现在改成「每节声明优先级 + 多档渲染（完整/精简/仅要点）」，超预算就从**优先级最低**的节
  开始逐级降档，降到底仍超才整节省略。
  档位 `tiny`(2k) / `small`(4k) / `standard`(8k，缺省) / `large`(16k) / `full`(不限)。
  两个刻意的设计：**输出顺序与裁剪顺序解耦**（主动记录置顶输出但最后才动）；
  **被裁掉的部分显式声明**并给出看全文的命令，并注明「不代表它不重要」——
  免得下一个 agent 把「摘要里没有」当成「会话里没有」。
- **源数据守护：把「只读」从代码纪律变成运行时可强制 + 可自证**（`src/core/roguard.ts`）。
  - **写边界**：会话数据所在位置是受保护区，任何写路径命中即拒绝（`assertWritable`），
    逃生门 `ASS_ALLOW_SOURCE_WRITE=1`。四处 `--out` 统一走同一个判断点，不分散判断。
    保护边界由 adapter 自报的 `sources()` 推导 —— 「怎么读」和「哪里别写」天生该同源。
  - **读即登记**：除了静态清单，**读过文件的父目录也自动进入保护区**，
    覆盖 `sources()` 看不出来的读路径（典型是 Cursor 把图片附件放在与 `state.vscdb` 平级的
    `workspaceStorage/` 下）。边界不必人为维护，也不会漏。
  - **只读句柄**：读源文件一律显式 `O_RDONLY`，`openSource()` 不给 flags 参数 —— 想改写成可写都改不了。
  - **变更自证**：开句柄时留指纹（size/mtime/ino），`ass doctor` 报告「本次运行未改动任何源数据」。
- **`ass mcp`：MCP 配置本身也能自动创建了。** 和 `ass rules`（打印规则原文）对称：
  - `ass mcp` 打印配置内容 + 该放到哪个文件，给 Trae 这种只能手工贴的用；
  - `ass mcp --write` 直接在**当前工程**创建 `.cursor/mcp.json` / `.mcp.json`。
    解决的是 Cursor 这类**没有用户级全局 MCP 文件**、而 `ass install` 又按设计
    「不创建 agent 配置目录」所以一直覆盖不到的情况。
  - 合并而非覆盖：文件里已有的别的 MCP server 不会被冲掉；`--undo` 只摘我们那一项，
    整个文件都只有我们时才删掉它。有 `--dry-run`，有测试。
- **「任务」——把跨 agent 的多段会话绑成一件事**（P1，立项初衷）：
  `ass task add <任务名>` 把会话绑进来，`ass resume <任务>` 看总览
  （原始目标 / 决策 / 各段进展 / 待办）。MCP 侧是 `session_task` / `session_task_resume`，
  `session_status` 会列出本仓库进行中的任务。
  `ass resume <任务> --save` 把同一份总览写成本仓库的交接记录，没接 MCP 的 agent 也能看到。
  - 任务存 `~/.local/share/agent-session-sync/tasks/index.json`（**全局单文件**，可跨仓库）。
    不按仓库分目录，是因为 per-repo 只能靠 `basename` 定位，而 `~/work/api` 与 `~/personal/api`
    会撞成同一个 slug —— 任务作为长期实体不该继承这个隐患。
  - 段在绑定时留**快照**，源会话被删掉之后这一段仍然能显示（标记「会话已不可读」）。
  - 删除任务时 id 记入 `retired`，**永不复用**，否则历史输出里的 `t3` 会指到新任务上。
  - 破坏性操作（`rm` / `done`）只认完整名字或 `tN`，不做模糊匹配。
- **决策 / 踩坑 / 约束 / 待办 通道**（`session_remember` / `ass context`）：
  agent 在干活过程中随手记下的判断，会**置顶**出现在之后每个 agent 的交接摘要里。
  这是换 agent 时最值钱、最省 token 的信息，也是唯一可信的来源。
- 规则块重写：加入「干活过程中随手记，别攒到最后」「收尾把状态落下来」的完整纪律，
  并明确「默认只给摘要、全文要显式要」。
- `ass rules` 命令（之前帮助里写了但没实现）。

### 修复

- **`sqlite3` 命令行漏了 `-readonly`**：它默认以**可写**方式打开数据库，遇到需要恢复的库
  会在旁边生成 `-journal`/`-wal` 甚至回写 —— 直接违背「只读聚合」的前提。
- **「变更自证」会恒亮**：agent 会话文件在用户干活时本来就持续被追加，不做区分的话这个信号
  立刻就是红的、也就等于没有 —— 而它本来是用来**证明没动过**的。现在把「读完之后仍在被写
  （mtime 在 5 分钟窗口内）」单列为「活跃会话，无法判定」，不计入 `changed`。
- **`ass install` 现在会给装了但还没有配置文件的 agent 建 `mcpServers`**。
  以前 `jsonMcpFile` 只要文件不存在就直接跳过（"不创建 agent 配置目录"），
  后果是 **Cursor 这类默认没有配置文件的 agent 永远接不上 MCP —— 哪怕你已经装了 Cursor**。
  判据仍然是 `isInstalled()`：本机什么都没装时依旧一个文件都不建（那条测试还在守）。
- **IDE 前缀会让整条用户提问消失**：VS Code 扩展把「选中的行 / 打开的文件」和用户那句话拼在
  **同一个文本块**里、排在前面，而 `cleanUserText` 只剥 `system-reminder` 那几类容器，
  没剥 `<ide_selection>` / `<ide_opened_file>`。于是整块以 `<` 开头，被 `isInjected()` 判成注入丢弃
  —— **连同用户真正写的那句话**。实测一个真实会话被少算了 6 轮（5 → 11）。
  影响的不只是轮次显示：`ass last` 会搬来一条**过期**的提问，交接摘要的「原始目标 / 需求时间线」
  会缺条目，任务派生的 goal 也可能取错。已把这两个标签加进 `cleanUserText`。
- **MCP 响应可能被截断**：`mcp.ts` 在 stdin 关闭时调用 `process.exit(0)`，而 stdout 接管道时是
  异步写，`process.exit` 不等它 flush —— `tools/list` 这类大响应会断在半截 JSON 上，客户端解析失败。
  改为只设 `exitCode`，让 Node 排空后自然退出。加了两个工具之后响应变大才暴露出来。

### 变更

- **`ass` 首屏重排**：只回答四个问题——有几个会话 / 有哪些任务 / 怎么合并 / 怎么恢复。
  - 以前会把整个交接摘要顶 18 行，把真正要看的东西全埋了；现在只留一行状态，全文用 `ass notes`。
  - 每个会话行末尾给**稳定引用**（`claude:4134ec80`），底部「怎么继续」用最近一条示范两条路：
    同一个 agent `claude --resume <id>`、换个 agent `ass brief <引用>`。
    以前只教前者——那恰恰**不是**这个工具存在的理由。
  - 任务区块加了一句概念说明（任务 = 把多段会话绑成一件事）。
  - 会话行下面补回**最新一条对话**（截断显示），标题只有一句时自动省略不重复。
  - 会话行末尾给的是**完整 id**（`claude:31c5af10-8dc3-...`），不是 8 位前缀。
    实测 `claude --resume 31c5af10` 不好使——`--resume` 只认完整 id；
    而 `ass brief` / `session_handoff` 是前缀匹配，完整 id 一样能用。
    所以**一个形式就够两用**，不必让用户在两种写法之间换算。
  - 新增 `dispWidth` / `truncWidth`（`util.ts`）：按**终端显示宽度**截断，中文算 2 列。
    以前按字符数截，60 个中文标题实际占 120 列，永远超宽。
    列表还会读 `process.stdout.columns` 按终端实际宽度调整，拿不到时按 120 列保守处理。
  - 「决策 1 · 坑 1 · 待办 1」以前光秃秃挂在状态行上，没人知道是什么；
    现在独立成块并写明「agent 干活时随手记的判断，换 agent 时会置顶出现在交接摘要里」。
- **规则块的「没有 MCP 工具时」兜底清单漏了 `ass brief <引用>`** —— 那恰恰是跨 agent
  搬上下文最核心的命令（实测 Cursor 里的 agent 只能自己猜出它）。已补上并说明用法；
  同时把清单里的 `#3` 换成稳定引用 `agent:id前缀`（`#N` 每次列会话都会被重写）。
- **任务的「原始目标」改为优先取会话标题**，不再取「用户第一句话」。
  人贴报错/终端输出是极常见的开场，第一句经常是一大段噪声（实测取到的是
  `lihaibo@lihaibo session-mcp % npm publish > cross-agent-sync@0.1.0 prepublishOnly > …`），
  当成目标毫无意义。标题是 agent 自己生成的摘要，短且达意。
  附带好处：标题就在 `SessionMeta` 里，`taskView` 因此**完全不读 transcript**。
  标题会随对话推进被重新生成，所以缓存值每次都对比刷新；`--goal` 显式写的永不覆盖。
- README 新增「会话 vs 任务」一节，讲清两者关系和跨 agent 的两条路径。
- `extractDecisions`（从对话里猜决策/踩坑）**默认关闭**，降级为 `ass brief --guess`。
  实测两版启发式精度都不够：放宽则把整段叙述抓进来，收紧则什么都抓不到，
  而一个猜错的「决策」比没有更危险。摘要默认只放可信内容。

### 说明

- npm 包名定为 **`cross-agent-sync`**（`agent-session-sync` 在 npm 上已被他人占用）。
  工具在**运行时**的名字仍是 `agent-session-sync`：配置目录 `~/.config/agent-session-sync/`、
  MCP server 名、规则块标记都没变，所以改名不影响任何已有安装。

## [0.1.0] — 2026-09-18

第一版。目标：换 agent、开新会话时，不用再手工复述「之前做了什么、接下来做什么」。

### 新增

- **跨 agent 会话索引**：Claude Code、Codex、Cursor、OpenCode 四个内置适配器，按仓库归一化对齐
  （统一 `git rev-parse --show-toplevel`，从子目录启动的会话也能对上同一个仓库）。
- **CLI `ass`**：
  - `ass` / `list` / `show` / `search` / `repos` / `agents` / `doctor`
  - `ass last`：把另一个 agent 里的最后一问**原样**搬过来，连图片一起
  - `ass brief`：生成交接摘要（目标 / 需求时间线 / 涉及文件 / 关键结论 / 待办 / 最后一轮）
  - `ass note` / `notes`：收尾存档，下次任何 agent 一进仓库就能看到
  - `ass install` / `uninstall` / `rules` / `init`：接入与维护
  - `ass detect`：自检索本机所有可能的 agent，给出可接入的配置草案
- **MCP server**：`session_status` / `session_list` / `session_handoff` / `session_read` /
  `session_last` / `session_search` / `session_note` / `session_repos` / `session_detect`，
  以及 prompt `sync_previous_session`。
- **图片搬运**：Claude/Codex 的内联 base64、OpenCode 的 data URL、Cursor 的附件文件
  （`workspaceStorage/<id>/images/`）都能解出来落盘，新 agent 直接读文件即可。
- **自定义 agent**：`customAgents` 配置支持 `jsonl` / `json` / `sqlite` 三种形态 + 字段映射 + `roleMap`。
- **一键接入**：把 MCP 和规则块写进 Claude Code / Codex / OpenCode / Cursor / Kiro / Windsurf，
  规则块用 marker 包起来，`ass uninstall` 能精确摘除，写前自动备份。

### 设计取舍

- **零运行时依赖**：只用 Node 内置模块。SQLite 走 `node:sqlite`（Node ≥ 22.5）
  或系统 `sqlite3` 命令行，两条路任选其一。
- **只读**：不修改任何 agent 的会话数据。
- **默认不碰你的仓库**：项目级规则注入必须显式 `ass init`，且支持 `--dry-run` / `--undo`。
- **不假装支持**：读不到的 agent 会明确说明原因和下一步，而不是静默失败。

### 已知限制

- Cursor 的轮次数是近似值（消息类型存在 JSON 里，只能 LIKE 匹配）。
- Gemini CLI 的会话记录里没有仓库路径，只能通过 `ass list --all` 看到，无法按仓库过滤。
- Trae / Windsurf / VS Code Copilot Chat 的存储结构还没摸清，`ass detect` 能找到库文件但不解析。

[Unreleased]: https://github.com/lhbDesign/cross-agent-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lhbDesign/cross-agent-sync/releases/tag/v0.1.0

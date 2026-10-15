# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.0] — 2026-10-15

### 修复

- **稳定编号引用**：`#N` 在解析过程中保留用户上一次看到的列表快照，不再因内部全量扫描覆盖缓存而指向另一仓库的会话；长期保存仍应使用稳定的 `agent:id`。
- **Codex 重复轮次**：只合并同一消息在相邻 `response_item` / `event_msg` 中的双份编码，保留用户在不同轮次重复发送的“继续”等真实输入；轮次、消息数、预览和输入列表保持一致。
- **Cursor 消息顺序与分支**：按 `composerData.fullConversationHeadersOnly` 的原始 `bubbleId` 顺序读取当前主线，排除 KV 中残留的废弃分支；缺少索引时稳定回退。轮次、消息数、`tail`、最后一问、摘要和自动交接共享同一主线定义。

### 改进

- **跨会话搜索**：`ass search` / `session_search` 同时搜索原生会话标题、最近消息预览和对话正文，并在结果中标明命中来源。
- **支持范围说明**：明确内置历史解析器为 Claude Code、Codex、Cursor、OpenCode；Continue、Gemini CLI 通过现成自定义配置接入；Kiro、Trae、Windsurf 等需检测后自行映射。原生自动交接安装器仅覆盖 Claude Code 和 Cursor。
- 新增 [1.0.0 发布修复计划](docs/1.0.0-release-plan.md)，记录实施顺序、验收标准、只读边界和发布边界。

### 升级

- 升级后重新运行 `ass install` 更新规则并重启 MCP 客户端。若已启用自动交接钩子，再运行 `ass hook install` 更新命令路径。
- 原始会话保持只读；已有交接快照和任务目标不追溯改写。

## [0.4.1] — 2026-10-14

### 修复

- **会话标题与原工具对齐**：Codex 优先读取只读状态库 `threads.title`，回退到 `session_index.jsonl` 的 `thread_name`，最后使用首条用户消息；支持归档会话与 `session_meta.id`。
- **Claude Code 标题更新**：读取最新有效的 AI 标题及自定义标题，自定义标题优先；无日志标题时读取项目 `sessions-index.json`，最后回退到首条用户消息。
- **Cursor / OpenCode**：保持原生标题优先，Cursor 补充 `composerData.name` 回退；空白或格式错误的标题不再遮挡后续回退。验证仅修改标题时即可刷新，消息预览保持独立。
- **自定义 agent**：JSON/JSONL 和 SQLite 映射读取最后一个有效标题；记录顺序由文件或自定义 SQL 的排序决定。
- **缓存与容错**：旧版日志解析缓存自动失效；Codex/Claude 外部标题元数据每次列表重新读取，无需修改会话日志或清理缓存；不可读的标题元数据不会导致会话丢失。原始会话与数据库始终只读。

### 升级

- 更新到 0.4.1 后重启 MCP 客户端。CLI 在下次运行时使用新标题；已有交接快照和保存的任务目标不会被追溯改写。
- Codex 可用 `ASS_CODEX_INDEX` / `ASS_CODEX_DB` 指定标题索引与状态库；指定 `ASS_CODEX_DIR` 时默认在其父目录查找标题元数据，不混用另一安装的标题。

## [0.4.0] — 2026-10-13

### 新增

- **逐条查看用户输入**：`ass inputs <引用>` / MCP `session_inputs` 按顺序展示所有可读取的用户输入全文，不含 AI 回复、不做摘要截断；支持 `--round N` 选条、`--raw` 纯正文复制、`--out` 导出和 `--json`。图片数量与文件附件独立标明，缺失历史不推测补写。
- **自动交接**：`ass hook install` 为 Claude Code（Stop / SessionEnd）和 Cursor（stop / sessionEnd）安装用户级钩子；支持按 agent 选择、dry-run、备份、幂等合并与精准卸载。自动安装支持 macOS/Linux，不会随 `ass install` 隐式启用。
- **精确保存与去重**：只处理事件中的完整会话 ID，核对来源仓库；按会话内容和项目笔记指纹去重，变化后保存新快照。使用现有本地摘要逻辑，不调用模型、不修改原始会话、不自动授权或完成待办。
- **诊断与恢复**：`ass hook status [--json]` 展示配置和最近 50 次结果；`ass hook retry --session agent:完整ID` 重试。输入大小与等待时间受限，错误输出到 stderr 并记录诊断；不返回要求 agent 再执行一轮的指令。
- **通用入口**：`ass hook run --agent <agent>` 接收 stdin JSON，供其他工具的生命周期回调手工接入，要求已有可用的会话解析器。
- **CI**：新增 GitHub Actions，Linux/macOS × Node 18/22/24 执行类型检查、回归测试和打包验证，不自动发布。

### 修复

- 用户输入时间改为本地 `YYYY-MM-DD HH:mm:ss`，CLI/MCP/文本导出保持一致；会话描述改用统一的本地时间格式，交接摘要复用相同格式化逻辑，并对无效时间显示占位符。JSON 与内部存储保留机器可读时间。

### 使用说明

- 升级到 0.4.0 后重启 MCP 客户端以加载 `session_inputs` 等新增能力；已安装自动交接钩子的用户应重新运行 `ass hook install` 更新命令路径。
- 开发与升级不会自动给用户的 agent 开启钩子。显式执行 `ass hook install --dry-run` 查看配置，再安装并按主机要求重新加载。
- 强制退出或主机超时可能阻止退出事件执行；轮次结束快照用于提前保存。历史尚未落盘或适配器不可读时明确报错，可在落盘后重试；不将通用入口宣称为所有 agent 的原生自动支持。
- 原生主机的真实触发行为需在用户环境验证；本版本提供协议输入、生成命令、配置合并与保存流程的自动化测试。

## [0.3.1] — 2026-10-12

### 修复

- **同名项目隔离**：笔记与交接记录按规范化完整仓库路径生成独立存储键，避免两个 `app` 项目互读笔记；Git 子目录和符号链接统一身份。任务聚合笔记也不再仅按目录名去重。
- **组合操作回滚**：`ass context` / `session_remember` 将新增与状态更新合并校验、一次提交。核对缺少依据、目标编号不存在等错误不会留下部分新增记录。
- **纯 JSON 输出**：`ass context` 写入配合 `--json` 时不再混入“已记录”等提示；不存在的删除目标返回错误。
- **并发写入保护**：笔记、任务修改及交接索引更新增加跨进程锁，JSON 与交接文本通过临时文件原子替换；收尾文件附唯一编号，避免同秒覆盖。
- **损坏数据保护**：持久化笔记、任务和交接索引无法解析时明确报错，拒绝静默清空覆盖。

### 文档与升级

- 清理“MCP 仍在规划中”“等待 Cursor 自动配置”等过时说明，将已完成的 npm 发布与未完成的 CI 分开列示。
- 旧笔记仅在记录的完整仓库路径匹配时读取，首次修改写入新目录并保留旧文件；旧交接索引按完整路径兼容读取。已混写的历史记录不能自动可靠拆分。
- 请重启所有 MCP 客户端，避免新旧版本混合写入。若进程崩溃留下锁，工具会报告锁路径；确认相关写入进程已退出后再清理，不自动抢占现有锁。
- 自动收尾钩子、CI 和新增 agent 历史解析器不属于本次修复范围。

## [0.3.0] — 2026-10-10

### 新增

- **建议与授权分开记录**：新增 `--suggestion` / MCP `suggestion`；用户明确授权后，用 `--confirm <编号> --evidence "授权依据"` 转为已确认待办。旧待办显示“授权未记录”，不会自动当作用户已同意修改。
- **带依据的进展核对**：`--review <编号> --result completed|partial|pending|unknown --evidence "依据"` 支持已完成、部分完成、仍需处理、无法确认，保留核对时间、来源会话和历史结果。核对完成会标记完成，核对本身不代表授权；工具保存 AI 或用户的判断，不会自行扫描代码证明完成。
- **笔记关联与状态管理**：`--related-to` 关联进展或子待办，`--supersedes` 用新决策替代旧决策；`--cancel` / `--reopen` 取消或重新打开事项。关联不会自动完成待办，替代保留历史。
- **笔记详情与来源**：`ass context --details` 查看完整笔记，`--all --details` 包含已完成、已取消、被替代记录及核对历史；`--session` 保存已知来源会话。MCP `session_remember` 同步提供对应参数（关联参数为 `related_to`）。

### 改进

- 首页明确区分“工作任务”“项目笔记”和会话；“2 段”改为“关联 2 个会话”，无任务时展示解释和创建入口，超过列表上限时明确显示“最近 N 个会话”。
- 用户设置的“任务目标”与从标题派生的“起始会话主题”分别展示，并标注来源；接续提示明确为使用方法。
- 项目笔记显示记录时间、保存方式、来源、授权及状态；长笔记默认截短，缺失信息标注“未记录”，不推断记录者。
- 区分原始提问、交接摘要、项目笔记与完整对话，移除“可信度高于自动摘要”的笼统表述；明确完整对话是已解析消息，并非原始日志的无损副本。
- 更新 CLI 帮助、MCP 描述和安装规则：一条笔记只表达一个事项，接手时以当前代码和测试核对旧待办，历史聊天仅作线索。

### 修复

- 笔记操作示例使用实际存在的条目编号，不再固定提示 `c4`。
- 默认交接隐藏已完成、已取消和被替代的笔记；任务总览排除已取消待办及被替代决策。
- 阻止删除有引用关系的笔记，保存编号高水位，避免删除后复用编号导致历史引用错指。
- 同步锁文件中的包名、版本及 CLI 入口，与 `package.json` 保持一致。

### 升级说明

- 现有笔记无需手动迁移；旧记录不会被自动补写授权、来源或完成依据。新增字段保存在本工具的数据目录中，不修改其他 agent 的原始会话文件。
- `ass context` 默认展示截短预览，脚本需要结构化内容时使用 `--json`，人工查看全文使用 `--details`。
- 更新 npm 包后，重新运行 `ass install` 更新全局规则；使用项目级规则的仓库运行 `ass init` 更新，并重新加载 MCP 客户端。可先加 `--dry-run` 查看规则变更。
- `--done` 仍可手动标记完成，但不等同于附有代码或测试依据的核对。新版状态字段应由新版工具管理。

## [0.2.2] — 2026-09-22

### 修复

- **`ass --limit` 写了但没给值时，静默变成「只要 1 条」**。`ass --limit --all` 这种写法里，
  `--limit` 后面跟的是另一个开关（以 `-` 开头），parseArgs 不把它当值消费，
  `flags.limit` 成了布尔 `true`，而 **`Number(true) === 1`** —— 于是用户看到「1 个会话」，
  完全摸不着头脑。现在显式区分「没写」「写了没给值」「值不合法」，后两种直接报错并非零退出，
  而不是猜一个数字出来。`ass list` 同样。
- **`ass --all` 被静默忽略**：底部提示写着「跨仓库：加 --all」，但 `cmdStatus` 压根不看这个开关
  —— 提示在教用户用一个不存在的功能（`ass list --all` 才是好的）。现在 `ass --all` 真的跨仓库，
  表头改成「全部仓库」，每行标出 `[项目名]`，此时不再显示「本仓库的交接记录」（跨仓库时它没有意义）。
- **OpenCode 会话在列表里永远没有「最近一句」**：适配器把 `preview` 硬编码成了空串
  （`preview: ''`），从来没去取最后一条用户消息。实测本机 62 个 OpenCode 会话**全部为空**，
  而其他四个适配器都是 100%。那个字段是列表第二行的来源，所以 OpenCode 行看着总是短一截。
  现在从 `part` 表取最后一条用户消息的正文，并复用 `read()` 同一套
  `cleanUserText` + `isInjected` 过滤 —— 两边各写一套提取逻辑必然会漂。
  最后一条如果是纯系统注入（比如只剩一个 `<system-reminder>`），会**往回找**最后一条真的
  说了话的，而不是把注入当预览、也不是直接留空；claude / codex 适配器本来就是这行为。

## [0.2.1] — 2026-09-22

### 修复

- **`ass --version` 报的是上一个版本号**。`cli.ts` 和 `mcp.ts` 各硬编码了一份 `'0.1.0'`，
  发 0.2.0 时只改了 `package.json`，于是命令行的 `--version` 和 MCP 的
  `serverInfo.version` 都还报 0.1.0 —— 用户报 bug 时会报错版本。
  改为运行时从 `package.json` 读（打包后是 `../` 的关系，读得到），
  读不到退回 `0.0.0`。两处手写常量彻底消失，以后不会再漂。

## [0.2.0] — 2026-09-22

### 新增

- **会话列表到上限时会明说**：`ass` / `ass list` 默认只列最近 15 个，以前超了也是**静默截断**
  —— 你会以为「就这么多」。现在底部补一行：

  ```
  显示上限     只显示了最近 15 个会话（还有更多）   看更多：ass --limit 60   跨仓库：加 --all
  ```

  实现上要多取一条来探测：`listSessions` 返回的数组本身已经被截断过，
  只看它无从判断到底是刚好 15 个还是被砍过。没到上限时这行不出现（否则每次都在喊狼来了）。

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

- **Cursor 会话在项目里凭空消失**：`workspaceId → 路径` 原先只查
  `workspaceStorage/<id>/workspace.json`，而实测本机 63 条非空 Cursor 会话里
  **有 5 条那个文件根本不存在**（目录被清理、或会话来自旧版本）。
  这些会话 `cwd`/`repo` 全为 null，而按仓库过滤是 `sameRepo(repo) || sameRepo(cwd)`
  —— 两个都 null 就**永远匹配不上任何仓库**，于是在它所属的项目里彻底看不见，
  哪怕你就是在那儿聊的。现在回退到 `state.vscdb` 里 `workspaceMetadata.entries`
  的 `displayPath`（`~` 会展开）。实测 5 条里有 4 条恢复归属。
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

- Cursor 有当前主线头部索引时按索引精确统计；旧结构缺少索引时回退到 JSON `LIKE` 近似计数。
- Gemini CLI 的会话记录里没有仓库路径，只能通过 `ass list --all` 看到，无法按仓库过滤。
- Trae / Windsurf / VS Code Copilot Chat 的存储结构还没摸清，`ass detect` 能找到库文件但不解析。

[Unreleased]: https://github.com/lhbDesign/cross-agent-sync/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/lhbDesign/cross-agent-sync/compare/v0.4.1...v1.0.0
[0.4.1]: https://github.com/lhbDesign/cross-agent-sync/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/lhbDesign/cross-agent-sync/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/lhbDesign/cross-agent-sync/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/lhbDesign/cross-agent-sync/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/lhbDesign/cross-agent-sync/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/lhbDesign/cross-agent-sync/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lhbDesign/cross-agent-sync/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lhbDesign/cross-agent-sync/releases/tag/v0.1.0

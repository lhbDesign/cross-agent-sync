# agent-session-sync

> 换 agent、开新会话时，不用再手工复述「之前做了什么、接下来要做什么」。
> 一条命令把另一次对话的**交接摘要**、**原始提问**甚至**图片**搬到当前 agent。

同一台机器上你可能同时用着 Claude Code、Codex、Cursor、OpenCode……
同一个项目、同一个问题，需求 1-3 用 claude 聊、需求 4-5 换 codex。
问题是：**历史留在了上一个 agent 里**，换过去等于失忆，图片还得重新贴一遍。

`agent-session-sync` 就是解决这个的：只读地聚合各 agent 存在本机的会话，
按**仓库**对齐，然后让你「挑一个会话 → 把上下文搬过来」。

---

## 它做什么

| 能力 | 命令 / MCP 工具 |
| --- | --- |
| 列出**所有 agent** 在**当前仓库**的会话 | `ass` · `ass list` · `session_list` |
| 跨仓库浏览、按 agent 过滤、看会话规模 | `ass list --all` / `--agent codex` |
| 看某个会话的完整对话 | `ass show #1 --full` · `session_read` |
| **把上一次的提问原样搬过来**（含图片落盘） | `ass last #1` · `session_last` |
| 连问多轮一起搬 | `ass last #1 --rounds 3` |
| **生成交接摘要**（目标 / 时间线 / 文件 / 结论 / 待办） | `ass brief #1` · `session_handoff` |
| **收尾存档**，下次任何 agent 一进来就能看到 | `ass note` · `session_note` · `session_status` |
| **记录决策 / 踩坑 / 约束 / 待办**，置顶给下一个 agent | `ass context` · `session_remember` |
| **把多段会话绑成一件事**（任务），换 agent 一句话接上 | `ass task` · `ass resume` · `session_task` |
| 看任务全貌：原始目标 / 决策 / 各段进展 / 待办 | `ass resume <任务>` · `session_task_resume` |
| 跨 agent 全文搜索 | `ass search "点击穿透"` · `session_search` |
| 一键把 MCP + 规则接进本机各 agent | `ass install` |
| **自检索**：扫盘找出本机所有可能的 agent | `ass detect` · `session_detect` |
| 哪些 agent 被探测到了、数据在哪 | `ass agents` |
| 自检 | `ass doctor` |

设计原则：

- **只读 —— 而且是运行时强制的，不是一句承诺**。会话数据所在位置是**受保护区**：
  任何写路径命中即拒绝（逃生门 `ASS_ALLOW_SOURCE_WRITE=1`），读源文件一律走显式 `O_RDONLY`
  句柄，读完留指纹。`ass doctor` 会自证「本次运行未改动任何源数据」。
  连 `sqlite3` 都是带 `-readonly` 调的 —— 它默认以**可写**方式打开，遇到需要恢复的库
  会在旁边生成 `-journal`/`-wal`，那就直接违背了「只读聚合」的前提。
- **不动你的项目**。默认只写用户级配置（`~/.config`、`~/.local/share`），
  要往仓库里注入规则必须显式执行 `ass init`（带 `--dry-run` 和备份）。
- **零运行时依赖**。发布出来的包只依赖 Node 内置模块。

---

## 两个概念：会话 vs 任务

```
任务 cross-agent-sync开发              ← 一件事
  ├── 段1  claude:4134ec80   14 轮      ← 一次对话
  └── 段2  codex:01a0b24d     7 轮      ← 一次对话
```

| | **会话** | **任务** |
| --- | --- | --- |
| 是什么 | **一次**对话 | **一件事** |
| 边界 | 属于某个 agent，**换 agent 就断** | 跨 agent、跨天 |
| 怎么接着做 | `claude --resume <id>`（**只能同一个 agent**） | 在新 agent 里说「继续 `<任务名>`」 |
| 数量 | 很多 | 少，一件事一个 |

**关键一点：会话是 agent 私有的。** claude 的会话躺在 claude 的 `.jsonl` 里，codex 既读不懂也接不上。
所以「在 codex 里**续接**一条 claude 会话」是不可能的——`claude --resume` 能用，只因为那条**本来就是 claude 的**。

能做的是**带着它的上下文开一条新对话**：

```bash
ass last  claude:4134ec80     # 只要它最后那一问（含图片原样搬过去）
ass brief claude:4134ec80     # 要完整交接摘要
```

或者把它绑进任务，之后换任何 agent 一句话接上：

```bash
ass task add cross-agent-sync开发 claude:4134ec80
# 然后在 codex / cursor 里说「继续 cross-agent-sync开发」——
# 它会自己取到：这事的目标是什么、前面做到哪了、有哪些决策和坑
```

**两条路适用场景不同**：

| 目标 agent | 怎么搬 | 为什么 |
| --- | --- | --- |
| 接了 MCP 的（Claude Code / Codex / OpenCode） | 说一句「看下 `claude:4134ec80` 的交接摘要」，它自己调 `session_handoff` | 零复制，上下文直接进对话 |
| 没接 MCP 的（Cursor / Trae …） | 跑 `ass brief claude:4134ec80`，把输出粘过去 | 这些 agent 读不到 MCP 工具 |

> 想让 Cursor 也走第一条路：Cursor Settings → MCP 里手工加上（`ass rules` 有现成配置），
> 或等 `ass install` 支持自动写入 `~/.cursor/mcp.json`。

> 引用写法：`claude:4134ec80`（agent:id 前缀）是**稳定**的，跟列表顺序无关。
> `#1` 只是「上次列表的第 1 条」，每次列会话都会被重写，**别在任务或脚本里用**。

---

## 交接摘要的预算

摘要最终是要**塞进下一个 agent 的对话**的 —— 所以它不能无脑长。`ass brief` / `session_handoff`
按目标 agent 的上下文预算自适应裁剪：

```bash
ass brief claude:31c5af10 --budget tiny    # 约 2000 tokens
```

| 档位 | 上限 | | 档位 | 上限 |
| --- | --- | --- | --- | --- |
| `tiny` | 2k | | `large` | 16k |
| `small` | 4k | | `full` | 不限 |
| `standard`（缺省） | 8k | | | |

裁剪**不是**「把每节都砍短」，而是**按优先级逐节降档**（完整 → 精简 → 仅要点），
仍超预算才整节省略。每个节自己声明优先级，所以「先砍谁」是可预期的：

- 「主动记录的决策/踩坑」（`ass context` 那份）**必留**，而且降档时先砍的是**条数**、不是**类别** ——
  宁可少看两条备注，也不能把「决策」整类丢掉；
- 「涉及文件」这类最先被降档；
- **被裁掉的部分会显式写出来**，并给出看全文的命令：

```
## 交接预算

> 档位 `small`（上限 4000 tokens）· 实际约 3870
> 已降档：涉及文件 → 精简、需求时间线 → 仅要点

> 上面被省略的内容**不代表它不重要** —— 它只是没挤进这次的预算。
> 需要时请按上面的命令取全文，不要按"摘要里没有"推断"会话里没有"。
```

最后那句是刻意的：**让下一个 agent 知道"这里缺了什么、去哪补"**，而不是静默地以为摘要就是全部。

---

## 安装

```bash
npm install -g cross-agent-sync        # 全局：得到 ass 命令
# 或
npx cross-agent-sync list              # 直接用，不安装
```

> npm 上的包名是 **`cross-agent-sync`**；工具在运行时的名字（配置目录、MCP server 名、
> 规则块标记）统一叫 `agent-session-sync`，两者不一样是有意的 —— 改名不会动你已有的配置。

要求 Node >= 18.17。读 SQLite 类型的 agent（Cursor / OpenCode）时二选一：

- Node >= 22.5 且用 `--experimental-sqlite`（Node 23.4+ 免 flag），或
- 系统里有 `sqlite3` 命令行（macOS 自带）。

两个都没有时，`ass agents` 会明确告诉你 Cursor/OpenCode 读不了，而不是静默失败。

---

## 快速开始

### 场景 1：换个 agent 继续同一个项目

```bash
cd ~/path/to/your-project
ass                      # 看看这个仓库有哪些 agent 的会话
ass show #2              # 看看第 2 条讲了什么
```

### 场景 2：把 codex 里刚问过的问题，原样丢给 claude

```bash
ass list --agent codex --limit 5
ass last #1 --rounds 2
```

输出是一段可以直接粘贴到 claude 里的文本；如果那一问带图片，
图片会被解码落盘成真文件，路径一并打印出来，新 agent 直接读文件就能看图：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
来自 Codex (codex:019ff487, 2026-09-17 14:20)
仓库 /Users/me/work/some-project
图片 2 张已落盘：
      ~/.local/share/agent-session-sync/attachments/codex_019ff487/img-1.png
      ~/.local/share/agent-session-sync/attachments/codex_019ff487/img-2.png
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<原来的提问原文>
```

### 场景 3：把「为什么这么决定」和「这条路走不通」记下来

这一层比自动摘要重要得多 —— 从对话里猜"当时为什么这么定"很不靠谱，
但 agent 亲手记的一句会**置顶**出现在之后每个 agent 的交接摘要里：

```bash
ass context --decision "接口错误统一走 msg 字段，不再各自判断报文类型"
ass context --dead-end  "在 axios 拦截器里做重试会导致 refresh 死循环，已验证不可行"
ass context --constraint "不要改旧版 SSO 的接口签名"
ass context --todo      "需求 5：首页表格换虚拟滚动"
ass context                        # 看当前记了什么
ass context --done c4              # 做完勾掉
```

装了 MCP 之后，agent 会在干活过程中自己调 `session_remember` 记这些（规则块里写了纪律）。

### 场景 4：收尾存档，下次换 agent 无缝接上

```bash
ass note --summary "卡在滑动验证码的接口联调，下一步做服务端校验"
```

之后**任何 agent** 一进这个仓库，`ass` / `session_status` 都会直接把这份摘要顶到最前面。

### 场景 5：让 agent 自己会用（MCP）

```bash
ass install          # 一键写 MCP 配置 + 全局规则块（先看：ass install --dry-run）
```

装完之后，新开的会话里 agent 就有 `session_*` 工具了：它会自己 `session_status` 看上次
收到哪儿、`session_list` 列候选给你选、`session_handoff` 取摘要、`session_last` 搬提问。
不想要了：`ass uninstall`（只摘 MCP 和规则，**不动**你的会话数据）。

### 场景 6：一件事分几段做完，中途换 agent

需求 1-3 用 claude 做完了，4-5 想换 codex —— 这两段在普通工具眼里是两条**互不相干**的会话。
把它们绑成**一个任务**：

```bash
ass task add 支付重构 --label "需求 1-3"      # 不给引用 = 绑本仓库最近那个会话
```

换到 codex 做完 4-5，接手时也绑进同一个任务：

```bash
ass task add 支付重构 --label "需求 4-5" --note "卡在退款回调"
```

之后在任何 agent 的新会话里说一句「**继续支付重构**」，它就会先取任务全貌再动手：

```bash
ass resume 支付重构
```

```
任务 支付重构  2 个会话 · claude→codex
起始会话主题（claude:8dda036d）
  把支付模块从回调改成 Promise
决策
  · 接口错误统一走 msg 字段 c4
  · 重试放拦截器会导致 refresh 死循环，已排除 c7
各段进展
  1. claude:8dda036d  需求 1-3 — 已完成
  2. codex:01a0b24d   需求 4-5 — 卡在退款回调（当前）
待办
  ☐ 退款回调重试幂等 c3
```

想让**没接 MCP 的 agent**（Cursor / Trae 这些）也看得到，就把它落成本仓库的交接记录：

```bash
ass resume 支付重构 --save
```

> 任务里存的引用一律是 `agent:id前缀` 这种**稳定形式**，不存 `#1`。
> 因为 `#N` 是「上次列表的第 N 条」，每次列会话都会被重写，跨进程不可靠。

---

## 两层上下文：自动读 + 主动记

这个工具刻意分两层，因为它们的可信度完全不同：

| 层 | 来源 | 可信度 | 谁负责 |
| --- | --- | --- | --- |
| **主动记录** | agent 干活时调 `session_remember` / 你敲 `ass context` | 高 —— 是当事人的判断 | 置顶显示在摘要最前面 |
| **自动摘要** | 从原始对话里启发式抽取（目标 / 时间线 / 涉及文件 / 结论 / 待办） | 中 —— 可能漏、可能偏 | `ass brief` / `session_handoff` |
| **原始记录** | 各 agent 自己的会话文件（只读） | 事实 | `ass show` / `ass search` / `session_read` |

为什么不做「从对话里自动猜决策」当作默认？我实测过两版：放宽了会把整段叙述抓进来，
收紧了又什么都抓不到 —— 一个**猜错的"决策"比没有更危险**，因为下一个 agent 会当真。
所以它被降级成 `ass brief --guess`（默认关，且标注"未经确认"）。

真正可靠的通道只有一条：**干活的时候顺手记一句**。所以规则块里专门写了这条纪律。

## 支持的 agent

内置 4 个（Claude Code / Codex / Cursor / OpenCode），其余通过 `ass detect` + 配置接入。

| agent | 数据源 | 格式 | 图片 |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` | JSONL | ✅ 内联 base64 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl`、`~/.codex/archived_sessions/` | JSONL | ✅ 内联 base64 |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite | ✅ `part.data.url` 是 data URL |
| Cursor | `<Cursor User>/globalStorage/state.vscdb` | SQLite | ✅ 附件文件 `workspaceStorage/<id>/images/` |
| Continue（可接入） | `~/.continue/sessions/*.json` | JSON | — |
| Gemini CLI（可接入） | `~/.gemini/tmp/<hash>/chats/*.json` | JSON | — |

仓库归属：Claude / Codex 用会话记录里的 `cwd`，OpenCode 用 `session.directory`，
Cursor 用 `workspaceStorage/<id>/workspace.json` 里的 `folder`；
最后统一用 `git rev-parse --show-toplevel` 归一化 —— 所以从子目录启动的会话也能对上同一个仓库。

### 没内置的 agent：`ass detect` 自己找

```bash
ass detect            # 扫一遍本机，列出所有能找到会话的 agent
ass detect --write    # 把「可接入」的写进配置文件（本机继续 / Gemini CLI 就是这么进去的）
```

`ass detect` 会分三类告诉你：

- **内置**：已经能读的（Claude Code / Codex / Cursor / OpenCode）；
- **可接入**：格式已知、给一段现成的 `customAgents` 配置就能用（Continue、Gemini CLI）；
- **需自定义**：装是装了、但存储结构还没摸清（Trae / Windsurf / VS Code Copilot Chat / Kiro）——
  它会告诉你库文件在哪，以及该往哪儿看。

### 关于 IDE 类 agent（Cursor / Kiro / Trae / Windsurf）

这类 agent 把会话塞在自己的 SQLite 或私有存储里，**结构是内部实现、随时会变**。
所以本工具的态度是：

- Cursor 内置了一份「尽力读取」的适配器（连它存在 `workspaceStorage/<id>/images/` 里的
  图片附件也能捞出来），读不到会告诉你原因，不会假装支持；
- Kiro / Trae / Windsurf 这类**需要你自己配置**（见下），你告诉它数据在哪、字段怎么取，它就能用。

**接 MCP**：`ass install` 只写**用户级**配置，而 Cursor 这类没有用户级全局 MCP 文件，
所以它默认接不上。用 `ass mcp` 处理：

```bash
ass mcp                    # 打印配置内容 + 该放到哪个文件（Trae 这类手工贴的用）
ass mcp --write            # 直接在**当前工程**创建 .cursor/mcp.json / .mcp.json
ass mcp --write --dry-run  # 只看不改
ass mcp --write --undo     # 撤销，只摘我们那一项（别人的 server 不动）
```

写进工程的那些文件都是 JSON，`ass mcp --write` 会**合并**而不是覆盖——
文件里已有的别的 MCP server 不会被冲掉。这些文件通常该提交进 git，团队共享；
不想提交就加进 `.gitignore`。

> **没接 MCP 也能用**：让 agent 跑 `ass brief <引用>` 一样能拿到交接摘要。
> 规则块里已经写明了这条兜底路径，agent 不需要自己猜。

---

## 配置

配置文件：`~/.config/agent-session-sync/config.json`（首次运行自动生成）。

```jsonc
{
  // 内置 adapter 开关（false = 不读这个 agent）
  "agents": { "claude": true, "codex": true, "opencode": true, "cursor": true },

  // 只保留这些 agent（白名单，优先级高于 agents）
  "only": ["claude", "codex"],

  "defaultLimit": 15,

  // 接入内置之外的 agent
  "customAgents": []
}
```

### 自定义 agent 示例

三种数据形态都支持：`jsonl`（一行一条）、`json`（一个文件一个会话）、`sqlite`（一条 SQL 出所有消息）。

**例 1：一个用 JSONL 存会话的 agent（比如 Kiro 的某类导出）**

```jsonc
{
  "customAgents": [
    {
      "id": "kiro",
      "label": "Kiro",
      "type": "jsonl",
      "path": "~/.kiro/sessions",
      "map": {
        "id": "sessionId",
        "cwd": "context.workingDirectory",
        "title": "title",
        "role": "message.role",
        "text": "message.content",
        "imageUrl": "message.imageUrl",
        "timestamp": "createdAt"
      },
      "resumeCmd": "kiro --resume {id}"
    }
  ]
}
```

`map` 里都是**点号路径**，从每条记录上取值；`role` 取到 `user` / `assistant` 才会计入对话。

**例 1.5：一个文件一个会话的 JSON（Continue 就是这样）**

```jsonc
{
  "customAgents": [
    {
      "id": "continue",
      "label": "Continue",
      "type": "json",
      "path": "~/.continue/sessions",
      "records": "history",              // 消息数组在这个字段里
      "roleMap": { "gemini": "assistant" }, // 把该 agent 的角色名映射成 user/assistant（可选）
      "map": {
        "id": "sessionId",
        "cwd": "workspaceDirectory",
        "title": "title",
        "role": "message.role",
        "text": "message.content"
      }
    }
  ]
}
```

消息正文是 `[{type:'text',text:'…'}]` 这种分片数组时，会自动拼成文本。

**例 2：一个用 SQLite 存会话的 agent**

```jsonc
{
  "customAgents": [
    {
      "id": "trae",
      "label": "Trae",
      "type": "sqlite",
      "path": "~/Library/Application Support/Trae/User/globalStorage/state.vscdb",
      "query": "select sessionId as id, cwd, title, role, text, createdAt as timestamp from messages order by createdAt",
      "map": { "id": "id", "cwd": "cwd", "title": "title", "role": "role", "text": "text", "timestamp": "timestamp" }
    }
  ]
}
```

`query` 返回的**列名**要和 `map` 的值对应；一个 `id` 下的多行会被聚合成一个会话。

> 💡 想快速摸清某个 IDE 的存储结构：用 `sqlite3 <db> ".tables"` 和
> `sqlite3 -json <db> "select * from <表> limit 1"` 看一眼，再对着填 `map` 就行。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `ASS_CLAUDE_DIR` / `ASS_CODEX_DIR` / `ASS_CODEX_ARCHIVED` / `ASS_OPENCODE_DB` / `ASS_CURSOR_DB` | 覆盖各 agent 的数据源路径 |
| `ASS_CONFIG_DIR` / `ASS_DATA_DIR` | 覆盖配置目录 / 数据目录（缓存、附件、交接记录） |
| `ASS_HOME` | 覆盖“用户主目录”的判定（测试 / 沙箱用） |

---

## 命令参考

```
ass                      当前仓库：上次收尾记录 + 最近会话
ass list [选项]           列出会话（--all 跨仓库，--agent claude，--limit 20，--json，--no-cache）
ass show <引用>           看某个会话（--full 全部，--tail 6 最后 N 条）
ass search <关键词>       在最近会话正文里全文搜索（--all，--scan 60）

ass last [引用]           把最后一问原样搬过来（--rounds 3，含图片落盘）
ass brief [引用]          生成交接摘要 Markdown（--out 文件.md；--guess 附上猜测内容，默认关）
                          --budget tiny|small|standard|large|full  按目标 agent 的上下文预算裁剪
ass note [引用]           收尾：把摘要存进本仓库（--summary "下一步做 X"）
ass notes                已保存的交接记录列表

ass context              看/记 决策·踩坑·约束·待办
                         --decision/--dead-end/--constraint/--todo "…" 记一条
                         --done c4 勾掉待办，--remove c4 删除，--all 连已完成一起看

ass resume [任务]        任务总览：原始目标 / 决策 / 各段进展 / 待办
                         --save 存成本仓库的交接记录（下次任何 agent 自动看到）
                         --md 输出 Markdown，--out 文件.md，--json
ass task                 列出本仓库的任务（--all 跨仓库且含已完成）
ass task new <名字>      新建任务（--goal "原始目标"）
ass task add <任务> [引用]  把会话绑进来（--label "需求 4-5"，--note "卡在退款回调"）
                         不给引用 = 本仓库最近在写的那个会话
ass task note <任务> [引用] --note "…"     更新某一段的进展
ass task rm <任务> [引用]  解绑一段；不给引用 = 删掉整个任务（只认完整名字 / tN）
ass task done <任务>     标记完成（再执行一次 = 重新打开）

ass install              接入 MCP + 全局规则（--dry-run 只看不改）
ass rules                打印规则原文（Cursor/Trae 要手工贴的用）
ass mcp                  打印 MCP 配置内容 + 该放哪；--write 在当前工程自动创建
                         （Cursor 这类没有用户级全局 MCP 文件的，只能走项目级）
ass uninstall            摘掉 MCP + 规则（不动会话数据）
ass init [目录]          项目级规则注入（--dry-run / --undo）
ass detect               自检索：扫盘找出本机所有可能的 agent（--write 写入配置草案）
ass agents               探测到哪些 agent、MCP 是否已接入
ass repos                有历史的仓库列表
ass config [--init]      打印/初始化配置文件
ass doctor               自检
```

### MCP 工具

| 工具 | 用途 |
| --- | --- |
| `session_status` | 新会话开场：进行中的任务 + 记过的上下文 + 上次收尾记录 + 最近会话 |
| `session_list` | 列出这个仓库跨 agent 的最近会话 |
| `session_handoff` | 生成交接摘要（推荐的导入方式） |
| `session_read` | `summary` / `tail` / `full` 读原始对话 |
| `session_last` | 把上一问（含图片）原样搬到当前 agent |
| `session_search` | 跨会话全文搜索 |
| `session_note` | 保存交接摘要（收尾时用） |
| `session_remember` | 记录决策 / 踩坑 / 约束 / 待办（**干活过程中就调**） |
| `session_task` | 把当前会话绑进一个任务（`attach` / `list` / `unbind` / `done`） |
| `session_task_resume` | 取任务全貌：原始目标 / 决策 / 各段进展 / 待办。**说「继续 X」时先调这个** |
| `session_repos` | 哪些仓库有历史 |
| `session_detect` | 扫盘找出本机所有可能的 agent |

另有 MCP prompt `sync_previous_session`（Claude Code 里可用 `/mcp__agent-session-sync__sync_previous_session`）。

**引用**怎么写都行：

| 写法 | 含义 |
| --- | --- |
| `#1` | 上一次 `list` 的第 1 条（⚠️ 位置会随每次列会话被重写，**跨进程不稳定**，脚本里别用） |
| `claude:31c5af10` | `agent:会话id前缀` |
| `31c5af10` | id 前缀（唯一时），多个候选取最近的 |
| `点击穿透` | 标题/最近一句需求里包含这段文字 |
| `t3` / `支付重构` | 任务（`ass task` / `ass resume` 用）；破坏性操作只认完整名字或 `tN` |

---

## 目录结构

```
~/.config/agent-session-sync/config.json     # 你的配置
~/.local/share/agent-session-sync/
├── cache/index.json                          # 跨 agent 索引缓存（可安全删除）
├── attachments/<agent>_<id>/img-N.png        # 搬运时落盘的图片
├── tasks/index.json                          # 任务 → 多段会话的绑定（全局，可跨仓库）
└── handoffs/
    ├── index.json                            # 仓库 → 最新一份交接记录
    └── <repo>/latest.md + <时间>-<标题>.md    # 每次 ass note / ass resume --save 存一份
```

`ass install` 会碰到的东西（每个文件写之前都先备份成 `<文件>.bak-<时间戳>`）：

| agent | MCP 配置位置 | 全局规则 |
| --- | --- | --- |
| Claude Code | `~/.claude.json` → `mcpServers` | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/config.toml` → `[mcp_servers.agent-session-sync]` | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/opencode.jsonc` → `mcp` | `~/.config/opencode/AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` | 手工贴：`ass rules` → Cursor Settings → Rules |
| Kiro | `~/.kiro/settings/mcp.json` | 同 Cursor，手工 |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | 同 Cursor，手工 |
| Trae | 在 IDE 里手工添加（`ass rules` 拿规则原文） | 手工 |

> 规则块用 `<!-- >>> agent-session-sync ... >>> -->` 标记包起来，
> `ass uninstall` 能精确摘掉；项目级注入（`ass init <目录>`）默认**不会**做。

## 开发

```bash
npm install
npm run dev        # tsup watch
npm run typecheck
npm test           # 构建 + node --test
```

架构分三层，加一个 agent 只要写一个文件：

```
src/adapters/*.ts   各 agent 的解析器（available / sources / list / read）
        ↓
src/core/*.ts       与 agent 无关：索引缓存、仓库归一化、跨 agent 解析、附件落盘
        ↓
src/cli.ts          命令行          src/mcp.ts   MCP server（规划中）
```

## Roadmap

- [x] **M1** 跨 agent 索引 + CLI（list / show / last / agents / repos / doctor）
- [x] **M2** 交接摘要（brief）+ MCP server + 收尾记录（note）+ `ass install`
- [x] **M3** 图片搬运打通全部内置 agent（Claude / Codex 内联 base64，OpenCode data URL，Cursor 附件文件）
- [x] **M4** 自检索 `ass detect`（含可接入草案）+ 项目级规则注入 `ass init --dry-run/--undo` + 自定义 agent
- [x] **P0** 决策/踩坑通道：`session_remember` + `ass context`（置顶进交接摘要）
- [x] **P4** 规则块重写：加上「干活过程中随手记」「收尾落状态」的纪律
- [x] **P1** 「任务/工作流」：把跨 agent 的多次会话绑成一个任务，`ass resume <任务>`
- [ ] **P2** 退场钩子：`ass hook install`，收尾自动落 note（不靠 agent 自觉）
- [ ] **M5** 打包发布：npm publish、CI
- [ ] 待摸清：Trae / Windsurf / VS Code Copilot Chat 的存储结构（`ass detect` 已能找到库文件）

## License

MIT

### 看懂任务、笔记与原始对话

- **工作任务**：将同一件事的多个会话关联起来。“关联 2 个会话 · claude→codex”表示两个已关联会话的 agent 接续顺序，不是两条待办。
- **任务目标**：用户显式设置的目标。未设置时显示“起始会话主题”及来源，它来自首个关联会话的标题，不代表工具综合理解了整个任务。
- **项目笔记**：用户或 agent 此前主动保存的仓库共享记录，不是原始提示词，也不是执行命令时重新生成的摘要。内容和完成状态可能尚未更新。
- **交接摘要**：工具按规则抽取并按预算裁剪，可能遗漏信息。
- **完整对话**：适配器解析出的用户与助手消息，不是原始日志的无损副本；部分工具返回等内容不会包含在内。

| 想查看的内容 | 命令 |
| --- | --- |
| 最后一次原始提问 | `ass last <会话引用>` |
| 完整的已解析对话 | `ass show <会话引用> --full` |
| 交接摘要 | `ass brief <会话引用>` |
| 项目笔记概览（长笔记截短） | `ass context` |
| 项目笔记完整内容 | `ass context --details` |
| 包含已完成待办的完整笔记 | `ass context --all --details` |

笔记显示记录时间、保存方式、已知的来源会话和待办标记状态。旧记录缺失的信息显示“未记录”，不会推断记录者。CLI 的新笔记可以用 `--session agent:id` 保存已知来源；MCP 的 `session_remember` 使用可选的 `session` 参数。

保存时一条笔记只表达一个事项：决策记录方案与原因；待办记录具体动作及完成条件；工作进展和验证结果使用 `--note` / `note`。确认完成后使用 `ass context --done <实际编号>`，工具不会自动把未勾选待办当成仍未完成的事实。

### 更新笔记状态与关联历史

以下编号仅为示例，请替换为 `ass context` 中实际存在的编号：

```bash
# 一条进展关联到待办；不会自动把待办标记完成
ass context --note "本地验证通过，线上尚未验证" --related-to c3
# 将大待办拆成具体事项：逐条新增并关联原待办，再显式取消原待办
ass context --todo "验证线上下载，确认文件内容正确" --related-to c3
ass context --cancel c3
# 确认完成 / 重新打开
ass context --done c4
ass context --reopen c4
# 新决策替代旧决策，保留两条记录
ass context --decision "采用新方案，因为旧方案不支持并发" --supersedes c1
# 查看包括已完成、已取消待办和被替代决策在内的历史
ass context --all --details
```

MCP `session_remember` 对应参数为 `related_to`、`supersedes`、`cancel`、`reopen`。替代只适用于决策；状态操作只适用于待办。不自动推断两条笔记的关联或完成情况。被引用的记录不能直接删除，避免丢失来源；取消和替代均保留历史。

没有工作任务时，首页会说明尚未建立并给出创建方式。会话列表超过显示上限时，首页标注“显示最近 N 个会话（还有更多）”，不会将显示数量当作仓库总数。

### 区分建议、授权与实际进展

“待办还没勾选”不能说明用户已同意修改，也不能说明别的 AI 没有完成。新版本将两件事分开记录：

- 未确认的 AI 想法保存为 **建议 / 待确认**，不会计入待办。
- 用户明确授权后，通过 `confirm` 保存授权依据，建议转为待办。
- 旧待办，以及直接用 `--todo` 保存而未确认的事项，显示 **授权未记录**；不会自动升级为已授权。
- 接手的 AI 应先只读核对当前代码和测试，再记录 **已完成、部分完成、仍需处理、无法确认**，附依据与局限。历史会话只能提供线索。

```bash
ass context --suggestion "建议重构请求层"
# 使用上一步实际返回的编号；依据应是已有的用户授权，不能编造
ass context --confirm c7 --evidence "用户明确要求按请求层方案修改" --session codex:<实际ID>
ass context --review c7 --result partial --evidence "拦截器已修复，下载路径尚未验证"
ass context --review c7 --result completed --evidence "已核对当前代码，相关集成测试通过"
ass context --all --details
```

MCP `session_remember` 提供同名参数 `suggestion`、`confirm`、`review`、`result`、`evidence`。`result` 可取 `completed`、`partial`、`pending`、`unknown`。确认与核对必须附依据；已取消事项需先重新打开。核对完成会标记完成，其余结果保留为未完成标记，所有核对结果均保留历史。核对不代表授权，重新打开也不会凭空产生授权。

这是 **AI 核对、工具保存依据与结果** 的流程，工具本身不会自动分析全部仓库或证明调用者填写的依据真实。`--done` 仍是兼容的手动完成标记，不等同于有证据的核对结果。现有已安装 agent 需要更新同步规则并重新加载 MCP，才能使用新指引和参数。

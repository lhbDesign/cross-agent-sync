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
| 看某个会话的完整对话 | `ass show #1` · `session_read` |
| **把上一次的提问原样搬过来**（含图片落盘） | `ass last #1` · `session_last` |
| 连问多轮一起搬 | `ass last #1 --rounds 3` |
| **生成交接摘要**（目标 / 时间线 / 文件 / 结论 / 待办） | `ass brief #1` · `session_handoff` |
| **收尾存档**，下次任何 agent 一进来就能看到 | `ass note` · `session_note` · `session_status` |
| 跨 agent 全文搜索 | `ass search "点击穿透"` · `session_search` |
| 一键把 MCP + 规则接进本机各 agent | `ass install` |
| **自检索**：扫盘找出本机所有可能的 agent | `ass detect` · `session_detect` |
| 哪些 agent 被探测到了、数据在哪 | `ass agents` |
| 自检 | `ass doctor` |

设计原则：

- **只读**。不修改任何 agent 的会话数据，只读 JSONL / SQLite。
- **不动你的项目**。默认只写用户级配置（`~/.config`、`~/.local/share`），
  要往仓库里注入规则必须显式执行 `ass init`（带 `--dry-run` 和备份）。
- **零运行时依赖**。发布出来的包只依赖 Node 内置模块。

---

## 安装

```bash
npm install -g agent-session-sync      # 全局：得到 ass 命令
# 或
npx agent-session-sync list            # 直接用，不安装
```

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

### 场景 3：收尾存档，下次换 agent 无缝接上

```bash
ass note --summary "卡在滑动验证码的接口联调，下一步做服务端校验"
```

之后**任何 agent** 一进这个仓库，`ass` / `session_status` 都会直接把这份摘要顶到最前面。

### 场景 4：让 agent 自己会用（MCP）

```bash
ass install          # 一键写 MCP 配置 + 全局规则块（先看：ass install --dry-run）
```

装完之后，新开的会话里 agent 就有 `session_*` 工具了：它会自己 `session_status` 看上次
收到哪儿、`session_list` 列候选给你选、`session_handoff` 取摘要、`session_last` 搬提问。
不想要了：`ass uninstall`（只摘 MCP 和规则，**不动**你的会话数据）。

---

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
ass brief [引用]          生成交接摘要 Markdown（--out 文件.md）
ass note [引用]           收尾：把摘要存进本仓库（--summary "下一步做 X"）
ass notes                已保存的交接记录列表

ass install              接入 MCP + 全局规则（--dry-run 只看不改）
ass rules                打印规则原文（Cursor/Trae 要手工贴的用）
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
| `session_status` | 新会话开场：上次的收尾记录 + 最近会话 |
| `session_list` | 列出这个仓库跨 agent 的最近会话 |
| `session_handoff` | 生成交接摘要（推荐的导入方式） |
| `session_read` | `summary` / `tail` / `full` 读原始对话 |
| `session_last` | 把上一问（含图片）原样搬到当前 agent |
| `session_search` | 跨会话全文搜索 |
| `session_note` | 保存交接摘要（收尾时用） |
| `session_repos` | 哪些仓库有历史 |
| `session_detect` | 扫盘找出本机所有可能的 agent |

另有 MCP prompt `sync_previous_session`（Claude Code 里可用 `/mcp__agent-session-sync__sync_previous_session`）。

**引用**怎么写都行：

| 写法 | 含义 |
| --- | --- |
| `#1` | 上一次 `list` 的第 1 条 |
| `claude:31c5af10` | `agent:会话id前缀` |
| `31c5af10` | id 前缀（唯一时），多个候选取最近的 |
| `点击穿透` | 标题/最近一句需求里包含这段文字 |

---

## 目录结构

```
~/.config/agent-session-sync/config.json     # 你的配置
~/.local/share/agent-session-sync/
├── cache/index.json                          # 跨 agent 索引缓存（可安全删除）
├── attachments/<agent>_<id>/img-N.png        # 搬运时落盘的图片
└── handoffs/
    ├── index.json                            # 仓库 → 最新一份交接记录
    └── <repo>/latest.md + <时间>-<标题>.md    # 每次 ass note 存一份
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
- [ ] **M5** 打包发布：npm publish、CI、CHANGELOG
- [ ] 待摸清：Trae / Windsurf / VS Code Copilot Chat 的存储结构（`ass detect` 已能找到库文件）

## License

MIT

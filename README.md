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

| 能力 | 命令 / 接口 |
| --- | --- |
| 列出**所有 agent** 在**当前仓库**的会话 | `ass` / `ass list` |
| 跨仓库浏览、按 agent 过滤、看会话规模 | `ass list --all` / `--agent codex` |
| 看某个会话的完整对话 | `ass show #1` |
| **把上一次的提问原样搬过来**（含图片落盘） | `ass last #1` |
| 连问多轮一起搬 | `ass last #1 --rounds 3` |
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

### 场景 3：接给 agent 当 MCP / 规则用

把下面的规则贴进各 agent 的全局规则文件（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、
Cursor 的 User Rules 等）：

```markdown
## 跨 agent 会话同步
新会话开场，或用户说「继续 / 接着上次 / 同步历史 / 换个模型」时：
1. 先跑 `ass`，用「序号 · agent · 时间 · 标题 · 最近一句需求」列出当前仓库的会话；
2. 问用户要同步哪一个（不要自己替他选）；
3. `ass show <引用>` 拿上下文，或 `ass last <引用>` 把上一问原样搬过来（含图片路径）；
完成一个阶段后，如果用户说「记一下 / 收尾 / 保存进度」，把结论写进仓库里的交接文件。
```

---

## 支持的 agent

内置 4 个，其余通过配置接入（见下一节）。

| agent | 数据源 | 格式 | 图片 |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` | JSONL | ✅ 内联 base64 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl`、`~/.codex/archived_sessions/` | JSONL | ✅ 内联 base64 |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite | ✅ `part.data.url` 是 data URL |
| Cursor | `<Cursor User>/globalStorage/state.vscdb` | SQLite | ✅ bubble 里的 images |

仓库归属：Claude / Codex 用会话记录里的 `cwd`，OpenCode 用 `session.directory`，
Cursor 用 `workspaceStorage/<id>/workspace.json` 里的 `folder`；
最后统一用 `git rev-parse --show-toplevel` 归一化 —— 所以从子目录启动的会话也能对上同一个仓库。

### 关于 IDE 类 agent（Cursor / Kiro / Trae / Windsurf）

这类 agent 把会话塞在自己的 SQLite 或私有存储里，**结构是内部实现、随时会变**。
所以本工具的态度是：

- Cursor 内置了一份「尽力读取」的适配器，读不到会告诉你原因，不会假装支持；
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

---

## 命令参考

```
ass                      看当前仓库有哪些 agent 的会话
ass list [选项]           列出会话（--all 跨仓库，--agent claude，--limit 20，--json，--no-cache）
ass show <引用>           看某个会话（--full 全部，--tail 6 最后 N 条）
ass last [引用]           把最后一问原样搬过来（--rounds 3 连问多轮，--json）
ass agents               本机探测到哪些 agent、数据源在哪
ass repos                有历史的仓库列表
ass config [--init]      打印/初始化配置文件
ass doctor               自检
```

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
└── attachments/<agent>_<id>/img-N.png        # 搬运时落盘的图片
```

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

- [x] M1 跨 agent 索引 + CLI（list / show / last / agents / repos / doctor）
- [ ] M2 交接摘要（brief）+ MCP server + 收尾记录（note）
- [ ] M3 附件搬运补齐（OpenCode/Cursor 图片、文件附件）
- [ ] M4 自检索（扫盘列出可能的 agent）+ 项目级规则注入（`ass init`）

## License

MIT

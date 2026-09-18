对，你描述的这个痛点非常明确：你需要的不是普通的“AI Memory”，而是一个 **跨 Agent 的 Session Handoff / Context Hub**。

你希望实现的是：

```text
Claude Code
  │
  │ 需求 1、2、3
  ↓
共享 Context / Session Store
  ↑
  │ 选择「A问题 / Claude会话」
  │
Codex
  │
  │ 接着完成需求 4、5
  ↓
共享 Context / Session Store
  ↑
Cursor / OpenCode / 其他 Agent
```

**这个方向完全可行，而且截至现在已经有一些工具在专门解决这个问题。**我刚查了当前方案，比较接近你需求的有 Handover、Delimit，以及基于 MCP Memory 自己搭一套；但我认为你真正需要的是“共享上下文 + 会话选择 + 自动交接”，而不只是简单的 memory。

### 你要解决的其实是 3 层问题

第一层是**项目永久规则**。例如项目技术栈、目录约定、接口规范、不能修改哪些代码。这种东西根本不应该跟着聊天走，而应该直接存在项目里：

```text
my-project/
├── AGENTS.md
├── CLAUDE.md
├── .cursor/
│   └── rules/
└── ...
```

Cursor 已经支持 `AGENTS.md`，Cursor CLI 甚至会同时读取 `AGENTS.md` 和 `CLAUDE.md`。:chatgpt-content-reference{index="0"}

所以这一部分比较容易统一。

第二层才是你真正缺的东西——**任务 Session**。

例如：

```text
任务：A问题
ID: login-refactor-001

目标：
重构登录模块

已经完成：
✓ 需求1
✓ 需求2
✓ 需求3

当前代码修改：
src/api/login.ts
src/store/user.ts
src/views/login.vue

关键决策：
- token 改为 xxx
- refreshToken 使用 xxx
- 不修改旧版 SSO

踩过的坑：
- xxx 方法不能使用
- 尝试方案 B 已失败

待完成：
□ 需求4
□ 需求5

最近执行 Agent：
Claude Code

相关 commits / diff：
xxxx
```

第三层是**原始对话历史**。

你甚至希望：

```text
/handoff
```

以后 Codex 启动：

```text
发现当前项目有 4 个历史任务：

1. A问题 - 登录模块重构
   Claude Code
   2026-09-17 17:42
   已完成 3/5

2. B问题 - ECharts地图
   Cursor
   2026-09-16 14:20

3. C问题 - 接口重构
   OpenCode
   2026-09-15 11:08

请选择要继续的会话：
> 1
```

然后 Codex 自动得到 A 问题的上下文。

**这就是最符合你描述的产品形态。**

---

## 现在已经有比较接近的东西

我查到一个非常贴近你需求的项目叫 **Handover**。

[Handover：Claude Code / Cursor / Codex 跨 Agent Memory](https://handover.sh/guides/mcp-memory-server-for-claude-code-cursor-codex?utm_source=chatgpt.com)

它的设计就是让：

> Claude Code / Cursor / Codex

全部连接同一个 MCP Memory Server。

而且它不是简单保存一堆聊天文本，而是保存：

> objective  
> current state  
> decisions  
> evidence  
> constraints  
> unresolved issues  
> next action  
> owner

也就是**专门保存“接下来另一个 Agent 怎么继续干活”所需要的信息**。:chatgpt-content-reference{index="2"}

还有一个更像你描述的：

[Delimit 跨 Agent Handoff](https://delimit.ai/reports/cross-agent-handoff?utm_source=chatgpt.com)

它给出的案例甚至就是：

```text
Claude Code
↓
做到 60%
↓
生成 handoff
↓
Codex / Cursor / Gemini
↓
继续做
```

核心机制就是：

```text
Claude Code
       \
Codex ---- MCP ---- ~/.delimit/sessions/
       /
Cursor
```

不同 CLI 不共享自己的聊天 buffer，但是通过 MCP 共享一个**结构化 Session Handoff**。:chatgpt-content-reference{index="4"}

这个和你刚才描述的场景已经非常接近了。

---

## 但我觉得你真正想要的还应该再往前一步

单纯装一个 Memory MCP，我觉得还不够爽。

因为你明确说了：

> “新启动一个对话的时候，我可以选择同步之前的哪个会话历史。”

所以如果让我按你的工作习惯设计，我会做成：

```text
              Agent Context Hub
                     │
        ┌────────────┼────────────┐
        │            │            │
   Project       Task Session    Memory
        │            │            │
    AGENTS.md     A问题         技术决策
    CLAUDE.md     B问题         踩坑记录
    rules         C问题         项目知识
                     │
       ┌─────────────┼─────────────┐
       ↓             ↓             ↓
    Claude         Codex        Cursor
       ↓             ↓             ↓
                OpenCode
```

然后所有 Agent 都安装同一个 MCP：

```text
context-hub MCP
```

提供几个统一工具：

```text
list_sessions(project)

get_session("A问题")

resume_session("A问题")

save_checkpoint()

handoff_session()

search_history("登录 token")

get_decisions("A问题")
```

这样 Claude 干完需求 1 ～ 3：

```text
/handoff
```

自动保存。

你退出 Claude，打开 Codex。

直接说：

```text
继续 A问题
```

Codex 调：

```text
context_hub.resume_session("A问题")
```

然后拿到：

```text
原始需求
+
Claude关键对话
+
已经修改的文件
+
git diff
+
执行过的命令
+
架构决策
+
失败尝试
+
当前TODO
+
下一步建议
```

你一句上下文都不用重新解释。

---

## “完整历史”我反而不建议全部灌给下一个 Agent

比如 Claude 已经聊了 150 轮。

直接把：

```text
150轮 Claude 对话
```

全部塞给 Codex，很浪费 context，而且很多都是：

```text
你：这个不对
Claude：我重新修改
你：还是不行
Claude：发现原因了
...
```

真正有价值的是最终状态。

所以最好保存两层：

```text
Session
│
├── raw-history/
│   └── claude-20260917.jsonl
│
└── handoff.md
```

Codex 启动默认只读：

```text
handoff.md
```

需要调查历史原因时，再通过 MCP：

```text
search_history(
  session="A问题",
  query="为什么当时没有使用方案B"
)
```

再从原始 Claude 对话里把相关几轮找出来。

这样 context 使用效率最高。

---

## 而且你甚至不一定需要等别人把产品做完善

你是前端开发，而且 Claude/Codex/OpenCode 都已经在用 MCP。Cursor 官方本身也支持 MCP，用于给 Agent 拉取外部上下文；CLI 也能读取同一套 MCP 配置。:chatgpt-content-reference{index="5"}

所以这个东西其实**自己做一个本地 MCP 并不复杂**。

最初版本甚至 SQLite 都不用：

```text
~/.agent-hub/

projects/
  decision-algo-frontend/
    project.json

    sessions/
      login-refactor/
        session.json
        handoff.md
        claude.jsonl
        codex.jsonl

      table-bug/
        session.json
        handoff.md
        cursor.jsonl
```

MCP Server 用 Node + TypeScript。

第一版只实现：

```text
list_sessions
create_session
get_session
save_checkpoint
handoff
search_sessions
```

就已经解决你 **80% 的问题**。

---

### 最关键的是再加一条所有 Agent 共用的规则

Claude / Codex / Cursor / OpenCode 都告诉它：

```text
When starting work:

1. Detect the current project.
2. Query Context Hub for active sessions.
3. If related sessions exist, ask the user which one to resume.
4. Load its handoff context before modifying code.

During work:
5. Record important architectural decisions.
6. Record failed approaches that should not be repeated.

Before ending:
7. Save a checkpoint containing:
   - completed work
   - modified files
   - decisions
   - unresolved problems
   - next steps
8. Update the current session.
```

于是就形成真正的：

**Agent 无状态，项目上下文有状态。**

你以后根本不用关心：

> “这件事之前到底是 Claude 做的还是 Codex 做的？”

你只需要关心：

> **“我要继续 A 问题。”**

Agent 自己去 Context Hub 拿上下文。

---

所以我觉得你这个需求**没必要强行寻找一个能够直接把 Claude UI 对话复制到 Codex UI 的工具**。更好的方向就是你自己刚才想到的：

> **一个所有 Agent 共用的 MCP + 一套共用 Skill/Rule + Session Handoff。**

现成的 Handover / Delimit 可以先试；如果它们的“选择历史 Session”体验达不到你要的程度，**这个东西非常值得自己做一个轻量版**，因为你的需求已经非常具体，而且技术实现并不重。

如果按你现在 Mac + Claude Code + Codex + Cursor + OpenCode 这套环境，我会优先设计成**纯本地、不开服务器、项目自动识别、可选择历史 Session、自动 handoff、原始对话可搜索**。这样基本就是你描述的完整体验。

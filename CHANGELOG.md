# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **决策 / 踩坑 / 约束 / 待办 通道**（`session_remember` / `ass context`）：
  agent 在干活过程中随手记下的判断，会**置顶**出现在之后每个 agent 的交接摘要里。
  这是换 agent 时最值钱、最省 token 的信息，也是唯一可信的来源。
- 规则块重写：加入「干活过程中随手记，别攒到最后」「收尾把状态落下来」的完整纪律，
  并明确「默认只给摘要、全文要显式要」。
- `ass rules` 命令（之前帮助里写了但没实现）。

### 变更

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

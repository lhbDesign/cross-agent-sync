# agent-session-sync

[English](README.md) | [中文](README.zh-CN.md)

> Switch agents or start a fresh chat without re-explaining “what we already did / what’s next.”
> One command brings over the **handoff brief**, the **original question**, and even **images** from another agent.

On the same machine you may run Claude Code, Codex, Cursor, OpenCode… side by side.
Same project, same problem: requirements 1–3 in Claude, 4–5 in Codex.
The catch: **history stays in the previous agent**. Switching feels like amnesia, and images have to be pasted again.

`agent-session-sync` fixes that: it **read-only** aggregates each agent’s local sessions,
aligns them by **repository**, then lets you “pick a session → bring the context over.”

---

## What it does

| Capability | CLI / MCP tool |
| --- | --- |
| List sessions from **all agents** in the **current repo** | `ass` · `ass list` · `session_list` |
| Browse across repos, filter by agent, see session size | `ass list --all` / `--agent codex` |
| Read a full conversation | `ass show #1 --full` · `session_read` |
| **Port the last question as-is** (images written to disk) | `ass last #1` · `session_last` |
| Port several recent rounds together | `ass last #1 --rounds 3` |
| **Build a handoff brief** (goal / timeline / files / conclusions / todos) | `ass brief #1` · `session_handoff` |
| **Wrap up & archive** so any agent sees it next time | `ass note` · `session_note` · `session_status` |
| **Record decisions / dead ends / constraints / todos**, pinned for the next agent | `ass context` · `session_remember` |
| **Bind multiple sessions into one task**, then resume in another agent with one sentence | `ass task` · `ass resume` · `session_task` |
| Task overview: original goal / decisions / per-segment progress / todos | `ass resume <task>` · `session_task_resume` |
| Full-text search across agents | `ass search "click-through"` · `session_search` |
| One-shot wire MCP + rules into local agents | `ass install` |
| **Auto-detect**: scan the disk for possible agents | `ass detect` · `session_detect` |
| Which agents were found and where their data lives | `ass agents` |
| Self-check | `ass doctor` |

Design principles:

- **Read-only — enforced at runtime, not just promised.** Session data paths are a **protected zone**:
  any write that hits them is rejected (escape hatch `ASS_ALLOW_SOURCE_WRITE=1`). Source files are
  opened with an explicit `O_RDONLY` handle and fingerprinted after read. `ass doctor` can prove
  “this run did not modify any source data.”
  Even `sqlite3` is invoked with `-readonly` — it otherwise opens writable and may create
  `-journal`/`-wal` beside a DB that needs recovery, which would break the “read-only aggregate” premise.
- **Does not touch your project by default.** Writes go to user-level config (`~/.config`, `~/.local/share`).
  Injecting rules into a repo requires an explicit `ass init` (with `--dry-run` and backups).
- **Zero runtime dependencies.** The published package only uses Node built-ins.

---

## Two concepts: session vs task

```
task  cross-agent-sync-dev           ← one piece of work
  ├── segment 1  claude:4134ec80   14 turns   ← one conversation
  └── segment 2  codex:01a0b24d     7 turns   ← one conversation
```

| | **Session** | **Task** |
| --- | --- | --- |
| What it is | **One** conversation | **One** piece of work |
| Boundary | Belongs to one agent; **breaks when you switch agents** | Cross-agent, cross-day |
| How to continue | `claude --resume <id>` (**same agent only**) | In a new agent, say “continue `<task name>`” |
| Count | Many | Few — one per piece of work |

**Key point: sessions are agent-private.** A Claude session lives in Claude’s `.jsonl`; Codex
cannot read or resume it. “Resume a Claude session inside Codex” is impossible — `claude --resume`
works only because that session **was Claude’s to begin with**.

What you *can* do is **open a new chat carrying that context**:

```bash
ass last  claude:4134ec80     # just the last question (images included)
ass brief claude:4134ec80     # full handoff brief
```

Or bind it into a task, then pick up in any agent with one sentence:

```bash
ass task add cross-agent-sync-dev claude:4134ec80
# Then in Codex / Cursor say “continue cross-agent-sync-dev” —
# it will fetch: goal, progress so far, decisions and dead ends
```

**Two paths for different setups**:

| Target agent | How to bring context | Why |
| --- | --- | --- |
| Agent with this tool’s MCP configured | Say “show the handoff brief for `claude:4134ec80`”; it calls `session_handoff` | Zero copy — context lands in the chat |
| Agent without this tool’s MCP yet | Run `ass brief claude:4134ec80` and paste the output | Current chat cannot call this MCP |

> For Cursor, `ass install` can write user-level MCP config, or `ass mcp --write` writes project config.
> Use `ass mcp` to inspect config and `ass rules` for the sync rules.

> Reference form: `claude:4134ec80` (`agent:id` prefix) is **stable**, independent of list order.
> `#1` only means “item 1 from the last list” and is rewritten every time you list sessions —
> **do not use it in tasks or scripts**.

---

## Handoff brief budget

The brief ends up **inside the next agent’s conversation**, so it cannot grow without bound.
`ass brief` / `session_handoff` trim adaptively to the target agent’s context budget:

```bash
ass brief claude:31c5af10 --budget tiny    # ~2000 tokens
```

| Tier | Cap | | Tier | Cap |
| --- | --- | --- | --- | --- |
| `tiny` | 2k | | `large` | 16k |
| `small` | 4k | | `full` | unlimited |
| `standard` (default) | 8k | | | |

Trimming is **not** “shorten every section equally.” Sections are **downgraded by priority**
(full → condensed → bullets only); only then is a whole section dropped. Each section declares
its own priority, so “what gets cut first” is predictable:

- “Actively recorded decisions / dead ends” (`ass context`) are **always kept**. When downgrading,
  we cut **count**, not **category** — better to show fewer notes than to drop the whole “decisions” class;
- “Files touched” is among the first to downgrade;
- **Dropped parts are stated explicitly**, with a command to fetch the full text:

```
## Handoff budget

> Tier `small` (cap 4000 tokens) · actual ~3870
> Downgraded: files touched → condensed, requirement timeline → bullets only

> Omitted content above does **not** mean it is unimportant — it simply did not fit this budget.
> Fetch the full text with the commands above; do not infer “not in the brief” as “not in the session.”
```

That last line is intentional: the next agent should know **what is missing and where to get it**,
instead of silently treating the brief as the whole story.

---

## Install

```bash
npm install -g cross-agent-sync        # global: get the `ass` command
# or
npx cross-agent-sync list              # use without installing
```

> The npm package name is **`cross-agent-sync`**. At runtime the tool name (config dir, MCP server name,
> rule-block markers) is `agent-session-sync`. The mismatch is intentional — renaming the package
> does not break existing config.

Requires Node >= 18.17. For SQLite-based agents (Cursor / OpenCode), pick one:

- Node >= 22.5 with `--experimental-sqlite` (Node 23.4+ needs no flag), or
- a system `sqlite3` CLI (bundled on macOS).

If neither is available, `ass agents` tells you clearly that Cursor/OpenCode cannot be read —
it does not fail silently.

---

## Quick start

### Scenario 1: Switch agents on the same project

```bash
cd ~/path/to/your-project
ass                      # see sessions from every agent for this repo
ass show #2              # peek at item 2
```

### Scenario 2: Port a question just asked in Codex into Claude as-is

```bash
ass list --agent codex --limit 5
ass last #1 --rounds 2
```

Output is paste-ready text for Claude. If that turn had images, they are decoded to real files
and paths are printed so the new agent can open them:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
From Codex (codex:019ff487, 2026-09-17 14:20)
Repo /Users/me/work/some-project
2 image(s) written to disk:
      ~/.local/share/agent-session-sync/attachments/codex_019ff487/img-1.png
      ~/.local/share/agent-session-sync/attachments/codex_019ff487/img-2.png
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<original question text>
```

### Scenario 3: Record “why we decided this” and “this path is a dead end”

This layer matters more than auto-summaries — guessing “why we decided X” from chat is unreliable,
but a line the agent writes itself is **pinned** at the top of every later handoff brief:

```bash
ass context --decision "API errors always use the msg field; stop branching on payload type"
ass context --dead-end  "Retry in the axios interceptor causes a refresh loop — verified dead"
ass context --constraint "Do not change the legacy SSO API signature"
ass context --todo      "Req 5: virtualize the home table"
ass context                        # see what is recorded
ass context --done c4              # check off when done
```

With MCP installed, agents call `session_remember` while working (the rule block spells out the discipline).

### Scenario 4: Wrap up so the next agent picks up seamlessly

```bash
ass note --summary "Stuck on captcha API integration; next: server-side validation"
```

Afterwards **any agent** entering this repo will see that brief first via `ass` / `session_status`.

### Scenario 5: Let agents use it themselves (MCP)

```bash
ass install          # write MCP config + global rule block (preview: ass install --dry-run)
```

New chats then get `session_*` tools: they `session_status` for where you left off,
`session_list` candidates for you to pick, `session_handoff` for the brief, `session_last` to port a question.
To remove: `ass uninstall` (MCP + rules only — **does not** touch your session data).

### Scenario 6: One piece of work across several segments, switching agents mid-way

Reqs 1–3 done in Claude, 4–5 want Codex — to most tools those are two **unrelated** sessions.
Bind them into **one task**:

```bash
ass task add payment-refactor --label "reqs 1-3"      # no ref = bind the latest session in this repo
```

After finishing 4–5 in Codex, attach that segment too:

```bash
ass task add payment-refactor --label "reqs 4-5" --note "stuck on refund callback"
```

In any agent’s new chat, say “**continue payment-refactor**” and it loads the full task picture first:

```bash
ass resume payment-refactor
```

```
task  payment-refactor  2 sessions · claude→codex
Starting session topic (claude:8dda036d)
  Refactor payment module from callbacks to Promises
Decisions
  · API errors always use the msg field  c4
  · Retry in interceptor causes refresh loop — ruled out  c7
Segment progress
  1. claude:8dda036d  reqs 1-3 — done
  2. codex:01a0b24d   reqs 4-5 — stuck on refund callback (current)
Todos
  ☐ Refund callback retry idempotency  c3
```

For agents **without MCP** (some Cursor / Trae setups), persist it as a repo handoff note:

```bash
ass resume payment-refactor --save
```

> Task refs are always stored as stable `agent:id-prefix` forms, never `#1`.
> `#N` means “Nth item from the last list” and is rewritten every list — unreliable across processes.

---

## Two layers of context: auto-read + actively recorded

The tool deliberately splits layers because their trustworthiness differs:

| Layer | Source | Trust | Who owns it |
| --- | --- | --- | --- |
| **Active notes** | Agent calls `session_remember` / you run `ass context` | High — judgment from the party that did the work | Pinned at the top of the brief |
| **Auto brief** | Heuristic extract from the raw chat (goal / timeline / files / conclusions / todos) | Medium — may miss or skew | `ass brief` / `session_handoff` |
| **Raw record** | Each agent’s own session files (read-only) | Facts | `ass show` / `ass search` / `session_read` |

Why isn’t “auto-guess decisions from chat” the default? Two heuristics were tried: loose ones
grabbed whole narratives; tight ones grabbed nothing. A **wrong “decision” is more dangerous than none**,
because the next agent will treat it as truth. So it is demoted to `ass brief --guess`
(off by default, labeled “unconfirmed”).

The only reliable channel: **jot a line while working**. The rule block encodes that discipline.

## Supported agents

Four built-in (Claude Code / Codex / Cursor / OpenCode); others via `ass detect` + config.

| Agent | Data source | Format | Images |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` | JSONL | ✅ inline base64 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl`, `~/.codex/archived_sessions/` | JSONL | ✅ inline base64 |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite | ✅ `part.data.url` as data URL |
| Cursor | `<Cursor User>/globalStorage/state.vscdb` | SQLite | ✅ attachment files in `workspaceStorage/<id>/images/` |
| Continue (pluggable) | `~/.continue/sessions/*.json` | JSON | — |
| Gemini CLI (pluggable) | `~/.gemini/tmp/<hash>/chats/*.json` | JSON | — |

Repo ownership: Claude / Codex use `cwd` from the session; OpenCode uses `session.directory`;
Cursor uses `folder` from `workspaceStorage/<id>/workspace.json`;
everything is normalized with `git rev-parse --show-toplevel` — sessions started from a subdirectory
still map to the same repo.

### Agents not built-in: `ass detect` finds them

```bash
ass detect            # scan the machine for agents that look like they have sessions
ass detect --write    # write “pluggable” ones into config (how Continue / Gemini CLI get in)
```

`ass detect` reports three buckets:

- **Built-in**: already readable (Claude Code / Codex / Cursor / OpenCode);
- **Pluggable**: known format — a ready-made `customAgents` snippet makes them work (Continue, Gemini CLI);
- **Needs custom**: installed, but storage layout not mapped yet (Trae / Windsurf / VS Code Copilot Chat / Kiro) —
  it tells you where the DB is and what to look at.

### About IDE agents (Cursor / Kiro / Trae / Windsurf)

These stash sessions in their own SQLite or private stores — **internal, subject to change**.
This tool’s stance:

- Cursor ships a best-effort adapter (including images under `workspaceStorage/<id>/images/`);
  if it cannot read, it explains why instead of pretending;
- Kiro / Trae / Windsurf need **your config** (below): tell it where data lives and how to map fields.

**MCP wiring**: `ass install` only writes **user-level** config. Cursor-like tools often have no
user-global MCP file, so they may not connect by default. Use `ass mcp`:

```bash
ass mcp                    # print config + where to put it (for Trae-style manual paste)
ass mcp --write            # create .cursor/mcp.json / .mcp.json in the **current project**
ass mcp --write --dry-run  # preview only
ass mcp --write --undo     # remove only our entry (leave other servers alone)
```

Project files are JSON; `ass mcp --write` **merges** instead of overwriting — other MCP servers stay.
Those files are usually committed for the team; add them to `.gitignore` if not.

> **Works without MCP too**: have the agent run `ass brief <ref>` for the same handoff brief.
> The rule block already documents this fallback — agents do not have to invent it.

---

## Configuration

Config file: `~/.config/agent-session-sync/config.json` (created on first run).

```jsonc
{
  // Built-in adapter toggles (false = do not read this agent)
  "agents": { "claude": true, "codex": true, "opencode": true, "cursor": true },

  // Whitelist only these agents (takes precedence over agents)
  "only": ["claude", "codex"],

  "defaultLimit": 15,

  // Agents beyond the built-ins
  "customAgents": []
}
```

### Custom agent examples

Three shapes: `jsonl` (one record per line), `json` (one file per session), `sqlite` (one SQL returns all messages).

**Example 1: JSONL-backed agent (e.g. a Kiro-style export)**

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

`map` values are **dot paths** into each record; only `role` values of `user` / `assistant` count as dialogue.

**Example 1.5: one-file-per-session JSON (Continue)**

```jsonc
{
  "customAgents": [
    {
      "id": "continue",
      "label": "Continue",
      "type": "json",
      "path": "~/.continue/sessions",
      "records": "history",              // message array field
      "roleMap": { "gemini": "assistant" }, // map agent role names to user/assistant (optional)
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

Message bodies shaped like `[{type:'text',text:'…'}]` are joined into text automatically.

**Example 2: SQLite-backed agent**

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

Column names from `query` must match `map` values; multiple rows sharing an `id` become one session.

> Tip: to explore an IDE store quickly, use `sqlite3 <db> ".tables"` and
> `sqlite3 -json <db> "select * from <table> limit 1"`, then fill in `map`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ASS_CLAUDE_DIR` / `ASS_CODEX_DIR` / `ASS_CODEX_ARCHIVED` / `ASS_OPENCODE_DB` / `ASS_CURSOR_DB` | Override each agent’s data path |
| `ASS_CONFIG_DIR` / `ASS_DATA_DIR` | Override config / data dirs (cache, attachments, handoffs) |
| `ASS_HOME` | Override home directory detection (tests / sandboxes) |

---

## Command reference

```
ass                      Current repo: last wrap-up note + recent sessions
ass list [options]       List sessions (--all across repos, --agent claude, --limit 20, --json, --no-cache)
ass show <ref>           Inspect a session (--full all, --tail 6 last N)
ass search <query>       Full-text search in recent session bodies (--all, --scan 60)

ass last [ref]           Port the last question as-is (--rounds 3, images on disk)
ass brief [ref]          Handoff brief Markdown (--out file.md; --guess adds guessed content, off by default)
                          --budget tiny|small|standard|large|full  trim to target agent context budget
ass note [ref]           Wrap up: store brief for this repo (--summary "next: do X")
ass notes                List saved handoff notes

ass context              View / record decisions · dead ends · constraints · todos
                         --decision/--dead-end/--constraint/--todo "…" record one
                         --done c4 check off a todo, --remove c4 delete, --all include completed

ass resume [task]        Task overview: original goal / decisions / segment progress / todos
                         --save store as this repo’s handoff note (any agent sees it next)
                         --md Markdown, --out file.md, --json
ass task                 List tasks for this repo (--all across repos, including done)
ass task new <name>      Create a task (--goal "original goal")
ass task add <task> [ref]  Bind a session (--label "reqs 4-5", --note "stuck on refund callback")
                         no ref = the session most recently written in this repo
ass task note <task> [ref] --note "…"     Update a segment’s progress
ass task rm <task> [ref]  Unbind a segment; no ref = delete the whole task (full name / tN only)
ass task done <task>     Mark done (run again = reopen)

ass install              Wire MCP + global rules (--dry-run preview)
ass rules                Print rule text (for Cursor/Trae manual paste)
ass mcp                  Print MCP config + where it belongs; --write create in current project
                         (agents without a user-global MCP file must use project-level)
ass uninstall            Remove MCP + rules (session data untouched)
ass init [dir]           Project-level rule injection (--dry-run / --undo)
ass detect               Auto-detect agents on disk (--write draft config)
ass agents               Which agents found, whether MCP is wired
ass repos                Repos that have history
ass config [--init]      Print / init config file
ass doctor               Self-check
```

### MCP tools

| Tool | Purpose |
| --- | --- |
| `session_status` | New-chat opener: in-progress task + recorded context + last wrap-up + recent sessions |
| `session_list` | Recent sessions for this repo across agents |
| `session_handoff` | Build handoff brief (recommended import path) |
| `session_read` | `summary` / `tail` / `full` raw dialogue |
| `session_last` | Port the previous question (incl. images) into the current agent |
| `session_search` | Cross-session full-text search |
| `session_note` | Save handoff brief (wrap-up) |
| `session_remember` | Record decision / dead end / constraint / todo (**call while working**) |
| `session_task` | Bind current session into a task (`attach` / `list` / `unbind` / `done`) |
| `session_task_resume` | Task overview: goal / decisions / segment progress / todos. **Call first when user says “continue X”** |
| `session_repos` | Repos that have history |
| `session_detect` | Scan disk for possible agents |

Also MCP prompt `sync_previous_session` (in Claude Code: `/mcp__agent-session-sync__sync_previous_session`).

**References** can be written in several ways:

| Form | Meaning |
| --- | --- |
| `#1` | Item 1 from the last `list` (⚠️ position rewrites every list — **unstable across processes**; avoid in scripts) |
| `claude:31c5af10` | `agent:session-id-prefix` |
| `31c5af10` | id prefix (when unique); if several match, the newest |
| `click-through` | Title / latest requirement text contains this |
| `t3` / `payment-refactor` | Task (`ass task` / `ass resume`); destructive ops require full name or `tN` |

---

## Directory layout

```
~/.config/agent-session-sync/config.json     # your config
~/.local/share/agent-session-sync/
├── cache/index.json                          # cross-agent index cache (safe to delete)
├── attachments/<agent>_<id>/img-N.png        # images written during port
├── tasks/index.json                          # task → multi-segment bindings (global, cross-repo)
└── handoffs/
    ├── index.json                            # repo → latest handoff note
    └── <repo>/latest.md + <time>-<title>.md  # one file per ass note / ass resume --save
```

What `ass install` may touch (each file is backed up as `<file>.bak-<timestamp>` first):

| Agent | MCP config | Global rules |
| --- | --- | --- |
| Claude Code | `~/.claude.json` → `mcpServers` | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/config.toml` → `[mcp_servers.agent-session-sync]` | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/opencode.jsonc` → `mcp` | `~/.config/opencode/AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` | Manual: `ass rules` → Cursor Settings → Rules |
| Kiro | `~/.kiro/settings/mcp.json` | Same as Cursor, manual |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | Same as Cursor, manual |
| Trae | Add manually in the IDE (`ass rules` for rule text) | Manual |

> Rule blocks are wrapped in `<!-- >>> agent-session-sync ... >>> -->` markers so
> `ass uninstall` can remove them precisely. Project-level injection (`ass init <dir>`) is **off** by default.

## Development

```bash
npm install
npm run dev        # tsup watch
npm run typecheck
npm test           # build + node --test
```

Three layers — adding an agent is one file:

```
src/adapters/*.ts   per-agent parsers (available / sources / list / read)
        ↓
src/core/*.ts       agent-agnostic: index cache, repo normalize, cross-agent resolve, attachments
        ↓
src/cli.ts          CLI          src/mcp.ts   MCP server
```

## Roadmap

- [x] **M1** Cross-agent index + CLI (list / show / last / agents / repos / doctor)
- [x] **M2** Handoff brief + MCP server + wrap-up notes + `ass install`
- [x] **M3** Image port for all built-in agents (Claude / Codex inline base64, OpenCode data URL, Cursor attachment files)
- [x] **M4** Auto-detect `ass detect` (incl. pluggable drafts) + project rule injection `ass init --dry-run/--undo` + custom agents
- [x] **P0** Decision / dead-end channel: `session_remember` + `ass context` (pinned into handoff briefs)
- [x] **P4** Rule-block rewrite: discipline for “jot while working” and “wrap-up state”
- [x] **P1** Task / workflow: bind multi-agent sessions into one task, `ass resume <task>`
- [ ] **P2** Exit hooks: `ass hook install`, auto-note on wrap-up (not relying on agent diligence)
- [x] **M5a** npm package & publish (0.3.0 shipped)
- [ ] **M5b** CI: typecheck, regression tests, package verification
- [ ] TBD: Trae / Windsurf / VS Code Copilot Chat storage layouts (`ass detect` already finds DB files)

## License

MIT

### Reading tasks, notes, and raw dialogue

- **Work task**: links several sessions for the same piece of work. “Linked 2 sessions · claude→codex” is the agent handoff order of linked sessions, not two todos.
- **Task goal**: an explicitly set goal. If unset, “starting session topic” and its source are shown — that comes from the first linked session’s title, not a synthesized understanding of the whole task.
- **Project notes**: repo-shared records actively saved by you or an agent earlier — not the original prompt, not a fresh summary regenerated at command time. Content and completion state may be stale.
- **Handoff brief**: extracted by rules and trimmed to budget; may omit information.
- **Full dialogue**: user/assistant messages as parsed by adapters — not a lossless dump of raw logs; some tool returns etc. are excluded.

| What you want | Command |
| --- | --- |
| Last original question | `ass last <session-ref>` |
| Full parsed dialogue | `ass show <session-ref> --full` |
| Handoff brief | `ass brief <session-ref>` |
| Project notes overview (long notes truncated) | `ass context` |
| Full project notes | `ass context --details` |
| Full notes including completed todos | `ass context --all --details` |

Notes show recorded time, how they were saved, known source session, and todo check state.
Missing fields on old records show as “not recorded” — the tool does not invent an author.
New CLI notes can use `--session agent:id` for a known source; MCP `session_remember` takes optional `session`.

Save one concern per note: decisions record the choice and why; todos record a concrete action and done criteria; progress and verification use `--note` / `note`.
After confirming completion, use `ass context --done <actual-id>` — the tool does not treat unchecked todos as proven still open.

### Updating note state and linked history

IDs below are examples — replace with real IDs from `ass context`:

```bash
# Progress linked to a todo; does not auto-complete the todo
ass context --note "Verified locally; not yet in production" --related-to c3
# Split a large todo: add concrete items linked to the old one, then cancel the old explicitly
ass context --todo "Verify production download; confirm file contents" --related-to c3
ass context --cancel c3
# Mark done / reopen
ass context --done c4
ass context --reopen c4
# New decision supersedes an old one; both records kept
ass context --decision "Adopt the new approach because the old one lacks concurrency" --supersedes c1
# History including completed, cancelled todos, and superseded decisions
ass context --all --details
```

MCP `session_remember` mirrors these as `related_to`, `supersedes`, `cancel`, `reopen`.
Supersede applies only to decisions; state ops only to todos. No automatic inference of links or completion.
Referenced records cannot be deleted outright (keeps provenance); cancel and supersede retain history.

With no work task, the home screen explains none exists and how to create one.
When the session list exceeds the display cap, the home screen notes “showing latest N sessions (more exist)” —
it does not treat the displayed count as the repo total.

### Separating suggestions, authorization, and actual progress

“Todo still unchecked” does not mean the user approved a change, nor that another AI did not finish it.
Newer versions keep those apart:

- Unconfirmed AI ideas are saved as **suggestion / pending confirmation**, not counted as todos.
- After explicit user authorization, `confirm` stores the evidence and the suggestion becomes a todo.
- Legacy todos, and items saved with `--todo` without confirmation, show **authorization not recorded**; they are not auto-upgraded to authorized.
- A taking-over AI should first read-only check current code and tests, then record **completed / partial / still pending / cannot confirm**, with evidence and limits. Historical sessions are clues only.

```bash
ass context --suggestion "Suggest refactoring the request layer"
# Use the id actually returned above; evidence must be real user authorization — do not invent it
ass context --confirm c7 --evidence "User explicitly asked to proceed with the request-layer plan" --session codex:<actual-id>
ass context --review c7 --result partial --evidence "Interceptor fixed; download path not yet verified"
ass context --review c7 --result completed --evidence "Checked current code; related integration tests pass"
ass context --all --details
```

MCP `session_remember` exposes the same-named params `suggestion`, `confirm`, `review`, `result`, `evidence`.
`result` may be `completed`, `partial`, `pending`, `unknown`. Confirm and review require evidence; cancelled items must be reopened first.
A completed review marks the item done; other results leave it open; all reviews keep history.
Review is not authorization; reopening does not invent authorization.

This is **AI reviews, tool stores evidence and results** — the tool does not auto-analyze the whole repo or prove the caller’s evidence is true.
`--done` remains a compatible manual completion mark, not the same as an evidenced review.
Already-installed agents need updated sync rules and an MCP reload to pick up the new guidance and params.

### 0.3.1: Project isolation & reliable writes

- Project notes and handoff dirs use “repo name + hash of normalized absolute path.” Git subdirs and symlinks collapse to the same repo; two same-named repos at different paths stay separate. Moving a repo changes storage identity — old records are not claimed by name alone.
- Legacy `<repo-name>/context.json` is read only when its `repo` field matches the current repo; the first successful write goes to the new directory and keeps the old file. Legacy handoff indexes are likewise checked against the recorded full path. If history was already mixed, the tool cannot reliably auto-split every record.
- CLI `ass context` and MCP `session_remember` “add + status update” validate in one transaction; failure saves no partial notes. On success, `ass context ... --json` writes one JSON object to stdout; errors go to stderr with a non-zero exit code.
- Notes, task edits, and handoff index updates use a cross-process lock; data is replaced via a same-directory temp file so readers never see half-written JSON. Wrap-up files use unique numbers so same-second saves do not overwrite.
- Unparseable persisted data errors clearly instead of being treated as empty and overwritten. Crashes may leave `.lock` dirs; the timeout message includes the path. Check `owner.json` inside and confirm the writer has exited before removing a stale lock. Do not delete a lock still in use.
- After upgrading, restart every MCP client connected to this tool so old and new processes do not write together. Older versions do not understand the new dirs and locks and must not share writes with 0.3.1. This release still has no auto wrap-up hook or CI — those remain on the roadmap.

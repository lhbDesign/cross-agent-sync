#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { loadConfig, type Config } from './config'
import { buildBrief, buildSummary } from './core/brief'
import { parseLevel } from './core/budget'
import { armGuard } from './core/roguard'
import { buildAdapters } from './adapters/registry'
import { latestNote, listNotes, saveNote } from './core/handoff'
import { addContext, contextMarkdown, readContext, updateContext } from './core/context'
import { formatSearchResult, searchSessions } from './core/search'
import { findSession, listSessions, readSession } from './core/store'
import {
  currentSession,
  findTask,
  taskAttach,
  taskDetach,
  taskLine,
  taskList,
  taskResumeMarkdown,
  taskSetStatus,
  taskView,
} from './core/task'
import { saveImages } from './core/attach'
import { detectSources } from './detect'
import { maybeReexec } from './bootstrap'
import { fmtTime, gitRoot, parseSince, pkgVersion, plain, truncate } from './util'
import type { Turn } from './types'
import type { ContextKind } from './core/context'

// 从 package.json 读，别硬编码 —— 硬编码的那份必然会和发布版本漂开
const VERSION = pkgVersion()
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

// node:sqlite 的 ExperimentalWarning 会污染 stderr，先关掉
const origEmitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (/SQLite|experimental/i.test(String(text))) return
  return (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

const INSTRUCTIONS = `agent-session-sync gives you access to the user's conversation history in OTHER coding
agents (Claude Code, Codex, Cursor, OpenCode, and any agent the user configured) for the same repository.

Use it when the user switches agents/models, starts a fresh chat, or says things like
"继续 / 接着上次 / 同步历史 / 换个模型 / 之前那个会话 / handoff".

Recommended flow:
1. call session_status first — it shows any in-progress TASK for this repo, the context recorded earlier,
   and recent sessions;
1.5 if session_status lists an in-progress task — or the user says "继续 X / 接着 X 任务" — call
   session_task_resume FIRST. Restate "目标 / 已完成 / 待办 / 下一步", wait for confirmation, then work.
   Do NOT ask the user to re-explain work that the task already describes;
2. if the user needs to pick a session, call session_list and show them the numbered candidates
   (agent · time · title · last request), then ask which one to import — do NOT pick for them;
3. call session_handoff to get the compact brief, then restate "目标 / 已完成 / 待办 / 下一步" and wait for confirmation;
4. to port a single question (with its images) into the current agent, call session_last.

During work: call session_remember the moment a decision is made, a path is proven wrong, or a constraint
is found — do not save it up until the end.

Tasks: a TASK binds several sessions across agents into one piece of work ("需求 1-3 用 claude 做完，
4-5 换 codex"). When the user starts a new piece of work, or moves to another agent to continue the same
work, call session_task to bind the current session. Do NOT invent task boundaries on the user's behalf —
list existing tasks first and let the user name the new one.

When wrapping up (user says "记一下 / 收尾 / 保存进度 / 下次继续 / wrap up"), call session_note.

Constraints: with respect to OTHER agents' session data this is strictly READ-ONLY — never modify another
agent's session files. session_remember and session_task write only to this tool's own store
(~/.local/share/agent-session-sync). Prefer the brief over the full transcript; only use
session_read mode=full when the user explicitly asks for the whole history.`

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call: (args: Record<string, any>) => string
}

const repoOf = (args: Record<string, any>): string =>
  typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : process.cwd()

function fmtList(sessions: ReturnType<typeof listSessions>['sessions']): string {
  if (!sessions.length) return '没有找到会话。'
  const lines = sessions.map((s, i) => {
    const when = fmtTime(s.updatedAt || s.startedAt)
    return (
      `${i + 1}. [${s.agentLabel}] ${s.title}\n` +
      `   key: \`${s.key}\` · ${when} · ${s.turns} 轮用户输入${s.model ? ` · ${s.model}` : ''}` +
      (s.repo ? `\n   仓库: \`${s.repo}\`` : '') +
      (s.preview ? `\n   ${plain(s.preview, 140)}` : '')
    )
  })
  return `${sessions.length} 个会话（按最近更新排序）：\n\n${lines.join('\n\n')}\n\n提示：把编号/标题给用户看，让用户选择要同步哪一个，然后调用 session_handoff。`
}

function turnsToMarkdown(turns: Turn[]): string {
  return turns
    .filter((t) => t.role !== 'tool')
    .map((t) => `## ${t.role === 'user' ? '用户' : '助手'}\n${t.text || '*(仅图片)*'}`)
    .join('\n\n')
}

const TOOLS: ToolDef[] = [
  {
    name: 'session_status',
    description:
      'Show the in-progress tasks, the previously recorded context, the latest saved handoff note, and the most ' +
      'recent sessions for this repository. Call this first at the start of a new conversation when the user has ' +
      'not yet stated a task.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository path (defaults to the current working directory).' },
        limit: { type: 'number', description: 'How many recent sessions to list (default 8).' },
      },
    },
    call(args) {
      const repo = repoOf(args)
      const note = latestNote(repo)
      const { sessions, errors } = listSessions({ repo, limit: Number(args.limit) || 8, includeAll: false }, CFG)
      const out: string[] = []
      out.push(`仓库 \`${repo}\``)
      out.push('')
      const ctx = contextMarkdown(repo)
      if (ctx) {
        out.push(ctx)
        out.push('')
      }
      // 用 git root 找任务：repo 可能是仓库的子目录，而任务记的是根目录
      const tasks = taskList({ repo: gitRoot(repo) ?? repo })
      if (tasks.length) {
        out.push('## 本仓库的任务')
        out.push('')
        for (const t of tasks) out.push(`- ${taskLine(t)}`)
        out.push('')
        out.push(`任务把跨 agent 的多段会话绑成一件事。**先取上下文再动手**：\`session_task_resume(task: "${tasks[0]!.name}")\``)
        out.push('')
      }
      if (!tasks.length) {
        out.push('## 工作任务 · 尚未建立')
        out.push('会话不会自动归为任务。用户命名并选择相关会话后，可用 session_task 关联；只读取历史无需建任务。')
        out.push('')
      }
      if (note) {
        out.push(`## 上次收尾留下的交接记录（${fmtTime(note.entry.at)}，来自 ${note.entry.key}）`)
        out.push('')
        out.push(note.content.replace(/^<!--[\s\S]*?-->\n/, ''))
        out.push('')
      } else {
        out.push('_这个仓库还没有保存过交接记录。_')
        out.push('')
      }
      out.push('## 最近会话')
      out.push('')
      out.push(fmtList(sessions))
      if (errors.length) out.push(`\n⚠️ ${errors.join('\n⚠️ ')}`)
      return out.join('\n')
    },
  },
  {
    name: 'session_list',
    description:
      'List recent coding-agent sessions (Claude Code, Codex, Cursor, OpenCode, …) for a repository, across all agents. ' +
      'Call this when the user starts a new conversation and wants to continue earlier work, or to find which agent handled what. ' +
      'Returns numbered candidates; present the top few to the user and ask which one to import.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Absolute path of the repository (defaults to the current working directory).' },
        agent: { type: 'string', description: 'Only this agent id, e.g. claude / codex / cursor / opencode.' },
        limit: { type: 'number', description: 'Max sessions to return (default 10).' },
        since: { type: 'string', description: 'Only sessions updated after this: ISO date or relative like "7d".' },
        all_repos: { type: 'boolean', description: 'Ignore the repo filter and list across every repository.' },
      },
    },
    call(args) {
      const limit = Number(args.limit) || 10
      const explicit = typeof args.repo === 'string' && args.repo.trim()
      const query = (repo: string | null): ReturnType<typeof listSessions> =>
        listSessions(
          { repo, includeAll: args.all_repos === true, agent: args.agent || undefined, since: parseSince(args.since) ?? undefined, limit, minTurns: 1 },
          CFG,
        )
      let { sessions, errors } = query(args.all_repos ? null : repoOf(args))
      let note = ''
      if (!sessions.length && !explicit && !args.all_repos) {
        const all = query(null)
        if (all.sessions.length) {
          sessions = all.sessions
          errors = all.errors
          note =
            `⚠️ 当前工作目录 \`${process.cwd()}\` 里没有找到会话，已改为列出**全部仓库**的最近会话。` +
            ' 用户的项目不在当前目录时，请把 `repo` 参数传成真正的仓库绝对路径。'
        }
      }
      let out = note ? `${note}\n\n` : ''
      out += fmtList(sessions)
      if (errors.length) out += `\n\n⚠️ ${errors.join('\n⚠️ ')}`
      return out
    },
  },
  {
    name: 'session_handoff',
    description:
      'Build a compact Markdown handoff brief from a previous session in another agent: original goal, requirement timeline, ' +
      'files touched, key conclusions, open questions and the final exchange. ' +
      'This is the recommended way to import context. Read it, then restate the current state and next step to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Session reference: full key like "claude:31c5af10-…", an id/prefix, a title fragment, or "#3" from the last list.',
        },
        repo: { type: 'string', description: 'Repository to search when the reference is not unique.' },
        budget: {
          type: 'string',
          enum: ['tiny', 'small', 'standard', 'large', 'full'],
          description:
            'How much context to spend (default standard ≈ 8000 tokens). Lower it when you are already deep into a ' +
            'conversation; raise it to "full" when you have room and need the whole timeline.',
        },
      },
      required: ['session'],
    },
    call(args) {
      const found = findSession(String(args.session), CFG)
      if (!found) return `没找到会话：${args.session}。先用 session_list 列出候选。`
      const turns = readSession(found)
      const level = parseLevel(args.budget)
      return buildBrief(found.meta, turns, level ? { level } : {})
    },
  },
  {
    name: 'session_read',
    description:
      'Read the raw message history of one session. mode=summary (default) gives a one-screen overview, ' +
      'mode=tail gives the last N messages, mode=full returns the whole conversation verbatim ' +
      '(can be very large — only use when the user asks for the full history).',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session reference (see session_handoff).' },
        mode: { type: 'string', enum: ['summary', 'tail', 'full'], description: 'How much to return (default summary).' },
        messages: { type: 'number', description: 'For mode=tail: how many trailing messages (default 6).' },
      },
      required: ['session'],
    },
    call(args) {
      const found = findSession(String(args.session), CFG)
      if (!found) return `没找到会话：${args.session}。先用 session_list 列出候选。`
      const mode = String(args.mode || 'summary')
      if (mode === 'summary') return buildSummary(found.meta, readSession(found))
      const n = Number(args.messages) || 6
      const turns = mode === 'tail' ? readSession(found, { tail: n }) : readSession(found)
      const header = mode === 'full' ? `${found.meta.key}（完整对话：已解析的用户和助手消息；不等同于原始日志的无损副本）` : `${found.meta.key}（最后 ${turns.length} 条）`
      return `${header}\n\n${turnsToMarkdown(turns)}`
    },
  },
  {
    name: 'session_last',
    description:
      'Port the last question(s) from another agent session into THIS agent, verbatim, including images. ' +
      'Images embedded in the transcript are written to disk as real files and their paths are returned. ' +
      'Use this when the user says "把刚才在 X 问的问题拿到这里继续".',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session reference (default: the most recent session in this repo).' },
        rounds: { type: 'number', description: 'How many trailing user questions to bring over (default 1).' },
        repo: { type: 'string', description: 'Repository (defaults to the current working directory).' },
      },
    },
    call(args) {
      let ref = args.session ? String(args.session) : ''
      if (!ref) {
        const { sessions } = listSessions({ repo: repoOf(args), limit: 1, includeAll: false }, CFG)
        if (!sessions.length) return '这个仓库里没有找到会话。'
        ref = sessions[0]!.key
      }
      const found = findSession(ref, CFG)
      if (!found) return `没找到会话：${ref}`
      const rounds = Math.max(1, Number(args.rounds) || 1)
      const users = readSession(found).filter((t) => t.role === 'user')
      const picked = users.slice(-rounds)
      if (!picked.length) return '这个会话里没有找到用户提问。'

      const imgPaths: string[] = []
      for (const t of picked) {
        if (!t.images?.length) continue
        imgPaths.push(...saveImages(t.images, found.meta.key, undefined, imgPaths.length + 1))
      }
      const out: string[] = []
      out.push(`来源：**${found.meta.agentLabel}** \`${found.meta.key}\` (${fmtTime(found.meta.updatedAt)})`)
      if (found.meta.repo) out.push(`仓库：\`${found.meta.repo}\``)
      if (imgPaths.length) {
        out.push(`图片 ${imgPaths.length} 张已落盘（用 Read/看图工具直接打开这些文件）：`)
        for (const p of imgPaths) out.push(`- \`${p}\``)
      }
      out.push('')
      picked.forEach((t, i) => {
        if (picked.length > 1) out.push(`**【第 ${i + 1} 问】**`)
        out.push('')
        out.push(t.text || `*(这一问只有 ${t.images?.length ?? 0} 张图片，见上面的路径)*`)
        out.push('')
      })
      return out.join('\n')
    },
  },
  {
    name: 'session_search',
    description:
      'Full-text search across the message history of recent sessions (all agents) for a keyword, error message, ' +
      'file name or decision. Useful when the user remembers "we discussed this somewhere" but not which agent or when.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive).' },
        repo: { type: 'string', description: 'Restrict to one repository.' },
        all_repos: { type: 'boolean', description: 'Search every repository.' },
        limit: { type: 'number', description: 'Max matching sessions (default 8).' },
        scan: { type: 'number', description: 'How many recent sessions to scan (default 60).' },
      },
      required: ['query'],
    },
    call(args) {
      const r = searchSessions(
        String(args.query || ''),
        { repo: args.all_repos ? null : repoOf(args), allRepos: args.all_repos === true, limit: Number(args.limit) || 8, scan: Number(args.scan) || 60 },
        CFG,
      )
      return formatSearchResult(r)
    },
  },
  {
    name: 'session_note',
    description:
      'Save a handoff brief for the current repository so the NEXT session in ANY agent can pick up automatically. ' +
      'Call this when wrapping up work, or when the user says "记一下 / 收尾 / handoff / wrap up / 下次继续".',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session to snapshot; defaults to the most recent session in this repo.' },
        repo: { type: 'string', description: 'Repository (defaults to the current working directory).' },
        summary: { type: 'string', description: 'Optional free-form note to prepend (e.g. "当前卡在 X，下一步做 Y").' },
      },
    },
    call(args) {
      const repo = repoOf(args)
      let ref = args.session ? String(args.session) : ''
      let sessions = listSessions({ repo, limit: 5, includeAll: false }, CFG).sessions
      if (!ref) {
        if (!sessions.length) sessions = listSessions({ limit: 1, includeAll: true }, CFG).sessions
        if (!sessions.length) return '没有找到任何会话，无法保存交接记录。'
        ref = sessions[0]!.key
      }
      const found = findSession(ref, CFG)
      if (!found) return `没找到会话：${ref}`
      const turns = readSession(found)
      const saved = saveNote(found.meta, turns, args.summary ? String(args.summary) : undefined, repo)
      return (
        `已保存交接记录：\n- 仓库：\`${found.meta.repo || repo}\`\n- 来源会话：\`${found.meta.key}\`\n` +
        `- 文件：\`${saved.file}\`\n- 下次一进这个仓库就能看到（latest.md / session_status）\n\n` +
        `摘要预览：\n\n${truncate(saved.md, 1200)}`
      )
    },
  },
  {
    name: 'session_remember',
    description:
      'Record a durable, structured note about THIS repository so that every agent — including future sessions of ' +
      'yourself — sees it. Use it DURING work (not only at the end): right after you make an architectural decision, ' +
      'or discover an approach that does NOT work (so nobody repeats it). These notes are shown at the TOP of every ' +
      'handoff. Record one clear item at a time. Use decision for a choice and its reason, todo for one unfinished action with completion criteria, and note for progress and validation results. Notes may become outdated; never infer completion without evidence. On handoff, read current code and test evidence before reviewing old todos; use completed/partial/pending/unknown with evidence and known session. Review records a caller assessment, not an automatic code scan. Suggestion and unknown authorization are not permission to edit code.',
    inputSchema: {
      type: 'object',
      properties: {
        suggestion: { type: 'string', description: 'An unapproved suggestion; never treat as permission to modify code.' },
        confirm: { type: 'string', description: 'Suggestion/todo ID explicitly authorized by the user. Requires evidence of user authorization.' },
        review: { type: 'string', description: 'Todo ID checked against current code/tests. Requires result and evidence; not inferred from old chat alone.' },
        result: { type: 'string', enum: ['completed', 'partial', 'pending', 'unknown'] },
        evidence: { type: 'string', description: 'User authorization quote for confirm, or current code/test findings and limitations for review.' },
        related_to: { type: 'string', description: 'Existing note ID to link this new progress or todo to; does not change its status.' },
        supersedes: { type: 'string', description: 'Existing active decision ID replaced by this new decision; preserves both records.' },
        cancel: { type: 'string', description: 'Cancel a todo by ID, preserving its history.' },
        reopen: { type: 'string', description: 'Reopen a completed or cancelled todo by ID.' },
        session: { type: 'string', description: 'Known source session reference (agent:id). Omit when unknown; do not guess.' },
        decision: { type: 'string', description: 'A decision and why, e.g. "token 改用 refresh token 轮换，因为旧接口不支持并发刷新"' },
        dead_end: { type: 'string', description: 'An approach that does NOT work / was reverted, so the next agent does not retry it' },
        constraint: { type: 'string', description: 'A rule that must not be broken, e.g. "不要改旧版 SSO 的接口"' },
        todo: { type: 'string', description: 'An outstanding action. Authorization remains unknown until confirm with user evidence; use suggestion for unapproved AI ideas.' },
        note: { type: 'string', description: 'Anything else worth persisting' },
        done: { type: 'string', description: 'Mark a recorded todo as done, by its id (e.g. "c4")' },
        remove: { type: 'string', description: 'Delete an entry by its id' },
        repo: { type: 'string', description: 'Repository (defaults to the current working directory)' },
      },
    },
    call(args) {
      const repo = repoOf(args)
      const kinds: [string, ContextKind][] = [
        ['decision', 'decision'],
        ['dead_end', 'dead-end'],
        ['constraint', 'constraint'],
        ['suggestion', 'suggestion'],
        ['todo', 'todo'],
        ['note', 'note'],
      ]
      const items = kinds
        .map(([flag, kind]) => ({ kind, text: String(args[flag] ?? '').trim(), source: 'agent', relatedTo: typeof args.related_to === 'string' ? args.related_to : undefined, supersedes: typeof args.supersedes === 'string' ? args.supersedes : undefined, session: typeof args.session === 'string' ? args.session : undefined }))
        .filter((x) => x.text)
      if ((args.related_to || args.supersedes) && !items.length) throw new Error('关联或替代需要同时提供新笔记内容')
      if (['done', 'cancel', 'reopen', 'remove', 'confirm', 'review'].filter((k) => args[k]).length > 1) throw new Error('每次只能选择一种状态或删除操作')
      if (items.length) addContext(repo, items)
      let result = ''
      for (const action of ['confirm', 'review'] as const) {
        if (typeof args[action] !== 'string') continue
        if (action === 'review' && typeof args.result !== 'string') throw new Error('核对需要 result')
        const e = updateContext(repo, args[action], { ...(action === 'confirm' ? { confirm: true } : { review: String(args.result) }), evidence: typeof args.evidence === 'string' ? args.evidence : undefined, session: typeof args.session === 'string' ? args.session : undefined })
        if (!e) throw new Error(`没有 id 为 ${args[action]} 的条目`)
        result = `${action === 'confirm' ? '已确认授权' : '已保存核对结果'} ${e.id}。\n`
      }
      for (const action of ['done', 'cancel', 'reopen', 'remove'] as const) {
        if (typeof args[action] !== 'string' || !args[action].trim()) continue
        const id = args[action].trim()
        if (!updateContext(repo, id, { [action]: true })) throw new Error(`没有 id 为 ${id} 的条目`)
        result = `${({ done: '已标记完成', cancel: '已取消', reopen: '已重新打开', remove: '已删除' })[action]} ${id}。\n`
      }
      const md = contextMarkdown(repo)
      if (!md) return `${result}没有记录任何内容。请至少给一个 decision / dead_end / constraint / todo。\n（仓库：${repo}）`
      return `${result}已记录。这个仓库当前的项目笔记：\n\n${md}`
    },
  },
  {
    name: 'session_repos',
    description: 'List which repositories have session history, how many sessions, and which agents were used.',
    inputSchema: {
      type: 'object',
      properties: {
        notes_only: { type: 'boolean', description: 'Only list repositories that have a saved handoff note.' },
      },
    },
    call(args) {
      if (args.notes_only) {
        const notes = listNotes()
        if (!notes.length) return '还没有保存过任何交接记录。'
        return notes.map((n) => `- \`${n.entry.repo}\` · 最近 ${fmtTime(n.entry.at)} · ${n.entry.key}`).join('\n')
      }
      const { sessions } = listSessions({ includeAll: true }, CFG)
      const by = new Map<string, { n: number; agents: Set<string>; last: number }>()
      for (const s of sessions) {
        const key = s.repo || s.cwd || '(未知)'
        const e = by.get(key) ?? { n: 0, agents: new Set<string>(), last: 0 }
        e.n++
        e.agents.add(s.agent)
        e.last = Math.max(e.last, s.updatedAt || s.startedAt || 0)
        by.set(key, e)
      }
      const rows = [...by].sort((a, b) => b[1].last - a[1].last)
      return `${rows.length} 个仓库：\n\n${rows.map(([r, v]) => `- \`${r}\` · ${v.n} 个会话 · ${[...v.agents].join('/')} · 最近 ${fmtTime(v.last)}`).join('\n')}`
    },
  },
]

TOOLS.push(
  {
    name: 'session_task',
    description:
      'Bind sessions into a named TASK — one unit of work that spans several agents and several days ' +
      '("需求 1-3 用 claude 做完，4-5 换 codex"). Call it when the user starts a new piece of work, when they move ' +
      'to another agent to continue the same work, or when they say "归到 X 任务 / 记到任务里 / 接着做 X". ' +
      'With no task name it lists existing tasks; creates the task if the name is new. ' +
      "Writes only to this tool's own store — never to any agent's session files.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task name (e.g. "支付重构") or id ("t3"). Omit to list tasks.' },
        action: { type: 'string', enum: ['attach', 'list', 'unbind', 'done'], description: 'Default: attach.' },
        session: {
          type: 'string',
          description: 'Session to bind; defaults to the session currently being written in this repo.',
        },
        label: { type: 'string', description: 'What this segment covers, e.g. "需求 4-5".' },
        note: { type: 'string', description: 'Progress of this segment, e.g. "卡在退款回调" or "已完成".' },
        goal: { type: 'string', description: "The original goal in the user's own words (used when creating the task)." },
        repo: { type: 'string', description: 'Repository (defaults to the current working directory).' },
      },
    },
    call(args) {
      const repo = repoOf(args)
      const root = gitRoot(repo) ?? repo
      const action = typeof args.action === 'string' ? args.action : 'attach'
      const ref = typeof args.task === 'string' ? args.task.trim() : ''
      const sessArg = typeof args.session === 'string' ? args.session.trim() : ''

      // 没给任务名 = 列任务。比直接报错有用，也是 agent 建任务前的必经一步
      if (action === 'list' || !ref) {
        const tasks = taskList({ repo: root })
        if (!tasks.length) {
          return '这个仓库还没有任务。传 `task` 建一个——**名字由用户定**，不要替他划分任务边界。'
        }
        return `本仓库的任务：\n\n${tasks.map((t) => `- ${taskLine(t)}`).join('\n')}\n\n取上下文：\`session_task_resume(task: "...")\``
      }

      if (action === 'unbind') {
        const t = findTask(ref)
        if (!t) return `没找到任务：${ref}`
        const r = taskDetach(t.id, sessArg || null)
        if (!r) return `任务「${t.name}」里没有这一段：${sessArg || '(整段)'}`
        return r.removed
          ? `已从任务 **${r.task.name}** 解绑 \`${r.removed.key}\`，还剩 ${r.task.sessions.length} 段。`
          : `已删除任务 **${r.task.name}**。`
      }

      if (action === 'done') {
        const t = findTask(ref)
        if (!t) return `没找到任务：${ref}`
        const r = taskSetStatus(t.id, 'done')
        return r ? `已把任务 **${r.name}** 标记为完成。` : `操作失败：${ref}`
      }

      let found = sessArg ? findSession(sessArg, CFG) : null
      let stale = false
      if (!found) {
        if (sessArg) return `没找到会话：${sessArg}`
        const cur = currentSession(root, CFG)
        if (!cur) return '这个仓库还没有会话记录，绑不了。先聊一句再试，或显式传 session。'
        found = cur.found
        stale = cur.stale
      }

      const r = taskAttach({
        task: ref,
        meta: found.meta,
        label: typeof args.label === 'string' ? args.label : undefined,
        note: typeof args.note === 'string' ? args.note : undefined,
        goal: typeof args.goal === 'string' ? args.goal : undefined,
        repo: root,
      })
      const segs = r.added ? `第 ${r.index + 1} 段` : `已在任务里（第 ${r.index + 1} 段），已更新说明`
      return (
        `${r.created ? '已新建任务，' : ''}已绑定 **${found.meta.agentLabel}** \`${found.meta.key}\` 到任务 ` +
        `\`${r.task.id}\` **${r.task.name}**（${segs}）` +
        (stale ? '\n\n注意：这是本仓库**最近**的会话，未必是当前这个；如果不对，请显式传 session。' : '') +
        `\n\n取完整上下文：\`session_task_resume(task: "${r.task.name}")\``
      )
    },
  },
  {
    name: 'session_task_resume',
    description:
      'Get the consolidated context of a TASK: the original goal, the decisions and dead-ends recorded along the way, ' +
      'what each constituent session accomplished, and the open todos. Call this FIRST when the user says ' +
      '"继续 X / 接着 X 任务 / 上次那个支付重构", or right after session_status lists an in-progress task. ' +
      'Read it, restate 目标 / 已完成 / 待办 / 下一步, wait for confirmation, then start working.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task name or id. Omit to use the single in-progress task of this repo.' },
        repo: { type: 'string', description: 'Repository (defaults to the current working directory).' },
      },
    },
    call(args) {
      const root = gitRoot(repoOf(args)) ?? repoOf(args)
      let ref = typeof args.task === 'string' ? args.task.trim() : ''
      if (!ref) {
        const mine = taskList({ repo: root })
        if (!mine.length) {
          return '这个仓库没有进行中的任务。用 `session_task` 建一个，或 `session_task` 不带参数看全部。'
        }
        if (mine.length > 1) {
          return `这个仓库有 ${mine.length} 个进行中的任务，请让用户指定一个：\n\n${mine.map((t) => `- ${taskLine(t)}`).join('\n')}`
        }
        ref = mine[0]!.id
      }
      const v = taskView(ref, CFG)
      if (!v) return `没找到任务：${ref}。用 \`session_task\` 列出或新建。`
      return taskResumeMarkdown(v)
    },
  },
)

TOOLS.push({
  name: 'session_detect',
  description:
    'Scan this machine for coding agents that have local session history — including ones the tool does not support ' +
    'out of the box — and return ready-to-paste custom-agent config drafts. Use when the user asks which agents can be synced.',
  inputSchema: { type: 'object', properties: {} },
  call() {
    const list = detectSources(CFG)
    const lines = list.map(
      (d) => `- ${d.available ? '●' : '○'} **${d.label}** (\`${d.id}\`) · ${d.sessions ? `${d.sessions} 个会话` : '无数据'}${d.detail ? `\n  ${d.detail}` : ''}\n  \`${d.path}\``,
    )
    const cands = list.filter((d) => d.kind === 'candidate' && d.config)
    let out = `${list.length} 个本机 agent：\n\n${lines.join('\n')}`
    if (cands.length) {
      out += `\n\n可直接接入（把 customAgents 写进 ~/.config/agent-session-sync/config.json）：\n\n`
      out += '```json\n' + JSON.stringify({ customAgents: cands.map((d) => d.config) }, null, 2) + '\n```'
    }
    return out
  },
})

const PROMPTS = [
  {
    name: 'sync_previous_session',
    description: '从其它 agent（Claude Code / Codex / Cursor / OpenCode …）同步一个历史会话，继续之前的工作。',
    arguments: [{ name: 'repo', description: '仓库路径（可留空，默认当前目录）', required: false }],
  },
]

// 需要 SQLite 而又缺 --experimental-sqlite 时，先带 flag 重跑一次自己
maybeReexec()

let CFG: Config = loadConfig()

/**
 * MCP server 长驻在 agent 进程旁边，是**最需要**把"只读"钉死的地方：
 * 它会被 agent 按自己的判断自动调用，没有人在旁边看一眼。
 * 所以启动即武装受保护区，之后任何写路径（含未来新增的工具）都自动受约束。
 */
function armGuardNow(): void {
  try {
    armGuard(buildAdapters(CFG, { includeUnavailable: true }))
  } catch {
    /* 边界拿不到不该让 server 起不来 */
  }
}
armGuardNow()

// ---------------- JSON-RPC over stdio ----------------
function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}
const ok = (id: unknown, result: unknown): void => send({ jsonrpc: '2.0', id, result })
const fail = (id: unknown, code: number, message: string): void => send({ jsonrpc: '2.0', id, error: { code, message } })
const text = (id: unknown, s: string): void => ok(id, { content: [{ type: 'text', text: s }] })

function handle(req: Record<string, any>): void {
  const { id, method, params } = req
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      const protocolVersion = PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0]
      ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, prompts: {} },
        serverInfo: { name: 'agent-session-sync', version: VERSION },
        instructions: INSTRUCTIONS,
      })
      return
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      ok(id, {})
      return
    case 'tools/list':
      ok(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      })
      return
    case 'tools/call': {
      const name = String(params?.name || '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return fail(id, -32602, `未知工具：${name}`)
      try {
        CFG = loadConfig() // 每次调用重读配置，改完配置不用重启
        armGuardNow() // 配置可能改了自定义 agent 的数据源，保护区跟着重算
        const out = tool.call((params?.arguments || {}) as Record<string, any>)
        text(id, out)
      } catch (e) {
        ok(id, { content: [{ type: 'text', text: `执行 ${name} 出错：${e instanceof Error ? e.message : String(e)}` }], isError: true })
      }
      return
    }
    case 'prompts/list':
      ok(id, { prompts: PROMPTS })
      return
    case 'prompts/get': {
      const repo = String(params?.arguments?.repo || process.cwd())
      ok(id, {
        description: '同步一个其它 agent 的历史会话',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `我在 ${repo} 这个仓库里之前用别的 agent 干过活。\n` +
                `请先调用 session_status（repo 传上面这个路径）：\n` +
                `1. 如果有上次收尾留下的交接记录，用几句话复述「目标 / 已完成 / 待办 / 下一步」，等我确认；\n` +
                `2. 否则调用 session_list，把最近的会话按「序号 · agent · 时间 · 标题 · 最近一句需求」列出来（最多 5 条）给我选；\n` +
                `3. 我选定后调用 session_handoff 取交接摘要，复述之后再开始动手。`,
            },
          },
        ],
      })
      return
    }
    case 'resources/list':
      ok(id, { resources: [] })
      return
    case 'completion/complete':
      ok(id, { completion: { values: [], total: 0, hasMore: false } })
      return
    default:
      if (id !== undefined) fail(id, -32601, `未实现的方法：${method}`)
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let chain: Promise<void> = Promise.resolve()

rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let req: Record<string, any>
  try {
    req = JSON.parse(t)
  } catch {
    return
  }
  // 串行处理，保证响应顺序与请求一致（也避免并发读大文件）
  chain = chain.then(() => {
    try {
      handle(req)
    } catch (e) {
      if (req.id !== undefined) fail(req.id, -32603, e instanceof Error ? e.message : String(e))
    }
  })
})

rl.on('close', () => {
  // 客户端关掉 stdin：把队列里没跑完的请求处理完再退出。
  //
  // ⚠️ 这里**不能**用 process.exit()：stdout 接管道时是异步写，而 process.exit 不等它 flush，
  // 会把还没写出去的响应直接截断（tools/list 这种大响应会断在半截 JSON 上，客户端解析失败）。
  // 只设 exitCode，让 Node 把 stdout 排空后自然退出。
  void chain.finally(() => {
    process.exitCode = 0
  })
})

// 握手之后再预热索引：initialize 必须马上回，不能被扫盘卡住
setTimeout(() => {
  try {
    if (process.env.ASS_NO_PREWARM !== '1') listSessions({ limit: 1, includeAll: true }, CFG)
  } catch {
    /* ignore */
  }
}, 1500).unref?.()

// 让 tsc 不要把这里当未使用
void fs
void path

#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { loadConfig, type Config } from './config'
import { buildBrief, buildSummary } from './core/brief'
import { latestNote, listNotes, saveNote } from './core/handoff'
import { formatSearchResult, searchSessions } from './core/search'
import { findSession, listSessions, readSession } from './core/store'
import { saveImages } from './core/attach'
import { detectSources } from './detect'
import { fmtTime, parseSince, plain, truncate } from './util'
import type { Turn } from './types'

const VERSION = '0.1.0'
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

// node:sqlite 的 ExperimentalWarning 会污染 stderr，先关掉
const origEmitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (/SQLite|experimental/i.test(String(text))) return
  return (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

const INSTRUCTIONS = `agent-session-sync gives you read-only access to the user's conversation history in OTHER coding
agents (Claude Code, Codex, Cursor, OpenCode, and any agent the user configured) for the same repository.

Use it when the user switches agents/models, starts a fresh chat, or says things like
"继续 / 接着上次 / 同步历史 / 换个模型 / 之前那个会话 / handoff".

Recommended flow:
1. call session_status first — it shows any handoff note saved earlier plus recent sessions;
2. if the user needs to pick, call session_list and show them the numbered candidates
   (agent · time · title · last request), then ask which one to import — do NOT pick for them;
3. call session_handoff to get the compact brief, then restate "目标 / 已完成 / 待办 / 下一步" and wait for confirmation;
4. to port a single question (with its images) into the current agent, call session_last.

When wrapping up (user says "记一下 / 收尾 / 保存进度 / 下次继续 / wrap up"), call session_note.

Constraints: everything is READ-ONLY — never modify another agent's session files. Prefer the brief over
the full transcript; only use session_read mode=full when the user explicitly asks for the whole history.`

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
      'Show the latest saved handoff note for this repository plus the most recent sessions across all agents. ' +
      'Call this first at the start of a new conversation when the user has not yet stated a task.',
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
      },
      required: ['session'],
    },
    call(args) {
      const found = findSession(String(args.session), CFG)
      if (!found) return `没找到会话：${args.session}。先用 session_list 列出候选。`
      const turns = readSession(found)
      return buildBrief(found.meta, turns)
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
      const header = mode === 'full' ? `${found.meta.key}（全文）` : `${found.meta.key}（最后 ${turns.length} 条）`
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

let CFG: Config = loadConfig()

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
  // 客户端关掉 stdin：把队列里没跑完的请求处理完再退出（否则响应会被截断）
  void chain.finally(() => process.exit(0))
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

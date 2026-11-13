import path from 'node:path'
import type { Adapter, AdapterCtx, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, exists, gitRoot, plain, projectName } from '../util'
import { lit, openSqlite } from '../sqlite'

/**
 * 通义灵码（Alibaba Lingma）：~/.lingma/cache/db/local.db
 *
 * 表：
 *   chat_session(session_id, session_title, project_uri, gmt_create, gmt_modified, ...)
 *   chat_message(role, content, ...)            content 是加密的
 *   chat_record(extra, summary, gmt_create, ...) extra.originalContent 是明文提问，
 *                                                summary 是明文助手摘要
 *
 * 因此这是**部分支持**：能读你的提问和助手摘要，读不到完整助手回复。
 * 不尝试解密 answer/question 字段。
 */
const DB_PATH = process.env.ASS_LINGMA_DB || path.join(HOME, '.lingma', 'cache', 'db', 'local.db')

function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  return null
}

function dbPathOf(uri: string | null): string | null {
  if (!uri) return null
  let p = uri
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\//, ''))
    } catch {
      p = p.replace(/^file:\/\//, '')
    }
  }
  return p || null
}

function list(_opts: ListOptions, _ctx: AdapterCtx): SessionMeta[] {
  if (!exists(DB_PATH)) return []
  const r = openSqlite(DB_PATH)
  if (!r.db) return []
  const db = r.db
  try {
    const sessions = db.query(
      `select session_id, session_title, project_uri, gmt_create, gmt_modified
         from chat_session order by gmt_modified desc, session_id`,
    ) as any[]
    const stats = new Map<string, { users: number; bubbles: number }>()
    try {
      for (const s of db.query(
        `select session_id,
                sum(case when role = 'user' then 1 else 0 end) as users,
                sum(case when role in ('user','assistant') then 1 else 0 end) as bubbles
           from chat_message group by session_id`,
      ) as any[]) {
        stats.set(String(s.session_id), { users: Number(s.users) || 0, bubbles: Number(s.bubbles) || 0 })
      }
    } catch { /* 统计不可用时只影响轮次 */ }

    // 明文提问在 chat_record.extra.originalContent；每个会话取最新一条作为 preview
    const previews = new Map<string, string>()
    try {
      for (const row of db.query(
        `select session_id, extra from chat_record
          where extra like '%originalContent%' order by gmt_create desc, request_id`,
      ) as any[]) {
        const sid = String(row.session_id || '')
        if (!sid || previews.has(sid)) continue
        const q = questionOf(row.extra)
        if (q) previews.set(sid, q)
      }
    } catch { /* preview 只是辅助信息 */ }

    const out: SessionMeta[] = []
    for (const row of sessions) {
      const id = String(row.session_id || '')
      if (!id) continue
      const cwd = dbPathOf(row.project_uri ? String(row.project_uri) : null)
      const repo = cwd ? gitRoot(cwd) : null
      const st = stats.get(id) || { users: 0, bubbles: 0 }
      const title = plain(String(row.session_title || ''), 70) || '(未命名会话)'
      out.push({
        key: `lingma:${id}`,
        agent: 'lingma',
        agentLabel: '通义灵码',
        id,
        title,
        preview: plain(previews.get(id) || title, 140),
        cwd,
        repo,
        project: projectName(repo || cwd),
        startedAt: toMs(row.gmt_create),
        updatedAt: toMs(row.gmt_modified),
        turns: st.users,
        bubbles: st.bubbles,
        model: null,
        branch: null,
        source: DB_PATH,
        size: 0,
        extra: { partial: 'assistant-summary-only' },
      })
    }
    return out
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function questionOf(extra: unknown): string {
  if (typeof extra !== 'string' || !extra) return ''
  try {
    const j = JSON.parse(extra)
    const q = j?.originalContent
    return typeof q === 'string' ? q.trim() : ''
  } catch {
    return ''
  }
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const r = openSqlite(meta.source)
  if (!r.db) return []
  const db = r.db
  try {
    const rows = db.query(
      `select request_id, extra, summary, gmt_create
         from chat_record where session_id = ${lit(meta.id)} order by gmt_create, request_id`,
    ) as any[]
    const turns: Turn[] = []
    for (const row of rows) {
      const at = toMs(row.gmt_create) || undefined
      const q = questionOf(row.extra)
      if (q) turns.push({ role: 'user', text: q, at })
      const summary = typeof row.summary === 'string' ? row.summary.trim() : ''
      if (summary) turns.push({ role: 'assistant', text: `（灵码摘要）${summary}`, at: at ? at + 1 : undefined })
    }
    return opts.tail ? turns.slice(-opts.tail) : turns
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

export const lingmaAdapter: Adapter = {
  id: 'lingma',
  label: '通义灵码',
  available: () => exists(DB_PATH),
  sources: () => [DB_PATH],
  list,
  read,
  hint: '灵码的完整回答是加密的；这里读取明文提问与助手摘要（summary），不是完整回复。',
}

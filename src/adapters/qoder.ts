import path from 'node:path'
import type { Adapter, AdapterCtx, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, exists, gitRoot, isDir, plain, projectName, statOf } from '../util'
import { openSqlite, lit } from '../sqlite'
import { makeClaudeFamilyAdapter } from './claude'

/**
 * Qoder（阿里）：
 *   1) CLI / Qoder CN 的 JSONL：~/.qoder/projects 与 ~/.qoder-cn/projects 下的 .jsonl
 *      记录形状与 Claude 兼容，直接复用 Claude family 解析器。
 *   2) 桌面版 SQLite：<App Support>/com.qoder.app.stable/main.sqlite
 *      （CN 为 com.qodercn.app.stable），表：
 *        chat_sessions(session_id,title,cwd,created_at,updated_at,deleted_at,...)
 *        chat_session_messages(session_id,message_id,sequence,payload_json,created_at)
 *      payload_json 里是 { role, text, parts: [{type:'text'|'tool',...}], timestamp }。
 *
 * 两种来源用同一个 agent id `qoder`；key 冲突时优先保留 JSONL（更接近原始会话）。
 */
const JSONL_ROOTS = process.env.ASS_QODER_DIR
  ? [process.env.ASS_QODER_DIR]
  : [path.join(HOME, '.qoder', 'projects'), path.join(HOME, '.qoder-cn', 'projects')]

function appSupport(...parts: string[]): string {
  return process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', ...parts)
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), ...parts)
      : path.join(HOME, '.config', ...parts)
}

const DB_PATHS = process.env.ASS_QODER_DB
  ? [process.env.ASS_QODER_DB]
  : [
      appSupport('com.qoder.app.stable', 'main.sqlite'),
      appSupport('com.qodercn.app.stable', 'main.sqlite'),
      appSupport('QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db'),
    ]

const jsonl = makeClaudeFamilyAdapter({
  id: 'qoder',
  label: 'Qoder',
  roots: JSONL_ROOTS,
})

function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n
    const d = Date.parse(v)
    if (!Number.isNaN(d)) return d
  }
  return null
}

function columns(db: { query: (sql: string) => any[] }, table: string): string[] {
  try {
    return db.query(`pragma table_info(${table})`).map((r: any) => String(r.name))
  } catch {
    return []
  }
}

function dbList(file: string): SessionMeta[] {
  if (!exists(file)) return []
  const r = openSqlite(file)
  if (!r.db) return []
  const db = r.db
  try {
    const cols = columns(db, 'chat_sessions')
    if (!cols.includes('session_id')) return []
    const pick = (name: string, fallback = 'null') => (cols.includes(name) ? name : `${fallback} as ${name}`)
    const where = cols.includes('deleted_at') ? 'where deleted_at is null' : ''
    const rows = db.query(
      `select ${pick('session_id')}, ${pick('title')}, ${pick('cwd')}, ${pick('created_at')}, ${pick('updated_at')}, ${pick('archived')} from chat_sessions ${where} order by updated_at desc, session_id`,
    )
    const msgCols = columns(db, 'chat_session_messages')
    const stats = new Map<string, { total: number; users: number }>()
    if (msgCols.includes('session_id') && msgCols.includes('payload_json')) {
      try {
        for (const s of db.query(
          `select session_id, count(*) as total,
                  sum(case when payload_json like '%"role":"user"%' then 1 else 0 end) as users
             from chat_session_messages group by session_id`,
        )) stats.set(String(s.session_id), { total: Number(s.total) || 0, users: Number(s.users) || 0 })
      } catch { /* 结构不兼容时只影响计数 */ }
    }
    const out: SessionMeta[] = []
    for (const row of rows) {
      const id = String(row.session_id || '')
      if (!id) continue
      const cwd = typeof row.cwd === 'string' && row.cwd ? row.cwd : null
      const st = stats.get(id) || { total: 0, users: 0 }
      const repo = cwd ? gitRoot(cwd) : null
      const title = plain(String(row.title || ''), 70) || '(未命名会话)'
      out.push({
        key: `qoder:${id}`,
        agent: 'qoder',
        agentLabel: 'Qoder',
        id,
        title,
        preview: title,
        cwd,
        repo,
        project: projectName(repo || cwd),
        startedAt: toMs(row.created_at),
        updatedAt: toMs(row.updated_at),
        turns: st.users,
        bubbles: st.total,
        model: null,
        branch: null,
        source: file,
        size: 0,
        extra: { variant: 'desktop', archived: Boolean(row.archived) },
      })
    }
    return out
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function readDb(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const r = openSqlite(meta.source)
  if (!r.db) return []
  const db = r.db
  try {
    const cols = columns(db, 'chat_session_messages')
    if (!cols.includes('payload_json')) return []
    const order = ['sequence', 'message_id'].filter((c) => cols.includes(c)).join(', ') || 'rowid'
    const rows = db.query(`select payload_json, created_at from chat_session_messages where session_id = ${lit(meta.id)} order by ${order}`)
    const turns: Turn[] = []
    for (const row of rows) {
      let m: any
      try {
        m = JSON.parse(String(row.payload_json || '{}'))
      } catch {
        continue
      }
      const role = m?.role
      if (role !== 'user' && role !== 'assistant') continue
      const parts = Array.isArray(m.parts) ? m.parts : []
      const texts: string[] = []
      const tools: string[] = []
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue
        if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) texts.push(p.text)
        else if (p.type === 'tool' && p.tool && typeof p.tool === 'object') {
          const name = String(p.tool.name || 'tool')
          const input = p.tool.input
          const hint = input && typeof input === 'object'
            ? String(input.file_path || input.path || input.command || input.description || '')
            : ''
          if (hint) tools.push(`▸ ${name}: ${plain(hint, 100)}`)
        }
      }
      if (!texts.length && typeof m.text === 'string' && m.text.trim()) texts.push(m.text)
      if (role === 'assistant') texts.push(...tools)
      const text = texts.join('\n').trim()
      if (!text) continue
      turns.push({
        role,
        text,
        at: toMs(m.timestamp) || toMs(row.created_at) || undefined,
      })
    }
    return opts.tail ? turns.slice(-opts.tail) : turns
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function list(opts: ListOptions, ctx: AdapterCtx): SessionMeta[] {
  const byKey = new Map<string, SessionMeta>()
  for (const meta of jsonl.list!(opts, ctx)) byKey.set(meta.key, meta)
  for (const file of DB_PATHS) {
    for (const meta of dbList(file)) if (!byKey.has(meta.key)) byKey.set(meta.key, meta)
  }
  return [...byKey.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  return meta.extra?.variant === 'desktop' ? readDb(meta, opts) : jsonl.read!(meta, opts)
}

export const qoderAdapter: Adapter = {
  id: 'qoder',
  label: 'Qoder',
  available: () => JSONL_ROOTS.some((r) => isDir(r)) || DB_PATHS.some((p) => exists(p)),
  sources: () => [...JSONL_ROOTS, ...DB_PATHS],
  list,
  read,
  hint: 'Qoder 支持 CLI 的 JSONL 与桌面版的 main.sqlite；两者都只读，桌面库可能带 -wal。',
}

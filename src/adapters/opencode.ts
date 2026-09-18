import path from 'node:path'
import type { Adapter, AdapterCtx, ImagePart, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, cleanUserText, exists, gitRoot, isInjected, parseDataUrl, plain, projectName } from '../util'
import { lit, openSqlite, type Db } from '../sqlite'

/**
 * OpenCode：~/.local/share/opencode/opencode.db（SQLite）
 *
 *   session(id, project_id, directory, title, time_created, time_updated, model, ...)
 *   message(id, session_id, data)   data.role = 'user' | 'assistant'
 *   part(id, message_id, session_id, data)  data.type = text | reasoning | tool | file | step-* | patch
 *
 * 图片：part.data = { type:'file', mime:'image/png', filename:'clipboard', url:'data:image/png;base64,...' }
 */
/** 数据源可用 ASS_OPENCODE_DB 覆盖 */
const DB_FILE = process.env.ASS_OPENCODE_DB || path.join(HOME, '.local', 'share', 'opencode', 'opencode.db')

let cachedDb: Db | null = null
let cachedReason: string | null = null

function db(): Db | null {
  if (cachedDb) return cachedDb
  const r = openSqlite(DB_FILE)
  if (r.db) {
    cachedDb = r.db
    return cachedDb
  }
  cachedReason = r.reason
  return null
}

function available(): boolean {
  return exists(DB_FILE) && db() !== null
}

function list(_opts: ListOptions, _ctx: AdapterCtx): SessionMeta[] {
  const d = db()
  if (!d) return []
  const rows = d.query<{ id: string; title: string; directory: string; worktree: string | null; model: string | null; t0: number; t1: number; turns: number }>(
    `select s.id, s.title, s.directory, p.worktree, s.model, s.time_created as t0, s.time_updated as t1,
            (select count(*) from message m where m.session_id = s.id and json_extract(m.data,'$.role')='user') as turns
       from session s left join project p on p.id = s.project_id
      where s.parent_id is null
      order by s.time_updated desc`,
  )
  return rows.map((r) => {
    const cwd = r.directory || r.worktree || null
    const repo = cwd ? gitRoot(cwd) : null
    return {
      key: `opencode:${r.id}`,
      agent: 'opencode',
      agentLabel: 'OpenCode',
      id: r.id,
      title: r.title || '(空会话)',
      preview: '',
      cwd,
      repo,
      project: projectName(repo || cwd),
      startedAt: r.t0 || null,
      updatedAt: r.t1 || null,
      turns: Number(r.turns) || 0,
      bubbles: Number(r.turns) || 0,
      model: r.model || null,
      branch: null,
      source: DB_FILE,
      size: 0,
    }
  })
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const d = db()
  if (!d) return []
  const id = meta.id.replace(/^opencode:/, '')
  const limitSql = opts.tail ? ` limit ${Number(opts.tail)}` : ''
  // 取最后 N 条消息：先按时间倒序取，再翻回来
  const msgs = d.query<{ id: string; data: string; t: number }>(
    opts.tail
      ? `select id, data, time_created as t from (select * from message where session_id = ${lit(id)} order by time_created desc, id desc${limitSql}) order by t asc, id asc`
      : `select id, data, time_created as t from message where session_id = ${lit(id)} order by time_created asc, id asc`,
  )
  if (msgs.length === 0) return []
  const ids = msgs.map((m) => lit(m.id)).join(',')
  const parts = d.query<{ message_id: string; data: string; t: number }>(
    `select message_id, data, time_created as t from part where message_id in (${ids}) order by time_created asc, id asc`,
  )
  const byMsg = new Map<string, Record<string, any>[]>()
  for (const p of parts) {
    let j: Record<string, any>
    try {
      j = JSON.parse(p.data)
    } catch {
      continue
    }
    const arr = byMsg.get(p.message_id)
    if (arr) arr.push(j)
    else byMsg.set(p.message_id, [j])
  }

  const turns: Turn[] = []
  for (const m of msgs) {
    let info: Record<string, any> = {}
    try {
      info = JSON.parse(m.data)
    } catch {
      /* ignore */
    }
    const role: Turn['role'] = info.role === 'user' ? 'user' : info.role === 'assistant' ? 'assistant' : 'system'
    if (role === 'system') continue
    const texts: string[] = []
    const images: ImagePart[] = []
    const files: { name: string; path?: string }[] = []
    for (const p of byMsg.get(m.id) || []) {
      if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text)
      else if (p.type === 'file' && typeof p.url === 'string') {
        const img = parseDataUrl(p.url)
        if (img && img.base64) images.push({ mediaType: img.mediaType || String(p.mime || 'image/png'), base64: img.base64 })
        else if (p.source?.path) files.push({ name: String(p.filename || path.basename(String(p.source.path))), path: String(p.source.path) })
      } else if (p.type === 'tool' && role === 'assistant') {
        const t = p.tool || 'tool'
        const input = p.state?.input || {}
        const v = input.filePath || input.path || input.pattern || input.command || ''
        if (v) texts.push(`▸ ${t}: ${plain(v, 100)}`)
      }
    }
    // assistant 的 reasoning 不搬；用户消息里的图片保留
    const text = cleanUserText(texts.join('\n'))
    if (!text && images.length === 0) continue
    if (role === 'user' && isInjected(text) && images.length === 0) continue
    turns.push({ role, text, at: m.t || undefined, images: images.length ? images : undefined, files: files.length ? files : undefined })
  }
  return turns
}

export const opencodeAdapter: Adapter = {
  id: 'opencode',
  label: 'OpenCode',
  available,
  sources: () => [DB_FILE],
  list,
  read,
  hint: cachedReason ?? undefined,
}

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
  const rows = d.query<{
    id: string
    title: string
    directory: string
    worktree: string | null
    model: string | null
    t0: number
    t1: number
    turns: number
    lasttxt: string | null
  }>(
    // lasttxt = 最后一条用户消息的正文。正文在 part 表里，所以要「先定位最后一条 user
    // message，再取它的 text part」。放在同一条 SQL 里做，避免 22+ 个会话各查一遍。
    `select s.id, s.title, s.directory, p.worktree, s.model, s.time_created as t0, s.time_updated as t1,
            (select count(*) from message m where m.session_id = s.id and json_extract(m.data,'$.role')='user') as turns,
            (select group_concat(json_extract(pt.data,'$.text'), ' ')
               from part pt
              where pt.message_id = (select m2.id from message m2
                                      where m2.session_id = s.id and json_extract(m2.data,'$.role')='user'
                                      order by m2.time_created desc, m2.id desc limit 1)
                and json_extract(pt.data,'$.type')='text') as lasttxt
       from session s left join project p on p.id = s.project_id
      where s.parent_id is null
      order by s.time_updated desc`,
  )
  // 第一遍：用「最后一条用户消息」。绝大多数会话到这里就够了
  const cleaned = rows.map((r) => cleanUserText(String(r.lasttxt || '')))
  const usable = cleaned.map((t) => (t && !isInjected(t) ? t : ''))
  // 少数派：最后一条用户消息清洗后是空的、或整条都是系统注入（比如只剩一个
  // <system-reminder>）。这时要往回找到最后一条**真的说了话**的 ——
  // claude / codex 适配器遍历时本来就是这个行为，两边不能不一致，
  // 否则列表里显示的和 `ass show` 读出来的对不上。
  const needFallback = rows.filter((_, i) => !usable[i]).map((r) => r.id)
  const fallback = needFallback.length ? lastUsableTexts(d, needFallback) : new Map<string, string>()

  return rows.map((r, i) => {
    const cwd = r.directory || r.worktree || null
    const repo = cwd ? gitRoot(cwd) : null
    const text = usable[i] || fallback.get(r.id) || ''
    const preview = text ? plain(text, 140) : ''
    return {
      key: `opencode:${r.id}`,
      agent: 'opencode',
      agentLabel: 'OpenCode',
      id: r.id,
      title: r.title || '(空会话)',
      preview,
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

/**
 * 给「最后一条用户消息不可用」的那几个会话往回找：按时间倒序扫它的用户消息，
 * 第一条清洗后非空且不是纯注入的，就是「用户最后真正说的那句话」。
 *
 * 只在少数会话上调用（见 list()），所以整表扫这几条的代价可以接受。
 */
function lastUsableTexts(d: Db, sessionIds: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const ids = sessionIds.map((s) => lit(s)).join(',')
  const rows = d.query<{ session_id: string; txt: string | null }>(
    `select m.session_id,
            (select group_concat(json_extract(p.data,'$.text'), ' ')
               from part p where p.message_id = m.id and json_extract(p.data,'$.type')='text') as txt
       from message m
      where m.session_id in (${ids}) and json_extract(m.data,'$.role')='user'
      order by m.session_id, m.time_created desc, m.id desc`,
  )
  for (const r of rows) {
    if (out.has(r.session_id)) continue // 已是倒序，第一条可用的就是最新的
    const t = cleanUserText(String(r.txt || ''))
    if (t && !isInjected(t)) out.set(r.session_id, t)
  }
  return out
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

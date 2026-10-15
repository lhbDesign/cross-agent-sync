import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterCtx, ImagePart, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { lit, openSqlite } from '../sqlite'
import { sessionTitle } from './title'
import { HOME, cleanUserText, exists, gitRoot, isDir, isInjected, parseDataUrl, plain, projectName, readJsonl, readJsonlTail, statOf } from '../util'

/**
 * Codex CLI / Codex app：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（+ archived_sessions/）
 *
 * 图片：response_item → payload.type=message / role=user，content 里
 *   { "type": "input_image", "image_url": "data:image/png;base64,..." }
 */
/** 数据源可用 ASS_CODEX_DIR / ASS_CODEX_ARCHIVED 覆盖 */
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex')
const ROOT = process.env.ASS_CODEX_DIR || path.join(CODEX_HOME, 'sessions')
const ARCHIVED = process.env.ASS_CODEX_ARCHIVED || path.join(CODEX_HOME, 'archived_sessions')
// An overridden transcript directory must not pick up another installation's titles.
const META_DIR = process.env.ASS_CODEX_DIR ? path.dirname(ROOT) : CODEX_HOME
const INDEX = process.env.ASS_CODEX_INDEX || path.join(META_DIR, 'session_index.jsonl')

function titles(ids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const wanted = new Set(ids)
  for (const rec of readJsonl(INDEX, 'file')) {
    const title = sessionTitle(rec.thread_name)
    if (wanted.has(rec.id) && title) out.set(rec.id, title)
  }
  let databases: string[] = []
  if (process.env.ASS_CODEX_DB) databases = [process.env.ASS_CODEX_DB]
  else {
    try {
      databases = fs.readdirSync(META_DIR).filter((f) => /^state_\d+\.sqlite$/.test(f))
        .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))
        .map((f) => path.join(META_DIR, f))
    } catch { /* index or first message remains usable */ }
  }
  // Current state is authoritative; the append-only index is the fallback.
  for (const file of databases) {
    // Metadata lives next to writable Codex configuration; protect the file, not CODEX_HOME.
    const { db } = openSqlite(file, 'file')
    if (!db) continue
    try {
      const found = new Map<string, string>()
      for (let i = 0; i < ids.length; i += 200) {
        for (const row of db.query<{ id: string; title: unknown }>(
          `select id, title from threads where id in (${ids.slice(i, i + 200).map(lit).join(',')})`,
        )) {
          const title = sessionTitle(row.title)
          if (title) found.set(row.id, title)
        }
      }
      for (const [id, title] of found) out.set(id, title)
      break
    } catch { /* unsupported/corrupt state database: try an older schema or the index */ }
    finally { db.close() }
  }
  return out
}

interface FileCache {
  files?: Record<string, { stamp: string; meta: SessionMeta }>
}

function available(): boolean {
  return exists(ROOT) || exists(ARCHIVED)
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

function files(): string[] {
  const out = exists(ROOT) ? walk(ROOT) : []
  if (exists(ARCHIVED)) {
    try {
      for (const f of fs.readdirSync(ARCHIVED)) if (f.endsWith('.jsonl')) out.push(path.join(ARCHIVED, f))
    } catch {
      /* ignore */
    }
  }
  return out
}

function idFromName(file: string): string {
  const m = /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-(.+)$/.exec(path.basename(file, '.jsonl'))
  return m?.[1] ?? path.basename(file, '.jsonl')
}

function messageParts(p: Record<string, any>): { text: string; images: ImagePart[] } {
  const images: ImagePart[] = []
  const texts: string[] = []
  const content = p.content
  if (typeof content === 'string') return { text: content, images }
  if (!Array.isArray(content)) return { text: '', images }
  for (const c of content) {
    if (!c || typeof c !== 'object') continue
    const blk = c as Record<string, any>
    if (typeof blk.text === 'string' && (blk.type === 'input_text' || blk.type === 'output_text' || blk.type === 'text')) {
      const cleaned = cleanUserText(blk.text)
      if (cleaned) texts.push(cleaned)
    } else if (blk.type === 'input_image' || blk.type === 'image') {
      const url = blk.image_url || blk.url
      const img = parseDataUrl(url)
      if (img && img.base64) images.push({ mediaType: img.mediaType, base64: img.base64 })
    }
  }
  return { text: texts.join('\n'), images }
}

function parseFile(file: string): SessionMeta {
  let meta: Record<string, any> | null = null
  let model: string | null = null
  let firstUser: string | null = null
  let lastUser: string | null = null
  let turns = 0
  let bubbles = 0
  let messageOrdinal = 0
  let prior: { role: 'user' | 'assistant'; text: string; source: string; at: number | null; ordinal: number } | null = null
  const noteMessage = (role: 'user' | 'assistant', text: string, source: string, at: number | null): void => {
    messageOrdinal++
    const t = text.trim()
    if (!t || (role === 'user' && isInjected(t))) return
    const closeInTime = prior?.at == null || at == null || Math.abs(at - prior.at) <= 1000
    const duplicateEncoding = prior?.ordinal === messageOrdinal - 1 && prior.role === role && prior.text === t && prior.source !== source && closeInTime
    if (!duplicateEncoding) {
      bubbles++
      if (role === 'user') {
        turns++
        lastUser = t
        if (!firstUser) firstUser = t
      }
    }
    prior = { role, text: t, source, at, ordinal: messageOrdinal }
  }

  for (const rec of readJsonl(file)) {
    const p: Record<string, any> = rec.payload || {}
    if (!meta && rec.type === 'session_meta') meta = p
    if (!model && rec.type === 'turn_context') model = p.model || p.model_info?.id || null
    const at = rec.timestamp ? Date.parse(String(rec.timestamp)) || null : null
    if (rec.type === 'event_msg' && p.type === 'user_message') {
      noteMessage('user', String(p.message || ''), 'event_msg', at)
    } else if (rec.type === 'event_msg' && p.type === 'agent_message') {
      noteMessage('assistant', String(p.message || ''), 'event_msg', at)
    } else if (rec.type === 'response_item' && p.type === 'message') {
      const { text } = messageParts(p)
      if (p.role === 'user') {
        noteMessage('user', text, 'response_item', at)
      } else if (p.role === 'assistant') {
        noteMessage('assistant', text, 'response_item', at)
      }
    }
  }

  const sessionId = (meta?.id as string) || (meta?.session_id as string) || idFromName(file)
  const cwd = (meta?.cwd as string) || null
  const st = statOf(file)
  const repo = cwd ? gitRoot(cwd) : null
  return {
    key: `codex:${sessionId}`,
    agent: 'codex',
    agentLabel: 'Codex',
    id: sessionId,
    title: firstUser ? plain(firstUser, 70) : '(空会话)',
    preview: plain(lastUser, 140),
    cwd,
    repo,
    project: projectName(repo || cwd),
    startedAt: meta?.timestamp ? Date.parse(String(meta.timestamp)) || null : null,
    updatedAt: st ? st.mtimeMs : null,
    turns,
    bubbles,
    model: model || (meta?.model as string) || null,
    branch: null,
    source: file,
    size: st ? st.size : 0,
    extra: { originator: meta?.originator },
  }
}

function list(_opts: ListOptions, ctx: AdapterCtx): SessionMeta[] {
  const cache = ctx.cache as FileCache
  const prev = cache.files || {}
  const next: Record<string, { stamp: string; meta: SessionMeta }> = {}
  const out: SessionMeta[] = []
  for (const full of files()) {
    const st = statOf(full)
    if (!st || st.size < 200) continue
    const stamp = `titles-v1:${st.mtimeMs}:${st.size}`
    const hit = prev[full]
    const meta = hit && hit.stamp === stamp ? hit.meta : parseFile(full)
    next[full] = { stamp, meta }
    out.push(meta)
  }
  cache.files = next
  const names = titles(out.map((m) => m.id))
  // Overlay without caching: renaming does not necessarily touch the rollout file.
  return out.map((m) => ({ ...m, title: names.get(m.id) || m.title }))
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const turns: Turn[] = []
  let messageOrdinal = 0
  let prior: { role: Turn['role']; text: string; source: string; at: number | undefined; ordinal: number; turnIndex: number } | null = null
  const push = (role: Turn['role'], text: string, at: number | undefined, source: string, images?: ImagePart[]) => {
    messageOrdinal++
    const t = text.trim()
    if (!t && !images?.length) return
    if (isInjected(t) && !images?.length) return
    const closeInTime = prior?.at == null || at == null || Math.abs(at - prior.at) <= 1000
    const duplicateEncoding = prior?.ordinal === messageOrdinal - 1 && prior.role === role && prior.text === t && prior.source !== source && closeInTime
    if (duplicateEncoding && prior) {
      if (images?.length && !turns[prior.turnIndex]?.images?.length) turns[prior.turnIndex] = { ...turns[prior.turnIndex], images }
      prior = { role, text: t, source, at, ordinal: messageOrdinal, turnIndex: prior.turnIndex }
      return
    }
    turns.push({ role, text: t, at, images: images?.length ? images : undefined })
    prior = { role, text: t, source, at, ordinal: messageOrdinal, turnIndex: turns.length - 1 }
  }

  const iter = opts.tail ? readJsonlTail(meta.source, Math.max(1 << 20, opts.tail * 4096)) : readJsonl(meta.source)
  for (const rec of iter) {
    const p: Record<string, any> = rec.payload || {}
    const at = Date.parse(rec.timestamp) || undefined
    if (rec.type === 'event_msg') {
      if (p.type === 'user_message') push('user', String(p.message || ''), at, 'event_msg')
      else if (p.type === 'agent_message') push('assistant', String(p.message || ''), at, 'event_msg')
    } else if (rec.type === 'response_item' && p.type === 'message') {
      const { text, images } = messageParts(p)
      if (p.role === 'user') push('user', text, at, 'response_item', images)
      else if (p.role === 'assistant') push('assistant', text, at, 'response_item')
    } else if (rec.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      const name = String(p.name || 'tool')
      let arg: unknown = p.arguments
      if (typeof arg === 'string') {
        try {
          arg = JSON.parse(arg)
        } catch {
          /* 保持字符串 */
        }
      }
      const v =
        arg && typeof arg === 'object'
          ? ((arg as Record<string, any>).file_path ?? (arg as Record<string, any>).path ?? (arg as Record<string, any>).command ?? '')
          : typeof arg === 'string'
            ? arg
            : ''
      if (name !== 'shell' || v) turns.push({ role: 'tool', text: `▸ ${name}: ${plain(v, 100)}`, at })
    }
  }
  const cleaned = turns.filter((t) => t.role !== 'tool' || t.text.length > 4)
  return opts.tail ? cleaned.slice(-opts.tail) : cleaned
}

export const codexAdapter: Adapter = {
  id: 'codex',
  label: 'Codex',
  available,
  sources: () => [ROOT, ARCHIVED, INDEX, ...(process.env.ASS_CODEX_DB ? [process.env.ASS_CODEX_DB] : [])],
  list,
  read,
  resumeCmd: (m) => `codex resume ${m.id}`,
}

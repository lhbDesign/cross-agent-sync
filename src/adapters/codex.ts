import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterCtx, ImagePart, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, cleanUserText, exists, gitRoot, isDir, isInjected, parseDataUrl, plain, projectName, readJsonl, readJsonlTail, statOf } from '../util'

/**
 * Codex CLI / Codex app：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（+ archived_sessions/）
 *
 * 图片：response_item → payload.type=message / role=user，content 里
 *   { "type": "input_image", "image_url": "data:image/png;base64,..." }
 */
/** 数据源可用 ASS_CODEX_DIR / ASS_CODEX_ARCHIVED 覆盖 */
const ROOT = process.env.ASS_CODEX_DIR || path.join(HOME, '.codex', 'sessions')
const ARCHIVED = process.env.ASS_CODEX_ARCHIVED || path.join(HOME, '.codex', 'archived_sessions')

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
  // 同一个用户消息在旧版里是 event_msg、新版里是 response_item.message，
  // 用签名去重，避免两种都有的会话被算两次。
  const sigs = new Set<string>()

  const noteUser = (text: string): void => {
    const t = text.trim()
    if (!t || isInjected(t)) return
    const sig = t.slice(0, 200)
    if (sigs.has(sig)) return
    sigs.add(sig)
    turns++
    lastUser = t
    if (!firstUser) firstUser = t
  }

  for (const rec of readJsonl(file)) {
    const p: Record<string, any> = rec.payload || {}
    if (!meta && rec.type === 'session_meta') meta = p
    if (!model && rec.type === 'turn_context') model = p.model || p.model_info?.id || null
    if (rec.type === 'event_msg' && p.type === 'user_message') {
      noteUser(String(p.message || ''))
      bubbles++
    } else if (rec.type === 'event_msg' && p.type === 'agent_message') {
      bubbles++
    } else if (rec.type === 'response_item' && p.type === 'message') {
      const { text } = messageParts(p)
      if (p.role === 'user') {
        noteUser(text)
        bubbles++
      } else if (p.role === 'assistant') {
        bubbles++
      }
    }
  }

  const sessionId = (meta?.session_id as string) || idFromName(file)
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
    const stamp = `${Math.round(st.mtimeMs)}:${st.size}`
    const hit = prev[full]
    const meta = hit && hit.stamp === stamp ? hit.meta : parseFile(full)
    next[full] = { stamp, meta }
    out.push(meta)
  }
  cache.files = next
  return out
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const turns: Turn[] = []
  const seen = new Set<string>()
  const push = (role: Turn['role'], text: string, at: number | undefined, images?: ImagePart[]) => {
    const t = text.trim()
    if (!t && !images?.length) return
    if (isInjected(t) && !images?.length) return
    const sig = `${role}:${t.slice(0, 160)}:${images?.length ?? 0}`
    if (seen.has(sig)) return
    seen.add(sig)
    turns.push({ role, text: t, at, images: images?.length ? images : undefined })
  }

  const iter = opts.tail ? readJsonlTail(meta.source, Math.max(1 << 20, opts.tail * 4096)) : readJsonl(meta.source)
  for (const rec of iter) {
    const p: Record<string, any> = rec.payload || {}
    const at = Date.parse(rec.timestamp) || undefined
    if (rec.type === 'event_msg') {
      if (p.type === 'user_message') push('user', String(p.message || ''), at)
      else if (p.type === 'agent_message') push('assistant', String(p.message || ''), at)
    } else if (rec.type === 'response_item' && p.type === 'message') {
      const { text, images } = messageParts(p)
      if (p.role === 'user') push('user', text, at, images)
      else if (p.role === 'assistant') push('assistant', text, at)
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
  sources: () => [ROOT, ARCHIVED],
  list,
  read,
  resumeCmd: (m) => `codex resume ${m.id}`,
}

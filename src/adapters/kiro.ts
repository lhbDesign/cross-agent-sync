import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterCtx, ImagePart, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, cleanUserText, gitRoot, isDir, isInjected, plain, projectName, statOf } from '../util'

/**
 * Kiro（AWS）有两代会话存储：
 *
 * ① 新会话：~/.kiro/sessions/<workspaceHash>/<sessionId>/
 *      session.json   { id, title, workspacePaths, rootPaths, createdAt, lastModifiedAt, modelId }
 *      messages.jsonl 每行 { timestamp, payload: { type: 'user'|'assistant'|'tool_call'|..., content, images } }
 *    ~/.kiro/session-index/<workspaceHash>.jsonl 只是 add 日志，不用它。
 *
 * ② 旧版（Continue 内核残留）：
 *      <Kiro>/User/globalStorage/kiro.kiroagent/sessions/<sessionId>.json
 *      { sessionId, title, workspaceDirectory, history: [{ message: { role, content } }] }
 *      sessions.json 提供 dateCreated/workspaceDirectory 索引。
 *
 * 两代都只读；不用 .chat（那是逐轮 API 请求/上下文日志，不是会话列表）。
 */
function appSupport(...parts: string[]): string {
  return process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', ...parts)
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), ...parts)
      : path.join(HOME, '.config', ...parts)
}

function newRoot(): string {
  const env = process.env.ASS_KIRO_DIR
  if (!env) return path.join(HOME, '.kiro', 'sessions')
  return isDir(path.join(env, 'sessions')) ? path.join(env, 'sessions') : env
}

const NEW_ROOT = newRoot()
const AGENT_ROOT = process.env.ASS_KIRO_AGENT_DIR ||
  appSupport('Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'sessions')

interface FileCache {
  files?: Record<string, { stamp: string; meta: SessionMeta }>
}

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

function textOf(content: unknown): string {
  if (typeof content === 'string') return cleanUserText(content)
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const b of content) {
    if (typeof b === 'string') out.push(b)
    else if (b && typeof b === 'object') {
      const blk = b as any
      if (typeof blk.text === 'string') out.push(blk.text)
    }
  }
  return cleanUserText(out.join('\n'))
}

function imageParts(images: unknown): ImagePart[] {
  if (!Array.isArray(images)) return []
  const out: ImagePart[] = []
  for (const img of images) {
    if (!img || typeof img !== 'object') continue
    const data = (img as any).data
    if (typeof data === 'string' && data) out.push({ mediaType: String((img as any).mediaType || (img as any).mimeType || 'image/png'), base64: data })
  }
  return out
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readMessages(file: string): any[] {
  const out: any[] = []
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch { /* 单行损坏不影响整段 */ }
  }
  return out
}

function cwdOf(paths: unknown): string | null {
  if (!Array.isArray(paths)) return null
  for (const p of paths) {
    if (typeof p === 'string' && p) return p
  }
  return null
}

function newDirs(): string[] {
  const out: string[] = []
  let workspaces: fs.Dirent[] = []
  try {
    workspaces = fs.readdirSync(NEW_ROOT, { withFileTypes: true })
  } catch {
    return out
  }
  for (const w of workspaces) {
    if (!w.isDirectory()) continue
    const wdir = path.join(NEW_ROOT, w.name)
    let sessions: fs.Dirent[] = []
    try {
      sessions = fs.readdirSync(wdir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const dir = path.join(wdir, s.name)
      if (fs.existsSync(path.join(dir, 'session.json')) && fs.existsSync(path.join(dir, 'messages.jsonl'))) out.push(dir)
    }
  }
  return out
}

function parseNew(dir: string): { meta: SessionMeta; messages: any[] } | null {
  const metaFile = path.join(dir, 'session.json')
  const msgFile = path.join(dir, 'messages.jsonl')
  const j = readJson(metaFile)
  const messages = readMessages(msgFile)
  if (!j || !messages.length) return null
  const id = typeof j.id === 'string' && j.id ? j.id : path.basename(dir)
  const cwd = cwdOf(j.workspacePaths) || cwdOf(j.rootPaths)
  let firstUser = ''
  let lastUser = ''
  let turns = 0
  let bubbles = 0
  let firstAt: number | null = null
  let lastAt: number | null = null
  for (const r of messages) {
    const p = r?.payload
    if (!p || (p.type !== 'user' && p.type !== 'assistant')) continue
    const text = textOf(p.content).trim()
    // Kiro 的 Reasoning 占位不是最终回答（常见内容就是 "..."）
    if (p.type === 'assistant' && (p.operationType === 'Reasoning' || text === '...')) continue
    const at = toMs(r.timestamp)
    if (at) {
      if (firstAt === null || at < firstAt) firstAt = at
      if (lastAt === null || at > lastAt) lastAt = at
    }
    if (!text) continue
    bubbles++
    if (p.type === 'user' && !isInjected(text)) {
      turns++
      lastUser = text
      if (!firstUser) firstUser = text
    }
  }
  const st = statOf(msgFile)
  const repo = cwd ? gitRoot(cwd) : null
  return {
    messages,
    meta: {
      key: `kiro:${id}`,
      agent: 'kiro',
      agentLabel: 'Kiro',
      id,
      title: plain(String(j.title || firstUser), 70) || '(空会话)',
      preview: plain(lastUser, 140),
      cwd,
      repo,
      project: projectName(repo || cwd),
      startedAt: toMs(j.createdAt) || firstAt || (st ? st.mtimeMs : null),
      updatedAt: toMs(j.lastModifiedAt) || lastAt || (st ? st.mtimeMs : null),
      turns,
      bubbles,
      model: typeof j.modelId === 'string' ? j.modelId : null,
      branch: null,
      source: msgFile,
      size: st ? st.size : 0,
      extra: { variant: 'session', dir },
    },
  }
}

function oldIndex(): Map<string, { title?: string; dateCreated?: number; workspaceDirectory?: string | null }> {
  const map = new Map<string, { title?: string; dateCreated?: number; workspaceDirectory?: string | null }>()
  const idx = readJson(path.join(AGENT_ROOT, 'sessions.json'))
  if (!Array.isArray(idx)) return map
  for (const x of idx) {
    if (!x || typeof x.sessionId !== 'string') continue
    map.set(x.sessionId, {
      title: typeof x.title === 'string' ? x.title : undefined,
      dateCreated: toMs(x.dateCreated) || undefined,
      workspaceDirectory: typeof x.workspaceDirectory === 'string' ? x.workspaceDirectory : null,
    })
  }
  return map
}

function parseOld(file: string, index: Map<string, { title?: string; dateCreated?: number; workspaceDirectory?: string | null }>): SessionMeta | null {
  const j = readJson(file)
  if (!j || typeof j.sessionId !== 'string') return null
  const idx = index.get(j.sessionId)
  let firstUser = ''
  let lastUser = ''
  let turns = 0
  let bubbles = 0
  let firstAt: number | null = null
  let lastAt: number | null = null
  const history = Array.isArray(j.history) ? j.history : []
  for (const h of history) {
    const m = h?.message
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    const text = textOf(m.content).trim()
    const at = toMs(h.timestamp) || toMs(h.createdAt)
    if (at) {
      if (firstAt === null || at < firstAt) firstAt = at
      if (lastAt === null || at > lastAt) lastAt = at
    }
    if (!text) continue
    bubbles++
    if (m.role === 'user' && !isInjected(text)) {
      turns++
      lastUser = text
      if (!firstUser) firstUser = text
    }
  }
  if (!bubbles) return null
  const rawDir = idx?.workspaceDirectory || j.workspaceDirectory
  const cwd = typeof rawDir === 'string' ? rawDir.replace(/^file:\/\//, '') : null
  const st = statOf(file)
  const repo = cwd ? gitRoot(cwd) : null
  return {
    key: `kiro:${j.sessionId}`,
    agent: 'kiro',
    agentLabel: 'Kiro',
    id: j.sessionId,
    title: plain(String(j.title || idx?.title || firstUser), 70) || '(空会话)',
    preview: plain(lastUser, 140),
    cwd,
    repo,
    project: projectName(repo || cwd),
    startedAt: idx?.dateCreated || firstAt || (st ? st.mtimeMs : null),
    updatedAt: lastAt || (st ? st.mtimeMs : null),
    turns,
    bubbles,
    model: typeof j.chatModelTitle === 'string' ? j.chatModelTitle : null,
    branch: null,
    source: file,
    size: st ? st.size : 0,
    extra: { variant: 'agent' },
  }
}

function list(_opts: ListOptions, ctx: AdapterCtx): SessionMeta[] {
  const cache = ctx.cache as FileCache
  const prev = cache.files || {}
  const next: Record<string, { stamp: string; meta: SessionMeta }> = {}
  const out: SessionMeta[] = []

  for (const dir of newDirs()) {
    const msgFile = path.join(dir, 'messages.jsonl')
    const metaFile = path.join(dir, 'session.json')
    const st = statOf(msgFile)
    const sm = statOf(metaFile)
    if (!st || !sm) continue
    const stamp = `${st.mtimeMs}:${st.size}:${sm.mtimeMs}:${sm.size}`
    const hit = prev[msgFile]
    const meta = hit && hit.stamp === stamp ? hit.meta : parseNew(dir)?.meta
    if (!meta) continue
    next[msgFile] = { stamp, meta }
    out.push(meta)
  }

  const index = oldIndex()
  let files: string[] = []
  try {
    files = fs.readdirSync(AGENT_ROOT).filter((f) => f.endsWith('.json') && f !== 'sessions.json')
  } catch { /* no old sessions */ }
  for (const f of files) {
    const file = path.join(AGENT_ROOT, f)
    const st = statOf(file)
    if (!st) continue
    const stamp = `${st.mtimeMs}:${st.size}`
    const hit = prev[file]
    const meta = hit && hit.stamp === stamp ? hit.meta : parseOld(file, index)
    if (!meta) continue
    next[file] = { stamp, meta }
    out.push(meta)
  }
  cache.files = next
  return out
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const turns: Turn[] = []
  if (meta.extra?.variant === 'session') {
    const dir = String(meta.extra.dir || path.dirname(meta.source))
    const messages = readMessages(path.join(dir, 'messages.jsonl'))
    for (const r of messages) {
      const p = r?.payload
      if (!p || (p.type !== 'user' && p.type !== 'assistant')) continue
      const text = textOf(p.content).trim()
      if (p.type === 'assistant' && (p.operationType === 'Reasoning' || text === '...')) continue
      const images = p.type === 'user' ? imageParts(p.images) : []
      if (!text && !images.length) continue
      if (p.type === 'user' && text && isInjected(text) && !images.length) continue
      turns.push({
        role: p.type === 'user' ? 'user' : 'assistant',
        text,
        at: toMs(r.timestamp) || undefined,
        images: images.length ? images : undefined,
      })
    }
  } else {
    const j = readJson(meta.source)
    const history = Array.isArray(j?.history) ? j.history : []
    for (const h of history) {
      const m = h?.message
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
      const text = textOf(m.content).trim()
      if (!text) continue
      if (m.role === 'user' && isInjected(text)) continue
      turns.push({ role: m.role, text, at: toMs(h.timestamp) || undefined })
    }
  }
  return opts.tail ? turns.slice(-opts.tail) : turns
}

export const kiroAdapter: Adapter = {
  id: 'kiro',
  label: 'Kiro',
  available: () => isDir(NEW_ROOT) || isDir(AGENT_ROOT),
  sources: () => [NEW_ROOT, AGENT_ROOT],
  list,
  read,
  hint: 'Kiro 有两代会话：~/.kiro/sessions（新）与 kiro.kiroagent/sessions（旧 Continue 内核）；都只读。',
}

import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterCtx, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, cleanUserText, gitRoot, isDir, isInjected, plain, projectName, statOf } from '../util'
import { openSqlite } from '../sqlite'

/**
 * Trae（字节）：
 *   <App Support>/Trae/User/workspaceStorage/<hash>/state.vscdb
 *   <App Support>/Trae CN/User/workspaceStorage/<hash>/state.vscdb
 *
 * Trae 新的 agent 库 ModularData/ai-agent/database.db 是 SQLCipher 加密的，
 * 不在这里解密。但 workspace state 里仍有明文：
 *   - memento/icube-ai-agent-storage            { list: [{ sessionId, title, messages: [...] }] }
 *   - memento/icube-ai-agent-storage-<id>       同上（新版本 key 带 workspace 后缀）
 *   - memento/icube-ai-ng-chat-storage-<id>     { list: [{ sessionId, messages: [...] }] }
 *   - icube-ai-agent-storage-input-history      仅用户输入（没有助手回复）
 *
 * 所以：能读到完整会话时读完整；只有输入历史时退化为「仅输入历史」并明确标注。
 */
function appSupport(): string {
  return process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'))
      : path.join(HOME, '.config')
}

function roots(): string[] {
  if (process.env.ASS_TRAE_DIR) {
    const dir = process.env.ASS_TRAE_DIR
    return isDir(path.join(dir, 'User', 'workspaceStorage')) ? [path.join(dir, 'User', 'workspaceStorage')] : [dir]
  }
  return ['Trae', 'Trae CN'].map((name) => path.join(appSupport(), name, 'User', 'workspaceStorage'))
}

const ROOTS = roots()

interface Entry {
  sessionId: string
  title?: string
  name?: string
  createdAt?: number
  updatedAt?: number
  messages: any[]
}

interface FileCache {
  files?: Record<string, { stamp: string; metas: SessionMeta[] }>
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

function parseJson(v: unknown): any {
  if (typeof v !== 'string' || !v) return null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return cleanUserText(content)
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const b of content) {
    if (typeof b === 'string') out.push(b)
    else if (b && typeof b === 'object' && typeof (b as any).text === 'string') out.push((b as any).text)
  }
  return cleanUserText(out.join('\n'))
}

function workspaceCwd(dir: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'))
    const raw = typeof j.folder === 'string' ? j.folder : typeof j.workspace === 'string' ? j.workspace : ''
    if (!raw) return null
    const p = raw.replace(/^file:\/\//, '')
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  } catch {
    return null
  }
}

function parseWorkspace(dbPath: string): { full: Entry[]; inputHistory: any[] } {
  const r = openSqlite(dbPath)
  if (!r.db) return { full: [], inputHistory: [] }
  const db = r.db
  try {
    let rows: any[] = []
    try {
      rows = db.query(
        `select key, value from ItemTable
          where key = 'memento/icube-ai-agent-storage'
             or key like 'memento/icube-ai-agent-storage-%'
             or key like 'memento/icube-ai-ng-chat-storage%'
             or key = 'icube-ai-agent-storage-input-history'`,
      ) as any[]
    } catch {
      return { full: [], inputHistory: [] }
    }
    const byId = new Map<string, Entry>()
    let inputHistory: any[] = []
    for (const row of rows) {
      const key = String(row.key || '')
      const value = parseJson(row.value)
      if (key === 'icube-ai-agent-storage-input-history') {
        if (Array.isArray(value)) inputHistory = value
        continue
      }
      const list = Array.isArray(value?.list) ? value.list : []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const messages = Array.isArray(item.messages) ? item.messages.filter((m: any) => m && typeof m === 'object') : []
        const sessionId = typeof item.sessionId === 'string' && item.sessionId ? item.sessionId : ''
        if (!sessionId || !messages.length) continue
        const prev = byId.get(sessionId)
        const next: Entry = {
          sessionId,
          title: typeof item.title === 'string' ? item.title : prev?.title,
          name: typeof item.name === 'string' ? item.name : prev?.name,
          createdAt: toMs(item.createdAt) || prev?.createdAt,
          updatedAt: toMs(item.updatedAt) || prev?.updatedAt,
          messages: messages.length >= (prev?.messages.length || 0) ? messages : prev!.messages,
        }
        byId.set(sessionId, next)
      }
    }
    return { full: [...byId.values()], inputHistory }
  } catch {
    return { full: [], inputHistory: [] }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function messageText(m: any): { role: 'user' | 'assistant'; text: string; at?: number } | null {
  const role = m?.role
  if (role !== 'user' && role !== 'assistant') return null
  let text = textOf(m.content).trim()
  // Builder 会话的 assistant.content 常为空，最终回答在 agentTaskContent.proposal
  if (!text && role === 'assistant' && typeof m.agentTaskContent?.proposal === 'string') {
    text = cleanUserText(m.agentTaskContent.proposal).trim()
  }
  if (!text) return null
  return { role, text, at: toMs(m.timestamp) || undefined }
}

function metaOf(dir: string, dbPath: string, entry: Entry, cwd: string | null, size: number): SessionMeta {
  let firstUser = ''
  let lastUser = ''
  let turns = 0
  let bubbles = 0
  let assistantTexts = 0
  let model: string | null = null
  let firstAt: number | null = null
  let lastAt: number | null = null
  for (const m of entry.messages) {
    const t = messageText(m)
    if (!t) continue
    bubbles++
    if (t.role === 'assistant') assistantTexts++
    if (!model) {
      const mm = m.modelInfo
      const name = mm?.display_model_name || mm?.displayModelName || m.modelName || m.displayModelName
      if (typeof name === 'string') model = name
    }
    if (t.at) {
      if (firstAt === null || t.at < firstAt) firstAt = t.at
      if (lastAt === null || t.at > lastAt) lastAt = t.at
    }
    if (t.role === 'user' && !isInjected(t.text)) {
      turns++
      lastUser = t.text
      if (!firstUser) firstUser = t.text
    }
  }
  const repo = cwd ? gitRoot(cwd) : null
  const title = plain(entry.title || entry.name || firstUser, 70) || '(空会话)'
  return {
    key: `trae:${entry.sessionId}`,
    agent: 'trae',
    agentLabel: 'Trae',
    id: entry.sessionId,
    title,
    preview: plain(lastUser, 140),
    cwd,
    repo,
    project: projectName(repo || cwd),
    startedAt: entry.createdAt || firstAt || statOf(dbPath)?.mtimeMs || null,
    updatedAt: entry.updatedAt || lastAt || statOf(dbPath)?.mtimeMs || null,
    turns,
    bubbles,
    model,
    branch: null,
    source: dbPath,
    size,
    extra: { variant: 'state', sessionId: entry.sessionId, partial: assistantTexts === 0 },
  }
}

function historyMeta(dir: string, dbPath: string, inputs: any[], cwd: string | null, size: number): SessionMeta | null {
  const texts = inputs
    .map((x) => (typeof x?.inputText === 'string' ? cleanUserText(x.inputText).trim() : ''))
    .filter(Boolean)
  if (!texts.length) return null
  const hash = path.basename(dir)
  const repo = cwd ? gitRoot(cwd) : null
  const st = statOf(dbPath)
  return {
    key: `trae:history-${hash}`,
    agent: 'trae',
    agentLabel: 'Trae',
    id: `history-${hash}`,
    title: `${projectName(repo || cwd) || hash} · Trae 输入历史（无 AI 回复）`,
    preview: plain(texts[texts.length - 1], 140),
    cwd,
    repo,
    project: projectName(repo || cwd),
    startedAt: st ? st.mtimeMs : null,
    updatedAt: st ? st.mtimeMs : null,
    turns: texts.length,
    bubbles: texts.length,
    model: null,
    branch: null,
    source: dbPath,
    size,
    extra: { variant: 'input-history', partial: true },
  }
}

function workspaces(): string[] {
  const out: string[] = []
  for (const root of ROOTS) {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const db = path.join(root, e.name, 'state.vscdb')
      if (fs.existsSync(db)) out.push(path.join(root, e.name))
    }
  }
  return out
}

function list(_opts: ListOptions, ctx: AdapterCtx): SessionMeta[] {
  const cache = ctx.cache as FileCache
  const prev = cache.files || {}
  const next: Record<string, { stamp: string; metas: SessionMeta[] }> = {}
  const out: SessionMeta[] = []
  for (const dir of workspaces()) {
    const dbPath = path.join(dir, 'state.vscdb')
    const st = statOf(dbPath)
    if (!st) continue
    const stamp = `${st.mtimeMs}:${st.size}`
    const hit = prev[dbPath]
    let metas: SessionMeta[]
    if (hit && hit.stamp === stamp) metas = hit.metas
    else {
      const cwd = workspaceCwd(dir)
      const { full, inputHistory } = parseWorkspace(dbPath)
      metas = full.map((e) => metaOf(dir, dbPath, e, cwd, st.size))
      if (!metas.length) {
        const h = historyMeta(dir, dbPath, inputHistory, cwd, st.size)
        if (h) metas = [h]
      }
    }
    next[dbPath] = { stamp, metas }
    out.push(...metas)
  }
  cache.files = next
  return out
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const { full, inputHistory } = parseWorkspace(meta.source)
  const variant = meta.extra?.variant
  if (variant === 'input-history') {
    const turns = inputHistory
      .map((x) => (typeof x?.inputText === 'string' ? cleanUserText(x.inputText).trim() : ''))
      .filter(Boolean)
      .map((text) => ({ role: 'user' as const, text }))
    return opts.tail ? turns.slice(-opts.tail) : turns
  }
  const entry = full.find((e) => e.sessionId === meta.id)
  if (!entry) return []
  const turns: Turn[] = []
  for (const m of entry.messages) {
    const t = messageText(m)
    if (!t) continue
    turns.push({ role: t.role, text: t.text, at: t.at })
  }
  return opts.tail ? turns.slice(-opts.tail) : turns
}

export const traeAdapter: Adapter = {
  id: 'trae',
  label: 'Trae',
  available: () => workspaces().length > 0,
  sources: () => ROOTS,
  list,
  read,
  hint: 'Trae 新版 agent 库是 SQLCipher 加密的；本工具读 workspaceState 里的明文会话，读不到时退化为「仅输入历史」。',
}

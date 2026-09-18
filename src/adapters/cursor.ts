import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterCtx, ImagePart, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, cleanUserText, exists, gitRoot, isInjected, plain, projectName, readJsonFile } from '../util'
import { lit, openSqlite, type Db } from '../sqlite'

/**
 * Cursor：<User>/globalStorage/state.vscdb（SQLite）
 *
 *   composerHeaders(composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, value)
 *      value.name / value.subtitle / value.isDraft
 *   cursorDiskKV(key, value)：'composerData:<composerId>' 与 'bubbleId:<composerId>:<bubbleId>'
 *      bubble: type '1'=用户 '2'=助手，text，images: [{...}]
 *
 * ⚠️ Cursor 的库结构是内部实现、会随版本变。这里按「尽力读取」实现，
 *    路径可通过配置 cursor.db 覆盖；读不到会给出明确提示，而不是假装支持。
 */
const USER_DIR =
  process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Cursor', 'User')
      : path.join(HOME, '.config', 'Cursor', 'User')

const DB_FILE = process.env.ASS_CURSOR_DB || path.join(USER_DIR, 'globalStorage', 'state.vscdb')
const WS_DIR = path.join(USER_DIR, 'workspaceStorage')

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
  if (!exists(DB_FILE)) return false
  const d = db()
  if (!d) return false
  try {
    d.query(`select composerId from composerHeaders limit 1`)
    return true
  } catch {
    return false
  }
}

/** workspaceId → 仓库路径（workspaceStorage/<id>/workspace.json 里的 folder） */
function workspacePath(workspaceId: string): string | null {
  const f = path.join(WS_DIR, workspaceId, 'workspace.json')
  const j = readJsonFile<Record<string, string>>(f, {})
  const raw = j.folder || j.workspace
  if (!raw) return null
  return String(raw).replace(/^file:\/\//, '')
}

function list(_opts: ListOptions, _ctx: AdapterCtx): SessionMeta[] {
  const d = db()
  if (!d) return []
  let rows: Record<string, any>[] = []
  try {
    rows = d.query(
      `select composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, value
         from composerHeaders
        where ifnull(isArchived,0) = 0 and ifnull(isSubagent,0) = 0
        order by lastUpdatedAt desc`,
    )
  } catch {
    return []
  }
  const out: SessionMeta[] = []
  for (const r of rows) {
    let head: Record<string, any> = {}
    try {
      head = JSON.parse(String(r.value))
    } catch {
      /* ignore */
    }
    if (head.isDraft) continue
    const cwd = workspacePath(String(r.workspaceId || ''))
    const repo = cwd ? gitRoot(cwd) : null
    out.push({
      key: `cursor:${r.composerId}`,
      agent: 'cursor',
      agentLabel: 'Cursor',
      id: String(r.composerId),
      title: String(head.name || head.subtitle || '(未命名)'),
      preview: plain(String(head.subtitle || ''), 140),
      cwd,
      repo,
      project: projectName(repo || cwd),
      startedAt: Number(r.createdAt) || null,
      updatedAt: Number(r.lastUpdatedAt) || null,
      turns: 0,
      bubbles: 0,
      model: head.modelConfig?.modelName ? String(head.modelConfig.modelName) : null,
      branch: null,
      source: DB_FILE,
      size: 0,
    })
  }
  return out
}

interface BubbleRow {
  key: string
  value: string
}

function listBubbles(d: Db, composerId: string): BubbleRow[] {
  const rows = d.query<BubbleRow>(
    `select key, value from cursorDiskKV where key like ${lit(`bubbleId:${composerId}:%`)} order by key asc`,
  )
  return rows
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const d = db()
  if (!d) return []
  const rows = listBubbles(d, meta.id)
  const all: Turn[] = []
  for (const r of rows) {
    let b: Record<string, any>
    try {
      b = JSON.parse(r.value)
    } catch {
      continue
    }
    const role: Turn['role'] = String(b.type) === '1' ? 'user' : String(b.type) === '2' ? 'assistant' : 'system'
    if (role === 'system') continue
    const images: ImagePart[] = []
    for (const im of Array.isArray(b.images) ? b.images : []) {
      const url = im?.url || im?.data || im?.imageUrl
      if (typeof url === 'string') {
        const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(url)
        if (m) images.push({ mediaType: m[1] ?? 'image/png', base64: m[2] ?? '' })
      }
    }
    const text = cleanUserText(String(b.text || ''))
    if (!text && images.length === 0) continue
    if (role === 'user' && isInjected(text) && images.length === 0) continue
    all.push({ role, text, images: images.length ? images : undefined })
  }
  return opts.tail ? all.slice(-opts.tail) : all
}

export const cursorAdapter: Adapter = {
  id: 'cursor',
  label: 'Cursor',
  available,
  sources: () => [DB_FILE],
  list,
  read,
  hint: `Cursor 的会话存在 ${DB_FILE}（内部结构随版本变化）。读不到时可用 ASS_CURSOR_DB 指向自己的 state.vscdb。`,
}

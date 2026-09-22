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

/** displayPath 形如 `~/Desktop/work/x`（也可能是绝对路径） */
function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p
}

/**
 * workspaceId → 仓库路径。两个来源，缺一不可：
 *   ① `workspaceStorage/<id>/workspace.json` 的 folder —— 首选，最准；
 *   ② `state.vscdb` 里 `workspaceMetadata.entries` 的 displayPath —— 回退。
 *
 * 为什么必须有 ②：实测本机 63 条非空 Cursor 会话里，有 5 条的
 * `workspaceStorage/<id>/` 下**根本没有 workspace.json**（目录被清理、或会话来自旧版本）。
 * 只走 ① 的话这些会话 cwd/repo 全是 null，而 `listSessions` 按仓库过滤是
 * `sameRepo(s.repo, 目标) || sameRepo(s.cwd, 目标)` —— 两个都 null，
 * **永远匹配不上任何仓库**，于是在项目里彻底看不见，哪怕它就是在那个项目里聊的。
 */
function workspacePath(workspaceId: string, fallback: Map<string, string>): string | null {
  if (!workspaceId) return null
  const j = readJsonFile<Record<string, string>>(path.join(WS_DIR, workspaceId, 'workspace.json'), {})
  const raw = j.folder || j.workspace
  if (raw) return String(raw).replace(/^file:\/\//, '')
  return fallback.get(workspaceId) ?? null
}

/** 回退来源：state.vscdb 的 workspaceMetadata.entries。读一次，整轮 list 复用 */
function workspacePathFallback(d: Db): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const rows = d.query<{ value: string }>(
      `select value from ItemTable where key = 'workspaceMetadata.entries'`,
    )
    const raw = rows[0]?.value
    if (!raw) return out
    const parsed = JSON.parse(String(raw)) as { entries?: { workspaceId?: string; displayPath?: string }[] }
    for (const e of parsed.entries ?? []) {
      const wid = String(e.workspaceId ?? '')
      const p = String(e.displayPath ?? '')
      if (wid && p) out.set(wid, expandTilde(p))
    }
  } catch {
    /* 结构对不上就当没有 —— 回退机制不该让整个 adapter 挂掉 */
  }
  return out
}

/**
 * 每个 composer 的气泡数 / 用户轮次（一次聚合查询，别对 500 个会话各查一遍）。
 * key 形如 `bubbleId:<composerId>:<bubbleId>`，composerId 是 36 字符 uuid。
 * 轮次是**近似值**：Cursor 把消息类型存在 JSON 里（`"type":1` 是用户、`2` 是助手），
 * 没有独立的列，只能靠 LIKE 数，够用来排序和过滤，不保证 100% 精确。
 */
function bubbleStats(d: Db): Map<string, { bubbles: number; turns: number }> {
  const out = new Map<string, { bubbles: number; turns: number }>()
  try {
    const rows = d.query<{ cid: string; bubbles: number; turns: number }>(
      `select substr(key, 10, 36) as cid,
              count(*) as bubbles,
              sum(case when value like '%"type":1,%' then 1 else 0 end) as turns
         from cursorDiskKV
        where key like 'bubbleId:%'
        group by cid`,
    )
    for (const r of rows) out.set(String(r.cid), { bubbles: Number(r.bubbles) || 0, turns: Number(r.turns) || 0 })
  } catch {
    /* 结构对不上就当没有统计 */
  }
  return out
}

function list(_opts: ListOptions, _ctx: AdapterCtx): SessionMeta[] {
  const d = db()
  if (!d) return []
  const stats = bubbleStats(d)
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
  const wsFallback = workspacePathFallback(d) // 读一次，整轮复用
  for (const r of rows) {
    let head: Record<string, any> = {}
    try {
      head = JSON.parse(String(r.value))
    } catch {
      /* ignore */
    }
    if (head.isDraft) continue
    const cwd = workspacePath(String(r.workspaceId || ''), wsFallback)
    const repo = cwd ? gitRoot(cwd) : null
    const st = stats.get(String(r.composerId)) || { bubbles: 0, turns: 0 }
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
      turns: st.turns,
      bubbles: st.bubbles,
      model: head.modelConfig?.modelName ? String(head.modelConfig.modelName) : null,
      branch: null,
      source: DB_FILE,
      size: 0,
      extra: { workspaceId: String(r.workspaceId || '') },
    })
  }
  return out
}

/**
 * Cursor 把用户贴的图片存成**文件**：
 *   <Cursor User>/workspaceStorage/<workspaceId>/images/<imageUuid>-<other>.png
 * bubble 里只有 `{ uuid, dimension }`，所以这里按 uuid 前缀把真文件找出来。
 */
function imageIndex(workspaceId: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!workspaceId) return out
  const dir = path.join(WS_DIR, workspaceId, 'images')
  let files: string[] = []
  try {
    files = fs.readdirSync(dir)
  } catch {
    return out
  }
  for (const f of files) {
    const m = /^([0-9a-f-]{36})[-.]/i.exec(f)
    if (m?.[1]) out.set(m[1].toLowerCase(), path.join(dir, f))
  }
  return out
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
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
  const idx = imageIndex(String((meta.extra as Record<string, unknown> | undefined)?.workspaceId ?? ''))
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
        // 少数版本会直接内联 data URL
        const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(url)
        if (m) images.push({ mediaType: m[1] ?? 'image/png', base64: m[2] ?? '' })
        continue
      }
      // 常见情况：只给 uuid，真文件在 workspaceStorage/<id>/images/ 下
      const uuid = typeof im?.uuid === 'string' ? im.uuid.toLowerCase() : ''
      if (!uuid) continue
      const file = idx.get(uuid)
      if (!file) continue
      const ext = (path.extname(file).slice(1) || 'png').toLowerCase()
      images.push({ mediaType: EXT_MIME[ext] ?? 'image/png', path: file })
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

import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterCtx, ImagePart, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { cleanUserText, exists, gitRoot, isDir, isInjected, parseDataUrl, plain, projectName, readJsonl, statOf } from '../util'
import { expandPath, type CustomAgent } from '../config'
import { openSqlite } from '../sqlite'

/**
 * 自定义 agent（R5）：用户在自己的配置里声明「这是什么 agent、数据在哪、字段怎么取」。
 *
 * 两种形态：
 *   type: 'jsonl'  —— 一个目录（递归）里的 *.jsonl，每个文件 = 一个会话；
 *                     每条记录按 map 里的点号路径取字段。
 *   type: 'sqlite' —— 一条 SQL（query）返回所有消息行，列名与 map 的键同名，
 *                     按 id 列聚合成会话。
 */
function pick(obj: unknown, dotted: string | undefined): unknown {
  if (!dotted) return undefined
  let cur: any = obj
  for (const seg of dotted.split('.')) {
    if (cur == null) return undefined
    cur = cur[seg]
  }
  return cur
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
    const d = Date.parse(v)
    if (!Number.isNaN(d)) return d
  }
  return null
}

function makeMeta(cfg: CustomAgent, id: string, cwd: string | null, title: string, preview: string, t0: number | null, t1: number | null, source: string, size = 0): SessionMeta {
  const repo = cwd ? gitRoot(cwd) : null
  return {
    key: `${cfg.id}:${id}`,
    agent: cfg.id,
    agentLabel: cfg.label || cfg.id,
    id,
    title: title || '(空会话)',
    preview: plain(preview, 140),
    cwd,
    repo,
    project: projectName(repo || cwd),
    startedAt: t0,
    updatedAt: t1,
    turns: 0,
    bubbles: 0,
    model: null,
    branch: null,
    source,
    size,
  }
}

function jsonlFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  if (isDir(root)) walk(root, 0)
  else if (exists(root) && root.endsWith('.jsonl')) out.push(root)
  return out
}

export function makeCustomAdapter(cfg: CustomAgent): Adapter {
  const root = expandPath(cfg.path)
  const map = cfg.map || {}
  const idPath = map.id || 'sessionId'
  const cwdPath = map.cwd || 'cwd'
  const titlePath = map.title || 'title'
  const rolePath = map.role || 'role'
  const textPath = map.text || 'text'
  const imagePath = map.imageUrl || 'imageUrl'
  const tsPath = map.timestamp || 'timestamp'

  const isJsonl = cfg.type !== 'sqlite'

  return {
    id: cfg.id,
    label: cfg.label || cfg.id,
    hint: cfg.hint,
    available: () => (isJsonl ? exists(root) : exists(root)),
    sources: () => [root],

    list(_opts: ListOptions, _ctx: AdapterCtx): SessionMeta[] {
      if (!isJsonl) return sqliteList(cfg, root, idPath, cwdPath, titlePath, tsPath)
      const out: SessionMeta[] = []
      for (const file of jsonlFiles(root)) {
        let sid = '', cwd: string | null = null, title = '', firstUser = '', lastUser = ''
        let t0: number | null = null
        for (const rec of readJsonl(file)) {
          const v = pick(rec, idPath)
          if (!sid && v) sid = str(v)
          const c = pick(rec, cwdPath)
          if (!cwd && c) cwd = str(c)
          const ti = pick(rec, titlePath)
          if (!title && ti) title = str(ti)
          const role = str(pick(rec, rolePath))
          const text = cleanUserText(str(pick(rec, textPath)))
          if (role === 'user' && text && !isInjected(text)) {
            if (!firstUser) firstUser = text
            lastUser = text
            if (t0 === null) t0 = num(pick(rec, tsPath))
          }
        }
        const st = statOf(file)
        const meta = makeMeta(cfg, sid || path.basename(file, '.jsonl'), cwd, title || plain(firstUser, 70), lastUser, t0, st ? st.mtimeMs : null, file, st?.size ?? 0)
        out.push(meta)
      }
      return out
    },

    read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
      if (!isJsonl) return sqliteRead(cfg, root, meta.id, idPath, rolePath, textPath, imagePath, tsPath, opts)
      const turns: Turn[] = []
      for (const rec of readJsonl(meta.source)) {
        const role = str(pick(rec, rolePath))
        if (role !== 'user' && role !== 'assistant') continue
        const text = cleanUserText(str(pick(rec, textPath)))
        const imgRaw = pick(rec, imagePath)
        const images: ImagePart[] = []
        const parsed = parseDataUrl(typeof imgRaw === 'string' ? imgRaw : '')
        if (parsed && parsed.base64) images.push({ mediaType: parsed.mediaType, base64: parsed.base64 })
        if (!text && images.length === 0) continue
        if (role === 'user' && isInjected(text) && images.length === 0) continue
        turns.push({ role: role as Turn['role'], text, at: num(pick(rec, tsPath)) ?? undefined, images: images.length ? images : undefined })
      }
      return opts.tail ? turns.slice(-opts.tail) : turns
    },

    resumeCmd: cfg.resumeCmd ? () => cfg.resumeCmd as string : undefined,
  }
}

function sqliteList(cfg: CustomAgent, file: string, idPath: string, cwdPath: string, titlePath: string, tsPath: string): SessionMeta[] {
  if (!cfg.query) return []
  const r = openSqlite(file)
  if (!r.db) return []
  let rows: Record<string, any>[] = []
  try {
    rows = r.db.query(cfg.query)
  } catch {
    return []
  } finally {
    r.db.close()
  }
  const byId = new Map<string, Record<string, any>[]>()
  for (const row of rows) {
    const sid = str(row[idPath] ?? row.id)
    const arr = byId.get(sid)
    if (arr) arr.push(row)
    else byId.set(sid, [row])
  }
  const out: SessionMeta[] = []
  for (const [sid, group] of byId) {
    let cfgCwd: string | null = null
    let title = ''
    let preview = ''
    let t0: number | null = null
    let t1: number | null = null
    for (const g of group) {
      const c = g[cwdPath]
      if (!cfgCwd && c) cfgCwd = str(c)
      const ti = g[titlePath]
      if (!title && ti) title = str(ti)
      if (str(g.role) === 'user') {
        const t = str(g.text)
        if (t && !t.trimStart().startsWith('<')) {
          if (!preview) preview = t
          t1 = num(g[tsPath]) ?? t1
        }
      }
      t0 = t0 ?? num(g[tsPath]) ?? null
    }
    out.push(makeMeta(cfg, sid, cfgCwd, title, preview, t0, t1, file))
  }
  return out
}

function sqliteRead(cfg: CustomAgent, file: string, sessionId: string, idPath: string, rolePath: string, textPath: string, imagePath: string, tsPath: string, opts: ReadOptions): Turn[] {
  if (!cfg.query) return []
  const r = openSqlite(file)
  if (!r.db) return []
  let rows: Record<string, any>[] = []
  try {
    rows = r.db.query(cfg.query)
  } catch {
    return []
  } finally {
    r.db.close()
  }
  const turns: Turn[] = []
  for (const row of rows) {
    if (str(row[idPath] ?? row.id) !== sessionId) continue
    const role = str(row[rolePath])
    if (role !== 'user' && role !== 'assistant') continue
    const text = str(row[textPath])
    const images: ImagePart[] = []
    const parsed = parseDataUrl(row[imagePath])
    if (parsed && parsed.base64) images.push({ mediaType: parsed.mediaType, base64: parsed.base64 })
    if (!text && images.length === 0) continue
    turns.push({ role: role as Turn['role'], text, at: num(row[tsPath]) ?? undefined, images: images.length ? images : undefined })
  }
  return opts.tail ? turns.slice(-opts.tail) : turns
}

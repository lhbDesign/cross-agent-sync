import path from 'node:path'
import type { Adapter, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { CACHE_DIR, loadConfig, type Config } from '../config'
import { buildAdapters } from '../adapters/registry'
import { errMsg, gitRoot, plain, readJsonFile, realpath, sameRepo, writeJsonFile } from '../util'

const CACHE_FILE = path.join(CACHE_DIR, 'index.json')
const CACHE_VERSION = 2

interface CacheFile {
  version: number
  agents: Record<string, Record<string, unknown>>
  /** 上一次列表的顺序，供 `#3` 这种引用用 */
  lastList: string[]
}

function loadCache(opts: { noCache?: boolean } = {}): CacheFile {
  if (opts.noCache) return { version: CACHE_VERSION, agents: {}, lastList: [] }
  const c = readJsonFile<CacheFile>(CACHE_FILE, { version: 0, agents: {}, lastList: [] })
  if (!c || c.version !== CACHE_VERSION) return { version: CACHE_VERSION, agents: {}, lastList: [] }
  c.agents = c.agents || {}
  c.lastList = c.lastList || []
  return c
}

function saveCache(c: CacheFile): void {
  try {
    writeJsonFile(CACHE_FILE, c)
  } catch {
    /* 缓存写不了不影响功能 */
  }
}

export interface ListResult {
  sessions: SessionMeta[]
  errors: string[]
  adapters: Adapter[]
}

/**
 * 列出所有可用 agent 的会话，按仓库/时间过滤后排序。
 * 索引结果带 mtime 缓存（换 agent 时热启动基本是秒开）。
 */
export function listSessions(opts: ListOptions = {}, cfg: Config = loadConfig()): ListResult {
  const cache = loadCache(opts)
  const adapters = buildAdapters(cfg, { only: opts.agent })
  const errors: string[] = []
  const all: SessionMeta[] = []

  for (const a of adapters) {
    try {
      const slot = cache.agents[a.id] || (cache.agents[a.id] = {})
      const sessions = a.list(opts, { cache: slot })
      cache.agents[a.id] = slot
      all.push(...sessions)
    } catch (e) {
      errors.push(`${a.id}: ${errMsg(e)}`)
    }
  }

  // 去重（同一 key 只留一份）
  const seen = new Set<string>()
  let out = all.filter((s) => {
    if (!s?.key || seen.has(s.key)) return false
    seen.add(s.key)
    return true
  })

  // 仓库过滤
  const target = opts.repo ? (gitRoot(opts.repo) ?? realpath(opts.repo)) : null
  if (target && !opts.includeAll) {
    out = out.filter((s) => sameRepo(s.repo, target) || sameRepo(s.cwd, target))
  } else if (!opts.includeAll && !opts.repo) {
    // 没指定仓库又不要求全部时：不过滤（由调用方决定展示），但把没时间的丢掉
    out = out.filter((s) => s.updatedAt || s.startedAt)
  }

  out = out.filter((s) => {
    // 空会话（没有任何用户轮次和回复）不展示，避免列表被噪音淹没
    if ((s.turns || 0) === 0 && (s.bubbles || 0) === 0) return false
    if (opts.minTurns && (s.turns || 0) < opts.minTurns) return false
    if (opts.since && (s.updatedAt || 0) < opts.since) return false
    return true
  })

  out.sort((a, b) => (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0))
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit)

  cache.lastList = out.map((s) => s.key)
  saveCache(cache)

  return { sessions: out, errors, adapters }
}

/** 各 adapter 的可用性 + 数据源（`ass agents` / `ass doctor` 用） */
export function agentStatus(cfg: Config = loadConfig()): {
  adapter: Adapter
  available: boolean
  found: number
  error?: string
}[] {
  const out: { adapter: Adapter; available: boolean; found: number; error?: string }[] = []
  for (const a of buildAdapters(cfg, { includeUnavailable: true })) {
    let available = false
    let found = 0
    let error: string | undefined
    try {
      available = a.available()
      if (available) found = a.list({}, { cache: {} }).length
    } catch (e) {
      error = errMsg(e)
    }
    out.push({ adapter: a, available, found, error })
  }
  return out
}

/**
 * 解析会话引用：
 *   `#3`             → 上一次列表的第 3 条
 *   `claude:31c5af`  → agent + id 前缀
 *   `31c5af10`       → id 前缀（唯一时）
 *   `点击穿透`        → 标题/预览里包含这段文字
 */
export function resolveRef(ref: string, sessions: SessionMeta[], lastList: string[] = []): SessionMeta | null {
  const r = ref.trim()
  if (!r) return null

  const hash = /^#(\d+)$/.exec(r)
  if (hash && lastList.length) {
    const key = lastList[Number(hash[1]) - 1]
    const hit = sessions.find((s) => s.key === key)
    if (hit) return hit
    // 列表被过滤过时，lastList 可能不在当前集合里；先返回 null 让调用方决定
    return null
  }

  const withAgent = /^([a-z0-9_-]+):(.+)$/i.exec(r)
  const candidates = sessions.filter((s) => {
    if (withAgent) {
      const [, agent, rest] = withAgent
      return s.agent.toLowerCase() === String(agent).toLowerCase() && s.id.startsWith(String(rest))
    }
    return s.id.startsWith(r)
  })
  if (candidates.length === 1) return candidates[0] ?? null
  if (candidates.length > 1) {
    // 取最近更新的那个
    return candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] ?? null
  }

  const byText = sessions.filter((s) => s.title.includes(r) || s.preview.includes(r))
  if (byText.length) return byText.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] ?? null
  return null
}

export interface FoundSession {
  meta: SessionMeta
  adapter: Adapter
}

/** 在所有 adapter 里定位一个会话（先按 key 直接找，找不到再全量列表 + resolveRef） */
export function findSession(ref: string, cfg: Config = loadConfig()): FoundSession | null {
  const adapters = buildAdapters(cfg, { includeUnavailable: true })
  const cache = loadCache()

  // 1. 看起来像 `agent:...` 的，只问那个 adapter
  const m = /^([a-z0-9_-]+):(.+)$/i.exec(ref.trim())
  if (m) {
    const a = adapters.find((x) => x.id.toLowerCase() === String(m[1]).toLowerCase())
    if (a) {
      try {
        const slot = cache.agents[a.id] || (cache.agents[a.id] = {})
        const list = a.list({ includeAll: true }, { cache: slot })
        cache.agents[a.id] = slot
        saveCache(cache)
        const hit = list.find((s) => s.id === m[2]) || list.find((s) => s.id.startsWith(String(m[2])))
        if (hit) return { meta: hit, adapter: a }
      } catch {
        /* 落到下面的全量查找 */
      }
    }
  }

  // 2. 全量列表 + 引用解析
  const { sessions } = listSessions({ includeAll: true }, cfg)
  const meta = resolveRef(ref, sessions, loadCache().lastList)
  if (!meta) return null
  const adapter = adapters.find((a) => a.id === meta.agent)
  if (!adapter) return null
  return { meta, adapter }
}

export function readSession(found: FoundSession, opts: ReadOptions = {}): Turn[] {
  return found.adapter.read(found.meta, opts)
}

export function describeSession(s: SessionMeta): string {
  const when = s.updatedAt ? new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '—'
  return `${s.agent}:${s.id.slice(0, 8)}  ${when}  ${plain(s.title, 60)}`
}

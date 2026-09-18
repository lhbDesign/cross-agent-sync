import type { SessionMeta } from '../types'
import { loadConfig, type Config } from '../config'
import { fmtTime, plain } from '../util'
import { findSession, listSessions, readSession } from './store'

/**
 * 跨 agent 全文搜索：在最近 N 个会话的消息正文里找关键词。
 * 用于「我记得在哪儿讨论过这个，但想不起来是哪个 agent」。
 */
export interface SearchHit {
  meta: SessionMeta
  snippets: string[]
}

export interface SearchResult {
  hits: SearchHit[]
  scanned: number
  query: string
}

export interface SearchOptions {
  repo?: string | null
  allRepos?: boolean
  limit?: number
  scan?: number
}

export function searchSessions(query: string, opts: SearchOptions = {}, cfg: Config = loadConfig()): SearchResult {
  const q = String(query || '').trim()
  if (!q) return { hits: [], scanned: 0, query: q }
  const needle = q.toLowerCase()
  const scan = Math.max(1, Number(opts.scan) || 60)
  const limit = Math.max(1, Number(opts.limit) || 8)

  const { sessions } = listSessions(
    { repo: opts.allRepos ? null : (opts.repo ?? null), includeAll: opts.allRepos, limit: 0, noCache: false },
    cfg,
  )

  const hits: SearchHit[] = []
  let scanned = 0
  for (const s of sessions.slice(0, scan)) {
    scanned++
    let turns
    try {
      const found = findSession(s.key, cfg)
      if (!found) continue
      turns = readSession(found)
    } catch {
      continue
    }
    const matched = turns.filter((t) => t.text && t.text.toLowerCase().includes(needle))
    if (!matched.length) continue
    const snippets = matched.slice(0, 3).map((t) => {
      const at = Math.max(0, t.text.toLowerCase().indexOf(needle))
      const head = t.role === 'user' ? '🧑' : '🤖'
      return `${head} …${plain(t.text.slice(at - 80 < 0 ? 0 : at - 80, at + 200), 260)}…`
    })
    hits.push({ meta: s, snippets })
    if (hits.length >= limit) break
  }
  return { hits, scanned, query: q }
}

export function formatSearchResult(r: SearchResult): string {
  if (!r.query) return '需要一个搜索关键词。'
  if (!r.hits.length) return `在最近 ${r.scanned} 个会话里没有找到 “${r.query}”。`
  const blocks = r.hits.map(
    (h) =>
      `**[${h.meta.agentLabel}] ${h.meta.title}**\n   key: \`${h.meta.key}\` · ${fmtTime(h.meta.updatedAt)}\n${h.snippets
        .map((s) => `   ${s}`)
        .join('\n')}`,
  )
  return `命中 ${r.hits.length} 个会话（扫描了最近 ${r.scanned} 个）：\n\n${blocks.join('\n\n')}`
}

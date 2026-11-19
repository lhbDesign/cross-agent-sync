import type { SessionMeta } from '../types'
import { loadConfig, type Config } from '../config'
import { fmtTime, plain } from '../util'
import { findSession, listSessions, readSession } from './store'

/**
 * 跨 agent 搜索：在最近 N 个会话的标题、预览和消息正文里找关键词。
 * 用于「我记得在哪儿讨论过这个，但想不起来是哪个 agent」。
 */
export interface SearchHit {
  meta: SessionMeta
  snippets: string[]
}

export interface SearchResult {
  hits: SearchHit[]
  scanned: number
  total: number
  query: string
}

export interface SearchProgress {
  scanned: number
  total: number
  hits: number
}

export interface SearchOptions {
  repo?: string | null
  allRepos?: boolean
  /** 只搜某个 agent（如 claude / cursor） */
  agent?: string
  limit?: number
  scan?: number
  /** 每扫完一个会话回调一次（CLI `--progress` / 桌面进度条） */
  onProgress?: (p: SearchProgress) => void
}

function snippetLine(role: 'user' | 'assistant' | 'title' | 'preview', text: string): string {
  if (role === 'title') return `🏷️ 标题：${plain(text, 260)}`
  if (role === 'preview') return `📝 最近消息：${plain(text, 260)}`
  const head = role === 'user' ? '🧑' : '🤖'
  return `${head} ${plain(text, 260)}`
}

function excerptAround(text: string, needle: string): string {
  const at = Math.max(0, text.toLowerCase().indexOf(needle))
  const start = Math.max(0, at - 80)
  const end = Math.min(text.length, at + 200)
  const chunk = text.slice(start, end)
  return `${start > 0 ? '…' : ''}${chunk}${end < text.length ? '…' : ''}`
}

export function searchSessions(query: string, opts: SearchOptions = {}, cfg: Config = loadConfig()): SearchResult {
  const q = String(query || '').trim()
  if (!q) return { hits: [], scanned: 0, total: 0, query: q }
  const needle = q.toLowerCase()
  const scan = Math.max(1, Number(opts.scan) || 60)
  const limit = Math.max(1, Number(opts.limit) || 8)

  const { sessions } = listSessions(
    {
      repo: opts.allRepos ? null : (opts.repo ?? null),
      includeAll: opts.allRepos,
      limit: 0,
      noCache: false,
      preserveLastList: true,
      agent: opts.agent || undefined,
    },
    cfg,
  )

  const pool = sessions.slice(0, scan)
  const total = pool.length
  const hits: SearchHit[] = []
  let scanned = 0

  opts.onProgress?.({ scanned: 0, total, hits: 0 })

  for (const s of pool) {
    scanned++
    const snippets: string[] = []
    if (s.title.toLowerCase().includes(needle)) snippets.push(snippetLine('title', s.title))
    if (s.preview.toLowerCase().includes(needle) && s.preview !== s.title) {
      snippets.push(snippetLine('preview', s.preview))
    }
    let turns
    try {
      const found = findSession(s.key, cfg)
      if (!found) {
        if (snippets.length) hits.push({ meta: s, snippets })
        opts.onProgress?.({ scanned, total, hits: hits.length })
        if (hits.length >= limit) break
        continue
      }
      turns = readSession(found)
    } catch {
      if (snippets.length) hits.push({ meta: s, snippets })
      opts.onProgress?.({ scanned, total, hits: hits.length })
      if (hits.length >= limit) break
      continue
    }
    const matched = turns.filter((t) => t.text && t.text.toLowerCase().includes(needle))
    // 正文最多留 4 条，方便桌面高亮多行
    const room = Math.max(0, 6 - snippets.length)
    snippets.push(
      ...matched.slice(0, Math.min(4, room)).map((t) =>
        snippetLine(t.role === 'user' ? 'user' : 'assistant', excerptAround(t.text, needle)),
      ),
    )
    if (snippets.length) hits.push({ meta: s, snippets })
    opts.onProgress?.({ scanned, total, hits: hits.length })
    if (hits.length >= limit) break
  }

  return { hits, scanned, total, query: q }
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

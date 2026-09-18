import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterCtx, ImagePart, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, cleanUserText, gitRoot, isDir, isInjected, plain, projectName, readJsonl, readJsonlTail, statOf } from '../util'

/**
 * Claude Code：~/.claude/projects/<cwd-slug>/<uuid>.jsonl
 *
 * 图片：用户消息 content 里就是 base64 内联
 *   { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
 */
/** 数据源可用 ASS_CLAUDE_DIR 覆盖（测试 / 非默认安装位置） */
const ROOT = process.env.ASS_CLAUDE_DIR || path.join(HOME, '.claude', 'projects')

interface FileCache {
  files?: Record<string, { stamp: string; meta: SessionMeta }>
}

function available(): boolean {
  return isDir(ROOT)
}

/** 用户消息里的文本 + 图片（跳过 tool_result / 系统注入） */
function userParts(content: unknown): { text: string; images: ImagePart[] } {
  const images: ImagePart[] = []
  const texts: string[] = []
  if (typeof content === 'string') return { text: content, images }
  if (!Array.isArray(content)) return { text: '', images }
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    const blk = b as Record<string, any>
    if (blk.type === 'text' && typeof blk.text === 'string') {
      const cleaned = cleanUserText(blk.text)
      if (cleaned) texts.push(cleaned)
    }
    else if (blk.type === 'image' && blk.source && blk.source.type === 'base64' && blk.source.data) {
      images.push({ mediaType: String(blk.source.media_type || 'image/png'), base64: String(blk.source.data) })
    }
  }
  return { text: texts.join('\n'), images }
}

function isHumanUser(rec: Record<string, any>): boolean {
  const c = rec.message?.content
  const toolResult = Array.isArray(c) && c.some((b: any) => b && b.type === 'tool_result')
  if (toolResult) return false
  if (rec.isSidechain) return false
  if (rec.origin) return rec.origin.kind === 'human'
  return true
}

function parseFile(file: string): SessionMeta {
  const sessionId = path.basename(file, '.jsonl')
  let cwd: string | null = null
  let branch: string | null = null
  let title: string | null = null
  let model: string | null = null
  let startedAt: number | null = null
  let firstUser: string | null = null
  let lastUser: string | null = null
  let turns = 0
  let bubbles = 0

  for (const rec of readJsonl(file)) {
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
    if (!branch && typeof rec.gitBranch === 'string') branch = rec.gitBranch
    if (!startedAt && rec.timestamp) startedAt = Date.parse(rec.timestamp) || null
    if (rec.type === 'ai-title' && rec.aiTitle && !title) title = String(rec.aiTitle)
    if (rec.type === 'assistant' && !model && rec.message?.model) model = String(rec.message.model)
    if (rec.type === 'user' && isHumanUser(rec)) {
      const { text } = userParts(rec.message?.content)
      if (text && !isInjected(text)) {
        turns++
        bubbles++
        lastUser = text
        if (!firstUser) firstUser = text
      }
    } else if (rec.type === 'assistant') {
      bubbles++
    }
  }

  const st = statOf(file)
  const repo = cwd ? gitRoot(cwd) : null
  return {
    key: `claude:${sessionId}`,
    agent: 'claude',
    agentLabel: 'Claude Code',
    id: sessionId,
    title: title || (firstUser ? plain(firstUser, 70) : '(空会话)'),
    preview: plain(lastUser, 140),
    cwd,
    repo,
    project: projectName(repo || cwd),
    startedAt,
    updatedAt: st ? st.mtimeMs : startedAt,
    turns,
    bubbles,
    model,
    branch,
    source: file,
    size: st ? st.size : 0,
  }
}

function list(_opts: ListOptions, ctx: AdapterCtx): SessionMeta[] {
  const cache = ctx.cache as FileCache
  const prev = cache.files || {}
  const next: Record<string, { stamp: string; meta: SessionMeta }> = {}
  const out: SessionMeta[] = []
  let dirs: fs.Dirent[] = []
  try {
    dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return []
  }
  for (const d of dirs) {
    const dir = path.join(ROOT, d.name)
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const full = path.join(dir, f)
      const st = statOf(full)
      if (!st || st.size === 0) continue
      const stamp = `${Math.round(st.mtimeMs)}:${st.size}`
      const hit = prev[full]
      const meta = hit && hit.stamp === stamp ? hit.meta : parseFile(full)
      next[full] = { stamp, meta }
      out.push(meta)
    }
  }
  cache.files = next
  return out
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const turns: Turn[] = []
  const iter = opts.tail ? readJsonlTail(meta.source, Math.max(1 << 20, opts.tail * 4096)) : readJsonl(meta.source)
  for (const rec of iter) {
    if (rec.type === 'user' && isHumanUser(rec)) {
      const { text, images } = userParts(rec.message?.content)
      if (!text && images.length === 0) continue
      if (text && isInjected(text) && images.length === 0) continue
      turns.push({ role: 'user', text, at: Date.parse(rec.timestamp) || undefined, images: images.length ? images : undefined })
    } else if (rec.type === 'assistant') {
      const blocks: any[] = rec.message?.content || []
      const parts: string[] = []
      for (const b of blocks) {
        if (!b) continue
        if (b.type === 'text' && b.text) parts.push(String(b.text))
        else if (b.type === 'tool_use') parts.push(`▸ ${b.name}: ${toolSummary(b.input)}`)
      }
      const text = parts.join('\n').trim()
      if (text) turns.push({ role: 'assistant', text, at: Date.parse(rec.timestamp) || undefined })
    }
  }
  return opts.tail ? turns.slice(-opts.tail) : turns
}

function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.file_path || o.path || o.notebook_path || o.pattern || o.command || o.description || o.url
  return typeof v === 'string' ? plain(v, 100) : ''
}

export const claudeAdapter: Adapter = {
  id: 'claude',
  label: 'Claude Code',
  available,
  sources: () => [ROOT],
  list,
  read,
  resumeCmd: (m) => `claude --resume ${m.id}`,
}

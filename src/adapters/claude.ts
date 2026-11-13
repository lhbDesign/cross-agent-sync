import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterCtx, ImagePart, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, cleanUserText, gitRoot, isDir, isInjected, plain, projectName, readJsonFile, readJsonl, readJsonlTail, statOf } from '../util'
import { sessionTitle } from './title'

/**
 * Claude Code：~/.claude/projects/<cwd-slug>/<uuid>.jsonl
 *
 * 图片：用户消息 content 里就是 base64 内联
 *   { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
 *
 * 这个解析器同时被 CodeBuddy / Qoder 复用：两者的 CLI 会话也是
 * `projects/<slug>/<session>.jsonl`，记录形状与 Claude 兼容。
 */
const DEFAULT_ROOT = process.env.ASS_CLAUDE_DIR || path.join(HOME, '.claude', 'projects')

interface FileCache {
  files?: Record<string, { stamp: string; meta: SessionMeta }>
}

export interface ClaudeFamilyOptions {
  id: string
  label: string
  /** 一个或多个 projects 根目录 */
  roots: string[]
  resumeCmd?: (meta: SessionMeta) => string
  hint?: string
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
  // isMeta = harness 自己注入的内容（skill 全文、图片显示副本等），不是用户说的话。
  // 以前只查了 isSidechain 漏了这个，于是 `ass inputs` 会把整篇 skill 当成「用户的第 3 条输入」。
  // 实测图片的 isMeta 记录只是显示副本，真实那条用户消息本来就带内联图片，过滤掉不丢数据。
  if (rec.isMeta) return false
  if (rec.origin) return rec.origin.kind === 'human'
  return true
}

function parseFile(file: string, opts: ClaudeFamilyOptions): SessionMeta {
  const sessionId = path.basename(file, '.jsonl')
  let cwd: string | null = null
  let branch: string | null = null
  let title: string | null = null
  let customTitle = ''
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
    if (!rec.sessionId || rec.sessionId === sessionId) {
      if (rec.type === 'ai-title' && sessionTitle(rec.aiTitle)) title = sessionTitle(rec.aiTitle)
      if (rec.type === 'custom-title' && sessionTitle(rec.customTitle)) customTitle = sessionTitle(rec.customTitle)
    }
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
    key: `${opts.id}:${sessionId}`,
    agent: opts.id,
    agentLabel: opts.label,
    id: sessionId,
    title: customTitle || title || (firstUser ? plain(firstUser, 70) : '(空会话)'),
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
    extra: { customTitle, aiTitle: title },
  }
}

/** 一个 projects 根下可能既有 <slug>/<id>.jsonl，也可能直接放 <id>.jsonl */
function jsonlFiles(root: string): { file: string; names: Map<string, string> }[] {
  const out: { file: string; names: Map<string, string> }[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: path.join(root, e.name), names: new Map() })
    else if (!e.isDirectory()) continue
    else {
      const dir = path.join(root, e.name)
      const index = readJsonFile<{ entries?: unknown } | null>(path.join(dir, 'sessions-index.json'), null)
      const names = new Map<string, string>()
      if (Array.isArray(index?.entries)) {
        for (const entry of index.entries) {
          if (!entry || typeof entry.sessionId !== 'string') continue
          const title = sessionTitle(entry.customTitle) || sessionTitle(entry.summary)
          if (title) names.set(entry.sessionId, title)
        }
      }
      let files: string[] = []
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const f of files) out.push({ file: path.join(dir, f), names })
    }
  }
  return out
}

export function makeClaudeFamilyAdapter(opts: ClaudeFamilyOptions): Adapter {
  const roots = opts.roots.filter(Boolean)

  function available(): boolean {
    return roots.some((r) => isDir(r))
  }

  function list(_opts: ListOptions, ctx: AdapterCtx): SessionMeta[] {
    const cache = ctx.cache as FileCache
    const prev = cache.files || {}
    const next: Record<string, { stamp: string; meta: SessionMeta }> = {}
    const out: SessionMeta[] = []
    for (const root of roots) {
      for (const { file, names } of jsonlFiles(root)) {
        const st = statOf(file)
        if (!st || st.size === 0) continue
        const stamp = `titles-v1:${st.mtimeMs}:${st.size}`
        const hit = prev[file]
        const meta = hit && hit.stamp === stamp ? hit.meta : parseFile(file, opts)
        next[file] = { stamp, meta }
        out.push({ ...meta, title: sessionTitle(meta.extra?.customTitle) || sessionTitle(meta.extra?.aiTitle) || names.get(meta.id) || meta.title })
      }
    }
    cache.files = next
    return out
  }

  function read(meta: SessionMeta, readOpts: ReadOptions = {}): Turn[] {
    const turns: Turn[] = []
    const iter = readOpts.tail ? readJsonlTail(meta.source, Math.max(1 << 20, readOpts.tail * 4096)) : readJsonl(meta.source)
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
    return readOpts.tail ? turns.slice(-readOpts.tail) : turns
  }

  const adapter: Adapter = {
    id: opts.id,
    label: opts.label,
    available,
    sources: () => roots,
    list,
    read,
  }
  if (opts.resumeCmd) adapter.resumeCmd = opts.resumeCmd
  if (opts.hint) adapter.hint = opts.hint
  return adapter
}

function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.file_path || o.path || o.notebook_path || o.pattern || o.command || o.description || o.url
  return typeof v === 'string' ? plain(v, 100) : ''
}

export const claudeAdapter: Adapter = makeClaudeFamilyAdapter({
  id: 'claude',
  label: 'Claude Code',
  roots: [DEFAULT_ROOT],
  resumeCmd: (m) => `claude --resume ${m.id}`,
})

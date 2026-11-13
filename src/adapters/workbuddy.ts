import fs from 'node:fs'
import path from 'node:path'
import type { Adapter, AdapterCtx, ImagePart, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, cleanUserText, gitRoot, isDir, isInjected, plain, projectName, readJsonl, readJsonlTail, statOf } from '../util'

/**
 * WorkBuddy（腾讯）：~/.workbuddy/projects/<slug>/<session-id>.jsonl
 *
 * 每行是一个事件：
 *   { type: "message", role: "user"|"assistant", content: string | Block[], timestamp, sessionId, cwd }
 *   { type: "reasoning" | "function_call" | "function_call_result" | "ai-title" | ... }
 *
 * 国际版 WorkBuddy AI 用独立目录 ~/.workbuddy-ai/projects，两边的会话不自动合并。
 * 可用 WORKBUDDY_CONFIG_DIR / ASS_WORKBUDDY_DIR 覆盖。
 */
const CONFIG_DIR = process.env.ASS_WORKBUDDY_HOME || process.env.WORKBUDDY_CONFIG_DIR || path.join(HOME, '.workbuddy')
const ROOTS = [
  process.env.ASS_WORKBUDDY_DIR,
  path.join(CONFIG_DIR, 'projects'),
  path.join(HOME, '.workbuddy-ai', 'projects'),
].filter((x): x is string => Boolean(x))

interface FileCache {
  files?: Record<string, { stamp: string; meta: SessionMeta }>
}

function textOf(content: unknown): { text: string; images: ImagePart[] } {
  const images: ImagePart[] = []
  const texts: string[] = []
  if (typeof content === 'string') return { text: cleanUserText(content), images }
  if (!Array.isArray(content)) return { text: '', images }
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    const blk = b as Record<string, any>
    if (blk.type === 'text' && typeof blk.text === 'string') {
      const cleaned = cleanUserText(blk.text)
      if (cleaned) texts.push(cleaned)
    } else if (blk.type === 'image' && blk.source?.type === 'base64' && blk.source?.data) {
      images.push({ mediaType: String(blk.source.media_type || 'image/png'), base64: String(blk.source.data) })
    }
  }
  return { text: texts.join('\n'), images }
}

function stampOf(file: string): string | null {
  const st = statOf(file)
  return st ? `${st.mtimeMs}:${st.size}` : null
}

function sessionIdOf(file: string, rows: Record<string, any>[]): string {
  for (const r of rows) if (typeof r.sessionId === 'string' && r.sessionId) return r.sessionId
  return path.basename(file, '.jsonl')
}

function filesUnder(root: string): string[] {
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
      if (e.isDirectory()) {
        // 子 agent 的 transcript 不算独立会话，避免列表里出现重复片段
        if (e.name === 'subagents') continue
        walk(full, depth + 1)
      } else if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.endsWith('.jsonl.zst')) {
        out.push(full)
      }
    }
  }
  walk(root, 0)
  return out
}

function parseFile(file: string): { meta: SessionMeta; rows: Record<string, any>[]; id: string } {
  const rows: Record<string, any>[] = []
  let cwd: string | null = null
  let title = ''
  let customTitle = ''
  let model: string | null = null
  let startedAt: number | null = null
  let updatedAt: number | null = null
  let firstUser: string | null = null
  let lastUser: string | null = null
  let turns = 0
  let bubbles = 0
  for (const rec of readJsonl(file)) {
    rows.push(rec)
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
    if (rec.type === 'ai-title') title = String(rec.aiTitle || rec.title || title)
    if (rec.type === 'custom-title') customTitle = String(rec.customTitle || rec.title || customTitle)
    const stamp = rec.timestamp ? Date.parse(String(rec.timestamp)) : NaN
    if (Number.isFinite(stamp)) {
      if (startedAt === null || stamp < startedAt) startedAt = stamp
      if (updatedAt === null || stamp > updatedAt) updatedAt = stamp
    }
    if (rec.type === 'message' && (rec.role === 'user' || rec.role === 'assistant')) {
      bubbles++
      const { text } = textOf(rec.content)
      if (rec.role === 'user' && text && !isInjected(text)) {
        turns++
        lastUser = text
        if (!firstUser) firstUser = text
      }
      if (rec.role === 'assistant' && !model) {
        const m = rec.model || rec.modelInfo?.display_model_name || rec.modelInfo?.displayModelName
        if (typeof m === 'string') model = m
      }
    }
    if (rec.type === 'function_call' && !model) {
      const m = rec.model || rec.modelInfo?.display_model_name
      if (typeof m === 'string') model = m
    }
  }
  const id = sessionIdOf(file, rows)
  const st = statOf(file)
  const repo = cwd ? gitRoot(cwd) : null
  const finalTitle = customTitle || title || (firstUser ? plain(firstUser, 70) : '(空会话)')
  return {
    id,
    rows,
    meta: {
      key: `workbuddy:${id}`,
      agent: 'workbuddy',
      agentLabel: 'WorkBuddy',
      id,
      title: finalTitle,
      preview: plain(lastUser, 140),
      cwd,
      repo,
      project: projectName(repo || cwd),
      startedAt,
      updatedAt: updatedAt || (st ? st.mtimeMs : null),
      turns,
      bubbles,
      model,
      branch: null,
      source: file,
      size: st ? st.size : 0,
      extra: { customTitle, aiTitle: title, variant: 'jsonl' },
    },
  }
}

function list(_opts: ListOptions, ctx: AdapterCtx): SessionMeta[] {
  const cache = ctx.cache as FileCache
  const prev = cache.files || {}
  const next: Record<string, { stamp: string; meta: SessionMeta }> = {}
  const out: SessionMeta[] = []
  for (const root of ROOTS) {
    for (const file of filesUnder(root)) {
      const stamp = stampOf(file)
      if (!stamp) continue
      const hit = prev[file]
      const meta = hit && hit.stamp === stamp ? hit.meta : parseFile(file).meta
      next[file] = { stamp, meta }
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
    if (rec.type === 'message' && (rec.role === 'user' || rec.role === 'assistant')) {
      const { text, images } = textOf(rec.content)
      if (!text && images.length === 0) continue
      if (rec.role === 'user' && text && isInjected(text)) continue
      turns.push({
        role: rec.role === 'user' ? 'user' : 'assistant',
        text,
        at: rec.timestamp ? Date.parse(String(rec.timestamp)) || undefined : undefined,
        images: images.length ? images : undefined,
      })
    } else if (rec.type === 'function_call') {
      const name = typeof rec.name === 'string' ? rec.name : 'tool'
      const args = rec.arguments ?? rec.input
      const summary = typeof args === 'string' ? plain(args, 100) : args && typeof args === 'object'
        ? plain(String((args as any).description || (args as any).command || (args as any).path || ''), 100)
        : ''
      if (summary) turns.push({ role: 'assistant', text: `▸ ${name}: ${summary}`, at: rec.timestamp ? Date.parse(String(rec.timestamp)) || undefined : undefined })
    }
  }
  return opts.tail ? turns.slice(-opts.tail) : turns
}

export const workbuddyAdapter: Adapter = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  available: () => ROOTS.some((r) => isDir(r)),
  sources: () => ROOTS,
  list,
  read,
  hint: `WorkBuddy 的会话在 ${ROOTS.join(' / ')}；国际版（~/.workbuddy-ai）与国内版分开存放。`,
}

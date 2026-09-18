import path from 'node:path'
import { HANDOFF_DIR } from '../config'
import type { Role } from '../types'
import { fmtTime, readJsonFile, slugify, writeJsonFile } from '../util'

/**
 * 「决策 / 踩坑 / 约束 / 待办」这类**由 agent 主动记录**的结构化上下文。
 *
 * 为什么单独存一层：从原始对话里启发式猜「当时为什么这么决定」很不靠谱，
 * 而这恰恰是换 agent 时最值钱、最省 token 的信息。所以给它一条可靠通道：
 * agent 干活时顺手记一句，下一个 agent 直接看到。
 *
 * 文件：~/.local/share/agent-session-sync/handoffs/<repo>/context.json
 */
export type ContextKind = 'decision' | 'dead-end' | 'constraint' | 'todo' | 'note'

export const KIND_LABEL: Record<ContextKind, string> = {
  decision: '决策',
  'dead-end': '别踩这个坑',
  constraint: '约束',
  todo: '待办',
  note: '备注',
}

export interface ContextEntry {
  id: string
  at: number
  kind: ContextKind
  text: string
  /** 谁记的，比如 `claude:31c5af10` 或 `ass` */
  source?: string
  /** 只有 todo 有意义 */
  done?: boolean
}

export interface RepoContext {
  repo: string
  updatedAt: number
  entries: ContextEntry[]
}

/** 仓库 → 目录名（和交接记录用同一套规则） */
export function repoSlug(repoDir: string): string {
  return slugify(path.basename(repoDir.replace(/\/+$/, '')) || 'unknown', 60)
}

export function contextFile(repoDir: string): string {
  return path.join(HANDOFF_DIR, repoSlug(repoDir), 'context.json')
}

export function readContext(repoDir: string): RepoContext {
  const f = contextFile(repoDir)
  const c = readJsonFile<RepoContext>(f, { repo: repoDir, updatedAt: 0, entries: [] })
  return { repo: c.repo || repoDir, updatedAt: c.updatedAt || 0, entries: Array.isArray(c.entries) ? c.entries : [] }
}

export interface AddItem {
  kind: ContextKind
  text: string
  source?: string
}

function nextId(entries: ContextEntry[]): string {
  let max = 0
  for (const e of entries) {
    const m = /^c(\d+)$/.exec(e.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `c${max + 1}`
}

/** 追加若干条；完全重复（同 kind + 同文本）的会被跳过 */
export function addContext(repoDir: string, items: AddItem[]): { added: ContextEntry[]; skipped: number } {
  const ctx = readContext(repoDir)
  const added: ContextEntry[] = []
  let skipped = 0
  for (const it of items) {
    const text = String(it.text || '').trim()
    if (!text) continue
    const dup = ctx.entries.some((e) => e.kind === it.kind && e.text.trim() === text && !e.done)
    if (dup) {
      skipped++
      continue
    }
    const entry: ContextEntry = { id: nextId(ctx.entries), at: Date.now(), kind: it.kind, text, source: it.source }
    ctx.entries.push(entry)
    added.push(entry)
  }
  if (added.length) {
    ctx.repo = repoDir
    ctx.updatedAt = Date.now()
    writeJsonFile(contextFile(repoDir), ctx)
  }
  return { added, skipped }
}

/** 勾掉一条待办 / 删掉一条 */
export function updateContext(repoDir: string, id: string, patch: { done?: boolean; remove?: boolean }): ContextEntry | null {
  const ctx = readContext(repoDir)
  const i = ctx.entries.findIndex((e) => e.id === id)
  if (i < 0) return null
  if (patch.remove) {
    const [gone] = ctx.entries.splice(i, 1)
    ctx.updatedAt = Date.now()
    writeJsonFile(contextFile(repoDir), ctx)
    return gone ?? null
  }
  const cur = ctx.entries[i]!
  cur.done = patch.done
  ctx.updatedAt = Date.now()
  writeJsonFile(contextFile(repoDir), ctx)
  return cur
}

export interface ContextStats {
  decisions: ContextEntry[]
  deadEnds: ContextEntry[]
  constraints: ContextEntry[]
  todos: ContextEntry[]
  openTodos: ContextEntry[]
  total: number
}

const byKind = (ctx: RepoContext, kind: ContextKind): ContextEntry[] => ctx.entries.filter((e) => e.kind === kind)

export function contextStats(repoDir: string): ContextStats {
  const ctx = readContext(repoDir)
  const todos = byKind(ctx, 'todo')
  return {
    decisions: byKind(ctx, 'decision'),
    deadEnds: byKind(ctx, 'dead-end'),
    constraints: byKind(ctx, 'constraint'),
    todos,
    openTodos: todos.filter((t) => !t.done),
    total: ctx.entries.length,
  }
}

/** 渲染成 Markdown（交接摘要 / session_status 用；空的话返回空串） */
export function contextMarkdown(repoDir: string, opts: { includeDone?: boolean } = {}): string {
  const ctx = readContext(repoDir)
  if (!ctx.entries.length) return ''
  const L: string[] = []
  L.push('## 决策 / 踩坑 / 待办（由 agent 主动记录，可信度高于自动摘要）')
  L.push('')
  const groups: ContextKind[] = ['decision', 'dead-end', 'constraint', 'todo', 'note']
  for (const kind of groups) {
    let list = ctx.entries.filter((e) => e.kind === kind)
    if (kind === 'todo' && !opts.includeDone) list = list.filter((e) => !e.done)
    if (!list.length) continue
    L.push(`### ${KIND_LABEL[kind]}`)
    L.push('')
    for (const e of list) {
      const box = kind === 'todo' ? (e.done ? '- [x]' : '- [ ]') : '-'
      const who = e.source ? ` ${'·'} ${e.source}` : ''
      L.push(`${box} \`${e.id}\` ${e.text}${who}`)
    }
    L.push('')
  }
  return L.join('\n').trimEnd()
}

/** 一行式概览，给 CLI 首屏用 */
export function contextLine(repoDir: string): string {
  const s = contextStats(repoDir)
  if (!s.total) return ''
  const bits: string[] = []
  if (s.decisions.length) bits.push(`决策 ${s.decisions.length}`)
  if (s.deadEnds.length) bits.push(`坑 ${s.deadEnds.length}`)
  if (s.constraints.length) bits.push(`约束 ${s.constraints.length}`)
  if (s.openTodos.length) bits.push(`待办 ${s.openTodos.length}`)
  return bits.join(' · ')
}

export function kindFromFlag(flag: string): ContextKind | null {
  switch (flag) {
    case 'decision':
    case 'decide':
      return 'decision'
    case 'dead-end':
    case 'deadend':
    case 'pit':
      return 'dead-end'
    case 'constraint':
      return 'constraint'
    case 'todo':
      return 'todo'
    case 'note':
    case 'remark':
      return 'note'
    default:
      return null
  }
}

export interface HeuristicHint {
  role: Role
  at?: number
}

export { fmtTime, contextFile as fileOf }

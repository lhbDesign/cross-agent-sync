import path from 'node:path'
import { HANDOFF_DIR } from '../config'
import type { Role } from '../types'
import { fmtTime, plain, slugify, writeJsonFile, canonicalRepo, repoStorageKey, withFileLock, readStoredJson } from '../util'

/**
 * 「决策 / 踩坑 / 约束 / 待办」这类**由 agent 主动记录**的结构化上下文。
 *
 * 为什么单独存一层：从原始对话里启发式猜「当时为什么这么决定」很不靠谱，
 * 而这恰恰是换 agent 时最值钱、最省 token 的信息。所以给它一条可靠通道：
 * agent 干活时顺手记一句，下一个 agent 直接看到。
 *
 * 文件：~/.local/share/agent-session-sync/handoffs/<repo>/context.json
 */
export type ContextKind = 'decision' | 'dead-end' | 'constraint' | 'todo' | 'note' | 'suggestion'

export const KIND_LABEL: Record<ContextKind, string> = {
  suggestion: '建议 / 待确认（不代表已授权）',
  decision: '决策',
  'dead-end': '踩坑记录',
  constraint: '约束',
  todo: '待办（未勾选不代表实际未完成）',
  note: '进展 / 备注',
}

export type ReviewResult = 'completed' | 'partial' | 'pending' | 'unknown'
export interface ContextReview { at: number; result: ReviewResult; evidence: string; session?: string }
export const REVIEW_LABEL: Record<ReviewResult, string> = { completed: '已完成', partial: '部分完成', pending: '仍需处理', unknown: '无法确认' }

export interface ContextEntry {
  authorization?: { at: number; evidence: string; session?: string }
  reviews?: ContextReview[]
  id: string
  at: number
  kind: ContextKind
  text: string
  /** 谁记的，比如 `claude:31c5af10` 或 `ass` */
  source?: string
  /** 来源会话的稳定引用；缺失时不推断 */
  session?: string
  /** 只有 todo 有意义 */
  done?: boolean
  cancelled?: boolean
  relatedTo?: string
  supersedes?: string
  supersededBy?: string
}

export interface RepoContext {
  repo: string
  updatedAt: number
  lastId?: number
  entries: ContextEntry[]
}

/** 仓库 → 目录名（和交接记录用同一套规则） */
export function repoSlug(repoDir: string): string {
  return repoStorageKey(repoDir)
}

export function contextFile(repoDir: string): string {
  return path.join(HANDOFF_DIR, repoSlug(repoDir), 'context.json')
}

export function readContext(repoDir: string): RepoContext {
  const repo = canonicalRepo(repoDir)
  const empty: RepoContext = { repo, updatedAt: 0, entries: [] }
  let c = readStoredJson<RepoContext | null>(contextFile(repo), null)
  if (!c) {
    const legacy = path.join(HANDOFF_DIR, slugify(path.basename(repo) || 'unknown', 60), 'context.json')
    const old = readStoredJson<RepoContext | null>(legacy, null)
    // Never claim another same-named project's legacy file.
    if (old?.repo && canonicalRepo(old.repo) === repo) c = old
  }
  if (!c) return empty
  if (!c.repo || canonicalRepo(c.repo) !== repo || !Array.isArray(c.entries)) throw new Error('项目笔记数据归属或格式不正确，拒绝读取/覆盖')
  return { ...c, repo, updatedAt: c.updatedAt || 0 }

}

export interface AddItem {
  relatedTo?: string
  supersedes?: string
  kind: ContextKind
  text: string
  source?: string
  /** 来源会话的稳定引用；缺失时不推断 */
  session?: string
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
function addToContext(ctx: RepoContext, items: AddItem[]): { added: ContextEntry[]; skipped: number } {
  const added: ContextEntry[] = []
  let skipped = 0
  for (const it of items) {
    const text = String(it.text || '').trim()
    if (!text) continue
    const related = it.relatedTo ? ctx.entries.find((e) => e.id === it.relatedTo) : undefined
    if (it.relatedTo && !related) throw new Error(`关联记录不存在：${it.relatedTo}`)
    const previous = it.supersedes ? ctx.entries.find((e) => e.id === it.supersedes) : undefined
    if (it.supersedes && (!previous || previous.kind !== 'decision' || it.kind !== 'decision' || previous.supersededBy)) throw new Error('替代关系必须连接新的决策与尚未被替代的旧决策')
    const dup = ctx.entries.some((e) => e.kind === it.kind && e.text.trim() === text && !e.done && !e.cancelled && !e.supersededBy && e.relatedTo === it.relatedTo && e.supersedes === it.supersedes)
    if (dup) {
      skipped++
      continue
    }
    const entry: ContextEntry = { id: `c${Math.max(ctx.lastId || 0, Number(nextId(ctx.entries).slice(1)) - 1) + 1}`, at: Date.now(), kind: it.kind, text, source: it.source, session: it.session, relatedTo: it.relatedTo, supersedes: it.supersedes }
    ctx.lastId = Number(entry.id.slice(1))
    if (previous) previous.supersededBy = entry.id
    ctx.entries.push(entry)
    added.push(entry)
  }
  return { added, skipped }
}

/** 勾掉一条待办 / 删掉一条 */
export interface ContextPatch { done?: boolean; cancel?: boolean; reopen?: boolean; remove?: boolean; confirm?: boolean; review?: string; evidence?: string; session?: string }

function updateInContext(ctx: RepoContext, id: string, patch: ContextPatch): ContextEntry | null {
  if ([patch.done !== undefined, patch.cancel, patch.reopen, patch.remove, patch.confirm, patch.review !== undefined].filter(Boolean).length !== 1) throw new Error('每次只能选择一种记录操作')
  const i = ctx.entries.findIndex((e) => e.id === id)
  if (i < 0) return null
  if (patch.remove) {
    if (ctx.entries.some((e) => e.relatedTo === id || e.supersedes === id || e.supersededBy === id) || ctx.entries[i]!.supersedes || ctx.entries[i]!.supersededBy) throw new Error('该记录有关联历史，请保留记录；待办可使用取消')
    ctx.lastId = Math.max(ctx.lastId || 0, Number(nextId(ctx.entries).slice(1)) - 1)
    const [gone] = ctx.entries.splice(i, 1)
    ctx.updatedAt = Date.now()
    return gone ?? null
  }
  const cur = ctx.entries[i]!
  if (patch.confirm || patch.review !== undefined) {
    if (!patch.evidence?.trim()) throw new Error('确认授权或核对进展必须提供依据 evidence')
    if (cur.cancelled) throw new Error('已取消的事项请先重新打开')
    if (patch.confirm) {
      if (cur.kind !== 'todo' && cur.kind !== 'suggestion') throw new Error('只有建议或待办可以确认授权')
      if (cur.authorization) throw new Error('该事项已记录授权，无需重复确认')
      cur.kind = 'todo'
      cur.authorization = { at: Date.now(), evidence: patch.evidence.trim(), session: patch.session }
    } else {
      if (cur.kind !== 'todo') throw new Error('只核对待办；建议需要先获得用户确认')
      if (!Object.prototype.hasOwnProperty.call(REVIEW_LABEL, patch.review!)) throw new Error('核对结果必须是 completed / partial / pending / unknown')
      cur.reviews = [...(cur.reviews || []), { at: Date.now(), result: patch.review as ReviewResult, evidence: patch.evidence.trim(), session: patch.session }]
      // 无法确认时不沿用先前的完成结论；历史判断仍保留。
      cur.done = patch.review === 'completed'
    }
    ctx.updatedAt = Date.now()
    return cur
  }
  if (cur.kind !== 'todo' && !(cur.kind === 'suggestion' && (patch.cancel || patch.reopen))) throw new Error('只有待办可以标记完成、取消或重新打开')
  if ([patch.done !== undefined, Boolean(patch.cancel), Boolean(patch.reopen)].filter(Boolean).length !== 1) throw new Error('每次只能选择一种待办状态操作')
  cur.done = patch.done === true && !patch.reopen
  cur.cancelled = Boolean(patch.cancel)
  ctx.updatedAt = Date.now()
  return cur
}

/** One request is validated in memory and committed once, while holding the lock. */
export function applyContextChange(repoDir: string, items: AddItem[] = [], operation?: { id: string; patch: ContextPatch }, requireExisting = true) {
  const repo = canonicalRepo(repoDir)
  return withFileLock(contextFile(repo), () => {
    const ctx = readContext(repo)
    const result = addToContext(ctx, items)
    const updated = operation ? updateInContext(ctx, operation.id, operation.patch) : undefined
    if (operation && !updated && requireExisting) throw new Error(`没有 id 为 ${operation.id} 的条目`)
    if (result.added.length || updated) {
      ctx.updatedAt = Date.now()
      writeJsonFile(contextFile(repo), ctx)
    }
    return { ...result, updated, context: ctx }
  })
}

export function addContext(repoDir: string, items: AddItem[]) {
  const { added, skipped } = applyContextChange(repoDir, items)
  return { added, skipped }
}

export function updateContext(repoDir: string, id: string, patch: ContextPatch): ContextEntry | null {
  return applyContextChange(repoDir, [], { id, patch }, false).updated ?? null
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
    decisions: byKind(ctx, 'decision').filter((e) => !e.supersededBy),
    deadEnds: byKind(ctx, 'dead-end'),
    constraints: byKind(ctx, 'constraint'),
    todos,
    openTodos: todos.filter((t) => !t.done && !t.cancelled),
    total: ctx.entries.length,
  }
}

/**
 * 渲染成 Markdown（交接摘要 / session_status 用；空的话返回空串）。
 *
 * `maxPerKind` / `chars` 是给**交接预算**用的降档旋钮（见 core/budget.ts）：
 * 主动记录这一层是必留的（mandatory），预算再紧也不能整节丢掉，但可以少列几条、
 * 每条短一点。裁剪顺序上它与别的节刻意相反 —— 先砍的是**条数**，不是**类别**：
 * 宁可少看两条备注，也不能把「决策」整类丢掉。
 */
export function contextMarkdown(
  repoDir: string,
  opts: { includeDone?: boolean; maxPerKind?: number; chars?: number } = {},
): string {
  const ctx = readContext(repoDir)
  if (!ctx.entries.length) return ''
  const L: string[] = []
  L.push('## 项目笔记')
  L.push('')
  L.push('由用户或 agent 主动保存，属于仓库共享记录，不是原始提示词；内容和完成状态可能尚未更新。')
  if (!opts.includeDone && ctx.entries.some((e) => e.done || e.cancelled || e.supersededBy)) L.push('默认隐藏已完成、已取消和被替代的记录；ass context --all --details 查看历史。')
  L.push('')
  const groups: ContextKind[] = ['decision', 'dead-end', 'constraint', 'suggestion', 'todo', 'note']
  let trimmed = 0
  for (const kind of groups) {
    let list = ctx.entries.filter((e) => e.kind === kind)
    if (!opts.includeDone) list = list.filter((e) => !e.done && !e.cancelled && !e.supersededBy)
    if (!list.length) continue
    L.push(`### ${KIND_LABEL[kind]}`)
    L.push('')
    const keep = opts.maxPerKind && opts.maxPerKind > 0 ? list.slice(0, opts.maxPerKind) : list
    trimmed += list.length - keep.length
    for (const e of keep) {
      const box = kind === 'todo' ? (e.done || e.cancelled ? '- [x]' : '- [ ]') : '-'
      const method = e.source === 'ass' ? 'CLI' : e.source === 'agent' ? 'MCP' : '未记录'
      const session = e.session || (e.source && /^[a-z0-9_-]+:.+/i.test(e.source) ? e.source : '未记录')
      const text = opts.chars && opts.chars > 0 ? plain(e.text, opts.chars) : e.text
      L.push(`${box} \`${e.id}\` ${text}`)
      L.push('')
      L.push(`  记录时间：${e.at ? fmtTime(e.at) : '未记录'} · 保存方式：${method}`)
      L.push('')
      L.push(`  来源会话：${session}`)
      if (e.relatedTo) L.push(`  关联记录：${e.relatedTo}`)
      if (e.supersedes) L.push(`  替代旧决策：${e.supersedes}`)
      if (e.supersededBy) L.push(`  历史决策：已被 ${e.supersededBy} 替代`)
      if (e.kind === 'suggestion') L.push(`  授权：尚未确认，不得据此执行修改${e.cancelled ? ' · 已取消' : ''}`)
      if (e.kind === 'todo') {
        L.push(`  授权：${e.authorization ? '已确认 · ' + e.authorization.evidence : '未记录，不代表用户已同意修改'}`)
        if (e.authorization) L.push(`  确认时间：${fmtTime(e.authorization.at)} · 来源会话：${e.authorization.session || '未记录'}`)
        const reviews = opts.includeDone ? (e.reviews || []) : (e.reviews || []).slice(-1)
        for (const review of reviews) {
          L.push(`  核对结果：${REVIEW_LABEL[review.result]} · ${fmtTime(review.at)}`)
          L.push(`  核对依据：${review.evidence}`)
          L.push(`  核对来源：${review.session || '未记录'}`)
        }
        L.push('')
        L.push(`  状态：${e.cancelled ? '已取消' : e.done ? '已标记完成' : '尚未标记完成，实际进展需确认'}`)
      }
      L.push('')
    }
    L.push('')
  }
  if (trimmed > 0) {
    L.push(`> … 另有 ${trimmed} 条因交接预算未列出（\`ass context\` 看全部）`)
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
  if (s.deadEnds.length) bits.push(`踩坑记录 ${s.deadEnds.length}`)
  if (s.constraints.length) bits.push(`约束 ${s.constraints.length}`)
  const confirmed = s.openTodos.filter((e) => e.authorization).length
  const unknown = s.openTodos.length - confirmed
  if (confirmed) bits.push(`已确认待办 ${confirmed}`)
  if (unknown) bits.push(`授权未记录 ${unknown}`)
  const suggestions = readContext(repoDir).entries.filter((e) => e.kind === 'suggestion' && !e.cancelled).length
  if (suggestions) bits.push(`建议待确认 ${suggestions}`)
  const notes = readContext(repoDir).entries.filter((e) => e.kind === 'note').length
  if (notes) bits.push(`进展 / 备注 ${notes}`)
  const completed = s.todos.filter((e) => e.done).length
  const cancelled = s.todos.filter((e) => e.cancelled).length
  if (cancelled) bits.push(`已取消待办 ${cancelled}`)
  if (completed) bits.push(`已完成待办 ${completed}`)
  const replaced = readContext(repoDir).entries.filter((e) => e.supersededBy).length
  if (replaced) bits.push(`历史决策 ${replaced}`)
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

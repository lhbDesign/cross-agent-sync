import path from 'node:path'
import { TASK_DIR, type Config } from '../config'
import type { SessionMeta } from '../types'
import { fmtTime, plain, readJsonFile, sameRepo, writeJsonFile } from '../util'
import { readContext, type ContextEntry } from './context'
import { findSession, listSessions, readSession, type FoundSession } from './store'

/**
 * 「任务」——把跨 agent、跨天的多段会话绑成**一件事**。
 *
 * 为什么需要这一层：这个工具的立项初衷就是「需求 1-3 用 claude、4-5 换 codex」，
 * 但在有任务之前，工具眼里只有一堆互不相干的会话——`ass` 列出的是 5 条会话，
 * 而不是「一件事，分了 5 段」。换 agent 时新 agent 只能看到某一段，看不到全貌。
 *
 * 文件：~/.local/share/agent-session-sync/tasks/index.json
 *
 * 为什么是**全局单文件**而不是 per-repo 目录：
 *   1. 一个任务天然可能横跨两个仓库，per-repo 会强迫它二选一；
 *   2. per-repo 只能靠 slugify(basename(repoDir)) 定位，而同名仓库会撞
 *      （~/work/api 与 ~/personal/api 都是 api），任务作为长期实体不该继承这个隐患；
 *   3. 跨仓库列举零成本。
 * 代价是整文件重写：同一毫秒内两个进程同时写会丢一次更新。概率极低且可重做，
 * 与 handoffs/index.json、cache/index.json 是同一套取舍。
 */
export type TaskStatus = 'active' | 'done'

/**
 * 任务里的一段。字段是**快照**——源会话被删掉之后，这一段仍然能展示出来，
 * 只是标记为「会话已不可读」。这是有意的：任务的价值之一就是留住已经消失的历史。
 */
export interface TaskSession {
  /** 稳定外键 `${agent}:${id}`，等于 SessionMeta.key */
  key: string
  agent: string
  id: string
  agentLabel: string
  title: string
  repo: string | null
  /** 这一段覆盖什么，如「需求 4-5」 */
  label?: string
  /** 这一段的进展，如「卡在退款回调」 */
  note?: string
  at: number
  startedAt: number | null
  updatedAt: number | null
}

export interface TaskRecord {
  id: string
  /** 全局唯一（比较前过 normalizeName） */
  name: string
  createdAt: number
  updatedAt: number
  status: TaskStatus
  /** 只作提示与筛选，**绝不作键**——仓库改名/移动不影响任务的定位 */
  repo: string | null
  /** 原始目标（用户原话）；没手写就由第一个会话的首条用户消息派生并缓存 */
  goal?: string
  goalFrom?: string
  sessions: TaskSession[]
}

export interface TaskFile {
  version: number
  tasks: TaskRecord[]
  /** 已删除任务的 id，保证 id 永不复用（否则历史输出里的 `t3` 会指到新任务上） */
  retired?: string[]
}

export const TASK_VERSION = 1
export const TASK_FILE = path.join(TASK_DIR, 'index.json')

// ---------------------------------------------------------------- 读写

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function normalizeSegment(raw: unknown): TaskSession | null {
  const s = (raw || {}) as Record<string, unknown>
  const key = str(s.key)
  // 只接受 `${agent}:${id}` 形状；坏数据丢掉而不是让整个文件读不出来
  if (!/^[a-z0-9_-]+:.+/i.test(key)) return null
  const colon = key.indexOf(':')
  return {
    key,
    agent: str(s.agent) || key.slice(0, colon),
    id: str(s.id) || key.slice(colon + 1),
    agentLabel: str(s.agentLabel) || str(s.agent) || key.slice(0, colon),
    title: str(s.title),
    repo: typeof s.repo === 'string' && s.repo ? s.repo : null,
    label: str(s.label) || undefined,
    note: str(s.note) || undefined,
    at: num(s.at) ?? 0,
    startedAt: num(s.startedAt),
    updatedAt: num(s.updatedAt),
  }
}

function normalizeTask(raw: unknown): TaskRecord | null {
  const t = (raw || {}) as Record<string, unknown>
  const id = str(t.id)
  const name = str(t.name)
  if (!id || !name) return null
  const seen = new Set<string>()
  const sessions: TaskSession[] = []
  for (const s of Array.isArray(t.sessions) ? t.sessions : []) {
    const seg = normalizeSegment(s)
    if (!seg || seen.has(seg.key)) continue // 同一会话只留一段
    seen.add(seg.key)
    sessions.push(seg)
  }
  return {
    id,
    name,
    createdAt: num(t.createdAt) ?? 0,
    updatedAt: num(t.updatedAt) ?? 0,
    status: t.status === 'done' ? 'done' : 'active',
    repo: typeof t.repo === 'string' && t.repo ? t.repo : null,
    goal: str(t.goal) || undefined,
    goalFrom: str(t.goalFrom) || undefined,
    sessions,
  }
}

export function readTasks(): TaskFile {
  const raw = readJsonFile<Partial<TaskFile>>(TASK_FILE, {})
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : []
  return {
    version: num(raw.version) ?? TASK_VERSION,
    tasks: tasks.map(normalizeTask).filter((t): t is TaskRecord => t !== null),
    retired: Array.isArray(raw.retired) ? raw.retired.filter((x): x is string => typeof x === 'string') : [],
  }
}

export function writeTasks(file: TaskFile): void {
  // 防旧版本抹掉新版本数据
  const onDisk = readJsonFile<{ version?: number }>(TASK_FILE, {})
  const v = num(onDisk.version)
  if (v !== null && v > TASK_VERSION) {
    throw new Error(`任务数据由更新版本的 agent-session-sync 写入，本版本拒绝覆盖：${TASK_FILE}（升级后重试）`)
  }
  writeJsonFile(TASK_FILE, { version: TASK_VERSION, tasks: file.tasks, retired: file.retired ?? [] })
}

/** 读 → 改 → 只在真变了才落盘。返回 null 表示「没找到目标」，调用方据此报错 */
function mutate<T>(fn: (file: TaskFile) => T | null): T | null {
  const before = readTasks()
  const next: TaskFile = { version: TASK_VERSION, tasks: clone(before.tasks), retired: [...(before.retired ?? [])] }
  const out = fn(next)
  if (out === null) return null
  const a = JSON.stringify({ t: before.tasks, r: before.retired ?? [] })
  const b = JSON.stringify({ t: next.tasks, r: next.retired ?? [] })
  if (a !== b) writeTasks(next)
  return out
}

function nextTaskId(file: TaskFile): string {
  const taken = new Set(file.retired ?? [])
  let max = 0
  for (const t of file.tasks) {
    taken.add(t.id)
    const m = /^t(\d+)$/.exec(t.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  let n = max + 1
  while (taken.has(`t${n}`)) n++
  return `t${n}`
}

// ---------------------------------------------------------------- 查找

/** 比较用的归一化：去掉所有空白 + 小写 */
export function normalizeName(s: string): string {
  return String(s || '').replace(/\s+/g, '').toLowerCase()
}

export interface FindTaskOptions {
  /** true（默认）：允许「支付」命中「支付重构」。false：只认 id 或完整名字——破坏性操作用 */
  fuzzy?: boolean
}

export function findTask(ref: string, opts: FindTaskOptions = {}): TaskRecord | null {
  const r = String(ref || '').trim()
  if (!r) return null
  const fuzzy = opts.fuzzy !== false
  const all = readTasks().tasks

  const byId = all.find((t) => t.id === r)
  if (byId) return byId

  const key = normalizeName(r)
  const exact = all.find((t) => normalizeName(t.name) === key)
  if (exact) return exact
  if (!fuzzy) return null

  // 模糊命中多个时取最近更新的那个；调用方必须回显实际名字
  const hits = all.filter((t) => normalizeName(t.name).includes(key))
  if (!hits.length) return null
  return hits.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] ?? null
}

export function taskList(opts: { repo?: string | null; includeDone?: boolean; cfg?: Config } = {}): TaskRecord[] {
  let out = readTasks().tasks
  if (!opts.includeDone) out = out.filter((t) => t.status !== 'done')
  if (opts.repo) out = out.filter((t) => taskMatchesRepo(t, opts.repo as string))
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/** 任务关联到某个仓库吗？——按任务字段**或**任一段的仓库判断，仓库改名后仍能命中活会话 */
export function taskMatchesRepo(t: TaskRecord, repoDir: string): boolean {
  if (t.repo && sameRepo(t.repo, repoDir)) return true
  return t.sessions.some((s) => s.repo && sameRepo(s.repo, repoDir))
}

// ---------------------------------------------------------------- 写操作

export interface TaskAttachInput {
  /** 任务名或 `t3`；不存在则新建 */
  task: string
  meta: SessionMeta
  label?: string
  note?: string
  goal?: string
  repo?: string | null
}

export interface TaskCreateInput {
  name: string
  goal?: string
  repo?: string | null
}

/** 建一个空任务（还没绑任何会话）。已存在同名则不新建，`created:false` */
export function taskCreate(input: TaskCreateInput): { task: TaskRecord; created: boolean } {
  const name = String(input.name || '').trim()
  if (!name) throw new Error('任务名不能为空')
  const out = mutate<{ task: TaskRecord; created: boolean }>((file) => {
    const key = normalizeName(name)
    const existing = file.tasks.find((t) => normalizeName(t.name) === key)
    if (existing) return { task: clone(existing), created: false }
    const task: TaskRecord = {
      id: nextTaskId(file),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'active',
      repo: input.repo ?? null,
      goal: str(input.goal) || undefined,
      sessions: [],
    }
    file.tasks.push(task)
    return { task: clone(task), created: true }
  })
  if (!out) throw new Error(`无法创建任务：${name}`)
  return out
}

export interface TaskAttachResult {
  task: TaskRecord
  created: boolean
  added: boolean
  updated: boolean
  index: number
}

export function taskAttach(input: TaskAttachInput): TaskAttachResult {
  const name = String(input.task || '').trim()
  if (!name) throw new Error('任务名不能为空')
  const meta = input.meta

  const out = mutate<TaskAttachResult>((file) => {
    const key = normalizeName(name)
    let task = file.tasks.find((t) => t.id === name) || file.tasks.find((t) => normalizeName(t.name) === key)
    let created = false
    if (!task) {
      task = {
        id: nextTaskId(file),
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active',
        repo: input.repo ?? meta.repo ?? null,
        goal: str(input.goal) || undefined,
        sessions: [],
      }
      file.tasks.push(task)
      created = true
    }
    // 重名不新建——全局唯一名的执行点
    // 显式给了 --goal 就以后者为准（否则派生错了没救，只能删了重建）
    if (input.goal) {
      task.goal = String(input.goal)
      task.goalFrom = 'user'
    }

    const existing = task.sessions.find((s) => s.key === meta.key)
    let added = false
    let updated = false
    if (existing) {
      if (input.label !== undefined) {
        existing.label = String(input.label) || undefined
        updated = true
      }
      if (input.note !== undefined) {
        existing.note = String(input.note) || undefined
        updated = true
      }
      // 顺手刷新快照里会变的部分
      if (meta.title && meta.title !== existing.title) existing.title = meta.title
      if (meta.updatedAt && meta.updatedAt !== existing.updatedAt) existing.updatedAt = meta.updatedAt
    } else {
      task.sessions.push({
        key: meta.key,
        agent: meta.agent,
        id: meta.id,
        agentLabel: meta.agentLabel,
        title: meta.title,
        repo: meta.repo ?? input.repo ?? null,
        label: str(input.label) || undefined,
        note: str(input.note) || undefined,
        at: Date.now(),
        startedAt: meta.startedAt ?? null,
        updatedAt: meta.updatedAt ?? null,
      })
      added = true
    }
    if (!task.repo) task.repo = input.repo ?? meta.repo ?? null
    if (created || added || updated) task.updatedAt = Date.now()

    const index = task.sessions.findIndex((s) => s.key === meta.key)
    return { task: clone(task), created, added, updated, index }
  })
  if (!out) throw new Error(`无法写入任务：${name}`)
  return out
}

/** 解绑一段。sessionRef 为 null 时删掉整个任务 */
export function taskDetach(taskRef: string, sessionRef: string | null): { task: TaskRecord; removed: TaskSession | null } | null {
  return mutate((file) => {
    const i = file.tasks.findIndex((t) => t.id === taskRef || normalizeName(t.name) === normalizeName(taskRef))
    if (i < 0) return null
    const task = file.tasks[i]!
    if (!sessionRef) {
      file.tasks.splice(i, 1)
      file.retired = [...(file.retired ?? []), task.id]
      return { task: clone(task), removed: null }
    }
    const key = normalizeName(sessionRef)
    const j = task.sessions.findIndex((s) => s.key === sessionRef || normalizeName(s.key) === key || s.id.startsWith(sessionRef))
    if (j < 0) return null
    const [removed] = task.sessions.splice(j, 1)
    task.updatedAt = Date.now()
    return { task: clone(task), removed: removed ?? null }
  })
}

/** 删掉整个任务。id 会记入 retired，永不复用 */
export function taskRemove(taskRef: string): TaskRecord | null {
  const out = taskDetach(taskRef, null)
  return out ? out.task : null
}

/** 更新某一段的进展（不给 sessionRef 就用最后一段） */
export function taskSetNote(taskRef: string, sessionRef: string | null, note: string): TaskRecord | null {
  return mutate((file) => {
    const task = file.tasks.find((t) => t.id === taskRef || normalizeName(t.name) === normalizeName(taskRef))
    if (!task) return null
    const seg = sessionRef
      ? task.sessions.find((s) => s.key === sessionRef || s.id.startsWith(sessionRef))
      : task.sessions[task.sessions.length - 1]
    if (!seg) return null
    seg.note = String(note) || undefined
    task.updatedAt = Date.now()
    return clone(task)
  })
}

export function taskSetStatus(taskRef: string, status: TaskStatus): TaskRecord | null {
  return mutate((file) => {
    const task = file.tasks.find((t) => t.id === taskRef || normalizeName(t.name) === normalizeName(taskRef))
    if (!task) return null
    task.status = status
    task.updatedAt = Date.now()
    return clone(task)
  })
}

// ---------------------------------------------------------------- 当前会话

/**
 * 「现在正在干活的是哪个会话」——只读元数据，不读任何 transcript。
 *
 * 依据：claude / codex adapter 的 updatedAt 就是 transcript 文件的 mtime，
 * 也就是「正在被写入的那个」= 调用方自己。所以取最近更新的即可。
 */
export function currentSession(
  repoDir: string,
  cfg: Config,
  opts: { agent?: string; now?: number } = {},
): { found: FoundSession; stale: boolean } | null {
  const { sessions } = listSessions({ repo: repoDir, agent: opts.agent, includeAll: false }, cfg)
  if (!sessions.length) return null
  // 同一仓库里开了多个子目录窗口时，cwd 精确匹配的优先
  const cwd = process.cwd()
  const atCwd = sessions.filter((s) => s.cwd && sameRepo(s.cwd, cwd))
  const pool = atCwd.length ? atCwd : sessions
  const best = pool.sort((a, b) => (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0))[0]
  if (!best) return null
  const found = findSession(best.key, cfg)
  if (!found) return null
  const when = best.updatedAt || best.startedAt || 0
  const stale = when > 0 && (opts.now ?? Date.now()) - when > 30 * 60 * 1000
  return { found, stale }
}

// ---------------------------------------------------------------- 视图

export interface TaskSegment {
  /** 稳定引用 `agent:8dda036d`——**不是 `#N`**（跨进程不稳） */
  ref: string
  key: string
  agent: string
  agentLabel: string
  /** 这一段所属仓库（优先取活会话的，仓库改名后仍准确） */
  repo: string | null
  label?: string
  note?: string
  title?: string
  startedAt?: number | null
  updatedAt?: number | null
  /** 活会话里最近更新的那一段 */
  current: boolean
  /** false = 会话已不可读，数据来自快照 */
  live: boolean
  /** 没写 note 时的兜底进展（meta.preview，零成本） */
  fallback?: string
}

export interface TaskDecision extends ContextEntry {
  repo: string
}

export interface TaskView {
  id: string
  name: string
  status: TaskStatus
  repo: string | null
  /** ['claude','codex','claude']，相邻去重 */
  chain: string[]
  sessions: number
  segments: TaskSegment[]
  goal?: { text: string; from?: string; at?: number | null }
  decisions: TaskDecision[]
  todos: ContextEntry[]
  totalTodos: number
  staleCount: number
}

/** `${agent}:${id 前 8 位}` —— 稳定引用 */
function refOf(agent: string, id: string): string {
  return `${agent}:${id.slice(0, 8)}`
}

/** 会话的 agent 序列，相邻去重：claude,claude,codex → ['claude','codex'] */
export function taskChain(task: TaskRecord): string[] {
  const out: string[] = []
  for (const s of task.sessions) if (out[out.length - 1] !== s.agent) out.push(s.agent)
  return out
}

/**
 * 合成任务视图。
 *
 * 成本 = 1 次全量列表（带 mtime 缓存）+ N 次小 JSON 读 + 最多 1 次 transcript 读
 * （只为派生原始目标，且结果会写回任务文件缓存）。
 * **绝不读任一会话的完整 transcript。**
 */
export function taskView(taskRef: string, cfg: Config): TaskView | null {
  const task = findTask(taskRef)
  if (!task) return null

  const { sessions } = listSessions({ includeAll: true }, cfg)
  const byKey = new Map(sessions.map((s) => [s.key, s]))

  const segments: TaskSegment[] = task.sessions.map((s) => {
    const live = byKey.get(s.key)
    return {
      ref: refOf(s.agent, s.id),
      key: s.key,
      agent: s.agent,
      agentLabel: s.agentLabel,
      repo: live?.repo ?? s.repo,
      label: s.label,
      note: s.note,
      title: live?.title || s.title,
      startedAt: live?.startedAt ?? s.startedAt,
      updatedAt: live?.updatedAt ?? s.updatedAt,
      current: false,
      live: Boolean(live),
      fallback: live?.preview ? plain(live.preview, 60) : undefined,
    }
  })

  // 当前段 = 活会话里 updatedAt 最大的那段
  let curIdx = -1
  let curAt = -1
  segments.forEach((seg, i) => {
    if (!seg.live) return
    const at = seg.updatedAt || 0
    if (at > curAt) {
      curAt = at
      curIdx = i
    }
  })
  if (curIdx >= 0) segments[curIdx]!.current = true

  // 决策 / 待办：用**活会话的 repo**（而非 task.repo），这样仓库改名后依然读得到
  const repos: string[] = []
  const seenRepo = new Set<string>()
  for (const seg of segments) {
    const live = byKey.get(seg.key)
    const r = live?.repo || seg.repo || task.repo
    if (!r) continue
    const k = path.basename(r)
    if (seenRepo.has(k)) continue
    seenRepo.add(k)
    repos.push(r)
  }
  const decisions: TaskDecision[] = []
  const todos: ContextEntry[] = []
  let totalTodos = 0
  for (const r of repos) {
    const ctx = readContext(r)
    for (const e of ctx.entries) {
      if (e.kind === 'decision' || e.kind === 'dead-end' || e.kind === 'constraint') decisions.push({ ...e, repo: r })
      else if (e.kind === 'todo') {
        totalTodos++
        todos.push(e)
      }
    }
  }
  decisions.sort((a, b) => a.at - b.at)

  // 原始目标：优先用缓存的；否则取**会话标题**。
  //
  // 为什么不用「用户第一句话」：人贴报错/粘贴终端输出是极常见的开场，第一句经常是一大段
  // 噪声（实测：「lihaibo@lihaibo session-mcp % npm publish > cross-agent-sync@0.1.0
  // prepublishOnly > …」），当成目标毫无意义。而 title 是 agent 自己生成的摘要，短且达意。
  // 附带好处：title 就在 SessionMeta 里，不用读 transcript —— taskView 因此完全不碰全文。
  let goal: TaskView['goal']
  const seg0 = segments[0]
  const liveTitle = seg0?.title && seg0.title !== '(空会话)' ? plain(seg0.title, 120) : ''
  const userSet = task.goalFrom === 'user' // --goal 显式写的，永远不覆盖

  if (liveTitle && !userSet) {
    if (task.goal !== liveTitle) {
      // 标题变了（agent 会随对话推进重新生成标题）→ 跟着刷。缓存若不动，目标会一直停在上一次的样子
      mutate((file) => {
        const t = file.tasks.find((x) => x.id === task.id)
        if (!t) return null
        t.goal = liveTitle
        t.goalFrom = seg0!.ref
        return true
      })
    }
    goal = { text: liveTitle, from: seg0!.ref, at: seg0!.updatedAt ?? null }
  } else if (task.goal) {
    goal = { text: task.goal, from: task.goalFrom, at: task.createdAt || null }
  } else if (seg0) {
    // 罕见回退：连标题都拿不到（空会话 / 自定义 agent）。读一次全文取第一句。
    const found = findSession(seg0.key, cfg)
    const u = found ? readSession(found).find((t) => t.role === 'user' && t.text.trim()) : undefined
    if (u) goal = { text: plain(u.text, 200), from: seg0.ref, at: seg0.startedAt }
  }
  if (!goal) goal = { text: '', from: undefined, at: null }

  return {
    id: task.id,
    name: task.name,
    status: task.status,
    repo: task.repo,
    chain: taskChain(task),
    sessions: task.sessions.length,
    segments,
    goal: goal && goal.text ? goal : undefined,
    decisions,
    todos,
    totalTodos,
    staleCount: segments.filter((s) => !s.live).length,
  }
}

/** 括号里那截概览：`2 段 · claude→codex`。列表里 id 和名字已经单独印了，只要这一截 */
export function taskSummary(t: TaskRecord): string {
  const bits = [`${t.sessions.length} 段`]
  const chain = taskChain(t)
  if (chain.length) bits.push(chain.join('→'))
  if (t.status === 'done') bits.push('已完成')
  return bits.join(' · ')
}

/** 一行式概览，给 cmdStatus / session_status 用 */
export function taskLine(t: TaskRecord): string {
  return `${t.id} ${t.name}（${taskSummary(t)}）`
}

const KIND_TAG: Record<string, string> = { 'dead-end': '（已排除）', constraint: '（约束）' }

/** 渲染成 Markdown —— MCP 工具 / `ass resume --md` / `--save` 共用同一份 */
export function taskResumeMarkdown(v: TaskView): string {
  const L: string[] = []
  const head = [`\`${v.id}\``, `${v.sessions} 个会话`, v.chain.join('→')]
  const cur = v.segments.find((s) => s.current)
  if (cur) head.push(`当前 \`${cur.ref}\``)
  L.push(`# 任务：${v.name}`)
  L.push('')
  L.push(head.filter(Boolean).join(' · '))

  if (v.goal) {
    L.push('')
    L.push(`## 原始目标${v.goal.from ? `（${v.goal.from}）` : ''}`)
    L.push('')
    L.push(`> ${v.goal.text}`)
  }

  if (v.decisions.length) {
    L.push('')
    L.push('## 决策')
    L.push('')
    const multi = new Set(v.decisions.map((d) => path.basename(d.repo))).size > 1
    for (const d of v.decisions) {
      const tag = KIND_TAG[d.kind] ?? ''
      const repoTag = multi ? ` \`[${path.basename(d.repo)}]\`` : ''
      L.push(`- \`${d.id}\` ${d.text}${tag}${repoTag}`)
    }
  }

  L.push('')
  L.push('## 各段进展')
  L.push('')
  v.segments.forEach((s, i) => {
    const bits: string[] = []
    if (s.label) bits.push(s.label)
    else if (s.title) bits.push(plain(s.title, 40))
    const state = s.note || s.fallback
    if (state) bits.push(`— ${state}`)
    const flags: string[] = []
    if (s.current) flags.push('当前')
    if (!s.live) flags.push('会话已不可读')
    const tail = flags.length ? `（${flags.join(' · ')}）` : ''
    L.push(`${i + 1}. \`${s.ref}\` ${bits.join(' ')}${tail}`)
  })

  if (v.todos.length) {
    L.push('')
    L.push('## 待办')
    L.push('')
    for (const t of v.todos) L.push(`- [${t.done ? 'x' : ' '}] ${t.text} \`${t.id}\``)
  }

  L.push('')
  if (v.staleCount) {
    L.push(`> ${v.staleCount} 段对应的会话已经读不到了（数据来自绑定时留下的快照）。`)
    L.push('> 清理：`ass task rm ' + v.name + ' <引用>`')
    L.push('')
  }
  const first = v.segments[0]
  // 和上面「各段进展」用同一种短引用，别一条长一条短
  if (first) L.push(`需要某一段的完整交接摘要：\`session_handoff(session: "${first.ref}")\``)
  return L.join('\n').trimEnd()
}

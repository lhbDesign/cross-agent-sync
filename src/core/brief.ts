import type { SessionMeta, Turn } from '../types'
import { plain, truncate } from '../util'
import { contextMarkdown } from './context'

/**
 * 交接摘要：把一次会话压成「下一个 agent 看完就能接着干」的 Markdown。
 *
 * 它只能做**启发式**抽取（我们读的是别人存的对话记录，没有结构化的
 * 「目标 / 待办」字段），所以每一节都标了它是怎么来的，不假装是精确结论。
 */

// 扩展名按“长的排前面”，并且后面必须不是字母数字 —— 否则 AGENTS.md 会被当成 .m 截断
const FILE_RE =
  /(?:^|[\s`'"([<|,:])((?:[\w.@~-]+\/)*[\w.@-]+\.(?:jsonc|prisma|graphql|svelte|mts|cts|tsx|jsx|mjs|cjs|yaml|scss|sass|less|html|toml|json|lock|mdx|vue|txt|css|htm|xml|proto|sql|sh|zsh|bash|yml|ini|php|swift|java|ruby|rbs|cpp|hpp|cs|go|rs|kt|mm|ts|js|py|rb|md|m|c|h|gql|tf))(?::\d+(?::\d+)?)?(?![A-Za-z0-9])/g
const NOISE_RE =
  /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|\.nuxt|vendor|target|__pycache__)(\/|$)|\.min\.|pnpm-lock\.yaml|package-lock\.json|yarn\.lock/

/** 按提及频次挑出这次会话涉及的文件 */
export function pickFiles(turns: Turn[], extra: string[] = []): [string, number][] {
  const counts = new Map<string, number>()
  const bump = (p: unknown, n = 1): void => {
    const clean = String(p)
      .replace(/^file:\/\//, '')
      .replace(/:\d+(?::\d+)?$/, '')
    if (!clean || NOISE_RE.test(clean)) return
    counts.set(clean, (counts.get(clean) ?? 0) + n)
  }
  for (const p of extra) bump(p, 3)
  for (const t of turns) {
    if (t.role === 'tool') continue
    const found = String(t.text || '').match(FILE_RE)
    if (!found) continue
    const seen = new Set<string>()
    for (const raw of found) {
      const clean = raw.trim().replace(/^[\s`'"([<|,:]+/, '').replace(/:\d+(?::\d+)?$/, '')
      if (!clean || seen.has(clean)) continue
      seen.add(clean)
      bump(clean)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const NEXT_STEP_HEAD = /(下一步|待办|后续|接下来|剩余|未完成|需要你|请确认|风险|建议|todo|next step|next steps|open question|remaining|follow[- ]up)/i
const BULLET = /^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ x]\]\s*)/

/** 从最后一条助手回复里抠出「待办那一节」 */
export function extractNextSteps(turns: Turn[], max = 8): { steps: string[]; kind: 'section' | 'tail' } {
  const last = [...turns].reverse().find((t) => t.role === 'assistant')
  if (!last) return { steps: [], kind: 'section' }
  const lines = String(last.text).split('\n')
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    const head = /^#{1,6}\s+(.*)$/.exec(line)
    if (head) {
      inSection = NEXT_STEP_HEAD.test(head[1] ?? '')
      continue
    }
    if (NEXT_STEP_HEAD.test(line) && line.length < 60 && !BULLET.test(line)) {
      inSection = true
      continue
    }
    if (inSection && BULLET.test(line)) {
      const t = plain(line, 200)
      if (t.length > 6) out.push(t)
      if (out.length >= max) break
    } else if (inSection && line.trim() === '' && out.length) {
      break
    }
  }
  if (!out.length) {
    // 没有明确的小标题时，退而求其次：看消息最后 40% 里的条目
    for (const line of lines.slice(Math.floor(lines.length * 0.6))) {
      if (!BULLET.test(line)) continue
      const t = plain(line, 200)
      if (t.length > 10) out.push(t)
      if (out.length >= 4) break
    }
  }
  return { steps: out.slice(0, 4), kind: out.length ? (inSection ? 'section' : 'tail') : 'section' }
}

const IGNORE_LINE = /^(?:\u25b8|\||```|\u2500|\+|-{2,}|\$ |>|node |npm |pnpm |git |\d+\s*\|)/

/** 决策 / 踩坑 的信号词（宁缺毋滥：太宽会把整段叙述都抓进来） */
const PIT_RE = /(不行|不可行|不生效|没生效|会失败|已失败|回滚了|撤销了|踩坑|这个坑|试过了|试了不行|别用|不要用|避免使用|走了弯路|绕了远路|会崩|会炸)/
const DECIDE_RE = /(决定把|决定用|决定改|决定采用|改成|换成|改为|采用|统一用|约定|结论是|定为|最终用|最终改)/

/**
 * 从对话里**猜**哪些是决策、哪些是踩过的坑 —— 兜底用。
 * 真正可靠的是 agent 用 session_remember 主动记（那份会置顶显示，见 contextMarkdown）。
 *
 * 宁可少抓也不要抓错：信号词收紧、只收短句、跳过整段叙述、跳过第一条用户消息（那是原始目标，上面已经有了）。
 */
export function extractDecisions(turns: Turn[], max = 6): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let firstUserSkipped = false

  const scan = (t: Turn): boolean => {
    for (const rawLine of String(t.text || '').split('\n')) {
      const raw = rawLine.trim()
      // 只认「列表项」：成篇叙述里几乎不可能出现结构化条目，
      // 而真正的结论/决策通常会被 agent 写成 bullet
      if (!/^(?:[-*+]|\d+[.)]|\[[ x]\])\s+\S/.test(raw)) continue
      const line = raw
        .replace(/^(?:[-*+]|\d+[.)]|\[[ x]\])\s*/, '')
        .replace(/^#+\s*/, '')
        .replace(/\*\*/g, '')
      if (line.length < 8 || line.length > 140) continue
      if (IGNORE_LINE.test(line) || /^https?:\/\//.test(line)) continue
      if (/[{};]\s*$/.test(line) || line.startsWith('|') || line.startsWith('\u25b8')) continue
      if (!PIT_RE.test(line) && !DECIDE_RE.test(line)) continue
      const key = line.slice(0, 40)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(plain(line, 160))
      if (out.length >= max) return false
    }
    return true
  }

  // 先看用户说的（短、指令性强），再看助手说的
  for (const t of turns) {
    if (t.role !== 'user') continue
    if (!firstUserSkipped) {
      firstUserSkipped = true
      continue
    }
    if (!scan(t)) return out
  }
  for (const t of turns) {
    if (t.role !== 'assistant') continue
    if (!scan(t)) return out
  }
  return out
}
function proseLines(text: string): string[] {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 12 &&
        !IGNORE_LINE.test(l) &&
        !/^https?:\/\//.test(l) &&
        !/^(at |import |export |const |let |var |function |\{|\[)/.test(l) &&
        !/[{};]$/.test(l) &&
        (l.match(/[\u4e00-\u9fff]/) ? l.length > 8 : l.length > 25),
    )
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*+]\s+/, ''))
}

/** 从助手回复里均匀采样几句「关键结论」 */
function assistantHighlights(turns: Turn[], max = 8): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const msgs = turns.filter((t) => t.role === 'assistant').map((t) => String(t.text))
  const step = Math.max(1, Math.floor(msgs.length / (max * 2)))
  for (let i = 0; i < msgs.length && out.length < max; i += step) {
    const line = proseLines(msgs[i] ?? '')[0]
    if (!line) continue
    const key = line.slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(plain(line, 190))
  }
  return out
}

export interface BriefOptions {
  /**
   * 是否附上「从对话里猜的决策/踩坑」。
   * 默认 false：实测精度不够 —— 一个猜错的「决策」比没有更危险，
   * 而可靠的通道是 agent 干活时用 session_remember 主动记（那份会置顶）。
   * 想看看猜成什么样：ass brief --guess
   */
  guess?: boolean
  maxFiles?: number
  tailMessages?: number
  /** 会话里被改过的文件（adapter 拿得到的话），会加权 */
  touchedFiles?: string[]
}

export function buildBrief(meta: SessionMeta, turns: Turn[], opts: BriefOptions = {}): string {
  const L: string[] = []
  const repo = meta.repo || meta.cwd || '(未知)'
  const users = turns.filter((t) => t.role === 'user')

  L.push(`# 交接摘要 · ${meta.title}`)
  L.push('')
  L.push('| 项 | 值 |')
  L.push('| --- | --- |')
  L.push(`| 来源 Agent | **${meta.agentLabel}** (\`${meta.key}\`) |`)
  L.push(`| 仓库 | \`${repo}\` |`)
  if (meta.branch) L.push(`| 分支 | \`${meta.branch}\` |`)
  L.push(`| 会话时间 | ${fmtRange(meta)} |`)
  if (meta.model) L.push(`| 模型 | \`${meta.model}\` |`)
  L.push(`| 规模 | ${users.length} 轮用户输入 / ${turns.length} 条消息 |`)
  L.push('')

  // ① agent 主动记录的（可信）—— 直接置顶
  const ctxMd = contextMarkdown(meta.repo || meta.cwd || '')
  if (ctxMd) {
    L.push(ctxMd)
    L.push('')
  }

  if (users.length) {
    L.push('## 原始目标（用户最初的原话）')
    L.push('')
    for (const u of users.slice(0, 3)) L.push(`> ${truncate(u.text, 600)}`)
    L.push('')
  }

  if (users.length) {
    L.push('## 需求时间线')
    L.push('')
    users.slice(0, 40).forEach((u, i) => L.push(`${i + 1}. ${plain(u.text, 220)}`))
    if (users.length > 40) L.push(`… 其余 ${users.length - 40} 条已省略（用 \`ass show <引用> --full\` 看全文）`)
    L.push('')
  }

  const files = pickFiles(turns, opts.touchedFiles)
  if (files.length) {
    L.push('## 涉及文件（按提及频次）')
    L.push('')
    for (const [f, n] of files.slice(0, opts.maxFiles ?? 25)) L.push(`- \`${f}\`${n > 1 ? ` (${n}×)` : ''}`)
    L.push('')
  }

  const highlights = assistantHighlights(turns)
  if (highlights.length) {
    L.push('## 助手关键结论（自动抽取，可能不完整）')
    L.push('')
    for (const h of highlights) L.push(`- ${h}`)
    L.push('')
  }

  // ② 从对话里**猜**的决策 / 踩坑 —— 默认不出（见 extractDecisions 的注释）
  if (opts.guess) {
    const guessed = extractDecisions(turns)
    if (guessed.length) {
      L.push('## 决策与踩坑（从对话里推测，未经确认，仅供参考）')
      L.push('')
      for (const g of guessed) L.push(`- ${g}`)
      L.push('')
    }
  }

  const { steps, kind } = extractNextSteps(turns)
  if (steps.length) {
    L.push(kind === 'section' ? '## 待办 / 待确认（启发式抽取）' : '## 消息末尾的要点（启发式抽取：可能是结论或状态，不一定是待办）')
    L.push('')
    for (const s of steps) L.push(kind === 'section' ? `- [ ] ${s}` : `- ${s}`)
    L.push('')
  }

  // 最后一轮完整对话：从最后一次用户发言开始截
  const nonTool = turns.filter((t) => t.role !== 'tool' && !(t.role === 'assistant' && t.text.trimStart().startsWith('▸')))
  const lastUser = nonTool.map((t) => t.role).lastIndexOf('user')
  const tailCount = opts.tailMessages ?? 4
  const seg = lastUser >= 0 ? nonTool.slice(lastUser) : nonTool.slice(-tailCount)
  const tail =
    seg.length > tailCount + 2
      ? [seg[0]!, { role: 'assistant' as const, text: `… (${seg.length - 1 - tailCount} 条助手消息已省略) …` }, ...seg.slice(-tailCount)]
      : seg
  if (tail.length) {
    L.push('## 最后一轮完整对话')
    L.push('')
    for (const t of tail) {
      L.push(`**${t.role === 'user' ? '用户' : '助手'}**`)
      L.push('')
      L.push(truncate(t.text, 4000))
      L.push('')
    }
  }
  return L.join('\n')
}

function fmtRange(meta: SessionMeta): string {
  // 避免循环依赖，这里直接内联一份最小实现
  const f = (ms: number | null): string => {
    if (!ms) return '—'
    const d = new Date(ms)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return `${f(meta.startedAt)} → ${f(meta.updatedAt)}`
}

/** 一屏概览（MCP 的 session_read mode=summary 用） */
export function buildSummary(meta: SessionMeta, turns: Turn[]): string {
  const L: string[] = []
  const users = turns.filter((t) => t.role === 'user')
  L.push(`**${meta.agentLabel}** \`${meta.key}\``)
  L.push('')
  L.push(`- 标题：${meta.title}`)
  L.push(`- 仓库：\`${meta.repo || '—'}\``)
  L.push(`- 时间：${fmtRange(meta)}`)
  L.push(`- 规模：${users.length} 轮用户输入 / ${turns.length} 条消息`)
  if (meta.model) L.push(`- 模型：\`${meta.model}\``)
  L.push('')
  if (users.length) {
    L.push('**用户需求（前 10 条）**')
    L.push('')
    users.slice(0, 10).forEach((u, i) => L.push(`${i + 1}. ${plain(u.text, 160)}`))
    L.push('')
  }
  const last = [...turns].reverse().find((t) => t.role === 'assistant')
  if (last) {
    L.push('**最后一条助手回复（截断）**')
    L.push('')
    L.push(truncate(last.text, 1200))
  }
  return L.join('\n')
}

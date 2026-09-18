import type { SessionMeta, Turn } from '../types'
import { plain, truncate } from '../util'

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

/** 只保留像「人话」的行：丢掉工具输出、代码、表格、命令行 */
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

import type { SessionMeta, Turn } from '../types'
import { plain, truncate } from '../util'
import { contextMarkdown } from './context'
import {
  DEFAULT_LEVEL,
  budgetFooter,
  estimateTokens,
  fitSections,
  levelTokens,
  type BudgetLevel,
  type BudgetSection,
} from './budget'

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
  /** 交接预算档位（tiny/small/standard/large/full）；缺省 standard */
  level?: BudgetLevel
  /** 直接给 token 上限，覆盖 level */
  tokens?: number
}

/**
 * 每节在各档位下的取量。集中放在一处，是为了让「降到下一档会少掉什么」一眼可见 ——
 * 散在各处的魔法数字正是这个模块原先的问题。
 */
const T = {
  goal: { full: { n: 3, chars: 600 }, compact: { n: 1, chars: 380 }, minimal: { n: 1, chars: 150 } },
  timeline: { full: { n: 40, chars: 220 }, compact: { n: 18, chars: 140 }, minimal: { n: 6, chars: 80 } },
  files: { full: { n: 25 }, compact: { n: 12 }, minimal: { n: 5 } },
  highlight: { full: { n: 8, chars: 190 }, compact: { n: 5, chars: 140 }, minimal: { n: 3, chars: 110 } },
  steps: { full: { n: 8 }, compact: { n: 5 }, minimal: { n: 3 } },
  tail: { full: { msgs: 4, chars: 4000 }, compact: { msgs: 2, chars: 1400 }, minimal: { msgs: 1, chars: 500 } },
  guess: { full: { n: 6 }, compact: { n: 4 }, minimal: { n: 0 } },
  ctx: { full: { per: 0, chars: 0 }, compact: { per: 12, chars: 120 }, minimal: { per: 6, chars: 70 } },
} as const

export function buildBrief(meta: SessionMeta, turns: Turn[], opts: BriefOptions = {}): string {
  const repo = meta.repo || meta.cwd || '(未知)'
  const users = turns.filter((t) => t.role === 'user')
  const files = pickFiles(turns, opts.touchedFiles)
  const highlights = assistantHighlights(turns)
  const { steps, kind } = extractNextSteps(turns)

  /** 节的输出顺序 = 声明顺序；裁剪顺序由 priority 决定 —— 两者刻意解耦 */
  const sections: BudgetSection[] = []

  sections.push({
    id: 'meta',
    label: '会话元信息',
    priority: 0,
    mandatory: true,
    render: () => {
      const L: string[] = [`# 交接摘要 · ${meta.title}`, '']
      L.push('| 项 | 值 |')
      L.push('| --- | --- |')
      L.push(`| 来源 Agent | **${meta.agentLabel}** (\`${meta.key}\`) |`)
      L.push(`| 仓库 | \`${repo}\` |`)
      if (meta.branch) L.push(`| 分支 | \`${meta.branch}\` |`)
      L.push(`| 会话时间 | ${fmtRange(meta)} |`)
      if (meta.model) L.push(`| 模型 | \`${meta.model}\` |`)
      L.push(`| 规模 | ${users.length} 轮用户输入 / ${turns.length} 条消息 |`)
      return L.join('\n')
    },
  })

  // ① agent 主动记录的（可信）—— 置顶输出，且**最后才降档**（priority 0 + mandatory）
  sections.push({
    id: 'context',
    label: '主动记录的决策/踩坑',
    priority: 0,
    mandatory: true,
    render: (tier) => {
      const t = T.ctx[tier]
      return contextMarkdown(repo, {
        maxPerKind: t.per || undefined,
        chars: t.chars || undefined,
      })
    },
  })

  sections.push({
    id: 'goal',
    label: '原始目标',
    priority: 1,
    render: (tier) => {
      if (!users.length) return ''
      const t = T.goal[tier]
      const L = ['## 原始目标（用户最初的原话）', '']
      for (const u of users.slice(0, t.n)) L.push(`> ${truncate(u.text, t.chars)}`)
      return L.join('\n')
    },
  })

  // 待办排在「时间线」前面输出，但**优先级高于**时间线与文件 ——
  // 换 agent 时最该先看到的就是"接下来要做什么"
  sections.push({
    id: 'todos',
    label: '待办 / 待确认',
    priority: 2,
    render: (tier) => {
      if (!steps.length) return ''
      const t = T.steps[tier]
      const head =
        kind === 'section'
          ? '## 待办 / 待确认（启发式抽取）'
          : '## 消息末尾的要点（启发式抽取：可能是结论或状态，不一定是待办）'
      const L = [head, '']
      for (const s of steps.slice(0, t.n)) L.push(kind === 'section' ? `- [ ] ${s}` : `- ${s}`)
      return L.join('\n')
    },
  })

  sections.push({
    id: 'timeline',
    label: '需求时间线',
    priority: 3,
    render: (tier) => {
      if (!users.length) return ''
      const t = T.timeline[tier]
      const L = ['## 需求时间线', '']
      users.slice(0, t.n).forEach((u, i) => L.push(`${i + 1}. ${plain(u.text, t.chars)}`))
      if (users.length > t.n) L.push(`… 其余 ${users.length - t.n} 条已省略（用 \`ass show <引用> --full\` 看全文）`)
      return L.join('\n')
    },
  })

  sections.push({
    id: 'files',
    label: '涉及文件',
    priority: 6,
    render: (tier) => {
      if (!files.length) return ''
      const t = T.files[tier]
      const cap = Math.min(t.n, opts.maxFiles ?? t.n)
      const L = ['## 涉及文件（按提及频次）', '']
      for (const [f, n] of files.slice(0, cap)) L.push(`- \`${f}\`${n > 1 ? ` (${n}×)` : ''}`)
      return L.join('\n')
    },
  })

  sections.push({
    id: 'highlights',
    label: '助手关键结论',
    priority: 5,
    render: (tier) => {
      if (!highlights.length) return ''
      const t = T.highlight[tier]
      const L = ['## 助手关键结论（自动抽取，可能不完整）', '']
      for (const h of highlights.slice(0, t.n)) L.push(`- ${plain(h, t.chars)}`)
      return L.join('\n')
    },
  })

  // ② 从对话里**猜**的决策 / 踩坑 —— 默认不出（见 extractDecisions 的注释），
  //    即使显式打开也是**优先级最低**的一节：预算一紧就先丢它
  sections.push({
    id: 'guess',
    label: '推测的决策与踩坑',
    priority: 7,
    render: (tier) => {
      if (!opts.guess) return ''
      const t = T.guess[tier]
      if (!t.n) return ''
      const guessed = extractDecisions(turns, t.n)
      if (!guessed.length) return ''
      const L = ['## 决策与踩坑（从对话里推测，未经确认，仅供参考）', '']
      for (const g of guessed) L.push(`- ${g}`)
      return L.join('\n')
    },
  })

  sections.push({
    id: 'tail',
    label: '最后一轮完整对话',
    priority: 4,
    render: (tier) => {
      const t = T.tail[tier]
      const tailCount = Math.min(opts.tailMessages ?? t.msgs, t.msgs)
      const nonTool = turns.filter(
        (x) => x.role !== 'tool' && !(x.role === 'assistant' && x.text.trimStart().startsWith('▸')),
      )
      const lastUser = nonTool.map((x) => x.role).lastIndexOf('user')
      const seg = lastUser >= 0 ? nonTool.slice(lastUser) : nonTool.slice(-tailCount)
      const tail =
        seg.length > tailCount + 2
          ? [
              seg[0]!,
              { role: 'assistant' as const, text: `… (${seg.length - 1 - tailCount} 条助手消息已省略) …` },
              ...seg.slice(-tailCount),
            ]
          : seg
      if (!tail.length) return ''
      const L = ['## 最后一轮完整对话', '']
      for (const x of tail) {
        L.push(`**${x.role === 'user' ? '用户' : '助手'}**`)
        L.push('')
        L.push(truncate(x.text, t.chars))
        L.push('')
      }
      return L.join('\n').trimEnd()
    },
  })

  const level = opts.level ?? DEFAULT_LEVEL
  const budget = opts.tokens ?? levelTokens(level)

  let fit = fitSections(sections, budget)
  let footer = ''
  if (fit.demoted.length || fit.dropped.length) {
    // 预算声明自己也要占额度。先按未预留拟合一次、量出声明实际多大，再按"预算 − 声明"
    // 重拟合一次 —— 这样既不浪费额度（预留写死会浪费），也不会被自己的脚注撑爆预算。
    const probe = budgetFooter(fit, level, meta.key)
    const reserved = estimateTokens(probe)
    if (reserved > 0 && Number.isFinite(budget)) {
      fit = fitSections(sections, Math.max(1, budget - reserved))
    }
    footer = budgetFooter(fit, level, meta.key)
  }
  return footer ? `${fit.md}\n\n${footer}` : fit.md
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

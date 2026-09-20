/**
 * 交接预算（R6）：交接摘要按**目标 agent 的上下文预算**自适应裁剪。
 *
 * 为什么需要这一层：`buildBrief` 里原先到处是硬编码的截断长度 —— 原始目标 600 字、
 * 时间线每条 220 字最多 40 条、最后一轮 4000 字 …… 这些数字是拍脑袋定的，
 * 有两个说不通的地方：
 *
 *   1. **不随会话规模变化**。短会话白白浪费额度，长会话里一段 4000 字的报错原文
 *      会把真正该看的「待办」挤到后面。
 *   2. **不知道下一个 agent 还剩多少上下文**。换 agent 时交接内容是要**塞进对话**的，
 *      目标 agent 可能刚读完一个大文件，也可能是一张白纸。
 *
 * 所以这里把「截断」换成「分档 + 拟合」：
 *   - 每一节声明**优先级**（数字越小越先保住）和**多档渲染**（full/compact/minimal）；
 *   - 拟合器只在预算内保留内容：先从**优先级最低**的节开始逐级降档，仍超就整节丢弃；
 *   - 被降档 / 丢弃的节**显式声明**出来，并给出看全文的命令 —— 让下一个 agent 知道
 *     "这里缺了什么、去哪补"，而不是静默地以为摘要就是全部。
 *
 * 两个刻意的设计：
 *   - **输出顺序与裁剪顺序解耦**。节的输出顺序按人的阅读习惯排，裁剪顺序按可信度/重要性排
 *     （比如「主动记录」置顶输出且最后才动，「涉及文件」排在中间但最先被降档）。
 *   - **降档而不是截断**。预算紧时保住的是"结论"本身，而不是"结论的头 100 个字"。
 */

/** 内容档位：由多到少 */
export type Tier = 'full' | 'compact' | 'minimal'

/** 预算档位；`full` 表示不设上限 */
export type BudgetLevel = 'tiny' | 'small' | 'standard' | 'large' | 'full'

export const LEVELS: BudgetLevel[] = ['tiny', 'small', 'standard', 'large', 'full']

/** 各档位的 token 上限（估算值，不是精确计数） */
export const LEVEL_TOKENS: Record<BudgetLevel, number> = {
  tiny: 2000,
  small: 4000,
  standard: 8000,
  large: 16000,
  full: Number.POSITIVE_INFINITY,
}

export const DEFAULT_LEVEL: BudgetLevel = 'standard'

export function parseLevel(v: unknown): BudgetLevel | null {
  const s = String(v ?? '').trim().toLowerCase()
  return (LEVELS as string[]).includes(s) ? (s as BudgetLevel) : null
}

export function levelTokens(level: BudgetLevel | undefined, fallback = DEFAULT_LEVEL): number {
  return LEVEL_TOKENS[level ?? fallback] ?? LEVEL_TOKENS[fallback]
}

/**
 * 中英混排的 token 估算。
 *
 * 不引入分词器（零依赖是硬约束），用行业常用的粗估：CJK 约 1 token/字、
 * ASCII 约 4 字符/token。目的是**分档与比较**，不是精确计费 —— 只要对同一份
 * 内容单调、对不同内容量级正确，拟合器的决策就是对的。
 */
export function estimateTokens(s: string): number {
  let wide = 0
  let narrow = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c > 0x7f) wide++
    else if (c !== 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) narrow++
  }
  return Math.ceil(wide + narrow / 4)
}

export interface BudgetSection {
  id: string
  /** 人看的名字，只用于末尾的预算声明 */
  label: string
  /** 数字越小越先保住；相同优先级按声明顺序 */
  priority: number
  /** 降到 minimal 也必留（只给元信息与「主动记录」这两节） */
  mandatory?: boolean
  /** 该档渲染出的 Markdown；返回空串表示这一档不产出内容 */
  render: (tier: Tier) => string
}

const NEXT: Record<Tier, Tier | null> = { full: 'compact', compact: 'minimal', minimal: null }

export interface Demoted {
  id: string
  label: string
  tier: Tier
}

export interface FitResult {
  md: string
  /** 每节最终落在哪一档 */
  tiers: Record<string, Tier>
  /** 被降档的节（不含已被整节丢弃的） */
  demoted: Demoted[]
  /** 被整节丢弃的节 */
  dropped: { id: string; label: string }[]
  used: number
  budget: number
}

/**
 * 把若干节拟合进预算。
 *
 * 贪心策略：先全部按 full 渲染；超预算就**从优先级最低的节开始**逐级降档
 * （minimal 之后仍超则整节丢弃），每动一次重算一次。节数是个位数，
 * 重算的代价可以忽略，换来的是「先降谁」这件事完全由 priority 决定、可预期。
 */
export function fitSections(sections: BudgetSection[], budget: number): FitResult {
  const tiers: Record<string, Tier> = {}
  const dropped: string[] = []
  for (const s of sections) tiers[s.id] = 'full'

  const tryRender = (s: BudgetSection): string => {
    try {
      return s.render(tiers[s.id] ?? 'full')
    } catch {
      // 单节渲染失败不该让整份摘要消失
      return ''
    }
  }

  const render = (): string =>
    sections
      .filter((s) => !dropped.includes(s.id))
      .map(tryRender)
      .filter(Boolean)
      .join('\n')

  const order = [...sections].sort((a, b) => b.priority - a.priority)
  let md = render()

  // 本事就空的节（比如这次没勾 --guess、会话里没提到文件）不该出现在"已降档"里 ——
  // 那会让下一个 agent 以为"这里有内容被裁掉了"，而实际上本来就没有。
  const empty = new Set(sections.filter((s) => tryRender(s) === '').map((s) => s.id))

  // ① 逐级降档
  while (estimateTokens(md) > budget) {
    const cand = order.find((s) => !empty.has(s.id) && NEXT[tiers[s.id] ?? 'full'] !== null)
    if (!cand) break
    tiers[cand.id] = NEXT[tiers[cand.id] ?? 'full']!
    md = render()
  }

  // ② 仍超预算 → 整节丢弃（必留节与空节除外）
  while (estimateTokens(md) > budget) {
    const cand = order.find((s) => !s.mandatory && !empty.has(s.id) && !dropped.includes(s.id))
    if (!cand) break
    dropped.push(cand.id)
    md = render()
  }

  const labels = new Map(sections.map((s) => [s.id, s.label]))
  return {
    md,
    tiers,
    demoted: sections
      .filter((s) => !empty.has(s.id) && (tiers[s.id] ?? 'full') !== 'full' && !dropped.includes(s.id))
      .map((s) => ({ id: s.id, label: s.label, tier: tiers[s.id]! })),
    dropped: dropped.map((id) => ({ id, label: labels.get(id) ?? id })),
    used: estimateTokens(md),
    budget,
  }
}

export const TIER_LABEL: Record<Tier, string> = { full: '完整', compact: '精简', minimal: '仅要点' }

/**
 * 预算声明。**只在真的裁掉了东西时才输出** —— 没降档就没必要占额度，
 * 否则每份摘要都要多背三行"我没裁"的废话。
 */
export function budgetFooter(fit: FitResult, level: BudgetLevel, ref: string): string {
  if (!fit.demoted.length && !fit.dropped.length) return ''
  const L: string[] = []
  L.push('## 交接预算')
  L.push('')
  const cap = fit.budget === Number.POSITIVE_INFINITY ? '不限' : `上限 ${fit.budget} tokens`
  L.push(`> 档位 \`${level}\`（${cap}）· 实际约 ${fit.used}`)
  if (fit.demoted.length) {
    L.push(`> 已降档：${fit.demoted.map((d) => `${d.label} → ${TIER_LABEL[d.tier]}`).join('、')}`)
  }
  if (fit.dropped.length) {
    L.push(`> 已省略：${fit.dropped.map((d) => d.label).join('、')}`)
  }
  if (ref) L.push(`> 要看全文：\`ass show ${ref} --full\``)
  L.push('')
  L.push('> 上面被省略的内容**不代表它不重要** —— 它只是没挤进这次的预算。')
  L.push('> 需要时请按上面的命令取全文，不要按"摘要里没有"推断"会话里没有"。')
  return L.join('\n')
}

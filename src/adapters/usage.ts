import type { TokenUsage } from '../types'

/**
 * 各 agent 的 usage 字段形状差异很大：
 *   Claude:   message.usage.{input_tokens,output_tokens,cache_read_input_tokens,...}
 *   Codex:    token_usage_record.{usage,turn_token_usage}.{input_tokens,output_tokens,cached_input_tokens,...}
 *   OpenCode: message.data.{tokens:{total,input,output,reasoning,cache:{read,write}},cost}
 *   DSH:      assistant/message.data.usage.{inputTokens,outputTokens,totalTokens,...}
 *   Cursor:   bubble.tokenCount.{inputTokens,outputTokens}（实测大量为 0）
 *   Kiro:     usage_summary.promptTurnSummaries[].{usage,unit:'credit'}
 *
 * 这里统一成一个小结构；没有记录就返回 undefined，不编 0。
 */
function n(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const x = Number(v)
    if (Number.isFinite(x)) return x
  }
  return undefined
}

function pick(obj: any, keys: string[]): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    const v = n(obj[k])
    if (v !== undefined) return v
  }
  return undefined
}

function same(vals: (number | undefined)[]): boolean {
  return vals.every((x) => x === undefined || x === 0)
}

export function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as any
  // 一层常见包装：{ usage: {...} } / { tokens: {...} } / { tokenCount: {...} }
  const base = o.tokens && typeof o.tokens === 'object' ? o.tokens
    : o.usage && typeof o.usage === 'object' ? o.usage
      : o.tokenCount && typeof o.tokenCount === 'object' ? o.tokenCount
        : o

  const cache = base.cache && typeof base.cache === 'object' ? base.cache : base
  const input = pick(base, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'input'])
  const output = pick(base, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'output'])
  const total = pick(base, ['total_tokens', 'totalTokens', 'total'])
  const cacheRead = pick(base, ['cache_read_input_tokens', 'cached_input_tokens', 'cacheReadTokens', 'cacheRead']) ??
    pick(cache, ['read'])
  const cacheWrite = pick(base, ['cache_creation_input_tokens', 'cache_write_input_tokens', 'cacheWriteTokens', 'cacheWrite']) ??
    pick(cache, ['write'])
  const reasoning = pick(base, ['reasoning_output_tokens', 'reasoningTokens', 'reasoning', 'thinking_tokens']) ??
    n(base.output_tokens_details?.thinking_tokens) ??
    n(base.outputTokensDetails?.thinkingTokens)
  const cost = n(o.cost) ?? n(base.cost)

  if (same([input, output, total, cacheRead, cacheWrite, reasoning]) && cost === undefined) return undefined
  const out: TokenUsage = { unit: 'token' }
  if (input !== undefined) out.input = input
  if (output !== undefined) out.output = output
  if (total !== undefined) out.total = total
  if (cacheRead !== undefined) out.cacheRead = cacheRead
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite
  if (reasoning !== undefined) out.reasoning = reasoning
  if (cost !== undefined) out.cost = cost
  return out
}

/** Kiro 这类只记 credit 的来源 */
export function creditUsage(value: number | undefined, unit: 'credit' = 'credit'): TokenUsage | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return { unit, cost: value }
}

export function mergeUsage(list: (TokenUsage | undefined)[]): TokenUsage | undefined {
  const out: TokenUsage = { unit: 'token' }
  let any = false
  for (const u of list) {
    if (!u) continue
    any = true
    for (const k of ['input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning', 'cost'] as const) {
      const v = u[k]
      if (typeof v === 'number') out[k] = (out[k] || 0) + v
    }
    if (u.unit === 'credit') out.unit = 'credit'
  }
  return any ? out : undefined
}

function fnum(v: number | undefined): string {
  if (v === undefined) return '?'
  if (v > 0 && v < 1) return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(Math.round(v))
}

/** 单行展示：token 用 ↑输入 ↓输出；credit 用数量 */
export function usageText(u: TokenUsage | undefined): string {
  if (!u) return ''
  if (u.unit === 'credit') {
    const v = u.cost ?? u.total ?? u.input
    return v === undefined ? '' : `${fnum(v)} credit`
  }
  const parts: string[] = []
  if (u.input !== undefined) parts.push(`↑${fnum(u.input)}`)
  if (u.output !== undefined) parts.push(`↓${fnum(u.output)}`)
  if (!parts.length && u.total !== undefined) parts.push(`Σ${fnum(u.total)}`)
  return parts.join(' ')
}

/** title 属性里的完整明细 */
export function usageTitle(u: TokenUsage | undefined): string {
  if (!u) return ''
  if (u.unit === 'credit') {
    const v = u.cost ?? u.total ?? u.input
    return v === undefined ? '' : `${v} credit`
  }
  const bits: string[] = []
  if (u.input !== undefined) bits.push(`输入 ${u.input}`)
  if (u.output !== undefined) bits.push(`输出 ${u.output}`)
  if (u.cacheRead) bits.push(`缓存读 ${u.cacheRead}`)
  if (u.cacheWrite) bits.push(`缓存写 ${u.cacheWrite}`)
  if (u.reasoning) bits.push(`推理 ${u.reasoning}`)
  if (u.total !== undefined) bits.push(`总计 ${u.total}`)
  if (u.cost !== undefined) bits.push(`费用 ${u.cost}`)
  return bits.join(' · ')
}

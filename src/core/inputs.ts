import { fmtTime } from '../util'
import type { Turn } from '../types'

/** Keep original parsed text and attachment data; never apply summary budgets. */
export function sessionInputs(turns: Turn[], round?: number) {
  const inputs = turns.filter(t => t.role === 'user').map((t, i) => ({ number: i + 1, ...t }))
  if (round !== undefined && (!Number.isSafeInteger(round) || round < 1 || round > inputs.length)) {
    throw new Error(`输入编号应为 1 到 ${inputs.length} 的整数；该会话可读取 ${inputs.length} 条用户输入。`)
  }
  return { total: inputs.length, inputs: round === undefined ? inputs : inputs.slice(round - 1, round) }
}

export function inputsMarkdown(key: string, result: ReturnType<typeof sessionInputs>): string {
  const out = [`# 用户输入 · ${key}`, '', `共 ${result.total} 条，当前显示 ${result.inputs.length} 条。按记录顺序编号；仅包含适配器可读取的用户消息，不含 AI 回复，不做摘要或截断。`, '']
  if (!result.total) out.push('没有找到可读取的用户输入。')
  for (const t of result.inputs) {
    out.push(`## 第 ${t.number} 条输入`, '')
    if (t.at !== undefined && Number.isFinite(t.at)) out.push(`时间：${fmtTime(t.at, true)}（本地时间）`, '')
    out.push(t.text || '（无文字输入）', '')
    if (t.images?.length) out.push(`附件：${t.images.length} 张图片（此处不转换图片内容；可用 ass last 搬运末尾提问及图片）。`, '')
    for (const file of t.files || []) {
      out.push(`附件文件：${file.name}${file.path ? ` · ${file.path}` : ''}`, '')
      if (file.text) out.push(file.text, '')
    }
  }
  return out.join('\n')
}

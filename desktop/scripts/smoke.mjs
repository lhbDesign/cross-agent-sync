#!/usr/bin/env node
/**
 * 数据层冒烟测试：不起 GUI，直接验证 IPC 依赖的 CLI JSON 出口。
 * 用普通 node 跑（不是 Electron），能过就说明数据契约没问题。
 */
import { runJson } from '../electron/cli.mjs'

const repo = process.argv[2] || process.cwd()
let failed = 0

async function check(name, fn) {
  try {
    const detail = await fn()
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (e) {
    failed++
    console.log(`  ❌ ${name} — ${e.message}`)
  }
}

console.log(`冒烟测试（repo=${repo}）`)

await check('agents --json --fast', async () => {
  const a = await runJson(['agents', '--json', '--fast'])
  if (!Array.isArray(a) || !a.length) throw new Error('应为非空数组')
  if (!a.every((x) => x.id && x.label && Array.isArray(x.sources))) throw new Error('字段缺失')
  if (!a.every((x) => typeof x.counted === 'boolean')) throw new Error('缺少 counted')
  return `${a.length} 个 agent，可用 ${a.filter((x) => x.available).length} 个`
})

await check('repos --json', async () => {
  const r = await runJson(['repos', '--json'], { cwd: repo })
  if (!Array.isArray(r)) throw new Error('应为数组')
  if (!r.every((x) => x.repo && typeof x.sessions === 'number' && x.byAgent && typeof x.byAgent === 'object')) {
    throw new Error('缺少 repo / sessions / byAgent')
  }
  return `${r.length} 个项目`
})

await check('status --json', async () => {
  const s = await runJson(['status', '--json', '--repo', repo])
  for (const k of ['repo', 'sessions', 'tasks', 'contextLine', 'note']) {
    if (!(k in s)) throw new Error(`缺少字段 ${k}`)
  }
  return `${s.sessions.length} 个会话，${s.tasks.length} 个任务`
})

await check('list --json', async () => {
  const l = await runJson(['list', '--json', '--repo', repo, '--limit', '5'])
  if (!Array.isArray(l)) throw new Error('应为数组')
  return `${l.length} 条`
})

await check('show --json --full', async () => {
  const l = await runJson(['list', '--json', '--repo', repo, '--limit', '1'])
  if (!l.length) return '没有会话，跳过'
  const s = await runJson(['show', l[0].key, '--json', '--full'], { cwd: repo })
  if (!Array.isArray(s.turns)) throw new Error('缺少 turns')
  if (!s.turns.every((t) => typeof t.role === 'string')) throw new Error('turn 缺少 role')
  return `${s.turns.length} 条消息（${l[0].key}）`
})

await check('context --json', async () => {
  const c = await runJson(['context', '--json', '--repo', repo])
  if (!Array.isArray(c.entries)) throw new Error('缺少 entries')
  return `${c.entries.length} 条笔记`
})

await check('tasks --json', async () => {
  const t = await runJson(['tasks', '--json'], { cwd: repo })
  if (!Array.isArray(t)) throw new Error('应为数组')
  return `${t.length} 个任务`
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)

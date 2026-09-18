import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-ctx-'))
const proj = path.join(home, 'my-project')
fs.mkdirSync(proj, { recursive: true })

// 造一个会话，用来验证「主动记录的上下文会置顶出现在交接摘要里」
const claudeDir = path.join(home, '.claude', 'projects', '-tmp-proj')
fs.mkdirSync(claudeDir, { recursive: true })
fs.writeFileSync(
  path.join(claudeDir, 'abcd-7777.jsonl'),
  JSON.stringify({ type: 'user', cwd: proj, timestamp: '2026-09-10T10:00:00.000Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: '把表格改成可编辑' }] } }) + '\n',
)

// ⚠️ 必须同时设到「当前进程」，否则被测模块会用真实的 HOME/数据目录
process.env.ASS_HOME = home
process.env.ASS_CONFIG_DIR = path.join(home, 'config')
process.env.ASS_DATA_DIR = path.join(home, 'data')
const env = { ...process.env }
const api = await import('../dist/index.js')
const run = (...args) => execFileSync(process.execPath, ['dist/cli.js', ...args], { env, encoding: 'utf8' })
const emptyCfg = { agents: { claude: false, codex: false, cursor: false, opencode: false } }

test('记录决策/坑/约束/待办：编号自增，重复的自动跳过', () => {
  const a = api.addContext(proj, [{ kind: 'decision', text: '接口错误统一走 msg 字段' }])
  assert.equal(a.added.length, 1)
  assert.equal(a.added[0].id, 'c1')

  const b = api.addContext(proj, [
    { kind: 'dead-end', text: '在拦截器里重试会死循环' },
    { kind: 'decision', text: '接口错误统一走 msg 字段' }, // 重复
    { kind: 'todo', text: '需求 5：虚拟滚动' },
  ])
  assert.equal(b.added.length, 2, '重复的那条不该再加')
  assert.equal(b.skipped, 1)
  assert.deepEqual(b.added.map((x) => x.id), ['c2', 'c3'])
})

test('待办能勾掉，勾掉后默认不显示，--all 时才显示', () => {
  const e = api.updateContext(proj, 'c3', { done: true })
  assert.equal(e.done, true)
  const md = api.contextMarkdown(proj)
  assert.doesNotMatch(md, /需求 5：虚拟滚动/, '已完成的待办默认不出现')
  assert.match(api.contextMarkdown(proj, { includeDone: true }), /\[x\] `c3` 需求 5：虚拟滚动/)

  const stats = api.contextStats(proj)
  assert.equal(stats.openTodos.length, 0)
  assert.equal(stats.decisions.length, 1)
  assert.equal(stats.deadEnds.length, 1)
})

test('分组渲染：决策 / 别踩这个坑 / 约束 各自成节', () => {
  const md = api.contextMarkdown(proj)
  assert.match(md, /### 决策/)
  assert.match(md, /### 别踩这个坑/)
  assert.match(md, /`c1` 接口错误统一走 msg 字段/)
  assert.match(md, /`c2` 在拦截器里重试会死循环/)
})

test('交接摘要里，主动记录的上下文排在原始目标之前（置顶）', () => {
  const found = api.findSession('claude:abcd-7777', { ...emptyCfg, agents: { claude: true, codex: false, cursor: false, opencode: false } })
  assert.ok(found)
  const md = api.buildBrief(found.meta, api.readSession(found))
  const iCtx = md.indexOf('由 agent 主动记录')
  const iGoal = md.indexOf('## 原始目标')
  assert.ok(iCtx > 0, '摘要里应该有「主动记录」这一节')
  assert.ok(iGoal > 0)
  assert.ok(iCtx < iGoal, '主动记录的上下文必须置顶')
  assert.doesNotMatch(md, /从对话里推测/, '默认不应带上猜测的内容')
})

test('已完成的待办勾掉后不再出现在摘要里', () => {
  const found = api.findSession('claude:abcd-7777', { agents: { claude: true, codex: false, cursor: false, opencode: false } })
  const md = api.buildBrief(found.meta, api.readSession(found))
  assert.doesNotMatch(md, /虚拟滚动/)
})

test('CLI：ass context 能记、能看、能勾', () => {
  const out = run('context', '--repo', proj, '--decision', '统一用 dayjs，不再引 moment')
  assert.match(out, /已记录/)
  assert.match(out, /统一用 dayjs/)

  const listed = run('context', '--repo', proj)
  assert.match(listed, /统一用 dayjs/)

  const done = run('context', '--repo', proj, '--todo', '补一版单测', '--done', 'c5')
  assert.match(done, /已完成 c5/)
})

test('CLI：没有记录时给出怎么用的提示', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-ctx-empty-'))
  const out = run('context', '--repo', fresh)
  assert.match(out, /还没有记录任何决策/)
  assert.match(out, /ass context --decision/)
})

test('MCP：session_remember 记录，session_status 能读到', async () => {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_remember', arguments: { repo: proj, decision: '导出走 worker，不阻塞主线程', dead_end: '在 render 里发请求会导致重复调用' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_status', arguments: { repo: proj } } },
  ]
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/mcp.js'], { env: { ...env, ASS_NO_PREWARM: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    const err = []
    p.stdout.on('data', (d) => (buf += d))
    p.stderr.on('data', (d) => err.push(String(d)))
    for (const r of requests) p.stdin.write(JSON.stringify(r) + '\n')
    p.stdin.end()
    const t = setTimeout(() => { p.kill(); reject(new Error('MCP 超时 ' + err.join(''))) }, 30000)
    p.on('close', () => {
      clearTimeout(t)
      resolve(buf.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    })
  })
  const remember = out.find((r) => r.id === 2)
  assert.match(remember.result.content[0].text, /已记录/)
  assert.match(remember.result.content[0].text, /导出走 worker/)

  const status = out.find((r) => r.id === 3).result.content[0].text
  assert.match(status, /决策 \/ 踩坑 \/ 待办/, 'session_status 应该带上主动记录的上下文')
  assert.match(status, /导出走 worker/)
  assert.match(status, /在 render 里发请求会导致重复调用/)
})

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
  assert.match(md, /### 踩坑记录/)
  assert.match(md, /`c1` 接口错误统一走 msg 字段/)
  assert.match(md, /`c2` 在拦截器里重试会死循环/)
})

test('交接摘要里，主动记录的上下文排在原始目标之前（置顶）', () => {
  const found = api.findSession('claude:abcd-7777', { ...emptyCfg, agents: { claude: true, codex: false, cursor: false, opencode: false } })
  assert.ok(found)
  const md = api.buildBrief(found.meta, api.readSession(found))
  const iCtx = md.indexOf('## 项目笔记')
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
  assert.match(status, /项目笔记/, 'session_status 应该带上主动记录的上下文')
  assert.match(status, /导出走 worker/)
  assert.match(status, /在 render 里发请求会导致重复调用/)
})

test('旧笔记不猜来源，长笔记可展开，完成示例使用实际待办编号', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-notes-display-'))
  const long = '需要逐项确认接口兼容性。'.repeat(30) + '完整内容结尾'
  api.addContext(repo, [
    { kind: 'decision', text: '历史决策', source: 'ass' },
    { kind: 'todo', text: long, source: 'agent', session: 'claude:known-session' },
  ])
  const out = run('context', '--repo', repo)
  assert.match(out, /来源会话：未记录/)
  assert.match(out, /来源会话：claude:known-session/)
  assert.match(out, /保存方式：CLI/)
  assert.match(out, /记录时间：/)
  assert.match(out, /ass context --done c2/)
  assert.match(out, /ass context --details/)
  assert.doesNotMatch(out, /完整内容结尾|可信度高于/)
  assert.match(run('context', '--repo', repo, '--details'), /完整内容结尾/)
  assert.equal(api.readContext(repo).entries[1].text, long)
  run('context', '--repo', repo, '--done', 'c2')
  assert.doesNotMatch(run('context', '--repo', repo), /ass context --done/)
  assert.match(run('context', '--repo', repo, '--all', '--details'), /已标记完成/)
})

test('关联进展不自动完成待办；取消、重开兼容旧 done 字段', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-note-status-'))
  api.addContext(repo, [{ kind: 'todo', text: '验证线上下载' }])
  run('context', '--repo', repo, '--note', '本地检查通过，线上待验证', '--related-to', 'c1')
  assert.equal(api.contextStats(repo).openTodos.length, 1)
  assert.match(api.contextMarkdown(repo), /关联记录：c1/)
  run('context', '--repo', repo, '--cancel', 'c1')
  assert.equal(api.contextStats(repo).openTodos.length, 0)
  assert.doesNotMatch(api.contextMarkdown(repo), /验证线上下载/)
  assert.match(run('context', '--repo', repo, '--all'), /已取消/)
  run('context', '--repo', repo, '--reopen', 'c1')
  assert.equal(api.contextStats(repo).openTodos.length, 1)
  api.updateContext(repo, 'c1', { done: true })
  assert.equal(api.readContext(repo).entries[0].done, true)
  assert.throws(() => api.updateContext(repo, 'c2', { done: true }), /只有待办/)
  assert.throws(() => api.updateContext(repo, 'c1', { remove: true }), /关联历史/)
})

test('决策替代可追溯；无效关联不写入；删除后编号不复用', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-note-links-'))
  api.addContext(repo, [{ kind: 'decision', text: '采用旧方案' }])
  run('context', '--repo', repo, '--decision', '采用新方案，因为旧方案不支持并发', '--supersedes', 'c1')
  assert.doesNotMatch(api.contextMarkdown(repo), /采用旧方案/)
  assert.match(api.contextMarkdown(repo, { includeDone: true }), /已被 c2 替代/)
  assert.equal(api.contextStats(repo).decisions.length, 1)
  const before = api.readContext(repo)
  assert.throws(() => api.addContext(repo, [{ kind: 'note', text: '无效', relatedTo: 'c999' }]), /不存在/)
  assert.throws(() => api.addContext(repo, [{ kind: 'todo', text: '错误类型', supersedes: 'c2' }]), /决策/)
  assert.deepEqual(api.readContext(repo), before)
  assert.throws(() => api.updateContext(repo, 'c2', { remove: true }), /关联历史/)
  api.addContext(repo, [{ kind: 'note', text: '临时笔记' }])
  api.updateContext(repo, 'c3', { remove: true })
  assert.equal(api.addContext(repo, [{ kind: 'note', text: '新笔记' }]).added[0].id, 'c4')
})

test('MCP 支持关联、替代、取消和重新打开，并报告无效编号', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-mcp-lifecycle-'))
  const args = [
    { decision: '旧方案' },
    { decision: '新方案', supersedes: 'c1' },
    { todo: '线上验收' },
    { note: '本地通过', related_to: 'c3' },
    { cancel: 'c3' },
    { reopen: 'c3' },
    { done: 'c999' },
    { suggestion: '建议优化缓存' },
    { confirm: 'c5', evidence: '用户明确说按缓存方案修改' },
    { review: 'c5', result: 'completed', evidence: '缓存集成测试通过', session: 'codex:review' },
  ]
  const requests = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    ...args.map((a, i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: 'session_remember', arguments: { repo, ...a } } }))]
  const responses = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['dist/mcp.js'], { env: { ...env, ASS_NO_PREWARM: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    proc.stdout.on('data', (d) => output += d)
    proc.on('error', reject)
    const timer = setTimeout(() => { proc.kill(); reject(new Error('MCP 超时')) }, 30000)
    proc.on('close', () => { clearTimeout(timer); resolve(output.trim().split('\n').map((line) => JSON.parse(line))) })
    proc.stdin.end(requests.map((r) => JSON.stringify(r)).join('\n') + '\n')
  })
  const content = (id) => responses.find((r) => r.id === id).result
  assert.match(content(3).content[0].text, /替代旧决策：c1/)
  assert.match(content(5).content[0].text, /关联记录：c3/)
  assert.match(content(6).content[0].text, /已取消 c3/)
  assert.match(content(7).content[0].text, /已重新打开 c3/)
  assert.equal(content(8).isError, true)
  assert.match(content(9).content[0].text, /建议 \/ 待确认/)
  assert.match(content(10).content[0].text, /已确认授权 c5/)
  assert.match(content(11).content[0].text, /已保存核对结果 c5/)
  assert.equal(api.readContext(repo).entries.find((e) => e.id === 'c5').reviews[0].session, 'codex:review')
  assert.equal(api.contextStats(repo).openTodos.length, 1)
  assert.equal(api.contextStats(repo).decisions.length, 1)
})

test('建议不代表授权，确认必须有依据；旧待办保留未知授权', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-authorization-'))
  run('context', '--repo', repo, '--suggestion', '建议重构请求层')
  api.addContext(repo, [{ kind: 'todo', text: '旧待办' }])
  assert.equal(api.contextStats(repo).openTodos.length, 1)
  assert.match(api.contextMarkdown(repo), /建议 \/ 待确认/)
  assert.match(api.contextMarkdown(repo), /授权：未记录/)
  assert.throws(() => api.updateContext(repo, 'c1', { confirm: true }), /依据/)
  assert.throws(() => api.updateContext(repo, 'c1', { done: true }), /只有待办/)
  run('context', '--repo', repo, '--confirm', 'c1', '--evidence', '用户说：按方案修改请求层', '--session', 'codex:approval')
  const entry = api.readContext(repo).entries[0]
  assert.equal(entry.kind, 'todo')
  assert.equal(entry.authorization.session, 'codex:approval')
  assert.equal(api.readContext(repo).entries[1].authorization, undefined)
  assert.equal(api.contextStats(repo).openTodos.length, 2)
})

test('核对要求依据和合法结果，保存历史并独立于授权', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-review-'))
  api.addContext(repo, [{ kind: 'todo', text: '接口修复' }])
  const before = api.readContext(repo)
  assert.throws(() => api.updateContext(repo, 'c1', { review: 'completed' }), /依据/)
  assert.throws(() => api.updateContext(repo, 'c1', { review: 'bad', evidence: 'x' }), /核对结果/)
  assert.deepEqual(api.readContext(repo), before)
  run('context', '--repo', repo, '--review', 'c1', '--result', 'partial', '--evidence', '拦截器已修复，下载场景未验证')
  assert.match(api.contextMarkdown(repo), /部分完成/)
  run('context', '--repo', repo, '--review', 'c1', '--result', 'completed', '--evidence', '已核对 src/api.ts，下载集成测试通过', '--session', 'claude:review')
  const entry = api.readContext(repo).entries[0]
  assert.equal(entry.done, true)
  assert.equal(entry.authorization, undefined)
  assert.equal(entry.reviews.length, 2)
  assert.equal(entry.reviews[1].session, 'claude:review')
  assert.match(run('context', '--repo', repo, '--all'), /部分完成/)
  api.updateContext(repo, 'c1', { review: 'unknown', evidence: '当前环境不能重现，完成状态无法确认' })
  assert.equal(api.contextStats(repo).openTodos.length, 1)
  assert.match(api.contextMarkdown(repo), /无法确认/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-task-'))
const proj = path.join(home, 'pay-refactor')
fs.mkdirSync(proj, { recursive: true })

// claude 会话：第一条用户消息就是「原始目标」的来源
const claudeDir = path.join(home, '.claude', 'projects', '-tmp-proj')
fs.mkdirSync(claudeDir, { recursive: true })
fs.writeFileSync(
  path.join(claudeDir, 'aaaa-1111.jsonl'),
  [
    { type: 'user', cwd: proj, timestamp: '2026-09-01T10:00:00.000Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: '把支付模块从回调改成 Promise' }] } },
    { type: 'assistant', cwd: proj, timestamp: '2026-09-01T10:01:00.000Z', message: { model: 'claude-x', content: [{ type: 'text', text: '好的' }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n',
)

// codex 会话：第二个 agent，用来验证跨 agent 绑定
const codexDir = path.join(home, '.codex', 'sessions')
fs.mkdirSync(codexDir, { recursive: true })
fs.writeFileSync(
  path.join(codexDir, 'rollout-2026-09-02T10-00-00-cccc-2222.jsonl'),
  [
    { type: 'session_meta', payload: { session_id: 'cccc-2222', cwd: proj, timestamp: '2026-09-02T10:00:00.000Z', originator: 'codex_cli' } },
    { type: 'response_item', timestamp: '2026-09-02T10:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '接着做需求 4-5' }] } },
    { type: 'response_item', timestamp: '2026-09-02T10:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到' }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n',
)

// ⚠️ 必须同时设到「当前进程」，否则被测模块会用真实的 HOME/数据目录
process.env.ASS_HOME = home
process.env.ASS_CONFIG_DIR = path.join(home, 'config')
process.env.ASS_DATA_DIR = path.join(home, 'data')
const env = { ...process.env }
const api = await import('../dist/index.js')

// ⚠️ 绝对路径 + cwd=proj：好几个命令（task add 不给引用时）依赖 process.cwd()
const CLI = path.resolve('dist/cli.js')
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: proj })

/** 失败的命令会非零退出，execFileSync 直接抛；这里把退出码和 stdout 一起捞出来 */
function runFail(...args) {
  try {
    return { code: 0, out: run(...args) }
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') }
  }
}

const cfg = { agents: { claude: true, codex: true, cursor: false, opencode: false } }
const metaOf = (key) => api.findSession(key, cfg).meta

/** 让某个会话成为「最近在写的那个」 */
function touch(key, ms) {
  const f = key.startsWith('claude') ? path.join(claudeDir, 'aaaa-1111.jsonl') : path.join(codexDir, 'rollout-2026-09-02T10-00-00-cccc-2222.jsonl')
  const t = new Date(Date.now() + ms)
  fs.utimesSync(f, t, t)
}

test('建任务 + 绑会话：幂等，重复绑不新增段', () => {
  const a = api.taskAttach({ task: '支付重构', meta: metaOf('claude:aaaa-1111'), label: '需求 1-3' })
  assert.equal(a.created, true)
  assert.equal(a.added, true)
  assert.equal(a.task.id, 't1')
  assert.equal(a.task.sessions.length, 1)
  assert.equal(a.task.sessions[0].agentLabel, 'Claude Code', '段里要留 agent 展示名，会话没了也能显示')
  assert.equal(a.task.sessions[0].label, '需求 1-3')

  const b = api.taskAttach({ task: '支付重构', meta: metaOf('claude:aaaa-1111'), label: '需求 1-3（改）' })
  assert.equal(b.created, false, '同名不新建任务')
  assert.equal(b.added, false, '同一会话不重复插段')
  assert.equal(b.updated, true)
  assert.equal(b.task.sessions.length, 1)
  assert.equal(b.task.sessions[0].label, '需求 1-3（改）')
})

test('跨 agent 绑进同一个任务；任务名比较忽略空格', () => {
  const r = api.taskAttach({ task: '支付 重构', meta: metaOf('codex:cccc-2222'), label: '需求 4-5', note: '卡在退款回调' })
  assert.equal(r.created, false, '「支付 重构」应命中已有的「支付重构」')
  assert.equal(r.added, true)
  assert.equal(r.task.id, 't1')
  assert.equal(r.task.sessions.length, 2)
  assert.equal(r.task.sessions[1].note, '卡在退款回调')
  assert.equal(api.taskList({ includeDone: true }).length, 1, '不该多出一个任务')
})

test('taskView：合成目标 / 链 / 当前段 / 决策 / 待办', () => {
  api.addContext(proj, [
    { kind: 'decision', text: '接口错误统一走 msg 字段' },
    { kind: 'dead-end', text: '重试放拦截器会导致 refresh 死循环' },
    { kind: 'todo', text: '退款回调重试幂等' },
    { kind: 'todo', text: '订单列表虚拟滚动' },
  ])

  touch('codex', 0) // 让 codex 成为最近在写的那个
  const v = api.taskView('支付重构', cfg)
  assert.deepEqual(v.chain, ['claude', 'codex'])
  assert.equal(v.sessions, 2)
  assert.equal(v.goal.text, '把支付模块从回调改成 Promise', '原始目标来自第一个会话的首条用户消息')
  // 引用一律是 8 位前缀（和文档里的 `claude:31c5af10` 一致）
  assert.equal(v.goal.from, 'claude:aaaa-111')
  assert.equal(v.segments.find((s) => s.current).key, 'codex:cccc-2222', '当前段 = 活会话里最近更新的')
  assert.equal(v.staleCount, 0)
  assert.ok(v.decisions.some((d) => d.text.includes('msg 字段')))
  assert.ok(v.decisions.some((d) => d.kind === 'dead-end'), '踩坑也算决策类，要出现在同一节')
  assert.equal(v.totalTodos, 2)
})

test('Markdown 形状：包含已批准预览里的每一节', () => {
  const md = api.taskResumeMarkdown(api.taskView('支付重构', cfg))
  assert.match(md, /# 任务：支付重构/)
  assert.match(md, /claude→codex/)
  assert.match(md, /## 原始目标（claude:aaaa-111）/)
  assert.match(md, /把支付模块从回调改成 Promise/)
  assert.match(md, /## 决策/)
  assert.match(md, /`c1` 接口错误统一走 msg 字段/)
  assert.match(md, /（已排除）/, 'dead-end 要标出来')
  assert.match(md, /## 各段进展/)
  assert.match(md, /1\. `claude:aaaa-111`/)
  assert.match(md, /2\. `codex:cccc-222`/)
  assert.match(md, /## 待办/)
  assert.match(md, /- \[ \] 退款回调重试幂等/)
  assert.doesNotMatch(md, /#\d/, '任务视图里绝不能出现 #N 这种不稳的引用')
})

test('会话读不到时降级：仍能渲染，标记「会话已不可读」，其它段不受影响', () => {
  api.taskAttach({ task: '降级验证', meta: metaOf('claude:aaaa-1111') })
  // 手工塞一个不存在的会话
  const f = api.TASK_FILE
  const file = JSON.parse(fs.readFileSync(f, 'utf8'))
  const t = file.tasks.find((x) => x.name === '降级验证')
  t.sessions.push({ key: 'codex:deadbeef', agent: 'codex', id: 'deadbeef', agentLabel: 'Codex', title: '已消失的会话', repo: proj, at: Date.now(), startedAt: null, updatedAt: null })
  fs.writeFileSync(f, JSON.stringify(file, null, 2))

  const v = api.taskView('降级验证', cfg)
  assert.equal(v.staleCount, 1)
  assert.equal(v.segments[1].live, false)
  assert.equal(v.segments[0].live, true, '其它段照常')
  const md = api.taskResumeMarkdown(v)
  assert.match(md, /会话已不可读/)
  assert.match(md, /已消失的会话/, '数据来自快照，标题还在')
})

test('删除只认完整名字；删掉的任务 id 不会复用', () => {
  assert.equal(api.findTask('降级', { fuzzy: false }), null, '精确模式不匹配「支付」这种部分名字')
  assert.ok(api.findTask('降级', { fuzzy: true }), '模糊模式才允许')

  assert.equal(api.taskRemove('降级'), null, '破坏性操作不能靠模糊匹配命中')
  const gone = api.taskRemove('降级验证')
  assert.equal(gone.name, '降级验证')
  assert.equal(api.findTask('降级验证'), null)

  // 删掉的是 t2；下一个任务必须拿到 t3，不能回收 t2
  const next = api.taskAttach({ task: '新任务', meta: metaOf('claude:aaaa-1111') })
  assert.equal(next.task.id, 't3', 'id 必须永不复用，否则历史里的 t2 会指到新任务上')
})

test('currentSession：取本仓库最近写入的那个，可按 agent 收敛', () => {
  touch('claude', 0)
  const cur = api.currentSession(proj, cfg)
  assert.equal(cur.found.meta.key, 'claude:aaaa-1111')
  assert.equal(cur.stale, false)

  const curCodex = api.currentSession(proj, cfg, { agent: 'codex' })
  assert.equal(curCodex.found.meta.key, 'codex:cccc-2222', '指定 agent 后只在该 agent 里挑')
})

test('CLI：task add → task → resume → resume --json', () => {
  const add = run('task', 'add', '命令行任务', 'claude:aaaa-1111', '--label', '需求 1-3')
  assert.match(add, /已新建任务/)
  assert.match(add, /已绑定/)
  assert.match(add, /第 1 段/)

  const listed = run('task')
  assert.match(listed, /命令行任务/)

  const resumed = run('resume', '命令行任务')
  assert.match(resumed, /原始目标/)
  assert.match(resumed, /需求 1-3/)

  const asJson = JSON.parse(run('resume', '命令行任务', '--json'))
  assert.equal(asJson.segments.length, 1)
  assert.equal(asJson.name, '命令行任务')

  const miss = runFail('resume', '并不存在的任务')
  assert.match(miss.out, /没找到任务/)
})

test('操作失败时：非零退出码，且不 dump 整篇帮助', () => {
  const r = runFail('resume', '并不存在的任务')
  assert.notEqual(r.code, 0, '脚本得能靠退出码判断失败（`ass resume X || ...`）')
  assert.doesNotMatch(r.out, /agent-session-sync \(ass\) — 跨 agent 会话同步/, '操作失败不该把整篇 usage 打出来')

  const rm = runFail('task', 'rm', '支付')
  assert.notEqual(rm.code, 0)
  assert.match(rm.out, /删除只认完整名字/, '破坏性操作必须拒绝模糊匹配')
  assert.doesNotMatch(rm.out, /agent-session-sync \(ass\) — 跨 agent 会话同步/)

  // 用法写错才该打整篇帮助
  const syntax = runFail('task', 'rm')
  assert.notEqual(syntax.code, 0)
  assert.match(syntax.out, /用法：ass task rm/)
})

test('CLI：ass task add 不给引用 = 绑本仓库最近的会话', () => {
  touch('codex', 0)
  const out = run('task', 'add', '隐式绑定')
  assert.match(out, /已绑定/)
  assert.match(out, /codex:cccc-2222/, '应该绑到最近在写的那个会话')
})

test('CLI：ass resume --save 落成本仓库的交接记录', () => {
  const out = run('resume', '支付重构', '--save')
  assert.match(out, /已存成本仓库的交接记录/)
  const latest = path.join(home, 'data', 'handoffs', 'pay-refactor', 'latest.md')
  assert.ok(fs.existsSync(latest), 'latest.md 应该落盘')
  assert.match(fs.readFileSync(latest, 'utf8'), /# 任务：支付重构/)
  // 落盘之后，ass 首屏和 session_status 都能自动看到它
  assert.match(run('resume', '支付重构', '--md'), /# 任务：支付重构/)
})

test('MCP：session_task 绑定 → session_task_resume 取回 → session_status 列出任务', async () => {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_task', arguments: { task: 'MCP 任务', session: 'claude:aaaa-1111', label: '需求 1-3', repo: proj } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_task_resume', arguments: { task: 'MCP 任务', repo: proj } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_status', arguments: { repo: proj } } },
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

  const init = out.find((r) => r.id === 1)
  assert.match(init.result.instructions, /session_task/, 'instructions 里必须提到任务，否则 agent 永远发现不了')
  assert.match(init.result.instructions, /session_task_resume/)

  const bound = out.find((r) => r.id === 2).result.content[0].text
  assert.match(bound, /已绑定/)
  assert.match(bound, /claude:aaaa-1111/, '必须回显实际绑了哪个会话，这是猜错时的安全阀')

  const resume = out.find((r) => r.id === 3).result.content[0].text
  assert.match(resume, /# 任务：MCP 任务/)
  assert.match(resume, /## 原始目标/)
  assert.match(resume, /## 各段进展/)

  const status = out.find((r) => r.id === 4).result.content[0].text
  assert.match(status, /## 本仓库的任务/, 'session_status 要列出本仓库任务，agent 才知道该 resume 哪个')
  assert.match(status, /MCP 任务/)
})

test('原始目标取的是会话第一句，而不是「最近 N 条里的第一句」', () => {
  // 造一个长会话：第一句之后还有 60 轮。如果派生时用了 readSession(..., { tail: N })，
  // 拿到的会是尾部切片的第一条 —— 跟原始目标毫无关系。这个坑真实发生过。
  const longDir = path.join(home, '.claude', 'projects', '-tmp-long')
  fs.mkdirSync(longDir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'user', cwd: proj, timestamp: '2026-09-05T10:00:00.000Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: '这是真正的第一句原始目标' }] } }),
    JSON.stringify({ type: 'assistant', cwd: proj, timestamp: '2026-09-05T10:00:01.000Z', message: { content: [{ type: 'text', text: '好的' }] } }),
  ]
  for (let i = 0; i < 60; i++) {
    lines.push(JSON.stringify({ type: 'user', cwd: proj, timestamp: '2026-09-05T10:01:00.000Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: `第 ${i + 1} 轮后续需求` }] } }))
    lines.push(JSON.stringify({ type: 'assistant', cwd: proj, timestamp: '2026-09-05T10:01:01.000Z', message: { content: [{ type: 'text', text: '收到' }] } }))
  }
  fs.writeFileSync(path.join(longDir, 'beef-9999.jsonl'), lines.join('\n') + '\n')

  const r = api.taskAttach({ task: '长会话任务', meta: api.findSession('claude:beef-9999', cfg).meta })
  const v = api.taskView(r.task.id, cfg)
  assert.equal(v.goal.text, '这是真正的第一句原始目标', 'tail 切片会让这里取到第 60 轮附近的消息')
  assert.match(api.taskResumeMarkdown(v), /## 原始目标/)
})

test('显式 --goal 能覆盖已经派生错的目标', () => {
  const r = api.taskAttach({ task: '长会话任务', meta: api.findSession('claude:beef-9999', cfg).meta, goal: '人工写的目标' })
  assert.equal(r.task.goal, '人工写的目标', '不给覆盖的话，派生错了只能删任务重建')
  assert.equal(r.task.goalFrom, 'user')
})

test('MCP：tools/list 暴露两个新工具', async () => {
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/mcp.js'], { env: { ...env, ASS_NO_PREWARM: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    p.stdout.on('data', (d) => (buf += d))
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n')
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
    p.stdin.end()
    const t = setTimeout(() => { p.kill(); reject(new Error('MCP 超时')) }, 30000)
    p.on('close', () => {
      clearTimeout(t)
      resolve(buf.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    })
  })
  const names = out.find((r) => r.id === 2).result.tools.map((t) => t.name)
  assert.ok(names.includes('session_task'), `工具列表里应该有 session_task，实际：${names.join(', ')}`)
  assert.ok(names.includes('session_task_resume'))
})

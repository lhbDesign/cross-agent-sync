import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 造一个“像 Continue / Gemini CLI 那样、一个文件一个会话”的目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-generic-'))
const sessionsDir = path.join(tmp, 'sessions')
fs.mkdirSync(sessionsDir, { recursive: true })
const proj = path.join(tmp, 'proj')
fs.mkdirSync(proj, { recursive: true })

fs.writeFileSync(
  path.join(sessionsDir, 'abc.json'),
  JSON.stringify({
    sessionId: 'abc',
    title: 'Untitled Session',
    workspaceDirectory: proj,
    history: [
      { message: { role: 'user', content: '把首页的表格改成可编辑' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: '好的，先看下现状' }] } },
      { message: { role: 'user', content: '顺便把导出按钮去掉' } },
    ],
  }),
)
// 索引文件（形状不对）应该被安静跳过，不能算成一个会话
fs.writeFileSync(path.join(sessionsDir, 'index.json'), JSON.stringify({ sessions: [] }))

process.env.ASS_HOME = tmp
process.env.ASS_CONFIG_DIR = path.join(tmp, 'config')
process.env.ASS_DATA_DIR = path.join(tmp, 'data')
const api = await import('../dist/index.js')

const cfg = {
  agents: { claude: false, codex: false, cursor: false, opencode: false },
  customAgents: [
    {
      id: 'continue',
      label: 'Continue',
      type: 'json',
      path: sessionsDir,
      records: 'history',
      map: { id: 'sessionId', cwd: 'workspaceDirectory', title: 'title', role: 'message.role', text: 'message.content' },
    },
  ],
}

test('自定义 agent（type=json）：一个文件一个会话，字段用点号路径取', () => {
  const { sessions } = api.listSessions({ includeAll: true }, cfg)
  assert.equal(sessions.length, 1, '形状不对的 index.json 不应该被当成会话')
  const s = sessions[0]
  assert.equal(s.key, 'continue:abc')
  assert.equal(s.agentLabel, 'Continue')
  assert.equal(s.turns, 2, '两条 user 才算 2 轮')
  assert.equal(s.bubbles, 3)
  assert.equal(s.preview, '顺便把导出按钮去掉')
  assert.equal(s.repo, fs.realpathSync(proj), 'cwd 应该被归一化到仓库根')
})

test('自定义 agent：消息正文是分片数组时也能拼出文本', () => {
  const found = api.findSession('continue:abc', cfg)
  const turns = api.readSession(found)
  assert.equal(turns.length, 3)
  assert.equal(turns[1].role, 'assistant')
  assert.equal(turns[1].text, '好的，先看下现状')
})

test('自定义 agent：roleMap 能把该 agent 自己的角色名映射过来', () => {
  const cfg2 = {
    ...cfg,
    customAgents: [
      {
        id: 'fake',
        type: 'json',
        path: sessionsDir,
        records: 'history',
        roleMap: { human: 'user', gemini: 'assistant' },
        map: { id: 'sessionId', role: 'message.role', text: 'message.content' },
      },
    ],
  }
  const { sessions } = api.listSessions({ includeAll: true }, cfg2)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].turns, 2, 'role=user 默认就认，所以还是 2 轮')
})

test('detectSources：至少能列出内置 agent 的可用性', () => {
  const list = api.detectSources({ agents: { claude: false, codex: false, cursor: false, opencode: false }, customAgents: [] })
  assert.ok(Array.isArray(list))
  for (const d of list) {
    assert.equal(typeof d.id, 'string')
    assert.equal(typeof d.available, 'boolean')
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 先造一个假 HOME 结构，再动态 import（模块在 import 时读 env）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-test-'))
const projDir = path.join(tmp, 'proj')
const claudeDir = path.join(tmp, 'claude-projects')
const codexDir = path.join(tmp, 'codex-sessions')
const dataDir = path.join(tmp, 'data')
fs.mkdirSync(projDir, { recursive: true })
fs.mkdirSync(path.join(claudeDir, '-tmp-proj'), { recursive: true })
fs.mkdirSync(codexDir, { recursive: true })

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// —— Claude 会话：1 轮用户提问 + 1 张图片 + 1 个助手的回复
const claudeFile = path.join(claudeDir, '-tmp-proj', 'aaaa-1111.jsonl')
fs.writeFileSync(
  claudeFile,
  [
    { type: 'user', cwd: projDir, timestamp: '2026-09-01T10:00:00.000Z', origin: { kind: 'human' },
      message: { content: [{ type: 'text', text: '帮我看这个 UI 问题' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }] } },
    { type: 'assistant', cwd: projDir, timestamp: '2026-09-01T10:00:05.000Z', message: { model: 'claude-x', content: [{ type: 'text', text: '好的我看下' }] } },
    { type: 'user', cwd: projDir, timestamp: '2026-09-01T10:01:00.000Z',
      message: { content: [{ type: 'tool_result', content: 'x' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n',
)

// —— Codex 会话：新版格式（response_item.message），带图片
const codexFile = path.join(codexDir, 'rollout-2026-09-02T10-00-00-cccc-2222.jsonl')
fs.writeFileSync(
  codexFile,
  [
    { type: 'session_meta', payload: { session_id: 'cccc-2222', cwd: projDir, timestamp: '2026-09-02T10:00:00.000Z', originator: 'codex_cli' } },
    { type: 'response_item', timestamp: '2026-09-02T10:00:01.000Z',
      payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>噪音</INSTRUCTIONS>' },
        { type: 'input_text', text: '把首页的表格改成可编辑' },
        { type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}` },
      ] } },
    { type: 'response_item', timestamp: '2026-09-02T10:00:09.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n',
)

// —— 旧版 Codex 格式（event_msg.user_message）也要能认
const codexOld = path.join(codexDir, 'rollout-2026-08-01T10-00-00-dddd-3333.jsonl')
fs.writeFileSync(
  codexOld,
  [
    { type: 'session_meta', payload: { session_id: 'dddd-3333', cwd: projDir, timestamp: '2026-08-01T10:00:00.000Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '老格式的提问' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '老格式的回复' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n',
)

process.env.ASS_CLAUDE_DIR = claudeDir
process.env.ASS_CODEX_DIR = codexDir
process.env.ASS_CODEX_ARCHIVED = path.join(tmp, 'nope')
process.env.ASS_OPENCODE_DB = path.join(tmp, 'nope.db')
process.env.ASS_CONFIG_DIR = path.join(tmp, 'config')
process.env.ASS_DATA_DIR = dataDir

const api = await import('../dist/index.js')

test('claude adapter：认出会话、轮次和图片', () => {
  const { sessions } = api.listSessions({ includeAll: true }, { agents: { claude: true, codex: false, cursor: false, opencode: false } })
  assert.equal(sessions.length, 1)
  const s = sessions[0]
  assert.equal(s.agent, 'claude')
  assert.equal(s.id, 'aaaa-1111')
  assert.equal(s.turns, 1, 'tool_result 不算用户轮次')
  assert.equal(s.repo, fs.realpathSync(projDir))

  const found = api.findSession(`claude:${s.id}`, { agents: { claude: true, codex: false, cursor: false, opencode: false } })
  assert.ok(found)
  const turns = api.readSession(found)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].role, 'user')
  assert.equal(turns[0].images.length, 1)
  assert.equal(turns[0].images[0].mediaType, 'image/png')
})

test('codex adapter：新版 response_item 格式 + 注入上下文过滤', () => {
  const cfg = { agents: { claude: false, codex: true, cursor: false, opencode: false } }
  const { sessions } = api.listSessions({ includeAll: true }, cfg)
  assert.equal(sessions.length, 2)
  const neu = sessions.find((s) => s.id === 'cccc-2222')
  assert.ok(neu, '新版会话应该被认出来')
  assert.equal(neu.turns, 1, '注入的 AGENTS.md 上下文不算用户轮次')
  assert.equal(neu.title, '把首页的表格改成可编辑')

  const found = api.findSession('codex:cccc-2222', cfg)
  const turns = api.readSession(found)
  const user = turns.find((t) => t.role === 'user')
  assert.equal(user.text, '把首页的表格改成可编辑')
  assert.equal(user.images.length, 1, 'codex 的 input_image 应该被解析出来')
})

test('codex adapter：老格式 event_msg 也能认', () => {
  const cfg = { agents: { claude: false, codex: true, cursor: false, opencode: false } }
  const { sessions } = api.listSessions({ includeAll: true }, cfg)
  const old = sessions.find((s) => s.id === 'dddd-3333')
  assert.ok(old)
  assert.equal(old.turns, 1)
  assert.equal(old.title, '老格式的提问')
})

test('resolveRef：支持 #N / agent:id / 标题片段', () => {
  const cfg = { agents: { claude: true, codex: true, cursor: false, opencode: false } }
  const { sessions } = api.listSessions({ includeAll: true }, cfg)
  const byHash = api.resolveRef('#1', sessions, sessions.map((s) => s.key))
  assert.equal(byHash.key, sessions[0].key)
  const byAgent = api.resolveRef('codex:cccc', sessions, [])
  assert.equal(byAgent.id, 'cccc-2222')
  const byTitle = api.resolveRef('可编辑', sessions, [])
  assert.equal(byTitle.id, 'cccc-2222')
})

test('saveImages：把 base64 落成真文件，且能连续编号', () => {
  const dir = path.join(tmp, 'attachments')
  const img = { mediaType: 'image/png', base64: PNG_B64 }
  const a = api.saveImages([img], 'claude:aaa', dir, 1)
  const b = api.saveImages([img], 'claude:aaa', dir, 2)
  assert.equal(path.basename(a[0]), 'img-1.png')
  assert.equal(path.basename(b[0]), 'img-2.png')
  assert.ok(fs.statSync(a[0]).size > 0)
  assert.ok(fs.readFileSync(a[0]).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
})

test('清理注入内容：剥容器标签后仍保留真实提问', () => {
  // 整条都是注入 → 丢掉
  assert.equal(api.isInjected('<system-reminder>你在 plan mode</system-reminder>'), true)
  assert.equal(api.isInjected('# AGENTS.md instructions\n\n<INSTRUCTIONS>规则</INSTRUCTIONS>'), true)
  // 注入 + 真实提问混在一条 → 只剥注入
  const mixed = '# AGENTS.md instructions\n\n<INSTRUCTIONS>规则</INSTRUCTIONS>\n帮我把表格改成可编辑'
  assert.equal(api.isInjected(mixed), false)
  assert.equal(api.cleanUserText(mixed), '帮我把表格改成可编辑')
  assert.equal(api.cleanUserText('<system-reminder>x</system-reminder>\n真实问题'), '真实问题')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 所有数据源都落到临时 HOME，避免碰到本机真实会话。
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-domestic-')))

const proj = (name) => {
  const p = path.join(tmp, 'projects', name)
  fs.mkdirSync(p, { recursive: true })
  return p
}
const projCb = proj('codebuddy-project')
const projWb = proj('workbuddy-project')
const projQd = proj('qoder-project')
const projLg = proj('lingma-project')
const projTr = proj('trae-project')
const projTrHist = proj('trae-history-project')
const projKi = proj('kiro-project')
const projDsh = proj('dsh-project')

const cbRoot = path.join(tmp, 'codebuddy', 'projects')
const wbRoot = path.join(tmp, 'workbuddy', 'projects')
const qdRoot = path.join(tmp, 'qoder', 'projects')
const lgDb = path.join(tmp, 'lingma', 'local.db')
const qdDb = path.join(tmp, 'qoder', 'main.sqlite')
const trRoot = path.join(tmp, 'trae')
const kiNewRoot = path.join(tmp, 'kiro-new')
const kiOldRoot = path.join(tmp, 'kiro-old')
const dshRoot = path.join(tmp, 'dsh', 'sessions')
fs.mkdirSync(path.join(cbRoot, 'cb-a'), { recursive: true })
fs.mkdirSync(path.join(wbRoot, 'wb-a'), { recursive: true })
fs.mkdirSync(path.join(qdRoot, 'qd-a'), { recursive: true })
fs.mkdirSync(path.dirname(lgDb), { recursive: true })
fs.mkdirSync(path.dirname(qdDb), { recursive: true })
fs.mkdirSync(path.join(trRoot, 'ws-full'), { recursive: true })
fs.mkdirSync(path.join(trRoot, 'ws-hist'), { recursive: true })
fs.mkdirSync(path.join(kiNewRoot, 'ws-hash', 'sess_kiro-new'), { recursive: true })
fs.mkdirSync(kiOldRoot, { recursive: true })
fs.mkdirSync(path.join(dshRoot, '--dsh-project--', 'sess-dsh-1'), { recursive: true })

const jsonl = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

// CodeBuddy：Claude 兼容 JSONL
const cbFile = path.join(cbRoot, 'cb-a', 'cb-sess-1.jsonl')
jsonl(cbFile, [
  { type: 'user', sessionId: 'cb-sess-1', cwd: projCb, timestamp: '2026-11-01T10:00:00Z', message: { content: [{ type: 'text', text: 'CodeBuddy 用户提问' }] } },
  { type: 'assistant', sessionId: 'cb-sess-1', cwd: projCb, timestamp: '2026-11-01T10:00:01Z', message: { content: [{ type: 'text', text: 'CodeBuddy 助手回答' }] } },
])

// WorkBuddy：事件流
const wbFile = path.join(wbRoot, 'wb-a', 'wb-sess-1.jsonl')
jsonl(wbFile, [
  { type: 'message', role: 'user', sessionId: 'wb-sess-1', cwd: projWb, timestamp: '2026-11-02T10:00:00Z', content: [{ type: 'text', text: 'WorkBuddy 问题' }] },
  { type: 'message', role: 'assistant', sessionId: 'wb-sess-1', timestamp: '2026-11-02T10:00:01Z', content: 'WorkBuddy 回答' },
  { type: 'ai-title', sessionId: 'wb-sess-1', aiTitle: 'WorkBuddy 标题' },
])

// Qoder CLI JSONL（Claude 兼容）
const qdFile = path.join(qdRoot, 'qd-a', 'qd-sess-1.jsonl')
jsonl(qdFile, [
  { type: 'user', sessionId: 'qd-sess-1', cwd: projQd, timestamp: '2026-11-03T10:00:00Z', message: { content: [{ type: 'text', text: 'Qoder 用户提问' }] } },
  { type: 'assistant', sessionId: 'qd-sess-1', cwd: projQd, timestamp: '2026-11-03T10:00:01Z', message: { content: [{ type: 'text', text: 'Qoder 助手回答' }] } },
])

// Trae：workspace state 里的明文会话 / 输入历史
fs.writeFileSync(path.join(trRoot, 'ws-full', 'workspace.json'), JSON.stringify({ folder: `file://${projTr}` }))
fs.writeFileSync(path.join(trRoot, 'ws-hist', 'workspace.json'), JSON.stringify({ folder: `file://${projTrHist}` }))
const fullStore = {
  list: [{
    sessionId: 'trae-sess-1',
    title: 'Trae 标题',
    createdAt: 1762200000000,
    updatedAt: 1762200001000,
    messages: [
      { role: 'user', content: 'Trae 提问', timestamp: 1762200000000 },
      { role: 'assistant', content: 'Trae 回答', timestamp: 1762200001000 },
    ],
  }],
}
const histStore = [{ inputText: 'Trae 历史提问' }]

// Kiro：新 sessions 会话 + 旧 Continue 内核会话
const kiSessionDir = path.join(kiNewRoot, 'ws-hash', 'sess_kiro-new')
fs.writeFileSync(path.join(kiSessionDir, 'session.json'), JSON.stringify({
  id: 'sess_kiro-new',
  title: 'Kiro 新会话标题',
  workspacePaths: [projKi],
  createdAt: '2026-11-04T10:00:00Z',
  lastModifiedAt: '2026-11-04T10:00:02Z',
  modelId: 'auto',
}))
jsonl(path.join(kiSessionDir, 'messages.jsonl'), [
  { id: 'm1', timestamp: '2026-11-04T10:00:00Z', payload: { type: 'user', content: 'Kiro 新会话提问' } },
  { id: 'm2', timestamp: '2026-11-04T10:00:01Z', payload: { type: 'assistant', content: '...', operationType: 'Reasoning' } },
  { id: 'm3', timestamp: '2026-11-04T10:00:02Z', payload: { type: 'assistant', content: 'Kiro 新会话回答', operationType: 'Say' } },
])
const kiOldFile = path.join(kiOldRoot, 'kiro-old-1.json')
fs.writeFileSync(kiOldFile, JSON.stringify({
  sessionId: 'kiro-old-1',
  title: 'Kiro 旧会话标题',
  workspaceDirectory: `file://${projKi}`,
  history: [
    { message: { role: 'user', content: [{ type: 'text', text: 'Kiro 旧提问' }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'Kiro 旧回答' }] } },
  ],
}))
fs.writeFileSync(path.join(kiOldRoot, 'sessions.json'), JSON.stringify([
  { sessionId: 'kiro-old-1', title: 'Kiro 旧会话标题', dateCreated: '1762500000000', workspaceDirectory: `file://${projKi}` },
]))

// DeepSeek Harness：append-only JSONL（未压缩版本，便于测试；线上默认 .jsonl.zstd）
const dshFile = path.join(dshRoot, '--dsh-project--', 'sess-dsh-1', 'session.v4.jsonl')
jsonl(dshFile, [
  { type: 'session', version: 4, id: 'sess-dsh-1', createdAt: 1762600000000, cwd: projDsh },
  { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1762600000000 },
  { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'DSH 提问' }], source: { kind: 'user' } }, seq: 1, time: 1762600000001 },
  { type: 'user/message', data: { id: 'u0', role: 'user', content: [{ type: 'text', text: '合成上下文' }], source: { kind: 'context' } }, seq: 2, time: 1762600000002 },
  { type: 'session/title', data: { title: 'DSH 标题' }, seq: 3, time: 1762600000003 },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'DSH 回答' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } } }, seq: 4, time: 1762600000004 },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 5, time: 1762600000005 },
])

let hasSqlite = true
try {
  execFileSync('sqlite3', ['--version'], { stdio: 'ignore' })
} catch {
  hasSqlite = false
}

function makeDb(file, sql) {
  if (!hasSqlite) return
  execFileSync('sqlite3', [file], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] })
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

// Qoder 桌面 SQLite
makeDb(qdDb, `
  create table chat_sessions(session_id text, title text, cwd text, created_at integer, updated_at integer, deleted_at integer, archived integer);
  create table chat_session_messages(session_id text, message_id text, sequence integer, payload_json text, created_at integer);
  insert into chat_sessions values ('qdb-1','Qoder DB 标题',${q(qdDbPath())},1762300000000,1762300002000,null,0);
  insert into chat_session_messages values ('qdb-1','m1',1,${q(JSON.stringify({ role: 'user', text: 'Qoder DB 提问', timestamp: 1762300000000, parts: [{ type: 'text', text: 'Qoder DB 提问' }] }))},1762300000000);
  insert into chat_session_messages values ('qdb-1','m2',2,${q(JSON.stringify({ role: 'assistant', parts: [{ type: 'text', text: 'Qoder DB 回答' }] }))},1762300001000);
`)
function qdDbPath() { return projQd }

// Lingma SQLite：question/answer 加密，extra.originalContent 与 summary 明文
makeDb(lgDb, `
  create table chat_session(session_id text, session_title text, project_uri text, project_name text, gmt_create integer, gmt_modified integer);
  create table chat_message(id text, session_id text, role text, content text, summary text, gmt_create integer);
  create table chat_record(request_id text, session_id text, extra text, summary text, gmt_create integer, gmt_modified integer);
  insert into chat_session values ('lg-1','灵码会话标题',${q(projLg)},'lingma-project',1762400000000,1762400002000);
  insert into chat_message values ('m1','lg-1','user','encrypted',null,1762400000000);
  insert into chat_message values ('m2','lg-1','assistant','encrypted',null,1762400001000);
  insert into chat_record values ('r1','lg-1',${q(JSON.stringify({ originalContent: '灵码提问' }))},'灵码助手摘要',1762400000000,1762400001000);
`)

// Trae state.vscdb
function makeTraeDb(dir, key, value) {
  const db = path.join(dir, 'state.vscdb')
  makeDb(db, `create table ItemTable(key text, value text); insert into ItemTable values (${q(key)},${q(JSON.stringify(value))});`)
}
if (hasSqlite) {
  makeTraeDb(path.join(trRoot, 'ws-full'), 'memento/icube-ai-agent-storage', fullStore)
  makeTraeDb(path.join(trRoot, 'ws-hist'), 'icube-ai-agent-storage-input-history', histStore)
}

Object.assign(process.env, {
  ASS_HOME: tmp,
  ASS_CONFIG_DIR: path.join(tmp, 'config'),
  ASS_DATA_DIR: path.join(tmp, 'data'),
  ASS_CODEBUDDY_DIR: cbRoot,
  ASS_WORKBUDDY_DIR: wbRoot,
  ASS_QODER_DIR: qdRoot,
  ASS_QODER_DB: qdDb,
  ASS_LINGMA_DB: lgDb,
  ASS_TRAE_DIR: trRoot,
  ASS_KIRO_DIR: kiNewRoot,
  ASS_KIRO_AGENT_DIR: kiOldRoot,
  ASS_DSH_DIR: dshRoot,
})

const api = await import('../dist/index.js')
const cfg = { only: ['codebuddy', 'workbuddy', 'qoder', 'lingma', 'trae', 'kiro', 'dsh'] }
const list = () => api.listSessions({ includeAll: true }, cfg).sessions
const one = (key) => {
  const found = api.findSession(key, cfg)
  assert.ok(found, `missing session ${key}`)
  return api.readSession(found)
}

test('CodeBuddy：Claude 兼容 JSONL 的会话与正文', () => {
  const s = list().find((x) => x.key === 'codebuddy:cb-sess-1')
  assert.ok(s)
  assert.equal(s.title, 'CodeBuddy 用户提问')
  const turns = one('codebuddy:cb-sess-1')
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [
    ['user', 'CodeBuddy 用户提问'],
    ['assistant', 'CodeBuddy 助手回答'],
  ])
})

test('WorkBuddy：message 事件流、标题与正文', () => {
  const s = list().find((x) => x.key === 'workbuddy:wb-sess-1')
  assert.ok(s)
  assert.equal(s.title, 'WorkBuddy 标题')
  const turns = one('workbuddy:wb-sess-1')
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [
    ['user', 'WorkBuddy 问题'],
    ['assistant', 'WorkBuddy 回答'],
  ])
})

test('Qoder：CLI JSONL 与桌面 SQLite 都能读', () => {
  const all = list()
  const jsonl = all.find((x) => x.key === 'qoder:qd-sess-1')
  assert.ok(jsonl)
  assert.equal(one('qoder:qd-sess-1')[1].text, 'Qoder 助手回答')

  if (!hasSqlite) return
  const db = all.find((x) => x.key === 'qoder:qdb-1')
  assert.ok(db)
  assert.equal(db.title, 'Qoder DB 标题')
  assert.deepEqual(one('qoder:qdb-1').map((t) => t.text), ['Qoder DB 提问', 'Qoder DB 回答'])
})

test('Lingma：明文提问 + 助手摘要', { skip: !hasSqlite && '本机没有 sqlite3' }, () => {
  const s = list().find((x) => x.key === 'lingma:lg-1')
  assert.ok(s)
  assert.equal(s.title, '灵码会话标题')
  const turns = one('lingma:lg-1')
  assert.equal(turns[0].role, 'user')
  assert.equal(turns[0].text, '灵码提问')
  assert.equal(turns[1].role, 'assistant')
  assert.match(turns[1].text, /^（灵码摘要）灵码助手摘要/)
})

test('Trae：workspaceState 明文会话 + 仅输入历史兜底', { skip: !hasSqlite && '本机没有 sqlite3' }, () => {
  const all = list()
  const full = all.find((x) => x.key === 'trae:trae-sess-1')
  assert.ok(full)
  assert.equal(full.title, 'Trae 标题')
  assert.deepEqual(one('trae:trae-sess-1').map((t) => t.text), ['Trae 提问', 'Trae 回答'])

  const hist = all.find((x) => x.agent === 'trae' && x.extra?.variant === 'input-history')
  assert.ok(hist)
  assert.match(hist.title, /输入历史/)
  assert.deepEqual(one(hist.key).map((t) => t.text), ['Trae 历史提问'])
})

test('Kiro：新 sessions 会话与旧 kiroagent 会话', () => {
  const all = list()
  const fresh = all.find((x) => x.key === 'kiro:sess_kiro-new')
  assert.ok(fresh)
  assert.equal(fresh.title, 'Kiro 新会话标题')
  assert.deepEqual(one('kiro:sess_kiro-new').map((t) => [t.role, t.text]), [
    ['user', 'Kiro 新会话提问'],
    ['assistant', 'Kiro 新会话回答'],
  ], 'Reasoning 的 "..." 占位不能当成助手回答')

  const old = all.find((x) => x.key === 'kiro:kiro-old-1')
  assert.ok(old)
  assert.equal(old.title, 'Kiro 旧会话标题')
  assert.deepEqual(one('kiro:kiro-old-1').map((t) => t.text), ['Kiro 旧提问', 'Kiro 旧回答'])
})

test('DeepSeek Harness：JSONL 会话与合成消息过滤', () => {
  const all = list()
  const s = all.find((x) => x.key === 'dsh:sess-dsh-1')
  assert.ok(s)
  assert.equal(s.title, 'DSH 标题')
  assert.equal(s.model, 'deepseek-chat')
  assert.deepEqual(one('dsh:sess-dsh-1').map((t) => [t.role, t.text]), [
    ['user', 'DSH 提问'],
    ['assistant', 'DSH 回答'],
  ], 'source.kind 不是 user 的合成上下文不能算用户输入')
})

test('所有新数据源都进入只读保护区，读取不修改源文件', { skip: !hasSqlite && '本机没有 sqlite3' }, () => {
  api.armGuard(api.buildAdapters(cfg, { includeUnavailable: true }))
  for (const p of [cbRoot, wbRoot, qdRoot, lgDb, trRoot, kiNewRoot, kiOldRoot, dshRoot]) {
    assert.ok(api.protectedBy(p), `${p} should be protected`)
  }
  const before = [cbFile, wbFile, qdFile, qdDb, lgDb, path.join(kiSessionDir, 'messages.jsonl'), kiOldFile, dshFile].map((f) => fs.readFileSync(f))
  list()
  one('codebuddy:cb-sess-1')
  one('lingma:lg-1')
  one('trae:trae-sess-1')
  one('kiro:sess_kiro-new')
  one('dsh:sess-dsh-1')
  const after = [cbFile, wbFile, qdFile, qdDb, lgDb, path.join(kiSessionDir, 'messages.jsonl'), kiOldFile, dshFile].map((f) => fs.readFileSync(f))
  assert.deepEqual(after, before)
})

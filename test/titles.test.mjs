import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-titles-'))
const codexHome = path.join(tmp, 'codex')
const claudeProject = path.join(tmp, 'claude', 'project')
const sessions = path.join(codexHome, 'sessions')
const archived = path.join(codexHome, 'archived_sessions')
for (const dir of [sessions, archived, claudeProject]) fs.mkdirSync(dir, { recursive: true })
Object.assign(process.env, {
  ASS_HOME: tmp, ASS_CODEX_DIR: sessions, ASS_CODEX_ARCHIVED: archived,
  ASS_CODEX_INDEX: path.join(codexHome, 'session_index.jsonl'),
  ASS_CODEX_DB: path.join(codexHome, 'state_5.sqlite'),
  ASS_CLAUDE_DIR: path.dirname(claudeProject),
  ASS_CONFIG_DIR: path.join(tmp, 'config'), ASS_DATA_DIR: path.join(tmp, 'data'),
})
const api = await import('../dist/index.js')
const jsonl = (file, rows) => fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
const append = (file, row) => fs.appendFileSync(file, JSON.stringify(row) + '\n')
const codexFile = path.join(sessions, 'rollout-2026-10-14T10-00-00-file-id.jsonl')
jsonl(codexFile, [
  { type: 'session_meta', payload: { id: 'actual-id', cwd: tmp, timestamp: '2026-10-14T10:00:00Z' } },
  { type: 'event_msg', payload: { type: 'user_message', message: '原始提问与标题不同，读取标题不能改变这条用户消息。' } },
])
jsonl(path.join(archived, 'rollout-2026-10-13T10-00-00-archived-id.jsonl'), [
  { type: 'session_meta', payload: { session_id: 'archived-id', cwd: tmp, timestamp: '2026-10-13T10:00:00Z' } },
  { type: 'event_msg', payload: { type: 'user_message', message: '归档会话仍然应该可以被读取，并且正确显示标题。' } },
])
const indexFile = process.env.ASS_CODEX_INDEX
const ctx = { cache: {} }
const codex = () => new Map(api.codexAdapter.list({}, ctx).map(m => [m.id, m]))

test('Codex: indexed titles, archived sessions, rename without transcript changes, and safe fallback', () => {
  const before = fs.readFileSync(codexFile)
  const original = codex().get('actual-id')
  assert.match(original.title, /^原始提问/)
  jsonl(indexFile, [
    { id: 'actual-id', thread_name: '旧标题' },
    { id: 'actual-id', thread_name: '解释 ass 会话同步信息' },
    { id: 'archived-id', thread_name: '归档标题' },
    { id: 'other-id', thread_name: '不属于这个会话' },
  ])
  fs.appendFileSync(indexFile, '{broken json\n')
  assert.equal(codex().get('actual-id').title, '解释 ass 会话同步信息')
  assert.equal(codex().get('archived-id').title, '归档标题')
  assert.ok(api.protectedBy(indexFile), 'index must remain protected')
  assert.equal(api.protectedBy(path.join(codexHome, 'config.toml')), null, 'metadata must not protect unrelated configuration')
  append(indexFile, { id: 'actual-id', thread_name: '用户改名' })
  append(indexFile, { id: 'actual-id', thread_name: { invalid: true } })
  assert.equal(codex().get('actual-id').title, '用户改名')
  assert.equal(codex().get('actual-id').preview, original.preview)
  fs.unlinkSync(indexFile)
  assert.equal(codex().get('actual-id').title, original.title, 'overlay must not leak into cache')
  assert.deepEqual(fs.readFileSync(codexFile), before)
  assert.equal(api.codexAdapter.read(original)[0].text, original.preview)
})

let hasSqlite = true
try { execFileSync('sqlite3', ['--version'], { stdio: 'ignore' }) } catch { hasSqlite = false }
test('Codex: read-only database title wins; DB-only rename refreshes and corrupt DB falls back', { skip: !hasSqlite }, () => {
  const db = process.env.ASS_CODEX_DB
  jsonl(indexFile, [{ id: 'actual-id', thread_name: '索引标题' }])
  execFileSync('sqlite3', [db], { input: "create table threads(id text, title text); insert into threads values ('actual-id','数据库标题');" })
  const before = fs.readFileSync(db)
  assert.equal(codex().get('actual-id').title, '数据库标题')
  assert.deepEqual(fs.readFileSync(db), before)
  assert.ok(api.protectedBy(db))
  assert.equal(api.protectedBy(path.join(codexHome, 'config.toml')), null)
  execFileSync('sqlite3', [db], { input: "update threads set title='数据库改名';" })
  assert.equal(codex().get('actual-id').title, '数据库改名')
  execFileSync('sqlite3', [db], { input: "update threads set title='  ';" })
  assert.equal(codex().get('actual-id').title, '索引标题')
  fs.writeFileSync(db, 'not a database')
  assert.equal(codex().get('actual-id').title, '索引标题')
  fs.unlinkSync(db)
})

test('Claude: latest AI title, user rename precedence, session identity and old-cache invalidation', () => {
  const file = path.join(claudeProject, 'claude-id.jsonl')
  jsonl(file, [
    { type: 'user', cwd: tmp, message: { content: '用户原始问题' } },
    { type: 'ai-title', sessionId: 'claude-id', aiTitle: '最早标题' },
    { type: 'ai-title', sessionId: 'claude-id', aiTitle: '最新标题' },
    { type: 'ai-title', sessionId: 'other-id', aiTitle: '别的会话标题' },
  ])
  const ctx = { cache: {} }
  const list = () => api.claudeAdapter.list({}, ctx).find(m => m.id === 'claude-id')
  assert.equal(list().title, '最新标题')
  const st = fs.statSync(file)
  ctx.cache.files[file] = { stamp: `${Math.round(st.mtimeMs)}:${st.size}`, meta: { ...list(), title: '旧版本缓存' } }
  assert.equal(list().title, '最新标题')
  append(file, { type: 'custom-title', sessionId: 'claude-id', customTitle: '手动命名' })
  append(file, { type: 'ai-title', aiTitle: '后续 AI 标题' })
  assert.equal(list().title, '手动命名')
  append(file, { type: 'custom-title', customTitle: '再次改名' })
  append(file, { type: 'custom-title', customTitle: '  ' })
  assert.equal(list().title, '再次改名')
  assert.equal(list().preview, '用户原始问题')
})

test('Claude: project index refreshes independently and missing/malformed index falls back', () => {
  const file = path.join(claudeProject, 'indexed.jsonl')
  const index = path.join(claudeProject, 'sessions-index.json')
  jsonl(file, [{ type: 'user', cwd: tmp, message: { content: '索引缺失时的提问' } }])
  const ctx = { cache: {} }
  const list = () => api.claudeAdapter.list({}, ctx).find(m => m.id === 'indexed')
  assert.equal(list().title, '索引缺失时的提问')
  fs.writeFileSync(index, JSON.stringify({ entries: [{ sessionId: 'indexed', summary: '索引中的标题' }, null] }))
  assert.equal(list().title, '索引中的标题')
  fs.writeFileSync(index, JSON.stringify({ entries: [{ sessionId: 'indexed', customTitle: '索引中的改名', summary: '旧标题' }] }))
  assert.equal(list().title, '索引中的改名')
  fs.writeFileSync(index, '{broken')
  assert.equal(list().title, '索引缺失时的提问')
  fs.writeFileSync(index, 'null')
  assert.equal(list().title, '索引缺失时的提问')
})

test('Generic JSONL: latest mapped title and non-string/blank fallback', () => {
  const dir = path.join(tmp, 'custom')
  fs.mkdirSync(dir)
  const file = path.join(dir, 'custom.jsonl')
  jsonl(file, [
    { sessionId: 'custom', role: 'user', text: '第一条提问', name: '旧标题' },
    { name: '用户改名' }, { name: ' ' }, { name: { invalid: true } },
  ])
  const a = api.makeCustomAdapter({ id: 'custom', type: 'jsonl', path: dir, map: { title: 'name' } })
  assert.equal(a.list({}, { cache: {} })[0].title, '用户改名')
  jsonl(file, [{ sessionId: 'custom', role: 'user', text: '第一条提问', name: ' ' }])
  assert.equal(a.list({}, { cache: {} })[0].title, '第一条提问')
})

test('Generic SQLite: latest mapped title follows query order', { skip: !hasSqlite }, () => {
  const file = path.join(tmp, 'custom.db')
  execFileSync('sqlite3', [file], { input: `
    create table messages(sessionId text, role text, text text, title text, timestamp integer);
    insert into messages values ('s','user','最初提问','旧标题',1);
    insert into messages values ('s','assistant','回复','新标题',2);
    insert into messages values ('s','assistant','回复','  ',3);
  ` })
  const a = api.makeCustomAdapter({ id: 'custom', type: 'sqlite', path: file, query: 'select * from messages order by timestamp' })
  assert.equal(a.list({}, { cache: {} })[0].title, '新标题')
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-oc-')))
const proj = path.join(tmp, 'Desktop', 'work', 'my-app')
fs.mkdirSync(proj, { recursive: true })
const dbFile = path.join(tmp, 'opencode.db')

const create = `
create table project (id text primary key, worktree text);
create table session (id text primary key, project_id text, directory text, title text,
                      time_created integer, time_updated integer, model text, parent_id text);
create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);

insert into project values ('proj', '${proj}');

-- A：两轮用户消息，preview 应该取**最后**那条，而不是标题（标题是第一句）
insert into session values ('ses_a','proj','${proj}','第一句话',1,100,'m1',null);
insert into message values ('m1','ses_a',10,10,'{"role":"user"}');
insert into part values ('p1','m1','ses_a',10,10,'{"type":"text","text":"第一句话"}');
insert into message values ('m2','ses_a',20,20,'{"role":"assistant"}');
insert into part values ('p2','m2','ses_a',20,20,'{"type":"text","text":"好的"}');
insert into message values ('m3','ses_a',30,30,'{"role":"user"}');
insert into part values ('p3','m3','ses_a',30,30,'{"type":"text","text":"最后一句"}');

-- B：最后一条用户消息整条都是注入内容 → 不该拿它当 preview
insert into session values ('ses_b','proj','${proj}','问候',1,200,'m1',null);
insert into message values ('m4','ses_b',10,10,'{"role":"user"}');
insert into part values ('p4','m4','ses_b',10,10,'{"type":"text","text":"你好"}');
insert into message values ('m5','ses_b',20,20,'{"role":"user"}');
insert into part values ('p5','m5','ses_b',20,20,'{"type":"text","text":"<system-reminder>你在 plan mode</system-reminder>"}');

-- C：只有助手消息（turns=0，会被当空会话过滤，这里只用来确认不炸）
insert into session values ('ses_c','proj','${proj}','空',1,300,'m1',null);
`

let hasSqlite = true
try {
  execFileSync('sqlite3', [dbFile], { input: create, stdio: ['pipe', 'pipe', 'pipe'] })
} catch {
  hasSqlite = false
}

process.env.ASS_HOME = tmp
process.env.ASS_OPENCODE_DB = dbFile
process.env.ASS_CONFIG_DIR = path.join(tmp, 'config')
process.env.ASS_DATA_DIR = path.join(tmp, 'data')
const api = await import('../dist/index.js')

const cfg = { agents: { claude: false, codex: false, cursor: false, opencode: true } }
const skip = !hasSqlite && '本机没有 sqlite3'

test('opencode：preview 取最后一条用户消息，而不是标题', { skip }, () => {
  const { sessions } = api.listSessions({ includeAll: true }, cfg)
  const a = sessions.find((s) => s.id === 'ses_a')
  assert.ok(a, 'ses_a 该被列出来')
  assert.equal(a.title, '第一句话', '标题来自 session.title')
  assert.equal(a.preview, '最后一句', 'preview 要取最后一条用户消息的正文')
  assert.equal(a.turns, 2, '两条用户消息')
})

test('opencode：最后一条是纯注入时往回找，而不是把注入当预览、也不是直接留空', { skip }, () => {
  const { sessions } = api.listSessions({ includeAll: true }, cfg)
  const b = sessions.find((s) => s.id === 'ses_b')
  assert.ok(b)
  assert.doesNotMatch(b.preview, /system-reminder/, '注入内容绝不能显示成「用户最后说了什么」')
  // 既不能显示注入，也不能因为最后一条是注入就整个空掉 —— 用户上一句是真的说过话的。
  // claude / codex 适配器遍历时就是这个行为，这里必须一致。
  assert.equal(b.preview, '你好', '要往回找到最后一条真的说了话的')
})

test('opencode：preview 与 read() 读出来的最后一条用户消息一致', { skip }, () => {
  // 这条是这次修复的核心约束：列表里显示的预览，必须和真去读那个会话得到的内容对得上。
  // 两边各自实现一套提取逻辑就必然会漂。
  for (const key of ['opencode:ses_a', 'opencode:ses_b']) {
    const found = api.findSession(key, cfg)
    assert.ok(found, `${key} 应该能找到`)
    const turns = api.readSession(found)
    const lastUser = [...turns].reverse().find((t) => t.role === 'user' && t.text.trim())
    const expected = lastUser ? api.plain(lastUser.text, 140) : ''
    const meta = api.listSessions({ includeAll: true }, cfg).sessions.find((s) => s.key === key)
    assert.equal(meta.preview, expected, `${key} 的 preview 应该和 read() 一致`)
  }
})

test('OpenCode: native title rename refreshes independently of messages; blank title falls back', { skip }, () => {
  const get = () => api.opencodeAdapter.list({}, { cache: {} }).find(s => s.id === 'ses_a')
  execFileSync('sqlite3', [dbFile], { input: "update session set title='重新命名' where id='ses_a';" })
  const before = fs.readFileSync(dbFile)
  assert.equal(get().title, '重新命名')
  assert.equal(get().preview, '最后一句')
  assert.deepEqual(fs.readFileSync(dbFile), before)
  execFileSync('sqlite3', [dbFile], { input: "update session set title='  ' where id='ses_a';" })
  assert.equal(get().title, '(空会话)')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// realpath 一次：macOS 的 /var 是 /private/var 的软链，不统一的话路径比较会假失败
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-cursor-')))

// 造一个假的 Cursor 用户目录。USER_DIR 是从 HOME 推出来的，而 HOME 走 ASS_HOME，
// 所以设了 ASS_HOME 之后 workspaceStorage / globalStorage 都会落到这个 tmp 里。
const userDir = path.join(tmp, 'Library', 'Application Support', 'Cursor', 'User')
const wsDir = path.join(userDir, 'workspaceStorage')
const dbFile = path.join(userDir, 'globalStorage', 'state.vscdb')
fs.mkdirSync(wsDir, { recursive: true })
fs.mkdirSync(path.dirname(dbFile), { recursive: true })

const projJson = path.join(tmp, 'Desktop', 'work', 'has-json')
const projFallback = path.join(tmp, 'Desktop', 'work', 'only-metadata')
fs.mkdirSync(projJson, { recursive: true })
fs.mkdirSync(projFallback, { recursive: true })

// ① 有 workspace.json 的（首选来源）
fs.mkdirSync(path.join(wsDir, 'WS_JSON'), { recursive: true })
fs.writeFileSync(path.join(wsDir, 'WS_JSON', 'workspace.json'), JSON.stringify({ folder: `file://${projJson}` }))
// ② 没有 workspace.json，只有 workspaceMetadata 的（回退来源）—— 目录都不建
// ③ 两边都没有的（真的无处归属）

// ⚠️ composerId 必须是**真实的 36 字符 uuid**：气泡统计靠 `substr(key,10,36)` 从
// `bubbleId:<composerId>:<bubbleId>` 里切出 composerId，短 id 对不上就统计不到气泡，
// 而 listSessions 会把「0 轮 0 气泡」当空会话过滤掉 —— 于是会话凭空消失。
// 同理每条会话都得有气泡，否则它会因为「空」而被过滤。
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'

const create = `
create table composerHeaders (composerId text, workspaceId text, createdAt integer, lastUpdatedAt integer, isArchived integer, isSubagent integer, value text);
create table cursorDiskKV (key text, value text);
create table ItemTable (key text, value text);
insert into composerHeaders values ('${A}','WS_JSON',1,100,0,0,'{"name":"有 workspace.json 的"}');
insert into composerHeaders values ('${B}','WS_FALLBACK',1,200,0,0,'{"name":"只有 metadata 的"}');
insert into composerHeaders values ('${C}','WS_ORPHAN',1,300,0,0,'{"name":"哪里都没有的"}');
insert into cursorDiskKV values ('bubbleId:${A}:b1','{"type":1,"text":"你好"}');
insert into cursorDiskKV values ('bubbleId:${A}:b2','{"type":2,"text":"收到"}');
insert into cursorDiskKV values ('bubbleId:${B}:b1','{"type":1,"text":"喂"}');
insert into cursorDiskKV values ('bubbleId:${C}:b1','{"type":1,"text":"在吗"}');
insert into ItemTable values ('workspaceMetadata.entries','{"entries":[{"workspaceId":"WS_FALLBACK","displayPath":"~/Desktop/work/only-metadata"}]}');
`
fs.writeFileSync(path.join(tmp, 'seed.sql'), create)

let hasSqlite = true
try {
  execFileSync('sqlite3', [dbFile], { input: create, stdio: ['pipe', 'pipe', 'pipe'] })
} catch {
  hasSqlite = false
}

process.env.ASS_HOME = tmp
process.env.ASS_CURSOR_DB = dbFile
process.env.ASS_CONFIG_DIR = path.join(tmp, 'config')
process.env.ASS_DATA_DIR = path.join(tmp, 'data')
const api = await import('../dist/index.js')

const cfg = { agents: { claude: false, codex: false, cursor: true, opencode: false } }

test('cursor：workspace.json 缺失时，回退到 workspaceMetadata.entries', { skip: !hasSqlite && '本机没有 sqlite3' }, () => {
  const { sessions } = api.listSessions({ includeAll: true }, cfg)
  const by = new Map(sessions.map((s) => [s.id, s]))
  assert.equal(sessions.length, 3, '三条都该被列出来')

  assert.equal(by.get(A).cwd, projJson, '首选来源：workspace.json 的 folder')
  assert.equal(
    by.get(B).cwd,
    projFallback,
    '回退来源：workspace.json 不在时，从 workspaceMetadata 取（~ 要展开成 ASS_HOME）',
  )
  assert.equal(by.get(C).cwd, null, '两个来源都没有 → 确实无处归属')
})

test('cursor：没有 cwd 的会话不该混进任何仓库的列表，有 cwd 的必须能按仓库过滤到', { skip: !hasSqlite && '本机没有 sqlite3' }, () => {
  // 这条是这次修复的意义所在：只走 workspace.json 的话，c-fallback 的 cwd/repo 都是 null，
  // 而按仓库过滤是 sameRepo(repo)||sameRepo(cwd) —— 两个都 null 就永远匹配不上，
  // 于是「明明是在这个项目里聊的会话」在项目里彻底看不见。
  const { sessions } = api.listSessions({ repo: projFallback }, cfg)
  assert.deepEqual(
    sessions.map((s) => s.id),
    [B],
    '靠回退拿到 cwd 的会话，必须能被它所属的仓库过滤出来',
  )

  const other = api.listSessions({ repo: projJson }, cfg)
  assert.deepEqual(other.sessions.map((s) => s.id), [A], '两个仓库各归各的')
})

test('Cursor 自动交接优先 conversation_id，兼容独立 session_id，原始数据库不变', { skip: !hasSqlite && '本机没有 sqlite3' }, () => {
  const before = fs.readFileSync(dbFile)
  const result = api.runHook('cursor', { session_id: 'run-identifier', conversation_id: A, workspace_roots: [projJson], hook_event_name: 'stop' }, cfg)
  assert.equal(result.status, 'saved')
  assert.equal(result.session, `cursor:${A}`)
  assert.match(fs.readFileSync(result.file, 'utf8'), /你好/)
  const repeat = api.runHook('cursor', { conversation_id: A, workspace_roots: [projJson], hook_event_name: 'sessionEnd' }, cfg)
  assert.equal(repeat.status, 'unchanged')
  assert.deepEqual(fs.readFileSync(dbFile), before)
})

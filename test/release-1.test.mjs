import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-v1-')))
const claudeDir = path.join(tmp, 'claude')
const codexDir = path.join(tmp, 'codex', 'sessions')
const repoA = path.join(tmp, 'repo-a')
const repoB = path.join(tmp, 'repo-b')
for (const dir of [path.join(claudeDir, 'p'), codexDir, repoA, repoB]) fs.mkdirSync(dir, { recursive: true })
const jsonl = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

jsonl(path.join(claudeDir, 'p', 'repo-a.jsonl'), [
  { type: 'user', cwd: repoA, timestamp: '2026-10-14T10:00:00Z', message: { content: '仓库 A 的正文' } },
  { type: 'ai-title', aiTitle: '只存在于标题的北极星' },
])
jsonl(path.join(claudeDir, 'p', 'repo-b.jsonl'), [
  { type: 'user', cwd: repoB, timestamp: '2026-10-14T11:00:00Z', message: { content: '仓库 B 的正文' } },
])

const codexFile = path.join(codexDir, 'rollout-2026-10-14T12-00-00-repeat.jsonl')
jsonl(codexFile, [
  { type: 'session_meta', payload: { id: 'repeat', cwd: repoA, timestamp: '2026-10-14T12:00:00Z' } },
  { type: 'response_item', timestamp: '2026-10-14T12:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] } },
  { type: 'event_msg', timestamp: '2026-10-14T12:00:01.001Z', payload: { type: 'user_message', message: '继续' } },
  { type: 'response_item', timestamp: '2026-10-14T12:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一次继续' }] } },
  { type: 'event_msg', timestamp: '2026-10-14T12:00:02.001Z', payload: { type: 'agent_message', message: '第一次继续' } },
  { type: 'response_item', timestamp: '2026-10-14T12:01:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '解释一下' }] } },
  { type: 'response_item', timestamp: '2026-10-14T12:02:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] } },
])

Object.assign(process.env, {
  ASS_HOME: tmp,
  ASS_CLAUDE_DIR: claudeDir,
  ASS_CODEX_DIR: codexDir,
  ASS_CODEX_ARCHIVED: path.join(tmp, 'none'),
  ASS_CODEX_INDEX: path.join(tmp, 'none-index'),
  ASS_CODEX_DB: path.join(tmp, 'none.db'),
  ASS_CURSOR_DB: path.join(tmp, 'cursor.db'),
  ASS_OPENCODE_DB: path.join(tmp, 'opencode.db'),
  ASS_CONFIG_DIR: path.join(tmp, 'config'),
  ASS_DATA_DIR: path.join(tmp, 'data'),
})
const api = await import('../dist/index.js')
const cfg = { agents: { claude: true, codex: true, cursor: false, opencode: false } }

test('#N keeps the last displayed repository-scoped list while resolving globally', () => {
  const shown = api.listSessions({ repo: repoA }, cfg).sessions
  assert.ok(shown.length >= 1)
  const expected = shown[0].key
  assert.equal(api.findSession('#1', cfg)?.meta.key, expected)
  assert.equal(api.findSession('claude:repo-b', cfg)?.meta.id, 'repo-b', 'stable lookups may scan globally')
  assert.equal(api.findSession('#1', cfg)?.meta.key, expected, 'internal scans must not rewrite the displayed list')
})

test('Codex collapses adjacent dual encodings but preserves repeated real turns', () => {
  const meta = api.codexAdapter.list({}, { cache: {} }).find((s) => s.id === 'repeat')
  assert.ok(meta)
  assert.equal(meta.turns, 3)
  assert.equal(meta.bubbles, 4)
  assert.equal(meta.preview, '继续')
  const users = api.codexAdapter.read(meta).filter((t) => t.role === 'user').map((t) => t.text)
  assert.deepEqual(users, ['继续', '解释一下', '继续'])
})

test('search includes native session titles and labels the match source', () => {
  const result = api.searchSessions('北极星', { allRepos: true, scan: 20 }, cfg)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].meta.id, 'repo-a')
  assert.match(result.hits[0].snippets[0], /标题：.*北极星/)
  assert.match(api.formatSearchResult(result), /🏷️ 标题/)
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

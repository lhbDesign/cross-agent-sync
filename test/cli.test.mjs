import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-cli-'))
const claudeDir = path.join(tmp, 'claude-projects')
fs.mkdirSync(path.join(claudeDir, '-tmp'), { recursive: true })
fs.writeFileSync(
  path.join(claudeDir, '-tmp', 'eeee-4444.jsonl'),
  JSON.stringify({ type: 'user', cwd: tmp, timestamp: '2026-09-03T10:00:00.000Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'CLI 冒烟测试' }] } }) + '\n',
)

const env = {
  ...process.env,
  ASS_CLAUDE_DIR: claudeDir,
  ASS_CODEX_DIR: path.join(tmp, 'nope'),
  ASS_CODEX_ARCHIVED: path.join(tmp, 'nope2'),
  ASS_OPENCODE_DB: path.join(tmp, 'nope.db'),
  ASS_CURSOR_DB: path.join(tmp, 'nope3.db'),
  ASS_CONFIG_DIR: path.join(tmp, 'config'),
  ASS_DATA_DIR: path.join(tmp, 'data'),
}

const run = (...args) =>
  execFileSync(process.execPath, ['dist/cli.js', ...args], { env, encoding: 'utf8' })

test('cli: list --all --json 输出可解析', () => {
  const out = run('list', '--all', '--json')
  const rows = JSON.parse(out)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'eeee-4444')
})

test('cli: agents 只列出本机真正有的数据源', () => {
  const out = run('agents')
  assert.match(out, /claude/)
  assert.doesNotMatch(out, /Codex\s+\d+ 个会话/)
})

test('cli: --help 有用法', () => {
  assert.match(run('--help'), /agent-session-sync/)
})

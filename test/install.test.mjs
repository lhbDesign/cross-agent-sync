import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-home-'))
fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true })
fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true })
fs.mkdirSync(path.join(fakeHome, '.config', 'opencode'), { recursive: true })
fs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({ mcpServers: {} }, null, 2))
fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), '[tui]\nmodel = "x"\n')
fs.writeFileSync(path.join(fakeHome, '.config', 'opencode', 'opencode.jsonc'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n')

const env = { ...process.env, ASS_HOME: fakeHome, ASS_DATA_DIR: path.join(fakeHome, 'data') }
const run = (...args) => execFileSync(process.execPath, ['dist/cli.js', ...args], { env, encoding: 'utf8' })

test('install --dry-run 不改动任何文件', () => {
  const before = fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8')
  run('install', '--dry-run')
  assert.equal(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8'), before)
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'CLAUDE.md')), false)
})

test('install 写 MCP + 规则，且幂等', () => {
  run('install')
  const claude = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8'))
  assert.ok(claude.mcpServers['agent-session-sync'].args[0].endsWith('mcp.js'))

  const codex = fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8')
  assert.match(codex, /\[mcp_servers\.agent-session-sync\]/)
  assert.match(codex, /\[tui\]/, '原有内容不能被破坏')

  const oc = fs.readFileSync(path.join(fakeHome, '.config', 'opencode', 'opencode.jsonc'), 'utf8')
  assert.match(oc, /"agent-session-sync"/)

  const rules = fs.readFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), 'utf8')
  assert.match(rules, /跨 agent 会话同步/)
  assert.match(rules, /<<< agent-session-sync <<< -->/)

  const before = fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8')
  run('install')
  assert.equal(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8'), before, '第二次 install 不应再改')
})

test('uninstall 精确摘除，原有配置回得来', () => {
  run('uninstall')
  const claude = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8'))
  assert.equal(claude.mcpServers['agent-session-sync'], undefined)
  const codex = fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8')
  assert.doesNotMatch(codex, /agent-session-sync/)
  assert.match(codex, /\[tui\]/)
  // 规则文件整份都是我们写的 → 摘块后应该被删掉
  assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'CLAUDE.md')), false)
})

test('init --dry-run 不落盘，init 写项目级规则，--undo 能撤回', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-proj-'))
  run('init', proj, '--dry-run')
  assert.equal(fs.existsSync(path.join(proj, 'AGENTS.md')), false)

  run('init', proj)
  assert.match(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8'), /跨 agent 会话同步/)
  assert.ok(fs.existsSync(path.join(proj, '.cursor', 'rules', 'agent-session-sync.mdc')))

  run('init', proj, '--undo')
  assert.equal(fs.existsSync(path.join(proj, 'AGENTS.md')), false)
  assert.equal(fs.existsSync(path.join(proj, '.cursor', 'rules', 'agent-session-sync.mdc')), false)
})

test('init 不覆盖仓库里已有的 AGENTS.md 内容', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-proj2-'))
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# 我的项目规则\n\n不要删我。\n')
  run('init', proj)
  const text = fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8')
  assert.match(text, /不要删我/)
  assert.match(text, /跨 agent 会话同步/)
  run('init', proj, '--undo')
  assert.match(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8'), /不要删我/)
})

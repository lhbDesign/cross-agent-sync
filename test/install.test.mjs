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

/** 造一个“什么都没装”的空 home */
function emptyHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-nohome-'))
  return { dir, env: { ...process.env, ASS_HOME: dir, ASS_DATA_DIR: path.join(dir, 'data') } }
}
function runIn(e, ...args) {
  return execFileSync(process.execPath, ['dist/cli.js', ...args], { env: e, encoding: 'utf8' })
}
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


test('机器上什么都没装时，install 不创建任何文件（不能污染用户 home）', () => {
  const { dir, env: e } = emptyHome()
  const out = runIn(e, 'install')
  assert.match(out, /没装这个 agent/, '应该报告跳过而不是硬写')
  const created = fs.readdirSync(dir).filter((f) => f !== 'data')
  assert.deepEqual(created, [], `不该创建任何东西，实际创建了：${created.join(', ')}`)
})

test('只装了 claude 时，只动 claude，不碰 codex/opencode', () => {
  const { dir, env: e } = emptyHome()
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  runIn(e, 'install')
  assert.ok(fs.existsSync(path.join(dir, '.claude.json')))
  assert.equal(fs.existsSync(path.join(dir, '.codex')), false, '不该凭空造 .codex')
  assert.equal(fs.existsSync(path.join(dir, '.config')), false, '不该凭空造 .config')
  const claude = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))
  assert.ok(claude.mcpServers['agent-session-sync'], 'claude 装了就该接上')
})

test('doctor 如实报告 SQLite 后端（不按 Node 版本号猜）', () => {
  const out = runIn({ ...process.env }, 'doctor')
  assert.match(out, /SQLite 读取\s+[✓✗]/)
  if (/sqlite3\(cli\)/.test(out)) assert.match(out, /sqlite3 命令行/)
})

// ---------------------------------------------------------------- ass mcp

test('ass mcp：打印配置内容，不发散到文件系统', () => {
  const out = run('mcp')
  assert.match(out, /mcpServers/)
  assert.match(out, /agent-session-sync/)
  assert.match(out, /\.cursor\/mcp\.json/, '要告诉用户放哪')
  assert.match(out, /ass mcp --write/)
})

test('ass mcp --write --dry-run 不创建任何文件', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-proj-'))
  const out = run('mcp', '--write', '--dry-run', proj)
  assert.match(out, /\[dry-run\]/)
  assert.deepEqual(fs.readdirSync(proj), [], 'dry-run 不能落盘')
})

test('ass mcp --write：创建 + 幂等 + 不弄丢别人的 server', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-proj-'))
  const cursorMcp = path.join(proj, '.cursor', 'mcp.json')

  const first = run('mcp', '--write', proj)
  assert.match(first, /新建/)
  const cfg = JSON.parse(fs.readFileSync(cursorMcp, 'utf8'))
  assert.ok(cfg.mcpServers['agent-session-sync'], '应该写进去')
  assert.ok(cfg.mcpServers['agent-session-sync'].args[0].endsWith('mcp.js'), '要指向真实的 mcp.js')
  assert.ok(fs.existsSync(path.join(proj, '.mcp.json')), 'Claude Code 的项目级文件也该建')

  assert.match(run('mcp', '--write', proj), /无需改动/, '第二次应该幂等')

  // 文件里已经有别的 MCP server 时，只能追加不能覆盖
  fs.writeFileSync(cursorMcp, JSON.stringify({ mcpServers: { 别的工具: { command: 'foo' } } }, null, 2))
  run('mcp', '--write', proj)
  const merged = JSON.parse(fs.readFileSync(cursorMcp, 'utf8'))
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['agent-session-sync', '别的工具'], '不能把别人的 server 冲掉')
})

test('ass mcp --write --undo：只摘我们那一项，别人留、独占的删', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-proj-'))
  const cursorMcp = path.join(proj, '.cursor', 'mcp.json')
  const claudeMcp = path.join(proj, '.mcp.json')
  // Cursor 那份：原本就有别人的 server，撤销后文件必须还在
  fs.mkdirSync(path.dirname(cursorMcp), { recursive: true })
  fs.writeFileSync(cursorMcp, JSON.stringify({ mcpServers: { 别人的: { command: 'x' } } }, null, 2))
  // Claude 那份：由我们新建，只含我们一项，撤销后整个删掉

  run('mcp', '--write', proj)
  run('mcp', '--write', '--undo', proj)

  const left = JSON.parse(fs.readFileSync(cursorMcp, 'utf8'))
  assert.deepEqual(Object.keys(left.mcpServers), ['别人的'], '别人的 server 必须留着，我们那一项摘掉')
  assert.equal(fs.existsSync(claudeMcp), false, '只有我们一项的文件，撤销时整个删掉而不是留个空壳')
})

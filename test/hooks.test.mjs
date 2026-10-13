import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-hooks-'))
const repo = path.join(home, 'repo')
const sourceDir = path.join(home, '.claude', 'projects', 'repo')
fs.mkdirSync(repo, { recursive: true })
fs.mkdirSync(sourceDir, { recursive: true })
fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
const source = path.join(sourceDir, 'hook-session.jsonl')
const message = (text, role = 'user') => JSON.stringify({ type: role, cwd: repo, timestamp: '2026-10-13T01:00:00Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text }] } }) + '\n'
fs.writeFileSync(source, message('实现自动交接') + message('已增加钩子入口', 'assistant'))
const env = { ...process.env, ASS_HOME: home, ASS_CONFIG_DIR: path.join(home, 'config'), ASS_DATA_DIR: path.join(home, 'data'), ASS_CLAUDE_DIR: path.join(home, '.claude', 'projects'), ASS_NO_PREWARM: '1' }
const cli = path.resolve('dist/cli.js')
const run = (args, input) => spawnSync(process.execPath, [cli, 'hook', ...args], { env, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 15000 })
const payload = { session_id: 'hook-session', cwd: repo, hook_event_name: 'Stop' }

test('钩子配置预览不写文件；安装幂等，备份并保留其他配置；卸载仅移除本工具', () => {
  const file = path.join(home, '.claude', 'settings.json')
  const original = { permissions: { allow: ['Read'] }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo keep' }] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'echo before' }] }] } }
  fs.writeFileSync(file, JSON.stringify(original))
  const preview = run(['install', '--agent', 'claude', '--dry-run', '--json'])
  assert.equal(preview.status, 0, preview.stderr)
  assert.equal(JSON.parse(preview.stdout)[0].action, 'would-install')
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), original)
  assert.equal(fs.readdirSync(path.dirname(file)).filter(f => f.includes('.bak-')).length, 0)
  const installed = run(['install', '--agent', 'claude', '--json'])
  assert.equal(installed.status, 0, installed.stderr)
  assert.ok(fs.existsSync(JSON.parse(installed.stdout)[0].backup))
  const config = JSON.parse(fs.readFileSync(file))
  assert.equal(config.hooks.Stop.length, 2)
  assert.equal(config.hooks.SessionEnd[0].hooks[0].timeout, 30)
  assert.equal(JSON.parse(run(['install', '--agent', 'claude', '--json']).stdout)[0].action, 'unchanged')
  assert.equal(JSON.parse(run(['status', '--json']).stdout).configs.find(c => c.agent === 'claude').installed, true)
  assert.equal(run(['uninstall', '--agent', 'claude']).status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), original)
})

test('Cursor 安装/卸载保留已有钩子；损坏配置不覆盖', () => {
  const file = path.join(home, '.cursor', 'hooks.json')
  const original = { version: 1, hooks: { stop: [{ command: 'echo keep-cursor' }] } }
  fs.writeFileSync(file, JSON.stringify(original))
  assert.equal(run(['install', '--agent', 'cursor']).status, 0)
  assert.equal(JSON.parse(fs.readFileSync(file)).hooks.stop.length, 2)
  assert.equal(run(['uninstall', '--agent', 'cursor']).status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), original)
  fs.writeFileSync(file, '{invalid')
  assert.notEqual(run(['install', '--agent', 'cursor']).status, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid')
  fs.writeFileSync(file, JSON.stringify(original))
})

test('原生钩子按精确会话保存、去重，消息变更后生成新快照；原始会话保持不变', () => {
  const before = fs.readFileSync(source, 'utf8')
  const first = run(['run', '--agent', 'claude'], payload)
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(JSON.parse(first.stdout), {})
  let state = JSON.parse(run(['status', '--json']).stdout)
  const saved = state.recent.at(-1)
  assert.equal(saved.status, 'saved')
  assert.match(fs.readFileSync(saved.file, 'utf8'), /实现自动交接/)
  assert.equal(fs.readFileSync(source, 'utf8'), before)
  const repeat = run(['run', '--agent', 'claude'], { ...payload, hook_event_name: 'SessionEnd' })
  assert.equal(repeat.status, 0, repeat.stderr)
  state = JSON.parse(run(['status', '--json']).stdout)
  assert.equal(state.recent.at(-1).status, 'unchanged')
  assert.equal(state.recent.at(-1).file, saved.file)
  fs.appendFileSync(source, message('下一步接入 CI'))
  assert.equal(run(['run', '--agent', 'claude'], payload).status, 0)
  state = JSON.parse(run(['status', '--json']).stdout)
  assert.equal(state.recent.at(-1).status, 'saved')
  assert.notEqual(state.recent.at(-1).file, saved.file)
})

test('无效输入、会话前缀、仓库不匹配都会失败并留下可诊断记录', () => {
  for (const input of [{}, { ...payload, session_id: 'hook-' }, { ...payload, cwd: home }, { ...payload, hook_event_name: 'PreToolUse' }]) {
    const result = run(['run', '--agent', 'claude'], input)
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stdout), {})
    assert.equal(JSON.parse(run(['status', '--json']).stdout).recent.at(-1).status, 'failed')
  }
  const invalid = spawnSync(process.execPath, [cli, 'hook', 'run', '--agent', 'claude'], { env, input: 'not json', encoding: 'utf8' })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /有效 JSON/)
})

test('安装后的命令可直接消费主机 JSON，且不会请求 agent 再执行一轮', () => {
  run(['install', '--agent', 'claude'])
  const command = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'))).hooks.Stop.at(-1).hooks[0].command
  const invoked = spawnSync('/bin/sh', ['-c', command], { env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 })
  assert.equal(invoked.status, 0, invoked.stderr)
  assert.deepEqual(JSON.parse(invoked.stdout), {})
})

test('同一输入可恢复重试；只允许完整会话引用', () => {
  const retry = run(['retry', '--session', 'claude:hook-session', '--json'])
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(JSON.parse(retry.stdout).session, 'claude:hook-session')
  assert.notEqual(run(['retry', '--session', 'claude:hook-']).status, 0)
  assert.notEqual(run(['retry', '--session', '#1']).status, 0)
})

test('缺少原生配置目录不会自动创建；不支持的 agent 给出错误', () => {
  const absent = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-hooks-absent-'))
  const output = spawnSync(process.execPath, [cli, 'hook', 'install', '--json'], { env: { ...env, ASS_HOME: absent }, encoding: 'utf8' })
  assert.equal(output.status, 0, output.stderr)
  assert.equal(JSON.parse(output.stdout).every(r => r.action === 'missing'), true)
  assert.equal(fs.existsSync(path.join(absent, '.claude')), false)
  assert.notEqual(run(['install', '--agent', 'unknown']).status, 0)
})

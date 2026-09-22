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

test('cli: 会话数到上限时给出提示，没到就不给', () => {
  // 自己造一个小仓库、用 --limit 2 触发截断 —— 比造 16 个会话快得多，测的是同一段逻辑
  const t2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-lim-')))
  const proj = path.join(t2, 'claude-projects', '-tmp-x')
  fs.mkdirSync(proj, { recursive: true })
  for (const id of ['a1', 'a2', 'a3']) {
    fs.writeFileSync(
      path.join(proj, `${id}.jsonl`),
      JSON.stringify({ type: 'user', cwd: t2, timestamp: '2026-09-03T10:00:00.000Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: `会话 ${id}` }] } }) + '\n',
    )
  }
  const e2 = { ...env, ASS_CLAUDE_DIR: path.join(t2, 'claude-projects'), ASS_DATA_DIR: path.join(t2, 'data') }
  const r2 = (...args) => execFileSync(process.execPath, ['dist/cli.js', ...args], { env: e2, encoding: 'utf8' })

  // ① 被截断 → 底部给提示，而且要给出可直接复制的命令，不能只说「有更多」
  const capped = r2('status', '--repo', t2, '--limit', '2')
  assert.match(capped, /只显示了最近 2 个会话/)
  assert.match(capped, /ass --limit 60/, '要给出可复制的命令')
  assert.match(capped, /--all/, '也要提示跨仓库的那个开关')

  // ② 没到上限 → 不该出现这行（否则每次都在喊狼来了）
  const roomy = r2('status', '--repo', t2, '--limit', '10')
  assert.doesNotMatch(roomy, /只显示了最近/, '没到上限就不该有这行')

  // ③ ass list 行为一致
  assert.match(r2('list', '--repo', t2, '--limit', '2'), /只显示了最近 2 个/)
  assert.doesNotMatch(r2('list', '--repo', t2, '--limit', '10'), /只显示了最近/)
})

test('cli: --limit 写了但没给值时报错，不能静默变成「只要 1 条」', () => {
  // parseArgs 遇到 `--limit --all` 时不会把 `--all` 当值消费，flags.limit 成了布尔 true，
  // 而 Number(true) === 1 —— 以前会静默只显示 1 条，用户完全摸不着头脑。
  let code = 0
  let out = ''
  try {
    run('--limit', '--all')
  } catch (e) {
    code = e.status
    out = String(e.stdout || '')
  }
  assert.equal(code, 1, '要当用法错误，非零退出')
  assert.match(out, /--limit 需要一个正整数/)
  assert.doesNotMatch(out, /1 个会话/, '绝不能显示成「只有 1 个会话」')

  // 合法值照常
  assert.doesNotMatch(run('list', '--limit', '5'), /需要一个正整数/)
})

test('cli: ass --all 真的跨仓库，且每行标出所属项目', () => {
  const t3 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-all-')))
  const repoA = path.join(t3, 'proj-a')
  const repoB = path.join(t3, 'proj-b')
  fs.mkdirSync(repoA, { recursive: true })
  fs.mkdirSync(repoB, { recursive: true })
  const dir = path.join(t3, 'claude-projects')
  for (const [sub, id, cwd, text] of [
    ['-a', 'b1', repoA, 'A 项目的事'],
    ['-b', 'b2', repoB, 'B 项目的事'],
  ]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
    fs.writeFileSync(
      path.join(dir, sub, `${id}.jsonl`),
      JSON.stringify({ type: 'user', cwd, timestamp: '2026-09-03T10:00:00.000Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text }] } }) + '\n',
    )
  }
  const e3 = { ...env, ASS_CLAUDE_DIR: dir, ASS_DATA_DIR: path.join(t3, 'data') }
  // cwd 换成了仓库目录，所以 cli.js 必须用绝对路径（模块加载时 cwd 还是包根）
  const CLI = path.resolve('dist/cli.js')
  const inA = (...args) =>
    execFileSync(process.execPath, [CLI, ...args], { env: e3, encoding: 'utf8', cwd: repoA })

  // 不带 --all：只看当前仓库
  const one = inA('status')
  assert.match(one, /1 个会话/)
  assert.doesNotMatch(one, /B 项目的事/)

  // 带 --all：两个仓库的都在，且各自标出项目名
  const all = inA('status', '--all')
  assert.match(all, /^全部仓库/m, '表头要说清这是跨仓库')
  assert.match(all, /2 个会话/)
  assert.match(all, /A 项目的事/)
  assert.match(all, /B 项目的事/)
  assert.match(all, /\[proj-a\]/)
  assert.match(all, /\[proj-b\]/)
})

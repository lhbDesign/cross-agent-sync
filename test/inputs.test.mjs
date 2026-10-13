import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { sessionInputs, inputsMarkdown } from '../dist/index.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-inputs-'))
after(() => fs.rmSync(home, { recursive: true, force: true }))
const dir = path.join(home, '.claude/projects/project')
fs.mkdirSync(dir, { recursive: true })
const source = path.join(dir, 'inputs-13.jsonl')
const texts = Array.from({ length: 13 }, (_, i) => `第 ${i + 1} 次输入\n\n代码：\n  const n = ${i};\n${i === 12 ? '长文本'.repeat(10000) + '结尾保留' : '内容'}`)
const messages = texts.flatMap(text => [
  { type: 'user', cwd: home, origin: { kind: 'human' }, message: { content: [{ type: 'text', text }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '助手回复不得出现' }] } },
])
fs.writeFileSync(source, messages.map(m => JSON.stringify(m)).join('\n') + '\n')
const env = { ...process.env, ASS_HOME: home, ASS_CONFIG_DIR: path.join(home, 'config'), ASS_DATA_DIR: path.join(home, 'data'), ASS_CLAUDE_DIR: path.join(home, '.claude/projects'), ASS_NO_PREWARM: '1' }
const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', 'inputs', ...args], { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })

test('13 条完整输入按顺序输出，无助手回复，长文本不截断', () => {
  const result = run('claude:inputs-13')
  assert.equal(result.status, 0, result.stderr)
  assert.equal((result.stdout.match(/^## 第 \d+ 条输入$/gm) || []).length, 13)
  assert.ok(result.stdout.includes(texts[12]))
  assert.ok(result.stdout.indexOf(texts[0]) < result.stdout.indexOf(texts[1]))
  assert.ok(!result.stdout.includes('助手回复不得出现'))
  const json = JSON.parse(run('claude:inputs-13', '--json').stdout)
  assert.equal(json.total, 13)
  assert.deepEqual(json.inputs.map(t => t.text), texts)
})

test('单条纯文本和导出保留正文，不附加标题或换行', () => {
  const result = run('claude:inputs-13', '--round', '3', '--raw')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, texts[2])
  const file = path.join(home, 'export.txt')
  assert.equal(run('claude:inputs-13', '--round', '13', '--raw', '--out', file).status, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), texts[12])
  const md = path.join(home, 'inputs.md')
  assert.equal(run('claude:inputs-13', '--out', md).status, 0)
  assert.ok(fs.readFileSync(md, 'utf8').includes('## 第 13 条输入'))
})

test('无效引用、编号和参数失败；不允许覆盖来源', () => {
  for (const args of [[], ['missing'], ['claude:inputs-13', '--raw'], ['claude:inputs-13', '--round'], ...['0', '14', '-1', 'NaN', '1.5'].map(n => ['claude:inputs-13', '--round', n])]) {
    assert.equal(run(...args).status, 1, JSON.stringify(args))
  }
  const before = fs.readFileSync(source, 'utf8')
  assert.equal(run('claude:inputs-13', '--out', source).status, 1)
  assert.equal(fs.readFileSync(source, 'utf8'), before)
})

test('图片和文件输入保留编号，空会话不伪造内容', () => {
  const result = sessionInputs([
    { role: 'system', text: '不要展示' },
    { role: 'user', text: '', images: [{ mediaType: 'image/png', base64: 'abc' }] },
    { role: 'tool', text: '不要展示' },
    { role: 'user', text: '附件提问', files: [{ name: 'a.txt', text: '文件全文' }] },
  ])
  assert.equal(result.total, 2)
  const md = inputsMarkdown('test:id', result)
  assert.match(md, /1 张图片/)
  assert.match(md, /文件全文/)
  assert.ok(!md.includes('不要展示'))
  assert.equal(sessionInputs([]).total, 0)
  assert.throws(() => sessionInputs([], 1))
})

test('用户输入时间按本地时区格式化，JSON 时间保持不变', () => {
  const at = Date.parse('2026-10-09T09:01:34.221Z')
  const file = path.join(dir, 'time-input.jsonl')
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: home, timestamp: '2026-10-09T09:01:34.221Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: '测试时间' }] } }) + '\n')
  for (const [tz, expected] of [['Asia/Shanghai', '2026-10-09 17:01:34'], ['UTC', '2026-10-09 09:01:34']]) {
    const output = spawnSync(process.execPath, ['dist/cli.js', 'inputs', 'claude:time-input'], { env: { ...env, TZ: tz }, encoding: 'utf8' })
    assert.equal(output.status, 0, output.stderr)
    assert.ok(output.stdout.includes(`时间：${expected}（本地时间）`), output.stdout)
    assert.ok(!output.stdout.includes('T09:01:34'))
  }
  assert.equal(JSON.parse(run('claude:time-input', '--json').stdout).inputs[0].at, at)
})

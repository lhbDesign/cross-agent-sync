import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-usage-')))
const claudeDir = path.join(tmp, 'claude-projects')
const claudeProject = path.join(claudeDir, '-tmp-proj')
const codexDir = path.join(tmp, 'codex-sessions')
const proj = path.join(tmp, 'proj')
fs.mkdirSync(claudeProject, { recursive: true })
fs.mkdirSync(codexDir, { recursive: true })
fs.mkdirSync(proj, { recursive: true })

const jsonl = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

jsonl(path.join(claudeProject, 'claude-usage.jsonl'), [
  { type: 'user', sessionId: 'claude-usage', cwd: proj, timestamp: '2026-11-10T10:00:00Z', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: '用量测试' }] } },
  {
    type: 'assistant', sessionId: 'claude-usage', cwd: proj, timestamp: '2026-11-10T10:00:01Z',
    message: {
      model: 'claude-x',
      content: [{ type: 'text', text: '带用量的回答' }],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, output_tokens_details: { thinking_tokens: 10 } },
    },
  },
])

jsonl(path.join(codexDir, 'rollout-2026-11-10T10-00-00-usage-id.jsonl'), [
  { timestamp: '2026-11-10T10:00:00Z', type: 'session_meta', payload: { id: 'usage-id', cwd: proj } },
  { timestamp: '2026-11-10T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: proj, model: 'gpt-x' } },
  { timestamp: '2026-11-10T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex 用量测试' }] } },
  // 先回答、后 token 记录：解析器需要两遍回填
  { timestamp: '2026-11-10T10:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex 带用量的回答' }] } },
  {
    timestamp: '2026-11-10T10:00:04Z', type: 'token_usage_record',
    payload: {
      turn_id: 'turn-1',
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      turn_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    },
  },
])

Object.assign(process.env, {
  ASS_HOME: tmp,
  ASS_CONFIG_DIR: path.join(tmp, 'config'),
  ASS_DATA_DIR: path.join(tmp, 'data'),
  ASS_CLAUDE_DIR: claudeDir,
  ASS_CODEX_DIR: codexDir,
  ASS_CODEX_ARCHIVED: path.join(tmp, 'no-archived'),
  ASS_CODEX_INDEX: path.join(tmp, 'no-index.jsonl'),
  ASS_CODEX_DB: path.join(tmp, 'no.db'),
})
const api = await import('../dist/index.js')

test('normalizeUsage：各家字段形状统一，0 不当成用量', () => {
  const claude = api.normalizeUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, output_tokens_details: { thinking_tokens: 1 } })
  assert.deepEqual({ ...claude }, { unit: 'token', input: 10, output: 2, cacheRead: 3, reasoning: 1 })

  const opencode = api.normalizeUsage({ tokens: { total: 12, input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } }, cost: 0 })
  assert.equal(opencode.input, 10)
  assert.equal(opencode.output, 2)
  assert.equal(opencode.cacheRead, 3)

  const dsh = api.normalizeUsage({ inputTokens: 5, outputTokens: 1, totalTokens: 6, reasoningTokens: 2 })
  assert.equal(dsh.input, 5)
  assert.equal(dsh.reasoning, 2)

  assert.equal(api.normalizeUsage({ tokenCount: { inputTokens: 0, outputTokens: 0 } }), undefined)
  assert.equal(api.normalizeUsage(null), undefined)
})

test('usageText / credit：小数值不要被四舍五入成 0 credit', () => {
  assert.equal(api.usageText(api.creditUsage(0.13)), '0.13 credit')
  assert.equal(api.usageText({ unit: 'token', input: 1200, output: 300 }), '↑1.2k ↓300')
  assert.match(api.usageTitle({ unit: 'token', input: 1200, output: 300, cacheRead: 100 }), /缓存读 100/)
})

test('Claude family：assistant.message.usage 挂到对应轮次', () => {
  const meta = api.claudeAdapter.list({}, { cache: {} })[0]
  assert.ok(meta)
  const turns = api.claudeAdapter.read(meta)
  const assistant = turns.find((t) => t.role === 'assistant')
  assert.ok(assistant?.usage)
  assert.equal(assistant.usage.input, 1000)
  assert.equal(assistant.usage.output, 200)
  assert.equal(assistant.usage.cacheRead, 300)
  assert.equal(assistant.usage.cacheWrite, 40)
  assert.equal(assistant.usage.reasoning, 10)
})

test('Codex：token_usage_record 出现在 assistant 之后也能回填', () => {
  const meta = api.codexAdapter.list({}, { cache: {} })[0]
  assert.ok(meta)
  const turns = api.codexAdapter.read(meta)
  const assistant = turns.find((t) => t.role === 'assistant')
  assert.ok(assistant?.usage)
  assert.equal(assistant.usage.input, 100)
  assert.equal(assistant.usage.output, 10)
  assert.equal(assistant.usage.total, 110)
})

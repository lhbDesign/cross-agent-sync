import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-mcp-'))
const proj = path.join(fakeHome, 'proj')
fs.mkdirSync(proj, { recursive: true })
const claudeDir = path.join(fakeHome, '.claude', 'projects', '-tmp-proj')
fs.mkdirSync(claudeDir, { recursive: true })

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
fs.writeFileSync(
  path.join(claudeDir, 'ffff-5555.jsonl'),
  JSON.stringify({
    type: 'user',
    cwd: proj,
    timestamp: '2026-09-04T10:00:00.000Z',
    origin: { kind: 'human' },
    message: { content: [{ type: 'text', text: '把登录页的验证码换成滑块' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
  }) + '\n',
)

const env = {
  ...process.env,
  ASS_HOME: fakeHome,
  ASS_CONFIG_DIR: path.join(fakeHome, 'config'),
  ASS_DATA_DIR: path.join(fakeHome, 'data'),
  ASS_NO_PREWARM: '1',
}

/** 起一个 MCP server，发一串请求，拿到所有响应 */
function rpc(requests, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/mcp.js'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    for (const r of requests) p.stdin.write(JSON.stringify(r) + '\n')
    p.stdin.end()
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error(`MCP 超时。stderr=${err}`))
    }, timeoutMs)
    p.on('close', () => {
      clearTimeout(timer)
      resolve(
        out
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      )
    })
  })
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const textOf = (r) => r.result.content[0].text

test('MCP：握手 + 工具清单 + 提示词', async () => {
  const res = await rpc([init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'prompts/list' }])
  const [a, b, c] = res
  assert.equal(a.result.serverInfo.name, 'agent-session-sync')
  assert.equal(a.result.protocolVersion, '2025-06-18')
  assert.match(a.result.instructions, /session_status/)
  const names = b.result.tools.map((t) => t.name)
  for (const t of ['session_status', 'session_list', 'session_handoff', 'session_read', 'session_last', 'session_search', 'session_note']) {
    assert.ok(names.includes(t), `缺少工具 ${t}`)
  }
  assert.equal(c.result.prompts[0].name, 'sync_previous_session')
})

test('MCP：session_list 列出这个仓库的会话', async () => {
  const res = await rpc([init, call(2, 'session_list', { repo: proj, limit: 5 })])
  const out = textOf(res[1])
  assert.match(out, /Claude Code/)
  assert.match(out, /把登录页的验证码换成滑块/)
  assert.match(out, /claude:ffff-5555/)
})

test('MCP：session_handoff 产出交接摘要', async () => {
  const res = await rpc([init, call(2, 'session_handoff', { session: 'claude:ffff-5555' })])
  const out = textOf(res[1])
  assert.match(out, /# 交接摘要/)
  assert.match(out, /## 原始目标/)
  assert.match(out, /把登录页的验证码换成滑块/)
})

test('MCP：session_last 把提问和图片一起搬过来', async () => {
  const res = await rpc([init, call(2, 'session_last', { session: 'claude:ffff-5555', rounds: 1 })])
  const out = textOf(res[1])
  assert.match(out, /把登录页的验证码换成滑块/)
  const m = /`([^`]+img-1\.png)`/.exec(out)
  assert.ok(m, `应该给出落盘图片路径，实际输出：${out}`)
  assert.ok(fs.existsSync(m[1]), '图片文件应该真的存在')
  assert.ok(fs.statSync(m[1]).size > 0)
})

test('MCP：session_note 存下交接记录，session_status 下次能读到', async () => {
  const res = await rpc([init, call(2, 'session_note', { repo: proj, summary: '卡在滑动验证码的接口联调' })])
  assert.match(textOf(res[1]), /已保存交接记录/)
  const res2 = await rpc([init, call(2, 'session_status', { repo: proj })])
  const out = textOf(res2[1])
  assert.match(out, /上次收尾留下的交接记录/)
  assert.match(out, /卡在滑动验证码的接口联调/)
})

test('MCP：未知工具返回错误而不是崩掉', async () => {
  const res = await rpc([init, call(2, 'session_nope', {})])
  assert.ok(res[1].error, '应该返回 JSON-RPC error')
  assert.match(res[1].error.message, /未知工具/)
})

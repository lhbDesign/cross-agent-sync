import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// realpath 一次：macOS 的 /var 是 /private/var 的软链，不统一的话
// 「同前缀的兄弟目录」那条断言会因为路径形式不同而假通过。
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ass-guard-')))
process.env.ASS_CONFIG_DIR = path.join(tmp, 'config')
process.env.ASS_DATA_DIR = path.join(tmp, 'data')
const api = await import('../dist/index.js')

test('protectedBy：目录按前缀判定，但必须比到路径分隔符', () => {
  api.resetGuard()
  const root = path.join(tmp, 'projects')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  api.addProtectedPath(root, '测试会话数据')

  assert.ok(api.protectedBy(root), '它自己该命中')
  assert.ok(api.protectedBy(path.join(root, 'a.jsonl')), '正下方该命中')
  assert.ok(api.protectedBy(path.join(root, 'sub', 'b.jsonl')), '子目录也该命中')

  // 关键：只比字符串前缀的话，/a/b 会把 /a/bc 也吞进来
  assert.equal(api.protectedBy(`${root}-backup`), null, '同前缀的兄弟目录不能被误判成受保护')
  assert.equal(api.protectedBy(path.join(`${root}-backup`, 'x.jsonl')), null)
  assert.equal(api.protectedBy(path.join(tmp, 'projects2')), null)
})

test('assertWritable：写受保护区被拒，逃生门能放行', () => {
  api.resetGuard()
  const root = path.join(tmp, 'session-data')
  fs.mkdirSync(root, { recursive: true })
  api.addProtectedPath(root, '测试会话数据')

  const inside = path.join(root, 'x.jsonl')
  assert.throws(() => api.assertWritable(inside, '测试写入'), /受保护区/, '命中保护区必须抛错')
  assert.doesNotThrow(() => api.assertWritable(path.join(tmp, 'ok.txt')), '保护区外应该放行')

  // 逃生门：只在用户显式知情时用
  process.env.ASS_ALLOW_SOURCE_WRITE = '1'
  assert.doesNotThrow(() => api.assertWritable(inside), 'ASS_ALLOW_SOURCE_WRITE=1 应该能放行')
  delete process.env.ASS_ALLOW_SOURCE_WRITE
  assert.throws(() => api.assertWritable(inside), /受保护区/, '撤销逃生门后重新拒绝')
})

test('读即登记：读过文件的父目录自动进保护区（覆盖 sources() 看不见的路径）', () => {
  api.resetGuard()
  // 模拟 Cursor 的附件目录：它在 sources() 里根本没声明，
  // 但和 state.vscdb 平级，读过就该被保护
  const dir = path.join(tmp, 'cursor', 'workspaceStorage')
  fs.mkdirSync(dir, { recursive: true })
  const db = path.join(dir, 'state.vscdb')
  fs.writeFileSync(db, 'v1')

  assert.equal(api.protectedBy(path.join(dir, 'other.bin')), null, '读之前不该被保护')

  const fd = api.openSource(db)
  assert.notEqual(fd, null, 'openSource 应该能打开')
  fs.closeSync(fd)

  assert.ok(api.protectedBy(path.join(dir, 'other.bin')), '读过之后，父目录应自动进入保护区')
  assert.equal(api.verifyUnchanged().length, 0, '刚读完、没动过 → 无变化')
})

test('变更自证：区分「我们改了」和「会话还在被写」', () => {
  api.resetGuard()
  const f = path.join(tmp, 'live-session.jsonl')
  fs.writeFileSync(f, 'v1')
  const fd = api.openSource(f)
  fs.closeSync(fd)

  fs.writeFileSync(f, 'v2-被改过了')

  // 刚写完 → 判为「活跃会话仍在被写」，无法判定是谁干的
  const fresh = api.verifyUnchanged()
  assert.equal(fresh.length, 1, '指纹变了就该被检出')
  assert.equal(fresh[0].active, true, 'mtime 很近 → 算活跃写入')

  const g = api.guardSummary()
  assert.equal(g.active, 1, '活跃写入单列')
  assert.equal(g.changed, 0, '活跃写入不该被算成异常变更 —— 否则这个信号会恒亮、等于没有')

  // 把时间往后推 10 分钟再看：已停止写入，就成了一处「说不清」的变更
  const later = api.verifyUnchanged(Date.now() + 10 * 60 * 1000)
  assert.equal(later.length, 1)
  assert.equal(later[0].active, false, '过了活跃窗口就不再算活跃写入')
})

test('noteSourceRead：第三方持有句柄的读路径（SQLite）也要登记', () => {
  api.resetGuard()
  const dir = path.join(tmp, 'opencode')
  fs.mkdirSync(dir, { recursive: true })
  const db = path.join(dir, 'opencode.db')
  fs.writeFileSync(db, 'db')

  api.noteSourceRead(db)
  assert.ok(api.protectedBy(path.join(dir, 'unseen-by-sources')), '也该登记父目录')
  assert.equal(api.guardSummary().opened, 1, '应记为一个已读源文件')
})

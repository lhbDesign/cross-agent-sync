import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-budget-'))
process.env.ASS_CONFIG_DIR = path.join(tmp, 'config')
process.env.ASS_DATA_DIR = path.join(tmp, 'data')
const api = await import('../dist/index.js')

/** 造一个可控的节：每档渲染出 n 个 ASCII 字符（≈ n/4 token） */
function sec(id, priority, sizes, opts = {}) {
  return {
    id,
    label: opts.label ?? id,
    priority,
    mandatory: opts.mandatory,
    render: (tier) => 'x'.repeat(sizes[tier] ?? 0),
  }
}

test('estimateTokens：CJK 约 1 token/字，ASCII 约 4 字符/token', () => {
  assert.equal(api.estimateTokens('中文字符'), 4, '4 个汉字 ≈ 4 token')
  assert.equal(api.estimateTokens('abcd'), 1, '4 个 ASCII ≈ 1 token')
  assert.equal(api.estimateTokens(''), 0)
  // 空白不计（缩进/换行不该算进预算）—— 3 个非空白 ASCII ≈ 0.75 → 向上取整 1
  assert.equal(api.estimateTokens('a b\nc'), 1, '空白不算，3 个 ASCII 向上取整还是 1 token')
  assert.equal(api.estimateTokens('    '), 0, '纯空白为 0')

  // 只要求单调：内容多了 token 不能反而变少
  const a = api.estimateTokens('x'.repeat(100))
  const b = api.estimateTokens('x'.repeat(200))
  assert.ok(b > a, '更长的内容 token 必须更多')
})

test('parseLevel / levelTokens：认得的档位、不认的给缺省', () => {
  assert.equal(api.parseLevel('tiny'), 'tiny')
  assert.equal(api.parseLevel('  LARGE '), 'large', '大小写和空格都该容忍')
  assert.equal(api.parseLevel('huge'), null, '不认的档位返回 null，而不是硬塞一个')
  assert.equal(api.parseLevel(undefined), null)

  assert.equal(api.levelTokens('tiny'), api.LEVEL_TOKENS.tiny)
  assert.equal(api.levelTokens(undefined), api.LEVEL_TOKENS[api.DEFAULT_LEVEL], '缺省用 DEFAULT_LEVEL')
  assert.equal(api.levelTokens('full'), Number.POSITIVE_INFINITY, 'full 表示不设上限')
})

test('fitSections：预算够就全档，不裁', () => {
  const sections = [sec('a', 0, { full: 40 }), sec('b', 5, { full: 40 })]
  const fit = api.fitSections(sections, 1000)
  assert.equal(fit.tiers.a, 'full')
  assert.equal(fit.tiers.b, 'full')
  assert.deepEqual(fit.demoted, [], '没超预算就不该有降档')
  assert.deepEqual(fit.dropped, [])
  assert.equal(api.budgetFooter(fit, 'standard', 'claude:x'), '', '没裁就不输出预算声明，别占额度')
})

test('fitSections：超预算时，从优先级最低的节开始降档', () => {
  // a 必留且便宜；b 优先级最低（数字最大）且最贵
  const sections = [sec('a', 0, { full: 400, compact: 200, minimal: 100 }), sec('b', 5, { full: 4000, compact: 40, minimal: 20 })]
  const fit = api.fitSections(sections, 200)

  assert.equal(fit.tiers.a, 'full', '高优先级（a）不该被先动')
  assert.equal(fit.tiers.b, 'compact', '先降的是优先级最低的 b')
  assert.deepEqual(fit.dropped, [], '降一档就够了，不该整节丢')
  assert.ok(fit.used <= fit.budget, `拟合结果 ${fit.used} 应落在预算 ${fit.budget} 内`)

  const footer = api.budgetFooter(fit, 'small', 'claude:31c5af10')
  assert.match(footer, /## 交接预算/)
  assert.match(footer, /已降档/)
  assert.match(footer, /精简/, '要说清降到了哪一档')
  assert.match(footer, /ass show claude:31c5af10 --full/, '要给出看全文的命令')
  assert.match(footer, /不代表它不重要/, '要防止下一个 agent 把「摘要里没有」当成「会话里没有」')
})

test('fitSections：降到 minimal 还不够就整节丢弃，但必留节不丢', () => {
  const sections = [
    sec('must', 0, { full: 200, compact: 200, minimal: 200 }, { mandatory: true }),
    sec('drop-me', 9, { full: 2000, compact: 1000, minimal: 500 }),
  ]
  const fit = api.fitSections(sections, 60)

  assert.deepEqual(
    fit.dropped.map((d) => d.id),
    ['drop-me'],
    '非必留节降到底还超就该整节丢',
  )
  assert.ok(fit.tiers.must, '必留节不能被丢')
  assert.match(fit.md, /xx/, '必留节的内容还在')
})

test('fitSections：本来就空的节，不该被报成「已降档」', () => {
  // 这次没勾 --guess、会话里没提文件 —— 这类节本来就渲染不出东西。
  // 把它记进 demoted 会让下一个 agent 以为「这里有内容被裁掉了」，而其实从来没有过。
  // real 要真的降一档（所以每档都得渲染出东西），才能看出空节有没有被误报
  const sections = [sec('real', 0, { full: 400, compact: 200, minimal: 100 }), sec('empty', 9, { full: 0 })]
  const fit = api.fitSections(sections, 50)

  assert.deepEqual(
    fit.demoted.map((d) => d.id),
    ['real'],
    '该降的是 real，空的那个不该混进来',
  )
  assert.equal(fit.tiers.empty, 'full', '空节不该被"降档"')
  assert.deepEqual(
    fit.dropped.map((d) => d.id),
    [],
    '更没有节该被"省略"',
  )
})

test('fitSections：单节渲染抛错不该让整份摘要消失', () => {
  const boom = {
    id: 'boom',
    label: 'boom',
    priority: 9,
    render: () => {
      throw new Error('渲染炸了')
    },
  }
  const fit = api.fitSections([sec('ok', 0, { full: 40 }), boom], 1000)
  assert.match(fit.md, /xx/, '好节的内容仍要输出')
})

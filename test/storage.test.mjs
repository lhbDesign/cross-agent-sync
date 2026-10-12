import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-storage-'))
process.env.ASS_HOME = home
process.env.ASS_CONFIG_DIR = path.join(home, 'config')
process.env.ASS_DATA_DIR = path.join(home, 'data')
const api = await import('../dist/index.js')
const env = { ...process.env, ASS_NO_PREWARM: '1' }
const run = (repo, ...args) => spawnSync(process.execPath, ['dist/cli.js', 'context', '--repo', repo, ...args], { env, encoding: 'utf8' })
const mkdir = (dir) => { fs.mkdirSync(dir, { recursive: true }); return dir }

test('同名仓库隔离笔记与交接；旧数据仅由所属仓库读取并惰性迁移', () => {
  const a = mkdir(path.join(home, 'one', 'app'))
  const b = mkdir(path.join(home, 'two', 'app'))
  const legacy = mkdir(path.join(home, 'data', 'handoffs', 'app'))
  const old = { repo: a, updatedAt: 1, entries: [{ id: 'c8', kind: 'todo', text: '旧笔记', at: 1 }] }
  const oldText = JSON.stringify(old)
  fs.writeFileSync(path.join(legacy, 'context.json'), oldText)
  fs.writeFileSync(path.join(legacy, 'latest.md'), '旧交接')
  fs.writeFileSync(path.join(home, 'data', 'handoffs', 'index.json'), JSON.stringify({ app: { repo: a, latest: 'app/latest.md', at: 1, key: 'claude:old', project: 'app' } }))
  assert.equal(api.readContext(a).entries[0].id, 'c8')
  assert.equal(api.readContext(b).entries.length, 0)
  assert.equal(api.latestNote(a).content, '旧交接')
  assert.equal(api.latestNote(b), null)
  api.addContext(a, [{ kind: 'note', text: 'A 新笔记' }])
  api.addContext(b, [{ kind: 'note', text: 'B 新笔记' }])
  assert.notEqual(api.contextFile(a), api.contextFile(b))
  assert.equal(api.readContext(a).entries[1].id, 'c9')
  assert.equal(api.readContext(b).entries[0].id, 'c1')
  assert.equal(fs.readFileSync(path.join(legacy, 'context.json'), 'utf8'), oldText)
  const savedA = api.saveNoteMd({ repo: a, md: 'A', title: 'same' })
  const savedB = api.saveNoteMd({ repo: b, md: 'B', title: 'same' })
  const savedAgain = api.saveNoteMd({ repo: a, md: 'A2', title: 'same' })
  assert.notEqual(savedA.file, savedAgain.file)
  assert.notEqual(savedA.latestFile, savedB.latestFile)
  assert.equal(api.latestNote(a).content.includes('A2'), true)
  assert.equal(api.latestNote(b).content.includes('B'), true)
  assert.equal(api.listNotes().filter(({ entry }) => entry.repo.endsWith('/app')).length, 2)
})

test('Git 子目录及符号链接使用同一个笔记身份', () => {
  const repo = mkdir(path.join(home, 'canonical'))
  execFileSync('git', ['init', '-q', repo])
  const sub = mkdir(path.join(repo, 'src'))
  const alias = path.join(home, 'alias')
  fs.symlinkSync(repo, alias, 'dir')
  api.addContext(sub, [{ kind: 'note', text: 'shared' }])
  assert.equal(api.contextFile(repo), api.contextFile(sub))
  assert.equal(api.contextFile(repo), api.contextFile(alias))
  assert.equal(api.readContext(repo).entries.length, 1)
})

test('组合写入失败完全回滚，JSON 写入输出可解析', () => {
  const repo = mkdir(path.join(home, 'transaction'))
  const invalid = run(repo, '--todo', '不能留下', '--review', 'c1', '--result', 'completed')
  assert.notEqual(invalid.status, 0)
  assert.equal(api.readContext(repo).entries.length, 0)
  assert.equal(fs.existsSync(api.contextFile(repo)), false)
  const good = run(repo, '--todo', '有效事项', '--done', 'c1', '--json')
  assert.equal(good.status, 0, good.stderr)
  assert.equal(JSON.parse(good.stdout).entries[0].done, true)
  const before = fs.readFileSync(api.contextFile(repo), 'utf8')
  const missing = run(repo, '--note', '也不能留下', '--cancel', 'c999', '--json')
  assert.notEqual(missing.status, 0)
  assert.equal(missing.stdout, '')
  assert.equal(fs.readFileSync(api.contextFile(repo), 'utf8'), before)
  assert.equal(run(repo, '--remove', 'c999').status, 1)
  for (const args of [['--todo', '--json'], ['--done', 'c1', '--cancel', 'c1', '--json'], ['--related-to', 'c1', '--json']]) {
    const invalid = run(repo, ...args)
    assert.notEqual(invalid.status, 0)
    assert.equal(invalid.stdout, '')
    assert.equal(fs.readFileSync(api.contextFile(repo), 'utf8'), before)
  }
})

test('损坏的数据报错，不静默覆盖；失败释放锁', () => {
  const repo = mkdir(path.join(home, 'corrupt'))
  const file = api.contextFile(repo)
  mkdir(path.dirname(file))
  fs.writeFileSync(file, '{bad json')
  assert.throws(() => api.addContext(repo, [{ kind: 'note', text: 'new' }]), /无法读取数据文件/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad json')
  assert.equal(fs.existsSync(file + '.lock'), false)
})

test('多进程同时更新笔记、任务和交接索引，不丢记录或复用编号', async () => {
  const repo = mkdir(path.join(home, 'concurrent'))
  const moduleUrl = pathToFileURL(path.resolve('dist/index.js')).href
  const worker = `
    const api = await import(process.argv[1]);
    process.stdout.write('ready');
    process.stdin.once('data', () => {
      for (let j=0;j<12;j++) api.addContext(process.argv[2], [{kind:'note',text:process.argv[3]+':'+j}]);
      api.taskCreate({ name:'parallel-'+process.argv[3], repo:process.argv[2] });
      api.saveNoteMd({repo:process.argv[2]+'/'+process.argv[3],md:process.argv[3]});
      process.exit(0);
    });
  `
  const jobs = Array.from({ length: 6 }, (_, i) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, moduleUrl, repo, String(i)], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => err += d)
    const ready = new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(err))) })
    return { child, ready, done }
  })
  try {
    await Promise.all(jobs.map(j => j.ready))
    jobs.forEach(j => j.child.stdin.end('go'))
    await Promise.all(jobs.map(j => j.done))
  } finally { jobs.forEach(j => { if (j.child.exitCode === null) j.child.kill() }) }
  const ctx = api.readContext(repo)
  assert.equal(ctx.entries.length, 72)
  assert.equal(new Set(ctx.entries.map(e => e.id)).size, 72)
  assert.equal(api.readTasks().tasks.filter(t => t.name.startsWith('parallel-')).length, 6)
  assert.equal(api.listNotes().filter(n => n.entry.repo.includes('/concurrent/')).length, 6)
})

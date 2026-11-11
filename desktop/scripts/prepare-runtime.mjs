#!/usr/bin/env node
/**
 * 把仓库根目录的 dist/ 复制成应用内的 runtime/。
 *
 * 为什么需要单独的 package.json：dist/cli.js 是 ESM，而 Node 依据**最近的 package.json**
 * 的 "type" 判断模块类型。复制到 app 内的 Resources/runtime/ 后，那里没有 package.json，
 * 就会被当成 CommonJS 而报错。所以这里一并写一份 {"type":"module"}。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(here, '..')
const repo = path.resolve(desktop, '..')
const src = path.join(repo, 'dist')
const out = path.join(desktop, 'runtime')

if (!fs.existsSync(path.join(src, 'cli.js'))) {
  console.error(`找不到 ${src}/cli.js —— 请先在仓库根目录运行 npm run build`)
  process.exit(1)
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

for (const f of ['cli.js', 'mcp.js', 'index.js', 'index.d.ts']) {
  const p = path.join(src, f)
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(out, f))
}

fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({ name: 'ass-runtime', private: true, type: 'module' }, null, 2) + '\n',
)

const size = fs.readdirSync(out).reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0)
console.log(`runtime 就绪：${out}（${(size / 1024 / 1024).toFixed(1)} MB）`)

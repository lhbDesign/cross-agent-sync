import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// 打包后代码在 app.asar/electron 里，runtime 由 extraResources 放到
// Contents/Resources/runtime —— 也就是 asar 的**同级**，不是 asar 内部。
const PACKAGED = here.includes('.asar') && typeof process.resourcesPath === 'string'

export const RUNTIME_DIR = PACKAGED
  ? path.join(process.resourcesPath, 'runtime')
  : path.join(here, '..', 'runtime')
export const CLI_ENTRY = path.join(RUNTIME_DIR, 'cli.js')

/**
 * 以「Electron 当 Node 用」的方式跑仓库自带的 CLI。
 *
 * 为什么不直接 import dist/index.js：
 *   config.ts / adapter 里的路径常量都是**模块导入时**求值的，
 *   一旦 import 之后改 process.env 就不生效了。子进程最干净。
 *
 * ASS_REEXEC=1 必须设：否则 bootstrap 在缺 node:sqlite 时可能用 Electron 二进制
 * 再 spawn 自己，行为不可控。
 */
export function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ASS_REEXEC: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, opts.timeout || 180_000)

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr || String(e?.message || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 某些 macOS 安全/监控软件会给进程注入 dylib，往 **stdout** 打
 * `[LSDEfsError] ...` / `objc[123]: ...` 这类噪音（Electron-as-Node 下实测出现）。
 * JSON 命令的输出永远是单个数组/对象，所以从第一个「能解析成功的 [ 或 { 行」开始解析。
 */
function extractJson(text) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart()
    if (!t.startsWith('[') && !t.startsWith('{')) continue
    try {
      return JSON.parse(lines.slice(i).join('\n'))
    } catch {
      // 噪音行也可能以 [ 开头（如 [LSDEfsError]），继续往下找
    }
  }
  return undefined
}

const NOISE = /^(?:\[LSDEfsError\]|\[ASSERT|objc\[\d+\]:|Class \w+ is implemented)/

/** 文本命令也可能混进同样的噪音行，去掉它们 */
function stripNoise(text) {
  return text
    .split('\n')
    .filter((l) => !NOISE.test(l.trimStart()))
    .join('\n')
}

export async function runJson(args, opts = {}) {
  const r = await runCli(args, opts)
  if (r.code !== 0) {
    const msg = stripNoise(r.stderr || r.stdout || '').trim() || `命令失败：ass ${args.join(' ')}`
    throw new Error(msg)
  }
  const text = stripNoise(r.stdout).trim()
  if (!text) return null
  const parsed = extractJson(text)
  if (parsed !== undefined) return parsed
  throw new Error(`输出不是纯 JSON：${text.slice(0, 200)}`)
}

/** 只取文本输出（brief / note 这类 Markdown 命令） */
export async function runText(args, opts = {}) {
  const r = await runCli(args, opts)
  if (r.code !== 0) throw new Error(stripNoise(r.stderr || r.stdout || '').trim() || '命令失败')
  return stripNoise(r.stdout)
}

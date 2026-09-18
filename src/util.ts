import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** 用户主目录；可用 ASS_HOME 覆盖（测试 / 沙箱 / 想把数据放在别处时） */
export const HOME = process.env.ASS_HOME || os.homedir()

export function home(...segs: string[]): string {
  return path.join(HOME, ...segs)
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function statOf(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

export function realpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** 压成一行并截断，用于列表里的标题/预览 */
export function plain(s: unknown, n = 120): string {
  if (typeof s !== 'string') return ''
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return realpath(a) === realpath(b)
}

const gitCache = new Map<string, string | null>()

/** 归一化到 git 仓库根目录；不是 git 仓库时回退到目录本身 */
export function gitRoot(dir: string | null | undefined): string | null {
  if (!dir) return null
  const key = dir
  if (gitCache.has(key)) return gitCache.get(key) ?? null
  let out: string | null = null
  try {
    const r = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim()
    out = r ? realpath(r) : realpath(dir)
  } catch {
    out = isDir(dir) ? realpath(dir) : null
  }
  gitCache.set(key, out)
  return out
}

export function projectName(p: string | null | undefined): string | null {
  if (!p) return null
  return path.basename(p.replace(/\/+$/, '')) || null
}

/**
 * 流式读 JSONL：大文件（几百 MB）也不会一次吃进内存。
 * 按字节找 \n，避免多字节 UTF-8 被切断。
 */
export function* readJsonl(file: string): Generator<Record<string, any>> {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(1 << 20)
    let pending = Buffer.alloc(0)
    let n: number
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      pending = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n))
      let idx: number
      while ((idx = pending.indexOf(0x0a)) >= 0) {
        const line = pending.subarray(0, idx).toString('utf8')
        pending = pending.subarray(idx + 1)
        const rec = tryParseLine(line)
        if (rec) yield rec
      }
    }
    const rec = tryParseLine(pending.toString('utf8'))
    if (rec) yield rec
  } catch {
    /* 文件读不了就当空 */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function tryParseLine(line: string): Record<string, any> | null {
  const t = line.trim()
  if (!t || t[0] !== '{') return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

/**
 * 只读文件末尾 maxBytes，再按行解析（用于 tail：不想为了最后几轮对话
 * 把 200MB 的 transcript 全扫一遍）。
 */
export function* readJsonlTail(file: string, maxBytes = 4 << 20): Generator<Record<string, any>> {
  const st = statOf(file)
  if (!st) return
  const size = st.size
  const start = Math.max(0, size - maxBytes)
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(size - start)
    const read = fs.readSync(fd, buf, 0, buf.length, start)
    let text = buf.subarray(0, read).toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1) // 丢掉半行
    for (const line of text.split('\n')) {
      const rec = tryParseLine(line)
      if (rec) yield rec
    }
  } catch {
    /* ignore */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJsonFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** 本地时间 `2026-09-18 13:20`；无效值给 `—` */
export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 文件名友好的短 slug */
export function slugify(s: string, max = 40): string {
  const t = String(s || '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (t || 'untitled').slice(0, max)
}

export function truncate(s: string, n: number): string {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** `7d` / `12h` / `30m` / ISO 日期 → 时间戳（毫秒） */
export function parseSince(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const m = /^(\d+)\s*([dhm])$/.exec(String(v).trim())
  if (m) {
    const n = Number(m[1])
    const unit = m[2] === 'd' ? 86400000 : m[2] === 'h' ? 3600000 : 60000
    return Date.now() - n * unit
  }
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? null : t
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 剥掉 agent 往消息里塞的“容器标签”（不是用户真说的话）：
 *   <system-reminder> / <local-command-stdout> / <command-name> …
 *   Codex 的 `# AGENTS.md instructions … </INSTRUCTIONS>` 与 <environment_context>
 * 注意：这些经常和用户的真实提问**在同一个消息里**，所以必须剥掉再判断，
 * 不能一看到 `<` 就整条丢掉（那会连真实提问一起丢）。
 */
export function cleanUserText(text: string): string {
  let t = text
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  t = t.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
  t = t.replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
  t = t.replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
  t = t.replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
  t = t.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
  t = t.replace(/^#+\s*AGENTS\.md\s+instructions[\s\S]*?<\/INSTRUCTIONS>/i, '')
  // 图片/附件在文本里留下的占位符（真图已经按 base64 单独解析出来了）
  t = t.replace(/<image>\s*<\/image>/gi, '')
  t = t.replace(/<file>\s*<\/file>/gi, '')
  return t.trim()
}

/** 剥完容器标签后什么都不剩 → 这条不是用户说的话 */
export function isInjected(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  const cleaned = cleanUserText(t)
  if (!cleaned) return true
  // 还有未识别的容器标签（<ide_opened_file> 之类）也当注入
  if (cleaned.startsWith('<') && /^<[a-z_][\w-]*>/i.test(cleaned)) return true
  return false
}

export function parseDataUrl(url: unknown): { mediaType: string; base64: string } | null {
  if (typeof url !== 'string') return null
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(url.trim())
  if (!m) return null
  return { mediaType: (m[1] ?? 'image/png').toLowerCase(), base64: m[2] ?? '' }
}

export function extForMediaType(mediaType: string): string {
  const t = mediaType.toLowerCase()
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  if (t.includes('webp')) return 'webp'
  if (t.includes('gif')) return 'gif'
  if (t.includes('svg')) return 'svg'
  return 'png'
}

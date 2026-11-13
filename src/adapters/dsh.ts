import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as zlib from 'node:zlib'
import type { Adapter, AdapterCtx, ListOptions, ReadOptions, SessionMeta, Turn } from '../types'
import { HOME, cleanUserText, gitRoot, isDir, isInjected, plain, projectName, statOf } from '../util'

/**
 * DeepSeek Harness（DSH）：
 *   ${DSH_HOME:-~/.dsh}/sessions/<project-slug>/<session>/session.v<N>.jsonl[.zstd]
 *
 * 日志是 append-only JSONL；第一条是 session header：
 *   { "type":"session", "version":4, "id":"session-…", "createdAt":<ms>, "cwd":"…" }
 * 之后是事件，每行 { type, data, seq, time }：
 *   - user/message       data.content: [{type:'text',text}]（source.kind='user' 才是真人；
 *                        文件变更提示/AGENTS.md/skill 等合成消息不是）
 *   - assistant/message  data.message.content: text / reasoning / tool-call
 *   - session/title      data.title
 *   - tool/result、system/message、developer/message、assistant/attempt … 不进对话正文
 *
 * DSH 默认把日志压成 **多个 zstd frame 拼接**。Node 24 的 zstdDecompressSync
 * 一次只解一帧，所以先按 zstd 帧结构扫描，再逐帧解压；没有 Node zstd 时
 * 回退到系统 `zstd -dc`（能直接处理 concatenated frames）。
 */
const DSH_HOME = process.env.DSH_HOME || process.env.ASS_DSH_HOME || path.join(HOME, '.dsh')
const ROOT = process.env.ASS_DSH_DIR ||
  path.join(process.env.DSH_DATA_ROOT || DSH_HOME, 'sessions')

interface FileCache {
  files?: Record<string, { stamp: string; meta: SessionMeta }>
}

interface FrameRange {
  start: number
  end: number
}

const ZSTD_MAGIC = 0xfd2fb528

/** 扫描 concatenated zstd stream，返回完整的 frame 区间；尾部不完整的帧直接忽略。 */
function scanZstdFrames(buf: Buffer): FrameRange[] {
  const out: FrameRange[] = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) break
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset >= buf.length) break

    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) break

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes
    if (buf.length - offset < headerBytes) break
    offset += headerBytes

    let ok = true
    for (;;) {
      if (buf.length - offset < 3) { ok = false; break }
      const header = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (header & 1) !== 0
      const blockType = (header >>> 1) & 0x03
      const blockSize = header >>> 3
      if (blockType === 3) { ok = false; break }
      const payload = blockType === 1 ? 1 : blockSize
      if (buf.length - offset < payload) { ok = false; break }
      offset += payload
      if (lastBlock) break
    }
    if (!ok) break
    if (checksum) {
      if (buf.length - offset < 4) break
      offset += 4
    }
    out.push({ start, end: offset })
  }
  return out
}

function readSessionText(file: string): string | null {
  let raw: Buffer
  try {
    raw = fs.readFileSync(file)
  } catch {
    return null
  }
  if (!file.endsWith('.zstd')) return raw.toString('utf8')

  const zstd = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
  if (typeof zstd === 'function') {
    const frames = scanZstdFrames(raw)
    if (!frames.length) return ''
    const out: Buffer[] = []
    for (const f of frames) {
      try {
        out.push(zstd(raw.subarray(f.start, f.end)))
      } catch {
        // 损坏的中间帧：保留前面能读的部分
        break
      }
    }
    return Buffer.concat(out).toString('utf8')
  }

  // Node < 22.15 / < 23.8 没有 zstd；如果系统装了 zstd，`-dc` 能处理 concatenated frames
  try {
    return execFileSync('zstd', ['-dc', file], { maxBuffer: 512 << 20, timeout: 120_000 }).toString('utf8')
  } catch {
    return null
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return cleanUserText(content)
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    const blk = b as any
    if (blk.type === 'text' && typeof blk.text === 'string') out.push(blk.text)
  }
  return cleanUserText(out.join('\n'))
}

function toolTextOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    const blk = b as any
    if (blk.type === 'tool-call' && typeof blk.name === 'string') {
      const args = typeof blk.arguments === 'string' ? blk.arguments : ''
      const hint = args.trim() ? plain(args, 100) : ''
      out.push(`▸ ${blk.name}${hint ? `: ${hint}` : ''}`)
    }
  }
  return out
}

interface Parsed {
  header: any
  events: any[]
}

function parseLog(file: string): Parsed | null {
  const text = readSessionText(file)
  if (text === null) return null
  let header: any = null
  const events: any[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let rec: any
    try {
      rec = JSON.parse(t)
    } catch {
      continue
    }
    if (!header && rec?.type === 'session') {
      header = rec
      continue
    }
    events.push(rec)
  }
  return header ? { header, events } : null
}

function parseMeta(file: string, parsed: Parsed): SessionMeta {
  const { header, events } = parsed
  let title = ''
  let firstUser = ''
  let lastUser = ''
  let turns = 0
  let bubbles = 0
  let assistantTexts = 0
  let model: string | null = null
  let firstAt: number | null = null
  let lastAt: number | null = null
  for (const ev of events) {
    const type = ev?.type
    const data = ev?.data
    const time = typeof ev?.time === 'number' ? ev.time : null
    if (time) {
      if (firstAt === null || time < firstAt) firstAt = time
      if (lastAt === null || time > lastAt) lastAt = time
    }
    if (type === 'session/title' && typeof data?.title === 'string') {
      title = data.title
      continue
    }
    if (type === 'user/message') {
      // 只收真人输入；agent.inject / AGENTS.md / skill 等合成消息不是用户提问
      if (data?.source && data.source.kind !== 'user') continue
      const text = textOf(data?.content).trim()
      if (!text || isInjected(text)) continue
      turns++
      bubbles++
      lastUser = text
      if (!firstUser) firstUser = text
      continue
    }
    if (type === 'assistant/message') {
      const msg = data?.message
      const text = textOf(msg?.content).trim()
      const tools = toolTextOf(msg?.content)
      if (!text && !tools.length) continue
      assistantTexts++
      bubbles++
      if (!model && typeof msg?.source?.model === 'string') model = msg.source.model
    }
  }
  const st = statOf(file)
  const cwd = typeof header.cwd === 'string' ? header.cwd : null
  const repo = cwd ? gitRoot(cwd) : null
  return {
    key: `dsh:${header.id}`,
    agent: 'dsh',
    agentLabel: 'DeepSeek Harness',
    id: String(header.id),
    title: plain(title || firstUser, 70) || '(空会话)',
    preview: plain(lastUser, 140),
    cwd,
    repo,
    project: projectName(repo || cwd),
    startedAt: typeof header.createdAt === 'number' ? header.createdAt : (firstAt || (st ? st.mtimeMs : null)),
    updatedAt: lastAt || (st ? st.mtimeMs : null),
    turns,
    bubbles,
    model,
    branch: null,
    source: file,
    size: st ? st.size : 0,
    extra: { variant: 'jsonl', compressed: file.endsWith('.zstd'), partial: assistantTexts === 0 },
  }
}

function read(meta: SessionMeta, opts: ReadOptions = {}): Turn[] {
  const parsed = parseLog(meta.source)
  if (!parsed) return []
  const turns: Turn[] = []
  for (const ev of parsed.events) {
    const type = ev?.type
    const data = ev?.data
    const at = typeof ev?.time === 'number' ? ev.time : undefined
    if (type === 'user/message') {
      if (data?.source && data.source.kind !== 'user') continue
      const text = textOf(data?.content).trim()
      if (!text || isInjected(text)) continue
      turns.push({ role: 'user', text, at })
    } else if (type === 'assistant/message') {
      const msg = data?.message
      const parts = [textOf(msg?.content).trim(), ...toolTextOf(msg?.content)].filter(Boolean)
      const text = parts.join('\n')
      if (text) turns.push({ role: 'assistant', text, at })
    }
  }
  return opts.tail ? turns.slice(-opts.tail) : turns
}

function sessionFiles(): { file: string; version: number }[] {
  const out: { file: string; version: number }[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    let best: { file: string; version: number } | null = null
    for (const e of entries) {
      if (e.isFile()) {
        const m = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(e.name)
        if (!m) continue
        const version = Number(m[1])
        const file = path.join(dir, e.name)
        const packed = Boolean(m[2])
        // 同版本优先未压缩；否则取最高版本
        if (!best || version > best.version || (version === best.version && !packed)) best = { file, version }
      }
    }
    if (best) out.push(best)
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1)
    }
  }
  walk(ROOT, 0)
  return out
}

function list(_opts: ListOptions, ctx: AdapterCtx): SessionMeta[] {
  const cache = ctx.cache as FileCache
  const prev = cache.files || {}
  const next: Record<string, { stamp: string; meta: SessionMeta }> = {}
  const out: SessionMeta[] = []
  for (const { file, version } of sessionFiles()) {
    const st = statOf(file)
    if (!st) continue
    const stamp = `${st.mtimeMs}:${st.size}:v${version}`
    const hit = prev[file]
    let meta: SessionMeta | null = hit && hit.stamp === stamp ? hit.meta : null
    if (!meta) {
      const parsed = parseLog(file)
      if (!parsed) continue
      meta = parseMeta(file, parsed)
      if (!meta) continue
    }
    next[file] = { stamp, meta }
    out.push(meta)
  }
  cache.files = next
  return out
}

export const dshAdapter: Adapter = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  available: () => isDir(ROOT),
  sources: () => [ROOT],
  list,
  read,
  hint: 'DSH 会话默认 zstd 压缩；Node >=22.15/23.8 内置 zstd，旧 Node 需安装系统 zstd 才能读 .jsonl.zstd。',
}

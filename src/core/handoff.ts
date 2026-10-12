import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { HANDOFF_DIR } from '../config'
import type { SessionMeta, Turn } from '../types'
import { slugify, writeJsonFile, readStoredJson, canonicalRepo, repoStorageKey, withFileLock, writeAtomic } from '../util'
import { buildBrief } from './brief'

/**
 * 收尾记录：把一次交接摘要落盘到本仓库名下，下次任何 agent 一进来就能看到。
 * 目录结构：
 *   ~/.local/share/agent-session-sync/handoffs/
 *   ├── index.json                      # 仓库 → 最新一份
 *   └── <repo-slug>/<时间>-<标题>.md     # 每次收尾存一份，另有 latest.md
 */
export interface NoteEntry {
  latest: string
  key: string
  at: number
  repo: string
  project: string
}

export type HandoffIndex = Record<string, NoteEntry>

const INDEX_FILE = path.join(HANDOFF_DIR, 'index.json')

export function loadIndex(): HandoffIndex {
  return readStoredJson<HandoffIndex>(INDEX_FILE, {})
}

export function repoSlugOf(meta: SessionMeta | null, repoDir: string): string {
  return repoStorageKey(repoDir)
}

export interface SavedNote {
  file: string
  latestFile: string
  slug: string
  md: string
}

export interface SaveNoteMdInput {
  /** 用来算 slug、并记进 index 的仓库目录 */
  repo: string
  md: string
  /** 这份记录是谁写的，如 `claude:31c5af10` 或 `task:t1` */
  key?: string
  /** 展示用项目名；存储身份始终由完整仓库路径决定 */
  project?: string | null
  /** 文件名里的标题片段 */
  title?: string
}

/**
 * 保存一份**任意 Markdown** 成本仓库的收尾记录。
 * 抽取出来是为了让「任务总览」（`ass resume <任务> --save`）也能走同一条路径。
 */
export function saveNoteMd(input: SaveNoteMdInput): SavedNote {
  return withFileLock(INDEX_FILE, () => {
    const repo = canonicalRepo(input.repo)
    const idx = loadIndex()
    const proj = input.project || path.basename(input.repo.replace(/\/+$/, '')) || ''
    const slug = repoStorageKey(repo)
    const dir = path.join(HANDOFF_DIR, slug)
    fs.mkdirSync(dir, { recursive: true })

    const md = input.md
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = path.join(dir, `${stamp}-${slugify(String(input.title ?? ''), 30)}-${randomUUID()}.md`)
    writeAtomic(file, md)
    const latestFile = path.join(dir, 'latest.md')
    writeAtomic(
      latestFile,
      `<!-- agent-session-sync:latest repo=${proj} key=${input.key ?? ''} at=${new Date().toISOString()} -->\n${md}`,
    )

    for (const [key, entry] of Object.entries(idx)) {
      if (key !== slug && entry.repo && canonicalRepo(entry.repo) === repo) delete idx[key]
    }
    idx[slug] = {
      latest: path.relative(HANDOFF_DIR, latestFile),
      key: input.key ?? '',
      at: Date.now(),
      repo,
      project: input.project ?? (proj || slug),
    }
    writeJsonFile(INDEX_FILE, idx)
    return { file, latestFile, slug, md }
  })
}

/** 保存一份收尾记录（同时更新 latest.md 和 index.json） */
export function saveNote(meta: SessionMeta, turns: Turn[], summary?: string, repoDir?: string): SavedNote {
  const repo = meta.repo || repoDir || meta.cwd || 'unknown'
  const md = (summary ? `> **补充说明：** ${summary}\n\n` : '') + buildBrief(meta, turns)
  return saveNoteMd({ repo, md, key: meta.key, project: meta.project, title: meta.title })
}

export interface LatestNote {
  slug: string
  entry: NoteEntry
  file: string
  content: string
}

/** 本仓库上次收尾留下的记录 */
export function latestNote(repoDir: string): LatestNote | null {
  const idx = loadIndex()
  const repo = canonicalRepo(repoDir)
  const slug = idx[repoStorageKey(repo)] ? repoStorageKey(repo) : Object.keys(idx).find((key) => idx[key]?.repo && canonicalRepo(idx[key]!.repo) === repo)
  if (!slug) return null
  const entry = idx[slug]
  if (!entry || canonicalRepo(entry.repo) !== repo) return null
  const file = path.join(HANDOFF_DIR, entry.latest)
  try {
    return { slug, entry, file, content: fs.readFileSync(file, 'utf8') }
  } catch {
    return null
  }
}

export function listNotes(): { slug: string; entry: NoteEntry }[] {
  const idx = loadIndex()
  return Object.entries(idx)
    .map(([slug, entry]) => ({ slug, entry }))
    .sort((a, b) => b.entry.at - a.entry.at)
}

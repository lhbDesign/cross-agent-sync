import fs from 'node:fs'
import path from 'node:path'
import { HANDOFF_DIR } from '../config'
import type { SessionMeta, Turn } from '../types'
import { readJsonFile, slugify, writeJsonFile } from '../util'
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
  return readJsonFile<HandoffIndex>(INDEX_FILE, {})
}

export function repoSlugOf(meta: SessionMeta | null, repoDir: string): string {
  const raw = meta?.project || path.basename(repoDir.replace(/\/+$/, '')) || 'unknown'
  return slugify(raw, 60)
}

export interface SavedNote {
  file: string
  latestFile: string
  slug: string
  md: string
}

/** 保存一份收尾记录（同时更新 latest.md 和 index.json） */
export function saveNote(meta: SessionMeta, turns: Turn[], summary?: string, repoDir?: string): SavedNote {
  const repo = meta.repo || repoDir || meta.cwd || 'unknown'
  const slug = repoSlugOf(meta, repo)
  const dir = path.join(HANDOFF_DIR, slug)
  fs.mkdirSync(dir, { recursive: true })

  const md = (summary ? `> **补充说明：** ${summary}\n\n` : '') + buildBrief(meta, turns)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const file = path.join(dir, `${stamp}-${slugify(meta.title, 30)}.md`)
  fs.writeFileSync(file, md)
  const latestFile = path.join(dir, 'latest.md')
  fs.writeFileSync(latestFile, `<!-- agent-session-sync:latest repo=${meta.project ?? ''} key=${meta.key} at=${new Date().toISOString()} -->\n${md}`)

  const idx = loadIndex()
  idx[slug] = { latest: path.relative(HANDOFF_DIR, latestFile), key: meta.key, at: Date.now(), repo, project: meta.project ?? slug }
  writeJsonFile(INDEX_FILE, idx)
  return { file, latestFile, slug, md }
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
  const slug = slugify(path.basename(repoDir.replace(/\/+$/, '')) || 'unknown', 60)
  const entry = idx[slug]
  if (!entry) return null
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

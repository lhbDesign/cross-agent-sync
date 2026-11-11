import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

/** 递归求和；跳过符号链接，避免环 */
function walkBytes(p, depth = 0) {
  if (depth > 12) return 0
  let st
  try {
    st = fs.lstatSync(p)
  } catch {
    return 0
  }
  if (st.isSymbolicLink()) return 0
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0

  let entries
  try {
    entries = fs.readdirSync(p)
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) total += walkBytes(path.join(p, e), depth + 1)
  return total
}

/**
 * `sources()` 没列出来、但适配器实际会读的路径。
 * 不补全的话，概览里的磁盘占用会明显偏小（尤其是 Cursor）。
 * 路径一律从 adapter 自己给出的 source 推导，保证 macOS / Windows 都对。
 */
function extraPaths(a) {
  const out = []
  if (a.id === 'codex') {
    try {
      const dir = path.join(HOME, '.codex')
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^state_\d+\.sqlite$/.test(f))
        .sort((x, y) => Number((y.match(/\d+/) || [0])[0]) - Number((x.match(/\d+/) || [0])[0]))
      if (files[0]) out.push(path.join(dir, files[0]))
    } catch { /* 没有就算了 */ }
  }
  if (a.id === 'cursor') {
    // source 形如 <User>/globalStorage/state.vscdb → workspaceStorage 在 <User> 下
    for (const src of a.sources || []) {
      const dbDir = path.dirname(src)
      if (path.basename(dbDir) === 'globalStorage') out.push(path.join(path.dirname(dbDir), 'workspaceStorage'))
    }
  }
  return out
}

/** agents 来自 `ass agents --json` */
export function diskUsage(agents) {
  const seen = new Set()
  return agents.map((a) => {
    const paths = [...(a.sources || []), ...extraPaths(a)]
    let bytes = 0
    for (const p of paths) {
      let real = p
      try {
        real = fs.realpathSync(p)
      } catch { /* 路径可能不存在 */ }
      if (seen.has(real)) continue
      seen.add(real)
      bytes += walkBytes(p)
      for (const suf of ['-wal', '-shm']) {
        try {
          bytes += fs.statSync(`${p}${suf}`).size
        } catch { /* ignore */ }
      }
    }
    return { id: a.id, label: a.label, bytes, paths }
  })
}

export function humanSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

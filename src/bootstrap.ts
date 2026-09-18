import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { sqliteBackend } from './sqlite'

/**
 * Node 22.5 ~ 23.3 的 `node:sqlite` 需要 `--experimental-sqlite` 才能用。
 * 如果用户：
 *   - 没装 sqlite3 命令行，且
 *   - Node 版本支持这个 flag，
 * 就带上 flag 重跑一次自己 —— 免得为了读 Cursor / OpenCode 还要额外装东西。
 *
 * 只重跑一次（ASS_REEXEC 兜底），且只在两条路都比不了的时候才动手。
 */
export function maybeReexec(): void {
  if (process.env.ASS_REEXEC === '1') return
  const sq = sqliteBackend()
  if (sq.backend) return // 已经能用（node:sqlite 或 sqlite3 命令行）
  const [major = 0, minor = 0] = process.versions.node.split('.').map((n) => Number.parseInt(n, 10))
  // 23.4+ / 24 已经不需要 flag 了：如果那时 node:sqlite 还是用不了，重跑也没意义
  if (major > 23 || (major === 23 && minor >= 4)) return
  const supportsFlag = (major === 22 && minor >= 5) || (major === 23 && minor < 4)
  if (!supportsFlag) return
  if (process.execArgv.includes('--experimental-sqlite')) return

  try {
    const r = spawnSync(
      process.execPath,
      ['--experimental-sqlite', ...process.execArgv, process.argv[1] ?? '', ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, ASS_REEXEC: '1' } },
    )
    process.exit(r.status ?? 0)
  } catch {
    // 重跑失败就按原样继续：还有“两个后端都不可用”的降级路径兜着
  }
}

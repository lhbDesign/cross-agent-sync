import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { exists } from './util'

/**
 * 零依赖读 SQLite（OpenCode / Cursor / Kiro 这类 agent 用 db 存会话）。
 *
 * 优先级：
 *   1. Node 内置 node:sqlite（Node >= 22.5 且带 --experimental-sqlite；23.4+ 免 flag）
 *   2. 系统 sqlite3 命令行（macOS 自带，用 -json 输出）
 *   3. 都不行 → db = null，由调用方给出「怎么办」的提示
 *
 * 两个后端都走「字符串拼 SQL」，所以统一用 lit() 转义。
 */
export interface Db {
  /** 只读查询，返回行数组 */
  query<T = Record<string, any>>(sql: string): T[]
  /** 后端名字，doctor 里展示 */
  backend: string
  close(): void
}

export type DbOpenResult = { db: Db; backend: string; reason?: undefined } | { db: null; backend: null; reason: string }

const require_ = createRequire(import.meta.url)

let nodeSqlite: any | null | undefined
function getNodeSqlite(): any | null {
  if (nodeSqlite !== undefined) return nodeSqlite
  try {
    // 用变量名 require：避免打包期静态解析（Node < 22.5 上根本没这个内置模块）
    const name = 'node:sqlite'
    nodeSqlite = require_(name)
  } catch {
    nodeSqlite = null
  }
  return nodeSqlite
}

let cliChecked: boolean | null = null
function hasSqliteCli(): boolean {
  if (cliChecked !== null) return cliChecked
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore', timeout: 5000 })
    cliChecked = true
  } catch {
    cliChecked = false
  }
  return cliChecked
}

/** 把值转成 SQL 字面量 */
export function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  return `'${String(v).replace(/'/g, "''")}'`
}

function openCli(file: string): Db {
  return {
    backend: 'sqlite3(cli)',
    query<T>(sql: string): T[] {
      const out = execFileSync('sqlite3', ['-json', file, sql], {
        encoding: 'utf8',
        maxBuffer: 256 << 20,
        timeout: 120_000,
      })
      const t = out.trim()
      if (!t) return []
      try {
        return JSON.parse(t) as T[]
      } catch {
        return []
      }
    },
    close() {
      /* CLI 每次查询都是独立进程，无需关闭 */
    },
  }
}

/**
 * 真正在用的是哪个后端 —— 按**实际探测**判断，不按 Node 版本号猜
 * （Node 22.11 就没带 node:sqlite 的默认开关，凭版本号会误报）。
 */
export function sqliteBackend(): { backend: 'node:sqlite' | 'sqlite3(cli)' | null; reason: string } {
  const mod = getNodeSqlite()
  if (mod?.DatabaseSync) {
    try {
      // 拿一个内存库真开一下，确认可用（而不是“模块能 require 就算数”）
      const probe = new mod.DatabaseSync(':memory:')
      probe.close()
      return { backend: 'node:sqlite', reason: 'Node 内置' }
    } catch (e) {
      // 常见：Node 22.5~23.3 需要 --experimental-sqlite
      const msg = e instanceof Error ? e.message : String(e)
      if (hasSqliteCli()) return { backend: 'sqlite3(cli)', reason: `node:sqlite 不可用（${msg.slice(0, 60)}），已回退到 sqlite3 命令行` }
      return { backend: null, reason: `node:sqlite 不可用：${msg}` }
    }
  }
  if (hasSqliteCli()) return { backend: 'sqlite3(cli)', reason: '系统 sqlite3 命令行' }
  return {
    backend: null,
    reason: '既没有 node:sqlite（Node < 22.5，或需要 --experimental-sqlite），也没有 sqlite3 命令行',
  }
}

export function openSqlite(file: string): DbOpenResult {
  if (!exists(file)) return { db: null, backend: null, reason: `文件不存在: ${file}` }
  const mod = getNodeSqlite()
  if (mod?.DatabaseSync) {
    try {
      const db = new mod.DatabaseSync(file, { readOnly: true })
      return {
        db: {
          backend: 'node:sqlite',
          query<T>(sql: string): T[] {
            return db.prepare(sql).all() as T[]
          },
          close() {
            try {
              db.close()
            } catch {
              /* ignore */
            }
          },
        },
        backend: 'node:sqlite',
      }
    } catch {
      /* 落到 CLI */
    }
  }
  if (hasSqliteCli()) return { db: openCli(file), backend: 'sqlite3(cli)' }
  return {
    db: null,
    backend: null,
    reason:
      '本机没有可用的 SQLite 读取方式。二选一：① 用 Node >= 22.5 并加 --experimental-sqlite（Node 23.4+ 免 flag）；② 装 sqlite3 命令行。',
  }
}

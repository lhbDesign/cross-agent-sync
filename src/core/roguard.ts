import fs from 'node:fs'
import path from 'node:path'

/**
 * 源数据守护（R7）：把「只读」从**纪律**变成**运行时可验证的机制**。
 *
 * 原先「只读」只是"我们代码里没写写操作"这一句承诺 —— 它既不防手滑
 * （比如 `ass brief --out ~/.claude/projects/x.jsonl`），也无法向用户证明。
 * 这里补三件事：
 *
 *   ① **写边界**：会话数据所在的位置是受保护区，任何写路径命中即拒绝（assertWritable）。
 *   ② **只读句柄**：读源文件一律显式 `O_RDONLY` 打开，不给"顺手改一下"留口子。
 *   ③ **变更自证**：开句柄时留指纹，运行期结束后能自证"本次没有改动过任何源数据"。
 *
 * 两个关键设计：
 *
 *   - **保护边界是子树，不是整个 agent 目录**：`~/.claude/projects/**` 是会话数据（保护），
 *     而 `~/.claude.json`、`~/.claude/CLAUDE.md` 恰恰是我们**该写**的配置文件（不保护）。
 *     边界由每个 adapter 自报的 `sources()` 推导 —— adapter 同时声明了"怎么读"和"哪里别写"，
 *     两者天生该由同一处提供，分开维护必然漂移。
 *
 *   - **读即登记**：除了 adapter 自报的静态边界，**凡是本进程读过文件的父目录也自动进入保护区**。
 *     这是为了覆盖 `sources()` 里看不出来的读路径 —— 典型例子是 Cursor 把图片附件放在与
 *     `state.vscdb` **平级**的 `workspaceStorage/` 下，静态清单里根本没有它。有了"读即登记"，
 *     保护边界不需要人为维护，也不会漏。
 *
 * 本模块是**叶子模块**：只依赖 node 内置模块，不 import 项目里的任何东西。
 * 因为它要被 util.ts 的读函数调用，而 util.ts 被几乎所有模块依赖 —— 一旦反向依赖就成环。
 */

/** 文件指纹。三类字段各管一件事：size 管增长、mtime 管就地改写、ino 管整体替换 */
export interface Fp {
  size: number
  mtimeMs: number
  ino: number
}

const roots = new Map<string, string>() // 绝对路径 → 为什么被保护（给 doctor 展示）
const opened = new Map<string, Fp>()

function realpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function statFp(p: string): Fp | null {
  try {
    const st = fs.statSync(p)
    return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }
  } catch {
    return null
  }
}

/** 显式声明一处受保护路径（文件或目录） */
export function addProtectedPath(p: string, why: string): void {
  if (!p) return
  roots.set(realpath(p), why)
}

/**
 * 用 adapter 自报的数据源武装保护区。
 *
 * 参数是 adapter 数组而不是 Config，是为了不 import `adapters/registry`
 * ——本模块必须保持叶子地位（见文件头）。
 */
export function armGuard(adapters: { id: string; label: string; sources(): string[] }[]): void {
  for (const a of adapters) {
    let srcs: string[] = []
    try {
      srcs = a.sources() || []
    } catch {
      continue
    }
    for (const s of srcs) {
      if (s) addProtectedPath(s, `${a.label} 的会话数据`)
    }
  }
}

/**
 * 目标路径是否落在某个受保护区里。
 *
 * 保护区可能是**文件**（如 `opencode.db`），也可能是**目录**（如 `~/.claude/projects`）。
 * 目录按前缀判定，且必须比到路径分隔符 —— 否则 `/a/bc` 会被误判成落在 `/a/b` 里。
 */
export function protectedBy(target: string): { root: string; why: string } | null {
  const real = realpath(target)
  for (const [root, why] of roots) {
    if (real === root) return { root, why }
    if (real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return { root, why }
  }
  return null
}

/**
 * 写操作的第一道闸。命中保护区就抛错 —— 这是**运行时强制**，不是文档承诺。
 * 逃生门：`ASS_ALLOW_SOURCE_WRITE=1`（只在用户显式知情时用，比如他在做数据迁移）。
 */
export function assertWritable(target: string, what = '写操作'): void {
  if (process.env.ASS_ALLOW_SOURCE_WRITE === '1') return
  const hit = protectedBy(target)
  if (!hit) return
  throw new Error(
    `${what}被拒绝：${target}\n` +
      `  该路径位于受保护区内（${hit.root} —— ${hit.why}）。\n` +
      `  agent-session-sync 对会话数据只读，不会写入这里。\n` +
      `  确实要写：显式设 ASS_ALLOW_SOURCE_WRITE=1 再执行。`,
  )
}

/**
 * 以只读句柄打开一个源文件，并登记指纹。
 *
 * 返回 fd（调用方负责 close），打不开返回 null。**只认 O_RDONLY** ——
 * 这里的意义不在于防外部攻击，而在于让"我们只读"这件事在代码里只有一个入口，
 * 想改写成可写都改不了（这个函数不给 flags 参数）。
 */
export function openSource(file: string, scope: 'directory' | 'file' = 'directory'): number | null {
  const real = realpath(file)
  // 读即登记：父目录进入保护区（覆盖 sources() 看不出来的读路径，如 Cursor 的附件目录）
  roots.set(scope === 'file' ? real : path.dirname(real), `${path.basename(real)}（读即登记）`)
  try {
    const fd = fs.openSync(real, fs.constants.O_RDONLY)
    noteOpened(real, fd)
    return fd
  } catch {
    return null
  }
}

/** 给已经打开的 fd 登记指纹（openSource 内部用；也供已有 fd 的调用方补登记） */
export function noteOpened(realPath: string, fd: number): void {
  try {
    const st = fs.fstatSync(fd)
    opened.set(realPath, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino })
  } catch {
    /* 拿不到指纹就不登记，不影响读取 */
  }
}

/**
 * 登记一次「读了这个源文件」，但不持有句柄。
 *
 * 给**由第三方库自己开句柄**的读路径用 —— 典型是 SQLite（cursor / opencode 的 db）：
 * 句柄在 node:sqlite 或 sqlite3 命令行手里，我们插不进去，但"读过它"这件事仍须登记，
 * 否则受保护区会漏掉 `state.vscdb` 所在的目录。
 */
export function noteSourceRead(file: string, scope: 'directory' | 'file' = 'directory'): void {
  const real = realpath(file)
  roots.set(scope === 'file' ? real : path.dirname(real), `${path.basename(real)}（读即登记）`)
  const fp = statFp(real)
  if (fp) opened.set(real, fp)
}

/**
 * 读过之后 mtime 还落在这个窗口内的，判为**「正在使用的会话」**而不是「被改动」。
 *
 * 为什么需要这个区分：agent 会话文件在用户干活时本来就是持续被追加的。
 * 不做区分的话，「变更自证」会**恒为红**（实测立刻就有 1 个），
 * 于是这个信号永远亮着、也就等于没有 —— 而它本来是用来**证明没动过**的。
 *
 * 5 分钟是经验值：正常一次工具调用的读写间隔是毫秒级，
 * 而"人还在这个会话里打字"的间隔通常远大于此。
 */
const ACTIVE_MS = 5 * 60 * 1000

export interface Change {
  file: string
  before: Fp
  after: Fp | null
  /** 文件整个不见了 */
  missing: boolean
  /** 读完之后仍在被写（多半是正在使用的会话）。这种变化**无法判定**是不是本进程所为 */
  active: boolean
}

/**
 * 自证：本进程读过的源文件，现在是否还和读的时候一样。
 *
 * 用途是**证明"没动过"**，不是"检测别人动过" —— 所以只对自己登记过的文件负责，
 * 返回空数组即"本次运行未改动任何源数据"。改动他人数据本来也不是这个进程能控制的。
 */
export function verifyUnchanged(now = Date.now()): Change[] {
  const out: Change[] = []
  for (const [file, before] of opened) {
    const after = statFp(file)
    if (!after) {
      out.push({ file, before, after: null, missing: true, active: false })
      continue
    }
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      out.push({ file, before, after, missing: false, active: now - after.mtimeMs < ACTIVE_MS })
    }
  }
  return out
}

export interface GuardSummary {
  /** 受保护的路径数 */
  roots: number
  /** 本次进程读过并登记指纹的源文件数 */
  opened: number
  /** 读后被改动、**且不是**活跃会话写入 —— 这才是需要关注的 */
  changed: number
  /** 读后仍在被写（正在使用的会话）。**无法判定**是本进程还是别的进程，单列不计入 changed */
  active: number
}

export function guardSummary(): GuardSummary {
  const all = verifyUnchanged()
  return {
    roots: roots.size,
    opened: opened.size,
    changed: all.filter((c) => !c.active).length,
    active: all.filter((c) => c.active).length,
  }
}

/** 保护区清单（`ass doctor` 展示用） */
export function protectedPaths(): { path: string; why: string }[] {
  return [...roots.entries()].map(([p, why]) => ({ path: p, why })).sort((a, b) => a.path.localeCompare(b.path))
}

/** 测试用：清空状态 */
export function resetGuard(): void {
  roots.clear()
  opened.clear()
}

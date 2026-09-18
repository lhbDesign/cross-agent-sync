/** 一个会话里出现的图片：要么是内联 base64，要么是本机上已有的文件 */
export interface ImagePart {
  mediaType: string
  /** 记录里内联的图片数据 */
  base64?: string
  /** 已经在磁盘上的图片（Cursor 这类把附件存成文件的 agent） */
  path?: string
}

/** 会话里的文件/文本附件引用 */
export interface FilePart {
  name: string
  path?: string
  text?: string
}

export type Role = 'user' | 'assistant' | 'tool' | 'system'

/** 统一后的“一轮对话”单元 */
export interface Turn {
  role: Role
  text: string
  at?: number
  images?: ImagePart[]
  files?: FilePart[]
}

/** 统一后的会话元数据（所有 adapter 的输出形状） */
export interface SessionMeta {
  /** 全局唯一引用：`<agent>:<id>` */
  key: string
  agent: string
  agentLabel: string
  /** 该 agent 内部的会话 id（用于 `claude --resume` 等） */
  id: string
  title: string
  /** 会话最近一句用户需求 */
  preview: string
  cwd: string | null
  /** 归一化后的 git 仓库根目录（跨 agent 对齐的关键） */
  repo: string | null
  project: string | null
  startedAt: number | null
  updatedAt: number | null
  /** 用户轮次数 */
  turns: number
  /** 消息总数（含回复） */
  bubbles: number
  model?: string | null
  branch?: string | null
  /** 原始文件（jsonl / db） */
  source: string
  size: number
  /** agent 专属字段，供 `show` 输出 */
  extra?: Record<string, unknown>
}

export interface ListOptions {
  /** 只看这个仓库（会用它去 gitRoot 归一化） */
  repo?: string | null
  limit?: number
  /** 跨所有仓库，不按 repo 过滤 */
  includeAll?: boolean
  minTurns?: number
  since?: number
  /** 关掉 mtime 缓存，强制重新解析 */
  noCache?: boolean
  /** 只看某个 agent */
  agent?: string
}

export interface AdapterCtx {
  /** adapter 自己的缓存槽（跨调用持久化到磁盘） */
  cache: Record<string, unknown>
}

export interface ReadOptions {
  /** 只取最后 N 条消息（大文件友好） */
  tail?: number
}

export interface Adapter {
  id: string
  label: string
  /** 该 agent 的数据源是否存在于本机 */
  available(): boolean
  /** 数据源描述，doctor 用 */
  sources(): string[]
  list(opts: ListOptions, ctx: AdapterCtx): SessionMeta[]
  read(meta: SessionMeta, opts?: ReadOptions): Turn[]
  /** 在新 agent 里继续这个会话的 shell 命令 */
  resumeCmd?(meta: SessionMeta): string
  /** 数据源不可用时的提示（比如 Cursor 需要用户配置路径） */
  hint?: string
}

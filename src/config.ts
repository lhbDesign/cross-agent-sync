import path from 'node:path'
import { HOME, exists, readJsonFile, writeJsonFile } from './util'

/**
 * 配置与数据目录（可用环境变量覆盖，方便多机/测试）：
 *   ASS_CONFIG_DIR  默认 ~/.config/agent-session-sync
 *   ASS_DATA_DIR    默认 ~/.local/share/agent-session-sync
 */
export const CONFIG_DIR = process.env.ASS_CONFIG_DIR || path.join(HOME, '.config', 'agent-session-sync')
export const DATA_DIR = process.env.ASS_DATA_DIR || path.join(HOME, '.local', 'share', 'agent-session-sync')
export const CACHE_DIR = path.join(DATA_DIR, 'cache')
export const HANDOFF_DIR = path.join(DATA_DIR, 'handoffs')
export const ATTACH_DIR = path.join(DATA_DIR, 'attachments')

export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

/** 用户自定义的 agent（自检索不到、或想自己指定路径/格式时用） */
export interface CustomAgent {
  id: string
  label?: string
  /**
   * jsonl  = 一个目录里若干 .jsonl，一行一条记录
   * json   = 一个目录里若干 .json，一个文件一个会话（记录数组用 records 指定，如 history）
   * sqlite = 一个 db 文件（需同时给 query）
   */
  type: 'jsonl' | 'json' | 'sqlite'
  /** 数据源：文件或目录，支持 ~ 展开 */
  path: string
  /** 该 agent 的会话文件里，哪些字段能取到这些值（点号路径） */
  map?: {
    id?: string
    cwd?: string
    title?: string
    role?: string
    text?: string
    imageUrl?: string
    timestamp?: string
  }
  /** type=sqlite 时的查询语句（返回列名同 map 的键） */
  query?: string
  /** type=json 时，记录数组在文件里的位置（点号路径），如 "history" */
  records?: string
  /** 把该 agent 自己的角色名映射成 user/assistant，如 { "gemini": "assistant" } */
  roleMap?: Record<string, 'user' | 'assistant'>
  resumeCmd?: string
  hint?: string
}

export interface Config {
  /** 内置 adapter 开关，如 { cursor: false } */
  agents?: Record<string, boolean>
  /** 只看这些 agent（白名单，优先级高于 agents） */
  only?: string[]
  customAgents?: CustomAgent[]
  defaultLimit?: number
  /** 会话里图片落盘的目录 */
  attachmentsDir?: string
}

const DEFAULTS: Config = {
  agents: {},
  customAgents: [],
  defaultLimit: 15,
}

export function configPath(): string {
  return CONFIG_FILE
}

export function loadConfig(): Config {
  const raw = readJsonFile<Partial<Config>>(CONFIG_FILE, {})
  return {
    ...DEFAULTS,
    ...raw,
    agents: { ...DEFAULTS.agents, ...(raw.agents || {}) },
    customAgents: raw.customAgents || [],
  }
}

/** 配置不存在时写一份带注释性默认值的模板，方便用户改 */
export function ensureConfig(): { config: Config; created: boolean } {
  if (exists(CONFIG_FILE)) return { config: loadConfig(), created: false }
  const template: Config = {
    agents: { claude: true, codex: true, opencode: true, cursor: true },
    customAgents: [],
    defaultLimit: 15,
  }
  saveConfig(template)
  return { config: loadConfig(), created: true }
}

export function saveConfig(cfg: Config): void {
  writeJsonFile(CONFIG_FILE, cfg)
}

/** ~ 展开 + 绝对化 */
export function expandPath(p: string): string {
  let out = p.trim()
  if (out === '~') out = HOME
  else if (out.startsWith('~/')) out = path.join(HOME, out.slice(2))
  return path.resolve(out)
}

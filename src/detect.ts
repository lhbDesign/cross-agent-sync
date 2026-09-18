import { HOME, exists, isDir } from './util'
import { buildAdapters } from './adapters/registry'
import { loadConfig, type Config, type CustomAgent } from './config'
import { makeCustomAdapter } from './adapters/generic'

/**
 * 自检索（R5）：扫一遍本机常见 agent 的数据目录，告诉你
 *   ① 哪些内置 adapter 真的有数据；
 *   ② 哪些 agent 装了但格式还没接 —— 并给出**可以直接抄的配置草案**。
 *
 * 只做探测和读文件，不会替你改配置（要落地请用 `ass detect --write`）。
 */
export interface Detected {
  id: string
  label: string
  kind: 'builtin' | 'configured' | 'candidate' | 'probe'
  path: string
  available: boolean
  sessions: number
  detail?: string
  /** 可直接写进 config.json 的 customAgents 草案 */
  config?: CustomAgent
}

/** 我们知道怎么解析、但默认不打开的 agent（用户点个头就能用） */
const PRESETS: CustomAgent[] = [
  {
    id: 'continue',
    label: 'Continue',
    type: 'json',
    path: '~/.continue/sessions',
    records: 'history',
    map: {
      id: 'sessionId',
      cwd: 'workspaceDirectory',
      title: 'title',
      role: 'message.role',
      text: 'message.content',
    },
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    type: 'json',
    // 每个会话是 ~/.gemini/tmp/<projectHash>/chats/session-*.json
    path: '~/.gemini/tmp',
    records: 'messages',
    roleMap: { gemini: 'assistant', model: 'assistant', user: 'user' },
    map: { id: 'sessionId', title: 'title', role: 'type', text: 'content', timestamp: 'timestamp' },
    hint: 'Gemini CLI 只按 projectHash 存目录、会话里没有仓库路径，所以这些会话只能在 ass list --all 里看到，无法按仓库过滤。',
  },
]

/** 只是探个存在、格式还没确定的 agent */
const PROBES: { id: string; label: string; path: string; detail: string }[] = [
  {
    id: 'trae',
    label: 'Trae',
    path: '~/Library/Application Support/Trae/User/globalStorage/state.vscdb',
    detail: 'Trae 是 VS Code 分支，聊天记录在 state.vscdb / workspaceStorage 里，需要自己的 query',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    path: '~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb',
    detail: '同上：需要先摸清它的库结构再写 query',
  },
  {
    id: 'vscode-copilot',
    label: 'VS Code (Copilot Chat)',
    path: '~/Library/Application Support/Code/User/globalStorage/state.vscdb',
    detail: 'Copilot Chat 的会话在 ItemTable / cursorDiskKV 里，可按 sqlite 类型接',
  },
  {
    id: 'kiro',
    label: 'Kiro',
    path: '~/.kiro',
    detail: 'Kiro 的会话目录因版本而异，找到 *.jsonl / *.json 后用 ass detect 的草案填 map',
  },
]

function expand(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, HOME) : p
}

export function detectSources(cfg: Config = loadConfig()): Detected[] {
  const out: Detected[] = []
  const configured = new Set((cfg.customAgents || []).map((c) => c.id))

  // ① 内置
  for (const a of buildAdapters(cfg, { includeUnavailable: true })) {
    let sessions = 0
    let available = false
    try {
      available = a.available()
      if (available) sessions = a.list({}, { cache: {} }).length
    } catch {
      /* 读不了就当不可用 */
    }
    out.push({
      id: a.id,
      label: a.label,
      kind: (cfg.customAgents || []).some((c) => c.id === a.id) ? 'configured' : 'builtin',
      path: a.sources().join('  '),
      available,
      sessions,
    })
  }

  // ② 预置的、知道怎么解析的
  for (const preset of PRESETS) {
    if (configured.has(preset.id)) continue
    const p = expand(preset.path)
    if (!exists(p)) continue
    let sessions = 0
    try {
      sessions = makeCustomAdapter(preset).list({}, { cache: {} }).length
    } catch {
      /* ignore */
    }
    out.push({
      id: preset.id,
      label: preset.label || preset.id,
      kind: 'candidate',
      path: preset.path,
      available: true,
      sessions,
      detail: sessions ? `找到 ${sessions} 个会话，可直接接入` : '目录在，但没解析出会话（字段可能对不上）',
      config: preset,
    })
  }

  // ③ 只探存在
  for (const probe of PROBES) {
    if (configured.has(probe.id)) continue
    const p = expand(probe.path)
    const there = exists(p)
    if (!there) continue
    out.push({
      id: probe.id,
      label: probe.label,
      kind: 'probe',
      path: probe.path,
      available: isDir(p) ? true : exists(p),
      sessions: 0,
      detail: probe.detail,
    })
  }
  return out
}

/** 把候选（candidate）合并进配置 */
export function applyDetected(ids: string[], cfg: Config = loadConfig()): { added: CustomAgent[]; config: Config } {
  const det = detectSources(cfg)
  const added: CustomAgent[] = []
  for (const d of det) {
    if (d.kind !== 'candidate' || !d.config) continue
    if (ids.length && !ids.includes(d.id)) continue
    if ((cfg.customAgents || []).some((c) => c.id === d.id)) continue
    added.push(d.config)
  }
  return { added, config: { ...cfg, customAgents: [...(cfg.customAgents || []), ...added] } }
}

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DATA_DIR, type Config } from './config'
import { HOME, canonicalRepo, readStoredJson, withFileLock, writeJsonFile, exists } from './util'
import { assertWritable } from './core/roguard'
import { findSession, readSession } from './core/store'
import { readContext } from './core/context'
import { saveNote } from './core/handoff'

const HOOK_DIR = path.join(DATA_DIR, 'hooks')
const STATE_FILE = path.join(HOOK_DIR, 'state.json')
const MARK = '--ass-managed-handoff-v1'
const EVENTS = { claude: ['Stop', 'SessionEnd'], cursor: ['stop', 'sessionEnd'] } as const
export type HookAgent = keyof typeof EVENTS
export interface HookResult {
  at: number
  agent: string
  session?: string
  repo?: string
  event?: string
  status: 'saved' | 'unchanged' | 'failed'
  file?: string
  error?: string
}
interface HookState {
  saves: Record<string, { fingerprint: string; file: string }>
  recent: HookResult[]
}
const emptyState = (): HookState => ({ saves: {}, recent: [] })
function loadState(): HookState {
  const state = readStoredJson<HookState>(STATE_FILE, emptyState())
  if (!state || typeof state.saves !== 'object' || !state.saves || !Array.isArray(state.recent)) throw new Error(`自动交接状态格式无效：${STATE_FILE}`)
  return state
}
function remember(state: HookState, result: HookResult): void {
  state.recent = [...state.recent, result].slice(-50)
  writeJsonFile(STATE_FILE, state)
}
function configPath(agent: HookAgent): string {
  return agent === 'claude' ? path.join(HOME, '.claude', 'settings.json') : path.join(HOME, '.cursor', 'hooks.json')
}
function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`)
  return value as Record<string, any>
}
function managed(hook: any): boolean {
  return typeof hook?.command === 'string' && /(?:^|\s)--ass-managed-handoff-v1(?:\s|$)/.test(hook.command)
}
function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'` }

/** Only merge our handlers; never replace another integration's hooks. */
export function configureHooks(agent: HookAgent, action: 'install' | 'uninstall', dryRun = false, cliPath = process.argv[1]) {
  if (!(Object.prototype.hasOwnProperty.call(EVENTS, agent))) throw new Error(`不支持自动安装 ${agent}；可通过 ass hook run --agent <agent> 手工接入`)
  if (process.platform === 'win32') throw new Error('自动安装目前支持 macOS/Linux；Windows 请手工配置 hook run')
  const file = configPath(agent)
  if (!exists(path.dirname(file))) return { agent, file, action: 'missing', detail: '未发现 agent 配置目录，未创建文件' }
  const change = () => {
    const original = object(readStoredJson(file, {}), file)
    const cfg = structuredClone(original)
    const hooks = cfg.hooks === undefined ? {} : object(cfg.hooks, 'hooks')
    if (agent === 'cursor' && cfg.version !== undefined && cfg.version !== 1) throw new Error('不支持的 Cursor hooks 配置版本')
    const command = `${quote(process.execPath)} ${quote(fs.realpathSync(cliPath))} hook run --agent ${agent} ${MARK}`
    for (const event of EVENTS[agent]) {
      const entries = hooks[event] ?? []
      if (!Array.isArray(entries)) throw new Error(`${event} 必须是数组，未修改配置`)
      const clean = agent === 'claude'
        ? entries.flatMap((group: any) => {
          if (!Array.isArray(group?.hooks)) return [group]
          const keep = group.hooks.filter((h: any) => !managed(h))
          return keep.length === group.hooks.length ? [group] : keep.length ? [{ ...group, hooks: keep }] : []
        })
        : entries.filter((h: any) => !managed(h))
      if (action === 'install') {
        const handler = { type: 'command', command, timeout: 30 }
        clean.push(agent === 'claude' ? { hooks: [handler] } : handler)
      }
      if (clean.length) hooks[event] = clean
      else delete hooks[event]
    }
    if (Object.keys(hooks).length) cfg.hooks = hooks
    else delete cfg.hooks
    if (agent === 'cursor' && action === 'install') cfg.version = 1
    const changed = JSON.stringify(cfg) !== JSON.stringify(original)
    let backup: string | undefined
    if (changed && !dryRun) {
      assertWritable(file, 'ass hook 配置')
      if (exists(file)) {
        backup = `${file}.bak-${Date.now()}-${randomUUID()}`
        assertWritable(backup, 'ass hook 备份')
        fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
      }
      writeJsonFile(file, cfg)
    }
    return { agent, file, action: changed ? (dryRun ? 'would-' : '') + action : 'unchanged', backup, events: EVENTS[agent] }
  }
  return dryRun ? change() : withFileLock(file, change)
}

export function hookStatus() {
  const configs = (Object.keys(EVENTS) as HookAgent[]).map(agent => {
    const file = configPath(agent)
    try {
      const cfg = object(readStoredJson(file, {}), file)
      const events = EVENTS[agent].filter(event => {
        const list = cfg.hooks?.[event]
        return Array.isArray(list) && list.some((g: any) => agent === 'claude' ? Array.isArray(g?.hooks) && g.hooks.some(managed) : managed(g))
      })
      return { agent, file, installed: events.length === EVENTS[agent].length, events }
    } catch (error) { return { agent, file, installed: false, error: String(error) } }
  })
  return { configs, stateFile: STATE_FILE, recent: loadState().recent }
}

export function recordHookFailure(agent: string, error: unknown, details: Partial<HookResult> = {}): HookResult {
  const result: HookResult = { ...details, at: Date.now(), agent, status: 'failed', error: error instanceof Error ? error.message : String(error) }
  withFileLock(STATE_FILE, () => remember(loadState(), result))
  return result
}

/** Exact source identity only. Do not guess the latest session or read arbitrary payload paths. */
export function runHook(agent: string, input: unknown, cfg: Config): HookResult {
  const payload = object(input, 'hook 输入')
  const id = payload.session_id ?? payload.conversation_id
  if (typeof id !== 'string' || !id.trim()) throw new Error('hook 缺少完整 session_id / conversation_id；不会自动选择最近会话')
  if (!/^[a-z0-9_-]+$/i.test(agent)) throw new Error('agent 标识无效')
  const session = `${agent}:${id}`
  const event = String(payload.hook_event_name || 'manual')
  if (Object.prototype.hasOwnProperty.call(EVENTS, agent) && !(EVENTS[agent as HookAgent] as readonly string[]).includes(event) && event !== 'manual') throw new Error(`不处理事件 ${event}`)
  // Cursor session_id can identify a run, conversation_id identifies the stored conversation.
  const exact = agent === 'cursor' && typeof payload.conversation_id === 'string' ? `cursor:${payload.conversation_id}` : session
  return withFileLock(STATE_FILE, () => {
    const found = findSession(exact, { ...cfg, only: [agent] })
    if (!found || found.meta.key !== exact) throw new Error(`没有找到精确会话 ${exact}；可能尚未落盘，可稍后用同一输入重试`)
    if (!found.meta.repo && !found.meta.cwd) throw new Error('源会话没有仓库路径，不能安全归档')
    const repo = canonicalRepo(found.meta.repo || found.meta.cwd!)
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []
    const supplied = typeof payload.cwd === 'string' ? [payload.cwd] : roots
    if (supplied.length && !supplied.some((r: unknown) => typeof r === 'string' && path.isAbsolute(r) && canonicalRepo(r) === repo)) throw new Error('hook 仓库路径与源会话不匹配，未保存')
    const turns = readSession(found)
    if (!turns.length) throw new Error('会话暂无可读取消息，请在消息落盘后重试')
    const fingerprint = createHash('sha256').update(JSON.stringify({ turns, notes: readContext(repo), title: found.meta.title })).digest('hex')
    const key = createHash('sha256').update(`${repo}\n${exact}`).digest('hex')
    const state = loadState()
    const prior = state.saves[key]
    const result: HookResult = { at: Date.now(), agent, session: exact, repo, event, status: 'unchanged', file: prior?.file }
    if (!prior || prior.fingerprint !== fingerprint || !exists(prior.file)) {
      const saved = saveNote(found.meta, turns, '自动交接快照；不代表任务已完成或用户已授权。', repo)
      result.status = 'saved'
      result.file = saved.file
      state.saves[key] = { fingerprint, file: saved.file }
    }
    remember(state, result)
    return result
  })
}

/** Bound input size/time so a malformed integration cannot leave a waiting process. */
export function readHookInput(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    const timer = setTimeout(() => finish(new Error('等待 hook JSON 输入超时')), 5000)
    function finish(error?: Error) {
      clearTimeout(timer)
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
      process.stdin.pause()
      if (error) reject(error)
      else { try { resolve(JSON.parse(data)) } catch { reject(new Error('hook 输入不是有效 JSON')) } }
    }
    const onData = (chunk: string) => { data += chunk; if (Buffer.byteLength(data) > 1024 * 1024) finish(new Error('hook 输入超过 1 MiB')) }
    const onEnd = () => finish()
    const onError = (error: Error) => finish(error)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData).once('end', onEnd).once('error', onError)
    process.stdin.resume()
  })
}

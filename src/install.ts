import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { HOME, exists, isDir, readJsonFile, writeJsonFile } from './util'

/**
 * 把 MCP server + 规则块接进本机的各个 agent。
 *
 * 原则：
 *   - **默认只写用户级配置**；往仓库里写东西必须显式 `ass init <dir>`；
 *   - 每个文件在改动前先备份到 <文件>.bak-<时间戳>（写之前只做一次）；
 *   - 规则块用 marker 包起来，`ass uninstall` 能精确摘掉，不留垃圾。
 */

export const SERVER_NAME = 'agent-session-sync'
const MARK_START = `<!-- >>> ${SERVER_NAME}`
const MARK_END = `<!-- <<< ${SERVER_NAME} <<< -->`
const TS = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

let DRY = false
export function setDryRun(v: boolean): void {
  DRY = v
}
/** 统一写入口：dry-run 时只报告不落盘 */
function writeText(file: string, text: string, needBackup = true): void {
  if (DRY) return
  if (needBackup) backupOnce(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
function removeFile(file: string): void {
  if (DRY) return
  fs.rmSync(file, { force: true })
}

export interface Step {
  target: string
  path: string
  action: 'created' | 'updated' | 'appended' | 'unchanged' | 'removed' | 'skipped' | 'missing' | 'failed' | 'manual'
  detail?: string
}

// ---------------------------------------------------------------- 路径解析

/** 当前 CLI 的位置 → 同一份 dist 里的 mcp.js（无论全局装还是 npm link） */
export function mcpScript(): string {
  try {
    const self = fs.realpathSync(process.argv[1] ?? '')
    const candidate = path.join(path.dirname(self), 'mcp.js')
    if (exists(candidate)) return candidate
  } catch {
    /* 落到下面的兜底 */
  }
  const fallback = path.join(path.dirname(fs.realpathSync(process.argv[1] ?? process.execPath)), 'mcp.js')
  return fallback
}

/** agent 端启动 MCP 的命令 + 参数（用当前 node 的绝对路径，最稳） */
export function mcpEntry(): { command: string; args: string[] } {
  return { command: process.execPath, args: [mcpScript()] }
}

const CLAUDE_JSON = path.join(HOME, '.claude.json')
const CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md')
const CODEX_TOML = path.join(HOME, '.codex', 'config.toml')
const CODEX_MD = path.join(HOME, '.codex', 'AGENTS.md')
const OPENCODE_JSONC = path.join(HOME, '.config', 'opencode', 'opencode.jsonc')
const OPENCODE_MD = path.join(HOME, '.config', 'opencode', 'AGENTS.md')
const CURSOR_MCP = path.join(HOME, '.cursor', 'mcp.json')
const KIRO_MCP = path.join(HOME, '.kiro', 'settings', 'mcp.json')
const WINDSURF_MCP = path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json')
const TRAE_DIR = path.join(HOME, '.trae')

// ---------------------------------------------------------------- 文本块

function backupOnce(file: string): void {
  if (!exists(file)) return
  const bak = `${file}.bak-${TS()}`
  try {
    fs.copyFileSync(file, bak)
  } catch {
    /* 备份失败不阻塞主流程，但要能看到 */
  }
}

/** 插入/替换 marker 包起来的块（幂等；块不存在就追加） */
export function patchBlock(file: string, block: string, opts: { dryRun?: boolean; create?: boolean } = {}): Step {
  const had = exists(file)
  if (!had && opts.create === false) return { target: 'rules', path: file, action: 'skipped' }
  let text = had ? fs.readFileSync(file, 'utf8') : ''
  const start = text.indexOf(MARK_START)
  const end = text.indexOf(MARK_END)
  if (start >= 0 && end > start) {
    const next = `${text.slice(0, start)}${block}${text.slice(end + MARK_END.length)}`
    if (next === text) return { target: 'rules', path: file, action: 'unchanged' }
    writeText(file, next)
    return { target: 'rules', path: file, action: 'updated' }
  }
  const sep = text.trim() ? (text.endsWith('\n') ? '\n' : '\n\n') : ''
  writeText(file, `${text}${sep}${block}\n`)
  return { target: 'rules', path: file, action: had ? 'appended' : 'created' }
}

/** 摘掉 marker 块；文件除块外没内容就删掉整个文件 */
export function stripBlock(file: string, opts: { dryRun?: boolean } = {}): Step {
  if (!exists(file)) return { target: 'rules', path: file, action: 'skipped' }
  const text = fs.readFileSync(file, 'utf8')
  const start = text.indexOf(MARK_START)
  const end = text.indexOf(MARK_END)
  if (start < 0 || end < 0) return { target: 'rules', path: file, action: 'unchanged' }
  const next = `${text.slice(0, start)}${text.slice(end + MARK_END.length)}`.replace(/\n{3,}/g, '\n\n').trim()
  if (next === '') removeFile(file)
  else writeText(file, `${next}\n`)
  return { target: 'rules', path: file, action: 'removed' }
}

export function rulesBlock(): string {
  return `${MARK_START} (managed block · edits here are overwritten by \`ass install\`) >>> -->
## 跨 agent 会话同步（agent-session-sync）

这台机器上有多个编码 agent（Claude Code · Codex · Cursor · OpenCode 等）在共用同一批仓库。
它们的本地会话历史可以通过 \`ass\` / MCP 工具互相读取（**只读**，不会改动别的 agent 的数据）。

**什么时候用**：新会话开场、用户还没给出明确任务，或者用户提到「继续 / 接着上次 / 同步历史 /
换个模型 / 之前那个会话 / 上次说的 / handoff」，又或者用户描述的任务明显是在延续某个已有上下文
而你现在手上没有这些上下文时。

1. 先看本仓库有没有上次收尾留下的记录（MCP: \`session_status\`；命令行: \`ass\`）；
2. 需要更多历史时列出该仓库跨 agent 的最近会话（\`session_list\` / \`ass list\`），
   用「序号 · agent · 时间 · 标题 · 最近一句需求」列前 5 条，**问用户要同步哪一个**（不要自己替用户选）；
3. 用户选定后取交接摘要（\`session_handoff\` / \`ass show <引用>\`），用几句话复述
   「目标 / 已完成 / 待办 / 下一步」，等用户确认后再动手；
4. 要把某个 agent 刚问过的问题原样搬过来（含图片）：\`session_last\` / \`ass last <引用>\`。

**收尾时**（用户说「记一下 / 收尾 / 保存进度 / 下次继续 / wrap up」）：
保存一份交接摘要（\`session_note\` / \`ass note\`），下次任何 agent 一进这个仓库就能直接看到。

**约束**
- 默认只给摘要；用户明确要「完整历史 / 全文」时才读全文，且不要把整段原文贴进回复。
- 引用交接摘要里的结论时，要说明它来自「之前某个 agent 的会话」，不要当成你自己验证过的事实；
  涉及代码现状的结论，仍然要用当前代码去核实。
- 不要为了同步去修改其它 agent 的会话文件；本工具全程只读。
- 没有 MCP 工具时，退回命令行：\`ass\` / \`ass list\` / \`ass show "#3"\` / \`ass last "#3"\`。
${MARK_END}`
}

// ---------------------------------------------------------------- 各 agent 的 MCP 配置

function installClaude(): Step[] {
  const entry = { type: 'stdio', ...mcpEntry(), env: {} }
  const cfg = readJsonFile<Record<string, any>>(CLAUDE_JSON, {})
  cfg.mcpServers = cfg.mcpServers || {}
  const before = JSON.stringify(cfg.mcpServers[SERVER_NAME])
  cfg.mcpServers[SERVER_NAME] = entry
  if (before === JSON.stringify(entry)) return [{ target: 'claude', path: CLAUDE_JSON, action: 'unchanged' }]
  writeText(CLAUDE_JSON, `${JSON.stringify(cfg, null, 2)}\n`)
  return [{ target: 'claude', path: CLAUDE_JSON, action: 'updated', detail: 'mcpServers' }]
}

function uninstallClaude(): Step[] {
  const cfg = readJsonFile<Record<string, any>>(CLAUDE_JSON, {})
  if (!cfg.mcpServers?.[SERVER_NAME]) return [{ target: 'claude', path: CLAUDE_JSON, action: 'unchanged' }]
  delete cfg.mcpServers[SERVER_NAME]
  // 保留空的 mcpServers 对象：别的工具可能就认这个键，删掉反而容易出意外
  writeText(CLAUDE_JSON, `${JSON.stringify(cfg, null, 2)}\n`)
  return [{ target: 'claude', path: CLAUDE_JSON, action: 'removed', detail: 'mcpServers' }]
}

/** Codex 用 TOML：只做最小侵入的文本增删（不引 TOML 依赖） */
function installCodex(): Step[] {
  const e = mcpEntry()
  const block = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(e.command)}\nargs = [${e.args.map((a) => JSON.stringify(a)).join(', ')}]`
  if (!exists(CODEX_TOML)) return [{ target: 'codex', path: CODEX_TOML, action: 'missing' }]
  const text = fs.readFileSync(CODEX_TOML, 'utf8')
  const re = new RegExp(`\\n*\\[mcp_servers\\.${SERVER_NAME}\\][\\s\\S]*?(?=\\n\\[|$)`)
  const had = re.test(text)
  const next = had ? text.replace(re, `\n${block}`) : `${text.replace(/\s*$/, '')}\n\n${block}\n`
  if (next === text) return [{ target: 'codex', path: CODEX_TOML, action: 'unchanged' }]
  writeText(CODEX_TOML, next)
  return [{ target: 'codex', path: CODEX_TOML, action: had ? 'updated' : 'appended', detail: `[mcp_servers.${SERVER_NAME}]` }]
}

function uninstallCodex(): Step[] {
  if (!exists(CODEX_TOML)) return [{ target: 'codex', path: CODEX_TOML, action: 'missing' }]
  const text = fs.readFileSync(CODEX_TOML, 'utf8')
  const re = new RegExp(`\\n*\\[mcp_servers\\.${SERVER_NAME}\\][\\s\\S]*?(?=\\n\\[|$)`)
  if (!re.test(text)) return [{ target: 'codex', path: CODEX_TOML, action: 'unchanged' }]
  writeText(CODEX_TOML, text.replace(re, '\n').replace(/\n{3,}/g, '\n\n'))
  return [{ target: 'codex', path: CODEX_TOML, action: 'removed' }]
}

/** OpenCode 是 JSONC：先试着按 JSON 解析，不行就走文本插入 */
function installOpencode(): Step[] {
  if (!exists(OPENCODE_JSONC)) return [{ target: 'opencode', path: OPENCODE_JSONC, action: 'missing' }]
  const e = mcpEntry()
  const entry = { type: 'local', command: [e.command, ...e.args], enabled: true }
  let text = fs.readFileSync(OPENCODE_JSONC, 'utf8')
  if (new RegExp(`"${SERVER_NAME}"\\s*:`).test(text)) {
    return [{ target: 'opencode', path: OPENCODE_JSONC, action: 'unchanged' }]
  }
  const body = JSON.stringify(entry, null, 2).replace(/\n/g, '\n    ')
  if (!/"mcp"\s*:/.test(text)) {
    const i = text.indexOf('{')
    if (i < 0) return [{ target: 'opencode', path: OPENCODE_JSONC, action: 'failed' }]
    text = `${text.slice(0, i + 1)}\n  "mcp": {\n    "${SERVER_NAME}": ${body}\n  },${text.slice(i + 1)}`
  } else {
    const m = /"mcp"\s*:\s*\{/.exec(text)
    if (!m) return [{ target: 'opencode', path: OPENCODE_JSONC, action: 'failed' }]
    const at = m.index + m[0].length
    text = `${text.slice(0, at)}\n    "${SERVER_NAME}": ${body},${text.slice(at)}`
  }
  writeText(OPENCODE_JSONC, text)
  return [{ target: 'opencode', path: OPENCODE_JSONC, action: 'updated', detail: 'mcp' }]
}

function uninstallOpencode(): Step[] {
  if (!exists(OPENCODE_JSONC)) return [{ target: 'opencode', path: OPENCODE_JSONC, action: 'missing' }]
  const text = fs.readFileSync(OPENCODE_JSONC, 'utf8')
  const m = /"mcp"\s*:\s*\{/.exec(text)
  if (!m) return [{ target: 'opencode', path: OPENCODE_JSONC, action: 'unchanged' }]
  const open = m.index + m[0].length - 1
  // 配平花括号找到 mcp 对象结尾
  let depth = 0
  let end = -1
  let inStr = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return [{ target: 'opencode', path: OPENCODE_JSONC, action: 'failed' }]
  const inner = text.slice(open + 1, end)
  const empty = inner.replace(/[\s,]/g, '') === ''
  let next: string
  if (empty) {
    // 整个 mcp 对象都没用了 → 连同 key 一起摘掉
    let s = m.index
    while (s > 0 && /\s/.test(text[s - 1]!)) s--
    if (text[s - 1] === ',') s--
    let e2 = end + 1
    while (e2 < text.length && /\s/.test(text[e2]!)) e2++
    if (text[e2] === ',') e2++
    next = text.slice(0, s) + text.slice(e2)
  } else {
    const re = new RegExp(`\\n\\s*"${SERVER_NAME}"\\s*:[\\s\\S]*?\\n\\s*(?=}|,)`, '')
    next = text.slice(0, open + 1) + inner.replace(re, '') + text.slice(end)
  }
  writeText(OPENCODE_JSONC, next.replace(/\n{3,}/g, '\n\n'))
  return [{ target: 'opencode', path: OPENCODE_JSONC, action: 'removed' }]
}

function jsonMcpFile(file: string, target: string, install: boolean): Step {
  if (!exists(file)) return { target, path: file, action: 'missing' }
  const cfg = readJsonFile<Record<string, any>>(file, { mcpServers: {} })
  cfg.mcpServers = cfg.mcpServers || {}
  if (install) {
    const entry = { command: process.execPath, args: [mcpScript()] }
    if (JSON.stringify(cfg.mcpServers[SERVER_NAME]) === JSON.stringify(entry)) {
      return { target, path: file, action: 'unchanged' }
    }
    cfg.mcpServers[SERVER_NAME] = entry
  } else {
    if (!cfg.mcpServers[SERVER_NAME]) return { target, path: file, action: 'unchanged' }
    delete cfg.mcpServers[SERVER_NAME]
  }
  writeText(file, `${JSON.stringify(cfg, null, 2)}\n`)
  return { target, path: file, action: install ? 'updated' : 'removed', detail: 'mcpServers' }
}

// ---------------------------------------------------------------- 对外 API

export function installAll(opts: { dryRun?: boolean; only?: string } = {}): Step[] {
  setDryRun(Boolean(opts.dryRun))
  const steps: Step[] = []
  steps.push(...installClaude())
  steps.push(...installCodex())
  steps.push(...installOpencode())
  steps.push(jsonMcpFile(CURSOR_MCP, 'cursor', true))
  steps.push(jsonMcpFile(KIRO_MCP, 'kiro', true))
  steps.push(jsonMcpFile(WINDSURF_MCP, 'windsurf', true))
  steps.push({ target: 'trae', path: TRAE_DIR, action: exists(TRAE_DIR) ? 'manual' : 'skipped', detail: 'Trae 的 MCP 配置请在 IDE 里手工添加（见 README）' })

  const block = rulesBlock()
  steps.push(patchBlock(CLAUDE_MD, block))
  steps.push(patchBlock(CODEX_MD, block))
  steps.push(patchBlock(OPENCODE_MD, block))
  setDryRun(false)
  return steps
}

export function uninstallAll(opts: { dryRun?: boolean } = {}): Step[] {
  setDryRun(Boolean(opts.dryRun))
  const steps: Step[] = []
  steps.push(...uninstallClaude())
  steps.push(...uninstallCodex())
  steps.push(...uninstallOpencode())
  steps.push(jsonMcpFile(CURSOR_MCP, 'cursor', false))
  steps.push(jsonMcpFile(KIRO_MCP, 'kiro', false))
  steps.push(jsonMcpFile(WINDSURF_MCP, 'windsurf', false))
  for (const f of [CLAUDE_MD, CODEX_MD, OPENCODE_MD]) steps.push(stripBlock(f))
  setDryRun(false)
  return steps
}

/** 给仓库写项目级规则（显式调用才会执行；支持 --dry-run） */
export function initProject(dir: string, opts: { dryRun?: boolean } = {}): Step[] {
  setDryRun(Boolean(opts.dryRun))
  const steps: Step[] = []
  const block = rulesBlock()
  steps.push(patchBlock(path.join(dir, 'AGENTS.md'), block, opts))
  steps.push(patchBlock(path.join(dir, 'CLAUDE.md'), `${MARK_START} (managed block · edits here are overwritten by \`ass init\`) >>> -->\n@AGENTS.md\n${MARK_END}`, opts))
  const mdc = path.join(dir, '.cursor', 'rules', `${SERVER_NAME}.mdc`)
  const mdcBody = `---\ndescription: 跨 agent 会话同步 —— 换 agent / 开新会话时用 ass 或 MCP 读取其它 agent 的历史\nglobs:\nalwaysApply: false\n---\n\n${rulesBlock()}\n`
  if (fs.existsSync(mdc) && fs.readFileSync(mdc, 'utf8') === mdcBody) {
    steps.push({ target: 'rules', path: mdc, action: 'unchanged' })
  } else {
    writeText(mdc, mdcBody, false)
    steps.push({ target: 'rules', path: mdc, action: 'created' })
  }
  setDryRun(false)
  return steps
}

/** 项目级规则的反向操作 */
export function deinitProject(dir: string, opts: { dryRun?: boolean } = {}): Step[] {
  setDryRun(Boolean(opts.dryRun))
  const steps: Step[] = []
  steps.push(stripBlock(path.join(dir, 'AGENTS.md'), opts))
  steps.push(stripBlock(path.join(dir, 'CLAUDE.md'), opts))
  const mdc = path.join(dir, '.cursor', 'rules', `${SERVER_NAME}.mdc`)
  if (exists(mdc)) {
    removeFile(mdc)
    steps.push({ target: 'rules', path: mdc, action: 'removed' })
  }
  setDryRun(false)
  return steps
}

/** 各 agent 的检测结果，给 `ass install --dry-run` / doctor 用 */
export function detectAgents(): { id: string; label: string; config: string; exists: boolean; installed: boolean }[] {
  const claudeCfg = readJsonFile<Record<string, any>>(CLAUDE_JSON, {})
  const cursorCfg = readJsonFile<Record<string, any>>(CURSOR_MCP, { mcpServers: {} })
  const kiroCfg = readJsonFile<Record<string, any>>(KIRO_MCP, { mcpServers: {} })
  const codexText = exists(CODEX_TOML) ? fs.readFileSync(CODEX_TOML, 'utf8') : ''
  const ocText = exists(OPENCODE_JSONC) ? fs.readFileSync(OPENCODE_JSONC, 'utf8') : ''
  return [
    { id: 'claude', label: 'Claude Code', config: CLAUDE_JSON, exists: exists(CLAUDE_JSON), installed: Boolean(claudeCfg.mcpServers?.[SERVER_NAME]) },
    { id: 'codex', label: 'Codex', config: CODEX_TOML, exists: exists(CODEX_TOML), installed: codexText.includes(`[mcp_servers.${SERVER_NAME}]`) },
    { id: 'opencode', label: 'OpenCode', config: OPENCODE_JSONC, exists: exists(OPENCODE_JSONC), installed: new RegExp(`"${SERVER_NAME}"\\s*:`).test(ocText) },
    { id: 'cursor', label: 'Cursor', config: CURSOR_MCP, exists: exists(CURSOR_MCP), installed: Boolean(cursorCfg.mcpServers?.[SERVER_NAME]) },
    { id: 'kiro', label: 'Kiro', config: KIRO_MCP, exists: exists(KIRO_MCP), installed: Boolean(kiroCfg.mcpServers?.[SERVER_NAME]) },
    { id: 'windsurf', label: 'Windsurf', config: WINDSURF_MCP, exists: exists(WINDSURF_MCP), installed: exists(WINDSURF_MCP) },
    { id: 'trae', label: 'Trae', config: TRAE_DIR, exists: exists(TRAE_DIR), installed: false },
  ]
}

/** 自检：Node 版本、sqlite 能力、各 agent 数据源 */
export function doctor(): string[] {
  const lines: string[] = []
  const major = Number(process.versions.node.split('.')[0])
  const minor = Number(process.versions.node.split('.')[1])
  const hasNodeSqlite = major > 23 || (major === 23 ? minor >= 4 : major === 22 && minor >= 5)
  lines.push(`node              ${process.version}${hasNodeSqlite ? '（自带 node:sqlite）' : ''}`)
  let hasCli = false
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore', timeout: 4000 })
    hasCli = true
  } catch {
    hasCli = false
  }
  lines.push(`sqlite3 命令      ${hasCli ? '✓ 有' : '✗ 没有'}`)
  lines.push(`SQLite 读取       ${hasNodeSqlite || hasCli ? '✓ 可用（' + (hasNodeSqlite ? 'node:sqlite' : 'sqlite3 CLI') + '）' : '✗ 不可用：升级 Node 到 22.5+ 或安装 sqlite3'}`)
  lines.push(`MCP 入口          ${mcpScript()}`)
  lines.push(`CLI 入口          ${isDir(path.dirname(process.argv[1] ?? '')) ? process.argv[1] : '—'}`)
  return lines
}

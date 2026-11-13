import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runJson, runText } from './cli.mjs'
import { diskUsage } from './stats.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'agent-session-sync')
const CONFIG_PATH = path.join(os.homedir(), '.config', 'agent-session-sync', 'config.json')
const ALIAS_FILE = path.join(DATA_DIR, 'desktop-aliases.json')

/** 只影响桌面端显示名；不改目录名，也不写入任何 agent 数据。 */
function readAliases() {
  try {
    const j = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8'))
    return { projects: j.projects || {}, sessions: j.sessions || {} }
  } catch {
    return { projects: {}, sessions: {} }
  }
}

function writeAliases(a) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(ALIAS_FILE, JSON.stringify(a, null, 2) + '\n', 'utf8')
}

let win = null

// 扫描很贵（Cursor 库近 1GB，全量 30–40s）：缓存一段时间，用户点「刷新」才强制重扫
const cache = { agents: null, agentsAt: 0, repos: null, reposAt: 0, all: null, allAt: 0 }
const TTL = 60_000
// CLI 的 list/status 默认只返回 15 条；桌面端要全量，显式给一个大上限。
const ALL_LIMIT = '100000'

async function getAgents(force = false) {
  if (!force && cache.agents && Date.now() - cache.agentsAt < TTL) return cache.agents
  // --fast：可用性 + 数据源，不数会话。Cursor 建库扫描要 15s+，首屏不能等；
  // 会话数由 renderer 从 repos 的 byAgent 汇总补上。
  const agents = await runJson(['agents', '--json', '--fast'])
  cache.agents = agents
  cache.agentsAt = Date.now()
  return agents
}

async function getRepos(force = false) {
  if (!force && cache.repos && Date.now() - cache.reposAt < TTL) return cache.repos
  const repos = await runJson(['repos', '--json'])
  cache.repos = repos
  cache.reposAt = Date.now()
  if (force) cache.all = null
  return repos
}

/** 全量会话元数据（项目页用 repos 的 keys 精确过滤，保证和卡片计数一致） */
async function getAllSessions(force = false) {
  if (!force && cache.all && Date.now() - cache.allAt < TTL) return cache.all
  const all = await runJson(['list', '--all', '--json', '--limit', ALL_LIMIT])
  cache.all = all
  cache.allAt = Date.now()
  return all
}

function createWindow() {
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#070b14',
    title: 'Agent Session Sync',
    // macOS：把红绿灯嵌进侧栏；Windows/Linux：用系统标题栏
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
      : { autoHideMenuBar: true }),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.loadFile(path.join(here, '..', 'ui', 'index.html'))
  win.on('closed', () => (win = null))
  // 调试截图在后台窗口上会取到旧帧，关掉节流
  win.webContents.setBackgroundThrottling(false)

  if (!app.isPackaged) {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`))
    win.webContents.on('preload-error', (_e, p, error) => console.error(`[preload] ${p}: ${error}`))
    win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer gone]', details))
  }

  // 开发期截图（只在本机调试用）：ASS_SCREENSHOT=/tmp/x.png electron .
  if (process.env.ASS_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.env.ASS_SCREENSHOT_TAB) {
            const clicked = await win.webContents.executeJavaScript(
              `(() => { const b = document.querySelector('[data-tab="${process.env.ASS_SCREENSHOT_TAB}"]'); if (!b) return 'no-button'; b.click(); return document.querySelector('.topbar-title')?.textContent || 'no-title' })()`,
            )
            console.log(`[screenshot] tab=${process.env.ASS_SCREENSHOT_TAB} → ${clicked}`)
            await new Promise((r) => setTimeout(r, 800))
          }
          if (process.env.ASS_SCREENSHOT_REPO) {
            await win.webContents.executeJavaScript(
              `(() => { const i = document.getElementById('repo-input'); i.value = ${JSON.stringify(process.env.ASS_SCREENSHOT_REPO)}; document.getElementById('btn-load').click() })()`,
            )
            await new Promise((r) => setTimeout(r, 4000))
          }
          if (process.env.ASS_SCREENSHOT_CLICK) {
            const sel = process.env.ASS_SCREENSHOT_CLICK
            const r = await win.webContents.executeJavaScript(
              `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return 'no-match'; b.click(); return 'clicked' })()`,
            )
            console.log(`[screenshot] click ${sel} → ${r}`)
            await new Promise((r) => setTimeout(r, Number(process.env.ASS_SCREENSHOT_CLICK_DELAY || 2500)))
          }
          if (process.env.ASS_SCREENSHOT_EVAL) {
            const r = await win.webContents.executeJavaScript(process.env.ASS_SCREENSHOT_EVAL)
            console.log(`[screenshot] eval → ${JSON.stringify(r)}`)
          }
          await new Promise((r) => setTimeout(r, 400))
          fs.writeFileSync(process.env.ASS_SCREENSHOT, (await win.webContents.capturePage()).toPNG())
        } finally {
          app.quit()
        }
      }, Number(process.env.ASS_SCREENSHOT_DELAY || 12_000)).unref()
    })
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  if (!isMac) {
    // Windows/Linux：不塞 mac 专属 role，避免菜单无效项
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: '文件', submenu: [{ role: 'quit' }] },
        { role: 'editMenu' },
        {
          label: '视图',
          submenu: [
            { role: 'reload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
      ]),
    )
    return
  }
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─────────────────────────────── IPC

ipcMain.handle('ass:boot', async () => {
  const agents = await getAgents(true)
  return {
    agents,
    appVersion: app.getVersion(),
    dataDir: DATA_DIR,
    configPath: CONFIG_PATH,
  }
})

ipcMain.handle('ass:repos', async (_e, { force } = {}) => {
  const repos = await getRepos(Boolean(force))
  // 后台预热全量会话，第一次点项目时就不用再等一次扫描
  getAllSessions(false).catch(() => {})
  return repos
})

ipcMain.handle('ass:disk', async (_e, { force } = {}) => {
  const agents = await getAgents(Boolean(force))
  return diskUsage(agents)
})

ipcMain.handle('ass:project', async (_e, { repo }) => {
  // status 给任务/笔记/恢复命令；会话列表以 repos 卡片同一份 keys 为准，
  // 避免「全部项目 31 个、进来只有 9 个」这种两套过滤口径不一致。
  const [status, context, repos, all] = await Promise.all([
    runJson(['status', '--json', '--repo', repo, '--limit', ALL_LIMIT]),
    runJson(['context', '--json', '--repo', repo]),
    getRepos(false),
    getAllSessions(false),
  ])
  const row = (repos || []).find((r) => r.repo === repo)
  let sessions = status.sessions
  if (row?.keys?.length) {
    const keys = new Set(row.keys)
    const picked = (all || []).filter((s) => keys.has(s.key))
    if (picked.length) sessions = picked
  }
  return { ...status, sessions, context, indexCount: row?.sessions ?? sessions.length }
})

ipcMain.handle('ass:sessions', async (_e, { repo, all, limit }) => {
  const args = ['list', '--json']
  if (all) args.push('--all')
  else args.push('--repo', repo)
  if (limit) args.push('--limit', String(limit))
  return runJson(args, { cwd: repo })
})

ipcMain.handle('ass:tasks', async (_e, { repo, all }) => {
  const args = ['tasks', '--json']
  if (all) args.push('--all')
  return runJson(args, { cwd: repo })
})

ipcMain.handle('ass:taskView', async (_e, { repo, name }) => {
  return runJson(['resume', name, '--json'], { cwd: repo })
})

ipcMain.handle('ass:sessionDetail', async (_e, { repo, key }) => {
  // show --json --full：用户 + 助手全部消息（GUI 自己按模式过滤）
  const shown = await runJson(['show', key, '--json', '--full'], { cwd: repo })
  return { meta: shown?.meta || null, turns: shown?.turns || [] }
})

ipcMain.handle('ass:brief', async (_e, { repo, ref }) => {
  return runText(['brief', ...(ref ? [ref] : [])], { cwd: repo })
})

ipcMain.handle('ass:search', async (_e, { q, repo }) => {
  const args = ['search', q, '--json']
  if (repo) args.push('--repo', repo)
  else args.push('--all')
  return runJson(args, { cwd: repo || process.cwd() })
})

// ── 写操作（渲染层先弹确认，这里只执行）
ipcMain.handle('ass:ctxAdd', async (_e, { repo, kind, text }) => {
  const flag = { decision: '--decision', 'dead-end': '--dead-end', constraint: '--constraint', todo: '--todo', note: '--note' }[kind]
  if (!flag) throw new Error(`未知类型：${kind}`)
  return runJson(['context', '--json', '--repo', repo, flag, text])
})

ipcMain.handle('ass:ctxDone', async (_e, { repo, id }) => {
  return runJson(['context', '--json', '--repo', repo, '--done', id])
})

ipcMain.handle('ass:taskNew', async (_e, { repo, name, goal }) => {
  const args = ['task', 'new', name, '--json']
  if (goal) args.push('--goal', goal)
  return runJson(args, { cwd: repo })
})

ipcMain.handle('ass:taskAdd', async (_e, { repo, name, ref, label, note }) => {
  const args = ['task', 'add', name, '--json']
  if (ref) args.push(ref)
  if (label) args.push('--label', label)
  if (note) args.push('--note', note)
  return runJson(args, { cwd: repo })
})

ipcMain.handle('ass:note', async (_e, { repo, ref, summary }) => {
  const args = ['note', ...(ref ? [ref] : []), '--repo', repo]
  if (summary) args.push('--summary', summary)
  return runText(args, { cwd: repo })
})

ipcMain.handle('ass:pickDirectory', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择项目目录',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择',
  })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('ass:openDataDir', async () => {
  await shell.openPath(DATA_DIR)
})

ipcMain.handle('ass:reveal', async (_e, { path: p }) => {
  if (p) shell.showItemInFolder(p)
})

ipcMain.handle('ass:copy', async (_e, { text }) => {
  clipboard.writeText(String(text ?? ''))
})

ipcMain.handle('ass:aliases', async () => readAliases())

ipcMain.handle('ass:configGet', async () => {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return {
      agents: raw.agents || {},
      only: raw.only,
      customAgents: Array.isArray(raw.customAgents) ? raw.customAgents : [],
      defaultLimit: raw.defaultLimit,
    }
  } catch {
    return { agents: {}, customAgents: [], defaultLimit: 15 }
  }
})

ipcMain.handle('ass:configSaveCustomAgents', async (_e, { customAgents }) => {
  if (!Array.isArray(customAgents)) throw new Error('customAgents 必须是数组')
  for (const a of customAgents) {
    if (!a || typeof a !== 'object') throw new Error('无效的 customAgent 项')
    if (!a.id || typeof a.id !== 'string') throw new Error('每项必须有 id')
    if (!['jsonl', 'json', 'sqlite'].includes(a.type)) throw new Error(`id=${a.id} 的 type 无效`)
    if (!a.path || typeof a.path !== 'string') throw new Error(`id=${a.id} 缺少 path`)
  }
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    raw = { agents: { claude: true, codex: true, opencode: true, cursor: true }, defaultLimit: 15 }
  }
  const next = { ...raw, customAgents }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  // 配置变了，清掉 agent 缓存，下次刷新会重新探测
  cache.agents = null
  cache.agentsAt = 0
  cache.repos = null
  cache.reposAt = 0
  cache.all = null
  cache.allAt = 0
  return { ok: true, count: customAgents.length }
})

ipcMain.handle('ass:aliasSet', async (_e, { kind, key, name }) => {
  if (kind !== 'project' && kind !== 'session') throw new Error(`未知别名类型：${kind}`)
  if (!key) throw new Error('缺少别名 key')
  const a = readAliases()
  const map = kind === 'project' ? a.projects : a.sessions
  const text = String(name || '').trim()
  if (text) map[key] = text
  else delete map[key]
  writeAliases(a)
  return a
})

// ─────────────────────────────── 清理（只删文件型会话，移到废纸篓）

function pathInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function sizeOf(p) {
  try {
    const st = fs.lstatSync(p)
    if (st.isFile()) return st.size
    if (!st.isDirectory()) return 0
    let n = 0
    for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e))
    return n
  } catch {
    return 0
  }
}

/**
 * 只有“一文件/一目录 = 一个会话”的来源才允许在这里清理。
 * shared SQLite（Cursor/OpenCode/Trae/灵码/Qoder 桌面库）一律拒绝：
 * 逐条删要改别人的数据库，违背只读边界，也容易弄坏它。
 */
function cleanupTarget(meta, agents) {
  const sources = (agents.find((a) => a.id === meta.agent)?.sources || []).filter(Boolean)
  const inside = (p) => sources.some((root) => pathInside(root, p))
  const src = String(meta.source || '')

  // Kiro 新会话：source 是 messages.jsonl，整个 session 目录才是一条会话
  if (meta.extra?.variant === 'session' && typeof meta.extra.dir === 'string') {
    const dir = meta.extra.dir
    return inside(dir) ? { path: dir, kind: 'dir' } : { reason: '不在该 agent 的数据源目录内' }
  }

  // DSH：source 是 session.vN.jsonl[.zstd]，同目录还可能有旧代际文件
  if (meta.agent === 'dsh' && /session\.v\d+\.jsonl(\.zstd)?$/.test(src)) {
    const dir = path.dirname(src)
    return inside(dir) ? { path: dir, kind: 'dir' } : { reason: '不在 DSH sessions 目录内' }
  }

  if (/\.vscdb$|\.db$|\.sqlite$|\.sqlite3$/i.test(src)) {
    return { reason: '共享 SQLite 数据库，请在对应 agent 内清理；本工具不写入源数据' }
  }

  const isJsonl = /\.jsonl(\.zstd)?$/i.test(src)
  const isJson = /\.json$/i.test(src)
  if (isJson && /(?:^|[\\/])(sessions|index|sessions-index)\.json$/i.test(src)) {
    return { reason: '这是索引文件，不是单条会话' }
  }
  if (!isJsonl && !isJson) return { reason: '该来源不支持逐条清理' }
  if (!inside(src)) return { reason: '不在该 agent 的数据源目录内' }
  return { path: src, kind: 'file' }
}

async function listCleanup(agentId) {
  if (!agentId) throw new Error('缺少 agent id')
  const agents = await getAgents(false)
  const rows = await runJson(['list', '--all', '--json', '--agent', agentId, '--limit', ALL_LIMIT])
  return (Array.isArray(rows) ? rows : []).map((s) => {
    const t = cleanupTarget(s, agents)
    return {
      key: s.key,
      title: s.title,
      agent: s.agent,
      updatedAt: s.updatedAt,
      source: s.source,
      path: t.path || null,
      kind: t.kind || null,
      deletable: Boolean(t.path),
      reason: t.reason || null,
      size: t.path ? sizeOf(t.path) : 0,
    }
  })
}

ipcMain.handle('ass:cleanupList', async (_e, { agent }) => listCleanup(agent))

ipcMain.handle('ass:cleanupOne', async (_e, { key }) => {
  const agent = String(key || '').split(':')[0]
  const rows = await listCleanup(agent)
  const hit = rows.find((r) => r.key === key)
  if (!hit) throw new Error(`没找到会话：${key}`)
  if (!hit.deletable) throw new Error(hit.reason || '该会话不支持清理')
  await shell.trashItem(hit.path)
  cache.repos = null
  cache.reposAt = 0
  cache.all = null
  cache.allAt = 0
  return { key, path: hit.path, size: hit.size }
})

ipcMain.handle('ass:cleanupAll', async (_e, { agent }) => {
  const rows = await listCleanup(agent)
  const targets = new Map()
  for (const r of rows) if (r.deletable && r.path) targets.set(r.path, r)
  let removed = 0
  let bytes = 0
  const errors = []
  for (const [p, r] of targets) {
    try {
      await shell.trashItem(p)
      removed++
      bytes += r.size
    } catch (e) {
      errors.push(`${r.key}: ${e.message}`)
    }
  }
  cache.repos = null
  cache.reposAt = 0
  cache.all = null
  cache.allAt = 0
  return { removed, bytes, errors, skipped: rows.length - targets.size }
})

ipcMain.handle('ass:saveText', async (_e, { name, text }) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出',
    defaultPath: path.join(app.getPath('downloads'), name || 'export.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  if (r.canceled || !r.filePath) return null
  fs.writeFileSync(r.filePath, String(text ?? ''), 'utf8')
  return r.filePath
})

// ─────────────────────────────── lifecycle

app.whenReady().then(() => {
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

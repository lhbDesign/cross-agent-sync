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

let win = null

// 扫描很贵（Cursor 库近 1GB，全量 30–40s）：缓存一段时间，用户点「刷新」才强制重扫
const cache = { agents: null, agentsAt: 0, repos: null, reposAt: 0 }
const TTL = 60_000

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
  return repos
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

ipcMain.handle('ass:repos', async (_e, { force } = {}) => getRepos(Boolean(force)))

ipcMain.handle('ass:disk', async (_e, { force } = {}) => {
  const agents = await getAgents(Boolean(force))
  return diskUsage(agents)
})

ipcMain.handle('ass:project', async (_e, { repo }) => {
  // status 给会话/任务/交接记录，context 给完整的笔记条目（决策/坑/待办）
  const [status, context] = await Promise.all([
    runJson(['status', '--json', '--repo', repo, '--limit', '200']),
    runJson(['context', '--json', '--repo', repo]),
  ])
  return { ...status, context }
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

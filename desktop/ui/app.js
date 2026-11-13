/* Agent Session Sync — 渲染层
 * 只通过 preload 暴露的 window.ass 调主进程；不碰 Node / fs。
 */
'use strict'

const el = (id) => document.getElementById(id)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const api = window.ass

// 平台差异交给 CSS（macOS 要把侧栏顶部让给红绿灯；Windows 用系统标题栏）
document.body.dataset.platform = api?.platform || 'unknown'

const state = {
  boot: null,
  agents: [],
  disk: [],
  repos: [],
  repo: null,
  project: null,
  selectedKey: null,
  repoFilter: '',
  agentFilter: null,
  aliases: { projects: {}, sessions: {} },
  cleanupAgent: null,
  cleanupSessions: [],
}

// ─────────────────────────────── 小工具

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—')

function humanSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const basename = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || String(p || '')

/** 路径里可能带 %20 这类转义，展示时还原；还原失败就用原样 */
function prettyName(p) {
  const b = basename(p)
  try {
    return decodeURIComponent(b)
  } catch {
    return b
  }
}

/** 桌面端显示名：优先用本应用里设置的名字，其次才是路径/原生标题 */
function projectLabel(repo) {
  return state.aliases.projects?.[repo] || prettyName(repo)
}

function sessionLabel(s) {
  return state.aliases.sessions?.[s?.key] || s?.title || '(无标题)'
}

let toastTimer = 0
function toast(msg, isErr = false) {
  const t = el('toast')
  t.textContent = msg
  t.classList.toggle('err', isErr)
  t.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 5000 : 2600)
}

let loadingDepth = 0
function showLoading(text) {
  loadingDepth++
  el('loading-text').textContent = text
  el('loading').classList.remove('hidden')
}
/** 只换文案，不改深度（同一段扫描里切换阶段用） */
function setLoadingText(text) {
  el('loading-text').textContent = text
}
function hideLoading() {
  loadingDepth = Math.max(0, loadingDepth - 1)
  if (!loadingDepth) el('loading').classList.add('hidden')
}
async function withLoading(text, fn) {
  showLoading(text)
  try {
    return await fn()
  } finally {
    hideLoading()
  }
}

async function guard(fn, errPrefix = '') {
  try {
    return await fn()
  } catch (e) {
    console.error(`[guard] ${errPrefix}${e?.stack || e}`)
    toast(`${errPrefix}${e?.message || e}`, true)
  }
}

window.addEventListener('error', (e) => console.error('[window error]', e.message, e.filename, e.lineno))
window.addEventListener('unhandledrejection', (e) => console.error('[unhandled]', e.reason?.stack || e.reason))

// ─────────────────────────────── 弹窗

let modalCleanup = null

/**
 * 通用确认 / 表单弹窗。
 * fields: [{ name, label, type: 'text'|'textarea'|'select', value, placeholder, readonly, options }]
 * extraActions: [{ label, onClick(values) }]，放在「取消 / 确定」左边。
 */
function openModal({ title, desc = '', fields = [], okText = '确定', onSubmit, extraActions = [] }) {
  return new Promise((resolve) => {
    el('modal-title').textContent = title
    el('modal-desc').textContent = desc

    const box = el('modal-fields')
    box.innerHTML = ''
    const inputs = {}

    for (const f of fields) {
      const wrap = document.createElement('div')
      wrap.className = 'field'
      const label = document.createElement('label')
      label.textContent = f.label
      wrap.appendChild(label)

      let input
      if (f.type === 'textarea') {
        input = document.createElement('textarea')
        if (f.rows) input.style.minHeight = `${f.rows * 20}px`
      } else if (f.type === 'select') {
        input = document.createElement('select')
        for (const o of f.options || []) {
          const op = document.createElement('option')
          op.value = o.value
          op.textContent = o.label
          input.appendChild(op)
        }
      } else {
        input = document.createElement('input')
        input.type = 'text'
        if (f.placeholder) input.placeholder = f.placeholder
      }
      input.value = f.value ?? ''
      input.readOnly = Boolean(f.readonly)
      input.dataset.name = f.name
      wrap.appendChild(input)
      box.appendChild(wrap)
      inputs[f.name] = input
    }

    const values = () => {
      const v = {}
      for (const k of Object.keys(inputs)) v[k] = inputs[k].value
      return v
    }

    // extraActions 按钮
    const actions = el('modal-actions')
    const oldExtra = $$('.modal-extra', actions)
    for (const b of oldExtra) b.remove()
    for (const extra of extraActions) {
      const btn = document.createElement('button')
      btn.className = 'btn modal-extra'
      btn.textContent = extra.label
      btn.addEventListener('click', () => guard(async () => extra.onClick(values())))
      actions.insertBefore(btn, el('modal-cancel'))
    }

    el('modal-ok').textContent = okText

    const close = (result = null) => {
      el('modal-mask').classList.add('hidden')
      el('modal-ok').onclick = null
      el('modal-cancel').onclick = null
      el('modal-mask').onclick = null
      document.removeEventListener('keydown', onKey)
      if (modalCleanup) modalCleanup()
      modalCleanup = null
      resolve(result)
    }

    const onKey = (e) => {
      if (e.key === 'Escape') close(null)
    }

    el('modal-cancel').onclick = () => close(null)
    el('modal-ok').onclick = () =>
      guard(async () => {
        const v = values()
        if (onSubmit) await onSubmit(v)
        close(v)
      })
    el('modal-mask').onclick = (e) => {
      if (e.target === el('modal-mask')) close(null)
    }
    document.addEventListener('keydown', onKey)

    el('modal-mask').classList.remove('hidden')
    const first = fields[0] ? inputs[fields[0].name] : el('modal-ok')
    setTimeout(() => first?.focus?.(), 30)
  })
}

// ─────────────────────────────── 抽屉

function openDrawer(title, sub, bodyHtml) {
  el('drawer-title').textContent = title
  el('drawer-sub').textContent = sub
  el('drawer-toolbar').classList.add('hidden')
  el('drawer-toolbar').innerHTML = ''
  el('drawer-body').innerHTML = bodyHtml
  el('drawer').classList.remove('hidden')
  el('drawer-mask').classList.remove('hidden')
}

function closeDrawer() {
  el('drawer').classList.add('hidden')
  el('drawer-mask').classList.add('hidden')
  el('drawer-toolbar').classList.add('hidden')
  el('drawer-toolbar').innerHTML = ''
}

// ─────────────────────────────── 导航

const TAB_TITLES = { overview: '概览', project: '项目', all: '全部项目', cleanup: '清理', settings: '设置' }

function switchTab(tab) {
  if (!TAB_TITLES[tab]) return
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`))
  el('view-title').textContent = TAB_TITLES[tab]
  if (tab === 'all' && !state.repos.length) guard(() => loadRepos(true).then(renderAll))
  if (tab === 'cleanup') {
    renderCleanupAgents()
    if (state.cleanupAgent) guard(() => loadCleanup(state.cleanupAgent))
  }
}

// ─────────────────────────────── 启动

async function boot() {
  // repos 独立跑（17s+），和 agents 并行，别串行等
  const reposPromise = api.repos(false)

  showLoading('读取 agent 数据…')
  try {
    state.boot = await api.boot()
    state.agents = state.boot?.agents || []
    try {
      state.aliases = await api.aliases()
    } catch { /* 别名读不到不影响主流程 */ }
    renderSettings()
    renderOverview()
  } catch (e) {
    toast(`读取失败：${e.message}`, true)
  } finally {
    hideLoading()
  }

  // 磁盘占用走本地文件遍历，和 repos 并行
  guard(async () => {
    state.disk = await api.disk(false)
    renderOverview()
  }, '磁盘扫描失败：')

  guard(async () => {
    el('side-status').textContent = '正在扫描所有项目…'
    state.repos = await reposPromise
    el('side-status').textContent = `${state.repos.length} 个项目 · 已就绪`
    renderAll()
    renderOverview()
  }, '项目列表加载失败：')
}

async function loadRepos(force) {
  el('side-status').textContent = '正在扫描所有项目…'
  state.repos = await api.repos(Boolean(force))
  el('side-status').textContent = `${state.repos.length} 个项目 · 已就绪`
  return state.repos
}

async function refreshAll(force = true) {
  await guard(async () => {
    showLoading('刷新 agent 数据…')
    try {
      state.boot = await api.boot()
      state.agents = state.boot?.agents || []
      renderAgentsTable()
      renderSettings()

      setLoadingText('重新扫描磁盘…')
      state.disk = await api.disk(force)
      renderOverview()

      setLoadingText('重新扫描项目…')
      await loadRepos(force)
      renderAll()
      if (state.repo && state.tab === 'project') await loadProject(state.repo)
      toast('已刷新')
    } finally {
      hideLoading()
    }
  }, '刷新失败：')
}

// ─────────────────────────────── 概览

function kpi(label, value, sub = '') {
  return `<div class="kpi"><div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}</div>`
}

function barChart(rows) {
  if (!rows.length) return '<div class="muted">暂无数据</div>'
  const max = Math.max(...rows.map((r) => r.value), 1)
  return rows
    .map(
      (r) => `<div class="bar-row">
        <div class="bar-name" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (r.value / max) * 100).toFixed(1)}%"></div></div>
        <div class="bar-val">${esc(r.text)}</div>
      </div>`,
    )
    .join('')
}

function agentSessionCount(id) {
  if (state.repos.length) {
    return state.repos.reduce((n, r) => n + ((r.byAgent && r.byAgent[id]) || 0), 0)
  }
  const a = state.agents.find((x) => x.id === id)
  return a && a.counted ? a.found : null
}

function renderOverview() {
  const agents = state.agents
  const available = agents.filter((a) => a.available)
  const sessions = state.repos.reduce((n, r) => n + (r.sessions || 0), 0)
  const diskTotal = state.disk.reduce((n, d) => n + (d.bytes || 0), 0)
  const reposReady = state.repos.length > 0

  el('kpis').innerHTML = [
    kpi('可用 Agent', `${available.length}<span class="muted"> / ${agents.length}</span>`, '检测到的数据源'),
    kpi('本机会话', reposReady ? num(sessions) : '…', reposReady ? `来自 ${state.repos.length} 个项目` : '正在扫描…'),
    kpi('项目', reposReady ? num(state.repos.length) : '…', '有 agent 会话的目录'),
    kpi('占用磁盘', state.disk.length ? humanSize(diskTotal) : '…', '仅 agent 会话数据'),
  ].join('')

  el('agents-hint').textContent = `${available.length} 个可读`

  const diskById = new Map(state.disk.map((d) => [d.id, d]))
  renderAgentsTable(diskById)
  renderOverviewCharts()
  renderCleanupAgents()
}

function renderAgentsTable(diskById = new Map(state.disk.map((d) => [d.id, d]))) {
  const box = el('agent-table')
  if (!state.agents.length) {
    box.innerHTML = '<div class="muted">没有检测到任何 agent。</div>'
    return
  }
  const head = `<div class="row head"><span>Agent</span><span>会话</span><span>磁盘</span><span>状态</span><span>数据路径</span></div>`
  const rows = state.agents.map((a) => {
    const d = diskById.get(a.id)
    const count = a.available ? agentSessionCount(a.id) : 0
    const status = a.error
      ? `<span class="badge warn" title="${esc(a.error)}">读取失败</span>`
      : !a.available
        ? '<span class="badge off">未安装 / 无数据</span>'
        : a.installed
          ? '<span class="badge ok">可用 · MCP 已接入</span>'
          : '<span class="badge ok">可用</span>'
    const paths = (a.sources || []).map((p) => esc(p))
    const pathText = paths.length ? paths.join('<br>') : '<span class="muted">—</span>'
    return `<div class="row">
      <span class="cell"><strong>${esc(a.label)}</strong> <span class="muted">${esc(a.id)}</span></span>
      <span class="cell num">${count === null ? '…' : num(count)}</span>
      <span class="cell num">${d ? humanSize(d.bytes) : '…'}</span>
      <span class="cell">${status}</span>
      <span class="cell mono" title="${esc((a.sources || []).join('\n'))}">${pathText}</span>
    </div>`
  })
  box.innerHTML = head + rows.join('')
}

function renderOverviewCharts() {
  // 右侧磁盘占用按大小降序；左侧会话数分布跟同一 agent 顺序，左右对称
  const diskSorted = state.disk
    .filter((d) => d.bytes > 0)
    .slice()
    .sort((a, b) => b.bytes - a.bytes)

  const diskRows = diskSorted.map((d) => ({ name: d.label, value: d.bytes, text: humanSize(d.bytes) }))
  el('chart-disk').innerHTML = barChart(diskRows)

  const countById = new Map(state.agents.map((a) => [a.id, agentSessionCount(a.id)]))
  const sessionRows = diskSorted
    .map((d) => {
      const value = countById.get(d.id)
      return { name: d.label, value: typeof value === 'number' ? value : 0, text: num(value) }
    })
    .filter((r) => r.value > 0)
  // 磁盘有、会话数为 0 的已滤掉；若还有可用但磁盘未统计到的 agent，接到末尾
  const seen = new Set(diskSorted.map((d) => d.id))
  for (const a of state.agents) {
    if (!a.available || seen.has(a.id)) continue
    const value = agentSessionCount(a.id)
    if (!(value > 0)) continue
    sessionRows.push({ name: a.label, value, text: num(value) })
  }
  el('chart-sessions').innerHTML = barChart(sessionRows)
}

// ─────────────────────────────── 全部项目

function repoMatches(r) {
  const q = state.repoFilter.trim().toLowerCase()
  if (q) {
    const hay = `${r.repo} ${basename(r.repo)}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  if (state.agentFilter && !(r.agents || []).includes(state.agentFilter)) return false
  return true
}

function renderAll() {
  // 过滤 chips：只列出实际出现在项目里的 agent
  const present = new Set(state.repos.flatMap((r) => r.agents || []))
  const chipData = [
    { id: null, label: '全部' },
    ...[...present].sort().map((id) => ({ id, label: state.agents.find((a) => a.id === id)?.label || id })),
  ]
  el('agent-chips').innerHTML = chipData
    .map(
      (c) =>
        `<button class="chip${state.agentFilter === c.id ? ' active' : ''}" data-agent="${c.id === null ? '' : esc(c.id)}">${esc(c.label)}</button>`,
    )
    .join('')

  const list = state.repos.filter(repoMatches)
  el('repos-empty').classList.toggle('hidden', list.length > 0)
  el('repos-grid').innerHTML = list
    .map(
      (r) => `<div class="repo-card" data-repo="${esc(r.repo)}">
        <div class="repo-top">
          <div class="repo-name" title="${esc(r.repo)}">${esc(projectLabel(r.repo))}</div>
          <button class="btn ghost icon repo-edit" data-edit-repo="${esc(r.repo)}" title="重命名显示名">✎</button>
        </div>
        <div class="repo-path" title="${esc(r.repo)}">${esc(r.repo)}</div>
        <div class="repo-meta">
          <span class="repo-count">${num(r.sessions)} 个会话</span>
          <div class="repo-agents">${(r.agents || [])
            .map((a) => `<span class="badge">${esc(state.agents.find((x) => x.id === a)?.label || a)}</span>`)
            .join('')}</div>
        </div>
      </div>`,
    )
    .join('')
}

// ─────────────────────────────── 项目

async function loadProject(repo) {
  const dir = String(repo || '').trim()
  if (!dir) return toast('先选一个项目目录', true)
  state.repo = dir
  el('repo-input').value = dir
  await guard(async () => {
    showLoading('读取项目数据…')
    try {
      state.project = await api.project(dir)
      state.selectedKey = null
      renderProject()
      document.querySelector('.content').scrollTop = 0
    } finally {
      hideLoading()
    }
  }, '加载项目失败：')
}

function openTodoCount(entries) {
  return entries.filter((e) => e.kind === 'todo' && !e.done && !e.cancelled && !e.supersededBy).length
}

function renderProject() {
  const p = state.project
  if (!p) return
  el('project-empty').classList.add('hidden')
  el('project-body').classList.remove('hidden')

  const entries = p.context?.entries || []
  const decisions = entries.filter((e) => e.kind === 'decision' && !e.supersededBy)
  el('project-kpis').innerHTML = [
    kpi('会话', num(p.sessions.length), p.truncated ? '已截断，调大上限看全部' : `${p.tasks.length} 个任务`),
    kpi('任务', num(p.tasks.length), '跨 agent 的工作'),
    kpi('决策', num(decisions.length), '已记录的判断'),
    kpi('待办', num(openTodoCount(entries)), '未勾选'),
  ].join('')

  renderSessions()
  renderTasks()
  renderNotes()
}

function sessionsOf() {
  return state.project?.sessions || []
}

function renderSessions() {
  const list = sessionsOf()
  el('sessions-count').textContent = list.length ? `显示 ${list.length} 个` : ''
  const box = el('sessions-table')
  if (!list.length) {
    box.innerHTML = '<div class="muted">这个项目还没有可读取的会话。</div>'
    return
  }
  const head = `<div class="row head"><span>Agent</span><span>标题</span><span>最近一句</span><span>轮数</span><span>更新</span></div>`
  box.innerHTML =
    head +
    list
      .map(
        (s) => `<div class="row${state.selectedKey === s.key ? ' selected' : ''}" data-key="${esc(s.key)}">
          <span class="cell"><span class="badge">${esc(s.agentLabel || s.agent)}</span></span>
          <span class="cell title-cell" title="${esc(s.title)}">
            <span class="title-text">${esc(sessionLabel(s))}</span>
            <button class="btn ghost icon row-edit" data-rename-session="${esc(s.key)}" title="重命名显示名">✎</button>
          </span>
          <span class="cell preview-cell" title="${esc(s.preview)}">${esc(s.preview || '—')}</span>
          <span class="cell num">${num(s.turns)}</span>
          <span class="cell mono">${esc(fmtTime(s.updatedAt))}</span>
        </div>`,
      )
      .join('')
}

function taskChainOf(t) {
  const out = []
  for (const s of t.sessions || []) {
    const a = s.agent || ''
    if (out[out.length - 1] !== a) out.push(a)
  }
  return out.join(' → ')
}

function renderTasks() {
  const list = state.project?.tasks || []
  const box = el('tasks-list')
  if (!list.length) {
    box.innerHTML = '<div class="muted">这个项目还没有任务。点「新建任务」把多个会话绑成一件事。</div>'
    return
  }
  box.innerHTML = list
    .map(
      (t) => `<div class="task" data-task="${esc(t.name)}">
        <div class="task-head">
          <span class="task-name">${esc(t.name)}</span>
          <span class="badge ${t.status === 'done' ? 'off' : 'ok'}">${t.status === 'done' ? '已完成' : '进行中'}</span>
        </div>
        <div class="task-meta">${esc(t.id)} · ${(t.sessions || []).length} 段 · ${esc(taskChainOf(t))}</div>
      </div>`,
    )
    .join('')
}

const NOTE_GROUPS = [
  ['decision', '决策', ''],
  ['dead-end', '踩坑记录', 'neg'],
  ['constraint', '约束', 'warn'],
  ['todo', '待办', ''],
  ['note', '进展 / 备注', ''],
  ['suggestion', '建议 / 待确认', 'warn'],
]

function renderNotes() {
  const entries = state.project?.context?.entries || []
  const box = el('notes-list')
  if (!entries.length) {
    box.innerHTML = '<div class="muted">这个项目还没有项目笔记。agent 干活时可以顺手记，你也可以点「记录一条」。</div>'
    return
  }
  const parts = []
  for (const [kind, label, tone] of NOTE_GROUPS) {
    const group = entries.filter((e) => e.kind === kind && !e.cancelled && !e.supersededBy)
    if (!group.length) continue
    parts.push(`<div class="note-group-title">${esc(label)} · ${group.length}</div>`)
    for (const e of group) {
      const done = e.kind === 'todo' && e.done
      const sub = [e.id, fmtTime(e.at), e.source, e.session].filter(Boolean).join(' · ')
      const toggle =
        e.kind === 'todo' && !e.done
          ? `<button class="btn small" data-done="${esc(e.id)}">标记完成</button>`
          : ''
      parts.push(`<div class="note-item ${tone}${done ? ' note-done' : ''}">
        <span class="note-id">${esc(e.id)}</span>
        <div style="flex:1;min-width:0">
          <div class="note-text">${esc(e.text)}</div>
          <div class="note-sub">${esc(sub)}${e.supersedes ? ` · 替代 ${esc(e.supersedes)}` : ''}</div>
        </div>
        ${toggle}
      </div>`)
    }
  }
  box.innerHTML = parts.join('')
}

// ─────────────────────────────── 会话详情

function sessionByKey(key) {
  return sessionsOf().find((s) => s.key === key)
}

/** 智能体回答的「摘要」：折叠代码块与空白，截到一段可读的长度 */
function summarize(text, max = 280) {
  const t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [代码块] ')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length <= max) return t
  return `${t.slice(0, max).replace(/[\s，,。.;；:：、\-]+$/, '')}…`
}

/** 工具名（含 UI 里常见的 ▸ Bash: / ▶ Read: 前缀） */
const TOOL_NAME_RE =
  /(?:Bash|Shell|Read|Edit|Write|Search|Grep|Glob|WebFetch|WebSearch|CallMcpTool|Await|TodoWrite|StrReplace|Delete|NotebookEdit|Task|Agent|Skill)/i
const TOOL_LINE_RE = new RegExp(
  `^[\\s]*[▸►▶•·▪▫＊*\\-–—]?\\s*${TOOL_NAME_RE.source}(?:\\s*[:：]\\s*|\\b)`,
  'i',
)

/** 纯工具 / 思考轮：不在「智能体回答」里展示 */
function isToolOrThinkingTurn(text) {
  const t = String(text || '').trim()
  if (!t) return false
  // ▸ Bash: sed ... / Bash: ... / ▶ Read path
  if (TOOL_LINE_RE.test(t)) return true
  if (/^(Thought|Thinking|思考过程|推理|Running|执行工具)\b/i.test(t)) return true
  if (/^<(thinking|think|reasoning|tool_call|tool_use)\b/i.test(t)) return true
  // 整段几乎只有工具调用块
  const withoutTools = t
    .replace(/```[\s\S]*?```/g, '')
    .replace(new RegExp(`^[\\s]*[▸►▶•·▪▫＊*\\-–—]?\\s*${TOOL_NAME_RE.source}\\s*[:：]?.*$`, 'gim'), '')
    .trim()
  return withoutTools.length < 12 && t.length > 20
}

/** 从助手全文里抽出结论：去掉思考标签、工具过程，优先取「结果/结论」段 */
function extractConclusion(text) {
  let t = String(text || '')
  t = t
    .replace(/<(thinking|think|reasoning|tool_call|tool_use)[\s\S]*?<\/\1>/gi, '')
    .replace(/```(?:thinking|thought|reasoning)[\s\S]*?```/gi, '')
    .replace(/^\s*(Thought|Thinking|思考过程|推理)[:：]?\s*[\s\S]*?(?=\n#{1,3}\s|\n##\s*结果|\n##\s*结论|\n(?=[^\s]))/gim, '')
  // 连续的工具行（含 ▸ Bash:）
  t = t.replace(new RegExp(`^[\\s]*[▸►▶•·▪▫＊*\\-–—]?\\s*${TOOL_NAME_RE.source}\\s*[:：]?.*$`, 'gim'), '')
  const resultMatch = t.match(/(?:^|\n)#{1,3}\s*(结果|结论|回答|最终|Final|Result)\s*\n([\s\S]+)$/i)
  if (resultMatch) t = resultMatch[2]
  t = t.replace(/\n{3,}/g, '\n\n').trim()
  // 抽完若只剩空白，视为无结论（调用方会显示「无文字」）；不要退回整段工具原文
  return t
}

const drawerState = { key: null, turns: [], mode: 'user', sub: 'summary', query: '', collapsed: new Set() }

const TURN_FILTERS = {
  user: (t) => t.role === 'user',
  all: (t) => t.role === 'user' || (t.role === 'assistant' && !isToolOrThinkingTurn(t.text)),
  assistant: (t) => t.role === 'assistant' && !isToolOrThinkingTurn(t.text),
}

function drawerCounts() {
  const users = drawerState.turns.filter((t) => t.role === 'user')
  const assistants = drawerState.turns.filter((t) => t.role === 'assistant' && !isToolOrThinkingTurn(t.text))
  return {
    user: users.length,
    assistant: assistants.length,
    all: users.length + assistants.length,
  }
}

function assistantIds() {
  return drawerState.turns.filter((t) => t.role === 'assistant' && !isToolOrThinkingTurn(t.text)).map((t) => t._id)
}

/** 折叠到约两行：按行数截，或单段长文按字数截 */
function firstLines(text, lines = 2) {
  const raw = String(text || '')
  const parts = raw.split(/\n/).map((x) => x.trimEnd()).filter((x) => x.trim())
  if (parts.length > lines) return `${parts.slice(0, lines).join('\n')}…`
  const maxChars = lines * 72
  if (raw.length > maxChars) {
    const cut = raw.slice(0, maxChars)
    return `${cut.replace(/\s+\S*$/, '').trimEnd() || cut.trimEnd()}…`
  }
  return raw
}

/** 在已转义文本上高亮搜索词（先匹配原文再分段转义） */
function highlightText(text, query) {
  const raw = String(text ?? '')
  const q = String(query || '').trim()
  if (!q) return esc(raw)
  const lower = raw.toLowerCase()
  const needle = q.toLowerCase()
  let out = ''
  let i = 0
  while (i < raw.length) {
    const j = lower.indexOf(needle, i)
    if (j < 0) {
      out += esc(raw.slice(i))
      break
    }
    out += esc(raw.slice(i, j))
    out += `<mark class="hl">${esc(raw.slice(j, j + needle.length))}</mark>`
    i = j + needle.length
  }
  return out
}

function displayAssistantText(text, summary) {
  const conclusion = extractConclusion(text)
  return summary ? summarize(conclusion) : conclusion
}

function renderDrawerTurnList() {
  const counts = drawerCounts()
  const isAssistant = drawerState.mode === 'assistant'
  const summary = isAssistant && drawerState.sub === 'summary'

  $$('#drawer-toolbar [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === drawerState.mode))
  $$('#drawer-toolbar [data-sub]').forEach((b) => b.classList.toggle('active', b.dataset.sub === drawerState.sub))
  el('drawer-sub-seg')?.classList.toggle('hidden', !isAssistant)

  const q = drawerState.query.trim()
  const qLower = q.toLowerCase()
  const base = drawerState.turns
    .filter(TURN_FILTERS[drawerState.mode])
    .filter((t) => t.text || t.images || (t.files && t.files.length))
  const matched = base.filter((t) => {
    if (!qLower) return true
    const hay = t.role === 'assistant' ? displayAssistantText(t.text, false) : String(t.text || '')
    return hay.toLowerCase().includes(qLower)
  })
  // 最近的在最上面；没有时间的排到最后
  const sorted = [...matched].sort((a, b) => (b.at || 0) - (a.at || 0))

  const note = el('drawer-note')
  if (note) {
    const baseText = {
      user: `用户提问 ${counts.user} 条 · 原样展示，不摘要、不截断`,
      all: `用户 ${counts.user} 条 + 智能体 ${counts.assistant} 条 · 智能体仅结论`,
      assistant: `智能体回答 ${counts.assistant} 条 · ${summary ? '摘要' : '结论全文'}（已隐藏思考/工具过程）`,
    }[drawerState.mode]
    note.innerHTML = q ? `${esc(baseText)} · 匹配 ${matched.length} / ${base.length}` : esc(baseText)
  }

  const ids = assistantIds().filter((id) => {
    const t = drawerState.turns.find((x) => x._id === id)
    const src = displayAssistantText(t?.text, summary)
    return String(src || '').length > 120 || String(src || '').split('\n').filter(Boolean).length > 2
  })
  const allCollapsed = ids.length > 0 && ids.every((id) => drawerState.collapsed.has(id))
  const collapseAll = el('drawer-collapse-all')
  if (collapseAll) {
    collapseAll.textContent = allCollapsed ? '全部展开' : '全部折叠'
    collapseAll.classList.toggle('hidden', drawerState.mode === 'user')
    collapseAll.disabled = !ids.length
  }

  const html = sorted.map((t) => {
    const isUser = t.role === 'user'
    const sourceText = isUser ? t.text || '' : displayAssistantText(t.text, summary)
    const canCollapse = !isUser && (String(sourceText).length > 120 || String(sourceText).split('\n').filter(Boolean).length > 2)
    const collapsed = canCollapse && drawerState.collapsed.has(t._id)
    const body = collapsed ? firstLines(sourceText, 2) : sourceText
    const imgs = t.images ? `<div class="turn-img">附件：${t.images} 张图片</div>` : ''
    const files = (t.files || []).map((f) => `<div class="turn-img">文件：${esc(f)}</div>`).join('')
    return `<div class="turn ${isUser ? 'user' : 'assistant'}${collapsed ? ' collapsed' : ''}">
      <div class="turn-head">
        <div class="turn-role">${isUser ? '用户' : '智能体'} · ${esc(fmtTime(t.at))}</div>
        ${canCollapse ? `<button class="btn small turn-toggle" data-toggle-turn="${esc(t._id)}">${collapsed ? '展开' : '折叠'}</button>` : ''}
      </div>
      <div class="turn-text${summary ? ' turn-summary' : ''}">${highlightText(body || '（无文字内容）', q)}</div>
      ${imgs}${files}
    </div>`
  })

  const box = el('drawer-turns')
  if (box) {
    box.innerHTML = html.length
      ? html.join('')
      : `<div class="empty"><p>${q ? '没有匹配的内容。' : drawerState.mode === 'user' ? '没有可读取的用户输入。' : drawerState.mode === 'assistant' ? '没有可读取的智能体回答。' : '没有可读取的对话内容。'}</p></div>`
  }
}

function renderDrawerContent() {
  const counts = drawerCounts()
  const toolbar = el('drawer-toolbar')
  toolbar.classList.remove('hidden')
  toolbar.innerHTML = `
      <div class="seg">
        <button class="seg-btn" data-mode="user">用户输入<span class="seg-count">${counts.user}</span></button>
        <button class="seg-btn" data-mode="all">全部信息<span class="seg-count">${counts.all}</span></button>
        <button class="seg-btn" data-mode="assistant">智能体回答<span class="seg-count">${counts.assistant}</span></button>
      </div>
      <div class="seg sub hidden" id="drawer-sub-seg">
        <button class="seg-btn" data-sub="summary">摘要</button>
        <button class="seg-btn" data-sub="full">全文</button>
      </div>
      <div class="drawer-search">
        <input id="drawer-search" class="input" placeholder="搜索当前标签页的内容…" spellcheck="false" />
        <button class="btn small" id="drawer-collapse-all">全部折叠</button>
      </div>`
  el('drawer-body').innerHTML = `
    <div class="drawer-note muted" id="drawer-note"></div>
    <div id="drawer-turns"></div>`
  el('drawer-search').value = drawerState.query
  el('drawer-search').addEventListener('input', (e) => {
    drawerState.query = e.target.value
    renderDrawerTurnList()
  })
  // 助手默认折叠到两行，点展开再看全文
  for (const id of assistantIds()) drawerState.collapsed.add(id)
  renderDrawerTurnList()
}

async function openSession(key) {
  const s = sessionByKey(key)
  state.selectedKey = key
  drawerState.key = key
  drawerState.turns = []
  drawerState.mode = 'user'
  drawerState.sub = 'summary'
  drawerState.query = ''
  drawerState.collapsed = new Set()
  renderSessions()
  openDrawer(sessionLabel(s) || '会话', `${s?.agentLabel || ''} · ${key}`, '<div class="empty"><p>读取会话内容…</p></div>')
  await guard(async () => {
    const d = await api.sessionDetail(state.repo, key)
    drawerState.turns = (d?.turns || []).map((t, i) => ({ ...t, _id: `${key}:${i}` }))
    renderDrawerContent()
    el('drawer-body').scrollTop = 0
  })
}

async function openTask(name) {
  const t = (state.project?.tasks || []).find((x) => x.name === name)
  openDrawer(t?.name || name, `任务 · ${t?.id || ''}`, '<div class="muted">读取任务总览…</div>')
  await guard(async () => {
    const v = await api.taskView(state.repo, name)
    const html = []
    html.push(`<p class="prose muted">${esc(v.id)} · ${esc(v.status === 'done' ? '已完成' : '进行中')} · ${esc(v.chain.join(' → '))} · ${v.sessions} 段</p>`)
    if (v.goal?.text) {
      html.push(`<div class="panel" style="margin-bottom:14px"><div class="panel-head"><h2>原始目标</h2></div><div class="prose">${esc(v.goal.text)}</div></div>`)
    }
    html.push(`<div class="note-group-title">各段进展</div>`)
    for (const seg of v.segments || []) {
      html.push(`<div class="turn user">
        <div class="turn-role">${esc(seg.agentLabel || seg.agent)} · 第 ${esc(seg.ref)}</div>
        <div class="turn-text">${esc(seg.label || '(未标注)')}\n${esc(seg.note || seg.fallback || '')}</div>
      </div>`)
    }
    if ((v.decisions || []).length) {
      html.push(`<div class="note-group-title">决策 · ${v.decisions.length}</div>`)
      for (const d of v.decisions) html.push(`<div class="note-item"><span class="note-id">${esc(d.id)}</span><div class="note-text">${esc(d.text)}</div></div>`)
    }
    if ((v.todos || []).length) {
      html.push(`<div class="note-group-title">待办 · ${v.todos.length}</div>`)
      for (const d of v.todos) {
        html.push(`<div class="note-item${d.done ? ' note-done' : ''}"><span class="note-id">${esc(d.id)}</span><div class="note-text">${esc(d.text)}</div></div>`)
      }
    }
    el('drawer-body').innerHTML = html.join('')
  })
}

// ─────────────────────────────── 项目操作

function activeKey() {
  return state.selectedKey || sessionsOf()[0]?.key || null
}

function requireProject() {
  if (!state.project) {
    toast('先选择一个项目', true)
    return false
  }
  return true
}

async function actBrief() {
  if (!requireProject()) return
  const key = activeKey()
  if (!key) return toast('这个项目还没有会话', true)
  const md = await withLoading('生成交接摘要…', () => api.brief(state.repo, key))
  await openModal({
    title: '交接摘要',
    desc: `来源会话 ${key} · 可直接粘贴给别的 agent`,
    fields: [{ name: 'md', label: 'Markdown', type: 'textarea', value: md, readonly: true, rows: 16 }],
    okText: '复制',
    extraActions: [
      {
        label: '导出 .md',
        onClick: async (v) => {
          const p = await api.saveText(`brief-${key.replace(/[:/]/g, '-')}.md`, v.md)
          if (p) toast(`已导出：${p}`)
        },
      },
    ],
    onSubmit: async (v) => {
      await api.copy(v.md)
      toast('已复制到剪贴板')
    },
  })
}

async function actInputs() {
  if (!requireProject()) return
  const key = activeKey()
  if (!key) return toast('这个项目还没有会话', true)
  await openSession(key)
}

async function actResume() {
  if (!requireProject()) return
  const key = activeKey()
  if (!key) return toast('这个项目还没有会话', true)
  const cmd = state.project.resume?.[key]
  if (!cmd) return toast('这个 agent 没有一键恢复命令，改用「生成交接摘要」', true)
  await api.copy(cmd)
  toast(`已复制：${cmd}`)
}

async function actNote() {
  if (!requireProject()) return
  const key = activeKey()
  const label = key ? `来源会话 ${key}` : '没有指定会话'
  await openModal({
    title: '保存交接记录',
    desc: `写入本工具自己的数据目录（不改 agent 会话文件）。${label}`,
    fields: [{ name: 'summary', label: '补充说明（可选）', type: 'textarea', placeholder: '当前卡在 X，下一步做 Y' }],
    okText: '保存',
    onSubmit: async (v) => {
      await withLoading('保存交接记录…', () => api.note(state.repo, key, v.summary))
      toast('已保存交接记录')
      await loadProject(state.repo)
    },
  })
}

async function actAddNote() {
  if (!requireProject()) return
  await openModal({
    title: '记录一条项目笔记',
    desc: `写入项目笔记：${state.repo}`,
    fields: [
      {
        name: 'kind',
        label: '类型',
        type: 'select',
        value: 'decision',
        options: [
          { value: 'decision', label: '决策（为什么这么选）' },
          { value: 'dead-end', label: '踩坑记录（这条路走不通）' },
          { value: 'constraint', label: '约束（不能碰的东西）' },
          { value: 'todo', label: '待办（还剩什么没做）' },
          { value: 'note', label: '进展 / 备注' },
        ],
      },
      { name: 'text', label: '内容', type: 'textarea', placeholder: '一句话说清结论和理由' },
    ],
    okText: '记录',
    onSubmit: async (v) => {
      if (!v.text.trim()) throw new Error('内容不能为空')
      await withLoading('写入笔记…', () => api.ctxAdd(state.repo, v.kind, v.text.trim()))
      toast('已记录')
      await loadProject(state.repo)
    },
  })
}

async function actDone(id) {
  const entry = (state.project?.context?.entries || []).find((e) => e.id === id)
  await openModal({
    title: `标记完成 ${id}`,
    desc: `写入项目笔记：${state.repo}\n${entry?.text || ''}`,
    okText: '标记完成',
    onSubmit: async () => {
      await withLoading('更新笔记…', () => api.ctxDone(state.repo, id))
      toast(`已标记 ${id} 完成`)
      await loadProject(state.repo)
    },
  })
}

async function actNewTask() {
  if (!requireProject()) return
  await openModal({
    title: '新建任务',
    desc: `任务名由你定；写入工具自己的任务索引。`,
    fields: [
      { name: 'name', label: '任务名', placeholder: '例如：退款流程改造' },
      { name: 'goal', label: '原始目标（可选）', type: 'textarea', placeholder: '一句话说明这件事的目标' },
    ],
    okText: '新建',
    onSubmit: async (v) => {
      const name = v.name.trim()
      if (!name) throw new Error('任务名不能为空')
      await withLoading('新建任务…', () => api.taskNew(state.repo, name, v.goal.trim() || undefined))
      toast(`已新建任务：${name}`)
      await loadProject(state.repo)
    },
  })
}

/** 项目/会话的“重命名”只是本应用的显示名，不改目录、也不写 agent 数据。 */
async function renameProject(repo) {
  if (!repo) return
  const current = state.aliases.projects?.[repo] || ''
  await openModal({
    title: '重命名项目（显示名）',
    desc: '只影响本应用的显示，不改目录名，也不写入任何 agent 数据。留空恢复默认。',
    fields: [{ name: 'name', label: '显示名', value: current, placeholder: prettyName(repo) }],
    okText: '保存',
    onSubmit: async (v) => {
      const name = v.name.trim()
      state.aliases = await api.aliasSet('project', repo, name)
      renderAll()
      if (state.repo === repo) renderProject()
      toast(name ? '已更新项目显示名' : '已恢复项目默认名')
    },
  })
}

async function renameSession(key) {
  const s = sessionsOf().find((x) => x.key === key)
  if (!s) return
  const current = state.aliases.sessions?.[s.key] || ''
  await openModal({
    title: '重命名会话（显示名）',
    desc: '只影响本应用的显示，不改 agent 自己的会话标题。留空恢复默认。',
    fields: [{ name: 'name', label: '显示名', value: current, placeholder: s.title }],
    okText: '保存',
    onSubmit: async (v) => {
      const name = v.name.trim()
      state.aliases = await api.aliasSet('session', s.key, name)
      renderSessions()
      if (drawerState.key === s.key) el('drawer-title').textContent = sessionLabel(s)
      toast(name ? '已更新会话显示名' : '已恢复会话默认名')
    },
  })
}

// ─────────────────────────────── 清理

function agentLabelOf(id) {
  return state.agents.find((a) => a.id === id)?.label || id
}

function renderCleanupAgents() {
  const agents = state.agents.filter((a) => a.available)
  el('cleanup-hint').textContent = agents.length ? `${agents.length} 个可用 agent` : '没有可用的 agent'
  el('cleanup-agents').innerHTML = agents
    .map(
      (a) =>
        `<button class="chip${state.cleanupAgent === a.id ? ' active' : ''}" data-clean-agent="${esc(a.id)}">${esc(a.label)}</button>`,
    )
    .join('')
  if (!state.cleanupAgent) {
    el('cleanup-list-title').textContent = '会话'
    el('cleanup-list').innerHTML = '<div class="muted">先选择上面的 Agent。</div>'
    el('btn-cleanup-all').disabled = true
  }
}

async function loadCleanup(agentId) {
  state.cleanupAgent = agentId
  renderCleanupAgents()
  state.cleanupSessions = await withLoading('读取可清理会话…', () => api.cleanupList(agentId))
  renderCleanupList()
}

function renderCleanupList() {
  const list = state.cleanupSessions || []
  const del = list.filter((x) => x.deletable)
  const total = del.reduce((n, x) => n + (x.size || 0), 0)
  el('cleanup-list-title').textContent = state.cleanupAgent
    ? `${agentLabelOf(state.cleanupAgent)} 的会话 · ${list.length}`
    : '会话'
  const btn = el('btn-cleanup-all')
  btn.disabled = !del.length
  btn.textContent = del.length ? `全部清理（${del.length}）` : '全部清理'

  const box = el('cleanup-list')
  if (!state.cleanupAgent) {
    box.innerHTML = '<div class="muted">先选择上面的 Agent。</div>'
    return
  }
  if (!list.length) {
    box.innerHTML = '<div class="empty"><p>这个 agent 没有可读取的会话。</p></div>'
    return
  }
  box.innerHTML =
    `<div class="cleanup-summary">可清理 ${del.length} 条 · 共 ${humanSize(total)}${list.length > del.length ? ` · ${list.length - del.length} 条不支持逐条清理` : ''}</div>` +
    list
      .map(
        (r) => `<div class="cleanup-row">
          <div class="cleanup-main">
            <div class="cleanup-title">${esc(r.title || r.key)}</div>
            <div class="cleanup-sub">${esc(r.key)} · ${esc(fmtTime(r.updatedAt))} · ${humanSize(r.size)}${r.deletable ? '' : ` · ${esc(r.reason || '不支持')}`}</div>
          </div>
          <button class="btn small${r.deletable ? ' danger' : ''}" data-clean-key="${esc(r.key)}" ${r.deletable ? '' : 'disabled'}>
            ${r.deletable ? '清理' : '不支持'}
          </button>
        </div>`,
      )
      .join('')
}

async function afterCleanup() {
  await guard(async () => {
    state.cleanupSessions = await api.cleanupList(state.cleanupAgent)
    renderCleanupList()
  }, '刷新清理列表失败：')
  guard(async () => {
    state.repos = await api.repos(true)
    renderAll()
    if (state.repo) await loadProject(state.repo)
  }, '刷新项目失败：')
  guard(async () => {
    state.disk = await api.disk(true)
    renderOverview()
  }, '刷新磁盘统计失败：')
}

async function cleanupOne(key) {
  const row = state.cleanupSessions.find((x) => x.key === key)
  if (!row?.deletable) return
  await openModal({
    title: '清理这条会话？',
    desc: `将移到系统废纸篓 / 回收站（可恢复）：\n${row.title || row.key}\n${row.path}`,
    okText: '移到废纸篓',
    onSubmit: async () => {
      await withLoading('正在移到废纸篓…', () => api.cleanupOne(key))
      toast('已移到废纸篓')
      await afterCleanup()
    },
  })
}

async function cleanupAll() {
  const del = state.cleanupSessions.filter((x) => x.deletable)
  if (!del.length) return
  const total = del.reduce((n, x) => n + (x.size || 0), 0)
  await openModal({
    title: `清理 ${agentLabelOf(state.cleanupAgent)} 的全部可清理会话？`,
    desc: `共 ${del.length} 条 · ${humanSize(total)}。全部移到系统废纸篓 / 回收站（可恢复）。\n\n共享 SQLite 数据库里的会话不会被动。`,
    okText: '全部移到废纸篓',
    onSubmit: async () => {
      const r = await withLoading('正在清理…', () => api.cleanupAll(state.cleanupAgent))
      toast(r.errors?.length ? `清理 ${r.removed} 条，${r.errors.length} 条失败` : `已清理 ${r.removed} 条`, Boolean(r.errors?.length))
      await afterCleanup()
    },
  })
}



// ─────────────────────────────── 设置

function renderSettings() {
  const b = state.boot || {}
  const fill = (id, rows) => {
    el(id).innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || '—')}</dd>`).join('')
  }
  fill('settings-paths', [
    ['数据目录', b.dataDir],
    ['配置文件', b.configPath],
  ])
  const v = api?.versions || {}
  fill('settings-versions', [
    ['应用版本', b.appVersion],
    ['Electron', v.electron],
    ['Node', v.node],
    ['Chromium', v.chrome],
    ['平台', api?.platform],
  ])
  guard(() => renderCustomAgents())
}

async function renderCustomAgents() {
  const box = el('custom-agents-list')
  if (!box) return
  const cfg = await api.configGet()
  const list = cfg?.customAgents || []
  if (!list.length) {
    box.innerHTML = '<div class="muted">还没有扩展 Agent。点右上角「添加」配置一个非内置数据源。</div>'
    return
  }
  box.innerHTML = list
    .map(
      (a, i) => `<div class="custom-agent-row" data-custom-idx="${i}">
      <div class="meta">
        <strong>${esc(a.label || a.id)} <span class="muted">${esc(a.id)}</span></strong>
        <div class="path">${esc(a.type)} · ${esc(a.path || '—')}</div>
      </div>
      <div class="acts">
        <button class="btn small" data-custom-edit="${i}">编辑</button>
        <button class="btn small danger" data-custom-del="${i}">删除</button>
      </div>
    </div>`,
    )
    .join('')
}

function parseMapJson(raw) {
  const t = String(raw || '').trim()
  if (!t) return undefined
  const obj = JSON.parse(t)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('map 必须是 JSON 对象')
  return obj
}

function parseRoleMap(raw) {
  const t = String(raw || '').trim()
  if (!t) return undefined
  const obj = JSON.parse(t)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('roleMap 必须是 JSON 对象')
  return obj
}

async function editCustomAgent(existing = null, index = -1) {
  const isEdit = index >= 0 && existing
  const values = await openModal({
    title: isEdit ? '编辑扩展 Agent' : '添加扩展 Agent',
    desc: '配置会写入 ~/.config/agent-session-sync/config.json 的 customAgents，与 CLI 共用。保存后点顶部「刷新」重新扫描。',
    okText: '保存',
    fields: [
      { name: 'id', label: 'ID（英文，唯一）', value: existing?.id || '', placeholder: 'my-agent' },
      { name: 'label', label: '显示名', value: existing?.label || '', placeholder: 'My Agent' },
      {
        name: 'type',
        label: '类型',
        type: 'select',
        value: existing?.type || 'jsonl',
        options: [
          { value: 'jsonl', label: 'jsonl（一行一条）' },
          { value: 'json', label: 'json（一个文件一个会话）' },
          { value: 'sqlite', label: 'sqlite' },
        ],
      },
      { name: 'path', label: '数据路径', value: existing?.path || '', placeholder: '~/.my-agent/sessions' },
      {
        name: 'map',
        label: '字段映射 map（JSON）',
        type: 'textarea',
        rows: 6,
        value: existing?.map ? JSON.stringify(existing.map, null, 2) : '{\n  "id": "id",\n  "cwd": "cwd",\n  "title": "title",\n  "role": "role",\n  "text": "text",\n  "timestamp": "timestamp"\n}',
      },
      {
        name: 'records',
        label: 'records（仅 json：消息数组字段）',
        value: existing?.records || '',
        placeholder: 'history',
      },
      {
        name: 'query',
        label: 'query（仅 sqlite）',
        type: 'textarea',
        rows: 3,
        value: existing?.query || '',
        placeholder: 'select id, cwd, title, role, text, timestamp from messages order by timestamp',
      },
      {
        name: 'roleMap',
        label: 'roleMap（可选 JSON）',
        type: 'textarea',
        rows: 2,
        value: existing?.roleMap ? JSON.stringify(existing.roleMap, null, 2) : '',
        placeholder: '{ "gemini": "assistant" }',
      },
      { name: 'hint', label: '备注 hint（可选）', value: existing?.hint || '' },
    ],
    onSubmit: async (v) => {
      const id = String(v.id || '').trim()
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) throw new Error('ID 需以字母开头，只含字母数字_-')
      const pathVal = String(v.path || '').trim()
      if (!pathVal) throw new Error('请填写数据路径')
      const type = v.type
      const agent = {
        id,
        label: String(v.label || '').trim() || id,
        type,
        path: pathVal,
      }
      const map = parseMapJson(v.map)
      if (map) agent.map = map
      const records = String(v.records || '').trim()
      if (records) agent.records = records
      const query = String(v.query || '').trim()
      if (query) agent.query = query
      if (type === 'sqlite' && !query) throw new Error('sqlite 类型必须填写 query')
      const roleMap = parseRoleMap(v.roleMap)
      if (roleMap) agent.roleMap = roleMap
      const hint = String(v.hint || '').trim()
      if (hint) agent.hint = hint

      const cfg = await api.configGet()
      const list = [...(cfg.customAgents || [])]
      if (isEdit) list[index] = agent
      else {
        if (list.some((x) => x.id === id)) throw new Error(`已存在 id=${id}`)
        list.push(agent)
      }
      await api.configSaveCustomAgents(list)
      toast(isEdit ? '已更新扩展 Agent' : '已添加扩展 Agent')
      await renderCustomAgents()
    },
  })
  return values
}

// ─────────────────────────────── 事件绑定

function bind() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)))
  el('btn-refresh').addEventListener('click', () => refreshAll(true))

  el('btn-pick').addEventListener('click', () =>
    guard(async () => {
      const dir = await api.pickDirectory()
      if (dir) {
        el('repo-input').value = dir
        await loadProject(dir)
      }
    }),
  )
  el('btn-load').addEventListener('click', () => loadProject(el('repo-input').value))
  el('btn-rename-project').addEventListener('click', () => guard(() => renameProject(state.repo || el('repo-input').value)))
  el('repo-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadProject(el('repo-input').value)
  })

  el('btn-task-new').addEventListener('click', actNewTask)
  el('btn-note-add').addEventListener('click', actAddNote)

  el('cleanup-agents').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-clean-agent]')
    if (chip) guard(() => loadCleanup(chip.dataset.cleanAgent))
  })
  el('cleanup-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clean-key]')
    if (btn) guard(() => cleanupOne(btn.dataset.cleanKey))
  })
  el('btn-cleanup-all').addEventListener('click', () => guard(cleanupAll))

  $$('.actions [data-act]').forEach((btn) =>
    btn.addEventListener('click', () =>
      guard(async () => {
        const act = btn.dataset.act
        if (act === 'brief') return actBrief()
        if (act === 'inputs') return actInputs()
        if (act === 'resume') return actResume()
        if (act === 'note') return actNote()
        if (act === 'reveal') {
          if (state.repo) api.reveal(state.repo)
          return
        }
        if (act === 'open-data') return api.openDataDir()
      }),
    ),
  )

  // 事件委托：会话行 / 任务卡 / 笔记完成 / 项目卡 / agent chips
  el('sessions-table').addEventListener('click', (e) => {
    const rename = e.target.closest('[data-rename-session]')
    if (rename) {
      e.stopPropagation()
      guard(() => renameSession(rename.dataset.renameSession))
      return
    }
    const row = e.target.closest('[data-key]')
    if (row) guard(() => openSession(row.dataset.key))
  })
  el('tasks-list').addEventListener('click', (e) => {
    const card = e.target.closest('[data-task]')
    if (card) guard(() => openTask(card.dataset.task))
  })
  el('notes-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-done]')
    if (btn) guard(() => actDone(btn.dataset.done))
  })
  el('repos-grid').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-repo]')
    if (edit) {
      e.stopPropagation()
      guard(() => renameProject(edit.dataset.editRepo))
      return
    }
    const card = e.target.closest('[data-repo]')
    if (!card) return
    guard(async () => {
      switchTab('project')
      await loadProject(card.dataset.repo)
    })
  })
  el('agent-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-agent]')
    if (!chip) return
    state.agentFilter = chip.dataset.agent || null
    renderAll()
  })
  el('all-search').addEventListener('input', (e) => {
    state.repoFilter = e.target.value
    renderAll()
  })

  el('btn-custom-add')?.addEventListener('click', () => guard(() => editCustomAgent(null, -1)))
  el('custom-agents-list')?.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-custom-edit]')
    if (edit) {
      guard(async () => {
        const cfg = await api.configGet()
        const i = Number(edit.dataset.customEdit)
        await editCustomAgent(cfg.customAgents?.[i], i)
      })
      return
    }
    const del = e.target.closest('[data-custom-del]')
    if (del) {
      guard(async () => {
        const cfg = await api.configGet()
        const i = Number(del.dataset.customDel)
        const a = cfg.customAgents?.[i]
        if (!a) return
        const ok = await openModal({
          title: '删除扩展 Agent',
          desc: `确定删除「${a.label || a.id}」？仅从配置里移除，不会删除该 agent 的会话文件。`,
          okText: '删除',
          fields: [],
        })
        if (!ok) return
        const list = [...(cfg.customAgents || [])]
        list.splice(i, 1)
        await api.configSaveCustomAgents(list)
        toast('已删除')
        await renderCustomAgents()
      })
    }
  })

  const onDrawerClick = (e) => {
    const mode = e.target.closest('[data-mode]')
    if (mode) {
      drawerState.mode = mode.dataset.mode
      el('drawer-body').scrollTop = 0
      renderDrawerTurnList()
      return
    }
    const sub = e.target.closest('[data-sub]')
    if (sub) {
      drawerState.sub = sub.dataset.sub
      el('drawer-body').scrollTop = 0
      renderDrawerTurnList()
      return
    }
    const toggle = e.target.closest('[data-toggle-turn]')
    if (toggle) {
      const id = toggle.dataset.toggleTurn
      if (drawerState.collapsed.has(id)) drawerState.collapsed.delete(id)
      else drawerState.collapsed.add(id)
      renderDrawerTurnList()
      return
    }
    if (e.target.closest('#drawer-collapse-all')) {
      const candidates = assistantIds().filter((id) => {
        const t = drawerState.turns.find((x) => x._id === id)
        const src = displayAssistantText(t?.text, drawerState.mode === 'assistant' && drawerState.sub === 'summary')
        return String(src || '').length > 120 || String(src || '').split('\n').filter(Boolean).length > 2
      })
      const allCollapsed = candidates.length > 0 && candidates.every((id) => drawerState.collapsed.has(id))
      if (allCollapsed) for (const id of candidates) drawerState.collapsed.delete(id)
      else for (const id of candidates) drawerState.collapsed.add(id)
      renderDrawerTurnList()
    }
  }
  el('drawer-toolbar').addEventListener('click', onDrawerClick)
  el('drawer-body').addEventListener('click', onDrawerClick)
  el('drawer-rename').addEventListener('click', () => guard(() => renameSession(drawerState.key)))
  el('drawer-close').addEventListener('click', closeDrawer)
  el('drawer-mask').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('drawer').classList.contains('hidden')) closeDrawer()
  })
}

bind()
boot()

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
  el('drawer-body').innerHTML = bodyHtml
  el('drawer').classList.remove('hidden')
  el('drawer-mask').classList.remove('hidden')
}

function closeDrawer() {
  el('drawer').classList.add('hidden')
  el('drawer-mask').classList.add('hidden')
}

// ─────────────────────────────── 导航

const TAB_TITLES = { overview: '概览', project: '项目', all: '全部项目', settings: '设置' }

function switchTab(tab) {
  if (!TAB_TITLES[tab]) return
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`))
  el('view-title').textContent = TAB_TITLES[tab]
  if (tab === 'all' && !state.repos.length) guard(() => loadRepos(true).then(renderAll))
}

// ─────────────────────────────── 启动

async function boot() {
  // repos 独立跑（17s+），和 agents 并行，别串行等
  const reposPromise = api.repos(false)

  showLoading('读取 agent 数据…')
  try {
    state.boot = await api.boot()
    state.agents = state.boot?.agents || []
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
  const sessionRows = state.agents
    .filter((a) => a.available)
    .map((a) => ({ name: a.label, value: agentSessionCount(a.id) }))
    .filter((r) => r.value > 0)
    .map((r) => ({ ...r, text: num(r.value) }))
  el('chart-sessions').innerHTML = barChart(sessionRows)

  const diskRows = state.disk
    .filter((d) => d.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .map((d) => ({ name: d.label, value: d.bytes, text: humanSize(d.bytes) }))
  el('chart-disk').innerHTML = barChart(diskRows)
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
        <div class="repo-name" title="${esc(r.repo)}">${esc(prettyName(r.repo))}</div>
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
          <span class="cell title-cell" title="${esc(s.title)}">${esc(s.title || '(无标题)')}</span>
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

const drawerState = { key: null, turns: [], mode: 'user', sub: 'summary' }

const TURN_FILTERS = {
  user: (t) => t.role === 'user',
  all: (t) => t.role === 'user' || t.role === 'assistant',
  assistant: (t) => t.role === 'assistant',
}

function drawerCounts() {
  const all = drawerState.turns.filter(TURN_FILTERS.all)
  return {
    user: all.filter((t) => t.role === 'user').length,
    assistant: all.filter((t) => t.role === 'assistant').length,
    all: all.length,
  }
}

function renderDrawerTurnList() {
  const counts = drawerCounts()
  const isAssistant = drawerState.mode === 'assistant'
  const summary = isAssistant && drawerState.sub === 'summary'

  // 分段控件状态
  $$('#drawer-body [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === drawerState.mode))
  $$('#drawer-body [data-sub]').forEach((b) => b.classList.toggle('active', b.dataset.sub === drawerState.sub))
  el('drawer-sub-seg')?.classList.toggle('hidden', !isAssistant)

  const note = el('drawer-note')
  if (note) {
    note.textContent = {
      user: `用户提问 ${counts.user} 条 · 原样展示，不摘要、不截断`,
      all: `用户 ${counts.user} 条 + 智能体 ${counts.assistant} 条 · 全文`,
      assistant: `智能体回答 ${counts.assistant} 条 · ${summary ? '摘要' : '全文'}`,
    }[drawerState.mode]
  }

  const list = drawerState.turns
    .filter(TURN_FILTERS[drawerState.mode])
    .filter((t) => t.text || t.images || (t.files && t.files.length))
    .map((t, i) => {
      const isUser = t.role === 'user'
      const body = summary ? summarize(t.text) : t.text || ''
      const imgs = t.images ? `<div class="turn-img">附件：${t.images} 张图片</div>` : ''
      const files = (t.files || []).map((f) => `<div class="turn-img">文件：${esc(f)}</div>`).join('')
      return `<div class="turn ${isUser ? 'user' : 'assistant'}">
        <div class="turn-role">${isUser ? '用户' : '智能体'} · ${esc(fmtTime(t.at))}${isUser ? '' : ` · #${i + 1}`}</div>
        <div class="turn-text${summary ? ' turn-summary' : ''}">${esc(body || '（无文字内容）')}</div>
        ${imgs}${files}
      </div>`
    })

  const box = el('drawer-turns')
  if (box) {
    box.innerHTML = list.length
      ? list.join('')
      : `<div class="empty"><p>${drawerState.mode === 'user' ? '没有可读取的用户输入。' : drawerState.mode === 'assistant' ? '没有可读取的智能体回答。' : '没有可读取的对话内容。'}</p></div>`
  }
}

function renderDrawerContent() {
  const counts = drawerCounts()
  el('drawer-body').innerHTML = `
    <div class="drawer-toolbar">
      <div class="seg">
        <button class="seg-btn" data-mode="user">用户输入<span class="seg-count">${counts.user}</span></button>
        <button class="seg-btn" data-mode="all">全部信息<span class="seg-count">${counts.all}</span></button>
        <button class="seg-btn" data-mode="assistant">智能体回答<span class="seg-count">${counts.assistant}</span></button>
      </div>
      <div class="seg sub hidden" id="drawer-sub-seg">
        <button class="seg-btn" data-sub="summary">摘要</button>
        <button class="seg-btn" data-sub="full">全文</button>
      </div>
    </div>
    <div class="drawer-note muted" id="drawer-note"></div>
    <div id="drawer-turns"></div>`
  renderDrawerTurnList()
}

async function openSession(key) {
  const s = sessionByKey(key)
  state.selectedKey = key
  drawerState.key = key
  drawerState.turns = []
  drawerState.mode = 'user'
  drawerState.sub = 'summary'
  renderSessions()
  openDrawer(s?.title || '会话', `${s?.agentLabel || ''} · ${key}`, '<div class="empty"><p>读取会话内容…</p></div>')
  await guard(async () => {
    const d = await api.sessionDetail(state.repo, key)
    drawerState.turns = d?.turns || []
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

// ─────────────────────────────── 设置

function renderSettings() {
  const b = state.boot || {}
  const fill = (id, rows) => {
    el(id).innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || '—')}</dd>`).join('')
  }
  fill('settings-paths', [
    ['数据目录', b.dataDir],
    ['MCP 配置', b.configPath],
  ])
  const v = api?.versions || {}
  fill('settings-versions', [
    ['应用版本', b.appVersion],
    ['Electron', v.electron],
    ['Node', v.node],
    ['Chromium', v.chrome],
    ['平台', api?.platform],
  ])
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
  el('repo-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadProject(el('repo-input').value)
  })

  el('btn-task-new').addEventListener('click', actNewTask)
  el('btn-note-add').addEventListener('click', actAddNote)

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

  el('drawer-body').addEventListener('click', (e) => {
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
    }
  })
  el('drawer-close').addEventListener('click', closeDrawer)
  el('drawer-mask').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('drawer').classList.contains('hidden')) closeDrawer()
  })
}

bind()
boot()

#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { SessionMeta, Turn } from './types'
import { DATA_DIR, configPath, ensureConfig, loadConfig, saveConfig, type Config } from './config'
import { agentStatus, findSession, listSessions, readSession } from './core/store'
import { saveImages } from './core/attach'
import { buildBrief } from './core/brief'
import { latestNote, listNotes, saveNote } from './core/handoff'
import { formatSearchResult, searchSessions } from './core/search'
import { detectAgents, deinitProject, doctor, initProject, installAll, rulesBlock, uninstallAll } from './install'
import { applyDetected, detectSources } from './detect'
import { fmtTime, plain } from './util'

const TTY = process.stdout.isTTY === true
const c = {
  dim: (s: string) => (TTY ? `\u001b[2m${s}\u001b[0m` : s),
  bold: (s: string) => (TTY ? `\u001b[1m${s}\u001b[0m` : s),
  cyan: (s: string) => (TTY ? `\u001b[36m${s}\u001b[0m` : s),
  green: (s: string) => (TTY ? `\u001b[32m${s}\u001b[0m` : s),
  yellow: (s: string) => (TTY ? `\u001b[33m${s}\u001b[0m` : s),
}

interface Args {
  cmd: string
  positional: string[]
  flags: Record<string, string | boolean>
}

const VALUE_FLAGS = ['repo', 'limit', 'agent', 'rounds', 'tail', 'since', 'out', 'summary', 'files', 'scan']

function parseArgs(argv: string[]): Args {
  const first = argv[0]
  const cmd = first && !first.startsWith('-') ? first : 'status'
  const rest = cmd === 'status' && first !== 'status' ? argv : argv.slice(1)
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      const key = k as string
      if (v !== undefined) flags[key] = v
      else {
        const next = rest[i + 1]
        if (next && !next.startsWith('-') && VALUE_FLAGS.includes(key)) {
          flags[key] = next
          i++
        } else flags[key] = true
      }
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = true
    } else positional.push(a)
  }
  return { cmd, positional, flags }
}

function repoLabel(s: SessionMeta): string {
  return s.project || (s.repo ? path.basename(s.repo) : '')
}

function printList(sessions: SessionMeta[], opts: { showRepo: boolean }): void {
  if (sessions.length === 0) {
    console.log(c.dim('（没有找到会话）'))
    return
  }
  const w = String(sessions.length).length
  sessions.forEach((s, i) => {
    const idx = c.dim(String(i + 1).padStart(w, ' '))
    const agent = c.cyan(s.agent.padEnd(9))
    const time = fmtTime(s.updatedAt || s.startedAt)
    // Cursor 这类拿不到精确轮次的，退而显示气泡数
    const turns = s.turns ? c.dim(`${s.turns}轮`) : s.bubbles ? c.dim(`${s.bubbles}条`) : ''
    const label = repoLabel(s)
    const repo = opts.showRepo && label ? c.dim(` [${label}]`) : ''
    console.log(`${idx} ${agent} ${c.dim(time)}  ${plain(s.title, 46)}${repo} ${turns}`)
    if (s.preview) console.log(`${' '.repeat(w)} ${c.dim(' '.repeat(9) + ' ' + plain(s.preview, 100))}`)
  })
}

function printTurns(turns: Turn[]): void {
  for (const t of turns) {
    const who = t.role === 'user' ? c.green('用户') : t.role === 'tool' ? c.dim('工具') : c.cyan('助手')
    console.log('')
    console.log(`${who} ${c.dim(t.at ? fmtTime(t.at) : '')}`)
    const body = plain(t.text, 2000)
    for (const line of body.split('\n')) console.log(`  ${line}`)
    if (t.images?.length) console.log(`  ${c.yellow(`[${t.images.length} 张图片]`)}`)
  }
}

// ---------------------------------------------------------------- 命令

function cmdStatus(args: Args, cfg: Config): void {
  const repo = (args.flags.repo as string) || process.cwd()
  const limit = Number(args.flags.limit || cfg.defaultLimit || 15)
  const { sessions, errors } = listSessions({ repo, limit }, cfg)
  console.log(c.bold(`仓库 ${sessions[0]?.repo || repo}`))
  console.log(c.dim(`配置 ${configPath()}   数据 ${DATA_DIR}`))

  const note = latestNote(sessions[0]?.repo || repo)
  if (note) {
    console.log('')
    console.log(c.bold(`上次收尾的记录（${fmtTime(note.entry.at)}，来自 ${note.entry.key}）`))
    const body = note.content.replace(/^<!--[\s\S]*?-->\n/, '')
    const preview = body.split('\n').slice(0, 18).join('\n')
    console.log(c.dim('─'.repeat(60)))
    console.log(preview)
    if (body.split('\n').length > 18) console.log(c.dim(`… 完整内容见 ${note.file}`))
    console.log(c.dim('─'.repeat(60)))
  }

  console.log('')
  if (sessions.length === 0) {
    console.log(c.yellow('这个仓库还没有任何 agent 的会话记录。'))
    console.log(c.dim('换个 agent 聊过之后，这里就会出现跨 agent 的历史。'))
  } else {
    const byAgent = new Map<string, number>()
    for (const s of sessions) byAgent.set(s.agent, (byAgent.get(s.agent) || 0) + 1)
    console.log(c.dim(`本仓库最近会话：${[...byAgent].map(([k, v]) => `${k}×${v}`).join('  ')}`))
    console.log('')
    printList(sessions, { showRepo: false })
    console.log('')
    console.log(c.dim('继续某个会话：  ass show #1       把最后一问搬到新 agent：  ass last #1       生成交接摘要：  ass brief #1'))
  }
  if (errors.length) {
    console.log('')
    console.log(c.yellow(`部分 agent 读取失败：${errors.join('; ')}`))
  }
}

function cmdList(args: Args, cfg: Config): void {
  const limit = Number(args.flags.limit || cfg.defaultLimit || 15)
  const repo = (args.flags.repo as string) || (args.flags.all ? null : process.cwd())
  const { sessions, errors } = listSessions(
    {
      repo,
      includeAll: Boolean(args.flags.all),
      limit,
      agent: (args.flags.agent as string) || undefined,
      noCache: Boolean(args.flags['no-cache']),
    },
    cfg,
  )
  if (args.flags.json) {
    console.log(JSON.stringify(sessions, null, 2))
    return
  }
  printList(sessions, { showRepo: !repo || Boolean(args.flags.all) })
  if (errors.length) console.log(c.yellow(`\n读取失败：${errors.join('; ')}`))
}

function locate(ref: string | undefined, cfg: Config, fallbackRepo?: string): ReturnType<typeof findSession> {
  if (ref) return findSession(ref, cfg)
  const repo = fallbackRepo || process.cwd()
  const { sessions } = listSessions({ repo, limit: 1 }, cfg)
  const first = sessions[0]
  return first ? findSession(first.key, cfg) : null
}

function cmdShow(args: Args, cfg: Config): void {
  const ref = args.positional[0]
  if (!ref) return usage('show 需要一个引用，例如 `ass show #1`')
  const found = findSession(ref, cfg)
  if (!found) return usage(`没找到会话：${ref}`)
  const s = found.meta
  console.log(c.bold(`${s.agentLabel}  ${s.key}`))
  console.log(`标题    ${s.title}`)
  if (s.preview) console.log(`最近    ${plain(s.preview, 160)}`)
  console.log(`仓库    ${s.repo || '—'}`)
  console.log(`目录    ${s.cwd || '—'}`)
  console.log(`时间    ${fmtTime(s.startedAt)} → ${fmtTime(s.updatedAt)}`)
  console.log(`规模    ${s.turns} 轮 / ${s.bubbles} 条消息`)
  if (s.model) console.log(`模型    ${s.model}`)
  console.log(`来源    ${s.source}`)
  if (found.adapter.resumeCmd) console.log(`继续    ${c.green(found.adapter.resumeCmd(s))}`)

  const tail = args.flags.full ? undefined : Number(args.flags.tail || 6)
  const turns = readSession(found, tail ? { tail } : {})
  if (turns.length) {
    console.log('')
    console.log(c.dim(tail ? `—— 最后 ${turns.length} 条 ——` : `—— 全部 ${turns.length} 条 ——`))
    printTurns(turns)
  }
}

/** R3：把「另一个 agent 里的那一问」原样搬过来（含图片落盘） */
function cmdLast(args: Args, cfg: Config): void {
  const found = locate(args.positional[0], cfg)
  if (!found) return usage(`没找到会话：${args.positional[0] || process.cwd()}`)
  const rounds = Math.max(1, Number(args.flags.rounds || 1))
  // 全量读：只读文件尾巴会漏掉更早的轮次（尤其是相隔很远的提问）
  const users = readSession(found).filter((t) => t.role === 'user')
  const picked = users.slice(-rounds)
  if (picked.length === 0) return usage('这个会话里没有找到用户提问。')

  const imgPaths: string[] = []
  for (const t of picked) {
    if (!t.images?.length) continue
    imgPaths.push(...saveImages(t.images, found.meta.key, undefined, imgPaths.length + 1))
  }

  if (args.flags.json) {
    console.log(JSON.stringify({ meta: found.meta, rounds: picked, images: imgPaths }, null, 2))
    return
  }

  console.log(c.dim('━'.repeat(72)))
  console.log(`${c.bold('来自')} ${found.meta.agentLabel} ${c.dim(`(${found.meta.key}, ${fmtTime(found.meta.updatedAt)})`)}`)
  if (found.meta.repo) console.log(`${c.bold('仓库')} ${found.meta.repo}`)
  if (imgPaths.length) {
    console.log(`${c.bold('图片')} ${imgPaths.length} 张已落盘：`)
    for (const p of imgPaths) console.log(`      ${p}`)
  }
  console.log(c.dim('━'.repeat(72)))
  picked.forEach((t, i) => {
    if (picked.length > 1) console.log(`\n${c.dim(`【第 ${i + 1} 问】`)}`)
    console.log('')
    console.log(t.text || c.dim(`(这一问只有 ${t.images?.length ?? 0} 张图片，路径见上面)`))
  })
  console.log('')
  console.log(c.dim('━'.repeat(72)))
  console.log(c.dim('把上面这段直接发给新 agent 即可继续；有图片的话把路径一起给它。'))
}

function cmdBrief(args: Args, cfg: Config): void {
  const found = locate(args.positional[0], cfg)
  if (!found) return usage(`没找到会话：${args.positional[0] || process.cwd()}`)
  const turns = readSession(found)
  const md = buildBrief(found.meta, turns, {
    maxFiles: Number(args.flags.files || 25),
    tailMessages: Number(args.flags.tail || 4),
  })
  const out = args.flags.out as string | undefined
  if (out) {
    fs.writeFileSync(out, md)
    console.log(`已写入 ${out}（${md.length} 字符）`)
    return
  }
  console.log(md)
}

function cmdNote(args: Args, cfg: Config): void {
  const repo = (args.flags.repo as string) || process.cwd()
  const found = locate(args.positional[0], cfg, repo)
  if (!found) return usage('没找到可以收尾的会话。')
  const turns = readSession(found)
  const saved = saveNote(found.meta, turns, args.flags.summary as string | undefined, repo)
  console.log(c.green('已保存交接记录'))
  console.log(`  来源会话   ${found.meta.key}`)
  console.log(`  文件       ${saved.file}`)
  console.log(`  下次入口   ${path.dirname(saved.latestFile)}/latest.md`)
  if (args.flags.json) console.log(JSON.stringify({ file: saved.file, slug: saved.slug }, null, 2))
}

function cmdSearch(args: Args, cfg: Config): void {
  const q = args.positional.join(' ')
  if (!q) return usage('search 需要一个关键词：`ass search "点击穿透"`')
  const r = searchSessions(
    q,
    {
      repo: (args.flags.repo as string) || process.cwd(),
      allRepos: Boolean(args.flags.all),
      limit: Number(args.flags.limit || 8),
      scan: Number(args.flags.scan || 60),
    },
    cfg,
  )
  console.log(args.flags.json ? JSON.stringify(r, null, 2) : formatSearchResult(r))
}

function cmdNotes(args: Args): void {
  const notes = listNotes()
  if (args.flags.json) {
    console.log(JSON.stringify(notes, null, 2))
    return
  }
  if (!notes.length) {
    console.log(c.dim('还没有保存过任何交接记录。'))
    return
  }
  for (const n of notes) console.log(`${c.dim(fmtTime(n.entry.at))}  ${c.cyan(n.entry.project.padEnd(28))} ${n.entry.repo}`)
}

function cmdAgents(args: Args, cfg: Config): void {
  const status = agentStatus(cfg)
  const detected = detectAgents()
  for (const { adapter, available, found, error } of status) {
    const mark = available ? c.green('●') : c.dim('○')
    const state = error ? c.yellow(`读取失败: ${error}`) : available ? c.dim(`${found} 个会话`) : c.dim('未安装 / 没有数据')
    const hook = detected.find((d) => d.id === adapter.id)
    const hooked = hook?.installed ? c.green(' [MCP 已接入]') : hook?.exists ? c.dim(' [MCP 未接入]') : ''
    console.log(`${mark} ${c.cyan(adapter.id.padEnd(10))} ${adapter.label.padEnd(14)} ${state}${hooked}`)
    for (const s of adapter.sources()) console.log(`  ${c.dim(s)}`)
    if (!available && adapter.hint) console.log(`  ${c.dim(adapter.hint)}`)
  }
  if (args.flags.json) console.log(JSON.stringify(status.map((s) => ({ id: s.adapter.id, available: s.available, found: s.found, error: s.error })), null, 2))
}

function cmdDetect(args: Args, cfg: Config): void {
  const list = detectSources(cfg)
  if (args.flags.json) {
    console.log(JSON.stringify(list, null, 2))
    return
  }
  for (const d of list) {
    const mark = d.available ? c.green('●') : c.dim('○')
    const kind =
      d.kind === 'candidate' ? c.yellow(' [可接入]') : d.kind === 'probe' ? c.dim(' [需自定义]') : d.kind === 'configured' ? c.dim(' [已配置]') : ''
    const n = d.sessions ? c.dim(`${d.sessions} 个会话`) : ''
    console.log(`${mark} ${c.cyan(d.id.padEnd(14))} ${(d.label || '').padEnd(20)} ${n}${kind}`)
    console.log(`  ${c.dim(d.path)}`)
    if (d.detail) console.log(`  ${c.dim(d.detail)}`)
  }

  const cands = list.filter((d) => d.kind === 'candidate' && d.config)
  if (cands.length && !args.flags.write) {
    console.log('')
    console.log(c.bold(`发现 ${cands.length} 个可以直接接入的 agent`))
    for (const d of cands) {
      console.log('')
      console.log(c.dim(`—— ${d.id} 的配置草案 ——`))
      console.log(JSON.stringify({ customAgents: [d.config] }, null, 2))
    }
    console.log('')
    console.log(c.dim('想直接写进配置：ass detect --write'))
  }
  if (args.flags.write) {
    const ids = args.positional.length ? args.positional : []
    const { added, config } = applyDetected(ids, cfg)
    if (!added.length) {
      console.log(c.dim('没有新的可接入 agent。'))
      return
    }
    saveConfig(config)
    console.log(c.green(`已写入配置：${added.map((a) => a.id).join(', ')}`))
    console.log(c.dim(configPath()))
  }
}

function cmdRepos(args: Args, cfg: Config): void {
  const { sessions } = listSessions({ includeAll: true }, cfg)
  const byRepo = new Map<string, { n: number; agents: Set<string>; last: number }>()
  for (const s of sessions) {
    const key = s.repo || s.cwd || '(未知)'
    const e = byRepo.get(key) || { n: 0, agents: new Set<string>(), last: 0 }
    e.n++
    e.agents.add(s.agent)
    e.last = Math.max(e.last, s.updatedAt || s.startedAt || 0)
    byRepo.set(key, e)
  }
  const rows = [...byRepo].sort((a, b) => b[1].last - a[1].last)
  if (args.flags.json) {
    console.log(JSON.stringify(rows.map(([r, v]) => ({ repo: r, sessions: v.n, agents: [...v.agents] })), null, 2))
    return
  }
  for (const [repo, v] of rows) {
    console.log(`${c.dim(fmtTime(v.last))}  ${String(v.n).padStart(4)} 个会话  ${[...v.agents].join('/').padEnd(30)} ${repo}`)
  }
  console.log(c.dim(`\n共 ${rows.length} 个仓库`))
}

function cmdConfig(args: Args): void {
  if (args.flags.init) {
    const { created } = ensureConfig()
    console.log(created ? `已创建 ${configPath()}` : `${configPath()} 已存在`)
  }
  console.log(configPath())
  console.log(c.dim(JSON.stringify(loadConfig(), null, 2)))
}

const ACTION_MARK: Record<string, string> = {
  created: '＋ 新建',
  updated: '✎ 更新',
  appended: '✎ 追加',
  unchanged: '= 无需改动',
  removed: '－ 摘除',
  skipped: '· 跳过',
  missing: '· 未安装',
  failed: '✗ 失败',
  manual: '! 需手工',
}

function printSteps(title: string, steps: { target: string; path: string; action: string; detail?: string }[]): void {
  console.log(c.bold(title))
  for (const s of steps) {
    const mark = ACTION_MARK[s.action] ?? s.action
    const color = s.action === 'failed' ? c.yellow : s.action === 'unchanged' || s.action === 'skipped' || s.action === 'missing' ? c.dim : c.green
    console.log(`  ${color(mark.padEnd(12))} ${c.cyan(s.target.padEnd(10))} ${c.dim(s.path)}${s.detail ? `  ${c.dim(s.detail)}` : ''}`)
  }
}

function cmdInstall(args: Args): void {
  if (args.flags.rules) {
    console.log(rulesBlock())
    return
  }
  const steps = installAll({ dryRun: Boolean(args.flags['dry-run']) })
  printSteps(`${args.flags['dry-run'] ? '[dry-run] ' : ''}agent-session-sync install`, steps)
  console.log('')
  console.log(c.dim('已接入 MCP 的 agent，重启后即可在会话里调用 session_* 工具；'))
  console.log(c.dim('规则块已写进全局 CLAUDE.md / AGENTS.md，新会话开场会主动问你「要不要同步之前的会话」。'))
  console.log(c.dim('Cursor / Trae 这类需要手工贴的地方：ass rules'))
}

function cmdUninstall(args: Args): void {
  const steps = uninstallAll({ dryRun: Boolean(args.flags['dry-run']) })
  printSteps(`${args.flags['dry-run'] ? '[dry-run] ' : ''}agent-session-sync uninstall`, steps)
  console.log('')
  console.log(c.dim('会话数据（缓存 / 附件 / 交接记录）没有被删除，需要的用 ass notes 找回。'))
}

function cmdInit(args: Args): void {
  const dir = path.resolve(args.positional[0] || process.cwd())
  const dry = Boolean(args.flags['dry-run'])
  const steps = args.flags.undo ? deinitProject(dir, { dryRun: dry }) : initProject(dir, { dryRun: dry })
  printSteps(`${dry ? '[dry-run] ' : ''}项目级规则 → ${dir}`, steps)
  if (!dry) console.log(c.dim('\n（这些文件都在 git 里未跟踪；不想要了执行 ass init --undo）'))
}

function cmdDoctor(args: Args, cfg: Config): void {
  console.log(c.bold('环境'))
  for (const line of doctor()) console.log(`  ${line}`)
  console.log(`  配置        ${configPath()}`)
  console.log(`  数据        ${DATA_DIR}`)
  console.log('')
  console.log(c.bold('agent'))
  cmdAgents({ cmd: 'agents', positional: [], flags: args.flags.json ? { json: true } : {} }, cfg)
}

function usage(msg?: string): void {
  if (msg) console.log(c.yellow(msg) + '\n')
  console.log(`${c.bold('agent-session-sync (ass)')} — 跨 agent 会话同步

${c.bold('看历史')}
  ass                      当前仓库：上次收尾记录 + 最近会话
  ass list [选项]           列出会话（--all 跨仓库，--agent claude，--limit 20，--json）
  ass show <引用>           看某个会话（--full 全部，--tail 6 最后 N 条）
  ass search <关键词>       在最近会话正文里全文搜索（--all 跨仓库，--scan 60）

${c.bold('搬上下文')}
  ass last [引用]           把最后一问原样搬过来（--rounds 3 连问多轮，含图片落盘）
  ass brief [引用]          生成交接摘要 Markdown（--out 文件.md，--tail 4，--files 25）
  ass note [引用]           收尾：把摘要存进本仓库，下次任何 agent 进来都能看到
  ass notes                已保存的交接记录列表

${c.bold('接入 / 维护')}
  ass install              把 MCP + 规则写进本机各 agent（--dry-run 只看不改）
  ass rules                打印规则原文（Cursor/Trae 这些要手工贴的用）
  ass uninstall            摘掉 MCP + 规则（不动你的会话数据）
  ass init [目录]          项目级注入规则（--dry-run / --undo）
  ass agents               探测到哪些 agent、数据源在哪、MCP 是否已接入
  ass detect               自检索：扫盘找出本机所有可能的 agent（--write 写入配置草案）
  ass repos                有历史的仓库列表
  ass config [--init]      打印/初始化配置文件
  ass doctor               自检

${c.bold('引用')}
  #1                      上一次 list 的第 1 条
  claude:31c5af10         agent:会话id 前缀
  点击穿透                 标题里包含这段文字
`)
}

function main(): void {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return usage()
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log('agent-session-sync 0.1.0')
    return
  }
  const args = parseArgs(argv)
  const cfg = loadConfig()
  switch (args.cmd) {
    case 'status':
      return cmdStatus(args, cfg)
    case 'list':
    case 'ls':
      return cmdList(args, cfg)
    case 'show':
      return cmdShow(args, cfg)
    case 'last':
      return cmdLast(args, cfg)
    case 'brief':
      return cmdBrief(args, cfg)
    case 'note':
      return cmdNote(args, cfg)
    case 'notes':
      return cmdNotes(args)
    case 'search':
      return cmdSearch(args, cfg)
    case 'agents':
      return cmdAgents(args, cfg)
    case 'detect':
      return cmdDetect(args, cfg)
    case 'repos':
      return cmdRepos(args, cfg)
    case 'config':
      return cmdConfig(args)
    case 'install':
      return cmdInstall(args)
    case 'uninstall':
      return cmdUninstall(args)
    case 'init':
      return cmdInit(args)
    case 'doctor':
      return cmdDoctor(args, cfg)
    default:
      return usage(`未知命令：${args.cmd}`)
  }
}

try {
  main()
} catch (e) {
  console.error(c.yellow(`出错了：${e instanceof Error ? e.message : String(e)}`))
  process.exitCode = 1
}

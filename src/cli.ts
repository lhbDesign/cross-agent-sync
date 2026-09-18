#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import type { SessionMeta, Turn } from './types'
import { ensureConfig, configPath, DATA_DIR, loadConfig, type Config } from './config'
import { agentStatus, findSession, listSessions, readSession, resolveRef } from './core/store'
import { saveImages } from './core/attach'
import { plain } from './util'

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

function parseArgs(argv: string[]): Args {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status'
  const rest = cmd === 'status' && argv[0] !== 'status' ? argv : argv.slice(1)
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      if (v !== undefined) flags[k as string] = v
      else {
        const next = rest[i + 1]
        if (next && !next.startsWith('-') && ['repo', 'limit', 'agent', 'rounds', 'tail', 'since'].includes(k as string)) {
          flags[k as string] = next
          i++
        } else flags[k as string] = true
      }
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = true
    } else positional.push(a)
  }
  return { cmd, positional, flags }
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function repoLabel(s: SessionMeta): string {
  return s.project || (s.repo ? path.basename(s.repo) : '—')
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
    const title = plain(s.title, 46)
    const turns = s.turns ? c.dim(`${s.turns}轮`) : ''
    const repo = opts.showRepo ? c.dim(` [${repoLabel(s)}]`) : ''
    console.log(`${idx} ${agent} ${c.dim(time)}  ${title}${repo} ${turns}`)
    if (s.preview) console.log(`${' '.repeat(w)} ${c.dim(' '.repeat(9) + ' ' + plain(s.preview, 100))}`)
  })
}

function cmdStatus(args: Args, cfg: Config): void {
  const repo = (args.flags.repo as string) || process.cwd()
  const limit = Number(args.flags.limit || cfg.defaultLimit || 15)
  const { sessions, errors } = listSessions({ repo, limit }, cfg)
  const root = sessions[0]?.repo
  console.log(c.bold(`仓库 ${root || repo}`))
  console.log(c.dim(`配置 ${configPath()}   数据 ${DATA_DIR}`))
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
    console.log(c.dim(`继续某个会话：  ass show #1       把它最后一问搬到新 agent：  ass last #1`))
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

function printTurns(turns: Turn[]): void {
  for (const t of turns) {
    const who = t.role === 'user' ? c.green('用户') : t.role === 'tool' ? c.dim('工具') : c.cyan('助手')
    console.log('')
    console.log(`${who} ${c.dim(t.at ? fmtTime(t.at) : '')}`)
    const body = t.text.length > 4000 && !process.stdout.isTTY ? t.text : plain(t.text, 2000)
    for (const line of body.split('\n')) console.log(`  ${line}`)
    if (t.images?.length) console.log(`  ${c.yellow(`[${t.images.length} 张图片]`)}`)
  }
}

/** R3：把「另一个 agent 里的那一问」原样搬过来（含图片落盘） */
function cmdLast(args: Args, cfg: Config): void {
  const ref = args.positional[0] || '#1'
  const found = findSession(ref, cfg)
  if (!found) return usage(`没找到会话：${ref}`)
  const rounds = Math.max(1, Number(args.flags.rounds || 1))
  // 这里必须全量读：只读文件尾巴会漏掉更早的轮次（尤其是相隔很远的提问）
  const turns = readSession(found)
  const users = turns.filter((t) => t.role === 'user')
  const picked = users.slice(-rounds)
  if (picked.length === 0) return usage('这个会话里没有找到用户提问。')

  const key = found.meta.key
  const imgPaths: string[] = []
  for (const t of picked) {
    if (!t.images?.length) continue
    imgPaths.push(...saveImages(t.images, key, undefined, imgPaths.length + 1))
  }

  if (args.flags.json) {
    console.log(JSON.stringify({ meta: found.meta, rounds: picked, images: imgPaths }, null, 2))
    return
  }

  console.log(c.dim('━'.repeat(72)))
  console.log(`${c.bold('来自')} ${found.meta.agentLabel} ${c.dim(`(${key}, ${fmtTime(found.meta.updatedAt)})`)}`)
  if (found.meta.repo) console.log(`${c.bold('仓库')} ${found.meta.repo}`)
  if (imgPaths.length) {
    console.log(`${c.bold('图片')} ${imgPaths.length} 张已落盘：`)
    for (const p of imgPaths) console.log(`      ${p}`)
  }
  console.log(c.dim('━'.repeat(72)))
  picked.forEach((t, i) => {
    if (picked.length > 1) console.log(`\n${c.dim(`【第 ${i + 1} 问】`)}`)
    console.log('')
    console.log(t.text || c.dim(`(这一问只有 ${t.images?.length ?? 0} 张图片，路径见上面)`) + t.text)
  })
  console.log('')
  console.log(c.dim('━'.repeat(72)))
  console.log(c.dim('把上面这段直接发给新 agent 即可继续；有图片的话把路径一起给它。'))
}

function cmdAgents(args: Args, cfg: Config): void {
  const status = agentStatus(cfg)
  for (const { adapter, available, found, error } of status) {
    const mark = available ? c.green('●') : c.dim('○')
    const state = error ? c.yellow(`读取失败: ${error}`) : available ? c.dim(`${found} 个会话`) : c.dim('未安装 / 没有数据')
    console.log(`${mark} ${c.cyan(adapter.id.padEnd(10))} ${adapter.label.padEnd(14)} ${state}`)
    for (const s of adapter.sources()) console.log(`  ${c.dim(s)}`)
    if (!available && adapter.hint) console.log(`  ${c.dim(adapter.hint)}`)
  }
  if (args.flags.json) console.log(JSON.stringify(status.map((s) => ({ id: s.adapter.id, available: s.available, found: s.found, error: s.error })), null, 2))
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

function cmdDoctor(args: Args, cfg: Config): void {
  console.log(c.bold('环境'))
  console.log(`  node        ${process.version}`)
  console.log(`  平台        ${process.platform}`)
  console.log(`  配置        ${configPath()}`)
  console.log(`  数据        ${DATA_DIR}`)
  console.log('')
  console.log(c.bold('agent'))
  cmdAgents({ cmd: 'agents', positional: [], flags: args.flags.json ? { json: true } : {} }, cfg)
}

function usage(msg?: string): void {
  if (msg) console.log(c.yellow(msg) + '\n')
  console.log(`${c.bold('agent-session-sync')} — 跨 agent 会话同步

${c.bold('用法')}
  ass                      看当前仓库有哪些 agent 的会话
  ass list [选项]           列出会话（--all 跨仓库，--agent claude，--limit 20，--json）
  ass show <引用>           看某个会话（--full 全部，--tail 6 最后 N 条）
  ass last [引用]           把它的最后一问原样搬过来（--rounds 3 连问多轮，含图片）
  ass agents               本机探测到哪些 agent、数据源在哪
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
    case 'agents':
      return cmdAgents(args, cfg)
    case 'repos':
      return cmdRepos(args, cfg)
    case 'config':
      return cmdConfig(args)
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

export { resolveRef }

#!/usr/bin/env node
import fs from 'node:fs'
import { sessionInputs, inputsMarkdown } from './core/inputs'
import { configureHooks, hookStatus, runHook, recordHookFailure, readHookInput, type HookAgent } from './hooks'
import path from 'node:path'
import process from 'node:process'
import type { SessionMeta, Turn } from './types'
import { DATA_DIR, configPath, ensureConfig, loadConfig, saveConfig, type Config } from './config'
import { agentStatus, findSession, listSessions, readSession } from './core/store'
import { saveImages } from './core/attach'
import { buildBrief } from './core/brief'
import { latestNote, listNotes, saveNote, saveNoteMd } from './core/handoff'
import {
  currentSession,
  findTask,
  taskAttach,
  taskCreate,
  taskDetach,
  taskLine,
  taskList,
  taskRemove,
  taskResumeMarkdown,
  taskSetNote,
  taskSetStatus,
  taskSummary,
  taskGoalLabel,
  taskGoalSource,
  taskView,
  type TaskRecord,
  type TaskView,
} from './core/task'
import { applyContextChange, type ContextPatch, addContext, contextFile, contextLine, contextMarkdown, KIND_LABEL, REVIEW_LABEL, readContext, updateContext, type ContextKind } from './core/context'
import { LEVELS, estimateTokens, parseLevel } from './core/budget'
import { armGuard, assertWritable, guardSummary, protectedPaths } from './core/roguard'
import { buildAdapters } from './adapters/registry'
import { formatSearchResult, searchSessions } from './core/search'
import {
  detectAgents,
  deinitProject,
  doctor,
  initProject,
  installAll,
  installProjectMcp,
  mcpConfigJson,
  PROJECT_MCP_TARGETS,
  rulesBlock,
  uninstallAll,
  uninstallProjectMcp,
} from './install'
import { applyDetected, detectSources } from './detect'
import { dispWidth, fmtTime, pkgVersion, plain, truncWidth } from './util'
import { maybeReexec } from './bootstrap'

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

const VALUE_FLAGS = [
  'repo', 'limit', 'agent', 'round', 'rounds', 'tail', 'since', 'out', 'summary', 'files', 'scan',
  'decision', 'decide', 'dead-end', 'deadend', 'constraint', 'todo', 'note', 'done', 'remove',
  'label', 'goal', 'budget', 'tokens', 'session', 'suggestion', 'confirm', 'review', 'result', 'evidence', 'related-to', 'supersedes', 'cancel', 'reopen',
]

/** 记录类参数：flag 名 → 条目类型 */
const CONTEXT_FLAGS: [string, ContextKind][] = [
  ['suggestion', 'suggestion'],
  ['decision', 'decision'],
  ['decide', 'decision'],
  ['dead-end', 'dead-end'],
  ['deadend', 'dead-end'],
  ['constraint', 'constraint'],
  ['todo', 'todo'],
  ['note', 'note'],
]

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

/**
 * 首屏只回答四个问题：有几个会话 / 有哪些任务 / 怎么合并 / 怎么恢复。
 * 交接摘要**不在这里展开**（以前会顶 18 行，把真正要看的东西全埋了）——要全文用 `ass notes`。
 */
/**
 * 解析 `--limit`。
 *
 * ⚠️ 这里有个坑：`--limit` 后面如果跟的是另一个开关（比如 `ass --limit --all`），
 * parseArgs 不会把它当值消费，`flags.limit` 会变成布尔 `true` ——
 * 而 `Number(true) === 1`。于是「没给值」被静默解释成「只要 1 条」，
 * 用户看到的是「1 个会话」，完全摸不着头脑。
 * 所以这里显式区分三种情况；返回 null 表示「写了但值不合法」，调用方应当报错而不是猜。
 */
function limitOf(args: Args, cfg: Config): number | null {
  const v = args.flags.limit
  if (v === undefined) {
    const d = Number(cfg.defaultLimit)
    return Number.isFinite(d) && d > 0 ? Math.floor(d) : 15
  }
  if (typeof v !== 'string') return null // 写了 --limit 但后面没跟数字
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function cmdStatus(args: Args, cfg: Config): void {
  const limit = limitOf(args, cfg)
  if (limit === null) return usageFail('--limit 需要一个正整数，例如 `ass --limit 100`')
  // `ass --all` = 跨仓库。以前这里根本不看这个开关，而底部提示却在教用户加它 ——
  // 说了支持就得真支持，否则提示本身就是在骗人。
  const all = Boolean(args.flags.all)
  const repo = (args.flags.repo as string) || (all ? null : process.cwd())
  // 多要一条：拿到 limit+1 条就说明「还有更多」。只看返回数组的话，
  // 它已经被截断过，无从判断到底是刚好 limit 个还是被砍过。
  const { sessions: raw, errors, adapters } = listSessions({ repo, includeAll: all, limit: limit + 1 }, cfg)
  const truncated = raw.length > limit
  const sessions = truncated ? raw.slice(0, limit) : raw
  const repoDir = sessions[0]?.repo || repo || process.cwd()

  console.log(c.bold(all ? '全部仓库' : `仓库 ${repoDir}`))

  const tasks = taskList({ repo: all ? null : repoDir })
  const ctxLine = all ? '' : contextLine(repoDir)
  const head = [truncated ? `显示最近 ${sessions.length} 个会话（还有更多）` : `${sessions.length} 个会话`]
  if (tasks.length) head.push(`${tasks.length} 个工作任务`)
  console.log(c.dim(head.join(' · ')))

  if (tasks.length) {
    console.log('')
    console.log(c.bold('工作任务'))
    for (const t of tasks) {
      const v = taskView(t.id, cfg)
      console.log(`${c.cyan(t.id)}  ${c.bold(t.name)}   ${c.dim(taskSummary(t))}`)
      if (v?.goal?.text) console.log(`    ${c.dim(taskGoalLabel(v.goal))}   ${v.goal.text}`)
      if (v?.goal) console.log(c.dim(`    来源：${taskGoalSource(v.goal)}`))
      console.log(`    查看详情 ${c.cyan(`ass resume ${t.id}`)}`)
      console.log(`    ${c.dim('如何接续')} ${c.green(`在已配置同步规则的 agent 里说「继续 ${t.name}」`)}`)
    }
    console.log('')
    console.log(c.dim('  工作任务把同一件事的多个会话关联起来；待办是其中尚需处理的具体事项。'))
  }

  if (!tasks.length) {
    console.log('\n工作任务 · 尚未建立')
    console.log(c.dim('  会话不会自动归为任务。跨会话接续同一件事时，可命名并关联相关会话。'))
    console.log('  创建并关联：ass task add "<任务名>" <会话引用>')
    console.log(c.dim('  只查看历史或搬运提问，无需创建任务。'))
  }

  if (ctxLine) {
    console.log('')
    console.log(`${c.bold('项目笔记')}  ${c.cyan(ctxLine)}`)
    console.log(c.dim('  此前主动保存的仓库共享记录，会放在交接摘要前面。'))
    console.log(c.dim('  内容和完成状态可能尚未更新。查看笔记：ass context；原始提问：ass last <引用>。'))
  }

  console.log('')
  if (sessions.length === 0) {
    console.log(c.yellow('这个仓库还没有任何 agent 的会话记录。'))
    console.log(c.dim('换个 agent 聊过之后，这里就会出现跨 agent 的历史。'))
    return
  }

  console.log(c.bold('会话'))
  const byAgent = new Map(adapters.map((a) => [a.id, a]))
  const idxW = String(sessions.length).length
  const agentW = Math.max(...sessions.map((s) => s.agent.length), 0)
  // 引用给**完整 id**：`--resume` 只认完整 id（实测 8 位前缀不好使），
  // 而 ass brief / session_handoff 是前缀匹配，完整 id 一样能用 —— 一个形式两用。
  const refs = sessions.map((s) => `${s.agent}:${s.id}`)
  const refW = Math.max(...refs.map((r) => r.length), 0)
  // 前缀部分（行首到标题列）先拼好，用**实际字符串**量宽度 ——
  // 手算常量必错：`turns.padEnd(4)` 是按字符补的，而「3轮」是 2 字符占 3 列。
  const leads = sessions.map((s, i) => {
    const turns = s.turns ? `${s.turns}轮` : s.bubbles ? `${s.bubbles}条` : ''
    const date = fmtTime(s.updatedAt || s.startedAt).slice(5)
    return { turns, date, idx: String(i + 1).padStart(idxW, ' ') }
  })
  const leadW = Math.max(
    ...leads.map((l) => dispWidth(`${l.idx} ${'x'.repeat(agentW)} ${l.date} ${l.turns.padEnd(4)} `)),
  )
  // 终端宽度拿不到（管道 / 重定向）时按 120 列保守处理
  const cols = process.stdout.columns && process.stdout.columns > 80 ? process.stdout.columns : 120
  const titleMax = Math.max(16, cols - leadW - refW - 2)

  const rows = sessions.map((s, i) => {
    const l = leads[i]!
    // 跨仓库时必须能看出每一条属于哪个项目，否则一堆同名标题分不清
    const label = all ? `[${repoLabel(s)}]` : ''
    const budget = label ? Math.max(12, titleMax - dispWidth(label) - 1) : titleMax
    // 按**显示宽度**截断：中文占 2 列，按字符数截在中文下必然超宽
    const t = truncWidth(plain(s.title, 200), budget)
    const title = label ? `${t} ${c.dim(label)}` : t
    const head = `${l.idx} ${s.agent.padEnd(agentW)} ${l.date} ${l.turns.padEnd(4)} ${t}${label ? ` ${label}` : ''}`
    const left =
      `${c.dim(l.idx)} ${c.cyan(s.agent.padEnd(agentW))} ` +
      `${c.dim(l.date)} ${c.dim(l.turns.padEnd(4))} ${title}`
    // 标题和最新一句常常是同一句（只有 1 轮时），重复显示没意义
    const preview = s.preview && s.preview !== s.title ? truncWidth(plain(s.preview, 300), cols - leadW) : ''
    return { left, ref: refs[i]!, preview, pad: dispWidth(head) }
  })
  const w = Math.max(...rows.map((r) => r.pad), 0)
  const indent = ' '.repeat(leadW)
  for (const r of rows) {
    console.log(`${r.left}${' '.repeat(Math.max(w - r.pad, 1))}${c.cyan(r.ref)}`)
    if (r.preview) console.log(`${indent}${c.dim(r.preview)}`)
  }

  // 「怎么继续」用**最近那一条**做例子，两条路各讲一次——不必为每一行重复同样的话
  const newest = sessions[0]!
  const newestCmd = byAgent.get(newest.agent)?.resumeCmd?.(newest) || ''
  const newestRef = `${newest.agent}:${newest.id}`
  console.log('')
  console.log(c.bold('怎么继续') + c.dim('（以第 1 条为例；想弄别的会话，把引用换成对应那行即可）'))
  if (newestCmd) {
    console.log(`  ${c.dim('同一个 agent 接着聊')}`)
    console.log(`      ${c.green(newestCmd)}`)
  }
  console.log(`  ${c.dim('查看原始提问')} ${c.cyan(`ass last ${newestRef}`)}`)
  console.log(`  ${c.dim('查看完整对话')} ${c.cyan(`ass show ${newestRef} --full`)}`)
  console.log(`  ${c.dim('换个 agent 带上交接摘要')}`)
  console.log(`      ${c.green(`ass brief ${newestRef}`)} ${c.dim('  输出交接摘要，可直接粘贴')}`)
  console.log(`      ${c.dim(`或在别的 agent 里说「看下 ${newestRef} 的交接摘要」`)}`)

  console.log('')
  const taskNames = tasks.map((t) => t.name)
  console.log(c.dim('并进任务     把这段会话绑进一件事，换 agent 时一句话接上'))
  console.log(
    `${c.dim('            ')}${c.cyan(`ass task add ${taskNames[0] ?? '<你想要的名字>'} <引用>`)}   ` +
      c.dim(taskNames.length ? `任务名你起；已有的：${taskNames.join('、')}` : '还没有任务，这样写就新建一个'),
  )
  console.log(`${c.dim('            ')}${c.dim('<引用> 就用每行末尾那个，例如 ')}${c.cyan(newestRef)}`)
  console.log(
    `${c.dim('找相关会话   ')}${c.cyan('ass search <关键词>')}   ` +
      c.dim('看哪几段其实在做同一件事 —— 判断由你下，工具不猜'),
  )
  // 跨仓库时「本仓库的交接记录」没有意义，不显示
  const note = all ? null : latestNote(repoDir)
  console.log(c.dim(`交接记录     ass notes${note ? `                        上次收尾 ${fmtTime(note.entry.at)}` : ''}`))
  if (truncated) {
    const more = Math.max(limit * 4, 60)
    console.log(
      c.dim('显示上限     ') +
        c.yellow(`只显示了最近 ${limit} 个会话（还有更多）`) +
        c.dim('   看更多：') +
        c.cyan(`ass --limit ${more}`) +
        (all ? '' : c.dim('   跨仓库：') + c.cyan(`ass --all --limit ${more}`)),
    )
  }
  if (errors.length) {
    console.log('')
    console.log(c.yellow(`部分 agent 读取失败：${errors.join('; ')}`))
  }
}

function cmdList(args: Args, cfg: Config): void {
  const limit = limitOf(args, cfg)
  if (limit === null) return usageFail('--limit 需要一个正整数，例如 `ass list --limit 100`')
  const repo = (args.flags.repo as string) || (args.flags.all ? null : process.cwd())
  const { sessions: raw, errors } = listSessions(
    {
      repo,
      includeAll: Boolean(args.flags.all),
      limit: limit + 1, // 多要一条，用来判断有没有被截断
      agent: (args.flags.agent as string) || undefined,
      noCache: Boolean(args.flags['no-cache']),
    },
    cfg,
  )
  const truncated = raw.length > limit
  const sessions = truncated ? raw.slice(0, limit) : raw
  if (args.flags.json) {
    console.log(JSON.stringify(sessions, null, 2))
    return
  }
  printList(sessions, { showRepo: !repo || Boolean(args.flags.all) })
  if (truncated) {
    console.log(
      c.dim('只显示了最近 ') +
        c.yellow(String(limit)) +
        c.dim(` 个（还有更多）   看更多：`) +
        c.cyan(`ass list --limit ${Math.max(limit * 4, 60)}`),
    )
  }
  if (errors.length) console.log(c.yellow(`\n读取失败：${errors.join('; ')}`))
}

/**
 * 用户指定路径的写出口 —— 一律先过 `assertWritable`。
 *
 * 四处 `--out` 都走这里，是为了让"能不能写"只有一个判断点：
 * 会话数据的保护区由 adapter 自报 + 读即登记两条来源拼成（见 core/roguard.ts），
 * 分散判断必然漏掉某一个。
 */
function justWrite(file: string, text: string, what: string): void {
  assertWritable(file, what)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
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

  console.log(c.dim('对话记录：已解析的用户和助手消息；工具返回等部分原始日志内容可能不包含在内。'))
  const tail = args.flags.full ? undefined : Number(args.flags.tail || 6)
  const turns = readSession(found, tail ? { tail } : {})
  if (turns.length) {
    console.log('')
    console.log(c.dim(tail ? `—— 最后 ${turns.length} 条 ——` : `—— 全部 ${turns.length} 条 ——`))
    printTurns(turns)
  }
}

function cmdInputs(args: Args, cfg: Config): void {
  const ref = args.positional[0]
  if (!ref) throw new Error('请提供会话引用，例如 ass inputs claude:完整会话ID')
  if (args.flags.raw && (args.flags.round === undefined || args.flags.json)) {
    throw new Error('--raw 需要 --round <编号>，且不能与 --json 同用。')
  }
  if (args.flags.out !== undefined && typeof args.flags.out !== 'string') throw new Error('--out 需要文件路径。')
  const found = findSession(ref, cfg)
  if (!found) throw new Error(`没找到会话：${ref}`)
  const round = args.flags.round === undefined ? undefined : Number(args.flags.round)
  if (typeof args.flags.round === 'boolean') throw new Error('--round 需要输入编号。')
  const result = sessionInputs(readSession(found), round)
  const output = args.flags.json
    ? JSON.stringify({ session: found.meta.key, ...result }, null, 2)
    : args.flags.raw ? result.inputs[0]!.text : inputsMarkdown(found.meta.key, result)
  if (args.flags.out) {
    justWrite(String(args.flags.out), output, 'ass inputs --out')
    console.log(`已导出 ${result.inputs.length} 条用户输入：${args.flags.out}`)
  } else {
    process.stdout.write(output)
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
  const rawLevel = args.flags.budget
  const level = rawLevel ? parseLevel(rawLevel) : null
  if (rawLevel && !level) return usage(`--budget 只认：${LEVELS.join(' / ')}`)
  const md = buildBrief(found.meta, turns, {
    maxFiles: Number(args.flags.files || 25),
    tailMessages: Number(args.flags.tail || 4),
    guess: Boolean(args.flags.guess),
    level: level ?? undefined,
    tokens: args.flags.tokens ? Number(args.flags.tokens) : undefined,
  })
  const out = args.flags.out as string | undefined
  if (out) {
    // 用户给的路径可能是任何地方 —— 包括某个 agent 的会话文件。
    // 这一步不是形式主义：`--out ~/.claude/projects/x.jsonl` 会**静默毁掉**一条会话。
    justWrite(out, md, 'ass brief --out')
    console.log(`已写入 ${out}（${md.length} 字符，约 ${estimateTokens(md)} tokens）`)
    return
  }
  console.log(md)
}

function cmdNote(args: Args, cfg: Config): void {
  const repo = (args.flags.repo as string) || process.cwd()
  const items = CONTEXT_FLAGS.map(([flag, kind]) => ({ kind, text: String(args.flags[flag] ?? '').trim(), source: 'ass note' })).filter((x) => x.text)
  if (items.length) {
    const { added } = addContext(repo, items)
    for (const a of added) console.log(`${c.green('已记录')} ${c.dim(a.id)} [${KIND_LABEL[a.kind]}] ${a.text}`)
  }
  const found = locate(args.positional[0], cfg, repo)
  if (!found) {
    if (items.length) {
      console.log(c.dim(`\n（只记录了上下文，没有可收尾的会话。文件：${contextFile(repo)}）`))
      return
    }
    return usage('没找到可以收尾的会话。')
  }
  const turns = readSession(found)
  const saved = saveNote(found.meta, turns, args.flags.summary as string | undefined, repo)
  console.log(c.green('已保存交接记录'))
  console.log(`  来源会话   ${found.meta.key}`)
  console.log(`  文件       ${saved.file}`)
  console.log(`  下次入口   ${path.dirname(saved.latestFile)}/latest.md`)
  if (args.flags.json) console.log(JSON.stringify({ file: saved.file, slug: saved.slug }, null, 2))
}

function cmdContext(args: Args, cfg: Config): void {
  const repo = path.resolve((args.flags.repo as string) || process.cwd())
  for (const [flag] of CONTEXT_FLAGS) {
    if (args.flags[flag] !== undefined && (typeof args.flags[flag] !== 'string' || !String(args.flags[flag]).trim())) throw new Error(`--${flag} 需要笔记内容`)
  }
  const items = CONTEXT_FLAGS.map(([flag, kind]) => ({ kind, text: String(args.flags[flag] ?? '').trim(), source: 'ass', relatedTo: typeof args.flags['related-to'] === 'string' ? args.flags['related-to'] : undefined, supersedes: typeof args.flags.supersedes === 'string' ? args.flags.supersedes : undefined, session: typeof args.flags.session === 'string' ? args.flags.session : undefined })).filter((x) => x.text)

  if ((args.flags['related-to'] || args.flags.supersedes) && !items.length) throw new Error('关联或替代需要同时提供新笔记内容')
  if (['done', 'cancel', 'reopen', 'remove', 'confirm', 'review'].filter((k) => args.flags[k]).length > 1) throw new Error('每次只能选择一种状态或删除操作')
  const action = ['done', 'cancel', 'reopen', 'remove', 'confirm', 'review'].find((key) => args.flags[key] !== undefined)
  let operation: { id: string; patch: ContextPatch } | undefined
  if (action) {
    const id = args.flags[action]
    if (typeof id !== 'string' || !id.trim()) throw new Error(`--${action} 需要条目编号`)
    if (action === 'review' && typeof args.flags.result !== 'string') throw new Error('--review 需要 --result completed|partial|pending|unknown')
    operation = { id: id.trim(), patch: {
      ...(action === 'review' ? { review: String(args.flags.result) } : { [action]: true }),
      evidence: typeof args.flags.evidence === 'string' ? args.flags.evidence : undefined,
      session: typeof args.flags.session === 'string' ? args.flags.session : undefined,
    } }
  }
  const result = items.length || operation ? applyContextChange(repo, items, operation) : { added: [], skipped: 0, updated: undefined, context: readContext(repo) }
  const ctx = result.context
  if (args.flags.json) {
    console.log(JSON.stringify(ctx, null, 2))
    return
  }
  for (const item of result.added) console.log(`${c.green('已记录')} ${item.id} [${KIND_LABEL[item.kind]}] ${item.text}`)
  if (result.skipped) console.log(c.dim(`（${result.skipped} 条重复，已跳过）`))
  if (result.updated && action) {
    const labels: Record<string, string> = { done: '已完成', cancel: '已取消', reopen: '已重新打开', remove: '已删除', confirm: '已确认授权', review: '已保存核对结果' }
    console.log(`${labels[action]} ${result.updated.id} ${result.updated.text}`)
  }
  if (!ctx.entries.length) {
    console.log(c.dim('这个仓库还没有记录任何决策 / 踩坑 / 约束 / 待办。'))
    console.log('')
    console.log(c.dim('agent 干活时应该顺手记（MCP 工具 session_remember），你也可以手敲：'))
    console.log('')
    console.log(`  ass context --decision "token 改用 refresh 轮换，因为旧接口不支持并发刷新"`)
    console.log(`  ass context --dead-end  "在 middleware 里刷新会死循环，已验证不可行"`)
    console.log(`  ass context --constraint "不要改旧版 SSO 的接口"`)
    console.log(`  ass context --todo      "需求 5：首页表格换虚拟滚动"`)
    console.log('')
    console.log(c.dim(`文件：${contextFile(repo)}`))
    return
  }
  console.log(contextMarkdown(repo, { includeDone: Boolean(args.flags.all), chars: args.flags.details ? undefined : 160 }))
  console.log('')
  const visible = ctx.entries.filter((e) => args.flags.all || (!e.done && !e.cancelled && !e.supersededBy))
  console.log(c.dim(`显示 ${visible.length} / 共 ${ctx.entries.length} 条 · ${contextFile(repo)}`))
  if (!args.flags.details && visible.some((e) => e.text.length > 160 || e.text.includes('\n'))) console.log(c.dim('长笔记仅显示截短预览；完整内容：ass context --details（包含已完成项再加 --all）'))
  const pending = ctx.entries.find((e) => e.kind === 'todo' && !e.done && !e.cancelled)
  if (pending) {
    console.log(c.dim(`标记待办完成：ass context --done ${pending.id}（手动标记，不等同于核对）`))
    console.log(c.dim(`核对进展：ass context --review ${pending.id} --result completed|partial|pending|unknown --evidence "代码或测试依据"`))
  }
  const unconfirmed = ctx.entries.find((e) => !e.cancelled && !e.done && (e.kind === 'suggestion' || (e.kind === 'todo' && !e.authorization)))
  if (unconfirmed) console.log(c.dim(`已有用户授权时记录：ass context --confirm ${unconfirmed.id} --evidence "用户授权原话"`))
  console.log(c.dim(`删除记录：ass context --remove ${ctx.entries[0]!.id}    包含已完成、取消及被替代记录：ass context --all`))
  console.log(c.dim('找回原始提问：ass last <会话引用>    阅读完整对话：ass show <会话引用> --full'))
}

async function cmdHook(args: Args, cfg: Config): Promise<void> {
  const action = args.positional[0] || 'status'
  if (action === 'run') {
    const agent = typeof args.flags.agent === 'string' ? args.flags.agent : ''
    let input: any
    try {
      if (!agent) throw new Error('hook run 需要 --agent')
      input = await readHookInput()
      const result = runHook(agent, input, cfg)
      // Hook stdout is protocol output, not human progress text. Never request another turn.
      console.log('{}')
      console.error(`[ass hook] ${result.status}: ${result.file}`)
    } catch (error) {
      try { recordHookFailure(agent || 'unknown', error, { session: typeof (input?.conversation_id ?? input?.session_id) === 'string' ? `${agent}:${input.conversation_id ?? input.session_id}` : undefined, event: typeof input?.hook_event_name === 'string' ? input.hook_event_name : undefined }) } catch (diagnosticError) { console.error(`无法保存 hook 诊断：${String(diagnosticError)}`) }
      console.error(`[ass hook] ${error instanceof Error ? error.message : String(error)}`)
      console.log('{}')
      process.exitCode = 1
    }
    return
  }
  if (action === 'retry') {
    const ref = typeof args.flags.session === 'string' ? args.flags.session : ''
    const match = /^([a-z0-9_-]+):(.+)$/i.exec(ref)
    if (!match) throw new Error('重试需要完整引用：ass hook retry --session agent:完整会话ID')
    try {
      const result = runHook(match[1]!, { session_id: match[2], hook_event_name: 'manual' }, cfg)
      console.log(args.flags.json ? JSON.stringify(result, null, 2) : `${result.status} · ${result.file}`)
    } catch (error) {
      try { recordHookFailure(match[1]!, error, { session: ref, event: 'manual' }) } catch { /* main reports original error */ }
      throw error
    }
    return
  }
  if (action === 'status') {
    const status = hookStatus()
    if (args.flags.json) console.log(JSON.stringify(status, null, 2))
    else {
      console.log('自动交接钩子')
      for (const c of status.configs) console.log(`  ${c.agent}: ${c.installed ? '已配置' : '未完整配置'} · ${c.file}${'error' in c ? ' · ' + c.error : ''}`)
      console.log(`最近执行（最多 50 次）：${status.stateFile}`)
      for (const r of status.recent.slice(-10)) console.log(`  ${fmtTime(r.at)} ${r.agent} ${r.status} ${r.session || ''} ${r.error || r.file || ''}`)
      console.log('安装预览：ass hook install --agent claude --dry-run（也支持 cursor）；卸载：ass hook uninstall --agent claude')
      console.log('失败重试：ass hook retry --session agent:完整会话ID')
    }
    return
  }
  if (action !== 'install' && action !== 'uninstall') throw new Error('用法：ass hook install|uninstall|status|run|retry')
  const requested = args.flags.agent
  if (requested !== undefined && requested !== 'claude' && requested !== 'cursor') throw new Error('自动安装支持 --agent claude 或 cursor；其他 agent 可手工接入 hook run')
  const agents: HookAgent[] = requested ? [requested as HookAgent] : ['claude', 'cursor']
  const results = agents.map(agent => configureHooks(agent, action, Boolean(args.flags['dry-run'])))
  if (args.flags.json) console.log(JSON.stringify(results, null, 2))
  else for (const r of results) console.log(`${r.agent}: ${r.action} · ${r.file}${'backup' in r && r.backup ? ' · 备份 ' + r.backup : ''}`)
}

// ---------------------------------------------------------------- 任务

/**
 * 操作失败：短错误 + 非零退出码。
 * 和 usage() 的区别：usage 是「你用法写错了」，打整篇帮助；
 * 这个只是「没办成」（任务名找不到、会话找不到），打整篇帮助会把真正的原因淹掉，
 * 而且脚本里 `ass resume X || ...` 需要非零退出码才判得出来。
 */
function fail(msg: string, hint?: string): void {
  console.log(c.yellow(msg))
  if (hint) console.log(c.dim(hint))
  process.exitCode = 1
}

/** 用法错误：打整篇帮助 + 非零退出码（`usage()` 本身不改退出码，这里补上） */
function usageFail(msg: string): void {
  process.exitCode = 1
  usage(msg)
}

/** 一行式概览（去掉 id 前缀，列表里 id 单独上色） */
function taskBits(t: TaskRecord): string {
  return taskSummary(t)
}

function printTaskView(v: TaskView): void {
  const head = [`${v.sessions} 个会话`, v.chain.join('→')]
  if (v.status === 'done') head.push('已完成')
  console.log(`${c.bold('工作任务')} ${c.cyan(v.name)}  ${c.dim(head.filter(Boolean).join(' · '))}`)
  console.log(c.dim('─'.repeat(48)))

  if (v.goal) {
    console.log(`${c.bold(taskGoalLabel(v.goal))}${v.goal.from ? c.dim(`（${v.goal.from}）`) : ''}`)
    console.log(`  ${v.goal.text}`)
    console.log(c.dim(`  来源：${taskGoalSource(v.goal)}`))
    console.log('')
  }

  if (v.decisions.length) {
    console.log(c.bold('决策'))
    const multi = new Set(v.decisions.map((d) => path.basename(d.repo))).size > 1
    for (const d of v.decisions.slice(0, 6)) {
      const tag = d.kind === 'dead-end' ? c.dim('，已排除') : d.kind === 'constraint' ? c.dim('（约束）') : ''
      const repoTag = multi ? c.dim(` [${path.basename(d.repo)}]`) : ''
      console.log(`  ${c.dim('·')} ${d.text}${tag} ${c.cyan(d.id)}${repoTag}`)
    }
    if (v.decisions.length > 6) console.log(c.dim(`  … 其余 ${v.decisions.length - 6} 条见 ass context`))
    console.log('')
  }

  if (v.segments.length) {
    console.log(c.bold('各段进展'))
    v.segments.forEach((s, i) => {
      const bits: string[] = []
      if (s.label) bits.push(s.label)
      else if (s.title) bits.push(plain(s.title, 40))
      const state = s.note || s.fallback
      if (state) bits.push(c.dim(`— ${state}`))
      const flags: string[] = []
      if (s.current) flags.push(c.green('当前'))
      if (!s.live) flags.push(c.yellow('会话已不可读'))
      console.log(`  ${i + 1}. ${c.cyan(s.ref.padEnd(18))} ${bits.join(' ')}${flags.length ? `（${flags.join(' · ')}）` : ''}`)
    })
    console.log('')
  } else {
    console.log(c.dim(`提示：ass task add ${v.name} 把会话绑进来`))
    console.log('')
  }

  if (v.todos.length) {
    console.log(c.bold('待办'))
    for (const t of v.todos.slice(0, 8)) {
      console.log(`  ${t.done ? c.dim('☑') : '☐'} ${t.done ? c.dim(t.text) : t.text} ${c.dim(t.id)}`)
      console.log(c.dim(`    授权：${t.authorization ? '已确认 · ' + t.authorization.evidence : '未记录，不代表用户已同意修改'}`))
      const review = t.reviews?.[t.reviews.length - 1]
      if (review) console.log(c.dim(`    核对记录：${REVIEW_LABEL[review.result]} · ${fmtTime(review.at)} · ${review.evidence}`))
    }
    if (v.totalTodos > 8) console.log(c.dim(`  … 其余 ${v.totalTodos - 8} 条见 ass context`))
    console.log('')
  }

  if (v.staleCount) {
    console.log(c.yellow(`${v.staleCount} 段对应的会话已经读不到了（数据来自绑定时留下的快照）。`))
    console.log(c.dim(`清理：ass task rm ${v.name} <引用>`))
    console.log('')
  }
  console.log(c.dim(`继续：新 agent 里说「继续 ${v.name}」，它会自己取这份上下文；`))
  console.log(c.dim(`      或 ass resume ${v.name} --save 存成本仓库的交接记录`))
}

function taskNamesHint(): string {
  const all = taskList({ includeDone: true })
  return all.length ? `（已有：${all.map((t) => t.name).join('、')}）` : '（还没有任何任务）'
}

function cmdResume(args: Args, cfg: Config): void {
  const ref = args.positional[0]
  let view: TaskView | null = null

  if (ref) {
    view = taskView(ref, cfg)
    if (!view) return fail(`没找到任务：${ref}`, taskNamesHint())
  } else {
    // 不给任务名：本仓库正好有一个进行中的就直出，多个就让人选
    const mine = taskList({ repo: process.cwd() })
    if (mine.length === 1) {
      view = taskView(mine[0]!.id, cfg)
    } else {
      const list = mine.length ? mine : taskList()
      if (!list.length) return fail('还没有任何任务。', '先绑一个：ass task add <任务名>')
      fail(mine.length ? `这个仓库有 ${mine.length} 个进行中的任务，需要指定一个。` : '这个仓库没有进行中的任务。全部任务：')
      console.log('')
      for (const t of list) console.log(`  ${c.cyan(t.id)} ${t.name}  ${c.dim(taskBits(t))}`)
      console.log('')
      console.log(c.dim(`例如：ass resume ${list[0]!.name}`))
      return
    }
  }
  if (!view) return usage(`没找到任务：${ref}`)

  if (args.flags.json) {
    console.log(JSON.stringify(view, null, 2))
    return
  }

  const md = taskResumeMarkdown(view)
  const out = args.flags.out as string | undefined
  if (out) {
    const file = path.resolve(out)
    justWrite(file, md, 'ass resume --out')
    console.log(c.green(`已写入 ${file}`) + c.dim(`（${md.length} 字符）`))
    return
  }
  if (args.flags.md) {
    console.log(md)
    return
  }
  if (args.flags.save) {
    const repo = view.segments.find((s) => s.repo)?.repo || view.repo
    if (!repo) return fail('这个任务没关联任何仓库。', '先 `ass task add` 绑一个会话。')
    const saved = saveNoteMd({ repo, md, key: `task:${view.id}`, title: view.name })
    console.log(c.green('已存成本仓库的交接记录'))
    console.log(`  ${c.dim('文件')}     ${saved.latestFile}`)
    console.log(c.dim('  效果     下次任何 agent 一进这个仓库，ass / session_status 就会显示这份任务总览'))
    return
  }
  printTaskView(view)
}

function cmdTask(args: Args, cfg: Config): void {
  const sub = args.positional[0]
  const rest = args.positional.slice(1)
  switch (sub) {
    case undefined:
    case 'list':
    case 'ls':
      return cmdTaskList(args)
    case 'new':
    case 'create':
      return cmdTaskNew(args, rest[0])
    case 'add':
    case 'bind':
      return cmdTaskAdd(args, cfg, rest)
    case 'note':
      return cmdTaskNote(args, rest)
    case 'rm':
    case 'remove':
    case 'del':
      return cmdTaskRm(args, rest)
    case 'done':
      return cmdTaskDone(args, rest)
    default:
      return usageFail(`未知的子命令：task ${sub}`)
  }
}

function cmdTaskList(args: Args): void {
  const all = Boolean(args.flags.all)
  const tasks = taskList({ repo: all ? null : process.cwd(), includeDone: all })
  if (args.flags.json) {
    console.log(JSON.stringify(tasks, null, 2))
    return
  }
  if (!tasks.length) {
    console.log(c.dim(all ? '还没有任何任务。' : '这个仓库还没有任务。'))
    console.log(c.dim(`绑一个：ass task add <任务名>       看全部仓库：ass task --all`))
    return
  }
  for (const t of tasks) console.log(`  ${c.cyan(t.id)} ${t.name}  ${c.dim(taskBits(t))}`)
  console.log('')
  console.log(c.dim(`看总览：ass resume <任务>      连已完成的也列：ass task --all`))
}

function cmdTaskNew(args: Args, name: string | undefined): void {
  if (!name) return usageFail('用法：ass task new <名字> [--goal "原始目标"]')
  const goal = typeof args.flags.goal === 'string' ? args.flags.goal : undefined
  const repo = path.resolve((args.flags.repo as string) || process.cwd())
  const r = taskCreate({ name, goal, repo })
  if (args.flags.json) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  console.log(r.created ? `${c.green('已新建任务')} ${c.cyan(r.task.id)} ${c.bold(r.task.name)}` : `${c.yellow('已存在同名任务')} ${c.cyan(r.task.id)} ${r.task.name}`)
  console.log(c.dim(`  ${taskBits(r.task)}`))
  console.log('')
  console.log(c.dim(`绑会话进来：ass task add ${r.task.name}`))
}

function cmdTaskAdd(args: Args, cfg: Config, rest: string[]): void {
  const name = rest[0]
  if (!name) return usageFail('用法：ass task add <任务名> [会话引用] [--label "需求 4-5"] [--note "卡在退款回调"]')
  const repo = path.resolve((args.flags.repo as string) || process.cwd())
  const ref = rest[1]

  let found = ref ? findSession(ref, cfg) : null
  if (!ref) {
    const cur = currentSession(repo, cfg)
    found = cur?.found ?? null
    if (cur?.stale) console.log(c.dim('（这是本仓库最近的会话；如果不对，显式给一个引用）'))
  }
  if (!found) {
    return fail(
      ref ? `没找到会话：${ref}` : '这个仓库还没有会话记录。',
      ref ? undefined : `等第一条消息落盘后再试，或显式给引用：ass task add ${name} <引用>`,
    )
  }

  const str1 = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const r = taskAttach({
    task: name,
    meta: found.meta,
    label: str1(args.flags.label),
    note: str1(args.flags.note),
    goal: str1(args.flags.goal),
    repo,
  })

  if (args.flags.json) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  if (r.created) console.log(`${c.green('已新建任务')} ${c.cyan(r.task.id)} ${c.bold(r.task.name)}`)
  console.log(
    r.added
      ? `${c.green('已绑定')} ${c.cyan(found.meta.key)} ${c.dim(`（第 ${r.index + 1} 段）`)}`
      : `${c.green('已更新')} 这个会话已经在任务里 ${c.dim(`（第 ${r.index + 1} 段）`)}`,
  )
  console.log(c.dim(`  ${found.meta.agentLabel} · ${plain(found.meta.title, 50)}`))
  console.log('')
  console.log(c.dim(`看总览：ass resume ${r.task.name}`))
}

function cmdTaskNote(args: Args, rest: string[]): void {
  const name = rest[0]
  const note = typeof args.flags.note === 'string' ? args.flags.note : undefined
  if (!name || !note) return usageFail('用法：ass task note <任务名> [会话引用] --note "卡在退款回调"')
  const r = taskSetNote(name, rest[1] ?? null, note)
  if (!r) return fail(`没找到任务或那一段：${name}`, taskNamesHint())
  if (args.flags.json) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  console.log(`${c.green('已更新进展')} ${c.cyan(r.id)} ${r.name}  ${c.dim(note)}`)
}

function cmdTaskRm(args: Args, rest: string[]): void {
  const name = rest[0]
  const which = rest[1]
  if (!name) return usageFail('用法：ass task rm <任务名> [会话引用]    （不给引用 = 删掉整个任务）')

  // 破坏性操作只认完整名字或 tN —— 不做模糊匹配
  const t = findTask(name, { fuzzy: false })
  if (!t) return fail(`没找到任务：${name}`, `${taskNamesHint()}删除只认完整名字或 tN（不支持模糊匹配）`)

  if (!which) {
    const gone = taskRemove(t.id)
    if (!gone) return fail(`删除失败：${name}`)
    if (args.flags.json) {
      console.log(JSON.stringify(gone, null, 2))
      return
    }
    console.log(`${c.yellow('已删除任务')} ${c.cyan(gone.id)} ${gone.name} ${c.dim(`（${gone.sessions.length} 段）`)}`)
    return
  }

  const out = taskDetach(t.id, which)
  if (!out?.removed) return fail(`任务「${t.name}」里没有这一段：${which}`)
  if (args.flags.json) {
    console.log(JSON.stringify(out, null, 2))
    return
  }
  console.log(`${c.yellow('已解绑')} ${c.cyan(out.removed.key)} ${c.dim(`（${t.name} 还剩 ${out.task.sessions.length} 段）`)}`)
}

function cmdTaskDone(args: Args, rest: string[]): void {
  const name = rest[0]
  if (!name) return usageFail('用法：ass task done <任务名>    （再执行一次 = 重新打开）')
  const t = findTask(name, { fuzzy: false })
  if (!t) return fail(`没找到任务：${name}`, `${taskNamesHint()}这个操作只认完整名字或 tN`)
  const r = taskSetStatus(t.id, t.status === 'done' ? 'active' : 'done')
  if (!r) return fail(`操作失败：${name}`)
  if (args.flags.json) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  console.log(`${c.green(r.status === 'done' ? '已标记完成' : '已重新打开')} ${c.cyan(r.id)} ${r.name}`)
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
  console.log(c.dim('MCP 已写进上面所有已安装的 agent（含 Cursor / Kiro），重启对应 agent 就能调用 session_* 工具。'))
  console.log('')
  console.log(
    c.bold('规则块') +
      c.dim('（开场该主动做什么的约定）只自动写进了 claude / codex / opencode。另外两个得手工：'),
  )
  console.log(`  ${c.cyan('Cursor')}   ${c.dim('Settings → Rules 里贴下面那条命令的输出；或在这个项目里跑 ass init（写 .cursor/rules/）')}`)
  console.log(`  ${c.cyan('Trae')}     ${c.dim('贴到它的规则设置里')}`)
  console.log(`  ${c.dim('原文：')}${c.green('ass rules')}`)
}

function cmdUninstall(args: Args): void {
  const steps = uninstallAll({ dryRun: Boolean(args.flags['dry-run']) })
  printSteps(`${args.flags['dry-run'] ? '[dry-run] ' : ''}agent-session-sync uninstall`, steps)
  console.log('')
  console.log(c.dim('会话数据（缓存 / 附件 / 交接记录）没有被删除，需要的用 ass notes 找回。'))
}

/**
 * MCP 配置本身——和 `ass rules`（规则原文）对称：
 * 不带参数就把配置内容打出来，给 Trae 这类只能手工贴的 agent 用；
 * `--write` 则直接在**当前工程**里创建，解决 Cursor 这种没有用户级全局 MCP 文件、
 * 而 `ass install` 又按设计不创建 agent 配置目录的情况。
 */
function cmdMcp(args: Args): void {
  if (args.flags.write) {
    const dir = path.resolve(args.positional[0] || process.cwd())
    const dry = Boolean(args.flags['dry-run'])
    const only = typeof args.flags.agent === 'string' ? args.flags.agent : undefined
    const steps = args.flags.undo
      ? uninstallProjectMcp(dir, { dryRun: dry })
      : installProjectMcp(dir, { dryRun: dry, only })
    printSteps(`${dry ? '[dry-run] ' : ''}项目级 MCP 配置 → ${dir}`, steps)
    if (!dry) {
      console.log('')
      console.log(c.dim('重启该 agent（或重新打开这个项目）后生效。不想要了：ass mcp --write --undo'))
    }
    return
  }

  console.log(c.bold('MCP 配置内容') + c.dim('   （能自动写的 agent 直接看下面第二条命令）'))
  console.log('')
  console.log(mcpConfigJson())
  console.log('')
  console.log(c.bold('放到哪里'))
  for (const t of PROJECT_MCP_TARGETS) {
    console.log(`  ${c.cyan(t.label.padEnd(12))} ${t.rel}   ${c.dim('（项目里，打开这个项目就生效）')}`)
  }
  console.log(`  ${c.cyan('Trae 等'.padEnd(11))} ${c.dim('在 IDE 的 MCP 设置里手工添加，内容就是上面那段 JSON')}`)
  console.log('')
  console.log(c.dim('自动创建   ass mcp --write                在当前工程写上面那些文件'))
  console.log(c.dim('           ass mcp --write --dry-run      只看不改'))
  console.log(c.dim('           ass mcp --write --undo         撤销（只摘我们那一项）'))
  console.log(c.dim('用户级     ass install                     Claude Code / Codex / OpenCode / Kiro'))
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

  // 只读自证：本次进程读过的源文件是否原样未动。
  // 注意它证明的是"**我们**没动过"，不是"没人动过" —— 后者不在这个进程的职责内。
  const g = guardSummary()
  console.log('')
  console.log(c.bold('源数据保护'))
  console.log(`  受保护区    ${g.roots} 处${g.roots ? c.dim('（用 `ass doctor --paths` 看清单）') : ''}`)
  console.log(`  已读源文件  ${g.opened} 个（均已留指纹）`)
  // 「正在使用的会话」单列：那些文件本来就一直在被追加，混进来会让这个信号恒亮、等于没有
  const active = g.active ? c.dim(`（另有 ${g.active} 个是正在使用的会话，仍在被写，不计）`) : ''
  console.log(
    g.changed === 0
      ? `  变更自证    ${c.green('本次运行未改动任何源数据')} ${active}`
      : `  变更自证    ${c.yellow(`${g.changed} 个文件在读后被改动，且不是活跃会话`)} ${active}`,
  )
  if (args.flags.paths) {
    for (const p of protectedPaths()) console.log(`    ${c.dim(p.path)}  ${c.dim(`— ${p.why}`)}`)
  }
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
  ass inputs <引用>        所有用户输入全文（--round 3 选一条；--raw 纯正文；--out 文件；--json）
  ass last [引用]           把最后一问原样搬过来（--rounds 3 连问多轮，含图片落盘）
  ass brief [引用]          生成交接摘要 Markdown（--out 文件.md，--tail 4，--files 25）
                          --guess 额外附上「从对话里猜的决策/踩坑」（默认关，不准）
                          --budget tiny|small|standard|large|full  按上下文预算自适应裁剪
                          --tokens 6000 直接给 token 上限（覆盖 --budget）
  ass note [引用]           收尾：把摘要存进本仓库，下次任何 agent 进来都能看到
  ass context             看/记 决策·踩坑·约束·待办（--decision/--dead-end/--constraint/--todo）
                          标记完成 --done <编号>，删除 --remove <编号>，包含已完成 --all，完整笔记 --details；来源会话 --session <引用>
                          关联记录 --related-to <编号>，新决策替代旧决策 --supersedes <编号>
                          取消待办 --cancel <编号>，重新打开 --reopen <编号>
                          建议 --suggestion "内容"；确认 --confirm <编号> --evidence "用户授权原话"
                          核对 --review <编号> --result completed|partial|pending|unknown --evidence "代码/测试依据"
  ass notes                已保存的交接记录列表

${c.bold('工作任务')}（把跨 agent 的多段会话绑成一件事）
  ass resume [任务]        任务总览：原始目标 / 决策 / 各段进展 / 待办
                          --save 存成本仓库的交接记录，--md 输出 Markdown，--out 文件.md，--json
  ass task                 列出本仓库的任务（--all 跨仓库且含已完成）
  ass task new <名字>      新建任务（--goal "原始目标"）
  ass task add <任务> [引用]  把会话绑进来（--label "需求 4-5"，--note "卡在退款回调"）
                          不给引用 = 本仓库最近的会话
  ass task note <任务> [引用] --note "…"     更新某一段的进展
  ass task rm <任务> [引用]  解绑一段；不给引用 = 删掉整个任务（只认完整名字 / tN）
  ass task done <任务>     标记完成（再执行一次 = 重新打开）

${c.bold('接入 / 维护')}
  ass hook install         安装自动交接（--agent claude|cursor，--dry-run）
  ass hook uninstall       卸载本工具钩子，保留其他配置
  ass hook status          查看配置及最近执行结果（--json）
  ass hook retry --session agent:id  按完整会话引用重试保存
  ass hook run --agent X   从 stdin 接收 JSON，按完整会话 ID 保存交接
  ass install              把 MCP + 规则写进本机各 agent（--dry-run 只看不改）
  ass rules                打印规则原文（Cursor/Trae 这些要手工贴的用）
  ass mcp                  打印 MCP 配置内容 + 该放到哪；--write 在当前工程自动创建
                           （按需写入项目配置，方便团队共享）
                           --write --dry-run 只看不改，--write --undo 撤销
  ass uninstall            摘掉 MCP + 规则（不动你的会话数据）
  ass init [目录]          项目级注入规则（--dry-run / --undo）
  ass agents               探测到哪些 agent、数据源在哪、MCP 是否已接入
  ass detect               自检索：扫盘找出本机所有可能的 agent（--write 写入配置草案）
  ass repos                有历史的仓库列表
  ass config [--init]      打印/初始化配置文件
  ass doctor               自检（--paths 看受保护区清单 + 只读变更自证）

${c.bold('引用')}
  #1                      上一次 list 的第 1 条（注意：跨进程不稳，任务里请用下面两种）
  claude:31c5af10         agent:会话id 前缀
  点击穿透                 标题里包含这段文字
  t3 / 支付重构            任务（ass task / ass resume 用）
`)
}

async function main(): Promise<void> {
  maybeReexec()
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return usage()
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(`agent-session-sync ${pkgVersion()}`)
    return
  }
  const args = parseArgs(argv)
  const cfg = loadConfig()
  // 开跑前先把受保护区武装起来：边界来自每个 adapter 自报的数据源。
  // 放在 switch 之前，是为了让**任何**命令的写路径都被同一套边界约束。
  try {
    armGuard(buildAdapters(cfg, { includeUnavailable: true }))
  } catch {
    /* 边界拿不到不该让命令跑不起来 */
  }
  switch (args.cmd) {
    case 'hook':
      return cmdHook(args, cfg)
    case 'status':
      return cmdStatus(args, cfg)
    case 'list':
    case 'ls':
      return cmdList(args, cfg)
    case 'show':
      return cmdShow(args, cfg)
    case 'inputs':
      return cmdInputs(args, cfg)
    case 'last':
      return cmdLast(args, cfg)
    case 'brief':
      return cmdBrief(args, cfg)
    case 'note':
      return cmdNote(args, cfg)
    case 'notes':
      return cmdNotes(args)
    case 'context':
    case 'ctx':
      return cmdContext(args, cfg)
    case 'resume':
      return cmdResume(args, cfg)
    case 'task':
    case 'tasks':
      return cmdTask(args, cfg)
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
    case 'rules':
      console.log(rulesBlock())
      return
    case 'mcp':
      return cmdMcp(args)
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
  await main()
} catch (e) {
  console.error(c.yellow(`出错了：${e instanceof Error ? e.message : String(e)}`))
  process.exitCode = 1
}

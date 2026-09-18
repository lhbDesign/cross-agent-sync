import type { Adapter } from '../types'
import type { Config } from '../config'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { opencodeAdapter } from './opencode'
import { cursorAdapter } from './cursor'
import { makeCustomAdapter } from './generic'

/** 内置 adapter：按「用的人多」排序 */
export const BUILTIN: Adapter[] = [claudeAdapter, codexAdapter, cursorAdapter, opencodeAdapter]

/**
 * 组装本次要用的 adapter 列表：
 *   - 内置中 available() 为 true 的（"自检索"）；
 *   - 去掉配置里显式关闭的（agents: { cursor: false }）；
 *   - 只留白名单里的（only: ['claude','codex']）；
 *   - 加上用户自定义的（customAgents）。
 */
export function buildAdapters(cfg: Config, opts: { includeUnavailable?: boolean; only?: string } = {}): Adapter[] {
  const out: Adapter[] = []
  const only = opts.only ? [opts.only] : cfg.only
  for (const a of BUILTIN) {
    if (only?.length && !only.includes(a.id)) continue
    if (cfg.agents?.[a.id] === false) continue
    if (!opts.includeUnavailable && !a.available()) continue
    out.push(a)
  }
  for (const c of cfg.customAgents || []) {
    if (only?.length && !only.includes(c.id)) continue
    if (cfg.agents?.[c.id] === false) continue
    const a = makeCustomAdapter(c)
    if (!opts.includeUnavailable && !a.available()) continue
    out.push(a)
  }
  return out
}

import path from 'node:path'
import { HOME } from '../util'
import { makeClaudeFamilyAdapter } from './claude'

/**
 * CodeBuddy（腾讯）：CodeBuddy Code CLI 的本地会话。
 *
 * 官方 CLI 把会话写成和 Claude Code 兼容的 JSONL：
 *   <config>/projects/<mangled-cwd>/<session-id>.jsonl
 *   <config>/projects/<mangled-cwd>/<session-id>.meta.json
 * 默认 <config> = ~/.codebuddy，可用 CODEBUDDY_CONFIG_DIR 覆盖。
 *
 * 注意：CodeBuddy CN 的 IDE 版是云端优先，.vscdb 里通常只有会话索引/元数据，
 * 正文在服务端；这里只读本地 JSONL，不假装能读云端内容。
 */
const CONFIG_DIR = process.env.ASS_CODEBUDDY_HOME || process.env.CODEBUDDY_CONFIG_DIR || path.join(HOME, '.codebuddy')
const PROJECTS = process.env.ASS_CODEBUDDY_DIR || path.join(CONFIG_DIR, 'projects')

export const codebuddyAdapter = makeClaudeFamilyAdapter({
  id: 'codebuddy',
  label: 'CodeBuddy',
  roots: [PROJECTS],
  hint: `CodeBuddy CLI 的会话在 ${PROJECTS}（Claude 兼容 JSONL）；IDE 版的云端会话可能不在本地。`,
})

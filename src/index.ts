/**
 * agent-session-sync —— 跨 agent 会话同步的编程式 API。
 *
 * 用法：
 *   import { listSessions, findSession, readSession } from 'agent-session-sync'
 */
export type {
  Adapter,
  AdapterCtx,
  FilePart,
  ImagePart,
  ListOptions,
  ReadOptions,
  Role,
  SessionMeta,
  Turn,
} from './types'

export {
  CONFIG_DIR,
  DATA_DIR,
  CACHE_DIR,
  HANDOFF_DIR,
  ATTACH_DIR,
  configPath,
  ensureConfig,
  expandPath,
  loadConfig,
  saveConfig,
} from './config'
export type { Config, CustomAgent } from './config'

export { BUILTIN, buildAdapters } from './adapters/registry'
export { claudeAdapter } from './adapters/claude'
export { codexAdapter } from './adapters/codex'
export { cursorAdapter } from './adapters/cursor'
export { opencodeAdapter } from './adapters/opencode'
export { makeCustomAdapter } from './adapters/generic'

export {
  agentStatus,
  describeSession,
  findSession,
  listSessions,
  readSession,
  resolveRef,
} from './core/store'
export type { FoundSession, ListResult } from './core/store'

export { saveImages, toDataUrl } from './core/attach'

export { buildBrief, buildSummary, extractDecisions, extractNextSteps, pickFiles } from './core/brief'
export type { BriefOptions } from './core/brief'
export { latestNote, listNotes, saveNote } from './core/handoff'
export {
  addContext,
  contextFile,
  contextLine,
  contextMarkdown,
  contextStats,
  KIND_LABEL,
  readContext,
  repoSlug,
  updateContext,
} from './core/context'
export type { ContextEntry, ContextKind, ContextStats, RepoContext } from './core/context'
export type { NoteEntry, SavedNote } from './core/handoff'
export { formatSearchResult, searchSessions } from './core/search'
export type { SearchHit, SearchResult } from './core/search'

export { applyDetected, detectSources } from './detect'
export type { Detected } from './detect'

export {
  deinitProject,
  detectAgents,
  doctor,
  initProject,
  installAll,
  mcpEntry,
  mcpScript,
  rulesBlock,
  uninstallAll,
} from './install'

export { cleanUserText, gitRoot, isInjected, parseDataUrl, plain, projectName, sameRepo } from './util'

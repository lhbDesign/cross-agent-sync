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
  TASK_DIR,
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
export {
  DEFAULT_LEVEL,
  LEVELS,
  LEVEL_TOKENS,
  TIER_LABEL,
  budgetFooter,
  estimateTokens,
  fitSections,
  levelTokens,
  parseLevel,
} from './core/budget'
export type { BudgetLevel, BudgetSection, FitResult, Tier } from './core/budget'
export {
  addProtectedPath,
  armGuard,
  assertWritable,
  guardSummary,
  noteSourceRead,
  openSource,
  protectedBy,
  protectedPaths,
  resetGuard,
  verifyUnchanged,
} from './core/roguard'
export type { Change, Fp, GuardSummary } from './core/roguard'
export { latestNote, listNotes, saveNote, saveNoteMd } from './core/handoff'
export type { SaveNoteMdInput } from './core/handoff'
export {
  addContext,
  contextFile,
  contextLine,
  contextMarkdown,
  contextStats,
  KIND_LABEL,
  readContext,
  repoSlug,
  applyContextChange,
  updateContext,
} from './core/context'
export type { ContextEntry, ContextKind, ContextStats, ContextPatch, RepoContext } from './core/context'
export {
  currentSession,
  findTask,
  normalizeName,
  readTasks,
  taskAttach,
  taskChain,
  taskCreate,
  taskDetach,
  taskLine,
  taskList,
  taskMatchesRepo,
  taskRemove,
  taskResumeMarkdown,
  taskSetNote,
  taskSetStatus,
  taskSummary,
  taskView,
  writeTasks,
  TASK_FILE,
  TASK_VERSION,
} from './core/task'
export type {
  FindTaskOptions,
  TaskAttachInput,
  TaskAttachResult,
  TaskDecision,
  TaskFile,
  TaskRecord,
  TaskSegment,
  TaskSession,
  TaskStatus,
  TaskView,
} from './core/task'
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
  installProjectMcp,
  mcpConfigJson,
  mcpEntry,
  mcpScript,
  PROJECT_MCP_TARGETS,
  rulesBlock,
  uninstallAll,
  uninstallProjectMcp,
} from './install'

export { cleanUserText, dispWidth, gitRoot, isInjected, parseDataUrl, plain, projectName, sameRepo, truncWidth } from './util'

export { configureHooks, hookStatus, runHook, recordHookFailure } from './hooks'
export type { HookAgent, HookResult } from './hooks'

export { sessionInputs, inputsMarkdown } from './core/inputs'

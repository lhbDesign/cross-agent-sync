const { contextBridge, ipcRenderer } = require('electron')

/**
 * 暴露给渲染进程的窄 API。
 * 渲染层拿不到 Node、拿不到 fs，只能调用下面这些固定通道。
 */
contextBridge.exposeInMainWorld('ass', {
  boot: () => ipcRenderer.invoke('ass:boot'),
  repos: (force) => ipcRenderer.invoke('ass:repos', { force }),
  disk: (force) => ipcRenderer.invoke('ass:disk', { force }),

  project: (repo) => ipcRenderer.invoke('ass:project', { repo }),
  sessions: (repo, opts) => ipcRenderer.invoke('ass:sessions', { repo, ...(opts || {}) }),
  tasks: (repo, all) => ipcRenderer.invoke('ass:tasks', { repo, all }),
  taskView: (repo, name) => ipcRenderer.invoke('ass:taskView', { repo, name }),
  sessionDetail: (repo, key) => ipcRenderer.invoke('ass:sessionDetail', { repo, key }),
  brief: (repo, ref) => ipcRenderer.invoke('ass:brief', { repo, ref }),
  search: (q, repo) => ipcRenderer.invoke('ass:search', { q, repo }),

  ctxAdd: (repo, kind, text) => ipcRenderer.invoke('ass:ctxAdd', { repo, kind, text }),
  ctxDone: (repo, id) => ipcRenderer.invoke('ass:ctxDone', { repo, id }),
  taskNew: (repo, name, goal) => ipcRenderer.invoke('ass:taskNew', { repo, name, goal }),
  taskAdd: (repo, name, ref, label, note) => ipcRenderer.invoke('ass:taskAdd', { repo, name, ref, label, note }),
  note: (repo, ref, summary) => ipcRenderer.invoke('ass:note', { repo, ref, summary }),

  pickDirectory: () => ipcRenderer.invoke('ass:pickDirectory'),
  openDataDir: () => ipcRenderer.invoke('ass:openDataDir'),
  reveal: (p) => ipcRenderer.invoke('ass:reveal', { path: p }),
  copy: (text) => ipcRenderer.invoke('ass:copy', { text }),
  saveText: (name, text) => ipcRenderer.invoke('ass:saveText', { name, text }),
  aliases: () => ipcRenderer.invoke('ass:aliases'),
  aliasSet: (kind, key, name) => ipcRenderer.invoke('ass:aliasSet', { kind, key, name }),
  configGet: () => ipcRenderer.invoke('ass:configGet'),
  configSaveCustomAgents: (customAgents) => ipcRenderer.invoke('ass:configSaveCustomAgents', { customAgents }),
  cleanupList: (agent) => ipcRenderer.invoke('ass:cleanupList', { agent }),
  cleanupOne: (key) => ipcRenderer.invoke('ass:cleanupOne', { key }),
  cleanupAll: (agent) => ipcRenderer.invoke('ass:cleanupAll', { agent }),

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
})

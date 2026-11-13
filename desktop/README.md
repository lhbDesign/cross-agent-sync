# Agent Session Sync — 桌面版

把 `ass` 的核心能力做成 macOS 应用：本机统计、按项目查看会话/任务/笔记、生成交接摘要、记录决策。
打包产物是 DMG，点击即装（不做 Developer ID 签名，首次打开需右键 → 打开）。

## 架构

```
desktop/
├── electron/
│   ├── main.mjs       主进程：窗口 / IPC / 缓存
│   ├── preload.cjs    contextBridge，渲染层只能用这份窄 API
│   ├── cli.mjs        子进程跑仓库自带的 CLI（只消费 JSON）
│   └── stats.mjs      磁盘占用扫描
├── ui/                原生 HTML/CSS/JS（无前端框架）
├── runtime/           构建产物：仓库根 dist/ 的副本（gitignore）
├── scripts/
│   ├── prepare-runtime.mjs
│   ├── make-icon.mjs  零依赖生成 icns（SDF 栅格化 + 手写 PNG）
│   └── adhoc-sign.sh  构建后补 codesign -s -
└── release/           DMG / .app（gitignore）
```

数据层不 import `dist/index.js`，而是 **子进程跑 `runtime/cli.js`**：

- 配置/数据路径是模块导入时求值的常量，import 后改 env 不生效；
- `ELECTRON_RUN_AS_NODE=1` + `ASS_REEXEC=1` 直接用 Electron 内置 Node 跑 CLI，不必额外打包 Node；
- 某些 macOS 安全软件会往 stdout 注入 `[LSDEfsError]` 之类噪音，`cli.mjs` 会先清洗再解析 JSON。

## 桌面端功能

- **会话抽屉**：用户输入 / 全部信息 / 智能体回答三种模式；每种模式都有搜索框；
  消息按时间倒序（最近的在最上面）；用户与助手用不同底色区分；
  每条助手回答可单独折叠，顶部可「全部折叠 / 全部展开」，折叠时保留前两行。
- **清理**：左侧「清理」页 → 选 Agent → 单条清理或全部清理。
  - 只处理「一个文件 / 一个目录 = 一条会话」的来源：Claude、Codex、CodeBuddy、WorkBuddy、
    Kiro、DSH、Qoder JSONL、Continue / Gemini JSON。
  - Cursor / OpenCode / Trae / 通义灵码 / Qoder 桌面库是共享 SQLite，不在这里删——
    逐条改库会违背只读边界，请在对应 agent 内清理。
  - 「清理」= 移到系统废纸篓 / 回收站，可恢复；清空废纸篓后才真正释放磁盘。
- **显示名**：项目卡片、项目页、会话行、会话抽屉里的 ✎ 可以改显示名。
  只写入 `~/.local/share/agent-session-sync/desktop-aliases.json`，
  不改目录名，也不改 agent 自己的会话标题；留空恢复默认。
- **计数一致**：全部项目的会话数来自 `repos --json` 的 `keys`；项目页用同一份 keys
  过滤全量会话（显式 `--limit 100000`），避免 CLI 默认 15 条截断导致「卡片 31、进来 9」。

## 开发

要求 **Node ≥ 22.12**（Electron 45 的 engines 限制）。本目录有 `.nvmrc`：

```bash
nvm use                 # 读取 .nvmrc → 24
npm install
npm run dev             # prepare runtime + 打开窗口
npm run smoke           # 不开 GUI，验证 CLI 的 JSON 契约
```

改完 CLI 后要重新构建根目录，`prepare:runtime` 才会复制到 `runtime/`：

```bash
cd ..
npm run build
cd desktop
npm run prepare:runtime
```

调试截图（不弹窗，跑完自动退出）：

```bash
ASS_SCREENSHOT=/tmp/shot.png ASS_SCREENSHOT_DELAY=8000 npx electron .
# 可选：ASS_SCREENSHOT_TAB=project ASS_SCREENSHOT_REPO=/path/to/repo
#       ASS_SCREENSHOT_CLICK='[data-act="brief"]' ASS_SCREENSHOT_EVAL='...'
```

## 打包

```bash
npm run dist       # macOS：prepare:runtime → make-icon → electron-builder → DMG
npm run dist:win   # Windows：NSIS 安装包 + 免安装 zip（x64，可在 macOS 上交叉构建）
```

产物：

- macOS：`release/Agent-Session-Sync-<版本>-arm64.dmg`（含安装说明）
- Windows：
  - `release/Agent-Session-Sync-<版本>-setup-x64.exe`（NSIS 安装包）
  - `release/Agent-Session-Sync-<版本>-win-x64.zip`（解压即用）
- 两者的解包目录：`release/mac-arm64/`、`release/win-unpacked/`

**macOS 签名必须放在 afterPack**：electron-builder 的顺序是「打包 .app → 生成 DMG」。
如果在最后才 `codesign`，只改了 `release/mac-arm64` 里那份，**DMG 里仍是未签名的**
（`Sealed Resources=none`），Apple Silicon 上下载后会直接报「已损坏」。

**Windows 在 macOS 上交叉构建**：没有 wine，electron-builder 的 rcedit 跑不了，
所以配置了 `win.signAndEditExecutable: false`，改由 `scripts/after-pack.cjs`
用纯 JS 的 `resedit` 写入 exe 图标与版本信息。NSIS 与 zip 由 electron-builder 自带的
macOS 版 makensis 处理，不需要 wine。

> Windows 包未做代码签名，首次运行会触发 SmartScreen：
> 点「更多信息 → 仍要运行」即可。
> 本仓库在 macOS 上交叉构建，结构/元数据已校验，但**没有在真实 Windows 上跑过**；
> 交付前建议在 Windows 机器上实际打开验证一次。

## 性能

- `ass agents --fast`：只探测可用性，不数会话。GUI 首屏用它，会话数随后从 `repos` 的 `byAgent` 汇总。
- Cursor 全库扫描单次约 15s。`src/adapters/cursor.ts` 现在按「会话条数 + 最近更新时间 + workspaceStorage mtime」
  缓存列表，内容没变时直接复用（实测 15s → 0.4s）；`--no-cache` 可强制重扫。
- Cursor 应用常驻时会持续写 WAL，所以缓存指纹**不用文件 mtime**。

## 只读边界

- 不改任何 agent 的会话文件。
- 写操作只写 `~/.local/share/agent-session-sync`（项目笔记 / 任务 / 交接记录），执行前都弹确认。

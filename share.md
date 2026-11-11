1. 看历史 · ass

ass # 当前仓库：上次收尾记录 + 最近会话
ass list # 本仓库会话列表
ass list --all --limit 50 # 跨仓库
ass list --agent claude # 只看 Claude
ass show claude:4134ec80 # 看某个会话
ass show claude:4134ec80 --full # 全文
ass show claude:4134ec80 --tail 6 # 只看最后 6 条
ass search 退款 --all # 搜标题/预览/正文

引用有三种写法：#1（上次列表第 1 条，跨进程不稳，别写进脚本）、claude:4134ec80（稳定）、标题里的一段文字。

---

2. 搬提问 · ass last

把「上一问」原样搬过来，包含图片（图片会落盘给路径）。

ass last # 当前仓库最近一次会话的最后一问
ass last claude:4134ec80 # 指定会话
ass last claude:4134ec80 --rounds 3 # 连最后 3 轮提问一起
ass last > /tmp/q.md # 存成文件，粘到别的 agent

典型场景：在 Codex 里新开会话，先把 ass last 的输出贴进去，等于把你当时的问题原样搬过去了。

---

3. 交接摘要 · ass brief

ass brief # 当前仓库最近会话
ass brief claude:4134ec80 # 指定会话
ass brief claude:4134ec80 --out handoff.md
ass brief claude:4134ec80 --budget large # 预算档：tiny/small/standard/large/full
ass brief claude:4134ec80 --tokens 6000 # 直接给 token 数
ass brief claude:4134ec80 --tail 4 --files 25
ass brief claude:4134ec80 --guess # 额外附上"猜的"决策/坑（默认关）

用途：换 agent 时，把这份 Markdown 贴进新会话，或者让新 agent 自己读。

---

4. 只看输入 · ass inputs

只要你自己说过的话，去掉助手回复和系统注入。

ass inputs claude:4134ec80 # 全部用户输入
ass inputs claude:4134ec80 --round 3 # 只看第 3 条
ass inputs claude:4134ec80 --raw # 纯正文
ass inputs claude:4134ec80 --out inputs.txt
ass inputs claude:4134ec80 --json

适合：100 多轮的老会话，快速回顾"我到底提过哪些需求"。

---

5. 任务 · ass task

把跨 agent 的多段会话绑成一件事。

ass task # 列出本仓库任务
ass task new 支付重构 --goal "退款链路重构" # 新建
ass task add 支付重构 claude:4134ec80 --label "需求 1-3" --note "已完成接口层"
ass task add 支付重构 codex:01a0b24d --label "需求 4-5" --note "卡在退款回调"
ass task note 支付重构 codex:01a0b24d --note "回调已修完"
ass resume 支付重构 # 总览：目标/决策/各段进展/待办
ass resume 支付重构 --save # 存成本仓库的交接记录
ass task done 支付重构 # 完成（再执行=重新打开）
ass task rm 支付重构 [引用] # 解绑一段；不带引用=删整个任务

换 agent 后只需说一句「继续 支付重构」，不用再解释背景。

---

6. 决策记录 · ass context

这是"状态"最可靠的来源——当时记一句，之后所有 agent 都能看到。

ass context # 查看（默认隐藏已完成/已取消）
ass context --all --details # 看全部历史 + 全文

# 记

ass context --decision "token 改用 refresh 轮换，因为旧接口不支持并发刷新"
ass context --dead-end "在 middleware 里刷新会死循环，已验证不可行"
ass context --constraint "不要改旧版 SSO 的接口"
ass context --todo "需求 5：首页表格换虚拟滚动"
ass context --suggestion "可以试试把首屏请求合并" # 建议，未授权

# 待办状态

ass context --done c8 # 标记完成
ass context --cancel c8 / --reopen c8 # 取消 / 重新打开
ass context --confirm c8 --evidence "用户原话：可以做" # 记录授权
ass context --review c8 --result partial --evidence "测试通过但…" # 核对进展

# 关联/替代

ass context --decision "新方案" --supersedes c3
ass context --todo "子任务" --related-to c3

MCP 里对应 session_remember，agent 干活时可以直接调。

---

7. 自动收尾 · ass hook

会话结束时自动落一份交接快照，不靠人自觉。

ass hook install --agent claude --dry-run # 先看要改什么
ass hook install --agent claude # 真装
ass hook install --agent cursor
ass hook status # 看配置 + 最近执行结果
ass hook retry --session claude:4134ec80 # 失败时按完整引用重试
ass hook uninstall # 只卸本工具的钩子

---

8. 自检 · ass doctor

ass doctor # 检查数据源、MCP 接入、钩子状态
ass doctor --paths # 受保护区清单 + 只读变更自证
ass agents # 本机探测到哪些 agent、数据在哪
ass detect --write # 扫盘找出新 agent，写配置草案
ass install --dry-run # 把 MCP + 规则写进各 agent 前先预览

---

三种最常用组合

① 同一个 agent 接着聊
ass # 找到会话
ass show #2 --tail 8 # 看一眼
claude --resume <id> # 原路恢复

② 换一个 agent 接着干
ass brief claude:4134ec80 --budget large --out handoff.md

# 然后在 Codex/Cursor 里：把 handoff.md 给它，或说「看下这个交接摘要」

③ 多段会话做一件事
ass task new 支付重构
ass task add 支付重构 claude:4134ec80
ass task add 支付重构 codex:01a0b24d --note "卡在退款回调"
ass resume 支付重构

# 之后任何 agent 里说「继续 支付重构」

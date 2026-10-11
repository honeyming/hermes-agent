# 语音通路升级自愈机制（Voice Upgrade Survival）

> 给任何未来要维护 Hermes 语音功能的 agent 或人阅读。读完本文件即可理解：**升级为什么断语音、现在怎么自愈、踩过什么坑、坏了怎么救。**
> 维护者：小可（Codex）｜最后更新：2026-09-10

## 1. 目标

Hermes 桌面端升级（`hermes update`，频繁发布）后，本地语音补丁必须**自动恢复**，语音始终可用，无需任何手工修复。

## 2. 背景：Hermes 升级机制

- `hermes-agent` 是一个 git checkout，升级 = `git stash`（含 untracked）→ pull/reset → `_restore_stashed_changes` 尝试恢复本地改动。
- 恢复遇冲突时官方逻辑：打印冲突文件 → `git reset --hard HEAD` 清空工作区 → 改动留在 stash 等手动（见 `hermes_cli/update_cmd.py::_restore_stashed_changes`）。
- 语音功能以**本地补丁**形式存在于 tracked 文件中，因此每次升级都可能被还原 → 语音断。

## 3. 自愈机制（当前实现，2026-08-21 已闭环）

**位置**：`hermes_cli/update_cmd.py`（该文件本身也列入白名单，保证机制自持）。

**逻辑**（冲突分支内）：

1. `_VOICE_PATCH_FILES` 白名单 = 37 个本地补丁 tracked 文件（语音 + 听写模式 + 赛博女友/头像 overlay + avatar 设置 + i18n + `voice-playback.ts`，含 `hermes_cli/update_cmd.py` 自身）。听写模式 tracked 文件：`src/app/chat/composer/hooks/use-voice-conversation.ts`、`use-composer-voice.ts`、`src/lib/voice-stop-word.ts`（+ 其 test）。赛博女友/avatar 的 tracked 文件：`apps/desktop/electron/main.ts`、`electron/preload.ts`、`src/app/pet-overlay/pet-overlay-app.tsx`、`src/components/pet/floating-pet.tsx`、`src/store/pet-overlay.ts`、`src/global.d.ts`、`src/app/settings/appearance-settings.tsx`、`src/app/settings/pet-settings.tsx`、`src/lib/voice-playback.ts`。
2. 冲突文件命中白名单 → `git checkout <stash> -- <file>` 取我们的版本 + `git add`。
3. 全部白名单冲突解决 → **跳过 reset**，返回成功；升级流程继续（pip install → 桌面重建 → 网关重启）。
4. 仍有未知冲突 → 保持官方行为（reset + 留 stash + 提示人工）。
5. 钩子代码本身在 stash 里，每次升级自动带回 → **自持，一次投入永久生效**。
6. **桌面重建是全自动的**：升级器对比内容 hash（覆盖 `apps/desktop/` 全部未被忽略文件，含 untracked 补丁），发现变化即自动关闭正在运行的 `Hermes.exe`（`_stop_desktop_processes_locking_build`，避免 win-unpacked 文件锁）并执行 `hermes desktop --build-only` 重新打包 win-unpacked——**无需手动 `npm run pack`**。

**验证**：`tests/hermes_cli/test_update_voice_autorestore.py`（7 个测试，含"升级器自身冲突自动恢复"回归）。

## 4. 踩过的坑（真实事故记录）

### 坑 1：ppinyin 丢失（bpe.model 报错）
- 症状：喊"小赫"没反应；`gui.log` 报 `File not exists ...\sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01\bpe.model`。
- 原因：`tools/wake_word.py` 被还原；中文拼音模型**本来就没有** bpe.model，需 ppinyin 兜底。
- 修复：wake_word.py 的 ppinyin 兜底（白名单自动恢复）。

### 坑 2：dialogue 端点丢失
- 症状：即使唤醒也无法对话。
- 原因：`hermes_cli/web_server.py` 被还原，`/api/audio/dialogue` 端点（+412 行）消失。

### 坑 3：前端接线丢失 + 打包覆盖
- 症状：实时语音按钮/接线消失。
- 原因：`controls.tsx`、`use-composer-voice.ts` 等被还原。
- **重要**：升级会用还原后的源码重新打包桌面端（`win-unpacked`），所以前端补丁必须随源码一起恢复并重新 `npm run pack`，否则 UI 是旧的空壳。

### 坑 4（自噬）：2026-08-21 升级器自身冲突
- 症状：升级后语音又断（bpe 报错 + PowerShell 弹窗）。
- 原因：上游改了 `hermes_cli/update_cmd.py`，钩子所在文件冲突；当时 **update_cmd.py 不在白名单** → 钩子救不了自己 → reset。
- 修复：update_cmd.py 加入白名单；新增回归测试 `test_updater_self_conflict_auto_restored`。
- 教训：**机制所在文件必须进白名单，否则机制先死。**

### 记录 6：2026-08-23 avatar 界面配置固化

- 移除自拍/唱歌：`avatar-renderer.tsx`（untracked，随 stash 带回）删除按钮/卡片/回调/常量；`hermes_cli/web_server.py`（tracked，白名单内）删除 `/api/avatar/selfie`、`/api/avatar/sing` 端点和 `_avatar_lyrics()`。
- 移除慢速按钮，工具栏收敛为「对话 + 暂停」一行（右上角）。
- avatar 设置开关：`src/app/settings/appearance-settings.tsx` / `pet-settings.tsx` 的 `AvatarSettings` 区块——**本次加入白名单**，升级冲突自动取回。
- 配置快照：`C:\Users\honey\Documents\New project\backups\config-2026-08-23-092940\`（update_cmd / web_server / avatar-renderer / settings / AGENTS / 文档原样副本）。
- 2026-08-27 语音升级：**纯语音模式**（realtime 对话默认不写聊天记录，`voice.voice_history_in_session` 可开回）+ **免提听写**（说"听写"进输入框，"停/继续/退出"控制；realtime 与 segmented 双路径）。前端 `use-realtime-voice-conversation.ts` 为 untracked 随 stash 带回；`web_server.py` / `use-composer-voice.ts` / `use-voice-conversation.ts` / `voice-stop-word.ts` 均在白名单。
- 2026-08-28 升级故障：上游 `main.ts` 新增 `BackendDialClaims`（后端连接去重），merge 时**调用合进来了但定义（import + const）取成了旧版** → 桌面端启动报 `ReferenceError: backendDialClaims is not defined`，连锁导致 profile 刷新/自动保存/消息平台/语音转写全失败。修复：补回 import + `const backendDialClaims = new BackendDialClaims()`；`backend-dial-claim.ts`（+ test）加入白名单防再次丢失。

### 记录 7：2026-08-23 收尾固化（字幕/波形打磨 + 升级防护复核）

- 本轮打磨：字幕配色区分（你说=蓝 #7CC4FF、她说=粉 #FFA7C4）、硬描边清晰化、
  字幕滚动（长回答顶出旧行）、你说话时字幕原地平滑增长（ASR 前缀续写 + 纯透明度淡入）。
- 波形改为**音频输出总线 AnalyserNode 直测**（`realtime-dialogue.ts` + `voice-playback.ts`），
  长回复全程跟真实播放能量，不再分包错位。
- `voice-playback.ts` 确认在白名单内（tracked）；`realtime-dialogue.ts` /
  `avatar-renderer.tsx` / `store/avatar.ts` 为 untracked，随 `git stash -u` 带回。
- 升级防护复核：白名单 33 项齐全 + 自愈回归测试 7 过（见第 3 节验证）。
- **最终状态快照**：`C:\Users\honey\Documents\New project\backups\avatar-final-2026-08-23-1516\`
  （avatar 全套源码 + 素材 + 成品 app.asar + 恢复说明 RESTORE.md，独立于仓库，升级/打包不碰）。

### 坑 5：PowerShell 空弹窗
- 症状：点"结束"或 TTS 时弹空 PowerShell/cmd 窗口。
- 原因：`tools/tts_tool.py` / `tools/transcription_tools.py` 被还原，缺少 `windows_hide_flags()`（CREATE_NO_WINDOW）。
- 修复：白名单自动恢复；另注意 `~/.hermes/scripts/` 下的 daemon/ffmpeg 调用也需 CREATE_NO_WINDOW（该目录在仓库外，升级不碰）。

### 记录 8：2026-08-25 hud-input-policy 白名单缺口（升级后「应用构建版本过旧」）

- 症状：`hermes update` 启动自动重打包后报「应用构建版本过旧」；About 面板 `bundleOutOfSync`。
- 原因：白名单里的 `apps/desktop/electron/main.ts` 引用了 `./hud-input-policy`，但
  `hud-input-policy.ts` 是本地新增文件、**不在白名单** → 升级 stash 后未被取回 →
  `bundle-electron-main` 报 `Could not resolve "./hud-input-policy"` → 打包失败 →
  `win-unpacked` 停留在旧构建（落后 HEAD 若干 desktop commit）→ 运行时判为过旧。
- 修复：把 `apps/desktop/electron/hud-input-policy.ts` 及 `.test.ts` 加入
  `_VOICE_PATCH_FILES` 白名单；`hermes desktop --force-build` 重打包对齐 HEAD。
- 教训：**被白名单文件 import 的本地源文件，也必须同步进白名单**，否则每次升级都撕裂。
- 快照：`C:\Users\honey\Documents\New project\backups\hermes-upgrade-fix-2026-08-25-0539\`。

### 记录 9：2026-08-26 小可语音桥独立 venv（升级不再被「关 python」堵）

- 症状：`hermes update` 预检报 `venv-blocked`，要求「关闭 python」；即使关了，看门狗
  （`bridge_with_codex.ps1`）在 Codex 开着时每 4s 又把桥拉起来 → 每次升级都被堵。
- 原因：小可语音桥 `python -m xiaoke.main` 一直跑在 **Hermes venv** 上
  （`start_bridge.cmd` / `start_bridge_hidden.vbs` 写死 `hermes-agent\venv\Scripts\python.exe`）。
  升级器的 venv-holder 守卫对「非 Hermes 自管」的 venv python 一律拒绝（`serve` 后端因
  app 会拉起来也拒绝），所以必须手动关。
- 修复：把语音桥迁到**独立 venv** `voice-bridge\.venv`（已装 `sherpa-onnx==1.13.4`、
  `sounddevice==0.5.5`、`pystray==0.19.5`、`Pillow==12.3.0`、`numpy==2.4.3`、
  `websockets==15.0.1`、`requests==2.33.0`、`av==18.0.0`、`sentencepiece==0.2.2`、
  `pypinyin==0.55.0`），并把两个启动器改指向 `.venv`。桥与 Hermes venv 解耦，升级预检
  只剩 Hermes 桌面自己的 `serve` 后端（关 app 即可，属正常要求）。
- 注意：豆包 daemon（`~/.hermes/scripts/doubao_voice_daemon.py`）用 `sys.executable` 跑
  （现在是 `.venv`），依赖 `av/numpy/websockets` + `tools.doubao_protocols`（daemon 自加
  hermes 仓库根进 sys.path）。若日后重建 `.venv`，务必连 `av/sentencepiece/pypinyin` 一起装。
- 关键文件：`voice-bridge\start_bridge.cmd` / `start_bridge_hidden.vbs` / `voice-bridge\.venv`。
- 补充（2026-08-26）：桥的 capture-host **electron** 也曾在 Hermes 仓库的
  `node_modules\electron\dist\electron.exe`（`config.ELECTRON`）——桥以**脱离方式**拉起它，
  杀掉桥进程并不会杀它，导致 `hermes desktop --force-build` 的 `npm ci` 重装 electron 时
  `v8_context_snapshot.bin` 被锁 → `EBUSY` → 重建失败（“update did not finish”）。
  现改为 `voice-bridge\.electron-dist`（独立拷贝，含完整 dist + icudtl.dat），不再锁仓库。
  **重建桥的 `.venv` 或重装桥前，务必先杀掉残留的 `node_modules\electron\dist\electron.exe`。**

### 记录 10：2026-08-29 Hermes gateway（Session 0）被预检误判为 blocker

- 症状：`hermes update` 预检又报「关闭其它进程/python」。此时 `xiaoke` 桥已解耦（在
  `voice-bridge\.venv`、capture-host 在 `.electron-dist`），并非桥。
- 原因：`Hermes_Gateway` 计划任务（Session 0）用 `venv\Scripts\python.exe -m
  hermes_cli.main gateway run`（经 `Hermes_Gateway.vbs`）常驻。升级预检
  `_scan_venv_blockers` **读不到 Session-0 进程的命令行**，无法判定它是「可自动暂停的
  gateway」→ 当 blocker 报出，要求手动关 python。
- 修复：写了个封装脚本 `C:\Users\honey\Documents\New project\scripts\hermes-upgrade.ps1`，
  升级前 `Disable-ScheduledTask Hermes_Gateway/Hermes_Gateway_Watchdog` + `hermes gateway
  stop --all`（清掉 Session-0 shell），再 `hermes update --yes`；`finally` 里 `hermes
  gateway start`（**直接 spawn**，可被预检识别为 pausable）+ 重新 `Enable-ScheduledTask`。
  之后用 `.\scripts\hermes-upgrade.ps1` 代替裸 `hermes update`。
- 备注：`hermes gateway start` 直接启动的 gateway 会被识别为 `pausable_gateways`（豁免）；
  但只要 `Hermes_Gateway` 任务再次以 Session-0 拉起（重启/登录/看门狗触发），又会回到
  不可识别状态。故升级走封装脚本最稳；如不常用可考虑拆掉该任务，但本机在用 Telegram
  网关，勿禁。

### 记录 11：2026-08-29 反复「应用构建版本过旧」的真根因 + 结论

- 现象：Hermes 反复报「应用构建版本过旧」「关闭其它进程/python」。一次"升级"只把
  **代码/依赖**升到了 `3340bbbd`，但**桌面端(win-unpacked)没重打包**，仍停在旧 stamp
  （落后 69 个 desktop commit）→ app 打开即报「过旧」。
- 结论（纠偏 + 实测）：
  - **`Hermes_Gateway` 任务 (S4U/Session-0) + RestartOnFailure 999 不是卡点**。网关
    `hermes gateway stop` 是 **clean drain（干净排空）**，不是强杀，所以**不会**触发
    "被杀后 1 分钟复活"。删 `<RestartOnFailure>` 会被 Task Scheduler/模块回填成 999，
    故**不要改**该任务。
  - **真正的自更新保护**：桌面 app 运行时会锁 venv 的 `.pyd` → `hermes update` 拒绝
    执行（防装一半坏掉）。正常软件做法=先关自身再更新；in-app 流程会先释放自己的
    serve 后端（`desktop exited` → `venv shim unlocked`）。
  - 补丁：`_scan_venv_blockers.py` + `update_cmd.py` 已加 `_is_gateway_holder_pid`
    （用 `gateway.status.get_running_pid` 识别网关启动壳，豁免/可停），均在白名单内自愈。
- 关键操作：升级后若报「过旧」，重跑 `hermes desktop --force-build` 补齐桌面重打包
  （本次即如此：stamp 对齐 `3340bbbd`，`rev-list count=0`，应用自动重开）。
- 自查清单：升级后必看 `apps\desktop\release\win-unpacked\resources\install-stamp.json`
  **是否 == HEAD**；不一致 → 重建桌面端。
- 当前状态：HEAD=桌面=`3340bbbd`，网关 PID 15352 运行（Telegram 正常），小可桥
  已解耦（`.venv` + `.electron-dist`）。`RestartOnFailure` 未改。

### 记录 12：2026-08-31 升级被网关阻塞的真实根因（taskkill 健壮性 bug）+ 修复

- 现象：`hermes update` 每次都被 venv-holder 守卫拒（exit 2），报
  `PID xxxx ... -m hermes_cli.main gateway run ← gateway`。
- 真实根因（Claude 实测一锤定音）：守卫暂停网关后，调用
  `gateway/status.py::terminate_pid()` → `taskkill /T /F` 杀残留的网关**启动壳树**
  （venv python + conhost 子进程，命令行对非提权隐藏），对 S4U/提权上下文报
  **"拒绝访问"** → 失败被守卫 `try/except` 吞掉 → 残留网关继续锁 venv 的 `.pyd` → 拒。
- 决定性实验：**同一个进程**，非提权的 venv python 用 **ctypes `TerminateProcess` 能直接
  杀死**（实测成功），只有 `taskkill` 失败。→ 不是权限无解，是 `taskkill` 对网关树的
  健壮性 bug。
- 修复（Claude）：`gateway/status.py` 新增 `_terminate_process_win()`（ctypes
  `TerminateProcess`），`terminate_pid` 的 `taskkill` 失败分支先走它；并把
  `gateway/status.py` 加入 `_VOICE_PATCH_FILES` 白名单（与语音补丁同机制，升级自愈）。
- 互补：本机另有 `_is_gateway_holder_pid`（`_scan_venv_blockers.py` + `update_cmd.py`）
  负责"把网关启动壳识别为可暂停网关"；Claude 的负责"真能杀掉"。**两个都要**，
  均已在白名单内。
- 当前状态：HEAD=origin=桌面=`4f225435`，0 behind，v0.20.6，Up to date；网关 PID 3896
  运行（Telegram 正常）；语音/avatar 白名单补丁完整。
- 关键教训：Windows 上"能读到进程列表"≠"能停掉它"。`taskkill` 可能因会话/令牌失败，
  而 `TerminateProcess` 更底层、更能穿透——清理此类顽固/系统级进程，先试
  `TerminateProcess` 兜底。
- 网关启动机制（本次确认）：`Hermes_Gateway` / `Hermes_Gateway_Watchdog` 两个任务已
  **Disable**；网关改由 **HKCU Run 键 `HermesGateway` =
  `"<venv>\Scripts\hermes.exe" gateway start`** 在登录时自动拉起（Session-1），
  属"用户会话自启"。登录自启的网关可能带提权，但已被 `TerminateProcess` 兜底覆盖。
- 兜底：若下次升级仍报 "Other Hermes processes..."，从**管理员终端**跑 `hermes update`
  即可（或先 `hermes gateway stop` 再升）。

### 记录 13：2026-09-03 网关"自动复活守护"占用 venv 导致预检拒（rescuer.py）

- 症状：升级预检（桌面页 or `hermes update`）报「关闭 pythonw.exe(pid 5076)才能更新」；
  网关本身其实在跑，报的进程**不是**网关。
- 根因：`C:\Users\honey\AppData\Local\hermes\gateway-service\rescuer.py`（本机自定义的
  **网关自动复活守护**，见 `hermes-desktop-operations/references/autonomous-recovery.md`
  的 "Rescuer Daemon" 模式——因为 `Hermes_Gateway` 计划任务被 Disable、`schtasks /Change
  /ENABLE` 又需要管理员，agent 只能放一个 pythonw watcher 自保网关）用
  `venv\Scripts\pythonw.exe` 跑 → 被 `_scan_venv_blockers`/`_detect_venv_python_processes`
  当作 **venv holder** → 升级预检拒；且它每 30s 检查 `gateway.pid`、网关一死就用
  `Hermes_Gateway.vbs` 重新拉起 → 会跟升级器的 `_pause_windows_gateways_for_update`
  打架（暂停后 30s 内又被拉起来）。
- 诊断要点：别被报的 pid 带偏，**真网关看 `gateway.pid`**，报出来的 pythonw 用
  `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"`（管理员）看 `CommandLine`
  定身份。本次：网关 `16056→16088`（`venv\Scripts\python.exe`
  `-m hermes_cli.main gateway run`，两段 launcher/worker 链），报 blocker 的是
  `pythonw ...\gateway-service\rescuer.py`（父 15076，Session-1）。
- 修复（印证记录 9 桥迁移的通用教训——**任何自定义守护/脚本都不要用 hermes venv 的解释器跑**）：
  1. 加固 `rescuer.py`：加 `PLANNED_STOP_MARKER = HERMES_HOME/".gateway-planned-stop.json"`
     ——升级器暂停网关前会写这个"计划停止"标记，检测到就不复活网关，避免和升级器打架。
     （由 `gateway/status.py::_get_planned_stop_marker_path` 确认路径为
     `<HERMES_HOME>\.gateway-planned-stop.json`。）
  2. 改用**独立解释器**重新拉起：`C:\Users\honey\Documents\New project\voice-bridge\.venv\
     Scripts\pythonw.exe`（rescuer 只依赖标准库，任何 python 都行）→ 不再占 hermes venv。
  3. 备份旧文件：`rescuer.py.bak-20260903`（原 3208B）。
- 验证结果：`venv\Scripts\python.exe -m hermes_cli._scan_venv_blockers` 输出
  `pausable_gateways:1`、唯一 blocker 改为桌面自身 `serve` 后端（关 app 即清）；网关 16088
  Telegram `connected`，v0.21.0；新 rescuer 跑在 voice-bridge venv（13280→14508），
  `rescuer.log`/`rescuer_state.json` 持续更新 = 守护正常。
- 关键文件：`gateway-service\rescuer.py`（加固版 4390B）+ `rescuer.py.bak-20260903`；
  副本 `C:\Users\honey\Documents\New project\rescuer.updated.py`。
- 兜底：凡预检再报外部 pythonw 占 venv，先 `Get-CimInstance` 看 `CommandLine` 问身份；
  网关/守护类走 `_is_pausable_gateway`/`_is_gateway_holder_pid`，守护一律换独立解释器。

### 记录 14：2026-09-07 升级器未自动还原 tracked 语音补丁 + 仓库停在功能分支

- 症状：`hermes update` 反复"升级失败"没进展；即便"成功退出"，语音 tracked 文件被上游
  覆盖、未走白名单自愈。
- 根因（两层）：
  1. **仓库停在本地功能分支 `codex/avatar`**（= main + 4 个语音/avatar commit，无上游跟踪）
     → 升级器 parked-branch 判定算不出落后数（`.update_check` 显示 `behind:-1, rev:null`），
     升级反复"成功退出但没更新"（HEAD 仍旧、main 落后 origin 254 commits）。语音补丁被
     **commit 进分支**，不走"工作区 + 白名单自愈"机制。
  2. **切回 main 升级后，升级器只还原了 untracked 新文件（19 个），未还原 tracked 语音改动
     （24 个）**——`web_server.py` 对话端点、`tools/wake_word_engines.py` 的 ppinyin、
     `apps/desktop/electron/main.ts` 语音接线等被上游 254 commits 覆盖，白名单自愈没触发
     tracked 部分。
- 诊断要点：
  - 先看 `git branch --show-current` 是不是 main；是功能分支则升级器不会正常更新。
    真目标看 `git rev-list --count HEAD..origin/<branch>`。
  - 核对语音是否还原：`git status --short` 里 tracked 语音文件是否仍是 `M`；
    `web_server.py` 是否含对话路由、`tools/wake_word_engines.py` 是否含 `ppinyin`。
  - 升级器升级前会 `git stash`（含 untracked）生成 `hermes-update-autostash-*`，语音改动
    通常都还在那个 stash 里。
- 修复（把语音补丁作为工作区改动恢复到新 main，而非整文件覆盖）：
  1. 备份：`git diff <旧分支>..<voice分支> > voice-patch.patch`（本次存
     `backups\voice-patch-20260907.patch`，43 文件 / 276KB）。
  2. 切回 `main`。
  3. 用本次最新 autostash `git stash apply 'stash@{0}'` **3-way 合并**回 tracked 语音改动
     （**不要** `git checkout stash -- file` 整文件覆盖——那样会丢掉上游这 254 commits 对
     该文件的新改动）。
  4. 解冲突（本次 2 处：`apps/desktop/electron/preload.ts`、`apps/desktop/src/global.d.ts`——
     上游给 `getConnection` 加了 `opts` 参数，我们加了 avatar IPC/类型；正确解法=**保留上游
     新 getConnection(opts) + 并入我们的 avatar 新增**）。
  5. `hermes desktop --force-build` 重建桌面端（让 win-unpacked 含完整语音接线；构建后 stamp
     显示 `dirty:true` 即证明含本地改动）。
  6. 验证：HEAD==origin、0 behind；43 文件在工作区；网关 `running`+Telegram `connected`；
     app 用新构建。
- 关键教训：
  - **语音补丁不要 commit 进功能分支**，应作为 main 上的工作区改动（白名单自愈才认）。
    若已在分支，先切回 main 再 `git stash apply` 合回。
  - **升级不总能自动还原 tracked 语音文件**：升级后必须核对；若只剩 untracked 新文件、
    tracked 被重置，用最近 autostash 的 `git stash apply` 合回 + 解冲突 + 重建。
  - 合回用 `git stash apply`（3-way），别用整文件 checkout，避免丢上游新代码。
- 当前状态：HEAD=桌面=`693641aa8b`、0 behind、v0.21.0、on `main`；网关 PID 29548
  Telegram `connected`；语音补丁 43 文件在工作区（tracked 为暂存态，功能正常；
  `git reset` 取消暂存会撞 `index.lock` —— 桌面端 git 监控句柄占用，关 app 后释放）。
- 关键文件：`hermes_cli/web_server.py`、`tools/wake_word_engines.py`、
  `apps/desktop/electron/main.ts`、`apps/desktop/electron/preload.ts`、
  `apps/desktop/src/global.d.ts`、`hermes_cli/web_routers/avatar.py`、
  `tools/doubao_dialogue.py`、`tools/doubao_protocols.py`、`apps/desktop/src/lib/realtime-dialogue.ts`。

### 记录 15：2026-09-08 升级反复丢语音的真根因（v0.21.1 删白名单 + 还原逻辑改动）

- 症状：每次 `hermes update`（或 app 内点升级）后语音补丁**整体丢失**；唤醒"小赫"报
  `wake.start(gui): failed to start listener: File not exists ...\sherpa-onnx-kws-zipformer-
  wenetspeech-3.3M-2024-01-01\bpe.model`（即 `tools/wake_word_engines.py` 的 **ppinyin
  兜底丢失**：中文 wenetspeech 模型没有 bpe.model，全靠 ppinyin）。
- 真根因（本次一锤定音）：**上游 v0.21.1 删掉了咱们的 `_VOICE_PATCH_FILES` 白名单**
  （原来靠它在升级时自动还原语音文件），并把 stash 还原逻辑移位到
  `hermes_cli/update_cmd_stash.py::_restore_stashed_changes`。
  新版还原逻辑在 `_git_untracked_paths` **基线未知**、或**非交互未确认**时会
  `return False` **直接跳过还原并保留 stash**（提示 `git stash apply <ref>` 手动还原）——
  于是语音补丁每次都留在 stash、工作区被清 → 更新一次丢一次语音。
- 诊断要点：升级后看 `git status --short`（语音文件是否还在）、
  `tools/wake_word_engines.py` 是否含 `ppinyin`；`git stash list` 里最新
  `hermes-update-autostash-*` 通常仍**完整装着语音补丁**（43 文件）。
- 修复（每次升级后自愈）：`git stash apply <最新autostash>` **3-way 合并**回语音改动 →
  解冲突（按"保留上游 getConnection(opts)+并入 avatar 新增"）→
  `hermes desktop --force-build` 重建 → 验证 gui.log 出现
  `wake.start(gui): listening for '小赫' (sherpa)`。**不要**整文件 checkout（会丢上游新代码）。
- 治本方向：**不再依赖上游那个会变的还原逻辑**。已把 `scripts/hermes-upgrade.ps1` 增强为
  "更新后自动核对语音（ppinyin 是否存在）→ 缺失则用最新 autostash 兜底还原 + 重建桌面端"，
  用 `.\scripts\hermes-upgrade.ps1` 代替裸 `hermes update`。
- 当前状态：HEAD=`2237be35`（v0.21.1，最新），语音 43 文件在工作区，唤醒 11:16:58
  正常（`listening for '小赫'`），桌面 stamp `dirty:true`。
- 关键文件：`tools/wake_word_engines.py`（ppinyin 兜底）、`hermes_cli/update_cmd_stash.py`
  （v0.21.1 还原逻辑）、`scripts/hermes-upgrade.ps1`（更新后自愈封装）。

### 记录 16：2026-09-09 Task Scheduler 拉起 PowerShell 黑窗（-WindowStyle Hidden 失效）

- 症状：`Hermes_VoiceGuardian_Periodic` 每 30 分钟在桌面闪一个黑框（console 一闪而过）。
- 根因：**Windows PowerShell 5.1 由 Task Scheduler 启动时，`powershell.exe -WindowStyle
  Hidden` 不生效**——Win32 console 的窗口样式由 scheduler 子系统决定，这是已知 bug。
  守护脚本里又有 `Write-Host`、`taskkill Hermes.exe`、`Start-Process Hermes.exe`，
  黑窗闪过即关；你看到的"闪窗"其实也是它杀+拉起 Hermes.exe 的那一瞬间。
- 修复：把 schtasks 启动方式从 `powershell.exe + WindowStyle Hidden` 改为 **vbs
  `WScript.Shell.Run cmd, 0, False`**（窗口句柄 `0` = SW_HIDE，真正隐藏）。
  1. 新建 `scripts/voice-guardian-hidden.vbs`：
     `sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ...\voice-guardian.ps1", 0, False`。
  2. 删除原任务，用导出 XML 改 Action 为 `wscript.exe "…\voice-guardian-hidden.vbs"` 重建
     （保留每 30 分钟 trigger + honey 主体 + 条件）。
- 验证：任务改走 `wscript` 后 `LastTaskResult=0`、守护日志正常、黑窗不再闪。
- 教训：**Task Scheduler 定时跑 Windows PowerShell 想隐藏控制台，别用 `-WindowStyle
  Hidden`，要用 vbs `WScript.Shell.Run ..., 0, False`**（跟 Hermes Gateway 的 vbs 隐藏写法一致）。
- 关键文件：`scripts/voice-guardian-hidden.vbs`、`scripts/voice-guardian.ps1`。

### 记录 17：2026-09-09 Telegram 豆包语音延迟优化（短答示范，最终无截断）

- 症状：Telegram 语音回复实测 3.4–5.8 秒，用户体感 5–8 秒。
- 对照实测：同一段缓存语音，新连接豆包整轮约 2.5–3.6 秒；连接复用约 2.6 秒，握手只占约 0.1–0.2 秒。真正的大头是模型生成了 10–16 秒音频，必须整段收完才能上传 Telegram。
- 修复：`tools/doubao_dialogue.py` 支持 `props.max_tokens`；Telegram 快速语音路径从
  `voice.telegram_dialogue_max_tokens` 读取上限（默认 64，夹在 32–256），并优先使用
  `voice.telegram_dialogue_speaking_style`（当前为“一句话，20字以内，不追问”），桌面端原风格不变。
- 实测结果：单独限制 token 不稳定，豆包仍会写 2–3 句；保留完整人设并加 Telegram 专用短句风格后，
  核心回合约 1.7–2.5 秒；不追加风格时约 2.4–3.5 秒。
- **4 秒硬截断已否决并撤销**：马哥反馈太短、会截断完整句子；adapter 中
  `telegram_dialogue_max_audio_seconds` 逻辑已删除，不做任何音频截断。
- 最终方案：`DoubaoDialogueSession` 增加 `dialog_context` 支持，Telegram 快速路径注入短答示范
  （“只回一句完整的话，尽量简短，不要补充建议，不要反问”）。5 段真实缓存语音对照：
  无示范时音频 7–18 秒，加示范后 1.2–5.0 秒；正式 adapter 路径音频 3.3–3.8 秒、核心回合 1.8–2.2 秒。
- 网关已于 2026-09-09 19:33 重启并健康运行，等待真实 Telegram 分段日志复核 `dialogue/encode/upload/total`。
- **2026-09-09 20:20 真实复测**：4 条语音总间隔 `2.81/2.84/2.91/2.79s`；`dialogue=1.70/1.72/1.78/1.69s`、`encode=0.11/0.12/0.12/0.11s`、`upload=1.00/1.01/1.01/0.99s`，音频 `1.5/2.0/3.2/1.8s`。`speech_rate=0` 语速自然。
- **进一步优化**：Telegram 快速语音路径改为边收豆包 PCM 边喂 ffmpeg 编码，把回合结束后的 `encode≈0.1s` 重叠掉；不截断内容、不改语速。网关已重启。
- **语速核对**：新 5 条字符/秒 `5.00/5.38/5.00/4.29/6.00`（排除标点），之前自然档 `5.00–5.71`；没有参数性加速。主观“变快”主要来自短句多、停顿少；`speech_rate` 保持 0。
- **停顿细分（20:34）**：`decode≈85ms`、`session≈133–164ms`、`first_asr≈659–754ms`、`first_chat≈919–1062ms`、`first_audio≈1202–1320ms`、`tts_end≈1445–1518ms`；连接/StartSession 与解码并行，WebSocket 关闭后台化。
- **收工状态（20:41）**：最后 5 条真实语音 `total=2.60/2.58/2.53/2.71/3.03s`，`dialogue=1.60/1.46/1.53/1.48/1.88s`，`encode` 全 `0.01s`，`upload=1.00/1.11/0.99/1.22/1.14s`。保持 Telegram 原聊天逻辑、`speech_rate=0` 自然语速、不截断；日常稳定在 `2.5–3.0s`。Mini App 不作为主路径，网关 PID `9196` 正常。
- 关键文件：`tools/doubao_dialogue.py`（untracked）、`plugins/platforms/telegram/adapter.py`（tracked 补丁）、`config.yaml`。
- 配置备份：`config.yaml.bak-20260909-telegram-max-tokens`。
- 注意：连接复用不是主瓶颈，且立即复用会撞豆包“session number limit exceeded: 1”；本轮未启用连接复用。

### 记录 18：2026-09-09 Telegram 真实时语音 Mini App 原型

- 结论：**Telegram Bot API 语音消息无法做到全双工**。语音消息是录完后上传，机器人在说话过程中听不到，也收不到客户端停止/插话事件；继续优化语音消息只能缩短“录完到回复”的间隔，不能实现“开口即打断、随时停止”。
- 新路径：Telegram Mini App（Web App）内的持续麦克风流。
  - `telegram-realtime/server.py`：单端口同时提供页面和 `/ws`；浏览器 PCM → 豆包 `full_duplex` → 流式文本/24k PCM 回传。
  - `telegram-realtime/web/index.html`：移动端 `getUserMedia` + AudioContext 播放；播放期间本地能量检测到开口即停播并发送 `interrupt`。
  - `telegram-realtime/set_telegram_menu.py`：发送 Telegram `web_app` 内联按钮。
  - `tools/doubao_dialogue.py`：新增 `cancel_turn()`（`CancelSession`）和 `session_canceled` 事件。
- 实测：Cloudflare Quick Tunnel 的公网 `wss` 全链路跑通；`CancelSession≈17ms`，同 WebSocket 重新 `StartSession≈28ms`。Telegram 已收到“打开实时语音”按钮。
- 注意：Quick Tunnel URL 是临时的；正式部署需换命名 Cloudflare Tunnel/VPS + 稳定 HTTPS 域名，并把 URL token 升级为 Telegram `initData` + 短期票据。
- 结果：马哥反馈“这又是另外一个逻辑，而且连不上”，已撤回 Telegram Web App 菜单按钮、停止临时 Cloudflare 隧道，恢复原来的 Telegram 语音消息主链路。Mini App 代码保留在 `telegram-realtime/`，暂不作为主路径。
- 结论：同一 Telegram 聊天窗口内无法做真正全双工；要继续原链路只能优化“录完→回复”间隔，真正全双工必须另开 Mini App/独立客户端。

### 记录 19：2026-09-10 「点升级显示失败但实际成功」的真根因 = 桌面端后置校验拿错目录（exit 8）

- 症状：app 内点升级，页面弹「升级失败」，但 git 已升到最新（本次 `b1f003e1 → 2db0c7a2`、
  receipt `outcome:success`、`.update_exit_code=0`），语音随后被 voice-guardian 自动救回——
  看起来"又成功了"。
- 真根因（一锤定音，实测复现）：**Electron 以 `cwd=HERMES_HOME`（`%LOCALAPPDATA%\hermes`）拉起
  `scripts/desktop-update/windows.ps1`**（main.ts `cwd: HERMES_HOME`），而该脚本在 `hermes update`
  exit 0 后的"诚实完成"校验里执行：
  `python -c "... verify_windows_desktop_update(Path.cwd())"` —— `Path.cwd()` 继承的是
  HERMES_HOME，于是去 `HERMES_HOME\apps\desktop\release\...` 找 exe，必然找不到 →
  `desktop_update_verify.py:77` 抛 "The updated Desktop executable is missing" →
  windows.ps1 以 **exit 8** 收尾 → 页面显示「升级失败」。`hermes update` 内部用
  `__file__` 推导 PROJECT_ROOT，所以从任何 cwd 都能正常升级——同一进程内"升级成功"与
  "校验失败"并存。
- 决定性实验：同一 venv python 同一校验代码，从 `HERMES_HOME` 跑必抛同样报错；
  从 `hermes-agent` 根跑 exit 0。09-09 06:31 与 09-10 05:26 两次 in-app 升级均为同款 exit 8。
- 修复（2026-09-10 已落地）：windows.ps1 校验段改为**环境变量**传仓库根，不再用
  `Path.cwd()`：
  ```powershell
  $env:HERMES_UPDATE_VERIFY_ROOT = $InstallRoot
  $verifyCode = "import os; import hermes_cli.main; from pathlib import Path; from hermes_cli.desktop_update_verify import verify_windows_desktop_update; verify_windows_desktop_update(Path(os.environ['HERMES_UPDATE_VERIFY_ROOT']))"
  $verify = Invoke-HermesStep $pythonExe @("-c", $verifyCode) "verify"
  Remove-Item Env:HERMES_UPDATE_VERIFY_ROOT -ErrorAction SilentlyContinue
  ```
  用环境变量而非内嵌路径字符串，是为了避开 PowerShell→`python -c` 对引号/反斜杠的参数
  转义坑（实测内嵌 JSON 会被搅乱）。备份：
  `scripts/desktop-update/windows.ps1.bak-20260910-verifyroot`。
- 为什么下次不再弹失败：windows.ps1 是 repo-owned、由桌面端每次现拉现跑（PowerShell
  整份读入内存），本次补丁生效于"读入内存的那一刻"——即使升级中途 git 把该文件还原成
  上游版本，正在运行的内存副本仍是修好的 → 校验通过 → exit 0 → 页面成功。
- 补丁的持久性：windows.ps1 是 tracked 本地改动，随 `--keep-stash` 进 autostash，再由
  voice-guardian 的 `git stash apply` 一并救回（与 43 个语音补丁同机制），无需额外守护。
- 结论要点：`hermes update` 与桌面端"后置校验"对仓库根的推导方式不同（`__file__` vs
  `cwd`）——凡 desktop handoff 后置校验类报 "executable is missing" / exit 8，先查
  windows.ps1 里传给 python 的 cwd/root 是否真的指向 `hermes-agent`。

### 记录 20：2026-09-10 补丁回填后没重启网关 → Telegram 每条消息都「unexpected error」

- 症状：Hermes Telegram 里发任何消息（文字/语音）都只回
  `Sorry, I encountered an unexpected error. Try again or use /reset to start a fresh session.`；
  `/reset` 无效；同机其他 agent 用同一家模型正常 → 先排除模型/接口。
- 真根因（时间戳一锤定音）：**voice-guardian 在网关进程已经起来之后才回填语音补丁，回填完没重启网关**，
  于是网关继续跑「升级后的上游模块」，而懒加载的 turn 代码已是「回填后的新模块」→ 混合 sys.modules。
  - 时间线：升级流程 05:26:20 重启网关（PID 23724，此刻工作区是纯上游代码、本地补丁还在 stash）→
    voice-guardian 05:27:05 巡检发现补丁丢失 → 05:27:08 `git stash apply` 回填（文件 mtime 05:27:09）
    → guardian 只 Disable/Enable 了 `Hermes_Gateway` 计划任务，**没动那个正在跑的进程**。
  - 崩点：网关启动时就 import 了旧版 `GatewayConfigLoadersMixin._resolve_session_reasoning_config`
    （没有 `is_voice` 形参），而 `gateway/run_turn_runner.py` 是**首次对话才懒加载**的新版
    （会传 `is_voice=`）→ 每个回合在 `run_turn_runner.py:1754` 抛
    `TypeError: ..._resolve_session_reasoning_config() got an unexpected keyword argument 'is_voice'`
    → 前端只显示那句通用错误。
  - 影响范围：补丁集里的服务端文件（`gateway/run_turn*.py`、`gateway/run_config_loaders.py`、
    `hermes_constants.py`、`agent/*`、`plugins/platforms/telegram/adapter.py`）都会这样错位——
    崩溃只是其一，也可能表现为语音/推理配置**静默失效**。
- 证据：`logs/gateway.log` 每次对话都是同一条 traceback；`guardian-logs/voice-guardian-20260910.log`
  05:27:05–05:27:09 就是回填现场；`hermes gateway status` 的 PID 23724 启动于 05:26:20，早于补丁
  mtime 05:27:09；而同一批补丁在磁盘上其实自洽（venv python 实测签名：caller 传 `is_voice`、callee
  收 `is_voice`）→ 说明只差一次重启：`hermes gateway restart` 后 PID 23724→25508，Telegram 立刻
  `connected`，agent 回合恢复正常。
- 修复（2026-09-10 已落地）：
  1. `scripts/voice-guardian.ps1` 新增 `Restart-Gateway`（= `hermes gateway restart`），只在**真的回填
     成功**（`$ok`）后调用，且排在 Enable 计划任务之后；补丁完好的常规巡检路径不受影响（`-DryRun`
     与每 30 分钟的 OK 分支照旧 `exit 0`）。
  2. 手动恢复（第 5 节）补一条：`git stash apply` 之后必须 `hermes gateway restart`。
- 验证：AST 解析通过（LF、无 BOM 保持原样）；`voice-guardian.ps1 -DryRun` 仍正常（补丁在 → OK，
  exit 0）；另用打桩副本强制走「补丁丢失」分支做端到端演练 → 日志出现 `restarting gateway ...` →
  `Gateway stopped (drained cleanly)` + `Gateway started ... (PID: 25932)` → 网关确认换进程并重连。
- 教训：**「补丁回填」和「进程重启」必须成对**。凡在网关运行期间改动 `gateway/*`、
  `hermes_constants.py`、`agent/*`、`plugins/platforms/telegram/*` 的脚本，改完必须重启网关；
  这类混合 sys.modules 的报错会伪装成"模型/接口故障"（马哥本次直觉判断"不是模型问题"，正确）。
  `scripts/hermes-upgrade.ps1` 的顺序本来就是对的（Pause-Gateway → update → SelfHeal →
  Resume-Gateway），本次只补齐 guardian 这一条路径。
- 当前状态：网关 PID 25932（14:52 重启）运行中、Telegram `connected`；`voice-guardian.ps1` 已带重启步骤。

### 记录 21：2026-09-12「后端已停止后退出，无法完成升级」真根因 = 守护留下的 Git 冲突标记把升级脚本写坏

**症状**：应用内点升级 → 窗口关闭 → 提示"后端已停止后退出"，版本原地不动；连点三次都一样。

**证据链**：
- `logs/desktop.log`：`launched repo hand-off script: …windows.ps1` → **0.7 秒后** `update finished; proceeding with backend start`。
- `logs/desktop-update-handoff.log` 与 `logs/update.log` 最后写入时间**停在 09-11 06:15** —— 今天三次尝试一条记录都没有 ⇒ handoff 脚本一行都没执行。
- `git status`：`UU scripts/desktop-update/windows.ps1`；1647–1652 行是 `<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes`。
- 带冲突标记的 .ps1 直接解析失败（实测 15 个语法错误，`The '<' operator is reserved for future use`）⇒ 脚本死透：不写日志、不认领 marker，app 误判"升级结束"。

**根因**：09-11 06:24 voice-guardian 自动救回语音补丁时 `git stash apply` 在 `windows.ps1` 冲突。旧版 guardian 只**记录**冲突（`CONFLICTS: …` → `AUTO-HEAL FAILED`）就退出，把 UU 状态留在工作区；此后每 30 分钟的巡检因为 `Test-VoicePatchPresent` 为真而报 OK，冲突状态再没人看，直到今天点升级才炸。

**上游已自带更优解**：本地那侧补丁（用 `HERMES_UPDATE_VERIFY_ROOT` 环境变量传根目录）已无必要 —— 上游 `hermes_cli/desktop_update_verify.py` 改为 `checkout_root() = Path(__file__).resolve().parent.parent`，注释里点名了 2026-09 那次 cwd 误报（= 记录 19）。所以本次取**上游侧**、放弃本地补丁。

**处置**：
1. `windows.ps1` 冲突块取上游单行 `verify_windows_desktop_update()`，删掉 `<<<<<<<`/`=======`/`>>>>>>>` 三行**及**本地补丁残留的 `Remove-Item Env:HERMES_UPDATE_VERIFY_ROOT`；`git add` 清掉 UU（不 commit，保持本地改动形态）。
2. 校验：pwsh 与 Windows PowerShell 5.1 解析器均 **0 错误**；全仓 `rg "^(<<<<<<<|>>>>>>>) "` 无命中。
3. 治本：`scripts/voice-guardian.ps1` 增加冲突自愈 `Repair-UnresolvedConflicts`：
   - **升级器自身文件**（`scripts/desktop-update/`、`hermes_cli/update_cmd.py`、`update_cmd_stash.py`、`desktop_update_verify.py`）→ 取**上游**（`git checkout --ours` + `git add`），绝不让本地补丁把升级器写坏；
   - 其余（语音补丁文件）→ 取**本地补丁**（`--theirs`），即守护本来要恢复的内容；
   - 修完复检 unmerged 为空 + 扫 `^(<<<<<<< |>>>>>>> )` 无残留，否则报 `CONFLICT MARKERS REMAIN`；
   - 巡检**开头**先做冲突清扫（`Get-ConflictedPaths`），所以最多 30 分钟自动自愈，不再默默烂两天。
4. 语义实测（临时仓库复现 stash 冲突）：updater 文件解成 `UPSTREAM_NEW`、语音文件解成 `VALUE = 2 / ppinyin = 2`，unmerged 清空、markers=0；守护 DryRun + 正式各跑一次，exit 0。

**口诀**：升级脚本类文件永远不能带着冲突标记放在工作区 —— 它会静默把"下一次升级"变成"点了没反应"。
### 记录 22：2026-09-12 升级终于走通（v0.21.1 → v0.21.2）+ 守护两处 bug 根治

**结果**：app 内点升级一次通过 —— handoff 日志齐全（`✓ Update complete! (v0.21.1 → v0.21.2) [main @ 31d0a2428e]`、`hermes update exit code: 0`、`removed update marker (owned)`、桌面端自动重拉）。记录 21 的冲突标记修复当场生效。

**新发现 1：守护"整文件取本地侧"会吃掉上游新代码**
- 升级后守护救回时 `apps/desktop/electron/preload.ts` 冲突，旧自愈策略整份取 stash 版本 → 上游 v0.21.2 新增的 `introReveal` / `chatOnboarding` / `getMachineProfile` / `guestOnboardingEnabled` 全丢，而渲染层（已正常合并上游）正在调用它们 → 新功能静默失效。
- 判定方法：`git diff HEAD -- <file>`，凡是"删除上游行"的 hunk 都是**陈旧回退**，不是本地补丁的本意。本例本地补丁真正的内容只有两块（头像/媒体 getter、pet-overlay 光标）。
- 修法：以上游版为底，只把这两块合回去；改完 `git diff HEAD` 只剩纯新增。
- 守护加固：冲突文件**不再整文件取任一侧** → `git checkout HEAD -- <file>` + `git diff --output=<tmp> <stash>^1 <stash> -- <file>` + `git apply --3way`，只在真重叠处留标记；留标记就整份保上游并大声记录。
- 两个踩坑（已实测确认）：① `git checkout --ours` 会破坏 `git apply --3way` 需要的索引（报 `does not exist in index`），必须先 `checkout HEAD`；② `git stash show -p <rev> -- <path>` 不支持 pathspec（报 `Too many revisions specified`），要用 `git diff <stash>^1 <stash> -- <path>`；③ 让 git 用 `--output` 自己写补丁文件，别经 PowerShell 文本中转，否则非 ASCII 源码会被编码破坏。

**新发现 2：守护的 `Rebuild-Desktop` 会永久挂起**
- `hermes desktop --force-build`（不带 `--build-only`）会启动 app 并一直等它退出 → 守护卡死在重建这一步，后面的"恢复 `Hermes_Gateway` 任务 + 重启网关"永远执行不到（09-10 05:27、09-12 05:42 两次都这样，日志停在 `rebuilding desktop` 后再无下文）。
- 修法：改用 `--force-build --build-only`，由 `Open-DesktopApp` 负责拉起。
- 残留影响：本次卡住使网关仍是 05:31 启动的旧模块进程（补丁 05:42 才还原），已手动 `hermes gateway restart` 补齐。

**当前状态**：v0.21.2 @ 31d0a2428e；语音补丁在位（`ppinyin`、`realtime-dialogue.ts`、avatar 路由）；桌面端用补丁版重建并运行；网关带补丁运行；无 unmerged。

**教训**：判断"本地补丁健康"要看它相对**新上游**是否**纯新增**；任何把 tracked 文件整份换成陈旧内容的自愈动作，都会静默回退上游修复。
### 记录 23：2026-09-12 唤醒词「小赫」默认开启

- 开关在 `$HERMES_HOME\config.yaml` 的 `wake_word` 段（本次把 `enabled: false` 改成 `true`）：`provider: sherpa`、`phrase: 小赫`、`capture: client`、`sensitivity: 0.3`、`surface` 缺省 `auto`、模型目录 `cache/wakewords/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`。
- **桌面端只在启动时自动 arm**：改配置后必须重启 Hermes 才生效。成功标志 `gui.log`：`wake.start(gui): listening for '小赫' (sherpa) capture=client frame=1280`；关着时是 `disabled (enabled=False, surface=auto)`。
- 判定逻辑：`tools/wake_word.wake_surface_enabled` = 配置 `enabled` 为真 **且**（`surface=auto` 或等于调用面）；`_DEFAULTS["enabled"]` 出厂 `False`。
- 为什么放在 config.yaml 而不是改代码：config 在 HERMES_HOME，不随仓库升级被 stash/覆盖；升级的"检查新配置项"只补新键，不会把它翻回 false。改前备份 `config.yaml.bak-20260912-wake`（改后逐行比对：只差这一行，中文字段完好）。
- 历史对照：09-04 / 09-06 / 09-09 的启动日志都是 `disabled (enabled=False)`，说明这项一直关着。
### 记录 24：2026-09-12 唤醒词「小赫」要有应答 —— 走豆包实时对话出声

需求：喊"小赫"不能只有一个提示音，要像以前那样有回应（"在呢，马哥"）。

**实现链路**（都在本地补丁里，随 autostash 走）：
1. 唤醒命中：`wiring.tsx` 的 `wake.detected` → `requestVoiceConversationStart()`（`store/composer.ts` 新增 `pendingWakeGreeting` latch）。
2. 实时对话启动：`use-realtime-voice-conversation.ts` 在 `startListening()` 里 `takeWakeGreeting()` → 从 `WAKE_ACKS`（`在呢，马哥` / `我在，马哥` / `嗯，马哥` / `在呢`）随机取一句，随 `session.beginTurn(greet)` 发出去。
3. 客户端 `lib/realtime-dialogue.ts`：`beginTurn(greet?)` 发 `{"type":"start","greet":"…"}`。
4. 服务端 `hermes_cli/web_routers/avatar.py`：`start` 消息带 `greet` 时排入队列，producer 调用 `session.say_hello(text)`。
5. `tools/doubao_dialogue.py` 新增 `say_hello(text="")`：`SayHello`(事件 300)，带 `{"content": "…"}` 才是"说这句"。

**豆包协议实测结论（2026-09-12，真实账号）**：
- `SayHello` + `{"content": "在呢，马哥"}` → 立刻回 TTS：`tts_sentence_start` + 4 帧音频（约 67KB / 1.4 秒）+ `tts_ended`。✅
- `SayHello` + `{}`（空） → 只有 `tts_ended`、**零音频**（bot 没配默认开场白）。
- `ChatTTSText`(事件 500) → 在本端点**完全无效果**（发出去没有事件回来），别用。
- 会话空闲约 10 秒会报 `DialogAudioIdleTimeoutError`（52000042）→ 必须持续喂音频；app 的 producer 每 250ms 补 100ms 静音（`full_duplex`），所以正常路径不会触发。

**验证**：① 协议实测（上面）；② 进程内集成测试：用假豆包会话跑 app 的 `/api/audio/dialogue` WS，发 `{"type":"start","greet":"在呢，马哥"}` → 服务端确实调用 `say_hello('在呢，马哥')` 并把 400 字节音频回给客户端，PASS；③ 打包产物 `dist/assets/index-*.js` 含应答文案；④ 重启后日志 `wake.start(gui): listening for '小赫' (sherpa) capture=client`。

**顺带修掉一个升级后遗症**：`apps/desktop/src/store/voice-prefs.ts` 丢了 `import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'`（3-way 合并把 import 挤掉了），导致设置里"实时对话"开关点了会抛 ReferenceError；`npm run typecheck` 报 `error TS2304` 才发现，已补回。**教训：每次升级后跑一次 `apps/desktop` 的 `npm run typecheck`，能捞出这类"补丁与上游 API 脱节"。**

### 记录 25：2026-09-15「升级完成后几分钟自动退出」= 守护自己两次杀 app，而且那次重建其实是失败的

**现象**：马哥在 app 里点升级（v0.21.2 → v0.21.3，05:52 完成、updater 自己把桌面端拉起来了），几分钟后 Hermes 窗口**自己消失**。

**时间线（全部实测日志）**

| 时刻 | 事件 | 证据 |
|---|---|---|
| 05:52:02 | 升级完成、updater 重新拉起桌面端 | `update.log` / `desktop-update-handoff.log: desktop relaunched detached (pid 7716)` |
| 05:52:16 | 唤醒监听起不来（补丁已被升级 park 掉） | `gui.log` WARNING `bpe.model` 不存在 |
| 05:54:02 | **守护第一次杀 app**：`taskkill /IM Hermes.exe /T /F` | `voice-guardian-20260915.log` 逐条「成功: 已终止 PID …」 |
| 05:54:07 | 守护开始整包重建桌面端（npm install + vite + electron-builder） | 同上 |
| 05:57:57 | **app 第二次退出**：构建器自己为解锁而停掉正在运行的桌面端 | `⚠ Stopped running desktop app to free the build output (pid …)` |
| 05:57:57 | 重建**失败**，守护仍打印 `AUTO-HEAL OK` 并把旧包重新拉起 | `✗ Desktop GUI build failed` 与 `AUTO-HEAL OK` 同一秒 |

**真根因（五条，按重要性）**

1. **升级用 `--keep-stash`，本地补丁必定丢**：`update.log` 明写「Local changes were stashed before updating and were NOT re-applied (--keep-stash)」。这是 app 内升级的既定参数，不是 bug —— 所以每次升级都必然触发一次"补丁回填"。
2. **守护的回填动作要杀 app**：`Close-DesktopApp` 的 `taskkill /IM Hermes.exe /T /F`（为释放 git index lock 与 Hermes.exe 文件锁）。节拍是每 30 分钟的 :24/:54，所以马哥看到的是"升级完成后几分钟突然退出"。
3. **构建器自己也会停 app**：`main_desktop.py::_build_desktop_app` 在打包前调 `_stop_desktop_processes_locking_build`（Windows 锁着运行中的 Hermes.exe，不关就打包不出来）。所以就算守护不杀，重建也会再杀一次。
4. **守护不看构建返回码**：`Rebuild-Desktop` 把 `& python -m hermes_cli.main desktop --force-build --build-only` 的输出直接灌进日志，**丢弃退出码**，于是构建失败也走 `AUTO-HEAL OK` —— 「升级显示失败但其实成功了 / 版本过旧」这类假象的温床。
5. **那次构建失败的真因是补丁只恢复了一半**：守护的三方合并对 `pet-settings.tsx` / `pet-overlay-app.tsx` 判了 "UNRESOLVED HUNKS → kept upstream"，把本地新增的 `AvatarSettings` 导出整块丢掉，而 `appearance-settings.tsx`（自动合并成功）还在 `import { AvatarSettings, PetSettings }` → vite 报 `[MISSING_EXPORT] "AvatarSettings" is not exported by "src/app/settings/pet-settings.tsx"`。

**修复（2026-09-15）**

1. **补回源码**（一次性）：对那两个文件做三方合并，冲突**只在上游新加的 `import { isSubmitEnter } from '@/lib/ime'` 那一行旁边**，按"两边都保留"解析（`SmilePlusIcon` + `isSubmitEnter` 共存）；`git add` 清掉未合并状态；`apps/desktop` 的 `npm run typecheck` 通过；整包重建成功（`✓ Desktop packaged app ready`）；应用启动后 `gui.log` 恢复 `wake.start(gui): listening for '小赫'`。
2. **守护脚本加固**（`Documents\New project\scripts\voice-guardian.ps1`）：
   - `Rebuild-Desktop` 现在检查退出码 + 校验 `release\win-unpacked\Hermes.exe` 存在，失败就 `AUTO-HEAL FAILED`（退出码 2），不再谎报成功。
   - **不再无故杀 app**：只有「app 本来没在跑」或「30 分钟内刚升级过」才关掉它重建（`Get-DesktopAppPids` / `Test-RecentUpdate`）。其它情况只还原 Python 侧补丁 + 重启网关，日志写 `AUTO-HEAL PARTIAL`，桌面重建留给下一次"app 已关闭"的节拍（退出码 3）。
   - 只有"本次关掉了 app"才会重新拉起（`$closedApp` 守卫），不再无条件 `Start-Process`。
   - 新增 `-RestoreOnly`：只还原补丁，不杀 app、不重建、不重启网关。
3. **治本：`.git/hooks/post-merge`**（`C:\Users\honey\AppData\Local\hermes\hermes-agent\.git\hooks\post-merge`）：
   升级器用的正是 `git fetch` + `git merge --ff-only origin/main`（`update_cmd.py:807`），而**桌面端重建在拉取之后**（`update_cmd.py:1254 _rebuild_desktop_after_update`）。hook 在拉取一结束就调 `voice-guardian.ps1 -RestoreOnly` 把补丁还原，于是**升级器自己那次重建就已经带补丁** —— 正常路径下守护根本不会被触发，也就不存在"升级后几分钟被杀"。
   - hook 在 `.git/hooks` 里，**不在工作区**，升级的 stash/keep-stash 永远动不到它（这是它比"改 update_cmd.py"更耐用的原因）。
   - 已实测：`git merge --ff-only`（快进）会执行 `post-merge`；用 Git 自带 `sh.exe` 跑该 hook → PowerShell → 守护脚本 → 日志落地，`exit=0`。
   - 已知覆盖不到的情况：升级器走 `git reset --hard origin/main` 兜底（上游强推/rebase 时）不会触发 post-merge，此时仍是守护兜底（30 分钟内会带 rebuildNow 重建）。

**遗留提醒**：第 6 节表格里"`update_cmd.py` 白名单内自恢复"**已经过期** —— 上游整体替换了 `update_cmd.py`，而守护对升级器自身的文件（`UpdaterOwnedPattern`）刻意"取上游"，所以那条白名单早就不在树里了。现在靠的是 post-merge hook + 守护兜底。

**验证命令**

```powershell
# 补丁是否健康（源码侧）
Select-String -Path "$env:LOCALAPPDATA\hermes\hermes-agent\tools\wake_word_engines.py" -Pattern ppinyin -SimpleMatch | Measure-Object   # > 0
Test-Path "$env:LOCALAPPDATA\hermes\hermes-agent\apps\desktop\src\lib\realtime-dialogue.ts"                                            # True
# 桌面端产物是否比补丁新
(Get-Item "$env:LOCALAPPDATA\hermes\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe").LastWriteTime
# 守护三态
& "C:\Users\honey\Documents\New project\scripts\voice-guardian.ps1" -DryRun        # 健康时应为 OK + exit 0
& "C:\Users\honey\Documents\New project\scripts\voice-guardian.ps1" -RestoreOnly   # 同上，但不碰 app
# hook 是否在位
Test-Path "$env:LOCALAPPDATA\hermes\hermes-agent\.git\hooks\post-merge"             # True
# 唤醒词是否就绪
Select-String -Path "$env:LOCALAPPDATA\hermes\logs\gui.log" -Pattern 'listening for' | Select-Object -Last 1
```

**教训**：`Rebuild-Desktop` 这类"发命令不接退出码"的包装，会把失败伪装成成功；凡是"自愈"脚本里的外部命令，都必须接 `$LASTEXITCODE` 并落进日志。
### 记录 26：2026-09-18 又见「升级失败」= post-merge 回填把 pet-overlay.ts 判成 kept upstream，补丁只回填一半

**现象**：点桌面端升级 → 界面「升级失败」；06:00 自动拉回旧包继续运行。

**时间线（实测日志）**

| 时刻 | 事件 | 证据 |
|---|---|---|
| 05:48:08 | `git merge --ff-only` 快进到 `cdceca42e1`（升级本身成功，behind=0） | `update.log` |
| 05:48:10 | post-merge hook 回填语音补丁 → `apps/desktop/src/store/pet-overlay.ts` 三方合并冲突 → 守护按既有策略 **kept upstream** | 守护日志 `UNRESOLVED HUNKS` |
| 05:57 / 06:00 | 桌面端打包失败两次，`.update_exit_code` = 1 → 界面「升级失败」 | `desktop-update-handoff.log` |
| 06:00:05 | 自动拉回旧包继续运行 | 同上 |

打包报错原文（`%LOCALAPPDATA%\hermes\logs\desktop-update-handoff.log`）：

```
[MISSING_EXPORT] "openAvatarOverlay" is not exported by "src/store/pet-overlay.ts"
  → src/components/pet/floating-pet.tsx:12
  → src/app/settings/pet-settings.tsx:21
```

**根因**：上游 `6005aa1fd9..cdceca42e1` 把 `pet-overlay.ts` 的 `$busy`/`$awaitingResponse` 换成 `PRIMARY_SESSION_VIEW.$busy`/`.$awaitingResponse`，正好压在本地补丁的上下文行上 → 三方合并冲突 → 守护「整体取上游」，把本地新增的 `openAvatarOverlay()`（含 `avatarOverlayWindowSize()`、payload 的 `avatarEnabled`/`mouthLevel`、两个 store 订阅）整块丢掉，而另两个补丁文件仍在 import 它 → vite 构建失败。与记录 25 第 5 条同病：**补丁只回填了一半，守护照样报 OK**。

**修复 A：一次性手工三方合并**

- 以上游版为底合并：`git diff HEAD` 只剩 47 增 / 2 改（那 2 行是给 `reaction:` 补逗号），上游 `PRIMARY_SESSION_VIEW` 改动一行未丢。
- 脚本 `Documents\New project\scripts\fix-pet-overlay-merge.ps1`（可重跑，内含 4 处 anchor 唯一性断言 + 从 stash 抽尾部块）。
- `apps/desktop` 的 `npm run typecheck` → exit 0（53.4s）。
- 备份：`%TEMP%\hermes-petfix-20260918-060537\`（upstream + stash 两份）与 `%TEMP%\pet-overlay.merged-20260918.ts`。

**修复 B：守护加固 —— 「文件在」≠「补丁健康」**

- 新增 `Invoke-DesktopTypecheck`：`npm run typecheck`（`apps/desktop`）作为「补丁成不成套」的廉价端到端判据（打包本身不是安全探针：它要关 app，还可能留下半换的包）。
- 新增 `$script:KeptUpstream`：任何被判 kept upstream 的路径都记账，杜绝「半回填报 OK」。
- 主路径：kept upstream 非空且 typecheck 失败 → **跳过重建**（保住上一个完整 bundle）、日志 `AUTO-HEAL FAILED`、**exit 2**。
- `-RestoreOnly`（post-merge hook 走的那条）：kept upstream 非空 → `RESTORE-ONLY INCOMPLETE` + typecheck，**exit 4**，不再谎报 OK。
- 体检门只在「补丁在场」且「30 分钟内刚升级过」(`Test-RecentUpdate`) 才跑 typecheck —— 补丁缺失时 tsc 必然失败（实测 15+ 条 TS2305/TS2339），没有这道门反而会挡住自愈本身。
- 退出码定稿：`0` healthy/healed｜`1` `--DryRun`｜`2` heal failed｜`3` deferred｜`4` patch restored INCOMPLETE。
- 顺带清掉脚本里全部非 ASCII 破折号：计划任务用 Windows PowerShell 5.1 读无 BOM `.ps1` 会按 ANSI 解码，日志出现 `OK 鈥?voice patch present` 这种 mojibake（极端情况能吞掉下一字节把字符串写坏）。

**验证（2026-09-18 实测）**

- `npm run typecheck`（`apps/desktop`）→ exit 0，53.4s。
- 临时把 `update.log` 的 mtime 设成当前（逼出「近期升级」分支）跑守护 → `typecheck OK` → exit 0，56.7s；跑完把 mtime 还原。
- 守护日志已无 mojibake。
- 整包重建 `hermes desktop --force-build --build-only` → exit 0（5 分钟，先打进 `.staging-*` 再落位）；`install-stamp.json` 的 commit 变成 `cdceca42e1`，`desktop-build-stamp.json` 的 contentHash 刷新 → **下一次点升级走「已是最新」，不再需要重建**。
- 应用拉起来后 `gui.log`：`wake.start(gui): listening for '小赫' (sherpa) capture=client frame=1280`。
- 残留的 `.update_exit_code`（失败那次写的 `1`）已改回 `0`，避免界面把旧失败当新状态。

**遗留 / 下次注意**

- 守护的 `Get-NewestVoiceStash` 用 `git stash apply`；若**未跟踪补丁文件已经在工作树里**，git 会拒（`error: could not restore untracked files from stash`）→ 回填失败却继续往下重建。生产路径不会撞（升级器的 autostash 连未跟踪一起 stash 走），只有「人为把 tracked 改动 stash 掉、未跟踪文件留在原地」的测试态才会。
- **测试教训**：不要在活的主树上做「补丁缺失」实验。那次把 tracked 改动 stash 走后，守护照旧进入重建，差点把 `win-unpacked` 覆盖成无补丁版本（在 `vite build` 阶段被打断，包没被替换）。要复现这类路径，用临时 worktree / 克隆。
- 下次升级仍要真机验收：点升级 → 预期只有升级本身那一次必要重启，且无「升级失败」。

### 记录 27：2026-09-23 Telegram 每条消息「Something went wrong」= 三次 kept upstream 丢件累计发作（09-14 / 09-17 / 09-21）

**现象**：马哥在 Telegram 给 Hermes 发语音 → 回「Something went wrong and I couldn't finish this reply. / This turn did not complete.」；随后补发的**文字**也一样挂。08:47–08:51 共 4 条进线全败。

**时间线（实测日志）**

| 时刻 | 事件 | 证据 |
|---|---|---|
| 09-14 06:24:08 | 升级回填三方合并冲突 → 守护把 5 个文件判 **kept upstream**：`apps/desktop/electron/preload.ts`、`use-composer-voice.ts`、`use-hermes-config.ts`、`gateway/run_config_loaders.py`、`gateway/slash_commands_model.py`；只留一行「re-apply the local edit by hand」，没人补 | `guardian-logs\voice-guardian-20260914.log` |
| 09-17 12:08:55 | 同法丢掉 `gateway/run_turn.py` 的两处补丁 | `voice-guardian-20260917.log` |
| 09-21 11:27:58 | 丢掉 `apps/desktop/src/app/settings/appearance-settings.tsx` 的 `<AvatarSettings />` 面板（这次守护已返回 exit 4 `RESTORE-ONLY INCOMPLETE`，同样没人处理） | `voice-guardian-20260921.log` |
| 09-11 18:14 → 09-23 08:47 | 期间 Telegram **一条消息都没有**（`gateway.log` 按日统计），丢件潜伏 9 天无人发现 | `logs\gateway.log` |
| 09-23 08:47:32 / 08:48:37 / 08:51:26 / 08:51:51 | 4 条消息全部 `TypeError: GatewayConfigLoadersMixin._resolve_session_reasoning_config() got an unexpected keyword argument 'is_voice'` | `logs\errors.log` |

**根因**：调用方 `gateway/run_turn_runner.py:1963`（本地补丁）传 `is_voice=`，而被调方 `gateway/run_config_loaders.py` 的那半边补丁在 09-14 被判 kept upstream 丢了。`is_voice_turn` 是**无条件求值后传入**的，所以文本消息一起炸——**不是语音专属**。与记录 20 报错字符串完全相同，但那次是「网关跑旧模块」（重启即好），这次是**文件级丢件**（重启无效：`git status` 里那个文件根本不在补丁集里）。

**修复（2026-09-23，全部按事故对应 stash 取原文回填）**

- 09-14（`stash@{9}`）：`gateway/run_config_loaders.py` 的 `_load_reasoning_config` / `_resolve_session_reasoning_config` 接受并透传 `is_voice`（上游函数名已从 `_load_gateway_runtime_config` 换成 `_load_gateway_config`，按现状适配）；`gateway/slash_commands_model.py` 让 `/reasoning` 面板按 voice 取值；`preload.ts` 恢复 avatar/now-playing 桥 + pet-overlay `onCursor`；`use-composer-voice.ts` + `use-hermes-config.ts` 恢复 realtime-dialogue 接线（config → `$realtimeDialogue` → `useRealtimeVoiceConversation`）。
- 09-17（`stash@{6}`）：`gateway/run_turn.py` 两处——流式语音已出声时不再重复发文字；**`_run_agent_build_turn_context(..., message_type=message_type)`**。后者尤其关键：缺了它 `turn_ctx.message_type` 恒为 `None`，语音 turn 永远拿不到 `voice.reasoning_effort`（只修 config loader 等于管道通了没水）。
- 09-21（`stash@{2}`）：`appearance-settings.tsx` 重新渲染 `<AvatarSettings />`（组件一直在 `pet-settings.tsx`，只是没人引用）。上游已加 `show('pet')` 子页 + `appearanceSettingElementId` 分组，所以按当前写法放进 pet 分组，没照抄 09-13 的裸 `<div>`。
- **刻意不搬**：09-13 版 `use-composer-voice.ts` 还含「删掉两个 TTS lease effect」，但上游这中间用 `voiceConversationActive && !liveEngineActive`（配合新的 `liveEngineActive` / `useVoiceLiveConversation`）重写了同一处，搬回来等于回退上游修复。只回填新增部分。
- 回填后**重启网关**（记录 20 的成对动作）：PID 9936 → 11096 → 23076，`telegram connected`。

**修复 B：守护加固 —— 标记表（本轮新增）**

- `scripts/voice-guardian.ps1` 新增 `$PatchMarkers`（8 条）+ `Get-MissingPatchMarkers`：每条都是**只存在于本地补丁**的字符串——`is_voice`（run_config_loaders.py）、`is_voice=_is_voice_turn`（slash_commands_model.py）、`message_type=message_type,`（run_turn.py）、`realtime_dialogue_bot_name`（adapter.py）、`getAvatarLines`（preload.ts）、`useRealtimeVoiceConversation`（use-composer-voice.ts）、`applyRealtimeDialogueFromConfig`（use-hermes-config.ts）、`<AvatarSettings />`（appearance-settings.tsx）。
- `Test-VoicePatchPresent` 现在还要过标记表；缺失就打印 `MARKERS MISSING: <文件> [<标记>]` 并返回 false → 走正常自愈路径。此前只查 `ppinyin` + `realtime-dialogue.ts` 两个文件，**python 侧丢件完全看不见**（这就是潜伏 9 天的原因）。
- 标记表是**常驻**判据，不再依赖 `Test-RecentUpdate` 的「30 分钟内刚升级」窗口：下一次 30 分钟巡检就会点出来。

**验证（2026-09-23 实测）**

- 负向：临时目录里只放 1 个带标记的文件 → 正确报出 7/8 缺失（临时目录用完即删，没动活的主树）。
- 正向：`voice-guardian.ps1 -DryRun` → `OK -- voice patch present (ppinyin + local patch markers verified)`，exit 0；脚本仍纯 ASCII、无 BOM，AST 解析 0 错。
- python：三个 gateway 文件 AST 通过；冒烟 `_resolve_session_reasoning_config(..., is_voice=True)` → `{'enabled': True, 'effort': 'low'}`（吃 `voice.reasoning_effort: low`），`is_voice=False` → `high`。
- 前端：`apps/desktop` `npm run typecheck` → exit 0。
- 重建：`hermes desktop --force-build --build-only` → exit 0（12:07:47 重建 dist，12:08 落位）；`desktop-build-stamp.json` contentHash `73c9c3b5…` → `8659f921…`。
- **产物核验（别只看 exit 0）**：该 build 把 dist 放在 `resources\app.asar.unpacked\dist`（`app.asar` 里只有头 + 资源），所以要在 unpacked 目录里查。`electron-preload.js` 含 `getAvatarLines`；渲染层是压缩过的、标识符查不到，改用**只存在于 `use-realtime-voice-conversation.ts` 的字符串字面量** `好的，你说`（源码写作 `\u597d\u7684\uff0c\u4f60\u8bf4`，全仓库唯此一处）→ 出现在新 chunk `use-pet-zoom-gesture-y4O7Tm5g.js`，证明这个此前无人 import 的模块这次真被打了进去。
- 应用拉起后 `gui.log`：`wake.start(gui): listening for '小赫' (sherpa) capture=client frame=1280`；网关 `tg connected`。

**教训 / 下次注意**

- **「kept upstream」的账可能延迟几天才结**：09-14 丢的包，09-23 才因为有人发消息而暴露（上一次 Telegram 消息是 09-11）。守护当时只写一行「re-apply by hand」，没有后续。
- 同一次三方合并可以只丢**被调方的半边**：调用方在、被调方不在 → 立刻 TypeError，而且报在 turn 建流的最外层，看着完全不像补丁问题（记录 20 报错字符串相同，处置手段相反：那次重启就好，这次必须先补文件）。
- 修本地补丁前先 `git grep` 全仓库找它的定义与调用，确认成对的两半都在同一补丁集里；桌面端 TS 补丁改了**只有重建才生效**（守护不会为「补丁齐全」的树重建），本轮为手工重建。

## 5. 手动恢复（兜底，钩子失效时）

在 `C:\Users\honey\AppData\Local\hermes\hermes-agent` 执行：

```powershell
git stash list                                   # 找最新 hermes-update-autostash-*
git stash apply stash@{0}                        # 恢复全部补丁（可能有冲突）
# 冲突自愈（记录 21）：升级器自身文件取上游 git checkout --ours -- <file>；语音补丁文件取本地 --theirs；随后 git add <file>
# 修完必须确认 git diff --name-only --diff-filter=U 为空，文件里没有 <<<<<<< / >>>>>>> 残留
# 补丁回填后必须重启网关，否则网关仍在跑旧模块（记录 20）：
hermes gateway restart
# 前端源码有变化时：
taskkill /IM Hermes.exe /F
cd apps\desktop; npm run pack
Start-Process release\win-unpacked\Hermes.exe
```

**验证**：
- `gui.log`：`wake.start(gui): listening for '小赫' (sherpa)`（无 bpe 报错）；对话时 `dialogue ws connected mode=full_duplex`。
- 后端测试：`venv\Scripts\python.exe -m pytest tests\hermes_cli\test_web_server_dialogue.py -q`（4/5 通过；实时上屏那 1 项是已移除功能）。
- 自愈测试：`venv\Scripts\python.exe -m pytest tests\hermes_cli\test_update_voice_autorestore.py -q`（7 过）。

## 6. 文件地图

| 类别 | 文件 | 升级影响 |
|---|---|---|
| 自愈钩子/白名单 | `hermes_cli/update_cmd.py` | tracked，白名单内自恢复 |
| 指引文件（必读入口） | `AGENTS.md`（hermes-agent 仓库根，含指引段落） | tracked，白名单内自恢复；**刻意不提交**（提交会被升级 reset 抹掉） |
| 语音后端 | `hermes_cli/web_server.py`、`tools/wake_word.py`、`tools/tts_tool.py`、`tools/transcription_tools.py` | tracked，白名单内自恢复 |
| 语音前端（untracked，升级不碰） | `apps/desktop/src/lib/realtime-dialogue.ts`、`pcm-*.ts`、`voice-*.ts`、`hooks/use-realtime-voice-conversation.ts`、`app/chat/voice/` | 无 |
| 赛博女友/avatar（untracked + 白名单） | `src/components/avatar/`（含 `avatar-renderer.tsx`）、`src/store/avatar.ts`、`public/avatar*.png`、`public/avatar.webp`、`public/avatar-slow.webp`、`public/avatar-still.png`、`public/avatar-lines.json`（untracked，随 stash 带回）；`electron/main.ts`、`preload.ts`、`pet-overlay-app.tsx`、`floating-pet.tsx`、`store/pet-overlay.ts`、`global.d.ts`、`src/app/settings/appearance-settings.tsx`、`src/app/settings/pet-settings.tsx`（tracked，已在白名单自动恢复） | 随 stash 带回 + 白名单自动恢复 |
| 赛博女友词库（用户可编辑） | `%APPDATA%\hermes\avatar-lines.json`（首次启动自动从内置默认生成，改台词不用重新打包） | 无（仓库外，升级不碰） |
| 赛博女友素材（用户可替换） | `%APPDATA%\hermes\avatar.webp` / `avatar-slow.webp` / `avatar-still.png`（首次启动自动从内置复制，丢新文件覆盖即可换装，不用重新打包） | 无（仓库外，升级不碰） |
| 语音 daemon（仓库外） | `~/.hermes/scripts/doubao_*.py` | 无 |
| 小可语音桥（独立 venv，解耦） | `voice-bridge\start_bridge.cmd` / `start_bridge_hidden.vbs` → `voice-bridge\.venv\Scripts\python.exe`（含 sherpa/sounddevice/pystray/av/websockets/pypinyin/sentencepiece 等） | 无（仓库外、独立 venv；升级不碰，不再堵 preflight） |
| 补丁备份（19 文件完整恢复集） | `C:\Users\honey\Documents\New project\backups\voice-restore-2026-08-20.patch` | 无 |
| 赛博女友手动备份 | `C:\Users\honey\Documents\New project\backups\avatar-restore-2026-08-22\`（tracked diff + avatar 组件/图片/视频/store） | 无 |
| avatar 配置快照（2026-08-23） | `C:\Users\honey\Documents\New project\backups\config-2026-08-23-092940\`（update_cmd/web_server/avatar-renderer/settings/AGENTS/文档原样副本） | 无（仓库外） |
| **赛博女友最终状态快照（2026-08-23 收工）** | `C:\Users\honey\Documents\New project\backups\avatar-final-2026-08-23-1516\`（avatar 全套源码 + public 素材 + 成品 app.asar + RESTORE.md） | 无（仓库外） |
| 详细恢复手册 | `C:\Users\honey\Documents\New project\hermes-desktop-realtime-voice-restore-2026-08-20.md` | 无 |

## 7. 已知残余风险

- **白名单"取我们的版本"会覆盖该文件里上游本次的新改动**：对语音文件是可接受的；`update_cmd.py` 长期会与上游漂移，若升级器行为异常按第 5 节手动处理。
- **上游 API 大改**（一年一两次）导致语音代码本身不适配：无法自动化，需人工适配；升级不会坏，只是语音需小改。
- **彻底根治**：独立语音桥（语音 I/O 与 Hermes 完全解耦），另行立项。

---

### 记录 28：2026-09-26 又见「升级失败 / 应用构建版本过旧」= 守护把「stash apply 直接 Aborting」当成回填成功，拿缺补丁的树去重建

**症状**：桌面端点升级 → 06:03:03 打包失败，`update.log` 里 7 条
`[MISSING_EXPORT] "isVoiceDictationCommand|isVoicePauseCommand|isVoiceResumeCommand|normalizeBotName" is not exported by "src/lib/voice-stop-word.ts"`
→ 界面「升级失败」；之后每次启动桌面端都进 `hermes: finishing an interrupted source update...` → 重新打包 → 再失败
（06:03 / 06:04 / 06:12 / 06:13 四次循环）。旧包没被覆盖（`win-unpacked\Hermes.exe` mtime 仍是 09-24 06:07:30），
所以还能开，但版本卡在旧上游。

**直接原因（三条，按重要性）**：

1. **守护脚本把「什么都没回填」当成成功**。06:24:03 那轮 `git stash apply stash@{0}` 的实际输出是
   `error: Your local changes to the following files would be overwritten by merge:`（列出 29 个文件）→ `Aborting`
   → `error: could not restore untracked files from stash`。因为**一个冲突标记都没有**，
   `Restore-VoicePatch` 直接 `return $true`，`$KeptUpstream` 为空 → 跳过 typecheck 闸门 → 拿一棵**仍然缺补丁**
   的树烧了 5 分钟重建（06:24:04 → 06:27:26，`npm error code 1`）。
   为什么会 Aborting：那 29 个文件的本地改动**已经在工作树里**（05:54 那轮已经三方合并回填过一批），
   `stash apply` 再叠一次必然被拒。
2. **4 个文件「有本地补丁、却没有 marker」**。05:54 的三方合并对这 4 个文件判 `kept upstream`（冲突），本地改动整块丢，
   而 `$PatchMarkers` 只覆盖了其中 2 个（`use-hermes-config.ts` / `appearance-settings.tsx`）——
   `main.ts` 的 180 行和 `voice-stop-word.ts` 的 196 行是**静默丢失**。真凶是后者少了 4 个导出，
   而调用方 `use-voice-conversation.ts` / `voice-stop-word.test.ts` 是自动合并成功的 → 只有打包时才炸。
3. **升级器 `gateway run --replace` 拉起的网关是「隐身」的**。PID 17644（06:03:01）占着 `127.0.0.1:9214`
   正常服务，但它**没写 pid 文件** → `hermes gateway status` 报 `✗ No gateway process detected`、
   看门狗 `rescuer.log` 每 30 秒 `gateway pid=None not alive, rescue` 再拉一个注定失败的新网关。
   `Stop-Process -Id 17644 -Force` 之后立刻恢复：`✓ Gateway process running (PID: 6864)`、进程数 1、
   看门狗安静、`[Telegram] Connected to Telegram (polling mode)`。

**本地补丁的正确取法（关键，别再手抄）**：`stash@{0}^1` = `1136f135dd640fff082af7859386637d347dbcd2`（09-23 14:55，
升级前的上游），`git diff stash@{0}^1 stash@{0} -- <path>` 才是**纯本地补丁**（不含上游这 2753 个提交的噪声）。
本次 4 个文件都必须**以上游为底逐处适配重贴**：

| 文件 | 本地补丁 | 上游侧变化 | 适配做法 |
|---|---|---|---|
| `apps/desktop/src/lib/voice-stop-word.ts` | +196/−4 | 只剩 2 个导出；`normalize()` 升级成 `.normalize('NFKC')` + `/\p{P}+/gu` | 中文标点那条改动**已被上游吸收**（不改）；其余照贴：PAUSE/RESUME/DICTATION 三组短语 + `BOT_NAME_ALIASES` + `normalizeBotName` + `stripAddress` 的 CJK 分支 + `isVoiceStopCommand` 走 `normalizeBotName` + 3 个新导出 |
| `apps/desktop/electron/main.ts` | +180/−1 | 第 1 行 import 多了 `type ChildProcess`；`openPetOverlay()` 多了 `!petOverlayClosing` | `import { type ChildProcess, execFile, execFileSync, spawn }`；4 个 avatar IPC + `hermes:media:now-playing` 插在 `hermes:get-remote-display-reason` 之后；光标定时器插在 `loadWindowUrl(win, petOverlayUrl(), 'Pet overlay')` 之后（**尾部上下文要收窄**，别把 `function openPetOverlay` 带进去） |
| `apps/desktop/src/app/session/hooks/use-hermes-config.ts` | +2 | 上游把 `applyBargeInThresholdFromConfig` 加回了调用链 | 保留上游那行，另加 import + `applyRealtimeDialogueFromConfig(config)` |
| `apps/desktop/src/app/settings/appearance-settings.tsx` | +4/−1 | pet 分组锚点在第 1049-1051 行 | `import { AvatarSettings, PetSettings }`；`<PetSettings />` 后插 `<div className="mt-6"><AvatarSettings /></div>` |

**本次根治（都已改）**：

1. `$PatchMarkers` 从 8 条加到 **16 条**（新增 `main.ts`、`voice-stop-word.ts`、`voice-prefs.ts`、`pet-overlay.ts`、
   `pet-overlay-app.tsx`、`floating-pet.tsx`、`pet-settings.tsx`、`global.d.ts`）。每条都实测过「上游取 0 次、工作树 ≥1 次」。
2. `Restore-VoicePatch` 不再信退出码：回填前后各数一次 `Get-MissingPatchMarkers`；
   `missingBefore > 0 且 missingAfter >= missingBefore 且 $KeptUpstream 为空` → 判定「什么都没回填」→ `return $false`。
   于是不再白烧 5 分钟重建，也不会再拿缺补丁的树去打包。
3. **订正**：`hermes_cli/update_cmd.py` 里**已经没有 `_VOICE_PATCH_FILES` 白名单**（`git grep voice_patch` 在 v0.21.5 零命中）。
   现在唯一的自恢复入口是 `.git/hooks/post-merge` → `voice-guardian.ps1 -RestoreOnly`。第 6 节「文件地图」里那条白名单说法按此作废。

**验证（实测数字）**：

- `git diff --stat`：4 文件 **+381/−5**（`main.ts` 181、`voice-stop-word.ts` 198、`appearance-settings.tsx` 5、`use-hermes-config.ts` 2）。
- `npm run typecheck`（apps/desktop）→ **exit 0**（54.1s）；`vitest run src/lib/voice-stop-word.test.ts` → **17/17 通过**。
- `hermes desktop --force-build --build-only` → **exit 0**（746.9s）：`✓ Building the web UI`（上次死在这里）、
  `✓ Packaging the desktop app`、`✓ Update complete! (v0.21.5+2299.g34343e7.dirty) [main @ 34343e79ab]`。
- `win-unpacked\Hermes.exe` mtime **09-26 06:45:20**（旧包 09-24 06:07:30）；`install-stamp.json` commit = `34343e79ab`。
- 启动桌面端**不再**出现 `finishing an interrupted source update`；`HERMES_BACKEND_READY port=13960` → `[boot] Hermes backend is ready`。
  `.update_exit_code` = `0`，仓库根无 `.update-incomplete` / `.lazy-refresh-incomplete`。
- 守护脚本：无 BOM、**0 个非 ASCII 字节**、只有 LF、AST 解析 0 错；`-DryRun` → `OK -- voice patch present (ppinyin + local patch markers verified)`，exit 0。

**未决（这次刻意没动，别当成修好了）**：

- **Group Chat worker 起不来**：`gateway.run: Group Chat worker failed to start; mutating Group Chat commands will fail closed`
  + `ModuleNotFoundError: No module named 'pydantic_core._pydantic_core'`。根因是**解释器/环境错配**：
  网关用 `tools\python-3.14.7+20260901` 跑（`Hermes_Gateway.vbs` 里 `VIRTUAL_ENV=tools`），
  但 `pydantic` 解析到了 **venv(3.11)** 的 `site-packages`，那里的 `_pydantic_core.cp311-win_amd64.pyd` 在 3.14 下加载不了
  （纯 Python 包如 `ruamel` 反而正常）。venv 自己是健康的（`venv\Scripts\python.exe` + `import pydantic_core` → OK 2.46.4）。
  上游新加的 `tui_gateway/contracts/*` 是网关里第一个 import pydantic 的东西，所以现在才暴露。
  没动的原因：改启动器会被 `publish_launchers()` 每次升级重写；改 PM 环境要动 `tools` 目录。
  补充（2026-09-26 复看）：这不是配置被改坏，而是**上游刻意的设计** —— `hermes_cli/_install_repair.py:68` 与
  `_subprocess_compat.py:125` 写明 detached 子进程就是「store python（3.14）+ `PYTHONPATH=<repo>;<venv>/site-packages`」，
  即**3.14 解释器配 3.11 的 site-packages**；纯 Python 包因此一直正常，直到上游引入第一个带 C 扩展的依赖（`pydantic_core`）。
  可选修法（都没做）：① 等上游把 `pydantic` 放进 3.14 可用的 overlay；② 在 **repo 根**放一份 3.14 版 `pydantic/` + `pydantic_core/`
  （PYTHONPATH 里 repo 排在 venv 前 → 天然遮蔽；代价是往主树塞二进制）；③ 改 `resolve_store_python()` 回退到 venv 解释器（动上游 tracked 代码，最贵）。
- 老 autostash 堆积：`update.log` 提示 **36 个**超过 7 天的 update autostash（`stash@{6}` 起），未清理。

### 记录 29：2026-09-27 又见「升级失败」= 这次不是补丁，是 git 自己断言（partial clone + MIDX 漂移）

- **症状**：`update.log` 里 `=== hermes update started 2026-09-27T06:33:35 ===` → `→ Fetching updates...` → `✗ Failed to fetch updates from origin.` + `BUG: builtin/pack-objects.c:4842: should_include_obj should only be called on existing objects`；06:34:18 `hermes update exit code: 1`，随后自动重启桌面端。**守护日志同期每 30 分钟 `OK -- voice patch present`（06:24:01 那次也是）—— 语音补丁、桌面端、应用本身全是健康的**，这次与补丁无关。
- **复现（决定性）**：手工 `git fetch --dry-run origin` 稳定重现，stderr 固定三行：`BUG: builtin/pack-objects.c:4842: should_include_obj should only be called on existing objects` / `fatal: could not finish pack-objects to repack local links` / `fatal: index-pack failed`（exit 128）。
- **定位**：从 `mingw64\bin\git.exe` 里读出同段字符串属于 `builtin/index-pack.c`（`could not start pack-objects to repack local links` / `failed to feed local object to pack-objects` / `--check-self-contained-and-connected`）—— 即 **index-pack 的「自包含 + 连通性」检查会拉起 `pack-objects` 把本地对象重打成 “local links”，断言发生在这步被喂了一个本地不存在的对象**。本仓库是 **partial clone**（`remote.origin.promisor=true`、`partialclonefilter=tree:0`）；出事时磁盘 **6 个 pack / 82 万对象（1.07 GiB）**，而 `multi-pack-index` 还是 **09-24 05:56** 写的、只记 **2 个 pack** —— MIDX 与 pack 集合已经漂移（09-26 那轮升级 fetch 又添了新 pack，而 fetch 不会重写 MIDX）。
- **修法（本次）**：`git multi-pack-index write` 重建 MIDX（约 5s）→ 同一条 `git fetch --dry-run` 立刻 **exit 0**；紧接着真实 `git fetch origin` **exit 0**，`origin/main=b9d5e4d17f`、本地落后 **717** 个提交。收尾实测：MIDX **8** = 磁盘 **8** 个 pack、`prune-packable=0`、`garbage=0`；全部 8 个 pack `git verify-pack` 均 `ok`（所以**不是数据损坏**）。
- **预防**：`git config core.multiPackIndex false`（仓库级）。MIDX 只是查询缓存，关掉它就不存在「缓存与 pack 集合不一致」这一类状态；代价是对象查询略慢，对这个 1 GB / 8 pack 的仓库可忽略。
- **诚实的边界（别把它当成已证明的因果）**：能稳定复现「修好前失败 → 修好后连续 5 次成功」，但**反向复现触发条件失败**：我做了两次受控重建 —— ① 用硬链接搭临时对象目录写出「只含 2 个 pack」的 MIDX 再跑 fetch；② 制造「MIDX 记 7 / 磁盘 8」的漂移再跑 fetch —— **都没有触发断言**。所以「MIDX 漂移」是与证据最一致的解释，但不是被证明的充分条件。**下次再见到 `should_include_obj` 这一行，第一件事是记录当时 `multi-pack-index` 里记了几个 pack、磁盘上有几个 pack**，再决定是否升级手段（`git repack -ad` / `git fetch --refetch`）。
- **附带发现**：hermes 自己内置了 `update_cmd_git.py::_git_is_trampoline` / `_ensure_non_trampoline_git`（针对 Git-for-Windows 那对 46KB shim 的 #87876 守卫），但它只认 shim 的 “fork bomb” 守卫消息；`_FETCH_FAILURE_RULES` 里**没有** `pack-objects` 断言这一类，所以界面只显示笼统的「Failed to fetch updates from origin.」，报错文案不指向真因。本机还有 `C:\Program Files\Git` 的 **2.54.0.windows.1** 可做对照，hermes 用的是 store 里的 **2.53.0.windows.3**。

### 记录 30：2026-09-28 升级失败（第三种形态）= 升级器自己拉起的网关是「隐身网关」，新版严格检查第一步就中止

- **症状**：`hermes update`（16:47:38 起）死在**第一步**，界面「升级失败」，日志是 Python traceback 而不是打包错误：
  `update_cmd_windows.py:909 _pause_windows_gateways_for_update` → `_discover_windows_gateways()` → `gateway.py:779 get_running_pid_identity_strict()` → `gateway/status.py:2092 RuntimeError("active gateway lock has no PID metadata")` → 外层 `RuntimeError: Could not map Windows gateway PIDs to profiles: Could not inspect gateway PID for profile default`，`hermes update exit code: 1`。
- **先排除掉「不是补丁、不是 git」**：守护日志 16:24 仍是 `OK -- voice patch present`；升级日志里没有 `[MISSING_EXPORT]`、根本没走到打包；09-27 那个 MIDX 断言已修好——**昨天那次升级其实成功了**（`v0.21.5+2299.g34343e7.dirty → v0.21.5+3016.gb9d5e4d.dirty` @ `b9d5e4d17f`）。
- **实测根因（一条因果链）**：昨天升级**收尾**时，升级器用 `python.exe -I -c "… runpy.run_module('hermes_cli.main', …)" gateway run --replace` 这种**包装命令行**重启网关。用网关自己的判定函数实测三种命令行：`-m hermes_cli.main gateway run` → **True**、`… gateway run --replace` → **True**、升级器那串 `-I -c …` → **False**。于是：
  - `hermes gateway status` → `✗ No gateway process detected`（而网关当时正常服务着 Telegram，`gateway_state.json` 里 `gateway_state: running`）
  - `_record_matches_live_gateway_pid()` → False → 任何状态轮询都把 `gateway.pid` 当「毒文件」删掉（手工补回 249 字节的 pid 文件，一分钟内又消失）
  - 看门狗 `rescuer.py` 每 30 秒 `gateway pid=None not alive, rescue` → **累计 4066 次**（`started_at` 可追到 09-24，说明这个状态已潜伏数天，只是旧版升级器不检查，没暴露）
  - 新版升级器（b9d5e4d1）在 `_discover_windows_gateways()` 用 `strict=True`，把「锁活着但没有 PID 记录」当**致命状态** → 升级第一步即中止
- **修法（本次，均已实测）**：① socket 优雅暂停生效（返回 `{'pausing': False, 'already_stopping': True, 'pid': 20452}`，网关自己退出，无需强杀）；② 清掉指向已死进程的 `gateway.pid`（否则新网关的 `O_CREAT|O_EXCL` 认领会失败、直接退出）；③ 用**正常启动器** `gateway-service\Hermes_Gateway.vbs` 重起。结果：`gateway.pid` + `gateway.lock` 双双写于 16:54:39（pid **28808**，argv 为 `main.py gateway run`）、`hermes gateway status` → `✓ Gateway process running (PID: 28808)`、**`find_profile_gateway_processes(strict=True)` → `[('default', 28808)]`**（就是今天抛异常的那个函数）、`rescuer_state.json` → `last_pid 28808 / last_alive true` 且再无 rescue 行。
- **防复发（已落地）**：`scripts\voice-guardian.ps1` 新增 `Get-VisibleGatewayPid` + `Repair-HiddenGateway`，在每 30 分钟 tick 里执行（`-DryRun` / `-RestoreOnly` 跳过）。判据 = `gateway_state.json` 说 `running` + 该 pid 确实活着 + `gateway.status.get_running_pid()` 返回 0；触发后走「优雅暂停 →（必要时强杀）→ 清 pid 文件 → 正常启动器重起 → 25 秒后复检」。脚本仍保持纯 ASCII、0 非 ASCII、全 LF、AST 0 错，`-DryRun` 实测 exit 0 且新代码不参与。
- **为什么必须修**：这个隐身状态是**升级器在升级收尾时自己制造的** —— 每成功升级一次就给下一次埋一颗雷。守护的 30 分钟 tick 负责拆雷，代价是升级后最多 30 分钟内再点一次升级仍会失败。
- **留给上游**：`looks_like_gateway_runtime_command_line()` 与升级器 respawn 用的启动器 argv 不一致（不认包装形式）。我们刻意**没有**去改上游 tracked 代码，避免再走上「merge 丢补丁」的脆弱链，只做「检测 + 用正常启动器重起」。

### 记录 30：2026-09-27「喊小赫 → realtime dialogue failed」= web_server.py 的 avatar 路由注册被升级吞掉（无 marker 静默丢件）

**症状**：唤醒词照常生效（`gui.log` 有 `wake.detected`），紧接着桌面端弹 `Realtime dialogue failed`，小赫不出声。

**定位（决定性证据）**：

- 报错来自 `use-realtime-voice-conversation.ts` 的 `notifyError(error, 'Realtime dialogue failed')`，即 **WS 建连阶段**就失败，不是豆包握手之后。
- 用仓库自带 venv 直接列运行后端的路由表：
  `.\venv\Scripts\python.exe -c "import hermes_cli.web_server as w; print([r.path for r in w.app.routes])"`
  → 只有上游的 `/api/audio/*`，**`/api/audio/dialogue` 与 `/api/avatar/see` 都不存在**。
- 根因：`hermes_cli/web_routers/avatar.py`（untracked，一直随 stash 带回）**没有被挂载** ——
  `hermes_cli/web_server.py` 里本地的两行注册丢了：

  ```
      avatar as _avatar_routes,                    # import 块，紧随 audio as _audio_routes,
  app.include_router(_avatar_routes.router)        # 紧随 app.include_router(_audio_routes.router)
  ```

- 何时丢的：比对 autostash 的文件清单 —— `stash@{2}`(09-23) 含 `hermes_cli/web_server.py`，
  `stash@{1}`(09-25)、`stash@{0}`(09-26) 不含；两份清单**只差这一个文件**（其余差异全是 build 产物）。
  即 09-24/09-25 之间的某次升级丢的，且**没有任何 marker 覆盖它** → 守护每 30 分钟照样报 `OK`。

**修法**：按已知好备份 `avatar-restore-2026-09-06-src\hermes_cli\web_server.py` 原样回填那两行；
备份在 `backups\web-server-avatar-route-20260927-150530\`（before / after）。
复检：路由表里出现 `/api/audio/dialogue` + `/api/avatar/see`；`git diff --stat` = `1 file changed, 2 insertions(+)`。

**防复发（本次新增）**：

- `scripts\voice-guardian.ps1` 的 `$PatchMarkers` 增加第 17 条
  `@{ File = 'hermes_cli/web_server.py'; Needle = 'avatar as _avatar_routes' }`（丢件 → 守护 `MARKERS MISSING` → 自动回填）。
- `check-avatar-after-upgrade.ps1` 同步加 marker 校验；顺手去掉过时的 `codex/avatar` 分支判断
  （现在升级是 update-in-place，仓库就在 `main` 上）。

**教训**：**untracked 的补丁文件不会丢，但"挂载它的那一行"在 tracked 文件里会丢**。
以后新增后端路由，必须同时给**注册行**加 marker —— 否则"文件在、路由不在"，守护全绿而功能是死的。

**生效条件**：后端是源码运行的（win-unpacked 里没有打包的 `hermes_cli`），所以**不需要重新 pack**；
但路由表在 import 时构建，**必须重启 Hermes 桌面端**才会重新挂载。

### 记录 31：2026-09-27「realtime dialogue failed」第二层 = 补丁代码跟上游漂移（符号被搬走 + 半回填）

**症状（修完路由后重启）**：`gui.log` 显示 `dialogue ws connected mode=full_duplex` 紧接
`ERROR dialogue config resolution failed`：

```
ImportError: cannot import name 'get_env_value' from 'tools.tts_tool'
  (hermes_cli/web_routers/avatar.py:280)
```

**真因**：上游把 `get_env_value` 从 `tools/tts_tool.py` 搬到了 `hermes_cli/config.py`
（现在 `tools/tts_streaming.py`、`tools/voice_client_config.py` 一律 `from hermes_cli.config import get_env_value`）。
补丁里还有两处从旧位置导入：`hermes_cli/web_routers/avatar.py`（桌面端语音对话）与
`plugins/platforms/telegram/adapter.py`（Telegram 语音对话，同样会挂）。
同一类漂移还有 `_session_db`（搬到 `tui_gateway/session_workdir.py`）。

**附带**：`tools/tts_streaming.py` 的 `DoubaoStreamer` 在 09-27 06:57 那次自愈里被判 `kept upstream`，
类没了（桌面端"工作助手"语音回复会静默失败）。回填时与上游新版 xAI 段冲突 →
按「**保留上游新版 + 追加豆包类**」解冲突（`git apply --3way` 后手工拼），并给该文件补了
`from hermes_cli.config import get_env_value`（类里 `available()/stream()` 用的是裸名）。

**新工具 `check-voice-imports.py`**（静态解析，不导入 hermes 模块，任何 python3.8+ 可跑）：
扫补丁文件里每个 `from MOD import NAME`，报出上游已不存在的符号。当前输出
`OK: every patched-file import resolves`。已接入 `check-avatar-after-upgrade.ps1` 末尾自动跑。

**守护 marker：17 → 19 条**，新增 `tools/tts_streaming.py → class DoubaoStreamer` 与
`hermes_cli/web_routers/avatar.py → /api/audio/dialogue`。

**前端顺带修**：服务端错误帧用的是 `{"type":"error","message": ...}`，而
`src/lib/realtime-dialogue.ts` 只读 `frame.text` → 所有后端失败都退化成笼统的
`Realtime dialogue failed`（本次两层故障都被它盖住）。已改为 `text || message`。
**注意**：这是桌面端源码，要下次 `npm run pack` 才会进包。

**教训**：**"文件在 + marker 在" 挡不住"符号被上游搬走"**。上游重构只要动到补丁依赖的 import，
功能就会在运行时炸，而且会被前端兜底文案盖住。以后动完语音/头像，除了守护自检＋
`check-avatar-after-upgrade.ps1`，还要看一眼 `gui.log` 里 `dialogue config resolution failed` 这类
`ERROR`（它带着真正的异常栈）。

### 记录 32：2026-10-03 「喊小赫后文字上屏 + 没有语音输出」= 三个补丁文件从 stash 链上漂移丢失（typecheck 短路掩盖）

**症状**：喊「小赫」进入语音对话后，识别文字被送进输入框（本该只在「听写」模式上屏），并且没有语音回复。

**真因（三层叠加）**：

1. 三个 tracked 补丁文件被判 `kept upstream`，本地补丁丢失：
   - `apps/desktop/src/app/chat/composer/hooks/use-voice-conversation.ts`（88 行本地增量：听写分流
     `onDictationText`、`isVoiceDictationCommand` / `isVoicePauseCommand` / `isVoiceResumeCommand`）
   - `apps/desktop/electron/preload.ts`（`getAvatarLines` / `getAvatarAssets` / `getAvatarPersona` / `getAvatarImage` / `getNowPlaying` 五个桥接）
   - `apps/desktop/src/app/session/hooks/use-hermes-config.ts`（`applyRealtimeDialogueFromConfig` 调用）
   丢件后 `use-composer-voice.ts`（本地版）仍把 `onDictationText` 传给上游版 hook → `TS2353`。
2. **autostash 链会漂移**：守护只从 `stash@{0}` 取补丁，而残缺版本会被下一次 autostash 固化：
   - `preload.ts` / `use-hermes-config.ts`：`stash@{0}`(10-03) 与 `stash@{1}`(10-01) 都已无补丁，只有 `stash@{2}`(09-28) 还有；
   - `use-voice-conversation.ts`：只有 `stash@{1}`(10-01) 还有。
   → 补丁丢一次，之后每次 autostash 记录的都是「没有补丁」的版本，等于永久丢失。
3. `tsc -p . && tsc -p tsconfig.electron.json && …` 是 `&&` 串联：renderer 那步失败时 electron 步骤**从未执行**，
   于是一个长期存在的 `main.ts` 重复声明（`NOW_PLAYING_PS` / `nowPlayingCache` / `readNowPlaying` 各两份）一直没被发现。

**修法**：

- 三方合并回填（base = 对应 stash 的 parent，local = 对应 stash 版本，head = 当前上游），union 型冲突手工解：
  - `use-voice-conversation.ts` ← `stash@{1}`：3 处冲突（import 合并 / `onDictationText` + 上游新 `onTranscribeAudio(owner)` 签名 / `onSubmitRef` + 三个 dictation ref）
  - `preload.ts` ← `stash@{2}`：1 处（保留 avatar/now-playing 桥接，**丢掉过时的 `skipIntro`** —— 上游已移除该 flag）
  - `use-hermes-config.ts` ← `stash@{2}`：2 处（import 与调用点 union）
- 删 `main.ts` 第二份 now-playing 块（重复声明）。
- 改前备份在 `.voice-fix\backup\`，合并脚本在 `.voice-fix\scripts\`（都带断言，可重跑）。
- `npm run typecheck` 三个阶段全绿 → `hermes desktop --build-only` 重建 → 启动；`install-stamp.commit == HEAD`，
  21 条 marker 全中。

**教训**：

1. **autostash 链不是备份**。守护「从 stash 取补丁」隐含假设 stash 里有补丁；一旦某次 `kept upstream`，补丁在链上就没了。
   取补丁前应先确认该 stash 确实含目标 marker，不含就往旧 stash 回溯（本次回溯了 1~2 代才找到）。
2. **typecheck 要逐段看**。`tsc -p .` 失败时 electron 段根本没跑；补丁回归必须确认三个阶段都过，别只看第一条报错。
3. **上游会删功能**：恢复本地补丁不能整块照抄，`skipIntro` 这类上游已移除的片段要随上游一起删。

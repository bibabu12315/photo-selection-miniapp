# 43 · 开发状态跟踪

> **定位**：进度看板 + 变更日志 + 阻塞登记。
>
> **Coding Agent 规则**：每完成一个 T-xx，**必须更新本文件**——把任务标记完成，并在「变更日志」追加一行（AI-8）。
>
> **状态取值**：`pending`（未开始）/ `doing`（进行中）/ `done`（已完成并自测）/ `blocked`（受阻，需说明）

---

## 一、总览

| 阶段 | 任务数 | 完成 | 进行中 | 受阻 | 进度 |
|---|---|---|---|---|---|
| P0 地基与安全 | 6 | 6 | 0 | 0 | 100% |
| P1 网页控制台 | 8 | 8 | 0 | 0 | 100% |
| P2 端收敛与治理 | 5 | 5 | 0 | 0 | 100% |
| P3 体验与上线 | 5 | 5 | 0 | 0 | 100% |
| **合计** | **24** | **24** | **0** | **0** | **100%** |

**当前应做的任务**：**功能开发 24/24 全部完成**。剩余全是「部署 + 手动验证」，按 `53_RELEASE_CHECKLIST.md` 顺序做：部署云函数 → 静态托管 → 小程序上传清数据 → **数据库全量导出备份**（回滚保险，不能省）→ 提交审核 → 发布后 30 分钟内验证
**用户指令（2026-10-05）**：订阅通知（T-P2-3）**暂时跳过**，不再推进验收；T-P3-5 里「模特提交 → 摄影师收到通知」这条验证同步跳过。其余（envVersion → release、静态托管、日志清理）照做

> 🆕 **2026-10-05 进入新阶段：UI 重设计（D-1 已启动，功能冻结）**。
> 新对话提示词与文档清单见 **`START_HERE.md` 第零节**；实施计划 `docs/54_UI_REDESIGN_PLAN.md`；接口规格 `docs/55_PHOTO_LIST_API_SPEC.md`；设计稿 `docs/ui-redesign/spec.html`（V1.2）。
> 本轮**不改业务规则 / 状态机 / 常量 / 接口语义**，只做 UI + 补必需数据接口。进度记在「二点六」。

> ⚠️ **灰度陷阱（改完 envVersion 后必读）**：`envVersion` 已改为 `release`，但小程序还没发布正式版。此刻起**体验版扫码会失效**（提示「该小程序尚未发布」）。如果还要用体验版继续测，把 `project/index.js` 与 `session/index.js` 里的 `release` 改回 `trial` 并重新部署；正式版上线后再改回来。

> **P0 阶段已完成（2026-10-05）**，建议跑一遍真机回归（首页 → 项目列表 → 详情 → 邀请 → 模特选片提交 → 结果）再进 P1。
> **扫码登录链路已验证通过（2026-10-05 13:26）**：网页出码 → 扫码（体验版）→ 自动进入 `#/projects`。

**当前基线**：`master @ c3f76e2`（V1.2 + V2.2 云成本优化已完成）

---

## 二、任务状态表

### P0 · 地基与安全

| 编号 | 任务 | 状态 | 完成日期 | 备注 |
|---|---|---|---|---|
| T-P0-1 | 接入 resolveCaller | `done` | 2026-10-05 | project / selection 双份副本，action 保留原有第二重校验 |
| T-P0-2 | session 云函数与集合 | `done` | 2026-10-05 | 六个 action 已写完；**集合与索引需你在控制台手动创建** |
| T-P0-3 | 提交后严格锁定 | `done` | 2026-10-05 | 后端 locked 拦截；重复提交走幂等成功；前端删「继续调整」+ 重进直接落终态 |
| T-P0-4 | 状态值收敛 | `done` | 2026-10-05 | `COMPLETED` / `EXPIRED` 全项目零命中；删 extend 死分支；补齐 ARCHIVED 展示文案 |
| T-P0-5 | 修归档被回拉 Bug | `done` | 2026-10-05 | 状态推进同时排除 ARCHIVED；getPreview 补 `ERR_ARCHIVED` |
| T-P0-6 | 删除 ping | `done` | 2026-10-05 | 前端零引用已确认，目录已删；**云端也要删否则仍计费** |

### P1 · 网页控制台

| 编号 | 任务 | 状态 | 完成日期 | 备注 |
|---|---|---|---|---|
| T-P1-1 | 网页脚手架 + 扫码登录 | `done` | 2026-10-05 | 代码完成；**待真机扫码验证**。hash 路由 + 登录页 + 轮询 + token 持久化 |
| T-P1-2 | guide 页扫码分支 | `done` | 2026-10-05 | **已验证**：扫码 → claim → 网页自动进入。scene 22 位票据识别在身份检查之前 |
| T-P1-3 | 项目列表 + 新建 | `done` | 2026-10-05 | 代码完成；列表字段/状态映射/新建弹窗/三态齐全；**待刷新网页验证** |
| T-P1-4 | 上传链路改造 | `done` | 2026-10-05 | 代码完成；**需部署 photo 云函数 + 上传 4 个网页文件后验证** |
| T-P1-5 | 画质预览对比 | `done`（返工 1 次） | 2026-10-05 | 第一版滑块形态实测不可用（附录 A），按新定稿的 12 文档返工为双视口同步对比 |
| T-P1-6 | 邀请二维码 | `done` | 2026-10-05 | 代码完成；`envVersion` 随 T-P3-5 已改 `release`（灰度期回退见总览下方提示） |
| T-P1-7 | 结果查看 + 导出 | `done` | 2026-10-05 | getProjectResults + 模特 tab + 复制/CSV（带 BOM） |
| T-P1-8 | 项目操作 | `done` | 2026-10-05 | 延期/归档/删除/解锁随 T-P1-4、T-P1-6 一并实现 |

### P2 · 端收敛与治理

| 编号 | 任务 | 状态 | 完成日期 | 备注 |
|---|---|---|---|---|
| T-P2-1 | 移除小程序新建入口 | `done` | 2026-10-05 | FAB + goCreate 已删；空态改「请在电脑上打开控制台创建项目」；顶部加「完整管理请在电脑上操作 + 复制控制台地址」；project-create 目录保留 |
| T-P2-2 | 解锁文案修正 | `done` | 2026-10-05 | selection-result 弹窗改「可加可减」，后端 resetLock 行为未动 |
| T-P2-3 | 订阅消息通知 | `done`（代码完成，待最终验收） | 2026-10-05 | 模板已申请通过（用户 2026-10-05）；环境变量已配（B-4 解决）；期间修两个部署配置问题：云函数默认超时 3 秒（B-5 前置）、selection 缺 openapi 权限声明（B-5）。**待用户：重新部署 selection → 等 10 分钟 → 真机重测** |
| T-P2-4 | usedBytes 校准 | `done` | 2026-10-05 | 新增 `recomputeProjectUsage`（photo 分页聚合 + invite.qrBytes），归档/续期两个节点覆盖计数器；二维码按「新旧差值」inc；`deleteFiles` 多返失败明细，删除失败的 preview 按 BR-904 不扣减 |
| T-P2-5 | previewSpec 回写 | `done` | 2026-10-05 | `project.create` 删 previewSpec；`registerPhoto` 按本次档位回写最近一次（新图与重传两条分支都写）；`uploader.js` 随登记带上 preset / watermarkText（C-21） |

### P3 · 体验与上线

| 编号 | 任务 | 状态 | 完成日期 | 备注 |
|---|---|---|---|---|
| T-P3-1 | 图片淡入 | `done` | 2026-10-05 | `<image>` 加 `bindload` → `onThumbLoad` 写 class（100ms 内命中缓存用 `fast` 直接显示，其余 `anim` 200ms 淡入）；`.thumb` 默认 opacity 0，占位靠格子底色 |
| T-P3-2 | 三态补齐 | `done` | 2026-10-05 | `client-select`：补空态（摄影师还没传照片 + 刷新）与「未保存」常驻提示条（替掉原来每次都弹的 Toast，成功必须静默 BR-503）；`selection-result`：加载失败由纯弹窗改为页内错误态 + 「点此重试」。home / model-home / 网页端已具备三态，核对通过 |
| T-P3-3 | 提交终态提示 | `done` | 2026-10-05 | T-P0-3 时已一并实现，本次逐条核对完成标准：已提交确认 + 已锁定说明 + 「如需修改请联系摄影师」 + 已选张数回显 + 重进直接落终态 + 无「继续调整」入口，全部满足（无需改代码） |
| T-P3-4 | 上传完成提示 | `done` | 2026-10-05 | `uploader.js`：结束必显示「成功 N / 共 M 张（占比%）+ 用时 X 秒」，有失败时在下一行列失败文件名；本来就有的「重试失败项」与下一步引导保留，不弹 Toast 覆盖详情 |
| T-P3-5 | 上线前配置三项 | `done`（代码侧） | 2026-10-05 | ① `envVersion` → `release`（`project.getInviteQrCode` + `session.createTicket` 两处，B-3 关闭）；② `project/config.json` 的 openapi 权限已含 `subscribeMessage.send`、模板 ID 已申请通过（B-1/B-4，但按你的指令**不验收订阅链路**）；③ 静态托管已开通在用；④ 顺手做掉发布前检查：`ping` 已删、全项目无 `COMPLETED` 残留、`app.ts` 的 `console.log`（含 openid）改为仅非正式版输出。**剩下全是手动活**：部署云函数 → 清 TEST- 测试数据 → **数据库导出备份** → 提交审核 → 发布后 30 分钟内验证 |

---

## 二点五、延后事项（基础功能跑通后再做，不进当前任务表）

| 编号 | 事项 | 提出时间 | 说明 |
|---|---|---|---|
| D-1 | **网页控制台 UI 重做**（视觉、布局、组件统一） | 2026-10-05 | 用户反馈当前网页端界面简陋。**约定：先把 V2 基础功能全部跑通，再单开一轮统一重做**。届时预期 `console.css` 全量重写 + `console.js` 模板抽取；现在改会被后续功能迭代推翻 → **状态：2026-10-05 已启动**，范围扩大为三端统一重设计，见「二点六」 |

---

## 二点六、UI 重设计阶段进度（2026-10-05 起）

> 依据 `54_UI_REDESIGN_PLAN.md`，状态取值同主表：`pending` / `doing` / `done` / `blocked`。
> 视觉依据 `docs/ui-redesign/spec.html` V1.2；接口依据 `docs/55_PHOTO_LIST_API_SPEC.md`。

| 编号 | 任务 | 状态 | 依赖 | 说明 |
|---|---|---|---|---|
| U-0 | `photo.list` 接口（`photo` 云函数新增 `list` action） | `done`（代码） | — | **全局前置**；A-4 / B-4 都是它下游。已实现，规格见 55，**验收见 55 第 6 节（需先部署 `photo` 云函数）** |
| U-1 | 设计 Token 落地（三端统一色板 / 字号 / 圆角） | `done` | — | 54 第 1 节；`--ok` 由 `#1d9e75` 改 `#2F7D4F`。旧变量名（green/amber/red 等）保留为别名，现有样式零破坏 |
| U-2 | 阶段 A 网页端：A-1 侧边栏 / A-2 登录页 / A-3 卡片网格 / A-4 照片墙 / A-5 上传抽屉 / A-6 结果页 | `done`（代码） | U-0（仅 A-4） | 54 第 3 节；A-1~A-6 全部落地，**待部署静态托管后验收**。两处降级见本表下方备注 |
| U-3 | 阶段 C 模特端：C-1 我的拍摄 / C-2 选片瀑布流 / C-3 大图 / C-4 锁定态 | `done` | — | 54 第 5 节；**`gest.wxs` 一行都不要动**。C-1 补剩 X 天 chip（≤7 天橙）+ 进度条 + 「看的是云端预览图」说明；C-2 JS 分列两列瀑布流（列宽 347rpx，高度 = 列宽×原图高/宽，缺宽高按 3:2 兜底，裁到 220~700rpx）；C-3 只改 bottombar 视觉（文件名等宽+底块、选中按钮统一 `#4CAF7D`）；C-4 锁定态文案改「已锁定 · 如需修改选片，请联系摄影师重新开放」，**无自行修改入口**。另：**D-4 已确认后端生效**——`selection.myList` 按 openid 查 model 的全部 invite，历史项目都会返回，无需新增功能 |
| U-4 | 阶段 B 摄影师端：B-1 引导页 / B-2 列表卡片 / B-3 详情进度条 / B-4 照片墙合一 | `done` | U-0（仅 B-4） | 54 第 4 节；**不加新建项目按钮**（已拍板）。B-1 引导页加分隔线 + 模特粘贴链接框（22 位 token 校验，抠不出来提示「向摄影师要一条邀请链接」，不跳转）；B-2 顶部改显眼引导条（主色描边 + 实心复制按钮）+ 卡片补剩 X 天 chip / 提交进度条 / 「去电脑上传 ›」线索；B-3 详情加四步派生进度条（上传→选片→提交→导出，**不落库**）+ 照片墙入口；B-4 列表视图保持「已选清单」不动，**网格视图改照片墙**（全部/已选/未选 + 2 列瀑布流 + 「这张被谁选中」标签 + 分页 18 + 失败重试），新增 `miniprogram/services/photo.ts` |
| U-5 | 阶段 E 体验增强：A 档 8 项 / B 档 3 项 | `完成` | B 档依赖 U-0 | 54 第 9 节。**已做**：E-1（提交二次确认）、E-2（模特端底栏「还能选 X 张」）、**E-3**（空态各带动作：小程序摄影师端/照片墙空态/模特端空态、网页端照片墙空态「↑ 上传照片」按钮；网页项目列表空态与模特面板空态原本已有「新建项目 / ＋邀请模特」按钮）、**E-4**（剩 3 天红、7 天橙；小程序卡片 + 网页卡片都给「续期 30 天」，复用 `project.extend`）、**E-5**（模特端首次进选片页 3 秒引导蒙层，storage `ps_guide_sel` 只弹一次）、**E-6**（网页详情页照片数>0 且模特数=0 时出现「照片已就位，现在邀请模特选片」引导卡 + 一键开邀请弹窗）、**E-7**（模特面板「已提交 2/3」汇总 + 「催一下」）、**E-8**（网页 Tab 写 localStorage `ps_wall_filter`；小程序选片成果页视图写 storage `ps_result_view`）、**E-10**（模特端「全部 / 已选」Tab，本地过滤）。**未做**：E-11 模特历史回看（D-4 待确认，需单独排期）；E-9「这张被谁选中」已随 B-4 白送 |
| U-W1 | 真机问题修复两连（2026-10-05 晚）：① 小程序摄影师端照片墙白屏/不像网页端 → **页面重构为照片墙优先**；② 网页端大图加载失败 → **大图取链改走云函数** | `done`（代码） | U-0 | ① `selection-result` 重写：默认视图=照片墙（两行导航：筛选 Tab + 搜索框吸顶，已选档下模特 chips 行，与网页端同构），格子点开大图（`wx.previewImage`），底部「查看选片清单」切到原清单视图（模特 Tab + 文件名列表 + 复制 + 重新开放，原功能不动）；`project-detail` 两个入口分别带 `view=wall` / `view=list`。② `photo` 云函数新增 `previewUrl` action（鉴权+归属校验后服务端取单张大图临时链接，归档返回明确提示）；`web/console.js` `openLightbox` 改走 `callCloud('photo','previewUrl')`，不再依赖浏览器端 `getTempFileURL`（存储安全规则/匿名身份任一变动都不会再挂）；小程序 `services/photo.ts` 同步加 `getPreviewUrl`。**需重新部署 `photo` 云函数 + 重传 web + 重传小程序才生效** |
| U-6 | 画质预览对比弹窗：视觉重做 + 层级修复（A-7） | `待开工` | U-2 | **【Bug】弹窗被上传抽屉压灰**：`.qt-*` 样式全部缺失（`console.css:957-990` 仅 5 条残留），弹窗无图层按文档流渲染，被 `.scrim`(z-40) 盖住。修复=补齐全套 `.qt-*`，`.qt-mask` 为 fixed z-70。视觉按 PS「存储为 Web」深色工作台重做。依据：`12` 附录 B + `54` A-7 + `web-ui-v2.html` SECTION 10。**红线：quality.js 交互逻辑一行不改** |
| U-7 | 自定义档单滑条（弹窗/抽屉互通）+ 水印满屏斜向平铺（A-8） | `待开工` | U-6 | 单滑条=档位轴插值（0=标准 1600/0.75 → 300=原画质 4096/0.92），clamp 收敛 1600~4096/0.75~0.92；互通单源 `presets.custom`（弹窗滑条→重生成 blob→回写抽屉；抽屉→弹窗再开一致）。水印改满屏斜向平铺：rotate -24°、白、alpha 0.16、字号 min(w,h)×2%、间距×9，pattern 实现，preview+thumb 都打，弹窗两视口同步叠加。依据：`12` B-3 + `54` A-8 + SECTION 10 |

**U-2 两处降级（有意为之，不是漏做）**：

| 项 | 54 要求 | 实际做法 | 原因 |
|---|---|---|---|
| 侧边栏「设置」 | 三个导航项：项目列表 / 选片结果 / **设置** | 只做前两项 + 底部「退出登录」 | 项目没有设置页，凭空造一个属于擅自加功能。真要做请单开需求 |
| A-6 结果页瀑布流 | 网格改瀑布流 | **保持 grid**，只做视觉对齐（圆角/间距/等宽字/「已确认 N 位」徽标） | ① 结果数据只有 `thumbUrl + filename`，**没有 `width/height`**，做不出原始比例；② CSS `columns` 是竖向填充，会把「按文件名升序」的阅读顺序（`BR-803`）变成先列后行。要真瀑布流需 `selection.getResult` 补尺寸字段，属后端项 |

**新增登记（A-4 连带）**：`photo.list` 出参加了一个 `previewFileID` 字段（55 文档 1.3 同步更新）——点开大图要按张换临时链接，批量取会白烧 `getTempFileURL` 调用。归档项目取大图会失败，前端提示「已归档，续期后可重新上传」，属预期。

**已拍板，别再改**：
1. 小程序端**不加**「新建项目」按钮（`BR-206` / `BR-1204`），改做「复制控制台地址」显眼引导条；
2. 全底片照片墙**必做**，三端统一真瀑布流（原始比例、按列填充、4~8px 缝）；
3. **提交即锁定，重开权在摄影师**，模特端无任何自行修改入口（`BR-601/602/605`，与现有规则一致，不用改规则）；
4. 摄影师端可看照片、不可上传、不可代选；模特回看的是云端预览图（ARW 不上云），窗口 = 存续期。

---

## 三、阻塞登记

| 编号 | 阻塞项 | 影响任务 | 状态 | 解决方式 |
|---|---|---|---|---|
| B-1 | 订阅消息模板未申请（审核 1~3 天） | T-P2-3、T-P3-5 | **已解决 2026-10-05** | 模板「用户加入任务提醒」审核通过；ID `Ftb4YWeLOPWm69U0p7ucsKOVXOOGdd_lU9cU0fNRXoY`；字段 thing1=用户(模特名) thing2=任务名称(项目名) time3=时间 |
| B-2 | 云开发静态托管未开通 / 安全域名未配 | T-P1-1 | **已解决 2026-10-05** | 已开通；域名 `cloud1-d2guu7uw1a306815a-1499127316.tcloudbaseapp.com` |
| B-3 | `envVersion` 仍为 `trial` | T-P1-6、session.createTicket | **已解决 2026-10-05** | 两处均已改 `release`。注意：正式版未发布期间体验版扫码会失效，见总览下方灰度陷阱 |
| B-4 | **selection 云函数环境变量未配置** | T-P2-3 | **已解决 2026-10-05** | 用户已在控制台配好 `SUBSCRIBE_TPL_ID` / `SUBSCRIBE_MSG_STATE=trial`（日志证实已走到推送环节，未再报「跳过」）。正式发布前 `SUBSCRIBE_MSG_STATE` 改 `formal`（与 B-3 同批） |
| B-5 | 推送报 `-604101`（function has no permission to call this API） | T-P2-3 | **已修代码，待重新部署验收** | 根因：实际发推送的是 `selection` 云函数，但 `subscribeMessage.send` 权限声明错配在 `project/config.json`，selection 没声明。已补 `selection/config.json` 的 `permissions.openapi`。注意：① 权限配置有约 10 分钟缓存，部署后稍等再测；② 云调用必须由小程序端真实触发，云端「测试」按钮触发的调用一律报 ERR_NO_AUTH/-604101 属正常 |

> 新增阻塞项时追加一行；解决后在「状态」写 `已解决 + 日期`。

---

## 四、环境配置清单（待填）

> 开源时要把这些抽成配置模板。当前先登记，避免遗漏。

| 配置项 | 当前落点 | 值 | 是否需脱敏 |
|---|---|---|---|
| 小程序 AppID | `project.config.json`、`web/upload.js` | `wxe950960fdf45e0b5` | ✅ 开源前改占位符 |
| 云开发环境 ID | `miniprogram/env.ts`、`web/upload.js` | `cloud1-d2guu7uw1a306815a` | ✅ 开源前改占位符 |
| 静态托管域名 | `web`（部署根目录） | `https://cloud1-d2guu7uw1a306815a-1499127316.tcloudbaseapp.com` | ✅ |
| 订阅消息模板 ID | 待申请后填 | — | ✅ |
| 上传页 URL | `miniprogram/env.ts` | — | ✅ |

---

## 五、变更日志

> 每完成一个任务追加一行。**格式**：`日期 | 任务编号 | 一句话改动 | 涉及文件`

| 日期 | 任务 | 改动 | 涉及文件 |
|---|---|---|---|
| 2026-10-05 | — | 文档体系建立：`40` 开发规则、`41` 编码规范、`42` 任务拆分、`43` 状态跟踪 | `docs/40~43` |
| 2026-10-05 | UI | **UI 重设计阶段启动**：新增 `54`（实施计划，含 D-1~D-4 决策 / A·B·C 三阶段任务 / 瀑布流规范 / 第 9 节 PM 增强清单）、`55`（`photo.list` 接口规格）；`22_API` 登记 4.4；`START_HERE` 加第零节（UI 阶段提示词与文档清单）；43 加「二点六 UI 阶段进度表」 | `docs/54`、`docs/55`、`docs/22_API.md`、`docs/START_HERE.md`、`docs/43`、`docs/ui-redesign/spec.html`（顶部加落地说明） |
| 2026-10-05 | T-P0-1 | project / selection 各加一份 `resolveCaller` + `openidBySessionToken`；入口改为 `await resolveCaller(event)`，无身份返回 `ERR_NO_AUTH` | `cloudfunctions/project/index.js`、`cloudfunctions/selection/index.js` |
| 2026-10-05 | T-P0-2 | 新建 `session` 云函数（createTicket / claim / poll / verify / logout / cleanup）+ `package.json` + `config.json`（wxacode.getUnlimited） | `cloudfunctions/session/*`（新建 3 个文件） |
| 2026-10-05 | T-P0-1 修正 | `openidBySessionToken` 的过期字段由 `expireAt` 改为 `tokenExpireAt`，与 session 集合写入保持一致 | `cloudfunctions/project/index.js`、`cloudfunctions/selection/index.js` |
| 2026-10-05 | T-P0-3 | `saveSelection` 加 locked 拦截（已提交拒绝写入）+ 重复提交幂等返回成功；删除 `reopen`「继续调整」；已提交模特重进直接进只读终态；提交弹窗文案改锁定口径 | `cloudfunctions/selection/index.js`、`miniprogram/pages/client-select/index.ts`、`index.wxml` |
| 2026-10-05 | T-P0-4 | 删 `types/index.ts` 的 `COMPLETED`/`EXPIRED` 类型、`format.ts` 的两个映射；删除 `project.extend` 的 EXPIRED 死分支；补 `ARCHIVED: '已归档'` 文案 | `miniprogram/types/index.ts`、`miniprogram/utils/format.ts`、`cloudfunctions/project/index.js` |
| 2026-10-05 | T-P0-5 | `updateModelSummary` 状态推进同时排除 `ARCHIVED`；`getPreview` 归档分支补 `code:'ERR_ARCHIVED'` | `cloudfunctions/selection/index.js` |
| 2026-10-05 | T-P0-6 | 删除 `cloudfunctions/ping/`（前端零引用已 grep 确认） | `cloudfunctions/ping/` 整个目录 |
| 2026-10-05 | T-P1-1 | 新建 `web/session.js`（token 封装 + callCloud）与 `web/console.js`（hash 路由 + 扫码登录 + 2s 轮询 + 过期刷新 + 退出登录）与 `web/console.css`；`index.html` 加登录页与控制台骨架，旧三步向导收敛为 `#/upload` 兜底入口；本地 `web/session.js` 不碰 `upload.js` 传输层（C-1） | `web/index.html`、`web/session.js`、`web/console.js`、`web/console.css` |
| 2026-10-05 | T-P1-2 | guide 页 `onLoad` 最先解析 scene，22 位票据调 `session.claim`，页面内提示「登录成功，请回电脑」；无 ticket 流程不变。**session.claim 行为变更：未开通摄影师由拒绝改为自动开通**（对齐 11 规范「首次扫码自动开通」）；`envVersion` 用 `trial`（体验版），上线改 `release`（B-3） | `miniprogram/pages/guide/index.ts`、`index.wxml`、`index.wxss`、`miniprogram/services/session.ts`（新建）、`cloudfunctions/session/index.js` |
| 2026-10-05 | 验证 | 扫码登录全链路通过：需在 mp 后台「选为体验版」后 `trial` 码才可扫（代码上传 ≠ 体验版） | — |
| 2026-10-05 | T-P1-3 | `console.js` 实现项目列表（状态唯一映射函数 + 模特进度 + 剩余天数 + 容量 + 三态 + ERR_NO_AUTH 踢回登录）与新建弹窗（名称≤30 必填 / packageCount 0~999 / expireDays 1~365 默认 30；按钮防连点，create 非幂等不自动重试）；`index.html` 加弹窗结构；`console.css` 加列表/徽章/弹窗样式 | `web/console.js`、`web/index.html`、`web/console.css` |
| 2026-10-05 | T-P1-4 | `photo` 云函数新增 `issueUploadSession`（sessionToken → openid → 项目归属校验 → 签 24h uploadToken；失败码 ERR_NO_AUTH / ERR_NOT_FOUND / ERR_ARCHIVED）。新建 `web/uploader.js`（移植 upload.js 的 traverseEntry / decode / render / 并发 3 / thumb 320/0.70 / 画质四档；用 session.js 的 Cloud 实例上传）。`console.js` 实现项目详情页（面包屑 + 头部 + 上传区 + 照片概览，上传后只刷新概览区）。`console.css` 加详情页与上传区样式；`index.html` 引 uploader.js | `cloudfunctions/photo/index.js`、`web/uploader.js`（新建）、`web/console.js`、`web/console.css`、`web/index.html` |
| 2026-10-05 | 小修 | 占位页（详情 / 结果）补「← 返回项目列表」链接 | `web/console.js`、`web/console.css` |
| 2026-10-05 | T-P1-6 + C-12 | 详情页补齐：① 头部操作「延期 30 天 / 归档（省空间）/ 删除项目」—— 确认弹窗严格按 `11` §1，只有归档与删除弹、延期不弹；② 模特与邀请区（区域 6+7 合并）：每位模特一行含进度徽章 + 已选张数 +「二维码 / 复制链接 / 允许重选 / 查看结果 / 移除」；③ 邀请弹窗（名字必填 ≤20，满 5 位隐藏入口）；④ 二维码走 `getInviteQrCode` 取 fileID → 临时链接展示 + 下载 PNG，页内缓存 fileID 防重复产图；⑤ 轻提示 Toast（2 秒）。上传进行中禁止会重渲染页面的操作 | `web/console.js`、`web/index.html`（邀请弹窗 + Toast 容器）、`web/console.css` |
| 2026-10-05 | T-P1-7 | `selection` 新增 `getProjectResults`（一次返回全部模特 filenames，服务端升序，零临时链接，非本人与不存在同码）；网页结果页：模特 tab + 全部合并（去重）+ 复制文件名（失败降级选中文本）+ 导出 CSV（**带 BOM**，列=序号/文件名/模特备注名）+ 缩略图按需加载并缓存 + 允许重选 + 空态 | `cloudfunctions/selection/index.js`、`web/console.js`、`web/console.css` |
| 2026-10-05 | T-P1-5 | 新建 `web/quality.js`：第一张样张本地生成四档、左右滑块对比、适应窗口/100% 切换、每档「长边/q/≈MB/张」+ 这批 N 张估算、点卡片选档回写上传下拉；`uploader.js` PRESETS 补 `perMb`；上传区加「画质预览对比」按钮 | `web/quality.js`（新）、`web/uploader.js`、`web/console.js`、`web/index.html`、`web/console.css` |
| 2026-10-05 | C-13 | 用户拍板：**移除模特必须二次确认**，已加 confirm（文案含模特名与已选张数） | `web/console.js` |
| 2026-10-05 | T-P2-1 / T-P2-2 | 小程序端收敛：home 删 FAB 与 goCreate、空态改「请在电脑上打开控制台创建项目」、顶部加提示条 + 复制控制台地址；`selection-result` 解锁文案改「可加可减」（R-2） | `miniprogram/pages/home/index.{wxml,ts,wxss}`、`miniprogram/pages/selection-result/index.ts` |
| 2026-10-05 | T-P1-5 返工 | 用户反馈三个缺陷：适应窗口看不出差异（下采样抹平，属形态缺陷）、100% 布局错乱（A/B 生成分辨率不同构图错位）、拖线坐标错乱。**新建 `12_QUALITY_PREVIEW_SPEC.md` 定稿**（需求 + 交互 + 技术要点 + 7 条验收用例 TC-QT-01~07 + 附录 A 缺陷记录），已挂入 START_HERE 文档地图。按文档返工 `quality.js`：废弃滑块，改**左右双视口同步对比**（同一显示宽度构图自动对齐、滚轮以光标为锚缩放、按住拖动平移、适应窗口/100%/200% 按钮、视口左上角档位标签、切档不动视图状态）；`console.css` 旧滑块样式整段替换 | `docs/12_QUALITY_PREVIEW_SPEC.md`（新）、`web/quality.js`、`web/console.css` |
| 2026-10-05 | T-P2-3 | 订阅通知全链路：① ``createInvite`` 加 notify 参数（22_API 3.8，invite 写 notifyAuth/notifyAuthAt）；② 新增 ``setInviteNotify`` action（授权登记）；③ ``selection`` 提交成功后 ``notifyOwnerSubmit``：查 invite.notifyAuth → ``subscribeMessage.send``（thing1=模特名 thing2=项目名 time3=提交时间，page 跳项目详情）→ 推完置 notifyAuth=false 消耗额度；**失败只记日志不回滚**（43101 未订阅等）；重复提交走幂等分支不会重复推；④ 小程序 project-detail 每位模特行加「通知我」按钮：wx.requestSubscribeMessage 允许后调 setInviteNotify，授权过则隐藏；⑤ project/config.json 加 openapi 权限 subscribeMessage.send；模板 ID：云函数侧走环境变量（B-4），小程序侧放 env.ts ``SUBSCRIBE_TPL_ID`` | `cloudfunctions/project/index.js`、`config.json`、`cloudfunctions/selection/index.js`、`miniprogram/services/project.ts`、`miniprogram/env.ts`、`miniprogram/pages/project-detail/index.ts`、`index.wxml` |
| 2026-10-05 | C-19 | 登记授权入口偏差（见冲突登记 C-19） | — |
| 2026-10-05 | T-P2-3 调试① | 真机报 `-504003` 超时：微信云函数默认超时仅 3 秒（官方 uploadFuncConfig 证实，1-300 秒可配）。全部 5 个云函数 config.json 加 `timeout: 20`。config.json 支持 timeout（与不支持 envVars 的结论并存，不能类推） | `cloudfunctions/*/config.json`（project、session 改，selection、photo、admin 新建） |
| 2026-10-05 | T-P2-4 | usedBytes 校准：① `project/index.js` 新增 `recomputeProjectUsage(projectId, opts)`——photo 按 1000/页分页聚合（thumbBytes [+previewBytes] + invite.qrBytes），覆盖写 `usedBytes` / `photoCount` / `qrcodeBytes`；② `archiveProject` 改用它（includePreview=false），`deleteFiles` 增返 `failedList`，删除失败的 preview 仍在云上故不扣减（BR-904）；③ `extendProject` 续期后重算（从归档恢复时 preview 已被删，不计入）；④ `getInviteQrCode` 上传后按 `qr.buffer.length` 与旧的 `invite.qrBytes` 取差值 inc（`usedBytes` 与 `qrcodeBytes` 同步），`invite` 写 `qrBytes`；⑤ `createProject` 初始化 `qrcodeBytes: 0` | `cloudfunctions/project/index.js` |
| 2026-10-05 | T-P2-5 | previewSpec 回写：`project.create` 删除 previewSpec 那行（21_DATABASE 2.4）；`photo/index.js` 加 `PREVIEW_PRESETS` 四档表与 `previewSpecOf(ev)`，`registerPhoto` 在新图与重传两条分支都回写 `project.previewSpec`（最近一次实际档位 + 水印文本，未知档位不动原值）；`web/uploader.js` 把 `preset`（`upPreset` 当前值）与 `watermarkText` 随 `registerPhoto` 一起提交，`processOne` 多收一个 presetKey 参数。旧兜底页 `web/upload.js` 未改，不回写 | `cloudfunctions/project/index.js`、`cloudfunctions/photo/index.js`、`web/uploader.js` |
| 2026-10-05 | T-P3-1 | 图片淡入（F-22）：`client-select/index.wxml` 的 `<image>` 加 `bindload="onThumbLoad"` 与 `class="thumb {{item.loaded}}"`；`index.wxss` 加 `.thumb{opacity:0}`、`.thumb.anim{opacity:1;transition:opacity 200ms ease}`、`.thumb.fast{opacity:1}`；`index.ts` 加 `loadT0`（每批 photos 渲染时刻）与 `onThumbLoad`（100ms 内回来=缓存命中→fast，否则→anim，用 `photos[i].loaded` 定点 setData） | `miniprogram/pages/client-select/index.{wxml,wxss,ts}` |
| 2026-10-05 | T-P3-2 | 三态补齐（F-23）：`client-select` 加空态（「摄影师还没有上传照片」+ 副文案 + 刷新按钮，条件 `emptyPhotos && !loadingMore && !loadError`）与 `.unsaved-bar` 未保存提示条；`index.ts` 里 `loadMore` 顺带算 `emptyPhotos`，`syncNow` 失败改为挂提示条 + 指数退避 1s/2s 补 2 次（`retryCount` 计数，成功清零），不再每次弹 Toast（BR-503）；`selection-result` 加 `loadError` 错误态块 + `.retry` 样式，`loadProject` / `loadResult` 失败改为写 `loadError`，新增 `retryLoad`（有模特列表时只重试当前模特）。home / model-home / 网页端核对后已具备三态 | `miniprogram/pages/client-select/index.{wxml,wxss,ts}`、`miniprogram/pages/selection-result/index.{wxml,wxss,ts}` |
| 2026-10-05 | T-P3-3 | 提交终态提示（F-24）：核对而非改码——`client-select` locked 页已有已提交确认 + 已锁定说明 + 「如需修改请联系摄影师」+ 已选张数回显，重进直接落终态且无「继续调整」。符合 42 完成标准 | — |
| 2026-10-05 | T-P3-4 | 上传完成提示（F-25）：`uploader.js` 的 `startUpload` 记录起始时间，结束一律调 `showDone(done, failed, 秒)`，显示「成功 N / 共 M 张（占比%）+ 用时 X 秒 + 下一步引导 / 失败可重试」，失败文件名另起一行 | `web/uploader.js` |
| 2026-10-05 | T-P2-3 调试② | 推送报 `-604101` 无权限：`subscribeMessage.send` 由 selection 调用，权限声明错配在 project。已把 permissions 补进 `selection/config.json`。**用户 2026-10-05 指示：订阅功能暂时跳过**，本次会话不再推进验收 | `cloudfunctions/selection/config.json` |
| 2026-10-05 | T-P3-5① | **envVersion → release（BR-407，B-3 关闭）**：`project/index.js` 的 `getInviteQrCode` 与 `session/index.js` 的 `createTicket` 两处 `wxacode.getUnlimited` 同步改 `release`，各留一行注释说明灰度期回退方式（改回 trial + 重新部署） | `cloudfunctions/project/index.js`、`cloudfunctions/session/index.js` |
| 2026-10-05 | T-P3-5② | 发布前日志清理：`app.ts` 加 `IS_DEV`（`wx.getAccountInfoSync().miniProgram.envType !== 'release'`），把两处 `console.log`（含 **openid 明文**，真机日志泄漏）改为仅非正式版输出。`selection/index.js` 的 3 处 `[notify]` 保留（云函数侧 console 是唯一可观测手段，属受控日志） | `miniprogram/app.ts` |
| 2026-10-05 | T-P3-5③ | 发布前检查验证：云函数目录无 `ping`（T-P0-6）；全项目 grep `COMPLETED` 无输出（T-P0-4）；静态托管域名不走小程序 web-view（只做复制链接到电脑浏览器打开），故「服务器域名白名单」一条**不适用**，已在 53 清单标注 | — |
| 2026-10-05 | U-0 | `photo.list` 落地：`cloudfunctions/photo/index.js` 新增 `list` action（`listPhotos`）+ `resolveCaller`（小程序 OPENID / 网页 sessionToken，各函数各写一份副本）+ `tempUrls`（getTempFileURL 按 50 分块，24h）+ `sortIdsByOrder`（已选分页先在内存按 sortOrder 排序再切片，where in 按 100 分块）。一次查 `selection` 建 `photoId → [modelId]` 与模特 chips；`all/unselected` 走 `orderBy sortOrder + skip/limit`，`selected` 走并集 id 排序切片；`total`：all=photoCount、unselected=photoCount-已选去重、selected=并集长度；`have` 机制沿用（端上缓存的不重复取链接）；归档项目照出（归档只清 preview，thumb 仍在）。**上传链路三个 action 未动** | `cloudfunctions/photo/index.js` |
| 2026-10-05 | U-2 | 阶段 A 网页端 A-1~A-6 全部落地：**A-1** `index.html` 加左 200px 侧边栏（品牌+项目列表+选片结果+退出）/ 内容区 960→1280 / 登录页 `body.solo` 隐藏侧边栏；新增 `syncChrome()`（顶栏标题+导航高亮+「选片结果」按 localStorage 里的最近项目直达，无项目时禁用）；**A-2** 登录页只换皮（品牌图标 44px、二维码框 300→200、底部说明改实心条），逻辑一行没动；**A-3** 项目列表改卡片网格（`auto-fill minmax(280px,1fr)`）+ 封面色带（`hueOf()` 按项目 id 生成稳定色，有 `coverThumbs` 就异步换真图）+ 进度条 + 剩余天数（≤7 天 `--warn`）+ 末尾虚线新建卡；**A-4** 详情页改「左深色画布瀑布流 + 右 300px 信息栏」：`photoWallHtml/loadWall/paintWall` 调 `photo.list`（Tab 全部/已选/未选 + 已选下的模特 chips + 文件名搜索 + 分页 18 + `have` 缓存 20h + 加载更多/失败重试），点图开大图（按需换 `previewFileID` 链接），右侧栏 = 状态块（进度+剩余+容量+查结果）+ 原有模特面板 + 时间线（只用 `createdAt/updatedAt/archivedAt/expireAt`，不编造日志）；**A-5** 上传区挪进右侧 480px 抽屉（`.open` 控制，可最小化，底部进度提示），`uploader.js` 一行没动；**A-6** 结果页视觉对齐（grid 保持，圆角/间距/等宽字 + 「已确认 N 位」徽标）。删掉被照片墙取代的 `overviewHtml` / `fillCovers` 死代码。`bindWall` 用 `onclick` 赋值而非 `addEventListener`（`#consoleMain` 是常驻元素，add 会累积监听）。**待部署静态托管验收** | `web/index.html`、`web/console.js`、`web/console.css`、`cloudfunctions/photo/index.js`（出参加 `previewFileID`）、`docs/55` |
| 2026-10-05 | U-3 | 模特端：C-1 我的拍摄补「剩 X 天」chip（≤7 天橙）+ 已选进度条 + 「看的是云端预览图」说明条，空态文案改写；**D-4 已确认后端生效**（`selection.myList` 按 openid 查 model 全部 invite，历史项目都会返回，无需新增功能）；C-2 选片页 3 列定高 → JS 分列两列瀑布流（列宽 347rpx，高度 = 列宽×原图高/宽，缺宽高按 3:2 兜底并裁到 220~700rpx；`photos` 仍是权威数据源，`colA/colB` 带 `idx` 回指）；C-3 大图页只改 bottombar 视觉（文件名等宽 + 底块、选中按钮统一 `#4CAF7D`），`gest.wxs` 未动；C-4 锁定态文案改「已锁定 · 如需修改选片，请联系摄影师重新开放」，无自行修改入口 | `miniprogram/pages/{model-home,client-select,photo-viewer}` |
| 2026-10-05 | U-4 + E-2/E-7 | 摄影师端：B-1 引导页加分隔线 + 模特粘贴邀请链接框（22 位 token 正则校验，抠不出来提示「向摄影师要一条邀请链接」不跳转）；B-2 顶部提示条升级为显眼引导条（主色描边 + 实心复制按钮），卡片补剩 X 天 chip + 模特提交进度条 + 「去电脑上传 ›」线索（**无新建/上传/导出按钮**，BR-1204）；B-3 详情加四步派生进度条（上传→选片→提交→导出，**不落库**，BR-204）+ 照片墙入口；B-4 **网格视图改照片墙**（全部/已选/未选 + 2 列瀑布流 + 「这张被谁选中」标签 + 分页 18 + 失败重试 + 空页自动续拉上限 5 次），**列表视图保持「已选清单」不动**（核心交付物零风险），新增 `miniprogram/services/photo.ts`；E-2 模特端底栏「还能选 X 张」；E-7 网页端模特面板「已提交 2/3」汇总 + 未交行按钮改「催一下」 | `miniprogram/pages/{guide,home,project-detail,selection-result}`、`miniprogram/services/photo.ts`、`web/console.js`、`web/console.css` |
| 2026-10-05 | U-1 | 设计 Token 落地：`web/style.css` 与 `miniprogram/app.wxss` 换成 54 第 1 节色板（fg/fg2/muted/page/panel/line/line2 + 新增 dark/dark2/dark-line + ok/warn/info/err），新增圆角变量（card 14 / ctl 8 / pill）。旧变量名（bg/chip/green/amber/red/*-bg）**保留为同值别名**，现有页面样式零破坏；小程序端不用嵌套 var，直接写字面值 | `web/style.css`、`miniprogram/app.wxss` |
| 2026-10-05 | C-22 补做 | 大图页 `photo-viewer` 三态补齐：`<image>` 加 `bindload`/`binderror`/`data-index`，`loaded[i]` 记 `fast`（≤100ms 缓存命中）/ `anim`（200ms 淡入）；失败显示就地重试块（`.fail`），`retryImg` 用 `getPreviewUrl(range=0)` 重取链接并 **先把 src 清掉、setData 回调里再填新 URL**（同 URL 不会重载），归档仍走 Toast；整页错误态覆盖三条路径（无 eventChannel / 上级 5 秒未推数据 / photos 为空）+ `goBack`。失败块用 `catchtouchstart|move|end|cancel="noop"` 吞掉触摸，不干扰 `gest.wxs`；`.img-wrap` 补 `position: relative` 让失败块按张定位。`gest.wxs` **未动** | `miniprogram/pages/photo-viewer/index.{wxml,wxss,ts}` |
| 2026-10-05 | U-W1 | 真机两问题：① 摄影师端照片墙白屏 → `selection-result` 整页重构为**照片墙优先**（筛选 Tab + 搜索框吸顶两行导航，已选档下模特 chips，2 列瀑布流 + 文件名角标，格子点开大图 `wx.previewImage`；底部按钮切「清单视图」= 原模特 Tab + 文件名列表 + 复制 + 重新开放，核心交付物未动）；`project-detail` 入口分别带 `view=wall/list`。② 网页大图加载失败 → `photo` 云函数新增 `previewUrl`（鉴权+归属校验，服务端对单张 `previewFileID` 取临时链接，归档给明确提示）；网页 `openLightbox` 与小程序照片墙大图都改走它，**不再依赖浏览器端 SDK `getTempFileURL`**（服务端取链路径已由缩略图验证稳定）。**生效需：部署 `photo` 云函数 + 重传 web 静态托管 + 小程序重新上传**。② 后续**真机白屏根因已查明并修复**（见下一条 U-W1b：并非 UI 问题，是展开运算符被降级编译成缺 `@babel/runtime` helper） | `cloudfunctions/photo/index.js`、`web/console.js`、`miniprogram/pages/{selection-result,project-detail}`、`miniprogram/services/photo.ts` |
| 2026-10-05 | U-W1b | **白屏根因（重要，别再踩）**：开发者工具 Console 报 `module '@babel/runtime/helpers/arrayWithoutHoles.js' is not defined` + `Component is not found in path "wx://not-found"`。原因是**我新写的代码用了对象/数组展开运算符**，IDE 降级编译会插入 `@babel/runtime/helpers/*` 的 require，而本项目无 node_modules → **页面 JS 在加载阶段就失败 → 整页纯白（连「加载中…」都不渲染）**。全量清理 9 处展开：`selection-result`（3）、`client-select`（5，**模特端选片页同病，本来也会白屏**）、`services/project.ts`（1），统一改 `Object.assign` / `concat`；规则写进 `41_CODING_RULES.md` 3.2 与禁止清单。**教训：小程序端禁止展开运算符；白屏类问题先看 Console 顶部那条 errorReport，再看 UI** | `miniprogram/pages/{selection-result,client-select}/index.ts`、`miniprogram/services/project.ts`、`docs/41_CODING_RULES.md` |
| 2026-10-05 | U-W1c | **缩略图大面积 403 根因（重要，别再踩）**：现象=瀑布流缩略图几乎全灰（Network 里 403 text/plain），点开大图正常。抓包关键线索=403 链接的 `t=` 时间戳是 **5 小时前**（缓存里的旧链接）→ 临时链接提前过期。根因：`getTempFileURL` 的 **maxAge 单位是「秒」，云函数错传了毫秒**（`24*3600*1000`=1000 天）→ 参数非法被后端忽略，回落约 2 小时短有效期；而端上缓存按 20 小时 TTL 存（`urlcache.ts` / web `thumbCache`）→ 缓存里全是过期链接。大图走 `previewUrl` 每次现取所以没事。修复：① `photo`/`selection` 两处 `TEMP_URL_MAX_AGE` 改 `86400`（秒）；② 端上缓存 TTL 收紧到 **90 分钟**（低于云端最差情况）；③ `urlcache.ts` 缓存 key 前缀 `psurl_`→`psurl2_` 让已中毒的本地缓存整体作废；④ web `have` 上报只带 90 分钟内的新鲜条目（`freshThumbIds()`）。**生效需：部署 `photo` + `selection` 两个云函数 + 重传 web + 小程序重新编译** | `cloudfunctions/{photo,selection}/index.js`、`miniprogram/services/urlcache.ts`、`web/console.js` |
| 2026-10-05 | **U-W3b** | **网页端 UI 2.0 第二轮（SECTION 5~9），依据 docs/ui-redesign/web-ui-v2.html**：①**项目详情页**改深色画布照片墙：顶部头（返回 / 状态徽标 / 上传 / 邀请 / ⋯菜单=延期·归档·删除）+ 工具条（Tab 带真实计数、文件名搜索、**密度切换小中大**、收起信息栏）+ 深色瀑布照片墙（悬停显示文件名与选择人、已选打勾、CSS 多列随密度变化）+ **右侧信息栏**（项目状态 / 四步进度 / 模特行含五个动作 / 最近动态，可折叠并记忆偏好）；②**上传抽屉**改 SECTION 6 版式（拖放区 + **规格卡**替代下拉框 + 水印 + 队列网格 + 底部进度条 + 最小化迷你条），规格卡只回写隐藏的 `select#upPreset`，**uploader.js 传输层一行没动**；③**大图**升级 SECTION 7：**← → 切换**（键盘 + 左右按钮，列表=当前这张墙/当前 tab，切换时丢弃迟到的请求）、顶栏文件名与序号、底栏快捷键提示与**缩放百分比 / 适应窗口**；④**选片结果**改表格（# / 文件名 / 选择人 / 时间 / 大图）+ chips 分模特 + 复制结果预览 + **新增导出 TXT（UTF-8 带 BOM）**，CSV 保留带选择人一列；⑤统一空 / 加载 / 错误态（骨架屏、带重试的错误块、带下一步的空态）；⑥外壳改为**全屏应用模式**（body 不滚动，页面 / 信息栏 / 画布各自内部滚动），避免 fixed 浮层跟着长页面跑。`node --check` 通过（console/uploader/quality），静态服务冒烟通过。**console.css 里迁移完的旧规则未物理删除（DOM 已无这些类名，不影响表现），文件头已注明保留的是哪些共用控件待后续清理。生效需：刷新网页（纯前端，无云函数改动）** | `web/console.js`、`web/console-v2.css`、`web/console.css`（注释） |
| 2026-10-06 | **U-W3c** | **真机反馈五项修复 + 类名防撞**：①**瀑布流被压成一条 + 下面大半黑的根因**：`style.css`（旧上传向导）的 `.wall` 规则（8 列网格 + `max-height:300px` + 图片 `opacity:0.35` 灰罩）与新照片墙撞名 —— 问题 1（下半屏黑）和问题 2（照片像蒙了灰罩）同源。照片墙改名 `.masonry`（JS 标记 + 全部 CSS 同步），CSS 多列恢复、画布内部滚动铺满；②**`.card` / `.steps` / `.drop` 同样撞名**，全部改名 `.vcard` / `.vsteps` / `.v2drop`，杜绝旧向导样式渗透；③**大图只看到半截的根因**：`.lb-stage img` 的 `max-height:100%` 对自适应高度父级无效 → 图片按原始尺寸渲染。改为 `max-width:calc(100vw-176px) / max-height:calc(100vh-148px)`，默认=适应窗口(100%)；**缩放下限 100%→25%**（上限 800%），可缩小看全图；④**左栏 232→260**、字号整体调大（导航 13.5→14.5、图标 16→18、头像 28→32），**右侧信息栏 288→320**（容器查询断点同步 240/224/284）；⑤照片墙**滚动到底自动加载下一页**（「加载更多」按钮保留兜底）。`node --check` 通过。刷新网页即生效 | `web/console.js`、`web/console-v2.css` |
| 2026-10-06 | **U-W3d** | **真机反馈第二轮七项**：①侧栏「工作台/项目/最近项目/设置」字号再放大（导航 14.5→15.5、标签 11→12、最近项目 13→14、用户区 13.5→14.5）；②**头部状态徽标竖排根因**：flex 挤压 + 无 nowrap → 徽标逐字换行；`.badge` 加 `white-space:nowrap; flex:none`，dhead 允许换行 + 标题省略号；③模特行操作按钮强制横排（`.md-ops-v2` 明确 `flex-direction:row` + wrap，按钮 `flex:none`）；④**左右栏宽度可拖拽**：新增 `.rz` 分隔条（侧栏右侧 / 信息栏左侧各一条），拖动范围 **1/10 ~ 1/3 视口宽**（实时夹紧），localStorage 记忆（`pw_side_w` / `pw_info_w`），窗口缩放时重新夹紧，窄屏(<902px)侧栏折叠态由 CSS 接管；⑤**大图顶栏重叠根因**：`.lb` 上 `align-items:center`（column 布局）让顶栏/画布/底栏收缩成内容宽并居中 → 关闭按钮挤到中间和「已选」重叠；改 `align-items:stretch`，文件名加省略号；⑥关闭按钮回到右上角（顶栏整行后 margin-left:auto 生效）；**点大图空白处关闭**已有（stage 空白 click → close），布局修复后正常；⑦**延期 30 天 / 归档 / 删除项目从 ⋯ 菜单改为头部直接并排**（删除项红色 `.hd-danger`），`bindDetailChrome` 逐按钮绑定原 data-hd 逻辑，菜单 DOM 删除。`node --check` 通过 | `web/console.js`、`web/console-v2.css` |
| 2026-10-06 | **U-W3e** | **按钮竖排真根因 + 六项反馈**：①**根因**：旧向导 `style.css` 的 `.btn{width:100%}` 漏进控制台，把头部/模特每个按钮撑满整行逐个换行（上一轮加 flex-wrap 后彻底爆开成竖排菜单状）；`.app .btn,.cs-modal .btn{width:auto}` 作用域修复，不影响旧向导页；同时给 index.html 全部 css/js 加 `?v=uw3e` 缓存击穿；②大图顶栏改三段布局：文件名/序号/已选一组**居中悬在照片正上方**（`.lb-top-c`，fn 超长省略号），关闭按钮 `position:absolute` 钉右上角，互不遮挡；③头部按钮工具栏化 + 「删除项目」改淡红底红字红描边 hover 反色（`.hd-danger`），模特行「移除」红色内联样式保留；④侧栏再放大 + 松间距：导航 16.5px/内边距 11px、工作台与项目间 5px、标签 12.5px、最近项目 15px、用户区 15.5px、logo 17px；⑤**拖入即显缩略图**：`renderSummary` 在非上传态直接 `buildWall()`，选完文件立刻看到待传缩略图（上传中不重建，保 it.el 实时状态）；⑥**自定义压缩滑条**：PRESETS 加 `custom` 档，抽屉规格区新增长边 1200~4096 / 画质 40~95% 双滑条（`setCustomSpec` 写回 presets.custom，perMb 估算随参数走），选中「自定义」卡显示，画质对比弹窗同步可用。`node --check` ×2 通过 | `web/console.js`、`web/uploader.js`、`web/console-v2.css`、`web/index.html` |
| 2026-10-06 | **U-W3f** | **真机反馈第三轮三项**：①**项目封面全黑根因**：`coverThumbs` 只有新上传链路（photo.confirm push）会写，老项目全是空数组 → `fillProjCovers` 无图可取。在 `project.list` 云函数里对 `coverThumbs 为空且 photoCount>0` 的项目一次性从 photo 集合兜底补齐（`_.in` 一次查询 + 按 sortOrder 取每项目前 3 张 thumbFileID，**只读不写库、不增加前端云调用**）；同时无底片项目的封面不再纯黑，显示「还没有底片 · 进入项目上传照片」提示层（`.pcover-empty`）；②**头部操作排加重**：延期/归档 ghost→白底描边（btn-sec），整排统一 32px 高 13px 字 500 字重，「上传照片」34px 黑底白字更大一号；③**侧栏留白对齐设计稿**：logo 下留白 22→30px、分组间 16px、标签上下 18/12px、导航项 12px 内边距 + 项间 6px；品牌名「摄影选片」→「**银盐定片**」（侧栏 + 登录页），缓存版本 bump `?v=uw3f`。`node --check` ×2 通过。**⚠ 生效需重新部署云函数 `project`（右键上传）+ 刷新网页** | `cloudfunctions/project/index.js`、`web/console.js`、`web/console-v2.css`、`web/index.html` |
| 2026-10-06 | **U-W3g** | **画质对比弹窗整层裸奔修复**：UI 2.0 迁移清理 console.css 时，把 `.qt-mask / .qt-modal / .qt-head / .qt-bar / .qt-tip / .qt-cards / .qt-card* / .qt-sum` 这批弹窗壳样式当成死代码误删（只剩 duo/zoom 几条），弹窗打开后白底文字流铺满页面。全部补回 console.css（qt-* 的指定归属地）：深色遮罩 + 居中白卡（min(1080px,100%)，内部滚动）、头部三按钮、灰底规格栏、双图对比区（qv 原有 440px 高度规则仍在）、五列档位卡（选中态墨色描边）、汇总行。缓存版本 bump `?v=uw3g`。纯前端，刷新即生效 | `web/console.css`、`web/index.html` |
| 2026-10-06 | **U-W3h** | **画质对比 + 自定义清晰度按 UI 2.0 设计稿（docs/ui-redesign/web-ui-v2.html SECTION 10）整版重做**：①弹窗从「浅色小卡」升级为 **PS「存储为 Web」式深色全屏工作台** —— `.qtd-mask/.qtd`（1380×860 深色工作台，z-index 70，高于抽屉 50、低于大图 90）、顶栏（标题 + 样张/原图尺寸 + 换一张样张/用这个档位/✕）、规格栏（A/B 下拉 + 适应窗口/100%/200% + 当前倍率）、双视口各自带**状态条**（JPG · qNN · W×H · 实测 KB）、底部五张档位卡（选中态绿色描边 + 圆点）；②**自定义档由「长边 + 画质」双滑条改为单滑条 t（0~300）**，两端锚死 标准(1600/0.75) ↔ 原画质(4096/0.92)，中间按 高清 / 高清 Pro 锚点插值；`PhotoUploader.setCustomT/customT` 为**单源**，上传抽屉滑条与弹窗滑条双向实时互通（改任一端，另一端文本/滑块/卡片/体积估算同步刷新，并只重生成 custom 一档，防抖 160ms）；③**水印所见即所得**：抽屉水印输入即时铺到「水印预览块」，弹窗两视口的 `.wm-cover` 同步叠加同款斜向平铺 SVG（图层矩形跟随图像平移缩放）；④支持 ESC / 点遮罩关闭，窗口 resize 重绘。旧 `.qt-*/.qv-*` 死样式已清掉。缓存 bump `?v=uw3h`。纯前端 | `web/quality.js`、`web/console.js`、`web/uploader.js`、`web/console.css`、`web/console-v2.css`、`web/index.html` |
| 2026-10-06 | **U-W3i** | **真机反馈第三轮三项**：①**自定义滑条重定标**——由 0~300（标准↔原画质经 hd/hdpro 插值）改为 **0~200 三锚点**：0=更省流量（1200px / q0.55，比标准更模糊更省）、100=标准（滑条正中间）、200=原画质；`specOfT` 三锚点线性插值，`customT` 默认 100；抽屉/弹窗滑条 max 同步改 200，说明文案改「两端 = 更省流量 ↔ 原画质，标准在中间」；②**按钮与间距放宽**——`.dhead .ops` gap 8→12、按钮 padding 0 14px；`.btn-sm` 28→32px 高、字号 12.5→13；`.up-acts` gap 8→12；`.md-ops-v2` gap 4→8、按钮 24→26px/字号 12/padding 0 12px；侧栏 nav-item gap 12→14、相邻项间距 6→8、最近项目行高 8→10px；③**水印三处统一重做**——`drawWatermark`（实际上传）由**单枚右下角文字**改为**全图斜向平铺**（-24° 白字、字号 4.5% 短边、交错半步、透明度 0.24 + 轻投影，覆盖对角半径）；抽屉预览块与画质对比弹窗的 SVG 平铺同步调大（字号 15→20、密度 190×130→260×190 双文字交错、透明度 0.17→0.24），预览块 120→150px 高。缓存 bump `?v=uw3i`。`node --check` 通过 | `web/uploader.js`、`web/console.js`、`web/quality.js`、`web/console-v2.css`、`web/index.html` |
| 2026-10-06 | **U-W3j** | **真机反馈第四轮三项**：①侧栏字号再放大——nav-item 16.5→**20.5px**、最近项目 15→**19px**、分组标签 12.5→14px，侧栏宽 260→276px；②**画质对比弹窗拖自定义滑条画面固定**——根因：custom 档重生成后 blob 尺寸变了，非 fit 模式下 D=blob.w×z 跟着缩放；修复：`rebuildCustom` 记住重生成前的显示宽度，重生成后把 z 调回 `keepD/newBlob.w`，pan 不动，画面纹丝不动（fit 模式本就不受影响）；③**档位重排**——「高清」由 2048/q0.82 改为 **1600/q0.65**；新增 **「标清（最省流量）」1200/q0.55**（perMb 0.14），档位卡变 6 张（`.qtd-cards` 5→6 列）；自定义滑条下限由 1200/q0.55 再降到 **800/q0.42 ≈ 标清 1200/q55 的一半清晰度**（长边×画质≈减半），锚点 0=800/0.42、100=标准、200=原画质；抽屉说明文案同步。旧向导 `upload.js` 的四档为废弃代码未动。缓存 bump `?v=uw3j`。`node --check` 通过 | `web/uploader.js`、`web/quality.js`、`web/console.js`、`web/console-v2.css`、`web/console.css`、`web/index.html` |
| 2026-10-06 | **U-W3k** | **真机反馈第五轮五项**：①侧栏字号再 +4px——nav-item 20.5→**24.5px**、最近项目 19→**23px**、分组标签 14→16px，侧栏宽 276→300px；②**重开上传抽屉自动清空上一批**——`openUploadDrawer` 调用新增的 `PhotoUploader.resetItems()`（revoke blobURL + 清墙/进度/成功框，上传中不清）；③**拖入即见**——collectFiles 后把缩略图墙 scrollIntoView + toast「已添加 N 张」；drop 处理抽成 `handleDrop`，**整个抽屉任意位置都可拖放**（原来只有拖动框一块，拖偏会触发浏览器直接打开图片）；④**水印三款可选 + 加大**——抽屉新增 `upWmStyle` 下拉（平铺·防裁剪 / 右下角 / 居中），预览块即时切换；实际上传 `drawWatermark(ctx,w,h,text,style)`：平铺字号 4.5%→**6%** 短边（α0.26）、右下角 7%（α0.45）、居中 10%（α0.4），`processOne/render` 全链路传 wmStyle；画质对比弹窗 `wmBg(text,style)` 同步三款（corner/center 用 no-repeat + background-position 定位）；⑤**档位重排**——删除旧「高清」(1600/q0.65)，**标清 = 1200/q0.45（perMb 0.11）**，**高清 = 1200/q0.55（perMb 0.14）**，自定义滑条下限相应降到 **700px/q0.40**（≈新标清的一半清晰度），说明文案同步。缓存 bump `?v=uw3k`。`node --check` 通过 | `web/uploader.js`、`web/console.js`、`web/quality.js`、`web/console-v2.css`、`web/index.html` |
| 2026-10-06 | **U-W3l** | **真机反馈第六轮三项**：①**抽屉水印预览改 canvas 绘制**——替换原 SVG data-URI 背景方案（高分屏缩放发糊 + 偶发不渲染），canvas 按 devicePixelRatio 渲染文字锐利；抽屉隐藏时 clientWidth=0 画不了，`openUploadDrawer` 里 rAF 补一次 `paintWmPreview()`；三款参数与实际上传 drawWatermark 同套（平铺 -24° 交错 / 右下角右对齐下对齐 / 居中）；②**画质档位重定义**——`标清=1200/q0.55`、`高清=1600/q0.75（推荐，默认档）`、`高清Pro=2880/q0.9`、`原画质=4096/q0.92`、自定义；删除「标准」档，旧档位名 `standard` 在三处镜像常量表保留为 =高清 兼容历史数据；自定义滑条锚点回到 0=800/q0.42（≈标清一半清晰度）、100=高清、200=原画质，文案同步；③**画质对比弹窗同步**——默认视口 A=高清，水印 SVG 升 2 倍分辨率（520×380）+ corner/center 用 background-size:100% 100% 拉满视口（文字位置随视口等比、高分屏锐利）。镜像常量四处同步：`cloudfunctions/photo/index.js PREVIEW_PRESETS`、`miniprogram/env.ts PREVIEW_PRESET/PRESET_SIZE_MB`（low=0.14/hd=0.25）、`web/upload.js PRESETS`（旧兜底页）、`web/index.html` 旧版下拉（low/hd selected）。缓存 bump `?v=uw3l`（5 个 js）。`node --check` 通过 | `web/uploader.js`、`web/console.js`、`web/quality.js`、`web/upload.js`、`web/index.html`、`cloudfunctions/photo/index.js`、`miniprogram/env.ts` |
| 2026-10-06 | **U-W3m** | **真机反馈第七轮两项**：①**水印只保留满屏斜向平铺一款**——删除抽屉「款式」下拉（平铺/右下角/居中 → 一律 -24° 全图交错平铺），`drawWatermark` 去 style 分支并删除 `drawOne`，`render/processOne/startUpload/PhotoQuality.open` 的 wmStyle 传参整链移除，`quality.js` 弹窗 `wmBg` 同步只出平铺 SVG（wmStyle 变量删除）；②**抽屉水印预览底色改深色**——`.wm-demo .ph` 由浅灰渐变改深色渐变（#2e2d2a→#101010→#262622），白色水印一目了然；顺手清理 `console-v2.css` 里失效的 `.wm-row/.wm-style-sel` 规则。缓存 bump `?v=uw3m`（uploader/quality/console.js + console-v2.css）。`node --check` 通过 | `web/uploader.js`、`web/console.js`、`web/quality.js`、`web/console-v2.css`、`web/index.html` |
| 2026-10-06 | **U-W3n** | **修复「预览依旧看不到水印」（真机反馈第八轮）**：agent-browser 最小复现页实测定位两个根因——①**canvas 是替换元素，`position:absolute; inset:0` 不会拉伸**（实测 clientWH=300×150 固有尺寸），只盖住预览块左上角；`.wm-cover` 补 `width/height:100%`；②`drawWatermark` 字体串里的 `-apple-system` 在 canvas 上不可靠，三处（console.js 预览 / uploader.js 实际成图 / quality.js 弹窗 SVG）统一改为 `'Segoe UI','Microsoft YaHei',sans-serif`。复现页截图验证：满屏「番茄」斜向平铺清晰可见。调试页 test-wm.html / test-wm-shot.png 已删。缓存 bump `?v=uw3n`（console.css/console.js/uploader.js/quality.js）。`node --check` 通过 | `web/console.css`、`web/console.js`、`web/uploader.js`、`web/quality.js`、`web/index.html` |
| 2026-10-05 | **U-W3a** | **网页端 UI 2.0 第一轮（骨架 + 登录 + 工作台 + 项目列表），依据 docs/ui-redesign/web-ui-v2.html SECTION 1~4**：①新骨架 `.app`（`data-panel`/`data-drawer`/`data-lb` 三态驱动抽屉与大图），侧边栏 = 工作台 / 项目（带数量）+ **最近项目**（localStorage 记忆最近打开 4 个）+ 设置 + 用户区，登录页改为独立一屏（登录态隐藏侧栏）；②**新增工作台 `#/dash`**（登录后首页）：问候语 + 三张统计卡（进行中 / 待处理选片 / 即将到期）+ 最近项目 + 最近动态 + 下一步建议——**动态与建议全部由项目真实时间戳与状态推导，不编造操作日志**；③项目列表改卡片网格：搜索框 + 状态 chips（全部/进行中/待确认/已归档，带数量）+ 排序（最近更新/创建时间/名称），卡片换成 UI 2.0 的 `.pcard`（三列错落真实封面 + 状态徽标 + 剩余天数 + 模特进度 + 选片进度条），封面填充逻辑同步适配 `grid3` 三列；④上传抽屉 / 迷你条 / 遮罩 / 大图 / Toast 改为骨架里的**静态容器**（抽屉内容按进详情时 `mountUploadDrawer()` 重建，避免重复 id），退出旧 CSS 前的兼容处理已完成（`node --check` 通过，本地静态服务冒烟通过）。**迁移期样式层：新增 `web/console-v2.css`（作用域限定在 `.app`，不动旧向导与弹窗），等详情页/抽屉/大图/结果页迁完再删 `console.css` 里的旧规则并合并。生效需：刷新网页（纯前端，无云函数改动）** | `web/{index.html,console.js,console-v2.css}` |
| 2026-10-05 | **U-W2** | **web 端三项体验改造（用户 2026-10-05 提出）**：①左侧控制栏移除「选片结果」直达入口（它跳的是「最近打开的项目」，语义混乱），选片结果只从**项目内部**进：详情页状态卡「查看选片结果 ›」、模特行「查看结果」；`#/result/:id` 路由保留，侧栏高亮把 result 也算进「项目列表」档。②**选片结果页缩略图可点开全屏**：`getResult` 本就返回 `_id`，grid 挂 `data-pid`，与照片墙**共用同一个 lightbox**（`openLightbox(projectId, photoId, filename, archived)` 通用化）；顺带补了结果页缩略图 403 自愈（`photo.thumbUrls` 重取，与照片墙 `retryThumbImg` 同口径）。③**查看器支持缩放**：web 端滚轮缩放（1~10 倍、中心缩放、平移夹取）+ 按住拖动 + 双击复原 + Esc 关闭（赋值式绑定不累积）；小程序摄影师端照片墙本来就是 `wx.previewImage`（自带双指缩放），本次把**清单视图的行缩略图**也接上 `onRowTap` → `previewImage`。`node --check` 通过 | `web/{index.html,console.js,console.css}`、`miniprogram/pages/selection-result/index.{ts,wxml}` |
| 2026-10-05 | **U-W1f** | **模特端缩略图全黑（不报错、CLI 无图片报错、点开全屏大图正常）**。两条独立成因，都修了：①**缓存判定不一致（真实缺陷）**——`urlcache.cachedIds` 只比较写入时的 TTL，而 `getCached` 会复核链接自带的 `t`；两者口径不同时出现「服务端认为端上有缓存而跳过签发 + 端上取不到可用链接」→ `thumbUrl` 为空串 → `<image>` 既不 bindload 也不 binderror → **黑格子且无任何提示**。统一两者的判定，并加 `RENEW_WINDOW=2min` 提前续签窗口（`cachedIds` 必须与 `getCached` 同口径，这是规则）。②**淡入 class 没写上**——`.thumb` 默认 `opacity:0`，`bindload` 在部分机型/缓存命中时不回调，图片已到位也是黑的。新增两条兜底：`healMissing()`（空链接统一补签一次，补不到就挂「没加载出来」而不是留黑格）、`forceLoaded()`（1.5s 后补齐淡入标记，宁可少一次淡入）。另加一条 `console.log` 打出「本批 N 张，拿到链接 X 张」，便于直接分锅。**生效需：小程序重新编译**（无云函数改动） | `miniprogram/services/urlcache.ts`、`miniprogram/pages/client-select/index.ts` |
| 2026-10-05 | **U-W1e** | **模特端白屏（U-W1b 的同源第二次踩坑）**：Console 报 `module '@babel/runtime/helpers/toPropertyKey.js' is not defined` + `Component is not found in path "wx://not-found"`，`weapp:///pages/client-select/index.js:4:24`。根因：**对象计算属性 `{ [\`photos[${i}].loaded\`]: v }`** 被降级编译成 `_defineProperty` → require `toPropertyKey`，项目无 node_modules → 页面 JS 加载失败。上次（U-W1b）只清了展开运算符，漏了计算属性。**已全量改写 11 处**：`photo-viewer`（7，`onImgLoad`/`onImgError`/`retryImg`×2/`toggleLike`）**首页大图页同病，此前也一直白屏**、`client-select`（2，`onThumbLoad` + 本次新增的 `patchThumb`）；统一改「空对象 + 下标赋值」（`obj[k] = v` 是原生语法，安全，只有对象字面量里的 `[k]:` 才引 helper）。规则补进 `41_CODING_RULES.md` 3.2 与禁止清单（含排查口诀：白屏先看 errorReport 里的 helper 名，再全局搜对应语法）。**生效需：小程序重新编译**（无云函数改动） | `miniprogram/pages/{photo-viewer,client-select}/index.ts`、`docs/41_CODING_RULES.md` |
| 2026-10-05 | **U-W1d** | **缩略图 403 的真正根因（推翻 U-W1c 的结论，别再踩）**：U-W1c 把 90 分钟 TTL 当成修复，但瀑布流仍是「部分缩略图灰掉」。抓包定案：403 链接 `?sign=…&t=1791205892`，把 `t` 换算成时间是 **13:11:32**，而响应头 `date` 是 **13:29:30** → 链接在请求时已过期 18 分钟，端上却认为它「新鲜」。**根因是云端私有读的临时链接实际只有约 10 分钟有效期**（官方文档 `Cloud.getTempFileURL` 原文：私有读文件「十分钟有效期」，且签名是 `fileList: string[]`，我们传的 `{fileID, maxAge}` 里的 maxAge 不保证生效）——端上任何写死的 TTL（20h / 90min）都远大于真实有效期，必然喂给用户过期链接。修复三层：① **缓存不再写死 TTL，改从链接自带的 `t`（Unix 秒，到期时刻）算到期时间**（`urlcache.ts` 的 `expireAtOf`，留 60 秒安全余量、上限 90 分钟、解析不到兜底 5 分钟；web `thumbCache` 同口径）；② **缩略图失效自愈**：`photo` 新增 `thumbUrls`（摄影师端）、`selection` 新增 `thumbUrls`（模特端），都是鉴权+归属校验后对 `thumbFileID` 重取链接；两个瀑布流 `<image>` 加 `binderror` → 丢缓存 → 自动换一条新链接重试（每张只自动一次），仍失败才挂「点此重试」；网页端 img 加 `error` 监听同理；③ 更新两条过时注释（maxAge 的说明）；④ 缓存 key 前缀 `psurl2_`→`psurl3_`，作废 v1/v2 那批按写死 TTL 存的旧缓存。**生效需：部署 `photo` + `selection` 两个云函数 + 小程序重新编译 + 重传 web**。副作用：`have` 命中率下降（链接寿命只有 10 分钟），取链调用量会小幅上升，但这是平台限制，无法靠延长缓存规避 | `cloudfunctions/{photo,selection}/index.js`、`miniprogram/services/{urlcache,photo,selection}.ts`、`miniprogram/pages/{selection-result,client-select}/index.{ts,wxml,wxss}`、`web/console.js` |
| 2026-10-05 | U-5 | **阶段 E 体验增强收尾（E-3/E-4/E-5/E-6/E-8/E-10）**：① E-3 空态动作——小程序摄影师端空态「复制控制台地址」、照片墙空态「回项目详情」、模特端空态「我有邀请链接 ›」（跳引导页）；网页照片墙空态加「↑ 上传照片」按钮（直接开上传抽屉）。② E-4 到期止损——剩 3 天标红、7 天标橙；小程序 `home` 卡片与网页 `projectCardHtml` 都加「续期 30 天」（`catchtap` / `stopPropagation` 防冒泡到卡片进详情）。③ E-5 模特端首次选片引导蒙层（3 秒自动消失 / 点任意处关闭，storage `ps_guide_sel` 只弹一次）。④ E-6 网页详情页「照片已就位，现在邀请模特选片」引导卡（photoCount>0 且 models=0 且未归档时出现，按钮直接开邀请弹窗）。⑤ E-8 视图偏好——网页 Tab 写 `localStorage['ps_wall_filter']`；小程序选片成果页写 `storage['ps_result_view']`（入口带 `view=` 优先并覆盖记忆）。⑥ E-10 模特端「全部 / 已选」Tab（本地过滤，`idx` 仍指向全量 `photos` 保证大图页取数正确）。**生效需：重传 web 静态托管 + 小程序重新编译**（本次无云函数改动） | `miniprogram/pages/{home,model-home,client-select,selection-result}`、`web/console.js`、`web/console.css` |

---

## 六、冲突与待决登记

> 用 `40_AI_DEVELOPMENT_RULES.md` 第四节模板上报的冲突，统一登记在这里，便于追溯。

| 编号 | 上报内容 | 状态 | 结论 |
|---|---|---|---|
| C-1 | **已裁决**：第六轮文档写「不引入 Web SDK」，但 `web/upload.js:71-81` 已在用微信 Web SDK | ✅ 已裁决 | 传输层维持 Web SDK 不动，鉴权层叠加自有 sessionToken。禁止重构 `ensureApp` / `callFn` / `uploadBlob` |
| C-2 | **已裁决**：`loginTicket` 集合命名统一为 `session` | ✅ 已裁决 | 用 `session` |
| C-3 | T-P2-5 遗留：一个项目可能有多批不同画质的上传，`previewSpec` 只回写最近一次 | 待定 | 暂按「回写最近一次」实现；若需精确，上报讨论 |
| C-4 | session 生效状态取值不一致：`20` 时序图 / `23` 3.2 / `32` 3.4 均用 `ACTIVE`（登出置 `REVOKED`），而 `42` T-P0-2 完成标准写「`PENDING → CLAIMED`」 | 待确认 | 本次按 **`ACTIVE`** 实现（`23_PERMISSION` 是鉴权唯一来源，且三处覆盖一处）；若确认改用 `CLAIMED`，改动为 `session/index.js` 常量 1 行 + `project` / `selection` 的 `SESSION_ACTIVE` 各 1 行 |
| C-5 | session 过期字段名不一致：`20_ARCHITECTURE` 四的示例代码用 `s.expireAt`，而 `21_DATABASE` 八 / `22_API` 2.1~2.3 / `31_STATE_MACHINE` 五均为 `ticketExpireAt` + `tokenExpireAt` | 待确认 | 已按 **`ticketExpireAt` / `tokenExpireAt`** 实现（21 是字段定义、22 是接口规格唯一来源，`session/index.js` 就这么写的，三处必须一致否则网页永远登不进） |
| C-6 | `resetLock` 可能把已归档项目拉回 `SELECTING`：`selection/index.js:480` 无条件写 `status:'SELECTING'`，与 T-P0-5 修的是同一类漏洞 | 待决 | 不在 T-P0-5 涉及范围内，未改。影响：摄影师解锁某个**手动归档且未过期**的项目时状态会跳回 SELECTING（preview 已删，模特看不到大图但能选）。建议下次单独修：加 `if (p.status !== 'ARCHIVED')` |
| C-7 | BR-509「已归档项目模特端只读」尚未实现：`saveSelection` 不校验 `ARCHIVED`，手动归档且未过期的项目，模特仍能改选择 | 待决 | 不在 T-P0-5 范围内，未改。多数情况下 `assertNotExpired` 会先拦住（自动归档=过期 7 天后），只有手动归档且未过期的项目受影响 |
| C-8 | `session.claim` 输出的 `displayName` 无数据来源：`admin` 集合只有 `openid` / `boundAt`，摄影师没有名字字段 | 待决 | 暂返回空串，前端展示「登录成功」。若要昵称需新增字段或走微信公开信息（后者超出范围） |
| C-10 | `issueUploadSession` 对 `ARCHIVED` 项目的处理，文档未定义（22 只写了 3 个失败码） | ✅ 已确认（用户 2026-10-05 拍板按此实现） | 本次**拒绝上传**并返 `ERR_ARCHIVED`「请先续期」（传上去模特端也读不到大图）。若要允许，删掉该 3 行守卫即可 |
| C-11 | P-W3 区域 5「照片概览（前 18 张 + 查看全部）」**缺少网页端照片列表接口**：`22` 未定义 web 侧 listPhotos，现有 `selection.getPhotos` 需模特身份 | ✅ 已确认（按「张数 + 前 3 张封面」实现，不新增接口） | 本次只显示「已上传 N 张」+ 前 3 张封面（读 `project.coverThumbs`，取临时链接失败则只显示张数）。若要完整网格，需新增 `photo.listPhotos`（含分页 18 + 批量临时链接），约 40 行，等确认后再做 |
| C-12 | P-W3 区域 2「延期 / 归档 / 删除」与区域 6「模特进度」的网页端入口，**42 的任务表里没有对应任务**（云函数 action 已存在） | ✅ 已解决 | 用户授权全权处理，2026-10-05 一并实现：头部延期/归档/删除 + 模特进度区（允许重选/移除/查看结果）+ 邀请区（T-P1-6） |
| C-13 | 「移除模特」不可逆（连带删 model + selection），但 `11_INTERACTION_SPEC` §1 明确「只在这 5 处使用确认弹窗」，移除模特不在其中 | ✅ 已确认（用户 2026-10-05 拍板：必须弹窗） | 已加确认弹窗：「移除后 X 将无法再进入这个项目，她已选的 N 张也会一并清除，无法恢复」。**文档 §1 的 5 处清单应补入第 6 处**（移除模特），待文档修订 |
| C-16 | `10_PAGE_SPEC` P-W4 路由写作 `#/project/:id/result`，实现用 `#/result/:id` | 已决策 | 详情页「查看结果」按钮已按后者实现，与现有 parseHash（只取两段）一致；改用前者需同时改路由解析与两处跳转 |
| C-17 | 结果页缩略图：`getProjectResults` 按 BR-805 只返回文件名，网格无图可显 | 已决策 | 守 BR-805（导出接口零链接）；看图时按 tab 追加调 `selection.getResult`（≤5 次，页内缓存，切 tab 不重复取）。全并 tab 去重并按文件名升序，备注列合并多选模特名 |
| C-18 | `getResult` / `getProjectResults` 的 photo 查询 `limit(1000)` | 待决 | 沿用既有实现；单项目超 1000 张会截断。真实项目少见，需分页时另开任务 |
| C-19 | 授权入口与 22/03 文档不符：文档规定「发邀请时勾选通知我」，但 requestSubscribeMessage 只能在小程序内调用，而邀请现在主要从网页端发 | 待确认 | 调整为小程序 project-detail 每位模特行独立「通知我」按钮（可重复点 = 多一次推送额度）；createInvite 的 notify 参数保留但网页端不传。若坚持文档口径需把邀请流程整体搬回小程序端。**用户 2026-10-05 指示订阅暂时搁置，本项不再推进** |
| C-20 | `22_API` 4.3 写着「registerPhoto **V2 变更：无**，不要动这个文件除新增 issueUploadSession 之外的部分」，但 `42` T-P2-5 与 BR-302 要求 `registerPhoto` 回写 `project.previewSpec` | ✅ 已按优先级裁决 | 按 `40` 第二节：规则优先级 30（BR-302）> 20~24（22_API）> 42 任务卡。已在 `registerPhoto` 内回写，未动其他逻辑。`22_API` 4.3 那句「V2 变更：无」已过时，建议下次修文档时同步为「新增 preset 入参 + 回写 previewSpec」 |
| C-22 | 大图浏览页（`photo-viewer` / P-C3）：`20_ARCHITECTURE` 6.2 与 `41_CODING_RULES` 3.5 都说它 V2 要「加淡入 + 失败占位」，但 T-P3-1 / T-P3-2 的涉及文件里都没有这个文件 | **已解决 2026-10-05** | 用户指示补做，已完成：① 淡入（`bindload` → `loaded[index]`，100ms 内回来 `fast`、其余 200ms `anim`，同 client-select 口径）；② `binderror` → 每张独立的「这张没加载出来 / 点此重试」块，重试重取一次大图链接（先把 src 清掉、渲染落地再填新 URL，否则同 URL 不会重载），归档时按原逻辑给 Toast；③ 整页错误态（拿不到 eventChannel / 上级 5 秒未推数据 / photos 为空）→ 「没有加载到照片 + 返回列表」。**失败块用 `catchtouchstart` 等吞掉触摸**，避免误触 dispatch 给 `gest.wxs` 造成翻页缩放；`gest.wxs` 未改动 |
| C-21 | T-P2-5 涉及文件不含 `web/uploader.js`，但不带 preset 就无法回写画质档位；同理后端要校验档位就得持有四档表副本（`AI-11` 禁止另写常量） | ✅ 已实现，待你确认 | 本次改动：`uploader.js` 只在既有 registerPhoto 载荷里加 `preset` / `watermarkText` 两个字段 + `processOne` 多一个参数（无其它改动）；后端 `PREVIEW_PRESETS` 只存 key→longEdge/quality 的映射并回写，未参与任何上传决策（画质数值仍由前端决定）。若不想维护后端副本，可改成「前端同时传 longEdge/quality、后端原样落库」 |
| C-14 | `22_API` 3.8 的 `notify`（选片完成通知我）与 3.10 的 `listInvites` 返回 `displayName` / `notifyAuth`，**云函数均未实现** | 待决 | 网页端未提供「通知我」勾选（避免做了无效开关）；模特名字改从 `project.models[].name` 读取，不依赖 listInvites。订阅消息属 P2 通知范畴，另议 |
| C-15 | P-W3 区域 6 与区域 7 在 `10_PAGE_SPEC` 里是两段，实现中合并为「模特与邀请」一段 | 已决策 | 同一位模特分两段显示会重复且割裂（进度与邀请入口本就绑在同一个人身上）。若坚持分两段，拆分 `modelsPanelHtml` 即可 |

---

## 七、验收锚点（做完 V2 应该是什么样）

1. 摄影师打开网页控制台地址 → 出现一个小程序码
2. 微信扫一下 → 网页自动进入，看到自己的项目列表
3. 新建项目 → 拖入文件夹 → 画质四档对比后选定 → 上传
4. 生成邀请二维码 → 截图发给模特
5. 模特微信扫码 → 浏览 → 勾选 → 提交 → 看到「已锁定」
6. 摄影师微信收到一次通知
7. 网页打开结果页 → 一键复制文件名清单 → 粘进 Lightroom 筛选
8. 全程**没有从手机复制任何东西到电脑**

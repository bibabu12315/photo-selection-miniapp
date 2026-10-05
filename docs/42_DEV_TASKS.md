# 42 · 开发任务拆分（P0~P3）

> **使用方式**：按 P0 → P1 → P2 → P3 顺序，一次领一个 T-xx。做完更新 `43_DEV_STATUS.md` 后再领下一个。
>
> **编号规则**：`T-{优先级}-{序号}`，例 `T-P1-4`。
>
> **优先级含义**
> - **P0 地基**：不做完，后面全部建在错误的基础上。含安全与规则缺陷修复。
> - **P1 主体**：网页控制台主链路。V2 的核心交付。
> - **P2 收敛**：小程序端收敛 + 数据治理 + 通知。
> - **P3 补齐**：体验细节 + 上线配置。
>
> **每个任务的字段含义**
> - **目标**：一句话，做完是什么状态
> - **对应**：关联的功能编号 F-xx / 规则编号 BR-xxx / 决策 R-x
> - **涉及文档**：开工前必读
> - **涉及文件**：**只允许改这些文件**（新增文件会标注「新建」）
> - **前置条件**：未完成则不得开始
> - **完成标准**：可逐条勾选的验收点
> - **测试方法**：怎么验证
> - **风险**：需要特别注意的坑
>
> **⚠️ 每个任务对应哪些测试用例**：见 `51_TEST_CASES.md` 第九章「用例与任务对照表」。
> 自测时按该表执行，**没有对应用例的任务（如 T-P0-6、T-P2-1、T-P3-5）按本文「完成标准」逐条核对即可**。
>
> **用例编号规则**：`TC-<模块>-<序号>`，模块为 `AUTH / PROJ / UPLD / SEL / RSLT / NOTI / PERM / EDGE`。
> 全部用例共 **71 条**，其中 **28 条 P0 是发布门禁**（`52_ACCEPTANCE.md` 第五节）。

---

## P0 · 地基与安全

### T-P0-1 · 接入身份解析层 `resolveCaller`

| 项 | 内容 |
|---|---|
| **目标** | `project` 和 `selection` 两个云函数能通过 `resolveCaller` 同时识别小程序与网页两种来源的身份 |
| **对应** | BR-103 / BR-105 / BR-106；`20_ARCHITECTURE.md` 二 |
| **涉及文档** | `20_ARCHITECTURE.md` 二（身份解析层）、`23_PERMISSION.md` 全、`22_API.md` 1.4、`41_CODING_RULES.md` 2.2 |
| **涉及文件** | `cloudfunctions/project/index.js`、`cloudfunctions/selection/index.js` |
| **前置条件** | 无 |

**完成标准**
- [ ] 两个云函数文件内各有一份 `resolveCaller(event)`（内容相同，各写一份副本，**不抽公共包**）
- [ ] `resolveCaller` 先取 `cloud.getWXContext().OPENID`，取不到再取 `event.sessionToken`
- [ ] 网页路径查 `session` 集合换 openid；token 缺失 / 无效 / 过期返回 `ERR_NO_AUTH`
- [ ] **全部业务 action 已改为接收 `caller` 参数**，不再直接取 `OPENID`
- [ ] 每个 action 保留原有的第二重授权校验（`ownedProject` / `isAdmin` / `guardModel`），**未因改造而削弱**
- [ ] 小程序端现有功能**零回归**
- [ ] 全文件搜索确认：除 `resolveCaller` 内部与 `admin` 云函数外，无裸露的 `getWXContext().OPENID`

**测试方法**
1. 小程序端走一遍：首页 → 项目列表 → 项目详情 → 邀请 → 模特选片提交 → 看结果，全部正常
2. 云函数控制台直接调 `project.list` 不带任何身份 → 返回 `ERR_NO_AUTH`
3. 带一个伪造的 `sessionToken` → 返回 `ERR_NO_AUTH`

**风险**
- ⚠️ 改造时**不要顺手重构** action 内部逻辑，只改身份获取方式（AI-3）
- ⚠️ `photo` 云函数**不接入**（它靠 uploadToken 鉴权，不含 openid 逻辑），本次不动
- ⚠️ `admin` 云函数**不接入**（它只服务小程序引导页），本次不动

---

### T-P0-2 · 新建 `session` 云函数与集合

| 项 | 内容 |
|---|---|
| **目标** | 网页扫码登录的后端能力完整可用（6 个 action + 集合 + 索引） |
| **对应** | F-01 / F-02；BR-103~BR-105；`21_DATABASE.md` 八 |
| **涉及文档** | `21_DATABASE.md` 八（session 集合字段）、`22_API.md` 二（六个接口规格）、`31_STATE_MACHINE.md` 四（票据状态机）、`20_ARCHITECTURE.md` 三（扫码登录时序） |
| **涉及文件** | `cloudfunctions/session/index.js`（新建）、`cloudfunctions/session/package.json`（新建）、`cloudfunctions/session/config.json`（新建）、云开发控制台（建集合与索引） |
| **前置条件** | T-P0-1 |

**完成标准**
- [ ] 六个 action 全部实现：`createTicket` / `claim` / `poll` / `verify` / `logout` / `cleanup`
- [ ] `createTicket` **不需要身份**（网页未登录时调用），返回 `ticket` + 小程序码 `buffer`
- [ ] 小程序码 `scene` 带 `loginTicket`，`envVersion` 用 **`release`**
- [ ] `claim` 从 `OPENID` 取身份并绑定，票据状态 `PENDING → CLAIMED`
- [ ] `poll` 由网页在票据未 claim 时轮询；已 claim 返回 `sessionToken`
- [ ] `verify` 用 `sessionToken` 换 openid，过期返回 `ERR_NO_AUTH`
- [ ] 票据 5 分钟过期、token 30 天过期，**用毫秒时间戳**
- [ ] 集合建好索引：`ticket`（唯一）、`token`、`openid`、`expiresAt`
- [ ] **票据用后即失效**（一次性），防重放

**测试方法**
1. 不登录调 `createTicket` → 拿到 ticket 和码图
2. 小程序端调 `claim`（带 OPENID）→ 票据变 CLAIMED
3. 网页调 `poll` → 拿到 token
4. 网页调 `verify`（带 token）→ 返回自己的 openid
5. 5 分钟后调 `poll` → `ERR_EXPIRED`
6. 调 `logout` → 再 `verify` → `ERR_NO_AUTH`

**风险**
- ⚠️ 生成小程序码需要云函数的 openapi 权限，先确认 `config.json` 已声明
- ⚠️ **ticket 和 token 必须是两个不同的值**，不能复用同一个字符串

---

### T-P0-3 · 提交后严格锁定（F-16）

| 项 | 内容 |
|---|---|
| **目标** | 模特提交后再也无法自行修改，必须摄影师解锁 |
| **对应** | R-1 / F-16；BR-4xx（锁定相关）；`31_STATE_MACHINE.md` 二 |
| **涉及文档** | `31_STATE_MACHINE.md` 二（模特选片状态机）、`32_ERROR_HANDLING.md`（ERR_LOCKED 文案）、`10_PAGE_SPEC.md`（P-C2 提交终态区域） |
| **涉及文件** | `cloudfunctions/selection/index.js`（`saveSelection`）、`miniprogram/pages/client-select/index.wxml`（9-18 行）、`miniprogram/pages/client-select/index.ts` |
| **前置条件** | T-P0-1 |

**完成标准**
- [ ] `saveSelection` 开头加 `locked` 拦截：已锁定返回 `{ ok:false, error:'已提交，如需修改请联系摄影师', code:'ERR_LOCKED' }`
- [ ] 删除 `client-select/index.wxml:9-18` 的「继续调整」按钮及其绑定事件
- [ ] 提交成功页（终态）展示：已锁定说明 + 「如需修改请联系摄影师」
- [ ] 摄影师解锁后（`resetLock`），模特再次进入可正常保存
- [ ] **后端拦截是唯一权威**，前端按钮删除只是体验

**测试方法**
1. 模特选片 → 提交 → 再调 `saveSelection` → 返回 `ERR_LOCKED`
2. 提交成功页确认无「继续调整」按钮
3. 摄影师 `resetLock` → 模特进入 → 可保存 → 可再次提交

**风险**
- ⚠️ 页面里如果还有其他能改 `phase` 回 `ready` 的入口，一并找出并删除

---

### T-P0-4 · 项目状态值收敛（F-18）

| 项 | 内容 |
|---|---|
| **目标** | 存储状态固定 5 个，消灭死值与死分支 |
| **对应** | R-3 / F-18；BR-204 / BR-205 |
| **涉及文档** | `31_STATE_MACHINE.md` 一（项目状态机）、`21_DATABASE.md`（状态定稿）、`00_V1现状与问题分析.md` 决策 R-3 |
| **涉及文件** | `cloudfunctions/project/index.js`（`create`、第 312 行附近的 `EXPIRED` 分支、第 307-317 行 `extend`）、`cloudfunctions/selection/index.js`（若有 `COMPLETED`） |
| **前置条件** | T-P0-1 |

**完成标准**
- [ ] 全项目搜索 `COMPLETED`：**零命中**（定义与赋值全部删除）
- [ ] 全项目搜索 `EXPIRED`：**只作为派生态的判断条件存在，不作为 `status` 的赋值**
- [ ] `project/index.js:312` 附近的 `EXPIRED` 死分支删除
- [ ] `extend` 里的 `EXPIRED` 判断改为基于 `expireAt` 现算
- [ ] `status` 的赋值只出现这 5 个值：`DRAFT` / `UPLOADING` / `SELECTING` / `SELECTION_SUBMITTED` / `ARCHIVED`
- [ ] 「已过期」「宽限中」由 `expireAt` 现算，不落库

**测试方法**
1. `grep -rn "COMPLETED" cloudfunctions/ miniprogram/` → 无输出
2. `grep -rn "status: '" cloudfunctions/` → 只出现 5 个值
3. 建一个项目，把 `expireAt` 手动改到过去 → 列表显示「已过期」但 `status` 字段未变

**风险**
- ⚠️ 若前端有按 `status === 'EXPIRED'` 分支的代码，需同步改为按 `expireAt` 判断

---

### T-P0-5 · 修归档状态被回拉（Bug）

| 项 | 内容 |
|---|---|
| **目标** | 归档项目不会再被模特保存动作拉回 `SELECTING` |
| **对应** | `31_STATE_MACHINE.md` 2.5（禁止的转换 C-x）；BR-208 |
| **涉及文档** | `31_STATE_MACHINE.md` 一 2.5、`32_ERROR_HANDLING.md`（ERR_ARCHIVED） |
| **涉及文件** | `cloudfunctions/selection/index.js`（约第 540 行） |
| **前置条件** | T-P0-1 |

**完成标准**
- [ ] 该处的条件由 `p.status !== 'SELECTION_SUBMITTED'` 改为**同时排除 `ARCHIVED`**
- [ ] 已归档项目的 `getPreview` 返回 `ERR_ARCHIVED`
- [ ] 已归档项目在列表仍可见，thumb 与文件名仍可读
- [ ] 归档项目被模特打开时，提示「项目已归档，如需查看大图请联系摄影师续期」

**测试方法**
1. 归档一个项目 → 模特端触发一次保存 → 检查 `status` 仍为 `ARCHIVED`
2. 模特端点开大图 → 得到 `ERR_ARCHIVED` 提示
3. 摄影师续期 → 项目回到可上传状态 → 模特可正常浏览

**风险**
- ⚠️ 这是**真实 Bug**，不是优化。若发现其他位置有同类「只挡一个状态」的写法，一并上报（不要自行扩大改动范围）

---

### T-P0-6 · 删除 `ping` 云函数（F-21）

| 项 | 内容 |
|---|---|
| **目标** | 清理测试残留 |
| **对应** | F-21 |
| **涉及文档** | `00_V1现状与问题分析.md`（测试残留记录） |
| **涉及文件** | `cloudfunctions/ping/`（整个目录） |
| **前置条件** | 无 |

**完成标准**
- [ ] 删除前先 `grep -rn "ping" miniprogram/ web/` 确认前端零引用
- [ ] 若确认零引用，删除目录
- [ ] 删除后小程序编译通过、无报错

**测试方法**
1. 删除前 grep 确认零引用（**若发现任何引用，停止并上报**）
2. 小程序重新编译 → 无云函数缺失告警

**风险**
- ⚠️ 云函数删除要在微信开发者工具里同步「上传并部署」，否则云端残留仍计费

---

## P1 · 网页控制台（V2 主体）

### T-P1-1 · 网页脚手架 + 扫码登录（P-W1）

| 项 | 内容 |
|---|---|
| **目标** | 打开网页控制台地址，出现小程序码；微信扫一下，网页自动进入 |
| **对应** | F-01 / F-02；`10_PAGE_SPEC.md` P-W1 |
| **涉及文档** | `10_PAGE_SPEC.md` P-W1、`11_INTERACTION_SPEC.md`（扫码登录）、`20_ARCHITECTURE.md` 三（时序）、`22_API.md` 二、`41_CODING_RULES.md` 四 |
| **涉及文件** | `web/index.html`、`web/console.js`（新建）、`web/console.css`（新建，或扩 `style.css`）、`web/session.js`（新建，token 读写封装） |
| **前置条件** | T-P0-2 |

**完成标准**
- [ ] hash 路由骨架：`#/login`、`#/projects`、`#/project/:id`、`#/result/:id`
- [ ] P-W1 页显示小程序码（来自 `session.createTicket` 返回的 buffer）
- [ ] 未 claim 时按 2 秒间隔轮询 `session.poll`，**页面离开时清除定时器**
- [ ] 扫码成功后写入 `localStorage` 的 `sessionToken`，跳转 `#/projects`
- [ ] 已有 token 时，进入先调 `session.verify`；失败则清 token 回登录页
- [ ] 提供「退出登录」入口（调 `session.logout`）
- [ ] **码过期（5 分钟）有明确提示 + 「刷新二维码」按钮**
- [ ] 零框架：原生 JS，无 npm 依赖
- [ ] 三态齐全：加载中 / 码生成失败 / 已过期

**测试方法**
1. 打开 `#/login` → 出现码
2. 微信扫码 → 3 秒内网页自动跳转
3. 刷新页面 → 仍保持登录（localStorage）
4. 等 5 分钟不扫 → 提示过期 → 点刷新 → 新码可用
5. 手动清 localStorage → 刷新 → 回到登录页
6. 点退出登录 → 回到登录页

**风险**
- ⚠️ 轮询不要做成 1 秒以内（浪费云调用），2 秒是平衡点
- ⚠️ `envVersion` 必须是 `release`，否则真机扫不出来

---

### T-P1-2 · 小程序 guide 页接入扫码登录分支

| 项 | 内容 |
|---|---|
| **目标** | 摄影师扫码后，小程序端能完成票据认领 |
| **对应** | F-01；`22_API.md` 2.2 |
| **涉及文档** | `10_PAGE_SPEC.md`（guide 页）、`22_API.md` 2.2、`31_STATE_MACHINE.md` 四 |
| **涉及文件** | `miniprogram/pages/guide/index.ts`（及其 wxml / json） |
| **前置条件** | T-P0-2 |

**完成标准**
- [ ] guide 页 `onLoad` 解析 `scene` 参数，识别出 `loginTicket`
- [ ] 有 ticket 时调 `session.claim`，成功后提示「登录成功，请回到电脑继续」并关闭/返回
- [ ] claim 失败（票据过期/已被使用）有明确中文提示
- [ ] **无 ticket 时维持原有引导流程不变**（不影响「我是摄影师」开通与模特建档）
- [ ] 需确认该页面已在 `app.json` 中注册为可通过小程序码场景进入

**测试方法**
1. 扫登录码 → 小程序打开 guide 页 → 显示「登录成功」
2. 电脑上网页在 3 秒内跳转
3. 扫一个已用过的码 → 提示票据无效
4. 正常打开小程序（不扫码）→ 引导流程与原来完全一致

**风险**
- ⚠️ 小程序码 scene 参数有长度限制（32 字符），ticket 生成时要控制长度（22 位，`20_ARCHITECTURE.md` 已定）

---

### T-P1-3 · 项目列表 + 新建项目（P-W2）

| 项 | 内容 |
|---|---|
| **目标** | 登录后在网页看到全部项目，并能新建项目 |
| **对应** | F-03 / F-04；BR-2xx；`10_PAGE_SPEC.md` P-W2 |
| **涉及文档** | `10_PAGE_SPEC.md` P-W2、`22_API.md` 3.1~3.3、`30_BUSINESS_RULES.md` 三 |
| **涉及文件** | `web/console.js`、`web/console.css` |
| **前置条件** | T-P1-1 |

**完成标准**
- [ ] 列表字段齐全：项目名、状态标签、照片数、模特数及各自进度、剩余存续天数、占用容量
- [ ] 状态标签按 5 个存储值 + 派生态（已过期 / 宽限中）显示
- [ ] 「新建项目」弹窗：项目名（必填 ≤30 字）+ 套餐张数上限（0~999，**0 = 不限**）+ 存续天数（1~365，默认 30）
- [ ] 空状态：新用户显示引导文案 **「请在电脑上打开控制台创建项目」同类引导**，不是空白页
- [ ] 加载态 / 错误态 / 空态三态齐全（F-23 的网页部分）
- [ ] 列表按创建时间倒序
- [ ] 点击项目进入 `#/project/:id`

**测试方法**
1. 新账号登录 → 看到空状态引导
2. 新建项目 → 列表立即出现
3. 项目名留空 → 前端拦截提示
4. 套餐张数填 0 → 模特端不显示上限提示
5. 断网刷新 → 看到错误态 + 重试按钮

**风险**
- ⚠️ 状态标签文案要在**前端**统一一个映射函数，不要散落多处
- ⚠️ 「剩余存续天数」由 `expireAt` 现算，不要读数据库里没有的字段

---

### T-P1-4 · 上传链路改造（P-W3 主体）

| 项 | 内容 |
|---|---|
| **目标** | 在项目详情页直接拖拽上传，**不再需要复制上传码** |
| **对应** | F-05；BR-301 / BR-302；`22_API.md` 4.1 |
| **涉及文档** | `22_API.md` 4.1（`issueUploadSession`）、`24_FILE_STORAGE.md` 二（路径规则）、`10_PAGE_SPEC.md` P-W3、`41_CODING_RULES.md` 4.2 |
| **涉及文件** | `cloudfunctions/photo/index.js`（新增 `issueUploadSession`）、`web/console.js` 或 `web/uploader.js`（新建，移植自 `upload.js`）、`web/upload.js`（**只删不改**：上传码输入相关步骤可保留作兜底） |
| **前置条件** | T-P0-1、T-P1-3 |

**完成标准**
- [ ] `photo.issueUploadSession` 实现：由 `caller` 校验项目归属，返回上传会话凭证（不再需要 6 位上传码）
- [ ] 网页端进入项目详情 → 自动获取上传会话 → 可直接选文件
- [ ] 拖拽文件夹 / 多选文件可用（**复用现有 `traverseEntry` / `collectFiles`**）
- [ ] 并发 3、失败有重试（**复用现有常量与逻辑**）
- [ ] 进度条：已传 / 总数 / 失败数
- [ ] 上传结束有明确完成提示（F-25）
- [ ] **禁止重构 `ensureApp()` / `callFn()` / `uploadBlob()`**（C-1 裁决）
- [ ] 保留原有「输入上传码」路径作为兜底，不删除

**测试方法**
1. 进入项目详情 → 拖入一个含 20 张 JPG 的文件夹 → 全部上传成功
2. 中途断网 → 有失败提示 → 恢复后可重试
3. 上传结束 → 显示「成功 N 张，失败 M 张」
4. 刷新页面 → 已传照片数正确（不重复计数）
5. 用一个不属于自己的项目 ID 调 `issueUploadSession` → `ERR_NOT_FOUND`

**风险**
- ⚠️ 这是 V1 唯一完整验证过的核心能力，**移植优先于重写**
- ⚠️ 文件路径规则必须严格按 `24_FILE_STORAGE.md` 第二章，不要自创
- ⚠️ 重传同名文件按 `24` 的规则处理（覆盖 + 增量调整 `usedBytes`）

---

### T-P1-5 · 画质预览对比（F-06）

| 项 | 内容 |
|---|---|
| **目标** | 上传前能看到四档画质实际长什么样，并知道这批照片大概多大 |
| **对应** | F-06；BR-303；`11_INTERACTION_SPEC.md`（画质预览）、`24_FILE_STORAGE.md` 3.1 |
| **涉及文档** | `11_INTERACTION_SPEC.md`（画质预览章节）、`24_FILE_STORAGE.md` 3.1（四档参数）、`30_BUSINESS_RULES.md` 第一章（参考体积） |
| **涉及文件** | `web/uploader.js`（或 `web/quality.js` 新建）、`web/console.css` |
| **前置条件** | T-P1-4 |

**完成标准**
- [ ] 选完文件后，取**第一张真实样张**在浏览器本地用 canvas 生成四档
- [ ] 左右滑块对比（拖动分割线看两种画质的差异）
- [ ] **必须支持 100% 放大查看**（糊不糊只有 1:1 才看得出来）
- [ ] 每个档位标注「这批 N 张 ≈ XXX MB」（按 `30` 参考体积 ×N）
- [ ] 默认选中 `standard`（1600 / 0.75）
- [ ] 四档参数**来自常量表**，不硬编码在 UI 里
- [ ] 纯本地计算，**不上传、不消耗云资源**
- [ ] 选中的档位随上传一起提交

**测试方法**
1. 选 50 张 → 四档预览都能生成，且能 1:1 放大
2. 拖动对比滑块 → 左右两侧画质差异可见
3. 体积估算与实际上传后的 `usedBytes` 增量误差在 ±20% 内
4. 切换档位后再上传 → `project.previewSpec` 回写的是所选档位（此条依赖 T-P2-5 完成后才能验）

**风险**
- ⚠️ 用第一张做样张即可，不要对全部 N 张都做本地压缩（会卡死浏览器）
- ⚠️ 生成的预览图**不得上传**，仅本地展示

---

### T-P1-6 · 邀请二维码（P-W3 邀请区）

| 项 | 内容 |
|---|---|
| **目标** | 网页生成模特邀请小程序码，可下载 PNG、可复制链接 |
| **对应** | F-07；BR-207（二维码计入 usedBytes） |
| **涉及文档** | `10_PAGE_SPEC.md` P-W3 邀请区、`22_API.md` 3.8~3.11 |
| **涉及文件** | `cloudfunctions/project/index.js`（`getInviteQrCode`）、`web/console.js` |
| **前置条件** | T-P1-3 |

**完成标准**
- [ ] 项目详情页可为每位模特生成邀请码（`createInvite` → `getInviteQrCode`）
- [ ] 模特数上限 5（`MAX_MODELS`），超出返回 `ERR_LIMIT`
- [ ] 二维码可**下载 PNG**
- [ ] 可**复制邀请链接**
- [ ] **`getInviteQrCode` 的 `envVersion` 改为 `release`**（现在是 `trial`，正式版扫不出）
- [ ] 生成的二维码 PNG **计入 `project.usedBytes`**
- [ ] 可移除邀请（`removeInvite`）
- [ ] 列表展示每位模特的备注名与选片进度

**测试方法**
1. 生成邀请 → 微信扫码 → 模特端正确进入该项目
2. 下载 PNG → 图片可用
3. 复制链接 → 在微信里打开可用
4. 建到第 6 位模特 → 返回 `ERR_LIMIT`
5. 移除邀请 → 该模特再扫旧码 → 失效

**风险**
- ⚠️ `envVersion` 这条不改，**正式版上线后会直接不可用**，属必改项
- ⚠️ 每次生成二维码都会产生一张 PNG，重复点击会累积存储 —— 考虑同项目同模特复用（若文档未定义，上报）

---

### T-P1-7 · 选片结果查看与导出（P-W4）

| 项 | 内容 |
|---|---|
| **目标** | 网页端看到每位模特选了哪些，能一键拿到文件名清单 |
| **对应** | F-08 / F-09；`22_API.md` 5.10 |
| **涉及文档** | `10_PAGE_SPEC.md` P-W4、`11_INTERACTION_SPEC.md`（导出）、`22_API.md` 5.10（`getProjectResults`）、`41_CODING_RULES.md` 4.5 |
| **涉及文件** | `cloudfunctions/selection/index.js`（新增 `getProjectResults`）、`web/console.js` |
| **前置条件** | T-P0-1、T-P1-3 |

**完成标准**
- [ ] `getProjectResults` 一次返回**全部模特**的已选结果
- [ ] 返回**文件名**（服务端已按 filename 升序排好），**不生成任何临时链接**（零额外云调用）
- [ ] 可按模特切换查看
- [ ] 展示已选张数 + 缩略图网格 + 文件名列表
- [ ] 「一键复制」：按文件名升序，纯文本换行分隔
- [ ] 「导出 CSV」：列 = 序号 / 文件名 / 模特备注名；**文件头带 BOM**（Excel 中文不乱码）
- [ ] 复制失败降级为「自动选中文本 + 提示手动复制」，**不报错**
- [ ] 空结果（无人提交）有明确空态

**测试方法**
1. 两位模特各选若干张 → 网页分别查看，张数正确
2. 点一键复制 → 粘贴到记事本，顺序为文件名升序
3. 导出 CSV → **用 Excel 打开**，中文不乱码，三列齐全
4. 无人提交时 → 空态文案，不是空白

**风险**
- ⚠️ 这是本项目的**差异化核心能力**，排序规则不能错（V1 既定：按文件名升序）
- ⚠️ CSV 不带 BOM 是本类需求最常见的翻车点

---

### T-P1-8 · 项目操作（延期 / 归档 / 解锁 / 删除）

| 项 | 内容 |
|---|---|
| **目标** | 网页端能管理项目全生命周期 |
| **对应** | F-10；BR-207 / BR-208 / BR-209 |
| **涉及文档** | `22_API.md` 3.4~3.6、`31_STATE_MACHINE.md` 一、`30_BUSINESS_RULES.md` 三 |
| **涉及文件** | `web/console.js`、`cloudfunctions/project/index.js`（若需补逻辑） |
| **前置条件** | T-P1-3、T-P1-7 |

**完成标准**
- [ ] **延期**：在原有 `expireAt` 基础上 +30 天；已过期的从当前时间起算
- [ ] **归档**：状态转 `ARCHIVED`，删 preview 留 thumb；列表仍可见；大图不可用
- [ ] **解锁模特重选**：调 `resetLock`，文案为「可在已选基础上继续调整」（R-2）
- [ ] **删除**：**连带删除云存储**（preview + thumb + 邀请二维码 PNG），二次确认弹窗
- [ ] 删除确认弹窗属于允许的那 5 处之一，其余操作**不加确认弹窗**
- [ ] 每个操作有成功反馈

**测试方法**
1. 延期 → 剩余天数 +30
2. 归档 → 模特端点大图 → `ERR_ARCHIVED`；列表仍可见；thumb 仍可看
3. 解锁 → 模特可再选 → 保留原有选择（不是清空）
4. 删除 → 云存储控制台确认该项目的文件已消失
5. 删除时点取消 → 项目仍在

**风险**
- ⚠️ 删除必须真删云文件（V1 曾泄漏，V2.2 已修，不要改回去）
- ⚠️ 解锁文案**不是**「会清空她当前的选择」（R-2 已纠正）

---

## P2 · 小程序端收敛与数据治理

### T-P2-1 · 移除小程序端新建入口（F-15）

| 项 | 内容 |
|---|---|
| **目标** | 小程序摄影师端变为只读补充端 |
| **对应** | F-15 / F-11；BR-206 |
| **涉及文档** | `10_PAGE_SPEC.md` P-M1、`01_PRODUCT_SCOPE.md` 九（两端边界） |
| **涉及文件** | `miniprogram/pages/home/index.wxml`（第 12 行空态文案、第 33 行 FAB）、`miniprogram/pages/home/index.ts`（`goCreate`） |
| **前置条件** | T-P1-3 |

**完成标准**
- [ ] 删除 `home/index.wxml:33` 的 `+ 新建` 悬浮按钮
- [ ] 删除 `home/index.ts` 的 `goCreate` 方法
- [ ] `home/index.wxml:12` 空态文案改为引导去电脑端创建（如「请在电脑上打开控制台创建项目」）
- [ ] **`project-create` 页面目录保留不删**，只移除入口（BR-206）
- [ ] 首页其余能力（项目列表、转发邀请、查看结果）**零回归**

**测试方法**
1. 打开首页 → 无新建按钮
2. 无项目时 → 看到引导文案，不是空白页
3. 首页列表、点进详情、转发邀请、看结果 → 全部正常

**风险**
- ⚠️ 只删入口，不删页面文件（删目录会破坏路由和历史链接）

---

### T-P2-2 · 解锁文案修正（F-17）

| 项 | 内容 |
|---|---|
| **目标** | 弹窗文案与后端实际行为一致 |
| **对应** | R-2 / F-17 |
| **涉及文档** | `00_V1现状与问题分析.md` R-2、`32_ERROR_HANDLING.md` |
| **涉及文件** | `miniprogram/pages/selection-result/index.ts`（约第 120 行） |
| **前置条件** | 无 |

**完成标准**
- [ ] 文案由「会清空她当前的选择」改为「可在已选基础上继续调整」（或同义表述）
- [ ] 后端 `resetLock` **保持保留原选择的行为不变**（不改后端）
- [ ] 若网页端也有同类文案（T-P1-8），一并统一

**测试方法**
1. 摄影师解锁 → 弹窗文案为「可加可减」语义
2. 解锁后模特进入 → **原有选择仍在**（验证前后端一致）

**风险**
- ⚠️ 是改文案还是改行为已由 R-2 定案：**改文案，保留选择**。不要反过来改后端

---

### T-P2-3 · 订阅消息通知（F-14）

| 项 | 内容 |
|---|---|
| **目标** | 模特提交时，摄影师在微信收到一次通知 |
| **对应** | F-14；`01_PRODUCT_SCOPE.md` 6.2 |
| **涉及文档** | `03_USER_FLOW.md`（通知流程）、`22_API.md` 5.7 / 3.8 / 3.10、`21_DATABASE.md`（`notifyAuthAt` 字段） |
| **涉及文件** | `cloudfunctions/project/index.js`（`createInvite` 加 notify 参数、`listInvites` 返回）、`cloudfunctions/selection/index.js`（`submitSelection` 触发推送）、`cloudfunctions/project/config.json`（openapi 权限）、`miniprogram/pages/project-detail/index.ts`（授权勾选） |
| **前置条件** | T-P0-1 |

**完成标准**
- [ ] `createInvite` 支持 `notify` 参数；摄影师勾选即为一次授权
- [ ] `submitSelection` 成功时消耗一次授权并推送
- [ ] **一次授权对应一次推送**（微信订阅消息规则），不超额推送
- [ ] `project/config.json` 声明 `subscribeMessage.send` 的 openapi 权限
- [ ] 模板 ID 走配置，**不硬编码在业务逻辑里**
- [ ] 推送失败**不影响**提交流程（记日志，不回滚）

**测试方法**
1. 勾选「选片完成通知我」→ 生成邀请
2. 模特提交 → 摄影师微信收到一次通知
3. 第二位模特提交（若只授权一次）→ 不推送或需再次授权
4. 推送失败 → 模特仍显示提交成功

**风险**
- ⚠️ **上线前必须先在微信公众平台申请订阅消息模板**（审核 1~3 天），否则无法联调，会卡住本任务
- ⚠️ 模板 ID 属于环境配置，开源时要抽成配置模板

---

### T-P2-4 · `usedBytes` 校准（F-19）

| 项 | 内容 |
|---|---|
| **目标** | 容量计数准确，支撑在线额度显示 |
| **对应** | R-7 / F-19；`21_DATABASE.md`（usedBytes 字段）、`24_FILE_STORAGE.md` 四（双轨制） |
| **涉及文档** | `24_FILE_STORAGE.md` 四、`30_BUSINESS_RULES.md` 第一章 |
| **涉及文件** | `cloudfunctions/photo/index.js`（`registerPhoto` 增量）、`cloudfunctions/project/index.js`（归档 / 删除 / 续期 三处聚合重算） |
| **前置条件** | T-P0-1 |

**完成标准**
- [ ] 日常路径用增量计数器（`_.inc`）
- [ ] **归档 / 删照片 / 续期**三个低频节点，用 `photo` 表聚合重算覆盖计数器
- [ ] 邀请二维码 PNG 的体积**计入** `usedBytes`（现在漏了）
- [ ] 重传同名文件按**差值**调整，不重复累加
- [ ] 删除项目时 `usedBytes` 随记录一起消失（无需单独清零）

**测试方法**
1. 传 10 张 → `usedBytes` ≈ 10 ×（preview + thumb）
2. 生成 2 个二维码 → `usedBytes` 增加
3. 归档 → 重算后 `usedBytes` 下降到只剩 thumb 的量
4. 重传其中 1 张 → `usedBytes` 只按差值变化
5. 续期 → 重算值与实际文件一致

**风险**
- ⚠️ 聚合重算要分页（`photo` 可能上千条），**禁止一次性全表 get**

---

### T-P2-5 · `previewSpec` 改为回写（F-20）

| 项 | 内容 |
|---|---|
| **目标** | 画质档位由上传行为决定并回写，消除死字段 |
| **对应** | R-4 / F-20；BR-302 |
| **涉及文档** | `21_DATABASE.md`（previewSpec 字段）、`24_FILE_STORAGE.md` 3.2、`00_V1现状与问题分析.md` R-4 |
| **涉及文件** | `cloudfunctions/project/index.js`（`create` 删 previewSpec）、`cloudfunctions/photo/index.js`（`registerPhoto` 回写） |
| **前置条件** | T-P1-4 |

**完成标准**
- [ ] `project.create` **不再写入** `previewSpec`
- [ ] `registerPhoto` 在上传时把实际使用的画质档位**回写**到 `project.previewSpec`
- [ ] 回写值仅用于**展示与统计**，**不参与任何上传决策**
- [ ] 上传页的画质选择**不读** `project.previewSpec`（保持「上传时的选择」语义）

**测试方法**
1. 新建项目 → 检查无 `previewSpec` 字段
2. 用 `hd` 档上传 → `previewSpec` 变为 `hd`
3. 再用 `standard` 传一批 → `previewSpec` 更新为最近一次的值
4. 上传页打开时画质下拉**不受** `previewSpec` 影响（默认 `standard`）

**风险**
- ⚠️ 一个项目可能有多批不同画质的上传，回写的是**最近一次**。若需要更精确，上报讨论，不要自行改成数组

---

## P3 · 体验补齐与上线配置

### T-P3-1 · 图片淡入（F-22）

| 项 | 内容 |
|---|---|
| **目标** | 消除 4G 下图片逐张「跳入」 |
| **对应** | F-22；`11_INTERACTION_SPEC.md` |
| **涉及文档** | `11_INTERACTION_SPEC.md`（图片加载）、`10_PAGE_SPEC.md` P-C2 |
| **涉及文件** | `miniprogram/pages/client-select/index.wxml` 与 `.wxss` |
| **前置条件** | T-P0-3 |

**完成标准**
- [ ] `<image>` 加 `bindload`，加载完成时加 class 触发淡入（opacity 过渡）
- [ ] 未加载完成有占位底色，不是白块
- [ ] 淡入时长 200~300ms，不要太慢
- [ ] **手势逻辑仍在 `gest.wxs`**，未迁到逻辑层

**测试方法**
1. 用 4G 或限速环境打开选片页 → 图片逐张淡入，无跳变
2. 快速滑动 → 不卡

---

### T-P3-2 · 空 / 加载 / 错误三态补齐（F-23）

| 项 | 内容 |
|---|---|
| **目标** | 所有页面没有「白屏」和「无反馈」 |
| **对应** | F-23；`10_PAGE_SPEC.md` 各页状态区、`32_ERROR_HANDLING.md` |
| **涉及文档** | `10_PAGE_SPEC.md`（四态覆盖自检表）、`32_ERROR_HANDLING.md` |
| **涉及文件** | `miniprogram/pages/home/`（已完成部分）、`miniprogram/pages/client-select/`、`miniprogram/pages/selection-result/`、`miniprogram/pages/model-home/`、`web/console.js` |
| **前置条件** | T-P1-3、T-P2-1 |

**完成标准**
- [ ] 按 `10_PAGE_SPEC.md` 末尾的**四态覆盖自检表**逐格核对，缺一态视为未完工
- [ ] 空态有文案 + 引导动作（不是只有「暂无数据」）
- [ ] 加载态有骨架屏或 loading
- [ ] 错误态有文案 + 重试按钮
- [ ] 网络异常提示统一走 `32_ERROR_HANDLING.md` 的文案

**测试方法**
1. 逐页面：清空数据看空态、断网看错误态、慢速看加载态
2. 错误态点重试 → 能恢复

---

### T-P3-3 · 提交终态提示（F-24）

| 项 | 内容 |
|---|---|
| **目标** | 模特提交后明确知道已锁定、以及怎么申请修改 |
| **对应** | F-24；`10_PAGE_SPEC.md` P-C2 终态区、`32_ERROR_HANDLING.md`（ERR_LOCKED 文案） |
| **涉及文档** | `10_PAGE_SPEC.md` P-C2、`32_ERROR_HANDLING.md` |
| **涉及文件** | `miniprogram/pages/client-select/index.wxml` 与 `.ts` |
| **前置条件** | T-P0-3 |

**完成标准**
- [ ] 终态页有：已提交确认、已锁定说明、「如需修改请联系摄影师」
- [ ] 已选张数回显
- [ ] 再次进入该项目时直接显示终态，不回到选片态
- [ ] 文案与 `32_ERROR_HANDLING.md` 的 `ERR_LOCKED` 一致

**测试方法**
1. 提交 → 看到终态
2. 杀掉小程序重进 → 仍是终态
3. 确认无「继续调整」入口

---

### T-P3-4 · 上传完成提示（F-25）

| 项 | 内容 |
|---|---|
| **目标** | 上传结束有明确反馈与下一步引导 |
| **对应** | F-25；`11_INTERACTION_SPEC.md` |
| **涉及文档** | `11_INTERACTION_SPEC.md`（上传反馈）、`10_PAGE_SPEC.md` P-W3 |
| **涉及文件** | `web/uploader.js`（或 `console.js`） |
| **前置条件** | T-P1-4 |

**完成标准**
- [ ] 上传结束显示：成功张数 / 失败张数 / 总耗时（或占比）
- [ ] 有失败时提供「重试失败项」
- [ ] 有明确的下一步引导：去生成邀请二维码
- [ ] 不弹无意义的「操作成功」Toast 覆盖详细信息

**测试方法**
1. 正常上传 → 显示成功数与下一步
2. 故意混入一个损坏文件 → 显示失败数 + 重试按钮

---

### T-P3-5 · 上线前配置三项（**必做**）

| 项 | 内容 |
|---|---|
| **目标** | 让正式版真的能用 |
| **对应** | `20_ARCHITECTURE.md` 八（上线前检查） |
| **涉及文档** | `20_ARCHITECTURE.md` 八、`22_API.md` 3.11 |
| **涉及文件** | `cloudfunctions/project/index.js`（`getInviteQrCode`）、`cloudfunctions/project/config.json`、微信公众平台（后台配置） |
| **前置条件** | T-P1-6、T-P2-3 |

**完成标准**
- [ ] `getInviteQrCode` 的 `envVersion` = **`release`**
- [ ] `project` 云函数 openapi 权限包含 **`subscribeMessage.send`**
- [ ] 订阅消息模板已在微信公众平台申请通过，模板 ID 已填入配置
- [ ] 云开发**静态托管**已开通，控制台页面已部署，安全域名已配置
- [ ] 小程序正式版发布前，用真机走一遍完整链路

**测试方法**
1. 正式版小程序扫码 → 能打开项目（验证 envVersion）
2. 模特提交 → 摄影师收到通知（验证模板与权限）
3. 用非开发者微信打开控制台地址 → 能正常加载（验证静态托管）

**风险**
- ⚠️ 这三项都是**配置活不是编码活**，但漏任何一项都会导致线上不可用
- ⚠️ 订阅模板审核需 1~3 天，**建议提前做**，不要等开发到最后

---

## 附：任务总览

| 编号 | 任务 | 对应 F | 前置 | 估时 |
|---|---|---|---|---|
| T-P0-1 | 接入 resolveCaller | — | 无 | 0.5 天 |
| T-P0-2 | session 云函数与集合 | F-01/02 | P0-1 | 1 天 |
| T-P0-3 | 提交后严格锁定 | F-16 | P0-1 | 0.5 天 |
| T-P0-4 | 状态值收敛 | F-18 | P0-1 | 0.5 天 |
| T-P0-5 | 修归档被回拉 Bug | — | P0-1 | 0.5 天 |
| T-P0-6 | 删除 ping | F-21 | 无 | 0.1 天 |
| T-P1-1 | 网页脚手架 + 扫码登录 | F-01/02 | P0-2 | 2 天 |
| T-P1-2 | guide 页扫码分支 | F-01 | P0-2 | 0.5 天 |
| T-P1-3 | 项目列表 + 新建 | F-03/04 | P1-1 | 1.5 天 |
| T-P1-4 | 上传链路改造 | F-05 | P0-1,P1-3 | 2 天 |
| T-P1-5 | 画质预览对比 | F-06 | P1-4 | 1 天 |
| T-P1-6 | 邀请二维码 | F-07 | P1-3 | 1 天 |
| T-P1-7 | 结果查看 + 导出 | F-08/09 | P0-1,P1-3 | 1.5 天 |
| T-P1-8 | 项目操作 | F-10 | P1-3,P1-7 | 1 天 |
| T-P2-1 | 移除新建入口 | F-15 | P1-3 | 0.3 天 |
| T-P2-2 | 解锁文案修正 | F-17 | 无 | 0.1 天 |
| T-P2-3 | 订阅消息通知 | F-14 | P0-1 | 1.5 天 |
| T-P2-4 | usedBytes 校准 | F-19 | P0-1 | 1 天 |
| T-P2-5 | previewSpec 回写 | F-20 | P1-4 | 0.5 天 |
| T-P3-1 | 图片淡入 | F-22 | P0-3 | 0.3 天 |
| T-P3-2 | 三态补齐 | F-23 | P1-3,P2-1 | 1 天 |
| T-P3-3 | 提交终态提示 | F-24 | P0-3 | 0.3 天 |
| T-P3-4 | 上传完成提示 | F-25 | P1-4 | 0.3 天 |
| T-P3-5 | 上线前配置三项 | — | P1-6,P2-3 | 0.5 天（不含审核等待） |

**合计约 19 人天**（全职 4 周；业余每天 2 小时约 3~4 个月）

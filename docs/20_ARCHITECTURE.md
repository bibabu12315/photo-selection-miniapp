# 20 · 系统架构设计（V2.0）

> 本文件是 **V2.0 技术实现的唯一架构约束来源**。
> 读者：执行 V2.0 开发的 Coding Agent、以及需要理解系统的你。
> 前置阅读：`01_PRODUCT_SCOPE.md`（范围与红线）、`03_USER_FLOW.md`（流程与状态）。
> 下游文件：`21_DATABASE.md`、`22_API.md`、`23_PERMISSION.md`、`24_FILE_STORAGE.md`。

---

## 一、本文件要解决的唯一难点

V1 的权限体系是围绕「小程序 openid」建的：所有云函数通过
`cloud.getWXContext().OPENID` 取身份（见 `cloudfunctions/project/index.js:38`）。

V2 要让**网页端**也能做摄影师操作（建项目、传图、看结果、导出），而网页端没有 openid。
所以本轮的核心是设计一层**身份解析抽象**，把「调用者是谁」从「调用来自哪里」解耦。

其余所有模块（上传、选片、归档、存储）都是这层抽象之上的既有能力平移。

---

## 二、系统拓扑

```
┌───────────────── 摄影师（人） ─────────────────┐
│                                                │
│  电脑浏览器                         手机微信     │
│  ┌──────────────────────┐        ┌──────────────┐
│  │ 网页控制台（静态托管） │        │ 小程序摄影师端│
│  │ P-W1 登录            │        │ P-M1 首页     │
│  │ P-W2 项目列表        │        │ P-M2 详情     │
│  │ P-W3 详情+上传+邀请   │        │ P-M3 结果     │
│  │ P-W4 结果+导出       │        │ + 订阅通知    │
│  └──────────┬───────────┘        └──────┬───────┘
│             │ Web SDK callFunction      │ wx.cloud.callFunction
│             │ + sessionToken            │ + OPENID 环境变量
└─────────────┼──────────────────────────┼──────────┘
              │                          │
              ▼                          ▼
      ┌────────────────────────────────────────┐
      │  云函数层（统一入口 exports.main）      │
      │  ┌──────────────────────────────────┐  │
      │  │ resolveCaller(event)  ← 新增      │  │
      │  │  小程序 → OPENID                  │  │
      │  │  网页   → sessionToken → openid   │  │
      │  └──────────────────────────────────┘  │
      │  session / project / photo / selection │
      │  admin（不改动）                        │
      └───────────────┬────────────────────────┘
                      │ 云开发数据库（仅管理端可读写）
                      ▼
      project / photo / model / invite / selection / admin / session
                      │
                      ▼  云存储（私有，仅创建者可读写）
      p/{projectId}/preview/*.jpg
      p/{projectId}/thumb/*.jpg
      p/{projectId}/qrcode-{modelId}.png
```

---

## 三、冲突记录（按规则上报，不自行猜测）

### C-1【已裁决】网页端传输层：Web SDK 还是 HTTP 访问服务

| 项 | 内容 |
|---|---|
| **文档要求**（第六轮 `10_PAGE_SPEC.md`） | 网页端走「云开发 HTTP 访问服务 + 自有 sessionToken」，**不引入云开发 Web SDK** |
| **当前代码** | `web/upload.js:71-81` 已在使用微信 Web SDK（`cloud.js 1.4.0`，`identityless: true`），且 `index.html:121` 已引入该 SDK。上传链路 `app.uploadFile` / `app.callFunction` 全部依赖它 |
| **存在冲突** | 若按第六轮文档改用 HTTP 访问服务，等于**重写整个上传链路**（`uploadBlob`、`ensureApp`、`callFn`），而上传是 V1 已验证通过的核心能力，重写风险高、收益为零 |
| **建议（已采用）** | **传输层维持 Web SDK 不变；鉴权层按第六轮决策用自有 sessionToken。** 即：第六轮决策中「不引入云开发 Web SDK」这一句作废，「用自有 sessionToken 鉴权、不做匿名登录」这一句保留 |
| **理由** | 第六轮那条建议的前提是「网页端尚未接云开发」，实际已接。Web SDK 只是传输通道，与用什么 token 鉴权是两个正交问题。HTTP 访问服务要额外配置、额外域名、额外鉴权头，徒增复杂度 |

> **给 Coding Agent 的硬约束**：不要重构 `web/upload.js` 的 `ensureApp()` / `callFn()` / `uploadBlob()`。
> 只允许在其上叠加会话管理（见第七节）。

### C-2【已裁决】集合命名

`10_PAGE_SPEC.md` 中提到「新增 `loginTicket` 集合」；本文件统一命名为 **`session`** 集合。
**以 `21_DATABASE.md` 为准**，`loginTicket` 视为同一事物的旧称。

---

## 四、身份解析层 `resolveCaller`（核心新增）

在**每个需要身份的云函数**顶部新增一个公共函数（建议落点为各云函数文件内的本地函数，或新建 `cloudfunctions/common/caller.js` 由各函数 require —— 但云函数之间 require 需要打包处理，**本轮选择在每个云函数文件内各写一份 5 行的副本**，避免引入构建步骤）。

```js
/**
 * 解析调用者 openid。
 * - 小程序端：走 cloud.getWXContext().OPENID
 * - 网页端：走 event.sessionToken → 查 session 集合
 * 返回 '' 表示无法识别身份（调用方应拒绝）
 */
async function resolveCaller(event) {
  const { OPENID } = cloud.getWXContext()
  if (OPENID) return OPENID
  const token = String((event && event.sessionToken) || '').trim()
  if (!token) return ''
  return await openidBySessionToken(token)
}

async function openidBySessionToken(token) {
  try {
    const res = await db.collection('session')
      .where({ token, status: 'ACTIVE' }).limit(1).get()
    const s = res.data && res.data[0]
    if (!s) return ''
    if (!s.expireAt || s.expireAt < Date.now()) return ''
    return s.openid || ''
  } catch (e) {
    return ''
  }
}
```

**改造范围（逐个替换，不要遗漏）**：

| 云函数 | 现状 | V2 改法 |
|---|---|---|
| `project` | `index.js:38` 取 OPENID，空则拒绝 | 改为 `const openid = await resolveCaller(event)`；仍为空才拒绝 |
| `selection` | `index.js:30` 取 OPENID，空则拒绝 | 同上。注意 `getResult` / `resetLock` 内部还有 `isAdmin(openid)` 校验，随之生效 |
| `photo` | 不取 OPENID，靠 `uploadToken` | **不改**（上传会话已有自己的令牌）；仅新增 `issueUploadSession` 走 sessionToken |
| `admin` | **完全不动**（小程序端开通摄影师） | 不动 |
| `session`（新增） | — | 只处理登录票据，不需要 resolveCaller |

**安全约束**：
- `resolveCaller` 只能在服务端执行，绝不出现在小程序端代码
- sessionToken 只在 `session` 集合中比对，**不做任何可推导的生成规则**（见 `23_PERMISSION.md`）
- 小程序端路径**优先级高于** sessionToken：即便 event 里混入了 sessionToken，只要有 OPENID 就以 OPENID 为准（防止网页端伪造提权）

---

## 五、扫码登录时序（F-01，P-W1）

```
网页                         云函数 session                小程序                微信
 │                                │                          │                  │
 │ 1. createTicket                │                          │                  │
 │ ──────────────────────────────>│ 生成 ticket(22字符)      │                  │
 │                                │ 写 session{status:PENDING,expireAt:+5min}   │
 │ <──────────────────────────────│ 返回 ticket             │                  │
 │                                │                          │                  │
 │ 2. 用 ticket 生成小程序码        │                          │                  │
 │ ──────────────────────────────>│ getUnlimited(scene=ticket,page=pages/...)   │
 │ <──────────────────────────────│ 返回二维码图片（buffer/临时链接）            │
 │                                │                          │                  │
 │ 3. 展示二维码，开始轮询          │                          │                  │
 │                                │            用户微信扫码 ──>│                  │
 │                                │                          │ 4. onLoad 取 scene│
 │                                │    claim{ticket,openid}  │                  │
 │                                │ <─────────────────────────│                  │
 │                                │ 绑定 openid，status=ACTIVE                  │
 │                                │ 签发 sessionToken(32字符) │                  │
 │                                │ ─────────────────────────>│ 提示「已登录」    │
 │                                │                          │                  │
 │ 5. poll{ticket}（每 2 秒）      │                          │                  │
 │ ──────────────────────────────>│                          │                  │
 │ <──────────────────────────────│ status=ACTIVE → 返回 sessionToken + openid  │
 │                                │                          │                  │
 │ 6. 存 localStorage，进 P-W2     │                          │                  │
```

**关键规则**：
- ticket 有效期 **5 分钟**；sessionToken 有效期 **30 天**（从签发时算）
- 小程序端 `claim` 必须由**真实 OPENID** 调用（不接 sessionToken），否则任何人拿 ticket 都能冒领
- ticket 一旦被 claim 即失效，不可重复使用
- 轮询上限 150 次（5 分钟），超时提示「二维码已过期，请刷新」
- 网页端拿到 sessionToken 后**立即停止轮询**

**小程序端承载页面**：复用现有 `pages/guide/index`（引导页），根据 `scene` 判断：
- `scene` 为空 → 正常引导（选「我是摄影师」/ 扫码进选片）
- `scene` 为 22 位 ticket → 走静默 claim 流程，成功后显示「登录成功，请回到电脑」并自动返回
- `scene` 为 22 位 invite token → 现有模特端入场逻辑（**不变**）

> 两种 token 长度都是 22 位，靠**查库区分**：先查 invite，命中走选片；再查 session，命中走登录；都不命中提示「链接无效」。

---

## 六、模块划分与文件落点

### 6.1 云函数（5 个现有 + 1 个新增）

| 函数 | V2 职责 | 改动级别 |
|---|---|---|
| `session`（新增） | 登录票据：createTicket / qrcode / claim / poll / verify / logout | 全新，约 150 行 |
| `project` | 项目 CRUD + 邀请管理 | 中：加 resolveCaller、`list` 返回派生字段、`remove` 已修 |
| `photo` | 上传会话 + 照片登记 | 小：新增 issueUploadSession；verifyCode 保留兼容 |
| `selection` | 选片 + 结果 + 解锁 | 中：加 resolveCaller、`saveSelection` 加 locked 拦截（R-1）、提交后触发订阅通知 |
| `admin` | 摄影师开通 | **不动** |
| `ping` | 测试残留 | **建议删除**（前端零引用，`docs/00` 已记录） |

`project` 云函数需新增 openapi 权限：`wxacode.getUnlimited`（已有）、`subscribeMessage.send`（新增）。
`session` 云函数需新增 openapi 权限：`wxacode.getUnlimited`。

### 6.2 小程序端（8 个页面，`app.json` 已注册）

| 页面 | V2 改动 |
|---|---|
| `pages/guide/index` | 承载扫码登录 claim（新增分支） |
| `pages/home/index` | 移除 `+ 新建` FAB（行 33）、空态文案改「请在电脑上打开控制台创建项目」 |
| `pages/project-detail/index` | 移除上传入口、保留查看/邀请转发/解锁 |
| `pages/selection-result/index` | 解锁文案改「可加可减」（行 120） |
| `pages/project-create/index` | **保留文件，移除入口**（`project-create` 不再被 `home` 跳转） |
| `pages/client-select/index` | 移除「继续调整」按钮（行 16）、加淡入/占位 |
| `pages/photo-viewer/index` | 仅加淡入 + 失败占位，手势逻辑不动 |
| `pages/model-home/index` | 不动 |

### 6.3 网页端（3 个现有文件扩展，不重写）

| 文件 | V2 改动 |
|---|---|
| `web/index.html` | 从「上传向导单页」扩展为「多视图容器」：登录 / 列表 / 详情 / 结果 四个 section，hash 路由切换。**保留原有三步向导 DOM 作为 P-W3 的上传部分** |
| `web/upload.js` | 拆出 `session.js`（登录与会话）与 `console.js`（列表/详情/结果/导出）；`upload.js` 保留上传核心，暴露 `initUploadSession(projectId)` |
| `web/style.css` | 扩展控制台样式，主色 `#185FA5` |

**拆分方式**：新增 `web/session.js`、`web/console.js` 两个文件，`index.html` 按顺序引入 `cloud.js → session.js → upload.js → console.js`。`upload.js` 的 `ensureApp()` / `callFn()` 保持不动，由 `session.js` 复用。

---

## 七、三条主链路的数据流

### 7.1 上传链路（V2 去掉「复制上传码」）

```
P-W2 点「上传」→ P-W3
  → photo.issueUploadSession{ sessionToken, projectId }
  → 返回 uploadToken（直接写 project.uploadToken，24h）
  → 前端进入向导第 2 步（选文件 + 画质预览）
  → 逐张：浏览器 canvas 压缩 → app.uploadFile(preview/thumb)
       → photo.registerPhoto{ projectId, uploadToken, ... }
  → 全部完成后 project.status: DRAFT → UPLOADING
```

`photo.verifyCode` **保留但不再作为主路径**（兼容旧链接与临时手工场景）。

### 7.2 选片链路（基本不变）

```
模特扫码 → guide 页 scene=inviteToken → selection.entry{token}
  → model.openid 首次绑定 → ensureSelection 建双人键
  → client-select：getPhotos 分页（have 缓存去重）
  → 勾选 → 2s 防抖 → saveSelection（未锁定）
  → 提交 → submitSelection（locked=true）→ 触发订阅通知
```

V2 唯一变化：`saveSelection` 需先校验 `!selection.locked`（R-1）。

### 7.3 结果导出链路（网页独有）

```
P-W4 → selection.getProjectResults{ sessionToken, projectId }
  → 一次返回全部模特的已选文件名（含未提交/已提交状态）
  → 前端按文件名升序排列
  → 「复制文件名」：navigator.clipboard → 失败降级为选中文本
  → 「导出 CSV」：拼字符串 + BOM → Blob 下载
```

> 导出**不需要**临时链接（只要文件名），因此不产生额外云调用。

---

## 八、环境与配置清单

| 配置项 | 位置 | V2 新增/变更 |
|---|---|---|
| 云开发环境 ID | `miniprogram/env.ts`、`web/upload.js:15` | 不变（开源时需模板化） |
| 小程序 AppID | `web/upload.js:16` | 不变 |
| 静态托管 | 云开发控制台 | **需开通**，并把默认域名回填 `env.ts` 的 `UPLOAD_PAGE_URL` |
| 安全域名 | 小程序后台「开发设置」 | **需配置**静态托管域名（否则小程序内无法跳转网页） |
| `project` 云函数 openapi | `cloudfunctions/project/config.json` | 新增 `subscribeMessage.send` |
| `session` 云函数 openapi | 新建 `config.json` | `wxacode.getUnlimited` |
| 订阅消息模板 ID | 微信公众平台申请 | **新增**，模板 ID 写入云函数环境变量 `SUBSCRIBE_TPL_ID` |
| `STORAGE_BUCKET` | `cloudfunctions/photo` 环境变量 | 已支持覆盖，可选 |
| `ADMIN_BIND_KEY` | `cloudfunctions/admin` 环境变量 | 不变（仅 claimLegacy 用） |

---

## 九、架构红线（出现即越界，立即停止并上报）

1. **不引入任何前端框架**（React / Vue / 构建工具 / npm 依赖）。网页端必须保持「静态托管 + 原生 JS + 几个 script 标签」的形态，这是开源可部署的前提。
2. **不重写 `web/upload.js` 的传输层**（C-1 已裁决）。
3. **不改动 `cloudfunctions/admin/index.js`**。
4. **不新增云函数**，除 `session` 外。需要新能力时优先在 `project` / `selection` / `photo` 内加 action。
5. **不做定时触发器**。归档继续走 `listProjects` 的惰性触发（V1 已实现）。
6. **不自建服务器、不迁数据库、不引入 Redis/消息队列**。
7. **不在小程序端做任何摄影师管理入口的新增**（P-M 端已决定收敛）。
8. **不在客户端存储或传输 openid**（网页端只持有 sessionToken）。

---

## 十、验收点（架构层面）

- [ ] `session` 云函数部署成功，六个 action 可用
- [ ] 网页端扫码登录后，`project.list` 返回与小程序端完全一致的项目集合（同一 openid）
- [ ] 网页端不传 sessionToken 调用 `project.list` 时被拒绝
- [ ] 小程序端调用不受影响（回归：首页、选片、提交、结果）
- [ ] 上传链路仍可用，且不再需要输入上传码
- [ ] `photo` 云函数不被误改（verifyCode 仍可用作兜底）

# 22 · 接口规格（V2.0）

> 本文件是 **V2.0 所有云函数接口的唯一规格来源**。
> Coding Agent 必须严格按本文件实现；需要新增接口时，先改本文件再改代码。
> 相关：`20_ARCHITECTURE.md`（身份解析）、`21_DATABASE.md`（字段）、`23_PERMISSION.md`（鉴权）。

---

## 一、通用约定

### 1.1 调用方式

| 端 | 调用 |
|---|---|
| 小程序 | `wx.cloud.callFunction({ name, data })`，经 `miniprogram/services/request.ts` 的 `call/callSafe` |
| 网页 | `app.callFunction({ name, data })`，经 `web/upload.js:83` 的 `callFn`（**不改动**） |

`name` 为云函数名，`data` 中**必须**带 `action`。

### 1.2 统一返回

```js
{ ok: true,  data: { ... }, code?: 'OK' }
{ ok: false, error: '中文错误文案', code: 'ERR_XXX' }
```

- `ok` 是唯一判定依据，**存量前端全部只看 `ok` 和 `error`**，不要改变这一点
- `code` 为 V2 新增的可选字段：**新增接口必须返回，存量接口逐步补充，不要求一次改完**
- 错误文案直接面向用户展示（如「最多只能选 30 张」），不要返回技术堆栈

### 1.3 错误码表

| code | 含义 | 前端处理 |
|---|---|---|
| `ERR_NO_AUTH` | 无登录态 / sessionToken 无效或过期 | 网页跳回 P-W1；小程序回引导页 |
| `ERR_NOT_ADMIN` | 不是摄影师 | 提示「请先在小程序的引导页点『我是摄影师』」 |
| `ERR_NOT_FOUND` | 资源不存在 | 提示 + 返回列表 |
| `ERR_EXPIRED` | 项目已过期 / 票据过期 | 提示过期，提供续期入口（摄影师）或联系摄影师（模特） |
| `ERR_LOCKED` | 已提交锁定 | 提示「已提交，如需修改请联系摄影师」 |
| `ERR_LIMIT` | 超出套餐张数 / 模特数上限 | 直接展示文案 |
| `ERR_PARAM` | 参数缺失或格式错误 | 展示文案 |
| `ERR_ARCHIVED` | 项目已归档，大图不可用 | 提示联系摄影师续期 |
| `ERR_UNKNOWN` | 未分类异常 | 展示 `error` 文案 |

### 1.4 鉴权参数

- 小程序端：**什么都不传**，云函数从 `cloud.getWXContext().OPENID` 取
- 网页端：**每个请求都要带 `sessionToken`**（登录接口除外）

### 1.5 时间

全部使用 **毫秒时间戳**（`Date.now()`）。前端自行格式化。

---

## 二、`session` 云函数（V2 新增）

> 职责：网页端登录票据。**不需要** `resolveCaller`（`claim` 用真实 OPENID，其余用 ticket/token 本身鉴权）。

### 2.1 `createTicket`

```
用途：网页端申请一个登录票据，并生成小程序码
调用方：网页（P-W1）
鉴权：无（公开）
输入：{}
输出：{ ticket, qrUrl, expireAt }
副作用：写 session{ status:'PENDING', ticket, ticketExpireAt: now+5min }
失败：ERR_UNKNOWN
```

**实现要点**：
- `ticket` 用 `randomBase62(22)`（复用 `project/index.js` 中同名函数的实现思路）
- 小程序码走 `cloud.openapi.wxacode.getUnlimited`，`scene = ticket`，`page = 'pages/guide/index'`，`checkPath: false`，`envVersion: 'release'`
- 码图**不落云存储**：直接把 buffer 转 base64 返回（`data:image/png;base64,...`），网页 `<img src>` 可直接显示。理由：票据 5 分钟就过期，落存储还要清理，得不偿失
- 顺手清理 30 天前的历史票据（限 20 条）

### 2.2 `claim`

```
用途：小程序扫码后，把当前微信身份绑定到该票据，并签发 sessionToken
调用方：小程序（pages/guide/index，scene 命中 session）
鉴权：必须有真实 OPENID（不接受 sessionToken）
输入：{ ticket }
输出：{ ok, displayName }   // 显示「xxx 已登录」
副作用：session.status: PENDING → ACTIVE，写入 openid、token、claimedAt、tokenExpireAt(+30d)
失败：ERR_NOT_FOUND（票据不存在）、ERR_EXPIRED（已过期或已被使用）、ERR_NO_AUTH（无 OPENID）
```

**约束**：
- 必须校验 `status === 'PENDING'` 且 `ticketExpireAt > now`，否则拒绝
- 同一 ticket 只能 claim 一次（claim 后 status 变化，二次 claim 自然失败）

### 2.3 `poll`

```
用途：网页轮询票据状态，成功后换取 sessionToken
调用方：网页（P-W1）
鉴权：ticket
输入：{ ticket }
输出：{ status: 'PENDING' | 'ACTIVE', token?, openid?, expireAt? }
     status 为 ACTIVE 时返回 token（32 位）
失败：ERR_NOT_FOUND / ERR_EXPIRED
```

**前端规则**：每 2 秒一次，最多 150 次；拿到 token 立即停止。

### 2.4 `verify`

```
用途：校验 sessionToken 是否有效，返回摄影师身份信息
调用方：网页（每次进入控制台时调用一次）
鉴权：sessionToken
输入：{ sessionToken }
输出：{ openid, isAdmin, displayName, expireAt }
失败：ERR_NO_AUTH（token 无效/过期/已登出）
```

**说明**：`isAdmin` 为 `false` 时，网页端显示「请先在小程序的引导页点『我是摄影师』完成开通」。
网页端**不提供**开通入口（开通必须由小程序端完成，因为需要真实 OPENID）。

### 2.5 `logout`

```
用途：登出
调用方：网页
鉴权：sessionToken
输入：{ sessionToken }
输出：{ ok }
副作用：session.status → 'REVOKED'；前端清 localStorage
```

### 2.6 `cleanup`（可选，非必须）

```
用途：清理过期票据
调用方：网页（createTicket 时顺带触发）或手动
鉴权：无
输入：{}
输出：{ removed }
```

> 若嫌多余可不做。票据体积小，堆积不影响功能。

---

## 三、`project` 云函数（摄影师专用）

> **全部 action 都需摄影师身份**：`resolveCaller(event)` → `isAdmin(openid)` 双重校验。
> V2 前只认小程序 OPENID，V2 后额外接受网页 sessionToken。

### 3.1 `create`

```
输入：{ name, shootDate?, note?, expireDays?, packageCount?, sessionToken? }
输出：{ _id }
校验：name 非空且 ≤30 字；expireDays 1~365 默认 30；packageCount 0~999 默认 0（0=不限）
副作用：写 project{ ownerOpenid, status:'DRAFT', usedBytes:0, photoCount:0,
                   coverThumbs:[], models:[], modelCount:0, createdAt, updatedAt }
失败：ERR_PARAM
```

**V2 变更**：删除 `previewSpec` 字段的写入（见 `21_DATABASE.md` 2.4）。

### 3.2 `list`

```
输入：{ sessionToken? }
输出：{ projects: [...] }   // 按 createdAt 倒序，limit 100
副作用：惰性归档——对 expireAt 早于 (now - 7 天) 且未归档的项目自动触发 archive
```

**返回字段**：当前返回 `project` 全文档。V2 **不裁剪**（前端需要 `expireAt` 算派生状态、`models[]` 显示进度）。

> 派生状态（已过期 / 宽限中 / 剩余天数）由**前端**按 `expireAt` 计算，服务端不返回额外字段。

### 3.3 `get`

```
输入：{ _id, sessionToken? }
输出：{ project }
失败：ERR_NOT_FOUND / ERR_NOT_ADMIN
```

> 现状：`project/index.js` 的 `getProject` 曾返回未定义的 `res.data` 导致必崩，V2.2 已修为 `own.project`。**回归时重点验证**。

### 3.4 `remove`

```
输入：{ _id, sessionToken? }
输出：{ ok, deletedFiles }
副作用（缺一不可）：
  1. 删云存储：photo 分页取 previewFileID/thumbFileID + 邀请二维码 → deleteFile（50 一批）
  2. 删 photo / invite / selection / model 记录
  3. 删 project 记录
失败：ERR_NOT_FOUND
删除失败记日志但不阻断主流程
```

### 3.5 `extend`

```
输入：{ _id, days?, sessionToken? }   // days 默认 30
输出：{ ok, expireAt, needReupload }
副作用：expireAt += days*86400000
        若原状态为 ARCHIVED → status = 'UPLOADING'，返回 needReupload = true
        （归档时 preview 已删，需摄影师重新上传）
失败：ERR_NOT_FOUND
```

**V2 变更**：删除 `p.status === 'EXPIRED' ? 'SELECTING'` 这个死分支（`index.js:312`）。

### 3.6 `archive`

```
输入：{ _id, sessionToken? }
输出：{ ok, deletedFiles, usedBytes }
副作用：分页取全部 photo 的 previewFileID → deleteFile
        status = 'ARCHIVED'，archivedAt/archivedBy 写入
        usedBytes 重算为 thumbBytes 总和
失败：ERR_NOT_FOUND / 「这个项目已经归档了」
```

### 3.7 `issueUploadCode`（**保留但降级**）

```
输入：{ _id, sessionToken? }
输出：{ code, expireAt }   // 6 位数字，5 分钟有效
```

> V2 主路径改为 `photo.issueUploadSession`，此接口保留作为手工兜底（例如换一台没登录的电脑临时传图）。

### 3.8 `createInvite`

```
输入：{ projectId, displayName, notify?, sessionToken? }
输出：{ inviteId, modelId, models }
校验：displayName 非空 ≤20 字；models 已达 5 位则拒绝（ERR_LIMIT）
副作用：写 model{ openid:'', displayName }
        写 invite{ projectId, modelId, token, notifyAuth: !!notify, notifyAuthAt }
        project.models 追加 { modelId, name, selectedCount:0, status:'待选片', submittedAt:0 }
失败：ERR_PARAM / ERR_LIMIT
```

**V2 变更**：新增 `notify` 参数 → 写入 `invite.notifyAuth`。
摄影师在发邀请时勾选「选片完成通知我」，即完成一次订阅消息授权（一次授权一次推送）。

### 3.9 `removeInvite`

```
输入：{ inviteId, sessionToken? }
副作用：删 invite + model + selection；project.models 移除对应项，modelCount 同步
```

### 3.10 `listInvites`

```
输入：{ projectId, sessionToken? }
输出：{ invites: [{ _id, modelId, token }] }
```

**V2 变更**：返回中增加 `displayName`（从 model 表取，避免前端再发一次请求）与 `notifyAuth`。

### 3.11 `getInviteQrCode`

```
输入：{ inviteId, sessionToken? }
输出：{ fileID }   // 云存储上的 PNG
副作用：生成小程序码（scene = invite.token, page = 'pages/client-select/index'）
        上传至 p/{projectId}/qrcode-{modelId}.png
        project.usedBytes += PNG 字节数（V2 新增，原来漏计）
失败：ERR_NOT_FOUND / 「小程序码生成失败」
```

> **注意**：`envVersion` 当前为 `'trial'`，上线前需改为 `'release'`，否则正式版小程序扫不出来。

---

## 四、`photo` 云函数（上传 + 照片读取）

> **上传链路不依赖 OPENID**，靠上传会话令牌鉴权。**`list` 是唯一需要摄影师身份的 action**（2026-10-05 新增）。

### 4.1 `issueUploadSession`（**V2 新增**，主路径）

```
用途：网页端已登录后，直接换取上传会话，取代「复制 6 位上传码」
调用方：网页（P-W3）
鉴权：sessionToken + 摄影师身份 + 项目归属
输入：{ projectId, sessionToken }
输出：{ projectId, projectName, uploadToken, tokenExpireAt }   // 24 小时
副作用：写 project.uploadToken / uploadTokenExpireAt
失败：ERR_NO_AUTH / ERR_NOT_ADMIN / ERR_NOT_FOUND
```

**实现要点**：复用 `verifyCode` 中生成 token 的逻辑，只是入参从 `code` 换成 `sessionToken + projectId`。
**必须**用 `resolveCaller` 校验调用者是项目 owner。

### 4.2 `verifyCode`（保留，兜底）

```
输入：{ code }
输出：{ projectId, projectName, clientName, uploadToken, tokenExpireAt }
失败：ERR_PARAM（格式不对）/ ERR_EXPIRED（无效或过期）
```

### 4.3 `registerPhoto`

```
输入：{ projectId, uploadToken, stem, filename, previewPath, thumbPath,
        width, height, sortOrder, previewBytes, thumbBytes }
输出：{ photoId, updated? }
校验顺序（缺一不可）：
  1. 项目存在、uploadToken 匹配、未过期
  2. stem / path 安全过滤（防路径穿越）
  3. 云端核验：getTempFileURL 确认 preview 与 thumb 真实存在
副作用：
  新图：add photo；project.photoCount inc 1；usedBytes inc(previewBytes+thumbBytes)
        若 status 为 DRAFT → UPLOADING；coverThumbs 不足 3 张时 push thumbFileID
  重传（同 stem）：update photo；usedBytes 按字节差值 inc；不重复计数
失败：ERR_PARAM / ERR_NO_AUTH（会话无效）/ ERR_UNKNOWN（云端核验失败）
```

**V2 变更**：无。**不要动这个文件除新增 issueUploadSession 之外的部分。**

### 4.4 `list`（**UI 阶段新增**，全底片照片墙用）

```
用途：摄影师视角按项目分页列出全部照片（含宽高比、被哪些模特选中）
调用方：网页端项目详情照片墙、小程序摄影师端照片墙
鉴权：resolveCaller + 项目归属（非本人与「不存在」同返 ERR_NOT_FOUND）
输入：{ projectId, skip=0, limit=18, filter='all'|'selected'|'unselected',
        modelId?, have?: string[] }   // have = 端上已缓存缩略图链接的 photo._id
输出：{ photos:[{_id, filename, width, height, thumbUrl, cached, selectedBy[]}],
        hasMore, total, models:[{modelId, displayName, selectedCount, locked}],
        archived, packageCount }
失败：ERR_PARAM / ERR_NO_AUTH / ERR_NOT_FOUND
```

**详细规格（分页写法、selectedBy 计算、临时链接缓存、验收清单）见 `docs/55_PHOTO_LIST_API_SPEC.md`，实现前必读。**

要点三句：① `filter:'selected'` 必须走「selection.photoIds 并集 → 内存排序分页 → `where _id in(页内 ids)`」，否则翻页漏张；② 只返回 `thumbUrl`，大图走 `selection.getPreview`；③ 不要动上传链路三个 action。

---

## 五、`selection` 云函数（选片 + 结果）

### 5.1 `whoami`

```
输入：{}（或 sessionToken）
输出：{ openid, isAdmin, isModel, displayName }
```

### 5.2 `entry`

```
输入：{ token }  或  { projectId, modelId }（已认领后再次进入）
输出：{ projectId, modelId, displayName, projectName, photoCount,
        packageCount, locked, selectedIds[] }
副作用：首次凭 token 进入 → model.openid = 调用者（隐式建档）→ ensureSelection
失败：ERR_EXPIRED / 「该链接已被其他微信账号使用」/ ERR_NOT_FOUND
```

### 5.3 `myList`

```
输入：{}
输出：{ projects: [...] }   // 模特名下的全部项目
```

### 5.4 `getPhotos`

```
输入：{ projectId, modelId, skip?, limit?, have? }
      limit 默认 18，上限 50
      have = 端上已缓存的 photoId 数组（服务端跳过这些的链接生成）
输出：{ photos: [{ _id, filename, width, height, thumbUrl, cached }],
        hasMore, locked, packageCount, archived }
失败：ERR_NOT_FOUND / ERR_EXPIRED
```

### 5.5 `getPreview`

```
输入：{ projectId, modelId, photoId, range? }   // range 默认 0，上限 5（±2 共 5 张）
输出：{ photoId, filename, previewUrl, list: [{ photoId, filename, previewUrl }] }
失败：ERR_ARCHIVED（项目已归档）/ ERR_NOT_FOUND
```

### 5.6 `saveSelection`

```
输入：{ projectId, modelId, photoIds[] }
输出：{ saved: true, locked: false, selectedCount }
副作用：写 selection.photoIds / updatedAt
        更新 project.models[i]：selectedCount、status（已选>0 → 选片中）
        若 project.status 为 DRAFT/UPLOADING → SELECTING
失败：ERR_LIMIT（超出套餐张数）/ ERR_LOCKED（已提交）
```

> **🔴 V2 必须在开头新增 `locked` 拦截**（决策 R-1）：
> ```js
> if (selection && selection.locked) {
>   return { ok:false, code:'ERR_LOCKED', error:'已提交，如需修改请联系摄影师' }
> }
> ```
> 缺了这条，模特提交后仍可无限自助修改，`resetLock` 形同虚设。

### 5.7 `submitSelection`

```
输入：{ projectId, modelId, photoIds[] }
输出：{ saved: true, locked: true, selectedCount }
副作用：selection.locked = true，submittedAt = now
        project.models[i].status = '已提交'，submittedAt = now
        若全部模特均已提交 → project.status = 'SELECTION_SUBMITTED'
        project.lastSubmittedAt = now
        ★若该 invite.notifyAuth 为 true → 发订阅消息给 project.ownerOpenid
失败：同 saveSelection
```

**重复提交**：允许（幂等覆盖），不算错误——模特反复点提交不应报错。

### 5.8 `getResult`

```
输入：{ projectId, modelId, sessionToken? }
输出：{ locked, submittedAt, selectedCount,
        photos: [{ _id, filename, thumbUrl }] }
鉴权：摄影师（小程序 OPENID 或 sessionToken）
```

### 5.9 `resetLock`

```
输入：{ projectId, modelId, sessionToken? }
输出：{ ok }
副作用：selection.locked = false，submittedAt = 0，★photoIds 保持不变
        selection.unlockCount inc 1，lastUnlockAt = now
        project.models[i].status = 已选>0 ? '选片中' : '待选片'
        project.status = 'SELECTING'
```

> **🔴 文案与实现对齐**（决策 R-2）：前端 `selection-result/index.ts:120` 改为「可加可减」，
> 后端保留 `photoIds` 的行为**不变**。两端都是「保留原选择」。

### 5.10 `getProjectResults`（**V2 新增**，供网页导出）

```
用途：一次取回项目下全部模特的已选文件名，避免 N 次 getResult
调用方：网页（P-W4）
鉴权：摄影师 + 项目归属
输入：{ projectId, sessionToken }
输出：{
  projectName, photoCount, packageCount, status, expireAt,
  models: [{
    modelId, displayName, locked, submittedAt, selectedCount,
    filenames: ['DSC01234.jpg', ...]      // 已按 filename 升序
  }]
}
失败：ERR_NOT_ADMIN / ERR_NOT_FOUND
```

**实现要点**：
- 一次查 `photo`（limit 1000）建 `_id → filename` 映射，一次查 `selection`（where projectId）
- **不生成任何临时链接**（导出只要文件名），因此零额外云调用
- `filenames` 服务端排序（按 `filename` 字典序升序），前端不再排

---

## 六、V2 接口变更对照

| 接口 | 变更类型 | 说明 |
|---|---|---|
| `session.*`（6 个） | **新增** | 网页登录 |
| `photo.issueUploadSession` | **新增** | 消灭「复制上传码」 |
| `selection.getProjectResults` | **新增** | 网页导出 |
| `selection.saveSelection` | **修改** | 加 locked 拦截（R-1） |
| `selection.submitSelection` | **修改** | 触发订阅通知 |
| `selection.resetLock` | **修改** | 记 unlockCount / lastUnlockAt |
| `project.createInvite` | **修改** | 加 notify 参数 |
| `project.listInvites` | **修改** | 返回 displayName / notifyAuth |
| `project.getInviteQrCode` | **修改** | 计入 usedBytes；envVersion 改 release |
| `project.create` | **修改** | 删 previewSpec |
| `project.extend` | **修改** | 删 EXPIRED 死分支 |
| `project.*` 全部 | **改造** | 接入 resolveCaller |
| `selection.*` 全部 | **改造** | 接入 resolveCaller |
| `photo.verifyCode` / `registerPhoto` | **不动** | — |
| `admin.*` | **不动** | — |

---

## 七、接口与页面映射（对齐 `10_PAGE_SPEC.md`）

| 页面 | 调用的接口 |
|---|---|
| P-W1 扫码登录 | `session.createTicket` → `session.poll` → `session.verify` |
| P-W2 项目列表 | `session.verify`、`project.list`、`project.create`、`project.extend`、`project.archive`、`project.remove` |
| P-W3 项目详情 | `project.get`、`photo.issueUploadSession`、`photo.registerPhoto`、`project.listInvites`、`project.createInvite`、`project.removeInvite`、`project.getInviteQrCode` |
| P-W4 结果导出 | `selection.getProjectResults`、`selection.resetLock` |
| P-M1 首页 | `admin.status`、`selection.whoami`、`project.list` |
| P-M2 详情 | `project.get`、`project.listInvites`、`project.getInviteQrCode` |
| P-M3 结果 | `selection.getResult`、`selection.resetLock` |
| P-C1 引导 | `selection.entry` |
| P-C2 选片 | `selection.getPhotos`、`selection.saveSelection`、`selection.submitSelection` |
| P-C3 大图 | `selection.getPreview`、`selection.saveSelection` |
| guide（扫码登录分支） | `session.claim` |

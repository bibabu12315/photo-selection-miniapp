# 55 · `photo.list` 接口规格（全底片照片墙）

> **为什么必须有它**：设计稿 V1.2 的「网页端项目详情照片墙」和「小程序摄影师端照片墙」都要**按项目列出全部底片**（全部 / 已选 / 未选 + 按模特筛选）。现有接口里没有这个能力：
>
> | 现有能力 | 为什么不够 |
> |---|---|
> | `photo` 云函数：`issueUploadSession` / `verifyCode` / `registerPhoto` | 全是**上传链路**，没有读取 |
> | `project.get` | 只返回 3 张封面 `coverThumbs`，不含全部照片 |
> | `selection.getPhotos` | **模特视角**（`guardModel` 校验模特身份），摄影师不能用来看全项目的底片 |
> | `selection.getProjectResults` | 只返回已选照片的 `filenames`，**没有 `_id / width / height / 缩略图`**，画不出照片墙 |
>
> **结论**：新增 `photo.list`，放在 **`photo` 云函数**（它是照片域的归属函数；不放 `project`，避免 `project.get` 被撑爆）。

---

## 1. 接口定义

### 1.1 调用方式

| 端 | 调用 |
|---|---|
| 网页端 | `app.callFunction({ name: 'photo', data: { action: 'list', sessionToken, ... } })`（见 `web/upload.js:86` 的封装） |
| 小程序摄影师端 | `wx.cloud.callFunction({ name: 'photo', data: { action: 'list', ... } })` |

### 1.2 入参

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `projectId` | string | 是 | — | 项目 ID |
| `skip` | number | 否 | `0` | 分页偏移，`Math.max(0, ...)` |
| `limit` | number | 否 | `18` | 每页张数，**钳制 1~50**（与 `selection.getPhotos` 同一口径，常量仍是 `PHOTO_PAGE_SIZE = 18`） |
| `filter` | string | 否 | `'all'` | `'all'` / `'selected'` / `'unselected'` |
| `modelId` | string | 否 | — | 仅在 `filter: 'selected'` 时生效，只看该模特选中的照片 |
| `have` | string[] | 否 | `[]` | **端上已缓存缩略图链接的 `photo._id` 列表**——服务端跳过这些的 `getTempFileURL`，省调用（沿用 `selection.getPhotos` 的 `have` 机制，最多取前 3000 个） |

### 1.3 出参（成功）

```js
{
  ok: true,
  data: {
    photos: [
      {
        _id: 'xxx',            // 照片 ID
        filename: 'DSC01234.jpg',
        width: 1600,           // 预览图尺寸，瀑布流算高度用
        height: 1067,
        thumbUrl: 'https://...', // 缩略图临时链接
        previewFileID: 'cloud://...', // 大图 fileID，点开大图时前端按需换临时链接（不批量取，省调用）
        cached: false,         // true = 端上已有缓存，服务端没生成链接，端上从缓存补
        selectedBy: ['m1','m3'] // 选中这张的模特 ID 数组；无人选 = []
      }
    ],
    hasMore: true,            // 是否还有下一页
    total: 128,               // 当前 filter 下的总数（见 3.3）
    models: [                 // 供「已选」Tab 下的模特 chips 使用
      { modelId: 'm1', displayName: '小小', selectedCount: 10, locked: true },
      { modelId: 'm2', displayName: '小王', selectedCount: 8,  locked: false }
    ],
    archived: false,          // true = 项目已归档（大图已清理，UI 需提示续期）
    packageCount: 0           // 套餐上限，0 = 不限（摄影师核对用）
  }
}
```

### 1.4 错误码

| code | 文案 | 触发 |
|---|---|---|
| `ERR_PARAM` | 缺少 projectId | 无 `projectId` |
| `ERR_NO_AUTH` | 未登录，请先扫码登录 | 网页端无 `sessionToken` / token 无效或过期 |
| `ERR_NOT_FOUND` | 项目不存在或无权访问 | 项目不存在 **或** `ownerOpenid !== 调用者`——**两者必须返回同一句**，避免用报错差异探测他人项目（沿用 `project.get` / `selection.getProjectResults` 的既有约定） |

> 一律 `{ ok: false, error, code }` 结构，与现有云函数一致。

---

## 2. 鉴权（关键，别写错）

**必须自己实现一份身份解析**——`photo` 云函数目前**没有** `resolveCaller`，只有 `openidBySessionToken`（273 行）。按项目既定约定：**每个云函数各写一份副本**（见 `30` 文档身份章节），不要跨函数 require。

```js
async function resolveCaller(event) {
  // 1) 小程序端：微信上下文直接给 OPENID
  const wxCtx = cloud.getWXContext() || {}
  if (wxCtx.OPENID) return wxCtx.OPENID
  // 2) 网页端：用 sessionToken 换 openid
  const token = String((event && event.sessionToken) || '').trim()
  if (!token) return ''
  return await openidBySessionToken(token)  // 复用现有 273 行实现
}
```

**校验顺序**（照抄 `issueUploadSession` 55~83 行的形状）：

1. `resolveCaller` 返回空 → `ERR_NO_AUTH`
2. 缺 `projectId` → `ERR_PARAM`
3. 取 project，取不到或 `ownerOpenid !== openid` → `ERR_NOT_FOUND`
4. 通过。

**注意**：`photo` 云函数的另外三个 action 是**上传链路**，靠 `uploadToken` 鉴权、**不含 openid 逻辑**。**不要动它们**——只新增 `list`。`registerPhoto` 里那句「本云函数只做这一个 action 的身份解析」的注释要同步改成「两个 action（`issueUploadSession` / `list`）」。

---

## 3. 实现要点（照着写，别自由发挥）

### 3.1 主流程（filter = all / unselected）

直接沿用 `selection.getPhotos`（252~291 行）的形状：

```js
const res = await db.collection('photo')
  .where({ projectId: project._id })
  .orderBy('sortOrder', 'asc')   // 约定：一律 sortOrder 升序，前端不再二次排序
  .skip(s).limit(l).get()
```

- 排序**必须** `sortOrder asc`（`21_DATABASE.md` 三节约束，导出时才按 `filename` 升序，那是结果页的事）；
- `unselected` = 取页后过滤掉 `selectedBy.length > 0` 的项。⚠️ **分页会有轻微不准**（某页被过滤后可能不足 18 张），这是云开发聚合能力限制；
  **处理方式**：前端按「本页返回不足 `limit` 且 `hasMore` 为 true 时继续拉下一页」拼接，UI 上表现为滚动加载，用户无感。不要为此引入复杂游标。
- `hasMore` 判定：`photos.length === l`（与 `selection.getPhotos` 一致）。

### 3.2 filter = selected（**分页必须准确**，写法不同）

已选是核心视图（摄影师最关心），不能出现「翻页漏张」。做法：

1. 查 `selection` 集合 `where({ projectId })` → 若传了 `modelId` 就只取那一条；否则取全部模特的 `photoIds` **并集去重**；
2. 用这批 `_id` 反查 `photo` 集合拿到 `sortOrder` 并排序（单次 `limit 1000`，超出分批）；
3. 在**内存里**对排好序的 id 数组做 `slice(skip, skip + limit)`；
4. `where({ _id: _.in(页内 ids) })` 取详情（每页 ≤18 个 id，`in` 数组很小，安全）。

```js
const pageIds = sortedIds.slice(s, s + l)
const res = await db.collection('photo').where({ _id: _.in(pageIds) }).get()
// 再按 pageIds 顺序还原（where in 不保证顺序）
```

### 3.3 `total` 怎么给（别乱 count）

- `all` / `unselected`：直接用 `project.photoCount`（已有字段，**不要**额外 `count()`，省钱）；
- `selected`：用第 3.2 步并集数组的长度；
- `unselected` 的 total 允许用 `photoCount - 已选去重数` 估算，UI 上只用于「共 N 张」的展示，不参与分页判断。

### 3.4 `selectedBy` 怎么算（一次查询，别 N 次）

```js
const selRes = await db.collection('selection').where({ projectId }).limit(100).get()
// photoId -> [modelId]
const byPhoto = {}
;(selRes.data || []).forEach((s) => {
  ;((s && s.photoIds) || []).forEach((pid) => {
    ;(byPhoto[pid] = byPhoto[pid] || []).push(s.modelId)
  })
})
```

规模可控：最多 5 位模特 × 各自已选张数。**不要**对每张照片查一次库。

### 3.5 `models` 数组（给 chips 用）

复用 `selection.getProjectResults`（534 行）里已有的 `models` 拼装逻辑：`modelId / displayName / locked / submittedAt / selectedCount`。摄影师端「已选」Tab 下的模特 chips 直接吃这个数组，**不用再发一次请求**。

### 3.6 缩略图链接：批量 + 缓存

- **必须**复用 `have` 机制（同 `selection.getPhotos`：端上已缓存的不再生成链接，回 `cached: true`）；
- `getTempFileURL` **单次最多 50 个**，要按 50 分块（照抄 `selection/tempUrls` 754~773 行的分块实现，在 `photo` 里写一份副本）；
- 只返回 **thumbUrl**（thumbnail 320px）。**不要返回 preview 链接**——大图按需调用 `selection.getPreview` 拿（摄影师端同理），否则一次 18 张大图链接白烧流量。

### 3.7 归档项目（ARCHIVED）

- `archived: true` 时 thumb 仍在（缩略图不在归档清理范围内），所以**列表仍可渲染**；
- 前端拿到 `archived: true` 要在照片墙顶部提示「项目已归档 · 大图已清理，续期后可恢复」（对齐 `BR-306` 的原图/预览清理规则）；
- **不要**在 `list` 里直接拒绝归档项目（摄影师需要看到历史项目的缩略图清单）。

> ⚠️ 实现前请在 `24_FILE_STORAGE` 里确认「归档清理的是 preview 还是 thumb」。若 thumb 也被清了，则归档项目照片墙只能显示灰色占位 + 文件名，需同步改设计稿注释。

---

## 4. 索引与性能

| 项 | 要求 |
|---|---|
| 索引 | `photo` 集合需 `projectId + sortOrder` 复合索引（`21_DATABASE.md` 第九节索引建议已列，确认云开发控制台里已建；没建就先建，否则千张项目排序会慢） |
| 单次返回 | ≤ 18 张（硬上限 50），单页 `thumbFileID` ≤ 50 个 |
| 大图 | 不在本接口返回，走 `selection.getPreview` |
| 成本 | 每页最多 1 次 `getTempFileURL`（分块后可能 1 次内搞定）+ 2 次库查询（photo / selection） |

---

## 5. 前端对接要点

| 端 | 调用处 | 备注 |
|---|---|---|
| 网页端 | `web/console.js` 新增 `photoWallHtml()` + 拉取函数 | 传 `sessionToken`（`web/session.js:49` 的调用形态） |
| 小程序摄影师端 | `pages/project-detail` 或 `selection-result` 的照片墙 | `wx.cloud.callFunction`，无需传 token |

**通用约束**（与 `54_UI_REDESIGN_PLAN.md` 第 6 节瀑布流规范一致）：
- 缩略图链接**端上缓存 20 小时**（`BR-505`），翻页回来时用 `have` 传已缓存的 `_id`；
- 高度 = 列宽 × `height / width`；`width/height` 缺失（老数据可能为 0）时按 **3:2 兜底**；
- 分页 18 张滚动加载，保留「加载失败，点此重试」。

---

## 6. 验收清单

- [ ] 摄影师本人：网页端 + 小程序端都能拉到自己项目的全部照片
- [ ] 换一个微信号调别人的 `projectId` → 返回 `ERR_NOT_FOUND`（与「不存在」同文案）
- [ ] 未登录（网页端不带 token）→ `ERR_NO_AUTH`
- [ ] `filter: 'selected'` 翻页不漏张、不重复（造 25 张已选，翻到第 2 页核对）
- [ ] `modelId` 精确到某模特时，只出她选的
- [ ] 同一张被 2 位模特选中 → `selectedBy` 两个 ID 都在
- [ ] 归档项目：列表能出缩略图，且前端显示归档提示
- [ ] 翻回第 1 页时 `have` 生效（Network 里 `getTempFileURL` 不再重复生成）
- [ ] 上传链路三个 action 回归一遍（传一张、重传同名覆盖）不受影响

---

## 7. 部署与回归

- 改完**必须重新部署 `photo` 云函数**（云开发控制台 → 云函数 → photo → 上传部署）；
- 本接口只做读取，**不触碰**：`project.create`（非幂等，禁止自动重试）、状态机 5 值、`usedBytes` 计量、`resolveCaller` 语义；
- 云开发控制台「云端测试」**没有登录态**，直接测会报 `ERR_NO_AUTH`，属预期，不是 Bug（真机/网页端带 token 才有效）。

---

*本文件是 `54_UI_REDESIGN_PLAN.md` 中 D-2 的落地规格；接口实现完成前，网页端 / 摄影师端的照片墙只能先用 `coverThumbs` 占位验证视觉。*

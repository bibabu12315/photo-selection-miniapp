# 21 · 数据模型（V2.0）

> 本文件是 **V2.0 数据库结构的唯一来源**。
> 所有字段以**当前代码实际读写**为准（基线 `master @ c3f76e2`），V2 新增字段单独标注。
> 相关：`20_ARCHITECTURE.md`、`22_API.md`、`23_PERMISSION.md`。

---

## 一、集合总览

| 集合 | 用途 | V2 变化 |
|---|---|---|
| `project` | 拍摄项目（摄影师拥有） | 加 2 字段、删 1 死字段 |
| `photo` | 单张照片（preview + thumb） | 不变 |
| `model` | 模特档案（openid 隐式建档） | 不变 |
| `invite` | 每项目每模特一条邀请 | 加 2 字段（订阅通知） |
| `selection` | 选片结果（projectId × modelId 双人键） | 加 2 字段 |
| `admin` | 摄影师白名单 | 不变 |
| `session` | **新增**：网页端登录票据 | 全新 |
| `selftest` | 自检残留 | **建议删除** |

**权限设置（全部集合统一）**：`仅管理端可读写`。
这意味着**小程序端与网页端都无法直接访问数据库**，所有读写必须经云函数——这是本项目安全模型的基础（详见 `23_PERMISSION.md`）。

---

## 二、`project` 拍摄项目

### 2.1 字段表

| 字段 | 类型 | 必填 | 默认 | 含义 | 写入处 |
|---|---|---|---|---|---|
| `_id` | string | 是 | 自动生成 | 项目 ID | — |
| `ownerOpenid` | string | 是 | 调用者 openid | **归属摄影师**，多租户隔离的唯一依据 | `project/index.js:95` |
| `name` | string | 是 | — | 项目名，≤30 字 | create |
| `note` | string | 否 | `''` | 备注，≤200 字 | create |
| `shootDate` | number | 是 | `now` | 拍摄日期（时间戳 ms） | create |
| `status` | string | 是 | `'DRAFT'` | 见 2.2 状态表 | create / registerPhoto / resetLock / submit / archive |
| `expireAt` | number | 是 | `now + 30d` | 到期时间（ms） | create / extend |
| `packageCount` | number | 是 | `0` | 套餐张数上限，`0 = 不限` | create |
| `usedBytes` | number | 是 | `0` | **在线存储占用**（preview + thumb 总字节） | registerPhoto(inc) / archive(重算) / remove(归零) |
| `photoCount` | number | 是 | `0` | 照片数 | registerPhoto(inc) |
| `coverThumbs` | string[] | 是 | `[]` | 前 3 张缩略图 fileID，用于列表封面 | registerPhoto(push, ≤3) |
| `models` | object[] | 是 | `[]` | 模特进度摘要，见 2.3 | createInvite / saveSelection / resetLock / removeInvite |
| `modelCount` | number | 是 | `0` | 模特数（≤5），与 `models.length` 同步 | 同上 |
| `uploadCode` | string | 是 | `''` | 6 位上传码 | issueUploadCode |
| `uploadCodeExpireAt` | number | 是 | `0` | 上传码过期（5 分钟） | 同上 |
| `uploadToken` | string | 是 | `''` | 上传会话令牌（24h） | verifyCode / issueUploadSession |
| `uploadTokenExpireAt` | number | 是 | `0` | 上传会话过期 | 同上 |
| `archivedAt` | number | 否 | 归档时写 | 归档时间 | archive |
| `archivedBy` | string | 否 | 归档时写 | `'manual'` / `'auto'` | archive |
| `createdAt` | number | 是 | `now` | 创建时间 | create |
| `updatedAt` | number | 是 | `now` | 更新时间 | 各 update |

### 2.2 状态字段（V2 定稿，对应决策 R-3）

**落库的存储值固定 5 个：**

| 值 | 含义 | 进入条件 | 退出条件 |
|---|---|---|---|
| `DRAFT` | 已创建，还没传图 | create 时写入 | 首张照片登记成功 → `UPLOADING` |
| `UPLOADING` | 有照片，等待模特选 | 首张登记 / 归档后续期恢复 | 首位模特开始选片 → `SELECTING` |
| `SELECTING` | 有模特在选 | 模特保存或提交选择 | 全部模特提交 → `SELECTION_SUBMITTED`；摄影师解锁回退此态 |
| `SELECTION_SUBMITTED` | 全部模特已提交 | `models` 中每一项的 status 均为「已提交」 | 摄影师解锁任一模特 → `SELECTING` |
| `ARCHIVED` | 已归档（preview 已删，仅留 thumb） | 手动归档 / 列表惰性触发 | 续期 → `UPLOADING`（需重新上传 preview） |

**不落库的派生状态（前端按 `expireAt` 实时计算，禁止写库）：**

| 派生显示 | 判定条件 |
|---|---|
| 已过期 | `status !== 'ARCHIVED' && expireAt < now` |
| 宽限中 | `status !== 'ARCHIVED' && expireAt < now && now < expireAt + 7d`（即将自动归档） |
| 剩余 N 天 | `expireAt - now`，向上取整 |

**必须清理的死值**（`docs/00` 已记录，V2 执行时删除相关代码）：

- `EXPIRED`：`project/index.js:312` 有读取分支 `p.status === 'EXPIRED' ? 'SELECTING'`，但**全项目无处写入**，是死分支 → 删除该分支
- `COMPLETED` / `CLOSED`：代码中不存在，若文档或注释中出现一并清除

> **给 Coding Agent**：状态值必须严格取自上表 5 个。不得新增第 6 个存储状态，
> 不得把「已过期」写成 `status` 落库。

### 2.3 `models[]` 子结构

```js
{
  modelId: string,      // 关联 model._id
  name: string,         // 摄影师填的备注名，如「小王」
  selectedCount: number,// 已选张数
  status: '待选片' | '选片中' | '已提交',
  submittedAt: number   // 提交时间，0 = 未提交
}
```

### 2.4 V2 变更

| 变更 | 说明 |
|---|---|
| **删** `previewSpec` | 死字段：创建时写入 `{preset,longEdge,quality,watermarkText}`，但 web 上传页从不读取、从不回写；画质由上传页下拉框决定。**删字段 + 删 create 中的写入**（`project/index.js:103`）。若需要「项目默认画质」应另做 `defaultPreset` 字段并在上传页真实读取，本轮不做 |
| **留** `clientName` | `photo/index.js:66` 有 `p.clientName \|\| ''` 的读取但从未写入。**保持现状不动**（返回空串无副作用），不要为了对称去补写字段 |
| **加** `qrcodeBytes` | 邀请二维码 PNG 的字节数，计入 `usedBytes`（现在漏计，见 `docs/云成本优化`）。`getInviteQrCode` 时写入 |
| **加** `lastSubmittedAt` | 最近一次模特提交时间，供列表按「有动静」排序与通知去重 |

---

## 三、`photo` 照片

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `_id` | string | 是 | 照片 ID（选片结果里存的就是它） |
| `projectId` | string | 是 | 所属项目 |
| `stem` | string | 是 | 文件名主干（去扩展名、去路径），**同名即同一张**，重传覆盖 |
| `filename` | string | 是 | 完整文件名，如 `DSC01234.jpg`——**导出清单用的就是这个** |
| `previewFileID` | string | 是 | 预览图 cloud fileID |
| `thumbFileID` | string | 是 | 缩略图 cloud fileID |
| `previewBytes` | number | 是 | 预览图字节数（归档时据此扣减） |
| `thumbBytes` | number | 是 | 缩略图字节数 |
| `width` / `height` | number | 是 | 预览图尺寸 |
| `sortOrder` | number | 是 | 排序号，上传时的数组下标 |
| `createdAt` / `updatedAt` | number | 是 | 时间戳 |

**约束**：
- `projectId + stem` 唯一（代码通过 `where({projectId, stem}).limit(1)` 保证，无数据库唯一索引，靠云函数逻辑）
- 排序：一律 `orderBy('sortOrder','asc')`，前端不再二次排序
- 导出：**按 `filename` 升序**（V1 既有约定，与 sortOrder 无关）

---

## 四、`model` 模特档案

| 字段 | 类型 | 含义 |
|---|---|---|
| `_id` | string | 模特 ID |
| `openid` | string | **空串 = 尚未被认领**。首次凭邀请链接进入时写入，此后该微信号即为此模特 |
| `displayName` | string | 摄影师填的备注名 |
| `createdAt` / `updatedAt` | number | 时间戳 |

**关键规则**：
- 一个模特身份跨项目复用（同一微信号打开新邀请仍是同一 `modelId`？——**否**：当前 `createInvite` 每次都新建 model 记录，因此同一人在不同项目是不同 `modelId`。这是 V1 既有行为，**V2 保持不变**）
- `openid` 一旦写入不可改；若已认领且 `model.openid !== 调用者`，`entry` 抛「该链接已被其他微信账号使用」

---

## 五、`invite` 邀请

| 字段 | 类型 | 含义 |
|---|---|---|
| `_id` | string | 邀请 ID（前端用它取二维码） |
| `projectId` | string | 项目 |
| `modelId` | string | 模特 |
| `token` | string | 22 位 base62，作为小程序码 `scene` |
| `createdAt` | number | 时间戳 |
| **`notifyAuth`**（V2 新增） | boolean | 摄影师发邀请时是否勾选了「选片完成通知我」，默认 `false` |
| **`notifyAuthAt`**（V2 新增） | number | 授权时间（微信订阅为一次一推，记录便于排查） |

**约束**：每项目最多 5 条（`MAX_MODELS = 5`）。

**扫码 scene 冲突处理**：`invite.token` 与 `session.ticket` 都是 22 位 base62，小程序 `guide` 页面按「先查 invite → 再查 session → 都无则提示无效」的顺序判定。

---

## 六、`selection` 选片结果

**键结构**：`projectId × modelId` 双人键，一个项目中一位模特一条记录。

| 字段 | 类型 | 含义 |
|---|---|---|
| `_id` | string | — |
| `projectId` | string | 项目 |
| `modelId` | string | 模特 |
| `photoIds` | string[] | 已选照片的 `photo._id` 数组 |
| `locked` | boolean | **true = 已提交锁定，模特不可再改**（R-1 必须生效） |
| `submittedAt` | number | 提交时间，0 = 未提交 |
| `createdAt` / `updatedAt` | number | 时间戳 |
| **`unlockCount`**（V2 新增） | number | 摄影师解锁次数，默认 0（运营观察用，不参与业务判断） |
| **`lastUnlockAt`**（V2 新增） | number | 最近解锁时间 |

**规则**：
- `locked = true` 时，`saveSelection`（非提交态）必须拒绝，返回「已提交，如需修改请联系摄影师」
- 摄影师 `resetLock` 只置 `locked = false`、**保留 `photoIds` 不动**（决策 R-2，文案改为「可加可减」）
- 提交后 `submittedAt` 更新为当前时间

---

## 七、`admin` 摄影师白名单

| 字段 | 类型 | 含义 |
|---|---|---|
| `_id` | string | — |
| `openid` | string | 摄影师微信 openid |
| `boundAt` | number | 开通时间 |

**零门槛开通**：`admin.bind` 点「我是摄影师」即写入（决策 R-5 相关）。数据安全由 `project.ownerOpenid` 保证。

---

## 八、`session` 网页登录票据（**V2 新增**）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `_id` | string | 是 | — |
| `ticket` | string | 是 | 22 位 base62，写入小程序码 `scene`，**5 分钟有效** |
| `token` | string | 是 | 32 位 base62，sessionToken，**30 天有效**；`PENDING` 时为空串 |
| `openid` | string | 是 | 绑定的摄影师 openid；`PENDING` 时为空串 |
| `status` | string | 是 | `'PENDING'`（待扫码）/ `'ACTIVE'`（已登录）/ `'REVOKED'`（已登出或已失效） |
| `createdAt` | number | 是 | ticket 创建时间 |
| `claimedAt` | number | 否 | 扫码绑定时间 |
| `ticketExpireAt` | number | 是 | `createdAt + 5min` |
| `tokenExpireAt` | number | 否 | `claimedAt + 30d` |
| `ua` | string | 否 | 浏览器 UA 摘要（仅用于「我的设备」展示与异常排查，不参与鉴权） |

**状态流转**：

```
PENDING ──(小程序 claim 成功)──> ACTIVE ──(logout / 过期)──> REVOKED
   └──(5 分钟未扫)──> REVOKED
```

**清理**：不需要定时触发器。提供 `session.logout` 主动置 `REVOKED`；过期票据在查询时按 `tokenExpireAt` 判定即可，堆积的记录可在 `session.createTicket` 时顺手清理 30 天前的旧记录（限 20 条）。

**为什么 ticket 与 token 是两个值**：ticket 短命且只用于换取 token，会暴露在小程序码 `scene` 里（可被拍照传播）；token 长命且从不出现在二维码中。分离后即使 ticket 被截获，也只在 5 分钟内、且需要本人微信扫码才能兑换。

---

## 九、索引建议（云开发控制台手动创建）

| 集合 | 索引字段 | 类型 | 理由 |
|---|---|---|---|
| `project` | `ownerOpenid`（升序）+ `createdAt`（降序） | 联合 | `listProjects` 的主查询 |
| `photo` | `projectId`（升序）+ `sortOrder`（升序） | 联合 | 选片分页的主查询 |
| `photo` | `projectId`（升序）+ `stem`（升序） | 联合 | 重传去重查询 |
| `selection` | `projectId`（升序）+ `modelId`（升序） | 联合 | 双人键查询 |
| `invite` | `projectId`（升序） | 单字段 | 邀请列表 |
| `invite` | `token`（升序） | 单字段 | 扫码入场 |
| `model` | `openid`（升序） | 单字段 | 「我的拍摄」列表 |
| `session` | `token`（升序）+ `status`（升序） | 联合 | 每次网页请求都要查 |
| `session` | `ticket`（升序） | 单字段 | 扫码绑定与轮询 |

> 云开发默认对 `_id` 有索引，其他需手动建。索引不建也能跑，但数据量上万后 `listProjects` 会明显变慢。

---

## 十、数据一致性规则

1. **`usedBytes` 双轨制**（决策 R-7）：日常用 `_.inc(delta)` 增量；在**归档 / 删除照片 / 续期**三个低频节点，用 `photo` 表聚合求和**覆盖**写入，防止误差累积漂移。
2. **`photoCount` 同理**：增量为主，归档与删除时以实际计数覆盖。
3. **`models[]` 与 `invite` 同步**：`removeInvite` 必须同时清 `invite`、`model`、`selection` 三条记录和 `project.models[]` 中的项（当前已实现，不要破坏）。
4. **删除项目**（`removeProject`）必须连带：photo 记录、云存储 preview/thumb/二维码、invite、selection、model（V2.2 已修，回归时验证）。
5. **归档不等于删除**：`status='ARCHIVED'` 的项目仍可在列表中看到，只是大图不可用且 `getPreview` 拒绝。

---

## 十一、迁移脚本（V2 上线前执行一次）

| 步骤 | 操作 | 风险 |
|---|---|---|
| 1 | 新建 `session` 集合，权限「仅管理端可读写」 | 无 |
| 2 | 给 `invite` 补 `notifyAuth: false`、`notifyAuthAt: 0` | 无，读端用 `\|\|` 兜底 |
| 3 | 给 `selection` 补 `unlockCount: 0`、`lastUnlockAt: 0` | 无 |
| 4 | 从 `project` 移除 `previewSpec` 字段（可选，不移除也不影响） | 无 |
| 5 | 删除 `selftest` 集合 | 需先删除 `ping` 云函数 |
| 6 | 建索引（第九节） | 无 |

> **不要做**破坏性数据迁移。所有 V2 新增字段都允许缺失（读端用默认值兜底），因此**不写批量迁移脚本也可以正常上线**。

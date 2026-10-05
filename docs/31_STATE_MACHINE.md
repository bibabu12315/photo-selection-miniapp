# 31 · 状态机（V2 完整定义）

> **本文档定位**：定义系统中**每一个状态、每一次转换的触发条件与副作用**。
>
> **给 Coding Agent**：状态值、转换条件、副作用三者**都必须严格按本文件实现**。
> 不得新增状态、不得新增转换、不得省略副作用。发现需要新增时，**停下来上报**，不要自己加。

---

## 一、状态机总览

系统由 6 个彼此独立的状态机组成：

| 编号 | 状态机 | 载体 | 是否落库 | 章节 |
|---|---|---|---|---|
| **PSM** | 项目状态机 | `project.status` | ✅ 落库（5 值） | 三 |
| **MSM** | 模特选片状态机 | `selection` + `project.models[]` | ✅ 落库 | 四 |
| **USM** | 上传任务状态机 | 网页端内存 / `localStorage` | ❌ 不落库 | 五 |
| **SSM** | 登录票据状态机 | `session.status` | ✅ 落库 | 六 |
| **ISM** | 邀请票据状态机 | `invite` 记录存在与否 | ✅ 落库 | 七 |
| **PHM** | 照片记录状态机 | `photo` 记录 | ✅ 落库 | 八 |

**贯穿原则**：
1. 落库状态**只存真实需要的**，能算出来的**一律派生、不落库**（R-3）。
2. 每次转换必须**原子完成**（同一个 `update` 里写完所有字段），不得分多次写导致中间态。
3. 状态转换的**副作用**（如 `usedBytes` 重算、文件删除）在同一次调用内完成；文件删除失败**不阻断**状态转换，但要写日志。

---

## 二、项目状态机（PSM）

### 2.1 状态定义（存储值只有 5 个）

| 状态 | 含义 | 模特端 | 摄影师端 |
|---|---|---|---|
| `DRAFT` | 已创建、未上传任何照片 | 不可进入 | 可上传、可邀请（但无意义） |
| `UPLOADING` | 已有照片，等待模特选 | 可浏览可选 | 可继续上传、可邀请 |
| `SELECTING` | 已有模特进入 | 可浏览可选 | 可查看进度 |
| `SELECTION_SUBMITTED` | 全部模特已提交 | 只读 | 可看结果、可解锁、可导出 |
| `ARCHIVED` | 已归档（preview 已删） | 只读（大图不可用） | 可见、可续期、可删除 |

### 2.2 转换表

| 编号 | 从 → 到 | 触发者 | 触发入口 | 前置条件 | 数据库副作用 | 失败处理 |
|---|---|---|---|---|---|---|
| **T-P01** | （新建）→ `DRAFT` | 摄影师 | `project.create` | name 非空 ≤30 字 | 写 `status:'DRAFT'`、`expireAt`、`usedBytes:0`、`photoCount:0`、`models:[]` | `ERR_PARAM` |
| **T-P02** | `DRAFT` → `UPLOADING` | 系统 | `photo.registerPhoto` | 该项目的**首张**照片登记成功 | `status:'UPLOADING'`、`photoCount:1`、`usedBytes += preview+thumb` | 登记失败则整体失败，状态不变 |
| **T-P03** | `DRAFT`/`UPLOADING` → `SELECTING` | 模特 | `selection.entry` | 模特持有效邀请 token 首次进入 | `status:'SELECTING'`；`models[]` 对应项 `status:'待选片'` | `ERR_EXPIRED` / `ERR_NOT_FOUND` |
| **T-P04** | `SELECTING` → `SELECTION_SUBMITTED` | 模特 | `selection.saveSelection(submit)` | 提交后 `models[]` **每一项**均为「已提交」 | `models[]` 项 `status:'已提交'`+`submittedAt`、`selection.locked:true`、项目 `status:'SELECTION_SUBMITTED'` | 校验失败不改状态 |
| **T-P05** | `SELECTION_SUBMITTED` → `SELECTING` | 摄影师 | `selection.resetLock` | 摄影师是项目 owner；该模特已提交 | `selection.locked:false`、`submittedAt:0`、`photoIds` **保留**、`models[]` 项回「选片中」、项目 `status:'SELECTING'` | `ERR_NOT_ADMIN` / `ERR_NOT_FOUND` |
| **T-P06** | 任意非 `ARCHIVED` → `ARCHIVED` | 摄影师 / 系统 | `project.archive`；或 `project.list` 惰性触发 | 摄影师是 owner；**惰性触发还要求** `expireAt + 7d < now` | 删 preview 云文件（**留 thumb + 二维码**）、`status:'ARCHIVED'`、`archivedAt`、**`usedBytes` 重算为 thumb 总量** | 文件删除失败**不阻断**，写日志 |
| **T-P07** | `ARCHIVED` → `UPLOADING` | 摄影师 | `project.extend` | 摄影师是 owner | `expireAt = max(old, now) + 30d`、`status:'UPLOADING'`、返回 `needReupload:true` | `ERR_NOT_ADMIN` |
| **T-P08** | 任意 → （删除） | 摄影师 | `project.remove` | 摄影师是 owner | **全删**：photo 记录、云存储 preview+thumb+二维码、invite、selection、model | 文件删除失败不阻断 |

### 2.3 转换图

```
              project.create
                    │
                    ▼
        ┌─────── DRAFT ───────┐
        │                     │
   T-P02│首张照片登记      T-P03│模特首次进入
        ▼                     │
   UPLOADING ─────────────────┤
        │                     │
        │                     ▼
        └───────────────► SELECTING ◄──────────┐
                              │                │
                    T-P04     │           T-P05│摄影师解锁
                  全部模特提交  │                │
                              ▼                │
                   SELECTION_SUBMITTED ────────┘
                              │
              T-P06           │           T-P07
            归档（删preview）  │          续期（需重传）
                              ▼                │
                          ARCHIVED ────────────┘
                              │
                          T-P08│删除（全删）
                              ▼
                          （已删除）
```

### 2.4 派生态（不落库，前端现算）

| 派生显示 | 判定条件 | 模特端表现 | 摄影师端表现 |
|---|---|---|---|
| **已过期** | `status !== 'ARCHIVED' && expireAt < now` | 禁止选片（只读） | 标签「已过期」，提供续期 |
| **宽限中** | 已过期 `&& now < expireAt + 7d` | 同上 | 标签「X 天后自动归档」 |
| **正常** | `expireAt >= now` | 正常 | 显示剩余天数 |

> `EXPIRED` **不得作为存储值**（R-3）。`project/index.js:312` 的 `p.status === 'EXPIRED' ? 'SELECTING'` 是**死分支**，V2 删除。

### 2.5 禁止的转换（必须加守卫）

| 禁止项 | 说明 | 代码落点 |
|---|---|---|
| ❌ `ARCHIVED` → `SELECTING`（非续期路径） | **现网漏洞**：`selection/index.js:540` 的 `else if (p.status !== 'SELECTION_SUBMITTED') update.status = 'SELECTING'` 会把**已归档**项目拉回 `SELECTING`。必须加条件：`p.status !== 'ARCHIVED'` | `selection/index.js:540` |
| ❌ 新增第 6 个存储状态 | 不得引入 `COMPLETED` / `EXPIRED` / `CLOSED` | `types/index.ts` |
| ❌ 模特自行从「已提交」回到「选片中」 | 只能走 T-P05（摄影师解锁） | `selection.saveSelection` |
| ❌ `DRAFT` 直接进入 `SELECTION_SUBMITTED` | 必须先有照片、再有模特 | — |

---

## 三、模特选片状态机（MSM）

### 3.1 状态定义

按 `(projectId, modelId)` 双人键，**每位模特独立一份**。

| 状态 | 判定 | 模特能做什么 | 数据写入 |
|---|---|---|---|
| **未开始**（`待选片`） | 有 `model` 记录，无 `selection` 或 `photoIds` 为空 | 浏览、选择 | 变更后 2s 防抖自动保存 |
| **选片中** | `photoIds.length > 0 && !locked` | 浏览、选择、取消 | 同上 |
| **已提交（锁定）** | `locked === true` | **只读**（R-1） | 已写入，不再改 |
| **已解锁** | `resetLock` 后 `locked === false` 且保留 `photoIds` | 在原基础上增删 | 变更后自动保存 |

### 3.2 转换表

| 编号 | 从 → 到 | 触发者 | 触发入口 | 副作用 |
|---|---|---|---|---|
| **T-M01** | 未开始 → 选片中 | 模特 | `saveSelection`（首次写入非空 ids） | `models[]` 项 `status:'选片中'`；项目 → `SELECTING`（T-P03） |
| **T-M02** | 选片中 → 已提交 | 模特 | `saveSelection(submit=true)` | `locked:true`、`submittedAt:now`、`models[]` 项 `status:'已提交'`；**推送订阅消息**（BR-1101）；若全员提交则 T-P04 |
| **T-M03** | 已提交 → 已解锁 | 摄影师 | `resetLock` | `locked:false`、`submittedAt:0`、`photoIds` **保持原值**（R-2）、`unlockCount+1`、`lastUnlockAt` |
| **T-M04** | 已解锁 → 已提交 | 模特 | 再次 `saveSelection(submit=true)` | 同 T-M02 |
| **T-M05** | 选片中 → 选片中（自更新） | 模特 | `saveSelection` 防抖触发 | 仅覆盖 `photoIds`，不改 `locked` |

### 3.3 转换图

```
   未开始 ──T-M01(首次选择)──► 选片中
                                │
                    T-M02(提交)  │  ▲ T-M03(摄影师解锁，保留原选择)
                                ▼  │
                          已提交 ───┘
                                │
                                └──T-M04(再次提交)──► 回到已提交
```

### 3.4 关键约束

| 编号 | 约束 |
|---|---|
| **C-M1** | **提交次数不限**（可反复 T-M03 → T-M04），但**每次解锁都必须由摄影师发起** |
| **C-M2** | 已提交状态下 `saveSelection` 必须**拒绝写入**并返回 `ERR_LOCKED`（BR-602） |
| **C-M3** | 解锁**不清空** `photoIds`（BR-701） |
| **C-M4** | 多位模特的 MSM **完全独立**，互不感知 |

---

## 四、上传任务状态机（USM，本地）

### 4.1 状态定义（**不落库**）

| 状态 | 含义 | 界面表现 |
|---|---|---|
| `待上传` | 已选文件、未开始 | 列表灰色 |
| `上传中` | 正在传输 | 进度条 |
| `上传成功` | 已登记到 photo 表 | 绿色对勾 |
| `上传失败` | 重试 2 次仍失败 | 标红，进失败列表 |
| `等待重试` | 失败后等待用户点「重试失败的」 | 标红 |

### 4.2 转换图

```
   待上传 ──开始──► 上传中 ──成功──► 上传成功
                     │
                     ├──失败(第1、2次)──► 上传中（自动重试）
                     │
                     └──失败(第3次)──► 上传失败 ──► 等待重试 ──点重试──► 上传中

   任何非成功态 ──网络断开──► 待上传（暂停排队，恢复后点继续）
   非图片文件 ──► （跳过，不进入状态机，计入"被跳过列表"）
```

### 4.3 约束

| 编号 | 约束 |
|---|---|
| **C-U1** | 并发固定 **3**（`web/upload.js:20`），不得调大（会触发限流） |
| **C-U2** | 单张**最多 3 次尝试**（首次 + 2 次自动重试） |
| **C-U3** | 浏览器关闭 / 刷新后，**已成功的不再重传**；下次进入提示「上次有 N 张未完成」 |
| **C-U4** | 重传同名文件按 `stem` 去重**覆盖**，不产生第二条记录（BR-307） |
| **C-U5** | 上传完成给出明确反馈：成功张数 / 失败张数 / 下一步（F-25） |

---

## 五、登录票据状态机（SSM）

### 5.1 状态定义

| 状态 | 含义 | `token` 字段 |
|---|---|---|
| `PENDING` | 已生成小程序码，等待扫码 | 空串 |
| `ACTIVE` | 已绑定 openid，会话有效 | 32 位 token |
| `REVOKED` | 已登出 / 已失效 | 保留原值但不再校验通过 |

### 5.2 转换图

```
  （无） ──session.createTicket──► PENDING ──5分钟未扫──► REVOKED
                                     │
                          session.claim（小程序扫码）
                                     ▼
                                  ACTIVE ──session.logout──► REVOKED
                                     │
                                     └──tokenExpireAt 过期──► REVOKED（查询时判定）
```

### 5.3 约束

| 编号 | 约束 |
|---|---|
| **C-S1** | `ticket`（22 位，5 分钟）与 `token`（32 位，30 天）**必须是两个不同的值**。ticket 会出现在二维码里可被拍照传播，token 永不出现在二维码中 |
| **C-S2** | `claim` 成功后 `ticket` **立即作废**（防二次兑换） |
| **C-S3** | 不使用定时触发器清理。查询时按 `tokenExpireAt` 判定；`createTicket` 时顺手清理 30 天前的旧记录（限 20 条） |
| **C-S4** | 网页端**每个请求**都带 `sessionToken`（`createTicket` 除外），后端每次查 `session` 集合 |

---

## 六、邀请票据状态机（ISM）

| 状态 | 判定 | 模特扫码结果 |
|---|---|---|
| **有效未使用** | `invite` 记录存在，`model` 未建档 | 建档 + 进入项目（T-P03） |
| **已使用** | `invite` 记录存在，对应 `model` 已建档 | 直接进入项目（不重复建档，BR-402） |
| **已移除** | 记录被 `removeInvite` 删除 | 「项目不存在或已被删除」 |
| **所属项目已过期** | `expireAt < now` | `ERR_EXPIRED`，禁止选片 |
| **所属项目已归档** | `status === 'ARCHIVED'` | `ERR_ARCHIVED`，只读 |

> **一码一人**（BR-402）：同一 `invite.token` 被第二个微信扫码时**不建档**，提示「该邀请已被使用」。

---

## 七、照片记录状态机（PHM）

| 状态 | 判定 | 说明 |
|---|---|---|
| **已登记** | `photo` 记录存在，有 `previewFileID` + `thumbFileID` | 正常 |
| **已覆盖** | 同名 `stem` 重传 | 覆盖 `previewFileID`/`thumbFileID`，`usedBytes` 按**差值**调整 |
| **已删 preview** | 项目归档 | `thumbFileID` 保留，`previewFileID` 清空 |
| **已删除** | 删除照片或删除项目 | 记录与云文件全部删除 |

> `photo` 记录**没有独立状态字段**，状态由「文件是否存在 + 所属项目状态」决定。**不要新增 `photo.status`**。

---

## 八、并发与竞态规则

| 编号 | 场景 | 规则 |
|---|---|---|
| **C-1** | **两位模特同时提交** | 各自独立写 `selection`；项目状态由 `pushModelSummary` 在**每次写入后重算**（`selection/index.js:538`），以「全员已提交」为准。允许短暂不一致 |
| **C-2** | **摄影师删除项目时模特正在选片** | 模特侧下次请求返回 `ERR_NOT_FOUND`；不要求实时中断 |
| **C-3** | **重复提交** | 幂等：已 `locked` 时再次提交**返回成功**，不重复推送通知（BR-603） |
| **C-4** | **并发上传同一文件** | 按 `stem` 去重，后到的覆盖；`usedBytes` 用 `inc` 差值，避免重复累加 |
| **C-5** | **`list` 惰性归档与摄影师操作并发** | 归档检查必须在 `update` 前重新读取项目状态；已 `ARCHIVED` 的跳过 |
| **C-6** | **摄影师解锁与模特提交同时发生** | 以**后完成的写入**为准。`resetLock` 与 `submit` 都要先读当前 `locked` 值再决定行为 |
| **C-7** | **多设备同时登录同一摄影师** | 允许。`session` 按 token 独立，互不影响 |

---

## 九、状态写入点代码落点（改代码时对照）

| 转换 | 文件 : 行 | 当前实现 |
|---|---|---|
| T-P01 建 `DRAFT` | `project/index.js:99` | `status: 'DRAFT'` |
| T-P02 → `UPLOADING` | `photo/index.js:176` | `if (p.status === 'DRAFT') updateData.status = 'UPLOADING'` |
| T-P03 → `SELECTING` | `selection/index.js:493-495` | DRAFT/UPLOADING 时置 `SELECTING` |
| T-P04 → `SELECTION_SUBMITTED` | `selection/index.js:538-539` | `models.every(m => m.status === '已提交')` |
| T-P05 → `SELECTING` | `selection/index.js:424` | `resetLock` 后写死 `SELECTING` |
| T-P06 → `ARCHIVED` | `project/index.js:181` | 归档写 `ARCHIVED` |
| T-P07 → `UPLOADING` | `project/index.js:302-317` | `extend`，`restored` 时回 `UPLOADING` |
| T-M02 锁定 | `selection/index.js:336-337` | `locked:true`、`submittedAt` |
| T-M03 解锁 | `selection/index.js:414` | `locked:false`、`photoIds: keep` |

> **必须修的一处**：`selection/index.js:540` 缺少 `ARCHIVED` 守卫（见 2.5）。

---

## 十、验收清单

- [ ] 新建项目后 `status === 'DRAFT'`，列表显示「待上传」
- [ ] 传第一张后变 `UPLOADING`
- [ ] 模特首次扫码进入后变 `SELECTING`
- [ ] 全部模特提交后变 `SELECTION_SUBMITTED`
- [ ] 摄影师解锁后**回** `SELECTING`，且模特原选择**仍在**
- [ ] 过期项目显示「已过期」，模特端只读
- [ ] 过期超 7 天后 `project.list` 触发归档，preview 被删、thumb 仍在
- [ ] 归档项目续期后回 `UPLOADING` 并提示需重传 preview
- [ ] **已归档项目被模特保存时，状态不会被拉回 `SELECTING`**（2.5 漏洞回归）
- [ ] 项目中不存在 5 个存储状态之外的任何值
- [ ] 删除项目后云存储中对应文件全部消失

---

*下一份：`32_ERROR_HANDLING.md`（异常场景与错误码）*

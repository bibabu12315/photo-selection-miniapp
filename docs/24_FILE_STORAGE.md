# 24 · 文件存储与图片规格（V2.0）

> 本文件是 **V2.0 云存储路径、画质档位、生命周期与容量计量的唯一来源**。
> 相关：`21_DATABASE.md`（usedBytes）、`22_API.md`（photo.* 接口）、`docs/云成本优化-四项技术任务.md`。

---

## 一、核心原则

1. **原图永不上传**。云端只有 preview 与 thumbnail，RAW 与原始 JPG 永远在本地。
2. **文件名必须与相机 DCIM 原名一致**（`DSC01234.jpg`），因为交付物是文件名清单。
3. **一个项目一个目录**，删除与归档都按 `projectId` 前缀整批处理。

---

## 二、存储路径规则

```
p/{projectId}/preview/{stem}.jpg      预览图（选片大图用）
p/{projectId}/thumb/{stem}.jpg        缩略图（网格列表用）
p/{projectId}/qrcode-{modelId}.png    邀请二维码（每模特一张）
```

| 规则 | 说明 |
|---|---|
| `{projectId}` | `project._id`（云开发自动 ID，字符集安全） |
| `{stem}` | 文件名主干，经 `sanitize()` 处理：去路径、只留 `[A-Za-z0-9._-]`、截断 80 字符 |
| 扩展名 | 一律 `.jpg`（即使源文件是 ARW/HEIC，浏览器 canvas 输出的也是 JPEG） |
| 重传 | 同 `stem` 覆盖写同一路径，不产生新文件 |

**防路径穿越**：`photo/index.js` 的 `sanitize()` 与 `safeCloudPath()` 已实现，
**不要绕过**。任何新增的上传入口都必须过这两个函数。

---

## 三、画质档位（四档）

### 3.1 规格表

| 档位 key | 界面名称 | 长边 | quality | 单张 preview 体积 | 适用 |
|---|---|---|---|---|---|
| `standard` | 标准 | 1600 | 0.75 | ~0.25 MB | **默认**，全部项目 |
| `hd` | 高清 | 2048 | 0.82 | ~0.55 MB | 需要放大看细节 |
| `hdpro` | 高清 Pro | 2880 | 0.90 | ~1.2 MB | 谨慎使用 |
| `raw` | 原画质 | 4096 | 0.92 | ~2.2 MB | 仅小批量项目 |

**缩略图固定**：长边 320 / quality 0.70（约 0.025 MB），**不随画质档变化**。

### 3.2 默认值

**`standard`（1600 / 0.75）是默认值**，理由：iPhone 物理屏宽约 1170~1290px，
1600 长边已超出 Retina 显示需求，而体积只有 2048 档的 45%。

- 定义位置：`web/upload.js:30-35`（`PRESETS`）
- 镜像定义：`miniprogram/env.ts:15-20`（`PREVIEW_PRESET`，仅用于体积提示文案）
- **两处必须保持一致**，改一处就要改另一处

### 3.3 体积参考值（界面提示用）

`miniprogram/env.ts:25-30` 的 `PRESET_SIZE_MB` 用于给摄影师直观提示「这批 N 张 ≈ XXX MB」。
这是**估算常量**，不是实测值；如果发现实际偏差超过 30%，更新常量即可，不要改计算逻辑。

---

## 四、上传流程（V2）

```
1. 网页 P-W3：photo.issueUploadSession{ projectId, sessionToken }
      → 拿到 uploadToken（24h）

2. 选文件（支持拖入文件夹，webkitGetAsEntry 递归读取）

3. 【V2 新增】画质预览：取选中的 1 张原图
      → 浏览器本地 canvas 按四档各渲染一次
      → 左右滑块对比 + 支持 100% 放大
      → 每档标注「这批 N 张 ≈ XXX MB」
      ★纯本地计算，不上传、不消耗云资源

4. 逐张处理（CONCURRENCY = 3）：
      decode(原图) → render(preview, 档位参数) → render(thumb)
      → app.uploadFile(p/{projectId}/preview/{stem}.jpg)
      → app.uploadFile(p/{projectId}/thumb/{stem}.jpg)
      → photo.registerPhoto{...}（云端核验文件真实存在后登记）

5. 全部完成 → 显示成功/失败统计，失败项可单独重试
```

### 4.1 已知坑：CORS

`web/upload.js:342-355` 的注释已记录：本环境存储桶不给 localhost 返回 CORS 头，
浏览器读不到上传响应（204），但文件可能已实际到达服务器。
**兜底方案**：`registerPhoto` 里用 `getTempFileURL` 核验文件是否真存在，
以云端核验结果为准，忽略浏览器的跨域报错。

> **不要**试图在前端用 try/catch 判断上传成败——必须以云端核验为准。

### 4.2 并发与重试

- 并发数 `CONCURRENCY = 3`（经验值，再高会触发云存储限流）
- 单张失败不影响整体，标记 `failed` 后可点「继续上传」重试
- 重传 = 覆盖更新，**不重复计数**（`registerPhoto` 已按 stem 去重）

---

## 五、临时链接策略

因为存储权限是「仅创建者可读写」，客户端不能直接访问 fileID，必须由云函数换临时链接。

| 规则 | 值 | 位置 |
|---|---|---|
| `maxAge` | 传 **24 小时**（86400 秒），但**不保证生效** | `selection` / `photo` 的 `tempUrls()` |
| 批量 | 一次请求批量取，`getPreview` 支持 `range` 预取 ±2 共 5 张 | 同上 |
| 端上缓存 | 分桶缓存，上限 3000 条；**到期时间从链接自带的 `t` 参数算，不写死 TTL** | `miniprogram/services/urlcache.ts` |
| 缓存去重 | `getPhotos` 支持传 `have`（已缓存的 photoId），服务端跳过不生成 | `selection.getPhotos` |

> ⚠️ **实测校准（2026-10-05，推翻旧结论）**：官方文档 `Cloud.getTempFileURL` 明确「私有读文件的临时链接**十分钟有效期**」，且接口签名是 `fileList: string[]`——传 `{fileID, maxAge}` 里的 `maxAge` 不保证被采纳。抓包佐证：403 链接的 `t=` 换算出来就是到期时刻，比请求时间早十几分钟。
> 因此**端上禁止写死任何长 TTL**（20h / 90min 都放过过期链接，症状＝瀑布流缩略图部分 403），一律按链接自带的 `t` 判断新鲜度，并在图片加载失败时重取链接自愈（见 `43_DEV_STATUS.md` U-W1d）。

**V2 不变**：这套策略在 V2.2 已调优到位（调用量从 17 次/张降到约 8 次/张），**不要再动**。

---

## 六、生命周期与清理

### 6.1 三阶段

| 阶段 | preview | thumb | `status` | `usedBytes` |
|---|---|---|---|---|
| 活跃 | ✅ | ✅ | DRAFT / UPLOADING / SELECTING / SELECTION_SUBMITTED | preview + thumb 总量 |
| 已归档 | ❌ 已删 | ✅ | `ARCHIVED` | 仅 thumb 总量 |
| 已删除 | ❌ | ❌ | 记录不存在 | — |

### 6.2 归档（删 preview 留 thumb）

- 触发：摄影师手动点「归档」，或 `project.list` 时对「过期超过 7 天」的项目惰性触发
- 宽限期 `ARCHIVE_GRACE_DAYS = 7`（避免刚到期就删图）
- 实现：`archiveProject` 分页取全部 `previewFileID` → `deleteFile`（50 一批）→ 重算 `usedBytes`
- **归档后**：项目仍可见、模特进度仍可查、`getPreview` 拒绝（提示联系摄影师续期）
- **续期恢复**：`extend` 时若原状态为 `ARCHIVED` → 置 `UPLOADING` 并返回 `needReupload: true`

### 6.3 删除（全删）

`removeProject` 必须删除：全部 preview + 全部 thumb + 邀请二维码 PNG。
删除失败记日志但不阻断（宁可留孤儿文件，也不能让摄影师删不掉项目）。

### 6.4 孤儿文件

以下情况可能产生残留，V2 **不做自动清理**（成本高于收益）：

- `removeInvite` 后该模特的 `qrcode-{modelId}.png`（当前未删）
- 极端情况下上传成功但登记失败的文件

> 若将来要做清理脚本，按 `p/{projectId}/` 前缀扫描即可。**V2 不实现**。

---

## 七、容量计量（`usedBytes`）

### 7.1 双轨制

| 时机 | 方式 |
|---|---|
| 每次 `registerPhoto` | `_.inc(previewBytes + thumbBytes)`；重传时 `_.inc(差值)` |
| 归档 | 聚合全部 photo 的 `thumbBytes` 求和，**覆盖** `usedBytes` |
| 删除照片 / 删除项目 | 聚合重算或归零 |
| 生成二维码 | `_.inc(PNG 字节数)`（**V2 新增，原来漏计**） |

**为什么双轨**：纯增量会漂移（并发、失败重试都可能算错），纯聚合太慢（每次上传都要全表求和）。
增量给实时性，低频聚合给准确性。

### 7.2 V2 不做的事

`usedBytes` 目前**只作为容量参考**，不用于任何硬性拦截（免费/付费额度是后话，本轮不实现）。
**不要**在 V2 里顺手加「超出额度禁止上传」的逻辑。

---

## 八、V2 变更清单

| 项 | 变更 | 落点 |
|---|---|---|
| 二维码计入容量 | `getInviteQrCode` 上传后 `usedBytes inc` | `cloudfunctions/project/index.js` |
| 二维码 `envVersion` | `'trial'` → `'release'`（上线前必改） | 同上 |
| 画质预览 UI | 纯前端新增，无后端改动 | `web/console.js` |
| 上传会话获取 | 新增 `issueUploadSession`，取代手工输码 | `cloudfunctions/photo/index.js` |
| 路径规则 / 画质档 / 临时链接 / 生命周期 | **不变** | — |

---

## 九、回归验证清单

- [ ] 上传 5 张照片，云存储出现 5 个 preview + 5 个 thumb，路径符合 `p/{projectId}/...`
- [ ] 同一张照片重传，`photoCount` 不增加，`usedBytes` 按差值变化
- [ ] 归档后 preview 文件消失，thumb 仍在，`getPreview` 返回「项目已归档」
- [ ] 续期后状态回 `UPLOADING`，提示需重新上传
- [ ] 删除项目后，云存储对应目录被清空
- [ ] 选片页图片能正常加载，滑动到未预取的图也能加载（走缓存或新链接）
- [ ] 模特端连续浏览 50 张，无链接失效（maxAge 24h 生效）

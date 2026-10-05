# 41 · 编码规范（三端统一约束）

> **定位**：`40` 规定「怎么做事」，本文档规定「代码长什么样」。
>
> 原则：**与现有代码保持一致优先于「更好的写法」**。现有代码不漂亮但能跑，就不要为了漂亮去改它（AI-3）。

---

## 一、通用规范（三端适用）

### 1.1 语言与注释

- **注释用中文**，且只写「为什么」，不写「做了什么」
  ```js
  // ✅ 好：说明原因
  // 归档后 preview 已删除，必须拒绝，否则模特会看到裂图
  if (p.status === 'ARCHIVED') return { ok: false, error: '项目已归档', code: 'ERR_ARCHIVED' }

  // ❌ 差：复述代码
  // 判断状态是否为 ARCHIVED
  if (p.status === 'ARCHIVED') ...
  ```
- **禁止注释掉的代码块**。要删就删干净，git 有历史
- **禁止 `console.log` 调试残留**提交进代码（云函数可以用 `console.warn` 记异常，但不要打印敏感信息如 openid 全量）

### 1.2 命名

| 类型 | 规范 | 示例 |
|---|---|---|
| 云函数 action | 小驼峰 | `getProjectResults` |
| 数据库集合 | 小写单数 | `project` / `photo` / `selection` / `model` / `invite` / `session` |
| 数据库字段 | 小驼峰 | `ownerOpenid` / `expireAt` / `usedBytes` |
| 小程序 service 函数 | 小驼峰 | `listProjects()` |
| 网页端函数 | 小驼峰 | `startUpload()` |
| 常量 | 全大写下划线 | `MAX_MODELS` / `CONCURRENCY` |

### 1.3 时间

- 一律 **毫秒时间戳**（`Date.now()`），字段名以 `At` 结尾：`createdAt` / `expireAt` / `submittedAt`
- 禁止存日期字符串，禁止在后端格式化

### 1.4 常量

- **所有业务常量以 `30_BUSINESS_RULES.md` 第一章为唯一来源**，禁止在代码里另写一份（AI-11）
- 需要新增常量时：先上报，确认后**同时**补进 `30` 的常量表，再写代码

---

## 二、云函数（cloudfunctions/）

### 2.1 文件结构（每个云函数固定四段）

```js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// ── 常量 ──────────────────────────────
const MAX_MODELS = 5

// ── 身份解析（每个云函数各写一份副本，禁止抽公共包）──
function resolveCaller(event) {
  const wxCtx = cloud.getWXContext()
  if (wxCtx && wxCtx.OPENID) return { openid: wxCtx.OPENID, source: 'mp' }
  if (event.sessionToken) return { token: event.sessionToken, source: 'web' }
  return null
}

// ── 各 action 实现 ─────────────────────
async function xxx(event, caller) { ... }

// ── 入口分发 ───────────────────────────
exports.main = async (event = {}) => {
  try {
    switch (event.action) {
      case 'xxx': return await xxx(event)
      default: return { ok: false, error: '未知 action: ' + (event.action || ''), code: 'ERR_PARAM' }
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: 'ERR_UNKNOWN' }
  }
}
```

### 2.2 身份解析层 `resolveCaller`（**V2 最重要的新增约定**）

- **在每个需要身份的云函数文件里各写一份 5 行副本**，不抽公共包（云函数间 require 需要打包步骤，不值得引入构建）
- **小程序路径优先级高于网页路径**：先取 `OPENID`，取不到再查 `sessionToken`（BR-105，防网页伪造提权）
- `resolveCaller` 只返回「你是谁」，**不返回「你能访问什么」**
- 每个 action 必须再做第二重授权校验（BR-106）：`ownedProject` / `isAdmin` / `guardModel`
- 网页端带 token 时，`resolveCaller` 需查 `session` 集合换 openid；token 无效或过期一律返回 `ERR_NO_AUTH`

**禁止**：在任何业务 action 里直接写 `cloud.getWXContext().OPENID`（除 `resolveCaller` 内部和 `admin` 云函数）。

### 2.3 返回格式

```js
{ ok: true,  data: { ... }, code: 'OK' }
{ ok: false, error: '面向用户的中文文案', code: 'ERR_XXX' }
```

- `ok` 是唯一判定依据，存量前端只看 `ok` / `error`，**不要改变**
- `code` 新增接口必须返回，存量接口逐步补
- `error` 直接展示给用户，**禁止返回技术堆栈、SQL、fileID、openid**
- 权限校验失败统一返回 `ERR_NOT_FOUND`（`32_ERROR_HANDLING.md`，避免资源枚举探测）

### 2.4 数据库操作

- 用 `db.collection(name).doc(id).get()` 时**必须处理不存在的情况**（返回 null 而非抛异常）
- 批量删除用 `_.in([...])`，**不要循环单条删**
- 分页用 `.skip().limit()`，`limit` 值取常量表（`PHOTO_PAGE_SIZE = 18`）
- **禁止 `db.collection().get()` 不带 limit**（全表扫描会爆配额）

### 2.5 云存储操作

- 删除文件用 `cloud.deleteFile({ fileList: [...] })`，**一次最多 50 个**，多的分批
- 删除失败要记日志但**不阻断主流程**（`24_FILE_STORAGE.md`）
- 文件路径规则见 `24_FILE_STORAGE.md` 第二章，**禁止自定义新路径规则**

---

## 三、小程序端（miniprogram/）

### 3.1 分层（现有架构，不得绕过）

```
页面 (pages/*)  →  service (services/*.ts)  →  云函数
```

- **页面禁止直接调 `wx.cloud.callFunction`**，必须走 `services/request.ts` 的 `call()` / `callSafe()`
- 新增接口时，在对应 service 文件加函数，**不要在页面里内联**
- `request.ts` 里**不弹 Toast**（`32_ERROR_HANDLING.md`），Toast 只在页面层弹

### 3.2 TypeScript

- 公共类型放 `miniprogram/types/index.ts`，不要在各页面重复定义
- 接口返回类型用泛型：`call<Project[]>(...)`
- `wx.` / `Page()` 全局未定义的 TS 报错属正常，不要为此改 `tsconfig.json` 乱加配置
- **禁止任何会被降级编译成 `@babel/runtime/helpers/*` 的语法**：IDE 降级编译（babel）会把它们转成 helper 的 require，本项目**没有 node_modules**，运行时报
  `module '@babel/runtime/helpers/xxx.js' is not defined` → **整个页面 JS 加载失败 → 白屏**（连「加载中」都不渲染，现象极具迷惑性）
  - 对象 / 数组展开运算符（`{ ...obj }`、`[...a, ...b]`）→ `Object.assign({}, obj, { k: v })` / `a.concat(b)`（helper：`arrayWithoutHoles`）
  - **对象计算属性（`{ [key]: value }`，含 `{ [\`a[${i}]\`]: v }`）** → 先建空对象再下标赋值：
    `const p: any = {}; p['photos[' + i + '].failed'] = true; this.setData(p)`（helper：`toPropertyKey`）
    - 注意区分：`obj[key] = value`（下标赋值）是原生语法，**安全**，只有写在对象字面量里的 `[key]:` 才会引 helper
  - 可选链 `?.` / 空值合并 `??` / 对象 rest 解构 `const { a, ...rest } = o` 同样禁用
  - 标准库 API（`Object.assign` / `Array.prototype.map` / `filter` / `find` / `for...of`）不受影响，现有代码大量在用，安全
- 排查口诀：**小程序白屏先看 Console 顶部那条 `errorReport`（`module '@babel/runtime/helpers/...' is not defined`），再看 UI**；报哪个 helper 就全局搜对应语法

### 3.2.1 端上临时链接缓存

- **`cachedIds()`（告诉服务端「我已有缓存」）必须与 `getCached()`（实际能不能取出来）用同一个有效性判定**，否则会出现「服务端跳过签发 + 端上又取不到」→ 链接为空 → `<image>` 不触发任何事件 → 黑格子且无提示（U-W1f）
- 缓存写入时拿不到可信到期时刻（链接 `t` 缺失/已过期）→ 不要把自己标成「已有缓存」；宁可让服务端重新签一条
- 凡是 `<image>` 依赖 `bindload` 切换 `opacity` 做淡入的，**必须有超时兜底**（`bindload` 在部分机型/缓存命中时不回调，结果是「图其实在，格子是黑的」）

### 3.3 setData 规范

- **禁止在循环里 setData**，拼好对象一次性提交
- 只 setData 变化的字段，用路径写法：`this.setData({ 'list[0].selected': true })`
- 分页追加用 `this.setData({ ['list[' + n + ']']: item })`，不要整表重设

### 3.4 交互反馈（对齐 `11_INTERACTION_SPEC.md`）

- Toast 只在页面层弹；**自动保存成功必须静默**，失败才提示
- 确认弹窗**只允许 5 处**：提交选片 / 解锁重选 / 删除项目 / 归档项目 / 退出登录
- Loading 用 `wx.showLoading({ mask: true })`，**必须在 finally 里 hideLoading**

### 3.5 大图手势

- 手势逻辑锁死在 `gest.wxs`（渲染层），**禁止迁到逻辑层**（会卡）
- V2 只允许加：淡入、加载失败占位图

---

## 四、网页端（web/）

### 4.1 零框架约束

- **不引入任何框架/构建工具**：原生 HTML + CSS + JS，hash 路由
- 现有三个文件（`index.html` / `upload.js` / `style.css`）继续扩展，**不重写**
- 新增页面脚本按功能拆文件（如 `console.js` / `login.js`），用 `<script src>` 引入

### 4.2 传输层（不可动）

- `ensureApp()` / `callFn()` / `uploadBlob()` 三个函数**禁止重构**（C-1 裁决）
- 继续用微信 Web SDK（`cloud.js`），不再引入其他 HTTP 方案
- 鉴权层叠加 `sessionToken`：调用时把 token 塞进 payload

### 4.3 会话存储

- `sessionToken` 存 **localStorage**，**不存 cookie、不放 URL**（BR-104）
- 读取不到 token 或 `verify` 返回 `ERR_NO_AUTH` → 跳回登录页（P-W1）

### 4.4 画质预览

- 四档对比在**浏览器本地用 canvas 生成**，纯本地计算，**不上传、不消耗云资源**
- 必须支持 100% 放大（`11_INTERACTION_SPEC.md`）
- 每档标注「这批 N 张 ≈ XXX MB」，体积按 `30` 第一章参考体积算

### 4.5 导出

- CSV **必须带 BOM**（`\uFEFF`），否则 Excel 中文乱码
- 排序**按文件名升序**
- 复制失败降级为「自动选中文本 + 提示手动复制」，不要报错

---

## 五、CSS / WXSS

- 沿用现有 CSS 变量，**不要新增一套配色**
- 网页主色蓝 `#185FA5`，小程序主色绿（微信原生观感），**两端不强求统一**
- 禁用态**必须视觉可见**（灰度 + `cursor: not-allowed`），不能只是静默不可点
- 小程序用 rpx，网页用 px

---

## 六、Git 与提交

- **禁止自动 `git commit` / `git push`**，提交由用户决定
- 提交信息格式：`类型: 简述`
  - `feat: 新增 session 云函数六个 action`
  - `fix: 修 ARCHIVED 被保存动作拉回 SELECTING`
  - `docs: 补充 42 任务 T-P2-3 完成标准`
  - `refactor:` **谨慎使用**——不在任务范围内的重构禁止提交

---

## 七、禁止清单（速查）

| 禁止 | 位置 |
|---|---|
| 引入 npm 依赖 / 框架 / 构建工具 | 全部 |
| 页面直连云函数（绕过 service） | 小程序 |
| 在 `request.ts` 里弹 Toast | 小程序 |
| 业务 action 里直接取 `OPENID` | 云函数 |
| 抽公共包给云函数共用 | 云函数 |
| 重写 `ensureApp` / `callFn` / `uploadBlob` | 网页 |
| 把大图手势迁出 `gest.wxs` | 小程序 |
| 新增第 6 个项目状态值 | 全部 |
| 新增文档未定义的字段 | 数据库 |
| 注释掉的代码块 / 调试 console.log | 全部 |
| 自动 git commit / push | 全部 |
| **对象 / 数组展开运算符 `...`（白屏，用 `Object.assign` / `concat`）** | 小程序 |
| **对象计算属性 `{ [key]: v }`（白屏，改成空对象 + 下标赋值）** | 小程序 |

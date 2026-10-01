# 摄影线上选片小程序

摄影师把一次拍摄的照片传到线上，模特扫码浏览并选出喜欢的，摄影师只精修被选中的那几张。

当前进度：**Phase 0 · 工程初始化**

技术栈：微信原生小程序 + TypeScript + CloudBase（云函数 / 云数据库 / 云存储）+ 电脑端浏览器上传页。

---

## 一、你需要填的 3 个值

| 值 | 位置 | 说明 |
|---|---|---|
| 小程序 AppID | `project.config.json` → `appid` | 现在是 `touristappid` 占位，换成你自己的 |
| 云环境 ID | `miniprogram/env.ts` → `ENV_ID` | 形如 `photo-select-1a2b3c4d5e` |
| 云环境 ID（上传页） | `web/index.html` 页面上的输入框 | 首次填一次，会记住；也可以用同一个值 |

---

## 二、CloudBase 控制台需要先做的事

1. **开通云开发**，拿到环境 ID。
2. **数据库建 3 个集合**：`selftest`（Phase 0 自检）、`admin`（管理员）、`project`（Phase 1 用）。
3. **数据库权限**改成「仅管理端可读写」——默认权限会让 token 形同虚设，见 `docs/安全与访问控制.md` 锁 1。
4. **云存储权限**改成「仅创建者可读写」。
5. **登录授权**里打开「匿名登录」。
6. **安全配置 → 安全域名**里加上上传页的域名（静态托管域名，或本地调试用的 `localhost:8080`）。不加会 CORS 报错。
7. 开通**静态网站托管**，把 `web/` 目录部署上去。

---

## 三、运行步骤

### 小程序端

1. 微信开发者工具 → 导入项目，选择本目录。
2. 右键 `cloudfunctions/ping` →「上传并部署：云端安装依赖」。
3. 编译。首页是 Phase 0 自检页，点「运行自检」。

### 电脑端上传页

本地调试（推荐先本地跑通再部署）：

```bash
cd web
python -m http.server 8080
# 浏览器打开 http://localhost:8080
# 记得把 localhost:8080 加到 CloudBase 安全域名
```

也可以用 Node：

```bash
npx serve web -l 8080
```

> 不要双击 `index.html` 用 `file://` 打开，CloudBase SDK 会因来源不合法被拒。

---

## 四、Phase 0 验收标准

全部通过才算 Phase 0 完成：

- [ ] 小程序能启动，首页显示环境 ID
- [ ] 点「运行自检」返回 openid，且数据库写入 + 读回成功
- [ ] 浏览器上传页能匿名登录成功
- [ ] 能上传一张图并拿到 `fileID`
- [ ] 点「取临时链接」能拿到临时 URL —— 这一步验证「存储私有 + 云函数 admin 权限下发」生效
- [ ] 把临时 URL 直接贴到无登录态的浏览器里，1 小时后失效（可选验证）

---

## 五、目录说明

```
miniprogram/            小程序端（摄影师端 + 模特端）
├── env.ts              环境配置，唯一需手改 ENV_ID 的地方
├── app.ts              初始化云开发、静默取 openid
├── types/              数据模型定义
├── services/request.ts 云函数统一入口：页面 → service → 云函数 → 数据库
├── utils/auth.ts       身份工具（openid 白名单）
└── pages/home/         Phase 0 自检页，Phase 1 换成项目列表

cloudfunctions/ping/    自检云函数：whoami / selftest / tempurl

web/                    电脑端上传页（唯一上传入口）
├── index.html
├── upload.js           Phase 0：登录 + 上传一张图
└── style.css

docs/                   方案与决策文档
```

---

## 六、文档索引

| 文档 | 内容 |
|---|---|
| `docs/技术方案V1.2-最小闭环.md` | **以此为准**：V1.0 最终范围、数据模型、状态机、Phase 划分 |
| `docs/安全与访问控制.md` | 四道锁、一码一人、能防住与防不住的边界 |
| `docs/技术方案修订-V1.1.md` | 决策历史与平台硬限制核实（已被 V1.2 部分取代） |

---

## 七、开发原则

1. 一次只做一个 Phase，做完自测再进下一个。
2. 页面不直接操作数据库，一律走 `services/` → 云函数。
3. 参数里的 `projectId` 永远不能信，只能用 token 推导出来的那个。
4. 先跑通闭环，再优化体验。

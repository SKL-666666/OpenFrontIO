# 交接文档 — OpenFront 本地化 fork

> 面向接手本仓库的人（或未来的 AI agent）。上游是 [OpenFront.io](https://github.com/openfrontio/OpenFrontIO)（AGPL-3.0），本 fork 的目标：**完全本地运行，不依赖任何游戏服务器 / API / 第三方域名**。
>
> 分支 `local-offline` → `https://github.com/SKL-666666/OpenFrontIO.git`

---

## 1. 快速开始

```bash
npm run inst              # 装依赖（用 npm ci --ignore-scripts，不要 npm install）
start-local.cmd           # 构建产物 :9000 + 自动开浏览器（推荐入口）
start-local.cmd --dev     # 改为 vite dev server（首屏 ~15s，热更新）
start-local.cmd --build   # 强制重建 static/
start-local.cmd --host    # 局域网可访问；--lan 同时启动 LAN 中继
```

局域网双开：一台跑 `start-lan-host.cmd`（JSON 帧中继，无游戏逻辑），各机器在游戏内用房间码互连。

单人：首页 **单人游戏** → 世界地图 → **开始游戏** → 点地图选出生点。

---

## 2. 提交历史（本 fork 的全部工作）

| commit | 内容 |
|---|---|
| `5cf4159f` | 离线构建、本地模式开关、LAN 房间（BroadcastChannel + relay）、中文 UI |
| `5e9321a5` | 单人预设、局内暂停/倍速记忆、结算回放（15s 步进）、统计图表、观战入口 |
| `3b1c920e` | 修三个运行时 bug（见 §4），加 `scripts/browser-smoke.mjs` 真机冒烟 |

改动范围：`src/client` 27 文件、`tests` 14、`index.html`/`vite.config.ts`/`resources/lang/en.json`、`packages/shared/src/configuration/Env.ts`、`scripts/*`。**`src/server/` 零改动**（那是线上部署用的）。

---

## 3. 本地模式原理（关键认知）

浏览器里跑的"后端"，不是 Node 服务器：

| 模式 | 实现 |
|---|---|
| 单人 | `src/client/LocalServer.ts` — 页面内实例，worker 里跑完整模拟 |
| 局域网 | `src/client/local/PeerRelayServer.ts` + `scripts/lan-host.mjs`（主机 tab 拨时钟，每个浏览器各自模拟） |
| 同浏览器 | BroadcastChannel，无需进程 |

- 开关链：`index.html` 的 `BOOTSTRAP_CONFIG.local` → `ClientEnv.isLocalMode()` → `isLocalMode()` 短路所有出网路径（auth、cosmetics、server list、Turnstile、结算上传…）。
- `index.html` 是 **EJS 模板**，只有 `src/server/RenderHtml.ts` 渲染它；本地构建靠 `vite.config.ts` 的 `transformIndexHtml` 注入（`local: true`）。**`npm run build-prod` 不渲染 EJS**，会把 `static/index.html` 写成模板 —— `start-local.cmd` 用 `scripts/check-local-build.mjs` 拦截并自动改用 `build:offline`。
- 引擎在**浏览器 worker** 里跑，服务端只负责线上对局（本 fork 不用）。

---

## 4. 已修的坑（别回归）

1. **裸 EJS 页面** — `build-prod` 与 `build:offline` 共用 `static/`，前者不渲染模板。→ `check-local-build.mjs` 检测 `<%`，`lan-host.mjs` 启动时告警。
2. **界面全是翻译 key** — `<lang-selector>` 是 `<page-footer>` 的子元素，而 `page-footer` 被 `index.html` 的 local 守卫剔除 → `translateText()` 找不到元素只能回显 key。→ local 分支单独渲染 `<lang-selector>`，`tests/LangSelectorPresence.test.ts` 锁两边分支。
3. **图片 404** — asset manifest 和 hashed `/_assets/` 只在 `isProduction` 生成，而 `build:offline` 是 `mode=development` → `assetUrl()` 回落到从未写出的原路径。→ `vite.config.ts` 改按 `command === "build"`。
4. **卡在「游戏正在启动...」** — Vite 把 worker 内联成 `blob:` URL，blob 是不可作 base 的 opaque path，worker 内 `fetch("/_assets/maps/world/manifest.json")` 抛 `Failed to parse URL`，引擎首 tick 前就死了。有 cdnBase 时（生产）URL 是绝对的所以看不出来。→ `absolutizeAssetUrl()`（`packages/engine-lib/src/AssetPaths.ts`）补上 blob 继承的 origin，core worker 的 map resolver 和 `shared` 的 `assetUrl()`（replay worker）都用它；主线程 document 分支不动。

---

## 5. 测试与验证

```bash
npm test                 # 全量
npm run typecheck        # root + 每个 package
npm run lint             # Oxlint + ESLint
npx prettier --check <files>
npx vitest tests/YourTest.test.ts --run
```

**基线（勿当新失败）**：`npm test` 稳定 **7 failed files** —— 6 个 `bash/sh ENOENT`（`DeployIdentity`、`GenerateNginxUpstream`、`UpdateFlagLatest`、`UpdateRegister`、`UpdateRestartPolicy`、`UpdateTraefikHostRule`）+ `tests/server/RenderHtml.test.ts` 的 locals 用例（已用 `git stash` 对照确认是上游既有问题）。其余 568 files / 7347+ tests 全过。

**真机验证（本机没有 Playwright，`npm ci --ignore-scripts` 不会装浏览器）**：

```bash
node scripts/lan-host.mjs --port 9415     # shell A：起静态服务
node scripts/browser-smoke.mjs --click     # shell B：headless Chrome 走 CDP
```

它会打印页面的全部 console / 未捕获异常 / 失败请求，模拟点击「开始游戏」，轮询加载遮罩状态，并把截图存到 `.browser-smoke.png`。`SMOKE_PORT` / `SMOKE_CHROME` 可改端口和浏览器路径。改任何 `src/client` 后用它跑一遍再交付。

**引擎改动必须带测试**（CLAUDE.md 硬要求）；纯逻辑的修复放进 `engine-lib`（如 `absolutizeAssetUrl` → `tests/AssetUrls.test.ts`）。

---

## 6. 环境坑（本机 Windows / PowerShell）

- **push / fetch 要代理**：`$env:HTTP_PROXY/HTTPS_PROXY = "http://<user>:<pass>@<host>:<port>"`（凭据不入库，问负责人）。偶发 `Proxy CONNECT aborted`，重试即可。
- **grep 工具会返回过期索引**（曾返回磁盘上已不存在的文件）→ 一律用 `Select-String`、`Get-Content` 或 Node 实时读文件。
- **PowerShell 读 UTF-8 中文会乱码** → 用 Node 解析；`Set-Content -Encoding UTF8` 会写 **BOM**，改文件用 Node 写。
- `resources/lang/en.json` 每层按 **UTF-16 码元**排序（`tests/EnJsonSorted.test.ts`）；只改 `en.json`，其他语言由 Crowdin 管。
- UI 文案一律 `translateText()` + `en.json` 条目。

---

## 7. 未完成 / 已知噪音

**未做（roadmap）**

- 回放历史列表：回放记录已有，但 **IndexedDB 存储层**未建，列表 UI 待做。
- 统计图表的多人对比线（现在只画单一序列 + 峰值）。
- LAN 延迟显示、房间码自动发现（mDNS）。
- 断线重连 / 中途加入 / 踢人 —— 需要后端与引擎支持，本地 relay 目前给不了。
- 真机多场景冒烟（现有 `browser-smoke` 只覆盖单人启动到出生点选择）。

**已知噪音（不阻塞，可选优化）**

- console 里 `localhost:8787/cluster.json`、`/auth/refresh` 连接拒绝 —— 本地模式有 fallback（"Server list API unreachable"），但可以按 `isLocalMode()` 直接跳过，让 console 干净。
- `SpawnExecution: cannot spawn China` 警告 —— 400 bot 随机出生时的正常重试，暂未深究。
- 版本号显示 `vx.xx.xx` 是**设计行为**：`src/client/GameVersion.ts` 说明占位符只有 tagged deploy 才覆盖，本地 = `DEV`。

---

## 8. 关键文件索引

| 文件 | 用途 |
|---|---|
| `index.html` | EJS 模板；local 守卫块在 L277-286 / L389-393 / L403-405 / L493-499；`BOOTSTRAP_CONFIG` 内联脚本约 L170-178 |
| `vite.config.ts` | `isProduction = mode==="production"`、`isBuild = command==="build"`；test 超时也在里面 |
| `scripts/check-local-build.mjs` | 拦截未渲染的模板 |
| `scripts/lan-host.mjs` | LAN 中继（纯 JSON 帧，无游戏逻辑） |
| `scripts/browser-smoke.mjs` | CDP 真机冒烟 |
| `src/client/LocalServer.ts` | 单人"服务器" |
| `src/client/SinglePlayerModal.ts` | 单人启动流程（`startGame()` → `join-lobby`） |
| `src/client/Main.ts` | `handleJoinLobby()`、`getTurnstileToken()`（本地跳过） |
| `src/client/Utils.ts` | `translateText()` / `getCachedLangSelector()` |
| `packages/engine-lib/src/AssetPaths.ts` | `buildAssetUrl` + `absolutizeAssetUrl` |
| `packages/engine/src/worker/Worker.worker.ts` | 核心 worker，map path resolver |
| `packages/shared/src/AssetUrls.ts` | `assetUrl()` / `getCdnBase()` / `getAssetManifest()` |
| `tests/LayerBoundaries.test.ts` | 包依赖边界执法（engine 不可碰 DOM/Node/`Math.random`） |
| `tests/util/Setup.ts` | 测试用全量对局 |

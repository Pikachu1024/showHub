# showHub 迁移 GitHub Pages 纯静态 —— 设计

日期：2026-09-29
分支：`github-pages`（自 `main` 切出）
状态：待评审

## 1. 背景与目标

现状是 Qoder Sites 托管：`web/` 静态页 + Deno serverless 入口（`functions/index.ts` → `functions/adapter.mjs` → `functions/handler.mjs`）+ Supabase/Postgres 存储演出数据，抓取由 `functions/sync/*` 的四个适配器完成，客户端可点「立即同步」触发（服务端按 `sync_log` 做 6 小时限流）。

目标：改为 **GitHub Pages 纯静态托管 + GitHub Actions 每 6 小时定时抓取**。

约束（用户已裁定）：

| 决策点 | 结论 |
|---|---|
| 迁移方向 | 纯静态：Actions 抓 → 生成 JSON → Pages 发布 |
| 同步 UI | 面板改只读概览；「查看抓取任务」链到 Actions 手动触发 |
| 旧后端 | 复用 `sync` 适配器，删除 serverless/DB 入口 |
| 仓库可见性 | public（免费计划开 Pages 必需） |
| 站点资源 ID 泄露 | 发布历史用 orphan 提交，不含 `.qoder.site` |
| 调度时刻 | `0 */6 * * *`（UTC 整点，北京 08/14/20/02） |

## 2. 架构与数据流

Pages 发布源设为 **GitHub Actions**（`actions/configure-pages` → `actions/upload-pages-artifact` → `actions/deploy-pages`）。生成的数据 JSON **不进 git 历史**：每天 4 次运行会在一年内留下近 1500 个膨胀提交，而回读线上 JSON 同样能达到目的。

`tools/publish-data.mjs` 一次运行的五步：

1. **回读 seed**：`GET ${BASE_URL}/data/shows.json`。404、网络异常、首跑 → 视为空表，并记录降级原因。
2. **注入内存库**：`fakeSupabase()._tables.set('shows', rows)`。必须在任何 `from()` 调用之前完成——`dev/fake-supabase.mjs:25` 的 builder 在创建时对行做引用快照，后建的 builder 看不到之前写入的行。
3. **抓取入库**：`await runSync({ supabase })`。四个适配器、单源 try/catch 隔离、7 天过期清理、`end_time IS NULL` 且 30 天未更新的兜底清理（`sync/sync.mjs:99-114`）全部原样生效，`sync` 模块零改动。
4. **导出 JSON**：写 `data/shows.json`（按 `start_at → min_price → name` 排好序的全量投影）与 `data/meta.json`（本次各源结果 + `lastSuccessAt`）。
5. **组装产物**：`dist/ = web/* + data/*.json`，交给 upload-pages-artifact。

**发布数据必须含 `updated_at`。** 原 `handler.mjs:25` 的投影不含该列，但兜底清理以 `updated_at` 判静止（`sync/sync.mjs:110`）；不回传，下次运行的 seed 就缺依据，那批脏行永远清不掉。前端忽略多余字段。

**降级语义**：seed 回读失败不阻断，退化为「本次抓取结果即全量」。upsert 以 `source + source_id` 定位（`sync/sync.mjs:93`），重抓幂等，不会写出重复行。

## 3. 目录结构

```
web/                     静态页（index.html/style.css/app.js/price-key.js）
sync/                    抓取适配器 + runSync（原 functions/sync/，纯 Node 可跑，无 secrets）
tools/publish-data.mjs   新增：seed → runSync → 导出 JSON → 组装 dist
dev/                     fake-supabase.mjs、preview-server.mjs、fixtures、tests
.github/workflows/publish.yml
docs/superpowers/        spec 与 plan
```

删除：`functions/index.ts`、`functions/adapter.mjs`、`functions/handler.mjs`。
停止跟踪：`.西安演出集.qoder.site`（本地保留，`*.qoder.site` 进 `.gitignore`）。

`functions/` 这个名字会误导（迁移后没有任何 serverless 函数），故 `functions/sync/` → `sync/`，同步更新 6 个测试文件与 `dev/preview-server.mjs` 的 import 路径。

`tools/publish-data.mjs` 的 CLI 契约（只有这三个参数，其余走环境变量）：

| 参数 | 默认 | 作用 |
|---|---|---|
| `--out <dir>` | `dist` | 产物目录，写入 `<dir>/data/shows.json`、`<dir>/data/meta.json`、`<dir>/{index.html,app.js,…}` |
| `--base-url <url>` | 取 `BASE_URL`，再回退 `GITHUB_REPOSITORY_OWNER`/`GITHUB_REPOSITORY` 推导 | seed 回读地址 |
| `--skip-scrape` | 关 | 只回读并透传，不抓取；回读失败则降级为完整抓取 |

## 4. 触发与调度

单个 `publish.yml`，三触发、一条代码路径：

| 触发 | `scrape` | 行为 |
|---|---|---|
| `schedule: cron: '0 */6 * * *'` | true | 完整流程 |
| `workflow_dispatch`（输入 `scrape`，默认 true） | 用户选 | 同上；选 false 则只重新发布现有数据 |
| `push` → `main`（paths: `web/**`、`sync/**`、`tools/**`、`dev/**`、`publish.yml`） | false | 跳过抓取，回读线上 JSON 随新静态资源发布 |

`scrape=false` 且回读失败（如首次部署前 Pages 还不存在）→ 自动降级为完整抓取，避免发布空站。

其余工作流设定：

- `concurrency: publish-pages`，`cancel-in-progress: false` —— 定时与手动撞车时排队，不互相覆盖产物。
- `permissions: contents: read, pages: write, id-token: write`；`environment: github-pages`。
- `actions/setup-node@v4` node 22（内置 `fetch`、`AbortSignal.timeout`、`crypto.randomUUID`，现有 `timeoutFetch` 与 id 生成可直接用）。**仓库无 `package.json`、零运行时依赖，Actions 里不装任何包。**
- 抓取阶段失败不让 workflow 变红（`runSync` 已内聚每源错误），只有产物组装/部署失败才 fail。
- `BASE_URL` 取 `steps.pages.outputs.base-url`，为空则回退 `https://${GITHUB_REPOSITORY_OWNER}.github.io/<repo>`。

配额：约 1–2 分钟 × 4 次/天 ≈ 250 分钟/月，远低于免费计划 2000 分钟/月。

## 5. 数据契约

`data/shows.json`

```json
{ "generated_at": "2026-09-29T10:00:00Z",
  "shows": [ { "source":"dahepiao","source_id":"2018091946076","name":"…","poster_url":"…",
               "start_time":"2026-11-01 周日 19:30","start_at":"…","end_time":"…",
               "price":"￥150起","min_price":150,"city":"西安","venue":"…","category":"…",
               "status":"售票中","buy_url":"…","updated_at":"…" } ] }
```

`data/meta.json`

```json
{ "generated_at": "…", "lastSuccessAt": "…",
  "workflowUrl": "https://github.com/<owner>/<repo>/actions/workflows/publish.yml",
  "sources": [ { "source":"dahepiao","status":"success","finished_at":"…",
                 "fetched":42,"inserted":3,"updated":39,"deleted":0,"error":"" } ],
  "cleanup_deleted": 5 }
```

`sources` 数组长度恒为本次运行涉及的来源数；`status` 取 `success|error`；`error` 已在 `runSync` 内截到 300 字符。

## 6. 前端改动

`web/app.js` —— 渲染、筛选、搜索、排序逻辑一行不动（`priceKeyOf/sortShows` 已在 `web/price-key.js` 里，与宿主解耦）：

- `loadShows()`：10 页游标循环 → 单次 `fetch('data/shows.json')`。
- 删除 `syncRequest()`、`syncInFlight`、`autoSyncFired`、`renderSyncRateLimited()`、`runSync()` 与启动时的自动触发块——没有服务端限流可谈。
- `buildSyncPanel()` → 读 `data/meta.json` 渲染只读概览（每源一行：状态符号 + 抓取/新增/更新数 + 完成时刻）。
- `#syncBtn` 由 `<button>` 改为 `<a>`，文案「查看抓取任务」，指向 Actions 工作流页。该 URL 构建期才已知（owner/repo 由运行环境决定），故由 workflow 以 `github.server_url`/`github.repository` 组成环境变量传给脚本，写进 `meta.json` 的 `workflowUrl` 字段，前端读它；`workflowUrl` 缺失时前端不渲染该链接。
- `renderFooter()` 逻辑不变，数据源换成 `meta.json` 的 `lastSuccessAt`。
- 海报 `img` 加 `referrerpolicy="no-referrer"`（`index.html` 同时加 `<meta name="referrer" content="no-referrer">`），保留现有 `onerror` 移除 `<img>` 的降级。

`web/index.html`、`web/app.js` 的**所有资源路径改为相对路径**（`style.css`、`price-key.js`、`app.js`、`data/*.json`）。project Pages 站点在 `user.github.io/<repo>/` 子路径下，现有的绝对路径 `/style.css` 会 404。

`dev/preview-server.mjs`：删除 `/functions/v1/app` 代理段，退化为纯静态服务 `web/`；预览数据靠先本地跑一次 `node tools/publish-data.mjs --out web-preview`。

## 7. 测试策略

现有 57 个测试为基线。改动后：

- 不动：4 个适配器测试、`normalize`、`ordering`、`price-key` 的纯函数部分（仅改 import 路径）。
- 新增 `dev/tests/publish-data.test.mjs`：mock transport + 预置 seed，断言 ①导出字段集合与排序 ②`updated_at` 存在 ③seed 中过期行被清理 ④seed 回读 404 时不抛错、输出仅本次抓取 ⑤`scrape=false` 分支原样透传回读数据。
- 改 `dev/tests/price-key.test.mjs:102`：原经 `handler` 的 list 端点断言，改为经 `publish-data` 的导出函数断言（`min_price` 为 NULL 的旧行仍被正确筛选与排序）。
- 改 `dev/tests/page-boot.test.mjs`：断言静态启动路径（`data/shows.json` + `data/meta.json` 加载后网格非空）、`syncBtn` 为链接、无 `/functions/v1/app` 残留引用。
- 加 `sync.test.mjs` 一例：同一 seed 跑两次输出幂等。
- 验证手段：`node --test dev/tests/*.test.mjs` 全绿 + 本地真实跑一次 `publish-data.mjs`。

## 8. 风险与未验证项

1. **GitHub Runner 在美国**，抓 `dahepiao.com` / `maitix.com` / `snpac.com` 可能被 CDN 地域策略限流或超时。**这是本设计最大的未验证风险**，只有首次真实跑 Actions 才能证实。本机（国内网络）实测：四源全成功、共 102 条原始记录、过滤非西安后 83 条落库、耗时 4.8 秒 —— 说明接口本身可用，风险仅剩 Runner 侧地域可达性。失败表现为 `meta.json` 中该源 `status: "error"`，页面显示 ✗，不影响其它源发布。缓解顺序：先在 Actions 实测；若确被地域拦截，改用自托管 Runner（国内机器）或降低频率。
2. **GitHub 调度不保证准时**，官方文档明确高峰可延迟数分钟到数小时。所以「6 小时同步」语义上是数据陈旧度的上限，不是保证。
3. **海报防盗链：实测不成立**。对三个图片来源（`ticketimg.snpac.com`、`img.alicdn.com`、`img.dahepiao.com`）分别带 `Referer: https://<owner>.github.io/`、不带 Referer、带伪造 Referer 各请求一次，全部返回 200/404 一致 —— 三家都不校验 Referer。因此热链在 Pages 域名下可用，保留 `<meta name="referrer" content="no-referrer">` 仅作为访客地址的隐私兜底，不引入本地镜像。附带发现：`img.dahepiao.com` 存在少量 404 死链（前端 `img.onerror` 移除 `<img>`，退化为无图卡片），且 dahepiao 当前 20 条里仅 1 条有 `poster_url` —— 属抓取层既有数据缺口，spec §9 已声明不改抓取规则，本次不动，另行跟进。
4. **public 仓库**：抓取逻辑、全量数据 JSON、Actions 日志全部公网可见。
5. **发布历史**：`main` 的历史里有 `.西安演出集.qoder.site`（含 `projectId`/`siteId`/`deploymentId`）。推送到 GitHub 的是末端用 `git commit-tree` 生成的 orphan 提交，只含最终树，不含旧历史。
6. 本机 git 2.39.5 上 `git switch --orphan` 会清空索引与工作树（本次已实测并恢复）。后续一律用 plumbing 生成 orphan，不再使用该命令。

## 9. 非目标

- 不做服务端渲染、不引入框架、不引入构建步骤（前端仍是无构建的经典脚本）。
- 不保留「客户端触发同步」能力（静态站做不到，且不能把 PAT 放进前端）。
- 不迁移 Supabase 历史数据：首跑即全量重抓，历史 `sync_log` 不再有意义。
- 不改四个源站的抓取与归一化规则。

## 10. 上线后实测与变更（2026-09-29，部署完成后追加）

站点已发布到 `https://Pikachu1024.github.io/showHub/`，以下为本机与 GitHub Runner 的实测结果。

**Runner 地域可达性：通过。** 首次 `workflow_dispatch` 运行（run 36530085882）build + deploy 全 step 成功，`meta.json` 三个来源均为 `success`，抓取 20/20/11/51 条 —— 原 §8 风险 1（美国 Runner 抓国内票务站）实测未发生。

**调度：待观察。** 工作流 `state: active`、远端文件含 `cron: '0 */6 * * *'`，但仓库新建数分钟内 `next_run_time` 为空、`/actions/workflows/{id}/schedule` 返回 404，需到首个整点（北京 20:00）确认定时确实触发。

**dahepiao 下线（对 §9 最后一条的有意推翻）。** 上线后发现大河票务网的西安搜索页返回的 20 条全是 2024 年已结束场次（逐条比对源站原文时间与适配器解析结果一致，非解析缺陷）：其中 19 条被 7 天过期清理删除，剩下 1 条因时间写作 `2024.04.26-2024.04.30` 解析不出、`end_time` 为 NULL，反而长期滞留在「即将开演」列表里。用户裁定直接下线该源。

落地方式是把「下线一个来源」做成单点操作：`sync/sync.mjs` 的 `ADAPTERS` 注销该项，`tools/publish-data.mjs` 回灌 seed 时按在册来源过滤，于是上一次发布里该源的残留行会在下一次运行自动消失，无需手工清数据。`sync/dahepiao.mjs` 与其单元测试保留（含 `buy_url` 协议白名单的安全用例），恢复只需重新登记。

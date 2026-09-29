# 西安演出集（showHub）

聚合西安四个票务来源的在售演出：大河票务网、西演SPACE、西安儿艺梦想剧场、爱乐剧管（陕西大剧院/西安音乐厅）。

静态站 + 定时抓取：页面本身是纯静态资源，数据由 GitHub Actions 每隔 6 小时抓取四个来源后写成 JSON 一并发布。

## 数据与陈旧度

- `data/shows.json`：全量演出列表（已按开始时间、最低价、名称排序，上限 2000 条）。
- `data/meta.json`：本次抓取概览（每个来源的成功/失败、抓取与新增/更新条数、清理条数、抓取时刻）。
- 过期演出在抓取后自动清理（结束后 7 天；时间解析失败的行静止 30 天后清理）。

**「每 6 小时」是数据陈旧度的上限，不是保证**：GitHub 的调度事件在高负载时会延迟数分钟到数小时。cron 按 UTC 解释（`0 */6 * * *` = UTC 00/06/12/18，即北京 08:00 / 14:00 / 20:00 / 02:00）。

## 手动触发与排查

站点上的「查看抓取任务」链接直达工作流页面，在那里点 **Run workflow** 即可手动跑一次（`scrape` 开关：关闭时只把线上已有数据随新的静态资源重新发布）。手动触发需要 GitHub 登录态——静态站本身不含任何凭据，也不提供页面上抓取数据的能力。

某个来源抓不到时：

1. 页面顶部「▾」概览面板里该源显示 `✗ 失败：<原因>`，原因文本来自抓取侧，已截断到 100 字符。
2. 或直接看 `https://<owner>.github.io/<repo>/data/meta.json` 的 `sources[].error`。
3. 抓取侧的超时统一为 15 秒（`sync/http.mjs`），失败不影响其它来源发布——单次运行里四个来源彼此隔离。
4. Actions 日志首行会打印 `event=<触发来源> args=<实际参数> baseUrl=<回读地址>`，用于确认定时任务是否真的执行了抓取。

## 本地开发

```bash
node tools/publish-data.mjs --out dist     # 真实抓取四源站并生成产物
node dev/preview-server.mjs 5173 dist      # 静态服务产物，等价于线上站点
node --test dev/tests/*.test.mjs           # 全部测试（无依赖，无 package.json）
```

`publish-data` 的三个参数：`--out <dir>`（默认 `dist`）、`--base-url <url>`（回读上次发布数据，缺省时由 `BASE_URL` 或 `GITHUB_REPOSITORY*` 推导）、`--skip-scrape`（只透传线上数据）。

## 结构

```
web/     静态页（无构建、无框架、经典脚本）
sync/    四个来源的抓取适配器 + runSync（Node 直跑，无需任何 secret）
tools/   静态导出：回读 seed → runSync → 导出 JSON → 组装 dist
dev/     内存数据库实现、静态预览服务、fixtures 与测试
.github/ publish.yml：定时抓取并发布 Pages
```

## 首次部署（一次性，需在仓库后台手动做）

1. 仓库设为 **public**（免费计划的 Pages 要求公开仓库）。
2. Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。这一步无法由工作流自我引导；未设置时 `actions/configure-pages` 会直接失败。
3. Actions → publish → Run workflow（保持 `scrape` 为开）跑通一次。
4. 打开 `https://<owner>.github.io/<repo>/` 确认卡片与页脚时间。

之后每次 push 到 `main` 会重新发布静态资源（沿用线上已有数据），定时任务负责刷新数据。

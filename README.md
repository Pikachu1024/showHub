# 西安演出集（showHub）

聚合西安三个票务来源的在售演出：西演SPACE、西安儿艺梦想剧场、爱乐剧管（陕西大剧院/西安音乐厅）。

大河票务网已下线：它的西安搜索页返回的是往年已结束演出的历史页（实测 20 条全是 2024 年的场次），抓回来只会被过期清理立刻删掉。解析器与用例保留在 `sync/dahepiao.mjs`，改好取数口径后在 `sync/sync.mjs` 的 `ADAPTERS` 里登记即可恢复。

静态站 + 定时抓取：页面本身是纯静态资源，数据由 GitHub Actions 每隔 6 小时抓取各来源后写成 JSON 一并发布。

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
3. 抓取侧的超时统一为 15 秒（`sync/http.mjs`），失败不影响其它来源发布——单次运行里各来源彼此隔离。
4. Actions 日志首行会打印 `event=<触发来源> args=<实际参数> baseUrl=<回读地址>`，用于确认定时任务是否真的执行了抓取。

## 免费演出微信推送（Server酱）

每次**抓取**发布后，`tools/notify.mjs` 拿本次数据与线上上一次发布的数据做差集（按 `source + source_id`），把「新出现 + 免费档 + 未售罄」的演出合成**一条** Markdown 消息推到微信。

以下情况一律不推，且都只在日志里说明原因，**绝不影响站点发布**（`runNotify` 吞掉一切异常返回状态）：

- 未配置 SendKey、或本次没有符合条件的新增演出；
- 读不到线上数据当基线（Pages 首发布 / 线上被清空）——否则会把全量上百条当新增推出去；
- `--skip-scrape` 的发布（push 改代码走这条分支：数据没变，推过去只会是重复消息）；
- 新增的免费场次已全部售罄（惠民票常在开票几小时内抢光，推了也是白跑，站点上仍能看到）。

一次性配置（只需做一次）：

1. 打开 <https://sct.ftqq.com/sendkey>，用微信扫码登录（登录即代表关注了「Server酱」服务号，消息发到这里）→ 复制 `SCT` 开头的 SendKey。
2. GitHub 仓库 → Settings → Secrets and variables → Actions → 新建 repository secret：`SERVERCHAN_SENDKEY`。工作流已注入这个 secret，无需改 yml。

要多人同时收到：让每个人各自扫码拿自己的 SendKey，用逗号拼进同一个 secret（`SCT_xxx,SCT_yyy`）。Server酱 免费版不支持群发（会员的 openid 抄送也只覆盖测试号与企业微信通道），所以脚本是**逐人各发一条**，各自消耗自己那 5 条/天的额度；某人 key 失效或额度用尽不影响其他人收到，日志会写成 `已推送 N 场新增免费演出 → 1 人；1 个接收者失败：<原因>`。

额度是硬约束：**免费每天 5 条，发送失败也计数**（另有每分钟 50 条的频率上限；返回 429 表示该 IP 24 小时内调用过多）。本站每天最多 4 轮抓取、每轮最多合成一条，正常用不完。`code != 0` 时服务端 `message` 会写明原因（如「达到今日发送上限」），原样出现在 Actions 日志里。

判定送达不能只看 `code`：`code: 0` 只代表请求被受理，**通道是否真投递看 `data.error`**（非 `SUCCESS` 即没送到）——只看 `code` 会把「取消关注服务号」当成推送成功。

本地验证（凭据只走环境变量，不进仓库）：

```bash
SERVERCHAN_SENDKEY=SCT_xxx node tools/notify.mjs --test   # 真发一条测试消息
node tools/notify.mjs preview                             # 离线复演：本地产物 vs 线上数据，只打印将要推的内容
node tools/notify.mjs preview dist                        # 同上，指定产物目录
```

日志里的 SendKey 一律脱敏成 `SCT_***` 再打印，Actions 日志同理。免费用户消息在服务端只保留 1 天，怀疑丢消息时先看 <https://sct.ftqq.com/log> 的推送日志。

## 本地开发

```bash
node tools/publish-data.mjs --out dist     # 真实抓取在册源站并生成产物
node dev/preview-server.mjs 5173 dist      # 静态服务产物，等价于线上站点
node --test dev/tests/*.test.mjs           # 全部测试（无依赖，无 package.json）
```

`publish-data` 的三个参数：`--out <dir>`（默认 `dist`）、`--base-url <url>`（回读上次发布数据，缺省时由 `BASE_URL` 或 `GITHUB_REPOSITORY*` 推导）、`--skip-scrape`（只透传线上数据）。

## 结构

```
web/     静态页（无构建、无框架、经典脚本）
sync/    三个在册来源的抓取适配器 + runSync（Node 直跑，无需任何 secret）
tools/   静态导出：回读 seed → runSync → 导出 JSON → 组装 dist → 推送新增免费演出
dev/     内存数据库实现、静态预览服务、fixtures 与测试
.github/ publish.yml：定时抓取并发布 Pages
```

## 首次部署（一次性，需在仓库后台手动做）

1. 仓库设为 **public**（免费计划的 Pages 要求公开仓库）。
2. Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。这一步无法由工作流自我引导；未设置时 `actions/configure-pages` 会直接失败。
3. Actions → publish → Run workflow（保持 `scrape` 为开）跑通一次。
4. 打开 `https://<owner>.github.io/<repo>/` 确认卡片与页脚时间。

之后每次 push 到 `main` 会重新发布静态资源（沿用线上已有数据），定时任务负责刷新数据。

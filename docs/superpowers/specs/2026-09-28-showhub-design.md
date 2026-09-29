# 西安演出聚合（showHub）设计文档

日期：2026-09-28
状态：待评审

## 1. 目标

每日定时从多个票务来源抓取演出信息，筛选出**西安**的演出，保存核心字段（名称、海报、时间、价格、城市/场馆、购票链接、分类、售票状态），在 Qoder Sites 上发布一个展示页面，并自动清理过期演出。

## 2. 范围

### v1（本期）

- 数据来源：三个已验证可服务端直连抓取的站点
  - **大河票务网**（m.dahepiao.com）— 服务端渲染 HTML，直接解析
  - **西演SPACE**（dhjc.maitix.com，API 域 client.maitix.com）— 公开 JSON API；站点自身标题为「西演SPACE」，自营场馆含石榴花剧场 / 西演LIVE·易俗大剧院 / 西演SPACE·车库LIVE
  - **西安儿艺梦想剧场**（xaetys.maitix.com）— 与西演SPACE同为 maitix（麦座）平台租户，同一 API、仅 Referer 不同
  - **爱乐剧管**（www.snpac.com）— 陕西大剧院·西安音乐厅院线官方票务 JSON API，覆盖陕西大剧院/西安音乐厅/开元大剧院/西安大剧院四个自营场馆；展示名按用户口径用「爱乐剧管」
- 每日一次定时同步（Sites 定时函数）
- 过期演出清理：结束日期超过 7 天后删除
- 展示页：卡片列表 + 按分类/状态筛选

### 后续（不在本期）

- **大麦**（damai.cn）：搜索接口 `searchajax.html` 被阿里 x5sec 风控拦截，服务端无法直连。预留适配器接口，未来可考虑本地浏览器脚本推送方案
- **猫眼演出** / **永乐票务**（228.com.cn）：网页端探测失败（当前网络环境无法解析，猫眼演出以 App/小程序为主），暂缓
- **好麦通**（dian.haomaitong.com）：平台型多店铺结构，需确定具体店铺，已从需求中移除
- **赳赳大秦**（jjdq.changhenge.cn）：单一驻场演出专用站，信息量小，暂不接

## 3. 来源接口明细（已验证）

### 3.1 大河票务网

- 列表页：`GET https://m.dahepiao.com/search_list?fenlei={分类}&title=西安&page={N}`
  - `fenlei`: 1/2/3/4/5/6 对应不同分类（2 已验证为演出类）；响应为服务端渲染 HTML
  - 翻页：`&page=N`，已验证 page=2 可用；每页约 10 条
- 列表项结构（class 选择器）：
  - `.ycList` 单条演出卡片
  - `.s_left img` → 海报 URL；`.s_left`/`.l1` 的 `href` → 详情/购票链接
  - `.l1` → 演出名称；`.l2` → 演出时间（如 `2024-08-18 周日 20:00`）
  - `.l3` → 场馆（如 `西安星球工厂`）；`.l4 span` → 售票状态（如 `订金预售`）
  - `.l5` → 价格（如 `￥150起`，`em` 内为数字）
- 城市：搜索关键词即"西安"，全部结果均为西安演出（需在适配器里按 `西安` 关键词或场馆字段兜底校验）
- 分类：由 `fenlei` 参数决定，适配器内维护 fenlei→分类名映射
- 抓取策略：从 page=1 逐页抓，直到返回列表为空或达到安全上限（如 10 页）

### 3.2 maitix 平台（西演SPACE dhjc + 西安儿艺梦想剧场 xaetys）

同一平台（maitix.com），**通过 `Referer` 请求头区分租户**，适配器只需配置不同的 Referer 即可复用全部逻辑：

- 城市列表：`GET https://client.maitix.com/api/region/getProjectCityList?langType=1`
  - 已知：西安市 `cityId=610100`
- 项目列表：`GET https://client.maitix.com/api/pro/customizableProjects?page={N}&pageSize=10&projectClass=&city=610100&startTime=&endTime=&langType=1`
  - 租户 Referer：`https://dhjc.maitix.com/`（西演SPACE）/ `https://xaetys.maitix.com/`（西安儿艺梦想剧场）
  - 无需登录、无风控，服务端直接可调（需带常规浏览器 UA 与对应租户的 Referer）
  - 响应 `data` 下的分页元数据：`page` / `totalPage` / `nextPage`，按 `page < totalPage` 翻页
  - 字段映射（已验证）：
    - `projectToken` → source_id（如 `240236026`）
    - `projectName` → 名称；`imgUrl` → 海报
    - `startTime` / `endTime` → 开演/结束时间（毫秒时间戳）
    - `minPrice` / `maxPrice` → 价格区间（均为 0 时视为免费/待定，展示"免费/暂无价格"）
    - `cityName` → 城市；`siteName` → 场馆名；`siteAddress` → 场馆地址（可选）
    - `projectTypeName` → 分类（如 `室内乐`）
    - `sellOut`（true=已售罄）/ `saleState` → 售票状态
- 详情/购票链接（已验证可访问）：`https://{租户域名}/m/#/allEvents/detail?projectId={projectToken}`
  - 即 `https://dhjc.maitix.com/m/#/allEvents/detail?projectId=...` / `https://xaetys.maitix.com/m/#/allEvents/detail?projectId=...`
- 两租户数据可能有重叠（同一演出在两边上架），按 `(source, source_id)` 去重时 source 分别为 `maitix-dhjc` / `maitix-xaetys`；展示层不做跨源合并，接受少量重复

### 3.3 爱乐剧管 SNPAC（snpac.com）

- 全量演出列表（已验证，返回 52 条，覆盖四个自营场馆）：
  `POST https://www.snpac.com/thvendor/ticket/program/getHotProgramList.xhtml`
  - 必需请求头：`cmpappkey: SXtheatre`；body：`showSite=pclist`（可选 `stadiumId` 按场馆过滤）
  - 场馆 ID（来自前端代码）：陕西大剧院 751 / 西安音乐厅 743 / 开元大剧院 750 / 西安大剧院 867（不传则返回全部）
- 字段映射（已验证）：
  - `id` → source_id；`fullCnName` → 名称
  - `verticalPoster` / `extraPoster`（竖版海报，列表页实际使用 `extraPoster`）→ 海报
  - `startTime` / `endTime` → 开演/结束时间（`YYYY-MM-DD HH:mm:ss` 字符串）
  - `minPrice` / `maxPrice` → 价格区间
  - `stadiumName`（如 `西安·开元大剧院`）+ `venueName`（如 `大剧场`）→ 场馆
  - `category` → 分类；`tag`（`最新开票,自营,热门推荐,不支持退换`）→ 状态标签
  - `saleType`（`sale` 等）→ 售票状态
- 城市：四个场馆均在西安，全量即西安演出，无需过滤
- 详情/购票链接：`https://www.snpac.com/sxtheatre/index.html#/ticket/detail/{id}`（路由已确认，实施时浏览器复核一次）

## 4. 架构（Qoder Sites 托管）

```
定时函数（每日一次）
  ├─ adapter: dahepiao     ──┐
  ├─ adapter: maitix-dhjc  ──┤
  ├─ adapter: maitix-xaetys ┤  ← 与 maitix-dhjc 同一适配器，不同租户配置
  ├─ adapter: snpac        ──┤
  └─ 清理：删除 end_time < now - 7天 的记录
                        │
展示页（前端） ←── 后端查询 API ←── 数据库（shows 表 + sync_log 表）
```

- 每个来源一个**独立适配器**，统一输出 `ShowRecord` 结构；单个适配器失败只记录错误，不影响其他来源和整体任务
- 适配器注册表模式：新增来源 = 新增一个适配器文件 + 注册，核心流程不动

## 5. 数据模型

### `shows` 表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 主键 | 自增/uuid |
| `source` | text | 来源标识：`dahepiao` / `maitix-dhjc` / `maitix-xaetys` / `snpac` |
| `source_id` | text | 来源侧唯一 ID（dahepiao 详情页 URL 中的数字 ID / maitix projectToken / snpac id） |
| `name` | text | 演出名称 |
| `poster_url` | text | 海报图 URL |
| `start_time` | text | 开演时间（原文，如 `2026-10-15 周三 19:30`） |
| `start_at` | timestamp | 解析出的开演时间（可解析时），用于排序 |
| `end_time` | timestamp | 演出结束时间（maitix 有；dahepiao 缺省用开演时间） |
| `price` | text | 价格展示文本（如 `￥150起` / `90-280`） |
| `city` | text | 城市（恒为 西安） |
| `venue` | text | 场馆 |
| `category` | text | 分类（演唱会/话剧/音乐会等） |
| `status` | text | 售票状态原文（如 `订金预售`） |
| `buy_url` | text | 购票/详情链接 |
| `created_at` / `updated_at` | timestamp | 入库/更新时间 |

- 唯一约束：`(source, source_id)`，同步时 upsert（存在则更新价格/状态/时间等，不存在则插入）
- 海报 URL 直接存源站 URL（v1 不做图片转存；若源站防盗链则在实施时改为代理或下载到 Sites Storage）

### `sync_log` 表

| 字段 | 说明 |
|---|---|
| `id`, `started_at`, `finished_at` | 本次同步起止 |
| `source` | 来源（或 `all` 汇总行） |
| `status` | `success` / `error` |
| `fetched` / `inserted` / `updated` / `deleted` | 各计数 |
| `error` | 错误信息 |

## 6. 定时同步流程（每日一次）

1. 读取启用的适配器列表（v1：dahepiao、maitix-dhjc、maitix-xaetys、snpac）
2. 逐个执行：抓取 → 解析 → 归一化 → 过滤西安 → upsert
3. 适配器内部对 HTTP 请求做超时（15s）与有限重试（1 次）
4. 每个来源结果写入 `sync_log`
5. 清理步骤：`DELETE FROM shows WHERE end_time < now - 7 days`
6. 请求间隔（来源内部翻页之间 sleep 1-2s，来源之间 3s），避免对目标站造成压力

## 7. 展示页

- 数据获取：后端查询接口返回 `shows` 列表（按 `start_at` 正序，未解析时间的排最后）+ 最近一次同步时间（来自 `sync_log`）
- 布局：响应式卡片流（移动端 1 列，桌面 3-4 列）
- 卡片内容：海报（封面）、名称、时间、场馆、价格、分类标签、售票状态徽标、购票按钮（新窗口打开 `buy_url`）
- 筛选：按分类（全部/演唱会/话剧/…）；按状态（即将开演 / 已结束）
- 页脚显示"数据更新于 {最近同步时间}"及各来源健康状态（dahepiao ✓ / maitix-dhjc ✓ / maitix-xaetys ✓ / snpac ✗）
- 已结束但仍在 7 天保留期内的演出置灰或标记"已结束"

## 8. 错误处理

- 适配器抛错（网络/解析失败）：捕获，记入 `sync_log`（status=error + 错误信息），继续下一个来源
- 解析容错：单个字段缺失（如价格缺失）不丢弃整条记录，存空值
- 海报加载失败：前端用占位图兜底
- 定时函数整体失败：下次定时自然重试；页面仍展示上次成功同步的旧数据

## 9. 测试策略

- 适配器解析逻辑：用保存的真实 HTML/JSON 样本（fixtures）做单元测试，断言提取出的字段
- 归一化/过滤逻辑：单元测试（西安过滤、时间解析、价格格式化）
- 同步流程：本地/预发环境手动触发定时函数，验证 upsert 去重、计数、清理逻辑
- 展示页：浏览器手动验证筛选、卡片渲染、购票跳转

## 10. 已知风险与对策

| 风险 | 对策 |
|---|---|
| 目标站改版导致解析失败 | 适配器隔离 + sync_log 告警字段；失败时页面显示旧数据并标注来源异常 |
| dahepiao 搜索结果混入非西安演出 | 适配器内按名称/场馆含"西安"兜底校验 |
| 海报防盗链 | 实施时验证；必要时下载到 Sites Storage |
| 定时函数执行时长限制 | 每来源分页上限、请求间隔控制在预算内；如超限改为每来源独立函数 |

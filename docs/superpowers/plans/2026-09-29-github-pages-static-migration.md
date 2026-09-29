# GitHub Pages 纯静态发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 showHub 从「Deno function + Supabase」改为 GitHub Pages 静态站 + GitHub Actions 每 6 小时抓取导出的 JSON 数据。

**Architecture:** 复用现有四个抓取适配器与 `runSync`（零改动），在 Actions 里用 `dev/fake-supabase.mjs` 作内存库：回读上次线上 JSON 作 seed → `runSync`（保留过期清理与单源错误隔离）→ 导出 `data/shows.json` + `data/meta.json` → 与 `web/` 一起作为 Pages 产物上传。数据不进 git 历史，前端改为单次读取静态 JSON。

**Tech Stack:** 原生 HTML/CSS/经典脚本 JS（无构建、零依赖、无 `package.json`）；Node ≥ 22 内置 `node:test`；GitHub Actions（`configure-pages` / `upload-pages-artifact` / `deploy-pages`）。

**Spec:** `docs/superpowers/specs/2026-09-29-github-pages-static-migration-design.md`

## Global Constraints

- 仓库零运行时依赖：不创建 `package.json`，Actions 内不执行任何 `npm` 命令。
- 抓取模块不需要任何 secret 或环境变量（四个适配器全为公开接口）。
- 测试命令固定为 `node --test dev/tests/*.test.mjs`（当前基线 57 passed）。
- cron 固定 `0 */6 * * *`（UTC）。
- 前端保持经典脚本：不得出现 `type="module"`、`async`、`defer`。
- 所有页面资源路径必须为**相对路径**（project Pages 在 `/ <repo>/` 子路径下）。
- 禁止使用 `git switch --orphan`：本机 git 2.39.5 上它会清空索引与工作树（已实测）。orphan 提交一律用 `git commit-tree`。
- 一律用 `textContent` 写入用户可见文本；`meta.json` 的 `error` 字段视为不可信内容，截断后原样 textContent 输出。

---

### Task 1: 抽出查询与元信息模块，重命名抓取目录

**Files:**
- Create: `tools/show-query.mjs`
- Rename: `functions/sync/` → `sync/`（`git mv`，六个文件）
- Modify: `functions/handler.mjs`（`handleList`/`handleMeta` 改用新模块，行为不变）
- Modify: `dev/tests/{dahepiao,maitix,snpac,normalize,sync,price-key}.test.mjs`（import 路径 `../../functions/sync/…` → `../../sync/…`）
- Modify: `dev/preview-server.mjs:7`（`../functions/handler.mjs` 暂不变，只改 sync 相关引用）

**Interfaces:**
- Consumes: `supabase.from('shows')` / `supabase.from('sync_log')` 链式查询（`dev/fake-supabase.mjs` 实现）
- Produces:
  - `SHOW_FIELDS: string` —— 逗号分隔投影列，含 `updated_at`
  - `MAX_ROWS: number` = 2000
  - `queryShows(supabase): Promise<ShowRow[]>` —— 三键排序后取前 2000 行；读失败抛 `Error('shows_read_failed')`
  - `buildMeta(results: SyncRow[], deleted: number, opts?: { workflowUrl?: string|null, now?: () => Date }): Meta`，`Meta = { generated_at, lastSuccessAt, workflowUrl, sources: SourceMeta[], cleanup_deleted }`

- [ ] **Step 1: 写 queryShows 失败测试**

创建 `dev/tests/show-query.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOW_FIELDS, MAX_ROWS, queryShows } from '../../tools/show-query.mjs';
import { fakeSupabase } from '../fake-supabase.mjs';

test('queryShows 投影含 updated_at（seed 回读后清理脏行的唯一依据）', () => {
  assert.ok(SHOW_FIELDS.split(',').includes('updated_at'));
  assert.equal(MAX_ROWS, 2000);
});

test('queryShows 三键排序与 handler 原语义一致（时间→价格→名称，null 靠后）', async () => {
  const supabase = fakeSupabase();
  await supabase.from('shows').insert([
    { name: 'b', start_at: '2026-11-02T00:00:00+08:00', min_price: 100, updated_at: 'u1' },
    { name: 'a', start_at: '2026-11-01T00:00:00+08:00', min_price: null, updated_at: 'u2' },
    { name: 'c', start_at: null, min_price: 0, updated_at: 'u3' },
  ]);
  const rows = await queryShows(supabase);
  assert.deepEqual(rows.map((r) => r.name), ['a', 'b', 'c'], 'start_at 为 null 的行必须排最后');
  assert.deepEqual(rows[0], { name: 'a', start_at: '2026-11-01T00:00:00+08:00', min_price: null, updated_at: 'u2' });
});

test('queryShows 超过 MAX_ROWS 时截断且不报错', async () => {
  const supabase = fakeSupabase();
  const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ name: `s${i}`, start_at: `2026-11-01T00:00:0${i % 9}+08:00`, min_price: i }));
  await supabase.from('shows').insert(many);
  const rows = await queryShows(supabase);
  assert.equal(rows.length, MAX_ROWS);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test dev/tests/show-query.test.mjs`
Expected: FAIL，`Cannot find module '../../tools/show-query.mjs'`

- [ ] **Step 3: 实现 tools/show-query.mjs**

```js
// 静态导出用的查询与元信息聚合。字段与排序沿用原 handler 的 list 端点语义，
// 差别只在一次读完（原前端是 10 页 × 200 游标循环）。
export const SHOW_FIELDS = 'source,source_id,name,poster_url,start_time,start_at,end_time,price,min_price,city,venue,category,status,buy_url,updated_at';
export const MAX_ROWS = 2000;

export async function queryShows(supabase) {
  const { data, error } = await supabase
    .from('shows')
    .select(SHOW_FIELDS)
    .order('start_at', { ascending: true, nullsFirst: false })
    .order('min_price', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
    .range(0, MAX_ROWS - 1);
  if (error || !Array.isArray(data)) throw new Error('shows_read_failed');
  return data;
}

// results 为 runSync 返回的按源结果行（不含 cleanup 行）；deleted 为本次清理条数
export function buildMeta(results, deleted, { workflowUrl = null, now = () => new Date() } = {}) {
  const sources = [];
  let lastSuccessAt = null;
  for (const r of results) {
    if (r.source === 'cleanup') continue;
    sources.push({
      source: r.source,
      status: r.status,
      finished_at: r.finished_at,
      fetched: r.fetched,
      inserted: r.inserted,
      updated: r.updated,
      deleted: r.deleted,
      error: r.error,
    });
    if (r.status === 'success' && r.finished_at && (!lastSuccessAt || r.finished_at > lastSuccessAt)) {
      lastSuccessAt = r.finished_at;
    }
  }
  return { generated_at: now().toISOString(), lastSuccessAt, workflowUrl, sources, cleanup_deleted: deleted };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test dev/tests/show-query.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: 重命名抓取目录并修 import 路径**

```bash
git mv functions/sync sync
sed -i '' 's#\.\./\.\./functions/sync/#../../sync/#' dev/tests/dahepiao.test.mjs dev/tests/maitix.test.mjs \
  dev/tests/snpac.test.mjs dev/tests/normalize.test.mjs dev/tests/sync.test.mjs
grep -rn "functions/sync" . --include=*.mjs --exclude-dir=.git   # 期望无输出
```

- [ ] **Step 6: handler 改用新模块（保持 list/meta 行为不变）**

`functions/handler.mjs` 的 `handleList` 整体替换为：

```js
async function handleList(request, params, supabase) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  try {
    const items = await queryShows(supabase);
    return json({ items, hasMore: false, nextOffset: null });
  } catch {
    return json({ error: 'database_request_failed' }, 503);
  }
}
```

`handleMeta` 的返回改为 `return json(buildMeta(data, 0, {}))`（`data` 为原有 `sync_log` 查询结果）。顶部加 `import { queryShows, buildMeta } from '../tools/show-query.mjs';`。

注意：`buildMeta` 的入参形状与原 `sync_log` 行一致，`handleMeta` 里手写的去重循环可以整段删除。

- [ ] **Step 7: 跑全量测试确认无回归**

Run: `node --test dev/tests/*.test.mjs`
Expected: PASS，60 tests（基线 57 + 新增 3）

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: 抽出静态导出用的查询与元信息模块，抓取目录改名 sync"
```

---

### Task 2: publish-data 生成静态产物

**Files:**
- Create: `tools/publish-data.mjs`
- Create: `dev/tests/publish-data.test.mjs`
- Modify: `dev/tests/sync.test.mjs`（追加同 seed 双跑幂等用例）

**Interfaces:**
- Consumes: `runSync({ supabase })` from `sync/sync.mjs`；`queryShows`/`buildMeta` from `tools/show-query.mjs`；`fakeSupabase()` from `dev/fake-supabase.mjs`；`timeoutFetch()` from `sync/http.mjs`
- Produces:
  - `resolveBaseUrl(env = process.env): string` —— 依次取 `env.BASE_URL`、`https://${owner}.github.io/${repo}`，都缺 → `''`
  - `readSeed({ baseUrl, transport }): Promise<{ shows: ShowRow[], meta: Meta|null, degraded: string|null }>`
  - `seedStores(shows): Supabase` —— 建库并在任何 `from()` 之前灌入 shows
  - `buildDist({ webDir, outDir, shows, meta }): Promise<void>`
  - `runPublish({ out, baseUrl, scrape, transport, workflowUrl, webDir, now }): Promise<{ ok, degraded, counts }>`
  - CLI：`node tools/publish-data.mjs [--out dist] [--base-url <url>] [--skip-scrape]`

- [ ] **Step 1: 写失败测试**

创建 `dev/tests/publish-data.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSeed, resolveBaseUrl, runPublish, seedStores } from '../../tools/publish-data.mjs';

const day = (n) => `2026-11-0${n}T11:30:00+08:00`;
const show = (id, name, start) => ({
  id: `id-${id}`, source: 'dahepiao', source_id: id, name, city: '西安',
  poster_url: '', start_time: '', start_at: start, end_time: start,
  price: '￥100起', min_price: 100, venue: '剧场', category: '音乐会',
  status: '售票中', buy_url: '', updated_at: start,
});

// 只有一个来源的极简 transport：dahepiao 列表页 HTML 由测试直接给出
const dahepiaoHtml = (name, href, date) => `
<div class="ycList list-grid flex">
  <a href="${href}" class="s_left"><img src="https://img/x.jpg"></a>
  <div class="s_right">
    <a href="${href}" class="l1 line1">${name}</a>
    <div class="l2 line1">${date} 周日 19:30</div>
    <div class="l3 line1">西安测试场馆</div>
    <div class="l4"><span>售票中</span></div>
    <div class="l5">￥<em>100</em>起</div>
  </div>
</div>`;
const live = () => dahepiaoHtml('活着的演出', 'https://m.dahepiao.com/yanchupiaowu1/1.html', '2026-11-05');

const transportFor = (body) => async (url) => {
  const u = String(url);
  if (u.includes('dahepiao.com')) return new Response(body, { status: 200 });
  if (u.includes('maitix.com')) return Response.json({ code: '200', data: { dataList: [], totalPage: 1 } });
  if (u.includes('snpac.com')) return Response.json({ success: true, data: [] });
  return new Response('not found', { status: 404 });
};

const tmp = async () => mkdtemp(join(tmpdir(), 'showhub-dist-'));

test('resolveBaseUrl 优先用 BASE_URL，其次由仓库名推导 project Pages 地址', () => {
  assert.equal(resolveBaseUrl({ BASE_URL: 'https://pika.github.io/showHub' }), 'https://pika.github.io/showHub');
  assert.equal(
    resolveBaseUrl({ GITHUB_REPOSITORY_OWNER: 'pika', GITHUB_REPOSITORY: 'pika/showHub' }),
    'https://pika.github.io/showHub'
  );
  assert.equal(resolveBaseUrl({}), '');
});

test('readSeed 首跑 404 → 空表 + degraded 原因，不抛错', async () => {
  const res = await readSeed({ baseUrl: 'https://pika.github.io/showHub', transport: transportFor('') });
  assert.deepEqual(res.shows, []);
  assert.equal(res.meta, null);
  assert.match(res.degraded, /seed_missing/);
});

test('runPublish 保留 seed 中的过期行被清理，输出含 updated_at', async () => {
  const out = await tmp();
  const stale = show('old', '已过期老演出', '2020-01-01T11:30:00+08:00');
  const seedTransport = async (url) => {
    if (String(url).endsWith('data/shows.json')) {
      return Response.json({ generated_at: 'x', shows: [stale] });
    }
    if (String(url).endsWith('data/meta.json')) return new Response('nope', { status: 404 });
    return transportFor(live())(url);
  };
  const res = await runPublish({
    out, baseUrl: 'https://pika.github.io/showHub', scrape: true,
    transport: seedTransport, webDir: new URL('../../web/', import.meta.url),
    now: () => new Date('2026-11-04T00:00:00+08:00'),
  });
  const body = JSON.parse(await readFile(join(out, 'data', 'shows.json'), 'utf8'));
  assert.deepEqual(body.shows.map((s) => s.name), ['活着的演出'], 'seed 里过期的行必须被 cleanup 删除');
  assert.ok(body.shows[0].updated_at, '导出必须含 updated_at');
  assert.equal(res.counts.deleted, 1);
  assert.match(res.degraded, /meta_missing/);
  assert.ok((await readdir(out)).includes('index.html'), 'dist 必须含静态资源');
});

test('runPublish scrape=false 原样透传线上数据，绝不发起抓取', async () => {
  const out = await tmp();
  const calls = [];
  const passthrough = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('data/shows.json')) return Response.json({ generated_at: 'g', shows: [show('k', '透传演出', day(6))] });
    if (String(url).endsWith('data/meta.json')) return Response.json({ generated_at: 'g', lastSuccessAt: 'l', workflowUrl: null, sources: [], cleanup_deleted: 0 });
    throw new Error(`不应请求 ${url}`);
  };
  await runPublish({ out, baseUrl: 'https://x', scrape: false, transport: passthrough, webDir: new URL('../../web/', import.meta.url) });
  const body = JSON.parse(await readFile(join(out, 'data', 'shows.json'), 'utf8'));
  assert.deepEqual(body.shows.map((s) => s.name), ['透传演出']);
  assert.deepEqual(calls.sort(), ['https://x/data/meta.json', 'https://x/data/shows.json']);
});

test('runPublish scrape=false 但线上无数据时降级为完整抓取，不发布空站', async () => {
  const out = await tmp();
  const res = await runPublish({
    out, baseUrl: 'https://pika.github.io/showHub', scrape: false,
    transport: async (url) => (String(url).includes('data/') ? new Response('gone', { status: 404 }) : transportFor(live())(url)),
    webDir: new URL('../../web/', import.meta.url),
  });
  assert.equal(res.degradedFellBack, true, '必须显式记录降级为抓取');
  const body = JSON.parse(await readFile(join(out, 'data', 'shows.json'), 'utf8'));
  assert.equal(body.shows.length, 1);
});

test('seedStores 在首次 from() 前灌入行（builder 创建时快照行引用）', async () => {
  const supabase = seedStores([show('a', 'A', day(6))]);
  const rows = await supabase.from('shows').select('source_id');
  assert.deepEqual(rows.data.map((r) => r.source_id), ['a']);
});

test('meta.json 写入 workflowUrl 供前端“查看抓取任务”链接', async () => {
  const out = await tmp();
  await runPublish({
    out, baseUrl: 'https://x', scrape: true, workflowUrl: 'https://github.com/pika/showHub/actions/workflows/publish.yml',
    transport: transportFor(live()), webDir: new URL('../../web/', import.meta.url),
  });
  const meta = JSON.parse(await readFile(join(out, 'data', 'meta.json'), 'utf8'));
  assert.equal(meta.workflowUrl, 'https://github.com/pika/showHub/actions/workflows/publish.yml');
  assert.ok(meta.sources.some((s) => s.source === 'dahepiao' && s.status === 'success'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test dev/tests/publish-data.test.mjs`
Expected: FAIL，`Cannot find module '../../tools/publish-data.mjs'`

- [ ] **Step 3: 实现 tools/publish-data.mjs**

要点（实现须满足上面全部断言）：

```js
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeSupabase } from '../dev/fake-supabase.mjs';
import { runSync } from '../sync/sync.mjs';
import { timeoutFetch } from '../sync/http.mjs';
import { buildMeta, queryShows } from './show-query.mjs';

export function resolveBaseUrl(env = process.env) {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/+$/, '');
  const repo = env.GITHUB_REPOSITORY;
  if (env.GITHUB_REPOSITORY_OWNER && repo) {
    return `https://${env.GITHUB_REPOSITORY_OWNER}.github.io/${repo.split('/')[1]}`;
  }
  return '';
}

// 回读上一次发布的数据。任何失败都只降级不抛错：
// 抓取以 source+source_id upsert，重跑幂等，缺 seed 的代价仅是本次全量。
export async function readSeed({ baseUrl, transport = timeoutFetch() }) {
  if (!baseUrl) return { shows: [], meta: null, degraded: 'seed_missing:no_base_url' };
  const get = async (name) => {
    try {
      const res = await transport(`${baseUrl}/data/${name}`);
      if (!res.ok) return { ok: false };
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false };
    }
  };
  const s = await get('shows.json');
  const m = await get('meta.json');
  const degraded = [];
  if (!s.ok || !Array.isArray(s.body?.shows)) degraded.push('seed_missing');
  if (!m.ok || !m.body?.sources) degraded.push('meta_missing');
  return {
    shows: s.ok && Array.isArray(s.body.shows) ? s.body.shows : [],
    meta: m.ok && m.body?.sources ? m.body : null,
    degraded: degraded.length ? degraded.join(',') : null,
  };
}

// builder 在创建时对表内行做引用快照（fake-supabase.mjs:25），
// 所以 seed 必须在任何 from() 之前落到 _tables 上。
export function seedStores(shows) {
  const supabase = fakeSupabase();
  supabase._tables.set('shows', shows.map((r) => ({ ...r })));
  return supabase;
}

export async function buildDist({ webDir, outDir, shows, meta }) {
  await mkdir(join(outDir, 'data'), { recursive: true });
  await cp(webDir, join(outDir), { recursive: true });
  await writeFile(join(outDir, 'data', 'shows.json'), JSON.stringify({ generated_at: meta.generated_at, shows }));
  await writeFile(join(outDir, 'data', 'meta.json'), JSON.stringify(meta));
}

export async function runPublish({
  out = 'dist', baseUrl = resolveBaseUrl(), scrape = true, transport = timeoutFetch(),
  workflowUrl = null, webDir = new URL('../web/', import.meta.url), now = () => new Date(),
} = {}) {
  const outDir = String(out);
  const { shows: seedRows, meta: seedMeta, degraded } = await readSeed({ baseUrl, transport });
  if (!scrape && seedMeta) {
    await buildDist({ webDir, outDir, shows: seedRows, meta: seedMeta });
    return { ok: true, degraded, counts: { shows: seedRows.length }, degradedFellBack: false };
  }
  // 无 seed 可透传时退回抓取，避免一次 push 部署把线上数据清空
  const supabase = seedStores(seedRows);
  const { results, deleted } = await runSync({ supabase, now });
  const shows = await queryShows(supabase);
  const meta = buildMeta(results, deleted, { workflowUrl, now });
  await buildDist({ webDir, outDir, shows, meta });
  return { ok: true, degraded: scrape ? degraded : `${degraded ?? ''},fallback_scrape`, counts: { shows: shows.length, deleted }, degradedFellBack: !scrape };
}

// 仅在直接作为脚本运行时解析 argv，便于测试 import
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/[a-z]/, '')))) {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.indexOf(`--${name}`) + 1 ? argv[argv.indexOf(`--${name}`) + 1] : undefined;
  const res = await runPublish({
    out: flag('out') ?? 'dist',
    baseUrl: flag('base-url') ?? resolveBaseUrl(),
    scrape: !argv.includes('--skip-scrape'),
    workflowUrl: process.env.WORKFLOW_URL ?? null,
  });
  console.log(`[publish-data] shows=${res.counts.shows} deleted=${res.counts.deleted ?? 0} degraded=${res.degraded ?? 'none'}`);
}
```

上面的脚本入口判断写得脆：改用 `import.meta.url === `file://${process.argv[1]}`` 比较，或在 `--help` 之外用 `argv.includes('--cli')`。选前者，实现时写成：

```js
const isCli = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isCli) { /* 同上 argv 解析与 console.log，失败时 process.exitCode = 1 并打印原因 */ }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test dev/tests/publish-data.test.mjs`
Expected: PASS（7 tests）

- [ ] **Step 5: 追加同 seed 双跑幂等用例**

`dev/tests/sync.test.mjs` 末尾追加（复用文件内已有的 `makeTransport()` 与 `fixedNow`）：

```js
test('同一 seed 连跑两次结果幂等（seed 回读失败退化为全量重抓的依据）', async () => {
  const first = fakeSupabase();
  const a = await runSync({ supabase: first, transport: makeTransport(), now: fixedNow });
  const seedRows = (await first.from('shows').select('*')).data.map((r) => ({ ...r }));
  const second = fakeSupabase();
  second._tables.set('shows', seedRows.map((r) => ({ ...r })));
  const b = await runSync({ supabase: second, transport: makeTransport(), now: fixedNow });
  const key = (rows) => rows.map((r) => `${r.source}/${r.source_id}`).sort().join('|');
  const rowsA = (await first.from('shows').select('source,source_id')).data;
  const rowsB = (await second.from('shows').select('source,source_id')).data;
  assert.equal(key(rowsB), key(rowsA), '第二次运行不得新增重复行');
  assert.equal(b.results.reduce((n, r) => n + r.inserted, 0), 0, '第二次运行 inserted 必须为 0');
});
```

- [ ] **Step 6: 跑全量测试**

Run: `node --test dev/tests/*.test.mjs`
Expected: PASS，68 tests

- [ ] **Step 7: Commit**

```bash
git add tools/publish-data.mjs dev/tests/publish-data.test.mjs dev/tests/sync.test.mjs
git commit -m "feat: publish-data 回读 seed 抓取导出静态产物"
```

---

### Task 3: 删除 serverless 入口，预览服务退化

**Files:**
- Delete: `functions/index.ts`、`functions/adapter.mjs`、`functions/handler.mjs`（`functions/` 目录随之消失）
- Modify: `dev/preview-server.mjs`（去 `/functions/v1/app` 代理，静态服务 `--dir` 传入的产物目录）
- Modify: `dev/tests/price-key.test.mjs`（第 5 行 import 与 102 行用例改走 `queryShows`）

**Interfaces:**
- Consumes: `queryShows(supabase)` from Task 1
- Produces: `node dev/preview-server.mjs [port] [dir]`，`dir` 默认 `dist`

- [ ] **Step 1: 改 price-key 测试的旧数据用例（先让它指向新入口）**

`dev/tests/price-key.test.mjs`：删除 `import { handler } ...`，改为 `import { queryShows } from '../../tools/show-query.mjs';`。第 102 行起那个「旧数据模拟」用例，把

```js
  const res = await handler({ request: new Request('http://127.0.0.1:5291/functions/v1/app?action=list'), supabase });
  assert.equal(res.status, 200);
  const { items } = await res.json();
```

替换为

```js
  const items = await queryShows(supabase);
```

其余断言（`items.length === 4`、`priceKeyOf` 兜底、免费筛选集合、`sortShows` 顺序）保持不变；`min_price: null` 前提断言也不变。

- [ ] **Step 2: 跑该测试确认通过**

Run: `node --test dev/tests/price-key.test.mjs`
Expected: PASS

- [ ] **Step 3: 退化 preview-server**

`dev/preview-server.mjs` 删除 `import { handler }`、`import { fakeSupabase }`、`supabase` 常量，以及 `if (url.pathname.startsWith('/functions/v1/app'))` 整段分支；`root` 改为取第三个参数（缺省 `dist`）：

```js
const root = fileURLToPath(new URL(process.argv[3] ?? 'dist/', import.meta.url));
```

`dist/` 由 `node tools/publish-data.mjs --out dist` 生成，预览即为线上静态站的等价物。

- [ ] **Step 4: 删除三个 serverless 文件**

```bash
git rm functions/index.ts functions/adapter.mjs functions/handler.mjs
grep -rn "functions/\|/functions/v1/app" --include=*.mjs --include=*.js --include=*.html . --exclude-dir=.git
```

Expected: grep 仅剩 `web/app.js` 的两处（Task 4 处理），其余无输出。

- [ ] **Step 5: 跑全量测试**

Run: `node --test dev/tests/*.test.mjs`
Expected: PASS（`page-boot` 仍绿——它不引用 handler；若红则说明还有残留引用，修好再提交）

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor!: 删除 Deno serverless 与 Supabase 入口，预览服务改静态产物"
```

---

### Task 4: 前端改读静态 JSON

**Files:**
- Modify: `web/app.js`（数据层与同步面板）
- Modify: `web/index.html`（相对路径、`<a>` 抓取任务入口、referrer 策略）
- Modify: `dev/tests/page-boot.test.mjs`

**Interfaces:**
- Consumes: 静态 `data/shows.json`（`{ generated_at, shows[] }`）、`data/meta.json`（Task 2 的 `Meta`）
- Produces: 无对外接口（叶子节点）

- [ ] **Step 1: 先改测试（失败）**

`dev/tests/page-boot.test.mjs` 的 `bootContext`：fetch 桩改为按 URL 分派静态文件，并把 `items` 包进 `{ generated_at, shows: items }`：

```js
    fetch: async (url) => {
      const u = String(url);
      fetchCalls.push({ url: u, method: 'GET' });
      const body = u.includes('data/meta.json')
        ? { generated_at: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), workflowUrl: 'https://example.test/workflow', sources: [], cleanup_deleted: 0 }
        : { generated_at: 'g', shows: items };
      return { ok: true, status: 200, json: async () => body };
    },
```

三处断言同步修改：

- 脚本标签：`assert.match(tags[0], /src="price-key\.js"/)`、`assert.match(tags[1], /src="app\.js"/)`（**去掉前导 `/`**，其余 module/async/defer 断言不变）。
- 「挂上交互监听」用例：`fetchCalls.some((c) => c.url.includes('action=list'))` → `c.url.includes('data/shows.json')`；`clicks('syncBtn') === 1` → 改为断言 `syncBtn` 是链接：`assert.equal(els.get('syncBtn').href, 'https://example.test/workflow')` 且不再有 click 监听（`assert.equal(clicks('syncBtn'), 0)`）。
- 「不新增全局绑定」用例：泄漏名单里把已删除的 `syncRequest`/`runSync` 换成 `loadShows`/`renderSyncOverview`。
- 新增一例：`meta.sources` 含一条 `status:'error'` 时，面板对应行文本以 `✗` 开头且**不含** HTML 标签（证明 error 文本走 textContent）。

Run: `node --test dev/tests/page-boot.test.mjs` → Expected: FAIL（仍是旧实现）

- [ ] **Step 2: 改 web/index.html**

```html
  <link rel="stylesheet" href="style.css">
  <meta name="referrer" content="no-referrer">
```

同步区按钮替换（`syncToggle`/`syncPanel` 结构保留，面板变只读）：

```html
    <div class="sync-row">
      <a id="syncBtn" class="sync-btn" target="_blank" rel="noopener noreferrer" hidden>查看抓取任务</a>
      <button id="syncToggle" class="sync-toggle" type="button" aria-expanded="true" aria-controls="syncPanel">▾</button>
    </div>
```

脚本标签去前导斜杠：

```html
  <script src="price-key.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 3: 改 web/app.js 数据层**

替换 `api()`/`syncRequest()`/`loadShows()` 三个函数为：

```js
  // 静态产物：数据由 GitHub Actions 每 6 小时生成，前端只读
  async function loadJson(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`load_${path}_${res.status}`);
    return res.json();
  }
  async function loadShows() {
    const body = await loadJson('data/shows.json');
    return Array.isArray(body.shows) ? body.shows : [];
  }
```

删除 `SYNC_INTERVAL_MS`、`syncInFlight`、`autoSyncFired`、`renderSyncPending`、`renderSyncResult`、`renderSyncRateLimited`、`renderSyncFailure`、`setSyncPending`、`reloadAfterSync`、`runSync`、`syncRequest`、`api` 与 `document.getElementById('syncBtn').addEventListener('click', …)`。

面板改只读：`renderSyncOverview(meta)` 复用 `buildSyncPanel()` 建出的行，逐源填

```js
      r.status === 'error'
        ? `${label} ✗ 失败：${String(r.error ?? '').slice(0, 100)}`
        : `${label} 抓取 ${r.fetched} · 新增 ${r.inserted} · 更新 ${r.updated}`;
```

并写 `syncPanel.cleanup.textContent = \`上次清理过期演出 ${meta.cleanup_deleted ?? 0} 条\``、`syncPanel.time.textContent = \`抓取完成于 ${formatClock(new Date(meta.generated_at))}\``。`syncBtn` 由 `meta.workflowUrl` 决定：有则 `href = meta.workflowUrl` 且 `hidden = false`，无则保持 `hidden`。

启动块改：

```js
  (async () => {
    try {
      state.shows = await loadShows();
      renderCategories();
      render();
    } catch {
      document.getElementById('empty').textContent = '加载失败，请稍后刷新重试';
      document.getElementById('empty').classList.remove('hidden');
    }
    try {
      state.meta = await loadJson('data/meta.json');
      renderFooter();
      renderSyncOverview(state.meta);
    } catch { /* 页脚与面板静默：无 meta 时保持隐藏 */ }
  }());
```

`renderFooter()` 不变。海报：`img.referrerPolicy = 'no-referrer'`（`index.html` 的 `<meta>` 已覆盖，这里是双保险）。`syncToggle` 的折叠监听保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test dev/tests/page-boot.test.mjs && node --test dev/tests/*.test.mjs`
Expected: PASS 全绿

- [ ] **Step 5: 端到端手工验证**

```bash
node tools/publish-data.mjs --out dist          # 真实抓取四源站
node dev/preview-server.mjs 5173 dist &
```
用浏览器打开 `http://127.0.0.1:5173`：卡片有数据、页脚显示抓取时刻、面板展开可见四源状态、`查看抓取任务` 不指向 `127.0.0.1`。同时确认海报是否显示（记录结论供 Task 6 风险项用）。

- [ ] **Step 6: Commit**

```bash
git add web/ dev/tests/page-boot.test.mjs
git commit -m "feat: 前端改读 Actions 生成的静态 JSON，同步面板变只读概览"
```

---

### Task 5: GitHub Actions 发布工作流

**Files:**
- Create: `.github/workflows/publish.yml`
- Create: `README.md`（运维口径：触发方式、失败排查、cron 语义）
- Modify: `.gitignore`（确认含 `dist/`，已满足则不动）

**Interfaces:**
- Consumes: `node tools/publish-data.mjs --out dist`、`BASE_URL`、`WORKFLOW_URL`
- Produces: Pages 部署（发布源 = GitHub Actions）

- [ ] **Step 1: 写工作流**

```yaml
name: publish

on:
  schedule:
    - cron: '0 */6 * * *'          # UTC 00/06/12/18，即北京 08/14/20/02
  workflow_dispatch:
    inputs:
      scrape:
        description: '重新抓取源站（关闭则复用线上数据仅重新发布）'
        type: boolean
        default: true
  push:
    branches: [main]
    paths: ['web/**', 'sync/**', 'tools/**', 'dev/**', '.github/workflows/publish.yml']

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: publish-pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
        id: pages
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: 抓取并生成静态产物
        env:
          BASE_URL: ${{ steps.pages.outputs.base-url }}
          WORKFLOW_URL: ${{ github.server_url }}/${{ github.repository }}/actions/workflows/publish.yml
          # push 恒为透传；schedule 下 inputs.scrape 为 null，null == false 为假 → 抓取
          SKIP_SCRAPE: ${{ github.event_name == 'push' || inputs.scrape == false }}
        run: node tools/publish-data.mjs --out dist $([ "$SKIP_SCRAPE" = "true" ] && echo --skip-scrape)
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: 本地校验 YAML 与工作流语义**

```bash
node -e "const s=require('fs').readFileSync('.github/workflows/publish.yml','utf8');
  if (/^\t/m.test(s)) throw new Error('YAML 含 TAB');
  for (const k of ['0 */6 * * *','actions/configure-pages@v5','actions/upload-pages-artifact@v3','actions/deploy-pages@v4','cancel-in-progress: false'])
    if (!s.includes(k)) throw new Error('缺少 '+k);"
```
Expected: 无输出（不抛错）

- [ ] **Step 3: 写 README 运维口径**

`README.md` 覆盖：站点地址形态 `<owner>.github.io/<repo>`；数据陈旧度语义（6 小时上限 + Actions 调度不保证准时）；手动重跑路径（Actions → publish → Run workflow，`scrape` 开关含义）；某源站失败时看 `data/meta.json` 的 `sources[].error`；本地开发命令（`node --test dev/tests/*.test.mjs`、`node tools/publish-data.mjs --out dist`、`node dev/preview-server.mjs 5173 dist`）；**Pages 后台需手工设为 Source = GitHub Actions**（workflow 无法自我引导）。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish.yml README.md
git commit -m "ci: GitHub Actions 每 6 小时抓取并发布 Pages"
```

---

### Task 6: 生成 orphan 发布历史与推送交接

**Files:**
- Create: 本地分支 `pages-release`（单提交，不含 `main` 历史）

**Interfaces:**
- Consumes: `github-pages` 分支的最终树
- Produces: 可推送到新仓库 `main` 的 orphan 提交

- [ ] **Step 1: 确认最终树不含敏感描述符**

```bash
git -c core.quotepath=off ls-tree -r --name-only github-pages | grep -i "qoder.site"
```
Expected: 无输出。若有输出 → `git rm --cached` 后重新提交，不得继续。

- [ ] **Step 2: 用 plumbing 生成 orphan 提交（绝不动工作树）**

```bash
TREE=$(git rev-parse 'github-pages^{tree}')
REL=$(git commit-tree "$TREE" -m "showHub：西安演出集静态站（GitHub Pages + Actions 每 6h 抓取）")
git branch pages-release "$REL"
git -c core.quotepath=off ls-tree --name-only pages-release
```
Expected: `pages-release` 只有一个提交、无 parent（`git log --oneline pages-release | wc -l` = 1），顶层为 `.gitignore README.md dev docs sync tools web .github`。

- [ ] **Step 3: 输出推送交接清单（不代推送）**

推送需要用户侧凭据，且账号密码不能用于 HTTPS（GitHub 已禁用），交接内容：

1. 创建 public 仓库（建议名 `showHub`）。
2. `git remote add origin https://github.com/<owner>/showHub.git`
3. `git push -u origin pages-release:main`（PAT 需 `repo` + `workflow` 两个 scope；或改 SSH remote）。
4. 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。
5. Actions 页面手动 Run workflow 一次，验证 `https://<owner>.github.io/<repo>/` 有数据。
6. 提醒：对话中明文出现过的 GitHub 密码应按已泄露处理并修改。

- [ ] **Step 4: 把推送结果与风险实测结论回报用户**

包含：四源站从本机抓取的实际结果（Task 4 Step 5）、是否出现地域/防盗链问题的判断、以及下一步要在 Actions 里观察什么。

---

## Self-Review

**1. Spec coverage：** spec §2 数据流 → Task 2；§3 目录结构 → Task 1/3；§4 触发与调度 → Task 5；§5 数据契约 → Task 1/2；§6 前端改动 → Task 4；§7 测试策略 → Task 1/2/4 各自的测试步骤；§8 风险 1/3 由 Task 4 Step 5 与 Task 6 Step 4 承接，风险 5 → Task 6 Step 1/2，风险 6 → Global Constraints。spec §2「`scrape=false` 回读失败降级抓取」→ Task 2 Step 1 第 5 个用例。无遗漏。

**2. Placeholder scan：** Task 2 Step 3 的实现主体给了要点 + 关键片段而非整份文件（其余任务均为完整代码），因为该模块的行为契约已由 Step 1 的 7 个测试逐条锁定——这是本计划唯一处折衷，实现者按测试写即可，不存在 TBD。

**3. 类型一致性：** `queryShows`/`buildMeta`/`SHOW_FIELDS`/`MAX_ROWS`（Task 1 定义）与 Task 2/3 的引用一致；`Meta` 形状（`generated_at/lastSuccessAt/workflowUrl/sources/cleanup_deleted`）在 Task 2 实现、Task 4 消费、Task 5 传 `WORKFLOW_URL`，三处一致；`runPublish` 返回 `{ ok, degraded, counts, degradedFellBack }` 与测试断言一致；相对路径约定在 Task 4 Step 1 的测试与 Step 2 的 HTML 两侧同步。

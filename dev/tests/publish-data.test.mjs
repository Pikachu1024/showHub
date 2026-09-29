import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSeed, resolveBaseUrl, runPublish, seedStores } from '../../tools/publish-data.mjs';

const day = (n) => `2026-11-0${n}T11:30:00+08:00`;
// 在册来源默认用 snpac；dahepiao 已从 ADAPTERS 注销，用它当「已下线来源」
const show = (id, name, start, source = 'snpac') => ({
  id: `id-${id}`, source, source_id: id, name, city: '西安市',
  poster_url: '', start_time: '', start_at: start, end_time: start,
  price: '￥100起', min_price: 100, venue: '剧场', category: '音乐会',
  status: '售票中', buy_url: '', updated_at: start,
});

const snpacItem = (id, name) => ({
  id, fullCnName: name, extraPoster: 'https://t/1.jpg',
  startTime: '2026-11-05 19:30:00', endTime: '2026-11-05 21:00:00',
  minPrice: 100, maxPrice: 100, stadiumName: '西安音乐厅', venueName: '交响大厅',
  category: '音乐会', saleType: 'sale', stadiumCityCode: '610100', stadiumCityName: '西安市',
});

// maitix 两租户返回空列表，使抓取结果只含 snpac 给定的条目
const transportFor = (data) => async (url) => {
  const u = String(url);
  if (u.includes('snpac.com')) return Response.json({ success: true, data });
  if (u.includes('maitix.com')) return Response.json({ code: '200', data: { dataList: [], totalPage: 1 } });
  return new Response('not found', { status: 404 });
};
const live = () => transportFor([snpacItem(7000, '活着的演出')]);

const tmp = async () => mkdtemp(join(tmpdir(), 'showhub-dist-'));
const webDir = new URL('../../web/', import.meta.url);

test('resolveBaseUrl 优先用 BASE_URL，其次由仓库名推导 project Pages 地址', () => {
  assert.equal(resolveBaseUrl({ BASE_URL: 'https://pika.github.io/showHub' }), 'https://pika.github.io/showHub');
  assert.equal(resolveBaseUrl({ BASE_URL: 'https://x.github.io/' }), 'https://x.github.io');
  assert.equal(
    resolveBaseUrl({ GITHUB_REPOSITORY_OWNER: 'pika', GITHUB_REPOSITORY: 'pika/showHub' }),
    'https://pika.github.io/showHub'
  );
  assert.equal(resolveBaseUrl({}), '');
});

test('readSeed 首跑 404 → 空表 + degraded 原因，不抛错', async () => {
  const res = await readSeed({ baseUrl: 'https://pika.github.io/showHub', transport: transportFor([]) });
  assert.deepEqual(res.shows, []);
  assert.equal(res.meta, null);
  assert.match(res.degraded, /seed_missing/);
});

test('readSeed 无 baseUrl（本地首跑/预览）→ 同样降级为空表', async () => {
  const res = await readSeed({ baseUrl: '', transport: transportFor([]) });
  assert.deepEqual(res.shows, []);
  assert.match(res.degraded, /no_base_url/);
});

test('runPublish 清理 seed 中的过期行，导出含 updated_at 与静态资源', async () => {
  const out = await tmp();
  const stale = show('old', '已过期老演出', '2020-01-01T11:30:00+08:00');
  const seedTransport = async (url) => {
    if (String(url).endsWith('data/shows.json')) return Response.json({ generated_at: 'x', shows: [stale] });
    if (String(url).endsWith('data/meta.json')) return new Response('nope', { status: 404 });
    return live()(url);
  };
  const res = await runPublish({
    out, baseUrl: 'https://pika.github.io/showHub', scrape: true,
    transport: seedTransport, webDir, now: () => new Date('2026-11-04T00:00:00+08:00'),
  });
  const body = JSON.parse(await readFile(join(out, 'data', 'shows.json'), 'utf8'));
  assert.deepEqual(body.shows.map((s) => s.name), ['活着的演出'], 'seed 里过期的行必须被 cleanup 删除');
  assert.ok(body.shows[0].updated_at, '导出必须含 updated_at');
  assert.equal(res.counts.deleted, 1);
  assert.match(res.degraded, /meta_missing/);
  assert.ok((await readdir(out)).includes('index.html'), 'dist 必须含静态资源');
});

// 下线一个来源不该只是不再抓：上一次发布里它的旧行也必须从站点消失
test('runPublish 丢弃 seed 中未在册来源的旧行', async () => {
  const out = await tmp();
  const rows = [show('keep', '在册演出', day(6)), show('gone', '已下线来源演出', day(6), 'dahepiao')];
  const transport = async (url) => {
    if (String(url).endsWith('data/shows.json')) return Response.json({ generated_at: 'g', shows: rows });
    if (String(url).endsWith('data/meta.json')) {
      return Response.json({ generated_at: 'g', lastSuccessAt: 'l', workflowUrl: null, sources: [], cleanup_deleted: 0 });
    }
    return live()(url);
  };
  await runPublish({ out, baseUrl: 'https://x', scrape: true, transport, webDir, now: () => new Date('2026-11-04T00:00:00+08:00') });
  const body = JSON.parse(await readFile(join(out, 'data', 'shows.json'), 'utf8'));
  assert.ok(!body.shows.some((s) => s.source === 'dahepiao'), '已注销来源的残留行不得再出现在站上');
  assert.deepEqual(body.shows.map((s) => s.name).sort(), ['在册演出', '活着的演出']);
});

test('runPublish scrape=false 原样透传线上数据，绝不发起抓取', async () => {
  const out = await tmp();
  const calls = [];
  const passthrough = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('data/shows.json')) return Response.json({ generated_at: 'g', shows: [show('k', '透传演出', day(6))] });
    if (String(url).endsWith('data/meta.json')) {
      return Response.json({ generated_at: 'g', lastSuccessAt: 'l', workflowUrl: null, sources: [], cleanup_deleted: 0 });
    }
    throw new Error(`不应请求 ${url}`);
  };
  const res = await runPublish({ out, baseUrl: 'https://x', scrape: false, transport: passthrough, webDir });
  const body = JSON.parse(await readFile(join(out, 'data', 'shows.json'), 'utf8'));
  assert.deepEqual(body.shows.map((s) => s.name), ['透传演出']);
  assert.deepEqual(calls.sort(), ['https://x/data/meta.json', 'https://x/data/shows.json']);
  assert.equal(res.degradedFellBack, false);
});

test('runPublish scrape=false 但线上无 meta 时降级为完整抓取，不发布空站', async () => {
  const out = await tmp();
  const res = await runPublish({
    out, baseUrl: 'https://pika.github.io/showHub', scrape: false,
    transport: async (url) => (String(url).includes('/data/') ? new Response('gone', { status: 404 }) : live()(url)),
    webDir,
  });
  assert.equal(res.degradedFellBack, true);
  const body = JSON.parse(await readFile(join(out, 'data', 'shows.json'), 'utf8'));
  assert.equal(body.shows.length, 1);
});

test('seedStores 在首次 from() 之前灌入行（builder 创建时快照行引用）', async () => {
  const supabase = seedStores([show('a', 'A', day(6))]);
  const rows = await supabase.from('shows').select('source_id');
  assert.deepEqual(rows.data.map((r) => r.source_id), ['a']);
});

test('meta.json 写入 workflowUrl 供前端「查看抓取任务」链接', async () => {
  const out = await tmp();
  await runPublish({
    out, baseUrl: 'https://x', scrape: true,
    workflowUrl: 'https://github.com/pika/showHub/actions/workflows/publish.yml',
    transport: live(), webDir,
  });
  const meta = JSON.parse(await readFile(join(out, 'data', 'meta.json'), 'utf8'));
  assert.equal(meta.workflowUrl, 'https://github.com/pika/showHub/actions/workflows/publish.yml');
  assert.ok(meta.sources.some((s) => s.source === 'snpac' && s.status === 'success'));
  assert.equal(meta.sources.length, 3, '在册来源应为三个');
});

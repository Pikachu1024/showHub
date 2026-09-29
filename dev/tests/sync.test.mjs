import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../../sync/sync.mjs';
import { fakeSupabase } from '../fake-supabase.mjs';

const fixedNow = () => new Date('2026-10-10T08:00:00+08:00');

// 三个来源各 1 条 + 2 条非西安（maitix 宝鸡市、snpac 深圳市，均应被过滤）+ 1 条已过期（应被清理）
const dahepiaoHtml = `
<div class="ycList list-grid flex">
  <a href="https://m.dahepiao.com/yanchupiaowu1/2018091946076.html" class="s_left"><img src="https://img.dahepiao.com/p/1.jpg"></a>
  <div class="s_right">
    <a href="https://m.dahepiao.com/yanchupiaowu1/2018091946076.html" class="l1 line1">测试演出A </a>
    <div class="l2 line1">2026-11-01 周日 19:30</div>
    <div class="l3 line1">西安测试场馆</div>
    <div class="l4"><span>订金预售</span></div>
    <div class="l5">￥<em>150</em>起</div>
  </div>
</div>`;

const maitixBody = (items) => ({ code: '200', data: { dataList: items, totalPage: 1 } });
// startTime/endTime 需晚于 fixedNow + 保留期（否则会被 cleanup 当过期行删除，与下方“仅 1 条过期”断言矛盾）
const maitixItem = (token, city = '西安市') => ({
  projectToken: token, projectName: `maitix-${token}`, imgUrl: 'https://img/1.jpg',
  cityName: city, siteName: '西演SPACE', projectTypeName: '话剧',
  startTime: 1793900000000, endTime: 1794000000000, minPrice: 80, maxPrice: 280, sellOut: false,
});
const snpacItem = (id, name, cityCode = '610100', cityName = '西安市', stadium = '西安·开元大剧院') => ({ id, fullCnName: name, extraPoster: 'https://t/1.jpg', startTime: '2026-11-13 19:30:00', endTime: '2026-11-14 21:50:00', minPrice: 70, maxPrice: 780, stadiumName: stadium, venueName: '大剧场', category: '话剧', saleType: 'sale', stadiumCityCode: cityCode, stadiumCityName: cityName });
// 深圳市条目（440300）应被 fetchSnpac 按 stadiumCityCode 过滤，runSync 落库不应出现
const snpacBody = { success: true, data: [snpacItem(6198, 'snpac-测试'), snpacItem(6135, 'snpac-深圳', '440300', '深圳市', '深圳音乐厅')] };

function makeTransport() {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.includes('dahepiao.com')) return new Response(dahepiaoHtml, { status: 200 });
    if (u.includes('client.maitix.com')) {
      const referer = init.headers && init.headers.Referer;
      const items = referer && referer.includes('xaetys') ? [maitixItem('30')] : [maitixItem('20'), maitixItem('21', '宝鸡市')];
      return Response.json(maitixBody(items));
    }
    if (u.includes('snpac.com')) return Response.json(snpacBody);
    throw new Error('unexpected url ' + u);
  };
}

test('runSync 四来源写入、过滤非西安、upsert 去重、清理过期', async () => {
  const supabase = fakeSupabase();
  // 预置：1 条已过期（end_time 30 天前）+ 1 条 maitix 旧记录（价格变化验证 update）
  const expiredEnd = new Date(fixedNow().getTime() - 30 * 86400000).toISOString();
  supabase._tables.set('shows', [
    { id: 'old-1', source: 'dahepiao', source_id: '999', name: '过期演出', poster_url: '', start_time: '', start_at: null, end_time: expiredEnd, price: '', city: '西安', venue: '', category: '演出', status: '', buy_url: '', updated_at: expiredEnd },
    { id: 'old-2', source: 'maitix-dhjc', source_id: '20', name: 'maitix-20-旧名', poster_url: 'https://img/old.jpg', start_time: '', start_at: null, end_time: null, price: '1元', city: '西安市', venue: '西演SPACE', category: '话剧', status: '售票中', buy_url: '', updated_at: expiredEnd },
  ]);

  const first = await runSync({ supabase, transport: makeTransport(), sleep: async () => {}, now: fixedNow });
  // 来源结果：dahepiao success, maitix-dhjc success, maitix-xaetys success, snpac success
  assert.deepEqual(first.results.map((r) => r.source), ['dahepiao', 'maitix-dhjc', 'maitix-xaetys', 'snpac']);
  assert.ok(first.results.every((r) => r.status === 'success'), JSON.stringify(first.results));
  assert.equal(first.results.find((r) => r.source === 'maitix-dhjc').fetched, 1, '宝鸡条目应被过滤');
  assert.equal(first.results.find((r) => r.source === 'snpac').fetched, 1, 'snpac 深圳条目应被过滤，仅存西安 1 条');
  assert.equal(first.deleted, 1, '过期记录应删除 1 条');

  const shows = supabase._tables.get('shows');
  // 3 新增（dahepiao + xaetys + snpac）+ old-2 即 dhjc/20 被 upsert 合并更新 = 4 行；过期 1 行删除（upsert 去重）
  assert.equal(shows.length, 4);
  const updated = shows.find((r) => r.source === 'maitix-dhjc' && r.source_id === '20');
  assert.equal(updated.name, 'maitix-20');
  assert.equal(updated.price, '80-280元');
  assert.ok(!shows.some((r) => r.city === '宝鸡市'));
  // 非西安过滤需覆盖 snpac：深圳条目既不得入库，city 也不得冒充西安
  assert.ok(!shows.some((r) => r.venue.includes('深圳音乐厅')), 'snpac 深圳条目不得入库');
  assert.ok(!shows.some((r) => r.city === '深圳市'));
  assert.ok(shows.every((r) => r.city.includes('西安')), '所有落库行 city 均应含西安');

  // runSync 落库的每一行都应带有 min_price 数字列
  assert.ok(shows.every((r) => 'min_price' in r), '所有 shows 行应含 min_price 键');
  assert.equal(shows.find((r) => r.source === 'dahepiao').min_price, 150);
  assert.equal(updated.min_price, 80);
  assert.equal(shows.find((r) => r.source === 'maitix-xaetys').min_price, 80);
  assert.equal(shows.find((r) => r.source === 'snpac').min_price, 70);

  const logs = supabase._tables.get('sync_log');
  assert.equal(logs.filter((r) => r.source !== 'cleanup').length, 4);
  assert.ok(logs.every((r) => r.id && r.started_at && r.finished_at));

  // 第二次运行：全为 update，无新增
  const second = await runSync({ supabase, transport: makeTransport(), sleep: async () => {}, now: fixedNow });
  assert.equal(second.results.find((r) => r.source === 'snpac').inserted, 0);
  assert.equal(second.results.find((r) => r.source === 'snpac').updated, 1);
  assert.equal(second.deleted, 0);
  // upsert 必须复用已存在行的主键，二次运行后 old-2 的 id 不被改写
  const kept = supabase._tables.get('shows').find((r) => r.source === 'maitix-dhjc' && r.source_id === '20');
  assert.equal(kept.id, 'old-2');
});

test('runSync 单来源失败不影响其他来源并记录错误', async () => {
  const supabase = fakeSupabase();
  const failing = async (url, init = {}) => {
    if (String(url).includes('dahepiao.com')) return new Response('x', { status: 500 });
    return makeTransport()(url, init);
  };
  const { results } = await runSync({ supabase, transport: failing, sleep: async () => {}, now: fixedNow });
  const dahepiao = results.find((r) => r.source === 'dahepiao');
  assert.equal(dahepiao.status, 'error');
  assert.match(dahepiao.error, /dahepiao_http_500/);
  assert.equal(results.filter((r) => r.status === 'success').length, 3);
  assert.equal(supabase._tables.get('shows').filter((r) => r.source === 'snpac').length, 1);
});

test('cleanup 兜底删除 end_time 为 NULL 且 30 天未更新的行，保留近期行', async () => {
  const supabase = fakeSupabase();
  const staleAt = new Date(fixedNow().getTime() - 40 * 86400000).toISOString();
  const freshAt = new Date(fixedNow().getTime() - 60000).toISOString();
  const mk = (id, updatedAt) => ({
    id, source: 'dahepiao', source_id: id, name: `null-end-${id}`, poster_url: '', start_time: '',
    start_at: null, end_time: null, price: '', city: '西安', venue: '', category: '演出', status: '',
    buy_url: '', updated_at: updatedAt,
  });
  supabase._tables.set('shows', [mk('null-stale', staleAt), mk('null-fresh', freshAt)]);

  const { deleted } = await runSync({ supabase, transport: makeTransport(), sleep: async () => {}, now: fixedNow });
  assert.equal(deleted, 1, '仅 stale 的 NULL end_time 行应被兜底删除');

  const cleanupLog = supabase._tables.get('sync_log').find((r) => r.source === 'cleanup');
  assert.equal(cleanupLog.deleted, 1, 'cleanup 日志 deleted 应为两段删除合计');

  const shows = supabase._tables.get('shows');
  assert.ok(!shows.some((r) => r.id === 'null-stale'), '40 天未更新的 NULL 行应被删除');
  assert.ok(shows.some((r) => r.id === 'null-fresh'), '刚更新的 NULL 行应保留');
});

// 静态发布把上一次导出的 JSON 当 seed 回灌，因此「带 seed 重跑」必须与首轮收敛到同一集合。
test('同一 seed 连跑两次结果幂等（seed 回读失败可安全退化为全量重抓）', async () => {
  const first = fakeSupabase();
  await runSync({ supabase: first, transport: makeTransport(), sleep: async () => {}, now: fixedNow });
  const seedRows = (await first.from('shows').select('*')).data.map((r) => ({ ...r }));

  const second = fakeSupabase();
  second._tables.set('shows', seedRows.map((r) => ({ ...r })));
  const b = await runSync({ supabase: second, transport: makeTransport(), sleep: async () => {}, now: fixedNow });

  const keyOf = (supa) => supa._tables.get('shows').map((r) => `${r.source}/${r.source_id}`).sort().join('|');
  assert.equal(keyOf(second), keyOf(first), '第二次运行不得增删行');
  assert.equal(b.results.reduce((n, r) => n + r.inserted, 0), 0, '第二次运行 inserted 必须为 0');
  assert.deepEqual(
    second._tables.get('shows').map((r) => r.id).sort(),
    first._tables.get('shows').map((r) => r.id).sort(),
    '复用旧行主键，不得每次同步改写 id'
  );
});

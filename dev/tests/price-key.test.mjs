import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { queryShows } from '../../tools/show-query.mjs';
import { fakeSupabase } from '../fake-supabase.mjs';

// 用 node:vm 读取并执行真实文件 web/price-key.js（经典脚本，非 ES module），
// 从沙箱全局命名空间取函数——测的是浏览器实际加载的同一份代码，而非复制实现。
const source = readFileSync(new URL('../../web/price-key.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { priceKeyOf, sortShows, timeKeyOf, compareShows } = sandbox.globalThis.ShowHubPrice;

test('price-key.js 是经典脚本：可被 vm 以非 module 方式执行且暴露全部四个函数', () => {
  assert.equal(typeof priceKeyOf, 'function');
  assert.equal(typeof timeKeyOf, 'function');
  assert.equal(typeof compareShows, 'function');
  assert.equal(typeof sortShows, 'function');
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'web/price-key.js 不得含 ES module 语法');
});

// —— priceKeyOf：后端 min_price 优先，旧数据（无 min_price 值）从 price 文本兜底 ——

test('priceKeyOf 后端 min_price 为 null 的旧行从 price 文本兜底解析', () => {
  assert.equal(priceKeyOf({ min_price: null, price: '￥150起' }), 150);
});

test('priceKeyOf min_price undefined 且 price 文本无数字归免费档 0', () => {
  assert.equal(priceKeyOf({ min_price: undefined, price: '免费/暂无价格' }), 0);
});

test('priceKeyOf 后端数值优先于 price 文本', () => {
  assert.equal(priceKeyOf({ min_price: 80, price: '￥150起' }), 80);
  assert.equal(priceKeyOf({ min_price: 0, price: '￥150起' }), 0, '后端免费档 0 不得被文本数字覆盖');
});

test('priceKeyOf 负的 min_price clamp 到免费档 0（脏数据不得透传负值）', () => {
  assert.equal(priceKeyOf({ min_price: -5, price: '' }), 0);
});

test('priceKeyOf 字段全缺失/非法类型安全归 0', () => {
  assert.equal(priceKeyOf({}), 0);
  assert.equal(priceKeyOf({ min_price: null, price: null }), 0);
  assert.equal(priceKeyOf({ min_price: 'x', price: undefined }), 0);
  assert.equal(priceKeyOf({ min_price: NaN, price: '90-280元' }), 90, 'NaN 非有限值走文本兜底');
});

// —— sortShows：前端二次排序 (时间, priceKeyOf, name) 三者升序 ——

test('sortShows 不修改输入数组（渲染前 .slice() 拷贝）', () => {
  const b = { name: 'b', start_at: '2026-11-02T19:30:00+08:00', price: '', min_price: 0 };
  const a = { name: 'a', start_at: '2026-11-01T19:30:00+08:00', price: '', min_price: 100 };
  const input = [b, a];
  const out = sortShows(input);
  assert.notEqual(out, input, '必须返回新数组');
  assert.deepEqual(input.map((r) => r.name), ['b', 'a'], '原数组顺序不得被原地改动');
  assert.deepEqual(out.map((r) => r.name), ['a', 'b']);
});

test('sortShows 时间键：start_at 优先，取不到回退 end_time，都取不到排最后', () => {
  const t1 = { name: 't1', start_at: '2026-11-01T19:30:00+08:00', min_price: 999 };
  const byEnd = { name: 'byEnd', start_at: null, end_time: '2026-11-02T19:30:00+08:00', min_price: 0 };
  const noTime = { name: 'noTime', start_at: '时间待定', end_time: null, min_price: 0 };
  const t0 = { name: 't0', start_at: '2026-10-31T19:30:00+08:00', min_price: 0 };
  // byEnd 的 start_at 为 null，按 end_time(11-02) 落在 t1(11-01) 与 noTime 之间，
  // 证明回退键生效（否则会被当成无时间排到最后）
  assert.deepEqual(
    sortShows([noTime, byEnd, t1, t0]).map((r) => r.name),
    ['t0', 't1', 'byEnd', 'noTime'],
    '时间升序、start_at 缺失回退 end_time、都取不到的行排最后'
  );
});

test('sortShows 同时间档内按 priceKeyOf 升序，旧行用兜底键插入正确位置', () => {
  const day = '2026-11-05T19:30:00+08:00';
  const stale150 = { name: 's150', start_at: day, min_price: null, price: '￥150起' };
  const fresh80 = { name: 'f080', start_at: day, min_price: 80, price: '80元' };
  const fresh0 = { name: 'f000', start_at: day, min_price: 0, price: '免费/暂无价格' };
  const staleTbd = { name: 's-tbd', start_at: day, min_price: null, price: '价格待定' };
  assert.deepEqual(
    sortShows([stale150, fresh80, fresh0, staleTbd]).map((r) => r.name),
    ['f000', 's-tbd', 'f080', 's150'],
    '待定旧行归免费档与 0 同档、按名称排序；150 旧行排在 80 之后'
  );
});

test('sortShows 同时间同价按名称 localeCompare(zh-Hans-CN) 升序', () => {
  const ying = { name: '英', start_at: '2026-11-01T00:00:00+08:00', min_price: 0 };
  const an = { name: '安', start_at: '2026-11-01T00:00:00+08:00', min_price: 0 };
  assert.deepEqual(sortShows([ying, an]).map((r) => r.name), ['安', '英']);
  assert.equal(compareShows({ name: '安', start_at: '', min_price: 0 }, { name: '英', start_at: '', min_price: 0 }),
    '安'.localeCompare('英', 'zh-Hans-CN'));
});

// —— 旧数据模拟验证（核心证明）——
// 第二个预览实例等价物：直接向 fake-supabase 的 shows 表插入 min_price 为 NULL、
// price 文本带价格的历史行（模拟 min_price 列新增之前同步入库的线上旧数据），
// 经静态导出的同一查询读出后，在浏览器外用 node 断言前端自足逻辑。
// 名称前缀 A-D 保证同档排序断言与 zh 拼音细则无关（ASCII 升序即可判定）。
test('旧数据模拟：min_price 为 NULL 的旧行经导出查询读出后仍能被正确筛选与排序', async () => {
  const supabase = fakeSupabase();
  const stalePaid = {
    // 旧行：入库于 min_price 列新增之前 → 该列为 NULL，但 price 文本带价
    name: 'D-旧数据有价格', source: 'dahepiao', source_id: 'st-1', poster_url: '', start_time: '2026-11-08 周日 19:30',
    start_at: '2026-11-08T19:30:00+08:00', end_time: '2026-11-08T19:30:00+08:00', price: '￥150起',
    min_price: null, city: '西安', venue: '西安测试场馆', category: '演出', status: '售票中', buy_url: '',
  };
  const staleTbd = { ...stalePaid, source_id: 'st-2', name: 'B-旧数据价格待定', price: '价格待定' };
  const freshFree = { ...stalePaid, source_id: 'fr-1', name: 'A-新数据免费', min_price: 0, price: '免费/暂无价格' };
  const fresh80 = { ...stalePaid, source_id: 'fr-2', name: 'C-新数据八十', min_price: 80, price: '80元' };
  await supabase.from('shows').insert([stalePaid, staleTbd, freshFree, fresh80]);

  const items = await queryShows(supabase);
  assert.equal(items.length, 4);

  // 后端仍会把旧行的 min_price 原样（NULL）吐出——修复必须不依赖重新同步
  const stale = items.find((i) => i.name === 'D-旧数据有价格');
  assert.equal(stale.min_price, null, '前提：旧行 min_price 为 NULL');

  // 断言 1：priceKeyOf 对旧行返回解析出的数字而不是 0
  assert.equal(priceKeyOf(stale), 150);
  assert.equal(priceKeyOf(items.find((i) => i.name === 'B-旧数据价格待定')), 0);

  // 断言 2：免费筛选（新口径 priceKeyOf(item)===0）不再命中全部旧行——
  // 有价格的旧行被正确排除，价格待定/免费行保留（用户裁定同档）
  const freeView = items.filter((i) => priceKeyOf(i) === 0).map((i) => i.name);
  assert.deepEqual(freeView, ['A-新数据免费', 'B-旧数据价格待定']);

  // 断言 3：前端二次排序把旧行排在正确位置（免费档 0 < 80 < 兜底 150，同日内）
  assert.deepEqual(
    sortShows(items).map((i) => i.name),
    ['A-新数据免费', 'B-旧数据价格待定', 'C-新数据八十', 'D-旧数据有价格']
  );

  // 断言 4：二次排序不改导出数组本身之外的输入语义——sortShows 返回新数组
  assert.notEqual(sortShows(items), items);
});

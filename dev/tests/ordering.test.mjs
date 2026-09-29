import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from '../fake-supabase.mjs';

// 对齐真实 PostgREST：多次 .order() 按调用顺序构成优先级递减的多键排序。
// b 行 min_price 为 NULL，模拟线上旧数据（min_price 列新增前同步入库的历史行）。
test('多次 .order() 链式调用构成优先级递减的多键排序（null 最后）', async () => {
  const supabase = fakeSupabase();
  await supabase.from('shows').insert([
    { name: 'a', start_at: '2026-11-02T00:00:00+08:00', min_price: 100 },
    { name: 'b', start_at: '2026-11-01T00:00:00+08:00', min_price: null },
    { name: 'c', start_at: '2026-11-01T00:00:00+08:00', min_price: 0 },
    { name: 'd', start_at: null, min_price: 50 },
    { name: 'e', start_at: '2026-11-01T00:00:00+08:00', min_price: 80 },
    { name: 'f', start_at: '2026-11-01T00:00:00+08:00', min_price: 0 },
  ]);
  const { data } = await supabase.from('shows')
    .select('name,start_at,min_price')
    .order('start_at', { ascending: true, nullsFirst: false })
    .order('min_price', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });
  // start_at 升序（null 最后）；同日内 min_price 升序（null 最后）；同价按 name 升序
  assert.deepEqual(data.map((r) => r.name), ['c', 'f', 'e', 'b', 'a', 'd']);
});

test('三级排序对 null 主键组的内部仍按次键排序', async () => {
  const supabase = fakeSupabase();
  await supabase.from('shows').insert([
    { name: 'x', start_at: null, min_price: 200 },
    { name: 'y', start_at: null, min_price: 30 },
    { name: 'z', start_at: '2026-11-01T00:00:00+08:00', min_price: null },
  ]);
  const { data } = await supabase.from('shows')
    .select('name')
    .order('start_at', { ascending: true, nullsFirst: false })
    .order('min_price', { ascending: true, nullsFirst: false });
  assert.deepEqual(data.map((r) => r.name), ['z', 'y', 'x']);
});

test('单列 order 不回退：降序、null 最后', async () => {
  const supabase = fakeSupabase();
  await supabase.from('t').insert([
    { name: 'a', finished_at: '2026-10-02T00:00:00Z' },
    { name: 'b', finished_at: null },
    { name: 'c', finished_at: '2026-10-03T00:00:00Z' },
  ]);
  const { data } = await supabase.from('t')
    .select('name')
    .order('finished_at', { ascending: false })
    .range(0, 29);
  assert.deepEqual(data.map((r) => r.name), ['c', 'a', 'b']);
});

// 线上旧数据场景：min_price 列新增之前同步入库的行该列全为 NULL。
// Task D 把新同步数据的空值语义改为 0，但 nullsFirst:false 保留 —— 历史 NULL 行
// 在后端价格键排序中仍应排在有值行之后（前端二次排序负责它们的相对位置）。
test('min_price 为 NULL 的历史行排在有值行之后（模拟线上旧数据）', async () => {
  const supabase = fakeSupabase();
  await supabase.from('shows').insert([
    { name: 'stale-a', start_at: '2026-11-01T00:00:00+08:00', min_price: null },
    { name: 'stale-b', start_at: '2026-11-01T00:00:00+08:00', min_price: null },
    { name: 'fresh-100', start_at: '2026-11-01T00:00:00+08:00', min_price: 100 },
    { name: 'fresh-0', start_at: '2026-11-01T00:00:00+08:00', min_price: 0 },
  ]);
  const { data } = await supabase.from('shows')
    .select('name,min_price')
    .order('start_at', { ascending: true, nullsFirst: false })
    .order('min_price', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });
  assert.deepEqual(data.map((r) => r.name), ['fresh-0', 'fresh-100', 'stale-a', 'stale-b']);
  assert.deepEqual(data.map((r) => r.min_price), [0, 100, null, null]);
});

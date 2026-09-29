import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOW_FIELDS, MAX_ROWS, queryShows } from '../../tools/show-query.mjs';
import { fakeSupabase } from '../fake-supabase.mjs';

test('queryShows 投影含 updated_at（seed 回读后清理脏行的唯一依据）', () => {
  assert.ok(SHOW_FIELDS.split(',').includes('updated_at'));
  assert.equal(MAX_ROWS, 2000);
});

test('queryShows 三键排序与原 list 端点语义一致（时间→价格→名称，null 靠后）', async () => {
  const supabase = fakeSupabase();
  await supabase.from('shows').insert([
    { name: 'b', start_at: '2026-11-02T00:00:00+08:00', min_price: 100, updated_at: 'u1' },
    { name: 'a', start_at: '2026-11-01T00:00:00+08:00', min_price: null, updated_at: 'u2' },
    { name: 'c', start_at: null, min_price: 0, updated_at: 'u3' },
  ]);
  const rows = await queryShows(supabase);
  assert.deepEqual(rows.map((r) => r.name), ['a', 'b', 'c'], 'start_at 为 null 的行必须排最后');
  // 投影按 SHOW_FIELDS 补齐缺失列为 null，故只断言本用例关心的键
  assert.equal(rows[0].updated_at, 'u2');
  assert.equal(rows[0].min_price, null);
  assert.equal(Object.keys(rows[0]).length, SHOW_FIELDS.split(',').length, '投影列数必须与 SHOW_FIELDS 一致');
});

test('queryShows 超过 MAX_ROWS 时截断且不报错', async () => {
  const supabase = fakeSupabase();
  const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
    name: `s${i}`, start_at: `2026-11-01T00:00:0${i % 9}+08:00`, min_price: i,
  }));
  await supabase.from('shows').insert(many);
  const rows = await queryShows(supabase);
  assert.equal(rows.length, MAX_ROWS);
});

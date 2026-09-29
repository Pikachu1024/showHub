import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShowDate, toIsoFromMs, msToCSText, formatPriceRange, isXian, toMinPrice, parseMinPriceText } from '../../sync/normalize.mjs';

test('parseShowDate 解析带星期的时间文本', () => {
  assert.equal(parseShowDate('2024-08-18 周日 20:00'), '2024-08-18T20:00:00+08:00');
});

test('parseShowDate 解析纯日期', () => {
  assert.equal(parseShowDate('2024-08-18'), '2024-08-18T00:00:00+08:00');
});

test('parseShowDate 非法输入返回 null', () => {
  assert.equal(parseShowDate('待定'), null);
  assert.equal(parseShowDate(''), null);
  assert.equal(parseShowDate(null), null);
});

test('toIsoFromMs 与 msToCSText 输出 UTC 与北京时间', () => {
  // 2026-10-01 19:30 北京 = 2026-10-01 11:30 UTC
  const ms = Date.parse('2026-10-01T19:30:00+08:00');
  assert.equal(toIsoFromMs(ms), '2026-10-01T11:30:00.000Z');
  assert.equal(msToCSText(ms), '2026-10-01 19:30');
});

test('formatPriceRange 区间/单一/免费', () => {
  assert.equal(formatPriceRange(90, 280), '90-280元');
  assert.equal(formatPriceRange(150, 150), '150元');
  assert.equal(formatPriceRange(0, 0), '免费/暂无价格');
  assert.equal(formatPriceRange('x', 'y'), '免费/暂无价格');
});

test('isXian 匹配西安市', () => {
  assert.equal(isXian('西安市'), true);
  assert.equal(isXian('西安'), true);
  assert.equal(isXian('宝鸡市'), false);
});

test('toMinPrice 数字与字符串数字取整为非负整数', () => {
  assert.equal(toMinPrice(150), 150);
  assert.equal(toMinPrice('80'), 80);
  assert.equal(toMinPrice('90'), 90, '字符串 "90" 应解析为 90');
  assert.equal(toMinPrice(70.0), 70);
  assert.equal(toMinPrice('8.6'), 9);
});

test('toMinPrice 0 与字符串 "0" 返回 0（免费判定可用）', () => {
  assert.equal(toMinPrice(0), 0);
  assert.equal(toMinPrice('0'), 0);
});

// 新语义（用户裁定）：未知价 = 免费档，min_price 恒为 number，不再有 null。
// min_price 既是筛选键也是排序键，null 会让两者退化（免费全命中、价格排序失效）。
test('toMinPrice 负数/非法/缺失归免费档 0', () => {
  assert.equal(toMinPrice(-5), 0);
  assert.equal(toMinPrice('abc'), 0);
  assert.equal(toMinPrice(NaN), 0);
  assert.equal(toMinPrice(Infinity), 0);
  assert.equal(toMinPrice(undefined), 0);
});

test('toMinPrice null/空串/纯空白归 0（未知价与免费同档，用户裁定）', () => {
  assert.equal(toMinPrice(null), 0, '未知价归免费档 0：null 会让筛选与排序双双退化');
  assert.equal(toMinPrice(''), 0);
  assert.equal(toMinPrice('  '), 0);
});

test('parseMinPriceText 从价格文本抽第一个数字', () => {
  assert.equal(parseMinPriceText('￥150起'), 150);
  assert.equal(parseMinPriceText('90-280元'), 90);
  assert.equal(parseMinPriceText('¥8.0'), 8);
});

test('parseMinPriceText 无数字文本与非字符串归免费档 0（未知价=免费，用户裁定）', () => {
  assert.equal(parseMinPriceText('价格待定'), 0);
  assert.equal(parseMinPriceText('免费/暂无价格'), 0);
  assert.equal(parseMinPriceText(''), 0);
  assert.equal(parseMinPriceText(null), 0);
  assert.equal(parseMinPriceText(150), 0);
});

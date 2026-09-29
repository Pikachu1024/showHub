import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapSnpacProgram, fetchSnpac } from '../../sync/snpac.mjs';

const body = JSON.parse(readFileSync(new URL('../fixtures/snpac.json', import.meta.url), 'utf8'));
const item = body.data[0];
// fixture 为陕西大剧院院线全国巡场列表：含深圳市（440300）与天津市（120000）各 1 条，
// 过滤后仅保留西安条目，各类计数断言以此为准。
const xianCount = body.data.filter((d) => {
  const code = String(d.stadiumCityCode ?? '');
  return code ? code === '610100' : String(d.stadiumCityName ?? '').includes('西安');
}).length;

test('mapSnpacProgram 字段映射', () => {
  const r = mapSnpacProgram(item);
  assert.equal(r.source, 'snpac');
  assert.equal(r.source_id, String(item.id));
  assert.equal(r.name, item.fullCnName);
  assert.equal(r.poster_url, item.extraPoster ?? item.verticalPoster);
  assert.equal(r.start_at, item.startTime.replace(' ', 'T') + '+08:00');
  assert.equal(r.end_time, item.endTime.replace(' ', 'T') + '+08:00');
  assert.ok(r.price.length > 0);
  assert.equal(r.min_price, 70, 'fixture 首条 minPrice 70.0 应归一化为 70');
  assert.ok(r.venue.includes(item.stadiumName));
  assert.equal(r.city, '西安市', 'city 应取自 stadiumCityName，而非硬编码');
  assert.equal(r.buy_url, `https://www.snpac.com/sxtheatre/index.html#/ticket/detail/${item.id}`);
});

test('mapSnpacProgram city 取 stadiumCityName 且保持非空', () => {
  assert.equal(mapSnpacProgram({ ...item, stadiumCityName: '西安市' }).city, '西安市');
  assert.equal(mapSnpacProgram({ ...item, stadiumCityName: null }).city, '西安', 'stadiumCityName 缺失回退 西安');
  assert.equal(mapSnpacProgram({ ...item, stadiumCityName: '' }).city, '西安', '空串不得产生空 city');
});

test('mapSnpacProgram 海报缺省与状态', () => {
  const noPoster = mapSnpacProgram({ ...item, extraPoster: null, verticalPoster: null });
  assert.equal(noPoster.poster_url, '');
  const selling = mapSnpacProgram({ ...item, saleType: 'sale' });
  assert.equal(selling.status, '售票中');
  const noPrice = mapSnpacProgram({ ...item, minPrice: undefined, maxPrice: undefined });
  assert.equal(noPrice.min_price, 0, 'minPrice 缺失时归免费档 0（未知价=免费，新语义不再有 null）');
});

test('fetchSnpac 发送 cmpappkey 头并返回映射结果', async () => {
  let headers = null;
  const transport = async (url, init) => {
    headers = init.headers;
    return Response.json(body);
  };
  const records = await fetchSnpac({ transport });
  assert.equal(headers['cmpappkey'], 'SXtheatre');
  assert.equal(records.length, xianCount, '应仅保留 fixture 中的西安条目');
  assert.ok(records.every((r) => r.source === 'snpac'));
  assert.ok(records.every((r) => r.city === '西安市'), '保留条目 city 应来自 stadiumCityName');
});

test('fetchSnpac 按 stadiumCity 过滤非西安条目', async () => {
  const sz = body.data.find((d) => String(d.stadiumCityCode) === '440300');
  const tjj = body.data.find((d) => String(d.stadiumCityCode) === '120000');
  assert.ok(sz && tjj, 'fixture 应含深圳/天津条目以供过滤验证');
  const noCodeXian = { ...item, id: 90001, stadiumCityCode: '', stadiumCityName: '西安市' };
  const transport = async () => Response.json({
    success: true,
    data: [sz, tjj, item, noCodeXian],
  });
  const records = await fetchSnpac({ transport });
  const ids = records.map((r) => r.source_id);
  assert.ok(!ids.includes(String(sz.id)), '深圳市（440300）条目应被剔除');
  assert.ok(!ids.includes(String(tjj.id)), '天津市（120000）条目应被剔除');
  assert.ok(ids.includes(String(noCodeXian.id)), 'stadiumCityCode 缺失但 stadiumCityName=西安市 应被 isXian 兜底保留');
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.city === '西安市'));
});

test('fetchSnpac 失败响应抛出', async () => {
  const transport = async () => Response.json({ errcode: '1101', msg: 'appkey错误！' });
  await assert.rejects(() => fetchSnpac({ transport }), /snpac_error_1101/);
});

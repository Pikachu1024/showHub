import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAITIX_TENANTS, mapMaitixProject, fetchMaitixTenant, isNonShowProduct } from '../../sync/maitix.mjs';

const body = JSON.parse(readFileSync(new URL('../fixtures/maitix.json', import.meta.url), 'utf8'));
const item = body.data.dataList[0];
const tenant = MAITIX_TENANTS[0];

test('租户配置覆盖两个站点', () => {
  assert.deepEqual(MAITIX_TENANTS.map((t) => t.source), ['maitix-dhjc', 'maitix-xaetys']);
  assert.equal(MAITIX_TENANTS[1].referer, 'https://xaetys.maitix.com/');
});

test('mapMaitixProject 字段映射', () => {
  const r = mapMaitixProject(item, tenant);
  assert.equal(r.source, 'maitix-dhjc');
  assert.equal(r.source_id, String(item.projectToken));
  assert.equal(r.name, item.projectName);
  assert.equal(r.poster_url, item.imgUrl);
  assert.match(r.start_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(r.end_time, new Date(item.endTime).toISOString());
  assert.ok(r.price.length > 0);
  assert.equal(r.min_price, 0, "fixture 首条 minPrice 为字符串 '0'，应归一化为数字 0");
  assert.equal(r.buy_url, `https://dhjc.maitix.com/m/#/allEvents/detail?projectId=${item.projectToken}`);
});

test('mapMaitixProject 售罄与免费价格', () => {
  const soldOut = mapMaitixProject({ ...item, sellOut: true }, tenant);
  assert.equal(soldOut.status, '已售罄');
  const free = mapMaitixProject({ ...item, minPrice: 0, maxPrice: 0 }, tenant);
  assert.equal(free.price, '免费/暂无价格');
  assert.equal(free.min_price, 0);
  const noPrice = mapMaitixProject({ ...item, minPrice: undefined, maxPrice: undefined }, tenant);
  assert.equal(noPrice.min_price, 0, 'minPrice 缺失归免费档 0（未知价=免费，新语义不再有 null）');
});

test('fetchMaitixTenant 翻页并过滤西安', async () => {
  const foreign = { ...item, cityId: '610300', cityName: '宝鸡市', projectToken: '999' };
  let page = 0;
  const transport = async (url) => {
    page += 1;
    const dataList = page === 1 ? body.data.dataList : [foreign];
    const data = { dataList, totalPage: 2, page };
    return Response.json({ code: '200', data });
  };
  const records = await fetchMaitixTenant(tenant, { transport, sleep: async () => {} });
  assert.equal(page, 2);
  assert.ok(records.every((r) => r.city.includes('西安')), '非西安城市应被过滤');
  assert.ok(!records.some((r) => r.source_id === '999'));
});

test('fetchMaitixTenant 带 Referer 头且 HTTP 错误抛出', async () => {
  let seenReferer = '';
  const ok = async (url, init) => {
    seenReferer = init.headers.Referer;
    return Response.json({ code: '200', data: { dataList: [], totalPage: 1 } });
  };
  await fetchMaitixTenant(tenant, { transport: ok, sleep: async () => {} });
  assert.equal(seenReferer, tenant.referer);
  const bad = async () => new Response('x', { status: 503 });
  await assert.rejects(() => fetchMaitixTenant(tenant, { transport: bad, sleep: async () => {} }), /maitix_http_503/);
});

// —— Task C：过滤非演出商品（储值卡等）——

test('isNonShowProduct 命中储值卡/年卡/券/开头套票等商品名', () => {
  for (const name of [
    '【迎新福利】梦想剧场储值卡',
    '梦想剧场 充 值 卡',
    '2026 年卡',
    '【会员专享】代金券',
    '套票两日畅玩',
  ]) {
    assert.equal(isNonShowProduct(name), true, `应判为非演出商品: ${name}`);
  }
});

test('isNonShowProduct 对真实演出名返回 false（防误杀）', () => {
  for (const name of [
    '2026.10.1西安·国庆爆笑脱口秀·放松解压·爆梗不断',
    '《三星堆之神树奇谭》',
    '贰佰西安演唱会',
    '国庆Q趣动漫嘉年华-套票享不停',
  ]) {
    assert.equal(isNonShowProduct(name), false, `真实演出名必须保留: ${name}`);
  }
});

test('isNonShowProduct 非字符串入参保守保留', () => {
  assert.equal(isNonShowProduct(undefined), false);
  assert.equal(isNonShowProduct(null), false);
  assert.equal(isNonShowProduct(123), false);
});

test('isNonShowProduct 「卡+农/丁/通/片/座/车」组合词不误杀，年卡/季卡/储值卡仍排除', () => {
  for (const name of [
    '七月卡农钢琴音乐会',
    '跨年卡通狂欢儿童剧',
    '卡丁车体验日',
  ]) {
    assert.equal(isNonShowProduct(name), false, `真实演出名必须保留: ${name}`);
  }
  for (const name of [
    '2026 年卡',
    '梦想剧场季卡',
    '【迎新福利】梦想剧场储值卡',
  ]) {
    assert.equal(isNonShowProduct(name), true, `应判为非演出商品: ${name}`);
  }
});

test('fetchMaitixTenant 过滤混入的储值卡商品，保留西安正常条目', async () => {
  const card = {
    projectName: '【迎新福利】梦想剧场储值卡',
    projectTypeName: '儿童剧',
    projectToken: 236637114,
    cityName: '西安市',
    cityId: '610100',
    startTime: 1766966400000,
    endTime: 1798732800000,
    minPrice: 400,
    maxPrice: 800,
    imgUrl: 'https://example.com/card.jpg',
    siteName: '梦想剧场',
  };
  const transport = async () => Response.json({ code: '200', data: { dataList: [item, card], totalPage: 1 } });
  const records = await fetchMaitixTenant(MAITIX_TENANTS[1], { transport, sleep: async () => {} });
  assert.ok(!records.some((r) => r.source_id === '236637114'), '储值卡商品应被过滤');
  assert.ok(!records.some((r) => r.name.includes('储值卡')));
  assert.ok(records.some((r) => r.source_id === String(item.projectToken)), '西安正常条目应保留');
});

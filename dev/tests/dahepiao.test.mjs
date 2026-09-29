import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDahepiaoHtml, fetchDahepiao } from '../../sync/dahepiao.mjs';

const html = readFileSync(new URL('../fixtures/dahepiao.html', import.meta.url), 'utf8');

test('parseDahepiaoHtml 解析 fixture 中的演出', () => {
  const records = parseDahepiaoHtml(html);
  assert.ok(records.length >= 5, `应有演出，实际 ${records.length}`);
  for (const r of records) {
    assert.equal(r.source, 'dahepiao');
    assert.match(r.source_id, /^\d+$/);
    assert.ok(r.name.length > 0);
    assert.ok(r.buy_url.startsWith('https://m.dahepiao.com/'));
    assert.equal(r.city, '西安');
    assert.equal(r.category, '演出');
    assert.ok(r.poster_url.startsWith('http'));
    // min_price 恒为非负整数（未知价格归免费档 0，新语义不再有 null），且与 price 展示文本的第一个数字一致
    assert.ok(Number.isInteger(r.min_price) && r.min_price >= 0,
      `min_price 应为非负整数，实际 ${r.min_price}`);
    const m = r.price.match(/\d+(?:\.\d+)?/);
    assert.equal(r.min_price, m ? Math.round(Number(m[0])) : 0, `min_price 应与 price 文本一致：${r.price}`);
  }
});

test('parseDahepiaoHtml 第一条字段完整', () => {
  const first = parseDahepiaoHtml(html)[0];
  assert.ok(first.start_time.length > 0);
  assert.ok(first.start_at !== null, '开始时间应可解析为 ISO');
  assert.equal(first.end_time, first.start_at, '无结束时间时用开演时间');
  assert.ok(first.price.length > 0);
  assert.ok(first.venue.length > 0);
  assert.equal(first.min_price, 150, '￥150起 应解析为 150');
});

test('fetchDahepiao 用注入 transport 抓多页并在空页停止', async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    // 第 1 页返回 fixture，第 2 页返回空列表
    const body = calls === 1 ? html : '<html><body></body></html>';
    return new Response(body, { status: 200 });
  };
  const sleep = async () => {};
  const records = await fetchDahepiao({ transport, sleep });
  assert.equal(calls, 2);
  assert.ok(records.length >= 5);
});

test('fetchDahepiao HTTP 错误抛出', async () => {
  const transport = async () => new Response('err', { status: 500 });
  await assert.rejects(() => fetchDahepiao({ transport, sleep: async () => {} }), /dahepiao_http_500/);
});

test('fetchDahepiao 重复页停止且不重复追加', async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    // 两页返回相同 fixture（整页 source_id 重复）：应在第 2 页识别重复并停止
    return new Response(html, { status: 200 });
  };
  const sleep = async () => {};
  const records = await fetchDahepiao({ transport, sleep });
  assert.equal(calls, 2, 'transport 应只被调用 2 次');
  const ids = records.map((r) => r.source_id);
  assert.equal(new Set(ids).size, ids.length, '结果不应有重复 source_id');
  assert.deepEqual(records, parseDahepiaoHtml(html), '结果应恰为单页 fixture，第二页不追加');
});

test('parseDahepiaoHtml buy_url 协议白名单：非 http(s) 的 href 置空且其余字段正常', () => {
  const block = `
<div class="ycList list-grid flex">
  <a href="javascript:alert(1)" class="s_left"><img src="https://img.dahepiao.com/p/xss.jpg"></a>
  <div class="s_right">
    <a href="https://m.dahepiao.com/yanchupiaowu1/2018091946076.html" class="l1 line1">恶意链接演出 </a>
    <div class="l2 line1">2026-11-01 周日 19:30</div>
    <div class="l3 line1">西安测试场馆</div>
    <div class="l4"><span>售票中</span></div>
    <div class="l5">￥<em>150</em>起</div>
  </div>
</div>`;
  // s_left href 供 buy_url 与 source_id 提取：javascript: URI 需保留 \d+\.html 才能命中卡片
  const withId = block.replace('javascript:alert(1)', 'javascript:alert(1)#2018091946076.html');
  const records = parseDahepiaoHtml(withId);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.buy_url, '', '非 http(s) 协议应被白名单拒绝置空');
  assert.equal(r.source, 'dahepiao');
  assert.equal(r.source_id, '2018091946076');
  assert.equal(r.name, '恶意链接演出');
  assert.equal(r.venue, '西安测试场馆');
  assert.equal(r.city, '西安');
  assert.equal(r.status, '售票中');
  assert.ok(r.start_at !== null, '其它字段应正常解析');
  assert.ok(r.price.length > 0);
  assert.equal(r.min_price, 150, '￥150起 应解析出 min_price=150');
});

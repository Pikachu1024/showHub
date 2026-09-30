import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMessage,
  diffNewShows,
  isPushableFreeShow,
  parseUids,
  runNotify,
  sendWxPusher,
  WXPUSHER_ENDPOINT,
  describeNotify,
} from '../../tools/notify.mjs';
import { runPublish } from '../../tools/publish-data.mjs';

// 交叉校验：站点前端的免费口径来自 web/price-key.js（经典脚本），
// 这里用 node:vm 执行同一份真实文件，而不是复制实现。
const priceSource = readFileSync(new URL('../../web/price-key.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {} };
vm.createContext(sandbox);
vm.runInContext(priceSource, sandbox);
const { priceKeyOf } = sandbox.globalThis.ShowHubPrice;

const show = (id, over = {}) => ({
  id: `id-${id}`,
  source: 'snpac',
  source_id: String(id),
  name: `演出 ${id}`,
  city: '西安市',
  venue: '剧场',
  category: '音乐会',
  price: '￥100起',
  min_price: 100,
  status: '售票中',
  start_time: '2026-11-05 19:30',
  start_at: '2026-11-05T19:30:00+08:00',
  buy_url: 'https://example.com/detail',
  poster_url: '',
  end_time: '',
  updated_at: '',
  ...over,
});
const free = (id, over = {}) => show(id, { price: '免费/暂无价格', min_price: 0, ...over });

const okResponse = (data) =>
  Response.json({ code: 1000, msg: '处理成功', success: true, data });
const sentTo = (uid) => ({ uid, code: 1000, status: '处理成功', messageContentId: 2285051974, sendRecordId: 1 });

const capture = (body = okResponse([sentTo('UID_x')])) => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    return typeof body === 'function' ? body(url, init) : body;
  };
  return { calls, transport };
};

// —— 免费口径与前端一致 ——

test('isPushableFreeShow 的免费判定与 web/price-key.js 的 priceKeyOf 完全一致', () => {
  const cases = [
    { min_price: 0, price: '免费/暂无价格' },
    { min_price: -1, price: '￥100起' },
    { min_price: null, price: '￥100起' },
    { min_price: null, price: '免费/暂无价格' },
    { min_price: null, price: '价格待定' },
    { min_price: undefined, price: '￥0.00起' },
    { min_price: 19.9, price: '' },
    { min_price: 20, price: '免费' },
  ];
  for (const c of cases) {
    // 只比对免费档这一布尔结论；非可售状态用 售票中 固定
    const grabable = { ...c, status: '售票中' };
    assert.equal(isPushableFreeShow(grabable), priceKeyOf(c) === 0, JSON.stringify(c));
  }
});

test('已售罄的免费场次不推送，其它状态（含缺失）照推', () => {
  assert.equal(isPushableFreeShow(free(1, { status: '已售罄' })), false);
  assert.equal(isPushableFreeShow(free(2, { status: '售票中' })), true);
  assert.equal(isPushableFreeShow(free(3, { status: undefined })), true);
});

// —— 差集与基线保护 ——

test('diffNewShows 按 source+source_id 取差集，同一 source_id 不同来源算新增', () => {
  const seed = [show(1), show(2, { source: 'maitix-dhjc' })];
  const cur = [show(1), show(2, { source: 'snpac' }), show(3), free(4)];
  assert.deepEqual(diffNewShows(seed, cur).map((r) => `${r.source}:${r.source_id}`), ['snpac:2', 'snpac:3', 'snpac:4']);
});

test('diffNewShows 在无基线时返回 null，绝不做全量推送', () => {
  assert.equal(diffNewShows([], [show(1), free(2)]), null);
  assert.equal(diffNewShows(undefined, [show(1)]), null);
});

// —— 消息构造 ——

test('buildMessage 只列免费且可售的新增场次，summary 是给微信列表看的标题', () => {
  const { summary, content, free: list } = buildMessage({
    newShows: [free(1), show(2), free(3, { status: '已售罄' })],
    siteUrl: 'https://pika.github.io/showHub',
  });
  assert.equal(list.length, 1);
  assert.equal(summary, '西安免费演出 +1');
  assert.match(content, /演出 1/);
  assert.doesNotMatch(content, /演出 2/);
  assert.doesNotMatch(content, /演出 3/, '已售罄不进正文');
  assert.match(content, /\[购票入口\]\(https:\/\/example\.com\/detail\)/);
});

test('buildMessage 超过 8 场截断并提示剩余数量', () => {
  const many = Array.from({ length: 11 }, (_, i) => free(i + 1));
  const { summary, content, omitted } = buildMessage({ newShows: many, siteUrl: '' });
  assert.equal(omitted, 3);
  assert.equal(summary, '西安免费演出 +11');
  assert.match(content, /…另有 3 场/);
  assert.equal((content.match(/\*\*演出 /g) ?? []).length, 8);
});

test('buildMessage 时间取源站原文，缺失时回落 start_at，再缺失写「时间待定」', () => {
  const { content } = buildMessage({
    newShows: [
      free(1, { start_time: '2026-11-06 14:30', start_at: '2026-11-06T19:30:00+08:00' }),
      free(2, { start_time: '', start_at: '2026-11-07T02:30:00.000Z' }),
      free(3, { start_time: '', start_at: '' }),
    ],
    siteUrl: '',
  });
  assert.match(content, /时间：2026-11-06 14:30/);
  assert.match(content, /时间：2026-11-07 02:30/);
  assert.match(content, /时间：时间待定/);
});

// —— 接口契约 ——

test('parseUids 支持逗号与空格分隔，忽略空值', () => {
  assert.deepEqual(parseUids('UID_a, UID_b ,UID_c'), ['UID_a', 'UID_b', 'UID_c']);
  assert.deepEqual(parseUids('  '), []);
  assert.deepEqual(parseUids(undefined), []);
});

test('sendWxPusher 发的是 Markdown 消息（contentType 3）且带 uids/appToken', async () => {
  const { calls, transport } = capture();
  await sendWxPusher({
    appToken: 'AT_test', uids: ['UID_a'], summary: '西安免费演出 +1', content: '正文',
    url: 'https://pika.github.io/showHub', transport,
  });
  assert.equal(calls[0].url, WXPUSHER_ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].payload, {
    appToken: 'AT_test', content: '正文', summary: '西安免费演出 +1',
    contentType: 3, uids: ['UID_a'], url: 'https://pika.github.io/showHub',
  });
});

test('sendWxPusher 顶层 code=1000 但目标未订阅（code=1001）判为失败', async () => {
  const { transport } = capture(Response.json({
    code: 1000, msg: '处理成功', success: true,
    data: [{ uid: 'UID_sampleUser123', code: 1001, status: '用户UID=[UID_sampleUser123]未订阅应用' }],
  }));
  await assert.rejects(
    () => sendWxPusher({ appToken: 'AT_secret', uids: ['UID_sampleUser123'], summary: 's', content: 'c', transport }),
    /wxpusher_not_delivered ok=0\/1 1001:/,
  );
});

test('sendWxPusher 多目标只要有一个未送达就失败；全送达才成功', async () => {
  const partial = capture(okResponse([sentTo('UID_a'), { uid: 'UID_b', code: 1001, status: '未订阅' }]));
  await assert.rejects(
    () => sendWxPusher({ appToken: 'AT_x', uids: ['UID_a', 'UID_b'], summary: 's', content: 'c', transport: partial.transport }),
    /wxpusher_not_delivered ok=1\/2/,
  );
  const all = capture(okResponse([sentTo('UID_a'), sentTo('UID_b')]));
  const r = await sendWxPusher({ appToken: 'AT_x', uids: ['UID_a', 'UID_b'], summary: 's', content: 'c', transport: all.transport });
  assert.equal(r.messageContentId, 2285051974);
});

test('错误信息里的凭据被脱敏，不泄漏 appToken 与 UID', async () => {
  const { transport } = capture(Response.json({ code: 1001, msg: 'appToken[AT_secretToken]无效', data: null }));
  const err = await sendWxPusher({ appToken: 'AT_secretToken', uids: ['UID_secretUser'], summary: 's', content: 'c', transport })
    .then(() => null)
    .catch((e) => e);
  assert.match(err.message, /AT_\*\*\*/);
  assert.doesNotMatch(err.message, /AT_secretToken/);
});

// —— runNotify 的降级契约：永不抛错 ——

test('runNotify 缺凭据时跳过，不发起任何请求', async () => {
  const { calls, transport } = capture();
  const r = await runNotify({ seedRows: [show(1)], shows: [show(1), free(2)], appToken: '', transport });
  assert.deepEqual(r, { status: 'skipped', reason: 'no_app_token' });
  const r2 = await runNotify({ seedRows: [show(1)], shows: [free(2)], appToken: 'AT_x', uidsRaw: ' ', transport });
  assert.deepEqual(r2, { status: 'skipped', reason: 'no_uids' });
  assert.equal(calls.length, 0);
});

test('runNotify 无基线 / 无新增免费都跳过', async () => {
  const { transport } = capture();
  assert.deepEqual(await runNotify({ seedRows: [], shows: [free(1)], appToken: 'AT_x', uidsRaw: 'UID_a', transport }),
    { status: 'skipped', reason: 'no_baseline' });
  assert.deepEqual(await runNotify({ seedRows: [show(1)], shows: [show(1), show(2)], appToken: 'AT_x', uidsRaw: 'UID_a', transport }),
    { status: 'skipped', reason: 'no_new_free', count: 1 });
  assert.deepEqual(await runNotify({ seedRows: [show(1)], shows: [show(1), free(2, { status: '已售罄' })], appToken: 'AT_x', uidsRaw: 'UID_a', transport }),
    { status: 'skipped', reason: 'no_new_free', count: 1 });
});

test('runNotify 命中新增免费时推送，并把UID 串拆给接口', async () => {
  const { calls, transport } = capture();
  const r = await runNotify({
    seedRows: [show(1)],
    shows: [show(1), free(2, { name: '惠民音乐会' }), free(3, { status: '已售罄' }), show(4)],
    siteUrl: 'https://pika.github.io/showHub',
    appToken: 'AT_x', uidsRaw: 'UID_a,UID_b', transport,
  });
  assert.equal(r.status, 'sent');
  assert.equal(r.count, 1);
  assert.equal(r.newCount, 3);
  assert.deepEqual(calls[0].payload.uids, ['UID_a', 'UID_b']);
  assert.equal(calls[0].payload.summary, '西安免费演出 +1');
});

test('runNotify 把接口异常归一化为 status=failed，绝不抛回调用方', async () => {
  const boom = async () => { throw new Error('upstream_timeout'); };
  const r = await runNotify({ seedRows: [show(1)], shows: [show(1), free(2)], appToken: 'AT_x', uidsRaw: 'UID_a', transport: boom });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /upstream_timeout/);
});

test('describeNotify 把四种状态翻成可读日志', () => {
  assert.match(describeNotify({ status: 'sent', count: 2, newCount: 5 }), /已推送 2 场.*共新增 5 条/);
  assert.match(describeNotify({ status: 'failed', error: 'boom' }), /推送失败（boom）/);
  assert.match(describeNotify({ status: 'skipped', reason: 'no_app_token' }), /未配置 WXPUSHER_APP_TOKEN/);
  assert.match(describeNotify({ status: 'skipped', reason: 'no_baseline' }), /缺上次发布数据作基线/);
});

// —— 与发布流程的接线 ——

const snpacItem = (id, name, minPrice) => ({
  id, fullCnName: name, extraPoster: 'https://t/1.jpg',
  startTime: '2026-11-05 19:30:00', endTime: '2026-11-05 21:00:00',
  minPrice, maxPrice: minPrice, stadiumName: '西安音乐厅', venueName: '交响大厅',
  category: '音乐会', saleType: 'sale', stadiumCityCode: '610100', stadiumCityName: '西安市',
});

test('runPublish 在抓取后调用推送：未配置凭据只跳过，且不产生对 WxPusher 的请求', async () => {
  const out = await mkdtemp(join(tmpdir(), 'showhub-notify-'));
  const urls = [];
  const transport = async (url, init) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('snpac.com')) return Response.json({ success: true, data: [snpacItem(8001, '免费惠民演出', 0)] });
    if (u.includes('maitix.com')) return Response.json({ code: '200', data: { dataList: [], totalPage: 1 } });
    return new Response('not found', { status: 404 });
  };
  const saved = { app: process.env.WXPUSHER_APP_TOKEN, uids: process.env.WXPUSHER_UIDS };
  delete process.env.WXPUSHER_APP_TOKEN;
  delete process.env.WXPUSHER_UIDS;
  try {
    const res = await runPublish({
      out, baseUrl: '', scrape: true, transport,
      webDir: new URL('../../web/', import.meta.url), now: () => new Date('2026-10-01T00:00:00Z'),
    });
    assert.equal(res.notify.status, 'skipped');
    assert.equal(res.notify.reason, 'no_app_token');
    assert.equal(urls.some((u) => u.includes('wxpusher')), false);
  } finally {
    if (saved.app) process.env.WXPUSHER_APP_TOKEN = saved.app;
    if (saved.uids) process.env.WXPUSHER_UIDS = saved.uids;
  }
});

test('runPublish 配好凭据且有新免费演出时把消息推给 WxPusher', async () => {
  const out = await mkdtemp(join(tmpdir(), 'showhub-notify-'));
  const sent = [];
  const oldRow = show(7000);
  const transport = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/data/shows.json')) return Response.json({ shows: [oldRow] });
    if (u.includes('snpac.com')) return Response.json({ success: true, data: [snpacItem(7000, '老演出', 100), snpacItem(8002, '新增免费场', 0)] });
    if (u.includes('maitix.com')) return Response.json({ code: '200', data: { dataList: [], totalPage: 1 } });
    if (u.includes('wxpusher.zjiecode.com')) {
      sent.push(JSON.parse(init.body));
      return okResponse([sentTo('UID_a')]);
    }
    return new Response('not found', { status: 404 });
  };
  // baseUrl 既是回读上一次发布数据（推送基线）的地址，也是消息里的站点链接
  const res = await runPublish({
    out, baseUrl: 'https://pika.github.io/showHub', scrape: true, transport,
    webDir: new URL('../../web/', import.meta.url), now: () => new Date('2026-10-01T00:00:00Z'),
    notify: { appToken: 'AT_x', uidsRaw: 'UID_a' },
  });
  assert.equal(res.notify.status, 'sent', JSON.stringify(res.notify));
  assert.equal(res.notify.count, 1);
  assert.equal(sent[0].contentType, 3);
  assert.deepEqual(sent[0].uids, ['UID_a']);
  assert.equal(sent[0].url, 'https://pika.github.io/showHub');
  assert.match(sent[0].content, /新增免费场/);
  assert.doesNotMatch(sent[0].content, /老演出/, '基线里的老演出不再推');
});

test('runPublish 的 --skip-scrape 分支不推送：改代码不是新数据', async () => {
  const out = await mkdtemp(join(tmpdir(), 'showhub-notify-'));
  const liveShows = [show(7000), free(7001)];
  const urls = [];
  const transport = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/data/shows.json')) return Response.json({ shows: liveShows });
    if (u.endsWith('/data/meta.json')) {
      return Response.json({ generated_at: '2026-09-30T00:00:00Z', sources: [], deleted: [] });
    }
    return new Response('not found', { status: 404 });
  };
  const res = await runPublish({
    out, baseUrl: 'https://pika.github.io/showHub', scrape: false, transport,
    webDir: new URL('../../web/', import.meta.url), now: () => new Date('2026-10-01T00:00:00Z'),
    notify: { appToken: 'AT_x', uidsRaw: 'UID_a' },
  });
  assert.equal(res.notify, null, 'skip-scrape 不应触发推送');
  assert.equal(urls.some((u) => u.includes('wxpusher')), false);
});

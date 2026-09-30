import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMessage,
  describeNotify,
  diffNewShows,
  isPushableFreeShow,
  parseSendKeys,
  runNotify,
  sendKeyEndpoint,
  sendServerChan,
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

// Server酱 的真实响应形状：code 是受理码，data.error 才是通道投递结果
const okResponse = (data = { pushid: 'pxx123', error: 'SUCCESS' }) =>
  Response.json({ code: 0, message: '', data });

// 默认用工厂而非现成的 Response：Response 的 body 只能读一次，
// 多接收者用例会读同一个实例，第二次就会拿到 null。
const capture = (body = () => okResponse()) => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    return typeof body === 'function' ? body(url, init) : body;
  };
  return { calls, transport };
};

const sendArgs = { sendKey: 'SCT_testKey', title: '西安免费演出 +1', desp: '正文' };

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

test('buildMessage 只列免费且可售的新增场次', () => {
  const { title, desp, free: list } = buildMessage({
    newShows: [free(1), show(2), free(3, { status: '已售罄' })],
    siteUrl: 'https://pika.github.io/showHub',
  });
  assert.equal(list.length, 1);
  assert.equal(title, '西安免费演出 +1');
  assert.match(desp, /演出 1/);
  assert.doesNotMatch(desp, /演出 2/);
  assert.doesNotMatch(desp, /演出 3/, '已售罄不进正文');
  assert.match(desp, /\[购票入口\]\(https:\/\/example\.com\/detail\)/);
  assert.match(desp, /\[进入站点\]\(https:\/\/pika\.github\.io\/showHub\)/);
});

test('buildMessage 超过 8 场截断并提示剩余数量', () => {
  const many = Array.from({ length: 11 }, (_, i) => free(i + 1));
  const { title, desp, omitted } = buildMessage({ newShows: many, siteUrl: '' });
  assert.equal(omitted, 3);
  assert.equal(title, '西安免费演出 +11');
  assert.match(desp, /…另有 3 场/);
  assert.equal((desp.match(/\*\*演出 /g) ?? []).length, 8);
});

test('title 不含换行且不超过 32 字符（服务端会拒绝含换行的标题）', () => {
  const long = Array.from({ length: 40 }, (_, i) => free(i + 1));
  const { title } = buildMessage({ newShows: long, siteUrl: '' });
  assert.doesNotMatch(title, /[\r\n]/);
  assert.ok(title.length <= 32, `title 过长: ${title.length}`);
});

test('desp 每段之间留空行：Server酱 按 Markdown 渲染，单换行不分段', () => {
  const { desp } = buildMessage({ newShows: [free(1, { name: '测试演出' })], siteUrl: '' });
  assert.match(desp, /测试演出\*\*\n\n时间：/);
  assert.doesNotMatch(desp, /[^\n]\n[^\n]/, '不允许出现单换行相邻的两行');
});

test('时间取源站原文，缺失时回落 start_at，再缺失写「时间待定」', () => {
  const { desp } = buildMessage({
    newShows: [
      free(1, { start_time: '2026-11-06 14:30', start_at: '2026-11-06T19:30:00+08:00' }),
      free(2, { start_time: '', start_at: '2026-11-07T02:30:00.000Z' }),
      free(3, { start_time: '', start_at: '' }),
    ],
    siteUrl: '',
  });
  assert.match(desp, /时间：2026-11-06 14:30/);
  assert.match(desp, /时间：2026-11-07 02:30/);
  assert.match(desp, /时间：时间待定/);
});

// —— 接口契约 ——

test('sendKeyEndpoint 用 SendKey 拼出 Turbo 端点', () => {
  assert.equal(sendKeyEndpoint('SCT42xY9'), 'https://sctapi.ftqq.com/SCT42xY9.send');
});

test('sendServerChan 发的是 {title, desp} JSON', async () => {
  const { calls, transport } = capture();
  await sendServerChan({ ...sendArgs, transport });
  assert.equal(calls[0].url, 'https://sctapi.ftqq.com/SCT_testKey.send');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(calls[0].payload, { title: '西安免费演出 +1', desp: '正文' });
});

test('sendServerChan：code 非 0 判为失败并带服务端 message', async () => {
  const { transport } = capture(Response.json({ code: 40004, message: '达到今日发送上限', data: null }));
  await assert.rejects(() => sendServerChan({ ...sendArgs, transport }), /serverchan_send_rejected status=200 code=40004 message=达到今日发送上限/);
});

test('sendServerChan：code=0 但通道投递失败仍判为失败', async () => {
  const { transport } = capture(okResponse({ pushid: 'p1', error: 'USER_NOT_FOLLOWED' }));
  await assert.rejects(() => sendServerChan({ ...sendArgs, transport }), /serverchan_not_delivered USER_NOT_FOLLOWED/);
});

test('sendServerChan：data.error 为 SUCCESS 或缺失时算成功', async () => {
  const a = capture(okResponse({ pushid: 'p9', error: 'SUCCESS' }));
  assert.equal((await sendServerChan({ ...sendArgs, transport: a.transport })).pushid, 'p9');
  const b = capture(okResponse({ pushid: 'p10' }));
  assert.equal((await sendServerChan({ ...sendArgs, transport: b.transport })).pushid, 'p10');
});

test('错误信息里的 SendKey 被脱敏，不泄漏凭据', async () => {
  const { transport } = capture(Response.json({ code: 40003, message: 'sendkey[SCT_secretKey999]不存在', data: null }));
  const err = await sendServerChan({ sendKey: 'SCT_secretKey999', title: 't', desp: 'd', transport }).then(() => null).catch((e) => e);
  assert.match(err.message, /SCT_\*\*\*/);
  assert.doesNotMatch(err.message, /SCT_secretKey999/);
});

// —— runNotify 的降级契约：永不抛错 ——

test('runNotify 缺 SendKey 时跳过，不发起任何请求', async () => {
  const { calls, transport } = capture();
  const r = await runNotify({ seedRows: [show(1)], shows: [show(1), free(2)], sendKey: '', transport });
  assert.deepEqual(r, { status: 'skipped', reason: 'no_send_key' });
  assert.equal(calls.length, 0);
});

test('runNotify 无基线 / 无新增免费都跳过', async () => {
  const { transport } = capture();
  assert.deepEqual(await runNotify({ seedRows: [], shows: [free(1)], sendKey: 'SCT_x', transport }),
    { status: 'skipped', reason: 'no_baseline' });
  assert.deepEqual(await runNotify({ seedRows: [show(1)], shows: [show(1), show(2)], sendKey: 'SCT_x', transport }),
    { status: 'skipped', reason: 'no_new_free', count: 1 });
  assert.deepEqual(await runNotify({ seedRows: [show(1)], shows: [show(1), free(2, { status: '已售罄' })], sendKey: 'SCT_x', transport }),
    { status: 'skipped', reason: 'no_new_free', count: 1 });
});

test('runNotify 命中新增免费时推送一条聚合消息', async () => {
  const { calls, transport } = capture();
  const r = await runNotify({
    seedRows: [show(1)],
    shows: [show(1), free(2, { name: '惠民音乐会' }), free(3, { status: '已售罄' }), show(4)],
    siteUrl: 'https://pika.github.io/showHub',
    sendKey: 'SCT_x', transport,
  });
  assert.equal(r.status, 'sent');
  assert.equal(r.count, 1);
  assert.equal(r.newCount, 3);
  assert.equal(calls.length, 1, '多场合成一条消息，不逐条发');
  assert.equal(calls[0].payload.title, '西安免费演出 +1');
  assert.match(calls[0].payload.desp, /惠民音乐会/);
});

test('runNotify 把接口异常归一化为 status=failed，绝不抛回调用方', async () => {
  const boom = async () => { throw new Error('upstream_timeout'); };
  const r = await runNotify({ seedRows: [show(1)], shows: [show(1), free(2)], sendKey: 'SCT_x', transport: boom });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /upstream_timeout/);
});

// —— 多接收者 ——

test('parseSendKeys 支持逗号与空格分隔，忽略空值', () => {
  assert.deepEqual(parseSendKeys('SCT_a, SCT_b ,SCT_c'), ['SCT_a', 'SCT_b', 'SCT_c']);
  assert.deepEqual(parseSendKeys('SCT_a\nSCT_b'), ['SCT_a', 'SCT_b']);
  assert.deepEqual(parseSendKeys('  '), []);
  assert.deepEqual(parseSendKeys(undefined), []);
});

test('runNotify 对每个 SendKey 各发一次，内容相同', async () => {
  const { calls, transport } = capture();
  const r = await runNotify({
    seedRows: [show(1)], shows: [show(1), free(2)],
    sendKey: 'SCT_alice, SCT_bob', transport,
  });
  assert.equal(r.status, 'sent');
  assert.equal(r.delivered, 2);
  assert.deepEqual(r.failed, []);
  assert.equal(calls.length, 2, '免费版不能群发，逐人各发一条');
  assert.equal(calls[0].url, 'https://sctapi.ftqq.com/SCT_alice.send');
  assert.equal(calls[1].url, 'https://sctapi.ftqq.com/SCT_bob.send');
  assert.deepEqual(calls[0].payload, calls[1].payload);
});

test('某个 SendKey 失效时另一人照常收到，状态仍是 sent', async () => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push(String(url));
    return url.includes('SCT_bad')
      ? Response.json({ code: 40003, message: 'sendkey 不存在', data: null })
      : okResponse();
  };
  const r = await runNotify({ seedRows: [show(1)], shows: [show(1), free(2)], sendKey: 'SCT_bad SCT_good', transport });
  assert.equal(r.status, 'sent');
  assert.equal(r.delivered, 1);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /sendkey 不存在/);
  assert.equal(calls.length, 2, '失败不中断后续接收者');
  assert.match(describeNotify(r), /已推送.*→ 1 人.*1 个接收者失败/);
});

test('全部接收者都失败才算 failed', async () => {
  const transport = async () => Response.json({ code: 40004, message: '达到今日发送上限', data: null });
  const r = await runNotify({ seedRows: [show(1)], shows: [show(1), free(2)], sendKey: 'SCT_a,SCT_b', transport });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /达到今日发送上限/);
  assert.equal(r.count, 1);
});

test('describeNotify 把四种状态翻成可读日志', () => {
  assert.match(describeNotify({ status: 'sent', count: 2, newCount: 5 }), /已推送 2 场.*共新增 5 条/);
  assert.match(describeNotify({ status: 'failed', error: 'boom' }), /推送失败（boom）/);
  assert.match(describeNotify({ status: 'skipped', reason: 'no_send_key' }), /未配置 SERVERCHAN_SENDKEY/);
  assert.match(describeNotify({ status: 'skipped', reason: 'no_baseline' }), /缺上次发布数据作基线/);
});

// —— 与发布流程的接线 ——

const snpacItem = (id, name, minPrice) => ({
  id, fullCnName: name, extraPoster: 'https://t/1.jpg',
  startTime: '2026-11-05 19:30:00', endTime: '2026-11-05 21:00:00',
  minPrice, maxPrice: minPrice, stadiumName: '西安音乐厅', venueName: '交响大厅',
  category: '音乐会', saleType: 'sale', stadiumCityCode: '610100', stadiumCityName: '西安市',
});

// 线上基线默认给一条老演出：没有基线时 runNotify 会整体跳过，测不到发送分支
const scrapeTransport = ({ seed = [show(7000)], serverChan } = {}) => async (url, init) => {
  const u = String(url);
  if (u.endsWith('/data/shows.json')) return Response.json({ shows: seed });
  if (u.includes('snpac.com')) return Response.json({ success: true, data: [snpacItem(7000, '老演出', 100), snpacItem(8001, '免费惠民演出', 0)] });
  if (u.includes('maitix.com')) return Response.json({ code: '200', data: { dataList: [], totalPage: 1 } });
  if (u.includes('sctapi.ftqq.com')) return serverChan ?? okResponse();
  return new Response('not found', { status: 404 });
};

test('runPublish 在抓取后调用推送：未配置 SendKey 只跳过，不产生对外请求', async () => {
  const out = await mkdtemp(join(tmpdir(), 'showhub-notify-'));
  const urls = [];
  const base = scrapeTransport();
  const transport = async (url, init) => { urls.push(String(url)); return base(url, init); };
  const saved = process.env.SERVERCHAN_SENDKEY;
  delete process.env.SERVERCHAN_SENDKEY;
  try {
    const res = await runPublish({
      out, baseUrl: 'https://pika.github.io/showHub', scrape: true, transport,
      webDir: new URL('../../web/', import.meta.url), now: () => new Date('2026-10-01T00:00:00Z'),
    });
    assert.deepEqual(res.notify, { status: 'skipped', reason: 'no_send_key' });
    assert.equal(urls.some((u) => u.includes('sctapi')), false);
  } finally {
    if (saved) process.env.SERVERCHAN_SENDKEY = saved;
  }
});

test('runPublish 配好 SendKey 且有新免费演出时推给 Server酱，站点链接用 baseUrl', async () => {
  const out = await mkdtemp(join(tmpdir(), 'showhub-notify-'));
  const sent = [];
  const base = scrapeTransport();
  const transport = async (url, init) => {
    if (String(url).includes('sctapi.ftqq.com')) { sent.push(JSON.parse(init.body)); return okResponse(); }
    return base(url, init);
  };
  const res = await runPublish({
    out, baseUrl: 'https://pika.github.io/showHub', scrape: true, transport,
    webDir: new URL('../../web/', import.meta.url), now: () => new Date('2026-10-01T00:00:00Z'),
    notify: { sendKey: 'SCT_x' },
  });
  assert.equal(res.notify.status, 'sent', JSON.stringify(res.notify));
  assert.equal(res.notify.count, 1);
  assert.match(sent[0].desp, /免费惠民演出/);
  assert.doesNotMatch(sent[0].desp, /老演出/, '基线里的老演出不再推');
  assert.match(sent[0].desp, /\[进入站点\]\(https:\/\/pika\.github\.io\/showHub\)/);
});

test('runPublish 读不到线上基线时整体跳过，避免把全量当新增推出上百条', async () => {
  const out = await mkdtemp(join(tmpdir(), 'showhub-notify-'));
  const res = await runPublish({
    out, baseUrl: '', scrape: true, transport: scrapeTransport({ seed: [] }),
    webDir: new URL('../../web/', import.meta.url), now: () => new Date('2026-10-01T00:00:00Z'),
    notify: { sendKey: 'SCT_x' },
  });
  assert.deepEqual(res.notify, { status: 'skipped', reason: 'no_baseline' });
});

test('runPublish 的 --skip-scrape 分支不推送：改代码不是新数据', async () => {
  const out = await mkdtemp(join(tmpdir(), 'showhub-notify-'));
  const urls = [];
  const liveShows = [show(7000), free(7001)];
  const transport = async (url, init) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/data/shows.json')) return Response.json({ shows: liveShows });
    if (u.endsWith('/data/meta.json')) return Response.json({ generated_at: '2026-09-30T00:00:00Z', sources: [], deleted: [] });
    return new Response('not found', { status: 404 });
  };
  const res = await runPublish({
    out, baseUrl: 'https://pika.github.io/showHub', scrape: false, transport,
    webDir: new URL('../../web/', import.meta.url), now: () => new Date('2026-10-01T00:00:00Z'),
    notify: { sendKey: 'SCT_x' },
  });
  assert.equal(res.notify, null, 'skip-scrape 不应触发推送');
  assert.equal(urls.some((u) => u.includes('sctapi')), false);
});

test('Server酱 返回额度用尽时发布仍然成功，只在日志里报失败', async () => {
  const out = await mkdtemp(join(tmpdir(), 'showhub-notify-'));
  const transport = scrapeTransport({ serverChan: Response.json({ code: 40004, message: '达到今日发送上限', data: null }) });
  const res = await runPublish({
    out, baseUrl: 'https://pika.github.io/showHub', scrape: true, transport,
    webDir: new URL('../../web/', import.meta.url), now: () => new Date('2026-10-01T00:00:00Z'),
    notify: { sendKey: 'SCT_x' },
  });
  assert.equal(res.ok, true, '推送失败不得影响发布');
  assert.equal(res.notify.status, 'failed');
  assert.match(res.notify.error, /达到今日发送上限/);
});

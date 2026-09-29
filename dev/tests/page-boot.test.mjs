// 页面启动契约测试（浏览器语义回归）。
// 同一页面的多枚经典脚本共享一个全局作用域：一份脚本的顶层 function/var 与另一份的顶层
// let/const 同名会在编译期抛 SyntaxError，整份 app.js 一行都不执行 ——
// 线上表现即「页面无卡片、抓取任务链接失效」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const priceKeySrc = read('../../web/price-key.js');
const appSrc = read('../../web/app.js');
const htmlSrc = read('../../web/index.html');

const PUBLIC_NAMES = ['priceKeyOf', 'timeKeyOf', 'compareShows', 'sortShows'];

const WORKFLOW_URL = 'https://github.com/pika/showHub/actions/workflows/publish.yml';

// 可观察的渲染桩：querySelector 按选择器缓存同一个节点，render() 写入的 textContent
// 之后能从被 append 到 grid 的卡片节点上原样读回来。
function makeNode() {
  const cache = new Map();
  const node = {
    children: [],
    listeners: {},
    className: '',
    textContent: '',
    href: '',
    src: '',
    alt: '',
    hidden: false,
    disabled: false,
    dataset: {},
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    addEventListener: (type, fn) => {
      (node.listeners[type] = node.listeners[type] || []).push(fn);
    },
    setAttribute: () => {},
    getAttribute: () => null,
    append: (...items) => node.children.push(...items),
    replaceChildren: () => { node.children.length = 0; },
    remove: () => {},
    querySelector: (sel) => {
      if (!cache.has(sel)) cache.set(sel, makeNode());
      return cache.get(sel);
    },
    content: { cloneNode: () => makeNode() },
  };
  return node;
}

const makeEl = makeNode;

// 最小 DOM + fetch 桩：只覆盖 app.js 顶层与首屏加载真正触碰到的 API。
// 静态产物语义：两个 JSON 分别对应演出全量与抓取概览，不再有 action= 查询串。
function bootContext(options = {}) {
  const items = options.items || [];
  const meta = options.meta || {
    generated_at: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    workflowUrl: WORKFLOW_URL,
    sources: [],
    cleanup_deleted: 0,
  };
  const els = new Map();
  const fetchCalls = [];
  const sandbox = {
    document: {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      querySelectorAll: () => [],
      createElement: (tag) => makeEl(`created:${tag}`),
    },
    fetch: async (url) => {
      const u = String(url);
      fetchCalls.push({ url: u, method: 'GET' });
      const body = u.includes('data/meta.json') ? meta : { generated_at: 'g', shows: items };
      return { ok: true, status: 200, json: async () => body };
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  return { els, fetchCalls, sandbox };
}

// 首屏加载是纯微任务链（无真实 IO），用 Promise 轮次冲刷即可
const flush = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

test('web/price-key.js 只暴露 ShowHubPrice 命名空间，不把函数名泄漏成全局绑定', () => {
  const ctx = vm.createContext({});
  vm.runInContext(priceKeySrc, ctx);
  assert.equal(vm.runInContext('typeof ShowHubPrice', ctx), 'object');
  const leaked = PUBLIC_NAMES.filter((n) => vm.runInContext(`typeof ${n}`, ctx) !== 'undefined');
  assert.deepEqual(leaked, [], '经典脚本的顶层 function 会成为全局 var 绑定，与 app.js 的顶层 const 同名即整页失效');
});

// project Pages 挂在 <owner>.github.io/<repo>/ 子路径下，前导 / 会解析到域名根而 404。
test('web/index.html 用相对路径按序加载两枚经典脚本（非 module/async/defer）', () => {
  const tags = [...htmlSrc.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(tags.length, 2, '页面只应有两枚脚本标签');
  assert.match(tags[0], /src="price-key\.js"/);
  assert.match(tags[1], /src="app\.js"/);
  for (const tag of tags) {
    assert.doesNotMatch(tag, /src="\//, '绝对路径在 project Pages 子路径下 404');
    assert.doesNotMatch(tag, /type="module"/, '模块脚本依赖服务端 JS MIME，线上不可验证，禁止使用');
    assert.doesNotMatch(tag, /\b(async|defer)\b/, 'async/defer 会打破 price-key.js 先于 app.js 执行的顺序');
  }
  assert.match(htmlSrc, /href="style\.css"/, '样式表也必须用相对路径');
});

test('页面声明 no-referrer，海报热链不被第三方 CDN 防盗链拒绝', () => {
  assert.match(htmlSrc, /<meta name="referrer" content="no-referrer">/);
});

test('抓取任务入口是默认隐藏的链接，不再是同步按钮', () => {
  assert.match(htmlSrc, /<a id="syncBtn"[^>]*hidden/, 'syncBtn 应为默认隐藏的 <a>：读不到 workflowUrl 时不展示');
  assert.doesNotMatch(htmlSrc, /<button id="syncBtn"/);
});

test('price-key.js 之后执行 app.js：整份脚本必须跑完并挂上交互监听', async () => {
  const { els, fetchCalls, sandbox } = bootContext();
  vm.runInContext(priceKeySrc, sandbox);
  vm.runInContext(appSrc, sandbox); // 修复前此处抛 SyntaxError: Identifier 'priceKeyOf' has already been declared
  await flush();

  const clicks = (id) => (els.get(id)?.listeners.click || []).length;
  assert.equal(clicks('freeChip'), 1, '免费筛选没有点击监听');
  assert.equal((els.get('searchInput')?.listeners.input || []).length, 1, '搜索框没有 input 监听');
  assert.ok(fetchCalls.some((c) => c.url.includes('data/shows.json')), '首屏从未加载演出数据');
  assert.ok(fetchCalls.some((c) => c.url.includes('data/meta.json')), '首屏从未加载抓取概览');
  assert.ok(!fetchCalls.some((c) => c.url.includes('action=')), '仍在请求已删除的 API 端点');
  assert.equal(fetchCalls.length, 2, `静态数据应各请求一次，实际 ${fetchCalls.map((c) => c.url).join(' ')}`);
  assert.equal(els.get('count').textContent, '共 0 场', '首屏渲染未写入计数');
  assert.equal(els.get('syncBtn').href, WORKFLOW_URL, '抓取任务链接未由 meta.workflowUrl 写入');
  assert.equal(els.get('syncBtn').hidden, false, '有 workflowUrl 时链接不应隐藏');
  assert.equal(clicks('syncBtn'), 0, '链接不应再挂同步点击监听');
  assert.equal(typeof sandbox.ShowHubPrice, 'object', 'ShowHubPrice 命名空间被覆盖');
});

// app.js 自身也不得向全局泄漏标识符：站点宿主会在页面注入内联脚本，
// 一旦其中的顶层声明与 app.js 同名（state/render/loadShows…），整页会以同样的 SyntaxError 失效。
test('app.js 执行后不新增全局绑定', async () => {
  const { sandbox } = bootContext();
  vm.runInContext(priceKeySrc, sandbox);
  vm.runInContext(appSrc, sandbox);
  await flush();
  const leaked = ['priceKeyOf', 'sortShows', 'state', 'SOURCE_LABELS', 'loadJson', 'loadShows', 'render', 'renderSyncOverview']
    .filter((n) => vm.runInContext(`typeof ${n}`, sandbox) !== 'undefined');
  assert.deepEqual(leaked, [], 'app.js 的顶层声明会进入全局词法环境，与宿主内联脚本同名即整页失效');
});

// 来源标签必须是站点自己的品牌名：
// dhjc.maitix.com <title>=西演SPACE；xaetys.maitix.com <title>=西安儿艺梦想剧场；
// www.snpac.com/sxtheatre 由用户指定称"爱乐剧管"。大河票务网已下线，不再是在册来源。
test('卡片按来源官方品牌名展示，不自造名字', async () => {
  const mk = (source, day) => ({
    source,
    source_id: `t-${source}`,
    name: `${source} 演出`,
    start_at: `2026-10-0${day}T02:30:00+00:00`,
    start_time: `2026-10-0${day} 10:30`,
    price: '￥100起',
    venue: '剧场',
    category: '音乐会',
    status: '售票中',
    buy_url: '',
    poster_url: '',
  });
  const items = [
    mk('snpac', 3),
    mk('maitix-xaetys', 2),
    mk('maitix-dhjc', 1),
  ];
  const { els, sandbox } = bootContext({ items });
  vm.runInContext(priceKeySrc, sandbox);
  vm.runInContext(appSrc, sandbox);
  await flush();

  const cards = els.get('grid').children;
  assert.equal(cards.length, 3, '三张来源卡片应全部渲染');
  const labels = cards.map((c) => c.querySelector('.source').textContent);
  assert.deepEqual(labels, ['西演SPACE', '西安儿艺梦想剧场', '爱乐剧管']);
});

// meta.json 的 error 文本源自远端响应，属不可信内容：只能经 textContent 落屏。
test('概览面板逐源展示抓取结果，失败原因不被当作 HTML 解析', async () => {
  const meta = {
    generated_at: '2026-11-04T00:00:00+08:00',
    lastSuccessAt: '2026-11-04T00:00:00+08:00',
    workflowUrl: WORKFLOW_URL,
    cleanup_deleted: 3,
    sources: [
      { source: 'snpac', status: 'error', finished_at: '2026-11-04T00:00:00+08:00', fetched: 0, inserted: 0, updated: 0, deleted: 0, error: '<img src=x onerror=alert(1)>' },
      { source: 'maitix-dhjc', status: 'success', finished_at: '2026-11-04T00:00:00+08:00', fetched: 12, inserted: 2, updated: 10, deleted: 0, error: '' },
    ],
  };
  const { els, sandbox } = bootContext({ meta });
  vm.runInContext(priceKeySrc, sandbox);
  vm.runInContext(appSrc, sandbox);
  await flush();

  const rowNodes = els.get('syncRows').children;
  const rows = rowNodes.map((n) => n.textContent);
  // 面板行数就是在册来源数：dahepiao 下线后不应再留一行「无抓取记录」
  assert.equal(rowNodes.length, 3, `面板应 3 行，实际：${JSON.stringify(rows)}`);
  assert.ok(rows.some((t) => t.startsWith('爱乐剧管 ✗')), `失败源应以 ✗ 开头：${JSON.stringify(rows)}`);
  assert.ok(rows.some((t) => t.startsWith('西演SPACE 抓取 12')), `成功源应展示抓取数：${JSON.stringify(rows)}`);
  // 注入载荷必须原样落在 textContent 上：一旦改走 innerHTML 就会解析出子节点
  assert.ok(rows.includes('爱乐剧管 ✗ 失败：<img src=x onerror=alert(1)>'), '错误文本应原样保留而非被丢弃');
  for (const n of rowNodes) assert.equal(n.children.length, 0, '面板行内不得解析出子节点');
  assert.equal(els.get('syncCleanup').textContent, '上次清理过期演出 3 条');
  assert.match(els.get('footer').textContent, /数据更新于/);
});

test('meta 无 workflowUrl 时不展示抓取任务链接，页脚退回尚未同步', async () => {
  const meta = { generated_at: '2026-11-04T00:00:00+08:00', lastSuccessAt: null, workflowUrl: null, sources: [], cleanup_deleted: 0 };
  const { els, sandbox } = bootContext({ meta });
  vm.runInContext(priceKeySrc, sandbox);
  vm.runInContext(appSrc, sandbox);
  await flush();
  assert.equal(els.get('syncBtn').hidden, true);
  assert.match(els.get('footer').textContent, /尚未同步/);
});

// 透传发布（push 触发）沿用线上旧 meta，其中可能带着已下线来源的记录；
// 页脚只应列在册来源，否则会出现「面板 3 行、页脚 4 个来源」的自相矛盾。
test('页脚忽略 meta 里已下线来源的旧记录', async () => {
  const meta = {
    generated_at: '2026-11-04T00:00:00+08:00',
    lastSuccessAt: '2026-11-04T00:00:00+08:00',
    workflowUrl: WORKFLOW_URL,
    cleanup_deleted: 0,
    sources: [
      { source: 'dahepiao', status: 'success', finished_at: 'x', fetched: 20, inserted: 0, updated: 20, deleted: 0, error: '' },
      { source: 'snpac', status: 'success', finished_at: 'x', fetched: 51, inserted: 0, updated: 51, deleted: 0, error: '' },
    ],
  };
  const { els, sandbox } = bootContext({ meta });
  vm.runInContext(priceKeySrc, sandbox);
  vm.runInContext(appSrc, sandbox);
  await flush();
  const footer = els.get('footer').textContent;
  // 断言用原始 key：标签表里已无 dahepiao，未过滤时页脚会直接吐出 "dahepiao ✓"
  assert.ok(!footer.includes('dahepiao'), `页脚不应再列已下线来源：${footer}`);
  assert.ok(footer.includes('爱乐剧管'), `在册来源应保留：${footer}`);
});

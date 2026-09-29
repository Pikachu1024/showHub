// 经典脚本：依赖 index.html 先加载 /price-key.js（纯函数经全局命名空间暴露，勿改为 ES module）
// 整份代码包在 IIFE 内：经典脚本的顶层声明会进入全局词法环境，与站点宿主注入的内联脚本
// 或 price-key.js 的同名声明相撞时，本文件会在编译期 SyntaxError 并整份不执行（页面无数据、按钮全失效）。
(function () {
  'use strict';

  const { priceKeyOf, sortShows } = globalThis.ShowHubPrice;

  // 名称取自各站点自身：dhjc.maitix.com 标题「西演SPACE」、xaetys.maitix.com 标题「西安儿艺梦想剧场」；
  // snpac.com（陕西大剧院/西安音乐厅自营）按用户口径称「爱乐剧管」。
  // 顺序即概览面板的行顺序，与 sync/sync.mjs 的 ADAPTERS 保持一致。
  const SOURCE_LABELS = {
    'maitix-dhjc': '西演SPACE',
    'maitix-xaetys': '西安儿艺梦想剧场',
    snpac: '爱乐剧管',
  };

  const state = { category: '全部', status: 'upcoming', free: false, query: '', shows: [], meta: null };

  // 数据由 GitHub Actions 定时生成，前端只读；相对路径以适配 project Pages 的子路径
  async function loadJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`load_${path}_${res.status}`);
    return res.json();
  }

  async function loadShows() {
    const body = await loadJson('data/shows.json');
    return Array.isArray(body.shows) ? body.shows : [];
  }

  function isEnded(show) {
    return show.end_time != null && Date.parse(show.end_time) < Date.now();
  }

  // 免费口径（用户裁定）：「免费」与「价格待定」同档，统一用 priceKeyOf===0 判定；
  // 旧数据 min_price 为 NULL 时由 price 文本兜底，有价格的旧行不再被误归免费档
  function isFree(show) {
    return priceKeyOf(show) === 0;
  }

  // name / venue / category 三字段的不区分大小写子串匹配；字段缺失按空字符串处理
  function matchesQuery(show, query) {
    if (!query) return true;
    return [show.name, show.venue, show.category].some(
      (v) => String(v ?? '').trim().toLowerCase().includes(query)
    );
  }

  function visibleShows() {
    return state.shows.filter((s) => {
      const cat = state.category === '全部' || s.category === state.category;
      const st = state.status === 'ended' ? isEnded(s) : !isEnded(s);
      const free = !state.free || isFree(s);
      return cat && st && free && matchesQuery(s, state.query);
    });
  }

  function render() {
    const grid = document.getElementById('grid');
    grid.replaceChildren();
    const tpl = document.getElementById('card-template');
    // 后端已按 (start_at, min_price, name) 排一次，但线上旧行 min_price 为 NULL 会让
    // 后端价格键退化；前端用 priceKeyOf 兜底键对可见集合二次排序（sortShows 内部 slice 拷贝）
    const items = sortShows(visibleShows());
    document.getElementById('count').textContent = `共 ${items.length} 场`;
    document.getElementById('empty').classList.toggle('hidden', items.length > 0);
    const ended = state.status === 'ended';
    for (const show of items) {
      const node = tpl.content.cloneNode(true);
      const card = node.querySelector('.card');
      if (ended) card.classList.add('ended');
      const poster = node.querySelector('.poster');
      poster.href = show.buy_url || '#';
      const img = node.querySelector('img');
      img.src = show.poster_url || '';
      img.alt = `${show.name} 海报`;
      img.onerror = () => { img.remove(); };
      node.querySelector('.badge').textContent = show.status || '';
      node.querySelector('.name').textContent = show.name;
      node.querySelector('.time').textContent = `🕐 ${show.start_time || '时间待定'}`;
      node.querySelector('.venue').textContent = `📍 ${show.venue || '场馆待定'}`;
      node.querySelector('.price').textContent = show.price || '';
      node.querySelector('.category').textContent = show.category || '';
      node.querySelector('.source').textContent = SOURCE_LABELS[show.source] || show.source;
      const buy = node.querySelector('.buy');
      if (show.buy_url) buy.href = show.buy_url; else buy.remove();
      grid.append(node);
    }
  }

  function renderCategories() {
    const cats = ['全部', ...new Set(state.shows.map((s) => s.category).filter(Boolean))];
    const wrap = document.getElementById('categoryFilters');
    wrap.replaceChildren();
    for (const cat of cats) {
      const btn = document.createElement('button');
      btn.className = 'chip' + (cat === state.category ? ' active' : '');
      btn.textContent = cat;
      btn.addEventListener('click', () => {
        state.category = cat;
        renderCategories();
        render();
      });
      wrap.append(btn);
    }
  }

  function renderFooter() {
    const el = document.getElementById('footer');
    if (!state.meta) { el.textContent = ''; return; }
    const time = state.meta.lastSuccessAt ? new Date(state.meta.lastSuccessAt).toLocaleString('zh-CN') : '尚未同步';
    const parts = (state.meta.sources || [])
      .filter((s) => s.source in SOURCE_LABELS)
      .map((s) => `${SOURCE_LABELS[s.source]} ${s.status === 'success' ? '✓' : '✗'}`);
    el.textContent = `数据更新于 ${time} · ${parts.join(' · ')}`;
  }

  document.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.status = btn.dataset.status;
      document.querySelectorAll('[data-status]').forEach((b) => b.classList.toggle('active', b === btn));
      render();
    });
  });

  // 「免费」开关式 chip：点击激活/取消，与分类、状态、搜索叠加生效。
  const freeChip = document.getElementById('freeChip');
  freeChip.addEventListener('click', () => {
    state.free = !state.free;
    freeChip.classList.toggle('active', state.free);
    freeChip.setAttribute('aria-pressed', String(state.free));
    render();
  });

  // 搜索：200ms 防抖后过滤重渲染；关键词与字段都 trim + 小写化。
  let searchTimer = null;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    const value = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = value.trim().toLowerCase();
      render();
    }, 200);
  });

  // —— 抓取概览面板（只读）——
  // 数据是 Actions 定时写入的 data/meta.json，页面不触发抓取。
  // 节点只创建一次并复用（挂在面板上），后续渲染仅更新 textContent，不重复建 DOM。
  // 面板所有文本一律经 textContent 写入；meta 里的 error 文本源自远端响应，属不可信内容。
  const SYNC_SOURCES = Object.keys(SOURCE_LABELS);
  const syncPanel = {
    root: null,
    rows: null, // [{source, el}]，与 SYNC_SOURCES 一一对应
    cleanup: null,
    time: null,
    built: false,
  };

  function buildSyncPanel() {
    const rowsWrap = document.getElementById('syncRows');
    syncPanel.root = document.getElementById('syncPanel');
    syncPanel.cleanup = document.getElementById('syncCleanup');
    syncPanel.time = document.getElementById('syncTime');
    syncPanel.rows = SYNC_SOURCES.map((source) => {
      const el = document.createElement('p');
      el.className = 'sync-line';
      el.hidden = true;
      rowsWrap.append(el);
      return { source, el };
    });
    syncPanel.built = true;
  }

  function formatClock(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function sourceLine(label, r) {
    if (!r) return `${label} 无抓取记录`;
    if (r.status === 'error') return `${label} ✗ 失败：${String(r.error ?? '').slice(0, 100)}`;
    return `${label} 抓取 ${r.fetched} · 新增 ${r.inserted} · 更新 ${r.updated}`;
  }

  function renderSyncOverview(meta) {
    if (!syncPanel.built) buildSyncPanel();
    syncPanel.root.hidden = false;
    document.getElementById('syncToggle').hidden = false;
    const link = document.getElementById('syncBtn');
    link.hidden = !meta.workflowUrl;
    if (meta.workflowUrl) link.href = meta.workflowUrl;
    const bySource = new Map((meta.sources || []).map((r) => [r.source, r]));
    for (const row of syncPanel.rows) {
      row.el.textContent = sourceLine(SOURCE_LABELS[row.source], bySource.get(row.source));
      row.el.hidden = false;
    }
    syncPanel.cleanup.textContent = `上次清理过期演出 ${meta.cleanup_deleted ?? 0} 条`;
    syncPanel.time.textContent = `抓取完成于 ${meta.generated_at ? formatClock(new Date(meta.generated_at)) : '未知'}`;
  }

  // 面板折叠小箭头：收起/展开，不新建 DOM
  document.getElementById('syncToggle').addEventListener('click', () => {
    const collapsed = syncPanel.root.classList.toggle('collapsed');
    const toggle = document.getElementById('syncToggle');
    toggle.textContent = collapsed ? '▸' : '▾';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });

  (async () => {
    try {
      state.shows = await loadShows();
      renderCategories();
      render();
    } catch {
      document.getElementById('empty').textContent = '加载失败，请稍后刷新重试';
      document.getElementById('empty').classList.remove('hidden');
    }
    try {
      state.meta = await loadJson('data/meta.json');
      renderFooter();
      renderSyncOverview(state.meta);
    } catch { /* 页脚与面板静默：读不到 meta 就维持隐藏的初始形态 */ }
  })();

}());

import { parseShowDate, parseMinPriceText } from './normalize.mjs';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15';
const LIST_URL = 'https://m.dahepiao.com/search_list?fenlei=2';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 列表页为服务端渲染 HTML；结构：.ycList 卡片内 .s_left img(海报)/.l1 名称/.l2 时间/.l3 场馆/.l4 状态/.l5 价格
export function parseDahepiaoHtml(html) {
  const records = [];
  const blocks = html.split('<div class="ycList list-grid flex">').slice(1);
  for (const block of blocks) {
    const href = block.match(/href="([^"]+)"\s+class="s_left"/);
    const img = block.match(/<img src="([^"]+)"/);
    const name = block.match(/class="l1 line1">\s*([^<]+?)\s*</);
    const time = block.match(/class="l2 line1">\s*([^<]+?)\s*</);
    const venue = block.match(/class="l3 line1">\s*([^<]+?)\s*</);
    const status = block.match(/class="l4">[\s\S]*?<span>\s*([^<]+?)\s*<\/span>/);
    const price = block.match(/class="l5">([\s\S]*?)<\/div>/);
    const id = href && href[1].match(/(\d+)\.html/);
    if (!href || !name || !id) continue;
    const startAt = parseShowDate(time ? time[1] : '');
    const priceText = price ? price[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim() : '';
    records.push({
      source: 'dahepiao',
      source_id: id[1],
      name: name[1].trim(),
      poster_url: img ? img[1].trim() : '',
      start_time: time ? time[1].trim() : '',
      start_at: startAt,
      end_time: startAt,
      price: priceText,
      min_price: parseMinPriceText(priceText),
      city: '西安',
      venue: venue ? venue[1].trim() : '',
      category: '演出',
      status: status ? status[1].trim() : '售票中',
      // 协议白名单：href 原文直接来自远端 HTML，仅接受 http(s)，否则置空（前端不渲染购票按钮）
      buy_url: /^https?:/i.test(href[1]) ? href[1].trim() : '',
    });
  }
  return records;
}

// 实测搜索页每页 20 条；停止条件：空页 / 整页 source_id 均重复（已到末尾）/ 不足一页。
export async function fetchDahepiao({ transport = globalThis.fetch, sleep = defaultSleep, maxPages = 15 } = {}) {
  const records = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${LIST_URL}&title=${encodeURIComponent('西安')}&page=${page}`;
    const res = await transport(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`dahepiao_http_${res.status}`);
    const items = parseDahepiaoHtml(await res.text());
    if (items.length === 0) break;
    if (items.every((r) => seen.has(r.source_id))) break; // 重复页：翻页已到列表末尾
    for (const r of items) {
      if (!seen.has(r.source_id)) {
        seen.add(r.source_id);
        records.push(r);
      }
    }
    if (items.length < 20) break; // 不足一页即为末页
    await sleep(600);
  }
  return records;
}

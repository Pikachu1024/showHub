import { formatPriceRange, toMinPrice, isXian } from './normalize.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const ENDPOINT = 'https://www.snpac.com/thvendor/ticket/program/getHotProgramList.xhtml';

// 注意：该接口返回陕西大剧院院线的全国巡场列表（含深圳音乐厅、天津大剧院等外地场馆），
// 并非全量即西安演出；fetchSnpac 必须按 stadiumCityCode/stadiumCityName 过滤，只保留西安市条目。
export function mapSnpacProgram(item) {
  const startAt = typeof item.startTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(item.startTime)
    ? item.startTime.replace(' ', 'T') + '+08:00' : null;
  const endAt = typeof item.endTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(item.endTime)
    ? item.endTime.replace(' ', 'T') + '+08:00' : null;
  const venue = [item.stadiumName, item.venueName].filter(Boolean).join('·');
  return {
    source: 'snpac',
    source_id: String(item.id ?? ''),
    name: String(item.fullCnName ?? item.cnName ?? '').trim(),
    poster_url: String(item.extraPoster ?? item.verticalPoster ?? ''),
    start_time: typeof item.startTime === 'string' ? item.startTime : '',
    start_at: startAt,
    end_time: endAt ?? startAt,
    price: formatPriceRange(item.minPrice, item.maxPrice),
    min_price: toMinPrice(item.minPrice),
    city: String(item.stadiumCityName || '西安'),
    venue,
    category: String(item.category ?? '演出'),
    status: item.saleType === 'sale' ? '售票中' : (item.saleType ? String(item.saleType) : '售票中'),
    buy_url: item.id ? `https://www.snpac.com/sxtheatre/index.html#/ticket/detail/${item.id}` : '',
  };
}

const XIAN_CITY_CODE = '610100';

// stadiumCityCode 优先；缺失时用 stadiumCityName 兜底判定，剔除外地巡演条目。
function isXianProgram(item) {
  const code = String(item.stadiumCityCode ?? '');
  if (code) return code === XIAN_CITY_CODE;
  return isXian(String(item.stadiumCityName ?? ''));
}

export async function fetchSnpac({ transport = globalThis.fetch } = {}) {
  const res = await transport(ENDPOINT, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.snpac.com/sxtheatre/index.html',
      'Content-Type': 'application/x-www-form-urlencoded',
      cmpappkey: 'SXtheatre',
    },
    body: 'showSite=pclist',
  });
  if (!res.ok) throw new Error(`snpac_http_${res.status}`);
  const body = await res.json();
  if (!body || body.success !== true || !Array.isArray(body.data)) {
    const code = body && body.errcode ? body.errcode : 'unknown';
    throw new Error(`snpac_error_${code}`);
  }
  return body.data
    .filter(isXianProgram)
    .map(mapSnpacProgram)
    .filter((r) => r.source_id && r.name);
}

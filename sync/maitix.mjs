import { formatPriceRange, isXian, toIsoFromMs, msToCSText, toMinPrice } from './normalize.mjs';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15';
const CITY_ID = '610100'; // 西安市

// maitix 平台同 API 不同租户，仅靠 Referer 区分
export const MAITIX_TENANTS = [
  { source: 'maitix-dhjc', referer: 'https://dhjc.maitix.com/', detailBase: 'https://dhjc.maitix.com/m/#/allEvents/detail?projectId=' },
  { source: 'maitix-xaetys', referer: 'https://xaetys.maitix.com/', detailBase: 'https://xaetys.maitix.com/m/#/allEvents/detail?projectId=' },
];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 非演出商品名称黑名单：命中任一正则即视为储值卡/券/套票类商品，需在 fetch 层排除。
// 正则大小写不敏感，并容忍关键词内的全角空格(\u3000)/半角空格(\s)。
export const NON_SHOW_NAME_PATTERNS = [
  /[充储][\s\u3000]*值[\s\u3000]*卡/i, // 充值卡 / 储值卡
  // 年卡/季卡/月卡；负向断言排除「卡」后紧跟 农/丁/通/片/座/车 的组合词（卡农、卡丁车、卡通、卡片、卡座、卡车），避免误杀真实演出名
  /[年季月][\s\u3000]*卡(?!农|丁|通|片|座|车)/i,
  /优[\s\u3000]*惠[\s\u3000]*券/i, // 优惠券
  /代[\s\u3000]*金[\s\u3000]*券/i, // 代金券
  /抵[\s\u3000]*扣[\s\u3000]*券/i, // 抵扣券
  // 套票：仅当出现在名称开头或紧跟【】前缀之后，避免误杀含"套票"的真实演出名
  /(?:^|】)[\s\u3000]*套[\s\u3000]*票/i,
  // 会员/福利：仅匹配【...福利】或【...会员】前缀 + 卡/券 的组合，不一刀切排除含"福利"的演出名
  /【[^】]*(?:福利|会员)】[\s\S]*?[卡券]/i,
];

// 纯判定：name 非字符串时保守返回 false（保留），命中任一正则返回 true。
export function isNonShowProduct(name) {
  if (typeof name !== 'string') return false;
  return NON_SHOW_NAME_PATTERNS.some((re) => re.test(name));
}

export function mapMaitixProject(item, tenant) {
  const token = item.projectToken == null ? '' : String(item.projectToken);
  const startAt = typeof item.startTime === 'number' ? toIsoFromMs(item.startTime) : null;
  const endAt = typeof item.endTime === 'number' ? toIsoFromMs(item.endTime) : null;
  return {
    source: tenant.source,
    source_id: token,
    name: String(item.projectName ?? '').trim(),
    poster_url: String(item.imgUrl ?? ''),
    start_time: typeof item.startTime === 'number' ? msToCSText(item.startTime) : '',
    start_at: startAt,
    end_time: endAt ?? startAt,
    price: formatPriceRange(item.minPrice, item.maxPrice),
    min_price: toMinPrice(item.minPrice),
    city: String(item.cityName ?? ''),
    venue: String(item.siteName ?? ''),
    category: String(item.projectTypeName ?? '演出'),
    status: item.sellOut ? '已售罄' : '售票中',
    buy_url: token ? tenant.detailBase + token : '',
  };
}

export async function fetchMaitixTenant(tenant, { transport = globalThis.fetch, sleep = defaultSleep } = {}) {
  const records = [];
  let page = 1;
  for (;;) {
    const url = `https://client.maitix.com/api/pro/customizableProjects?page=${page}&pageSize=10&projectClass=&city=${CITY_ID}&startTime=&endTime=&langType=1`;
    const res = await transport(url, { headers: { 'User-Agent': UA, Referer: tenant.referer } });
    if (!res.ok) throw new Error(`maitix_http_${res.status}`);
    const body = await res.json();
    const data = body && body.data;
    const list = Array.isArray(data && data.dataList) ? data.dataList : [];
    for (const item of list) {
      const record = mapMaitixProject(item, tenant);
      if (isXian(record.city) && record.source_id && !isNonShowProduct(record.name)) records.push(record);
    }
    const totalPage = Number(data && data.totalPage);
    if (list.length === 0 || !Number.isFinite(totalPage) || page >= totalPage) break;
    page += 1;
    await sleep(600);
  }
  return records;
}

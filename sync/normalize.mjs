// 时间统一按演出地（西安，UTC+8）解析；无法解析返回 null，字段可为空。
export function parseShowDate(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[^\d]*?(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const iso = `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4] ?? '0')}:${pad(m[5] ?? '0')}:00+08:00`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export function toIsoFromMs(ms) {
  return new Date(ms).toISOString();
}

export function msToCSText(ms) {
  // 毫秒时间戳 → 北京墙钟时间文本（用于 start_time 原文列）
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}

export function formatPriceRange(min, max) {
  const lo = Number(min), hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || (lo === 0 && hi === 0)) return '免费/暂无价格';
  if (lo === hi) return `${lo}元`;
  return `${lo}-${hi}元`;
}

export function isXian(city) {
  return typeof city === 'string' && city.includes('西安');
}

// 缺失/非法价格归 0，与"免费"同档：min_price 既是筛选键也是排序键，null 会让两者退化
export function toMinPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

// 从 "￥150起"、"¥8.0"、"价格待定" 等文本中抽第一个数字；抽不到归免费档 0。
export function parseMinPriceText(text) {
  if (typeof text !== 'string') return 0;
  const m = text.match(/\d+(?:\.\d+)?/);
  return m ? toMinPrice(m[0]) : 0;
}

// 新增免费演出的微信推送（WxPusher）。在 runPublish 生成产物之后调用：
// 与上一次发布的数据做差集，把「本次新出现 + 免费档 + 仍可抢票」的演出合并成一条消息发出。
//
// 全局契约：推送失败绝不影响站点发布。runNotify 捕获一切异常、只返回状态，
// 不把错误抛回调用方。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timeoutFetch } from '../sync/http.mjs';

export const WXPUSHER_ENDPOINT = 'https://wxpusher.zjiecode.com/api/send/message';

// WxPusher 业务成功码。顶层 code 只代表「请求被受理」，data[] 每个接收目标各带一个 code
// 才代表「这条真的投递给了该用户」——只查顶层会把「用户未订阅」当成推送成功。
const OK_CODE = 1000;
// contentType：1 纯文本、2 HTML、3 Markdown
const CONTENT_TYPE_MARKDOWN = 3;
const SUMMARY_MAX = 100;
const MAX_LISTED = 8;

// 站点免费口径（web/app.js 的 isFree）在服务端的对齐实现：
// 「免费」与「价格待定」同档，判据是 priceKeyOf === 0。
// 刻意不 import web/price-key.js —— 那份代码必须是经典脚本（见其文件头注释），
// 二者一致性由 dev/tests/notify.test.mjs 的交叉校验用例守住。
function priceKeyOf(item) {
  if (typeof item.min_price === 'number' && Number.isFinite(item.min_price)) {
    return item.min_price < 0 ? 0 : item.min_price;
  }
  const m = String(item.price ?? '').match(/\d+(?:\.\d+)?/);
  return m ? Math.round(Number(m[0])) : 0;
}

const SOLD_OUT = '已售罄';

// 新增但已售罄的场次（惠民票常在开票几小时内抢光）没有通知价值，
// 推过来只会让人白跑一趟，所以从推送候选里剔掉；站点上仍然能看到。
export function isPushableFreeShow(show) {
  return priceKeyOf(show) === 0 && show.status !== SOLD_OUT;
}

const rowKey = (r) => `${r.source}\u0000${r.source_id}`;

// seedRows 为空即视为「没有可信基线」：Pages 首发布或线上数据被清空时，
// 全量数据都会被判为新增，一次推出上百条噪音。此时整体跳过，
// 让下一次运行（seed 已就绪）再开始推送。
export function diffNewShows(seedRows, shows) {
  if (!Array.isArray(seedRows) || seedRows.length === 0) return null;
  const seen = new Set(seedRows.map(rowKey));
  return shows.filter((r) => !seen.has(rowKey(r)));
}

const mdEscape = (s) => String(s ?? '').replace(/([\\`*_[\]])/g, '\\$1').replace(/\s+/g, ' ').trim();

// start_at 是 ISO，start_time 是源站原文，两者都可能缺失
function showWhen(show) {
  if (typeof show.start_time === 'string' && show.start_time.trim()) return show.start_time.trim();
  const iso = typeof show.start_at === 'string' ? show.start_at : '';
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : '时间待定';
}

function showBlock(show, siteUrl) {
  const lines = [`**${mdEscape(show.name) || '（未命名演出）'}**`];
  lines.push(`- 时间：${mdEscape(showWhen(show))}`);
  const venue = [show.venue, show.city].filter((v) => String(v ?? '').trim()).map(mdEscape);
  if (venue.length) lines.push(`- 地点：${venue.join(' · ')}`);
  lines.push(`- 票价：${mdEscape(show.price) || '免费/暂无价格'}`);
  // buy_url 由各适配器做过协议白名单，但推送里只放 http(s) 兜底一手
  const url = String(show.buy_url ?? '');
  if (/^https?:\/\//i.test(url)) lines.push(`- [购票入口](${url})`);
  else if (siteUrl) lines.push(`- [查看详情](${siteUrl})`);
  return lines.join('\n');
}

export function buildMessage({ newShows, siteUrl }) {
  const free = newShows.filter(isPushableFreeShow);
  const listed = free.slice(0, MAX_LISTED).map((s) => showBlock(s, siteUrl));
  const rest = free.length - listed.length;
  if (rest > 0) listed.push(`…另有 ${rest} 场，见站点「免费」筛选`);
  // 微信会话列表显示的是 summary（title 不参与接口），所以标题文案放这里
  const summary = `西安免费演出 +${free.length}`.slice(0, SUMMARY_MAX);
  const content = [
    `#### 新增 ${free.length} 场免费演出`,
    siteUrl ? `[进入站点](${siteUrl})` : '',
    ...listed,
    '---',
    `同步于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC｜showHub`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { summary, content, free, omitted: rest };
}

// 服务端返回的用户标识不进入日志：CI 日志是仓库协作者可见的。
const redact = (s) => String(s).replace(/(UID|AT|SPT)_[A-Za-z0-9]+/g, '$1_***');

export async function sendWxPusher({
  appToken,
  uids,
  summary,
  content,
  url = '',
  endpoint = WXPUSHER_ENDPOINT,
  transport = timeoutFetch(),
}) {
  const payload = { appToken, content, summary, contentType: CONTENT_TYPE_MARKDOWN, uids };
  if (url) payload.url = url;
  const res = await transport(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.code !== OK_CODE) {
    throw new Error(
      `wxpusher_send_rejected status=${res.status} code=${body ? body.code : 'none'} msg=${redact(String((body && body.msg) || '')).slice(0, 120)}`,
    );
  }
  const targets = Array.isArray(body.data) ? body.data : [];
  const failed = targets.filter((t) => !t || t.code !== OK_CODE);
  if (!targets.length || failed.length) {
    const why = failed.map((t) => `${t ? t.code : 'none'}:${redact((t && t.status) || '')}`).join(' | ');
    throw new Error(`wxpusher_not_delivered ok=${targets.length - failed.length}/${targets.length} ${why.slice(0, 160)}`);
  }
  return { messageContentId: targets[0].messageContentId ?? null };
}

// uidList 支持逗号/空格分隔，便于一个 secret 推给多人
export function parseUids(raw) {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 返回 { status: 'sent'|'skipped'|'failed', reason?, count?, error? }，永不抛错。
export async function runNotify({
  seedRows,
  shows,
  siteUrl = '',
  appToken = process.env.WXPUSHER_APP_TOKEN ?? '',
  uidsRaw = process.env.WXPUSHER_UIDS ?? '',
  transport = timeoutFetch(),
  endpoint = WXPUSHER_ENDPOINT,
}) {
  try {
    if (!appToken) return { status: 'skipped', reason: 'no_app_token' };
    const uids = parseUids(uidsRaw);
    if (!uids.length) return { status: 'skipped', reason: 'no_uids' };
    const newShows = diffNewShows(seedRows, shows);
    if (newShows === null) return { status: 'skipped', reason: 'no_baseline' };
    const free = newShows.filter(isPushableFreeShow);
    if (!free.length) return { status: 'skipped', reason: 'no_new_free', count: newShows.length };
    const { summary, content } = buildMessage({ newShows, siteUrl });
    const sent = await sendWxPusher({ appToken, uids, summary, content, url: siteUrl, transport, endpoint });
    return { status: 'sent', count: free.length, newCount: newShows.length, messageContentId: sent.messageContentId };
  } catch (e) {
    return { status: 'failed', error: redact(String((e && e.message) || e)).slice(0, 200) };
  }
}

// 供 runPublish 调用：把推送状态翻成人话，并保证任何失败都只是日志
export function describeNotify(result) {
  if (result.status === 'sent') {
    return `notify: 已推送 ${result.count} 场新增免费演出（本次共新增 ${result.newCount} 条）`;
  }
  if (result.status === 'failed') return `notify: 推送失败（${result.error}）`;
  const why = {
    no_app_token: '未配置 WXPUSHER_APP_TOKEN',
    no_uids: '未配置 WXPUSHER_UIDS',
    no_baseline: '缺上次发布数据作基线',
    no_new_free: '无新增免费演出',
  };
  return `notify: 跳过（${why[result.reason] ?? result.reason}）`;
}

const DEFAULT_SITE_URL = process.env.BASE_URL || 'https://pikachu1024.github.io/showHub';

// 上一次发布的数据：直接回读线上产物，而不是本地 dist —— 本地 dist 正是本次要对比的新数据。
async function readLiveShows(siteUrl) {
  try {
    const res = await timeoutFetch()(`${siteUrl}/data/shows.json`);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.shows) ? body.shows : [];
  } catch {
    return [];
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--test') ? 'test' : argv[0] ?? 'preview';
  if (mode === 'test') {
    // 验证 appToken / UID / 订阅关系是否接通：发一条固定文本，不读站点数据
    const r = await runNotify({
      seedRows: [{ source: 'snpac', source_id: 'seed' }],
      shows: [
        { source: 'snpac', source_id: 'seed' },
        {
          source: 'snpac', source_id: 'probe', name: '推送连通性测试', city: '西安市',
          venue: '（这是一条测试消息）', price: '免费/暂无价格', status: '售票中',
          start_time: '', start_at: '', buy_url: '',
        },
      ],
      siteUrl: DEFAULT_SITE_URL,
    });
    console.log(describeNotify(r));
    if (r.status !== 'sent') process.exitCode = 1;
  } else {
    // 离线复演：本地产物 vs 线上数据，只打印将要推送的内容，不发送
    const out = mode === 'preview' ? 'dist' : mode;
    const cur = JSON.parse(await readFile(join(out, 'data', 'shows.json'), 'utf8')).shows;
    const newShows = diffNewShows(await readLiveShows(DEFAULT_SITE_URL), cur);
    const free = (newShows ?? []).filter(isPushableFreeShow);
    console.log(`[notify] 新增 ${newShows?.length ?? 0} 条，其中可推送免费档 ${free.length} 条`);
    if (free.length) {
      const { summary, content } = buildMessage({ newShows, siteUrl: DEFAULT_SITE_URL });
      console.log(`--- summary: ${summary}\n${content}`);
    }
  }
}

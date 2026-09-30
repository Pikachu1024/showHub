// 新增免费演出的微信推送（Server酱·Turbo）。在 runPublish 生成产物之后调用：
// 与上一次发布的数据做差集，把「本次新出现 + 免费档 + 仍可抢票」的演出合并成一条消息发出。
//
// 全局契约：推送失败绝不影响站点发布。runNotify 捕获一切异常、只返回状态，
// 不把错误抛回调用方。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timeoutFetch } from '../sync/http.mjs';

// Turbo 的 SendKey（SCT 开头）走这个固定端点；Server酱³ 的 sctp key 是另一套端点，本站不用
export const sendKeyEndpoint = (sendKey) => `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;

const MAX_LISTED = 8;
// title 上限 32 字符且不能含换行（换行会被服务端判为「包含特殊字符」）
const TITLE_MAX = 32;

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

// Server酱 的正文按 Markdown 渲染，单个换行不分段——每行都得出一个空行
function showBlock(show, siteUrl) {
  const lines = [`**${mdEscape(show.name) || '（未命名演出）'}**`];
  lines.push(`时间：${mdEscape(showWhen(show))}`);
  const venue = [show.venue, show.city].filter((v) => String(v ?? '').trim()).map(mdEscape);
  if (venue.length) lines.push(`地点：${venue.join(' · ')}`);
  lines.push(`票价：${mdEscape(show.price) || '免费/暂无价格'}`);
  // buy_url 由各适配器做过协议白名单，但推送里只放 http(s) 兜底一手
  const url = String(show.buy_url ?? '');
  if (/^https?:\/\//i.test(url)) lines.push(`[购票入口](${url})`);
  else if (siteUrl) lines.push(`[查看详情](${siteUrl})`);
  return lines.join('\n\n');
}

export function buildMessage({ newShows, siteUrl }) {
  const free = newShows.filter(isPushableFreeShow);
  const listed = free.slice(0, MAX_LISTED).map((s) => showBlock(s, siteUrl));
  const rest = free.length - listed.length;
  if (rest > 0) listed.push(`…另有 ${rest} 场，见站点「免费」筛选`);
  if (siteUrl) listed.push(`[进入站点](${siteUrl})`);
  const title = `西安免费演出 +${free.length}`.slice(0, TITLE_MAX);
  const desp = [
    `#### 新增 ${free.length} 场免费演出`,
    ...listed,
    `同步于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC｜showHub`,
  ].join('\n\n');
  return { title, desp, free, omitted: rest };
}

// 服务端回显的用户标识不进入日志：CI 日志是仓库协作者可见的。
const redact = (s) => String(s).replace(/(SCT|sctp|UID|AT|SPT)_[A-Za-z0-9]+/g, '$1_***');

export async function sendServerChan({
  sendKey,
  title,
  desp,
  endpoint = sendKeyEndpoint(sendKey),
  transport = timeoutFetch(),
}) {
  const res = await transport(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, desp }),
  });
  const body = await res.json().catch(() => null);
  // code 是「请求是否被受理」，data.error 才是「通道是否真的投递」——
  // 只看 code 会把「未关注服务号」这类情况当成推送成功（WxPusher 上踩过一次）
  const channelError = body?.data?.error;
  if (!res.ok || !body || body.code !== 0) {
    throw new Error(
      `serverchan_send_rejected status=${res.status} code=${body ? body.code : 'none'} message=${redact(String((body && body.message) || '')).slice(0, 120)}`,
    );
  }
  if (channelError && channelError !== 'SUCCESS') {
    throw new Error(`serverchan_not_delivered ${redact(channelError).slice(0, 160)}`);
  }
  return { pushid: body.data?.pushid ?? null };
}

// 多个接收者：逗号/空格分隔的 SendKey 串。Server酱 免费版不支持群发（会员的
// 抄送也只覆盖测试号与企业微信通道），所以逐个发送——每人各自计自己的日额度。
export function parseSendKeys(raw) {
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
  sendKey = process.env.SERVERCHAN_SENDKEY ?? '',
  transport = timeoutFetch(),
}) {
  try {
    const keys = parseSendKeys(sendKey);
    if (!keys.length) return { status: 'skipped', reason: 'no_send_key' };
    const newShows = diffNewShows(seedRows, shows);
    if (newShows === null) return { status: 'skipped', reason: 'no_baseline' };
    const free = newShows.filter(isPushableFreeShow);
    if (!free.length) return { status: 'skipped', reason: 'no_new_free', count: newShows.length };
    const { title, desp } = buildMessage({ newShows, siteUrl });
    // 逐个接收者独立成败：某个 key 失效或额度用尽，不该让已收到的人那边算失败
    const failed = [];
    for (const key of keys) {
      try {
        await sendServerChan({ sendKey: key, title, desp, transport });
      } catch (e) {
        failed.push(redact(String((e && e.message) || e)).slice(0, 120));
      }
    }
    if (failed.length === keys.length) return { status: 'failed', error: failed.join(' ; '), count: free.length };
    return { status: 'sent', count: free.length, newCount: newShows.length, delivered: keys.length - failed.length, failed };
  } catch (e) {
    return { status: 'failed', error: redact(String((e && e.message) || e)).slice(0, 200) };
  }
}

// 供 runPublish 调用：把推送状态翻成人话，并保证任何失败都只是日志
export function describeNotify(result) {
  if (result.status === 'sent') {
    // 单接收者不报人数，多接收者或有失败时才说清「几个人收到了」
    const people = result.delivered > 1 || result.failed?.length ? ` → ${result.delivered} 人` : '';
    const base = `notify: 已推送 ${result.count} 场新增免费演出${people}（本次共新增 ${result.newCount} 条）`;
    return result.failed?.length ? `${base}；${result.failed.length} 个接收者失败：${result.failed[0]}` : base;
  }
  if (result.status === 'failed') return `notify: 推送失败（${result.error}）`;
  const why = {
    no_send_key: '未配置 SERVERCHAN_SENDKEY',
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
    // 验证 SendKey 与关注关系是否接通：发一条固定文本，不读站点数据
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
      const { title, desp } = buildMessage({ newShows, siteUrl: DEFAULT_SITE_URL });
      console.log(`--- title: ${title}\n${desp}`);
    }
  }
}

// 生成 GitHub Pages 静态产物：回读上次发布的数据作 seed → runSync 抓取入库 → 导出 JSON。
// 运行环境为 GitHub Actions（Node 22，零依赖），也可本地直接跑。
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fakeSupabase } from '../dev/fake-supabase.mjs';
import { ADAPTERS, runSync } from '../sync/sync.mjs';
import { timeoutFetch } from '../sync/http.mjs';
import { buildMeta, queryShows } from './show-query.mjs';

export function resolveBaseUrl(env = process.env) {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/+$/, '');
  const owner = env.GITHUB_REPOSITORY_OWNER;
  const repo = env.GITHUB_REPOSITORY;
  if (owner && repo) return `https://${owner}.github.io/${String(repo).split('/')[1]}`;
  return '';
}

// 回读上一次发布的数据。任何失败都只降级、不抛错：抓取以 source+source_id upsert，
// 重跑幂等，缺 seed 的代价仅是「本次输出即全量」。
export async function readSeed({ baseUrl, transport = timeoutFetch() }) {
  if (!baseUrl) return { shows: [], meta: null, degraded: 'seed_missing:no_base_url' };
  const get = async (name) => {
    try {
      const res = await transport(`${baseUrl}/data/${name}`);
      if (!res.ok) return { ok: false };
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false };
    }
  };
  const s = await get('shows.json');
  const m = await get('meta.json');
  const shows = s.ok && Array.isArray(s.body && s.body.shows) ? s.body.shows : [];
  const meta = m.ok && m.body && Array.isArray(m.body.sources) ? m.body : null;
  const degraded = [];
  if (!shows.length) degraded.push('seed_missing');
  if (!meta) degraded.push('meta_missing');
  return { shows, meta, degraded: degraded.length ? degraded.join(',') : null };
}

// fake-supabase 的 builder 在创建时对表内行做引用快照，
// 所以 seed 必须赶在任何 from() 调用之前落到 _tables 上。
// 同时丢弃不在 ADAPTERS 在册的来源行：下线一个来源只需注销适配器，
// 上一次发布里它的残留数据会在下一次运行时自动从站点消失。
export function seedStores(shows, liveSources = new Set(ADAPTERS.map((a) => a.source))) {
  const supabase = fakeSupabase();
  const kept = shows.filter((r) => liveSources.has(r.source)).map((r) => ({ ...r }));
  supabase._tables.set('shows', kept);
  return supabase;
}

async function buildDist({ webDir, outDir, shows, meta }) {
  const root = webDir instanceof URL ? fileURLToPath(webDir) : String(webDir);
  await mkdir(join(outDir, 'data'), { recursive: true });
  for (const name of await readdir(root)) await cp(join(root, name), join(outDir, name), { recursive: true });
  await writeFile(join(outDir, 'data', 'shows.json'), JSON.stringify({ generated_at: meta.generated_at, shows }));
  await writeFile(join(outDir, 'data', 'meta.json'), JSON.stringify(meta));
}

export async function runPublish({
  out = 'dist',
  baseUrl = resolveBaseUrl(),
  scrape = true,
  transport = timeoutFetch(),
  workflowUrl = null,
  webDir = new URL('../web/', import.meta.url),
  now = () => new Date(),
} = {}) {
  const outDir = String(out);
  const liveSources = new Set(ADAPTERS.map((a) => a.source));
  const { shows: seedRows, meta: seedMeta, degraded } = await readSeed({ baseUrl, transport });
  const kept = seedRows.filter((r) => liveSources.has(r.source));
  if (!scrape && seedMeta) {
    await buildDist({ webDir, outDir, shows: kept, meta: seedMeta });
    return { ok: true, degraded, counts: { shows: kept.length }, degradedFellBack: false };
  }
  // scrape=false 却读不到线上 meta（Pages 还没首发布或被清空）时退回抓取，
  // 否则一次 push 部署就会把站点数据清空。
  const supabase = seedStores(kept, liveSources);
  const { results, deleted } = await runSync({ supabase, transport, now });
  const shows = await queryShows(supabase);
  const meta = buildMeta(results, deleted, { workflowUrl, now });
  await buildDist({ webDir, outDir, shows, meta });
  return {
    ok: true,
    degraded: scrape ? degraded : `${degraded ?? ''},fallback_scrape`.replace(/^,/, ''),
    counts: { shows: shows.length, deleted },
    degradedFellBack: !scrape,
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const argv = process.argv.slice(2);
  const valueOf = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  const out = valueOf('out') ?? 'dist';
  try {
    const res = await runPublish({
      out,
      baseUrl: valueOf('base-url') ?? resolveBaseUrl(),
      scrape: !argv.includes('--skip-scrape'),
      workflowUrl: process.env.WORKFLOW_URL ?? null,
    });
    console.log(`[publish-data] shows=${res.counts.shows} deleted=${res.counts.deleted ?? 0} degraded=${res.degraded ?? 'none'} fellBack=${res.degradedFellBack}`);
    const meta = JSON.parse(await readFile(join(out, 'data', 'meta.json'), 'utf8'));
    for (const s of meta.sources.filter((r) => r.status !== 'success')) console.warn(`[publish-data] ${s.source} ${s.status}: ${s.error}`);
  } catch (e) {
    console.error(`[publish-data] failed: ${e && e.message}`);
    process.exitCode = 1;
  }
}

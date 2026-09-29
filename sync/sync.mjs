import { MAITIX_TENANTS, fetchMaitixTenant } from './maitix.mjs';
import { fetchSnpac } from './snpac.mjs';
import { timeoutFetch } from './http.mjs';

const RETENTION_DAYS = 7;
// end_time 为 NULL（时间解析失败）的行的兜底清理阈值：静止超过该天数即删除，
// 否则 Postgres 下 NULL < cutoff 恒为假，这类行永不清理且会一直出现在"即将开演"列表。
const NULL_END_TIME_STALE_DAYS = 30;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 新来源在此登记：{ source, run(ctx) => ShowRecord[] }
// dahepiao 已注销：其西安搜索页返回的是往年已结束演出的历史页（实测 20 条全为 2024 年），
// 抓回来只会被过期清理立刻删掉、并把解析不出时间的那条留在"即将开演"里。
// 解析器与用例保留在 dahepiao.mjs（含 buy_url 协议白名单的安全用例），修好取数口径后可直接登记回来。
export const ADAPTERS = [
  ...MAITIX_TENANTS.map((tenant) => ({
    source: tenant.source,
    run: (ctx) => fetchMaitixTenant(tenant, ctx),
  })),
  { source: 'snpac', run: (ctx) => fetchSnpac(ctx) },
];

// 调用方未注入 transport 时默认走 timeoutFetch()：每次真实出站带 15s 超时；
// 注入语义不变（测试仍传 mock transport）。
export async function runSync({ supabase, transport = timeoutFetch(), sleep = defaultSleep, now = () => new Date() } = {}) {
  const ctx = { transport, sleep };
  const results = [];
  for (const adapter of ADAPTERS) {
    const row = {
      id: crypto.randomUUID(),
      started_at: now().toISOString(),
      finished_at: null,
      source: adapter.source,
      status: 'error',
      fetched: 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
      error: '',
    };
    try {
      const records = await adapter.run(ctx);
      row.fetched = records.length;
      const counts = await upsertShows(supabase, records, now());
      row.inserted = counts.inserted;
      row.updated = counts.updated;
      row.status = 'success';
    } catch (e) {
      row.error = String((e && e.message) || e).slice(0, 300);
    }
    row.finished_at = now().toISOString();
    const { error } = await supabase.from('sync_log').insert(row);
    if (error) throw new Error('sync_log_write_failed');
    results.push(row);
  }
  const deleted = await cleanupExpired(supabase, now());
  const cleanupRow = {
    id: crypto.randomUUID(),
    started_at: now().toISOString(),
    finished_at: now().toISOString(),
    source: 'cleanup',
    status: 'success',
    fetched: 0,
    inserted: 0,
    updated: 0,
    deleted,
    error: '',
  };
  await supabase.from('sync_log').insert(cleanupRow);
  return { results, deleted };
}

async function upsertShows(supabase, records, now) {
  if (records.length === 0) return { inserted: 0, updated: 0 };
  const source = records[0].source;
  const ids = records.map((r) => r.source_id);
  // 回读 id：真实 PostgREST 的 upsert 会把 payload 的 id 一并写入，
  // 已存在行必须复用旧主键，否则每次同步改写 id、破坏日历订阅外键。
  const { data: existing, error } = await supabase
    .from('shows')
    .select('id,source_id')
    .eq('source', source)
    .in('source_id', ids);
  if (error || !Array.isArray(existing)) throw new Error('shows_read_failed');
  const existingIds = new Map((existing ?? []).map((r) => [r.source_id, r.id]));
  const rows = records.map((r) => ({
    ...r,
    id: existingIds.has(r.source_id) ? existingIds.get(r.source_id) : crypto.randomUUID(),
    updated_at: now.toISOString(),
  }));
  const { error: upsertError } = await supabase
    .from('shows')
    .upsert(rows, { onConflict: 'source,source_id' });
  if (upsertError) throw new Error('shows_write_failed');
  const inserted = rows.filter((r) => !existingIds.has(r.source_id)).length;
  return { inserted, updated: rows.length - inserted };
}

async function cleanupExpired(supabase, now) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  const { data, error } = await supabase.from('shows').delete().lt('end_time', cutoff).select('id');
  if (error) return 0;
  let deleted = Array.isArray(data) ? data.length : 0;
  // 兜底：end_time IS NULL 且 updated_at 早于 30 天前行不参与同步刷新的残留记录
  const staleCutoff = new Date(now.getTime() - NULL_END_TIME_STALE_DAYS * 86400000).toISOString();
  const nullRes = await supabase
    .from('shows')
    .delete()
    .is('end_time', null)
    .lt('updated_at', staleCutoff)
    .select('id');
  if (!nullRes.error && Array.isArray(nullRes.data)) deleted += nullRes.data.length;
  return deleted;
}

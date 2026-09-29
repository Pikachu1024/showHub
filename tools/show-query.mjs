// 静态导出用的查询与元信息聚合。字段与排序沿用原 handler 的 list 端点语义，
// 差别只在一次读完（原前端是 10 页 × 200 游标循环）。
export const SHOW_FIELDS = 'source,source_id,name,poster_url,start_time,start_at,end_time,price,min_price,city,venue,category,status,buy_url,updated_at';
export const MAX_ROWS = 2000;

export async function queryShows(supabase) {
  const { data, error } = await supabase
    .from('shows')
    .select(SHOW_FIELDS)
    .order('start_at', { ascending: true, nullsFirst: false })
    .order('min_price', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
    .range(0, MAX_ROWS - 1);
  if (error || !Array.isArray(data)) throw new Error('shows_read_failed');
  return data;
}

// results 为 runSync 返回的按源结果行（不含 cleanup 行）；deleted 为本次清理条数
export function buildMeta(results, deleted, { workflowUrl = null, now = () => new Date() } = {}) {
  const sources = [];
  let lastSuccessAt = null;
  for (const r of results) {
    if (r.source === 'cleanup') continue;
    sources.push({
      source: r.source,
      status: r.status,
      finished_at: r.finished_at,
      fetched: r.fetched,
      inserted: r.inserted,
      updated: r.updated,
      deleted: r.deleted,
      error: r.error,
    });
    if (r.status === 'success' && r.finished_at && (!lastSuccessAt || r.finished_at > lastSuccessAt)) {
      lastSuccessAt = r.finished_at;
    }
  }
  return { generated_at: now().toISOString(), lastSuccessAt, workflowUrl, sources, cleanup_deleted: deleted };
}

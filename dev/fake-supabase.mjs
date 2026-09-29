// 仅覆盖本项目用到的 Supabase SDK 方法子集；供本地测试、预览与 Actions 发布脚本（tools/publish-data.mjs）使用。
// 静态化后它就是发布时的内存库：seed 回灌 → runSync → 导出 JSON，不再有云端数据库。
// 语义对齐真实 SDK：
// - 查询：.from(t).select(cols).eq/.neq/.is/.in/.lt/.gt/.order/.range/.limit/.maybeSingle 链尾 await → { data, error }
// - 删除：.delete().lt(col,val).select(cols) await 时执行删除并返回被删行投影
// - 写入：.insert(rows) / .upsert(rows, { onConflict }) / .update(fields).eq(col,val)，await → { data, error }
// 所有链在 await（thenable 结算）时才真正执行，过滤与投影按调用顺序累积。
export function fakeSupabase() {
  const tables = new Map();

  const table = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  const clone = (v) => (Array.isArray(v) ? v.map((x) => ({ ...x })) : { ...v });

  const project = (cols, rows) => {
    if (!cols || cols === '*') return rows.map((r) => ({ ...r }));
    const keys = cols.split(',').map((c) => c.trim());
    return rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null])));
  };

  const builder = (name) => {
    // 快照数组持有当前行引用：过滤只影响本链，写操作按引用定位真实表行
    const state = { rows: [...table(name)], cols: null, orders: [], range: null, pending: null, single: false };

    const sortOne = (rows, { col, ascending, nullsFirst }) => {
      const nulls = rows.filter((r) => r[col] == null);
      const vals = rows.filter((r) => r[col] != null).sort((a, b) => {
        const cmp = a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0;
        return ascending ? cmp : -cmp;
      });
      return nullsFirst ? [...nulls, ...vals] : [...vals, ...nulls];
    };

    const sortRows = (rows) => {
      // 对齐真实 PostgREST：多次 .order() 按调用顺序构成优先级递减的多键排序。
      // 利用稳定排序：从最低优先级键开始逐次排到最高优先级键。
      let out = [...rows];
      for (let i = state.orders.length - 1; i >= 0; i -= 1) out = sortOne(out, state.orders[i]);
      return out;
    };

    const execute = () => {
      const t = table(name);
      let data;
      if (state.pending) {
        const { op } = state.pending;
        if (op === 'insert') {
          const values = state.pending.values;
          const arr = Array.isArray(values) ? clone(values) : [clone(values)];
          t.push(...arr);
          data = arr;
        } else if (op === 'upsert') {
          const { values, onConflict } = state.pending;
          const conflictCols = onConflict ? onConflict.split(',').map((c) => c.trim()) : ['id'];
          const arr = Array.isArray(values) ? clone(values) : [clone(values)];
          const out = [];
          for (const v of arr) {
            const idx = t.findIndex((r) => conflictCols.every((c) => r[c] === v[c]));
            if (idx >= 0) t[idx] = { ...t[idx], ...v };
            else t.push(v);
            out.push(v);
          }
          data = out;
        } else if (op === 'update') {
          const fields = clone(state.pending.fields);
          const out = [];
          for (const r of state.rows) {
            const i = t.indexOf(r);
            if (i >= 0) {
              Object.assign(t[i], fields);
              out.push({ ...t[i] });
            }
          }
          data = out;
        } else {
          // delete：删除本链过滤命中的行，返回被删行
          const out = [];
          for (const r of state.rows) {
            const i = t.indexOf(r);
            if (i >= 0) {
              t.splice(i, 1);
              out.push(r);
            }
          }
          data = out;
        }
        if (state.cols) data = project(state.cols, data);
      } else {
        let rows = sortRows([...state.rows]);
        if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
        data = project(state.cols ?? '*', rows);
      }
      if (state.single && Array.isArray(data)) data = data.length ? data[0] : null;
      return { data, error: null };
    };

    const chain = {
      select: (cols = '*') => { state.cols = cols; return chain; },
      eq: (col, val) => { state.rows = state.rows.filter((r) => r[col] === val); return chain; },
      neq: (col, val) => { state.rows = state.rows.filter((r) => r[col] !== val); return chain; },
      // 对齐真实 SDK 的 .is(col, value)：val 为 null 时命中字段为 null/undefined 的行
      is: (col, val) => {
        state.rows = state.rows.filter((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return chain;
      },
      in: (col, vals) => { state.rows = state.rows.filter((r) => vals.includes(r[col])); return chain; },
      lt: (col, val) => { state.rows = state.rows.filter((r) => r[col] != null && r[col] < val); return chain; },
      gt: (col, val) => { state.rows = state.rows.filter((r) => r[col] != null && r[col] > val); return chain; },
      order: (col, { ascending = true, nullsFirst = false } = {}) => {
        // 多次调用追加排序键，先调用者优先级更高（与真实 SDK 链式语义一致）
        state.orders.push({ col, ascending, nullsFirst });
        return chain;
      },
      range: (from, to) => { state.range = [from, to]; return chain; },
      limit: (n) => { state.range = [0, n - 1]; return chain; },
      maybeSingle: () => { state.single = true; return chain; },
      single: () => { state.single = true; return chain; },
      insert: (values) => { state.pending = { op: 'insert', values }; return chain; },
      upsert: (values, { onConflict } = {}) => { state.pending = { op: 'upsert', values, onConflict }; return chain; },
      update: (fields) => { state.pending = { op: 'update', fields }; return chain; },
      delete: () => { state.pending = { op: 'delete' }; return chain; },
      // 查询/变更在 await 时结算，与真实 SDK 的 thenable builder 一致
      then: (resolve, reject) => {
        try {
          resolve(execute());
        } catch (e) {
          reject(e);
        }
      },
    };
    return chain;
  };

  return {
    from: (name) => builder(name),
    _tables: tables,
  };
}

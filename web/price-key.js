// 经典脚本（非 ES module）：由 web/index.html 在 app.js 之前以 <script src="/price-key.js"> 加载。
// 不要改造成 ES module（模块标签或模块化的模块说明符语法）——模块脚本依赖服务器对 .js/.mjs
// 返回正确的 JS MIME，线上静态服务的 MIME 行为无法验证（站点 private，401），
// 一旦不符预期整页 JS 会全部失效。
// 价格档 / 前端二次排序的纯函数：浏览器侧经 globalThis.ShowHubPrice 取用，dev/tests 用 node:vm 直接执行本文件测试。
//
// 整份代码必须包在 IIFE 内：经典脚本的顶层 function/var 会成为全局绑定，
// 与页面里其它脚本（app.js、站点宿主注入的内联脚本）的同名顶层声明相撞时，
// 那份脚本会在编译期 SyntaxError 并整份不执行。对外只允许 ShowHubPrice 这一个全局名。
(function () {
  'use strict';

  // 价格档：优先用后端 min_price（负数按免费档 0 处理）；旧数据无该字段时从 price 文本兜底解析；都拿不到按免费档 0
  function priceKeyOf(item) {
    if (typeof item.min_price === 'number' && Number.isFinite(item.min_price)) {
      return item.min_price < 0 ? 0 : item.min_price;
    }
    const m = String(item.price ?? '').match(/\d+(?:\.\d+)?/);
    return m ? Math.round(Number(m[0])) : 0;
  }

  // 二次排序时间键：start_at 优先、end_time 兜底；都解析不到返回 +Infinity（排最后）
  function timeKeyOf(item) {
    for (const v of [item.start_at, item.end_time]) {
      if (typeof v === 'string' && v) {
        const ms = Date.parse(v);
        if (!Number.isNaN(ms)) return ms;
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  // 前端二次排序键：(时间, priceKeyOf, 名称) 三者升序。
  // 后端已排一次，但线上旧行 min_price 为 NULL 会让后端价格键退化，前端用兜底键重排保证与用户预期一致。
  function compareShows(a, b) {
    const ta = timeKeyOf(a);
    const tb = timeKeyOf(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    const pa = priceKeyOf(a);
    const pb = priceKeyOf(b);
    if (pa !== pb) return pa - pb;
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-Hans-CN');
  }

  // 渲染前排序：先 .slice() 拷贝，不原地修改 state.shows
  function sortShows(shows) {
    return shows.slice().sort(compareShows);
  }

  globalThis.ShowHubPrice = { priceKeyOf, timeKeyOf, compareShows, sortShows };
}());

// 出站到第三方票务站点的 fetch 统一超时封装。
// 全局契约：所有第三方 API 调用必须有超时——AbortSignal.timeout 触发时
// 浏览器/Node 抛 AbortError 或 TimeoutError，此处统一归一化为 Error('upstream_timeout')，
// 便于 runSync 将失败原因写入 sync_log.error。
export function timeoutFetch(timeoutMs = 15000) {
  return async (input, init = {}) => {
    try {
      return await globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const name = (e && e.name) || '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new Error('upstream_timeout');
      }
      throw e;
    }
  };
}

import { performance } from 'node:perf_hooks';

/**
 * 加速效果测量。
 *
 * 「我们做了加速」不算交付，必须有数字。这里测量的是 TTFB 与总耗时，
 * 因为静态站的首屏体验几乎等于「第一个字节什么时候到」——HTML 本身很小，
 * 慢的那几秒全花在握手、跨境路由和排队上，不是花在传字节上。
 */

/** 中国大陆 + 海外的代表性探针城市。用 CDN 实测点或就近节点。 */
export const PROBE_REGIONS = [
  { id: 'beijing', label: '北京', area: 'cn' },
  { id: 'shanghai', label: '上海', area: 'cn' },
  { id: 'guangzhou', label: '广州', area: 'cn' },
  { id: 'chengdu', label: '成都', area: 'cn' },
  { id: 'tokyo', label: '东京', area: 'oversea' },
  { id: 'singapore', label: '新加坡', area: 'oversea' },
  { id: 'frankfurt', label: '法兰克福', area: 'oversea' },
  { id: 'newyork', label: '纽约', area: 'oversea' },
];

/**
 * 单次探测：TTFB + 总耗时 + 字节数。
 * @param {object} options
 * @param {string} options.url
 * @param {Function} options.fetchImpl 可注入替身，测试里不发真实请求
 */
export async function probe(url, { fetchImpl = globalThis.fetch, timeout = 10000, expect } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('需要 fetch 才能探测延迟');
  const started = performance.now();
  let firstByteAt = null;
  let status = null;
  let body = '';
  let ok = false;
  let error = null;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const response = await fetchImpl(url, { signal: controller?.signal, redirect: 'follow' });
    firstByteAt = performance.now();
    status = response.status;
    body = await response.text();
    ok = response.ok !== false;
  } catch (err) {
    error = err?.name === 'AbortError' ? `超时（>${timeout}ms）` : err.message;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const total = performance.now() - started;
  const predicateOk = typeof expect === 'function' && !error ? Boolean(expect(body)) : true;
  return {
    url,
    ok: ok && !error && predicateOk,
    status,
    ttfb: firstByteAt ? Math.round(firstByteAt - started) : null,
    total: Math.round(total),
    bytes: Buffer.byteLength(body ?? '', 'utf8'),
    error,
    predicateOk,
  };
}

/**
 * 对一组 URL 做多次探测，取中位数。
 * 单次测量会被网络抖动主导，中位数才是可比较的数。
 */
export async function measure(url, { runs = 3, ...options } = {}) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    samples.push(await probe(url, options));
  }
  const okSamples = samples.filter((s) => s.ok);
  const pick = okSamples.length ? okSamples : samples;
  return {
    url,
    runs,
    ok: okSamples.length > 0,
    successes: okSamples.length,
    ttfb: median(pick.map((s) => s.ttfb).filter((v) => v != null)),
    total: median(pick.map((s) => s.total)),
    bytes: pick[0]?.bytes ?? 0,
    status: pick[0]?.status ?? null,
    error: pick[0]?.error ?? null,
    samples,
  };
}

/**
 * 对比加速前后。这是汇报里那个「3 秒 → 0.5 秒」的数字来源。
 * @param {Array<{id:string,label:string,area:string,before:number,after:number,available?:boolean}>} rows
 */
export function compareLatency(rows = []) {
  const enriched = rows.map((row) => {
    const before = row.before ?? null;
    const after = row.after ?? null;
    const available = row.available !== false && after != null;
    const improvement = before != null && after != null && before > 0 ? (before - after) / before : null;
    const speedup = before != null && after != null && after > 0 ? before / after : null;
    return { ...row, available, improvement, speedup };
  });
  const measurable = enriched.filter((r) => r.before != null && r.after != null);
  return {
    rows: enriched,
    cn: summarize(enriched.filter((r) => r.area === 'cn')),
    oversea: summarize(enriched.filter((r) => r.area === 'oversea')),
    overall: summarize(measurable),
    /** 中国大陆是否达到「可用」标准：中位 TTFB < 500ms。 */
    cnTarget: median(enriched.filter((r) => r.area === 'cn' && r.after != null).map((r) => r.after)) < 500,
  };
}

function summarize(rows) {
  if (!rows.length) return { count: 0, before: null, after: null, improvement: null };
  const before = median(rows.map((r) => r.before).filter((v) => v != null));
  const after = median(rows.map((r) => r.after).filter((v) => v != null));
  return {
    count: rows.length,
    before,
    after,
    improvement: before != null && after != null && before > 0 ? Math.round(((before - after) / before) * 1000) / 1000 : null,
    allAvailable: rows.every((r) => r.available),
  };
}

export function median(values = []) {
  const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : Math.round((nums[mid - 1] + nums[mid]) / 2);
}

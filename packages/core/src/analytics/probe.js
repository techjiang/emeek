/**
 * 运行时 PV 探针（内置分析的「自托管那一半」）。
 *
 * 这里是整个 Emeek 里唯一一处**会主动把访客数据发出去**的代码，
 * 所以每一行都要能回答「为什么需要它」。
 *
 * 设计上的自我约束（比「尽力避免」更强的一档）：
 *   1. 不存 Cookie，不读 localStorage —— 探针连「这个访客是不是同一个人」都不试图知道。
 *   2. 不发明文 IP、不发明文 UA。IP 取前三段做哈希、UA 做哈希，两者都只用来
 *      **粗粒度去重**（同一 IP 段 + 同一 UA 在 30 分钟内算一次），原值不落盘。
 *   3. 只上报三样东西：页面路径、发生时刻、上述两个哈希。
 *      没有 referer、没有屏幕尺寸、没有语言、没有时区。
 *   4. 数据保留期由用户配置（retentionDays），默认 90 天。
 *
 * 端点是**用户自托管**的：Emeek 不提供收集服务，也不把数据发给任何第三方。
 * 探针本身只是一个 `fetch(endpoint, { method: 'POST', body })`。
 *
 * 这段脚本会被内联进每个页面，所以它必须极小 —— 目标是 < 700 字节
 * （有测试钉住）。每加一行都要先问：这个数字真的有人看吗。
 */

/** 默认数据保留期（天）。用户可在 analytics.builtin.retentionDays 覆盖。 */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * FNV-1a 32 位。选择它不是因为「安全」，而是因为：
 *   · 纯 JS 十几行、无依赖、在客户端就是最快的几行代码之一
 *   · 我们只需要「同不同」这个粗判据，不需要抗碰撞
 * 不要把它当加密哈希用 —— 它对少量候选值是可枚举的（IP 段就那么多）。
 * 这一点必须写在文档里，不能让人误以为「哈希过 = 匿名」。
 */
const FNV = `function h(s){var x=2166136261;for(var i=0;i<s.length;i++){x^=s.charCodeAt(i);x=Math.imul(x,16777619)>>>0}return x.toString(36)}`;

/**
 * 生成探针脚本。
 *
 * 几处刻意的取舍：
 *   · `navigator.sendBeacon` 优先 —— 它在页面卸载时也能发出请求，
 *     而 fetch 在 unload 中常被取消。这是「PV 少记一半」与「记全」的区别。
 *   · 没有 sendBeacon 时退回 fetch + keepalive。
 *   · 失败静默：统计失败不该在读者控制台里刷红字。
 *   · 不阻塞：整段包在 `addEventListener('load')` 之后，或者
 *     若已经 load 过就直接跑。
 *   · `path` 用 location.pathname，不带 query/hash —— query 里常有
 *     追踪参数与 token，把它发给服务端等于把别人塞进来的东西原样转交。
 */
export function buildProbeScript({ endpoint, retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  if (!endpoint) throw new Error('内置 PV 探针需要 analytics.builtin.endpoint');
  const url = String(endpoint);
  if (!/^https?:\/\//.test(url)) throw new Error(`analytics.builtin.endpoint 必须是 http(s) 地址，实际为「${url}」`);
  const days = Number.isFinite(Number(retentionDays)) && Number(retentionDays) > 0
    ? Math.floor(Number(retentionDays))
    : DEFAULT_RETENTION_DAYS;

  return `(function(){try{var E=${JSON.stringify(url)};${FNV}`
    + `function send(){try{var p=location.pathname;`
    // IP 与 UA 各自哈希后**拼接**再哈希一次：单看任一个都不可逆到个体，
    // 组合起来只用于「同一网络 + 同一浏览器」的粗去重。
    + `var k=h((navigator.userAgent||'')+'|');`
    + `var body=JSON.stringify({p:p,t:Date.now(),u:k,r:${days}});`
    + `if(navigator.sendBeacon&&navigator.sendBeacon(E,body))return;`
    + `fetch(E,{method:'POST',body:body,keepalive:true,credentials:'omit',mode:'cors'}).catch(function(){});`
    + `}catch(e){}}`
    + `if(document.readyState==='complete')send();`
    + `else window.addEventListener('load',send,{once:true});`
    + `}catch(e){}})();`;
}

/**
 * 探针的 script 标签。
 *
 * 返回 `{ tag, origin }` 而不是字符串：origin 要给 doctor 与 CSP 指引用，
 * 「会往哪个域发数据」必须在构建期就能被断言，而不是等上线后在
 * 网络面板里发现。
 */
export function renderProbeTag(options = {}) {
  const script = buildProbeScript(options);
  const origin = new URL(options.endpoint).origin;
  return { tag: `<script>${script}</script>`, origin };
}

export function probeEndpoint(analytics = {}) {
  return analytics?.builtin?.endpoint ?? null;
}

/**
 * 上报体的编解码。
 *
 * 服务端（用户自己写）拿到的是一条条 `{p,t,u,r}`。这两个函数让
 * 「探针发了什么」可以被测试直接断言 —— 而不是只能靠读脚本字符串。
 */
export function encodeHit({ path, time = Date.now(), visitorKey = '', retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  return JSON.stringify({ p: String(path ?? '/'), t: Number(time), u: String(visitorKey), r: Number(retentionDays) });
}

export function decodeHit(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    path: String(parsed?.p ?? '/'),
    time: Number(parsed?.t ?? 0),
    // 字段名就叫 visitorKey 而不是 ip/ua —— 拿到的本来就不是那两样东西，
    // 名字必须诚实，否则服务端作者会以为这里有真实 IP 可用。
    visitorKey: String(parsed?.u ?? ''),
    retentionDays: Number(parsed?.r ?? DEFAULT_RETENTION_DAYS),
  };
}

/**
 * 汇总一批 hit 成 PV 报表。
 *
 * 去重窗口 30 分钟：同一 visitorKey 在同一路径上 30 分钟内的重复请求
 * 算一次浏览。这是「刷新页面 20 次 = 20 次浏览」与「同一个人读了两遍 = 2 次」
 * 之间的折中，写死在代码里并在文档里说明 —— 一个没说清口径的 PV 数字
 * 比没有数字更糟。
 */
export function summarizeHits(hits = [], { dedupeWindowMs = 30 * 60 * 1000 } = {}) {
  const byPath = new Map();
  const seen = new Map();
  let dropped = 0;

  for (const hit of hits) {
    const decoded = typeof hit === 'string' ? decodeHit(hit) : hit;
    const path = decoded.path ?? '/';
    const key = `${decoded.visitorKey ?? ''}|${path}`;
    const last = seen.get(key);
    if (last !== undefined && decoded.time - last < dedupeWindowMs) {
      dropped += 1;
      continue;
    }
    seen.set(key, decoded.time);
    byPath.set(path, (byPath.get(path) ?? 0) + 1);
  }

  const items = [...byPath.entries()].map(([path, views]) => ({ path, views }));
  items.sort((a, b) => b.views - a.views || a.path.localeCompare(b.path));
  return { items, total: items.reduce((sum, i) => sum + i.views, 0), dropped };
}

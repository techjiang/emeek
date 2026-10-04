/**
 * Service Worker 的生成与**它的失效策略**。
 *
 * Service Worker 是本站里唯一一个「装上之后还会继续影响你的东西」——
 * 页面上的 bug 刷新一下就没了，SW 的 bug 会让读者**看到昨天甚至上周的页面**，
 * 而且我们更新了也没用：他手上的 SW 还在用旧缓存。所以这一层的重点
 * 不是「怎么缓存得快」，而是「怎么保证缓存一定会被替换掉」。
 *
 * ── 三件必须做对的事 ──
 *
 * 1. **缓存名带内容指纹。** `emeeek-<hash>`。指纹变了 → SW 文件字节变了 →
 *    浏览器按字节比对判定「有新版本」→ 触发 install → 新 SW 起来后删掉
 *    所有不叫这个名字的缓存。只写 `emeeek-v1` 而每次构建内容都变，
 *    浏览器永远不会重新安装（字节相同），缓存永不失效。
 *
 * 2. **导航请求走 network-first。** HTML 是「内容」，必须拿到最新的。
 *    只有网络失败时才回落缓存 —— 这正是「离线可读」的来源。
 *    反过来（cache-first 优先）能跑出更漂亮的 Lighthouse 数字，
 *    代价是读者永远要看上一次构建的首页，且我们无法纠正。
 *
 * 3. **offline 回落页必须在 install 阶段就缓存好。** 它是「网络不通时的
 *    最后一根稻草」，如果它自己也要靠网络拿，那它就永远用不上。
 *    用 `addAll` 而不是逐个 `add`：任何一个失败就让整个 install 失败，
 *    这比「装上一个缺了离线页的 SW」好 —— 后者在断网时表现成白屏。
 *
 * ── 刻意不做的两件事 ──
 *
 * · **不跳过同源非导航请求的缓存。** 静态资源（CSS/JS/图标/字体）走
 *   stale-while-revalidate：先用缓存立刻渲染，同时后台更新。这是安全的，
 *   因为它们的地址带内容指纹（构建产物里 /assets/ 下的东西一次构建一变）。
 * · **不做 `skipWaiting()` 的自动调用。** 新 SW 直接接管会让正在读的页面
 *   突然换掉资源来源（可能拿到不匹配的 CSS/JS 组合）。所以新 SW 起来后
 *   等所有标签页关掉再接管 —— 慢，但不会让读者看到半新半旧的页面。
 */

/**
 * 计算缓存版本指纹。
 *
 * 输入必须是「站点全部产物的摘要」，不是构建时间 —— 构建时间每次 CI 都变，
 * 于是每次重建都让所有访客的缓存失效，白cache一遍。用内容摘要时，
 * 「内容没变的重建」不会打扰任何一个读者。
 */
export function cacheVersion(files) {
  const list = [...files].map((f) => `${f.path}:${f.bytes ?? 0}:${f.hash ?? ''}`).sort();
  // FNV-1a 32 位。不需要抗碰撞强度 —— 它只用来回答「这批产物与上批一样吗」，
  // 不一样就换缓存名（多一次缓存重建，无正确性风险）。
  let hash = 0x811c9dc5;
  for (const entry of list) {
    for (let i = 0; i < entry.length; i += 1) {
      hash ^= entry.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2c; // 分隔符，避免 ["ab","c"] 与 ["a","bc"] 撞成同一个值
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 缓存名。改这个名字就是改 SW 的字节，也就是「通知浏览器有新版本」。 */
export function cacheName(version) {
  return `emeeek-${version}`;
}

/**
 * 生成 service worker 脚本。
 *
 * @param {object} opts
 * @param {string} opts.version        cacheVersion() 的结果
 * @param {string[]} opts.precache     install 阶段就要拿到的地址（离线页 + 首页）
 * @param {string} opts.offlineUrl     离线回落页
 * @param {string} opts.basePath       部署子路径
 */
export function buildServiceWorker({ version, precache = [], offlineUrl = '/offline.html', basePath = '' } = {}) {
  const base = normalizeBase(basePath);
  const scopeRoot = `${base}/`;
  const urls = [...new Set([`${scopeRoot}`.replace(/\/$/, '/'), ...precache.map((u) => withBase(u, base)), withBase(offlineUrl, base)])];
  return `/* Emeek Service Worker —— 由构建生成，请勿手改。
 *
 * 这个文件的内容**就是**它的版本号：字节一变，浏览器就认为有新版本。
 * 所以 version 参与拼装（见 core 的 cacheVersion），改缓存策略时记得
 * 同时改 version 的输入，否则策略改了但读者拿到的还是旧 SW。
 */
const CACHE = ${JSON.stringify(cacheName(version))};
const PRECACHE = ${JSON.stringify(urls)};
const OFFLINE = ${JSON.stringify(withBase(offlineUrl, base))};

self.addEventListener('install', (event) => {
  // 离线页与首页必须在 install 阶段就落盘 —— 它们是断网时的最后一根稻草。
  // 逐个 add 会在某一个失败时留下「装了一半的 SW」：断网时表现成白屏。
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch((error) => {
        // install 失败是**可接受的**：不装 SW，站点照常在线工作。
        // 静默失败不行 —— 出错时至少留一条日志，否则将来只能靠猜。
        console.warn('[emeeek-sw] 预缓存失败，本次不启用离线缓存：', error);
        throw error;
      }),
  );
});

self.addEventListener('activate', (event) => {
  // 只留当前缓存名的那一份。这一步是「缓存一定会被替换」的落点：
  // 指纹一变，旧缓存名不匹配，删掉。
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 跨域一律直通：站点的资源提示也会拒绝外链（见 transform/hints.js），
  // 这里同样不替第三方做缓存 —— 那是别人的缓存策略，不是我们的。
  if (url.origin !== self.location.origin) return;
  // 站内但不在 scope 内的（子路径部署时的域根其他站点）也直通。
  if (!url.pathname.startsWith(${JSON.stringify(scopeRoot)})) return;

  // 导航请求：network-first。HTML 是内容，必须最新；断网才用缓存。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // 顺手更新缓存：下次断网时能拿到的是「最后一次成功访问的版本」。
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match(OFFLINE))),
    );
    return;
  }

  // 静态资源：stale-while-revalidate。地址带构建指纹，先用缓存立刻渲染，
  // 后台再更新一份 —— 保证下一个请求能拿到新的。
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
`;
}

function withBase(url, base) {
  const value = String(url ?? '');
  if (/^https?:/i.test(value)) return value;
  const path = value.startsWith('/') ? value : `/${value}`;
  if (!base || path.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}

function normalizeBase(basePath) {
  const value = String(basePath ?? '').trim();
  if (!value || value === '/') return '';
  return '/' + value.replace(/^\/+|\/+$/g, '');
}

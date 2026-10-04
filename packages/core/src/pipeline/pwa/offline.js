/**
 * 离线页 + SW 注册脚本。
 *
 * 离线页的**唯一职责**是「断网时告诉读者发生了什么，并给出可行的下一步」。
 *
 * 为什么不用一句「你离线了」了事：读者看到白屏的第一反应是「网站坏了」，
 * 第二反应是反复刷新（每次都失败）。一个说清楚「你离线了、这几篇已经存好了、
 * 联网后自动恢复」的页面，把一次「网站坏了」变成一次「暂时没网」。
 *
 * 所以离线页做三件事：
 *   1. 明确说明状态（不是你网速慢，是离线了）
 *   2. 列出**确实缓存过**的文章（来自构建期，不是运行时猜的）
 *   3. 给一个「重试」按钮，且**不带 JS 也能看**（表单 GET 也能工作）
 *
 * 主题系统不参与：离线页是引擎产物，4 套主题共用一份骨架 + 一份内联样式。
 * 理由同 SEO —— 4 份手写的离线页一定会漂移，而它的漂移平时完全看不到
 * （只有断网的人能看到）。
 */

/**
 * 生成离线页 HTML。
 *
 * 样式内联，不引外部 CSS —— 离线页必须在**任何资源都没拿到**的情况下
 * 也能正常显示。引用一份可能没被缓存的 CSS，就会得到一个裸 HTML。
 */
export function buildOfflinePage({
  site = {}, basePath = '', cachedPosts = [], offlinePath = '/offline.html',
} = {}) {
  const base = normalizeBase(basePath);
  const href = (path) => `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const items = cachedPosts.map((post) => {
    const url = href(post.url ?? `/posts/${post.slug}.html`);
    return `<li><a href="${escapeAttr(url)}">${escapeHtml(post.title ?? '未命名')}</a></li>`;
  }).join('\n        ');

  return `<!DOCTYPE html>
<html lang="${escapeAttr(site.language ?? 'zh-CN')}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<!-- 离线页不进任何索引：它不是内容，是一块路牌。 -->
<meta name="robots" content="noindex" />
<title>当前离线 · ${escapeHtml(site.title ?? 'Emeek')}</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  padding: 24px; font: 16px/1.7 ui-sans-serif, system-ui, -apple-system, "Noto Sans SC", sans-serif;
  background: #ffffff; color: #1f2937;
}
main { max-width: 480px; width: 100%; }
h1 { font-size: 1.5rem; margin: 0 0 12px; }
p { margin: 0 0 16px; color: #4b5563; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
button, .button {
  font: inherit; padding: 10px 18px; border-radius: 8px; cursor: pointer;
  border: 1px solid #d1d5db; background: #f9fafb; color: inherit; text-decoration: none;
}
button:hover, .button:hover { background: #f3f4f6; }
h2 { font-size: 1rem; margin: 0 0 8px; }
ul { margin: 0; padding-left: 20px; }
li { margin-bottom: 6px; }
a { color: #2563eb; }
@media (prefers-color-scheme: dark) {
  body { background: #0f1115; color: #e5e7eb; }
  p { color: #9ca3af; }
  button, .button { background: #1b1f27; border-color: #2c333f; }
  button:hover, .button:hover { background: #232936; }
  a { color: #7aa2ff; }
}
</style>
</head>
<body>
<main>
  <h1>现在处于离线状态</h1>
  <p>页面没有加载出来，是因为设备当前没有网络连接 —— 不是站点出了问题。</p>
  <div class="actions">
    <button type="button" onclick="location.reload()">重试</button>
    <a class="button" href="${escapeAttr(href('/'))}">回到首页</a>
  </div>
  ${items ? `<h2>已经存好、可以离线阅读的文章</h2>
    <ul>
        ${items}
    </ul>` : '<p>还没有可以离线阅读的内容。联网后打开几篇文章，它们会自动存到本地。</p>'}
</main>
</body>
</html>
`;
}

/**
 * SW 注册脚本（内联进页面）。
 *
 * 三处刻意的选择：
 *
 * 1. **`load` 之后再注册。** SW 注册要下载脚本、解析、跑 install。
 *    放在 load 之前会与首屏资源抢带宽与主线程，而它带来的收益（离线）
 *    在本次访问里根本用不上。
 * 2. **只在 https 或 localhost 注册。** 其他环境下 `navigator.serviceWorker`
 *    要么不存在，要么注册会抛 —— 让它静默失败，不要让控制台出现红字。
 * 3. **不做「有新版本，点击刷新」的提示条。** 提示条要么被忽略，
 *    要么被误点（正在写的评论没了）。新 SW 自己会等标签页关闭后接管，
 *    这是更安静也更安全的方式。
 */
export function buildRegisterScript({ basePath = '', swPath = '/sw.js' } = {}) {
  const base = normalizeBase(basePath);
  const url = `${base}${swPath}`;
  return `(function(){
  if(!('serviceWorker' in navigator))return;
  // 非安全上下文下 register() 会 reject，先自己挡掉，别在控制台留红字。
  if(!(location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1'))return;
  window.addEventListener('load',function(){
    navigator.serviceWorker.register(${JSON.stringify(url)},{scope:${JSON.stringify(`${base}/`)}})
      .catch(function(error){console.warn('[emeeek] Service Worker 注册失败，站点仍可正常在线使用：',error);});
  });
})();`;
}

/**
 * 安装提示（beforeinstallprompt）。
 *
 * 为什么默认**关**：一个「安装到桌面」的横幅在读者第一次访问时就弹出来，
 * 是最常被抱怨的 Web 行为之一。它对站点主人的价值（留存）与对读者的
 * 打扰不成比例。
 *
 * 打开它时也有节制：
 *   · 只在读者已经**读过至少一篇**文章后考虑（以本地记录为准）
 *   · 读者点过「不」之后永久不再出现（localStorage，不是 sessionStorage）
 *   · 不由我们计时弹出 —— 用浏览器给的 `beforeinstallprompt`，
 *     它本身就有节制（不会在首次访问触发）
 */
export function buildInstallPrompt({ basePath = '', key = 'emeeek-install-dismissed' } = {}) {
  return `(function(){
  var KEY=${JSON.stringify(key)};
  var deferred=null;
  function dismissed(){try{return localStorage.getItem(KEY)==='1';}catch(e){return true;}}
  function mark(){try{localStorage.setItem(KEY,'1');}catch(e){}}
  // 读者读过至少一篇文章才考虑提示 —— 第一次来就弹安装横幅是最讨人厌的做法。
  function hasRead(){try{return Number(localStorage.getItem('emeeek-visited')||'0')>0;}catch(e){return false;}}
  window.addEventListener('beforeinstallprompt',function(event){
    event.preventDefault();
    deferred=event;
    if(dismissed()||!hasRead())return;
    show();
  });
  function show(){
    if(document.getElementById('emeeek-install'))return;
    var bar=document.createElement('div');
    bar.id='emeeek-install';
    bar.setAttribute('role','dialog');
    bar.setAttribute('aria-label','安装提示');
    bar.innerHTML='<span>把这个站点安装到桌面，离线也能读。</span>'+
      '<button type="button" data-act="ok">安装</button>'+
      '<button type="button" data-act="no" aria-label="不再提示">以后再说</button>';
    bar.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:60;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px;border-radius:12px;background:#1f2937;color:#f9fafb;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    bar.addEventListener('click',function(event){
      var act=event.target.getAttribute&&event.target.getAttribute('data-act');
      if(act==='ok'&&deferred){deferred.prompt();deferred=null;}
      if(act==='no')mark();
      if(act)bar.remove();
    });
    document.body.appendChild(bar);
  }
  // 访问计数：只用来判断「读者是否已经读过东西」。
  window.addEventListener('load',function(){
    try{localStorage.setItem('emeeek-visited',String(Number(localStorage.getItem('emeeek-visited')||'0')+1));}catch(e){}
  });
})();`;
}

/**
 * 行内「是否已安装」的小标记 —— 主题可以用它隐藏「安装」入口。
 * 不做可视化提示，只暴露状态，避免引擎替主题决定视觉。
 */
export function buildDisplayModeScript() {
  return `(function(){
  function apply(){
    var standalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
    document.documentElement.setAttribute('data-display-mode',standalone?'standalone':'browser');
  }
  apply();
  try{window.matchMedia('(display-mode: standalone)').addEventListener('change',apply);}catch(e){}
})();`;
}

function normalizeBase(basePath) {
  const value = String(basePath ?? '').trim();
  if (!value || value === '/') return '';
  return '/' + value.replace(/^\/+|\/+$/g, '');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function escapeAttr(text) {
  return escapeHtml(text);
}

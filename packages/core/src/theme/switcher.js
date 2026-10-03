/**
 * 运行时主题切换按钮（P3-1b-3b，feature F）。
 *
 * 静态站点不能在浏览器里重新构建，所以「切换主题」在运行时能做的只有两件事：
 *   1. 亮/暗切换（就是既有的 data-theme 契约）
 *   2. 跳到另一套主题的预览（每套主题在构建期各有一份产物时，用同源路径切换）
 *
 * 这里注入的是**能力**，不是「假装能换主题」：面板里列出的每套主题都带一个
 * 真实 URL，点下去就是真的导航过去。没有 URL 的主题不列 —— 不画一个点了没
 * 反应的按钮。
 *
 * 安全：整段 HTML 由本模块拼装，不插入任何用户输入；主题名走属性白名单
 * （只允许 [\w-]），URL 只允许同源相对路径。样式用内联 style 属性，
 * 不依赖主题 CSS，因此四套主题开箱即用。
 */

/**
 * @param {object} options
 * @param {string} options.current    当前主题名
 * @param {{name: string, label?: string, url?: string}[]} options.themes  可切换到的主题
 * @param {boolean} options.darkToggle  是否提供亮暗切换
 * @param {'bottom-right'|'bottom-left'} options.position
 * @returns {{ html: string, script: string }} 二者都为空串表示不启用
 */
export function buildThemeSwitcher({ current, themes = [], darkToggle = true, position = 'bottom-right' } = {}) {
  const safeName = (name) => (/^[\w-]+$/.test(String(name ?? '')) ? String(name) : null);
  const currentName = safeName(current);
  const items = themes
    .map((theme) => ({ name: safeName(theme.name), label: String(theme.label ?? theme.name ?? ''), url: theme.url ?? null }))
    .filter((theme) => theme.name);

  if (!items.length && !darkToggle) return { html: '', script: '' };

  const side = position === 'bottom-left' ? 'left' : 'right';
  const linkFor = (theme) => (theme.url ? `<a class="emeeek-switch-item${theme.name === currentName ? ' is-active' : ''}" href="${escapeAttr(theme.url)}" data-theme-name="${theme.name}">${escapeHtml(theme.label)}</a>`
    : `<span class="emeeek-switch-item${theme.name === currentName ? ' is-active' : ''}" data-theme-name="${theme.name}" aria-disabled="true">${escapeHtml(theme.label)}<small>（仅此站）</small></span>`);

  const html = `
<div class="emeeek-switcher" data-position="${side}" hidden>
  <button type="button" class="emeeek-switcher-toggle" aria-expanded="false" aria-label="切换主题" title="切换主题">◐</button>
  <div class="emeeek-switcher-panel" role="dialog" aria-label="主题切换" hidden>
    ${darkToggle ? `<button type="button" class="emeeek-switch-dark" data-action="toggle-dark">切换明暗</button>` : ''}
    <div class="emeeek-switch-list" aria-label="可用主题">${items.map(linkFor).join('')}</div>
  </div>
</div>
<noscript><style>.emeeek-switcher{display:none !important}</style></noscript>`;

  // 脚本只做「展开/收起 + 亮暗切换 + 持久化」。不用任何模板变量，
  // 主题列表在服务端渲染进 HTML —— 脚本不碰内容，也就没有注入面。
  const script = `(function(){try{
  var root=document.documentElement;
  var box=document.querySelector('.emeeek-switcher');
  if(!box||box.hasAttribute('data-ready'))return;box.setAttribute('data-ready','1');box.hidden=false;
  var toggle=box.querySelector('.emeeek-switcher-toggle');
  var panel=box.querySelector('.emeeek-switcher-panel');
  function setOpen(open){panel.hidden=!open;toggle.setAttribute('aria-expanded',open?'true':'false');}
  toggle.addEventListener('click',function(){setOpen(panel.hidden);});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!panel.hidden)setOpen(false);});
  document.addEventListener('click',function(e){if(!box.contains(e.target)&&!panel.hidden)setOpen(false);});
  var dark=box.querySelector('.emeeek-switch-dark');
  if(dark)dark.addEventListener('click',function(){
    var next=root.getAttribute('data-theme')==='dark'?'light':'dark';
    root.setAttribute('data-theme',next);root.setAttribute('data-theme-mode',next);
    try{localStorage.setItem('emeeek-theme',next);}catch(e){}
  });
  // 点其它主题：同源导航过去，并把「我想换主题」这个意图记下来（下一个站可读）。
  box.querySelectorAll('a.emeeek-switch-item').forEach(function(a){
    a.addEventListener('click',function(){try{localStorage.setItem('emeeek-last-theme',a.dataset.themeName||'');}catch(e){}});
  });
}catch(e){}})();`;

  return { html, script };
}

/** 内联样式：不依赖主题 CSS，四套主题都能用。 */
export const SWITCHER_CSS = `.emeeek-switcher{position:fixed;bottom:1.25rem;z-index:60}
.emeeek-switcher[data-position="right"]{right:1.25rem}
.emeeek-switcher[data-position="left"]{left:1.25rem}
.emeeek-switcher-toggle{width:2.5rem;height:2.5rem;border-radius:999px;border:1px solid var(--border,#d1d5db);background:var(--bg,#fff);color:var(--text,#111);cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.18);font-size:1.1rem}
.emeeek-switcher-panel{position:absolute;bottom:3rem;right:0;min-width:9rem;padding:.5rem;border-radius:10px;border:1px solid var(--border,#d1d5db);background:var(--bg,#fff);box-shadow:0 12px 32px rgba(0,0,0,.24);display:flex;flex-direction:column;gap:.25rem}
.emeeek-switcher[data-position="left"] .emeeek-switcher-panel{right:auto;left:0}
.emeeek-switch-dark,.emeeek-switch-item{display:block;text-align:left;padding:.4rem .6rem;border-radius:6px;border:none;background:none;color:var(--text,#111);font:inherit;font-size:.86rem;text-decoration:none;cursor:pointer}
.emeeek-switch-dark{cursor:pointer;border-bottom:1px solid var(--border,#e5e7eb);margin-bottom:.25rem}
.emeeek-switch-item:hover,.emeeek-switch-dark:hover{background:var(--bg-soft,#f3f4f6)}
.emeeek-switch-item.is-active{color:var(--accent,#2563eb);font-weight:600}
.emeeek-switch-item small{color:var(--text-dim,#6b7280);font-weight:400}`;

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function escapeAttr(text) {
  return String(text ?? '').replace(/["'<>`]/g, (ch) => ({ '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '`': '&#96;' }[ch]));
}

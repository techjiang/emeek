/* Emeek Magazine 前端脚本。
   无框架、无构建步骤，直接内联进页面。
   与主题外观无关的行为（切换/搜索/进度/复制）在这里；纯碎样式全在 CSS 里。 */
(function () {
  'use strict';

  // ── 主题切换 ──────────────────────────────────────────────
  // 契约（与 theme/inject.js 的首帧脚本一致）：
  //   data-theme      实际生效的 light | dark —— 样式只看这一个
  //   data-theme-mode auto | light | dark —— 用户的策略选择
  // 首帧脚本已经把 data-theme 定好，这里只负责「点击切换 + 系统变化时跟随」。
  var root = document.documentElement;
  var forced = root.getAttribute('data-theme-mode') || 'auto';
  var stored = null;
  try { stored = localStorage.getItem('emeeek-theme'); } catch (e) { /* 隐私模式 */ }

  function resolve(value) {
    if (value === 'light' || value === 'dark') return value;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(value) {
    root.setAttribute('data-theme', resolve(value));
    root.setAttribute('data-theme-mode', value);
  }

  if (forced !== 'light' && forced !== 'dark') {
    applyTheme(stored || 'auto');
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (!stored) applyTheme('auto');
    });
  }

  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var current = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      stored = current;
      try { localStorage.setItem('emeeek-theme', current); } catch (e) { /* 忽略 */ }
      applyTheme(current);
    });
  }

  // ── 阅读进度 + 回到顶部 ────────────────────────────────────
  var bar = document.getElementById('reading-bar');
  var toTop = document.getElementById('to-top');
  var post = document.querySelector('.prose');

  function onScroll() {
    var scrollTop = window.scrollY;
    if (bar && post) {
      var start = post.offsetTop;
      var total = post.offsetHeight - window.innerHeight;
      var ratio = total > 0 ? (scrollTop - start) / total : 0;
      bar.style.width = Math.min(100, Math.max(0, ratio * 100)) + '%';
    }
    if (toTop) toTop.classList.toggle('visible', scrollTop > 600);
  }

  if (bar || toTop) {
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
  if (toTop) toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // ── 目录高亮当前章节 ──────────────────────────────────────
  var sidebarLinks = Array.prototype.slice.call(document.querySelectorAll('.sidebar-toc a'));
  if (sidebarLinks.length && 'IntersectionObserver' in window) {
    var headings = sidebarLinks.map(function (link) { return document.getElementById(link.hash.slice(1)); }).filter(Boolean);
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        sidebarLinks.forEach(function (link) { link.classList.remove('active'); });
        var active = sidebarLinks.find(function (link) { return link.hash === '#' + entry.target.id; });
        if (active) active.classList.add('active');
      });
    }, { rootMargin: '-10% 0px -80% 0px' });
    headings.forEach(function (h) { observer.observe(h); });
  }

  // ── 代码复制 ──────────────────────────────────────────────
  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.code-copy') : null;
    if (!button) return;
    var block = button.parentElement.querySelector('code');
    if (!block) return;
    var text = block.textContent;
    var done = function () {
      var original = button.textContent;
      button.textContent = '已复制';
      setTimeout(function () { button.textContent = original; }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  });

  function fallbackCopy(text, done) {
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
    document.body.removeChild(area);
  }
})();

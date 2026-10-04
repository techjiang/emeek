/* Emeek Inkstone 前端脚本。
   无框架、无构建步骤，直接内联进页面。 */
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

  // ── 回到顶部 ──────────────────────────────────────────────
  // 阅读进度与目录高亮已移到引擎的 reading script（core/reading/index.js）——
  // 它们需要与「目录放在哪」这件事保持一致，而那个决定在引擎手里。
  // 主题只管这一件纯样式的事。
  var toTop = document.getElementById('to-top');

  window.addEventListener('scroll', function () {
    if (toTop) toTop.classList.toggle('visible', window.scrollY > 600);
  }, { passive: true });
  if (toTop) toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

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

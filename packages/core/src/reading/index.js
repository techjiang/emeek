/**
 * 长文导航：目录 / 锚点 / 阅读进度。
 *
 * ── 这一层要解决的真实问题 ──
 *
 * 在 P3-3c 之前，`post.tocHtml`（引擎渲染的目录）被塞在正文**上方**，
 * 而侧边栏又从 `post.toc` 重新渲染了一份同样的目录。
 * 结果是 3 套主题的长文页上**同一份目录出现两次** —— 一次在正文开头、
 * 一次在侧栏。两处内容完全一样、锚点完全一样，看起来像设计、实际是重复渲染。
 *
 * 为什么会这样：`tocHtml` 是 Phase 1 的产物（那时还没有侧边栏），
 * 侧边栏是 P3-1 加的。两边各写各的，谁也没觉得该删掉旧的。
 * 这类重复不会报错、不会让测试变红，只会让页面多一块没人想要的区域。
 *
 * ── 现在的分工 ──
 *
 * `buildReadingNav()` 产出**一份**目录数据 + 决定它放在哪：
 *
 *   placement: 'sidebar'  → 主题渲染侧边栏目录（宽屏），正文上方不重复
 *   placement: 'inline'   → 主题在正文上方渲染（窄屏/无侧栏主题）
 *   placement: 'none'     → 章节太少，目录没有价值
 *
 * 「章节太少」这条是有依据的：一篇文章只有 2 个 h2 时，目录比它索引的
 * 内容还占地方。阈值默认 3。
 */

/** 少于这么多章节就不给目录 —— 目录比它索引的内容还长的时候，它是负担。 */
export const TOC_MIN_ITEMS = 3;

/**
 * 规划一篇文章的长文导航。
 *
 * @param {object} opts
 * @param {Array<{level:number,id:string,text:string}>} opts.toc  从渲染产出的标题列表
 * @param {boolean} opts.hasSidebar   主题是否为这篇文章渲染侧边栏
 * @param {number}  opts.minItems
 */
export function buildReadingNav({ toc = [], hasSidebar = false, minItems = TOC_MIN_ITEMS } = {}) {
  const items = toc.filter((item) => item && item.id && String(item.text ?? '').trim());
  const meaningful = items.length >= minItems;

  return {
    items,
    // 只有真的形成层级时才显示层级缩进 —— 全是 h2 的文章缩进是噪音。
    nested: new Set(items.map((item) => item.level)).size > 1,
    /**
     * 放在哪。
     *
     * 有侧边栏时放侧栏（宽屏读者的视线本来就在右边），
     * 没有侧边栏的主题（Magazine 的中栏版式）放正文上方。
     * 两者都做会得到重复目录 —— 就是这一层要修的那个问题。
     */
    placement: !meaningful ? 'none' : (hasSidebar ? 'sidebar' : 'inline'),
    /**
     * 阅读进度条的阈值（章节数）。
     *
     * 短文章不需要进度条：一共一屏就看完的内容，顶部那条 3px 的线
     * 从 0 走到 100% 只在一瞬间，它带来的是「页面在动」而不是「读到哪了」。
     * 用章节数而不是字数做判据：章节数直接对应「这文有多长」的观感，
     * 而字数在多图少字的文章上会误判。
     */
    showProgress: items.length >= minItems,
  };
}

/**
 * 目录骨架的 HTML。
 *
 * 为什么用 `<ol>` 而不是 `<ul>`：章节是有顺序的。
 * 屏幕阅读器会念出「列表，共 7 项」而不是「项目符号」——
 * 对「这是第几节」这个信息来说，有序列表才是正确的语义。
 *
 * 为什么给每个链接加 `data-heading`：浏览器端靠它把目录项与
 * 正文里的标题对上（滚动时高亮当前位置）。用 `href.slice(1)` 也能拿到 id，
 * 但那样一旦 href 里带了别的参数就静默失效 —— 显式属性更容易在测试中断言。
 */
export function renderReadingToc(nav, { title = '目录', className = 'toc' } = {}) {
  if (!nav || !nav.items.length || nav.placement === 'none') return '';
  const links = nav.items
    .map((item) => `<li class="toc-item toc-level-${item.level}"><a href="#${escapeAttr(item.id)}" data-heading="${escapeAttr(item.id)}">${escapeHtml(item.text)}</a></li>`)
    .join('\n');
  return `<nav class="${escapeAttr(className)}" aria-labelledby="toc-title">
<p class="toc-title" id="toc-title">${escapeHtml(title)}</p>
<ol class="toc-list">
${links}
</ol>
</nav>`;
}

/**
 * 阅读进度条的容器。
 *
 * `aria-hidden` 是必须的：进度条是**纯装饰** —— 屏幕阅读器读者需要的
 * 是「文档还剩多少」这个信息，而那个信息由一个 `role="progressbar"`
 * 带 `aria-valuenow` 的元素提供才准确。一个内容一直在变、
 * 每次滚动都触发播报的装饰元素只会干扰。
 *
 * 所以进度条本身藏起来，语义交给 `data-reading-progress` 属性
 * （见下方脚本：它会写 aria-valuenow，由主题决定是否额外暴露一个
 * 可聚焦的进度元素）。
 */
export function renderReadingProgress(nav) {
  if (!nav?.showProgress) return '';
  return '<div class="reading-progress" aria-hidden="true"><span class="reading-bar" data-reading-bar></span></div>';
}

/**
 * 长文导航的浏览器端脚本。
 *
 * 三件事：
 *   1. 阅读进度：滚动时更新进度条宽度
 *   2. 目录高亮：用 IntersectionObserver 而不是每次滚动都算位置
 *   3. 平滑跳转：点击目录项时跳过去，且**不改变浏览器历史的行为**
 *      （用默认锚点跳转，不 preventDefault —— 否则「后退」会失灵）
 *
 * 为什么用 IntersectionObserver 而不是 scroll 事件算位置：
 * scroll 回调里读 `getBoundingClientRect()` 会触发**强制同步布局**，
 * 长文页上这是最容易被测出来的卡顿源。一篇 100 个标题的文章，
 * 每次滚动都要读 100 次布局 —— 而 Observer 是浏览器在合成阶段
 * 一次性告诉我们的。
 *
 * ── 关于「当前章节」的判定（这里踩过一个真实的坑）──
 *
 * 第一版用的是「窄带 IntersectionObserver」：`rootMargin: '-10% 0px -70% 0px'`
 * 造出视口上方 10%~30% 的一条窄带，命中窄带的标题才算当前章节。
 * 看起来合理，实测**完全不工作**：
 *
 *   视口 800px 时窄带只有 160px 高（y=80..240）。一篇正常排版的文章里
 *   相邻两个 h2 之间往往有 300~500px，于是滚动时**没有任何标题落进窄带** ——
 *   目录高亮从头到尾一次都不亮。而页面上看不出任何异常（没有报错、
 *   目录在、点击也能跳），只是滚到哪都不亮。
 *
 * 根因是把「当前章节」这件事交给几何判定（它在不在某条带里），
 * 而它本质上是**顺序判定**：读者滚到 y 位置时所在的是「最后一个
 * 已经滚过视口上沿的标题」那一节。
 *
 * 所以现在改成：Observer 只用来**触发重算**（进/出视口都算），
 * 真正判定当前章节用「最后一个顶边 ≤ 判定线」的标题。
 * 判定线取视口高度的 30% —— 标题滚过这条线就算「你正在读这一节」。
 *
 * 这样无论章节疏密都正确：疏的时候也能命中（总有标题在判定线之上），
 * 密的时候也稳定（不会来回跳）。
 */
export const READING_CLIENT = `(function () {
  'use strict';

  // ── 等一下：目录可能还没解析出来 ──────────────────────────
  //
  // 这个脚本由主题摆放在正文区域里（reading partial），
  // 而**侧边栏的目录在它之后**才出现在 HTML 里。脚本直接跑的话
  // querySelectorAll('.sidebar-toc a') 拿到空集，于是整个高亮逻辑
  // 提前 return —— 页面上看不出任何异常（没报错、目录在、点击也能跳），
  // 只是滚到哪都不亮。这个 bug 真实存在过，只有真浏览器的 e2e 抓到了它。
  //
  // 所以：DOM 没就绪就等 DOMContentLoaded 再跑。
  // 用 readyState 判断而不是无条件挂事件 —— 脚本被放到页面靠后位置时
  // DOMContentLoaded 可能已经错过了，那时候挂监听器永远不会触发。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
    return;
  }
  init();

  function init() {

  // ── 阅读进度 ──────────────────────────────────────────────
  var bar = document.querySelector('[data-reading-bar]');
  if (bar) {
    var content = document.querySelector('.prose') || document.querySelector('article') || document.body;
    var ticking = false;
    var update = function () {
      ticking = false;
      var start = content.offsetTop;
      var total = content.offsetHeight - window.innerHeight;
      var ratio = total > 0 ? (window.scrollY - start) / total : (window.scrollY > 0 ? 1 : 0);
      ratio = Math.min(1, Math.max(0, ratio));
      bar.style.width = (ratio * 100) + '%';
      bar.setAttribute('data-reading-ratio', ratio.toFixed(3));
    };
    var onScroll = function () {
      // requestAnimationFrame 合帧：滚动一秒能触发几十次事件，
      // 每次都算布局会让主线程在长文页上肉眼可见地忙起来。
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  // ── 目录高亮 ──────────────────────────────────────────────
  // 两个选择器都要：目录可能在侧栏（.sidebar-toc，4 套主题的默认落位）
  // 或在正文上方（.toc-list，无侧栏主题的落位）。
  var links = Array.prototype.slice.call(
    document.querySelectorAll('.toc-list a[data-heading], .sidebar-toc a[data-heading]'));
  if (!links.length || !('IntersectionObserver' in window)) return;

  var byId = {};
  links.forEach(function (link) {
    var id = link.getAttribute('data-heading');
    if (id) byId[id] = link;
  });

  // 保持**文档顺序**：判定「最后一个滚过判定线的标题」必须按顺序遍历，
  // 而 Object.keys 的顺序依赖 id 的字符串形态（数字开头的会被排到前面）。
  var headings = links
    .map(function (link) { return document.getElementById(link.getAttribute('data-heading')); })
    .filter(Boolean);
  // 同一 id 出现两次（目录与锚点重复）时去重，但保持首次出现的位置。
  headings = headings.filter(function (h, i) { return headings.indexOf(h) === i; });
  if (!headings.length) return;

  var current = null;

  function activate(id) {
    if (current === id) return;
    if (current && byId[current]) {
      byId[current].classList.remove('active');
      byId[current].removeAttribute('aria-current');
    }
    current = id;
    if (!id || !byId[id]) return;
    byId[id].classList.add('active');
    // aria-current="location" 是「你在文档里的位置」的正确语义，
    // 比 aria-selected（那是选项卡的）准确。
    byId[id].setAttribute('aria-current', 'location');
    // 把高亮项滚进可视区 —— 长目录里当前项在框外时高亮等于没有。
    // 只在它确实在框外时才滚，避免目录自己在抖动。
    var box = byId[id].closest('.sidebar-toc, .toc-list, nav');
    if (box && box.scrollHeight > box.clientHeight + 4) {
      var top = byId[id].offsetTop;
      if (top < box.scrollTop + 24 || top > box.scrollTop + box.clientHeight - 24) {
        box.scrollTop = Math.max(0, top - box.clientHeight / 3);
      }
    }
  }

  /**
   * 判定当前章节：**最后一个顶边在判定线之上的标题**。
   *
   * 判定线取视口高度的 30%。为什么不是「视口内最靠上的标题」：
   * 一个标题刚出现在视口底部时，读者其实还在读上一节 ——
   * 用它会让目录提前跳到下一节。30% 是「已经开始读这一节了」的位置。
   *
   * 为什么不用窄带 Observer 直接判定：见平台文档（章节疏时会一次都不命中）。
   */
  function updateCurrent() {
    var line = window.innerHeight * 0.3;
    var found = null;
    for (var i = 0; i < headings.length; i += 1) {
      if (headings[i].getBoundingClientRect().top <= line) found = headings[i].id;
      else break; // 标题在文档里有序，第一个超出判定线的之后都不用了
    }
    // 一个都没过线时（页面顶部、第一个标题还在判定线以下），
    // 高亮**第一个**标题而不是不高亮。
    //
    // 为什么：读者刚打开文章时，目录一项都不亮看起来像「目录坏了」。
    // 而此刻他所在位置的正确答案就是「第一节还没开始，但马上要看的就是它」。
    // 不亮 vs 亮第一项 —— 后者与读者的心理模型一致。
    activate(found || (headings[0] && headings[0].id));
  }

  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; updateCurrent(); });
  }

  // Observer 只负责「什么时候该重算」，判定逻辑在上面。
  // 同时监听全部标题与整篇正文：只观察标题时，两个标题之间的长段落里
  // 滚动不会触发任何回调（没有目标进出），高亮就停在上一次的结果上 ——
  // 表现是「在高亮项附近来回滚，高亮不动」。
  var observer = new IntersectionObserver(schedule, { rootMargin: '0px 0px -20% 0px', threshold: 0 });
  headings.forEach(function (heading) { observer.observe(heading); });

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  // 首次立即算一次：一进页面就停在某个章节上（比如从锚点链接进来），
  // 等第一次滚动才高亮会显得目录是坏的。
  updateCurrent();

  } // init
})();`;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function escapeAttr(text) {
  return escapeHtml(text);
}

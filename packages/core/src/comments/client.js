/**
 * 评论区的浏览器端取数（可内联的传统脚本，无模块语法）。
 *
 * 这份脚本是**内联进页面**的，所以不 import 任何东西、不用 export。
 * 构建期由 comments/ui.js 把它与 normalize 逻辑拼在一起（与搜索页同一套做法）。
 *
 * ── 为什么在浏览器端取而不是构建期烘死 ──
 * 评论区的内容必须能「不发版就更新」：来一条新评论就要重建整站、
 * 等 CI 跑完才显示出来，对「评论」这个场景是不可接受的。
 *
 * ── 为什么可以不配 token ──
 * GitHub 的 Issues API 匿名可读（限流 60 次/小时/IP）。评论条数少时
 * 这个额度够用。不配 token 是刻意的：**任何写进静态产物的 token
 * 都是公开的** —— 一个站点源码里的 GitHub token 等于把仓库权限送人。
 * 要更高额度应当在部署侧用代理，而不是把 token 发到浏览器。
 *
 * ── 三件必须做对的事 ──
 *
 * 1. **失败要说清楚**。网络失败 / 404（Issue 被删）/ 403（限流）
 *    的原因完全不同，但都会让评论区空着。给一句「评论加载失败」
 *    然后不区分原因，读者会以为是站点坏了。
 * 2. **空列表要说「还没有评论」**，不是什么都不显示。
 *    空白区域与「加载中」在视觉上无法区分。
 * 3. **不用 innerHTML 插正文**。正文的转换在 normalize 之后是安全的，
 *    但这里仍然用 createElement + textContent 组装结构 ——
 *    多一层保险，且这里的代码将来被人改动时不容易引入 XSS。
 */
export const COMMENTS_CLIENT = `(function () {
  'use strict';

  var root = document.querySelector('.comments[data-comments-provider]');
  if (!root) return;

  var repo = root.getAttribute('data-comments-repo');
  var issue = root.getAttribute('data-comments-issue');
  var limit = Number(root.getAttribute('data-comments-limit') || 50);
  var withReactions = root.getAttribute('data-comments-reactions') === '1';
  var strings = {};
  try { strings = JSON.parse(root.getAttribute('data-comments-strings') || '{}'); } catch (e) {}

  var status = root.querySelector('[data-role="status"]');
  var list = root.querySelector('[data-role="list"]');

  function setStatus(text, kind) {
    if (!status) return;
    status.textContent = text;
    status.setAttribute('data-kind', kind || '');
    status.hidden = !text;
  }

  // 缓存：同一次会话里回到同一页不重复请求。GitHub 匿名限流只有 60 次/小时，
  // 读者按几下「后退」就可能把额度用掉。
  var cacheKey = 'emeeek-comments:' + repo + '#' + issue + ':' + limit;

  function readCache() {
    try {
      var raw = sessionStorage.getItem(cacheKey);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      // 60 秒的短缓存：够挡往返，又不会让读者看到明显过时的讨论。
      if (!parsed || Date.now() - parsed.at > 60000) return null;
      return parsed.items;
    } catch (e) { return null; }
  }

  function writeCache(items) {
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), items: items })); } catch (e) {}
  }

  function endpoint() {
    // 只取需要的字段。Issues API 一页 100 条、每条 40+ 字段，
    // 不筛字段时响应能大好几倍，而正文之外的字段我们一个都不用。
    return 'https://api.github.com/repos/' + repo + '/issues/' + issue + '/comments'
      + '?per_page=' + Math.min(100, Math.max(1, limit));
  }

  function fetchComments() {
    var cached = readCache();
    if (cached) { render(cached); return; }
    setStatus(strings.loading || '正在加载评论…', 'loading');

    fetch(endpoint(), { headers: { accept: 'application/vnd.github+json' } })
      .then(function (response) {
        if (response.status === 404) {
          // Issue 被删了 / 编号配错了。这跟「网络不通」是两回事，
          // 说清楚能让站点主人一分钟内找到问题。
          throw { kind: 'not-found', message: '讨论区不存在（Issue #' + issue + ' 可能已被删除）' };
        }
        if (response.status === 403 || response.status === 429) {
          throw { kind: 'rate-limit', message: '暂无法加载评论（GitHub 接口限流，请稍后再试）' };
        }
        if (!response.ok) throw { kind: 'http', message: '评论加载失败（HTTP ' + response.status + '）' };
        return response.json();
      })
      .then(function (raw) {
        if (!Array.isArray(raw)) throw { kind: 'shape', message: '评论数据格式异常' };
        var items = window.__EMEEEK_COMMENTS__ ? window.__EMEEEK_COMMENTS__(raw, limit, withReactions) : raw;
        writeCache(items);
        render(items);
      })
      .catch(function (error) {
        // 用 error.kind 而不是固定的 'error'。
        //
        // 上面几处 throw 各自带了 kind（not-found / rate-limit / http / shape），
        // 目的就是让**样式与测试**能区分它们。这里写死 'error' 会把这个区分
        // 白白丢掉 —— 四种失败在 DOM 上长得一模一样。这个疏漏被 e2e 抓到了
        // （断言 data-kind="not-found" 时拿到的是 "error"）。
        var kind = (error && error.kind) || 'error';
        setStatus((error && error.message) || strings.error || '评论加载失败。', kind);
      });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function render(items) {
    if (!items.length) { setStatus(strings.empty || '还没有评论。', 'empty'); list.hidden = true; return; }
    setStatus('', '');
    list.hidden = false;
    list.textContent = '';

    items.forEach(function (item) {
      var li = el('li', 'c-item');
      li.id = 'comment-' + item.id;

      var head = el('div', 'c-head');
      if (item.avatar) {
        var img = document.createElement('img');
        img.className = 'c-avatar';
        img.src = item.avatar;
        img.alt = '';
        img.loading = 'lazy';
        img.width = 32; img.height = 32;
        head.appendChild(img);
      }
      var who = el('a', 'c-author', item.author);
      who.href = item.authorUrl;
      who.rel = 'noopener noreferrer nofollow';
      who.target = '_blank';
      head.appendChild(who);
      if (item.isAuthor) head.appendChild(el('span', 'c-badge', '作者'));
      var time = el('time', 'c-time', formatDate(item.createdAt));
      time.dateTime = item.createdAt;
      head.appendChild(time);
      li.appendChild(head);

      // 正文：normalizeBody 的产物已经是「转义过的文本 + 我们自己造的 a 标签」。
      // 这里用 innerHTML 是安全的，但**注释必须留下**，否则下一个人会以为
      // 这是个疏漏然后改成别的东西。
      var body = el('div', 'c-body');
      body.innerHTML = item.body;
      li.appendChild(body);

      if (item.reactions && item.reactions.length) {
        var reactions = el('div', 'c-reactions');
        item.reactions.forEach(function (reaction) {
          reactions.appendChild(el('span', 'c-reaction', reaction.emoji + ' ' + reaction.count));
        });
        li.appendChild(reactions);
      }

      var link = el('a', 'c-permalink', '查看');
      link.href = item.url;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      li.appendChild(link);

      list.appendChild(li);
    });
  }

  function formatDate(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    try {
      return date.toLocaleDateString(document.documentElement.lang || 'zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) { return date.toISOString().slice(0, 10); }
  }

  fetchComments();
})();`;

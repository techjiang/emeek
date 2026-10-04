/* Emeek 搜索页客户端（DOM 壳 + 内联的匹配逻辑）。
 *
 * 这份脚本由构建期内联进搜索页。四套主题共用同一份逻辑，差异全在 CSS ——
 * 联想的触发时机、URL 同步的字段、历史的存法不该因为主题不同而不同。
 *
 * 匹配逻辑不在这里手写第二遍：ui/index.js 在构建期把 matcher.js 的源码
 * 拼到下面那个行注释占位符的位置。同一个实现，既能被单测 import，
 * 也能被内联进页面 —— 不必为了内联而复刻一份会漂移的副本。
 *
 * 依赖：window.__EMEEEK_SEARCH_INDEX__（构建期内联的索引 JSON）。
 * 无 JS 兜底：页面里有一个 form action="search" method="get"，脚本只做增强。
 */
(function () {
  'use strict';

  var INDEX = window.__EMEEEK_SEARCH_INDEX__ || null;
  var HISTORY_KEY = 'emeeek-search-history';
  var HISTORY_MAX = 8;

//__MATCHER__

  // ── 渲染 ────────────────────────────────────────────────────
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function highlight(text, terms) {
    var safe = escapeHtml(text);
    terms.filter(Boolean).slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (term) {
      var pattern = escapeRegExp(escapeHtml(term));
      if (!pattern) return;
      safe = safe.replace(new RegExp(pattern, 'gi'), function (m) { return '<mark>' + m + '</mark>'; });
    });
    return safe;
  }

  var els = {};
  function $(id) { return document.getElementById(id); }

  function currentFilters() {
    return {
      category: els.category ? els.category.value : '',
      tag: els.tag ? els.tag.value : '',
      from: els.from ? els.from.value : '',
      to: els.to ? els.to.value : ''
    };
  }

  function render() {
    if (!els.results) return;
    var query = els.input ? els.input.value : '';
    var out = runQuery(INDEX, query, { filters: currentFilters(), maxResults: 50 });
    var results = out.results;
    var sort = els.sort ? els.sort.value : 'relevance';
    if (sort === 'date') results.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    if (sort === 'oldest') results.sort(function (a, b) { return new Date(a.date) - new Date(b.date); });

    if (!query.trim()) {
      els.results.innerHTML = '';
      if (els.count) els.count.textContent = '';
      return;
    }
    if (!results.length) {
      els.results.innerHTML = '<p class="search-empty">没有找到相关内容</p>'
        + '<p class="search-suggest">试试更短的关键词，或去掉筛选条件。</p>';
      if (els.count) els.count.textContent = '0 条结果';
      return;
    }
    if (els.count) els.count.textContent = results.length + ' 条结果';
    els.results.innerHTML = results.map(function (item) {
      return '<article class="search-result">'
        + '<h2 class="search-result-title"><a href="' + escapeHtml(item.url) + '">'
        + highlight(item.title, item.matched) + '</a></h2>'
        + '<p class="search-result-excerpt">' + highlight(item.excerpt, item.matched) + '</p>'
        + '<div class="search-result-meta">' + escapeHtml(item.date || '')
        + (item.tags.length ? ' · ' + item.tags.map(function (t) { return '#' + escapeHtml(t); }).join(' ') : '')
        + '</div></article>';
    }).join('');
  }

  // ── URL 同步 ─────────────────────────────────────────────────
  function readUrl() {
    var params = new URLSearchParams(location.search);
    if (els.input) els.input.value = params.get('q') || '';
    if (els.category) els.category.value = params.get('category') || '';
    if (els.tag) els.tag.value = params.get('tag') || '';
    if (els.from) els.from.value = params.get('from') || '';
    if (els.to) els.to.value = params.get('to') || '';
    if (els.sort) els.sort.value = params.get('sort') || 'relevance';
  }
  function writeUrl(replace) {
    var params = new URLSearchParams();
    if (els.input && els.input.value.trim()) params.set('q', els.input.value.trim());
    [['category', els.category], ['tag', els.tag], ['from', els.from], ['to', els.to]].forEach(function (pair) {
      if (pair[1] && pair[1].value) params.set(pair[0], pair[1].value);
    });
    if (els.sort && els.sort.value && els.sort.value !== 'relevance') params.set('sort', els.sort.value);
    var url = location.pathname + (params.toString() ? '?' + params.toString() : '');
    // replaceState：打字过程中不该把每个字符都塞进历史，否则返回键要点很多下。
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  // ── 搜索历史（localStorage） ─────────────────────────────────
  function readHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
  }
  function pushHistory(term) {
    var value = String(term || '').trim();
    if (!value) return;
    var list = readHistory().filter(function (x) { return x !== value; });
    list.unshift(value);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) { /* 隐私模式 */ }
  }
  function renderHistory() {
    if (!els.history) return;
    var list = readHistory();
    els.history.innerHTML = list.length
      ? list.map(function (t) { return '<button type="button" class="search-history-item" data-term="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>'; }).join('')
      : '';
  }

  // ── 联想（防抖 150ms + 键盘导航） ────────────────────────────
  var suggestTimer = null;
  var suggestIndex = -1;
  function renderSuggest(list) {
    if (!els.suggest) return;
    suggestIndex = -1;
    if (!list.length) { els.suggest.innerHTML = ''; els.suggest.hidden = true; return; }
    els.suggest.innerHTML = list.map(function (item) {
      return '<li role="option" class="search-suggest-item" data-value="' + escapeHtml(item.value) + '">'
        + escapeHtml(item.value) + '<span class="search-suggest-type">' + item.type + '</span></li>';
    }).join('');
    els.suggest.hidden = false;
  }

  function init() {
    els = {
      input: $('search-input'), results: $('search-results'), count: $('search-count'),
      suggest: $('search-suggest'), history: $('search-history'),
      category: $('filter-category'), tag: $('filter-tag'), from: $('filter-from'),
      to: $('filter-to'), sort: $('filter-sort'), form: $('search-form')
    };
    if (!els.input) return;

    readUrl();
    render();
    renderHistory();

    var debounce = null;
    els.input.addEventListener('input', function () {
      var value = els.input.value;
      writeUrl(true);
      clearTimeout(debounce);
      debounce = setTimeout(render, 120);
      clearTimeout(suggestTimer);
      // 防抖 150ms：每敲一个字符就重算联想，在长列表上会卡；
      // 150ms 是「感觉即时」与「不浪费计算」的平衡点。
      suggestTimer = setTimeout(function () { renderSuggest(collectSuggestions(INDEX, value)); }, 150);
    });

    [els.category, els.tag, els.from, els.to, els.sort].forEach(function (el) {
      if (!el) return;
      el.addEventListener('change', function () { writeUrl(false); render(); });
    });

    // 键盘导航：↑↓ 选择，Enter 确认，Esc 收起
    els.input.addEventListener('keydown', function (event) {
      if (!els.suggest || els.suggest.hidden) {
        if (event.key === 'Enter') { pushHistory(els.input.value); writeUrl(false); }
        return;
      }
      var items = els.suggest.querySelectorAll('.search-suggest-item');
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        suggestIndex = (suggestIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        Array.prototype.forEach.call(items, function (item, i) { item.classList.toggle('is-active', i === suggestIndex); });
      } else if (event.key === 'Enter' && suggestIndex >= 0) {
        event.preventDefault();
        els.input.value = items[suggestIndex].getAttribute('data-value');
        els.suggest.hidden = true;
        // 从联想里选词后回车，也算一次搜索 —— 不记的话「我明明搜过」
        // 在历史里找不到，那比没有历史更让人困惑。
        pushHistory(els.input.value);
        writeUrl(false);
        renderHistory();
        render();
      } else if (event.key === 'Escape') {
        els.suggest.hidden = true;
      }
    });

    if (els.suggest) {
      els.suggest.addEventListener('click', function (event) {
        var item = event.target.closest('.search-suggest-item');
        if (!item) return;
        els.input.value = item.getAttribute('data-value');
        els.suggest.hidden = true;
        render();
      });
    }
    if (els.history) {
      els.history.addEventListener('click', function (event) {
        var item = event.target.closest('.search-history-item');
        if (!item) return;
        els.input.value = item.getAttribute('data-term');
        render();
      });
    }
    if (els.form) {
      els.form.addEventListener('submit', function (event) {
        // 有脚本时不让浏览器重新加载整页 —— 结果是本地算的。
        event.preventDefault();
        pushHistory(els.input.value);
        writeUrl(false);
        render();
      });
    }
    window.addEventListener('popstate', function () { readUrl(); render(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

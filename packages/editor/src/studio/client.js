/**
 * Studio 客户端入口。
 *
 * 这个文件只做三件事：装配编辑器、订阅状态、把 UI 事件翻译成命令调用。
 * 任何「怎么写 HTML」的逻辑都不在这里 —— 预览 HTML 一律来自 @emeeek/core，
 * 客户端是纯粹的展示层 + 事件层。
 */
import { wrapSelection, insertLink, insertCodeBlock, insertTable, insertFormula, insertQuote, insertList, insertOrderedList, insertTaskList, headingCommand } from '../editor/commands.js';
import { createEmeekEditor } from '../editor/index.js';
import { updatePreview, createIncrementalRenderer, createWikiLinkResolver } from '../preview/index.js';
import { fetchDictionaryBytes } from '../editor/dict.js';
import { createLocalAIService } from '../ai/bridge.js';
import { editorStats } from '../editor/stats.js';
import { WELCOME } from './welcome.js';

/** 当前编辑器实例。目录点击等回调需要它，而实例在 boot() 里才创建。 */
let editorRef = null;

/**
 * 预览渲染的调度状态。
 *
 * 放在模块作用域而不是 boot() 内部：boot() 里的函数声明会被提升，
 * 但 `let` 变量不会 —— 构造函数里先调用的 cycleMode 会读到未初始化的
 * previewTimer，抛 TDZ 错误（实测过一次，整个 boot 中断）。
 */
let previewTimer = null;

const state = {
  filename: 'untitled.md',
  theme: localStorage.getItem('studio:theme') ?? 'one-dark',
  mode: localStorage.getItem('studio:mode') ?? 'split',
  saved: true,
  posts: [],
  outline: [],
  activeHeading: -1,
  aiBusy: false,
};

const $ = (selector) => document.querySelector(selector);

boot();

async function boot() {
  const app = $('#studio');
  app.dataset.theme = state.theme;
  document.body.classList.toggle('dark', isDark(state.theme));

  // 站点数据：文章列表用于 [[ 补全与双向链接解析，图片列表用于 ![ 补全。
  const siteData = await loadSiteData();
  state.posts = siteData.posts ?? [];
  const wikiLink = createWikiLinkResolver(state.posts);

  const draft = await loadDraft();
  const initial = draft?.content ?? WELCOME;
  state.filename = draft?.filename ?? 'untitled.md';

  // 预览渲染：大文档走增量渲染，小文档直通 —— 两者调的是同一个 core 函数。
  const incremental = createIncrementalRenderer({ render: (block) => updatePreview(block, { wikiLink }) });

  const editor = createEmeekEditor({
    doc: initial,
    parent: $('#editor-host'),
    theme: themeFor(state.theme),
    posts: state.posts,
    images: siteData.images ?? [],
    uploadImage: uploadImage,
    onSave: saveDraft,
    onChange: onSourceChange,
    onOutlineChange: (outline, active) => { state.outline = outline; state.activeHeading = active; renderOutline(); },
    onStats: renderStatus,
    onTogglePreviewMode: cycleMode,
    onToggleTheme: toggleTheme,
  });

  editorRef = editor;
  window.__studio = { editor, state };

  renderOutline();
  renderStatus(editorStats(editor.state));
  bindToolbar(editor);
  bindLayout();
  bindKeyboardShortcuts();
  bindAiPanel();
  applyTheme(state.theme);
  cycleMode(state.mode);

  // 首屏只渲染一次预览：不预加载 408KB 词表，AI 相关能力在点击时才加载。
  updatePreviewPane(incremental, initial);
  requestAnimationFrame(() => {
    performance.mark?.('studio:ready');
    $('#boot').hidden = true;
    app.hidden = false;
    setSaveState('saved');
  });

  function onSourceChange(text) {
    setSaveState('dirty');
    schedulePreview(text);
  }

  function schedulePreview(text) {
    if (state.mode === 'edit') return;
    clearTimeout(previewTimer);
    // 防抖 200ms：用户停下来才渲染，打字过程不抢主线程
    previewTimer = setTimeout(() => {
      const start = performance.now();
      renderInto(incremental(text), performance.now() - start);
    }, 200);
  }

  function renderInto(result, elapsedMs) {
    const frame = $('#preview-frame');
    if (!frame) return;
    frame.srcdoc = frameDocument(result.html);
    const meta = $('#preview-meta');
    if (meta) {
      // 渲染耗时 + 复用的块数是增量渲染是否真的在工作的直接证据，
      // 直接摆在预览区标题栏，不藏进控制台。
      meta.textContent = `${elapsedMs.toFixed(0)}ms · 复用 ${result.reused} 块 / 渲染 ${result.rendered} 块`;
    }
  }

  function updatePreviewPane(renderer, text) {
    const start = performance.now();
    renderInto(renderer(text), performance.now() - start);
  }

  function saveDraft() {
    setSaveState('saving');
    const content = editor.getText();
    localStorage.setItem('studio:draft', JSON.stringify({ filename: state.filename, content, at: Date.now() }));
    state.saved = true;
    setTimeout(() => setSaveState('saved'), 120);
    return true;
  }

  function setSaveState(kind) {
    state.saved = kind === 'saved';
    const el = $('#save-state');
    if (!el) return;
    el.dataset.state = kind;
    el.textContent = { saved: '已保存 ✓', saving: '保存中…', dirty: '未保存 ●', local: '本地草稿（未连接仓库）' }[kind] ?? '';
  }

  /** 主题切换：编辑器主题 + 预览 iframe 主题，两边一起变，否则一半亮一半暗。 */
  function toggleTheme() {
    state.theme = isDark(state.theme) ? 'github-light' : 'one-dark';
    applyTheme(state.theme);
  }
  function applyTheme(theme) {
    localStorage.setItem('studio:theme', theme);
    $('#studio').dataset.theme = theme;
    document.body.classList.toggle('dark', isDark(theme));
    editor.setTheme(themeFor(theme));
    const frame = $('#preview-frame');
    if (frame?.contentDocument?.documentElement) frame.contentDocument.documentElement.dataset.theme = isDark(theme) ? 'dark' : 'light';
    document.querySelectorAll('[data-theme-option]').forEach((el) => el.classList.toggle('active', el.dataset.themeOption === theme));
  }

  function cycleMode(mode) {
    state.mode = mode ?? ({ split: 'edit', edit: 'preview', preview: 'split' })[state.mode];
    localStorage.setItem('studio:mode', state.mode);
    $('#studio').dataset.mode = state.mode;
    document.querySelectorAll('[data-mode-option]').forEach((el) => el.classList.toggle('active', el.dataset.modeOption === state.mode));
    if (state.mode !== 'edit') schedulePreview(editor.getText());
    editor.focus();
  }

  /** 目录：点击跳转，光标所在章节高亮。 */
  function renderOutline() {
    const host = $('#outline-list');
    if (!host) return;
    if (!host.dataset.bound) {
      host.dataset.bound = '1';
      host.addEventListener('click', (event) => {
        const item = event.target.closest?.('.outline-item');
        if (item) editorRef?.jumpToLine(Number(item.dataset.line));
      });
    }
    if (!state.outline.length) {
      host.innerHTML = '<p class="outline-empty">还没有标题<br><span>用 ## 写一个小标题试试</span></p>';
      $('#outline-count').textContent = '0';
      return;
    }
    $('#outline-count').textContent = String(state.outline.length);
    const minLevel = Math.min(...state.outline.map((i) => i.level));
    host.innerHTML = state.outline.map((item, index) => `
      <button class="outline-item${index === state.activeHeading ? ' active' : ''}"
              data-line="${item.line}" data-level="${item.level}"
              style="padding-left:${8 + (item.level - minLevel) * 14}px"
              title="第 ${item.line} 行：${escapeHtml(item.text)}">
        ${escapeHtml(item.text)}
      </button>`).join('');
  }

  /** 状态栏：字数 / 阅读时长 / 行列 / 选中长度。 */
  function renderStatus(stats) {
    if (!stats) return;
    $('#stat-words').textContent = `${stats.words.toLocaleString('zh-CN')} 字`;
    $('#stat-reading').textContent = `约 ${stats.readingMinutes} 分钟`;
    $('#stat-cursor').textContent = `行 ${stats.line}, 列 ${stats.column}`;
    $('#stat-selected').textContent = stats.selected ? `选中 ${stats.selected}` : '';
  }

  /**
   * 绑定事件。
   *
   * 元素缺失时抛出的 TypeError（Cannot read properties of null）对排查毫无帮助，
   * 而这里拼错一个 id 就足够让整个 boot 中断、页面停在加载页。
   * 所以统一走 on()：缺元素 → 控制台明确写「找不到 #xxx」，其余功能照常可用。
   */
  function on(selector, event, handler) {
    const el = typeof selector === 'string' ? $(selector) : selector;
    if (!el) { console.warn(`[studio] 找不到元素 ${selector}，该交互已跳过`); return null; }
    if (typeof el.addEventListener !== 'function') { console.warn(`[studio] ${selector} 不是可绑定元素`); return null; }
    el.addEventListener(event, handler);
    return el;
  }

  function onAll(selector, event, handler) {
    const list = typeof selector === 'string' ? document.querySelectorAll(selector) : selector;
    if (!list.length) console.warn(`[studio] 找不到任何 ${selector}`);
    list.forEach((el) => el.addEventListener(event, handler));
  }

  function bindToolbar(editor) {
    // 工具栏按钮与快捷键走同一条命令路径 —— 按钮能点的快捷键一定能按，
    // 快捷键能做的按钮一定做得到。两套逻辑是「按钮点了没反应」的根源。
    onAll('[data-command]', 'click', (event) => {
      const button = event.currentTarget;
      const action = COMMANDS[button.dataset.command];
      if (!action) { console.warn(`[studio] 未知命令 ${button.dataset.command}`); return; }
      editor.focus();
      action(editor);
      button.classList.add('pressed');
      setTimeout(() => button.classList.remove('pressed'), 140);
    });

    on('#file-name', 'click', () => {
      const next = window.prompt('文件名', state.filename);
      if (next) { state.filename = next; $('#file-name').textContent = next; setSaveState('dirty'); }
    });

    on('#btn-save', 'click', saveDraft);

    on('#btn-copy-markdown', 'click', async () => {
      const button = $('#btn-copy-markdown');
      try {
        await navigator.clipboard.writeText(editor.getText());
        flash(button, '已复制');
      } catch { flash(button, '复制失败'); }
    });

    on('#btn-delete-draft', 'click', () => {
      if (!window.confirm('清空本地草稿并恢复示例内容？')) return;
      localStorage.removeItem('studio:draft');
      editor.setText(WELCOME);
      flash($('#btn-delete-draft'), '已重置');
    });

    on('#btn-toggle-preview', 'click', () => cycleMode());

    onAll('[data-mode-option]', 'click', (event) => cycleMode(event.currentTarget.dataset.modeOption));
    onAll('[data-theme-option]', 'click', (event) => applyTheme(event.currentTarget.dataset.themeOption));
    on('#select-theme', 'change', (event) => applyTheme(event.target.value));
    on('#select-wrap', 'change', (event) => editor.setLineWrapping(event.target.checked));
  }

  function bindLayout() {
    // 分割线拖动：指针事件 + 百分比，避免重排时用像素导致缩放后错位
    const splitter = $('#splitter-left');
    const previewSplitter = $('#splitter-right');
    drag(splitter, (ratio) => { $('#studio').style.setProperty('--nav-width', `${ratio * 100}%`); }, 'nav');
    drag(previewSplitter, (ratio) => { $('#studio').style.setProperty('--editor-width', `${ratio * 100}%`); }, 'editor');

    function drag(handle, apply, which) {
      if (!handle) return;
      let dragging = false;
      handle.addEventListener('pointerdown', (event) => {
        dragging = true;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
      });
      handle.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const host = $('#studio');
        const total = which === 'nav' ? host.clientWidth * 0.35 : host.clientWidth;
        const bound = which === 'nav' ? handle.parentElement.getBoundingClientRect().left : handle.parentElement.getBoundingClientRect().left + handle.parentElement.clientWidth * 0.4;
        const ratio = Math.min(0.6, Math.max(0.12, (event.clientX - (which === 'nav' ? host.getBoundingClientRect().left + 48 : bound)) / (total || 1)));
        apply(ratio);
      });
      const stop = (event) => { if (dragging) { dragging = false; handle.releasePointerCapture?.(event.pointerId); document.body.classList.remove('resizing'); } };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    }

    on('#btn-outline-toggle', 'click', () => {
      $('#studio').classList.toggle('no-outline');
    });
  }

  function bindKeyboardShortcuts() {
    // 全局（非编辑器内）快捷键：在输入框里打字不该触发 Ctrl+S
    document.addEventListener('keydown', (event) => {
      const inField = /input|textarea/i.test(event.target.tagName);
      if (inField) return;
      if (event.key === 'Escape') { $('#ai-panel').classList.remove('open'); return; }
      if (event.key === 'F1' || (event.key === '/' && event.ctrlKey)) {
        event.preventDefault();
        $('#shortcut-dialog').showModal();
      }
    });
    on('#shortcut-dialog .close', 'click', () => $('#shortcut-dialog').close());
  }

  /** AI 面板：本期只有框架 + 只读的本地分析。 */
  function bindAiPanel() {
    on('#btn-ai', 'click', () => $('#ai-panel').classList.toggle('open'));
    on('#ai-close', 'click', () => $('#ai-panel').classList.remove('open'));
    onAll('[data-ai-action]', 'click', (event) => runAiAction(event.currentTarget.dataset.aiAction, event.currentTarget));
  }

  async function runAiAction(action, button) {
    if (state.aiBusy) return;
    const output = $('#ai-output');
    const text = editor.getText();

    if (GENERATIVE_ACTIONS.has(action)) {
      // 生成类任务没有本地替代。诚实报错，不返回任何「猜的续写」。
      output.innerHTML = `<div class="ai-error"><strong>AI 写作辅助需要配置 API Key</strong>
        <p>当前仅支持本地分析功能（摘要 / 关键词 / 可读性 / SEO）。</p>
        <p class="hint">在设置里填入 Provider 与 API Key 后，续写 / 改写 / 扩写 / 精简才会可用。</p></div>`;
      output.classList.add('visible');
      return;
    }

    state.aiBusy = true;
    button.classList.add('busy');
    output.innerHTML = '<p class="ai-loading">正在加载本地算法…</p>';
    output.classList.add('visible');
    try {
      const service = await createLocalAIService({ loadDictionary: fetchDictionaryBytes });
      const started = performance.now();
      const result = await service.run(text, action);
      const elapsed = Math.round(performance.now() - started);
      output.innerHTML = renderAiResult(action, result, elapsed);
    } catch (error) {
      output.innerHTML = `<div class="ai-error"><strong>${escapeHtml(error.message)}</strong></div>`;
      output.classList.add('visible');
    } finally {
      state.aiBusy = false;
      button.classList.remove('busy');
    }
  }

  function renderAiResult(action, result, elapsed) {
    const content = result.content ?? result;
    const badge = result.source === 'local'
      ? `<span class="ai-badge local">本地算法 · ${elapsed}ms</span>`
      : `<span class="ai-badge remote">${escapeHtml(result.provider ?? 'AI')} · ${elapsed}ms</span>`;
    if (action === 'summarize') {
      const body = typeof content === 'string' ? content : content?.short ?? content?.long ?? JSON.stringify(content);
      return `${badge}<div class="ai-block">${escapeHtml(body).replace(/\n/g, '<br>')}</div>`;
    }
    if (action === 'tags') {
      const tags = Array.isArray(content) ? content : [];
      if (!tags.length) return `${badge}<p class="ai-empty">正文太短，提不出关键词。</p>`;
      return `${badge}<div class="ai-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
        <p class="ai-note">这是 TF-IDF 关键词，不是语义标签 —— 按词频算，不懂主题。</p>`;
    }
    if (action === 'readability') {
      const score = content?.score ?? content?.flesch ?? '—';
      const level = content?.level ?? content?.label ?? '';
      const suggestions = content?.suggestions ?? content?.issues ?? [];
      return `${badge}<div class="ai-metric"><span class="value">${escapeHtml(String(score))}</span><span class="label">可读性</span></div>
        ${level ? `<p class="ai-note">${escapeHtml(String(level))}</p>` : ''}
        ${suggestions.length ? `<ul class="ai-list">${suggestions.slice(0, 6).map((s) => `<li>${escapeHtml(String(s.message ?? s))}</li>`).join('')}</ul>` : ''}`;
    }
    if (action === 'seo') {
      const score = content?.score ?? '—';
      const issues = content?.issues ?? content?.checks ?? [];
      return `${badge}<div class="ai-metric"><span class="value">${escapeHtml(String(score))}</span><span class="label">SEO</span></div>
        <ul class="ai-list">${issues.slice(0, 8).map((issue) => {
          const level = issue.level ?? issue.severity ?? 'info';
          return `<li class="level-${level}">${escapeHtml(String(issue.message ?? issue))}${issue.hint ? `<span class="hint">${escapeHtml(issue.hint)}</span>` : ''}</li>`;
        }).join('')}</ul>`;
    }
    return `${badge}<div class="ai-block">${escapeHtml(JSON.stringify(content, null, 2))}</div>`;
  }

  function flash(element, text) {
    const original = element.textContent;
    element.textContent = text;
    setTimeout(() => { element.textContent = original; }, 1200);
  }
}

/** HTML 转义：预览与目录都用它，不引第三方库（就这一个需求）。 */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** 工具栏命令表。全部来自 editor/commands.js，UI 不自己实现编辑逻辑。 */
const COMMANDS = {
  bold: (editor) => editor.exec(wrapSelection('**')),
  italic: (editor) => editor.exec(wrapSelection('*')),
  underline: (editor) => editor.exec(wrapSelection('<u>', { closing: '</u>' })),
  link: (editor) => editor.exec(insertLink()),
  image: (editor) => editor.exec(insertLink({ image: true })),
  code: (editor) => editor.exec(insertCodeBlock()),
  'code-block': (editor) => editor.exec(insertCodeBlock()),
  table: (editor) => editor.exec(insertTable),
  formula: (editor) => editor.exec(insertFormula),
  quote: (editor) => editor.exec(insertQuote),
  list: (editor) => editor.exec(insertList),
  'ordered-list': (editor) => editor.exec(insertOrderedList),
  task: (editor) => editor.exec(insertTaskList),
  h1: (editor) => editor.exec(headingCommand(1)),
  h2: (editor) => editor.exec(headingCommand(2)),
  h3: (editor) => editor.exec(headingCommand(3)),
};

/** 需要模型能力的动作：本地不提供替代。 */
const GENERATIVE_ACTIONS = new Set(['continue', 'rewrite', 'expand', 'condense', 'translate', 'title']);

// 预览 iframe 的文档壳：只带一份极简主题，正文 HTML 完全来自 core。
// 用 iframe 是为了让预览样式与站点样式隔离 —— 编辑器 UI 的 CSS 不会漏进预览，
// 预览的 CSS 也不会污染编辑器（否则「预览和构建不一样」就有了借口）。
function frameDocument(html) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/__studio/preview.css">
</head><body class="emeeek-preview"><article class="post-content">${html}</article></body></html>`;
}

function isDark(theme) { return theme === 'one-dark' || theme === 'dracula'; }
function themeFor(theme) { return theme; }

async function loadSiteData() {
  try {
    const response = await fetch('/__studio/site.json');
    if (!response.ok) return { posts: [], images: [] };
    return await response.json();
  } catch { return { posts: [], images: [] }; }
}

async function loadDraft() {
  try {
    const raw = localStorage.getItem('studio:draft');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function uploadImage(file) {
  const response = await fetch('/__studio/upload', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
    body: file,
  });
  if (!response.ok) throw new Error(`上传失败：${response.status}`);
  return response.json();
}

export { COMMANDS, frameDocument };

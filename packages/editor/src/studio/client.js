/**
 * Studio 客户端入口。
 *
 * 这个文件只做三件事：装配编辑器、订阅状态、把 UI 事件翻译成命令调用。
 * 任何「怎么写 HTML」的逻辑都不在这里 —— 预览 HTML 一律来自 @emeeek/core，
 * 客户端是纯粹的展示层 + 事件层。
 */
import {
  wrapSelection, insertLink, insertCodeBlock, insertTable, insertFormula, insertInlineFormula,
  insertQuote, insertList, insertOrderedList, insertTaskList, insertFootnote, insertHr, headingCommand,
} from '../editor/commands.js';
import { createEmeekEditor } from '../editor/index.js';
import { updatePreview, createIncrementalRenderer, createWikiLinkResolver } from '../preview/index.js';
import { fetchDictionaryBytes } from '../editor/dict.js';
import { createLocalAIService } from '../ai/bridge.js';
import { editorStats } from '../editor/stats.js';
import { byteLength, statusState, formatBytes } from '../editor/statusbar.js';
import { DraftStore, createAutoSaver, isMobileLike, DRAFT_LIMITS } from './drafts.js';
import { WELCOME } from './welcome.js';
import { SHORTCUTS, TOUCH_ALTERNATIVES, groupShortcuts, findShortcut, matchesShortcut } from './shortcuts.js';
import { decideSync, SYNC_DECISION, connectReloadStream } from './sync.js';
import { KeyStore, KEY_STORAGE, KEY_STORAGE_LABEL } from './keyring.js';

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

/** 待处理的草稿恢复（boot 阶段探测到，装配完编辑器再弹窗）。 */
let pendingRecovery = null;

const state = {
  filename: 'untitled.md',
  theme: readPref('studio:theme') ?? 'one-dark',
  mode: readPref('studio:mode') ?? 'split',
  saved: true,
  posts: [],
  outline: [],
  activeHeading: -1,
  aiBusy: false,
  /** 保存状态：saved | saving | dirty | failed | too-large | foreign-tab | local */
  saveState: 'local',
  /** 最近一次预览渲染耗时（ms），状态栏的性能提示要用。 */
  renderMs: 0,
  /** 当前正文的 UTF-8 字节数 —— 上限判断按字节，不按字符。 */
  bytes: 0,
  /** 后端文件模式（emeeek dev 集成）下的当前文件路径；否则 null。 */
  filePath: null,
  /** 远端内容指纹，用于草稿冲突检测。 */
  remote: null,
  /** 服务端提供的可编辑文件索引（emeeek dev 集成时非空）。 */
  available: [],
  autoSave: null,
  /** 是否按移动端策略跑（更短的兜底间隔、触屏替代入口）。 */
  mobile: false,
  /** 磁盘变更通道（只在文件模式下存在）。 */
  sync: null,
  /** API Key 仓库（决策 D1）。 */
  keys: null,
  /** 当前 Key 状态（四档之一）。 */
  keyStatus: null,
};

/**
 * 读偏好设置。
 *
 * 包一层 try 是必须的：Safari 隐私模式下 localStorage 存在但读写会抛，
 * 顶层直接读会让整个 boot() 中断、页面停在加载页 —— 一个「记住主题」的
 * 便利功能不该有让编辑器打不开的权力。
 */
function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 记不住偏好不影响编辑 */ }
}

const $ = (selector) => document.querySelector(selector);

/**
 * 自启动。
 *
 * 只在真的有 DOM 时启动 —— 这个文件同时被测试 import（拿 COMMANDS /
 * decideDraft 这类纯逻辑），那时没有 document，启动会抛一个
 * 「document is not defined」并污染整份测试报告（实测过：
 * 报错会挂在文件级，看不出是哪个测试的问题）。
 * 判据用 #studio 是否存在，而不是「有没有 document」——
 * 嵌到别的页面时也不该抢着启动。
 */
if (typeof document !== 'undefined' && document.getElementById('studio')) boot();

async function boot() {
  const app = $('#studio');
  app.dataset.theme = state.theme;
  document.body.classList.toggle('dark', isDark(state.theme));

  // 站点数据：文章列表用于 [[ 补全与双向链接解析，图片列表用于 ![ 补全。
  const siteData = await loadSiteData();
  state.posts = siteData.posts ?? [];
  const wikiLink = createWikiLinkResolver(state.posts);

  // 草稿：打开编辑器时先看有没有没写完的东西。
  //
  // 顺序很重要 —— 先把文件引出来，再决定用哪份内容，最后才装配编辑器。
  // 反过来做（先 WELCOME 装配、再替换内容）会多一次全量渲染，
  // 而且用户会看到标题闪一下。
  // owner 用会话级 id：刷新页面后还是「我」，重开标签页则是「新会话」。
  // 这是「草稿不丢」与「多标签页不互相覆盖」两个需求能同时成立的前提。
  const store = new DraftStore({ owner: TAB_ID });
  const file = await loadCurrentFile();
  const draft = store.load(file.filename);
  const decision = decideDraft({ file, draft });

  let initial = file.content ?? WELCOME;
  state.filename = file.filename;
  state.filePath = file.path ?? null;
  state.remote = file.remote ?? null;
  state.available = file.available ?? [];
  state.store = store;

  if (decision.use === 'draft' || decision.use === 'file') {
    initial = decision.use === 'draft' ? draft.content : file.content;
  }
  if (decision.prompt && draft) {
    // 内容先放草稿，对话框再问「恢复还是重来」——
    // 这样即使用户关掉对话框不做选择，看到的也是自己写过的东西，不会凭空丢失。
    initial = draft.content;
    pendingRecovery = { draft, file, decision };
  }

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
  window.__studio = { editor, state, store, vault };

  // 文件名上屏。之前忘了这一步，于是打开了 posts/foo.md 却还写着 untitled.md ——
  // 编辑器的标题栏在说谎，用户不知道自己在改哪个文件。
  setText('#file-name', state.filename);
  const fileNameButton = $('#file-name');
  if (fileNameButton) fileNameButton.title = state.filePath ? `正在编辑 ${state.filePath}` : '点击重命名（本地草稿）';

  renderOutline();
  renderStatus(editorStats(editor.state));
  bindToolbar(editor);
  bindLayout();
  bindKeyboardShortcuts();
  bindAiPanel();
  state.keys = createKeyStore();
  bindRecoveryDialog();
  bindHistoryDialog();
  renderKeyState();
  startDiskSync();
  applyTheme(state.theme);
  cycleMode(state.mode);
  startAutoSave();

  // 首屏只渲染一次预览：不预加载 408KB 词表，AI 相关能力在点击时才加载。
  updatePreviewPane(incremental, initial);
  requestAnimationFrame(() => {
    performance.mark?.('studio:ready');
    $('#boot').hidden = true;
    app.hidden = false;
    setSaveState('saved');
  });

  function onSourceChange(text) {
    // 内容一变就是「未保存」，并重置 5 秒空闲计时。
    // 不用等保存结果回来说脏 —— 从敲下第一个字到落盘之间，就是有东西没存。
    // 先更新字节数再改状态：状态栏的性能提示依赖 bytes，
    // 顺序反了会有一帧显示上一个文档的大小（大文档粘贴时看得出来）。
    state.bytes = byteLength(text);
    setSaveState('dirty');
    if (state.autoSave) state.autoSave.markDirty();
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
    // 渲染耗时既上预览标题栏（诊断），也进状态栏（预期管理）——
    // 两处说的是同一件事，不该各算一次。
    state.renderMs = elapsedMs;
    renderStatusBar(editorStats(editor.state));
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

  /**
   * 磁盘变更同步（决策 D4）。
   *
   * 立场与 S2-3a 完全一致，这里只是让它对新入口生效：
   *   本地干净 → 刷新（磁盘是唯一真相）
   *   本地脏   → 提示、两边都留、不自动合并
   *
   * 判断在哪一侧做：**决策在编辑器**。服务端只推「磁盘变了」这个事实，
   * 因为它不知道本地脏不脏。服务端替它决定就成了自动刷新 ——
   * 那种「你的改动被静默丢弃」的体验正是这一条要避免的。
   */
  function startDiskSync() {
    if (!state.filePath) return;   // 草稿模式没有磁盘可同步
    state.sync = connectReloadStream({
      /**
       * 通道用 studio 自己的 `/__studio/sync`。
       *
       * 默认值 `/__emeeek/reload` 是 dev server 那条 —— 它只推「变了」，
       * 不带磁盘指纹，拿它做同步决策会一路退化成 noop（sync 静默失效，
       * 而日志里一切正常：这个坑值得写下来）。
       */
      url: '/__studio/sync',
      onMessage: async (payload) => {
        // 编辑器自己保存触发的事件会走到这里：此时内容一致，决策是 noop
        const local = editor.getText();
        let decision = decideSync({
          localDirty: state.autoSave?.dirty ?? false,
          localFingerprint: fingerprint(local),
          remoteFingerprint: payload.fingerprint ?? null,
          currentRemote: state.remote?.fingerprint ?? null,
        });
        // 服务端能拿到磁盘指纹，用它复核一次 —— 两边都算同一件事
        try {
          const response = await fetch('/__studio/sync/decide', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              localDirty: state.autoSave?.dirty ?? false,
              localFingerprint: fingerprint(local),
              remoteFingerprint: payload.fingerprint ?? null,
              currentRemote: state.remote?.fingerprint ?? null,
            }),
          });
          if (response.ok) decision = await response.json();
        } catch { /* 服务端不可达时用本地判断，不阻断 */ }

        if (decision.decision === SYNC_DECISION.NOOP) return;
        if (decision.decision === SYNC_DECISION.CONFLICT) {
          showSyncConflict(decision.message);
          return;
        }
        // 本地干净：把磁盘内容取回来，不刷新整页（刷新会丢掉 AI 面板状态等）
        try {
          const file = await vault.read(state.filePath);
          editor.setText(file.content);
          state.remote = { id: `file:${file.path}`, kind: 'local-file', fingerprint: file.fingerprint };
          state.bytes = byteLength(file.content);
          setSaveState('saved');
          renderOutline();
        } catch (error) {
          console.warn(`[studio] 拉取磁盘内容失败：${error.message}`);
        }
      },
      onError: () => { /* EventSource 自己重连；这里不插手 */ },
    });
    state.sync.start();
  }

  function showSyncConflict(message) {
    const output = $('#ai-output');
    if (!output) return;
    output.classList.add('visible');
    output.innerHTML = `<div class="ai-error"><strong>磁盘上的文件变了</strong>
      <p>${escapeHtml(message)}</p>
      <p class="hint">没有自动合并 —— 那是把「谁的内容对」这个判断从你手里拿走。要覆盖就先「复制 Markdown」备份，再手动粘回去。</p></div>`;
  }

  /**
   * 自动保存调度（决策 D3）。
   *
   * 三条触发线的分工写在 drafts.js 的注释里，这里只说**为什么之前是错的**：
   *
   * 上一版只有「5 秒空闲 + 30 秒兜底 + beforeunload」，三条全押在定时器与
   * beforeunload 上。而移动端切后台会冻结定时器，beforeunload 又经常不触发 ——
   * 结果就是「切出去接个电话，回来稿子退回 5 秒前」，中间每一次自动保存都没跑。
   *
   * 现在把 `visibilitychange` / `pagehide` 交给 createAutoSaver 统一绑定：
   * 落盘时机只在一处实现，测试可以注入假事件验证，生产用真的 document/window。
   */
  function startAutoSave() {
    if (state.autoSave) return;
    state.mobile = detectMobile();
    state.autoSave = createAutoSaver({
      store,
      filename: state.filename,
      save: (reason) => persist(reason),
      mobile: state.mobile,
      events: { document, window },
    });
    state.autoSave.start();
    applyMobileLayout();
  }

  /** 移动端判定：视口宽度 + 触摸能力（UA 嗅探会把 iPad 当成桌面）。 */
  function detectMobile() {
    return isMobileLike({
      width: window.innerWidth ?? 0,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      coarsePointer: window.matchMedia?.('(pointer: coarse)')?.matches ?? false,
    });
  }

  /**
   * 移动端布局补偿。
   *
   * 三件事，都是「不做就会出问题」：
   *   1. 把 `--vvh` 设成 visualViewport 的高度 —— 软键盘弹出时布局视口不变，
   *      不这么做光标会被键盘挡住
   *   2. 转屏后重算高度 —— 否则编辑区还停在转屏前的尺寸
   *   3. 聚焦时把光标所在位置滚进可视区 —— 浏览器只保证「不离谱」，
   *      不保证「光标可见」
   */
  function applyMobileLayout() {
    const syncViewport = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--vvh', `${Math.round(height)}px`);
    };
    syncViewport();
    window.visualViewport?.addEventListener?.('resize', syncViewport);
    window.visualViewport?.addEventListener?.('scroll', ensureCursorVisible);
    window.addEventListener('orientationchange', () => {
      // 转屏后有两帧的中间态，等一拍再算 —— 立刻算会拿到旧尺寸
      setTimeout(syncViewport, 120);
      setTimeout(() => editorRef?.focus?.(), 160);
    });
    window.addEventListener('resize', () => {
      state.mobile = detectMobile();
      syncViewport();
      ensureCursorVisible();
    });
  }

  /** 把编辑器的光标行滚进可视区。软键盘遮挡时这一步是唯一能让用户看见光标的手段。 */
  function ensureCursorVisible() {
    const cursor = document.querySelector('.cm-cursor') ?? document.querySelector('.cm-content');
    if (!cursor?.scrollIntoView) return;
    const rect = cursor.getBoundingClientRect?.();
    if (!rect) return;
    const height = window.visualViewport?.height ?? window.innerHeight;
    // 只在真的越界时滚，否则每次按键都会重排一次
    if (rect.bottom > height - 24 || rect.top < 0) cursor.scrollIntoView({ block: 'nearest' });
  }

  /**
   * 真正的落盘。
   *
   * 关键点：**返回结果说了算**。store 说没写成，状态栏就显示失败 ——
   * 让用户以为存住了、结果重启后什么都没有，是这里最严重的一种 bug。
   */
  function persist(reason = 'idle') {
    const content = editor.getText();
    state.bytes = byteLength(content);

    /**
     * 打开了磁盘上的真实文件时，落盘就是「保存」的全部含义 ——
     * 不再往 localStorage 里抄一份。
     *
     * 之前两条路都写，结果同一份内容在本地草稿与文件之间出现了两个
     * 会各自漂移的副本：下次打开时「本地草稿比文件新」这类假冲突会一直报。
     * 文件模式信任文件，草稿模式信任草稿，两者不重叠。
     */
    if (state.filePath) {
      setSaveState('saving', `正在写回 ${state.filePath}…`);
      return pushFileToDisk()
        .then((result) => { setSaveState('saved'); return { ok: true, ...result }; })
        .catch((error) => {
          setSaveState('failed', `写回文件失败：${error.message}`);
          return { ok: false, reason: 'write-file', error: error.message, message: `写回文件失败：${error.message}` };
        });
    }

    setSaveState('saving', `正在保存（${reason}）…`);
    const result = store.save(state.filename, content, {
      title: firstHeading(content),
      source: state.remote,
    });
    if (result.ok) {
      setSaveState('saved');
      if (result.evicted?.length) {
        console.info(`[studio] 本地草稿超出 10MB 上限，已淘汰最旧的 ${result.evicted.length} 篇：${result.evicted.join('、')}`);
      }
      if (result.conflict) showConflictBanner(result.conflict);
      return result;
    }
    // 诚实反馈：写不进去就说写不进去，并说清为什么、还能怎么办。
    if (result.reason === 'too-large' || result.reason === 'quota') setSaveState('failed', result.message);
    else setSaveState(result.reason === 'foreign-tab' ? 'foreign-tab' : 'failed', result.message);
    return result;
  }

  /**
   * Ctrl+S / 保存按钮。
   *
   * 走的是与自动保存**同一条** persist 路径 —— 两条路径分开写，
   * 迟早有一条忘了处理失败、忘了更新状态栏，然后用户就看到一个
   * 显示「已保存 ✓」而实际没落盘的编辑器。
   * persist 在文件模式下返回 Promise，这里统一按 Promise 处理。
   */
  function saveDraft() {
    flushDraft('manual');
    return true;
  }

  /** 触发一次保存（同步返回草稿模式的结果，文件模式是 promise）。 */
  function flushDraft(reason) {
    if (state.autoSave && state.autoSave.dirty === false && reason !== 'manual') return null;
    const result = state.autoSave ? state.autoSave.flush(reason) : persist(reason);
    if (result && typeof result.then === 'function') return result;
    return result;
  }

  /** 第一行标题：草稿列表里显示用，找不到就退回文件名。 */
  function firstHeading(text) {
    const match = /^#{1,6}\s+(.+)$/m.exec(String(text ?? '')) ?? /^(.+)$/m.exec(String(text ?? '').trim());
    return match ? match[1].trim().slice(0, 60) : '';
  }

  /** 草稿恢复对话框的三种出口。 */
  function bindRecoveryDialog() {
    if (!pendingRecovery) return;
    const { draft, file, decision } = pendingRecovery;
    const dialog = $('#recover-dialog');
    if (!dialog?.showModal) return;

    setText('#recover-title', decision.prompt === 'conflict' ? '本地草稿与文件不一致' : '发现未保存的草稿');
    setText('#recover-meta', decision.prompt === 'conflict'
      ? `${file.filename} 在磁盘上被改过，本地也有一份草稿。两边都留着，你选一份继续。`
      : `上次写到 ${new Date(draft.timestamp).toLocaleString('zh-CN')} · ${formatBytes(byteLength(draft.content))} · 第 ${draft.version} 版`);
    const preview = $('#recover-preview');
    if (preview) preview.textContent = draft.content.slice(0, 400) || '（空）';

    on('#btn-recover', 'click', () => {
      editorRef.setText(draft.content);
      state.bytes = byteLength(draft.content);
      setSaveState('saved');
      dialog.close();
      flash($('#btn-recover'), '已恢复');
    });
    on('#btn-recover-discard', 'click', () => {
      store.remove(state.filename);
      editorRef.setText(file.content ?? WELCOME);
      setSaveState('saved');
      dialog.close();
    });
    on('#btn-recover-cancel', 'click', () => dialog.close());

    dialog.showModal();
    pendingRecovery = null;
  }

  /** 版本历史：看一眼每一版的开头，回退是最坏情况下唯一的退路。 */
  function bindHistoryDialog() {
    on('#btn-history', 'click', () => openHistory());
    on('#history-dialog .close', 'click', () => $('#history-dialog')?.close());
  }

  function openHistory() {
    const dialog = $('#history-dialog');
    const list = $('#history-list');
    if (!dialog?.showModal || !list) return;
    const record = store.load(state.filename);
    if (!record) {
      list.innerHTML = '<p class="history-empty">还没有存过草稿。停止输入 5 秒就会自动保存一次。</p>';
      dialog.showModal();
      return;
    }
    const entries = [{ version: record.version, timestamp: record.timestamp, content: record.content, current: true }, ...record.versions];
    list.innerHTML = entries.map((entry, index) => `
      <div class="history-item${entry.current ? ' current' : ''}">
        <div class="history-head">
          <span>第 ${entry.version} 版${entry.current ? '（当前）' : ''}</span>
          <span class="muted">${new Date(entry.timestamp).toLocaleString('zh-CN')} · ${formatBytes(byteLength(entry.content))}</span>
        </div>
        <pre>${escapeHtml(entry.content.slice(0, 160))}</pre>
        ${entry.current ? '' : `<button class="link-button" data-restore="${index - 1}">回退到这一版</button>`}
      </div>`).join('');
    list.querySelectorAll('[data-restore]').forEach((button) => button.addEventListener('click', () => {
      const index2 = Number(button.dataset.restore);
      const result = store.restoreVersion(state.filename, index2);
      if (!result?.restored) { flash(button, '这一版已经取不到了'); return; }
      editorRef.setText(result.restored.content);
      state.bytes = byteLength(result.restored.content);
      setSaveState('saved');
      flash(button, '已回退');
      openHistory();
    }));
    dialog.showModal();
  }

  /**
   * 站点/项目文件列表。
   *
   * 只在服务端提供了文件索引时才有内容，所以它是可选的 UI ——
   * 没有它就等于 `emeeek studio` 的纯草稿模式，功能不受影响。
   */
  renderFileList();

  function renderFileList() {
    const host = $('#file-list');
    if (!host) return;
    const available = state.available ?? [];
    if (!available.length) {
      host.innerHTML = '<p class="outline-empty">只跑 <code>emeeek studio</code> 时没有文件列表<br><span>用 <code>emeeek dev</code> 打开可以读写 posts/</span></p>';
      return;
    }
    host.innerHTML = available.map((file) => `
      <button class="file-item${file.path === state.filePath ? ' active' : ''}" data-file="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}">
        ${escapeHtml(file.title || file.name || file.path)}
      </button>`).join('');
    host.querySelectorAll('[data-file]').forEach((button) => button.addEventListener('click', async () => {
      try {
        await openFile(button.dataset.file);
        renderFileList();
        renderOutline();
      } catch (error) {
        flash(button, `打不开：${error.message}`);
      }
    }));
  }

  /** 冲突提示：本地和远端都改过。不自动合并 —— 那种「聪明」的合并最容易毁内容。 */
  function showConflictBanner(conflict) {
    const output = $('#ai-output');
    if (!output) return;
    output.classList.add('visible');
    output.innerHTML = `<div class="ai-error"><strong>远端内容也在变化（${escapeHtml(conflict.source)}）</strong>
      <p>本地草稿与远端的上一次同步点不同。已保留两边：你的内容在编辑器里，远端版本没有被动过。</p>
      <p class="hint">需要时先用「复制 Markdown」备份，再决定以哪边为准。</p></div>`;
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

  /** 状态栏：把渲染交给模块级的 renderStatusBar（见文件末尾）。 */
  function renderStatus(stats) {
    renderStatusBar(stats);
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

    // 命令顺序在 client 里补（fallback 分支的最后一项），
    // commands.js 不认识具体的模板名，也不该认识
    COMMANDS.code = (editor) => editor.exec(insertCodeBlock());

    // tooltip 里补上快捷键：按钮上悬停就能看到键位，不用去翻 F1 对话框
    document.querySelectorAll('[data-command]').forEach((button) => {
      const key = COMMAND_KEYS[button.dataset.command];
      if (!key) return;
      const base = button.title.replace(/\s*(?:Ctrl|Mod)[^ ]*.*$/, '');
      button.title = `${base} ${key}`;
    });

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

  /**
   * 全局快捷键（决策 D5）。
   *
   * 绑定的依据不是一份硬编码的 if 链，而是 shortcuts.js 的**声明表** ——
   * 表里每一条都有 handler，handler 表里每一条也都在表里。
   * 审计脚本（scripts/check-shortcuts.mjs）核对的正是这份表与这里的关系。
   *
   * 编辑器内的键位（CodeMirror keymap）不在这里 —— 那些跟着焦点走，
   * 表里以 handler:'editor' 标注，审计时去 editor/commands.js 核对。
   */
  function bindKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
      // 在输入框里打字不该触发 Ctrl+S，但功能键（F1）例外 ——
      // 用户在任何地方按 F1 都是想要帮助
      const inField = /input|textarea/i.test(event.target?.tagName ?? '');
      if (inField && event.key !== 'F1') return;

      if (event.key === 'Escape') {
        $('#ai-panel')?.classList.remove('open');
        document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
        return;
      }

      const declared = findShortcut(event);
      if (!declared) return;
      const handler = GLOBAL_HANDLERS[declared.id];
      if (!handler) {
        // 声明了却没有 handler：这是缺陷，不是「静默无事发生」。
        // 审计脚本会把它变红，运行时这里也留一条能定位的告警。
        console.warn(`[studio] 快捷键 ${declared.keys}（${declared.id}）声明了但没有 handler`);
        return;
      }
      event.preventDefault();
      handler(event);
    });
    on('#shortcut-dialog .close', 'click', () => $('#shortcut-dialog').close());
    on('#btn-shortcuts', 'click', () => openShortcutDialog());
    on('#btn-mobile-help', 'click', () => openShortcutDialog());
    renderShortcutDialog();
  }

  /**
   * 全局快捷键的 handler 表。
   *
   * 键 = shortcuts.js 里声明条的 id。审计脚本会双向核对：
   *   表里有 id、这里没有 → 红（这是 Ctrl+G 那一类）
   *   这里有 id、表里没有 → 红（用户永远不知道有这个键位）
   */
  const GLOBAL_HANDLERS = {
    save: () => saveDraft(),
    'goto-line': () => {
      const answer = globalThis.prompt?.('跳转到行号', '1');
      if (answer) editor.jumpToLine(Number(answer));
    },
    'toggle-preview': () => cycleMode(),
    'toggle-theme': () => toggleTheme(),
    'ai-panel': () => {
      $('#ai-panel')?.classList.toggle('open');
      $('#ai-close')?.focus();
    },
    help: () => openShortcutDialog(),
  };

  function openShortcutDialog() {
    const dialog = $('#shortcut-dialog');
    if (!dialog?.showModal) return;
    renderShortcutDialog();
    dialog.showModal();
  }

  /**
   * F1 表由声明表渲染。
   *
   * 手写一份 HTML 就会与实现分叉 —— 那份 HTML 正是 Ctrl+G 出现的地方。
   * 现在唯一的数据源是 shortcuts.js，渲染只是它的一个消费者。
   */
  function renderShortcutDialog() {
    const grid = $('#shortcut-grid');
    if (!grid || grid.dataset.rendered === '1') return;
    grid.dataset.rendered = '1';
    grid.innerHTML = groupShortcuts().map((group) => `
      <div>
        <h3>${escapeHtml(group.name)}</h3>
        ${group.items.map((item) => `
          <p data-shortcut="${escapeHtml(item.id)}">
            ${item.keys.split('+').map((part) => `<kbd>${escapeHtml(part)}</kbd>`).join('+')}
            <span>${escapeHtml(item.label)}</span>
          </p>`).join('')}
      </div>`).join('');

    const touch = $('#shortcut-touch');
    if (touch) {
      touch.innerHTML = `
        <h3>触屏替代</h3>
        <p class="dialog-note">触屏没有功能键。下面是同一件事在触屏上怎么做 —— 做不到的如实写「没有等价入口」，不假装可用。</p>
        <ul class="touch-list">
          ${TOUCH_ALTERNATIVES.map((item) => `<li><strong>${escapeHtml(item.action)}</strong>：${escapeHtml(item.via)}${item.note ? `<span class="hint">（${escapeHtml(item.note)}）</span>` : ''}</li>`).join('')}
        </ul>`;
    }

    // 草稿那一栏是动态的：间隔按当前是桌面还是移动端显示，不写死
    grid.insertAdjacentHTML('beforeend', `
      <div>
        <h3>草稿</h3>
        <p><span>停止输入 ${Math.round(DRAFT_LIMITS.idleMs / 1000)} 秒自动保存</span></p>
        <p><span>每 ${Math.round((state.autoSave?.intervalMs ?? DRAFT_LIMITS.intervalMs) / 1000)} 秒兜底保存一次${state.mobile ? '（移动端）' : ''}</span></p>
        <p><span>切后台 / 关页面时立即落盘，不等定时器</span></p>
        <p><span>本地保留最近 ${DRAFT_LIMITS.versions} 个版本，可回退</span></p>
        <p><span>单篇上限 ${Math.round(DRAFT_LIMITS.singleBytes / 1024 / 1024)}MB，总计 ${Math.round(DRAFT_LIMITS.totalBytes / 1024 / 1024)}MB</span></p>
      </div>`);
  }

  /**
   * AI 设置（决策 D1）。
   *
   * Key 状态机四档：未配置 / 服务端已配置 / 本次会话 / 已记住。
   * 四档文案全部来自 keyring.js，UI 不自己拼 —— 否则「服务端已配置」和
   * 「已记住」迟早被写成同一句话，而它们对用户的含义完全不同
   * （一个什么都不用做，一个要知道它留在哪台机器上）。
   */
  function createKeyStore() {
    return new KeyStore({
      server: async () => {
        try {
          const response = await fetch('/__studio/ai/status');
          if (!response.ok) return { configured: false };
          return await response.json();
        } catch { return { configured: false }; }
      },
    });
  }

  async function renderKeyState() {
    const status = await state.keys.status();
    const host = $('#ai-key-state');
    if (host) host.dataset.state = status.kind;
    setText('#ai-key-label', status.label ?? KEY_STORAGE_LABEL.none);
    const detail = $('#ai-key-detail');
    if (detail) {
      detail.textContent = status.kind === KEY_STORAGE.SERVER
        ? `${status.provider ?? ''} ${status.model ?? ''}`.trim()
        : status.kind === KEY_STORAGE.NONE ? '' : `${status.provider ?? '未指定 provider'}`;
    }
    const button = $('#btn-ai-key');
    if (button) {
      button.textContent = status.kind === KEY_STORAGE.SERVER ? '查看配置' : status.kind === KEY_STORAGE.NONE ? '配置 Key' : '修改 Key';
      // 服务端托管时用户不需要输入任何东西 —— 但保留入口，让他知道为什么不用输
      button.title = status.kind === KEY_STORAGE.SERVER ? 'Key 由服务端托管，不会进入浏览器' : '';
    }
    const hint = $('#ai-key-hint');
    if (hint) {
      hint.textContent = status.kind === KEY_STORAGE.SERVER
        ? 'Key 由服务端托管：它只存在于 dev server 进程内，不会到达浏览器。你不需要在这里输入任何东西。'
        : '无服务端托管时，Key 默认只作用于本次会话。勾选「记住」才会留在这台机器上。';
    }
    state.keyStatus = status;
    return status;
  }

  function bindAiPanel() {
    on('#btn-ai', 'click', () => $('#ai-panel').classList.toggle('open'));
    on('#ai-close', 'click', () => $('#ai-panel').classList.remove('open'));
    onAll('[data-ai-action]', 'click', (event) => runAiAction(event.currentTarget.dataset.aiAction, event.currentTarget));

    on('#btn-ai-key', 'click', () => openKeyDialog());
    on('#btn-ai-key-save', 'click', () => {
      const value = $('#ai-key-value')?.value ?? '';
      if (!value.trim()) { flash($('#btn-ai-key-save'), '请填入 Key'); return; }
      const remember = Boolean($('#ai-key-remember')?.checked);
      state.keys.set(value, {
        remember,
        provider: $('#ai-key-provider')?.value ?? null,
        model: $('#ai-key-model')?.value?.trim() || null,
      });
      const input = $('#ai-key-value');
      if (input) input.value = '';   // 存完就把输入框清掉，别让明文留在 DOM 里
      $('#ai-key-dialog')?.close();
      renderKeyState();
      flash($('#btn-ai-key'), remember ? '已记住' : '本次会话有效');
    });
    on('#btn-ai-key-clear', 'click', () => {
      state.keys.clear();
      const input = $('#ai-key-value');
      if (input) input.value = '';
      $('#ai-key-dialog')?.close();
      renderKeyState();
      flash($('#btn-ai-key'), '已清除');
    });
    on('#btn-ai-key-cancel', 'click', () => $('#ai-key-dialog')?.close());
  }

  function openKeyDialog() {
    const dialog = $('#ai-key-dialog');
    if (!dialog?.showModal) return;
    // 服务端托管时把输入区说清楚：用户不需要填，但可以覆盖成自己的
    if (state.keyStatus?.kind === KEY_STORAGE.SERVER) {
      setText('#ai-key-dialog-hint', `当前由服务端托管（${state.keyStatus.provider ?? ''}）。在这里填入 Key 会覆盖成你自己的、只作用于浏览器的这一份。`);
    }
    const provider = $('#ai-key-provider');
    if (provider && state.keyStatus?.provider) provider.value = state.keyStatus.provider;
    const model = $('#ai-key-model');
    if (model && state.keyStatus?.model) model.value = state.keyStatus.model;
    dialog.showModal();
  }

  async function runAiAction(action, button) {
    if (state.aiBusy) return;
    const output = $('#ai-output');
    const text = editor.getText();
    const status = state.keyStatus ?? await state.keys.status();

    /**
     * 生成类任务（续写 / 改写 / 扩写 / 精简 / 翻译 / 标题）。
     *
     * 两条路，按 D1 分层走：
     *   · 服务端托管 → 请求打到 /__studio/ai/run，**Key 不进浏览器**
     *   · 会话级 Key → 也只能走服务端代理（浏览器直连会把 Key 暴露在
     *     网络面板与扩展面前），所以同样打到那个端点，只是带上会话 Key
     *   · 都没有 → 诚实报错，不返回任何「猜的续写」
     */
    if (GENERATIVE_ACTIONS.has(action)) {
      if (status.kind === KEY_STORAGE.NONE) {
        output.innerHTML = `<div class="ai-error"><strong>AI 写作辅助需要配置 API Key</strong>
          <p>当前仅支持本地分析功能（摘要 / 关键词 / 可读性 / SEO），这些离线也能用。</p>
          <p class="hint">在「AI 设置」里填入 Key，或用 <code>EMEEEK_OPENAI_API_KEY</code> 启动 <code>emeeek studio</code> 由服务端托管 —— 后者不会让 Key 进入浏览器。</p></div>`;
        output.classList.add('visible');
        return;
      }
      state.aiBusy = true;
      button.classList.add('busy');
      output.innerHTML = '<p class="ai-loading">正在请求 AI…</p>';
      output.classList.add('visible');
      try {
        const started = performance.now();
        const result = await requestGenerative(action, text);
        const elapsed = Math.round(performance.now() - started);
        output.innerHTML = renderAiResult(action, result, elapsed);
      } catch (error) {
        // 「不确定就说不确定」：不编一个看起来像答案的东西
        output.innerHTML = `<div class="ai-error"><strong>AI 没能完成这次请求</strong>
          <p>${escapeHtml(error.message)}</p>
          <p class="hint">没有返回任何「猜的」内容 —— 不确定的事就该说不确定。</p></div>`;
      } finally {
        state.aiBusy = false;
        button.classList.remove('busy');
      }
      return;
    }

    state.aiBusy = true;
    button.classList.add('busy');
    // 词表加载进度：408KB 第一次取要一点时间，不提示会像卡住
    output.innerHTML = renderDictProgress(0);
    output.classList.add('visible');
    try {
      const service = await createLocalAIService({
        loadDictionary: (url) => fetchDictionaryBytes(url, (loaded, total) => {
          output.innerHTML = renderDictProgress(total ? loaded / total : 0);
        }),
      });
      output.innerHTML = '<p class="ai-loading">正在计算…</p>';
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

  /** 生成类任务统一走服务端代理 —— 即便 Key 在会话里，也不直连 provider。 */
  async function requestGenerative(action, text) {
    const apiKey = state.keys.get();
    const response = await fetch('/__studio/ai/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: text,
        task: action,
        // 会话级 Key 通过请求体传给**服务端**，由服务端转发。
        // 它没有出现在任何 URL 上（URL 会进访问日志与浏览器历史）。
        options: apiKey ? { apiKey, provider: state.keyStatus?.provider, model: state.keyStatus?.model } : {},
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!payload) throw new Error(`服务端没有返回可解析的结果（HTTP ${response.status}）`);
    if (!payload.ok) throw new Error(payload.error?.message ?? '未知错误');
    return payload.result;
  }

  /** 词表加载进度条。用文字而不是只转圈 —— 用户要知道还要等多久。 */
  function renderDictProgress(ratio) {
    const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    return `<p class="ai-loading">正在加载中文词表 408KB… ${percent}%
      <span class="hint">只在第一次「关键词提取」时需要，之后走浏览器缓存。</span></p>`;
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
  'formula-inline': (editor) => editor.exec(insertInlineFormula),
  quote: (editor) => editor.exec(insertQuote),
  list: (editor) => editor.exec(insertList),
  'ordered-list': (editor) => editor.exec(insertOrderedList),
  task: (editor) => editor.exec(insertTaskList),
  footnote: (editor) => editor.exec(insertFootnote),
  hr: (editor) => editor.exec(insertHr),
  h1: (editor) => editor.exec(headingCommand(1)),
  h2: (editor) => editor.exec(headingCommand(2)),
  h3: (editor) => editor.exec(headingCommand(3)),
};

  /**
   * 状态栏：字数 / 阅读时长 / 语言 / 行列 / 保存状态 / 大文档提示。
   *
   * 全部字段由 statusbar.js 的纯函数算出来，这里只做赋值 ——
   * 「保存失败却显示已保存」这类问题因此能在没有浏览器的测试里被抓
/**
 * 状态栏渲染（模块级）。
 *
 * 为什么在 boot() 之外：保存是异步的（写文件要走一个 HTTP 往返），
 * 它的回调要在很久之后更新状态栏。闭包在这件事上唯一的贡献是
 * 埋一个「函数在作用域外被调用」的坑 —— 已经踩过一次。
 *
 * 全部字段由 statusbar.js 的纯函数算出，这里只做赋值 ——
 * 「保存失败却显示已保存」这类问题因此能在没有浏览器的测试里被抓住。
 */
function renderStatusBar(stats) {
  const editor = editorRef;
  if (!stats || !editor) return;
  const text = editor.getText();
  const view = statusState({
    stats,
    bytes: state.bytes || byteLength(text),
    savedState: state.saveState,
    renderMs: state.renderMs,
    text,
  });
  setText('#stat-words', view.words);
  setText('#stat-reading', view.reading);
  setText('#stat-language', view.language);
  setText('#stat-cursor', view.cursor);
  setText('#stat-selected', view.selected);
  setText('#stat-save', view.save.label);
  const saveEl = $('#stat-save');
  if (saveEl) saveEl.dataset.state = view.save.state;
  renderPerf(view.perf);

  const button = $('#btn-save');
  if (button) {
    button.dataset.saveState = view.save.state;
    setText('#btn-save-label', saveButtonLabel(view.save.state));
    button.title = `${view.save.label}（Ctrl+S）`;
  }
  return view;
}

/**
 * 大文档性能提示。
 *
 * 这不是优化，是预期管理：27ms 的渲染用户感觉不到，但「点了没反应」
 * 会让人以为工具坏了。把数字和结论一起摆出来，用户就知道该等还是该分段。
 */
function renderPerf(notice) {
  const el = $('#stat-perf');
  if (!el) return;
  if (!notice) { el.hidden = true; el.textContent = ''; el.removeAttribute('data-level'); return; }
  el.hidden = false;
  el.dataset.level = notice.level;
  el.textContent = notice.text;
  el.title = '预览渲染与构建使用同一个渲染器，耗时随文档线性增长。';
}

function saveButtonLabel(kind) {
  return { saved: '已保存', saving: '保存中', dirty: '保存', failed: '重试', 'too-large': '无法保存', 'foreign-tab': '保存', quota: '重试' }[kind] ?? '保存';
}

/** 只在真的变了的时候写 DOM —— 状态栏每次按键都会刷，别让它成为输入延迟的来源。 */
function setText(selector, value) {
  const el = $(selector);
  if (el && el.textContent !== value) el.textContent = value;
}

/**
 * 保存状态。
 *
 * 做成模块级函数而不是 boot() 内的闭包：文件的写入是**异步**的，
 * 它的回调在 boot() 返回很久之后才跑。闭包在这件事上没有任何好处，
 * 反而在文件写入分支里踩过一次「setSaveState is not defined」——
 * 那次的表现是「Ctrl+S 后一直显示保存失败」，而真正的原因跟保存无关。
 *
 * `detail` 是给 tooltip / 控制台的原因说明。四种状态对应四种真实情况，
 * 不做「几乎成功」这种模糊表述 —— 用户必须有办法知道自己的字有没有落盘。
 */
function setSaveState(kind, detail = '') {
  state.saveState = kind;
  state.saved = kind === 'saved';
  const el = $('#stat-save');
  if (el) {
    el.dataset.state = kind;
    el.title = detail || '';
  }
  if (detail && kind !== 'saved' && kind !== 'dirty') console.warn(`[studio] 保存状态 ${kind}：${detail}`);
  const editor = editorRef;
  if (editor) renderStatusBar(editorStats(editor.state));
}

/**
 * 由确定性的种子算出来的「文件 id」，用于草稿归属。
 *
 * 为什么需要它：`emeeek studio` 每次打开都是全新的标签页，
 * localStorage 里还留着上一轮会话的 owner 标记 —— 如果不换 id，
 * 第二次打开会因为「这份草稿属于上一个标签页」而拒绝自动保存，
 * 表现为「打字之后永远显示未保存」。那个上一个标签页其实早就关了。
 *
 * 用「随机值 + 会话级存储」而不是 `crypto.randomUUID()`：
 * 随机值天生每次不同，会话存储（关标签页即清）让刷新后仍然认得自己。
 */
const TAB_ID = (() => {
  const KEY = '__emeeek_tab__';
  try {
    const existing = globalThis.sessionStorage?.getItem(KEY);
    if (existing) return existing;
    const fresh = `tab-${Math.random().toString(36).slice(2, 10)}`;
    globalThis.sessionStorage?.setItem(KEY, fresh);
    return fresh;
  } catch {
    return `tab-${Math.random().toString(36).slice(2, 10)}`;
  }
})();

/**
 * 命令的快捷键说明。
 *
 * 工具栏的 tooltip 直接读这张表，不另写一份 —— 两份「Ctrl+Shift+K 是任务列表」
 * 迟早会分叉，然后用户按不出来就开始怀疑编辑器。
 */
export const COMMAND_KEYS = Object.freeze({
  bold: 'Ctrl+B', italic: 'Ctrl+I', underline: 'Ctrl+U', link: 'Ctrl+K', image: 'Ctrl+Shift+I',
  'code-block': 'Ctrl+Shift+C', table: 'Ctrl+Shift+T', formula: 'Ctrl+Shift+M', 'formula-inline': 'Ctrl+Shift+E',
  footnote: 'Ctrl+Shift+F', list: 'Ctrl+Shift+U', 'ordered-list': 'Ctrl+Shift+O', task: 'Ctrl+Shift+K',
  hr: 'Ctrl+Shift+H', h1: 'Ctrl+Shift+1', h2: 'Ctrl+Shift+2', h3: 'Ctrl+Shift+3',
});

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

/** 与 core 一致的 FNV-1a 指纹（服务端比对用同一套）。 */
function fingerprint(text) {
  const value = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${value.length.toString(36)}-${hash.toString(36)}`;
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

/**
 * 文件仓库。
 *
 * Studio 有两种运行方式：
 *   `emeeek studio`          → 只有一个「当前草稿」，文件列表是站点文章（只读）
 *   `emeeek dev` 的 /studio  → 直接读写 posts/ 目录里的真实文件
 *
 * 两种方式在这里统一成同一个接口，编辑器上层不需要 if 分支。
 * 所有路径都由服务端校验（见 studio/server.js 的 resolveProjectFile）——
 * 客户端传什么都不能读写项目目录之外的东西。
 */
const vault = {
  mode: 'draft',
  list: async () => {
    try {
      const response = await fetch('/__studio/files');
      if (!response.ok) return null;
      const payload = await response.json();
      return Array.isArray(payload.files) ? payload.files : null;
    } catch { return null; }
  },
  read: async (filePath) => {
    const response = await fetch(`/__studio/file?path=${encodeURIComponent(filePath)}`);
    if (!response.ok) throw new Error(`读取失败：${response.status}`);
    return response.json();
  },
  write: async (filePath, content) => {
    const response = await fetch('/__studio/file', {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'x-file-path': encodeURIComponent(filePath) },
      body: content,
    });
    if (!response.ok) throw new Error(`写入失败：${response.status}`);
    return response.json();
  },
};

/**
 * 装载「当前正在编辑的文件」。
 *
 * 三种情况：
 *   1. URL 带 ?file=posts/x.md  → 从磁盘读（emeeek dev 集成）
 *   2. 服务端有文件模式但没有指定 → 用第一篇，方便直接开始
 *   3. 都没有 → 空白草稿，文件名 untitled.md
 *
 * 服务端不可用（离线打开、只跑了静态预览）时静默降级成第 3 种 ——
 * 编辑器不该因为「文件 API 没有」就打不开。
 */
async function loadCurrentFile() {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const requested = params.get('file');
  const index = await vault.list();
  const available = index ?? [];

  if (requested) {
    try {
      const file = await vault.read(requested);
      return {
        filename: pathName(file.path),
        path: file.path,
        content: file.content,
        remote: { id: `file:${file.path}`, kind: 'local-file', fingerprint: file.fingerprint },
        available,
      };
    } catch (error) {
      console.warn(`[studio] 打不开 ${requested}：${error.message}`);
    }
  }
  if (!requested && available.length) {
    try {
      const file = await vault.read(available[0].path);
      return {
        filename: pathName(file.path),
        path: file.path,
        content: file.content,
        remote: { id: `file:${file.path}`, kind: 'local-file', fingerprint: file.fingerprint },
        available,
      };
    } catch { /* 退回空白草稿 */ }
  }
  return { filename: 'untitled.md', path: null, content: null, remote: null, available };
}

/**
 * 草稿决策。
 *
 * 这里要回答的问题只有一个：**打开编辑器那一刻，屏幕上该是哪份内容。**
 * 三种情形各有各的正确解：
 *   - 有草稿、内容不同 → 用草稿（用户上次没写完的东西，丢掉最不可原谅）
 *   - 有草稿、内容相同 → 用哪份都一样，别弹窗打扰
 *   - 有草稿、磁盘文件也变了 → 两边都留着，让用户选（不自动合并）
 */
export function decideDraft({ file, draft }) {
  if (!draft) return { use: 'file', prompt: null };
  const same = file.content !== null && file.content === draft.content;
  if (same) return { use: 'draft', prompt: null };
  const diskChanged = Boolean(file.remote?.fingerprint && draft.source?.fingerprint && file.remote.fingerprint !== draft.source.fingerprint && file.content !== null);
  if (diskChanged) return { use: 'draft', prompt: 'conflict' };
  // 纯草稿模式（没有磁盘文件）：只要草稿跟示例内容不同就提示，避免「示例内容被当成我的稿子」
  if (file.content === null && draft.content !== WELCOME) return { use: 'draft', prompt: 'recover' };
  if (file.content !== null && draft.content !== file.content) return { use: 'draft', prompt: 'recover' };
  return { use: 'draft', prompt: null };
}

/** 从路径取文件名。服务端路径一律是 POSIX 风格。 */
function pathName(filePath) {
  return String(filePath ?? '').split('/').filter(Boolean).pop() ?? 'untitled.md';
}

/** 切换文件：先把当前草稿写完再换，最后 3 秒的输入不能因为切走而丢。 */
async function openFile(filePath) {
  if (state.autoSave?.dirty) state.autoSave.flush('switch');
  const file = await vault.read(filePath);
  state.filename = pathName(file.path);
  state.filePath = file.path;
  state.remote = { id: `file:${file.path}`, kind: 'local-file', fingerprint: file.fingerprint };
  state.autoSave?.rename(state.filename);
  editorRef.setText(file.content);
  setText('#file-name', state.filename);
  const button = $('#file-name');
  if (button) button.title = `正在编辑 ${file.path}`;
  setSaveState('saved');
  const url = new URL(globalThis.location.href);
  url.searchParams.set('file', file.path);
  globalThis.history?.replaceState?.(null, '', url);
  return file;
}

/** 把编辑器内容写回磁盘（emeeek dev 集成模式下 Ctrl+S 的第二个动作）。 */
async function pushFileToDisk() {
  if (!state.filePath) return null;
  const result = await vault.write(state.filePath, editorRef.getText());
  state.remote = { id: `file:${result.path}`, kind: 'local-file', fingerprint: result.fingerprint };
  setSaveState('saved');
  return result;
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

/**
 * Emeek Studio 编辑器核心：CodeMirror 6 装配。
 *
 * 设计取向：这个文件只负责「把扩展拼起来」，不实现任何编辑逻辑。
 * 每个能力都是独立扩展（命令 / 补全 / 状态栏 / 目录联动），
 * 这样默认配置和用户自定义配置走的是同一条路径 —— 不存在「内置的能改、
 * 外挂的不能改」这种分层。
 */
import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, highlightActiveLineGutter, lineNumbers, highlightSpecialChars, placeholder as cmPlaceholder, ViewPlugin } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, indentMore, indentLess } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput, LanguageDescription } from '@codemirror/language';
import { closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';

import { themeExtensions, THEMES, isDarkTheme } from './themes.js';
import { editorKeymap, setGotoLineHandler, gotoLine } from './commands.js';
import { autoCompleteExtensions } from './autocomplete.js';
import { codeLanguageDescriptions, findLanguage, loadLanguageSupport, SUPPORTED_LANGUAGES, isKnownLanguage } from './languages.js';
import { tocHighlightExtension, buildOutline } from './outline.js';
import { wordCountExtension, editorStats } from './stats.js';
import { imageDropHandler } from './drop-image.js';
import { markdownStyle, markdownDecorations } from './markdown-style.js';

export const DEFAULT_EXTENSIONS = Object.freeze([
  'basicSetup',
  'markdown',
  'theme',
  'lineWrapping',
  'markdownShortcuts',
  'autoComplete',
  'tocHighlight',
  'imageDrop',
]);

/**
 * 创建编辑器。
 *
 * @param {object} options
 *   doc              初始内容
 *   parent           挂载节点（浏览器环境必填）
 *   theme            'one-dark' | 'github-light' | 'dracula' | 'one-light'
 *   themeId          同 theme（兼容写法）
 *   lineWrapping     软换行，默认 true
 *   lineNumbers      行号，默认 true（也可以传 config 覆盖）
 *   onSave/onChange/onOutlineChange/onStats  回调
 *   posts/images     自动补全数据源
 *   extensions       追加扩展（插件化出口）
 *   initialLine      初始光标行（1 起）
 */
export function createEmeekEditor(options = {}) {
  const {
    doc = '',
    parent = null,
    theme = 'one-dark',
    lineWrapping = true,
    lineNumbers: showLineNumbers = true,
    readOnly = false,
    placeholder = '开始写点什么… 支持 Markdown、[[双向链接]]、代码块、公式',
    onSave,
    onChange,
    onOutlineChange,
    onStats,
    onTogglePreviewMode,
    onToggleTheme,
    posts = [],
    images = [],
    extensions = [],
    initialLine = 1,
  } = options;

  // 用 Compartment 而不是重建 view：主题切换、软换行开关都不该丢光标和撤销栈。
  const themeCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

  const themeList = [];
  if (theme) themeList.push(...themeExtensions(theme));
  if (theme === 'github-light' || theme === 'one-light') {
    themeList.push(syntaxHighlighting(defaultHighlightStyle, { fallback: true }));
  }

  const fixedExtensions = [
    themeCompartment.of(themeList),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    wrapCompartment.of(lineWrapping ? EditorView.lineWrapping : []),
    readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
    ...(showLineNumbers ? [lineNumbers()] : []),
    foldGutter(),
    ...markdownStyle,
    // markdownLanguage 提供 GFM 方言（表格、任务列表、删除线）；
    // codeLanguages 用 language-data 动态解析 ```lang —— 语言包按需下载。
    markdown({ base: markdownLanguage, codeLanguages: codeBlockLanguages(), addKeymap: true }),
    markdownDecorations,
    autoCompleteExtensions({ getPosts: () => posts, getImages: () => images }),
    tocHighlightExtension({ onChange: onOutlineChange }),
    wordCountExtension({ onChange: onStats }),
    imageDropHandler({ upload: options.uploadImage, onInsert: options.onImageInsert }),
    editorKeymap({ onSave, onTogglePreviewMode, onToggleTheme }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap]),
    // 条件扩展必须展开成数组：`cond ? ext : []` 会把数组当成扩展传进去，
    // CodeMirror 不认识「数组里嵌套数组」的组合（实测直接抛
    // Unrecognized extension value），所以统一用展开语法。
    ...(placeholder ? [cmPlaceholder(placeholder)] : []),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange?.(update.state.doc.toString(), update.state);
    }),
    ...extensions,
  ];

  if (typeof process !== 'undefined' && process.env?.EMEEEK_DEBUG_EXTENSIONS) {
    // 排障用：逐个 flatten 一次，报出到底哪个扩展是无效值。
    // CodeMirror 的错误信息只说「扩展集合里有无法识别的值」，不说是哪一个。
    for (const ext of fixedExtensions) {
      try {
        EditorState.create({ doc: '', extensions: [ext] });
      } catch (error) {
        console.error('[studio] 无效扩展：', ext, error.message);
      }
    }
  }

  const state = initialLine > 1
    ? EditorState.create({ doc, extensions: fixedExtensions, selection: EditorSelection.cursor(0) })
    : EditorState.create({ doc, extensions: fixedExtensions });

  const view = new EditorView({ state, parent: parent ?? undefined });

  if (initialLine > 1) gotoLine(initialLine)(view);
  if (parent) view.focus();

  const api = {
    view,
    get state() { return view.state; },
    get doc() { return view.state.doc.toString(); },

    focus: () => view.focus(),
    destroy: () => view.destroy(),

    getText: () => view.state.doc.toString(),
    setText: (text) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },

    /** 主题切换：Compartment 重配，光标/撤销栈保持。 */
    setTheme: (id) => {
      const themeListNext = themeExtensions(id);
      view.dispatch({ effects: themeCompartment.reconfigure(themeListNext) });
      view.dom.dataset.studioTheme = id;
      view.dom.classList.toggle('cm-studio-dark', isDarkTheme(id));
      return id;
    },
    setLineWrapping: (enabled) => view.dispatch({ effects: wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : []) }),
    setReadOnly: (enabled) => view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(enabled)) }),

    /** 目录导航用：让编辑器滚动到指定行（光标不动，避免打断输入）。 */
    scrollToLine: (line) => {
      const target = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line)));
      view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
    },

    jumpToLine: (line) => gotoLine(line)(view),

    /** 当前光标所在行（1 起）与列。 */
    cursorPosition: () => {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number, column: head - line.from + 1, total: view.state.doc.lines };
    },

    /** 统计信息（字数/阅读时长/行列）。 */
    getStats: () => editorStats(view.state),

    outline: () => buildOutline(view.state),

    runCommand: (command) => command(view),
    /** 供外部（工具栏）把命令绑上去：先聚焦再执行，否则选区会丢。 */
    exec: (command) => { view.focus(); return command(view); },

    get themes() { return THEMES; },
  };

  setGotoLineHandler(() => {
    const answer = typeof globalThis.prompt === 'function' ? globalThis.prompt('跳转到行号', '1') : null;
    if (answer) api.jumpToLine(Number(answer));
  });

  return api;
}

/**
 * 代码块语言适配。
 *
 * 只暴露 @codemirror/lang-markdown 需要的 LanguageDescription 形状，
 * 具体语言在语法树第一次遇到该语言的代码块时才会真正 import。
 */
function codeBlockLanguages() {
  return codeLanguageDescriptions;
}

/** 便捷：只有 DOM 的极简挂载（演示页/嵌入用）。 */
export function mountEditor(element, options = {}) {
  return createEmeekEditor({ ...options, parent: element });
}

export { EditorView, EditorState, ThemeType };
export { THEMES, themeExtensions, isDarkTheme } from './themes.js';
export { editorKeymap, wrapSelection, insertSnippet, insertLink, insertTable, insertCodeBlock, headingCommand, gotoLine } from './commands.js';
export { autoCompleteExtensions } from './autocomplete.js';
export { buildOutline, tocHighlightExtension } from './outline.js';
export { editorStats, countWords, readingTime } from './stats.js';
export { SUPPORTED_LANGUAGES, findLanguage, isKnownLanguage, loadLanguageSupport, preloadLanguages } from './languages.js';
export { markdownStyle, markdownDecorations } from './markdown-style.js';

// ThemeType 只是主题 id 的语义化别名，不引入运行时类型系统
const ThemeType = /** @type {const} */ ('one-dark');

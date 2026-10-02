/**
 * Markdown 自动补全：`[[` 文章链接、``` 代码块语言、`![` 图片。
 *
 * 用 @codemirror/autocomplete 的 source 接口，而不是自己监听按键拼字符：
 * 后者会和输入法（中文输入法尤其）打架，而且撤销栈会碎成一地。
 * source 只在补全面板需要时才被调用，输入法在 composition 期间不会触发。
 */
import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { COMMON_LANGUAGES, SUPPORTED_LANGUAGES, isKnownLanguage } from './languages.js';

export const SEMANTIC_EMOJI = ['✨', '🚀', '📦', '🔧', '🐛', '📝', '⚡', '🎨', '🔥', '✅', '❌', '⚠️', '💡', '📌', '🔍', '🧪', '🛠️', '🌱', '📊', '🧩'];

/**
 * `[[` 触发：已有文章标题候选。
 *
 * posts 由外部注入（编辑器不知道站点有哪些文章），每项 { title, url?, description? }。
 * 没有文章时给一条「了解双向链接」的兜底提示 —— 空面板比没有面板更让人困惑。
 */
export function wikiLinkCompletion(posts = []) {
  return (context) => {
    // 同上：matchBefore 的模式必须能匹配到光标位置
    const before = context.matchBefore(/\[\[[^\]|]*$/);
    if (!before) return null;
    const query = before.text.slice(2).trim().toLowerCase();
    const options = posts
      .map((post) => (post && typeof post === 'object' ? post : { title: String(post ?? '') }))
      .map((post) => ({ title: String(post.title ?? ''), rest: post }))
      .filter((item) => item.title !== '')
      .filter((item) => !query || item.title.toLowerCase().includes(query))
      .slice(0, 30)
      .map((item) => ({
        // label 是插入内容，也是面板里的显示文本。CM6 没有独立的
        // displayLabel 字段（那是我记错了 API）—— 想要「显示标题、
        // 插入 [[标题]]」，正确做法是用 label + apply 覆盖插入行为。
        label: item.title,
        detail: item.rest.tags?.slice(0, 3).join(' · ') || item.rest.description?.slice(0, 24) || '',
        type: 'text',
        apply: (view, _completion, from, to) => {
          const insert = `[[${item.title}]]`;
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
        },
      }));

    /**
     * 兜底提示只在「站点里一篇文章都没有」时给。
     *
     * 之前写成了「过滤后为空就给」—— 于是用户打「[[首屏」而站内没有
     * 匹配的文章时，面板里冒出一条「还没有其他文章」，而站内其实有 30 篇。
     * 那是在撒谎，比空面板更让人困惑。
     * 过滤后为空就是为空 —— 补全面板本来就会自己关掉，不需要我编一条。
     */
    if (!options.length && posts.length === 0) {
      options.push({
        label: '文章标题',
        detail: '站内还没有其他文章',
        type: 'text',
        apply: (view, _c, from, to) => {
          view.dispatch({ changes: { from, to, insert: '[[文章标题]]' }, selection: { anchor: from + 2 } });
        },
      });
    }
    return { from: before.from + 2, to: before.to, options, validFor: /^[^\]|]*$/ };
  };
}

/** ``` 触发：代码块语言候选。已输入的语言名做过滤，未知语言给一条纯文本提示。 */
export function codeFenceCompletion() {
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = /^\s*```([A-Za-z0-9+#-]*)$/.exec(before);
    if (!match) return null;
    const query = match[1].toLowerCase();
    const ordered = [...new Set([...COMMON_LANGUAGES, ...SUPPORTED_LANGUAGES])];
    const options = ordered
      .filter((name) => !query || name.toLowerCase().startsWith(query) || name.toLowerCase().includes(query))
      .map((name) => ({
        label: name.toLowerCase(),
        displayLabel: name,
        detail: COMMON_LANGUAGES.includes(name) ? '常用' : '',
        type: 'keyword',
        apply: (view, _c, from, to) => {
          view.dispatch({ changes: { from, to, insert: name.toLowerCase() }, selection: { anchor: from + name.length } });
        },
      }));

    // 「输入语言名但语言包不存在」是最容易让人困惑的情况，明确告知而不是静默变纯文本
    if (query.length > 1 && !isKnownLanguage(query)) {
      options.unshift({
        label: query,
        displayLabel: `${query}（无语法支持，按纯文本显示）`,
        type: 'text',
        apply: (view, _c, from, to) => view.dispatch({ changes: { from, to, insert: query } }),
      });
    }
    if (!options.length) return null;
    return { from: line.from + match[0].indexOf('```') + 3, to: context.pos, options, validFor: /^[A-Za-z0-9+#-]*$/ };
  };
}

/** `![alt](` 触发：图片路径候选（来自外部提供的已有图片列表）。 */
export function imagePathCompletion(images = []) {
  return (context) => {
    const before = context.matchBefore(/!?\[[^\]]*\]\(([^)\s]*)$/);
    if (!before) return null;
    const query = /\(([^)]*)$/.exec(before.text)?.[1]?.toLowerCase() ?? '';
    return {
      from: context.pos - query.length,
      to: context.pos,
      options: images
        .filter((image) => !query || String(image).toLowerCase().includes(query))
        .slice(0, 20)
        .map((image) => ({ label: String(image), type: 'text' })),
      validFor: /^[^)\s]*$/,
    };
  };
}

/** 行首触发常用语法模板（输入 `h1`、`table`、`code` 之类直接展开）。 */
export function snippetCompletion() {
  const SNIPPETS = [
    { label: 'h1', detail: '一级标题', apply: '# ' },
    { label: 'h2', detail: '二级标题', apply: '## ' },
    { label: 'h3', detail: '三级标题', apply: '### ' },
    { label: 'table', detail: '表格', apply: '| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |' },
    { label: 'code', detail: '代码块', apply: '```\n\n```' },
    { label: 'formula', detail: '公式', apply: '$$\n\n$$' },
    { label: 'link', detail: '链接', apply: '[](url)' },
    { label: 'image', detail: '图片', apply: '![alt](url)' },
    { label: 'quote', detail: '引用', apply: '> ' },
    { label: 'task', detail: '任务列表', apply: '- [ ] ' },
    { label: 'hr', detail: '分隔线', apply: '---' },
    { label: 'footnote', detail: '脚注', apply: '[^1]: 说明' },
  ].map((item) => ({ ...item, type: 'keyword', apply: (view, _c, from, to) => {
    view.dispatch({ changes: { from, to, insert: item.apply }, selection: { anchor: from + item.apply.length } });
  } }));

  return (context) => {
    /**
     * 只匹配「从行首开始、全是小写字母」的当前词。
     *
     * 不用 /^[a-z]+$/ 交给 matchBefore —— 带上 ^/$ 锚点的正则，
     * matchBefore 会按「整份文档」而不是「当前词」判断，实测直接返回 null。
     * 自己取词 + 自己判行首，语义明确也测得住。
     */
    /**
     * 自己取词，不用 matchBefore。
     *
     * matchBefore 会用 ensureAnchor(expr, false) 把正则重写成「行首锚定」，
     * 于是 /[a-z]+/ 变成 /^[a-z]+/，只从行首开始匹配 —— 而光标在词尾时
     * search 仍找不到（实测返回 null）。它的语义是「光标前那个完整的词」，
     * 与「行首那个词」不是一回事。
     *
     * 这里要的是后者，所以直接看当前行的行首文本，语义直白也能测。
     */
    const line = context.state.doc.lineAt(context.pos);
    const beforeCursor = line.text.slice(0, context.pos - line.from);
    // 允许数字：模板名里就有 h1/h2/h3（写成 [a-z]+ 会让它们永远匹配不到）
    const word = /^([a-z][a-z0-9]*)$/.exec(beforeCursor);
    if (!word) return null;
    const options = SNIPPETS.filter((item) => item.label.startsWith(word[1]));
    if (!options.length) return null;
    return { from: line.from, to: context.pos, options, validFor: /^[a-z][a-z0-9]*$/ };
  };
}

/**
 * 汇总成一个扩展。
 * posts/images 通过 getter 注入，这样补全候选会跟着站点数据变化，
 * 不需要重建 EditorView（重建会丢光标与撤销栈）。
 */
export function autoCompleteExtensions({ getPosts = () => [], getImages = () => [] } = {}) {
  return [
    closeBrackets(),
    autocompletion({
      // 传函数而不是数组：面板每次打开时重新求值，
      // 站点文章列表变了不需要重建 EditorView（重建会丢光标与撤销栈）。
      override: [
        (context) => wikiLinkCompletion(getPosts())(context),
        codeFenceCompletion(),
        (context) => imagePathCompletion(getImages())(context),
        snippetCompletion(),
      ],
      activateOnTyping: true,
      closeOnBlur: true,
      maxRenderedOptions: 30,
    }),
  ];
}

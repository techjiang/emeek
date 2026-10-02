/**
 * 目录导航：从编辑器语法树抽标题，并做「光标 → 当前章节」联动。
 *
 * 为什么走语法树而不是正则扫 `^#{1,6}`：
 * 代码块里的 `# 注释` 不是标题。正则分不清，语法树天然分得清 ——
 * 目录里混进代码注释，用户点一下跳到错误的位置，比没有目录更糟。
 *
 * 锚点 id 的算法与 @emeeek/core 的 slugify 保持一致（同一份规则复制到
 * 浏览器端不现实 —— core 的渲染器依赖 Node），所以这里有一份等价实现，
 * 并有测试盯着两者对齐。
 */
import { syntaxTree } from '@codemirror/language';
import { ViewPlugin } from '@codemirror/view';

export function headingSlug(text) {
  const base = String(text)
    .toLowerCase()
    .trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'section';
  return base;
}

/** 抽取标题：返回 [{ level, text, line, from, id }]。 */
export function buildOutline(state) {
  const items = [];
  const seen = new Map();
  syntaxTree(state).iterate({
    enter: (node) => {
      const match = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
      if (!match) return;
      const level = Number(match[1]);
      const line = state.doc.lineAt(node.from);
      const raw = state.sliceDoc(node.from, node.to);
      const text = raw.replace(/^#{1,6}\s*/, '').replace(/\s+#+\s*$/, '').replace(/[*_`~[\]]/g, '').trim();
      if (!text) return;
      const base = headingSlug(text);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      items.push({ level, text, line: line.number, from: node.from, id: count === 0 ? base : `${base}-${count + 1}` });
    },
  });
  return items;
}

/** 当前光标所在章节的下标（-1 表示在首个标题之前）。 */
export function activeHeadingIndex(outline, cursorLine) {
  let index = -1;
  for (let i = 0; i < outline.length; i += 1) {
    if (outline[i].line <= cursorLine) index = i;
    else break;
  }
  return index;
}

/**
 * 目录联动扩展。
 *
 * onChange(outline, activeIndex) 在文档或光标变化时触发 ——
 * UI 只订阅这一个事件，不需要自己 diff 文档。
 * 变化时才回调（docChanged / selectionSet），普通滚动不触发，避免无谓的重渲染。
 */
export function tocHighlightExtension({ onChange } = {}) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.outline = buildOutline(view.state);
      this.active = activeHeadingIndex(this.outline, view.state.doc.lineAt(view.state.selection.main.head).number);
      onChange?.(this.outline, this.active);
    }

    update(update) {
      const changed = update.docChanged || update.selectionSet;
      if (!changed) return;
      if (update.docChanged) this.outline = buildOutline(update.state);
      const active = activeHeadingIndex(this.outline, update.state.doc.lineAt(update.state.selection.main.head).number);
      if (update.docChanged || active !== this.active) {
        this.active = active;
        onChange?.(this.outline, active);
      }
    }
  });
}

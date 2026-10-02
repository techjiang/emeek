/**
 * 编辑器统计：字数、阅读时长、行列。
 *
 * 与 @emeeek/core 的 excerpt.js 保持同一套口径（中文字符按 1 字、英文按词），
 * 否则编辑器说 1200 字、构建产物说 1100 字，用户不知道该信哪个。
 */
import { ViewPlugin } from '@codemirror/view';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const LATIN_WORD = /[A-Za-z0-9][A-Za-z0-9'’_-]*/g;

/** 去掉 front-matter、代码块围栏与行内标记，统计「正文」字数。 */
export function stripForCount(markdown) {
  return String(markdown ?? '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~\-]{1,}/g, ' ');
}

export function countWords(markdown) {
  const text = stripForCount(markdown);
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.match(LATIN_WORD) ?? []).length;
  return cjk + latin;
}

/** 阅读时长（分钟）：中文按 300 字/分，英文按 200 词/分，取整数分钟，最小 1。 */
export function readingTime(markdown) {
  const text = stripForCount(markdown);
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.match(LATIN_WORD) ?? []).length;
  const minutes = cjk / 300 + latin / 200;
  return Math.max(1, Math.round(minutes));
}

export function editorStats(state) {
  const doc = state.doc.toString();
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const selected = state.selection.main.empty ? 0 : state.selection.main.to - state.selection.main.from;
  return {
    characters: doc.length,
    words: countWords(doc),
    readingMinutes: readingTime(doc),
    lines: state.doc.lines,
    line: line.number,
    column: head - line.from + 1,
    selected,
  };
}

/** 变化时回调统计结果（含光标移动）。 */
export function wordCountExtension({ onChange } = {}) {
  return ViewPlugin.fromClass(class {
    update(update) {
      if (update.docChanged || update.selectionSet) onChange?.(editorStats(update.state));
    }
  });
}

/**
 * 图片拖拽 / 粘贴。
 *
 * 两条路径：
 * - 有 upload（Studio 的 /__studio/upload）→ 上传后插入返回的 URL
 * - 没有 upload（纯前端演示）→ 用 ObjectURL 插入本地预览
 *
 * 都用 data-* 标记「本地未上传」，交给 UI 提示用户 —— 静默插入一个
 * 只在本机有效的 blob: 链接，用户发布后才发现图片 404，这才是最坏的结果。
 */
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

async function handleFiles(view, files, { upload, onInsert, insertAt }) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    let url = null;
    let local = true;
    if (typeof upload === 'function') {
      try {
        const result = await upload(file);
        url = typeof result === 'string' ? result : result?.url ?? null;
        local = false;
      } catch (error) {
        console.warn('[studio] 图片上传失败，退回本地预览', error);
      }
    }
    if (!url) url = URL.createObjectURL(file);
    const alt = file.name.replace(/\.[^.]+$/, '');
    const syntax = `![${alt}](${url})`;
    const from = insertAt ?? view.state.selection.main.from;
    view.dispatch({
      changes: { from, insert: syntax },
      selection: EditorSelection.cursor(from + syntax.length),
      userEvent: 'input',
    });
    onInsert?.({ url, alt, local, file });
  }
}

export function imageDropHandler({ upload, onInsert } = {}) {
  return [
    EditorView.domEventHandlers({
      drop(event, view) {
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
        handleFiles(view, files, { upload, onInsert, insertAt: pos });
        return true;
      },
      paste(event, view) {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault();
        handleFiles(view, files, { upload, onInsert });
        return true;
      },
    }),
  ];
}

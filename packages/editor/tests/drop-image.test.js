/**
 * 图片拖拽 / 粘贴。
 *
 * 关键断言是「本地未上传的图片被明确标记」——
 * 静默插入一个只在本机有效的 blob: 链接，用户发布后才发现图 404，
 * 这是最坏的结果。所以 onInsert 必须带 local 标志。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { imageDropHandler } from '../src/editor/drop-image.js';
import { EditorView } from '@codemirror/view';

const { setupDom, createHost } = await import('./helpers/dom.js');
await setupDom();

const { createEmeekEditor } = await import('../src/editor/index.js');

/**
 * 取出 drop-image 扩展里的 drop/paste 处理器。
 *
 * EditorView.domEventHandlers() 返回一个 ViewPlugin，处理器在
 * `.domEventHandlers` 上（不是 `.extension[0].value` —— 我一开始就是这么
 * 写错的，直接 TypeError）。这里把访问方式收成一个函数，测试里只关心行为。
 */
const handlers = (options) => imageDropHandler(options)[0].domEventHandlers;

/** 造一个假的 image File。 */
function imageFile(name = 'shot.png', type = 'image/png') {
  return new globalThis.File([new Uint8Array([1, 2, 3])], name, { type });
}

function textFile(name = 'notes.txt') {
  return new globalThis.File(['hello'], name, { type: 'text/plain' });
}

describe('图片拖拽', () => {
  test('上传成功后插入远端 URL，并标记为非本地', async () => {
    const inserted = [];
    const editor = createEmeekEditor({
      doc: '',
      parent: document.getElementById('host'),
      uploadImage: async (file) => ({ url: `/uploads/${file.name}` }),
      onImageInsert: (info) => inserted.push(info),
    });
    const event = { preventDefault: () => {}, dataTransfer: { files: [imageFile('我的图.png')] }, clientX: 0, clientY: 0 };
    const handled = handlers({ upload: async (file) => ({ url: `/uploads/${file.name}` }), onInsert: (info) => inserted.push(info) }).drop(event, editor.view);
    assert.equal(handled, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].local, false, '上传成功的图片不该被标成本地');
    assert.match(editor.getText(), /!\[我的图\]\(\/uploads\//);
    editor.destroy();
  });

  test('没有上传能力时用 ObjectURL，并明确标记 local: true', async () => {
    const inserted = [];
    const editor = createEmeekEditor({ doc: '', parent: document.getElementById('host') });
    const event = { preventDefault: () => {}, dataTransfer: { files: [imageFile('shot.png')] }, clientX: 0, clientY: 0 };
    handlers({ onInsert: (info) => inserted.push(info) }).drop(event, editor.view);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].local, true, '本地预览图必须标记出来，否则用户发布后才发现 404');
    assert.match(editor.getText(), /blob:local-preview/);
    editor.destroy();
  });

  test('上传失败时退回本地预览（不静默丢弃）', async () => {
    const inserted = [];
    const editor = createEmeekEditor({ doc: '', parent: document.getElementById('host') });
    handlers({ upload: async () => { throw new Error('服务器 500'); }, onInsert: (info) => inserted.push(info) })
      .drop({ preventDefault: () => {}, dataTransfer: { files: [imageFile()] }, clientX: 0, clientY: 0 }, editor.view);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].local, true);
    assert.match(editor.getText(), /blob:/);
    editor.destroy();
  });

  test('非图片文件不处理（返回 false，让浏览器默认行为接管）', () => {
    const editor = createEmeekEditor({ doc: '', parent: document.getElementById('host') });
    const handled = handlers({}).drop({ preventDefault: () => {}, dataTransfer: { files: [textFile()] }, clientX: 0, clientY: 0 }, editor.view);
    assert.equal(handled, false);
    editor.destroy();
  });

  test('没有文件的拖拽不处理', () => {
    const editor = createEmeekEditor({ doc: '', parent: document.getElementById('host') });
    assert.equal(handlers({}).drop({ preventDefault: () => {}, dataTransfer: { files: [] }, clientX: 0, clientY: 0 }, editor.view), false);
    editor.destroy();
  });

  test('粘贴图片走同一条路径', async () => {
    const inserted = [];
    const editor = createEmeekEditor({ doc: '', parent: document.getElementById('host') });
    const handled = handlers({ onInsert: (info) => inserted.push(info) }).paste({ preventDefault: () => {}, clipboardData: { files: [imageFile('paste.png')] } }, editor.view);
    assert.equal(handled, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(inserted[0].alt, 'paste');
    editor.destroy();
  });

  test('alt 文字取文件名去掉扩展名', async () => {
    const inserted = [];
    const editor = createEmeekEditor({ doc: '', parent: document.getElementById('host') });
    handlers({ onInsert: (info) => inserted.push(info) })
      .drop({ preventDefault: () => {}, dataTransfer: { files: [imageFile('我的截图.webp')] }, clientX: 0, clientY: 0 }, editor.view);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(inserted[0].alt, '我的截图');
    editor.destroy();
  });
});

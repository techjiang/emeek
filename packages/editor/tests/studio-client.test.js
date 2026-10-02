/**
 * Studio 客户端逻辑的测试（不需要浏览器）。
 *
 * 这里放的是「能被纯逻辑测掉、但曾经因为没测而在真浏览器里翻车」的东西：
 *   - 打开哪个文件（草稿 / 磁盘文件 / URL 指定的文件）
 *   - 冲突与恢复的判定
 *   - 快捷键表与工具栏命令表是否对得上
 *
 * 真浏览器留给端到端冒烟（要启动 Chromium），这里保证的是
 * 「改了这些东西不会悄悄弄坏另一处」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideDraft, COMMAND_KEYS } from '../src/studio/client.js';
import { COMMANDS } from '../src/studio/client.js';
import { WELCOME as WELCOME_TEXT } from '../src/studio/welcome.js';

describe('草稿决策', () => {
  const WELCOME = { content: '# 欢迎', filename: 'untitled.md' };
  const file = (content, fingerprint = 'fp1') => ({
    filename: 'a.md', path: 'posts/a.md', content, remote: { id: 'file:posts/a.md', fingerprint }, available: [],
  });

  test('没有草稿 → 用文件内容', () => {
    const d = decideDraft({ file: file('# 磁盘上的'), draft: null });
    assert.equal(d.use, 'file');
    assert.equal(d.prompt, null);
  });

  test('草稿与文件内容一致 → 用草稿，但不打扰用户', () => {
    const d = decideDraft({ file: file('# 一样'), draft: { content: '# 一样', timestamp: 1 } });
    assert.equal(d.use, 'draft');
    assert.equal(d.prompt, null);
  });

  test('草稿比文件新且不相同 → 用草稿并提示恢复', () => {
    const d = decideDraft({ file: file('# 磁盘'), draft: { content: '# 草稿', timestamp: 1 } });
    assert.equal(d.use, 'draft');
    assert.equal(d.prompt, 'recover');
  });

  test('文件在磁盘上也被改过（指纹变了）→ 提示冲突，不自动选边', () => {
    const d = decideDraft({
      file: file('# 远端新内容', 'fp-new'),
      draft: { content: '# 本地草稿', timestamp: 1, source: { id: 'file:posts/a.md', fingerprint: 'fp-old' } },
    });
    assert.equal(d.prompt, 'conflict');
  });

  test('纯草稿模式：内容还是示例时也不弹恢复对话框', () => {
    const d = decideDraft({
      file: { filename: 'untitled.md', path: null, content: null, remote: null },
      // WELCOME 的真实内容由 welcome.js 提供，这里直接 import 它 ——
      // 硬编码字符串会在示例内容一改就假绿
      draft: { content: WELCOME_TEXT, timestamp: 1 },
    });
    assert.equal(d.prompt, null, '内容还是首篇示例时不该问「要不要恢复」');
  });

  test('纯草稿模式：真写过的内容会提示恢复', () => {
    const d = decideDraft({ file: { filename: 'untitled.md', path: null, content: null, remote: null }, draft: { content: '# 我自己写的', timestamp: 1 } });
    assert.equal(d.prompt, 'recover');
  });
});

describe('命令表与快捷键表', () => {
  test('工具栏上每个按钮都有对应命令实现', () => {
    // 按钮在 HTML 里，这里只能断言「表里有实现的命令不少于按钮数」，
    // 真正的「HTML 上的每个 data-command 都有实现」由下面那条守
    for (const name of ['bold', 'italic', 'underline', 'link', 'image', 'code-block', 'table', 'formula', 'quote', 'list', 'ordered-list', 'task', 'hr', 'h1', 'h2', 'h3']) {
      assert.equal(typeof COMMANDS[name], 'function', `${name} 没有实现 —— 按钮点了会没反应`);
    }
  });

  test('快捷键说明表里的每个命令都在命令表里', () => {
    for (const name of Object.keys(COMMAND_KEYS)) {
      assert.equal(typeof COMMANDS[name], 'function', `${name} 在快捷键表里但没有实现`);
    }
  });

  test('用户清单上的快捷键都有落点', () => {
    // 用户明确要求的键位，一个都不能少
    for (const key of ['Ctrl+B', 'Ctrl+I', 'Ctrl+K', 'Ctrl+Shift+I', 'Ctrl+Shift+C', 'Ctrl+Shift+M', 'Ctrl+Shift+T']) {
      assert.ok(Object.values(COMMAND_KEYS).includes(key), `${key} 没有对应的命令`);
    }
  });
});

describe('HTML 与命令表一致', () => {
  test('studio.html 上每个 data-command 都有实现（否则按钮点了没反应）', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const html = await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/assets/studio.html'), 'utf8');
    const used = [...html.matchAll(/data-command="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(used.length >= 14, `工具栏按钮只有 ${used.length} 个，太少了`);
    for (const name of used) {
      assert.equal(typeof COMMANDS[name], 'function', `HTML 里的 ${name} 在 COMMANDS 里没有实现`);
    }
  });

  test('状态栏与恢复对话框需要的关键元素都在 HTML 里', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const html = await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/assets/studio.html'), 'utf8');
    for (const id of ['stat-words', 'stat-reading', 'stat-language', 'stat-cursor', 'stat-save', 'stat-perf', 'recover-dialog', 'history-dialog', 'history-list', 'file-list', 'btn-history', 'btn-save-label']) {
      assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id} —— 状态栏或对话框会缺一块`);
    }
  });

  test('首屏 HTML 依然不引用词表（408KB 不进关键路径）', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const html = await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/assets/studio.html'), 'utf8');
    assert.doesNotMatch(html, /zh-words/);
  });
});

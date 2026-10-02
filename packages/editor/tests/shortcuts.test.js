/**
 * 快捷键声明表的测试（决策 D5）。
 *
 * 这里只测「声明表自身的形状与匹配规则」；声明与实现的**双向审计**
 * 在 scripts/check-shortcuts.mjs 里（它需要同时读 client.js / commands.js 的源码）。
 * 两层分开的理由：这个文件能给出「哪一条的匹配规则错了」这种定位，
 * 审计脚本能给出「表里有实现没有」这种全局结论。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUTS, TOUCH_ALTERNATIVES, groupShortcuts, matchesShortcut, findShortcut } from '../src/studio/shortcuts.js';

/** 造一个键盘事件。 */
function keyEvent(key, { ctrl = false, meta = false, shift = false, alt = false, code = '' } = {}) {
  return { key, ctrlKey: ctrl, metaKey: meta, shiftKey: shift, altKey: alt, code };
}

describe('声明表的形状', () => {
  test('每条都有 id / label / keys / group / handler / match', () => {
    for (const item of SHORTCUTS) {
      assert.ok(item.id, `缺 id：${JSON.stringify(item)}`);
      assert.ok(item.label, `${item.id} 缺 label`);
      assert.ok(item.keys, `${item.id} 缺 keys`);
      assert.ok(item.group, `${item.id} 缺 group`);
      assert.ok(['editor', 'global'].includes(item.handler), `${item.id} 的 handler 只能是 editor/global`);
      assert.ok(item.match && item.match.key, `${item.id} 缺 match.key`);
    }
  });

  test('id 唯一（重复 id 会让 handler 表静默覆盖）', () => {
    const ids = SHORTCUTS.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, `重复 id：${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
  });

  test('键位描述唯一（同一个键位绑两件事，后一条永远触发不了）', () => {
    const keys = SHORTCUTS.map((item) => item.keys);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dupes, [], `重复键位：${dupes.join(', ')}`);
  });

  test('触屏替代清单里每条要么有入口，要么明说没有', () => {
    for (const item of TOUCH_ALTERNATIVES) {
      assert.ok(item.action && item.via, `触屏条目不完整：${JSON.stringify(item)}`);
      if (!item.selector) assert.ok(item.note, `「${item.action}」没有 selector 时必须在 note 里说明为什么`);
    }
  });

  test('分组只是视图，不丢条目', () => {
    const total = groupShortcuts().reduce((sum, group) => sum + group.items.length, 0);
    assert.equal(total, SHORTCUTS.length);
  });
});

describe('匹配规则', () => {
  const save = SHORTCUTS.find((item) => item.id === 'save');
  const help = SHORTCUTS.find((item) => item.id === 'help');
  const h1 = SHORTCUTS.find((item) => item.id === 'h1');
  const up = SHORTCUTS.find((item) => item.id === 'move-line-up');

  test('Ctrl 与 Cmd 等价（macOS 上按 Cmd）', () => {
    assert.equal(matchesShortcut(keyEvent('s', { ctrl: true }), save.match), true);
    assert.equal(matchesShortcut(keyEvent('s', { meta: true }), save.match), true);
  });

  test('不带 Shift 的键位：Shift 按下时不匹配（这一点必须精确）', () => {
    // Ctrl+S 与 Ctrl+Shift+S 是两件事。只判「按了 Ctrl」的写法会让它们互相触发，
    // 表现是「想保存结果触发了别的东西」——所以这里要求精确匹配。
    assert.equal(matchesShortcut(keyEvent('s', { ctrl: true }), save.match), true);
    assert.equal(matchesShortcut(keyEvent('S', { ctrl: true, shift: true }), save.match), false);
  });

  test('大小写不敏感：Caps Lock 不该让快捷键失效', () => {
    assert.equal(matchesShortcut(keyEvent('S', { ctrl: true }), save.match), true);
  });

  test('缺 Ctrl 不触发，多余的 Shift 也不触发', () => {
    assert.equal(matchesShortcut(keyEvent('s'), save.match), false);
    assert.equal(matchesShortcut(keyEvent('s', { ctrl: true, shift: true }), save.match), false);
  });

  test('F1 不需要修饰键', () => {
    assert.equal(matchesShortcut(keyEvent('F1'), help.match), true);
    assert.equal(matchesShortcut(keyEvent('F1', { ctrl: true }), help.match), false);
  });

  test('Ctrl+Shift+1 在真实浏览器里 event.key 是 !（必须靠 code 区分）', () => {
    // 真浏览器的行为：Shift 把「1」变成「!」，所以拿 event.key 比 '1' 永远比不中。
    // 声明表里带 code 的条目就是为这个存在的。
    assert.equal(matchesShortcut(keyEvent('!', { ctrl: true, shift: true, code: 'Digit1' }), h1.match), true);
    assert.equal(matchesShortcut(keyEvent('@', { ctrl: true, shift: true, code: 'Digit2' }), h1.match), false, '别的数字键不该匹配 H1');
    assert.equal(matchesShortcut(keyEvent('!', { ctrl: true, code: 'Digit1' }), h1.match), false, '缺 Shift 不该匹配');
  });

  test('Alt 组合不要求 Ctrl', () => {
    assert.equal(matchesShortcut(keyEvent('ArrowUp', { alt: true }), up.match), true);
    assert.equal(matchesShortcut(keyEvent('ArrowUp'), up.match), false);
  });

  test('findShortcut 找到唯一一条', () => {
    assert.equal(findShortcut(keyEvent('s', { ctrl: true }))?.id, 'save');
    assert.equal(findShortcut(keyEvent('q', { ctrl: true, shift: true }))?.id, 'quote');
    assert.equal(findShortcut(keyEvent('s')), null);
  });
});

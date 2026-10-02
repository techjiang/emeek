/**
 * 状态栏与性能提示的测试。
 *
 * 这些断言的对象都是纯函数，原因是：状态栏最严重的 bug 不是「显示得不好看」，
 * 而是**说了假话** —— 显示「已保存 ✓」但其实没写进去、显示「0 字」但其实有内容。
 * 把它做成纯函数，这类问题就能在没有浏览器的测试里被钉住。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { statusState, perfNotice, detectLanguage, formatBytes, byteLength, PERF_THRESHOLDS, SAVE_LABELS } from '../src/editor/statusbar.js';

const stats = (over = {}) => ({ words: 1200, readingMinutes: 4, line: 12, column: 3, selected: 0, characters: 5000, ...over });

describe('性能提示', () => {
  test('小文档不提示（提示过多等于没有提示）', () => {
    assert.equal(perfNotice(10 * 1024, 3), null);
    assert.equal(perfNotice(PERF_THRESHOLDS.noticeBytes - 1, 3), null);
  });

  test('50KB 起提示「文档较大」，并给出真实耗时', () => {
    const notice = perfNotice(82 * 1024, 27);
    assert.equal(notice.level, 'notice');
    assert.match(notice.text, /文档较大（82KB）/);
    assert.match(notice.text, /27ms/);
  });

  test('100KB 起提示「文档很大，可能有轻微延迟」', () => {
    const notice = perfNotice(156 * 1024, 27);
    assert.equal(notice.level, 'large');
    assert.match(notice.text, /156KB/);
    assert.match(notice.text, /轻微延迟/);
  });

  test('渲染超过 50ms 时优先级最高 —— 用户正在经历的事比客观大小更该说', () => {
    const notice = perfNotice(60 * 1024, 85);
    assert.equal(notice.level, 'slow');
    assert.match(notice.text, /85ms/);
    assert.match(notice.text, /分段编辑/);
  });

  test('用户给的示例文案逐字对得上', () => {
    // 「文档较大（82KB），渲染耗时 27ms」
    assert.equal(perfNotice(82 * 1024, 27).text, '文档较大（82KB），渲染耗时 27ms');
    // 「文档很大（156KB），预览可能有轻微延迟」
    assert.equal(perfNotice(156 * 1024, 27).text, '文档很大（156KB），预览可能有轻微延迟');
    // 「预览渲染较慢（85ms），建议分段编辑」
    assert.equal(perfNotice(60 * 1024, 85).text, '预览渲染较慢（85ms），建议分段编辑');
  });
});

describe('保存状态', () => {
  test('每种状态都有对应文案，且没有一种是模棱两可的', () => {
    for (const kind of ['saved', 'saving', 'dirty', 'failed', 'local', 'too-large', 'quota', 'foreign-tab']) {
      assert.equal(typeof SAVE_LABELS[kind], 'string', `${kind} 缺少文案`);
      assert.ok(SAVE_LABELS[kind].length > 0);
    }
  });

  test('保存失败必须显示失败，不能显示已保存', () => {
    const view = statusState({ stats: stats(), bytes: 5000, savedState: 'failed' });
    assert.equal(view.save.state, 'failed');
    assert.ok(!view.save.label.includes('已保存'));
    assert.match(view.save.label, /失败/);
  });

  test('未知状态退回「本地草稿」，不显示空白', () => {
    const view = statusState({ stats: stats(), savedState: 'wat' });
    assert.equal(view.save.label, '本地草稿');
  });
});

describe('语言指示', () => {
  test('纯中文 / 纯英文 / 混排 / 空', () => {
    assert.equal(detectLanguage('这是一段中文').code, 'zh');
    assert.equal(detectLanguage('this is english text').code, 'en');
    // 混排的判据：两种文字都占到 20% 以上
    assert.equal(detectLanguage('中文 mixed 英文').label, '中英混排');
    // 中文技术文章里夹几个英文术语不算混排 —— 那是常态
    assert.equal(detectLanguage('中文中文中文中文中文中文中文中文中文中文 GitHub 中文中文中文中文中文中文中文中文中文').label, '中文');
    assert.equal(detectLanguage('12345').label, '纯文本');
    assert.equal(detectLanguage('').label, '纯文本');
  });
});

describe('状态栏整体', () => {
  test('全部字段来自 stats，不自己造数字', () => {
    const view = statusState({ stats: stats({ words: 3456, readingMinutes: 12, line: 88, column: 9 }), bytes: 20000, savedState: 'saved', text: '中文' });
    assert.equal(view.words, '3,456 字');
    assert.equal(view.reading, '约 12 分钟');
    assert.equal(view.cursor, '行 88, 列 9');
    assert.equal(view.language, '中文');
  });

  test('空文档不显示性能提示（空白页说「文档较大」只会让人困惑）', () => {
    assert.equal(statusState({ stats: stats({ words: 0, characters: 0 }), bytes: 0 }).perf, null);
  });

  test('缺少 stats 时给出安全默认值，而不是抛错', () => {
    const view = statusState({});
    assert.equal(view.words, '0 字');
    assert.equal(view.cursor, '行 1, 列 1');
  });

  test('选中长度只在真有选区时出现', () => {
    assert.equal(statusState({ stats: stats({ selected: 0 }) }).selected, '');
    assert.equal(statusState({ stats: stats({ selected: 42 }) }).selected, '选中 42');
  });

  test('bytes 优先于 characters（中文按字节算才对）', () => {
    // 100 个中文字 = 5000 个字符位？不，是 100 字符 / 300 字节
    const view = statusState({ stats: stats({ characters: 100 }), bytes: 60 * 1024, renderMs: 20 });
    assert.ok(view.perf, '按字节 60KB 应当触发提示');
  });
});

describe('字节数', () => {
  test('中文按 UTF-8 三字节算', () => {
    assert.equal(byteLength('中'), 3);
    assert.equal(byteLength('中文测试'), 12);
    assert.equal(byteLength('ab'), 2);
    assert.equal(byteLength(''), 0);
  });

  test('formatBytes 与提示文案里的单位一致', () => {
    assert.equal(formatBytes(82 * 1024), '82KB');
    assert.equal(formatBytes(156 * 1024), '156KB');
  });
});

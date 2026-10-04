import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanBlockedHosts,
  checkIcp,
  planFontSubset,
  toRanges,
  analyzeImages,
  buildLocalFontFace,
  BLOCKED_HOSTS,
} from '../../src/accel/china.js';

describe('中国大陆加速专项', () => {
  test('识别 Google Fonts 引用 —— 国内首屏白屏的常见元凶', () => {
    const html = '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet" />';
    const found = scanBlockedHosts(html);
    assert.equal(found.length, 1);
    assert.equal(found[0].host, 'fonts.googleapis.com');
    assert.ok(found[0].suggestion);
  });

  test('识别多个不可达域名并去重', () => {
    const html = [
      '<link href="https://fonts.googleapis.com/css" rel="stylesheet" />',
      '<script src="https://cdn.jsdelivr.net/npm/x.js"></script>',
      '<link href="https://fonts.googleapis.com/css2" rel="stylesheet" />',
    ].join('');
    const found = scanBlockedHosts(html);
    assert.deepEqual(found.map((f) => f.host).sort(), ['cdn.jsdelivr.net', 'fonts.googleapis.com']);
  });

  test('本地资源不受影响', () => {
    assert.deepEqual(scanBlockedHosts('<link href="/assets/theme.css" /><script src="/a.js"></script>'), []);
  });

  test('自定义 hosts 列表可用于扩展', () => {
    const found = scanBlockedHosts('<script src="https://my-cdn.example/x.js"></script>', { hosts: ['my-cdn.example'] });
    assert.equal(found.length, 1);
  });

  test('BLOCKED_HOSTS 覆盖关键项', () => {
    assert.ok(BLOCKED_HOSTS.includes('fonts.googleapis.com'));
    assert.ok(BLOCKED_HOSTS.includes('fonts.gstatic.com'));
  });

  test('ICP 未备案 → blocker（这不是慢，是打不开）', () => {
    const r = checkIcp({ cdn: { china: { enabled: true, provider: 'aliyun', domain: 'cdn.x.cn', icp: false } } });
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0].message, /不是变慢，是打不开/);
  });

  test('github.io 不能作为国内加速域名', () => {
    const r = checkIcp({ cdn: { china: { enabled: true, provider: 'aliyun', domain: 'x.github.io', icp: true } } });
    assert.ok(r.blockers.some((b) => /github\.io/.test(b.message)));
  });

  test('Cloudflare 免费套餐不含大陆节点 → 警告而非阻断', () => {
    const r = checkIcp({ cdn: { china: { enabled: true, provider: 'cloudflare', domain: 'cdn.x.cn', icp: true } } });
    assert.ok(r.warnings.some((w) => /免费套餐/.test(w.message)));
  });

  test('未开启大陆加速时不检查', () => {
    const r = checkIcp({ cdn: { china: { enabled: false } } });
    assert.equal(r.enabled, false);
    assert.equal(r.blockers.length, 0);
  });

  test('字体子集规划：只保留 CJK 与中文标点', () => {
    const posts = [{ title: '你好世界', raw: 'hello 你好，世界！' }];
    const plan = planFontSubset(posts);
    assert.ok(plan.totalGlyphs > 0);
    assert.ok(plan.totalGlyphs < 20, `应只收中文字形，实际 ${plan.totalGlyphs}`);
  });

  test('字体子集按 30KB 分片，每片不超过上限', () => {
    const raw = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
    const plan = planFontSubset([{ title: raw, raw }]);
    assert.ok(plan.chunkCount > 1);
    for (const chunk of plan.chunks) {
      assert.ok(chunk.estimatedBytes <= plan.maxChunkBytes + 1, `片 ${chunk.index} 超限`);
    }
  });

  test('unicode-range 连续段合并', () => {
    assert.deepEqual(toRanges([65, 66, 67, 70]), ['U+0041-U+0043', 'U+0046']);
  });

  test('无字体重子集时回退系统字体（零网络请求）', () => {
    const css = buildLocalFontFace({ chunks: [] });
    assert.match(css, /system-ui/);
    assert.doesNotMatch(css, /@font-face/);
  });

  test('有子集时生成 @font-face + unicode-range', () => {
    const css = buildLocalFontFace({ chunks: [{ index: 0, unicodeRange: ['U+0041-U+005A'] }] });
    assert.match(css, /@font-face/);
    assert.match(css, /unicode-range: U\+0041-U\+005A/);
    assert.match(css, /font-display: swap/);
  });

  test('图片分析点出体积/尺寸/WebP/懒加载问题', () => {
    const r = analyzeImages([
      { url: '/a.png', bytes: 900 * 1024, width: 3000, format: 'png', hasWebp: false, lazy: false },
      { url: '/b.webp', bytes: 50 * 1024, width: 800, format: 'webp', hasWebp: true, lazy: true },
    ]);
    assert.equal(r.offenders.length, 1);
    assert.equal(r.offenders[0].url, '/a.png');
    assert.ok(r.offenders[0].reasons.length >= 3);
  });
});

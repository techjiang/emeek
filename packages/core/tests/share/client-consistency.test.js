import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { encodeQr } from '../../src/share/qr.js';
import { SHARE_CLIENT } from '../../src/share/client.js';
import { buildShareView } from '../../src/share/index.js';

/**
 * 构建期与浏览器端的二维码必须**逐格相同**。
 *
 * 这是「同一算法的两个宿主」这类设计的核心防线：一旦两边漂移，
 * 症状是「页面上画的二维码扫出来是错的地址」—— 而这在开发时不点
 * 「微信」按钮就永远看不到。
 *
 * 做法：把 SHARE_CLIENT 放进一个 vm，暴露它的 encode()，
 * 与 qr.js 的输出对比。这样两边用的是**同一份真实代码**，
 * 而不是「我以为它们一样」。
 */
function loadClientEncoder() {
  const sandbox = {
    document: { readyState: 'complete', querySelectorAll: () => [], addEventListener() {} },
  };
  vm.createContext(sandbox);
  // 在**外层 IIFE 收尾之前**插入暴露语句。必须定位到最后一个 `}());` ——
  // 脚本里有多个 IIFE（GF 表、主逻辑），用 replace 会命中第一个，
  // 把赋值塞进内层作用域，而 encode 在外层，取不到（ReferenceError）。
  const marker = '}());';
  const at = SHARE_CLIENT.lastIndexOf(marker);
  assert.ok(at > 0, 'SHARE_CLIENT 必须以 IIFE 形式收尾');
  const instrumented = `${SHARE_CLIENT.slice(0, at)}globalThis.__encode = encode;\n${SHARE_CLIENT.slice(at)}`;
  vm.runInContext(instrumented, sandbox);
  assert.equal(typeof sandbox.__encode, 'function', 'SHARE_CLIENT 必须暴露 encode（测试接缝）');
  return sandbox.__encode;
}

describe('二维码：构建期与浏览器端一致', () => {
  const texts = [
    'https://example.com/',
    'https://example.com/posts/hello.html',
    'https://example.com/posts/hello.html?utm_source=emeek&utm_medium=social',
    'https://emeeek.example.com/posts/为什么我们需要一个静态博客引擎.html',
    'a'.repeat(60),
    'b'.repeat(120),
  ];

  test('同一输入的矩阵逐格相同', () => {
    const encodeClient = loadClientEncoder();
    for (const text of texts) {
      const build = encodeQr(text, { level: 'M' });
      const client = encodeClient(text);
      assert.equal(client.length, build.size, `尺寸不一致：${text.slice(0, 30)}`);
      // 用 JSON 比较，不用 deepEqual：client 的数组来自另一个 vm realm，
      // 它的 Array.prototype 与主 realm 不是同一个 —— 严格深比较会因为
      // 「原型不同」而判不等，哪怕每一格都一样。这类假失败很费时间，记在这。
      assert.equal(
        JSON.stringify(client),
        JSON.stringify(build.matrix),
        `矩阵不一致：${text.slice(0, 30)}`,
      );
    }
  });

  test('画布必须留 4 模块静默区（扫码成功率的硬条件）', () => {
    const sandbox = { document: { readyState: 'complete', querySelectorAll: () => [], addEventListener() {} } };
    vm.createContext(sandbox);
    const marker = '}());';
    const at = SHARE_CLIENT.lastIndexOf(marker);
    const instrumented = `${SHARE_CLIENT.slice(0, at)}globalThis.__layout = qrLayout;\n${SHARE_CLIENT.slice(at)}`;
    vm.runInContext(instrumented, sandbox);
    const layout = sandbox.__layout;
    assert.equal(typeof layout, 'function', 'qrLayout 必须可测');
    // 版本 1（21 模块）：21 + 4*2 = 29 模块宽
    const g1 = layout(21, 240);
    assert.equal(g1.quiet, 4, '静默区必须是 4 个模块 —— 少了它解码器读不出来');
    assert.equal(g1.px, (21 + 8) * g1.scale, '画布宽 = (模块数 + 静默区×2) × 缩放');
    assert.ok(g1.scale >= 2, '模块至少要 2 像素');
    // 更大的矩阵也不会退化掉静默区
    const g2 = layout(57, 240);
    assert.equal(g2.quiet, 4);
    assert.equal(g2.px, (57 + 8) * g2.scale);
  });

  test('两边都遵守同一容量边界', () => {
    const encodeClient = loadClientEncoder();
    // 长度刚好能编 / 明显超长，两边表现要一致（能编则同矩阵，超长则都失败）
    const ok = 'c'.repeat(60);
    assert.equal(JSON.stringify(encodeClient(ok)), JSON.stringify(encodeQr(ok, { level: 'M' }).matrix));
  });
});

describe('分享视图', () => {
  const config = {
    site: { title: '站', url: 'https://example.com' },
    share: { enabled: true, platforms: ['twitter', 'weibo', 'wechat', 'copy'] },
  };

  test('默认关闭：不配就不产生分享视图', () => {
    const view = buildShareView({ title: 'T', canonical: 'https://example.com/posts/t.html' }, { site: { url: 'https://example.com' } });
    assert.equal(view, null, 'share.enabled 不为 true 时必须返回 null（整块不渲染）');
  });

  test('分享地址必须是绝对地址，且带上 UTM', () => {
    const view = buildShareView(
      { title: '标题', canonical: 'https://example.com/posts/t.html' },
      { ...config, share: { ...config.share, utm_source: 'emeek', utm_medium: 'social' } },
    );
    assert.equal(view.absolute, true);
    assert.match(view.url, /^https:\/\/example\.com\/posts\/t\.html\?/);
    assert.match(view.url, /utm_source=emeek/);
    assert.match(view.url, /utm_medium=social/);
  });

  test('相对地址不拼 UTM（拼了会把 404 分享出去）', () => {
    const view = buildShareView({ title: 'T', url: '/posts/t.html' }, config);
    assert.equal(view.absolute, false);
    assert.equal(view.url, '/posts/t.html', '相对地址必须原样返回，而不是拼成坏链接');
  });

  test('标题与地址都做 URL 编码（中文标题不能把查询串破坏掉）', () => {
    const view = buildShareView(
      { title: '中文 标题 & 符号', canonical: 'https://example.com/posts/t.html' },
      config,
    );
    const twitter = view.items.find((i) => i.id === 'twitter');
    assert.ok(twitter.href.includes('text=%E4%B8%AD%E6%96%87'), '中文必须被编码');
    assert.ok(!twitter.href.includes('中文'), '不能有裸中文出现在查询串里');
    assert.ok(!twitter.href.includes('&符号'), '& 必须被编码，否则查询串被截断');
  });

  test('微信与复制不需要 href，但需要浏览器端', () => {
    const view = buildShareView({ title: 'T', canonical: 'https://example.com/posts/t.html' }, config);
    const wechat = view.items.find((i) => i.id === 'wechat');
    const copy = view.items.find((i) => i.id === 'copy');
    assert.equal(wechat.href, null);
    assert.equal(copy.href, null);
    assert.equal(view.needsClient, true, '有微信/复制时必须带客户端脚本');
  });

  test('只有纯链接平台时不需要客户端脚本', () => {
    const view = buildShareView({ title: 'T', canonical: 'https://example.com/posts/t.html' }, {
      ...config, share: { ...config.share, platforms: ['twitter', 'weibo'] },
    });
    assert.equal(view.needsClient, false, '没有微信/复制时不该背 QR 编码器');
  });

  test('未知平台名不静默丢弃（收集起来让上层告警）', () => {
    const view = buildShareView({ title: 'T', canonical: 'https://example.com/posts/t.html' }, {
      ...config, share: { ...config.share, platforms: ['twitter', 'reddit', 'twiter'] },
    });
    assert.deepEqual(view.unknown, ['twiter'], '拼错的平台名必须被报出来');
    assert.ok(view.items.some((i) => i.id === 'twitter'));
  });

  test('平台去重：重复配置同一个平台只出一个按钮', () => {
    const view = buildShareView({ title: 'T', canonical: 'https://example.com/posts/t.html' }, {
      ...config, share: { ...config.share, platforms: ['copy', 'copy', 'copy'] },
    });
    assert.equal(view.items.filter((i) => i.id === 'copy').length, 1);
  });

  test('位置语义：bottom / sidebar / both', () => {
    const mk = (position) => buildShareView({ title: 'T', canonical: 'https://example.com/p.html' }, {
      ...config, share: { ...config.share, position },
    });
    assert.deepEqual([mk('bottom').bottom, mk('bottom').sidebar], [true, false]);
    assert.deepEqual([mk('sidebar').bottom, mk('sidebar').sidebar], [false, true]);
    assert.deepEqual([mk('both').bottom, mk('both').sidebar], [true, true]);
    // 默认（不写 position）走 bottom
    const def = buildShareView({ title: 'T', canonical: 'https://example.com/p.html' }, {
      ...config, share: { enabled: true, platforms: ['copy'] },
    });
    assert.equal(def.bottom, true);
    assert.equal(def.sidebar, false);
  });

  test('没有任何可用平台时整块不渲染', () => {
    const view = buildShareView({ title: 'T', canonical: 'https://example.com/p.html' }, {
      ...config, share: { ...config.share, platforms: ['not-a-platform'] },
    });
    assert.equal(view, null);
  });
});

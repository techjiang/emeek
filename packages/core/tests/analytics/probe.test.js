import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProbeScript, renderProbeTag, encodeHit, decodeHit, summarizeHits,
  DEFAULT_RETENTION_DAYS, probeEndpoint,
} from '../../src/analytics/probe.js';

describe('PV 探针脚本', () => {
  test('必须给 endpoint，且必须是 http(s)', () => {
    assert.throws(() => buildProbeScript({}), /endpoint/);
    assert.throws(() => buildProbeScript({ endpoint: 'javascript:alert(1)' }), /http\(s\)/);
    assert.throws(() => buildProbeScript({ endpoint: '/api/hit' }), /http\(s\)/);
  });

  test('★ 不读 Cookie、不读 localStorage —— 探针不试图识别「同一个人」', () => {
    const script = buildProbeScript({ endpoint: 'https://c.example.com/hit' });
    assert.ok(!/document\.cookie/.test(script), '不得读取 Cookie');
    assert.ok(!/localStorage/.test(script), '不得使用 localStorage');
    assert.ok(!/sessionStorage/.test(script), '不得使用 sessionStorage');
  });

  test('★ 不发明文 IP、不发明文 UA，也不发 referer / 屏幕尺寸', () => {
    const script = buildProbeScript({ endpoint: 'https://c.example.com/hit' });
    assert.ok(!/referrer/i.test(script), '不得上报 referer');
    assert.ok(!/screen\./.test(script), '不得上报屏幕尺寸');
    assert.ok(!/navigator\.language/.test(script), '不得上报语言');
    // UA 只用于哈希，不得作为字段值直接上报。
    assert.ok(!/u\s*:\s*navigator\.userAgent/.test(script));
    assert.match(script, /navigator\.userAgent\|\|''\)\+'\|'/, 'UA 必须先进哈希函数');
  });

  test('★ 只带 pathname，不带 query —— query 里常有 token 与追踪参数', () => {
    const script = buildProbeScript({ endpoint: 'https://c.example.com/hit' });
    assert.match(script, /location\.pathname/);
    assert.ok(!/location\.search/.test(script), '不得带上 query string');
    assert.ok(!/location\.hash/.test(script));
  });

  test('优先 sendBeacon（unload 时 fetch 会被取消，PV 会少记一半）', () => {
    const script = buildProbeScript({ endpoint: 'https://c.example.com/hit' });
    assert.match(script, /sendBeacon/);
    assert.match(script, /keepalive:true/, 'fetch 兜底必须 keepalive');
  });

  test('不阻塞首屏：跑在 load 之后；且失败静默', () => {
    const script = buildProbeScript({ endpoint: 'https://c.example.com/hit' });
    assert.match(script, /readyState==='complete'/);
    assert.match(script, /addEventListener\('load'/);
    assert.match(script, /catch\(function\(\)\{\}\)/);
  });

  test('体积预算：探针 + 标签 < 900 字节（它是内联进每个页面的）', () => {
    const { tag } = renderProbeTag({ endpoint: 'https://c.example.com/hit' });
    assert.ok(Buffer.byteLength(tag) < 900, `探针 ${Buffer.byteLength(tag)} 字节，超预算`);
  });

  test('retentionDays 进脚本（服务端按它裁剪）', () => {
    const script = buildProbeScript({ endpoint: 'https://c.example.com/hit', retentionDays: 30 });
    assert.match(script, /r:30/);
    // 非法值退化成默认值，而不是把 NaN 发给服务端。
    const fallback = buildProbeScript({ endpoint: 'https://c.example.com/hit', retentionDays: -5 });
    assert.match(fallback, new RegExp(`r:${DEFAULT_RETENTION_DAYS}`));
  });

  test('renderProbeTag 暴露 origin（「发往哪个域」必须可断言）', () => {
    const { tag, origin } = renderProbeTag({ endpoint: 'https://c.example.com/hit' });
    assert.equal(origin, 'https://c.example.com');
    assert.match(tag, /^<script>/);
    assert.match(tag, /<\/script>$/);
  });

  test('probeEndpoint 读的是 builtin.endpoint', () => {
    assert.equal(probeEndpoint({ builtin: { endpoint: 'https://x.test/h' } }), 'https://x.test/h');
    assert.equal(probeEndpoint({}), null);
  });
});

describe('上报体编解码', () => {
  test('encode 出来的字段就是探针发的那几个（p/t/u/r）', () => {
    const raw = encodeHit({ path: '/posts/a.html', time: 1000, visitorKey: 'k', retentionDays: 10 });
    assert.deepEqual(JSON.parse(raw), { p: '/posts/a.html', t: 1000, u: 'k', r: 10 });
  });

  test('decode 的字段名是 visitorKey 而不是 ip/ua —— 名字必须诚实', () => {
    const hit = decodeHit('{"p":"/a","t":5,"u":"x","r":7}');
    assert.deepEqual(hit, { path: '/a', time: 5, visitorKey: 'x', retentionDays: 7 });
    assert.ok(!('ip' in hit), '拿到的本来就不是 IP，字段名不得暗示它是');
    assert.ok(!('ua' in hit));
  });

  test('字段缺失时给安全默认值，不抛', () => {
    const hit = decodeHit('{}');
    assert.equal(hit.path, '/');
    assert.equal(hit.time, 0);
    assert.equal(hit.visitorKey, '');
    assert.equal(hit.retentionDays, DEFAULT_RETENTION_DAYS);
  });
});

describe('PV 汇总与去重', () => {
  const at = (minutes) => minutes * 60 * 1000;

  test('同一 visitor 在同一路径的 30 分钟内重复请求只算一次', () => {
    const { items, total, dropped } = summarizeHits([
      { path: '/a', time: at(0), visitorKey: 'v1' },
      { path: '/a', time: at(5), visitorKey: 'v1' },
      { path: '/a', time: at(29), visitorKey: 'v1' },
    ]);
    assert.equal(total, 1);
    assert.equal(dropped, 2, '被去重的次数要如实报告 —— 不能说「这些人没来过」');
    assert.deepEqual(items, [{ path: '/a', views: 1 }]);
  });

  test('超过窗口后算新的浏览', () => {
    const { total } = summarizeHits([
      { path: '/a', time: at(0), visitorKey: 'v1' },
      { path: '/a', time: at(31), visitorKey: 'v1' },
    ]);
    assert.equal(total, 2);
  });

  test('不同 visitor 或不同路径互不影响', () => {
    const { items } = summarizeHits([
      { path: '/a', time: at(0), visitorKey: 'v1' },
      { path: '/a', time: at(1), visitorKey: 'v2' },
      { path: '/b', time: at(1), visitorKey: 'v1' },
    ]);
    assert.deepEqual(items, [{ path: '/a', views: 2 }, { path: '/b', views: 1 }]);
  });

  test('排序稳定（按 views 降序，同数按路径字典序）', () => {
    const { items } = summarizeHits([
      { path: '/z', time: at(0), visitorKey: 'a' },
      { path: '/a', time: at(0), visitorKey: 'b' },
    ]);
    assert.deepEqual(items.map((i) => i.path), ['/a', '/z']);
  });

  test('接受原始 JSON 字符串（服务端直接喂日志行）', () => {
    const { total } = summarizeHits(['{"p":"/a","t":0,"u":"v","r":90}']);
    assert.equal(total, 1);
  });

  test('空输入不崩', () => {
    assert.deepEqual(summarizeHits([]), { items: [], total: 0, dropped: 0 });
  });
});

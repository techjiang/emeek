import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, validateAndBuildAnalytics } from '../../src/pipeline/index.js';

async function site(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-analytics-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content, 'utf8');
  }
  return dir;
}

const POST = 'posts/a.md';
const POST_BODY = '---\ntitle: 甲\ndate: 2024-01-01\n---\n\n# 甲\n\n正文。';

function cfg(analytics) {
  return `export default {
    site: { title: 'T', url: 'https://t.example.com', author: 'A', language: 'zh-CN' },
    content: { source: 'local', localDirs: ['posts'] },
    analytics: ${JSON.stringify(analytics)},
  };`;
}

/** 抓出产物里所有 <script> 的内容，用于「有没有注入东西」的断言。 */
function scripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
}

const readPage = (dir, rel = 'index.html') => fs.readFile(path.join(dir, 'dist', rel), 'utf8');

describe('★ 零追踪：未开启时产物里不存在任何统计脚本', () => {
  for (const [name, analytics] of [
    ['完全不配 analytics', {}],
    ['显式 enabled: false', { enabled: false }],
    ['enabled: false 但残留了 provider 配置', { enabled: false, provider: 'plausible', plausible: { domain: 'x.test' } }],
  ]) {
    test(`${name} —— 页面上不得出现任何第三方统计域名`, async () => {
      const dir = await site({
        'emeeek.config.js': cfg(analytics),
        [POST]: POST_BODY,
      });
      await build({ cwd: dir });
      const html = await readPage(dir);
      for (const marker of ['plausible.io', 'goatcounter', 'umami', 'data-domain', 'sendBeacon', 'data-website-id']) {
        assert.ok(!html.includes(marker), `未开启分析时不该出现「${marker}」`);
      }
    });
  }

  test('未开启时每个页面的 script 数量与「不配 analytics」时完全一致', async () => {
    const a = await site({ 'emeeek.config.js': cfg({}), [POST]: POST_BODY });
    const b = await site({
      'emeeek.config.js': cfg({ enabled: false, provider: 'goatcounter', goatcounter: { code: 'x' } }),
      [POST]: POST_BODY,
    });
    await build({ cwd: a });
    await build({ cwd: b });
    assert.equal(scripts(await readPage(a)).length, scripts(await readPage(b)).length);
    // 也不该多出任何属性
    assert.equal((await readPage(a)).length, (await readPage(b)).length, '关掉分析必须是零字节差异');
  });

  test('builtin 开启但不开 PV：产物里同样没有任何统计脚本', async () => {
    const dir = await site({
      'emeeek.config.js': cfg({ enabled: true, provider: 'builtin', builtin: { trackPageViews: false } }),
      [POST]: POST_BODY,
    });
    await build({ cwd: dir });
    const html = await readPage(dir);
    assert.ok(!html.includes('sendBeacon'), 'builtin 不开 PV 时不该有探针');
    assert.ok(!html.includes('plausible.io'));
  });
});

describe('注入点与注入内容', () => {
  test('plausible 开启后脚本进 <head>，且域与配置一致', async () => {
    const dir = await site({
      'emeeek.config.js': cfg({
        enabled: true, provider: 'plausible', plausible: { domain: 'blog.example.com' },
      }),
      [POST]: POST_BODY,
    });
    await build({ cwd: dir });
    const html = await readPage(dir);
    assert.match(html, /data-domain="blog\.example\.com"/);
    assert.ok(html.indexOf('plausible.io/js/script.js') < html.indexOf('</head>'), '统计脚本应在 head 里');
  });

  test('goatcounter 开启后 code 进产物', async () => {
    const dir = await site({
      'emeeek.config.js': cfg({ enabled: true, provider: 'goatcounter', goatcounter: { code: 'myblog' } }),
      [POST]: POST_BODY,
    });
    await build({ cwd: dir });
    assert.match(await readPage(dir), /https:\/\/myblog\.goatcounter\.com\/count/);
  });

  test('umami 缺 scriptSrc 时构建失败（不注入半残脚本）', async () => {
    const dir = await site({
      'emeeek.config.js': cfg({ enabled: true, provider: 'umami', umami: { websiteId: 'x' } }),
      [POST]: POST_BODY,
    });
    await assert.rejects(() => build({ cwd: dir }), /分析配置校验失败|必须配置/);
  });

  test('未知 provider 让构建失败（而不是静默不注入）', async () => {
    const dir = await site({
      'emeeek.config.js': cfg({ enabled: true, provider: 'google-analytics' }),
      [POST]: POST_BODY,
    });
    await assert.rejects(() => build({ cwd: dir }), /配置校验失败|不支持|只能是/);
  });

  test('builtin + PV：探针进 footer，且只往用户给的 endpoint 发', async () => {
    const dir = await site({
      'emeeek.config.js': cfg({
        enabled: true,
        provider: 'builtin',
        builtin: { trackPageViews: true, endpoint: 'https://collect.self.hosted/hit', retentionDays: 30 },
      }),
      [POST]: POST_BODY,
    });
    await build({ cwd: dir });
    const html = await readPage(dir);
    assert.match(html, /collect\.self\.hosted\/hit/);
    assert.match(html, /sendBeacon/);
    assert.ok(html.indexOf('collect.self.hosted') > html.indexOf('</main>'), '探针应在 body 末尾，不挡首屏');
  });

  test('自定义脚本：headScript 进 head、footerScript 进末尾，位置分离', async () => {
    const dir = await site({
      'emeeek.config.js': cfg({
        enabled: true, provider: 'custom', custom: { headScript: 'window.HEAD_MARK=1', footerScript: 'window.FOOT_MARK=1' },
      }),
      [POST]: POST_BODY,
    });
    await build({ cwd: dir });
    const html = await readPage(dir);
    assert.ok(html.indexOf('HEAD_MARK') < html.indexOf('</head>'));
    assert.ok(html.indexOf('FOOT_MARK') > html.indexOf('</head>'));
  });

  test('★ 自定义脚本里的 </script> 被打散（否则脚本块提前结束 → XSS）', async () => {
    const dir = await site({
      'emeeek.config.js': cfg({
        enabled: true,
        provider: 'custom',
        // 攻击形状：用户（或复制粘贴来的第三方代码）里带了一个闭合标签，
        // 闭合之后的内容会被浏览器当 HTML 解析。
        custom: { headScript: 'var a="</script><img src=x onerror=alert(1)>";' },
      }),
      [POST]: POST_BODY,
    });
    await build({ cwd: dir });
    const html = await readPage(dir);

    // 断言的是**安全性质**：产物里任何一个 <script> 的 body 里都不能再出现
    // 裸的 `</script`。只要不出现，后面的内容就仍然是脚本字符串、不是 HTML。
    //
    // 刻意不断言「产物里没有 <img」——那句断言过严且是错的：
    // 打散之后 `<img ...>` 会作为**脚本字符串的字面内容**留在页面里，
    // 它不构成标签，因为脚本块没有提前结束。用「有没有那个字符串」
    // 来判 XSS 会把正确的实现判红（我第一版就是这么写错的）。
    for (const script of scripts(html)) {
      assert.ok(!/<\/script/i.test(script.body), 'script body 里不得有裸的 </script');
    }
    assert.ok(html.includes('<\\/script>'), '闭合标签必须被打散成 <\\/script>');
  });

  test('每个页面都拿到分析片段（不是只有首页）', async () => {
    const dir = await site({
      'emeeek.config.js': cfg({ enabled: true, provider: 'plausible', plausible: { domain: 'a.test' } }),
      [POST]: POST_BODY,
    });
    await build({ cwd: dir });
    for (const page of ['index.html', 'archive.html', 'tags.html', 'about.html', '404.html', 'posts/a.html']) {
      assert.match(await readPage(dir, page), /data-domain="a\.test"/, `${page} 少了分析脚本`);
    }
  });
});

describe('validateAndBuildAnalytics（可单独调用）', () => {
  test('未开启 → 两个空串 + provider null', () => {
    assert.deepEqual(validateAndBuildAnalytics({}), { head: '', footer: '', provider: null, origin: null });
    assert.deepEqual(validateAndBuildAnalytics({ analytics: { enabled: false } }), { head: '', footer: '', provider: null, origin: null });
  });

  test('builtin 开启 → provider 是 builtin，但没有任何脚本', () => {
    const out = validateAndBuildAnalytics({ analytics: { enabled: true, provider: 'builtin' } });
    assert.equal(out.provider, 'builtin');
    assert.equal(out.head, '');
    assert.equal(out.footer, '');
  });

  test('builtin + PV 但缺 endpoint → 抛错（而不是发到一个 undefined）', () => {
    assert.throws(
      () => validateAndBuildAnalytics({ analytics: { enabled: true, provider: 'builtin', builtin: { trackPageViews: true } } }),
      /endpoint/,
    );
  });

  test('plausible → origin 是可断言的域', () => {
    const out = validateAndBuildAnalytics({
      analytics: { enabled: true, provider: 'plausible', plausible: { domain: 'a.test' } },
    });
    assert.equal(out.origin, 'plausible.io');
  });
});

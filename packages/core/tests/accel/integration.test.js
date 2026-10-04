import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { accelerate, applyAcceleration } from '../../src/accel/index.js';
import { build as coreBuild } from '../../src/pipeline/index.js';
import { cacheHeaders } from '../../src/accel/cache-headers.js';

async function tmpProject(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-accel-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

const POST = `---
title: 加速测试
date: 2024-05-01
tags: [性能]
---

# 加速测试

正文内容，用于验证构建与加速管线。
`;

describe('加速管线集成', () => {
  test('构建产物包含指纹资源、预压缩产物与加速清单', async () => {
    const cwd = await tmpProject({
      'emeeek.config.js': "export default { site: { title: 'T', url: 'https://t.test' } };\n",
      'posts/a.md': POST,
    });
    const stats = await coreBuild({ cwd });
    assert.ok(stats.manifest.acceleration, '缺少 acceleration 清单');
    assert.ok(stats.manifest.acceleration.precompressed > 0, '没有预压缩产物');

    const files = await fs.readdir(stats.outDir);
    assert.ok(files.includes('acceleration.json'));
    assert.ok(files.some((f) => f.endsWith('.gz')));
    assert.ok(files.some((f) => f.endsWith('.br')));

    const manifest = JSON.parse(await fs.readFile(path.join(stats.outDir, 'acceleration.json'), 'utf8'));
    assert.ok(manifest.headers.length > 0, '缺少缓存头清单');
  });

  test('内容不变时二次构建逐文件一致 —— 幂等（含 rss/sitemap）', async () => {
    const cwd = await tmpProject({
      'emeeek.config.js': "export default { site: { title: 'T', url: 'https://t.test' } };\n",
      'posts/a.md': POST,
    });
    const first = await coreBuild({ cwd });
    const filesA = { ...first.manifest.acceleration.tree.files };
    const second = await coreBuild({ cwd });
    const filesB = { ...second.manifest.acceleration.tree.files };

    // 逐文件比对：只比总摘要的话，两个文件互换变化会互相抵消。
    for (const key of new Set([...Object.keys(filesA), ...Object.keys(filesB)])) {
      assert.equal(filesB[key], filesA[key], `${key} 在二次构建中变了 —— 产物不可复现`);
    }
    assert.equal(second.manifest.acceleration.tree.digest, first.manifest.acceleration.tree.digest);

    // rss.xml 的 lastBuildDate 若取当前时间，就会永远不同 → 幂等推送失效。
    assert.ok('rss.xml' in filesA, 'rss.xml 应在产物里');
  });

  test('内容变化时只有变化文件的哈希改变（指纹是内容敏感的）', async () => {
    const cwd = await tmpProject({
      'emeeek.config.js': "export default { site: { title: 'T', url: 'https://t.test' } };\n",
      'posts/a.md': POST,
    });
    const first = await coreBuild({ cwd });
    await fs.writeFile(path.join(cwd, 'posts', 'a.md'), POST.replace('正文内容', '改动过的正文'));
    const second = await coreBuild({ cwd });
    const a = first.manifest.acceleration.tree.files;
    const b = second.manifest.acceleration.tree.files;
    assert.notEqual(a['index.html'], b['index.html'], 'index.html 内容变了哈希应改变');
    // 静态资源（favicon）没变，哈希不该变
    const faviconKey = Object.keys(a).find((k) => k.includes('favicon'));
    if (faviconKey) assert.equal(a[faviconKey], b[faviconKey]);
  });

  test('★ 负向验证：CDN API Key 不出现在任何产物里', async () => {
    const SECRET = 'cf-super-secret-token-DO-NOT-LEAK';
    const cwd = await tmpProject({
      'emeeek.config.js': `export default {
        site: { title: 'T', url: 'https://t.test' },
        cdn: { enabled: true, provider: 'cloudflare', zone: 't.test', zoneId: 'z1' },
      };\n`,
      'posts/a.md': POST,
    });
    // 模拟真实环境：secret 只通过环境变量进入进程。
    const previous = process.env.CF_API_KEY;
    process.env.CF_API_KEY = SECRET;
    try {
      const stats = await coreBuild({ cwd });
      const entries = await walk(stats.outDir);
      for (const file of entries) {
        const content = await fs.readFile(file, 'utf8').catch(() => '');
        assert.ok(!content.includes(SECRET), `产物 ${path.relative(stats.outDir, file)} 泄露了 API Key`);
      }
      const config = await fs.readFile(path.join(cwd, 'emeeek.config.js'), 'utf8');
      assert.ok(!config.includes(SECRET), '配置文件泄露了 API Key');
    } finally {
      if (previous === undefined) delete process.env.CF_API_KEY;
      else process.env.CF_API_KEY = previous;
    }
  });

  test('★ 负向验证：把 secret 写进配置会被构建拦住', async () => {
    const cwd = await tmpProject({
      'emeeek.config.js': `export default {
        site: { title: 'T', url: 'https://t.test' },
        cdn: { enabled: true, provider: 'cloudflare', zoneId: 'z1', apiKey: 'leaked-in-config' },
      };\n`,
      'posts/a.md': POST,
    });
    await assert.rejects(() => coreBuild({ cwd }), /不能写进配置文件/);
  });

  test('★ 负向验证：customHead 里的 Google Fonts 会被扫描出来并记入加速清单', async () => {
    // 真实场景：站主从某个模板复制来的 head 片段带 Google Fonts 链接。
    // 这不是内容注入，是站主自己的配置 —— 但它在国内会让首屏卡死。
    const cwd = await tmpProject({
      'emeeek.config.js': `export default {
        site: { title: 'T', url: 'https://t.test' },
        theme: { customHead: '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet" />' },
      };\n`,
      'posts/a.md': POST,
    });
    const stats = await coreBuild({ cwd });
    const manifest = JSON.parse(await fs.readFile(path.join(stats.outDir, 'acceleration.json'), 'utf8'));
    assert.ok(manifest.blockedHosts.some((b) => b.host === 'fonts.googleapis.com'), '应识别出 Google Fonts');
    assert.ok(manifest.blockedHosts[0].suggestion, '应给出替代建议');
  });

  test('customCSS / customHead 真的进了产物（此前是「配了不生效」的死配置）', async () => {
    const cwd = await tmpProject({
      'emeeek.config.js': `export default {
        site: { title: 'T', url: 'https://t.test' },
        theme: { customCSS: 'body{color:red}', customHead: '<meta name="x" content="y" />' },
      };\n`,
      'posts/a.md': POST,
    });
    const stats = await coreBuild({ cwd });
    const html = await fs.readFile(path.join(stats.outDir, 'index.html'), 'utf8');
    assert.match(html, /body\{color:red\}/);
    assert.match(html, /name="x"/);
  });

  test('有外链资源时 preload 真的写进 HTML 的 </head> 前', async () => {
    const outDir = await tmpProject({});
    const css = 'body{color:red}'.repeat(200);
    const result = {
      enabled: true,
      fingerprint: { map: [], assets: [], rewrittenHtml: 0 },
      fingerprinted: [{ path: '/assets/theme.a1b2c3d4.css', originalPath: '/assets/theme.css', fingerprint: 'a1b2c3d4', content: css }],
      rewrittenHtml: new Map([['/index.html', '<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>']]),
      compression: { variants: [], summary: null },
      headerManifest: [],
      preload: [{ path: '/assets/theme.a1b2c3d4.css', as: 'style' }],
      preloadTags: '<link rel="preload" href="/assets/theme.a1b2c3d4.css" as="style" />',
      earlyHints: '</assets/theme.a1b2c3d4.css>; rel=preload; as=style',
      serverConfigs: null,
      fonts: null,
    };
    await applyAcceleration(outDir, result);
    const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.match(html, /<link rel="preload" href="\/assets\/theme\.a1b2c3d4\.css" as="style" \/>/);
    assert.ok(html.indexOf('rel="preload"') < html.indexOf('</head>'), 'preload 应在 </head> 之前');
  });

  test('accelerate 关闭时完全跳过（返回 enabled:false）', async () => {
    const result = await accelerate({ files: [], html: [], config: { cdn: { enabled: false } } });
    assert.equal(result.enabled, false);
  });

  test('applyAcceleration 生成 server 配置与 acceleration.json', async () => {
    const outDir = await tmpProject({});
    const result = {
      enabled: true,
      fingerprint: { map: [], assets: [], rewrittenHtml: 0 },
      fingerprinted: [],
      rewrittenHtml: new Map(),
      compression: { variants: [], summary: null },
      headerManifest: [],
      preload: [],
      earlyHints: '',
      serverConfigs: { nginx: '# nginx', caddy: '# caddy' },
      fonts: null,
    };
    await applyAcceleration(outDir, result);
    const files = await fs.readdir(outDir);
    assert.ok(files.includes('acceleration.json'));
    assert.ok(files.includes('server'));
  });
});

describe('缓存头与指纹的配合', () => {
  test('指纹资源 → immutable；未指纹 → 短缓存（这是长缓存的前提）', () => {
    assert.match(cacheHeaders('/a.abc12345.css', { fingerprinted: true })['Cache-Control'], /immutable/);
    assert.doesNotMatch(cacheHeaders('/a.css')['Cache-Control'], /immutable/);
  });
});

async function walk(dir, acc = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

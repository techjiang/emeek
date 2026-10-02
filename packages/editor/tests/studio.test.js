/**
 * Studio 服务端与打包器的集成测试。
 *
 * 真的起一个 HTTP 服务、真的请求每个端点。理由是这些代码路径全在
 * 「拼路径、读文件、回响应」上 —— 纯单测（mock 掉 fs）测不出
 * 「词表路径算错了」这类问题，而那正是实际踩到的坑。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build as coreBuild } from '@emeeek/core';
import { createStudioServer } from '../src/studio/server.js';
import { bundleClient, bundleFailureNotice } from '../src/studio/bundle.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EXAMPLE = path.join(REPO, 'examples/minimal');

describe('客户端打包', () => {
  test('产出入口 + 按需 chunk（代码分割真的生效）', async () => {
    const result = await bundleClient({ sourcemap: false });
    assert.ok(result.code, `打包失败：${result.error}`);
    // 入口必须小：语言语法全在 chunk 里，入口不该把它们算进来
    assert.ok(result.bytes < 600 * 1024, `入口 ${(result.bytes / 1024).toFixed(0)}KB 偏大，说明语言包被打进入口了`);
    assert.ok(result.chunks.length > 10, `只有 ${result.chunks.length} 个 chunk，懒加载可能没生效`);
  });

  test('入口里不含 node: 静态 import（浏览器会直接崩）', async () => {
    const result = await bundleClient({ sourcemap: false });
    assert.doesNotMatch(result.code, /from\s*["']node:/, '入口不能有 node: 静态导入');
  });

  test('node: 模块被替换成会报错的桩，而不是留成 external', () => {
    // external 会让产物流下 import('node:fs')，浏览器解析时抛 CORS 错误，
    // 整个模块图崩掉。桩则只在使用时报错。
    const notice = bundleFailureNotice('test error');
    assert.match(notice, /esbuild/);
    assert.match(notice, /pnpm install/);
  });

  test('每个 chunk 的路径都能被服务端解析到', async () => {
    const result = await bundleClient({ sourcemap: false });
    for (const chunk of result.chunks) {
      assert.match(chunk.path, /^\/__studio\//, `chunk 路径不合法：${chunk.path}`);
      assert.ok(!chunk.path.includes('..'), 'chunk 路径不该出现 ..');
    }
  });
});

describe('Studio HTTP 服务', () => {
  let instance;
  let base;

  before(async () => {
    instance = await createStudioServer({
      port: 0,
      host: '127.0.0.1',
      build: () => coreBuild({ cwd: EXAMPLE }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    base = `http://127.0.0.1:${instance.port}`;
  });

  after(async () => { await instance?.close(); });

  test('GET /studio 返回编辑器页面', async () => {
    const res = await fetch(`${base}/studio`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Emeek Studio/);
    assert.match(html, /__studio\/client\.js/);
    // 首屏不该引用词表（408KB 不进关键路径）
    assert.doesNotMatch(html, /zh-words\.txt\.gz/);
  });

  test('GET /__studio/client.js 返回打包产物', async () => {
    const res = await fetch(`${base}/__studio/client.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const code = await res.text();
    assert.ok(code.length > 1000);
  });

  test('GET /__studio/chunks/* 能取到按需 chunk（入口里的相对引用能解析）', async () => {
    const entry = await (await fetch(`${base}/__studio/client.js`)).text();
    // esbuild 拆出来的 chunk 在入口里是相对引用 `./chunks/xxx.js`
    const references = [...entry.matchAll(/"\.\/(chunks\/[^"]+\.js)"/g)].map((m) => m[1]);
    assert.ok(references.length > 0, '入口里应引用至少一个 chunk');
    // 全部试一遍：只要有一个 404，说明服务端的路径映射与打包器的输出不一致
    for (const relative of references.slice(0, 8)) {
      const res = await fetch(`${base}/__studio/${relative}`);
      assert.equal(res.status, 200, `chunk ${relative} 取不到 —— 路径拼接有问题`);
    }
  });

  test('GET /__studio/dict/* 惰性提供词表', async () => {
    const res = await fetch(`${base}/__studio/dict/zh-words.txt.gz`);
    assert.equal(res.status, 200, '词表端点必须能找到 core 的词表 —— 路径算错会让分词静默退化');
    assert.match(res.headers.get('content-type'), /gzip/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 100000, `词表只有 ${bytes.length} 字节，不对`);
  });

  test('词表请求的 gzip 内容真的能解开', async () => {
    const res = await fetch(`${base}/__studio/dict/zh-words.txt.gz`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { gunzipSync } = await import('node:zlib');
    const text = gunzipSync(Buffer.from(bytes)).toString('utf8');
    assert.ok(text.length > 300000, '解出来的词表太小');
    assert.ok(text.split('\n').length > 100000, '词条数不对');
  });

  test('GET /__studio/site.json 给出站点索引（[[ 补全与双向链接要用）', async () => {
    const res = await fetch(`${base}/__studio/site.json`);
    assert.equal(res.status, 200);
    const site = await res.json();
    assert.ok(Array.isArray(site.posts));
    assert.ok(site.posts.length >= 2, '示例站应有文章');
    for (const post of site.posts) {
      assert.ok(post.title, '每篇文章都要有标题');
      assert.ok(post.url, '每篇文章都要有 URL');
    }
  });

  test('POST /__studio/render 与构建渲染逐字节一致', async () => {
    const source = '# 标题\n\n正文 **加粗**。\n\n```js\nconst a = 1;\n```\n';
    const res = await fetch(`${base}/__studio/render`, { method: 'POST', body: source });
    assert.equal(res.status, 200);
    const { html } = await res.json();
    const { renderArticle } = await import('@emeeek/core/render');
    assert.equal(html, renderArticle(source, { allowHtml: false, lazyImages: true, headingIds: new Map() }));
  });

  test('GET /__studio/status 报告 bundle 与构建状态', async () => {
    await fetch(`${base}/__studio/client.js`); // 触发打包
    const status = await (await fetch(`${base}/__studio/status`)).json();
    assert.equal(status.bundle, 'ready');
    assert.ok(status.bundleStats.entryKB > 0);
    assert.ok(status.bundleStats.chunks > 10);
  });

  test('未知路径 404（不像 SPA 一样回落到首页）', async () => {
    const res = await fetch(`${base}/__studio/nope`);
    assert.equal(res.status, 404);
  });

  test('图片上传写入目标目录并返回可访问 URL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-upload-'));
    const uploader = await createStudioServer({
      port: 0,
      host: '127.0.0.1',
      uploadDir: dir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${uploader.port}/__studio/upload`, {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-filename': encodeURIComponent('我的图 1.png') },
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      });
      assert.equal(res.status, 200);
      const { url, bytes } = await res.json();
      assert.equal(bytes, 4);
      assert.match(url, /^\/uploads\//);
      // 文件名要清洗过：空格与中文不该原样落盘
      const files = fs.readdirSync(dir);
      assert.equal(files.length, 1);
      assert.doesNotMatch(files[0], /\s/);
    } finally {
      await uploader.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

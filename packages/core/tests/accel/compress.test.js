import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { shouldCompress, compressVariants, precompress } from '../../src/accel/compress.js';

describe('预压缩', () => {
  test('文本类型可压缩，已压缩格式跳过', () => {
    const big = 'a'.repeat(5000);
    assert.equal(shouldCompress('/index.html', big), true);
    assert.equal(shouldCompress('/a.css', big), true);
    assert.equal(shouldCompress('/a.svg', big), true);
    assert.equal(shouldCompress('/a.png', big), false);
    assert.equal(shouldCompress('/a.woff2', big), false);
    assert.equal(shouldCompress('/a.zip', big), false);
  });

  test('小于阈值跳过（收益抵不过一个额外往返）', () => {
    assert.equal(shouldCompress('/a.css', 'x'), false);
    assert.equal(shouldCompress('/a.css', 'x'.repeat(2048)), true);
  });

  test('gzip 与 brotli 变体都是合法压缩流且可解回原文', async () => {
    const input = '<html>'.repeat(500);
    const r = await compressVariants(input);
    assert.equal(zlib.gunzipSync(r.gzip).toString('utf8'), input);
    assert.equal(zlib.brotliDecompressSync(r.brotli).toString('utf8'), input);
  });

  test('brotli 通常比 gzip 更小', async () => {
    const input = 'const x = 1;'.repeat(2000);
    const r = await compressVariants(input);
    assert.ok(r.brotliSize <= r.gzipSize, `brotli ${r.brotliSize} 应 <= gzip ${r.gzipSize}`);
  });

  test('precompress 汇总压缩率', async () => {
    const files = [
      { path: '/index.html', content: '<p>hello</p>'.repeat(1000) },
      { path: '/a.png', content: Buffer.alloc(5000, 1) },
    ];
    const { variants, summary } = await precompress(files);
    assert.equal(variants.length, 1);
    assert.equal(summary.skipped, 1);
    assert.ok(summary.gzipRatio < 1);
    assert.ok(summary.brotliRatio < 1);
  });

  test('压完更大时退化不发压缩产物（小文件偶尔如此）', async () => {
    // 随机二进制在文本扩展名下压缩必然膨胀。
    const random = Buffer.from(Array.from({ length: 1200 }, () => Math.floor(Math.random() * 256)));
    const { variants } = await precompress([{ path: '/a.txt', content: random }]);
    if (variants.length) {
      assert.ok(variants[0].gzipSize < random.length || variants[0].brotliSize < random.length);
    }
  });
});

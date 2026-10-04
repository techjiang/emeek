import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const ENTRY = path.join(SRC, 'search/browser.js');

/**
 * 「零 node: 依赖」是靠静态扫描依赖闭包守的，而不是靠「现在恰好没写」。
 * 有人以后在 search/ 里加一句 node:fs，浏览器打包会炸，而 Node 单测
 * 全绿 —— 那是这个项目吃过亏的失败模式（假绿）。
 */
function closure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    for (const match of source.matchAll(/^(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      const base = path.resolve(dir, spec);
      for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { stack.push(candidate); break; }
      }
    }
  }
  return [...seen];
}

describe('搜索层边界（零 node: 依赖）', () => {
  test('浏览器入口的依赖闭包里没有顶层 node: import', () => {
    const files = closure(ENTRY);
    assert.ok(files.length >= 5, `闭包过小（${files.length}），扫描逻辑可能失效`);
    const violators = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
        if (match[1].startsWith('node:')) violators.push(`${path.relative(SRC, file)} → ${match[1]}`);
      }
    }
    assert.deepEqual(violators, [], `浏览器打包会炸：\n${violators.join('\n')}`);
  });

  test('构建期接缝（node:zlib）不在浏览器入口的闭包里', () => {
    const files = closure(ENTRY).map((f) => path.relative(SRC, f));
    assert.ok(!files.includes('search/site-index.js'), 'site-index 被拖进了浏览器闭包');
    assert.ok(!files.includes('search/build.js'), 'build 入口被拖进了浏览器闭包');
  });

  test('browser.js 不导出构建期函数', async () => {
    const mod = await import('../../src/search/browser.js');
    assert.equal(mod.buildSearchIndexFile, undefined, 'browser 入口泄漏了构建期函数');
  });

  test('build.js 才导出构建期函数', async () => {
    const mod = await import('../../src/search/build.js');
    assert.equal(typeof mod.buildSearchIndexFile, 'function');
  });
});

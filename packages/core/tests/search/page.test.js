import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSearchClient } from '../../src/search/ui/index.js';
import { renderLayout } from '../../src/pipeline/render/theme.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');

const THEMES = ['aurora', 'inkstone', 'minimal', 'magazine'];

describe('搜索页布局（4 套主题）', () => {
  for (const theme of THEMES) {
    const layout = path.join(ROOT, 'packages', `theme-${theme}`, 'layouts', 'search.html');
    const meta = path.join(ROOT, 'packages', `theme-${theme}`, 'theme.json');

    test(`${theme} 提供 layouts/search.html`, () => {
      assert.ok(fs.existsSync(layout), `缺 ${path.relative(ROOT, layout)}`);
    });

    test(`${theme} 在 theme.json 里声明了 search 布局`, () => {
      const json = JSON.parse(fs.readFileSync(meta, 'utf8'));
      assert.ok(json.layouts.includes('search'), `${theme}.layouts 缺 search`);
    });

    test(`${theme} 搜索页有必需的元素 id 与无 JS 兜底`, () => {
      const html = fs.readFileSync(layout, 'utf8');
      for (const id of ['search-form', 'search-input', 'search-suggest', 'search-results',
        'filter-category', 'filter-tag', 'filter-from', 'filter-to', 'filter-sort',
        'search-history', 'search-count']) {
        assert.ok(html.includes(`id="${id}"`), `${theme} 缺 #${id}`);
      }
      // 无 JS 兜底：form 必须能独立工作（method=get + action 指向搜索页）
      assert.match(html, /<form[^>]*id="search-form"[^>]*method="get"/s, `${theme} form 缺 method=get`);
      assert.match(html, /<form[^>]*action="[^"]*search/, `${theme} form action 未指向搜索页`);
    });

    test(`${theme} 内联脚本用三花括号（否则 & 被转义，脚本语法错误）`, () => {
      const html = fs.readFileSync(layout, 'utf8');
      assert.ok(html.includes('{{{ searchScript }}}'), `${theme} searchScript 未用三花括号`);
      assert.ok(!html.includes('<script>{{ searchScript }}</script>'), `${theme} 仍在用转义输出`);
    });
  }

  test('4 套主题的搜索页 HTML 结构各不相同（不是复制粘贴的同一份）', () => {
    const bodies = THEMES.map((t) => fs.readFileSync(path.join(ROOT, 'packages', `theme-${t}`, 'layouts', 'search.html'), 'utf8'));
    const unique = new Set(bodies);
    assert.equal(unique.size, THEMES.length, `有主题共用同一份搜索页 HTML（去重后 ${unique.size} 份）`);
  });
});

describe('搜索页 CSS（4 套主题）', () => {
  for (const theme of THEMES) {
    test(`${theme} 有独立的 styles/search.css`, () => {
      const css = path.join(ROOT, 'packages', `theme-${theme}`, 'styles', 'search.css');
      assert.ok(fs.existsSync(css), `缺 styles/search.css`);
      const content = fs.readFileSync(css, 'utf8');
      // 配色必须走变量，否则暗色模式与主题配置改色都跟不动
      assert.ok(content.includes('var(--accent)'), `${theme} 搜索 CSS 未使用 --accent`);
      assert.ok(content.includes('.search-input'), `${theme} 搜索 CSS 缺 .search-input`);
      assert.ok(content.includes('.search-result mark'), `${theme} 搜索 CSS 缺高亮规则`);
    });
  }

  test('搜索 CSS 里没有残留的旧 .search-panel（那是 header 内联面板的死代码）', () => {
    for (const theme of THEMES) {
      for (const file of ['styles/search.css', 'styles/main.css']) {
        const p = path.join(ROOT, 'packages', `theme-${theme}`, file);
        if (!fs.existsSync(p)) continue;
        assert.ok(!fs.readFileSync(p, 'utf8').includes('.search-panel'), `${theme}/${file} 还有 .search-panel`);
      }
    }
  });
});

describe('header 搜索入口', () => {
  for (const theme of THEMES) {
    test(`${theme} 的 header 用链接指向搜索页，而不是内联面板`, () => {
      const header = fs.readFileSync(path.join(ROOT, 'packages', `theme-${theme}`, 'partials', 'header.html'), 'utf8');
      assert.ok(header.includes('search-link'), `${theme} header 缺 search-link`);
      assert.ok(header.includes('href="{{ searchPageUrl }}"'), `${theme} search-link 未指向 searchPageUrl`);
      // 内联面板必须移除：两套搜索实现必然分叉
      assert.ok(!header.includes('search-panel'), `${theme} header 仍有 search-panel`);
      assert.ok(!header.includes('id="search-input"'), `${theme} header 仍占用 search-input 这个 id`);
    });

    test(`${theme} 的 main.js 不再包含第二套搜索实现`, () => {
      const js = fs.readFileSync(path.join(ROOT, 'packages', `theme-${theme}`, 'scripts', 'main.js'), 'utf8');
      assert.ok(!js.includes('searchToggle'), `${theme} main.js 仍有 searchToggle`);
      assert.ok(!js.includes('runSearch'), `${theme} main.js 仍有 runSearch`);
    });
  }
});

describe('可内联的搜索客户端', () => {
  test('拼接产物是合法脚本且不含 ESM 语法', async () => {
    const js = await loadSearchClient();
    assert.ok(!/^export\b/m.test(js), '拼接产物里还留着 export');
    assert.ok(!/^import\b/m.test(js), '拼接产物里还留着 import');
    assert.ok(js.includes('function runQuery'), '拼接产物缺 runQuery（占位符没替换？）');
    // 语法合法性：能构造 Function 就能被浏览器解析
    assert.doesNotThrow(() => new Function(js));
  });

  test('拼接产物不含 node: 依赖', async () => {
    const js = await loadSearchClient();
    assert.ok(!/require\(['"]node:/.test(js));
    assert.ok(!/from\s+['"]node:/.test(js));
  });
});

describe('renderLayout 的 strict 模式（内置布局缺失必须报错）', () => {
  // 这条是真防线：非 strict 时找不到布局会回退到 index，
  // 于是「主题缺 search.html」会静默变成「搜索页其实是首页」——
  // 构建成功、页面也长得像模像样，只是没有搜索框。
  const fakeTheme = (layouts) => ({
    meta: { name: 'fake' },
    entry: 'index',
    layouts: new Map(Object.entries(layouts).map(([name, source]) => [name, {
      source,
      compiled: () => `<rendered:${name}>`,
    }])),
  });

  test('strict 找不到布局 → 抛错', () => {
    const theme = fakeTheme({ index: 'x' });
    assert.throws(() => renderLayout(theme, 'search', {}, { strict: true }), /找不到布局 search/);
  });

  test('非 strict 找不到布局 → 回退到 entry（既有行为不变）', () => {
    const theme = fakeTheme({ index: 'x' });
    assert.equal(renderLayout(theme, 'search', {}), '<rendered:index>');
  });

  test('strict 下布局存在则正常渲染', () => {
    const theme = fakeTheme({ index: 'x', search: 'y' });
    assert.equal(renderLayout(theme, 'search', {}, { strict: true }), '<rendered:search>');
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from '../../src/pipeline/index.js';

/**
 * 端到端集成：构建一个小站，检查主题注入真的落进了 HTML。
 * 这里验的是「接线对不对」——各部分的单测已经验过逻辑本身。
 */
async function makeSite(configBody, posts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-theme-int-'));
  await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'emeeek.config.js'), configBody, 'utf8');
  for (const [name, content] of Object.entries(posts)) {
    await fs.writeFile(path.join(dir, 'posts', name), content, 'utf8');
  }
  await fs.writeFile(path.join(dir, 'posts', 'hello.md'), '---\ntitle: 你好\ndate: 2024-01-01\n---\n\n# 你好\n\n正文。\n', 'utf8');
  return dir;
}

const read = (dir, file) => fs.readFile(path.join(dir, 'dist', file), 'utf8');

test('customCSS 被注入 <style> 且在主题 CSS 之后', async () => {
  const dir = await makeSite(`
    export default {
      site: { title: 'T', url: 'https://x.dev' },
      theme: { name: 'minimal', customCSS: '.custom-marker{color:red}' },
    };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    assert.match(html, /\.custom-marker\{color:red\}/);
    // 主题 CSS 里有 `.site-header`，自定义 CSS 必须排在它后面（覆盖关系）
    assert.ok(html.indexOf('.custom-marker') > html.indexOf('.site-header'), '自定义 CSS 应在主题 CSS 之后');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('customHead 注入 head，customFooter 注入 footer，位置分离', async () => {
  const dir = await makeSite(`
    export default {
      site: { title: 'T', url: 'https://x.dev' },
      theme: { name: 'minimal', customHead: '<meta name="injected" content="1">', customFooter: '<span id="footer-injected">f</span>' },
    };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    const headEnd = html.indexOf('</head>');
    assert.ok(html.indexOf('name="injected"') < headEnd, 'customHead 应在 </head> 之前');
    assert.ok(html.indexOf('footer-injected') > headEnd, 'customFooter 应在 </head> 之后');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('customCSS 里的 </style> 逃逸在构建产物里被中和', async () => {
  const dir = await makeSite(`
    export default {
      site: { title: 'T', url: 'https://x.dev' },
      theme: { name: 'minimal', customCSS: 'body{}</style><script>window.__x=1</script>' },
    };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    assert.ok(!/<\/style>\s*<script>window\.__x/i.test(html), '不应出现可执行的逃逸序列');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('customHead 里的 <script> 被剥掉（主题配置不得注入脚本）', async () => {
  const dir = await makeSite(`
    export default {
      site: { title: 'T', url: 'https://x.dev' },
      theme: { name: 'minimal', customHead: '<script src="evil.js"></script><meta name="ok" content="1">' },
    };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    assert.ok(!/evil\.js/.test(html), '注入的脚本不应出现');
    assert.match(html, /name="ok"/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('用户覆盖主色写进变量块', async () => {
  const dir = await makeSite(`
    export default {
      site: { title: 'T', url: 'https://x.dev' },
      theme: { name: 'minimal', colors: { primary: '#ff00aa' } },
    };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    assert.match(html, /--primary:\s*#ff00aa/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('首帧脚本出现在 head 且早于主题样式', async () => {
  const dir = await makeSite(`
    export default { site: { title: 'T', url: 'https://x.dev' }, theme: { name: 'minimal' } };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    const scriptAt = html.indexOf('prefers-color-scheme: dark');
    const styleAt = html.indexOf('<style>');
    assert.ok(scriptAt > -1, '应有首帧脚本');
    assert.ok(scriptAt < styleAt, '首帧脚本必须早于样式，否则会闪');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('darkMode=dark 时首帧脚本强制 dark', async () => {
  const dir = await makeSite(`
    export default { site: { title: 'T', url: 'https://x.dev' }, theme: { name: 'minimal', darkMode: 'dark' } };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    assert.match(html, /var m="dark"/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('aurora 主题能从任意 cwd 解析（内置主题）', async () => {
  const dir = await makeSite(`
    export default { site: { title: 'T', url: 'https://x.dev' }, theme: { name: 'aurora' } };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    assert.match(html, /极光渐变/, 'aurora 的 CSS 应被内联');
    assert.match(html, /--aurora-blue/, 'aurora 变量应存在');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('finalizeHtml 不改动 <style> 内的空白（否则会悄悄改样式）', async () => {
  const dir = await makeSite(`
    export default {
      site: { title: 'T', url: 'https://x.dev' },
      theme: { name: 'minimal', customCSS: '.a{margin: 0  1rem; content: "x  y";}' },
    };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    // 双空格必须原样保留 —— 折叠它会改掉 content 字符串与某些 CSS 值
    assert.match(html, /margin: 0  1rem;/);
    assert.match(html, /content: "x  y";/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('finalizeHtml 仍压缩 <style> 之外的空白（没有因保护样式而放弃压缩）', async () => {
  const dir = await makeSite(`
    export default { site: { title: 'T', url: 'https://x.dev' }, theme: { name: 'minimal' } };`);
  try {
    await build({ cwd: dir });
    const raw = await read(dir, 'index.html');
    // 标签之间的缩进应被折叠
    assert.ok(!/>\s{2,}</.test(raw), 'HTML 结构空白应被压缩');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('站点 assets/ 拷进产物的 /assets（封面图不该 404）', async () => {
  const dir = await makeSite(`
    export default {
      site: { title: 'T', url: 'https://x.dev' },
      theme: { name: 'minimal' },
    };`);
  try {
    await fs.mkdir(path.join(dir, 'assets', 'covers'), { recursive: true });
    await fs.writeFile(path.join(dir, 'assets', 'covers', 'a.svg'), '<svg/>', 'utf8');
    await fs.writeFile(path.join(dir, 'posts', 'hello.md'),
      '---\ntitle: 你好\ndate: 2024-01-01\ncover: /assets/covers/a.svg\n---\n\n正文。\n', 'utf8');
    await build({ cwd: dir });
    // front-matter 里的 cover 是绝对路径，产物必须真的存在，否则浏览器 404
    const copied = await fs.readFile(path.join(dir, 'dist', 'assets', 'covers', 'a.svg'), 'utf8');
    assert.equal(copied, '<svg/>');
    // 主题自己的资源不能被站点内容挤掉
    await fs.access(path.join(dir, 'dist', 'assets', 'favicon.svg'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('CSS 超阈值时改用外链，且 /assets/theme.css 真的写出来', async () => {
  // inlineCriticalCss 在 24KB 以上返回 <link>。这条路径曾经是死路：
  // HTML 指着 /assets/theme.css，却没有任何地方写这个文件。
  // magazine 的 CSS 有 30KB，正好压在这条路径上。
  const dir = await makeSite(`
    export default {
      site: { title: 'T', url: 'https://x.dev' },
      theme: { name: 'magazine' },
    };`);
  try {
    await build({ cwd: dir });
    const html = await read(dir, 'index.html');
    assert.match(html, /<link rel="stylesheet" href="\/assets\/theme\.css"/, '超阈值应改外链');
    const css = await fs.readFile(path.join(dir, 'dist', 'assets', 'theme.css'), 'utf8');
    assert.ok(css.length > 24 * 1024, `theme.css 应包含完整样式（实际 ${css.length} 字节）`);
    assert.match(css, /\.section-number/, '外链里要有主题的特色样式');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

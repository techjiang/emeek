import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCommentsClient } from '../../src/comments/ui.js';
import { normalizeComments } from '../../src/comments/index.js';

test('产出的脚本是传统脚本（无 ESM 语法），否则内联会直接报错', async () => {
  const js = await loadCommentsClient();
  assert.doesNotMatch(js, /^\s*export\s/m, '内联脚本里不能有 export');
  assert.doesNotMatch(js, /^\s*import\s/m, '内联脚本里不能有 import');
});

test('四个必需函数都被抽出来了（抽不到时会抛，不产出残缺脚本）', async () => {
  const js = await loadCommentsClient();
  for (const name of ['normalizeComments', 'normalizeBody', 'normalizeReactions', 'escapeHtml']) {
    assert.match(js, new RegExp(`function ${name}\\(`), `缺少 ${name}`);
  }
});

test('浏览器端的 normalize 与构建期的产出一致（同一份逻辑，不是两份实现）', async () => {
  const js = await loadCommentsClient();
  const prelude = js.slice(0, js.indexOf('window.__EMEEEK_COMMENTS__'));
  const browserNormalize = new Function(`${prelude}\nreturn normalizeComments;`)();

  const raw = [
    { id: 1, user: { login: 'octocat', html_url: 'https://github.com/octocat' }, body: 'Nice! @someone <script>x</script>', created_at: '2024-01-01T00:00:00Z', html_url: 'u', reactions: { '+1': 2 } },
    { id: 2, pull_request: {}, body: 'PR' },
    { id: 3, state: 'deleted', body: 'gone' },
  ];
  const server = normalizeComments(raw, { limit: 50, reactions: true });
  const client = browserNormalize(raw, 50, true);
  // 剥掉函数与闭包差异，只比数据结构。两条链路产出不同 = 测试里的样子
  // 与读者看到的不一样，而这种差异只能靠肉眼发现。
  assert.deepEqual(JSON.parse(JSON.stringify(client)), JSON.parse(JSON.stringify(server)));
});

test('抽出的 bundle 里不含构建期才有的东西（config / 转义属性工具）', async () => {
  const js = await loadCommentsClient();
  // resolveCommentTarget 依赖 config，renderCommentsShell 依赖 escapeAttr ——
  // 搬进浏览器会报错。`extract` 按函数名精确抽取就是为了避开它们。
  assert.doesNotMatch(js, /resolveCommentTarget/);
  assert.doesNotMatch(js, /renderCommentsShell/);
});

test('客户端脚本自带失败分类（不同原因给不同提示，不是一句「加载失败」）', async () => {
  const js = await loadCommentsClient();
  assert.match(js, /not-found/, 'Issue 被删/编号错 要与网络失败区分开');
  assert.match(js, /rate-limit/, '限流要与网络失败区分开');
  // 分类**必须传到 DOM**上。只在 throw 里带 kind 是不够的 ——
  // catch 里写死 'error' 会让四种失败在页面上长得一模一样，
  // 那么分类就白做了。这个疏漏被真浏览器 e2e 抓到过。
  assert.match(js, /var kind = \(error && error\.kind\)/, 'catch 里必须用 error.kind，不能写死');
  assert.match(js, /setStatus\([^)]*kind\)/, 'kind 必须传给 setStatus');
});

test('客户端只用 innerHTML 插已 normalize 的正文', async () => {
  const js = await loadCommentsClient();
  // 只看**代码行**（注释里出现这个词是说明，不是用法）。
  const codeLines = js.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
  });
  const assignments = codeLines.filter((line) => /innerHTML\s*=/.test(line));
  // 只允许一处赋值：插正文。多出来的任何一处，一旦接了未 normalize
  // 的内容就是 XSS —— 而评论正文是任意人写的。
  assert.equal(assignments.length, 1, `innerHTML 赋值出现 ${assignments.length} 次：\n${assignments.join('\n')}`);
  assert.match(assignments[0], /body\.innerHTML = item\.body/);
});

test('客户端有 sessionStorage 短缓存（GitHub 匿名限流只有 60 次/小时）', async () => {
  const js = await loadCommentsClient();
  assert.match(js, /sessionStorage/);
  assert.match(js, /60000/);
});

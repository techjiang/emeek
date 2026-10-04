import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCommentTarget, normalizeComments, normalizeBody, renderCommentsShell, COMMENT_PROVIDERS,
} from '../../src/comments/index.js';

// ── resolveCommentTarget ────────────────────────────────────────
test('provider=none 时不渲染评论区', () => {
  const config = { comments: { provider: 'none' }, content: { repo: 'a/b' } };
  assert.equal(resolveCommentTarget({ config, post: { issueNumber: 1 } }), null);
});

test('默认（没配 comments）时不渲染评论区', () => {
  assert.equal(resolveCommentTarget({ config: {}, post: { issueNumber: 1 } }), null);
});

test('没有 issue 编号时返回 null —— 不猜、不按标题搜', () => {
  const config = { comments: { provider: 'github-issues', repo: 'a/b' } };
  // 曾经诱人的做法是「按标题搜一下仓库里有没有同名 Issue」。
  // 那会把两条不同的评论线程栓到同一篇文章上（标题改过之后），
  // 而且错误一旦发生就没法往回查。
  assert.equal(resolveCommentTarget({ config, post: {} }), null);
  assert.equal(resolveCommentTarget({ config, post: { title: 'x' } }), null);
  assert.equal(resolveCommentTarget({ config, post: null }), null);
});

test('repo 非法时返回 null（不产出指向不存在仓库的链接）', () => {
  const config = { comments: { provider: 'github-issues', repo: 'not-a-repo' } };
  assert.equal(resolveCommentTarget({ config, post: { issueNumber: 1 } }), null);
});

test('repo 可以回落到 content.repo（github-issues 源不需要重复配置）', () => {
  const config = { comments: { provider: 'github-issues' }, content: { repo: 'a/b' } };
  const target = resolveCommentTarget({ config, post: { issueNumber: 7 } });
  assert.equal(target.repo, 'a/b');
  assert.equal(target.issueNumber, 7);
  assert.equal(target.discussionUrl, 'https://github.com/a/b/issues/7');
});

test('COMMENT_PROVIDERS 是封闭集合', () => {
  assert.deepEqual(COMMENT_PROVIDERS, ['github-issues', 'none']);
});

// ── normalizeComments ───────────────────────────────────────────
test('过滤拉取请求（Issues API 会把 PR 混进来）', () => {
  const out = normalizeComments([{ id: 1, user: { login: 'a' }, body: 'c', pull_request: {} }]);
  assert.equal(out.length, 0);
});

test('过滤已删除的评论', () => {
  const out = normalizeComments([{ id: 1, user: { login: 'a' }, body: 'c', state: 'deleted' }]);
  assert.equal(out.length, 0);
});

test('作者标记按 author_association 判定，不按用户名猜', () => {
  const out = normalizeComments([
    { id: 1, user: { login: 'x' }, body: 'b', author_association: 'OWNER' },
    { id: 2, user: { login: 'y' }, body: 'b', author_association: 'NONE' },
  ]);
  assert.equal(out[0].isAuthor, true);
  assert.equal(out[1].isAuthor, false);
});

test('limit 生效（评论多的文章不让页面多几百 KB）', () => {
  const raw = Array.from({ length: 100 }, (_, i) => ({ id: i, user: { login: 'a' }, body: 'b' }));
  assert.equal(normalizeComments(raw, { limit: 10 }).length, 10);
});

test('非数组输入返回空数组而不是抛错（接口返回异常数据时页面不该崩）', () => {
  assert.deepEqual(normalizeComments(null), []);
  assert.deepEqual(normalizeComments({ message: 'Not Found' }), []);
  assert.deepEqual(normalizeComments('nope'), []);
});

test('缺字段时给兜底值而不是 undefined（视图里不该出现 undefined）', () => {
  const out = normalizeComments([{ id: 1 }]);
  assert.equal(out[0].author, 'ghost');
  // 空正文给空串而不是 `<p></p>` —— 后者会渲染出一个有 margin 的空段落，
  // 看起来像「这条评论加载失败了」。
  assert.equal(out[0].body, '');
  assert.ok(out[0].authorUrl.startsWith('https://github.com/'));
  // repo 未知时不拼一个看起来可点、点进去 404 的链接。
  assert.equal(out[0].url, '');
});

test('reactions 归一化：只留计数 > 0 的', () => {
  const out = normalizeComments([{ id: 1, user: { login: 'a' }, body: 'b', reactions: { '+1': 2, '-1': 0, heart: 1 } }], { reactions: true });
  assert.equal(out[0].reactions.length, 2);
  assert.deepEqual(out[0].reactions.map((r) => r.count).sort(), [1, 2]);
  // 全零时返回 null，而不是空数组 —— 空数组会让视图渲染一个空的 reaction 条。
  const none = normalizeComments([{ id: 1, user: { login: 'a' }, body: 'b', reactions: { '+1': 0 } }], { reactions: true });
  assert.equal(none[0].reactions, null);
});

test('reactions 关闭时字段为 null', () => {
  const out = normalizeComments([{ id: 1, user: { login: 'a' }, body: 'b', reactions: { '+1': 5 } }], { reactions: false });
  assert.equal(out[0].reactions, null);
});

// ── normalizeBody（安全边界） ───────────────────────────────────
test('HTML 被转义成字面量，不执行', () => {
  const html = normalizeBody('<script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('img onerror 这类属性也进不了 DOM', () => {
  const html = normalizeBody('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('@提及变成指向 GitHub 主页的链接', () => {
  const html = normalizeBody('谢谢 @octocat');
  assert.match(html, /href="https:\/\/github\.com\/octocat"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test('邮箱里的 @ 不被当成提及', () => {
  const html = normalizeBody('mail me a@b.com');
  assert.doesNotMatch(html, /github\.com\/b\.com/);
});

test('URL 变成链接，且只放行 http(s)', () => {
  const html = normalizeBody('see https://example.com/x');
  assert.match(html, /href="https:\/\/example\.com\/x"/);
  // javascript: 不是 http(s)，不会被链上
  const bad = normalizeBody('javascript:alert(1)');
  assert.doesNotMatch(bad, /href="javascript:/);
});

test('换行变成 <br>，空行分段', () => {
  const html = normalizeBody('a\nb\n\nc');
  assert.match(html, /a<br \/>b/);
  assert.equal((html.match(/<p>/g) ?? []).length, 2);
});

test('转义发生在识别之前（先识别后转义会被注入）', () => {
  // 这条是顺序断言：如果先做 @/URL 识别再转义，下面这个会被注入。
  const html = normalizeBody('<a href="https://x.com/">@evil</a>');
  assert.doesNotMatch(html, /<a href="https:\/\/x\.com\/">/);
});

// ── renderCommentsShell ─────────────────────────────────────────
test('外壳带齐浏览器端需要的全部数据属性', () => {
  const target = { provider: 'github-issues', repo: 'a/b', issueNumber: 3, limit: 50, reactions: true, discussionUrl: 'https://github.com/a/b/issues/3' };
  const html = renderCommentsShell(target);
  for (const attr of ['data-comments-provider', 'data-comments-repo', 'data-comments-issue', 'data-comments-limit', 'data-comments-reactions', 'data-comments-strings']) {
    assert.match(html, new RegExp(attr), `缺少 ${attr}`);
  }
});

test('外壳在无 JS 时也有可读内容与 GitHub 链接', () => {
  const target = { provider: 'github-issues', repo: 'a/b', issueNumber: 3, limit: 50, reactions: true, discussionUrl: 'https://github.com/a/b/issues/3' };
  const html = renderCommentsShell(target);
  assert.match(html, /正在加载评论/);
  assert.match(html, /href="https:\/\/github\.com\/a\/b\/issues\/3"/);
  assert.match(html, /GitHub 账号/);
});

test('target 为 null 时产出空串（调用方据此完全跳过渲染）', () => {
  assert.equal(renderCommentsShell(null), '');
});

test('repo / issue 里的特殊字符被转义（属性注入）', () => {
  const html = renderCommentsShell({ provider: 'github-issues', repo: 'a/b" onload="alert(1)', issueNumber: 1, limit: 10, reactions: true, discussionUrl: '#' });
  assert.doesNotMatch(html, /onload="alert/);
});

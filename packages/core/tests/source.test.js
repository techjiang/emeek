import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGithubIssues, parseNextLink } from '../src/pipeline/source/github-issues.js';
import { normalizeDate, slugifySlug, loadLocalPosts } from '../src/pipeline/source/local-files.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CONFIG = {
  content: {
    repo: 'me/blog',
    labels: { publish: 'publish', draft: 'draft', pin: 'pin' },
  },
};

/** 造一个只认固定 JSON 的 fetch 替身，避免测试依赖网络。 */
function stubFetch(issues, { status = 200, headers = {} } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (status !== 200) {
      return { ok: false, status, statusText: 'Error', text: async () => 'boom' };
    }
    return {
      ok: true,
      status,
      headers: { get: (name) => (name.toLowerCase() === 'link' ? headers.link ?? null : null) },
      json: async () => (typeof issues === 'function' ? issues(url) : issues),
    };
  };
  impl.calls = calls;
  return impl;
}

const issue = (overrides = {}) => ({
  number: 1,
  title: '文章标题',
  body: '正文内容',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
  labels: [{ name: 'publish' }],
  user: { login: 'me' },
  html_url: 'https://github.com/me/blog/issues/1',
  ...overrides,
});

test('只读取带 publish 标签的 Issue', async () => {
  const fetchImpl = stubFetch([
    issue({ number: 1, labels: [{ name: 'publish' }] }),
    issue({ number: 2, labels: [{ name: 'other' }] }),
  ]);
  const posts = await loadGithubIssues(CONFIG, { fetchImpl });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].issueNumber, 1);
  assert.equal(posts[0].source, 'github-issues');
});

test('带 draft 标签的 Issue 优先排除', async () => {
  const fetchImpl = stubFetch([issue({ labels: [{ name: 'publish' }, { name: 'draft' }] })]);
  assert.deepEqual(await loadGithubIssues(CONFIG, { fetchImpl }), []);
});

test('跳过 Pull Request 条目', async () => {
  const fetchImpl = stubFetch([issue({ pull_request: { url: 'x' } })]);
  assert.deepEqual(await loadGithubIssues(CONFIG, { fetchImpl }), []);
});

test('Issue 标题与正文首部 front-matter 可覆盖字段', async () => {
  const fetchImpl = stubFetch([issue({
    title: 'Issue 原始标题',
    body: '---\ntitle: 覆盖后的标题\ntags: [自定义]\ndate: 2023-05-05\n---\n正文',
  })]);
  const [post] = await loadGithubIssues(CONFIG, { fetchImpl });
  assert.equal(post.title, '覆盖后的标题');
  assert.ok(post.tags.includes('自定义'));
  assert.equal(post.date.slice(0, 10), '2023-05-05');
  assert.equal(post.raw, '正文');
});

test('标签合并：front-matter 标签 + Issue 标签，去掉元标签', async () => {
  const fetchImpl = stubFetch([issue({ labels: [{ name: 'publish' }, { name: 'tech' }], body: '---\ntags: [自定义]\n---\n' })]);
  const [post] = await loadGithubIssues(CONFIG, { fetchImpl });
  assert.deepEqual(post.tags.sort(), ['tech', '自定义']);
});

test('pin 标签映射为置顶', async () => {
  const fetchImpl = stubFetch([issue({ labels: [{ name: 'publish' }, { name: 'pin' }] })]);
  const [post] = await loadGithubIssues(CONFIG, { fetchImpl });
  assert.equal(post.pinned, true);
});

test('分页：跟随 Link 头直到最后一页', async () => {
  const pages = { 1: [issue({ number: 1 })], 2: [issue({ number: 2 })] };
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    const page = call;
    return {
      ok: true,
      headers: { get: () => (page === 1 ? '<https://api.github.com/page2>; rel="next"' : null) },
      json: async () => pages[page] ?? [],
    };
  };
  const posts = await loadGithubIssues(CONFIG, { fetchImpl });
  assert.equal(posts.length, 2);
});

test('API 失败时抛出带状态码的错误', async () => {
  const fetchImpl = stubFetch([], { status: 404 });
  await assert.rejects(() => loadGithubIssues(CONFIG, { fetchImpl }), /404/);
});

test('缺少 content.repo 时抛出可读错误', async () => {
  await assert.rejects(() => loadGithubIssues({ content: {} }), /content\.repo/);
});

test('parseNextLink 只认 rel="next"', () => {
  assert.equal(parseNextLink('<https://a/2>; rel="next"'), 'https://a/2');
  assert.equal(parseNextLink('<https://a/1>; rel="prev", <https://a/3>; rel="next"'), 'https://a/3');
  assert.equal(parseNextLink('<https://a/1>; rel="last"'), null);
  assert.equal(parseNextLink(null), null);
});

test('normalizeDate 支持纯日期与完整时间', () => {
  assert.equal(normalizeDate('2024-01-01'), '2024-01-01T00:00:00.000Z');
  assert.equal(normalizeDate('2024-01-01T12:00:00Z'), '2024-01-01T12:00:00.000Z');
  assert.equal(normalizeDate('不是日期'), null);
  assert.equal(normalizeDate(undefined), null);
});

test('slugifySlug 处理中文与符号', () => {
  assert.equal(slugifySlug('Hello World!'), 'hello-world');
  assert.equal(slugifySlug('中文 标题'), '中文-标题');
  assert.equal(slugifySlug('!!!'), 'untitled');
});

test('本地内容源跳过不存在的目录而不是报错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-src-'));
  try {
    const posts = await loadLocalPosts(dir, { content: { localDirs: ['nope'] } });
    assert.deepEqual(posts, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('本地内容源递归读取子目录，并从文件名推日期', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-src-'));
  try {
    await fs.mkdir(path.join(dir, 'posts', 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts', 'sub', '2024-03-04-nested.md'), '---\ntitle: 嵌套\n---\n正文', 'utf8');
    const posts = await loadLocalPosts(dir, { content: { localDirs: ['posts'] } });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].title, '嵌套');
    assert.equal(posts[0].date.slice(0, 10), '2024-03-04');
    assert.equal(posts[0].slug, 'nested');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('文件名没有日期时回退到文件修改时间', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-src-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts', 'plain.md'), '# 从一级标题取标题\n\n正文', 'utf8');
    const [post] = await loadLocalPosts(dir, { content: { localDirs: ['posts'] } });
    assert.equal(post.title, '从一级标题取标题');
    assert.ok(!Number.isNaN(new Date(post.date).getTime()));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

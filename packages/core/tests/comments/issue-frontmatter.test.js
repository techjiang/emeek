import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadLocalPosts } from '../../src/pipeline/source/local-files.js';

async function site(frontmatter) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-issue-'));
  await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'posts', '2024-01-01-a.md'),
    `---\ntitle: 标题\n${frontmatter}\n---\n\n正文。\n`, 'utf8');
  const posts = await loadLocalPosts(dir, { content: { localDirs: ['posts'] } });
  return posts[0];
}

test('issue: 42 → issueNumber 42', async () => {
  assert.equal((await site('issue: 42')).issueNumber, 42);
});

test('没有 issue 字段 → null（评论区完全不渲染）', async () => {
  assert.equal((await site('tags: [a]')).issueNumber, null);
});

test('issue 可以是字符串数字（YAML 里不加引号也是字符串的场合）', async () => {
  assert.equal((await site('issue: "17"')).issueNumber, 17);
});

test('非法值给 null，而不是 0 或 NaN', async () => {
  // 给 0 会让评论区去请求 issue/0；给 NaN 会拼出 issue/NaN 的 URL。
  // 两者都是「看起来配了、实际永远加载不出来」，比不配更难排查。
  for (const bad of ['issue: abc', 'issue: "#42"', 'issue: 0', 'issue: -1', 'issue: 1.5']) {
    assert.equal((await site(bad)).issueNumber, null, `${bad} 应当给 null`);
  }
});

test('非法值不报错（它是可选字段，不该让整站构建失败）', async () => {
  await assert.doesNotReject(() => site('issue: abc'));
});

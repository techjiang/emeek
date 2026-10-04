import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../parse/frontmatter.js';

/**
 * 本地 Markdown 内容源。
 * 读取顺序：front-matter > 文件名（日期前缀）> 文件系统 stat。
 * 任何一项都缺失时给出可用的兜底值，而不是让构建失败。
 */
export async function loadLocalPosts(cwd, config) {
  const dirs = config.content.localDirs ?? ['posts'];
  const posts = [];

  for (const dir of dirs) {
    const abs = path.resolve(cwd, dir);
    let entries;
    try {
      entries = await fs.readdir(abs, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`读取内容目录失败 ${abs}：${error.message}`);
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(?:md|markdown)$/i.test(entry.name)) continue;
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      posts.push(await readPost(file, cwd, dir));
    }
  }
  return posts;
}

async function readPost(file, cwd, sourceDir) {
  const raw = await fs.readFile(file, 'utf8');
  const { data, content } = parseFrontmatter(raw);
  const stat = await fs.stat(file);

  // 文件名形如 2024-01-01-hello-world.md，日期段作为兜底日期。
  const base = path.basename(file, path.extname(file));
  const dateMatch = /^(\d{4}-\d{2}-\d{2})[-_]/.exec(base);
  const slugFromName = base.replace(/^\d{4}-\d{2}-\d{2}[-_]/, '');

  const title = data.title || deriveTitle(content) || slugFromName;
  const date = normalizeDate(data.date) ?? (dateMatch ? `${dateMatch[1]}T00:00:00.000Z` : stat.mtime.toISOString());

  return {
    // id 前缀区分来源，避免本地文件与 Issue 编号撞号。
    id: `local:${path.relative(cwd, file)}`,
    slug: data.slug || slugifySlug(slugFromName || title),
    title,
    date,
    updated: normalizeDate(data.updated) ?? date,
    author: data.author ?? null,
    lang: data.lang ?? null,
    tags: toArray(data.tags ?? data.tag),
    categories: toArray(data.categories ?? data.category),
    description: data.description ?? data.summary ?? null,
    draft: data.draft === true || data.publish === false,
    pinned: data.pin === true || data.pinned === true,
    cover: data.cover ?? data.image ?? null,
    /**
     * `issue: 42` —— 把本地文章挂到某个 GitHub Issue 的讨论上。
     *
     * 为什么需要它：评论存在 Issue 的评论区里（见 comments/index.js），
     * 而 `local` 源的文章天然没有 Issue 编号。没有这个字段的话，
     * 「本地写文章 + 用 GitHub 放评论」这个组合做不到 ——
     * 而那恰恰是「不想把草稿放 GitHub、但想要评论区」的人最需要的东西。
     *
     * 只接受正整数。写成 `issue: abc` 时不报错也不生效 ——
     * 报错会让「顺手把 issue 字段写错」变成整站构建失败，
     * 而它只是一个可选字段。但也不静默当成 0（那会去请求 issue/0）。
     */
    issueNumber: normalizeIssueNumber(data.issue),
    raw: content,
    file: path.relative(cwd, file),
    sourceDir,
    source: 'local',
  };
}

/**
 * `issue` front-matter → 正整数，或 null。
 *
 * 刻意不接受字符串数字以外的形式（`#42`、`issue-42` 都不行）——
 * 宽松解析在这里没有收益：写错的人会得到一个「评论区不出现」的结果，
 * 而不是「评论区指向了别的 Issue」。后者才是真正危险的。
 */
function normalizeIssueNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : (/^\d+$/.test(String(value).trim()) ? Number(value) : NaN);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function deriveTitle(content) {
  const m = /^#\s+(.+)$/m.exec(content ?? '');
  return m ? m[1].trim() : null;
}

export function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [String(value).trim()];
}

export function slugifySlug(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'untitled';
}

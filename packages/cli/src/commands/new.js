import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, logger } from '@emeeek/core';

/**
 * 新建文章。Phase 1 只生成本地 Markdown 文件；
 * 走 GitHub Issues 的内容源会提示改用 Issue 创建（写 API 属于 Phase 2 的编辑器职责）。
 */
export async function newPost({ positionals, cwd, flags }) {
  const title = positionals.join(' ').trim();
  if (!title) {
    throw new Error('用法：emeeek new "文章标题"');
  }

  const root = path.resolve(cwd);
  const { config } = await loadConfig(root);
  const dir = config.content.localDirs?.[0] ?? 'posts';
  const slug = slugify(title);
  const date = new Date().toISOString().slice(0, 10);
  const file = path.resolve(root, dir, `${date}-${slug}.md`);

  if (await exists(file)) throw new Error(`文件已存在：${path.relative(root, file)}`);

  const tags = flags.tags ? String(flags.tags).split(',').map((t) => t.trim()) : [];
  const frontmatter = [
    '---',
    `title: ${title}`,
    `date: ${date}`,
    tags.length ? `tags: [${tags.join(', ')}]` : 'tags: []',
    'description: ',
    'draft: true',
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, frontmatter, 'utf8');

  logger.success(`已创建 ${path.relative(root, file)}`);
  logger.dim('  默认 draft: true，写完把 draft 改成 false 才会出现在站点上。');
  if (config.content.source === 'github-issues') {
    logger.warn('当前内容源是 github-issues，本地文件不会进入站点。请改用 GitHub Issue 发布。');
  }
  return file;
}

function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'untitled';
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

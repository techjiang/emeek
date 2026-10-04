import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 部署前质量门禁。
 *
 * 部署是「发出去就收不回」的动作，所以推送之前必须确认 dist/ 里
 * 该有的东西都在、不该有的东西没漏。这里刻意只做「产物级」检查：
 * 构建期已经拦掉的（配置错误、XSS）不重复，只补部署特有的失败模式。
 */

const REQUIRED = [
  { file: 'index.html', label: '首页' },
  { file: '404.html', label: '404 页（GitHub Pages 等要求叫这个名字）' },
  { file: 'sitemap.xml', label: 'sitemap（SEO 收录依赖）' },
  { file: 'rss.xml', label: 'RSS（订阅者依赖）' },
  { file: 'robots.txt', label: 'robots.txt' },
];

const OPTIONAL = [
  { file: 'search-index.json', label: '搜索索引' },
];

/**
 * @returns {{ ok: boolean, checks: Array<{name, ok, detail, hint}> }}
 */
export async function preflight(distDir, { config = {}, requireSearch = true } = {}) {
  const checks = [];
  const add = (name, ok, detail, hint = null) => { checks.push({ name, ok, detail, hint }); return ok; };

  let stat = null;
  try {
    stat = await fs.stat(distDir);
  } catch {
    add('产物目录', false, `不存在：${distDir}`, '先运行 emeeek build，或用 emeeek deploy（默认会自动构建）');
    return { ok: false, checks };
  }
  add('产物目录', stat.isDirectory(), distDir, stat.isDirectory() ? null : 'dist 不是目录');

  for (const item of REQUIRED) {
    const abs = path.join(distDir, item.file);
    const exists = await isFile(abs);
    add(item.label, exists, exists ? item.file : `缺少 ${item.file}`, exists ? null : '重新构建；若开关被关掉，请打开 seo.sitemap / feed.enabled');
  }

  for (const item of OPTIONAL) {
    const abs = path.join(distDir, item.file);
    const enabled = config.search?.enabled !== false;
    const exists = await isFile(abs);
    if (!enabled && !requireSearch) continue;
    if (!enabled) { add(item.label, true, '已按配置关闭'); continue; }
    add(item.label, exists, exists ? item.file : `缺少 ${item.file}`, exists ? null : 'search.enabled 为 true 时应生成 search-index.json');
  }

  // 站点地址没改过 = sitemap / canonical 全是 example.com。
  // 这在本地看不出来，是部署后才暴露的典型问题，必须在推之前拦。
  const url = config.site?.url ?? '';
  const isPlaceholder = !url || url.includes('example.com');
  add('站点地址已配置', !isPlaceholder, url || '（空）', isPlaceholder ? '把 site.url 改成真实域名，否则 sitemap/canonical/OG 全指向 example.com' : null);

  // 空站点：产物存在但一篇文章都没有 —— 发布出去是个白板。
  const hasPost = await hasAnyHtmlUnder(path.join(distDir, 'posts'));
  add('至少有一篇文章', hasPost, hasPost ? 'posts/ 下存在页面' : 'posts/ 为空', hasPost ? null : '先写一篇：emeeek new "标题"');

  return { ok: checks.every((c) => c.ok), checks };
}

async function isFile(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch { return false; }
}

async function hasAnyHtmlUnder(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && await hasAnyHtmlUnder(path.join(dir, entry.name))) return true;
      if (entry.isFile() && entry.name.endsWith('.html')) return true;
    }
    return false;
  } catch { return false; }
}

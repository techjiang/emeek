import { loadLocalPosts } from './local-files.js';
import { loadGithubIssues } from './github-issues.js';
import { logger } from '../../util/logger.js';

/**
 * 内容源分派。
 *
 * hybrid 模式下 GitHub 不可用（无 token、限流、仓库名错）时，只告警并继续用本地内容 ——
 * 远程内容源是增强，不是构建的前提。纯 github-issues 模式则必须显式失败，
 * 因为那时「构建成功但站点是空的」比报错更糟。
 */
export async function loadPosts(cwd, config, options = {}) {
  const source = config.content.source;
  const posts = [];

  if (source === 'local' || source === 'hybrid') {
    posts.push(...await loadLocalPosts(cwd, config));
  }
  if (source === 'github-issues' || source === 'hybrid') {
    try {
      posts.push(...await loadGithubIssues(config, options));
    } catch (error) {
      if (source === 'github-issues') throw error;
      logger.warn(`读取 GitHub Issues 失败，仅使用本地内容：${error.message}`);
    }
  }

  // Issues 优先于同名本地文件：GitHub 才是与协作者共享的版本源。
  const seen = new Map();
  for (const post of posts) {
    if (!seen.has(post.slug) || seen.get(post.slug).source === 'local') seen.set(post.slug, post);
  }
  return [...seen.values()];
}

export { loadLocalPosts, loadGithubIssues };

import { normalizeDate, slugifySlug } from './local-files.js';
import { parseFrontmatter } from '../parse/frontmatter.js';

const API = 'https://api.github.com';

/**
 * GitHub Issues 内容源 —— Emeek 继承自 Gmeek 的第一根支柱。
 *
 * 只有带 publish 标签的 Issue 会进入站点；draft 标签强制排除（即使同时带了 publish）。
 * 正文开头允许写 front-matter，用来覆盖 Issue 元数据（标题、日期、标签等）。
 */
export async function loadGithubIssues(config, { fetchImpl = globalThis.fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const repo = config.content.repo;
  if (!repo) throw new Error('content.repo 未配置，无法读取 GitHub Issues');
  const labels = config.content.labels ?? {};
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'Emeek',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  const issues = await fetchAllPages(`${API}/repos/${repo}/issues?state=all&per_page=100&sort=updated&direction=desc`, headers, fetchImpl);
  const posts = [];

  for (const issue of issues) {
    if (issue.pull_request) continue;
    const labelNames = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    if (labels.draft && labelNames.includes(labels.draft)) continue;
    if (labels.publish && !labelNames.includes(labels.publish)) continue;

    const { data, content } = parseFrontmatter(issue.body ?? '');
    const date = normalizeDate(data.date) ?? normalizeDate(issue.created_at);
    const title = data.title || issue.title;
    posts.push({
      id: `issue:${issue.number}`,
      issueNumber: issue.number,
      slug: data.slug || slugifySlug(`issue-${issue.number}-${title}`),
      title,
      date,
      updated: normalizeDate(data.updated) ?? normalizeDate(issue.updated_at),
      author: data.author ?? issue.user?.login ?? null,
      lang: data.lang ?? null,
      tags: mergeTags(data.tags, labelNames.filter((l) => ![labels.publish, labels.draft, labels.pin].includes(l))),
      categories: mergeTags(data.categories, []),
      description: data.description ?? data.summary ?? null,
      draft: false,
      pinned: data.pin === true || (labels.pin && labelNames.includes(labels.pin)),
      cover: data.cover ?? data.image ?? null,
      raw: content,
      url: issue.html_url,
      source: 'github-issues',
    });
  }
  return posts;
}

async function fetchAllPages(url, headers, fetchImpl) {
  const all = [];
  let next = url;
  let guard = 0;
  while (next) {
    if (++guard > 20) throw new Error('Issues 分页超过 20 页，疑似异常响应');
    const response = await fetchImpl(next, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub API 请求失败 ${response.status} ${response.statusText}${body ? `：${body.slice(0, 200)}` : ''}`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('GitHub API 返回了预期之外的数据结构');
    all.push(...page);
    next = parseNextLink(response.headers.get('link'));
  }
  return all;
}

export function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

function mergeTags(a, b) {
  return [...new Set([...(toArray(a)), ...(toArray(b))])];
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

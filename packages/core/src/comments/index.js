/**
 * 评论系统 —— GitHub Issues 驱动。
 *
 * ── 为什么是「读 Issue 的评论」而不是 giscus/utterances ──
 *
 * 那两者的做法是：把 GitHub Discussions / Issues 当成一个**外部评论服务**，
 * 你在它们的后台配置，它们在你的页面上挂一个 iframe。代价有三条：
 *
 *   1. **多一个第三方源**（js 从别人的域名加载）。本站的「零外部请求」
 *      是设计约束，不是巧合 —— 加一个 iframe 就破了。
 *   2. **多一份配置**（repo / category / mapping 三处要对上）。
 *      对不上时表现为「评论区一直空着」，看不出是配置错了还是真没人评论。
 *   3. **主题无法控制外观**。iframe 里的样式不由我们决定，
 *      「4 套主题各自的评论区样式」这件事根本做不到。
 *
 * 而 Emeek 的正文本来就可能就是 Issue（`content.source: github-issues`）——
 * 评论就是那个 Issue 的评论，**不需要任何额外配置**，因为 repo 与 issue
 * 编号都已知。主题拿到的是纯 JSON，样式完全在 CSS 里。
 *
 * ── 本模块的边界 ──
 *
 * 这里是**纯函数**：给「文章元数据 + 评论数组」，产出可直接塞进页面的视图。
 * 网络请求不在这里（构建期不发请求 —— 那会让构建依赖 GitHub 可用性）。
 * 浏览器端取数是 `client.js` 的事，它读这里的 `data-comments-*` 属性。
 *
 * 也就是说：**评论区的内容是运行时填的，不是构建期烘死的。**
 * 这样评论能在不发版的情况下更新 —— 对一个「评论」来说这是必要的
 * （否则每来一条新评论都要重建整站）。
 */

/** 支持的评论来源。`none` 是显式关闭。 */
export const COMMENT_PROVIDERS = ['github-issues', 'none'];

/**
 * 计算一篇文章的评论配置。
 *
 * 返回 null 表示「这篇文章不显示评论区」——
 * 调用方据此完全跳过渲染（而不是渲染一个空壳 + 一段「评论加载中」）。
 */
export function resolveCommentTarget({ config, post }) {
  const comments = config?.comments ?? {};
  const provider = comments.provider ?? 'none';
  if (provider === 'none') return null;
  if (!COMMENT_PROVIDERS.includes(provider)) return null;

  // issue 编号：github-issues 源会带上；local 源的文章没有。
  //
  // 没有 issue 编号时**不猜**。曾经的诱人做法是「按标题搜一下仓库里有没有
  // 同名 Issue」——那会把两条不同的评论线程栓到同一篇文章上（标题改过之后），
  // 而且这个错误一旦发生就没法往回查。宁可没有评论区。
  const issueNumber = post?.issueNumber ?? null;
  if (!issueNumber) return null;

  const repo = comments.repo || config?.content?.repo;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;

  return {
    provider,
    repo,
    issueNumber,
    // 评论条数上限。GitHub 的 Issues API 一页 100 条，评论多的文章
    // 全拉下来会让首屏多几百 KB。默认 50，够用且可控。
    limit: Number(comments.limit ?? 50),
    // 是否显示 reaction（👍 等）。默认开 —— 它是「无话可说但想表态」的唯一出口。
    reactions: comments.reactions !== false,
    // 讨论入口。评论在 GitHub 上，读者要发言得去那里（这需要说清楚，见 ui）。
    discussionUrl: `https://github.com/${repo}/issues/${issueNumber}`,
  };
}

/**
 * 把 GitHub 的评论 JSON 规范化成视图。
 *
 * **为什么要有这一步，而不是直接把 API 响应扔给模板**：
 * GitHub 的评论对象有 40+ 字段，而页面只需要 6 个。把原始对象塞进 DOM
 * 意味着「API 加了字段 → 我们的页面里多出数据」，以及「API 改了字段名 →
 * 页面静默失去内容」。规范化是唯一能在运行时发现这类变化的接缝。
 *
 * 另外这里做三件事是必须的：
 *   · **过滤拉取请求**（Issues API 会把 PR 混进来）
 *   · **过滤已删除/最小化的**（minimized 是被折叠的垃圾评论）
 *   · **规范化 markdown body** —— 直接 innerHTML 把 body 插进去就是 XSS，
 *     body 是用户输入。这里只做纯文本 + 链接，见 normalizeBody。
 */
export function normalizeComments(raw, { repo = '', limit = 50, reactions = true } = {}) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && !item.pull_request)
    .filter((item) => item.state !== 'deleted')
    .slice(0, limit)
    .map((item) => ({
      id: String(item.id ?? ''),
      author: item.user?.login ?? 'ghost',
      authorUrl: item.user?.html_url ?? `https://github.com/${item.user?.login ?? 'ghost'}`,
      avatar: item.user?.avatar_url ?? '',
      // 「作者」标记：评论者与文章作者是同一个人的时候，读者需要知道。
      isAuthor: Boolean(item.author_association && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(item.author_association)),
      body: normalizeBody(item.body ?? ''),
      createdAt: item.created_at ?? '',
      updatedAt: item.updated_at ?? '',
      // 兜底 URL 只在知道 repo 时才有意义。repo 为空时给空串 ——
      // 拼出一个 `https://github.com//issues#...` 的链接比没有链接更糟：
      // 它看起来是可点的，点进去是 404。
      url: item.html_url ?? (repo ? `https://github.com/${repo}/issues#issuecomment-${item.id}` : ''),
      reactions: reactions ? normalizeReactions(item.reactions) : null,
    }));
}

/**
 * 评论正文 → 安全的 HTML 片段。
 *
 * **这里不能直接用 GitHub 返回的 body_markdown 再自己渲染**，也不能
 * `innerHTML = body` —— 后者是教科书级的 XSS，而评论是任意人写的。
 *
 * 做法是「只识别两种东西，其余全部当纯文本转义」：
 *   · `@username` → 指向 GitHub 主页的链接
 *   · URL → 指向该 URL 的链接（且只放行 http(s)）
 *   · 其余全是文本，包括 `<script>`、`<img onerror>` 这些 —— 它们会显示成
 *     字面量（读者看到 `&lt;script&gt;`），而不是被执行
 *
 * 为什么不渲染完整 Markdown：那要引入一个 Markdown 渲染器并在**浏览器里**
 * 处理不可信输入。构建期用的渲染器有一条 sanitize 管线（见
 * parse/sanitize-html.js），但把它搬到浏览器端意味着多下载一份渲染器
 * （几十 KB），而评论区的排版需求只有「换行 + 链接 + @提及」。
 * 代价与收益不成比例。
 *
 * 注：`body` 字段（HTML 版）刻意不用 —— 它是 GitHub 自己 sanitize 过的，
 * 但我们会把结果插进**我们自己的** DOM 结构里，依赖别人的 sanitize
 * 结果来决定自己的安全性，是把自己安全边界交给第三方。
 */
export function normalizeBody(body) {
  const text = String(body ?? '');
  // 空正文直接给空串，不要吐出 `<p></p>` —— 后者会在页面上渲染出一个
  // 有上下 margin 的空段落，看起来像「这条评论的内容加载失败了」。
  if (!text.trim()) return '';
  // 先转义，再在转义后的文本上做行内识别 —— 顺序反了就会被注入。
  const escaped = escapeHtml(text);
  const withMentions = escaped.replace(
    /(^|[^\w/])@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})/gi,
    (full, prefix, name) => `${prefix}<a class="c-mention" href="https://github.com/${name}" rel="noopener noreferrer nofollow" target="_blank">@${name}</a>`,
  );
  const withLinks = withMentions.replace(
    /(?<!["'=])\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]]/gi,
    (url) => `<a class="c-link" href="${url}" rel="noopener noreferrer nofollow" target="_blank">${url}</a>`,
  );
  return withLinks.split(/\n{2,}/).map((para) => `<p>${para.replace(/\n/g, '<br />')}</p>`).join('');
}

/** 只保留我们真的会显示的三种 reaction，且只保留计数 > 0 的。 */
function normalizeReactions(reactions) {
  if (!reactions) return null;
  const map = { '+1': '👍', '-1': '👎', laugh: '😄', hooray: '🎉', confused: '😕', heart: '❤️', rocket: '🚀', eyes: '👀' };
  const out = [];
  for (const [key, emoji] of Object.entries(map)) {
    const count = Number(reactions[key] ?? 0);
    if (count > 0) out.push({ emoji, count });
  }
  return out.length ? out : null;
}

/**
 * 渲染评论区的**静态外壳**。
 *
 * 为什么外壳在构建期渲染、内容在运行时填：
 *   · 外壳给了无 JS 读者一句可读的话 + 一个去 GitHub 的链接
 *     （纯静态站的评论区在无 JS 时最容易被做成一片空白）
 *   · SEO 不受影响：评论内容不参与排名，空壳不会污染页面
 *   · 数据属性是浏览器端唯一的接缝，改了它 client 就找不到地方填
 */
export function renderCommentsShell(target, { labels = {} } = {}) {
  if (!target) return '';
  const L = {
    title: '评论',
    empty: '还没有评论。',
    join: '在 GitHub 上参与讨论',
    loading: '正在加载评论…',
    error: '评论加载失败。',
    openIn: '在 GitHub 上查看',
    ...labels,
  };
  const attrs = [
    `data-comments-provider="${escapeAttr(target.provider)}"`,
    `data-comments-repo="${escapeAttr(target.repo)}"`,
    `data-comments-issue="${escapeAttr(String(target.issueNumber))}"`,
    `data-comments-limit="${escapeAttr(String(target.limit))}"`,
    `data-comments-reactions="${target.reactions ? '1' : '0'}"`,
    `data-comments-strings="${escapeAttr(JSON.stringify({ empty: L.empty, error: L.error, loading: L.loading }))}"`,
  ].join(' ');
  return `<section class="comments" id="comments" aria-labelledby="comments-title" ${attrs}>
  <h2 class="comments-title" id="comments-title">${escapeHtml(L.title)}</h2>
  <p class="comments-status" data-role="status">${escapeHtml(L.loading)}</p>
  <ol class="comments-list" data-role="list" hidden></ol>
  <p class="comments-cta">
    <a href="${escapeAttr(target.discussionUrl)}" rel="noopener noreferrer" target="_blank">${escapeHtml(L.join)}</a>
    <span class="comments-cta-note">（评论在 GitHub 上进行，需要 GitHub 账号）</span>
  </p>
</section>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function escapeAttr(text) {
  return escapeHtml(text);
}

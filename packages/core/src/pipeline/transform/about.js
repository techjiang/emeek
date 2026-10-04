/**
 * 关于页正文处理：把内容里的一级标题提升为「页面主标题」。
 *
 * 为什么需要这一步：关于页的正文来自用户自己的 ABOUT.md，
 * 里面几乎总有一个 `# 关于` 开头。而布局本身也会输出一个 <h1> ——
 * 一页两个 <h1>，搜索引擎分不清哪个是页面主题。
 *
 * 两种处理方式，选的是前者：
 *  A. 布局不输出 h1，把正文的 h1 提上来（当前做法）
 *  B. 硬删正文 h1（会丢内容）
 *
 * 没有 h1 时（用户直接写散文），布局用页面标题兜底 —— 保证每页都有主标题。
 */
export function extractAboutTitle(html, fallback = '关于') {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  if (!match) return { title: fallback, html, titleSource: 'fallback' };
  const title = match[1].replace(/<[^>]+>/g, '').trim() || fallback;
  return {
    title,
    // 摘掉这个 h1（连同紧跟的空白），由布局渲染成 .page-title。
    // 只摘第一个：正文后面若还有 h1，渲染器已经把它们降成 h2 了。
    html: html.slice(0, match.index) + html.slice(match.index + match[0].length),
    titleSource: 'content',
  };
}

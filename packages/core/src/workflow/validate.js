/**
 * 构建期内容校验（P3-4b-rest D2）。
 *
 * ── 校验什么、不校验什么 ──
 *
 * 这里只查**能明确判定对错**的事：空标题、非法的发布日期、
 * 指向不存在文件的本地图片、站内链接指向不存在的页面、分类/标签格式不对。
 *
 * 刻意**不查**「文章太短」「没有标签」「标题不够吸引人」这类 ——
 * 它们是判断，不是事实。把判断混进校验会让用户学会「忽略这些警告」，
 * 而那会连带把真问题一起忽略掉。一条永远在响的警告等于没有警告。
 *
 * ── 为什么默认不阻塞构建 ──
 *
 * 校验是新加的一道关。用户的内容仓库里可能本来就有几条历史问题，
 * 一升级就构建失败是很糟的体验。所以默认 `warn`：问题被逐条说出来，
 * 但构建照常。要严格就在配置里写 `error`。
 *
 * ── 每条问题都带「怎么修」──
 *
 * 只说「标题为空」没用，作者打开那个文件还是不知道该写什么。
 * 所以每条问题都带 `fix`（一句话的修法）与 `file`（哪个文件）。
 */

/** 校验项清单。配置里写错的名字会被忽略并告警。 */
export const VALIDATION_RULES = ['title', 'date', 'links', 'markdown', 'taxonomy', 'internal-links'];

export const SEVERITY = { error: 'error', warn: 'warn' };

/** 常见但应被拦下的本地图片扩展名（不存在时的提示更有针对性）。 */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

/**
 * 校验一批文章。
 *
 * @param {object[]} posts     构建期文章（含 raw / title / date / categories / tags / url）
 * @param {object}   options
 *   checks        要跑哪些项（空 = 全部）
 *   knownFiles    项目里**确实存在**的文件路径集合（相对项目根，以 / 开头）。
 *                 不给时跳过「本地文件存在性」检查 —— 宁可少查一项，
 *                 也不要在拿不到事实时凭猜报警。
 *   urlSet        站内已知 URL 集合（用于内链检查）。同上，不给就跳过。
 *   source        'local' | 'github-issues' —— 非 local 源不查本地文件。
 * @returns {{ issues, counts }}
 */
export function validatePosts(posts = [], {
  checks = [],
  knownFiles = null,
  urlSet = null,
  source = 'local',
} = {}) {
  const enabled = new Set(Array.isArray(checks) && checks.length ? checks : VALIDATION_RULES);
  const issues = [];

  for (const post of posts) {
    const where = post.file ? relativeFile(post.file) : (post.id ?? post.slug ?? '(未知文章)');

    if (enabled.has('title')) issues.push(...checkTitle(post, where));
    if (enabled.has('date')) issues.push(...checkDate(post, where));
    if (enabled.has('taxonomy')) issues.push(...checkTaxonomy(post, where));
    if (enabled.has('markdown')) issues.push(...checkMarkdown(post, where));
    if (enabled.has('links') && source === 'local' && knownFiles) issues.push(...checkLinks(post, where, knownFiles));
    if (enabled.has('internal-links') && urlSet) issues.push(...checkInternalLinks(post, where, urlSet));
  }

  const counts = { error: 0, warn: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return { issues, counts };
}

function checkTitle(post, where) {
  const title = String(post.title ?? '').trim();
  if (!title) {
    return [issue('error', 'title', where, '文章没有标题', '在 front-matter 里写 title，或让文件名带上可读的标题（如 2024-01-05-hello.md）')];
  }
  if (title === 'untitled') {
    return [issue('warn', 'title', where, '标题是默认值「untitled」', '把 front-matter 的 title 改成真的标题')];
  }
  if (title.length > 120) {
    return [issue('warn', 'title', where, `标题过长（${title.length} 字）`, '标题超过 120 字在搜索引擎与卡片里会被截断，考虑精简')];
  }
  return [];
}

function checkDate(post, where) {
  if (post.date == null || post.date === '') {
    return [issue('warn', 'date', where, '没有发布日期', '在 front-matter 写 date: 2024-01-05，或让文件名以 2024-01-05- 开头')];
  }
  const parsed = new Date(post.date);
  if (Number.isNaN(parsed.getTime())) {
    return [issue('error', 'date', where, `发布日期无法解析（${post.date}）`, '日期要写成 YYYY-MM-DD 或完整的 ISO 8601（如 2024-01-05T10:00:00Z）')];
  }
  if (post.updated) {
    const up = new Date(post.updated);
    if (Number.isNaN(up.getTime())) {
      return [issue('error', 'date', where, `更新日期无法解析（${post.updated}）`, 'updated 要写成 YYYY-MM-DD 或完整 ISO 8601')];
    }
    if (up.getTime() < parsed.getTime() - 86400000) {
      return [issue('warn', 'date', where, '更新日期早于发布日期', '把 updated 改到 date 之后，或删掉 updated')];
    }
  }
  return [];
}

function checkTaxonomy(post, where) {
  const issues = [];
  const check = (list, name) => {
    for (const raw of list ?? []) {
      const value = String(raw);
      if (!value.trim()) {
        issues.push(issue('warn', 'taxonomy', where, `有一个空的${name}`, `删掉 front-matter 里那个空的${name}项`));
        continue;
      }
      // 逗号分隔是 front-matter 里最常见的写法错误：`tags: a, b` 在 YAML 里
      // 是一整个字符串 "a, b"，于是标签变成一个带逗号的长标签，
      // 而页面上看起来只是「标签怪怪的」——很难联想到是写法问题。
      if (value.includes(',')) {
        issues.push(issue('warn', 'taxonomy', where, `${name}「${value}」里含逗号，可能被当成了一整个标签`, `写成 YAML 数组：${name}: ["a", "b"]`));
      }
      if (value.length > 40) {
        issues.push(issue('warn', 'taxonomy', where, `${name}「${value.slice(0, 20)}…」过长（${value.length} 字）`, '标签/分类宜短，超过 40 字多半是整句话被误当成标签了'));
      }
    }
  };
  check(post.tags, '标签');
  check(post.categories, '分类');
  return issues;
}

function checkMarkdown(post, where) {
  const issues = [];
  const raw = String(post.raw ?? '');
  if (!raw.trim()) {
    issues.push(issue('error', 'markdown', where, '正文是空的', '这篇文章只有 front-matter 没有内容 —— 补上正文，或删掉这个文件'));
    return issues;
  }

  // 未闭合的代码块围栏。这是最容易出现、也最容易被忽略的一类：
  // 后面所有内容都被吞进代码块里，页面看起来「只是后半段变丑了」。
  const fences = raw.match(/^```/gm) ?? [];
  if (fences.length % 2 !== 0) {
    issues.push(issue('error', 'markdown', where, `代码块围栏数量是奇数（${fences.length} 个 \`\`\`）`, '有一个 ``` 没有闭合 —— 后面所有内容会被当成代码'));
  }

  // 未闭合的链接/图片：`[文字](地址` 少了右括号。
  const broken = /\[[^\]]*\]\([^)\s]*$/m.exec(raw);
  if (broken) {
    issues.push(issue('warn', 'markdown', where, '有一个链接/图片语法没有闭合', `检查这一处：${broken[0].slice(0, 40)}`));
  }

  // 负缩进列表（用 Tab 缩进）：不同渲染器对 Tab 的展开宽度不一致。
  if (/^\t+[-*+]\s/m.test(raw)) {
    issues.push(issue('warn', 'markdown', where, '列表用 Tab 缩进', '改用空格缩进 —— Tab 在不同渲染器里展开宽度不一致，嵌套层级会错'));
  }
  return issues;
}

/**
 * 本地图片/附件是否真的存在。
 *
 * 这是「坏图」的唯一可靠检出方式：渲染出来的网页上，缺图与有一张
 * 加载失败的图**看起来完全一样**（都是灰色占位），只有构建时知道项目里
 * 到底有没有那个文件。
 */
function checkLinks(post, where, knownFiles) {
  const issues = [];
  const raw = String(post.raw ?? '');
  const re = /!?\[[^\]]*\]\(([^)\s]+)/g;
  let match;
  const seen = new Set();
  while ((match = re.exec(raw))) {
    const target = match[1];
    if (seen.has(target)) continue;
    seen.add(target);

    // 只查本地相对/绝对项目路径。远程 URL、锚点、数据 URI 不查 ——
    // 构建期不联网（那会让构建依赖外部站点可用性）。
    if (/^(?:https?:|mailto:|data:|tel:|#)/i.test(target)) continue;
    if (!IMAGE_EXT.test(target) && !target.startsWith('/') && !target.startsWith('./') && !target.startsWith('../')) continue;

    // 归一化：把 markdown 里的来源目录去掉（front-matter 里的路径规则
    // 是「相对项目根」，见 docs/configuration.md）。
    const normalized = `/${target.replace(/^\.\.?\/+/, '').replace(/^\/+/, '')}`;
    if (!knownFiles.has(normalized)) {
      issues.push(issue('warn', 'links', where, `引用的文件不存在：${target}`, `把文件放到 ${normalized}，或修正路径`));
    }
  }
  return issues;
}

/**
 * 站内链接是否指向真实存在的页面。
 *
 * 判据是**已产出的页面集合**，不是「看起来像路径就算」——
 * 后者查不出任何东西（/posts/typo.html 也「像路径」）。
 */
function checkInternalLinks(post, where, urlSet) {
  const issues = [];
  const raw = String(post.raw ?? '');
  const re = /(?<!\!)\[[^\]]*\]\((\/[^)\s#?]+)/g;
  let match;
  const seen = new Set();
  while ((match = re.exec(raw))) {
    const target = match[1];
    if (seen.has(target)) continue;
    seen.add(target);
    if (urlSet.has(target)) continue;
    // 允许指向目录形式（/posts/）——产物里是 /posts/index.html。
    if (urlSet.has(`${target.replace(/\/$/, '')}/index.html`) || urlSet.has(`${target}index.html`)) continue;
    issues.push(issue('warn', 'internal-links', where, `站内链接没有对应页面：${target}`, '检查路径是否写错，或那篇文章是不是还没发布'));
  }
  return issues;
}

function issue(severity, rule, file, message, fix) {
  return { severity, rule, file, message, fix };
}

/** 文件路径只留相对项目根的部分 —— 绝对路径会泄漏构建机器的目录结构。 */
function relativeFile(file) {
  const text = String(file);
  const marker = text.lastIndexOf('/posts/');
  if (marker >= 0) return text.slice(marker + 1);
  const parts = text.split('/');
  return parts.slice(-2).join('/');
}

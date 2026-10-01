import { extractKeywords, splitProseParagraphs, splitSentences, stripMarkdown, countWords, hasCJK } from './text.js';

/**
 * 本地 SEO 分析器。
 *
 * 一条判断标准贯穿全文：**「SEO 得分 45」没有价值，
 * 「标题缺少核心关键词，建议改成 X」才有价值。**
 *
 * 所以这里的每条 check 都必须带上 `suggestion`，而且建议里要出现
 * 具体的字符串（当前的标题、该加的关键词、该补的 alt 文本）。
 * 给不出具体建议的检查项，宁可不做。
 *
 * 检查项按 Yoast 的维度裁剪到「静态博客真的能改的」那些：
 * Yoast 会检查「出站链接 nofollow」这类东西，对个人博客是噪音。
 */

const LENGTHS = {
  title: [15, 60],
  metaDescription: [50, 160],
  slug: [3, 60],
};

export class LocalSEOAnalyzer {
  /**
   * @param {object} post  标准化后的文章对象（与构建管线里的一致）
   *   { title, raw, description, tags, slug, date, author, html, cover, url }
   * @param {object} options
   *   site: { title, url, description }  用于判断社交卡片是否完整
   *   knownPosts: [{ title, slug, url }] 用于内链建议
   */
  analyze(post, options = {}) {
    const data = normalize(post);
    const keywords = extractKeywords(data.raw, { top: 5 }).map((k) => k.term);
    const checks = [];

    checks.push(...this.#titleChecks(data, keywords));
    checks.push(...this.#descriptionChecks(data, keywords));
    checks.push(...this.#keywordChecks(data, keywords));
    checks.push(...this.#linkChecks(data, options));
    checks.push(...this.#structureChecks(data));
    checks.push(...this.#shareChecks(data, options));
    checks.push(...this.#technicalChecks(data));

    const total = checks.length;
    const failed = checks.filter((c) => c.status === 'fail').length;
    const warned = checks.filter((c) => c.status === 'warn').length;
    // 评分：fail 扣满，warn 扣一半。分母是检查项总数，所以项数变化不会让分数漂移。
    const score = Math.round(((total - failed - warned * 0.5) / total) * 100);

    return {
      score: Math.max(0, Math.min(100, score)),
      level: seoLevel(score),
      source: 'local',
      quality: 'high',
      checks,
      keywords,
      meta_description_suggestion: this.suggestMetaDescription(data, keywords),
      total_score: Math.max(0, Math.min(100, score)),
      improvement_count: failed + warned,
      // 分维度汇总，UI 可以按 category 分组折叠
      by_category: groupBy(checks, 'category'),
    };
  }

  #titleChecks(data, keywords) {
    const checks = [];
    const title = data.title ?? '';
    const length = [...title].length;

    if (!title) {
      checks.push(check('title', '标题存在', 'fail', '文章没有标题', '在 front-matter 里补上 title，或给 Issue 写一个有信息量的标题。'));
      return checks;
    }

    checks.push(check('title', '标题存在', 'pass', `标题「${truncate(title, 30)}」`));

    if (length < LENGTHS.title[0]) {
      checks.push(check('title', '标题长度', 'warn',
        `标题 ${length} 字符，偏短`,
        `标题太短通常意味着没写清主题。建议展开到 15~60 字符，例如「${title} — ${suggestTopicSuffix(data, keywords)}」。`));
    } else if (length > LENGTHS.title[1]) {
      checks.push(check('title', '标题长度', 'warn',
        `标题 ${length} 字符，超出搜索结果展示长度（约 60 字符后会被截断）`,
        `建议压到 60 字符以内，把核心词前置：${truncate(title, 40)}…`.replace(/…$/, '')));
    } else {
      checks.push(check('title', '标题长度', 'pass', `标题 ${length} 字符，在理想范围内`));
    }

    const hit = keywords.filter((k) => title.toLowerCase().includes(k.toLowerCase()));
    if (keywords.length && !hit.length) {
      const top = keywords.slice(0, 2).join('、');
      const suggestion = titleSuggestion(data, keywords);
      checks.push(check('title', '标题含关键词', 'fail',
        `标题没有出现正文中的核心关键词（${top}）`,
        `建议改为「${suggestion}」—— 这样搜索结果里用户能立刻看出文章讲什么。`));
    } else if (hit.length) {
      checks.push(check('title', '标题含关键词', 'pass', `标题命中关键词：${hit.join('、')}`));
    } else {
      checks.push(check('title', '标题含关键词', 'warn', '正文太短，无法提取可靠关键词', '文章内容偏少时关键词统计不可靠。'));
    }

    return checks;
  }

  #descriptionChecks(data, keywords) {
    const checks = [];
    const description = data.description ?? '';
    const length = [...description].length;

    if (!description) {
      checks.push(check('description', '元描述存在', 'fail',
        '没有元描述，搜索引擎会自行截取正文，结果通常不理想',
        `建议补上：${this.suggestMetaDescription(data, keywords)}`));
      return checks;
    }

    checks.push(check('description', '元描述存在', 'pass', `元描述 ${length} 字符`));

    if (length < LENGTHS.metaDescription[0]) {
      checks.push(check('description', '元描述长度', 'warn',
        `元描述 ${length} 字符，偏短，浪费了展示空间`,
        `建议扩到 50~160 字符。可以补一句这篇文章解决了什么问题：${description}${description.endsWith('。') ? '' : '。'}本文介绍了具体做法与取舍。`));
    } else if (length > LENGTHS.metaDescription[1]) {
      checks.push(check('description', '元描述长度', 'warn',
        `元描述 ${length} 字符，超出 160，搜索结果的尾部会被截掉`,
        `建议精简到 160 字符以内，优先保留结论与关键词：${truncate(description, 120)}…`));
    } else {
      checks.push(check('description', '元描述长度', 'pass', `元描述 ${length} 字符，在理想范围内`));
    }

    const hit = keywords.filter((k) => description.toLowerCase().includes(k.toLowerCase()));
    if (keywords.length && !hit.length) {
      checks.push(check('description', '元描述含关键词', 'warn',
        `元描述没有命中关键词（${keywords.slice(0, 3).join('、')}）`,
        `建议在描述里自然地带入核心词，例如：「${keywords[0]}」相关的做法与取舍，详见正文。`));
    } else if (hit.length) {
      checks.push(check('description', '元描述含关键词', 'pass', `元描述命中关键词：${hit.join('、')}`));
    }

    return checks;
  }

  #keywordChecks(data, keywords) {
    const checks = [];
    const words = countWords(data.raw);

    if (!keywords.length) {
      checks.push(check('keyword', '关键词提取', 'warn', '无法从正文提取关键词', '正文内容过少或过于口语化，建议补充实质内容。'));
      return checks;
    }
    checks.push(check('keyword', '关键词提取', 'pass', `核心关键词：${keywords.slice(0, 5).join('、')}`));

    const top = keywords[0];
    const occurrences = countOccurrences(data.raw, top);
    const density = words ? occurrences / words : 0;
    const percent = (density * 100).toFixed(1);

    if (density < 0.005) {
      checks.push(check('keyword', '关键词密度', 'warn',
        `核心关键词「${top}」出现 ${occurrences} 次，密度 ${percent}%，偏低`,
        `建议在开头段与结尾段各自然提及一次「${top}」，让搜索引擎确认主题。不要堆砌，8 次以上会触发降权。`));
    } else if (density > 0.05) {
      checks.push(check('keyword', '关键词密度', 'warn',
        `关键词密度 ${percent}%，偏高，可能被判定为堆砌`,
        `建议把部分「${top}」替换成代词或同义表达，降到 5% 以下。`));
    } else {
      checks.push(check('keyword', '关键词密度', 'pass', `关键词密度 ${percent}%，在 0.5%~5% 的合理区间`));
    }

    const firstParagraph = (splitProseParagraphs(data.raw)[0] ?? '').slice(0, 200);
    if (firstParagraph && !keywords.some((k) => firstParagraph.toLowerCase().includes(k.toLowerCase()))) {
      checks.push(check('keyword', '首段含关键词', 'warn',
        '第一段没有出现任何核心关键词',
        `搜索引擎更看重开头内容。建议第一段自然带入「${top}」，例如在说明背景时点出它。`));
    } else if (firstParagraph) {
      checks.push(check('keyword', '首段含关键词', 'pass', '首段包含核心关键词'));
    }

    return checks;
  }

  #linkChecks(data, options) {
    const checks = [];
    const raw = data.raw;
    const internal = [...raw.matchAll(/\[([^\]]+)\]\((\/[^)\s]+|[^)\s]*\.html[^)\s]*)\)/g)].map((m) => ({ anchor: m[1], href: m[2] }));
    const external = [...raw.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => ({ anchor: m[1], href: m[2] }));
    const wiki = [...raw.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);

    const totalLinks = internal.length + external.length + wiki.length;
    if (totalLinks === 0) {
      const suggestion = options.knownPosts?.length
        ? `文内没有链接。可以链接到相关文章，例如「${options.knownPosts[0].title}」（[[${options.knownPosts[0].title}]]）。`
        : '文内没有链接。建议至少加 1~2 个指向站内其它文章的双向链接（[[文章标题]]），帮助搜索引擎理解文章之间的关系。';
      checks.push(check('link', '内链数量', 'warn', '文章内没有任何链接', suggestion));
    } else if (internal.length + wiki.length === 0) {
      checks.push(check('link', '内链数量', 'warn',
        `只有 ${external.length} 个外链，没有站内链接`,
        '外链会把权重导出去，站内链接能留住权重。建议补充指向本站相关文章的链接。'));
    } else {
      checks.push(check('link', '内链数量', 'pass', `站内链接 ${internal.length + wiki.length} 个，外链 ${external.length} 个`));
    }

    // 锚文本质量：一堆「点击这里」「这里」等于没写
    const weakAnchors = [...internal, ...external].filter((l) => /^(?:点击?这里|这里|链接|详见|更多|click here|here|link)$/i.test(l.anchor.trim()));
    if (weakAnchors.length) {
      checks.push(check('link', '锚文本质量', 'warn',
        `有 ${weakAnchors.length} 个链接使用了无信息量的锚文本（如「${weakAnchors[0].anchor}」）`,
        '锚文本应当描述目标内容，例如把「点击这里」改成「Emeek 的插件系统」—— 这对 SEO 和无障碍都更好。'));
    } else if (totalLinks > 0) {
      checks.push(check('link', '锚文本质量', 'pass', '链接锚文本都有描述性'));
    }

    if (wiki.length) {
      checks.push(check('link', '双向链接', 'pass', `使用 ${wiki.length} 个双向链接：${wiki.slice(0, 3).join('、')}`));
    }

    return checks;
  }

  #structureChecks(data) {
    const checks = [];
    const raw = data.raw;
    const headings = [...raw.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: m[1].length, text: m[2] }));

    if (!headings.length) {
      if (countWords(raw) > 200) {
        checks.push(check('structure', '标题层级', 'warn',
          '文章超过 200 字但没有小标题',
          '建议每 2~3 段加一个 ## 小标题，把内容分层。小标题本身也是关键词的载体。'));
      } else {
        checks.push(check('structure', '标题层级', 'pass', '短文不需要小标题'));
      }
    } else {
      // H1 -> H2 -> H3 跳级会破坏文档结构
      let previous = 0;
      let jumped = null;
      for (const heading of headings) {
        if (previous && heading.level > previous + 1) {
          jumped = { from: previous, to: heading.level, text: heading.text };
          break;
        }
        previous = heading.level;
      }
      if (jumped) {
        checks.push(check('structure', '标题层级', 'warn',
          `标题层级跳级：从 H${jumped.from} 直接到 H${jumped.to}（「${truncate(jumped.text, 20)}」）`,
          '层级跳跃会让大纲结构断裂。建议把中间层补上，或把该标题提升一级。'));
      } else {
        checks.push(check('structure', '标题层级', 'pass', `${headings.length} 个小标题，层级有序`));
      }
    }

    // 图片 alt：无障碍与图片搜索都依赖它
    const images = [...raw.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((m) => ({ alt: m[1].trim(), src: m[2] }));
    if (!images.length) {
      const words = countWords(raw);
      if (words > 400) {
        checks.push(check('structure', '图片', 'warn', `文章 ${words} 字但没有配图`, '长文建议至少配一张结构图或流程图，能显著降低阅读门槛，也增加图片搜索的入口。'));
      } else {
        checks.push(check('structure', '图片', 'pass', '短文可以不配图'));
      }
    } else {
      const missing = images.filter((img) => !img.alt || /^(?:image|img|图片|截图)$/i.test(img.alt));
      if (missing.length) {
        checks.push(check('structure', '图片 alt 文本', 'fail',
          `${missing.length}/${images.length} 张图片缺少有效的 alt 文本（第一张：${truncate(missing[0].src, 40)}）`,
          'alt 是图片搜索的唯一入口，也是屏幕阅读器用户的唯一信息来源。请描述图片内容，而不是写「图片」。'));
      } else {
        checks.push(check('structure', '图片 alt 文本', 'pass', `${images.length} 张图片都有 alt 文本`));
      }
    }

    const hasList = /^(?:[-*+]|\d+[.)])\s/m.test(raw);
    const hasTable = /^\|.*\|$/m.test(raw);
    if (hasList || hasTable) {
      checks.push(check('structure', '结构化内容', 'pass', `包含${hasList ? '列表' : ''}${hasList && hasTable ? '与' : ''}${hasTable ? '表格' : ''}`));
    } else if (countWords(raw) > 250) {
      checks.push(check('structure', '结构化内容', 'warn',
        '没有使用列表或表格',
        '并列的信息（多个方案、多个步骤、多个参数）改成列表会更好扫读，也更容易被搜索引擎当作结构化内容。'));
    }

    return checks;
  }

  #shareChecks(data, options) {
    const checks = [];
    const site = options.site ?? {};
    const url = data.url ?? (site.url && data.slug ? `${site.url}/posts/${data.slug}.html` : null);

    if (url) {
      checks.push(check('share', 'canonical URL', 'pass', `canonical：${truncate(url, 60)}`));
    } else {
      checks.push(check('share', 'canonical URL', 'warn', '无法确定文章 URL', '确认 slug 或 site.url 已配置，否则 canonical 与社交卡片都会缺失。'));
    }

    if (data.cover) {
      checks.push(check('share', '社交卡片图', 'pass', `已配置封面图 ${truncate(data.cover, 40)}`));
    } else {
      checks.push(check('share', '社交卡片图', 'warn',
        '没有设置封面图，分享到社交平台时只会显示纯文本卡片',
        '在 front-matter 里加 cover: /assets/your-cover.png（建议 1200×630），点击率差别很明显。'));
    }

    const description = (data.description ?? '').trim();
    if (description.length >= 50) {
      checks.push(check('share', '社交预览描述', 'pass', `社交预览描述 ${description.length} 字符，足够完整`));
    } else {
      checks.push(check('share', '社交预览描述', 'warn',
        description ? `社交预览描述只有 ${description.length} 字符` : '没有社交预览描述',
        `OG 与 Twitter Card 都会用它。建议 ${this.suggestMetaDescription(data, [])}`));
    }

    return checks;
  }

  #technicalChecks(data) {
    const checks = [];

    if (!data.slug) {
      checks.push(check('technical', 'URL slug', 'fail', '没有 slug，无法生成稳定 URL', '在 front-matter 里补 slug: my-post-name，用英文小写加连字符。'));
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)) {
      checks.push(check('technical', 'URL slug', 'warn',
        `slug「${data.slug}」包含非规范字符`,
        `建议改成纯小写字母数字加连字符，例如「${data.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-post'}」。`));
    } else if (data.slug.length > LENGTHS.slug[1]) {
      checks.push(check('technical', 'URL slug', 'warn', `slug 长度 ${data.slug.length} 字符，偏长`, '建议压到 60 字符以内，只保留 3~5 个关键词。'));
    } else {
      checks.push(check('technical', 'URL slug', 'pass', `slug「${data.slug}」规范`));
    }

    if (!data.date) {
      checks.push(check('technical', '发布日期', 'fail', '缺少发布日期', '补上 date: YYYY-MM-DD。搜索引擎会用它判断内容新鲜度。'));
    } else if (Number.isNaN(new Date(data.date).getTime())) {
      checks.push(check('technical', '发布日期', 'fail', `日期「${data.date}」无法解析`, '改成 YYYY-MM-DD 格式，例如 2024-04-01。'));
    } else {
      checks.push(check('technical', '发布日期', 'pass', `发布日期 ${data.date}`));
    }

    if (!data.author) {
      checks.push(check('technical', '作者信息', 'warn', '没有作者信息', '补上 author 字段，JSON-LD 结构化数据里会用到它（作者是 E-E-A-T 信号的一部分）。'));
    } else {
      checks.push(check('technical', '作者信息', 'pass', `作者：${data.author}`));
    }

    if (!data.tags?.length) {
      checks.push(check('technical', '标签', 'warn', '文章没有标签', '加 3~8 个标签，标签页是站内重要的聚合入口，也是内链的来源。'));
    } else {
      checks.push(check('technical', '标签', 'pass', `${data.tags.length} 个标签：${data.tags.slice(0, 5).join('、')}`));
    }

    return checks;
  }

  /**
   * 本地元描述生成：标题 + 首段首句 + 核心关键词。
   *
   * 不引 LLM，因为这段文字的价值在于「准确」而不是「优美」——
   * 编造一句漂亮的描述，如果它和正文不符，用户点进来会觉得被骗，跳出率更高。
   */
  suggestMetaDescription(data, keywords = []) {
    const title = (data.title ?? '').trim();
    const paragraphs = splitProseParagraphs(data.raw);
    const firstSentence = paragraphs.length ? (splitSentences(paragraphs[0])[0] ?? paragraphs[0]) : '';

    const parts = [];
    if (title) parts.push(title);

    let body = firstSentence.replace(/^[，,。.\s]+/, '').trim();
    if (body && body !== title) {
      // 首句已经提到标题就不要再重复
      if (!body.includes(title)) parts.push(body);
      else parts.push(body);
    }

    // 关键词补充：只在描述还太短时加，避免为了塞词把句子写别扭
    const missing = keywords.slice(0, 3).filter((k) => !parts.join(' ').toLowerCase().includes(k.toLowerCase()));
    if (missing.length && parts.join(' ').length < 60) {
      parts.push(`${missing.join('、')} 等主题的实践记录`);
    }

    let text = parts.join(' — ').replace(/\s+/g, ' ').trim();
    text = text.replace(/[；;、,，]$/, '');
    if (!/[。！？.!?]$/.test(text)) text += hasCJK(text) ? '。' : '.';

    // 控制在 50~160：太短补不了就让它短（诚实），太长就截到句末
    if ([...text].length > 160) {
      text = `${[...text].slice(0, 155).join('').replace(/[，,、]$/, '')}…`;
    }
    return text;
  }
}

function check(category, item, status, message, suggestion = '') {
  return { category, item, status, message, suggestion };
}

/** 归一化输入：既能接受构建管线的 post 对象，也能接受裸 Markdown 字符串。 */
function normalize(post) {
  if (typeof post === 'string') {
    return { title: '', raw: post, description: null, tags: [], slug: null, date: null, author: null, cover: null, url: null };
  }
  const source = post ?? {};
  return {
    title: source.title ?? null,
    raw: String(source.raw ?? source.markdown ?? source.content ?? ''),
    description: source.description ?? source.summary ?? null,
    tags: source.tags ?? [],
    slug: source.slug ?? null,
    date: source.date ?? null,
    author: source.author ?? null,
    cover: source.cover ?? source.image ?? null,
    url: source.url ?? null,
  };
}

/**
 * 标题改写建议。
 *
 * 目标是给出「可以直接复制去用」的字符串，而不是「记得加关键词」这种提示。
 * 结构：核心关键词 + 分隔符 + 原标题的信息点。
 */
function titleSuggestion(data, keywords) {
  const title = (data.title ?? '').trim();
  const top = keywords[0] ?? '';
  const second = keywords[1] ?? '';
  if (top && !title.toLowerCase().includes(top.toLowerCase())) {
    return cleanTitle(`${top}${second ? `：${second}` : ''} — ${title || '完整指南'}`);
  }
  return cleanTitle(title);
}

function cleanTitle(value) {
  const text = value.replace(/\s+/g, ' ').replace(/^[—\-：:]+|[—\-：:]+$/g, '').trim();
  return [...text].length > 60 ? `${[...text].slice(0, 57).join('')}…` : text;
}

function suggestTopicSuffix(data, keywords) {
  if (keywords.length >= 2) return `${keywords[0]}与${keywords[1]}`;
  return '完整指南';
}

function truncate(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return [...text].length > limit ? `${[...text].slice(0, limit).join('')}…` : text;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  const lower = String(text).toLowerCase();
  const target = needle.toLowerCase();
  let count = 0;
  let index = 0;
  while ((index = lower.indexOf(target, index)) !== -1) {
    count += 1;
    index += target.length;
  }
  return count;
}

function seoLevel(score) {
  if (score >= 90) return '优秀';
  if (score >= 70) return '良好';
  if (score >= 50) return '一般';
  return '需改进';
}

function groupBy(items, key) {
  const groups = {};
  for (const item of items) {
    const value = item[key];
    groups[value] ??= { pass: 0, warn: 0, fail: 0, items: [] };
    groups[value][item.status] += 1;
    groups[value].items.push(item);
  }
  return groups;
}

export { LENGTHS };

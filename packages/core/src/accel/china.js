/**
 * 中国大陆加速专项（A4）。
 *
 * 这块的痛点不是「不够快」，是「打不开」。所以这里的每一项都对应一个
 * 具体的「打不开」原因：
 *   1. ICP 备案 —— 没备案的域名在国内 CDN 会被阻断解析，不是慢，是不通。
 *   2. Google Fonts —— fonts.googleapis.com 在国内不可达，页面会卡在
 *      样式表请求上直到超时（首屏白屏的常见元凶）。
 *   3. 中文字体体积 —— 思源黑体全量 20MB+，一次下载等于不可用。
 *   4. 图片 —— 未压缩的原图在移动网络上是首屏杀手。
 */

/** 已知在国内不可达或极不稳定的外部资源域名。 */
export const BLOCKED_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ajax.googleapis.com',
  'cdn.jsdelivr.net',      // jsDelivr 国内时通时断，不作为关键路径
  'unpkg.com',
  'esm.sh',
  'cdnjs.cloudflare.com',
  'code.jquery.com',
  'stackpath.bootstrapcdn.com',
  'use.typekit.net',
  'fastly.jsdelivr.net',
];

/** 推荐的国内可达替代。 */
export const CHINA_ALTERNATIVES = {
  'fonts.googleapis.com': {
    replaceWith: '自有 CDN 字体（emeek 字体子集化产物）或系统字体回退',
    note: '字体子集化的产物应放在自己的 CDN 上，不要依赖第三方字体服务',
  },
  'fonts.gstatic.com': {
    replaceWith: '自有 CDN 字体文件',
    note: '同上；子集化后每片 < 30KB，回退到 system-ui 也完全可用',
  },
  'cdn.jsdelivr.net': {
    replaceWith: '自有 CDN / 阿里云 CDN / 腾讯云 CDN',
    note: '关键路径资源不要放第三方 CDN；非关键资源可保留但需有 fallback',
  },
};

/**
 * 扫描一份 HTML，找出所有指向国内不可达域名的引用。
 * @returns {Array<{host: string, url: string, context: string, suggestion: object|null}>}
 */
export function scanBlockedHosts(html, { hosts = BLOCKED_HOSTS } = {}) {
  const found = new Map();
  const regex = /\b(?:href|src|action|poster|data-src)=("|')([^"']+)\1/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = match[2];
    let host;
    try {
      host = new URL(url, 'https://placeholder.local').host;
    } catch {
      continue;
    }
    if (!host || !hosts.includes(host)) continue;
    if (!found.has(host)) {
      found.set(host, {
        host,
        url,
        context: extractTag(html, match.index),
        suggestion: CHINA_ALTERNATIVES[host] ?? null,
      });
    }
  }
  return [...found.values()];
}

function extractTag(html, index) {
  const start = html.lastIndexOf('<', index);
  const end = html.indexOf('>', index);
  if (start === -1 || end === -1) return '';
  return html.slice(start, end + 1).slice(0, 200);
}

/**
 * ICP 备案检查。
 *
 * 无法在本地真正确认备案状态（需要工信部查询），所以这里只做「前置条件」判定：
 * 大陆 CDN 需要 (1) 已备案域名作为加速域名 (2) 备案号可展示。
 * 返回 blockers 时，说明这套配置在国内上线必然被阻断 —— 要在部署前拦住。
 */
export function checkIcp({ cdn, site } = {}) {
  const blockers = [];
  const warnings = [];
  const chinaEnabled = cdn?.china?.enabled === true;
  if (!chinaEnabled) {
    return { enabled: false, blockers, warnings, icp: null };
  }

  const provider = cdn.china?.provider ?? cdn?.provider;
  const domain = cdn.china?.domain ?? cdn?.domain ?? '';
  const icp = cdn.china?.icp ?? cdn?.icp ?? false;

  if (!icp) {
    blockers.push({
      path: 'cdn.china.icp',
      message: `中国大陆 CDN（${provider}）要求域名已完成 ICP 备案。未备案域名会被阻断解析 —— 这不是变慢，是打不开。`,
    });
  }
  if (!domain) {
    blockers.push({
      path: 'cdn.china.domain',
      message: '缺少大陆加速域名（如 cdn.myblog.techsauce.cn）。国内 CDN 需要独立备案域名。',
    });
  } else if (domain.endsWith('.github.io')) {
    blockers.push({
      path: 'cdn.china.domain',
      message: 'github.io 无法备案，也不能作为国内 CDN 加速域名。请使用自有域名。',
    });
  }
  if (provider === 'cloudflare') {
    warnings.push({
      path: 'cdn.china.provider',
      message: 'Cloudflare 免费套餐不含中国大陆节点。大陆加速请用 aliyun / tencent。',
    });
  }
  if (site?.url && domain && new URL(site.url, 'https://x.local').host === domain) {
    warnings.push({
      path: 'cdn.china.domain',
      message: '加速域名与站点主域名相同，建议用独立子域（cdn.）以便区分回源与缓存。',
    });
  }
  return { enabled: true, blockers, warnings, icp: { provider, domain, icp } };
}

/**
 * 中文字体子集化。
 *
 * 这里刻意不做真正的字形裁剪（那需要 fontkit/fonttools 级别的依赖），
 * 而是做**可执行的规划**：算出需要保留哪些字符、按 unicode-range 怎么分片、
 * 每片预估多大、本地回退怎么写。真正的裁剪交给 fonttools 脚本（见
 * scripts/subset-fonts.py），构建期只消费它的产物。
 *
 * 之所以把「规划」放进 core 并可测试：分片策略错了（比如按笔画而不是按
 * unicode-range）会让浏览器把所有分片都下下来，比不分片还慢。
 */
export function planFontSubset(posts = [], {
  maxChunkBytes = 30 * 1024,
  bytesPerGlyph = 420, // woff2 中文字形平均约 400~450 字节，含 hinting
} = {}) {
  const chars = new Set();
  for (const post of posts) {
    const text = [post.title, post.description, post.raw, post.html].filter(Boolean).join('');
    for (const ch of text) {
      const code = ch.codePointAt(0);
      // 只收 CJK 基本区 + 扩展 A + 常用标点。
      if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) chars.add(ch);
      else if (code >= 0x3000 && code <= 0x303f) chars.add(ch);
      else if (code >= 0xff00 && code <= 0xffef) chars.add(ch);
    }
  }
  const glyphs = [...chars].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const perChunk = Math.max(1, Math.floor(maxChunkBytes / bytesPerGlyph));
  const chunks = [];
  for (let i = 0; i < glyphs.length; i += perChunk) {
    const slice = glyphs.slice(i, i + perChunk);
    const ranges = toRanges(slice.map((c) => c.codePointAt(0)));
    chunks.push({
      index: chunks.length,
      glyphCount: slice.length,
      estimatedBytes: slice.length * bytesPerGlyph,
      unicodeRange: ranges,
      sample: slice.slice(0, 8).join(''),
    });
  }
  return {
    totalGlyphs: glyphs.length,
    totalEstimatedBytes: glyphs.length * bytesPerGlyph,
    chunkCount: chunks.length,
    maxChunkBytes,
    chunks,
  };
}

/** 把码点序列压成 unicode-range 表达式（连续段合并）。 */
export function toRanges(codepoints) {
  const sorted = [...new Set(codepoints)].sort((a, b) => a - b);
  const ranges = [];
  let start = null;
  let prev = null;
  for (const cp of sorted) {
    if (start === null) {
      start = cp;
      prev = cp;
      continue;
    }
    if (cp === prev + 1) {
      prev = cp;
      continue;
    }
    ranges.push(formatRange(start, prev));
    start = cp;
    prev = cp;
  }
  if (start !== null) ranges.push(formatRange(start, prev));
  return ranges;
}

function formatRange(start, end) {
  const hex = (n) => `U+${n.toString(16).toUpperCase().padStart(4, '0')}`;
  return start === end ? hex(start) : `${hex(start)}-${hex(end)}`;
}

/**
 * 图片加速建议：把「原图直出」的问题点出来。
 * @returns {{ totalBytes: number, offenders: Array<{url:string, bytes:number, reasons:string[]}>, savings: object }}
 */
export function analyzeImages(images = [], { maxBytes = 300 * 1024, maxWidth = 1600 } = {}) {
  const offenders = [];
  let total = 0;
  for (const img of images) {
    const bytes = img.bytes ?? 0;
    total += bytes;
    const reasons = [];
    if (bytes > maxBytes) reasons.push(`${Math.round(bytes / 1024)}KB 超过 ${Math.round(maxBytes / 1024)}KB`);
    if ((img.width ?? 0) > maxWidth) reasons.push(`宽度 ${img.width}px 超过 ${maxWidth}px`);
    if (['png', 'jpg', 'jpeg'].includes(String(img.format ?? '').toLowerCase()) && !img.hasWebp) {
      reasons.push('未提供 WebP 变体');
    }
    if (!img.lazy) reasons.push('未启用懒加载');
    if (reasons.length) offenders.push({ url: img.url, bytes, reasons });
  }
  return {
    totalBytes: total,
    offenders,
    savings: {
      webp: '同尺寸 WebP 通常比 PNG 小 60~80%',
      srcset: '移动端按需下发小图，常见节省 40~70% 流量',
      cdn: 'CDN 缓存命中后源站零流量，首字节取决于边缘节点',
    },
  };
}

/** 生成一份 Google Fonts 替代的 @font-face 片段。 */
export function buildLocalFontFace({ family = 'Emeek Sans', path = '/assets/fonts', chunks = [] } = {}) {
  if (!chunks.length) {
    return [
      '/* 未生成字体子集：使用系统字体回退，零网络请求，国内必然可用。 */',
      ':root {',
      "  --font-sans: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;",
      '}',
    ].join('\n');
  }
  return chunks
    .map((chunk) => [
      '@font-face {',
      `  font-family: '${family}';`,
      '  font-style: normal;',
      '  font-weight: 400;',
      '  font-display: swap;',
      `  src: url('${path}/subset-${chunk.index}.woff2') format('woff2');`,
      `  unicode-range: ${chunk.unicodeRange.join(', ')};`,
      '}',
    ].join('\n'))
    .join('\n\n');
}

export { };

/**
 * 资源提示与 103 Early Hints。
 *
 * HTTP/2 Push 已被主流浏览器废弃，替代方案是：
 *   - <link rel="preload"> 精确标注关键资源（HTML 内，无需服务器支持）
 *   - 103 Early Hints（服务器在 HTML 生成完成前先发 Link 头，浏览器并行预连）
 * 两者都不需要额外请求，是纯白赚的 RTT。
 */

/** 根据产物清单算出「哪些资源值得 preload」。 */
export function selectPreloadTargets(files, { limit = 4 } = {}) {
  const candidates = files
    .filter((f) => !f.path.endsWith('.html'))
    .filter((f) => /\.(css|js|woff2)$/i.test(f.path))
    .map((f) => ({ path: f.path, bytes: f.bytes ?? 0, priority: priorityOf(f.path) }))
    .sort((a, b) => a.priority - b.priority || b.bytes - a.bytes)
    .slice(0, limit);
  return candidates.map((c) => ({ path: c.path, as: asOf(c.path), priority: c.priority }));
}

function priorityOf(p) {
  if (/\.css$/i.test(p)) return 0;
  if (/\.woff2$/i.test(p)) return 1;
  if (/\.js$/i.test(p)) return 2;
  return 3;
}

function asOf(p) {
  if (/\.css$/i.test(p)) return 'style';
  if (/\.js$/i.test(p)) return 'script';
  if (/\.woff2?$/i.test(p)) return 'font';
  if (/\.(png|jpe?g|webp|avif|gif|svg)$/i.test(p)) return 'image';
  return '';
}

/**
 * 生成 <link rel="preload"> 标签。crossorigin 只对字体/跨域需要 ——
 * 同源 CSS/JS 加上反而会导致二次下载。
 */
export function renderPreloadTags(targets = []) {
  return targets
    .map((t) => {
      const cross = t.as === 'font' ? ' crossorigin' : '';
      const asAttr = t.as ? ` as="${t.as}"` : '';
      return `<link rel="preload" href="${t.path}"${asAttr}${cross} />`;
    })
    .join('\n');
}

/**
 * 生成 103 Early Hints 的 Link 头值。
 * @returns {string} 形如 `</a.css>; rel=preload; as=style, </b.woff2>; rel=preload; as=font`
 */
export function buildEarlyHintsHeader(targets = []) {
  return targets
    .map((t) => {
      const parts = [`<${t.path}>`, 'rel=preload'];
      if (t.as) parts.push(`as=${t.as}`);
      if (t.as === 'font') parts.push('crossorigin');
      return parts.join('; ');
    })
    .join(', ');
}

/**
 * 生成 Nginx 片段：预压缩静态文件 + 103 Early Hints + 缓存头。
 * 直接可用的配置 —— 用户不该为「开个加速」去查 Nginx 文档。
 */
export function renderNginxSnippet({ root = '/var/www/emeeek/dist', serverName = 'example.com', earlyHints = [] } = {}) {
  const hints = earlyHints.length
    ? `\n    # 103 Early Hints：HTML 还没生成完，先告诉浏览器去下关键资源。\n    http2_push_preload on;\n    add_header Link "${buildEarlyHintsHeader(earlyHints)}" always;`
    : '';
  return `# Emeek 加速配置（由 emeeek accelerate 生成）
# 放到 nginx.conf 的 server 块里。
server {
    listen 443 ssl http2;
    server_name ${serverName};
    root ${root};

    # 预压缩产物优先：直接发 .br / .gz，不在请求时现压。
    gzip_static on;
    brotli_static on;
    gzip_vary on;
    http2 on;${hints}

    # 带指纹的静态资源：一年不变的承诺由文件名兜底。
    location ~* \\.[0-9a-f]{8}\\.(css|js|woff2?|svg|png|jpe?g|webp|avif)$ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
    }

    # HTML：短缓存 + 后台回源校验，让新文章尽快可见。
    location ~* \\.html$ {
        add_header Cache-Control "public, max-age=300, stale-while-revalidate=3600" always;
    }

    # 搜索索引等稳定入口：绝不缓存，否则用户搜不到新内容。
    location = /search-index.json {
        add_header Cache-Control "no-store" always;
    }

    location ~* \\.(xml|txt|json)$ {
        add_header Cache-Control "public, max-age=60, must-revalidate" always;
    }
}
`;
}

/** 生成 Caddyfile 片段（Caddy 自带 Brotli 与 103）。 */
export function renderCaddySnippet({ root = '/var/www/emeeek/dist', serverName = 'example.com' } = {}) {
  return `# Emeek 加速配置（由 emeeek accelerate 生成）
${serverName} {
    root * ${root}
    encode zstd br gzip
    header {
        Link "</assets/theme.css>; rel=preload; as=style"
    }
    @immutable path_regexp fp \\.[0-9a-f]{8}\\.(css|js|woff2?|svg|png|jpe?g|webp|avif)$
    header @immutable Cache-Control "public, max-age=31536000, immutable"
    @html path *.html
    header @html Cache-Control "public, max-age=300, stale-while-revalidate=3600"
    file_server
}
`;
}

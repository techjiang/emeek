/**
 * 各平台的部署配置文件生成。
 *
 * 全是纯函数：输入 (config, options) → 输出字符串。
 * 这样「生成了什么」可以直接被测试断言，不必真的写盘再读回来 ——
 * 写盘是副作用，配置内容才是需要被守住的东西。
 */

/** 统一入口：返回 `{ 相对路径: 内容 }`，无匹配平台时返回空对象。 */
export function generateDeployFiles(target, config = {}, options = {}) {
  const generators = {
    'github-pages': githubPagesFiles,
    cloudflare: cloudflareFiles,
    vercel: vercelFiles,
    netlify: netlifyFiles,
    rsync: selfHostedFiles,
    docker: dockerFiles,
  };
  const generator = generators[target];
  if (!generator) return {};
  return generator(config, options);
}

/** 取站点 URL 的 host，作为默认域名回退值。 */
function hostOf(config) {
  try {
    return new URL(config?.site?.url ?? '').host;
  } catch {
    return '';
  }
}

function customDomain(config) {
  return config?.deploy?.customDomain || '';
}

// ── GitHub Pages ──────────────────────────────────────────────

function githubPagesFiles(config) {
  const files = {
    // .nojekyll：GitHub Pages 默认用 Jekyll 处理静态文件，
    // 会把下划线开头的目录（_next 之类）和某些文件吃掉。加这个文件直接关掉 Jekyll。
    '.nojekyll': '',
  };
  const domain = customDomain(config);
  if (domain) files.CNAME = `${domain}\n`;

  files['.github/workflows/deploy-pages.yml'] = `# 由 \`emeeek deploy --target github-pages\` 生成。
# 内容变更（Issue / push）→ 构建 → 发布到 GitHub Pages。
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - name: 构建
        run: npx emeeek build
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
`;
  return files;
}

// ── Cloudflare Pages ──────────────────────────────────────────

function cloudflareFiles(config, options = {}) {
  const project = options.project ?? slugify(config?.site?.title ?? 'emeeek-site');
  return {
    'wrangler.toml': `# 由 \`emeeek deploy --target cloudflare\` 生成。
name = "${project}"
pages_build_output_dir = "dist"
compatibility_date = "${new Date().toISOString().slice(0, 10)}"
`,
    'public/_headers': `# 静态资源长缓存：内容带 hash 或很少变动，缓存久一点省带宽。
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/*.html
  Cache-Control: public, max-age=0, must-revalidate

/*.xml
  Cache-Control: public, max-age=3600
`,
    'public/_redirects': `# 404 交给 Emeek 生成的 404.html。
/*  /404.html  404
`,
  };
}

// ── Vercel ────────────────────────────────────────────────────

function vercelFiles() {
  return {
    'vercel.json': JSON.stringify({
      buildCommand: 'npx emeeek build',
      outputDirectory: 'dist',
      cleanUrls: false,
      trailingSlash: false,
      headers: [
        { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
        { source: '/(.*).html', headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }] },
      ],
    }, null, 2) + '\n',
  };
}

// ── Netlify ───────────────────────────────────────────────────

function netlifyFiles() {
  return {
    'netlify.toml': `# 由 \`emeeek deploy --target netlify\` 生成。
[build]
  command = "npx emeeek build"
  publish = "dist"

[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/*.html"
  [headers.values]
    Cache-Control = "public, max-age=0, must-revalidate"
`,
    'public/_headers': '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n',
    'public/_redirects': '/*  /404.html  404\n',
  };
}

// ── 自托管 ────────────────────────────────────────────────────

function selfHostedFiles() {
  return {
    'deploy/nginx.conf': `# 由 \`emeeek deploy --target rsync\` 生成。
# 放到 /etc/nginx/sites-available/ 并软链到 sites-enabled/。
server {
  listen 80;
  server_name _;
  root /var/www/blog;
  index index.html;

  # 静态产物没有后端，直接用文件；找不到再落到 404.html。
  location / {
    try_files $uri $uri/ $uri.html /404.html;
  }

  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  location ~* \\.(html|xml)$ {
    add_header Cache-Control "public, max-age=0, must-revalidate";
  }

  error_page 404 /404.html;

  gzip on;
  gzip_types text/html text/css application/javascript application/json application/xml image/svg+xml;
  gzip_min_length 256;
}
`,
    'deploy/Caddyfile': `# 由 \`emeeek deploy --target rsync\` 生成。
# Caddy 自动申请与续期 TLS 证书。
blog.example.com {
  root * /var/www/blog
  encode gzip
  try_files {path} {path}.html {path}/ /404.html
  file_server

  @assets path /assets/*
  header @assets Cache-Control "public, max-age=31536000, immutable"
}
`,
    'deploy/deploy-rsync.sh': `#!/usr/bin/env bash
# 由 \`emeeek deploy --target rsync\` 生成。
# 幂等：--delete 让远端与 dist/ 完全一致，重复执行不产生副作用。
set -euo pipefail

HOST="\${1:-user@server}"
REMOTE_PATH="\${2:-/var/www/blog}"

npx emeeek build
rsync -az --delete dist/ "\${HOST}:\${REMOTE_PATH}/"
echo "已同步到 \${HOST}:\${REMOTE_PATH}"
`,
  };
}

// ── Docker ────────────────────────────────────────────────────

function dockerFiles() {
  return {
    Dockerfile: `# 由 \`emeeek deploy --target docker\` 生成。
# 多阶段：构建用完整 Node，运行用 nginx:alpine —— 镜像里不留 node_modules。
FROM node:20-alpine AS build
WORKDIR /site
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund
COPY . .
RUN npx emeeek build

FROM nginx:alpine AS runtime
COPY --from=build /site/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
`,
    '.dockerignore': `node_modules
dist
.git
.github
*.log
`,
  };
}

function slugify(text) {
  return String(text).toLowerCase().trim().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'emeeek-site';
}

export { slugify };

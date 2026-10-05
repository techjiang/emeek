/**
 * 部署平台注册表。
 *
 * 每个平台只声明三件事：需要哪些构建期文件、怎么推送、部署后怎么验证。
 * 把「平台差异」全部收在这一处，deploy 命令本身不含任何 if (target === 'vercel')，
 * 新增平台只需往这里加一条 —— 这也是它能被单测逐个断言的原因。
 */

/** 部署后验证：访问这些路径，检查是否真的发布了。 */
const DEFAULT_PROBES = [
  { path: '/', label: '首页', expect: (body) => /<html/i.test(body) },
  { path: '/sitemap.xml', label: 'sitemap', expect: (body) => /<urlset/i.test(body) },
  { path: '/rss.xml', label: 'RSS', expect: (body) => /<rss/i.test(body) },
];

export const PLATFORMS = {
  'github-pages': {
    name: 'GitHub Pages',
    docs: 'docs/deployment.md#github-pages',
    // 配置由 deploy 命令生成到项目里；这里描述「文件名 → 内容」，
    // 生成逻辑保持纯函数，测试可以直接断言字符串内容。
    files: ['CNAME', '.nojekyll', '.github/workflows/deploy-pages.yml'],
    // 推送方式：GitHub Pages 走 Actions，本地不做 git push（避免污染用户历史）。
    mode: 'actions',
    previewSupport: true,
    hints: [
      '在仓库 Settings → Pages → Source 选择 “GitHub Actions”',
      '自定义域名：设定 deploy.customDomain 后 Emeek 会生成 CNAME',
    ],
  },
  cloudflare: {
    name: 'Cloudflare Pages',
    docs: 'docs/deployment.md#cloudflare-pages',
    files: ['wrangler.toml', 'public/_headers', 'public/_redirects'],
    mode: 'cli',
    // Cloudflare Pages 用 wrangler pages deploy <dir>；预览加 --branch。
    push: ({ preview }) => ['npx', ['wrangler', 'pages', 'deploy', 'dist', ...(preview ? ['--branch', 'preview'] : ['--branch', 'main'])]],
    previewSupport: true,
    hints: [
      '首次使用需 `npx wrangler login`，CI 里用 CLOUDFLARE_API_TOKEN',
      'wrangler.toml 里的 project name 可以改，但要与 Cloudflare 控制台一致',
    ],
  },
  vercel: {
    name: 'Vercel',
    docs: 'docs/deployment.md#vercel',
    files: ['vercel.json'],
    mode: 'cli',
    push: ({ preview }) => ['npx', ['vercel', 'deploy', 'dist', '--yes', ...(preview ? [] : ['--prod'])]],
    previewSupport: true,
    hints: [
      '首次使用需 `npx vercel login`，CI 里用 VERCEL_TOKEN / VERCEL_ORG_ID / VERCEL_PROJECT_ID',
      '--preview 不发布到生产域名，用于 PR 预览',
    ],
  },
  netlify: {
    name: 'Netlify',
    docs: 'docs/deployment.md#netlify',
    files: ['netlify.toml', 'public/_headers', 'public/_redirects'],
    mode: 'cli',
    push: ({ preview }) => ['npx', ['netlify', 'deploy', '--dir', 'dist', ...(preview ? ['--alias', 'preview'] : ['--prod'])]],
    previewSupport: true,
    hints: [
      '首次使用需 `npx netlify login`，CI 里用 NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID',
      'Deploy Previews 由 Netlify 侧自动生成，本地 --preview 只是给一个 alias',
    ],
  },
  rsync: {
    name: '自托管（rsync）',
    docs: 'docs/deployment.md#自托管',
    files: ['deploy/nginx.conf', 'deploy/Caddyfile', 'deploy/deploy-rsync.sh'],
    mode: 'push',
    // rsync 用 --delete 让远端与产物完全一致：漏删旧文件比漏传更隐蔽。
    // 参数名与 CLI flag 对齐：--host 与 --path。
    push: ({ host, path: remotePath }) => ['rsync', ['-az', '--delete', 'dist/', `${host}:${remotePath}/`]],
    previewSupport: false,
    requires: ["host", "path"],
    hints: [
      '--host user@server 与 --path /var/www/blog 必填',
      'SSL 用 deploy/Caddyfile（自动申请）或 nginx.conf + certbot',
    ],
  },
  docker: {
    name: 'Docker 镜像',
    docs: 'docs/deployment.md#docker',
    files: ['Dockerfile', '.dockerignore', 'deploy/nginx.conf'],
    mode: 'docker',
    push: ({ tag }) => ['docker', ['build', '-t', tag ?? 'emeeek-site:latest', '.']],
    previewSupport: false,
    hints: ['镜像基于 nginx:alpine + 静态文件，通常在 30MB 内', '运行：docker run -p 8080:80 emeeek-site:latest'],
  },
};

/** 平台别名：用户不必记住 `--target` 的确切拼写。 */
const ALIASES = {
  gh: 'github-pages',
  github: 'github-pages',
  pages: 'github-pages',
  cf: 'cloudflare',
  'cloudflare-pages': 'cloudflare',
  nginx: 'rsync',
  caddy: 'rsync',
  ssh: 'rsync',
  'self-hosted': 'rsync',
  'docker-image': 'docker',
};

export function normalizeTarget(target) {
  if (!target) return null;
  const key = String(target).toLowerCase().trim();
  return ALIASES[key] ?? (PLATFORMS[key] ? key : null);
}

export function listTargets() {
  return Object.entries(PLATFORMS).map(([key, value]) => ({ target: key, name: value.name, mode: value.mode }));
}

export function getPlatform(target) {
  const resolved = normalizeTarget(target);
  if (!resolved) {
    throw new Error(
      `不认识的部署目标：${target}\n  可用目标：${Object.keys(PLATFORMS).join(' / ')}\n  别名：${Object.keys(ALIASES).join(' / ')}`
    );
  }
  return { target: resolved, ...PLATFORMS[resolved] };
}

export function probesFor(target) {
  // 目前各平台探针一致；保留函数是为了将来给 Cloudflare Pages 之类的
  // 平台加差异化检查（例如 Functions 路由）时不必改调用方。
  getPlatform(target);
  return DEFAULT_PROBES;
}

export { DEFAULT_PROBES };

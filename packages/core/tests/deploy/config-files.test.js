import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDeployFiles, slugify } from '../../src/deploy/config-files.js';

const config = (extra = {}) => ({
  site: { title: 'My Blog', url: 'https://blog.techsauce.cn' },
  deploy: { customDomain: '' },
  ...extra,
});

test('未知平台不生成任何文件（不静默产出半成品）', () => {
  assert.deepEqual(generateDeployFiles('heroku', config()), {});
});

test('github-pages 生成 .nojekyll，因为 Jekyll 会吞掉下划线目录', () => {
  const files = generateDeployFiles('github-pages', config());
  assert.equal(files['.nojekyll'], '');
});

test('自定义域名存在时才生成 CNAME，且带尾部换行', () => {
  const without = generateDeployFiles('github-pages', config());
  assert.equal(without.CNAME, undefined);

  const with_ = generateDeployFiles('github-pages', config({ deploy: { customDomain: 'blog.x.cn' } }));
  assert.equal(with_.CNAME, 'blog.x.cn\n');
});

test('github-pages workflow 使用 Pages 官方 actions 且权限最小化', () => {
  const files = generateDeployFiles('github-pages', config());
  const yml = files['.github/workflows/deploy-pages.yml'];
  assert.match(yml, /actions\/upload-pages-artifact@v3/);
  assert.match(yml, /actions\/deploy-pages@v4/);
  assert.match(yml, /pages: write/);
  assert.match(yml, /id-token: write/);
  assert.match(yml, /contents: read/);
});

test('github-pages workflow 把 GITHUB_TOKEN 传给构建（Issues 源需要）', () => {
  const yml = generateDeployFiles('github-pages', config())['.github/workflows/deploy-pages.yml'];
  assert.match(yml, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

test('workflow 里的 \${{ }} 没有被 JS 模板吃掉（转义正确）', () => {
  const yml = generateDeployFiles('github-pages', config())['.github/workflows/deploy-pages.yml'];
  assert.ok(!yml.includes('undefined'), '不该出现 undefined');
  assert.match(yml, /\$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
});

test('cloudflare 生成 wrangler.toml 且项目名由标题 slug 化', () => {
  const files = generateDeployFiles('cloudflare', config());
  assert.match(files['wrangler.toml'], /name = "my-blog"/);
  assert.match(files['wrangler.toml'], /pages_build_output_dir = "dist"/);
});

test('cloudflare 项目名可通过 options.project 覆盖', () => {
  const files = generateDeployFiles('cloudflare', config(), { project: 'custom-proj' });
  assert.match(files['wrangler.toml'], /name = "custom-proj"/);
});

test('cloudflare 的 _headers 给静态资源长缓存、HTML 不缓存', () => {
  const headers = generateDeployFiles('cloudflare', config())['public/_headers'];
  assert.match(headers, /\/assets\/\*/);
  assert.match(headers, /immutable/);
  assert.match(headers, /must-revalidate/);
});

test('cloudflare 的 _redirects 把 404 交给 404.html', () => {
  const redirects = generateDeployFiles('cloudflare', config())['public/_redirects'];
  assert.match(redirects, /\/404\.html\s+404/);
});

test('vercel.json 是合法 JSON 且声明输出目录与构建命令', () => {
  const raw = generateDeployFiles('vercel', config())['vercel.json'];
  const json = JSON.parse(raw);
  assert.equal(json.outputDirectory, 'dist');
  assert.equal(json.buildCommand, 'npx emeeek build');
  assert.ok(Array.isArray(json.headers));
});

test('vercel.json 里没有第三方 SDK / 追踪脚本', () => {
  const raw = generateDeployFiles('vercel', config())['vercel.json'];
  assert.ok(!/analytics|gtag|segment|sentry/i.test(raw));
});

test('netlify.toml 声明 build 与 publish', () => {
  const toml = generateDeployFiles('netlify', config())['netlify.toml'];
  assert.match(toml, /publish = "dist"/);
  assert.match(toml, /command = "npx emeeek build"/);
});

test('自托管生成 nginx / Caddy / rsync 三件套', () => {
  const files = generateDeployFiles('rsync', config());
  assert.ok(files['deploy/nginx.conf']);
  assert.ok(files['deploy/Caddyfile']);
  assert.ok(files['deploy/deploy-rsync.sh']);
});

test('nginx 配置有 try_files 回落与 gzip', () => {
  const nginx = generateDeployFiles('rsync', config())['deploy/nginx.conf'];
  assert.match(nginx, /try_files/);
  assert.match(nginx, /gzip on/);
  assert.match(nginx, /error_page 404 \/404\.html/);
});

test('Caddy 配置自动 TLS（不依赖 certbot）', () => {
  const caddy = generateDeployFiles('rsync', config())['deploy/Caddyfile'];
  assert.match(caddy, /encode gzip/);
  assert.ok(!/certbot/.test(caddy), 'Caddy 不该需要 certbot');
});

test('rsync 脚本是幂等的（--delete）且用 set -euo pipefail', () => {
  const sh = generateDeployFiles('rsync', config())['deploy/deploy-rsync.sh'];
  assert.match(sh, /--delete/);
  assert.match(sh, /set -euo pipefail/);
});

test('Dockerfile 是多阶段构建，运行阶段基于 nginx:alpine', () => {
  const files = generateDeployFiles('docker', config());
  const dockerfile = files.Dockerfile;
  assert.match(dockerfile, /FROM node:20-alpine AS build/);
  assert.match(dockerfile, /FROM nginx:alpine AS runtime/);
  assert.match(dockerfile, /COPY --from=build \/site\/dist/);
});

test('Dockerfile 只把 dist 拷进运行镜像（不留 node_modules）', () => {
  const dockerfile = generateDeployFiles('docker', config()).Dockerfile;
  const runtimePart = dockerfile.split('AS runtime')[1];
  assert.ok(!/node_modules/.test(runtimePart), '运行阶段不该出现 node_modules');
});

test('.dockerignore 排除 node_modules 与 .git', () => {
  const ignore = generateDeployFiles('docker', config())['.dockerignore'];
  assert.match(ignore, /node_modules/);
  assert.match(ignore, /\.git/);
});

test('slugify 处理中文标题与标点', () => {
  assert.equal(slugify('My Blog'), 'my-blog');
  assert.equal(slugify('我的博客'), '我的博客');
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
  assert.equal(slugify(''), 'emeeek-site');
  assert.equal(slugify('!!!'), 'emeeek-site');
});

test('生成是纯函数：同样输入两次结果一致', () => {
  const a = generateDeployFiles('vercel', config());
  const b = generateDeployFiles('vercel', config());
  assert.deepEqual(a, b);
});

test('site.url 非法时也要能生成配置（hostOf 不抛）', () => {
  assert.doesNotThrow(() => generateDeployFiles('github-pages', { site: { url: 'not-a-url' } }));
});

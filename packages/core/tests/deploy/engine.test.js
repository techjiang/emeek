import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  plan,
  missingRequirements,
  prepare,
  verify,
  pushCommand,
  summarize,
  deploy,
  preflight,
} from '../../src/deploy/index.js';

const config = (extra = {}) => ({
  site: { title: 'My Blog', url: 'https://blog.techsauce.cn' },
  deploy: { customDomain: '' },
  ...extra,
});

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-deploy-'));
}

// ── plan ──────────────────────────────────────────────────────

test('plan 是纯计算：不写任何文件', async () => {
  const dir = await tmp();
  try {
    plan({ target: 'vercel', config: config() });
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('plan 归一别名并带上平台名', () => {
  const result = plan({ target: 'gh', config: config() });
  assert.equal(result.target, 'github-pages');
  assert.equal(result.name, 'GitHub Pages');
  assert.equal(result.mode, 'actions');
});

test('plan 自带探针与提示', () => {
  const result = plan({ target: 'cloudflare', config: config() });
  assert.equal(result.probes.length, 3);
  assert.ok(result.hints.some((h) => h.includes('wrangler')));
});

test('plan 尊重配置里的自定义探针', () => {
  const result = plan({ target: 'vercel', config: config({ deploy: { probes: [{ path: '/tags.html', label: '标签页' }] } }) });
  assert.deepEqual(result.probes.map((p) => p.path), ['/tags.html']);
});

test('plan 里的 preview 影响推送命令', () => {
  const prod = plan({ target: 'vercel', config: config() });
  const prev = plan({ target: 'vercel', config: config(), preview: true });
  assert.ok(prod.command.args.includes('--prod'));
  assert.ok(!prev.command.args.includes('--prod'));
});

test('summarize 生成人类可读的行，且不泄露 token', () => {
  const lines = summarize(plan({ target: 'netlify', config: config() }));
  const text = lines.join('\n');
  assert.match(text, /Netlify/);
  assert.match(text, /netlify\.toml/);
  assert.ok(!/token/i.test(text));
});

// ── missingRequirements ───────────────────────────────────────

test('rsync 缺 host/path 时列出缺失项', () => {
  const p = plan({ target: 'rsync', config: config() });
  assert.deepEqual(missingRequirements(p, {}), ['host', 'path']);
  assert.deepEqual(missingRequirements(p, { host: 'root@x' }), ['path']);
  assert.deepEqual(missingRequirements(p, { host: 'root@x', path: '/var/www' }), []);
});

test('非 rsync 平台不要求额外参数', () => {
  for (const target of ['github-pages', 'vercel', 'netlify', 'cloudflare', 'docker']) {
    assert.deepEqual(missingRequirements(plan({ target, config: config() }), {}), []);
  }
});

// ── prepare（幂等）────────────────────────────────────────────

test('prepare 写入配置文件并报告字节数', async () => {
  const dir = await tmp();
  try {
    const p = plan({ target: 'vercel', config: config() });
    const result = await prepare(dir, p);
    assert.equal(result.written.length, 1);
    assert.ok(result.written[0].bytes > 0);
    const content = await fs.readFile(path.join(dir, 'vercel.json'), 'utf8');
    assert.match(content, /outputDirectory/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('prepare 幂等：第二次调用跳过，不重写（mtime 不变）', async () => {
  const dir = await tmp();
  try {
    const p = plan({ target: 'github-pages', config: config() });
    await prepare(dir, p);
    const file = path.join(dir, '.nojekyll');
    const first = await fs.stat(file);

    await new Promise((r) => setTimeout(r, 20));
    const second = await prepare(dir, p);
    assert.equal(second.written.length, 0);
    assert.ok(second.skipped.includes('.nojekyll'));

    const after = await fs.stat(file);
    assert.equal(after.mtimeMs, first.mtimeMs, 'mtime 变了说明被重写了，幂等被破坏');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('prepare 内容变化时重写（幂等不是永不更新）', async () => {
  const dir = await tmp();
  try {
    await prepare(dir, plan({ target: 'github-pages', config: config() }));
    const changed = await prepare(dir, plan({ target: 'github-pages', config: config({ deploy: { customDomain: 'blog.x.cn' } }) }));
    assert.ok(changed.written.some((w) => w.file === 'CNAME'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('prepare dry-run 不写盘但报告将写入', async () => {
  const dir = await tmp();
  try {
    const result = await prepare(dir, plan({ target: 'vercel', config: config() }), { dryRun: true });
    assert.equal(result.written.length, 1);
    assert.equal(result.written[0].dryRun, true);
    await assert.rejects(fs.access(path.join(dir, 'vercel.json')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('prepare 能按 only 过滤文件', async () => {
  const dir = await tmp();
  try {
    const result = await prepare(dir, plan({ target: 'netlify', config: config() }), { only: ['netlify.toml'] });
    assert.deepEqual(result.written.map((w) => w.file), ['netlify.toml']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── verify ────────────────────────────────────────────────────

function fakeFetch(pages) {
  return async (url) => {
    const body = pages[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => body };
  };
}

test('verify 全绿当所有探针命中', async () => {
  const fetchImpl = fakeFetch({
    'https://x.cn/': '<html>hi</html>',
    'https://x.cn/sitemap.xml': '<urlset></urlset>',
    'https://x.cn/rss.xml': '<rss></rss>',
  });
  const result = await verify({ baseUrl: 'https://x.cn', probes: plan({ target: 'vercel', config: config() }).probes, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 3);
});

test('verify 遇到 404 会报红并给出原因', async () => {
  const fetchImpl = fakeFetch({ 'https://x.cn/': '<html>hi</html>' });
  const result = await verify({ baseUrl: 'https://x.cn', probes: plan({ target: 'vercel', config: config() }).probes, fetchImpl });
  assert.equal(result.ok, false);
  const failed = result.results.find((r) => !r.ok);
  assert.match(failed.reason, /404/);
});

test('verify 对内容不符预期（返回了 404 页面但 HTTP 200）也报红', async () => {
  // 这是最阴险的一种：静态托管「找不到」时回落到 404.html 但状态码 200。
  const fetchImpl = fakeFetch({
    'https://x.cn/': '<html>hi</html>',
    'https://x.cn/sitemap.xml': '<html>这是 404 页面</html>',
    'https://x.cn/rss.xml': '<rss></rss>',
  });
  const result = await verify({ baseUrl: 'https://x.cn', probes: plan({ target: 'vercel', config: config() }).probes, fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.results.find((r) => r.label === 'sitemap' && !r.ok));
});

test('verify 把 baseUrl 尾部斜杠规整，不产生双斜杠', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => '<html><urlset><rss>' }; };
  await verify({ baseUrl: 'https://x.cn/', probes: [{ path: '/', label: '首页' }], fetchImpl });
  assert.deepEqual(seen, ['https://x.cn/']);
});

test('verify 网络异常被捕获成一条失败记录，不抛出', async () => {
  const fetchImpl = async () => { throw new Error('ENOTFOUND'); };
  const result = await verify({ baseUrl: 'https://nope.cn', probes: [{ path: '/', label: '首页' }], fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.results[0].reason, /ENOTFOUND/);
});

test('verify 无 baseUrl 直接报错（而不是静默通过）', async () => {
  await assert.rejects(verify({ baseUrl: null }), /baseUrl/);
});

// ── pushCommand ───────────────────────────────────────────────

test('github-pages 没有本地推送命令（走 Actions）', () => {
  assert.equal(pushCommand(plan({ target: 'github-pages', config: config() })), null);
});

test('cli 平台返回 { bin, args }', () => {
  const cmd = pushCommand(plan({ target: 'vercel', config: config() }));
  assert.equal(cmd.bin, 'npx');
  assert.ok(cmd.args.includes('vercel'));
});

// ── deploy 编排 ───────────────────────────────────────────────

test('deploy 在 rsync 缺参数时立即报错，不进入构建', async () => {
  let built = false;
  await assert.rejects(
    deploy({ target: 'rsync', config: config(), buildFn: async () => { built = true; } }),
    /--host/
  );
  assert.equal(built, false, '参数没齐就不该开始构建');
});

test('deploy 走完 build → preflight → prepare → push → verify 五阶段', async () => {
  const dir = await tmp();
  try {
    const dist = path.join(dir, 'dist');
    await seedDist(dist);
    const events = [];
    const result = await deploy({
      cwd: dir,
      target: 'vercel',
      config: config({ output: { dir: 'dist' } }),
      baseUrl: 'https://blog.techsauce.cn',
      buildFn: async () => ({ posts: 3, pages: 10 }),
      runCommand: async () => ({ code: 0 }),
      fetchImpl: fakeFetch({
        'https://blog.techsauce.cn/': '<html></html>',
        'https://blog.techsauce.cn/sitemap.xml': '<urlset></urlset>',
        'https://blog.techsauce.cn/rss.xml': '<rss></rss>',
      }),
      onEvent: (e) => events.push(`${e.phase}:${e.status}`),
    });
    assert.deepEqual(events, [
      'build:start', 'build:done',
      'preflight:start', 'preflight:done',
      'prepare:start', 'prepare:done',
      'push:start', 'push:done',
      'verify:start', 'verify:done',
    ]);
    assert.equal(result.verification.ok, true);
    assert.equal(result.pushResult.skipped, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy 在 preflight 失败时中止，绝不推送', async () => {
  const dir = await tmp();
  try {
    let pushed = false;
    await assert.rejects(
      deploy({
        cwd: dir,
        target: 'vercel',
        config: config({ output: { dir: 'dist' } }),
        skipBuild: true,
        runCommand: async () => { pushed = true; return { code: 0 }; },
      }),
      /部署前检查未通过/
    );
    assert.equal(pushed, false, '产物不合格时不该推送');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy dry-run 不推送、不验证、不改盘', async () => {
  const dir = await tmp();
  try {
    await seedDist(path.join(dir, 'dist'));
    const result = await deploy({
      cwd: dir,
      target: 'github-pages',
      config: config({ output: { dir: 'dist' } }),
      dryRun: true,
      skipBuild: true,
    });
    assert.equal(result.pushResult.skipped, true);
    assert.equal(result.verification, null);
    await assert.rejects(fs.access(path.join(dir, '.nojekyll')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy 推送失败时抛出，且带重试命令', async () => {
  const dir = await tmp();
  try {
    await seedDist(path.join(dir, 'dist'));
    await assert.rejects(
      deploy({
        cwd: dir,
        target: 'vercel',
        config: config({ output: { dir: 'dist' } }),
        skipBuild: true,
        runCommand: async () => ({ code: 1 }),
      }),
      /推送失败/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── preflight ─────────────────────────────────────────────────

test('preflight 缺关键产物时逐条报红', async () => {
  const dir = await tmp();
  try {
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    const result = await preflight(path.join(dir, 'dist'), { config: config() });
    assert.equal(result.ok, false);
    assert.ok(result.checks.find((c) => c.name === '首页' && !c.ok));
    assert.ok(result.checks.find((c) => c.name.includes('404') && !c.ok));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('preflight 拦截 example.com 占位域名（部署后才暴露的典型坑）', async () => {
  const dir = await tmp();
  try {
    await seedDist(path.join(dir, 'dist'));
    const result = await preflight(path.join(dir, 'dist'), { config: { site: { url: 'https://example.com' } } });
    assert.equal(result.ok, false);
    const check = result.checks.find((c) => c.name === '站点地址已配置');
    assert.equal(check.ok, false);
    assert.match(check.hint, /真实域名/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('preflight 对空站点（无任何文章）报红', async () => {
  const dir = await tmp();
  try {
    const dist = path.join(dir, 'dist');
    await seedDist(dist, { posts: false });
    await fs.mkdir(path.join(dist, 'posts'), { recursive: true });
    const result = await preflight(dist, { config: config() });
    assert.equal(result.ok, false);
    assert.ok(result.checks.find((c) => c.name === '至少有一篇文章' && !c.ok));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('preflight 全绿当产物完整且域名真实', async () => {
  const dir = await tmp();
  try {
    const dist = path.join(dir, 'dist');
    await seedDist(dist);
    const result = await preflight(dist, { config: config() });
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('preflight 在 search 关闭时不要求 search-index.json', async () => {
  const dir = await tmp();
  try {
    const dist = path.join(dir, 'dist');
    await seedDist(dist, { searchIndex: false });
    const result = await preflight(dist, { config: config({ search: { enabled: false } }) });
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** 造一份「合格」的产物，供 preflight / deploy 测试使用。 */
async function seedDist(dist, { posts = true, searchIndex = true } = {}) {
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(path.join(dist, 'index.html'), '<html></html>');
  await fs.writeFile(path.join(dist, '404.html'), '<html>404</html>');
  await fs.writeFile(path.join(dist, 'sitemap.xml'), '<urlset></urlset>');
  await fs.writeFile(path.join(dist, 'rss.xml'), '<rss></rss>');
  await fs.writeFile(path.join(dist, 'robots.txt'), 'User-agent: *');
  if (searchIndex) await fs.writeFile(path.join(dist, 'search-index.json'), '[]');
  if (posts) {
    await fs.mkdir(path.join(dist, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dist, 'posts', 'a.html'), '<html>post</html>');
  }
}

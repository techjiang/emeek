import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTarget, getPlatform, listTargets, probesFor, PLATFORMS } from '../../src/deploy/platforms.js';

test('六个部署目标都在注册表里', () => {
  const targets = listTargets().map((t) => t.target);
  for (const expected of ['github-pages', 'cloudflare', 'vercel', 'netlify', 'rsync', 'docker']) {
    assert.ok(targets.includes(expected), `缺少目标 ${expected}`);
  }
});

test('别名归一到规范目标名', () => {
  assert.equal(normalizeTarget('gh'), 'github-pages');
  assert.equal(normalizeTarget('GitHub'), 'github-pages');
  assert.equal(normalizeTarget('  CF '), 'cloudflare');
  assert.equal(normalizeTarget('cloudflare-pages'), 'cloudflare');
  assert.equal(normalizeTarget('ssh'), 'rsync');
  assert.equal(normalizeTarget('self-hosted'), 'rsync');
});

test('大小写与空白不影响识别', () => {
  assert.equal(normalizeTarget('VERCEL'), 'vercel');
  assert.equal(normalizeTarget('netlify'), 'netlify');
});

test('未知目标返回 null（由调用方决定如何报错）', () => {
  assert.equal(normalizeTarget('heroku'), null);
  assert.equal(normalizeTarget(''), null);
  assert.equal(normalizeTarget(undefined), null);
});

test('getPlatform 对未知目标抛出含可用列表的错误', () => {
  assert.throws(() => getPlatform('heroku'), /不认识的部署目标/);
  assert.throws(() => getPlatform('heroku'), /github-pages/);
});

test('每个平台都声明了 name / docs / mode', () => {
  for (const [key, platform] of Object.entries(PLATFORMS)) {
    assert.equal(typeof platform.name, 'string', `${key} 缺 name`);
    assert.equal(typeof platform.docs, 'string', `${key} 缺 docs`);
    assert.ok(['actions', 'cli', 'push', 'docker'].includes(platform.mode), `${key} mode 非法`);
  }
});

test('只有 github-pages 用 actions 模式，其余都有本地推送命令', () => {
  for (const [key, platform] of Object.entries(PLATFORMS)) {
    if (key === 'github-pages') assert.equal(platform.mode, 'actions');
    else assert.notEqual(platform.mode, 'actions', `${key} 不该是 actions`);
  }
});

test('rsync 声明了必填参数，其余平台不强制', () => {
  assert.deepEqual(PLATFORMS.rsync.requires, ['host', 'path']);
  assert.equal(PLATFORMS.vercel.requires, undefined);
  assert.equal(PLATFORMS['github-pages'].requires, undefined);
});

test('探针覆盖首页 / sitemap / RSS 三条生命线', () => {
  const probes = probesFor('github-pages');
  const paths = probes.map((p) => p.path);
  assert.deepEqual(paths, ['/', '/sitemap.xml', '/rss.xml']);
});

test('探针的 expect 谓词能区分真页面与错误页', () => {
  const [home, sitemap, rss] = probesFor('vercel');
  assert.equal(home.expect('<html lang="zh">'), true);
  assert.equal(home.expect('Not Found'), false);
  assert.equal(sitemap.expect('<?xml?><urlset></urlset>'), true);
  assert.equal(sitemap.expect('<html>404</html>'), false);
  assert.equal(rss.expect('<rss version="2.0"></rss>'), true);
  assert.equal(rss.expect('unauthorized'), false);
});

test('platforms.push 生成的命令在 preview 下换分支/别名', () => {
  const prod = PLATFORMS.vercel.push({ preview: false });
  const prev = PLATFORMS.vercel.push({ preview: true });
  assert.ok(prod[1].includes('--prod'));
  assert.ok(!prev[1].includes('--prod'));
});

test('cloudflare 的推送带 --branch，预览与生产不同分支', () => {
  assert.deepEqual(PLATFORMS.cloudflare.push({ preview: false })[1].slice(-2), ['--branch', 'main']);
  assert.deepEqual(PLATFORMS.cloudflare.push({ preview: true })[1].slice(-2), ['--branch', 'preview']);
});

test('rsync 推送使用 --delete（远端收敛，幂等）', () => {
  const [bin, args] = PLATFORMS.rsync.push({ host: 'root@1.2.3.4', path: '/var/www/blog' });
  assert.equal(bin, 'rsync');
  assert.ok(args.includes('--delete'));
  assert.ok(args.includes('root@1.2.3.4:/var/www/blog/'));
});

test('docker 推送用 --tag 覆盖镜像名，默认 emeek-site', () => {
  assert.deepEqual(PLATFORMS.docker.push({})[1], ['build', '-t', 'emeeek-site:latest', '.']);
  assert.deepEqual(PLATFORMS.docker.push({ tag: 'myblog:v1' })[1], ['build', '-t', 'myblog:v1', '.']);
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCdnClient, buildPurgeTargets, buildWarmTargets } from '../../src/accel/cdn-client.js';

function recorder() {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };
  return { calls, fetchImpl };
}

describe('CDN 客户端', () => {
  test('purge 打到该 provider 的刷新端点，带 Bearer token', async () => {
    const { calls, fetchImpl } = recorder();
    const client = createCdnClient({
      providerId: 'cloudflare',
      config: { zoneId: 'zone-1' },
      credentials: { apiKey: 'secret-token' },
      fetchImpl,
    });
    const result = await client.purge(['https://blog.test/']);
    assert.equal(result.ok, true);
    assert.match(calls[0].url, /zones\/zone-1\/purge_cache/);
    assert.equal(calls[0].request.headers.Authorization, 'Bearer secret-token');
    assert.match(calls[0].request.body, /https:\/\/blog\.test\//);
  });

  test('凭据可注入替身 —— 不注入就无法在 CI 中断言', async () => {
    const { calls, fetchImpl } = recorder();
    const client = createCdnClient({ providerId: 'custom', config: { purgeEndpoint: 'https://my.test/purge' }, credentials: {}, fetchImpl });
    await client.purge(['https://blog.test/']);
    assert.equal(calls[0].url, 'https://my.test/purge');
  });

  test('cloudflare 无预热接口 → 明确 skipped 而非静默成功', async () => {
    const client = createCdnClient({ providerId: 'cloudflare', config: {}, credentials: {}, fetchImpl: recorder().fetchImpl });
    const result = await client.warm(['https://blog.test/']);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /无预热接口|未提供/);
  });

  test('阿里云有预热接口', async () => {
    const { calls, fetchImpl } = recorder();
    const client = createCdnClient({ providerId: 'aliyun', config: { domain: 'cdn.x.cn' }, credentials: {}, fetchImpl });
    const result = await client.warm(['https://cdn.x.cn/']);
    assert.equal(result.ok, true);
    assert.match(calls[0].url, /PushObjectCache/);
  });

  test('HTTP 错误被如实上报（不吞）', async () => {
    const client = createCdnClient({
      providerId: 'cloudflare',
      config: { zoneId: 'z' },
      credentials: { apiKey: 'k' },
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => '{"errors":[{"code":10000}]}' }),
    });
    const result = await client.purge(['https://x/']);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });

  test('URL 目标只含 HTML 与数据入口，默认不含指纹资源', () => {
    const targets = buildPurgeTargets('https://blog.test', {
      files: ['/index.html', '/posts/a.html', '/search-index.json', '/assets/x.abc12345.css'],
    });
    assert.ok(targets.includes('https://blog.test/index.html'));
    assert.ok(targets.includes('https://blog.test/search-index.json'));
    assert.ok(!targets.includes('https://blog.test/assets/x.abc12345.css'));
    assert.ok(targets.includes('https://blog.test/'));
  });

  test('includeAssets 时连指纹资源一起刷', () => {
    const targets = buildPurgeTargets('https://blog.test', { files: ['/assets/x.abc12345.css'], includeAssets: true });
    assert.ok(targets.includes('https://blog.test/assets/x.abc12345.css'));
  });

  test('预热目标是入口页 + 最近文章', () => {
    const targets = buildWarmTargets('https://blog.test', {
      posts: [{ url: '/posts/a.html' }, { url: '/posts/b.html' }],
      extra: ['/sitemap.xml'],
    });
    assert.ok(targets.includes('https://blog.test/'));
    assert.ok(targets.includes('https://blog.test/archive.html'));
    assert.ok(targets.includes('https://blog.test/posts/a.html'));
    assert.ok(targets.includes('https://blog.test/sitemap.xml'));
  });

  test('没有 siteUrl 时返回空目标（而不是拼出畸形 URL）', () => {
    assert.deepEqual(buildPurgeTargets('', { files: ['/a.html'] }), []);
    assert.deepEqual(buildWarmTargets(null, {}), []);
  });
});

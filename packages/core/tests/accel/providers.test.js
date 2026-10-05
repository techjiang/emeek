import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, PROVIDER_IDS, getProvider, validateCdnConfig, readCredentialsFromEnv } from '../../src/accel/providers.js';

describe('CDN 提供商注册表', () => {
  test('四个提供商都在（cloudflare/aliyun/tencent/custom）', () => {
    assert.deepEqual(PROVIDER_IDS.sort(), ['aliyun', 'cloudflare', 'custom', 'tencent']);
  });

  test('每个提供商都有完整元数据 —— 新增平台不用改调用侧', () => {
    for (const id of PROVIDER_IDS) {
      const p = PROVIDERS[id];
      assert.equal(p.id, id);
      assert.ok(p.name, `${id} 缺 name`);
      assert.ok(Array.isArray(p.fields), `${id} 缺 fields`);
      assert.equal(typeof p.buildHeaders, 'function', `${id} 缺 buildHeaders`);
      assert.equal(typeof p.chinaAccess, 'boolean', `${id} 缺 chinaAccess`);
      assert.equal(typeof p.requiresIcp, 'boolean', `${id} 缺 requiresIcp`);
    }
  });

  test('中国大陆加速能力标注正确', () => {
    assert.equal(PROVIDERS.aliyun.chinaAccess, true);
    assert.equal(PROVIDERS.tencent.chinaAccess, true);
    assert.equal(PROVIDERS.cloudflare.chinaAccess, false, 'Cloudflare 免费套餐无大陆节点');
    assert.equal(PROVIDERS.aliyun.requiresIcp, true);
  });

  test('getProvider 对未知 id 报错并列出可用项', () => {
    assert.throws(() => getProvider('nope'), /未知的 CDN 提供商/);
    assert.throws(() => getProvider('nope'), /cloudflare/);
  });

  test('API Key 写进配置 → 直接报错（负向验证）', () => {
    const { errors } = validateCdnConfig({ enabled: true, provider: 'cloudflare', apiKey: 'sk-leak' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'cdn.apiKey');
    assert.match(errors[0].message, /不能写进配置文件/);
  });

  test('阿里云 secret 同理被拒', () => {
    const { errors } = validateCdnConfig({ enabled: true, provider: 'aliyun', accessKeySecret: 'x' });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /ALIYUN_ACCESS_KEY_SECRET/);
  });

  test('未备案 + 国内 CDN → 警告（不是静默通过）', () => {
    const { warnings } = validateCdnConfig({ enabled: true, provider: 'aliyun', domain: 'cdn.x.cn', icp: false });
    assert.ok(warnings.some((w) => /ICP 备案/.test(w.message)));
  });

  test('Cloudflare + 开启大陆加速 → 提示换 provider', () => {
    const { warnings } = validateCdnConfig({
      enabled: true, provider: 'cloudflare', zone: 'x.cn', china: { enabled: true },
    });
    assert.ok(warnings.some((w) => /免费套餐不含中国大陆节点/.test(w.message)));
  });

  test('cdn.enabled=false 时完全不校验', () => {
    assert.deepEqual(validateCdnConfig({ enabled: false, provider: 'nope' }), { errors: [], warnings: [] });
  });

  test('provider 未配置不是错误 —— 降级加速不需要 CDN', () => {
    assert.deepEqual(validateCdnConfig({ enabled: true, provider: null }), { errors: [], warnings: [] });
    assert.deepEqual(validateCdnConfig({ enabled: true }), { errors: [], warnings: [] });
  });

  test('readCredentialsFromEnv 只返回存在的，缺的进 missing', () => {
    const { values, missing } = readCredentialsFromEnv('cloudflare', { CF_API_KEY: 'k' });
    assert.equal(values.apiKey, 'k');
    assert.equal(values.zoneId, undefined);
    assert.deepEqual(missing.map((m) => m.env), ['CF_ZONE_ID']);
  });

  test('buildHeaders 生成三类缓存语义', () => {
    const h = PROVIDERS.cloudflare.buildHeaders({
      immutable: 'immutable', html: 'html', data: 'data', noStore: 'no-store',
    });
    assert.ok(JSON.stringify(h).includes('immutable'));
  });
});

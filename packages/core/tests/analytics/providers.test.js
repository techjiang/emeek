import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYTICS_PROVIDERS, PROVIDER_IDS, getAnalyticsProvider,
  validateAnalyticsConfig, buildAnalyticsScripts, listScriptOrigins,
} from '../../src/analytics/providers.js';

describe('分析 provider 注册表', () => {
  test('注册表含全部文档里承诺的 provider', () => {
    for (const id of ['builtin', 'plausible', 'umami', 'goatcounter', 'custom']) {
      assert.ok(ANALYTICS_PROVIDERS[id], `缺少 provider ${id}`);
      assert.equal(ANALYTICS_PROVIDERS[id].id, id, 'provider.id 必须与键一致');
      assert.equal(typeof ANALYTICS_PROVIDERS[id].build, 'function');
      assert.ok(Array.isArray(ANALYTICS_PROVIDERS[id].requires));
    }
    assert.deepEqual(PROVIDER_IDS.sort(), ['builtin', 'custom', 'goatcounter', 'plausible', 'umami']);
  });

  test('builtin 的 build 永远返回空片段（它是「零请求」的那个）', () => {
    const out = ANALYTICS_PROVIDERS.builtin.build({ trackPageViews: true, endpoint: 'https://x.test/c' });
    assert.equal(out.head, '');
    assert.equal(out.footer, '');
  });

  test('每个 provider 的 origin 要么是域名、要么明确为 null', () => {
    for (const p of Object.values(ANALYTICS_PROVIDERS)) {
      assert.ok(p.origin === null || typeof p.origin === 'string', `${p.id} 的 origin 形状不对`);
    }
    assert.deepEqual(listScriptOrigins(), ['gc.zgo.at', 'goatcounter.com', 'plausible.io']);
  });
});

describe('provider 脚本生成', () => {
  test('plausible：注入的域与配置一致，且 defer', () => {
    const { head } = ANALYTICS_PROVIDERS.plausible.build({ domain: 'blog.example.com' });
    assert.match(head, /data-domain="blog\.example\.com"/);
    assert.match(head, /src="https:\/\/plausible\.io\/js\/script\.js"/);
    assert.match(head, /\bdefer\b/, '统计脚本必须 defer —— 不能挡首屏');
  });

  test('plausible：domain 里的引号被转义（不能借此跳出属性）', () => {
    const { head } = ANALYTICS_PROVIDERS.plausible.build({ domain: '"><script>alert(1)</script>' });
    assert.ok(!head.includes('<script>alert'), '注入内容不得形成新的 script 标签');
    assert.match(head, /data-domain="&quot;&gt;&lt;script&gt;/);
  });

  test('plausible：scriptSrc 允许自托管，但非 http(s) 一律拒绝', () => {
    const ok = ANALYTICS_PROVIDERS.plausible.build({
      domain: 'a.test', scriptSrc: 'https://analytics.self.hosted/js/script.js',
    });
    assert.match(ok.head, /analytics\.self\.hosted/);
    assert.throws(
      () => ANALYTICS_PROVIDERS.plausible.build({ domain: 'a.test', scriptSrc: 'javascript:alert(1)' }),
      /http\(s\)/,
    );
  });

  test('umami：websiteId 与 scriptSrc 都进产物', () => {
    const { head } = ANALYTICS_PROVIDERS.umami.build({
      websiteId: 'abc-123', scriptSrc: 'https://umami.example.com/umami.js',
    });
    assert.match(head, /data-website-id="abc-123"/);
    assert.match(head, /src="https:\/\/umami\.example\.com\/umami\.js"/);
  });

  test('goatcounter：code 只接受安全字符（它要拼进域名）', () => {
    const { head } = ANALYTICS_PROVIDERS.goatcounter.build({ code: 'myblog' });
    assert.match(head, /https:\/\/myblog\.goatcounter\.com\/count/);
    assert.throws(
      () => ANALYTICS_PROVIDERS.goatcounter.build({ code: 'evil.com/x' }),
      /只能包含/,
    );
  });

  test('custom：代码原样注入，但 </script> 被打散', () => {
    const { head, footer } = ANALYTICS_PROVIDERS.custom.build({
      headScript: 'window.x=1;',
      footerScript: 'var s="</script>";',
    });
    assert.match(head, /^<script>window\.x=1;<\/script>$/);
    // 关键：脚本体内的 </script 不再出现，否则脚本块被提前结束 → XSS。
    assert.ok(!footer.includes('</script>";'), '内联脚本里的 </script> 必须被打散');
    assert.match(footer, /<\\\/script>/);
    assert.ok(footer.endsWith('</script>'), '最外层闭合标签必须保留');
  });

  test('custom：空代码不产出空 script 标签', () => {
    const { head, footer } = ANALYTICS_PROVIDERS.custom.build({});
    assert.equal(head, '');
    assert.equal(footer, '');
  });

  test('getAnalyticsProvider 对未知 id 返回 null（不抛）', () => {
    assert.equal(getAnalyticsProvider('nope'), null);
    assert.equal(getAnalyticsProvider('builtin').id, 'builtin');
  });
});

describe('分析配置校验', () => {
  test('enabled 不是 true 时直接放行 —— 关掉的功能不该因为残留参数报错', () => {
    for (const value of [undefined, false, 'yes', 1]) {
      const { errors } = validateAnalyticsConfig({ enabled: value, provider: 'nope' });
      assert.deepEqual(errors, [], `enabled=${value} 时不应报错`);
    }
  });

  test('未知 provider 报错（枚举必须与注册表一致）', () => {
    const { errors } = validateAnalyticsConfig({ enabled: true, provider: 'google-analytics' });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /未知的分析服务/);
    assert.match(errors[0].message, /builtin/, '错误信息应列出可选值');
  });

  test('缺必填项报错，路径指到具体哪一项', () => {
    const { errors } = validateAnalyticsConfig({ enabled: true, provider: 'plausible', plausible: {} });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'analytics.plausible.domain');
  });

  test('builtin + trackPageViews 给警告（提醒 endpoint 必须自托管）', () => {
    const { errors, warnings } = validateAnalyticsConfig({
      enabled: true, provider: 'builtin', builtin: { trackPageViews: true },
    });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => w.path === 'analytics.builtin.trackPageViews'));
  });

  test('非 builtin 时内置探针不生效，且给出明确警告（不是静默）', () => {
    const { warnings } = validateAnalyticsConfig({
      enabled: true, provider: 'plausible', plausible: { domain: 'a.test' }, builtin: { trackPageViews: true },
    });
    assert.ok(warnings.some((w) => /不会生效/.test(w.message)), '被忽略的配置必须说出来');
  });
});

describe('buildAnalyticsScripts —— 零追踪的唯一实现点', () => {
  test('★ 未开启时返回两个空串，provider 也是 null', () => {
    for (const cfg of [{}, { enabled: false }, { enabled: false, provider: 'plausible', plausible: { domain: 'x' } }]) {
      const out = buildAnalyticsScripts(cfg);
      assert.equal(out.head, '', '未开启时不得注入任何 head 脚本');
      assert.equal(out.footer, '', '未开启时不得注入任何 footer 脚本');
      assert.equal(out.provider, null);
      assert.equal(out.origin, null);
    }
  });

  test('builtin 开启但不开 PV：两段仍然都是空（零请求）', () => {
    const out = buildAnalyticsScripts({ enabled: true, provider: 'builtin', builtin: { trackPageViews: false } });
    assert.equal(out.head, '');
    assert.equal(out.footer, '');
    assert.equal(out.provider, 'builtin');
    assert.equal(out.origin, null);
  });

  test('校验失败直接抛错，不注入半残脚本', () => {
    assert.throws(
      () => buildAnalyticsScripts({ enabled: true, provider: 'umami', umami: {} }),
      /分析配置校验失败/,
    );
  });

  test('builtin + PV：走注入的探针 buildProbe，并暴露 origin', () => {
    const out = buildAnalyticsScripts(
      { enabled: true, provider: 'builtin', builtin: { trackPageViews: true, endpoint: 'https://c.example.com/hit' } },
      { buildProbe: () => ({ tag: '<script>probe()</script>', origin: 'https://c.example.com' }) },
    );
    assert.match(out.footer, /probe\(\)/);
    assert.equal(out.origin, 'https://c.example.com', '数据发往哪个域必须可断言');
  });

  test('custom provider 时 origin 是 null（域名由用户决定，我们不能替它声明）', () => {
    const out = buildAnalyticsScripts({ enabled: true, provider: 'custom', custom: { headScript: 'x()' } });
    assert.equal(out.origin, null);
    assert.equal(out.provider, 'custom');
  });
});

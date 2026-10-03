import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStudioServer } from '../src/studio/server.js';

/**
 * Studio 的主题配置接口（P3-1b-3b feature D）。
 *
 * 两个端点：读描述符与生效值 / 校验一份运行时覆盖。
 * 这里重点验「校验真的会拒」—— 面板能改但不能改坏，是这条链的底线。
 */

const META = {
  name: 'demo',
  config: {
    colors: { primary: { type: 'color', default: '#111111' }, accent: { type: 'color', default: '#2563eb' } },
    typography: { fontSize: { type: 'number', default: 16, min: 12, max: 24 } },
    layout: { sidebar: { type: 'boolean', default: true } },
    features: { darkMode: { type: 'select', options: ['auto', 'light', 'dark'], default: 'auto' } },
  },
};

describe('Studio 主题配置接口', () => {
  let instance;
  let base;

  before(async () => {
    instance = await createStudioServer({
      port: 0,
      host: '127.0.0.1',
      build: async () => ({ posts: 0, siteIndex: { titles: [] } }),
      themeProvider: async () => ({ meta: META, values: { 'colors.primary': '#111111', 'typography.fontSize': 16 } }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    base = `http://127.0.0.1:${instance.port}`;
  });

  after(async () => { await instance?.close(); });

  test('GET /__studio/theme/config 返回描述符与生效值', async () => {
    const res = await fetch(`${base}/__studio/theme/config`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.available, true);
    assert.equal(payload.meta.name, 'demo');
    assert.equal(payload.meta.config.colors.primary.type, 'color');
    assert.equal(payload.values['colors.primary'], '#111111');
  });

  test('POST /__studio/theme/override 接受合法值', async () => {
    const res = await fetch(`${base}/__studio/theme/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: { colors: { primary: '#ff0000' }, typography: { fontSize: 20 } } }),
    });
    const payload = await res.json();
    assert.equal(payload.accepted['colors.primary'], '#ff0000');
    assert.equal(payload.accepted['typography.fontSize'], 20);
    assert.deepEqual(payload.rejected, []);
  });

  test('非法值被拒绝且带原因（不静默）', async () => {
    const res = await fetch(`${base}/__studio/theme/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: { colors: { primary: 'red; } x {' }, features: { darkMode: 'bogus' } } }),
    });
    const payload = await res.json();
    assert.equal(payload.rejected.length, 2);
    for (const item of payload.rejected) assert.ok(item.reason);
  });

  test('请求体不是 JSON 时返回 400', async () => {
    const res = await fetch(`${base}/__studio/theme/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
  });
});

describe('Studio 主题配置接口：无 provider 时', () => {
  let instance;
  let base;
  before(async () => {
    instance = await createStudioServer({
      port: 0, host: '127.0.0.1',
      build: async () => ({ posts: 0 }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    base = `http://127.0.0.1:${instance.port}`;
  });
  after(async () => { await instance?.close(); });

  test('没有 themeProvider 时 available=false（面板不显示假界面）', async () => {
    const payload = await (await fetch(`${base}/__studio/theme/config`)).json();
    assert.equal(payload.available, false);
  });
});

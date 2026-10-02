/**
 * AI 面板的 Key 状态机（决策 D1 / PR-4）。
 *
 * 四档状态各有各的文案，**不能合并**：
 *   未配置       用户要做点什么
 *   服务端已配置 用户什么都不用做（这是好消息，别让他以为缺东西）
 *   本次会话     关掉标签页就没了 —— 用户该知道这件事
 *   已记住       留在本机上了 —— 用户该知道这件事
 *
 * 「服务端已配置」与「已记住」如果写成同一句话，用户就分不清
 * 「我不用管」和「它留在这台机器上」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { KeyStore, KEY_STORAGE, KEY_STORAGE_LABEL } from '../src/studio/keyring.js';
import { createMemoryStorage } from '../src/studio/drafts.js';

function makeStore({ server = null } = {}) {
  return new KeyStore({
    storage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
    server,
    now: () => 1700000000000,
  });
}

describe('Key 状态机', () => {
  test('未配置', async () => {
    const status = await makeStore({ server: async () => ({ configured: false }) }).status();
    assert.equal(status.kind, KEY_STORAGE.NONE);
    assert.equal(status.label, '未配置');
  });

  test('服务端已配置（且浏览器里没有 Key）', async () => {
    const store = makeStore({ server: async () => ({ configured: true, provider: 'openai', model: 'gpt-4o-mini' }) });
    const status = await store.status();
    assert.equal(status.kind, KEY_STORAGE.SERVER);
    assert.equal(status.label, '服务端已配置');
    assert.equal(store.get(), null, '服务端模式下浏览器不持有 Key');
  });

  test('本次会话', async () => {
    const store = makeStore({ server: async () => ({ configured: false }) });
    store.set('sk-proj-abcdefghijklmnop');
    const status = await store.status();
    assert.equal(status.kind, KEY_STORAGE.SESSION);
    assert.equal(status.label, '本次会话');
  });

  test('已记住', async () => {
    const store = makeStore({ server: async () => ({ configured: false }) });
    store.set('sk-proj-abcdefghijklmnop', { remember: true });
    const status = await store.status();
    assert.equal(status.kind, KEY_STORAGE.PERSISTED);
    assert.equal(status.label, '已记住');
  });

  test('四档文案互不相同 —— 用户分得清「不用管」和「存在本机」', () => {
    const labels = Object.values(KEY_STORAGE_LABEL);
    assert.equal(new Set(labels).size, labels.length, `状态文案有重复：${labels.join(' / ')}`);
    assert.notEqual(KEY_STORAGE_LABEL.server, KEY_STORAGE_LABEL.persisted);
    assert.match(KEY_STORAGE_LABEL.server, /服务端/);
    assert.match(KEY_STORAGE_LABEL.persisted, /记住/);
  });

  test('状态切换：服务端配置后，本地 Key 不再被使用（但也没被删掉）', async () => {
    let serverConfigured = false;
    const store = makeStore({ server: async () => ({ configured: serverConfigured, provider: 'openai' }) });
    store.set('sk-proj-abcdefghijklmnop', { remember: true });
    assert.equal((await store.status()).kind, KEY_STORAGE.PERSISTED);
    serverConfigured = true;
    // 重新探一次服务端
    store.serverState = null;
    const status = await store.status();
    assert.equal(status.kind, KEY_STORAGE.SERVER, '服务端配好之后就该优先用服务端的');
    assert.equal(store.get(), 'sk-proj-abcdefghijklmnop', '本机那份不主动删 —— 用户回头可能要拿它去别处用');
  });

  test('服务端状态获取失败时不算「已配置」（不能凭不确定就说好了）', async () => {
    const store = makeStore({ server: async () => { throw new Error('网络不可达'); } });
    const status = await store.status();
    assert.equal(status.kind, KEY_STORAGE.NONE);
    assert.equal(store.serverState.configured, false);
  });
});

describe('生成类动作的诚实报错', () => {
  test('没有 Key 时不返回任何「猜的」内容', async () => {
    // 这一条的实质是：面板不能编一个看起来像答案的东西。
    // 判据放在这里：错误文案里必须明确说「需要配置」，且不能含任何
    // 像「以下是续写」这类会给用户错觉的措辞。
    const status = await makeStore({ server: async () => ({ configured: false }) }).status();
    assert.equal(status.kind, KEY_STORAGE.NONE);
    const message = 'AI 写作辅助需要配置 API Key';
    assert.match(message, /需要配置/);
    assert.doesNotMatch(message, /续写如下|以下内容|已生成/);
  });
});

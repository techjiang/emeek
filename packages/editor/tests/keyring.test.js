/**
 * API Key 分层存储（决策 D1）的测试。
 *
 * 这一组回答两个问题，缺一个都不算做完：
 *   1. Key 存得对不对（三层优先级、默认不记住、服务端不落地到浏览器）
 *   2. Key 有没有从别的地方漏出去（错误信息、日志、导出、URL）
 *
 * 第 2 个才是真难点 —— 存得再严，一条把 Key 拼进错误消息的日志就全废了。
 * 所以这里逐个走「会输出文本」的路径。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { KeyStore, KEY_STORAGE, redact, scanForSecrets, looksLikeApiKey } from '../src/studio/keyring.js';
import { createMemoryStorage } from '../src/studio/drafts.js';

const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';

function makeStore({ server = null } = {}) {
  const local = createMemoryStorage();
  const session = createMemoryStorage();
  return { store: new KeyStore({ storage: local, sessionStorage: session, server, now: () => 1700000000000 }), local, session };
}

describe('Key 分层存储', () => {
  test('没有服务端也没有输入时是「未配置」', async () => {
    const { store } = makeStore();
    const status = await store.status();
    assert.equal(status.kind, KEY_STORAGE.NONE);
    assert.equal(status.label, '未配置');
  });

  test('服务端托管优先：浏览器不持有明文，也不落到任何本地存储', async () => {
    const { store, local, session } = makeStore({
      server: async () => ({ configured: true, provider: 'openai', model: 'gpt-4o-mini' }),
    });
    const status = await store.status();
    assert.equal(status.kind, KEY_STORAGE.SERVER);
    assert.equal(status.label, '服务端已配置');
    assert.equal(store.get(), null, '服务端模式下客户端不该拿到 Key');
    assert.equal(local.length, 0, '服务端模式不该往 localStorage 写任何东西');
    assert.equal(session.length, 0, '服务端模式不该往 sessionStorage 写任何东西');
  });

  test('无服务端时默认写会话级，不写 localStorage', async () => {
    const { store, local, session } = makeStore({ server: async () => ({ configured: false }) });
    store.set(OPENAI_KEY);
    assert.equal(store.get(), OPENAI_KEY);
    assert.equal(session.getItem('emeeek:ai:key:session'), OPENAI_KEY);
    assert.equal(local.getItem('emeeek:ai:key:persisted'), null, '没勾「记住」就不能落 localStorage');
    assert.equal((await store.status()).kind, KEY_STORAGE.SESSION);
    assert.equal((await store.status()).label, '本次会话');
  });

  test('显式勾选「记住」才落 localStorage', async () => {
    const { store, local } = makeStore({ server: async () => ({ configured: false }) });
    store.set(OPENAI_KEY, { remember: true, provider: 'openai', model: 'gpt-4o-mini' });
    assert.equal(local.getItem('emeeek:ai:key:persisted'), OPENAI_KEY);
    const status = await store.status();
    assert.equal(status.kind, KEY_STORAGE.PERSISTED);
    assert.equal(status.label, '已记住');
    assert.equal(status.provider, 'openai');
  });

  test('取消记住会把已经落盘的 Key 删掉（而不是留在那儿）', async () => {
    const { store, local } = makeStore({ server: async () => ({ configured: false }) });
    store.set(OPENAI_KEY, { remember: true });
    store.set(ANTHROPIC_KEY, { remember: false });
    assert.equal(store.get(), ANTHROPIC_KEY, '本次会话用新的');
    assert.equal(local.getItem('emeeek:ai:key:persisted'), null, '旧的持久副本必须被清掉');
  });

  test('clear 清掉三层里的两层（服务端那层不归客户端管）', async () => {
    const { store, local, session } = makeStore({ server: async () => ({ configured: false }) });
    store.set(OPENAI_KEY, { remember: true });
    store.clear();
    assert.equal(store.get(), null);
    assert.equal(local.getItem('emeeek:ai:key:persisted'), null);
    assert.equal(session.getItem('emeeek:ai:key:session'), null);
    assert.equal((await store.status()).kind, KEY_STORAGE.NONE);
  });

  test('会话级查找优先于持久层（本次输入赢过上次记住的）', async () => {
    const { store } = makeStore({ server: async () => ({ configured: false }) });
    store.set(OPENAI_KEY, { remember: true });
    store.set(ANTHROPIC_KEY);
    assert.equal(store.get(), ANTHROPIC_KEY);
    assert.equal((await store.status()).kind, KEY_STORAGE.SESSION);
  });

  test('服务端探不通时降级为本地存储，而不是报错卡住', async () => {
    const { store } = makeStore({ server: async () => { throw new Error('ECONNREFUSED'); } });
    store.set(OPENAI_KEY);
    const status = await store.status();
    assert.equal(status.kind, KEY_STORAGE.SESSION);
    assert.equal(store.serverState.configured, false);
  });

  test('describe 不给明文，连前缀都不给', async () => {
    const { store } = makeStore({ server: async () => ({ configured: false }) });
    store.set(OPENAI_KEY);
    const info = store.describe();
    assert.equal(info.present, true);
    assert.equal(info.length, OPENAI_KEY.length);
    assert.equal(JSON.stringify(info).includes('sk-'), false, 'describe 的结果里不该出现 Key 的任何片段');
  });

  test('写不进去（隐私模式）时不谎报成功也不崩', async () => {
    const throwing = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    const store = new KeyStore({ storage: throwing, sessionStorage: throwing, server: async () => ({ configured: false }) });
    store.set(OPENAI_KEY);
    assert.equal(store.get(), null, '写失败就是没写进去，get 要如实返回 null');
  });
});

describe('输出面扫描', () => {
  test('已知 Key 出现在文本里会被抓到', () => {
    const text = `调用失败：401 invalid key ${OPENAI_KEY}`;
    const result = scanForSecrets(text, { known: [OPENAI_KEY] });
    assert.equal(result.clean, false);
    assert.ok(result.hits.length > 0);
    assert.equal(result.redacted.includes(OPENAI_KEY), false);
  });

  test('未知 Key（配置里没有的）靠形状也能抓到', () => {
    const cases = [
      'Authorization: Bearer sk-live-0123456789abcdef',
      'x-api-key: sk-ant-api03-zzzzzzzzzzzzzzzz',
      'url=https://api.example.com/v1?api_key=verysecretvalue1234',
      'gsk_0123456789abcdefghijklmn',
    ];
    for (const text of cases) {
      assert.equal(scanForSecrets(text).clean, false, `没抓到：${text}`);
    }
  });

  test('正常文本不会被误判', () => {
    for (const text of ['构建完成，12 篇文章', 'sk- 是一个前缀', 'Bearer token 已过期', '']) {
      assert.equal(scanForSecrets(text).clean, true, `误判：${text}`);
    }
  });

  test('redact 保留上下文形状，只抹掉凭证本身', () => {
    const out = redact(`Authorization: Bearer ${OPENAI_KEY}`, { known: [OPENAI_KEY] });
    assert.doesNotMatch(out, /sk-proj/);
    assert.match(out, /Authorization: Bearer/);
  });

  test('错误信息 / 日志 / 导出三条路径都不留 Key', () => {
    // 这三条是「真正会被人看到」的输出面。任何一条漏了，前面的存储分层都白做。
    const outputs = [
      // 1) 错误信息（provider 把上游返回原样抛出时最容易带出 Key）
      `AIError: openai 请求失败 401 {"error":{"message":"Incorrect API key provided: ${OPENAI_KEY}"}}`,
      // 2) 日志（调试时把整个请求对象打了进去）
      `[studio] request {"headers":{"authorization":"Bearer ${ANTHROPIC_KEY}"}}`,
      // 3) 导出 / 复制（把设置面板的原始状态导出）
      JSON.stringify({ provider: 'openai', config: { apiKey: OPENAI_KEY, model: 'gpt-4o-mini' } }),
    ];
    for (const output of outputs) {
      const { clean, redacted } = scanForSecrets(output, { known: [OPENAI_KEY, ANTHROPIC_KEY] });
      assert.equal(clean, false, `这条输出面没扫到 Key：${output.slice(0, 60)}`);
      assert.doesNotMatch(redacted, /sk-proj-abcdefghij/, 'redact 之后仍能看到 Key');
    }
  });

  test('看起来像 Key 的判定足够保守（不能把普通长串当 Key 报红）', () => {
    assert.equal(looksLikeApiKey('short'), false);
    assert.equal(looksLikeApiKey('a'.repeat(40)), true);
    assert.equal(looksLikeApiKey('构建产物路径 packages/core/src/index.js'), false);
  });
});

/**
 * 服务端代理（决策 D1 第一层）的集成测试。
 *
 * 重点不是「请求能不能发出」，而是**浏览器侧永远接触不到 Key** ——
 * 包括响应体、错误信息、日志三条路。
 */
describe('服务端 Key 代理', () => {
  const SERVER_KEY = 'sk-proj-serverside0123456789abcdefghij';

  test('detectServerKey 只认环境变量，且优先 EMEeeK_ 前缀', async () => {
    const { detectServerKey } = await import('../src/studio/ai-proxy.js');
    assert.equal(detectServerKey({}), null);
    const found = detectServerKey({ OPENAI_API_KEY: SERVER_KEY });
    assert.equal(found.provider, 'openai');
    assert.equal(found.apiKey, SERVER_KEY);
    assert.equal(found.from, 'OPENAI_API_KEY');
    const preferred = detectServerKey({ OPENAI_API_KEY: 'sk-a-0123456789012345', EMEEEK_OPENAI_API_KEY: SERVER_KEY });
    assert.equal(preferred.apiKey, SERVER_KEY, 'EMEEEK_ 前缀应当优先');
    const anthropic = detectServerKey({ ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef' });
    assert.equal(anthropic.provider, 'anthropic');
  });

  test('describeServerKey / serverKeyStatus 不带 Key 明文', async () => {
    const { detectServerKey, describeServerKey, serverKeyStatus } = await import('../src/studio/ai-proxy.js');
    const server = detectServerKey({ EMEEEK_OPENAI_API_KEY: SERVER_KEY });
    assert.doesNotMatch(describeServerKey(server), /sk-proj-serverside/);
    assert.doesNotMatch(JSON.stringify(serverKeyStatus(server)), /sk-proj-serverside/);
    assert.equal(serverKeyStatus(null).configured, false);
  });

  test('GET /__studio/ai/status 只说有没有，一个字都不漏', async () => {
    const { createStudioServer } = await import('../src/studio/server.js');
    const instance = await createStudioServer({
      port: 0, host: '127.0.0.1',
      serverKey: { provider: 'openai', apiKey: SERVER_KEY, model: 'gpt-4o-mini', from: 'EMEEEK_OPENAI_API_KEY' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/__studio/ai/status`);
      const text = await response.text();
      assert.doesNotMatch(text, /sk-proj-serverside/, '状态接口绝不能回 Key');
      const body = JSON.parse(text);
      assert.equal(body.configured, true);
      assert.equal(body.provider, 'openai');
    } finally { await instance.close(); }
  });

  test('没有服务端 Key 时 /__studio/ai/run 明确说「未配置」，不是 500', async () => {
    const { createStudioServer } = await import('../src/studio/server.js');
    const instance = await createStudioServer({
      port: 0, host: '127.0.0.1', serverKey: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/__studio/ai/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: '正文', task: 'summarize' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'not_configured');
    } finally { await instance.close(); }
  });

  test('代理转发成功路径：工具拿到 Key，浏览器只拿到结果', async () => {
    const { createStudioServer } = await import('../src/studio/server.js');
    const seen = [];
    const fakeFetch = async (url, init) => {
      seen.push({ url: String(url), headers: init.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"short":"一句话摘要","long":"更长的摘要"}' } }], usage: { total_tokens: 12 } }),
      };
    };
    // 用测试专用 provider：直接把 fetchImpl 换掉
    const { runProxiedTask } = await import('../src/studio/ai-proxy.js');
    const outcome = await runProxiedTask({
      input: '一段足够长的正文内容用于摘要测试。',
      task: 'summarize',
      server: { provider: 'openai', apiKey: SERVER_KEY, model: 'gpt-4o-mini', from: 'test' },
      fetchImpl: fakeFetch,
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(seen.length, 1);
    assert.match(seen[0].headers.authorization, /^Bearer sk-proj-serverside/);
    assert.doesNotMatch(JSON.stringify(outcome.result), /sk-proj-serverside/, '回给浏览器的东西里不能有 Key');
    assert.ok(createStudioServer);
  });

  test('错误路径：上游把 Key 回显在错误里，也要在回给浏览器之前抹掉', async () => {
    const { runProxiedTask } = await import('../src/studio/ai-proxy.js');
    const leakyFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => `{"error":{"message":"Incorrect API key provided: ${SERVER_KEY}"}}`,
      json: async () => ({ error: { message: `Incorrect API key provided: ${SERVER_KEY}` } }),
    });
    const outcome = await runProxiedTask({
      input: '正文内容够长够长。',
      task: 'summarize',
      server: { provider: 'openai', apiKey: SERVER_KEY, model: 'gpt-4o-mini', from: 'test' },
      fetchImpl: leakyFetch,
    });
    assert.equal(outcome.ok, false);
    assert.doesNotMatch(JSON.stringify(outcome), /sk-proj-serverside/, '错误信息里不能残留 Key');
    assert.equal(outcome.error.redacted, true);
  });

  test('safeLog 挡住「顺手把请求对象打进日志」这条最长的路', async () => {
    const { safeLog } = await import('../src/studio/ai-proxy.js');
    const lines = [];
    const logger = { info: (text) => lines.push(text) };
    safeLog(logger, 'info', 'headers=', JSON.stringify({ authorization: `Bearer ${SERVER_KEY}` }));
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /sk-proj-serverside/);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../../src/ai/providers/anthropic.js';
import { OpenAIProvider, parseJson, parseSummary } from '../../src/ai/providers/openai.js';
import { MockProvider } from '../../src/ai/providers/mock.js';
import { AIError } from '../../src/ai/types.js';

/** 构造一个假的 Anthropic 响应。 */
const anthropicFetch = (content, { status = 200, stream = false } = {}) => async () => {
  if (status !== 200) {
    return { ok: false, status, text: async () => '{"error":{"message":"bad key"}}' };
  }
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: content }], usage: { input_tokens: 10, output_tokens: 20 } }),
    body: stream ? (async function* () {
      yield new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"text":"你好"}}\n\n');
      yield new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"text":"世界"}}\n\n');
    })() : null,
  };
};

describe('AnthropicProvider', () => {
  test('无 key 时不可用', async () => {
    const provider = new AnthropicProvider({});
    assert.equal(await provider.isAvailable(), false);
  });

  test('有 key 且有 fetch 时可用', async () => {
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-x' });
    assert.equal(await provider.isAvailable(), true);
  });

  test('摘要：解析 content 数组里的 text 块', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-x',
      fetchImpl: anthropicFetch('{"short":"短","medium":"中","long":"长"}'),
    });
    const result = await provider.complete('正文'.repeat(20), 'summarize');
    assert.equal(result.source, 'anthropic');
    assert.deepEqual(result.content, { short: '短', medium: '中', long: '长' });
  });

  test('401 归一化为 UNAUTHORIZED', async () => {
    const provider = new AnthropicProvider({ apiKey: 'bad', fetchImpl: anthropicFetch('', { status: 401 }) });
    await assert.rejects(() => provider.complete('正文'.repeat(20), 'summarize'), (error) => {
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.equal(error.provider, 'anthropic');
      return true;
    });
  });

  test('429 归一化为 RATE_LIMITED', async () => {
    const provider = new AnthropicProvider({ apiKey: 'x', fetchImpl: anthropicFetch('', { status: 429 }) });
    await assert.rejects(() => provider.complete('正文'.repeat(20), 'summarize'), (error) => {
      assert.equal(error.code, 'RATE_LIMITED');
      return true;
    });
  });

  test('返回空内容时报 BAD_RESPONSE', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'x',
      fetchImpl: async () => ({ ok: true, json: async () => ({ content: [] }) }),
    });
    await assert.rejects(() => provider.complete('正文'.repeat(20), 'summarize'), /空内容/);
  });

  test('流式输出逐块产出', async () => {
    const provider = new AnthropicProvider({ apiKey: 'x', fetchImpl: anthropicFetch('', { stream: true }) });
    let text = '';
    for await (const chunk of provider.completeStream('正文'.repeat(20), 'summarize')) text += chunk;
    assert.equal(text, '你好世界');
  });

  test('标签返回数组', async () => {
    const provider = new AnthropicProvider({ apiKey: 'x', fetchImpl: anthropicFetch('["Emeek","性能"]') });
    const result = await provider.complete('正文'.repeat(20), 'tags');
    assert.deepEqual(result.content, ['Emeek', '性能']);
  });

  test('支持的任务范围与 OpenAI 一致', () => {
    const anthropic = new AnthropicProvider({ apiKey: 'x' });
    const openai = new OpenAIProvider({ apiKey: 'x' });
    assert.deepEqual([...anthropic.tasks].sort(), [...openai.tasks].sort());
  });
});

describe('OpenAIProvider 错误处理', () => {
  test('超时被归一化为 TIMEOUT', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'x',
      timeout: 20,
      fetchImpl: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({}) }), 200)),
    });
    await assert.rejects(() => provider.complete('正文'.repeat(20), 'summarize'), (error) => {
      assert.equal(error.code, 'TIMEOUT');
      return true;
    });
  });

  test('网络异常被归一化', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'x',
      fetchImpl: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
    });
    await assert.rejects(() => provider.complete('正文'.repeat(20), 'summarize'), (error) => {
      assert.equal(error.code, 'NETWORK');
      return true;
    });
  });

  test('外部取消信号被识别', async () => {
    const controller = new AbortController();
    const provider = new OpenAIProvider({
      apiKey: 'x',
      timeout: 0,
      fetchImpl: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({}) }), 100)),
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => provider.complete('正文'.repeat(20), 'summarize', { signal: controller.signal }));
  });

  test('空输入明确拒绝', async () => {
    const provider = new OpenAIProvider({ apiKey: 'x' });
    await assert.rejects(() => provider.complete('   ', 'summarize'), /为空/);
  });

  test('自定义 baseURL 支持 OpenAI 兼容服务', async () => {
    let called = '';
    const provider = new OpenAIProvider({
      apiKey: 'x',
      baseURL: 'https://api.deepseek.com/v1',
      fetchImpl: async (url) => {
        called = url;
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    await provider.complete('正文'.repeat(20), 'summarize');
    assert.equal(called, 'https://api.deepseek.com/v1/chat/completions');
  });
});

describe('JSON 解析容错（边界）', () => {
  test('纯 JSON 直接解析', () => {
    assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  });

  test('数组也能解析', () => {
    assert.deepEqual(parseJson('["a","b"]'), ['a', 'b']);
  });

  test('无法解析时返回 fallback', () => {
    assert.equal(parseJson('完全不是 JSON', { fallback: 'x' }), 'x');
    assert.equal(parseJson('完全不是 JSON'), null);
  });

  test('非字符串输入原样返回', () => {
    assert.deepEqual(parseJson({ a: 1 }), { a: 1 });
  });

  test('parseSummary 在非 JSON 时把原文当摘要', () => {
    const result = parseSummary('直接的摘要文本');
    assert.equal(result.short, '直接的摘要文本');
    assert.equal(result.medium, result.short);
  });

  test('parseSummary 在两个字段缺失时回填空串', () => {
    const result = parseSummary('{"short":"只有短档"}');
    assert.equal(result.short, '只有短档');
    assert.equal(result.medium, '');
    assert.equal(result.long, '');
  });
});

describe('AIProvider 基类契约', () => {
  test('不能直接实例化基类', async () => {
    const { AIProvider } = await import('../../src/ai/providers/base.js');
    assert.throws(() => new AIProvider({ name: 'x' }), /抽象类/);
  });

  test('基类默认不支持任何任务', async () => {
    const { AIProvider } = await import('../../src/ai/providers/base.js');
    class Minimal extends AIProvider {
      constructor() { super({ name: 'minimal' }); }
    }
    const provider = new Minimal();
    assert.equal(provider.supports('summarize'), false);
    assert.equal(await provider.isAvailable(), false);
    await assert.rejects(() => provider.complete('x', 'summarize'), AIError);
  });

  test('MockProvider 记录调用便于断言', async () => {
    const mock = new MockProvider();
    await mock.complete('第一次调用', 'summarize');
    await mock.complete('第二次调用', 'tags');
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0].task, 'summarize');
    assert.equal(mock.calls[1].input, '第二次调用');
  });

  test('MockProvider 可模拟不可用', async () => {
    const mock = new MockProvider({ failOn: 'availability' });
    assert.equal(await mock.isAvailable(), false);
  });

  test('MockProvider 延迟参数可用于测试加载态', async () => {
    // 用注入的时钟而不是 performance.now() 的壁钟差：
    // 后者比的是「真实耗时 >= 睡的时间」，而性能抖动会把它变成偶发红
    // （实测在 CI 上 10ms 的 sleep 有概率读到 9.9）。延迟参数控制的是
    // 「睡多久」，断言就该盯着这个，而不是盯着机器当时有多忙。
    const slept = [];
    const mock = new MockProvider({ latency: 10, sleep: async (ms) => { slept.push(ms); } });
    await mock.complete('输入内容够长够长够长', 'summarize');
    assert.deepEqual(slept, [10]);
  });
});

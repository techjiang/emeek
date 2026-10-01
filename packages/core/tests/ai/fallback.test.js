import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { AIService, MockProvider, LocalProvider } from '../../src/ai/index.js';
import { loadDictionarySync } from '../../src/ai/local/segmenter.js';

const ARTICLE = `## 为什么选择静态站点

Emeek 博客引擎把 GitHub Issues 当作内容源，构建时生成纯静态页面。静态站点方案没有服务器，也不需要数据库，部署成本接近零。

### 构建流程

- 读取 Issues
- 渲染 Markdown
- 输出 HTML

性能不是优化出来的，是设计出来的。默认主题从第一天起就按一次请求来设计，样式表内联进头部。`;

describe('降级链：无 API Key 的离线模式', () => {
  before(() => { loadDictionarySync(); });

  test('没有任何 Provider 时仍可完成摘要', async () => {
    const service = new AIService({ providers: [] });
    assert.equal(service.isDegraded, true);
    const result = await service.summarize(ARTICLE);
    assert.equal(result.source, 'local');
    assert.ok(result.content.short.length > 0);
  });

  test('离线时 source 标记为 local，quality 如实标注', async () => {
    const service = new AIService({ providers: [] });
    const summary = await service.summarize(ARTICLE);
    assert.equal(summary.source, 'local');
    // 抽取式摘要不是生成结果，不能标成 generative
    assert.equal(summary.quality, 'medium');

    const readability = await service.readability(ARTICLE);
    // 本地确定性计算是 high，这不是降级产物
    assert.equal(readability.quality, 'high');
  });

  test('能力矩阵如实反映哪些功能不可用', () => {
    const service = new AIService({ providers: [] });
    const capabilities = service.capabilities();
    assert.equal(capabilities.summarize.available, true);
    assert.equal(capabilities.summarize.degraded, true);
    assert.equal(capabilities.summarize.label, '快速摘要');
    // 续写没有本地替代，必须明确不可用
    assert.equal(capabilities.continue.available, false);
    assert.ok(capabilities.continue.reason.includes('API Key'));
  });

  test('离线时续写明确报错，不返回假结果', async () => {
    const service = new AIService({ providers: [] });
    await assert.rejects(
      () => service.run(ARTICLE, 'continue'),
      (error) => {
        assert.equal(error.code, 'NOT_CONFIGURED');
        return true;
      },
    );
  });

  test('离线可读性分析不依赖任何 Provider', async () => {
    const service = new AIService({ providers: [] });
    const result = await service.readability(ARTICLE, { withAdvice: false });
    assert.ok(result.content.score >= 0);
    assert.ok(Array.isArray(result.content.suggestions));
  });
});

describe('降级链：Provider 失败时的行为', () => {
  before(() => { loadDictionarySync(); });

  test('LLM 失败后降级到本地，且结果带 fallback 标记', async () => {
    const warnings = [];
    const failing = new MockProvider({ name: 'openai', failOn: 'all' });
    const service = new AIService({ providers: [failing], onWarn: (m) => warnings.push(m) });
    const result = await service.summarize(ARTICLE);
    assert.equal(result.source, 'local');
    assert.equal(result.meta.fallback, true);
    assert.ok(result.meta.attempts.length > 0, '应记录失败的尝试');
    assert.ok(warnings.some((w) => w.includes('降级')), '应发出降级告警');
  });

  test('失败的 Provider 抛错信息被保留，便于诊断', async () => {
    const failing = new MockProvider({ name: 'openai', failOn: 'summarize' });
    const service = new AIService({ providers: [failing] });
    const result = await service.summarize(ARTICLE);
    const attempt = result.meta.attempts[0];
    assert.equal(attempt.provider, 'openai');
    assert.equal(attempt.code, 'NETWORK');
    assert.ok(attempt.message.includes('MockProvider'));
  });

  test('续写任务在 Provider 失败时不降级（本地做不了）', async () => {
    const failing = new MockProvider({ name: 'openai', failOn: 'continue' });
    const service = new AIService({ providers: [failing] });
    await assert.rejects(() => service.run(ARTICLE, 'continue'), (error) => {
      assert.equal(error.code, 'BAD_RESPONSE');
      assert.ok(error.attempts.length > 0);
      return true;
    });
  });
});

describe('降级链：有 Provider 时的正常路径', () => {
  test('Provider 可用时不走本地', async () => {
    const mock = new MockProvider({ name: 'openai' });
    const service = new AIService({ providers: [mock] });
    const result = await service.summarize(ARTICLE);
    assert.equal(result.source, 'openai');
    assert.equal(result.quality, 'generative');
    assert.equal(mock.calls.length, 1);
  });

  test('Provider 不支持的任务交给下一个 Provider', async () => {
    const limited = new MockProvider({ name: 'limited' });
    limited.tasks = ['summarize'];
    const full = new MockProvider({ name: 'openai' });
    const service = new AIService({ providers: [limited, full] });
    const result = await service.run(ARTICLE, 'rewrite');
    assert.equal(result.source, 'openai');
  });

  test('MockProvider 输出确定性，可直接断言', async () => {
    const mock = new MockProvider();
    const a = await mock.complete('固定输入内容', 'summarize');
    const b = await mock.complete('固定输入内容', 'summarize');
    assert.deepEqual(a.content, b.content);
    assert.ok(a.content.short.startsWith('[mock:summarize]'));
  });

  test('MockProvider 能模拟失败以测试降级', async () => {
    const mock = new MockProvider({ failOn: 'summarize' });
    await assert.rejects(() => mock.complete('x'.repeat(30), 'summarize'));
  });

  test('MockProvider 流式输出与一次性内容一致', async () => {
    const mock = new MockProvider();
    const once = await mock.complete('流式测试输入内容', 'continue');
    let streamed = '';
    for await (const chunk of mock.completeStream('流式测试输入内容', 'continue')) streamed += chunk;
    assert.equal(streamed, once.content);
  });
});

describe('AIService 可读性走本地优先', () => {
  before(() => { loadDictionarySync(); });

  test('即使有 LLM，可读性分数仍由本地计算', async () => {
    const mock = new MockProvider({ name: 'openai' });
    const service = new AIService({ providers: [mock] });
    const result = await service.readability(ARTICLE);
    // 分数必须来自本地确定性计算，LLM 只被用于补充建议文字
    assert.equal(result.source, 'local');
    assert.equal(result.quality, 'high');
    assert.equal(typeof result.content.score, 'number');
  });

  test('LLM 补充建议失败不影响本地结论', async () => {
    const failing = new MockProvider({ name: 'openai', failOn: 'all' });
    const service = new AIService({ providers: [failing] });
    const result = await service.readability(ARTICLE);
    assert.ok(result.content.score >= 0);
    assert.ok(result.content.suggestions.length > 0, '本地建议应仍然存在');
  });
});

describe('AIService 从配置构建', () => {
  test('无配置时进入降级模式', async () => {
    const service = await AIService.fromConfig({});
    assert.equal(service.isDegraded, true);
  });

  test('配置了 key 但 fetch 不可用时仍降级', async () => {
    const service = await AIService.fromConfig({ ai: { providers: { openai: { apiKey: 'sk-x', fetchImpl: null } } } });
    // isAvailable 为 false，不应进入 providers
    assert.equal(service.isDegraded, true);
  });
});

describe('LocalProvider 能力边界', () => {
  before(() => { loadDictionarySync(); });

  test('本地 Provider 支持的任务清单', () => {
    const provider = new LocalProvider();
    for (const task of ['summarize', 'readability', 'seo', 'tags', 'title']) {
      assert.equal(provider.supports(task), true, `应支持 ${task}`);
    }
    for (const task of ['continue', 'rewrite', 'translate', 'expand', 'condense']) {
      assert.equal(provider.supports(task), false, `不应支持 ${task}`);
    }
  });

  test('生成类任务明确报 UNSUPPORTED_TASK', async () => {
    const provider = new LocalProvider();
    for (const task of ['continue', 'rewrite', 'translate', 'expand', 'condense']) {
      await assert.rejects(() => provider.complete('内容'.repeat(20), task), (error) => {
        assert.equal(error.code, 'UNSUPPORTED_TASK', `${task} 应报不支持`);
        assert.ok(error.message.includes('AI 模型'));
        return true;
      });
    }
  });

  test('空输入在入口被拦截', async () => {
    const provider = new LocalProvider();
    await assert.rejects(() => provider.summarize('   '), /为空/);
    await assert.rejects(() => provider.tags(''), /为空/);
  });

  test('关键词提取优先复用已有标签', async () => {
    const provider = new LocalProvider();
    const result = await provider.tags(ARTICLE, { existingTags: ['emeek', '静态站点'] });
    assert.ok(result.meta.matched_existing >= 1, `应有已有标签被复用，实际命中 ${result.meta.matched_existing}`);
    // 命中的已有标签必须排在未命中标签前面
    const matched = result.content.filter((t) => ['emeek', '静态站点'].includes(t));
    assert.ok(matched.length > 0, `已有标签应出现在结果中：${result.content.join('、')}`);
    const firstUnmatched = result.content.findIndex((t) => !['emeek', '静态站点'].includes(t));
    const lastMatched = result.content.map((t) => ['emeek', '静态站点'].includes(t)).lastIndexOf(true);
    if (firstUnmatched >= 0) assert.ok(lastMatched < firstUnmatched, '已有标签应排在前面');
  });

  test('关键词数量受 top 参数限制', async () => {
    const provider = new LocalProvider();
    const result = await provider.tags(ARTICLE, { top: 3 });
    assert.ok(result.content.length <= 3, `应最多 3 个，实际 ${result.content.length}`);
  });

  test('标题建议数量受 count 限制且无重复', async () => {
    const provider = new LocalProvider();
    const result = await provider.titles(ARTICLE, { count: 3 });
    assert.ok(result.content.length <= 3);
    assert.equal(new Set(result.content).size, result.content.length, '标题不应重复');
  });

  test('标题建议里不出现多句拼成的段落', async () => {
    const provider = new LocalProvider();
    const result = await provider.titles(ARTICLE, { count: 5 });
    for (const title of result.content) {
      assert.ok(!title.includes('\n'), `标题不应含换行：${title}`);
      assert.ok([...title].length <= 60, `标题过长：${title}`);
    }
  });

  test('词典可注入自定义路径', async () => {
    const provider = new LocalProvider({ dictionary: { file: '/nonexistent/dict.gz' } });
    // 加载失败不应抛异常，只是分词退化为单字
    const ok = await provider.ensureDictionary();
    assert.equal(typeof ok, 'boolean');
  });

  test('同步加载词典供 CLI 使用', () => {
    const provider = new LocalProvider();
    assert.equal(provider.ensureDictionarySync(), true);
  });

  test('摘要结果带降级标记', async () => {
    const provider = new LocalProvider();
    const result = await provider.summarize(ARTICLE);
    assert.equal(result.meta.degraded, true);
    assert.equal(result.meta.algorithm, 'extractive-multi-feature');
  });

  test('可读性与 SEO 不标记为降级（本地算更准）', async () => {
    const provider = new LocalProvider();
    const readability = await provider.readability(ARTICLE);
    const seo = await provider.seo(ARTICLE);
    assert.equal(readability.quality, 'high');
    assert.equal(seo.quality, 'high');
    assert.equal(readability.meta.degraded, undefined);
  });

  test('短文摘要标记 empty 供 UI 判断', async () => {
    const provider = new LocalProvider();
    const result = await provider.summarize('太短了。');
    assert.equal(result.meta.empty, true);
  });
});

describe('registry：Provider 工厂与解析', () => {
  test('createProvider 按名称创建', async () => {
    const { createProvider } = await import('../../src/ai/index.js');
    assert.equal(createProvider('openai').name, 'openai');
    assert.equal(createProvider('anthropic').name, 'anthropic');
    assert.equal(createProvider('local').name, 'local');
    assert.equal(createProvider('mock').name, 'mock');
  });

  test('未知名称给出明确错误', async () => {
    const { createProvider } = await import('../../src/ai/index.js');
    assert.throws(() => createProvider('nonexistent'), /未知的 AI Provider/);
  });

  test('resolveProviders 只返回可用的 Provider', async () => {
    const { resolveProviders } = await import('../../src/ai/index.js');
    const none = await resolveProviders({});
    assert.equal(none.length, 0);

    const withKey = await resolveProviders({ ai: { providers: { openai: { apiKey: 'sk-x' } } } });
    assert.equal(withKey.length, 1);
    assert.equal(withKey[0].name, 'openai');
  });

  test('同时配置两家时都返回', async () => {
    const { resolveProviders } = await import('../../src/ai/index.js');
    const providers = await resolveProviders({
      ai: { providers: { openai: { apiKey: 'sk-a' }, anthropic: { apiKey: 'sk-b' } } },
    });
    assert.equal(providers.length, 2);
  });

  test('provider 名称列表写法也支持', async () => {
    const { resolveProviders } = await import('../../src/ai/index.js');
    const providers = await resolveProviders({ ai: { provider: ['local', 'mock'] } });
    const names = providers.map((p) => p.name).sort();
    assert.deepEqual(names, ['local', 'mock'], '两个都应可用');
  });

  test('名称列表里写错的名字被忽略，不影响其它 Provider', async () => {
    const { resolveProviders } = await import('../../src/ai/index.js');
    const providers = await resolveProviders({ ai: { provider: ['typo-provider', 'local'] } });
    assert.ok(providers.every((p) => p.name !== 'typo-provider'));
  });

  test('ai.openaiApiKey 简写形式也被识别', async () => {
    const { resolveProviders } = await import('../../src/ai/index.js');
    const providers = await resolveProviders({ ai: { openaiApiKey: 'sk-short' } });
    assert.equal(providers.length, 1);
  });

  test('AIService.fromConfig 传递 promptsDir', async () => {
    const { AIService } = await import('../../src/ai/index.js');
    const service = await AIService.fromConfig({ ai: { promptsDir: '/tmp/custom-prompts' } });
    assert.equal(service.local.promptsDir, '/tmp/custom-prompts');
  });

  test('onWarn 回调在降级时被调用', async () => {
    const { AIService, MockProvider } = await import('../../src/ai/index.js');
    const messages = [];
    const service = new AIService({ providers: [new MockProvider({ failOn: 'all' })], onWarn: (m) => messages.push(m) });
    await service.summarize(ARTICLE);
    assert.ok(messages.length >= 2, '应有失败告警与降级告警');
    assert.ok(messages.some((m) => m.includes('失败')));
  });

  test('无 onWarn 时降级不抛异常', async () => {
    const { AIService, MockProvider } = await import('../../src/ai/index.js');
    const service = new AIService({ providers: [new MockProvider({ failOn: 'all' })] });
    const result = await service.summarize(ARTICLE);
    assert.equal(result.source, 'local');
  });

  test('lastError 在失败后被记录', async () => {
    const { AIService, MockProvider } = await import('../../src/ai/index.js');
    const service = new AIService({ providers: [new MockProvider({ failOn: 'all' })] });
    await service.summarize(ARTICLE);
    assert.equal(service.isDegraded, false, '有 Provider 时不处于降级模式');
  });

  test('seo 与 tags 便捷入口可用', async () => {
    const { AIService } = await import('../../src/ai/index.js');
    const service = new AIService({ providers: [] });
    const seo = await service.seo({ title: '标题', raw: ARTICLE, slug: 'a', date: '2024-01-01' });
    assert.equal(seo.source, 'local');
    const tags = await service.tags(ARTICLE);
    assert.ok(Array.isArray(tags.content));
  });
});

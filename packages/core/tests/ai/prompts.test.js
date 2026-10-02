import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadTemplate, renderTemplate, listTemplates, parseTemplate, clearTemplateCache } from '../../src/ai/prompts/loader.js';
import { OpenAIProvider } from '../../src/ai/providers/openai.js';
import { AnthropicProvider } from '../../src/ai/providers/anthropic.js';
import { AITask } from '../../src/ai/types.js';

describe('提示词模板', () => {
  test('内置模板覆盖全部 AI 任务', () => {
    const templates = listTemplates();
    for (const name of ['summarize', 'tags', 'seo', 'continue', 'rewrite', 'expand', 'condense', 'translate', 'title']) {
      assert.ok(templates.includes(name), `缺少模板：${name}`);
    }
  });

  test('模板元信息可解析', () => {
    const template = loadTemplate('summarize');
    assert.equal(template.meta.task, 'summarize');
    assert.ok(template.meta.output);
    assert.ok(template.variables.includes('content'));
    assert.ok(template.variables.includes('title'));
  });

  test('渲染替换全部变量', () => {
    const rendered = renderTemplate('summarize', {
      title: '测试标题', content: '测试正文', shortLength: 50, mediumLength: 100, longLength: 200,
    });
    assert.ok(rendered.includes('测试标题'));
    assert.ok(rendered.includes('测试正文'));
    assert.ok(rendered.includes('50'));
    assert.ok(!rendered.includes('{{'), '不应残留未替换的变量');
  });

  test('缺失变量渲染为空串，不抛异常（生产路径）', () => {
    const rendered = renderTemplate('summarize', { title: '只有标题' });
    assert.ok(!rendered.includes('{{title}}'));
    assert.ok(!rendered.includes('{{content}}'));
  });

  test('strict 模式下缺失变量报错（测试路径）', () => {
    assert.throws(
      () => renderTemplate('summarize', { title: '只有标题' }, { strict: true }),
      /缺少变量/,
    );
  });

  test('未知模板名给出明确错误与查找路径', () => {
    assert.throws(() => loadTemplate('nonexistent-template'), /找不到提示词模板/);
  });

  test('模板支持嵌套变量路径', () => {
    const template = parseTemplate('inline', '标题：{{ post.title }}\n正文：{{ post.body }}');
    const rendered = renderTemplate(template, { post: { title: '标题', body: '正文' } });
    assert.ok(rendered.includes('标题：标题'));
    assert.ok(rendered.includes('正文：正文'));
  });

  test('模板缓存可清空（改文件后能读到新内容）', () => {
    loadTemplate('summarize');
    clearTemplateCache();
    const again = loadTemplate('summarize');
    assert.ok(again.text.length > 0);
  });
});

describe('提示词质量约束', () => {
  test('摘要提示词明确禁止编造', () => {
    const template = loadTemplate('summarize').text;
    assert.ok(/不要.*编造|绝不编造|不存在的信息/.test(template), '摘要提示词必须包含防幻觉约束');
  });

  test('标签提示词要求复用已有标签', () => {
    const template = loadTemplate('tags').text;
    assert.ok(template.includes('已有标签库'), '应引导复用站内已有标签');
    assert.ok(/只输出 JSON/.test(template), '应约束输出格式');
  });

  test('SEO 提示词要求建议具体可操作', () => {
    const template = loadTemplate('seo').text;
    assert.ok(/具体位置|具体改法/.test(template), '应要求建议具体');
    assert.ok(template.includes('反例'), '应给出反例避免空泛建议');
  });

  test('续写提示词要求延续风格且不重复', () => {
    const template = loadTemplate('continue').text;
    assert.ok(/风格/.test(template));
    assert.ok(/不要重复/.test(template));
  });
});

describe('Provider 与模板的映射', () => {
  const provider = new OpenAIProvider({ apiKey: 'sk-test' });

  test('每个任务都能构建出非空提示词', () => {
    for (const task of Object.values(AITask)) {
      if (task === 'readability') continue; // 不走 LLM
      const { prompt } = provider.buildPrompt('测试正文内容', task, { title: '标题' });
      assert.ok(prompt.length > 50, `${task} 的提示词过短`);
      assert.ok(!prompt.includes('{{'), `${task} 的提示词残留变量`);
    }
  });

  test('摘要提示词带上三档长度参数', () => {
    const { prompt } = provider.buildPrompt('正文', 'summarize', { title: 'T' });
    assert.ok(prompt.includes('50'));
    assert.ok(prompt.includes('100'));
    assert.ok(prompt.includes('200'));
  });

  test('标签提示词带上已有标签库', () => {
    const { prompt } = provider.buildPrompt('正文', 'tags', { existingTags: ['Emeek', '性能'] });
    assert.ok(prompt.includes('Emeek'));
    assert.ok(prompt.includes('性能'));
  });

  test('Anthropic 与 OpenAI 使用同一套模板但各自拼装', () => {
    const anthropic = new AnthropicProvider({ apiKey: 'sk-test' });
    const openaiPrompt = provider.buildPrompt('同一段正文', 'summarize', { title: 'T' }).prompt;
    const anthropicPrompt = anthropic.buildPrompt('同一段正文', 'summarize', { title: 'T' }).prompt;
    // 语义相同即可，不要求逐字一致（两家风格不同是刻意的）
    assert.ok(openaiPrompt.includes('同一段正文'));
    assert.ok(anthropicPrompt.includes('同一段正文'));
    assert.ok(openaiPrompt.includes('摘要'));
    assert.ok(anthropicPrompt.includes('摘要'));
  });

  test('不支持的任务给出明确错误', () => {
    assert.throws(() => provider.buildPrompt('x', 'unknown-task'), /不支持任务/);
  });
});

describe('返回内容解析的容错', () => {
  const provider = new OpenAIProvider({ apiKey: 'sk-test' });

  test('摘要结果兼容多种字段命名', async () => {
    const fake = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '短', mediumSummary: '中', detailed: '长' }) } }] }) });
    const p = new OpenAIProvider({ apiKey: 'sk-test', fetchImpl: fake });
    const result = await p.complete('正文'.repeat(20), 'summarize', {});
    assert.equal(result.content.short, '短');
    assert.equal(result.content.medium, '中');
    assert.equal(result.content.long, '长');
  });

  test('JSON 围栏被剥离', async () => {
    const fake = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"short":"a","medium":"b","long":"c"}\n```' } }] }) });
    const p = new OpenAIProvider({ apiKey: 'sk-test', fetchImpl: fake });
    const result = await p.complete('正文'.repeat(20), 'summarize', {});
    assert.equal(result.content.short, 'a');
  });

  test('前后有解释文字时仍能取出 JSON', async () => {
    const fake = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '好的，这是结果：{"short":"a","medium":"b","long":"c"} 希望有帮助' } }] }) });
    const p = new OpenAIProvider({ apiKey: 'sk-test', fetchImpl: fake });
    const result = await p.complete('正文'.repeat(20), 'summarize', {});
    assert.equal(result.content.medium, 'b');
  });

  test('标签返回非数组时按行拆解', async () => {
    const fake = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '- Emeek\n- 性能\n- 静态站点' } }] }) });
    const p = new OpenAIProvider({ apiKey: 'sk-test', fetchImpl: fake });
    const result = await p.complete('正文'.repeat(20), 'tags', {});
    assert.deepEqual(result.content, ['Emeek', '性能', '静态站点']);
  });
});

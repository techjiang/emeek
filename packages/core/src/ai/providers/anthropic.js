import { AIError, AIErrorCode, AIQuality } from '../types.js';
import { AIProvider, requireText } from './base.js';
import { loadTemplate, renderTemplate } from '../prompts/loader.js';
import { parseSummary, parseJson } from './openai.js';

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1';
const DEFAULT_MODEL = 'claude-3-5-haiku-latest';
const API_VERSION = '2023-06-01';

/**
 * Anthropic Provider。
 *
 * 结构与 OpenAIProvider 几乎一致，但没有复用它的 prompt 拼装 —— 两家的
 * 提示词风格差异不小（Claude 吃 system 角色更重要，长上下文也更稳），
 * 硬合并会让两边都别扭。共享的只有「模板加载」和「返回值解析」。
 *
 * 默认 haiku：同样出于「摘要是格式化重写不是推理」的判断。
 */
export class AnthropicProvider extends AIProvider {
  constructor({ apiKey, model = DEFAULT_MODEL, baseURL = DEFAULT_ENDPOINT, timeout = 30000, fetchImpl = globalThis.fetch, promptsDir } = {}) {
    super({ name: 'anthropic', quality: AIQuality.GENERATIVE, timeout });
    this.apiKey = apiKey;
    this.model = model;
    this.baseURL = String(baseURL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.promptsDir = promptsDir;
    this.tasks = ['summarize', 'tags', 'seo', 'continue', 'rewrite', 'expand', 'condense', 'translate', 'title'];
  }

  async isAvailable() {
    return Boolean(this.apiKey) && typeof this.fetchImpl === 'function';
  }

  async complete(input, task = 'summarize', options = {}) {
    const text = requireText(input);
    const { prompt } = this.buildPrompt(text, task, options);
    const payload = await this.withTimeout(this.#request({
      model: this.model,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? (task === 'continue' || task === 'rewrite' ? 0.7 : 0.3),
      system: '你是一位严谨的中文技术写作助手。只输出被要求的内容，不添加任何解释。',
      messages: [{ role: 'user', content: prompt }],
    }, options), options);

    const content = (payload?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
    if (!content.trim()) throw new AIError('Anthropic 返回了空内容', { code: AIErrorCode.BAD_RESPONSE, provider: this.name });
    return this.result(this.#shape(content, task), { task, meta: { model: this.model, usage: payload.usage } });
  }

  async *completeStream(input, task = 'summarize', options = {}) {
    const text = requireText(input);
    const { prompt } = this.buildPrompt(text, task, options);
    const response = await this.withTimeout(this.fetchImpl(`${this.baseURL}/messages`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ model: this.model, max_tokens: options.maxTokens ?? 2048, stream: true, messages: [{ role: 'user', content: prompt }] }),
      signal: options.signal,
    }), options);
    if (!response.ok) throw await this.#httpError(response);

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (event.type === 'content_block_delta' && event.delta?.text) yield event.delta.text;
        } catch {
          // 分片边界，跳过
        }
      }
    }
  }

  buildPrompt(input, task, options = {}) {
    const mapping = {
      summarize: { template: 'summarize', extra: { shortLength: 50, mediumLength: 100, longLength: 200, title: options.title ?? '' } },
      tags: { template: 'tags', extra: { minLength: 2, maxLength: 6, title: options.title ?? '', existingBlock: options.existingTags?.length ? `\n已有标签库（请优先复用）：${options.existingTags.join('、')}\n` : '' } },
      seo: { template: 'seo', extra: { title: options.title ?? '', description: options.description ?? '', tags: (options.tags ?? []).join(', ') } },
      continue: { template: 'continue', extra: { length: options.length ?? 120, context: options.context ?? input, tail: options.tail ?? '' } },
      rewrite: { template: 'rewrite', extra: { style: options.style ?? '正式', styleGuide: options.styleGuide ?? '保持书面、清晰、简洁', text: options.text ?? input } },
      expand: { template: 'expand', extra: { length: options.length ?? 200, text: options.text ?? input, title: options.title ?? '' } },
      condense: { template: 'condense', extra: { targetRatio: options.targetRatio ?? 0.6, text: options.text ?? input } },
      translate: { template: 'translate', extra: { targetLanguage: options.targetLanguage ?? 'en', targetLanguageName: options.targetLanguageName ?? '英文', text: options.text ?? input } },
      title: { template: 'title', extra: { content: options.text ?? input } },
    };
    const entry = mapping[task];
    if (!entry) throw new AIError(`${this.name} 不支持任务 ${task}`, { code: AIErrorCode.UNSUPPORTED_TASK, provider: this.name });
    const template = loadTemplate(entry.template, { dir: this.promptsDir });
    return { prompt: renderTemplate(template, { content: input, ...entry.extra }) };
  }

  #shape(content, task) {
    if (task === 'summarize') return parseSummary(content);
    if (task === 'seo') return parseJson(content, { fallback: null });
    if (task === 'tags' || task === 'title') {
      const parsed = parseJson(content, { fallback: null });
      if (Array.isArray(parsed)) return parsed.map(String);
      return content.split('\n').map((line) => line.replace(/^[-*\d.\s"'[\]]+/, '').replace(/["',\]]+$/, '').trim()).filter(Boolean).slice(0, 8);
    }
    return content.trim();
  }

  async #request(body, options) {
    const response = await this.fetchImpl(`${this.baseURL}/messages`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(body),
      signal: options.signal,
    }).catch((error) => {
      throw this.normalizeError(error);
    });
    if (!response.ok) throw await this.#httpError(response);
    return response.json();
  }

  #headers() {
    return { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': API_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' };
  }

  async #httpError(response) {
    const detail = await response.text().catch(() => '');
    return this.normalizeError({ status: response.status, message: `Anthropic 请求失败 ${response.status}: ${detail.slice(0, 200)}` });
  }
}

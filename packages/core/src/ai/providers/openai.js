import { AIError, AIErrorCode, AIQuality, AITask } from '../types.js';
import { AIProvider, requireText } from './base.js';
import { loadTemplate, renderTemplate } from '../prompts/loader.js';

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * OpenAI 兼容 Provider。
 *
 * 之所以叫「兼容」：DeepSeek、Moonshot、通义、本地 vLLM / LM Studio
 * 都提供同一套 /chat/completions 协议。把 baseURL 做成可配置项，
 * 这一个 Provider 就覆盖了绝大部分自建与国内服务，没必要为每家写一个。
 *
 * 默认模型选 mini 而不是旗舰：摘要、标签这类任务是「格式化重写」而非推理，
 * mini 的质量差距在这个场景下用户感知不到，但成本差 10 倍以上。
 */
export class OpenAIProvider extends AIProvider {
  constructor({ apiKey, model = DEFAULT_MODEL, baseURL = DEFAULT_ENDPOINT, timeout = 30000, fetchImpl = globalThis.fetch, promptsDir } = {}) {
    super({ name: 'openai', quality: AIQuality.GENERATIVE, timeout });
    this.apiKey = apiKey;
    this.model = model;
    this.baseURL = String(baseURL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.promptsDir = promptsDir;
    this.tasks = [AITask.SUMMARIZE, AITask.TAGS, AITask.SEO, AITask.CONTINUE, AITask.REWRITE, AITask.EXPAND, AITask.CONDENSE, AITask.TRANSLATE, AITask.TITLE];
  }

  async isAvailable() {
    return Boolean(this.apiKey) && typeof this.fetchImpl === 'function';
  }

  async complete(input, task = AITask.SUMMARIZE, options = {}) {
    const text = requireText(input);
    const { prompt, json } = this.buildPrompt(text, task, options);
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: '你是一位严谨的中文技术写作助手。只输出被要求的内容，不添加任何解释。' },
        { role: 'user', content: prompt },
      ],
      temperature: options.temperature ?? (task === AITask.CONTINUE || task === AITask.REWRITE ? 0.7 : 0.3),
    };
    if (json) body.response_format = { type: 'json_object' };

    const payload = await this.withTimeout(this.#request(body, options), options);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AIError('OpenAI 返回了空内容', { code: AIErrorCode.BAD_RESPONSE, provider: this.name });
    }
    return this.result(this.#shape(content, task, json), { task, meta: { model: this.model, usage: payload.usage } });
  }

  async *completeStream(input, task = AITask.SUMMARIZE, options = {}) {
    const text = requireText(input);
    const { prompt } = this.buildPrompt(text, task, options);
    const response = await this.withTimeout(this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({
        model: this.model,
        stream: true,
        temperature: options.temperature ?? 0.7,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: options.signal,
    }), options);

    if (!response.ok) throw await this.#httpError(response);
    if (!response.body) throw new AIError('当前环境不支持流式响应', { code: AIErrorCode.BAD_RESPONSE, provider: this.name });

    for await (const line of readLines(response.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // 流里混进半截 JSON 是正常的（分片边界），跳过而不是中断整个流
      }
    }
  }

  /** 把 task 映射到提示词模板与变量。这里是「任务 -> 提示词」的唯一映射点。 */
  buildPrompt(input, task, options = {}) {
    const vars = { content: input, ...options.variables };
    const mapping = {
      [AITask.SUMMARIZE]: { template: 'summarize', json: false, extra: { shortLength: 50, mediumLength: 100, longLength: 200, title: options.title ?? '' } },
      [AITask.TAGS]: { template: 'tags', json: false, extra: { minLength: 2, maxLength: 6, title: options.title ?? '', existingBlock: formatExisting(options.existingTags) } },
      [AITask.SEO]: { template: 'seo', json: true, extra: { title: options.title ?? '', description: options.description ?? '', tags: (options.tags ?? []).join(', ') } },
      [AITask.CONTINUE]: { template: 'continue', json: false, extra: { length: options.length ?? 120, context: options.context ?? input, tail: options.tail ?? '' } },
      [AITask.REWRITE]: { template: 'rewrite', json: false, extra: { style: options.style ?? '正式', styleGuide: STYLE_GUIDES[options.style] ?? options.styleGuide ?? '保持书面、清晰、简洁', text: options.text ?? input } },
      [AITask.EXPAND]: { template: 'expand', json: false, extra: { length: options.length ?? 200, text: options.text ?? input, title: options.title ?? '' } },
      [AITask.CONDENSE]: { template: 'condense', json: false, extra: { targetRatio: options.targetRatio ?? 0.6, text: options.text ?? input } },
      [AITask.TRANSLATE]: { template: 'translate', json: false, extra: { targetLanguage: options.targetLanguage ?? 'en', targetLanguageName: LANGUAGE_NAMES[options.targetLanguage ?? 'en'] ?? options.targetLanguage, text: options.text ?? input } },
      [AITask.TITLE]: { template: 'title', json: false, extra: { content: options.text ?? input } },
    };
    const entry = mapping[task];
    if (!entry) throw new AIError(`${this.name} 不支持任务 ${task}`, { code: AIErrorCode.UNSUPPORTED_TASK, provider: this.name });
    const template = loadTemplate(entry.template, { dir: this.promptsDir });
    return { prompt: renderTemplate(template, { ...vars, ...entry.extra }), json: entry.json };
  }

  /**
   * 模型返回的 JSON 经常包着 ```json 围栏，或者前后带一句废话。
   * 与其在提示词里反复强调（模型不一定听），不如在解析时宽容一点。
   */
  #shape(content, task, json) {
    if (task === AITask.SUMMARIZE) return parseSummary(content);
    if (task === AITask.SEO) return parseJson(content, { fallback: null });
    if (task === AITask.TAGS || task === AITask.TITLE) {
      const parsed = parseJson(content, { fallback: null });
      if (Array.isArray(parsed)) return parsed.map(String);
      // 不是 JSON 就按行拆，总比直接失败强
      return content.split('\n').map((line) => line.replace(/^[-*\d.\s"'[\]]+/, '').replace(/["',\]]+$/, '').trim()).filter(Boolean).slice(0, 8);
    }
    if (json) return parseJson(content, { fallback: content });
    return content.trim();
  }

  async #request(body, options) {
    const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
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
    return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
  }

  async #httpError(response) {
    const detail = await response.text().catch(() => '');
    return this.normalizeError({ status: response.status, message: `OpenAI 请求失败 ${response.status}: ${detail.slice(0, 200)}` });
  }
}

export function parseSummary(content) {
  const parsed = parseJson(content, { fallback: null });
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return {
      short: String(parsed.short ?? parsed.summary ?? parsed.brief ?? '').trim(),
      medium: String(parsed.medium ?? parsed.mediumSummary ?? '').trim(),
      long: String(parsed.long ?? parsed.detailed ?? '').trim(),
    };
  }
  return { short: content.trim(), medium: content.trim(), long: content.trim() };
}

/** 容错 JSON 解析：剥围栏、截取第一个 { 或 [ 到最后一个 } 或 ]。 */
export function parseJson(content, { fallback = null } = {}) {
  if (typeof content !== 'string') return content ?? fallback;
  let text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // 前后有解释文字时，截取最外层的括号再试
  }
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // 确实不是 JSON，落到 fallback
    }
  }
  return fallback;
}

async function* readLines(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) yield line.trim();
  }
  if (buffer.trim()) yield buffer.trim();
}

function formatExisting(tags) {
  if (!tags?.length) return '';
  return `\n已有标签库（请优先复用）：${tags.join('、')}\n`;
}

const STYLE_GUIDES = {
  正式: '书面语，避免口语词与语气助词，逻辑连接明确',
  口语: '像跟朋友聊天，可以用短句和口语词，但不轻浮',
  学术: '客观、克制，避免第一人称，术语准确，论证有保留',
  幽默: '有分寸的幽默感，可用比喻和反差，但不刻意搞笑、不冒犯',
  简洁: '能删就删，一句话一个意思，不用修饰语',
};

const LANGUAGE_NAMES = { en: '英文', zh: '中文', 'zh-CN': '中文', ja: '日文', ko: '韩文', fr: '法文', de: '德文', es: '西班牙文' };

export { STYLE_GUIDES };

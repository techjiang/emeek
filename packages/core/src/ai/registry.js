import { AIError, AIErrorCode, AIQuality, TASK_CAPABILITIES } from './types.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { MockProvider } from './providers/mock.js';
import { LocalProvider } from './providers/local.js';

/**
 * Provider 注册表 + 降级链。
 *
 * 这是整个 AI 层的决策中心，只有一条规则：
 * **永远不要因为 AI 不可用而让用户什么都得不到。**
 *
 * 降级顺序：用户指定的 provider -> 其它已配置的 LLM -> LocalProvider。
 * LocalProvider 没有前置条件，所以链的末端一定有东西能接住。
 */

export function createProvider(name, options = {}) {
  switch (name) {
    case 'openai':
      return new OpenAIProvider(options);
    case 'anthropic':
      return new AnthropicProvider(options);
    case 'mock':
      return new MockProvider(options);
    case 'local':
      return new LocalProvider(options);
    default:
      throw new AIError(`未知的 AI Provider：${name}`, { code: AIErrorCode.NOT_CONFIGURED });
  }
}

/**
 * 探测实际能用的 LLM Provider。
 *
 * 只看「配置齐不齐」不足以判断 —— key 可能是过期的、额度过期的、被墙的。
 * 所以这里会真的发一次 cheap 请求（isAvailable 在 LLM Provider 里是纯本地判断，
 * 真正的连通性交给具体的调用失败处理，避免启动时多打一次网络）。
 */
export async function resolveProviders(config = {}) {
  const providers = [];
  const configured = config.ai?.providers ?? {};

  if (configured.openai?.apiKey || config.ai?.openaiApiKey) {
    providers.push(new OpenAIProvider({ ...configured.openai, apiKey: configured.openai?.apiKey ?? config.ai?.openaiApiKey }));
  }
  if (configured.anthropic?.apiKey || config.ai?.anthropicApiKey) {
    providers.push(new AnthropicProvider({ ...configured.anthropic, apiKey: configured.anthropic?.apiKey ?? config.ai?.anthropicApiKey }));
  }

  // 纯 Provider 名列表（如 ai.providers = ['openai']）也支持
  if (Array.isArray(config.ai?.provider)) {
    for (const name of config.ai.provider) {
      try {
        providers.push(createProvider(name, { ...configured[name], promptsDir: config.ai?.promptsDir }));
      } catch {
        // 名字写错不该让构建失败，后面会告警
      }
    }
  }

  const available = [];
  for (const provider of providers) {
    try {
      if (await provider.isAvailable()) available.push(provider);
    } catch {
      // isAvailable 抛异常视为不可用
    }
  }
  return available;
}

/**
 * 带降级链的执行器。
 *
 * 返回结果里一定带 `source` 与 `quality`，UI 靠这两个字段决定
 * 显示「快速摘要」还是「AI 摘要 ✨」、以及是否显示降级提示条。
 */
export class AIService {
  constructor({ providers = [], local = new LocalProvider(), onWarn } = {}) {
    this.providers = providers;
    this.local = local;
    this.onWarn = onWarn ?? (() => {});
    this.lastError = null;
  }

  static async fromConfig(config = {}, { onWarn } = {}) {
    const providers = await resolveProviders(config);
    return new AIService({ providers, local: new LocalProvider({ promptsDir: config.ai?.promptsDir }), onWarn });
  }

  /** 当前是否处于降级模式。UI 的提示条就靠它。 */
  get isDegraded() {
    return this.providers.length === 0;
  }

  /** 离线时某个功能能不能用。不能用的功能应当禁用并说明原因，而不是点下去报错。 */
  capabilities() {
    const result = {};
    for (const [task, capability] of Object.entries(TASK_CAPABILITIES)) {
      result[task] = {
        available: this.providers.length > 0 || capability.local,
        degraded: this.providers.length === 0 && capability.local,
        label: this.providers.length > 0 ? capability.aiLabel : capability.label,
        reason: this.providers.length === 0 && !capability.local ? '需要配置 AI API Key' : null,
      };
    }
    return result;
  }

  /**
   * 执行任务。
   * 主 Provider 失败时**不抛出**，而是记下来继续降级 —— 除非所有环节都失败。
   */
  async run(input, task, options = {}) {
    const errors = [];

    for (const provider of this.providers) {
      if (!provider.supports(task)) continue;
      try {
        return await provider.complete(input, task, options);
      } catch (error) {
        errors.push({ provider: provider.name, code: error.code, message: error.message });
        this.onWarn(`AI Provider「${provider.name}」执行 ${task} 失败，尝试下一个：${error.message}`);
      }
    }

    const capability = TASK_CAPABILITIES[task];
    if (!capability?.local) {
      // 明确不可用比假装成功好：调用方需要知道这里没有兜底
      const error = new AIError(
        this.providers.length ? `${task} 在所有 AI Provider 上都失败了` : `${task} 需要配置 AI API Key（本地算法不提供此能力）`,
        { code: this.providers.length ? AIErrorCode.BAD_RESPONSE : AIErrorCode.NOT_CONFIGURED },
      );
      error.attempts = errors;
      throw error;
    }

    if (errors.length) this.onWarn(`已降级到本地算法：${task}`);
    const result = await this.local.complete(input, task, options);
    result.meta = { ...result.meta, fallback: true, attempts: errors };
    return result;
  }

  /** 摘要的便捷入口：离线也能拿到三档结果。 */
  async summarize(input, options = {}) {
    return this.run(input, 'summarize', options);
  }

  /**
   * 可读性走本地计算优先。
   *
   * 这不是降级 —— LLM 算 Flesch 分数会给出看似合理但毫无根据的数字，
   * 而本地计算是确定性的、可复现的、能被指回的。AI 只在本地算完之后
   * 补充「建议文字」，且这部分是可选的。
   */
  async readability(input, options = {}) {
    const result = await this.local.readability(input, options);
    if (this.providers.length && options.withAdvice !== false) {
      try {
        const advice = await this.run(input, 'seo', { ...options, readabilityOnly: true });
        if (advice?.content?.improvements) result.suggestions = [...result.suggestions, ...advice.content.improvements];
      } catch {
        // AI 补充建议失败无所谓，本地结论已经完整
      }
    }
    return result;
  }

  async seo(input, options = {}) {
    return this.run(input, 'seo', options);
  }

  async tags(input, options = {}) {
    return this.run(input, 'tags', options);
  }
}

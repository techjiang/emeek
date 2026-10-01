import { AIError, AIErrorCode, AIQuality, AITask, TASK_CAPABILITIES } from '../types.js';
import { AIProvider, requireText } from './base.js';

/**
 * 测试用 Provider：确定性输出。
 *
 * 存在的意义是让「AI 功能」这件事可测 —— 不能因为结果来自模型就只能靠肉眼看。
 * 所有输出都从输入内容推导（长度、关键词、句子数），所以同一份输入永远给同一份结果，
 * 断言可以写得非常具体，而不是「检查返回值非空」这种没有信息量的测试。
 *
 * 注意：这里返回的内容是**假的**，只能用于验证调用链路与格式。
 * 任何面向用户的真实质量判断都不能用 MockProvider 得出。
 */
export class MockProvider extends AIProvider {
  constructor({ name = 'mock', quality = AIQuality.GENERATIVE, failOn = null, latency = 0 } = {}) {
    super({ name, quality });
    this.failOn = failOn;
    this.latency = latency;
    this.calls = [];
    this.tasks = Object.values(AITask);
  }

  async isAvailable() {
    return this.failOn !== 'availability';
  }

  async complete(input, task = AITask.SUMMARIZE) {
    const text = requireText(input);
    this.calls.push({ task, input: text });

    if (this.latency) await new Promise((resolve) => setTimeout(resolve, this.latency));
    if (this.failOn === task) {
      throw new AIError(`MockProvider 按配置在 ${task} 上失败`, { code: AIErrorCode.NETWORK, provider: this.name });
    }
    if (this.failOn === 'all') {
      throw new AIError('MockProvider 按配置全局失败', { code: AIErrorCode.NETWORK, provider: this.name });
    }

    return this.result(this.#fabricate(text, task), { task, meta: { mock: true } });
  }

  async *completeStream(input, task = AITask.SUMMARIZE) {
    const result = await this.complete(input, task);
    const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    for (const chunk of content.match(/[\s\S]{1,12}/g) ?? []) yield chunk;
  }

  /**
   * 从输入本身派生一个「看起来像那么回事」的输出。
   * 长度跟输入挂钩，是为了让「摘要比原文短」这类约束真的能被断言到。
   */
  #fabricate(text, task) {
    const head = text.replace(/\s+/g, ' ').slice(0, 40);
    const marker = `[mock:${task}]`;
    switch (task) {
      case AITask.SUMMARIZE:
        return { short: `${marker}${head.slice(0, 20)}`, medium: `${marker}${head}`, long: `${marker}${text.slice(0, 80)}` };
      case AITask.TAGS:
        return ['MockTag', '测试', '确定性'].slice(0, Math.max(1, Math.min(3, Math.ceil(text.length / 50))));
      case AITask.CONTINUE:
        return `${marker} 这是续写内容，紧接在「${head.slice(-12)}」之后。`;
      case AITask.REWRITE:
        return `${marker} 改写后的版本：${head}`;
      case AITask.TITLE:
        return [`${marker} 标题候选一`, `${marker} 标题候选二`];
      case AITask.TRANSLATE:
        return `${marker} translated: ${head}`;
      default:
        return `${marker} ${head}`;
    }
  }
}

export { TASK_CAPABILITIES };

/**
 * 服务端 AI 代理（决策 D1 的第一层）。
 *
 * 存在的理由只有一条：**Key 不进浏览器**。
 *
 * 浏览器直连 provider 意味着 Key 必须到达页面 —— 一旦到达，
 * 它就同时存在于 DevTools 的网络面板、任何浏览器扩展、以及
 * 「不小心把 sessionStorage 导出来贴进 Issue」的风险里。
 * 而这些都不是「密钥管理做得好不好」的问题，是「它根本不该来」的问题。
 *
 * 所以这里的做法是：Key 只从**进程环境**读，请求由服务端发出去，
 * 浏览器只拿到结果。设置面板能看到的只有「服务端已配置」这一个事实。
 */
import { AIError, AIErrorCode } from '@emeeek/core/ai';
import { redact, scanForSecrets } from './keyring.js';

/** 环境变量名 → provider。顺序即优先级。 */
const ENV_KEYS = [
  { provider: 'openai', env: ['EMEEEK_OPENAI_API_KEY', 'OPENAI_API_KEY'], modelEnv: 'EMEEEK_OPENAI_MODEL', defaultModel: 'gpt-4o-mini' },
  { provider: 'anthropic', env: ['EMEEEK_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'], modelEnv: 'EMEEEK_ANTHROPIC_MODEL', defaultModel: 'claude-3-5-haiku-latest' },
];

/**
 * 从环境里探测服务端托管的 Key。
 *
 * 读的是 `process.env` 而不是配置文件：配置文件会进 git，
 * 而「把 Key 提交上去」是这类事故里最常见的一种。
 */
export function detectServerKey(env = process.env) {
  for (const entry of ENV_KEYS) {
    for (const name of entry.env) {
      const value = env[name];
      if (value && String(value).trim()) {
        return {
          provider: entry.provider,
          apiKey: String(value).trim(),
          model: env[entry.modelEnv] || entry.defaultModel,
          from: name,
        };
      }
    }
  }
  return null;
}

/**
 * 代理执行一次 AI 任务。
 *
 * 刻意不在这里做「本地降级」——降级是 core 的 AIService 的事。
 * 这里只负责「把请求带 Key 发出去、把结果与错误都消毒后带回来」。
 *
 * @returns {{ok: true, result: object} | {ok: false, error: {code: string, message: string}}}
 */
export async function runProxiedTask({ input, task, options = {}, server, fetchImpl = globalThis.fetch }) {
  if (!server?.apiKey) {
    return { ok: false, error: { code: AIErrorCode.NOT_CONFIGURED, message: '服务端没有配置 AI Key' } };
  }

  try {
    const { createProvider } = await import('@emeeek/core/ai');
    const provider = createProvider(server.provider, {
      apiKey: server.apiKey,
      model: server.model,
      fetchImpl,
    });
    const result = await provider.complete(input, task, options);
    return { ok: true, result };
  } catch (error) {
    /**
     * 错误信息是最容易漏 Key 的地方：上游 401 的响应体里经常会
     * 把整个请求头回显回来。所以这里**先扫再回**，而不是「相信 provider
     * 不会把 Key 放进错误消息里」。
     */
    const raw = String(error?.message ?? error ?? 'AI 请求失败');
    const { clean, redacted } = scanForSecrets(raw, { known: [server.apiKey] });
    return {
      ok: false,
      error: {
        code: error?.code ?? AIErrorCode.BAD_RESPONSE,
        message: clean ? raw : redacted,
        provider: server.provider,
        redacted: !clean,
      },
    };
  }
}

/**
 * 服务端状态：只暴露「有没有」，不暴露值。
 *
 * 刻意**不回 `from`**（那个环境变量名）—— 它会把「这台机器是怎么配的」
 * 告诉任何能打开这个页面的人，而这对使用者毫无用处。
 * 「谁配的、从哪个变量读的」是运维信息，不是界面信息。
 */
export function serverKeyStatus(server) {
  if (!server) return { configured: false, provider: null, model: null };
  return { configured: true, provider: server.provider, model: server.model };
}

/** 给日志用的单行描述 —— 永远不含 Key 本身。 */
export function describeServerKey(server) {
  if (!server) return '未配置服务端 Key（AI 写作辅助将不可用）';
  return `服务端已配置 ${server.provider} Key（来自 ${server.from}，模型 ${server.model}）`;
}

export { redact };

/**
 * 日志出口的单一入口。
 *
 * 为什么要有它：只要有人写一句 `logger.info(req.headers)`，Key 就出去了。
 * 把「记录任何东西」这件事收口到一个函数里，消毒就只有一处需要保证。
 */
export function safeLog(logger, level, message, extra = '') {
  const text = redact(`${message} ${extra}`, { known: [] });
  logger?.[level]?.(text);
  return text;
}

export class ProxyConfigError extends AIError {}

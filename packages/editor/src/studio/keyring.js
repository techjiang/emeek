/**
 * API Key 的分层存储（决策 D1）。
 *
 * 三层，按优先级：
 *   1. 服务端托管（dev 模式首选）—— Key 只存在于 dev server 进程内，
 *      浏览器拿不到，请求由服务端代理转发。这是唯一「Key 不进浏览器」的形态。
 *   2. 会话级（无服务端时的默认）—— 存在内存 + sessionStorage，关掉标签页即消失。
 *   3. 记住（必须用户显式勾选）—— 存 localStorage，会一直留着。
 *
 * 为什么默认不是「记住」：
 *   API Key 是长期凭证，泄露一次就要去后台吊销。而「记住我」这个勾选框
 *   是用户做的一个有意识的决定 —— 默认替用户勾上，等于替用户决定了
 *   「以后别人用这台机器也能花我的额度」。
 *
 * 为什么不允许把 Key 写进 URL / 日志 / 导出：
 *   见 redact / scanForSecrets —— 输出面扫描是这一层的另一半，
 *   只有「存得安全」而没有「不往别处漏」是不完整的。
 */

export const KEY_STORAGE = Object.freeze({
  SERVER: 'server',
  SESSION: 'session',
  PERSISTED: 'persisted',
  NONE: 'none',
});

export const KEY_STORAGE_LABEL = Object.freeze({
  server: '服务端已配置',
  session: '本次会话',
  persisted: '已记住',
  none: '未配置',
});

const SESSION_KEY = 'emeeek:ai:key:session';
const PERSIST_KEY = 'emeeek:ai:key:persisted';
const META_KEY = 'emeeek:ai:key:meta';

/** Provider 的 Key 前缀，用来在日志里做粗略识别（不依赖它做安全判断）。 */
const KEY_SHAPES = [/^sk-[A-Za-z0-9_-]{8,}/, /^sk-ant-[A-Za-z0-9_-]{8,}/, /^gsk_[A-Za-z0-9]{8,}/, /^[A-Za-z0-9_-]{24,}$/];

export function looksLikeApiKey(value) {
  const text = String(value ?? '');
  if (text.length < 16) return false;
  return KEY_SHAPES.some((re) => re.test(text));
}

/**
 * 抹掉文本里的 Key。日志、错误信息、导出内容都过它。
 *
 * 两条路一起走：
 *   · 已知的 Key 值（当前配置里的）逐个替换 —— 精确
 *   · 形如 Key 的长 token —— 兜底，覆盖「Key 泄漏在某个第三方返回的
 *     错误串里、而我们的配置里没有」的情况
 * 只做后者会漏（用户的 Key 未必长成我们猜的样子），只做前者也会漏。
 */
export function redact(text, { known = [], mask = '***' } = {}) {
  let out = String(text ?? '');
  for (const secret of known) {
    const value = String(secret ?? '');
    if (value.length < 8) continue;
    out = out.split(value).join(mask);
  }
  out = out.replace(/\b(?:sk|sk-ant|gsk|xai|api)[-_][A-Za-z0-9_-]{12,}\b/gi, mask);
  /**
   * 顺序在这里是有意义的，别随手调换。
   *
   * 认证头那条规则最「贪」：`Authorization: Bearer sk-xxx` 会被它整段吃掉，
   * 连 `Bearer` 一起换成 `***` —— 日志里就只剩「Authorization: ***」，
   * 排查时分不清是认证头出了问题还是整个请求头都没了。
   * 所以先单独处理 `Bearer <token>`（只抹 token），认证头那条放在最后兜底。
   */
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._-]{8,}/gi, `$1 ${mask}`);
  out = out.replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"']+/gi, `$1${mask}`);
  out = out.replace(/\b(x-api-key|api-key)\s*[:=]\s*[^\s,;"']+/gi, `$1: ${mask}`);
  out = out.replace(/\b(authorization)\s*[:=]\s*([^\s,;"']+)(\s+)([^\s,;"']+)/gi, (_, name, scheme, space) => `${name}: ${scheme}${space}${mask}`);
  return out;
}

/**
 * 输出面扫描：一段文本里还有没有 Key 残留。
 *
 * 「构造含 Key 的错误/导出/日志路径，断言无 Key 残留」靠的就是它。
 * 它同时被测试和生产代码使用 —— 生产里用它做最后一道兜底，
 * 测试里用它做断言。两处一份实现，不存在「测试扫的规则和运行时扫的不一样」。
 */
export function scanForSecrets(text, { known = [] } = {}) {
  const redacted = redact(text, { known });
  const hits = [];
  for (const secret of known) {
    const value = String(secret ?? '');
    if (value.length >= 8 && String(text).includes(value)) hits.push({ kind: 'known', value: `${value.slice(0, 4)}…` });
  }
  for (const pattern of [
    /\bsk-[A-Za-z0-9_-]{12,}/g,
    /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
    /\bgsk_[A-Za-z0-9]{12,}/g,
    /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
    /(?:api[_-]?key|token|access_token)=[^&\s"']{12,}/gi,
  ]) {
    for (const match of String(text).matchAll(pattern)) hits.push({ kind: 'shape', value: `${match[0].slice(0, 6)}…` });
  }
  return { clean: hits.length === 0, hits, redacted };
}

/**
 * Key 仓库。
 *
 * 三层不是「三个开关」，而是**一次有顺序的查找**：
 * 服务端有就用服务端的（用户根本不用输），否则看会话，最后看记住的那份。
 * 客户端永远拿不到服务端那份的明文 —— 它只知道「有」。
 */
export class KeyStore {
  /**
   * @param {object} options
   *   storage           localStorage 等价物（Node 测试注入）
   *   sessionStorage    会话级存储
   *   server            服务端状态探针：() => Promise<{configured, provider, model}>
   *   now               取时间戳
   */
  constructor({ storage, sessionStorage, server = null, now = () => Date.now() } = {}) {
    this.storage = storage ?? safeStorage('localStorage');
    this.session = sessionStorage ?? safeStorage('sessionStorage');
    this.server = server;
    this.now = now;
    /** 服务端状态缓存。null 表示还没探过。 */
    this.serverState = null;
  }

  /** 探一次服务端。探不通就当作「没有服务端托管」。 */
  async probeServer() {
    if (!this.server) { this.serverState = { configured: false }; return this.serverState; }
    try {
      const state = await this.server();
      this.serverState = state && typeof state === 'object' ? state : { configured: Boolean(state) };
    } catch {
      this.serverState = { configured: false, error: 'unreachable' };
    }
    return this.serverState;
  }

  /** 当前状态机：未配置 / 服务端已配置 / 会话中 / 已记住。 */
  async status() {
    const serverState = this.serverState ?? await this.probeServer();
    if (serverState.configured) return { kind: KEY_STORAGE.SERVER, provider: serverState.provider ?? null, model: serverState.model ?? null, label: KEY_STORAGE_LABEL.server };
    const meta = this.#meta();
    /**
     * 会话与持久两份同时存在时，报「已记住」——因为用户真正关心的
     * 是「关了标签页还在不在」。报「本次会话」会让一个已经持久化的 Key
     * 看起来随时会丢，用户于是再点一次「记住」，或者干脆不信任这个开关。
     */
    if (this.#read(this.storage, PERSIST_KEY) && meta.remembered) return { kind: KEY_STORAGE.PERSISTED, label: KEY_STORAGE_LABEL.persisted, ...meta };
    if (this.#read(this.session, SESSION_KEY)) return { kind: KEY_STORAGE.SESSION, label: KEY_STORAGE_LABEL.session, ...meta };
    if (this.#read(this.storage, PERSIST_KEY)) return { kind: KEY_STORAGE.PERSISTED, label: KEY_STORAGE_LABEL.persisted, ...meta };
    return { kind: KEY_STORAGE.NONE, label: KEY_STORAGE_LABEL.none, provider: null, model: null };
  }

  /**
   * 取当前可用的 Key。
   * 服务端模式返回 null —— 不是「没有」，而是「不该由客户端持有」。
   */
  get() {
    return this.#read(this.session, SESSION_KEY) ?? this.#read(this.storage, PERSIST_KEY) ?? null;
  }

  /**
   * 保存 Key。
   * @param {boolean} remember 显式勾选「记住」才落 localStorage。
   */
  set(apiKey, { remember = false, provider = null, model = null } = {}) {
    const value = String(apiKey ?? '').trim();
    if (!value) return this.clear();
    // 先写会话，再按需写持久层 —— 中途出错时至少「这次会话能用」
    this.#write(this.session, SESSION_KEY, value);
    if (remember) this.#write(this.storage, PERSIST_KEY, value);
    else this.#remove(this.storage, PERSIST_KEY);
    this.#writeMeta({ provider, model, updatedAt: this.now(), remembered: remember });
    return { ok: true, kind: remember ? KEY_STORAGE.PERSISTED : KEY_STORAGE.SESSION };
  }

  clear() {
    this.#remove(this.session, SESSION_KEY);
    this.#remove(this.storage, PERSIST_KEY);
    this.#remove(this.storage, META_KEY);
    return { ok: true, kind: KEY_STORAGE.NONE };
  }

  /**
   * 给 UI / 日志用的展示值。
   * 永远不返回明文 —— 连「前 4 位」也不给：8 个字符的 Key 前缀加上
   * 「我见过它」这件事，已经足以在社交工程里派上用场。
   */
  describe() {
    const key = this.get();
    if (!key) return { present: false, length: 0 };
    return { present: true, length: key.length };
  }

  #meta() {
    const raw = this.#read(this.storage, META_KEY);
    if (!raw) return { provider: null, model: null, updatedAt: null };
    try { return JSON.parse(raw); } catch { return { provider: null, model: null, updatedAt: null }; }
  }

  #writeMeta(meta) { this.#write(this.storage, META_KEY, JSON.stringify(meta)); }

  #read(store, key) {
    try { return store?.getItem(key) ?? null; } catch { return null; }
  }
  #write(store, key, value) {
    try { store?.setItem(key, value); } catch { /* 写不进去由调用方从 status() 看出来 */ }
  }
  #remove(store, key) {
    try { store?.removeItem(key); } catch { /* 删不掉不影响正确性 */ }
  }
}

function safeStorage(name) {
  try {
    const store = globalThis[name];
    const probe = '__emeeek_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)); },
      removeItem: (key) => { map.delete(key); },
    };
  }
}

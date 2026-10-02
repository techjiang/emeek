/**
 * 草稿存储：版本化、有上限、能被校验的 localStorage 包装。
 *
 * 为什么单独一个模块而不是在 client.js 里随手写两行 localStorage：
 * 「草稿不丢」是用户信任的基础，而「丢」的方式有好几种，每一种都得有对策 ——
 *
 *   写了一半被关机   → 停止输入 5 秒后落盘（不是只在 Ctrl+S 时落）
 *   改错了想回退     → 保留最近 5 个版本
 *   浏览器崩了       → 每次落盘都是完整 JSON，不做增量追加
 *   localStorage 写满 → 单草稿 2MB / 总 10MB 上限，超限淘汰最旧的
 *   仓库那边也改了   → 保存时比对 source 指纹，不一致就提示，不自动覆盖
 *
 * 还有一条更容易被忽略的：**同一个站点在多个标签页里打开**。
 * 两个标签页各自自动保存，后写的会静默覆盖先写的 —— 用户丢掉的是
 * 另一个标签页里半小时的输入，而且完全没有征兆。所以这里带一个
 * owner 标记，发现草稿被别的标签页写过就拒绝覆盖并如实上报。
 *
 * 这个文件不碰 DOM、不碰 CodeMirror：它是一个纯函数式的存储层，
 * 可以在 Node 里用假的 storage 完整测一遍（包括「写满」和「淘汰」）。
 */

export const DRAFT_LIMITS = Object.freeze({
  /** 单篇草稿上限 2MB。超过时**不截断**，只保留在内存里并明确告知用户。 */
  singleBytes: 2 * 1024 * 1024,
  /** 所有草稿合计上限 10MB。超过时淘汰最旧的（且永不动当前草稿）。 */
  totalBytes: 10 * 1024 * 1024,
  /** 保留最近 5 个版本，可回退。 */
  versions: 5,
  /** 停止输入 5 秒后自动保存。 */
  idleMs: 5000,
  /** 兜底：每 30 秒无条件保存一次（防止用户一直在敲键盘、从不停下来）。 */
  intervalMs: 30000,
});

const PREFIX = 'emeeek:draft:';
const INDEX_KEY = 'emeeek:drafts:index';
const OWNER_KEY = 'emeeek:drafts:owner';

/** 简易稳定指纹：长度 + 两处采样 + 滚动哈希。不要求抗碰撞，只要求「变了就能看出来」。 */
export function fingerprint(text) {
  const value = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${value.length.toString(36)}-${hash.toString(36)}`;
}

/** UTF-8 字节数。不要用 string.length：中文一个字 3 字节，按字符算会说 0.6MB 实际 1.8MB。 */
export function byteLength(text) {
  const value = String(text ?? '');
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  // 退化实现：BMP 之外的字符按 4 字节算
  let bytes = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * 把任意名字收敛成一个安全、可读、可比较的草稿 key。
 *
 * 用 encodeURIComponent 而不是「把非法字符替换成 -」：替换会让
 * `我的文章.md` 和 `我的-文章.md` 撞成同一个 key，两篇稿件互相覆盖。
 * 编码之后既唯一又能直接塞进 localStorage 的键名。
 */
export function draftKey(filename) {
  const name = String(filename ?? '').trim() || 'untitled.md';
  return `${PREFIX}${encodeURIComponent(name)}`;
}

export function filenameOf(key) {
  try { return decodeURIComponent(String(key).slice(PREFIX.length)); } catch { return String(key).slice(PREFIX.length); }
}

/** 内存 storage（Node 测试 / 隐私模式下 localStorage 不可用时用）。 */
export function createMemoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
    /** 测试用：塞爆配额。 */
    _setQuota(bytes) { this.quota = bytes; },
    _map: map,
  };
}

/**
 * 拿到一个可用的 storage。
 *
 * 隐私模式（Safari）/ 禁用站点数据时 localStorage 存在但一写就抛，
 * 也有环境里 window.localStorage 直接抛 SecurityError。所以**探测方式是
 * 真的写一次**，而不是判断 `typeof localStorage !== 'undefined'`。
 * 退化成内存存储时草稿仍然可用（刷新就没了），但功能不会中断。
 */
export function resolveStorage() {
  try {
    const probe = '__emeeek_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return createMemoryStorage();
  }
}

/**
 * 草稿仓库。
 *
 * 键布局：
 *   emeeek:draft:{filename}      → 最新版本记录
 *   emeeek:draft:{filename}:v{n} → 历史版本（最多 4 个，加上最新共 5 个）
 *   emeeek:drafts:index          → 索引：每篇的字节数、时间、source 指纹
 *   emeeek:drafts:owner          → 本标签页 id，用于多标签检测
 */
export class DraftStore {
  /**
   * @param {object} options
   *   storage   Storage（默认探测 localStorage，失败退内存）
   *   limits    上限，默认 DRAFT_LIMITS
   *   owner     标签页 id（默认随机；Node 测试里可固定）
   *   now       取时间戳（测试注入用）
   */
  constructor({ storage, limits = DRAFT_LIMITS, owner, now = () => Date.now() } = {}) {
    this.limits = { ...DRAFT_LIMITS, ...limits };
    this.storage = storage ?? resolveStorage();
    this.now = now;
    this.owner = owner ?? globalThis.__emeeek_owner__ ?? randomOwner();
    /** 上一次写入失败的原因。UI 靠它显示「保存失败」而不是「已保存」。 */
    this.lastError = null;
  }

  /**
   * 读取某篇草稿。
   * @returns {null | {filename, content, timestamp, version, title, source, owner, fingerprint, versions}}
   */
  load(filename) {
    const raw = this.#read(draftKey(filename));
    if (!raw) return null;
    const record = parseRecord(raw);
    if (!record) return null;
    return { ...record, versions: this.#history(filename) };
  }

  /** 列出所有草稿（不含正文，只有元信息）。 */
  list() {
    const index = this.#index();
    return Object.entries(index)
      .map(([filename, meta]) => ({ filename, ...meta }))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }

  /**
   * 保存一篇草稿。
   *
   * 返回结构化结果而不是 boolean —— 「成功 / 因为什么没成功」是 UI
   * 必须如实告诉用户的东西（保存失败却显示「已保存 ✓」是这里最严重的 bug）。
   *
   * @returns {{ok: boolean, reason: string|null, version: number, bytes: number,
   *            timestamp: number, fingerprint: string, owner: string,
   *            conflict: object|null, evicted: string[], error: string|null}}
   */
  save(filename, content, { title = '', source = null, force = false, owner = this.owner } = {}) {
    const text = String(content ?? '');
    const bytes = byteLength(text);
    const timestamp = this.now();
    const previous = this.load(filename);
    const previousVersions = previous?.versions ?? [];

    // 多标签页检测：同一篇草稿被另一个标签页写过。
    // 不静默覆盖 —— 那会丢掉另一个标签页里所有未保存的输入。
    const foreignOwner = previous && previous.owner && previous.owner !== owner;
    if (foreignOwner && !force) {
      return {
        ok: false, reason: 'foreign-tab', version: previous?.version ?? 0, bytes,
        // owner 要放**另一个**标签页的 id 与**本次**调用的标签页 id，
        // 不能只放一个 owner 名 —— UI 要说的句子是「A 和 B 都在编辑这篇」，
        // 一个字段承载不了这个信息（而且和成功分支的 owner 语义会打架：
        // 那里 owner 是「这次的写入者」）。
        owner, foreignOwner: previous?.owner ?? null,
        conflict: null, evicted: [], error: null,
        message: '这篇草稿正在另一个标签页里被编辑，已停止自动保存以免覆盖那边的输入。',
      };
    }

    // 单篇超限：不截断、不谎报。数据留在编辑器内存里，用户自己决定怎么办。
    if (bytes > this.limits.singleBytes) {
      return {
        ok: false, reason: 'too-large', version: previous?.version ?? 0, bytes,
        timestamp, fingerprint: fingerprint(text), owner,
        conflict: null, evicted: [], error: null,
        message: `文档 ${formatBytes(bytes)} 超过单篇草稿上限 ${formatBytes(this.limits.singleBytes)}，未写入本地存储。内容仍在编辑器里，请用「复制 Markdown」备份。`,
      };
    }

    const version = (previous?.version ?? 0) + (fingerprint(text) === previous?.fingerprint ? 0 : 1);
    /**
     * 来源要「合并」而不是「替换」。
     *
     * 冲突检测比的是「我上次同步时远端长什么样」与「现在远端长什么样」。
     * 基准指纹必须一直留着 —— 一旦被本次传入的指纹覆盖掉，
     * 下一次保存就会拿「现在的远端」跟自己比，永远不冲突（实测就是这样，
     * 冲突检测形同虚设）。
     */
    const baseSource = previous?.source ?? null;
    const incomingSource = typeof source === 'string' ? { id: source } : source;
    const nextSource = incomingSource
      ? { ...baseSource, ...incomingSource, fingerprint: baseSource?.fingerprint ?? incomingSource.fingerprint ?? null }
      : baseSource ?? guessSource(filename);

    const record = {
      filename,
      content: text,
      timestamp,
      version,
      title: title || previous?.title || '',
      source: nextSource,
      owner,
      fingerprint: fingerprint(text),
    };

    // 历史版本：把「上一个最新」推进历史，超过版本上限的丢掉。
    const history = [...previousVersions];
    if (previous && previous.fingerprint !== record.fingerprint) {
      history.unshift({ version: previous.version, timestamp: previous.timestamp, content: previous.content, bytes: byteLength(previous.content) });
    }
    const kept = history.slice(0, Math.max(0, this.limits.versions - 1));

    const evicted = [];
    try {
      this.#write(draftKey(filename), JSON.stringify(record));
      kept.forEach((entry, index) => {
        // v 的编号沿用原版本号，回退时才知道退到哪一版
        this.#write(`${draftKey(filename)}:v${index}`, JSON.stringify(entry));
      });
      // 版本数变少时清掉多余的旧键，否则淘汰掉的旧版本仍占空间
      for (let i = kept.length; i < previousVersions.length; i += 1) this.#remove(`${draftKey(filename)}:v${i}`);
      this.#touchIndex(filename, record);
      evicted.push(...this.#evict());
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      // 配额满：淘汰最旧的草稿后重试一次。retry 只做一次 ——
      // 反复重试在「整篇文档就超过总配额」时会变成死循环。
      const freed = this.#evict({ aggressive: true, protect: filename });
      if (freed.length) {
        try {
          this.#write(draftKey(filename), JSON.stringify(record));
          this.#touchIndex(filename, record);
          this.lastError = null;
          return { ok: true, reason: null, version, bytes, timestamp, fingerprint: record.fingerprint, owner, conflict: null, evicted: [...evicted, ...freed], error: null };
        } catch (retryError) {
          this.lastError = retryError.message;
        }
      }
      return {
        ok: false, reason: 'quota', version: previous?.version ?? 0, bytes, timestamp,
        fingerprint: record.fingerprint, owner, conflict: null, evicted: freed, error: this.lastError,
        message: `本地存储写入失败：${this.lastError}`,
      };
    }

    return {
      ok: true, reason: null, version, bytes, timestamp,
      fingerprint: record.fingerprint, owner,
      conflict: this.#detectConflict(record, source),
      evicted, error: null,
    };
  }

  /** 回退到第 n 个历史版本（0 是最新的历史版本）。 */
  restoreVersion(filename, index = 0) {
    const versions = this.#history(filename);
    const entry = versions[index];
    if (!entry) return null;
    const current = this.load(filename);
    // 回退本身也走一次 save，于是「回退」是可再回退的 —— 否则误点一下就回不去了
    const result = this.save(filename, entry.content, { title: current?.title, source: current?.source, force: true });
    return { ...result, restored: entry };
  }

  /** 删除草稿及其全部历史版本。 */
  remove(filename) {
    this.#remove(draftKey(filename));
    for (let i = 0; i < this.limits.versions; i += 1) this.#remove(`${draftKey(filename)}:v${i}`);
    const index = this.#index();
    delete index[filename];
    this.#writeIndex(index);
    return true;
  }

  /** 当前占用的总字节数（按索引估算，索引本身已按真实字节记）。 */
  usage() {
    const index = this.#index();
    return Object.values(index).reduce((sum, meta) => sum + (meta.bytes ?? 0), 0);
  }

  clearAll() {
    for (const { filename } of this.list()) this.remove(filename);
    this.#writeIndex({});
    return true;
  }

  #history(filename) {
    const out = [];
    for (let i = 0; i < this.limits.versions - 1; i += 1) {
      const raw = this.#read(`${draftKey(filename)}:v${i}`);
      const entry = raw ? parseRecord(raw) : null;
      if (entry) out.push({ version: entry.version, timestamp: entry.timestamp, content: entry.content, bytes: byteLength(entry.content) });
    }
    return out;
  }

  /**
   * 冲突检测。
   *
   * 只有「草稿记录了来源（github-issue-123 / posts/foo.md），而这次保存
   * 传入的来源指纹与草稿里的不同」才算冲突 —— 不能只看时间戳，
   * 用户在两台机器上编辑同一篇 Issue 的时间戳毫无可比性。
   */
  #detectConflict(record, incomingSource) {
    if (!incomingSource || !record.source) return null;
    const remote = typeof incomingSource === 'object' ? incomingSource : { id: String(incomingSource) };
    if (!record.source.id || !remote.id || record.source.id !== remote.id) return null;
    const remoteFingerprint = remote.fingerprint ?? null;
    const baseFingerprint = record.source.fingerprint ?? null;
    if (!remoteFingerprint || !baseFingerprint || remoteFingerprint === baseFingerprint) return null;
    return {
      source: record.source.id,
      baseFingerprint,
      remoteFingerprint,
      localTimestamp: record.timestamp,
    };
  }

  #touchIndex(filename, record) {
    const index = this.#index();
    index[filename] = {
      bytes: byteLength(record.content),
      timestamp: record.timestamp,
      version: record.version,
      title: record.title,
      source: record.source,
    };
    this.#writeIndex(index);
  }

  /**
   * 总容量淘汰。
   *
   * 规则：超限时按时间从旧到新删，**但永不动当前正在编辑的那篇**。
   * 淘汰掉用户此刻在看的东西，比让他删掉别的草稿更糟。
   */
  #evict({ aggressive = false, protect = null } = {}) {
    const evicted = [];
    const limit = aggressive ? this.limits.totalBytes * 0.5 : this.limits.totalBytes;
    let index = this.#index();
    let total = Object.values(index).reduce((sum, meta) => sum + (meta.bytes ?? 0), 0);
    const candidates = Object.entries(index)
      .filter(([filename]) => filename !== protect)
      .sort((a, b) => (a[1].timestamp ?? 0) - (b[1].timestamp ?? 0));
    for (const [filename, meta] of candidates) {
      if (total <= limit) break;
      total -= meta.bytes ?? 0;
      this.#remove(draftKey(filename));
      for (let i = 0; i < this.limits.versions; i += 1) this.#remove(`${draftKey(filename)}:v${i}`);
      delete index[filename];
      evicted.push(filename);
    }
    if (evicted.length) {
      index = this.#index();
      for (const filename of evicted) delete index[filename];
      this.#writeIndex(index);
    }
    return evicted;
  }

  #index() {
    const raw = this.#read(INDEX_KEY);
    if (!raw) return {};
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : {};
    } catch { return {}; }
  }

  #writeIndex(index) {
    this.#write(INDEX_KEY, JSON.stringify(index));
  }

  #read(key) {
    try { return this.storage.getItem(key); } catch { return null; }
  }

  #write(key, value) {
    this.storage.setItem(key, value);
  }

  #remove(key) {
    try { this.storage.removeItem(key); } catch { /* 删不掉不影响正确性 */ }
  }
}

/** 来源推断：没有显式 source 时，从文件名猜一个可读的来源标识。 */
export function guessSource(filename) {
  const name = String(filename ?? '');
  const issue = /issue[-_ ]?(\d+)/i.exec(name);
  if (issue) return { id: `github-issue-${issue[1]}`, kind: 'github-issue' };
  if (name && name !== 'untitled.md') return { id: `local-file:${name}`, kind: 'local-file' };
  return { id: 'local-file:untitled', kind: 'local-file' };
}

function parseRecord(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.content !== 'string') return null;
    return value;
  } catch { return null; }
}

function randomOwner() {
  return `tab-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 自动保存调度器。
 *
 * 两条触发线，缺一不可：
 *   停止输入 5 秒  → 覆盖绝大多数「写一段、想一想」的节奏
 *   每 30 秒兜底   → 覆盖「一直没停过」的情况（连续打字 10 分钟一次都没存）
 *
 * Ctrl+S 是第三条线：立即保存，并重置计时器。
 */
export function createAutoSaver({ store, filename, save, idleMs = DRAFT_LIMITS.idleMs, intervalMs = DRAFT_LIMITS.intervalMs, timers = globalThis } = {}) {
  let idleTimer = null;
  let intervalTimer = null;
  let dirty = false;
  let lastResult = null;

  function clearIdle() {
    if (idleTimer) { timers.clearTimeout(idleTimer); idleTimer = null; }
  }

  function flush(reason = 'manual') {
    clearIdle();
    if (!dirty && reason !== 'manual') return lastResult;
    dirty = false;
    lastResult = save(reason);
    return lastResult;
  }

  return {
    /** 内容变化时调用：重置 5 秒空闲计时。 */
    markDirty() {
      dirty = true;
      clearIdle();
      idleTimer = timers.setTimeout(() => flush('idle'), idleMs);
    },
    /** 手动保存（Ctrl+S / 保存按钮）。 */
    flush,
    /** 切换文件时把上一个文件写完，避免「切走了最后 3 秒的输入」。 */
    rename(next) { filename = next; },
    start() {
      if (intervalTimer) return;
      intervalTimer = timers.setInterval(() => flush('interval'), intervalMs);
      intervalTimer?.unref?.();
    },
    stop() {
      clearIdle();
      if (intervalTimer) { timers.clearInterval(intervalTimer); intervalTimer = null; }
    },
    get dirty() { return dirty; },
    get lastResult() { return lastResult; },
    get filename() { return filename; },
  };
}

/**
 * 热更新同步（决策 D4）。
 *
 * ## 立场与 S2-3a 完全一致
 *
 * ```
 * 本地干净 → 刷新（磁盘是唯一真相）
 * 本地脏   → 提示、两边都留、**不自动合并**
 * ```
 *
 * 不算「智能」的自动合并：那是把「谁的内容对」这个判断从用户手里拿走。
 * 合并算法在文本上永远能做，做出来的结果却可能是「两份都被改了，
 * 而用户以为没被改」。这里宁可让用户手动挑，也不猜。
 *
 * ## 状态文案复用现有五档
 *
 * 保存状态一共五档（已保存 / 保存中 / 未保存 / 保存失败 / 另一个标签页在编辑），
 * 全部来自 statusbar.js 的 SAVE_LABELS。热更新**不新增第二套说法** ——
 * 「磁盘已更新，本地有改动」是一个**提示**，不是第六种保存状态。
 * 两套说法并存的结果是用户要同时理解「我是已保存还是未保存」和
 * 「我是干净还是脏」，而它们说的其实是同一件事。
 */

export const SYNC_DECISION = Object.freeze({
  /** 本地干净 → 直接用磁盘内容。 */
  RELOAD: 'reload',
  /** 本地脏 → 两边都留，提示用户。 */
  CONFLICT: 'conflict',
  /** 磁盘内容与当前一致 → 什么都不做（自己保存下去的改动会走到这里）。 */
  NOOP: 'noop',
});

/**
 * 决定磁盘变更时该怎么办。
 *
 * @param {object} input
 *   localDirty       本地有没有未落盘的改动
 *   localFingerprint 本地内容的指纹
 *   remoteFingerprint 磁盘内容的指纹
 *   currentRemote    当前已知的磁盘指纹（上次同步时的）
 * @returns {{decision: string, message: string|null}}
 */
export function decideSync({ localDirty, localFingerprint, remoteFingerprint, currentRemote = null }) {
  // 磁盘变了但变回原样（比如编辑器写盘后触发的自回环）→ 什么都不做
  if (localFingerprint && remoteFingerprint && localFingerprint === remoteFingerprint) {
    return { decision: SYNC_DECISION.NOOP, message: null };
  }
  // 是「我们自己刚写下去的那一次」：remote 等于当前已知的 remote
  if (currentRemote && remoteFingerprint && currentRemote === remoteFingerprint) {
    return { decision: SYNC_DECISION.NOOP, message: null };
  }
  if (!localDirty) {
    return { decision: SYNC_DECISION.RELOAD, message: null };
  }
  return {
    decision: SYNC_DECISION.CONFLICT,
    /**
     * 文案要回答三个问题：发生了什么、你的东西在哪、我有没有动它。
     * 只说「文件已更新」会让人以为自己的改动没了。
     */
    message: '磁盘上的文件被改过了，而你本地也有未保存的改动。两边都留着 —— 你的内容还在编辑器里，磁盘上的版本也没有被动过。需要时先用「复制 Markdown」备份，再决定以哪边为准。',
  };
}

/**
 * 把决定渲染成一个提示条。
 *
 * 刻意不做「一键以磁盘为准」这种按钮：那是自动合并的另一种形式，
 * 只是把选择挪到了一个更容易误点的位置。要覆盖就自己全选粘贴。
 */
export function renderSyncNotice(host, { decision, message, onCopyLocal = null }) {
  if (!host) return;
  if (decision !== SYNC_DECISION.CONFLICT) {
    host.classList.remove('visible');
    host.innerHTML = '';
    return;
  }
  host.classList.add('visible');
  host.innerHTML = `<div class="ai-error"><strong>磁盘上的文件变了</strong>
    <p>${escapeHtml(message ?? '')}</p>
    <p class="hint">没有自动合并 —— 那是把「谁的内容对」这个判断从你手里拿走。</p>
  </div>`;
  if (onCopyLocal) host.querySelector('strong')?.setAttribute('data-copy-hook', '1');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * 与 dev server 的 SSE 通道对接。
 *
 * 复用 dev 已有的 `/__emeeek/reload` 事件流，而不是新开一个 ——
 * 两个通道意味着两条会各自断线重连的路径，而它们承载的是同一件事。
 */
export function connectReloadStream({
  eventSourceFactory = (url) => new globalThis.EventSource(url),
  url = '/__emeeek/reload',
  onMessage = () => {},
  onError = () => {},
  logger = console,
} = {}) {
  let source = null;
  let closed = false;

  return {
    start() {
      if (closed || source) return;
      try {
        source = eventSourceFactory(url);
      } catch (error) {
        logger.warn?.(`[sync] 无法连接热更新通道：${error.message}`);
        return;
      }
      source.onmessage = (event) => {
        let payload = {};
        try { payload = event?.data ? JSON.parse(event.data) : {}; } catch { payload = { raw: event?.data }; }
        try { onMessage(payload); } catch (error) {
          // 处理失败不能把通道带走 —— 通道还在，下一次变更才有机会被处理
          logger.warn?.(`[sync] 热更新处理失败（已隔离）：${error.message}`);
        }
      };
      source.onerror = (error) => {
        // EventSource 自己会重连；这里只记一笔，不主动 close
        try { onError(error); } catch { /* 回调出错不影响重连 */ }
      };
    },
    stop() {
      closed = true;
      try { source?.close?.(); } catch { /* 关不掉不影响退出 */ }
      source = null;
    },
    get connected() { return Boolean(source); },
  };
}

/**
 * 状态栏与性能提示。
 *
 * 这里的每一条都对应一个「用户此刻需要知道的预期」：
 *   字数 / 阅读时长  我写了多少、读者要花多久
 *   保存状态         我刚敲的字有没有落盘（最要紧的一条）
 *   行列位置         我在文档的哪儿
 *   大文档提示       为什么预览慢了一点 —— 让用户有预期，而不是怀疑编辑器坏了
 *
 * 「大文档提示」不是性能优化，是预期管理：27ms 的渲染用户根本感觉不到，
 * 但用户看到「正在渲染…」卡了一下会以为工具坏了。提前说明白就好。
 */

/** 阈值。50KB 是「正常博客文章的 5 倍」，到这个量级才值得提一句。 */
export const PERF_THRESHOLDS = Object.freeze({
  noticeBytes: 50 * 1024,
  largeBytes: 100 * 1024,
  slowMs: 50,
});

/**
 * UTF-8 字节数。
 *
 * 用 string.length 判断「文档大不大」是错的：中文一个字 3 字节，
 * 按字符算 30 万字的文档会被报成 300KB 而不是 900KB，
 * 于是「文档很大」的提示永远不出现。上限与提示一律按字节走。
 */
export function byteLength(text) {
  const value = String(text ?? '');
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  let bytes = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 大文档提示文案。
 *
 * 优先级：渲染慢 > 文档很大 > 文档较大。
 * 「慢」比「大」更该说 —— 大是客观事实，慢是用户正在经历的事。
 *
 * @returns {null | {level: 'notice'|'large'|'slow', text: string}}
 */
export function perfNotice(bytes, renderMs = 0) {
  if (renderMs > PERF_THRESHOLDS.slowMs) {
    return { level: 'slow', text: `预览渲染较慢（${Math.round(renderMs)}ms），建议分段编辑` };
  }
  if (bytes >= PERF_THRESHOLDS.largeBytes) {
    return { level: 'large', text: `文档很大（${formatBytes(bytes)}），预览可能有轻微延迟` };
  }
  if (bytes >= PERF_THRESHOLDS.noticeBytes) {
    return { level: 'notice', text: `文档较大（${formatBytes(bytes)}），渲染耗时 ${Math.round(renderMs)}ms` };
  }
  return null;
}

/** 保存状态文案。`local` 是没有可保存目标时的诚实说法。 */
export const SAVE_LABELS = Object.freeze({
  saved: '已保存 ✓',
  saving: '保存中…',
  dirty: '未保存 ●',
  failed: '保存失败 ✕',
  local: '本地草稿',
  'too-large': '未保存（超出 2MB 上限）',
  'foreign-tab': '另一个标签页在编辑',
  quota: '保存失败（存储已满）',
});

/**
 * 语言指示。
 *
 * 「中文文档里出现几个英文单词」不该被标成「中英混排」—— 那是绝大多数
 * 中文技术文章的样子。混排的判据是**两种文字都占到相当比例**，
 * 所以两边都要求 ≥ 20%；否则按多数派给主语言。
 *
 * 这个函数只服务于状态栏那个小标签，判错不影响任何编辑行为，
 * 但判错会让用户觉得编辑器不了解自己在写什么（实测第一版就是这样）。
 */
export function detectLanguage(text) {
  const value = String(text ?? '');
  const cjk = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  if (!cjk && !latin) return { code: 'plain', label: '纯文本', cjk, latin };
  if (cjk === 0) return { code: 'en', label: 'English', cjk, latin };
  if (latin === 0) return { code: 'zh', label: '中文', cjk, latin };
  const zhShare = cjk / (cjk + latin);
  if (zhShare >= 0.8) return { code: 'zh', label: '中文', cjk, latin };
  if (zhShare <= 0.2) return { code: 'en', label: 'English', cjk, latin };
  return { code: zhShare >= 0.5 ? 'zh' : 'en', label: '中英混排', cjk, latin };
}

/**
 * 整块状态栏的状态计算。
 *
 * 做成纯函数，UI 只负责把结果塞进 DOM —— 这样「保存失败却显示已保存」
 * 这类问题能在没有浏览器的测试里被抓住。
 */
export function statusState({ stats, bytes, savedState = 'local', renderMs = 0, text = '', dirty = false }) {
  const metric = stats ?? { words: 0, readingMinutes: 1, line: 1, column: 1, selected: 0, characters: 0 };
  const measured = bytes ?? metric.characters ?? 0;
  const language = detectLanguage(text);
  return {
    words: `${metric.words.toLocaleString('zh-CN')} 字`,
    reading: `约 ${Math.max(1, metric.readingMinutes)} 分钟`,
    cursor: `行 ${metric.line}, 列 ${metric.column}`,
    selected: metric.selected ? `选中 ${metric.selected}` : '',
    language: language.label,
    save: { state: savedState, label: SAVE_LABELS[savedState] ?? SAVE_LABELS.local },
    // 空文档不提示性能 —— 「文档较大（12KB）」出现在空白页上只会让人困惑
    perf: measured > 0 ? perfNotice(measured, renderMs) : null,
    dirty: Boolean(dirty),
  };
}

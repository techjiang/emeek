/**
 * 主题注入（customCSS / customHead / customFooter / 变量块）。
 *
 * 安全模型（S2-3b 白名单方案的延续，不允许回退）：
 *
 *   customCSS   → 只能进 <style>，且剥掉「能跳出样式上下文」的构造。
 *                 `</style>` 是唯一真正危险的东西：后面的内容会被当 HTML 解析，
 *                 于是 `</style><script>…` 是一条完整的 XSS。CSS 里其余部分
 *                 （url()、@import、表达式）在「不执行脚本」的前提下不需要拦。
 *
 *   customHead  → 白名单标签（meta / link / style / title / base 中的安全子集），
 *                 同样先剥 <script>/on* 与 javascript: URL。
 *
 *   customFooter→ 位置固定（footer 末尾），白名单标签（不含 <script> ——
 *                 与「不允许通过主题配置注入 <script>」一致）。
 *
 * 不做「任意位置注入」：位置由加载器写死在固定标记处，用户值只能填内容。
 */

/** 剥掉能终止 <style> 的序列，以及旧 IE 的表达式执行入口。 */
export function sanitizeCss(css) {
  return String(css ?? '')
    // `</style` 无论后面接什么都先打散 —— 这是唯一的样式上下文逃逸口。
    .replace(/<\/\s*style/gi, '<\\/style')
    // CSS 表达式（IE 的 expression()/behavior）属于可执行入口，直接移除。
    .replace(/expression\s*\(/gi, 'expr/*x*/ession(')
    .replace(/-moz-binding\s*:/gi, 'x-binding:')
    // @import 会引入外部样式 —— 允许，但 http(s) 之外的协议拦掉。
    .replace(/@import\s+(?!url\(\s*['"]?https?:)[^;]+;/gi, '');
}

/**
 * 过滤一段「head/footer 里允许出现的 HTML」。
 * 只保留结构化、不执行的标签；属性同样过白名单。
 */
const HEAD_TAGS = new Set(['meta', 'link', 'title', 'style', 'noscript']);
const FOOTER_TAGS = new Set(['div', 'span', 'p', 'a', 'img', 'br', 'hr', 'small', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'nav', 'section', 'footer', 'header']);
// 先吃掉左标签的 `>`，再接一个「到同名闭标签为止」的惰性体；无闭标签时只吃左标签。
const DROP_WITH_CONTENT = /<(script|iframe|object|embed|applet|portal|template)\b[^>]*>[\s\S]*?<\/\1\s*>|<(?:script|iframe|object|embed|applet|portal|template)\b[^>]*\/?>/gi;
const DROP_TAG = /<(?:form|input|button|select|textarea|base)\b[^>]*>/gi;

/**
 * @param {string} html
 * @param {'head'|'footer'} position
 * @returns {string} 安全子集；无法识别的标签被丢弃（连同内容）
 */
export function sanitizeInjection(html, position) {
  const allowed = position === 'head' ? HEAD_TAGS : FOOTER_TAGS;
  // <style> 在 head 里允许，但要再过一遍 sanitizeCss。
  const styles = [];
  let out = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_WITH_CONTENT, '')
    .replace(DROP_TAG, '')
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_, body) => {
      styles.push(body);
      return position === 'head' ? `\u0000STYLE${styles.length - 1}\u0000` : '';
    });

  // 标记：非 <style> 的标签全部按白名单清洗。属性只留安全集。
  out = out.replace(/<(\/?)([a-z][a-z0-9-]*)((?:\s+[^<>]*?)?)(\/?)>/gi, (full, slash, name, attrs, selfClose) => {
    const tag = name.toLowerCase();
    if (!allowed.has(tag)) return '';
    if (tag === 'style') return full;
    const kept = filterAttrs(attrs);
    // 只有自闭合/空元素允许没有结束标签；其余原样保留标签。
    return `<${slash}${tag}${kept}${selfClose ? ' /' : ''}>`;
  });

  return out.replace(/\u0000STYLE(\d+)\u0000/g, (_, idx) => `<style>${sanitizeCss(styles[Number(idx)])}</style>`);
}

const SAFE_ATTRS = new Set(['charset', 'name', 'content', 'property', 'http-equiv', 'rel', 'href', 'type', 'media', 'hreflang', 'sizes', 'as', 'crossorigin', 'referrerpolicy', 'class', 'id', 'title', 'alt', 'src', 'width', 'height', 'target', 'lang', 'dir', 'datetime', 'cite', 'loading', 'decoding']);

function filterAttrs(attrs) {
  const out = [];
  // content 的校验取决于同一标签上的 http-equiv，先把它捞出来。
  const eqMatch = /http-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/i.exec(attrs);
  const httpEquiv = eqMatch ? (eqMatch[1] ?? eqMatch[2] ?? eqMatch[3] ?? '') : '';
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match;
  while ((match = re.exec(attrs))) {
    const name = match[1].toLowerCase();
    if (name.startsWith('on')) continue;
    if (!SAFE_ATTRS.has(name)) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if ((name === 'href' || name === 'src') && !isSafeInjectionUrl(value)) continue;
    if (name === 'http-equiv' && !/^(?:content-security-policy|x-ua-compatible|content-type|refresh)$/i.test(value)) continue;
    // refresh 的跳转 URL 藏在 content 里，单独校验：只允许 http(s) 或相对路径。
    if (name === 'content' && httpEquiv === 'refresh') {
      if (!/^\s*\d+\s*(?:;\s*url=)?\s*[^;]*$/i.test(value)) continue;
      const urlPart = /url\s*=\s*(.+)$/i.exec(value);
      if (urlPart && !/^\s*(?:https?:|\/|\.)/i.test(urlPart[1].trim())) continue;
    }
    out.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

function isSafeInjectionUrl(raw) {
  const probe = String(raw ?? '').trim().replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:/.test(probe)) return true; // 相对路径 / 片段 / 协议相对
  const scheme = probe.slice(0, probe.indexOf(':'));
  return ['http', 'https', 'mailto', 'tel', 'data'].includes(scheme) && !(scheme === 'data' && /^data:text\/html/i.test(probe));
}

/**
 * 首帧无闪烁的暗色脚本。
 *
 * 关键约束：必须在 <head> 里**同步执行**，且早于任何样式表生效之前决定
 * data-theme。放到 footer 里 = 先渲染亮色再翻黑，闪一下。
 * 因此它是内联（不走外部文件），且不依赖任何异步 API。
 */
export function buildNoFlashScript(darkMode) {
  const forced = darkMode === 'light' || darkMode === 'dark' ? JSON.stringify(darkMode) : 'null';
  return `(function(){try{var m=${forced};var d=m||localStorage.getItem('emeeek-theme')||'auto';` +
    `var dark=d==='dark'||(d!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);` +
    `var r=document.documentElement;r.setAttribute('data-theme',dark?'dark':'light');` +
    `r.setAttribute('data-theme-mode',d);}catch(e){}})();`;
}

/**
 * 组装页面要注入的全部主题片段。
 *
 * 注入点的分工（写死在这里，不给主题/用户选择权）：
 *   headStyle    → 主题变量 + customCSS，进 <head>
 *   headExtra    → customHead，进 <head>
 *   footerExtra  → customFooter，进 footer 区
 *   noFlash      → 首帧 data-theme 脚本，必须是 <head> 里第一个同步脚本
 *
 * 顺序不能乱：no-flash 必须在样式生效前跑，所以它在 headStyle 之前。
 */
export function buildInjections(theme, themeConfig = {}) {
  const customCSS = sanitizeCss(themeConfig.customCSS ?? '');
  const cssBlocks = [theme.variables, customCSS].filter(Boolean);

  return {
    /** 变量 + 自定义 CSS，包在一个 <style> 里，减少节点数。 */
    headStyle: cssBlocks.length ? `<style>${cssBlocks.join('\n')}</style>` : '',
    headExtra: themeConfig.customHead ? sanitizeInjection(themeConfig.customHead, 'head') : '',
    footerExtra: themeConfig.customFooter ? sanitizeInjection(themeConfig.customFooter, 'footer') : '',
    noFlash: buildNoFlashScript(themeConfig.darkMode ?? 'auto'),
  };
}

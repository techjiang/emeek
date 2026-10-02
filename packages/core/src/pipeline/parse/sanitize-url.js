/**
 * URL 消毒。
 *
 * 这是「Markdown 预览能注入脚本」这条根风险的唯一堵口，所以它必须满足两件事：
 *   1. 在**所有**写 href/src 的地方都被调用（渲染器、图片装饰、双向链接）
 *   2. allowHtml 开着的时候也照样生效
 *
 * 为什么不是「转义引号就够了」：
 *   转义只挡得住跳出属性，挡不住 `javascript:` 这种**合法属性值**。
 *
 *     [点我](JaVaScRiPt:window.__xss=1)
 *
 *   渲染出来是一个完全合法的 <a href="JaVaScRiPt:...">，属性没被跳出，
 *   但用户一点就执行。真浏览器里验证过（见 tests/security/xss*.test.js）。
 *
 * 为什么「过滤掉 javascript: 前缀」也不够：
 *   浏览器解析 URL 时会先剥掉 ASCII 空白与控制字符（TAB / LF / CR）再判协议，
 *   所以 `java\tscript:`、`\x01javascript:`、`javascript&colon;` 都是活的。
 *   这里先把这些字符剥掉再判，判的是「浏览器会怎么理解」，不是「字符串长什么样」。
 *
 * 放行策略是**白名单**，不是黑名单。黑名单永远差一个你没见过的协议
 * （vbscript:、file:、blob:、filesystem:、jar: 以及将来某个新的）。
 */

/** 会被浏览器忽略的控制字符与空白（URL 规范里的 C0 控制符 + 空格）。 */
const IGNORED = /[\u0000-\u0020\u007f]/g;

/**
 * @returns {string|null} 安全可用的 URL；不安全时返回 null（调用方渲染成纯文本）。
 */
export function sanitizeUrl(raw, { allowData = false } = {}) {
  const value = String(raw ?? '').trim();
  if (!value) return '';

  // 判协议前先去掉浏览器会忽略的字符，否则 `java\tscript:` 会蒙混过关。
  const probe = value.replace(IGNORED, '').toLowerCase();

  // 相对路径、片段、协议相对（//host）都是安全的
  if (!/^[a-z][a-z0-9+.-]*:/.test(probe)) return value;

  const scheme = probe.slice(0, probe.indexOf(':'));

  // 显式白名单：只有这几种能出现在 href/src 上
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return value;
  if (scheme === 'data') {
    // data: 默认拒绝 —— `data:text/html,<script>…</script>` 是一条完整的 XSS。
    // 图片场景由调用方显式放开，且只放开图片 MIME。
    if (!allowData) return null;
    return /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)?[;,]/i.test(probe) ? value : null;
  }

  // 其余一律拒绝：javascript / vbscript / file / blob / filesystem / jar / chrome …
  return null;
}

export function isSafeUrl(url, options) {
  return sanitizeUrl(url, options) !== null;
}

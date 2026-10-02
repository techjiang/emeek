/**
 * 轻量语法高亮。
 *
 * 选择自研而非 Shiki/Prism：Shiki 需要按语言加载语法 JSON，Shiki 的 WASM 后端
 * 会让构建耗时从秒级变成分钟级。这里用一组通用 token 规则覆盖主流语言的高频结构，
 * 输出体积为零依赖。语义上够用，代价是消歧能力弱于完整词法分析器。
 */
const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'class', 'extends', 'new', 'this', 'super', 'import', 'from', 'export', 'default', 'async', 'await', 'yield', 'try',
  'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'static', 'get', 'set',
  'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'as', 'None', 'True', 'False', 'self', 'and', 'or', 'not', 'is',
  'fn', 'impl', 'trait', 'struct', 'enum', 'match', 'mut', 'pub', 'use', 'mod', 'crate', 'where', 'loop',
  'public', 'private', 'protected', 'interface', 'implements', 'final', 'abstract', 'package', 'synchronized',
  'func', 'defer', 'go', 'chan', 'map', 'range', 'select', 'type', 'interface', 'nil',
  'int', 'string', 'bool', 'float', 'double', 'char', 'long', 'short', 'byte', 'boolean', 'any', 'never',
  'echo', 'then', 'fi', 'done', 'esac', 'local', 'declare',
]);

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export function highlight(code, lang = '') {
  const text = String(code);
  const language = String(lang || '').toLowerCase();
  if (!language || ['text', 'plain', 'plaintext', 'none', 'log'].includes(language)) {
    return escapeHtml(text);
  }

  const patterns = [
    ['comment', language === 'python' || language === 'yaml' || language === 'sh' || language === 'bash' || language === 'ruby' ? /#[^\n]*/y : /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
    ['string', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/y],
    ['number', /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y],
    ['keyword', new RegExp(`\\b(?:${[...KEYWORDS].join('|')})\\b`, 'y')],
    ['function', /[A-Za-z_$][\w$]*(?=\s*\()/y],
    ['property', /(?<=\.)[A-Za-z_$][\w$]*/y],
    ['punctuation', /[{}[\]();,.:=+\-*/%<>!&|^~?@]+/y],
    ['identifier', /[A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*/y],
  ];

  let out = '';
  let index = 0;
  while (index < text.length) {
    let matched = false;
    for (const [type, regex] of patterns) {
      regex.lastIndex = index;
      const m = regex.exec(text);
      if (m && m[0]) {
        out += `<span class="tok-${type}">${escapeHtml(m[0])}</span>`;
        index += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += escapeHtml(text[index]);
      index += 1;
    }
  }
  return out;
}

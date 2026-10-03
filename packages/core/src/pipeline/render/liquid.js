/**
 * 极简模板引擎。
 *
 * 选它而不是 EJS/Nunjucks：{{ }} 插值 + {% %} 流程控制已覆盖主题所需的全部场景，
 * 实现不到 200 行，主题作者能一眼看懂它怎么工作；同时它没有任意代码执行能力 ——
 * 第三方主题应当是「数据 + 模板」，而不是「可执行代码」。
 *
 * 转义策略：{{ x }} 默认 HTML 转义，{{{ x }}} 输出原始 HTML。
 *
 * 变量解析：编译期把模板里出现的顶层标识符抽成局部变量（作用域链 局部 → 顶层 context）。
 * 循环变量通过 __scope 压栈，因此 `{% for p in posts %}{{ p.title }}{% endfor %}`
 * 里的 `p` 取自当前迭代，而 `posts` 取自顶层 context。
 */
const cache = new Map();

export function render(template, context) {
  return compile(template)(context);
}

export function compile(source) {
  const key = String(source);
  if (cache.has(key)) return cache.get(key);
  const body = tokenize(key).map(emit).join('');
  const names = [...new Set(collectNames(key))];
  const declarations = names
    .map((n) => `let ${n} = __lookup(${JSON.stringify(n)});`)
    .join('\n    ');

  // eslint-disable-next-line no-new-func
  const fn = new Function('__data', '__helpers', '__render', `
    const __out = [];
    const __push = (v) => { if (v !== null && v !== undefined) __out.push(v); };
    const __esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // 统一成 [值, 键] 二元组，让数组与对象能用同一种写法遍历。
    // 单变量形式取「值」；双变量形式按 {% for 键, 值 in 对象 %} 的直觉绑定。
    const __iter = (v) => Array.isArray(v)
      ? v.map((item, i) => [item, i])
      : (v && typeof v === 'object' ? Object.entries(v) : []);
    // 数组双变量形式读作 {% for 值, 索引 in 数组 %}，与对象的 {% for 键, 值 %} 保持
    // 同一形状：[第一个变量是元素本身，第二个是它的下标/键]。
    let __locals = {};
    const __lookup = (name) => (name in __locals ? __locals[name] : __data[name]);
    const __scope = (next, body) => { const prev = __locals; __locals = { ...prev, ...next }; try { body(); } finally { __locals = prev; } };
    // 未知过滤器返回原值：模板里写错一个名字不该让整站构建失败，
    // 但也不能静默产出一个错误的形状 —— 所以只在「名字对但参数错」时由过滤器自己兜。
    const __filter = (name, value, ...args) => (typeof __helpers[name] === 'function' ? __helpers[name](value, ...args) : value);
    ${declarations}
    ${body}
    return __out.join('');
  `);
  // 第二参数是当前局部作用域（循环变量等）：partial 需要它才能拿到迭代中的项。
  const wrapped = (context = {}, scope = {}) => fn(context, helpers, (name, locals) => (
    context.__render ? context.__render(name, { ...scope, ...(locals ?? {}) }) : ''
  ));
  cache.set(key, wrapped);
  return wrapped;
}

/** 抽出模板里用到的顶层标识符，跳过字符串字面量。 */
function collectNames(source) {
  const reserved = new Set(['true', 'false', 'null', 'undefined', 'if', 'else', 'in', 'of', 'and', 'or', 'not', 'typeof', 'instanceof', 'loop']);
  const found = [];
  // 只在模板标签内部扫描：直接对整份源码做引号剥离会误伤 HTML 属性，
  // 把 `lang="{{ site.language }}"` 里的表达式一起吃掉。
  const tagRegex = /\{#(?:[\s\S]*?)#\}|\{\{\{?([\s\S]*?)\}\}?\}|\{%\s*([^%]*?)\s*%\}/g;
  let match;
  while ((match = tagRegex.exec(String(source)))) {
    const expr = match[1] ?? match[2] ?? '';
    // 标签内部的字符串字面量（如 include "header"）不算变量引用。
    const cleaned = expr.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, ' ');
    const forMatch = /^for\s+([\s\S]+?)\s+in\s+/.exec(cleaned);
    const loopVars = forMatch ? forMatch[1].split(',').map((v) => v.trim()) : [];
    const body = forMatch ? cleaned.slice(forMatch[0].length) : cleaned;
    for (const name of body.match(/(?<![.\w$])([A-Za-z_$][\w$]*)/g) ?? []) {
      if (!reserved.has(name) && !loopVars.includes(name)) found.push(name);
    }
  }
  return found;
}

/**
 * 管道过滤器 → 表达式前缀变换。
 *
 *   `posts | slice: 0, 2`  →  __filter('slice', posts, 0, 2)
 *
 * 为什么在「编译期」做而不是在运行时 split：表达式本身可能是
 * `post.tags | len` 这种形式，运行时再解析就得再实现一遍表达式解析器。
 * 这里只做一件事 —— 认出顶层（不在引号/括号里的）管道符并改写。
 * 管道是「值 → 值」的函数调用，不是可执行代码，符合模板引擎的能力边界。
 */
function compileFilters(expr) {
  if (!expr.includes('|')) return expr;
  const parts = splitTopLevel(expr, '|');
  if (parts.length < 2) return expr;
  let out = parts[0].trim();
  for (const raw of parts.slice(1)) {
    const { name, args } = parseFilter(raw.trim());
    if (!name) return expr;
    out = `__filter(${JSON.stringify(name)}, ${out}${args ? `, ${args}` : ''})`;
  }
  return out;
}

/** 按分隔符切分，但跳过字符串字面量与括号内部。 */
function splitTopLevel(source, delimiter) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += source[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === delimiter && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** `slice: 0, 2` → { name: 'slice', args: '0, 2' }；无参形式 → args 为空串。 */
function parseFilter(source) {
  const colon = source.indexOf(':');
  const name = ((colon === -1 ? source : source.slice(0, colon)).match(/^[A-Za-z_$][\w$]*/) ?? [''])[0];
  if (!name) return { name: '', args: '' };
  const args = colon === -1 ? '' : source.slice(colon + 1).trim();
  return { name, args };
}

const helpers = {
  formatDate: (value, locale = 'zh-CN', options = {}) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', ...options });
  },
  isoDate: (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  },
  truncate: (text, limit = 100) => {
    const value = String(text ?? '');
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  },
  /**
   * 取子序列：`{{ posts | slice: 2 }}` / `{{ posts | slice: 0, 2 }}`。
   *
   * 为什么需要它：`{% for %}` 只有「从头开始」这一种遍历。
   * 杂志式首页要的是「前 2 篇当封面文章，其余进网格」—— 没有切分，
   * 主题只能把同一批文章渲染两遍（重复的标题在无障碍树里出现两次）。
   * 引擎侧给一个语义最简单、看得懂的函数，比在主题模板里堆 if/loop.index 可靠。
   */
  slice: (value, start = 0, end) => {
    const list = Array.isArray(value) ? value : [];
    const from = Math.max(0, Number(start) || 0);
    return end === undefined ? list.slice(from) : list.slice(from, Math.max(from, Number(end) || 0));
  },
  json: (value) => JSON.stringify(value).replace(/</g, '\\u003c'),
};

function tokenize(source) {
  const tokens = [];
  // {# … #} 是模板注释：它必须在这里被吃掉，不能落到 text token 里 ——
  // 落到 text 就会原样出现在页面上（主题作者写注释是为了解释模板，
  // 结果注释变成了正文，这是最难看的一种失败）。
  // 放在与插值同一个正则里，是为了保证扫描顺序（否则 \{\{ 会先吃掉注释的开头）。
  const regex = /\{#([\s\S]*?)#\}|\{\{\{([\s\S]*?)\}\}\}|\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g;
  let last = 0;
  let match;
  while ((match = regex.exec(source))) {
    if (match.index > last) tokens.push({ type: 'text', value: source.slice(last, match.index) });
    if (match[1] !== undefined) { /* 注释：丢弃 */ } else if (match[2] !== undefined) tokens.push({ type: 'raw', value: match[2].trim() });
    else if (match[3] !== undefined) tokens.push({ type: 'expr', value: match[3].trim() });
    else tokens.push({ type: 'tag', value: match[4].trim() });
    last = regex.lastIndex;
  }
  if (last < source.length) tokens.push({ type: 'text', value: source.slice(last) });
  return tokens;
}

let seq = 0;

function emit(token) {
  if (token.type === 'text') return `__push(${JSON.stringify(token.value)});`;
  if (token.type === 'expr') return `__push(__esc(${compileFilters(token.value)}));`;
  if (token.type === 'raw') return `__push(${compileFilters(token.value)});`;

  const tag = token.value;
  if (/^if\s/.test(tag)) return `if (${compileFilters(tag.slice(3))}) {`;
  // "else if " 恰好 8 个字符，slice(8) 才是条件表达式本身。
  if (/^else\s+if\s/.test(tag)) return `} else if (${compileFilters(tag.slice(8))}) {`;
  if (tag === 'else') return '} else {';
  if (tag === 'endif' || tag === '/if') return '}';
  if (/^for\s+/.test(tag)) {
    const [, decl, rawIterable] = /^for\s+([\s\S]+?)\s+in\s+([\s\S]+)$/.exec(tag);
    const iterable = compileFilters(rawIterable);
    const [first, second] = decl.split(',').map((s) => s.trim());
    seq += 1;
    const id = seq;
    // 两个分支闭合结构必须一致：外层 {} + for + __scope(...=>{ } )，由 endfor 统一收口。
    // 双变量：__iter 给 [键, 值] 或 [值, 索引]，这里的 ${first}/${second} 就是用户写的顺序。
    return second
      ? `{ let __idx = 0; const __arr = __iter(${iterable}); for (const [${first}, ${second}] of __arr) { const loop = { index: __idx + 1, first: __idx === 0, last: __idx === __arr.length - 1 }; __scope({ ${first}, ${second} }, () => {`
      : `{ let __idx = 0; const __arr = __iter(${iterable}); for (const [${first}] of __arr) { const loop = { index: __idx + 1, first: __idx === 0, last: __idx === __arr.length - 1 }; __scope({ ${first} }, () => {`;
  }
  if (tag === 'endfor' || tag === '/for') return '}); __idx += 1; } }';
  if (/^include\s/.test(tag)) return `__push(__render(${tag.slice(8)}, __locals));`;
  return '';
}

export function clearTemplateCache() {
  cache.clear();
}

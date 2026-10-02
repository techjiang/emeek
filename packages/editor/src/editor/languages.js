/**
 * 代码块语言高亮：一份「显式清单 + 真·按需加载」的语言注册表。
 *
 * 为什么不用 @codemirror/language-data：
 * 它注册了 143 种语言，而它的 load() 是 `Promise.resolve().then(() => init_distN())`
 * —— 打包器无法把它拆成异步块，于是 143 个语法解析器全被打进入口 bundle。
 * 实测入口 bundle 2.9MB，全部是首屏代价，而用户可能一篇代码都没有。
 * 那不是「懒加载」，那是把懒加载写成了注释。
 *
 * 这里的做法：显式列出要支持的语言，每一项用真正动态的 `import()`。
 * 结果：入口 bundle 回落到 700KB 级，某个语言的语法只在文档里真的出现
 * 该语言的代码块时才下网络。清单变短了，但清单上每一项都真的能用。
 *
 * Svelte / GraphQL / Elixir / Vue SFC 不在清单里 —— @codemirror 生态没有
 * 对应语法包，硬列上去就是「列了没实现」。它们会按纯文本渲染，并且
 * 补全面板会明确告知「无语法支持」。
 */

/** 语言定义：name 是展示名，alias 是代码块里可能写的写法。 */
const DEFINITIONS = [
  { name: 'JavaScript', alias: ['js', 'jsx', 'mjs', 'cjs', 'node'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })) },
  { name: 'TypeScript', alias: ['ts', 'tsx', 'mts'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })) },
  { name: 'HTML', alias: ['htm', 'xhtml'], load: () => import('@codemirror/lang-html').then((m) => m.html()) },
  { name: 'CSS', alias: ['scss', 'less', 'sass'], load: () => import('@codemirror/lang-css').then((m) => m.css()) },
  { name: 'JSON', alias: ['jsonc', 'json5'], load: () => import('@codemirror/lang-json').then((m) => m.json()) },
  { name: 'Python', alias: ['py', 'python3'], load: () => import('@codemirror/lang-python').then((m) => m.python()) },
  { name: 'Java', alias: [], load: () => import('@codemirror/lang-java').then((m) => m.java()) },
  { name: 'Go', alias: ['golang'], load: () => import('@codemirror/lang-go').then((m) => m.go()) },
  { name: 'Rust', alias: ['rs'], load: () => import('@codemirror/lang-rust').then((m) => m.rust()) },
  { name: 'PHP', alias: [], load: () => import('@codemirror/lang-php').then((m) => m.php()) },
  { name: 'C', alias: ['h'], load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()) },
  { name: 'C++', alias: ['cpp', 'c++', 'cc', 'cxx', 'hpp'], load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()) },
  { name: 'SQL', alias: ['mysql', 'postgres', 'postgresql', 'sqlite'], load: () => import('@codemirror/lang-sql').then((m) => m.sql()) },
  { name: 'XML', alias: ['svg', 'plist'], load: () => import('@codemirror/lang-xml').then((m) => m.xml()) },
  { name: 'YAML', alias: ['yml'], load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()) },
  // 以下走 legacy-modes 的流式词法器：有语法高亮，只是不如 Lezer 精细。
  // 一个语言 3~8KB，比等价的 Lezer 包小两个数量级 —— 对代码块来说够用。
  { name: 'Shell', alias: ['sh', 'bash', 'zsh', 'console', 'terminal'], load: () => loadLegacy('shell', 'shell') },
  { name: 'Ruby', alias: ['rb'], load: () => loadLegacy('ruby', 'ruby') },
  { name: 'C#', alias: ['csharp', 'cs'], load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.csharp)) },
  { name: 'Objective-C', alias: ['objc'], load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.objectiveC)) },
  { name: 'Kotlin', alias: [], load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.kotlin)) },
  { name: 'Scala', alias: [], load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.scala)) },
  { name: 'Dart', alias: [], load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.dart)) },
  { name: 'Swift', alias: [], load: () => import('@codemirror/legacy-modes/mode/swift').then((m) => legacy(m.swift)) },
  { name: 'Lua', alias: [], load: () => import('@codemirror/legacy-modes/mode/lua').then((m) => legacy(m.lua)) },
  { name: 'Perl', alias: ['pl'], load: () => import('@codemirror/legacy-modes/mode/perl').then((m) => legacy(m.perl)) },
  { name: 'R', alias: ['rscript'], load: () => import('@codemirror/legacy-modes/mode/r').then((m) => legacy(m.r)) },
  { name: 'PowerShell', alias: ['ps1', 'pwsh'], load: () => import('@codemirror/legacy-modes/mode/powershell').then((m) => legacy(m.powerShell)) },
  { name: 'Dockerfile', alias: ['docker'], load: () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => legacy(m.dockerFile)) },
  { name: 'Nginx', alias: ['nginxconf'], load: () => import('@codemirror/legacy-modes/mode/nginx').then((m) => legacy(m.nginx)) },
  { name: 'TOML', alias: [], load: () => import('@codemirror/legacy-modes/mode/toml').then((m) => legacy(m.toml)) },
  { name: 'Properties', alias: ['ini', 'conf', 'env'], load: () => import('@codemirror/legacy-modes/mode/properties').then((m) => legacy(m.properties)) },
  { name: 'LaTeX', alias: ['tex'], load: () => import('@codemirror/legacy-modes/mode/stex').then((m) => legacy(m.stex)) },
  { name: 'CMake', alias: ['cmake'], load: () => import('@codemirror/legacy-modes/mode/cmake').then((m) => legacy(m.cmake)) },
  { name: 'Erlang', alias: ['erl'], load: () => import('@codemirror/legacy-modes/mode/erlang').then((m) => legacy(m.erlang)) },
  { name: 'Diff', alias: ['patch'], load: () => import('@codemirror/legacy-modes/mode/diff').then((m) => legacy(m.diff)) },
  { name: 'Markdown', alias: ['md'], load: () => import('@codemirror/lang-markdown').then((m) => m.markdown()) },
];

/** 明确支持的语言（补全面板与文档都用这一份）。 */
export const SUPPORTED_LANGUAGES = DEFINITIONS.map((d) => d.name);

/** 补全面板里排在前面的常用语言。 */
export const COMMON_LANGUAGES = [
  'JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'C', 'C++', 'C#', 'Shell',
  'HTML', 'CSS', 'JSON', 'YAML', 'SQL', 'PHP', 'Ruby', 'Swift', 'Kotlin', 'Dockerfile',
  'PowerShell', 'TOML', 'Markdown', 'LaTeX', 'XML', 'Nginx', 'Diff',
];

/** 「无高亮」的写法，视为已知语言（就是纯文本）。 */
const PLAIN_NAMES = new Set(['plaintext', 'text', 'plain', 'none', 'log', 'txt', '']);

const lookup = new Map();
for (const definition of DEFINITIONS) {
  lookup.set(definition.name.toLowerCase(), definition);
  for (const alias of definition.alias) lookup.set(alias.toLowerCase(), definition);
}
// 常用名补齐：Bash / Docker 是用户直觉里会写的名字
lookup.set('bash', lookup.get('shell'));
lookup.set('docker', lookup.get('dockerfile'));

async function loadLegacy(module, exportName) {
  const mod = await import(/* @vite-ignore */ `@codemirror/legacy-modes/mode/${module}`);
  return legacy(mod[exportName]);
}

async function legacy(parser) {
  const { StreamLanguage } = await import('@codemirror/language');
  return StreamLanguage.define(parser);
}

/** 解析代码块语言名 → 定义（找不到返回 null）。 */
export function findLanguage(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return lookup.get(key) ?? null;
}

export function isKnownLanguage(name) {
  const key = String(name ?? '').trim().toLowerCase();
  return PLAIN_NAMES.has(key) || lookup.has(key) || lookup.has(key.replace(/\s+/g, ''));
}

/**
 * 代码块语言的 LanguageSupport 缓存。
 *
 * 缓存的是 Promise 而不是结果：同一份文档里 5 个 ```python 只会触发一次加载，
 * 加载期间重复请求拿到同一个 Promise。解析器是纯函数式的，全局共享安全。
 */
const cache = new Map();

export function loadLanguageSupport(name) {
  const definition = findLanguage(name);
  if (!definition) return null;
  if (!cache.has(definition.name)) {
    cache.set(definition.name, Promise.resolve()
      .then(() => definition.load())
      .catch((error) => {
        console.warn(`[studio] 语言 ${definition.name} 加载失败，按纯文本处理`, error);
        return null;
      }));
  }
  return cache.get(definition.name);
}

/** 给 @codemirror/lang-markdown 用的 codeLanguages 适配器（要求同步返回描述）。 */
export const codeLanguageDescriptions = DEFINITIONS.map((definition) => ({
  name: definition.name,
  alias: definition.alias,
  // markdown 包的 LanguageDescription 只要 load()，我们在这里桥接到缓存
  load: () => loadLanguageSupport(definition.name),
}));

/** 语言名列表（不含别名），给补全面板用。 */
export const LANGUAGE_NAMES = SUPPORTED_LANGUAGES;

/** 预加载：只有文档里出现该语言的代码块时才调用。 */
export async function preloadLanguages(names = []) {
  // 空串/'text' 这类「已知但没有语法包」的名字要过滤掉 —— 它们会返回 null，
  // 留在结果数组里会让「加载失败」的检查误判（测试里就是这么发现的一处漏判）。
  const loadable = names.filter((name) => findLanguage(name) !== null);
  return Promise.all(loadable.map((name) => loadLanguageSupport(name)));
}

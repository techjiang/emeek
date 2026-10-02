/**
 * 语言注册表测试。
 *
 * 核心断言不是「有 20 种语言」，而是「清单上每一种都真的能加载出语法」——
 * 上一轮被指出的问题正是「标了 ✅ 但不存在」。所以这里列表上的每一项
 * 都真的 import 一次。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_LANGUAGES, COMMON_LANGUAGES, findLanguage, isKnownLanguage, loadLanguageSupport, codeLanguageDescriptions, preloadLanguages } from '../src/editor/languages.js';

describe('语言清单', () => {
  test('至少 20 种语言', () => {
    assert.ok(SUPPORTED_LANGUAGES.length >= 20, `只有 ${SUPPORTED_LANGUAGES.length} 种`);
  });

  test('常用语言都在清单里', () => {
    for (const name of COMMON_LANGUAGES) {
      assert.ok(SUPPORTED_LANGUAGES.includes(name), `${name} 不在 SUPPORTED_LANGUAGES 里`);
    }
  });

  test('清单里没有重复项', () => {
    assert.equal(new Set(SUPPORTED_LANGUAGES).size, SUPPORTED_LANGUAGES.length);
  });

  test('清单上每一种语言都能真的加载出语法（不允许「列了没实现」）', async () => {
    const supports = await preloadLanguages(SUPPORTED_LANGUAGES);
    const failed = SUPPORTED_LANGUAGES.filter((_, index) => !supports[index]);
    assert.deepEqual(failed, [], `这些语言加载不出语法：${failed.join(', ')}`);
  });

  test('语言支持对象形状正确（有 extension 或 language）', async () => {
    const support = await loadLanguageSupport('JavaScript');
    assert.ok(support, 'JavaScript 应该有支持对象');
    assert.ok(support.extension || support.language, 'LanguageSupport 应有 extension 或 language');
  });
});

describe('语言名解析', () => {
  test('常见别名能解析到同一语言', () => {
    for (const [alias, name] of [['js', 'JavaScript'], ['ts', 'TypeScript'], ['py', 'Python'], ['sh', 'Shell'], ['bash', 'Shell'], ['yml', 'YAML'], ['rb', 'Ruby'], ['rs', 'Rust'], ['golang', 'Go'], ['docker', 'Dockerfile']]) {
      assert.equal(findLanguage(alias)?.name, name, `${alias} 应指向 ${name}`);
    }
  });

  test('大小写与空格不敏感', () => {
    assert.equal(findLanguage('  JAVASCRIPT ')?.name, 'JavaScript');
    assert.equal(findLanguage('Python')?.name, 'Python');
  });

  test('未知语言返回 null（由调用方决定退化成纯文本）', () => {
    assert.equal(findLanguage('brainfuck'), null);
    assert.equal(findLanguage(''), null);
    assert.equal(findLanguage(null), null);
  });

  test('isKnownLanguage：纯文本算已知，乱写的语言算未知', () => {
    assert.equal(isKnownLanguage('text'), true);
    assert.equal(isKnownLanguage('plaintext'), true);
    assert.equal(isKnownLanguage(''), true);
    assert.equal(isKnownLanguage('python'), true);
    assert.equal(isKnownLanguage('notalanguage'), false);
  });

  test('没有语法包的语言明确返回未知（不假装支持）', () => {
    // 这几个在 @codemirror 生态里没有语法包，刻意不进清单
    for (const name of ['svelte', 'graphql', 'elixir']) {
      assert.equal(findLanguage(name), null, `${name} 不该被声明为支持`);
    }
  });
});

describe('懒加载', () => {
  test('加载同一个语言两次返回同一个 promise（不重复下载）', () => {
    assert.equal(loadLanguageSupport('Rust'), loadLanguageSupport('rust'));
  });

  test('描述对象给 markdown 包的形状是 {name, alias, load}', () => {
    const sample = codeLanguageDescriptions.find((d) => d.name === 'Python');
    assert.ok(sample);
    assert.equal(typeof sample.load, 'function');
    assert.ok(Array.isArray(sample.alias));
    assert.equal(sample.load(), loadLanguageSupport('Python'));
  });

  test('预加载未知语言不报错，只是过滤掉', async () => {
    const result = await preloadLanguages(['notalanguage', '']);
    assert.deepEqual(result, []);
  });
});

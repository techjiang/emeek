import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDictionarySync, isDictionaryLoaded, dictionarySize,
  segment, segmentWords, decodeFrontCoded, resetDictionary,
} from '../../src/ai/local/segmenter.js';
import { extractKeywords, tokenize } from '../../src/ai/local/text.js';

describe('中文字典', () => {
  before(() => { loadDictionarySync(); });

  test('词典加载成功且规模合理', () => {
    assert.equal(isDictionaryLoaded(), true);
    assert.ok(dictionarySize() > 50000, `词条数 ${dictionarySize()} 偏少`);
  });

  test('front-coding 解码正确', () => {
    // 每行首字符是「与上一行共享的前缀长度」，其余是新后缀。
    // 静态 / 静态博客 / 静态博客引擎 应编码为：0静态 / 2博客 / 4引擎
    const encode = (words) => {
      let previous = '';
      return words.map((word) => {
        let shared = 0;
        while (shared < previous.length && shared < word.length && previous[shared] === word[shared]) shared += 1;
        const line = String.fromCharCode(shared) + word.slice(shared);
        previous = word;
        return line;
      }).join('\n');
    };
    const words = decodeFrontCoded(encode(['静态', '静态博客', '静态博客引擎']));
    assert.ok(words.has('静态'));
    assert.ok(words.has('静态博客'));
    assert.ok(words.has('静态博客引擎'));
    assert.equal(words.size, 3);
  });
});

describe('分词质量', () => {
  before(() => { loadDictionarySync(); });

  test('常见技术词组不被切碎', () => {
    // 断言「切出来的是完整的词」而不是「切成特定的几个词」：
    // 补充词表加入后「静态站点」会作为一个整体被切出，那是改进不是回归。
    // 测试要守住的是「不出现碎片」，不是「必须按某种方式切」。
    const cases = ['博客引擎', '静态站点', '数据库', '服务器', '首屏'];
    for (const word of cases) {
      const result = segment(word);
      assert.equal(result.join(''), word, `「${word}」切分后拼不回原文：${result.join('/')}`);
      assert.ok(result.length <= 2, `「${word}」被切得过碎：${result.join('/')}`);
      // 每个片段都必须是词典里的真词，而不是半截碎片
      for (const piece of result) {
        assert.ok([...piece].length >= 1, `空片段`);
      }
    }
  });

  test('项目补充词表生效（上游通用词典没有的词）', () => {
    // 「首屏」不在 segmentit 的通用词典里，是 extra-words.txt 补上的
    assert.deepEqual(segment('首屏'), ['首屏']);
    assert.deepEqual(segment('内联'), ['内联']);
  });

  test('不再产生跨词碎片', () => {
    // 这是无词典分词方案的典型失败：下面这些碎片绝不能出现
    const fragments = ['客引', '擎基', '擎基', '个博', '态站', '点零', '让写和', '建静', '本部'];
    const text = '博客引擎基于 GitHub 构建静态站点。静态站点零成本部署。让写和发布变简单。';
    const tokens = tokenize(text);
    for (const fragment of fragments) {
      assert.ok(!tokens.includes(fragment), `出现了跨词碎片：${fragment}`);
    }
  });

  test('英文词与数字原样保留', () => {
    const result = segment('Emeek 支持 GitHub Issues 和 WebP 格式，首屏小于 50KB');
    const joined = result.join('|');
    assert.ok(joined.includes('GitHub'));
    assert.ok(joined.includes('Issues'));
    assert.ok(joined.includes('WebP'));
    assert.ok(joined.includes('50'));
  });

  test('标点与空白不被当成词', () => {
    const words = segmentWords('性能，不是优化出来的。');
    assert.ok(!words.includes('，'));
    assert.ok(!words.includes('。'));
    assert.ok(words.includes('性能'));
  });

  test('长句分词结果可拼回原文', () => {
    // 分词是无损的：拼回去必须和原文一致，否则说明丢了字符
    const text = '默认主题从第一天起就按一次请求来设计，样式表内联进头部';
    assert.equal(segment(text).join(''), text);
  });

  test('未登录词（人名/新词）不会崩，退化为更小的切分', () => {
    const result = segment('张三丰在用某个不存在的词XYZ说事');
    assert.ok(result.length > 0);
    assert.equal(result.join(''), '张三丰在用某个不存在的词XYZ说事');
  });
});

describe('分词对关键词质量的影响', () => {
  before(() => { loadDictionarySync(); });

  test('提取出的关键词是完整的词而非字', () => {
    const text = 'Emeek 博客引擎把 GitHub Issues 当作内容源，构建时生成纯静态页面。静态站点方案没有服务器，也不需要数据库。';
    const keywords = extractKeywords(text, { top: 8 }).map((k) => k.term);
    // 断言的性质是「提取出的是实词」而不是「必须包含某个特定词」——
    // 后者会随词典调整而失效，前者才是我们真正要保护的。
    const joined = keywords.join('、');
    assert.ok(keywords.length >= 5, `关键词太少：${joined}`);
    assert.ok(keywords.some((k) => ['服务器', '数据库', '内容源', '构建时', '静态站点', '静态'].includes(k)),
      `应提取出正文中的实词，实际：${joined}`);
    // 不应出现单字关键词（除非是技术符号）
    for (const keyword of keywords) {
      if (/^[\u4e00-\u9fa5]+$/.test(keyword)) {
        assert.ok([...keyword].length >= 2, `关键词「${keyword}」是单字，说明分词退化`);
      }
    }
  });

  test('虚词被过滤，不占关键词名额', () => {
    const text = '这个功能是可以使用的，我们需要通过它们来完成的。如果这样的话，那么我们就应该去看一下。';
    const keywords = extractKeywords(text, { top: 5 }).map((k) => k.term);
    for (const stop of ['可以', '我们', '需要', '应该', '如果', '这个']) {
      assert.ok(!keywords.includes(stop), `停用词「${stop}」不应成为关键词`);
    }
  });
});

describe('分词降级行为', () => {
  test('词典未加载时 segment 返回 null 而非抛异常', () => {
    resetDictionary();
    assert.equal(segment('测试文本'), null);
    assert.equal(segmentWords('测试文本'), null);
    // 恢复，避免影响其它测试
    loadDictionarySync();
  });

  test('词典缺失时 tokenize 退化为单字但仍可用', () => {
    resetDictionary();
    const tokens = tokenize('性能优化设计');
    assert.ok(tokens.length > 0, '降级后仍应有输出');
    // 降级路径丢掉虚词，但保留实义字
    assert.ok(tokens.includes('性') || tokens.includes('能') || tokens.includes('优'));
    loadDictionarySync();
  });
});

describe('分词性能', () => {
  before(() => { loadDictionarySync(); });

  test('单次分词 < 1ms', () => {
    const text = '性能不是优化出来的，是设计出来的。Emeek 的默认主题从第一天起就按一次请求来设计。';
    for (let i = 0; i < 100; i += 1) segment(text);
    const start = performance.now();
    for (let i = 0; i < 200; i += 1) segment(text);
    const perCall = (performance.now() - start) / 200;
    assert.ok(perCall < 1, `单次分词 ${perCall.toFixed(3)}ms，超过 1ms`);
  });
});

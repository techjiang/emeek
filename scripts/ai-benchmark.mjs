/**
 * AI 本地模块基准测试。
 *
 * 单独跑而不是塞进单元测试，因为它要输出数据给人看 —— 测试只断言阈值，
 * 这里要回答「到底多快、快在哪」。
 *
 * 用法：node scripts/ai-benchmark.mjs [--json]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalSummarizer } from '../packages/core/src/ai/local/summarizer.js';
import { ReadabilityAnalyzer } from '../packages/core/src/ai/local/readability.js';
import { LocalSEOAnalyzer } from '../packages/core/src/ai/local/seo.js';
import { loadDictionarySync, dictionarySize, segment } from '../packages/core/src/ai/local/segmenter.js';
import { extractKeywords } from '../packages/core/src/ai/local/text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  'examples/minimal/posts/2024-01-15-why-emeeek.md',
  'examples/minimal/posts/2024-02-03-markdown-syntax.md',
  'examples/minimal/posts/2024-03-20-performance-notes.md',
  'examples/full-featured/posts/2024-04-01-welcome.md',
  'docs/configuration.md',
  'docs/themes.md',
  'docs/plugins.md',
  'docs/performance.md',
  'README.md',
];

/** 稳定的 10KB 测试文本：拼接仓库真实文档，而不是重复填充字符。 */
async function buildCorpus(targetSize = 10000) {
  const files = await Promise.all(SOURCES.map((file) => fs.readFile(path.join(ROOT, file), 'utf8')));
  let text = files.join('\n\n');
  while (text.length < targetSize) text += `\n\n${files.join('\n\n')}`;
  return text.slice(0, targetSize);
}

function measure(label, fn, { iterations = 30, warmup = 5 } = {}) {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    p50: samples[Math.floor(samples.length * 0.5)],
    p90: samples[Math.floor(samples.length * 0.9)],
    min: samples[0],
    max: samples[samples.length - 1],
  };
}

const fmt = (n) => `${n.toFixed(2)}ms`;

async function main() {
  const asJson = process.argv.includes('--json');
  const corpus = await buildCorpus(10000);
  const source = await fs.readFile(path.join(ROOT, SOURCES[0]), 'utf8');

  const summarizer = new LocalSummarizer();
  const readability = new ReadabilityAnalyzer();
  const seo = new LocalSEOAnalyzer();
  const post = { title: '基准测试文章', raw: corpus, description: '基准测试用描述，长度需要超过五十个字符才能进入理想区间以便观察评分变化。', tags: ['基准', '测试'], slug: 'benchmark-post', date: '2024-04-01', author: 'bench', cover: '/c.png', url: 'https://example.com/posts/benchmark-post.html' };

  // 词典加载单独计时（一次性成本）
  const dictStart = performance.now();
  loadDictionarySync();
  const dictLoadMs = performance.now() - dictStart;

  const results = [
    measure('分词（单句，词典已加载）', () => segment('性能不是优化出来的，是设计出来的。默认主题从第一天起就按一次请求来设计。')),
    measure('关键词提取 top-5', () => extractKeywords(corpus, { top: 5 })),
    measure('摘要 summarize(100)', () => summarizer.summarize(corpus, 100)),
    measure('摘要 summarizeMulti（三档）', () => summarizer.summarizeMulti(corpus)),
    measure('可读性分析', () => readability.analyze(corpus)),
    measure('SEO 分析', () => seo.analyze(post, {})),
  ];

  const targets = {
    '摘要 summarize(100)': 50,
    '摘要 summarizeMulti（三档）': 100,
    可读性分析: 30,
    'SEO 分析': 30,
  };

  if (asJson) {
    console.log(JSON.stringify({ corpusBytes: Buffer.byteLength(corpus), dictionaryWords: dictionarySize(), dictionaryLoadMs: dictLoadMs, results }, null, 2));
    return;
  }

  console.log('\n  Emeek 本地 AI 模块基准\n');
  console.log(`  语料：${Buffer.byteLength(corpus)} 字节真实文档（${SOURCES.length} 个仓库文件拼接）`);
  console.log(`  词典：${dictionarySize().toLocaleString()} 词条 · 首次加载 ${dictLoadMs.toFixed(1)}ms（一次性，惰性触发）\n`);
  console.log('  模块                          中位       P90        目标      结果');
  console.log('  ' + '─'.repeat(72));

  let allPass = true;
  for (const result of results) {
    const target = targets[result.label];
    const pass = target === undefined ? null : result.p50 < target;
    if (pass === false) allPass = false;
    const targetText = target === undefined ? '—' : `< ${target}ms`;
    const verdict = pass === null ? '—' : pass ? 'PASS' : 'FAIL';
    console.log(`  ${result.label.padEnd(28)} ${fmt(result.p50).padStart(8)} ${fmt(result.p90).padStart(9)} ${targetText.padStart(9)}  ${verdict}`);
  }
  console.log('  ' + '─'.repeat(72));

  // 输出效果样例，让数字背后有具体的东西
  console.log('\n  摘要效果（examples/minimal/posts/2024-01-15-why-emeeek.md）\n');
  const sample = summarizer.summarizeMulti(source);
  for (const [key, value] of Object.entries(sample)) {
    if (key === 'status') continue;
    console.log(`  ${key.padEnd(7)} ${value.split('\n').join(' ').slice(0, 90)}`);
  }

  console.log('\n  关键词提取\n');
  console.log(`  ${extractKeywords(source, { top: 8 }).map((k) => k.term).join(' · ')}\n`);

  const seoResult = seo.analyze({ ...post, raw: source, slug: 'why-emeeek', title: '为什么我们还需要一个静态博客引擎' }, {});
  console.log(`  SEO 检查：${seoResult.checks.length} 项，得分 ${seoResult.score}（${seoResult.level}），待改进 ${seoResult.improvement_count} 项\n`);

  console.log(allPass ? '  全部达标\n' : '  存在未达标项\n');
  if (!allPass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

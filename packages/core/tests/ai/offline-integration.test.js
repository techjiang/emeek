import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIService, LocalProvider, AITask, TASK_CAPABILITIES } from '../../src/ai/index.js';
import { parseFrontmatter } from '../../src/pipeline/parse/frontmatter.js';
import { stripMarkdown } from '../../src/ai/local/text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const EXAMPLE_POSTS = [
  'examples/minimal/posts/2024-01-15-why-emeeek.md',
  'examples/minimal/posts/2024-02-03-markdown-syntax.md',
  'examples/minimal/posts/2024-03-20-performance-notes.md',
];

/**
 * 端到端离线集成测试。
 *
 * 这是「没配 API Key 也能用」这句话的证明。前面各模块的单元测试只说明
 * 每个零件能转，这一组要说明：把 AIService 以完全无配置的状态跑起来，
 * 仓库里真实存在的文章能走完写作辅助的每一步。
 */
async function loadPost(file) {
  const raw = await fs.readFile(path.join(ROOT, file), 'utf8');
  const { data, content } = parseFrontmatter(raw);
  return {
    ...data,
    raw: content,
    slug: (data.slug ?? path.basename(file, '.md')).replace(/^\d{4}-\d{2}-\d{2}-/, ''),
    date: data.date ?? '2024-01-01',
    author: data.author ?? 'cosy',
  };
}

describe('离线集成：无 API Key 的完整写作辅助流程', () => {
  let service;

  before(async () => {
    // 完全无配置：没有 key、没有 provider，只有一个 LocalProvider
    service = await AIService.fromConfig({});
    assert.equal(service.isDegraded, true, '无配置时应处于降级模式');
  });

  test('对真实文章生成三档摘要，长度递增且非空', async () => {
    for (const file of EXAMPLE_POSTS) {
      const post = await loadPost(file);
      const result = await service.summarize(post.raw, { title: post.title });
      assert.equal(result.source, 'local', `${file} 应来自本地算法`);
      assert.ok(result.content.short.length > 0, `${file} 短档摘要为空`);
      assert.ok(result.content.medium.length >= result.content.short.length, `${file} 中档应不短于短档`);
      assert.ok(result.content.long.length >= result.content.medium.length, `${file} 长档应不短于中档`);
    }
  });

  test('摘要句全部来自原文（端到端防幻觉）', async () => {
    for (const file of EXAMPLE_POSTS) {
      const post = await loadPost(file);
      const result = await service.summarize(post.raw);
      // 比对基准必须是「清洗后的正文」而不是原始 Markdown：
      // 摘要里的 `srcset` 对应原文的 `` `srcset` ``，反引号是标记不是内容。
      // 直接拿 Markdown 原文比对，会把「正常去标记」误判为幻觉。
      // 但必须仍然能抓到真正的编造 —— 见下一条测试。
      const source = stripMarkdown(post.raw).replace(/\s+/g, '');
      // 抽取式摘要的每一句都必须在原文里逐字存在。
      // 比对前两边都去掉空白：原文里的换行与缩进不该导致误判为幻觉。
      // 但要保留标点 —— 那是判断句子边界与截断位置的依据。
      for (const sentence of result.content.medium.split(/\n+/)) {
        const core = sentence.trim().replace(/\s+/g, '');
        if (core.replace(/[^\w\u4e00-\u9fa5]/g, '').length < 8) continue;
        assert.ok(source.includes(core), `${file} 的摘要句不在原文中：${sentence}`);
      }
    }
  });

  test('防幻觉检查本身是有效的（能抓到编造内容）', async () => {
    // 如果这条测试永远通过，说明上一条测试是假通过。这里手动构造一个
    // 「摘要句不在原文中」的情形，验证检查逻辑真的会拒绝。
    const post = await loadPost(EXAMPLE_POSTS[0]);
    const source = stripMarkdown(post.raw).replace(/\s+/g, '');
    const fabricated = 'Emeek 在 2025 年被 GitHub 官方收购，并成为 Pages 的默认构建引擎。';
    const core = fabricated.replace(/\s+/g, '');
    assert.equal(source.includes(core), false, '编造的内容不应能在原文中找到（否则检查无效）');
  });

  test('对真实文章做可读性分析并给出可执行建议', async () => {
    for (const file of EXAMPLE_POSTS) {
      const post = await loadPost(file);
      const result = await service.readability(post.raw, { withAdvice: false });
      assert.equal(result.quality, 'high', '本地可读性是高可信结果');
      assert.ok(result.content.score >= 0 && result.content.score <= 100, `${file} 分数越界`);
      assert.ok(result.content.suggestions.length > 0, `${file} 应给出至少一条建议`);
      for (const suggestion of result.content.suggestions) {
        assert.ok(suggestion.length > 8, `${file} 建议过短、无信息量：${suggestion}`);
      }
    }
  });

  test('对真实文章做 SEO 检查，且建议落到具体内容', async () => {
    const post = await loadPost(EXAMPLE_POSTS[0]);
    const result = await service.seo(post, { site: { title: 'Emeek', url: 'https://example.com' } });
    assert.equal(result.quality, 'high');
    assert.ok(result.content.checks.length >= 15, '检查项覆盖不足');
    assert.ok(result.content.keywords.length > 0, '应提取出关键词');
    // 有问题的项必须给出建议，且建议里要有具体内容（不是「请优化」）
    for (const item of result.content.checks.filter((c) => c.status !== 'pass')) {
      assert.ok(item.suggestion.length > 10, `${item.item} 建议过于空泛`);
    }
  });

  test('提取关键词，且是可用的完整词', async () => {
    const post = await loadPost(EXAMPLE_POSTS[0]);
    const result = await service.tags(post.raw, { top: 8 });
    assert.equal(result.source, 'local');
    assert.ok(result.content.length > 0);
    for (const tag of result.content) {
      assert.ok(tag.length >= 2, `关键词「${tag}」过短`);
      assert.ok(!tag.includes('\n'), `关键词「${tag}」含换行`);
    }
  });

  test('离线模式下不再显示「请配置 API Key」这类死路', async () => {
    // 四个本地可用的能力都必须真的返回结果，而不是提示去配 key
    const post = await loadPost(EXAMPLE_POSTS[0]);
    const results = await Promise.all([
      service.summarize(post.raw),
      service.readability(post.raw, { withAdvice: false }),
      service.seo(post, {}),
      service.tags(post.raw),
    ]);
    for (const result of results) {
      assert.ok(result.content, '不应返回空结果');
      assert.notEqual(result.content, '请配置 API Key');
    }
  });

  test('离线时续写明确不可用，且不伪装成降级', async () => {
    const post = await loadPost(EXAMPLE_POSTS[0]);
    const capabilities = service.capabilities();
    assert.equal(capabilities.continue.available, false);
    await assert.rejects(() => service.run(post.raw, AITask.CONTINUE), (error) => {
      assert.equal(error.code, 'NOT_CONFIGURED');
      return true;
    });
  });

  test('能力矩阵与实际行为一致', async () => {
    const capabilities = service.capabilities();
    const post = await loadPost(EXAMPLE_POSTS[0]);
    for (const [task, capability] of Object.entries(capabilities)) {
      if (!capability.available) {
        await assert.rejects(() => service.run(post.raw, task), `能力矩阵说 ${task} 不可用，实际却成功了`);
      } else if (task === AITask.SUMMARIZE) {
        const result = await service.run(post.raw, task);
        assert.ok(result.content);
      }
    }
  });
});

describe('离线集成：降级提示所需的字段', () => {
  let service;
  before(async () => { service = await AIService.fromConfig({}); });

  test('每个结果都带 source 与 quality，供 UI 判断标注', async () => {
    const post = await loadPost(EXAMPLE_POSTS[0]);
    const results = {
      summarize: await service.summarize(post.raw),
      readability: await service.readability(post.raw, { withAdvice: false }),
      seo: await service.seo(post, {}),
      tags: await service.tags(post.raw),
    };
    for (const [name, result] of Object.entries(results)) {
      assert.equal(result.source, 'local', `${name} 的 source 应为 local`);
      assert.ok(['high', 'medium', 'generative'].includes(result.quality), `${name} 的 quality 非法：${result.quality}`);
    }
    // 摘要与关键词是 medium（算法近似），可读性与 SEO 是 high（确定性计算）
    assert.equal(results.summarize.quality, 'medium');
    assert.equal(results.tags.quality, 'medium');
    assert.equal(results.readability.quality, 'high');
    assert.equal(results.seo.quality, 'high');
  });

  test('能力矩阵提供 UI 展示所需的标签文案', () => {
    const capabilities = service.capabilities();
    assert.equal(capabilities.summarize.label, '快速摘要');
    assert.equal(capabilities.tags.label, '关键词提取');
    assert.equal(capabilities.readability.label, '可读性分析');
    assert.equal(capabilities.seo.label, 'SEO 检查');
  });

  test('一句话能说明当前处于降级状态（UI 提示条素材）', () => {
    assert.equal(service.isDegraded, true);
    // TASK_CAPABILITIES 是 UI 文案的唯一来源，改文案不必改组件
    assert.ok(Object.keys(TASK_CAPABILITIES).length >= 10);
  });
});

describe('离线集成：全功能可用性矩阵', () => {
  test('本地可用任务在离线时全部可执行', async () => {
    const service = await AIService.fromConfig({});
    const post = await loadPost(EXAMPLE_POSTS[0]);
    const localTasks = Object.values(AITask).filter((task) => TASK_CAPABILITIES[task].local);
    assert.ok(localTasks.length >= 5, '本地可用任务应有 5 个以上');

    for (const task of localTasks) {
      if (task === AITask.READABILITY) {
        const result = await service.readability(post.raw, { withAdvice: false });
        assert.ok(result.content, `${task} 应返回结果`);
        continue;
      }
      const result = await service.run(post.raw, task);
      assert.ok(result.content, `${task} 在离线时应可用`);
      assert.equal(result.source, 'local');
    }
  });

  test('本地不可用任务在离线时全部明确失败', async () => {
    const service = await AIService.fromConfig({});
    const post = await loadPost(EXAMPLE_POSTS[0]);
    const remoteOnly = Object.values(AITask).filter((task) => !TASK_CAPABILITIES[task].local);
    assert.ok(remoteOnly.length >= 5);

    for (const task of remoteOnly) {
      await assert.rejects(
        () => service.run(post.raw, task),
        (error) => {
          assert.equal(error.code, 'NOT_CONFIGURED', `${task} 应报未配置而非静默失败`);
          return true;
        },
      );
    }
  });
});

describe('离线集成：性能与稳定性', () => {
  test('对全部示例文章跑完整流程，总耗时在可接受范围', async () => {
    const service = await AIService.fromConfig({});
    const posts = await Promise.all(EXAMPLE_POSTS.map(loadPost));
    // 预热
    await service.summarize(posts[0].raw);

    const start = performance.now();
    for (const post of posts) {
      await service.summarize(post.raw);
      await service.readability(post.raw, { withAdvice: false });
      await service.seo(post, {});
      await service.tags(post.raw);
    }
    const elapsed = performance.now() - start;
    // 3 篇文章 × 4 个功能，本地算法不该超过 1 秒
    assert.ok(elapsed < 1000, `完整流程耗时 ${elapsed.toFixed(0)}ms，偏慢`);
  });

  test('重复调用结果稳定（无隐藏状态污染）', async () => {
    const service = await AIService.fromConfig({});
    const post = await loadPost(EXAMPLE_POSTS[0]);
    const first = await service.summarize(post.raw);
    const second = await service.summarize(post.raw);
    assert.deepEqual(first.content, second.content);
  });
});

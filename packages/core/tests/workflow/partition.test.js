import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { partitionPosts, explainStatus, WORKFLOW_CHECKS } from '../../src/workflow/index.js';

/**
 * 草稿 / 定时发布的判定。
 *
 * 这一层是「草稿绝不进生产」与「定时发布不漏」的**唯一判定点** ——
 * 构建、CLI、校验都读它。所以测试要钉住的是「两类文章各自去哪」，
 * 而不是某个调用点的行为。
 */
const NOW = new Date('2025-06-15T12:00:00Z');
const post = (o = {}) => ({ title: 'T', slug: 't', date: '2025-01-01', ...o });

describe('内容分区（草稿 / 定时 / 已发布）', () => {
  test('草稿不进产物：draft: true 一律归草稿', () => {
    const { published, drafts } = partitionPosts([post({ draft: true }), post({ slug: 'x' })], { now: NOW });
    assert.equal(drafts.length, 1);
    assert.equal(published.length, 1);
    assert.equal(published[0].slug, 'x');
  });

  test('未到点的定时文章不进产物（这是最危险的失败形态：以为它在等，其实已发）', () => {
    const { published, scheduled } = partitionPosts([
      post({ slug: 'future', date: '2999-01-01' }),
      post({ slug: 'now', date: '2025-06-15T11:00:00Z' }),
    ], { now: NOW, schedule: { enabled: true } });
    assert.deepEqual(scheduled.map((p) => p.slug), ['future']);
    assert.deepEqual(published.map((p) => p.slug), ['now']);
  });

  test('刚过点的文章立刻进产物（边界是「到点」，不是「下一小时」）', () => {
    const { published } = partitionPosts([post({ date: '2025-06-15T12:00:00Z' })], { now: NOW, schedule: { enabled: true } });
    assert.equal(published.length, 1, 'date 恰好等于 now 时必须已发布');
  });

  test('graceHours 把「刚过点」的文章再压一会儿（避免时区/时钟偏差的抢跑）', () => {
    // 一小时**前**到点：无缓冲时已发布；带 2 小时缓冲时仍算「等定时」。
    // 缓冲的方向是「推迟发布」，不是「提前」—— 名字容易读反。
    const recent = post({ slug: 'recent', date: '2025-06-15T11:00:00Z' });
    const strict = partitionPosts([recent], { now: NOW, schedule: { enabled: true, graceHours: 0 } });
    const grace = partitionPosts([recent], { now: NOW, schedule: { enabled: true, graceHours: 2 } });
    assert.equal(strict.published.length, 1, '无缓冲时 11:00 早已到点，应发布');
    assert.equal(grace.published.length, 0, '带 2 小时缓冲时 11:00 仍压在缓冲期内');
    assert.equal(grace.scheduled.length, 1);
  });

  test('关掉定时发布后，未来时间的文章直接上线（不再是定时）', () => {
    const { published, scheduled } = partitionPosts([post({ date: '2999-01-01' })], { now: NOW, schedule: { enabled: false } });
    assert.equal(scheduled.length, 0);
    assert.equal(published.length, 1);
  });

  test('草稿优先于定时：既是草稿又是未来时间 → 归草稿', () => {
    const { drafts, scheduled } = partitionPosts([post({ draft: true, date: '2999-01-01' })], { now: NOW, schedule: { enabled: true } });
    assert.equal(scheduled.length, 0, '草稿不该出现在「等定时」里');
    assert.equal(drafts.length, 1);
  });

  test('没有日期的文章照常发布（不因为缺日期被当成未来）', () => {
    const { published } = partitionPosts([post({ date: null })], { now: NOW, schedule: { enabled: true } });
    assert.equal(published.length, 1);
  });

  test('非法日期不拦截发布（它是校验该报的事，不是分区的判据）', () => {
    const { published } = partitionPosts([post({ date: 'not-a-date' })], { now: NOW, schedule: { enabled: true } });
    assert.equal(published.length, 1);
  });

  test('每一篇都有明确的「为什么」', () => {
    const a = post({ slug: 'a' });
    const b = post({ slug: 'b', draft: true });
    const c = post({ slug: 'c', date: '2999-01-01' });
    const { reasons } = partitionPosts([a, b, c], { now: NOW, schedule: { enabled: true } });
    assert.equal(reasons.get(a), 'published');
    assert.equal(reasons.get(b), 'draft');
    assert.equal(reasons.get(c), 'scheduled');
    assert.match(explainStatus('draft'), /草稿/);
    assert.match(explainStatus('scheduled'), /定时发布/);
  });

  test('三条规则的三篇分区之和等于总数（不丢不重）', () => {
    const posts = [post({ slug: '1' }), post({ slug: '2', draft: true }), post({ slug: '3', date: '2999-01-01' }), post({ slug: '4' })];
    const { published, drafts, scheduled } = partitionPosts(posts, { now: NOW, schedule: { enabled: true } });
    assert.equal(published.length + drafts.length + scheduled.length, posts.length);
  });

  test('校验项清单是稳定契约（配置里写它）', () => {
    assert.deepEqual(WORKFLOW_CHECKS, ['title', 'date', 'links', 'markdown', 'taxonomy', 'internal-links']);
  });
});

/**
 * 内容工作流（P3-4b-rest D2）—— 草稿 / 定时发布 / 分类 / 构建时校验。
 *
 * ── 这一层守的是什么 ──
 *
 * 博客最伤用户信任的一件事不是「功能少」，是**「我明明写了，网站上没有」**
 * 和 **「一篇草稿被发出去了」**。前者让人反复怀疑自己写错了地方，
 * 后者是不可撤回的事故（搜索引擎抓到过、RSS 推过、读者看到过）。
 *
 * 所以这里的三条规则是**结构性的**，不是「尽量」：
 *
 *  1. 草稿绝不进生产 —— 由「构建过滤 + 硬断言」两步守，不是靠一个 if 分支
 *  2. 定时发布不漏 —— 到点自动进产物；没到点的**完全不出现**
 *  3. 校验失败要说出来 —— 但默认不阻塞（warn），除非用户显式要求 error
 *
 * ── 与 `emeek drafts` 的关系 ──
 *
 * `emeek drafts` 早已存在（P3-4a），它做的是「把为什么没发摊开给用户看」。
 * 这一层做的是**构建期的同一份判定**。两者读同一个 `partitionPosts`，
 * 所以命令行看到的状态与产物里的状态**结构上不可能分叉** ——
 * 这正是 P3-4b-accel 里「不留两份真相」的同一条原则。
 */

/** 可用的校验项。写错的名字会被忽略并告警（不静默）。 */
export const WORKFLOW_CHECKS = ['title', 'date', 'links', 'markdown', 'taxonomy', 'internal-links'];

/**
 * 把文章分成「进产物 / 不进产物」，并说明每一篇为什么。
 *
 * 这是草稿与定时发布的**唯一判定点**。构建、CLI、校验都读它。
 *
 * @param {object[]} posts   原始文章（已带 draft / date）
 * @param {object}   options
 *   now          构建时刻（测试注入，保证确定性）
 *   schedule     定时发布配置 { enabled, graceHours }
 * @returns {{ published, drafts, scheduled, reasons }}
 */
export function partitionPosts(posts = [], { now = new Date(), schedule = {} } = {}) {
  const scheduleEnabled = schedule.enabled !== false;
  // graceHours 的方向：**推迟**发布，不是提前。
  // `date + grace <= now` 才算到点 —— 所以带缓冲时，一个刚过点的文章
  // 会再「压」一会儿才上线。用途是躲开时钟偏差与 CI 调度的抖动：
  // 定时任务每小时跑一次时，正好卡在整点的文章可能因几十秒的偏差
  // 被算成「还没到」，白等一小时。
  const graceMs = Number(schedule.graceHours ?? 0) * 3600 * 1000;
  const cutoff = now.getTime() - graceMs;

  const published = [];
  const drafts = [];
  const scheduled = [];
  const reasons = new Map();

  for (const post of posts) {
    if (post.draft) {
      drafts.push(post);
      reasons.set(post, 'draft');
      continue;
    }
    const at = post.date ? new Date(post.date).getTime() : null;
    if (scheduleEnabled && at != null && !Number.isNaN(at) && at > cutoff) {
      scheduled.push(post);
      reasons.set(post, 'scheduled');
      continue;
    }
    published.push(post);
    reasons.set(post, 'published');
  }

  return { published, drafts, scheduled, reasons };
}

/**
 * 草稿/定时文章的「为什么没发」说明。CLI 与校验共用 ——
 * 一处措辞，用户不会在两个地方读到两种说法。
 */
export function explainStatus(status) {
  switch (status) {
    case 'draft': return '草稿：把 front-matter 里的 draft 改成 false 即发布';
    case 'scheduled': return '定时发布：等 date 到点后重新构建';
    case 'published': return '已发布';
    default: return '未知';
  }
}

export { validatePosts, VALIDATION_RULES } from './validate.js';

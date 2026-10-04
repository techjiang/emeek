import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 多源站部署 + 故障转移（A3）。
 *
 * 核心不变量：**构建一次，推送多次，产物一模一样**。
 * 每个源站是同一份 dist 的投影，所以「推送到哪里」不改变内容 ——
 * 改的只有「这一份内容通过哪些入口可达」。
 *
 * 幂等同样重要：重复推送不产生副作用。做法是给每个源站算一份
 * 「产物指纹清单」，与上次推送的清单一致就跳过。
 */

/** 站点产物清单：路径 → 内容哈希。用于幂等判定与验证。 */
export async function hashTree(dir) {
  const entries = await walk(dir);
  const files = {};
  for (const file of entries) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const content = await fs.readFile(file);
    files[rel] = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
  return {
    files,
    count: Object.keys(files).length,
    digest: digestOf(files),
  };
}

export function digestOf(files) {
  const keys = Object.keys(files).sort();
  const h = crypto.createHash('sha256');
  for (const key of keys) h.update(`${key}:${files[key]}\n`);
  return h.digest('hex').slice(0, 16);
}

/** 比较两份树清单，返回差异。 */
export function diffTrees(prev = { files: {} }, next = { files: {} }) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [file, hash] of Object.entries(next.files ?? {})) {
    if (!(file in (prev.files ?? {}))) added.push(file);
    else if (prev.files[file] !== hash) changed.push(file);
  }
  for (const file of Object.keys(prev.files ?? {})) {
    if (!(file in (next.files ?? {}))) removed.push(file);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    identical: added.length + removed.length + changed.length === 0,
  };
}

/**
 * 规划多源站推送。每个源站独立判定「需要推吗」，互不影响 ——
 * 一个源站失败不该阻塞另一个（镜像的价值就在于冗余）。
 */
export function planFanout({ origins = [], prevManifest = {}, nextManifest }) {
  return origins.map((origin) => {
    const id = typeof origin === 'string' ? origin : origin.id;
    const previous = prevManifest[id];
    const diff = diffTrees(previous, nextManifest);
    return {
      id,
      target: typeof origin === 'string' ? origin : origin.target ?? origin.id,
      needsPush: !diff.identical,
      diff,
      reason: diff.identical ? '产物未变化，跳过推送' : `${diff.added.length} 新增 / ${diff.changed.length} 变更 / ${diff.removed.length} 删除`,
    };
  });
}

/**
 * 故障转移健康检查配置。
 *
 * 判定「源站挂了」不能只看 TCP 是否连得上 —— 静态站最常见的故障是
 * 「HTTP 200 但内容是 404 页」或「返回旧版本」。所以检查项包含内容谓词。
 */
export function buildHealthChecks(origins = [], defaults = {}) {
  const base = {
    interval: '5m',
    retries: 3,
    timeout: '10s',
    expectedStatus: 200,
    ...defaults,
  };
  return origins.map((origin) => {
    const target = typeof origin === 'string' ? origin : origin.url ?? origin.target ?? origin.id;
    return {
      origin: typeof origin === 'string' ? origin : origin.id,
      target,
      ...base,
      expect: base.expect ?? ((body) => typeof body === 'string' && body.length > 0),
    };
  });
}

/**
 * 评估一组健康检查结果，给出「当前该把流量导到哪里」。
 * 决策规则：优先主站；主站不健康则按顺序取第一个健康的镜像。
 */
export function decideActiveOrigin(origins = [], results = []) {
  const statusById = new Map(results.map((r) => [r.origin, r]));
  for (const origin of origins) {
    const id = typeof origin === 'string' ? origin : origin.id;
    const role = typeof origin === 'string' ? 'mirror' : origin.role ?? 'mirror';
    const status = statusById.get(id);
    if (status?.healthy) {
      return { active: id, role, failover: role !== 'primary', checked: results.length };
    }
  }
  return { active: null, role: null, failover: true, checked: results.length, error: '所有源站均不健康' };
}

async function walk(dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return acc;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

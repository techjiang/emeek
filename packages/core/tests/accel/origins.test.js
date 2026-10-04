import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashTree, digestOf, diffTrees, planFanout, buildHealthChecks, decideActiveOrigin } from '../../src/accel/origins.js';

async function tmpTree(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-origins-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

describe('多源站与故障转移', () => {
  test('hashTree 给出稳定摘要（内容不变摘要不变）', async () => {
    const dir = await tmpTree({ 'index.html': 'a', 'assets/x.css': 'b' });
    const a = await hashTree(dir);
    const b = await hashTree(dir);
    assert.equal(a.digest, b.digest);
    assert.equal(a.count, 2);
  });

  test('内容变则摘要变', async () => {
    const dir = await tmpTree({ 'index.html': 'a' });
    const before = await hashTree(dir);
    await fs.writeFile(path.join(dir, 'index.html'), 'b');
    const after = await hashTree(dir);
    assert.notEqual(before.digest, after.digest);
  });

  test('diffTrees 分类增删改', () => {
    const diff = diffTrees(
      { files: { 'a.html': '1', 'b.html': '2' } },
      { files: { 'a.html': '1', 'b.html': '9', 'c.html': '3' } },
    );
    assert.deepEqual(diff.added, ['c.html']);
    assert.deepEqual(diff.changed, ['b.html']);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.identical, false);
  });

  test('产物一致时 identical=true —— 幂等推送的判据', () => {
    const same = { files: { 'a.html': '1' } };
    assert.equal(diffTrees(same, { ...same }).identical, true);
  });

  test('planFanout 每个源站独立判定（一个源站失败不阻塞其他）', () => {
    const plan = planFanout({
      origins: [{ id: 'github', role: 'primary' }, { id: 'vercel' }],
      prevManifest: { github: { files: { 'a.html': '1' } } },
      nextManifest: { files: { 'a.html': '1', 'b.html': '2' } },
    });
    assert.equal(plan[0].needsPush, true);
    assert.equal(plan[1].needsPush, true);
    assert.match(plan[0].reason, /1 新增/);
  });

  test('幂等：产物未变 → 跳过推送', () => {
    const manifest = { files: { 'a.html': '1' } };
    const plan = planFanout({ origins: [{ id: 'github' }], prevManifest: { github: manifest }, nextManifest: manifest });
    assert.equal(plan[0].needsPush, false);
    assert.match(plan[0].reason, /跳过/);
  });

  test('健康检查带内容谓词 —— 不能只看 TCP 通不通', () => {
    const checks = buildHealthChecks([{ id: 'github', role: 'primary' }], { interval: '5m', retries: 3 });
    assert.equal(checks[0].interval, '5m');
    assert.equal(checks[0].retries, 3);
    assert.equal(typeof checks[0].expect, 'function');
  });

  test('主站健康时用主站', () => {
    const d = decideActiveOrigin([{ id: 'github', role: 'primary' }, { id: 'vercel' }], [
      { origin: 'github', healthy: true },
      { origin: 'vercel', healthy: true },
    ]);
    assert.equal(d.active, 'github');
    assert.equal(d.failover, false);
  });

  test('主站挂了切到第一个健康镜像', () => {
    const d = decideActiveOrigin([{ id: 'github', role: 'primary' }, { id: 'vercel' }, { id: 'cf' }], [
      { origin: 'github', healthy: false },
      { origin: 'vercel', healthy: true },
    ]);
    assert.equal(d.active, 'vercel');
    assert.equal(d.failover, true);
  });

  test('全部不健康时明确报错而不是随便选一个', () => {
    const d = decideActiveOrigin([{ id: 'a', role: 'primary' }], [{ origin: 'a', healthy: false }]);
    assert.equal(d.active, null);
    assert.match(d.error, /所有源站均不健康/);
  });
});

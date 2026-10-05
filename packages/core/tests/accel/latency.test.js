import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { probe, measure, compareLatency, median } from '../../src/accel/latency.js';

const fakeFetch = (body = 'hello', status = 200) => async () => ({
  ok: status < 400,
  status,
  text: async () => body,
});

describe('延迟测量', () => {
  test('probe 返回 TTFB 与总耗时', async () => {
    const r = await probe('https://x.test/', { fetchImpl: fakeFetch('abc') });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(typeof r.ttfb, 'number');
    assert.equal(r.bytes, 3);
  });

  test('probe 支持内容谓词 —— 200 不等于正确', async () => {
    const wrong = await probe('https://x.test/', { fetchImpl: fakeFetch('<html>404</html>'), expect: (b) => /urlset/i.test(b) });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.predicateOk, false);
  });

  test('probe 捕获超时', async () => {
    const never = () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('abort'), { name: 'AbortError' })), 5));
    const r = await probe('https://x.test/', { fetchImpl: never, timeout: 5 });
    assert.equal(r.ok, false);
    assert.match(r.error, /超时/);
  });

  test('measure 取中位数，抗单次抖动', async () => {
    let calls = 0;
    const r = await measure('https://x.test/', {
      runs: 3,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => 'x' };
      },
    });
    assert.equal(calls, 3);
    assert.equal(r.ok, true);
    assert.equal(typeof r.total, 'number');
  });

  test('median 正确处理奇偶与空', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 3);
    assert.equal(median([]), null);
  });

  test('compareLatency 算出加速倍数与改善率', () => {
    const c = compareLatency([
      { id: 'bj', area: 'cn', before: 3000, after: 400 },
      { id: 'tokyo', area: 'oversea', before: 900, after: 200 },
    ]);
    assert.equal(c.cn.before, 3000);
    assert.equal(c.cn.after, 400);
    assert.equal(c.cn.improvement, 0.867);
    assert.equal(c.cnTarget, true);
  });

  test('中国大陆目标线 500ms：超标时 cnTarget=false', () => {
    const c = compareLatency([{ id: 'bj', area: 'cn', before: 3000, after: 800 }]);
    assert.equal(c.cnTarget, false);
  });

  test('不可达区域标为 available=false', () => {
    const c = compareLatency([{ id: 'bj', area: 'cn', before: 5000, after: null, available: false }]);
    assert.equal(c.rows[0].available, false);
  });
});

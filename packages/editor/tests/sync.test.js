/**
 * 热更新同步（决策 D4）。
 *
 * 核心立场只有一句：**本地干净就刷新，本地脏就两边都留、不自动合并。**
 * 这一组测试守的就是「不许出现自动合并」这条线 —— 它是那种一旦加上去
 * 就再也拿不掉的「贴心功能」，而它出错时用户不会有任何察觉。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideSync, SYNC_DECISION, connectReloadStream, renderSyncNotice } from '../src/studio/sync.js';
import { SAVE_LABELS } from '../src/editor/statusbar.js';

describe('同步决策', () => {
  test('本地干净 + 磁盘变了 → 刷新', () => {
    const result = decideSync({ localDirty: false, localFingerprint: 'a', remoteFingerprint: 'b', currentRemote: 'a' });
    assert.equal(result.decision, SYNC_DECISION.RELOAD);
    assert.equal(result.message, null);
  });

  test('本地脏 + 磁盘变了 → 冲突，两边都留', () => {
    const result = decideSync({ localDirty: true, localFingerprint: 'a', remoteFingerprint: 'b', currentRemote: 'a' });
    assert.equal(result.decision, SYNC_DECISION.CONFLICT);
    assert.match(result.message, /两边都留着/);
    assert.match(result.message, /没有被动过/);
  });

  test('内容一致 → 什么都不做（编辑器自己写盘会走到这里）', () => {
    const result = decideSync({ localDirty: false, localFingerprint: 'same', remoteFingerprint: 'same' });
    assert.equal(result.decision, SYNC_DECISION.NOOP);
  });

  test('本地脏但磁盘没变 → 什么都不做（别打扰用户）', () => {
    const result = decideSync({ localDirty: true, localFingerprint: 'a', remoteFingerprint: 'a', currentRemote: 'a' });
    assert.equal(result.decision, SYNC_DECISION.NOOP);
  });

  test('自己刚写下去的那一次不回环（remote 与已知 remote 相同）', () => {
    const result = decideSync({ localDirty: false, localFingerprint: 'x', remoteFingerprint: 'b', currentRemote: 'b' });
    assert.equal(result.decision, SYNC_DECISION.NOOP, '自己写盘触发的事件不该再刷新一次页面');
  });

  test('决策里没有「自动合并」这个选项', () => {
    // 这一条不是凑数：把「不许出现自动合并」写成断言，比写在注释里有效
    const values = Object.values(SYNC_DECISION);
    assert.deepEqual(values, ['reload', 'conflict', 'noop']);
    assert.ok(!values.some((v) => /merge|auto/i.test(v)));
  });

  test('冲突文案不承诺「已合并」或「已保留你的版本」', () => {
    const { message } = decideSync({ localDirty: true, localFingerprint: 'a', remoteFingerprint: 'b' });
    assert.doesNotMatch(message, /已合并|已保留你的|自动/);
  });
});

describe('状态文案只有一套', () => {
  test('同步提示不新增第六种保存状态', () => {
    const labels = Object.values(SAVE_LABELS);
    assert.equal(new Set(labels).size, labels.length);
    // 「磁盘已更新，本地有改动」是提示，不是保存状态 —— 它不该出现在保存状态表里
    assert.ok(!labels.some((label) => /磁盘/.test(label)), '磁盘同步不该混进保存状态文案');
    // 五档都在
    for (const key of ['saved', 'saving', 'dirty', 'failed', 'foreign-tab']) {
      assert.ok(SAVE_LABELS[key], `缺少保存状态 ${key}`);
    }
  });
});

describe('热更新通道', () => {
  function fakeSource() {
    return { onmessage: null, onerror: null, closed: false, close() { this.closed = true; } };
  }

  test('收到消息回调被调用', () => {
    const source = fakeSource();
    const received = [];
    const stream = connectReloadStream({ eventSourceFactory: () => source, onMessage: (p) => received.push(p) });
    stream.start();
    source.onmessage({ data: JSON.stringify({ path: 'posts/a.md' }) });
    assert.deepEqual(received, [{ path: 'posts/a.md' }]);
  });

  test('非 JSON 消息不会把通道弄崩', () => {
    const source = fakeSource();
    const received = [];
    const stream = connectReloadStream({ eventSourceFactory: () => source, onMessage: (p) => received.push(p) });
    stream.start();
    source.onmessage({ data: 'not json' });
    assert.equal(received.length, 1);
    assert.equal(received[0].raw, 'not json');
  });

  test('onMessage 抛错被隔离，后续消息照常', () => {
    const source = fakeSource();
    let calls = 0;
    const warnings = [];
    const stream = connectReloadStream({
      eventSourceFactory: () => source,
      logger: { warn: (msg) => warnings.push(msg) },
      onMessage: () => { calls += 1; throw new Error('handler exploded'); },
    });
    stream.start();
    source.onmessage({ data: '{}' });
    source.onmessage({ data: '{}' });
    assert.equal(calls, 2, '处理失败不能把通道带走');
    assert.match(warnings.join('\n'), /已隔离/);
  });

  test('EventSource 构造失败只告警，不抛', () => {
    const warnings = [];
    const stream = connectReloadStream({
      eventSourceFactory: () => { throw new Error('CSP 拦了'); },
      logger: { warn: (msg) => warnings.push(msg) },
    });
    assert.doesNotThrow(() => stream.start());
    assert.match(warnings.join('\n'), /无法连接热更新通道/);
  });

  test('stop 之后关闭通道且不重复连接', () => {
    const source = fakeSource();
    const stream = connectReloadStream({ eventSourceFactory: () => source });
    stream.start();
    stream.stop();
    assert.equal(source.closed, true);
    stream.start();
    assert.equal(stream.connected, false, 'stop 之后不该再连上');
  });
});

describe('提示条渲染', () => {
  function fakeHost() {
    return {
      classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
      innerHTML: '',
      querySelector: () => null,
    };
  }

  test('冲突时显示，并说清两边都留着', () => {
    const host = fakeHost();
    renderSyncNotice(host, { decision: SYNC_DECISION.CONFLICT, message: '两边都留着' });
    assert.ok(host.classList.contains('visible'));
    assert.match(host.innerHTML, /两边都留着/);
    assert.match(host.innerHTML, /没有自动合并/);
  });

  test('非冲突决策清空提示（否则用户会一直看到一个过期的警告）', () => {
    const host = fakeHost();
    host.classList.add('visible');
    renderSyncNotice(host, { decision: SYNC_DECISION.RELOAD });
    assert.equal(host.classList.contains('visible'), false);
    assert.equal(host.innerHTML, '');
  });

  test('内容被转义（提示条里塞的是磁盘路径，也是不可信输入）', () => {
    const host = fakeHost();
    renderSyncNotice(host, { decision: SYNC_DECISION.CONFLICT, message: '<img src=x onerror=alert(1)>' });
    assert.doesNotMatch(host.innerHTML, /<img src=x/);
  });
});

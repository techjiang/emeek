/**
 * 草稿存储的测试。
 *
 * 这个文件盯的是「草稿不丢」这一条 —— 用户在编辑器里最不能被背叛的承诺。
 * 所以覆盖的重点不是「能存能取」，而是各种**丢失场景**：
 * 崩溃、配额满、多标签页、超上限、误删。
 * 能想到的丢法都要在这里有一条对应的断言。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DraftStore, createAutoSaver, createMemoryStorage, draftKey, fingerprint,
  byteLength, resolveStorage, guessSource, DRAFT_LIMITS, formatBytes,
} from '../src/studio/drafts.js';

function makeStore(options = {}) {
  const storage = options.storage ?? createMemoryStorage();
  let clock = options.start ?? 1_700_000_000_000;
  const store = new DraftStore({
    storage,
    owner: options.owner ?? 'tab-a',
    now: () => (clock += options.step ?? 1000),
    ...options,
  });
  return { store, storage, tick: (ms) => { clock += ms; } };
}

describe('字节与指纹', () => {
  test('byteLength 按 UTF-8 算，不是按字符数', () => {
    assert.equal(byteLength('abc'), 3);
    // 中文一个字 3 字节 —— 按 string.length 算会把 1.8MB 报成 0.6MB
    assert.equal(byteLength('中'), 3);
    assert.equal(byteLength('中文'), 6);
  });

  test('fingerprint 对同一输入稳定、对变化敏感', () => {
    assert.equal(fingerprint('# 标题\n正文'), fingerprint('# 标题\n正文'));
    assert.notEqual(fingerprint('# 标题\n正文'), fingerprint('# 标题\n正文 '));
    assert.notEqual(fingerprint('a'), fingerprint('b'));
    // 长文本中间改动也能看出来（采样哈希的意义）
    const long = 'x'.repeat(10000);
    assert.notEqual(fingerprint(`${long}A`), fingerprint(`${long}B`));
  });

  test('draftKey 不会把不同文件名折成同一个键', () => {
    // 「把非法字符替换成 -」的写法会让这两个撞在一起，两篇稿子互相覆盖
    assert.notEqual(draftKey('我的文章.md'), draftKey('我的-文章.md'));
    assert.equal(draftKey(''), draftKey('untitled.md'));
  });

  test('guessSource 能从文件名认出 Issue 来源', () => {
    assert.equal(guessSource('issue-123.md').id, 'github-issue-123');
    assert.equal(guessSource('posts/hello.md').kind, 'local-file');
  });
});

describe('保存与恢复', () => {
  test('存进去能原样取出来（含换行与 emoji）', () => {
    const { store } = makeStore();
    const content = '# 标题\n\n正文 ✨\n\n```js\nconst a = 1;\n```\n';
    const result = store.save('a.md', content);
    assert.equal(result.ok, true);
    assert.equal(result.version, 1);
    assert.equal(store.load('a.md').content, content);
  });

  test('内容没变时不涨版本号，也就不会把历史挤掉', () => {
    const { store } = makeStore();
    store.save('a.md', 'same');
    store.save('a.md', 'same');
    assert.equal(store.load('a.md').version, 1);
    assert.equal(store.load('a.md').versions.length, 0);
  });

  test('每次内容变化都推进历史，最多保留 4 个旧版本（共 5 版）', () => {
    const { store } = makeStore();
    for (let i = 1; i <= 9; i += 1) store.save('a.md', `v${i}`);
    const record = store.load('a.md');
    assert.equal(record.content, 'v9');
    assert.equal(record.versions.length, DRAFT_LIMITS.versions - 1);
    // 最近的历史在前
    assert.equal(record.versions[0].content, 'v8');
    assert.equal(record.version, 9);
  });

  test('回退到历史版本，而且回退本身也能再回退', () => {
    const { store } = makeStore();
    store.save('a.md', '第一版');
    store.save('a.md', '第二版');
    const result = store.restoreVersion('a.md', 0);
    assert.equal(result.ok, true);
    assert.equal(store.load('a.md').content, '第一版');
    // 回退之后，「第二版」进了历史 —— 点错了还能回来
    assert.ok(store.load('a.md').versions.some((v) => v.content === '第二版'));
  });

  test('回退一个不存在的版本返回 null，不抛错也不改内容', () => {
    const { store } = makeStore();
    store.save('a.md', 'x');
    assert.equal(store.restoreVersion('a.md', 42), null);
    assert.equal(store.load('a.md').content, 'x');
  });

  test('删除草稿会连历史一起清掉', () => {
    const { store, storage } = makeStore();
    store.save('a.md', 'v1');
    store.save('a.md', 'v2');
    store.remove('a.md');
    assert.equal(store.load('a.md'), null);
    assert.equal(store.list().length, 0);
    // 历史键也不能留，否则旧内容仍占空间且能被 load 出来
    assert.equal(storage.getItem(`${draftKey('a.md')}:v0`), null);
  });

  test('list 只给元信息，不把正文全塞进内存', () => {
    const { store } = makeStore();
    store.save('a.md', 'x'.repeat(5000));
    const [entry] = store.list();
    assert.equal(entry.filename, 'a.md');
    assert.ok(entry.bytes >= 5000);
    assert.equal(entry.content, undefined);
  });
});

describe('浏览器崩溃后能恢复', () => {
  test('模拟杀进程：新建 store 实例（新页面）仍能取到上次内容', () => {
    const storage = createMemoryStorage();
    const first = new DraftStore({ storage, owner: 'tab-a' });
    first.save('a.md', '# 写到一半就崩了');

    // 新页面 = 新 store 实例 + 新 owner，storage 只有一份（浏览器的实际情况）
    const revived = new DraftStore({ storage, owner: 'tab-b' });
    const record = revived.load('a.md');
    assert.equal(record.content, '# 写到一半就崩了');
    assert.equal(record.version, 1);
  });

  test('崩溃恢复时不会被「另一个标签页」误判拦住', () => {
    const storage = createMemoryStorage();
    new DraftStore({ storage, owner: 'dead-tab' }).save('a.md', 'old');
    // 崩溃后重开：新 owner 与记录里的 owner 不同，但那是上一个已死的标签页。
    // 这里断言的是「读取」不受影响 —— 覆盖判断只发生在写入路径上。
    const revived = new DraftStore({ storage, owner: 'fresh-tab' });
    assert.equal(revived.load('a.md').content, 'old');
  });
});

describe('多标签页', () => {
  test('发现另一个标签页写过同一篇时拒绝自动保存，并如实上报', () => {
    const storage = createMemoryStorage();
    const tabA = new DraftStore({ storage, owner: 'tab-a' });
    tabA.save('a.md', 'A 写的');

    const tabB = new DraftStore({ storage, owner: 'tab-b' });
    const result = tabB.save('a.md', 'B 写的');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'foreign-tab');
    assert.equal(result.owner, 'tab-b', 'owner 是本次试图写入的标签页');
    assert.equal(result.foreignOwner, 'tab-a', 'foreignOwner 才是指出「谁在编辑」的那一个');
    assert.match(result.message, /另一个标签页/);
    // 关键：A 的内容没被覆盖
    assert.equal(tabA.load('a.md').content, 'A 写的');
  });

  test('用户明确选择「以我为准」时（force）才覆盖', () => {
    const storage = createMemoryStorage();
    const tabA = new DraftStore({ storage, owner: 'tab-a' });
    tabA.save('a.md', 'A');
    const tabB = new DraftStore({ storage, owner: 'tab-b' });
    assert.equal(tabB.save('a.md', 'B', { force: true }).ok, true);
    assert.equal(tabA.load('a.md').content, 'B');
  });
});

describe('会话 id（owner）的取法', () => {
  test('同一个会话内刷新页面仍是同一个 owner，重开标签页才是新的', () => {
    // 这是「自动保存永远失败」那个 bug 的回归测试：
    // 如果 owner 每次页面加载都重新随机，刷新之后会认为草稿属于
    // 「上一个标签页」而拒绝写入，用户会看到「打字后一直是未保存」。
    const KEY = '__emeeek_tab__';
    const map = new Map();
    const sessionStorage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
    };
    const read = () => {
      const existing = sessionStorage.getItem(KEY);
      if (existing) return existing;
      const fresh = `tab-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(KEY, fresh);
      return fresh;
    };
    const first = read();
    const afterReload = read(); // 刷新：sessionStorage 还在
    assert.equal(afterReload, first, '刷新后必须还是同一个 owner');

    map.clear(); // 新标签页：sessionStorage 是空的
    const newTab = read();
    assert.notEqual(newTab, first, '新标签页应当是新的 owner');

    // 效果：同一会话里连续两次保存不会互相拦
    const storage = createMemoryStorage();
    const session = new DraftStore({ storage, owner: first });
    assert.equal(session.save('a.md', '一').ok, true);
    const again = new DraftStore({ storage, owner: afterReload });
    assert.equal(again.save('a.md', '二').ok, true, '同一会话刷新后自动保存必须继续可用');
  });
});

describe('上限与淘汰', () => {
  test('单篇超过 2MB 时不写入、不截断，并说明原因', () => {
    const { store } = makeStore();
    const huge = '中'.repeat(800 * 1024); // 约 2.4MB（UTF-8）
    assert.ok(byteLength(huge) > DRAFT_LIMITS.singleBytes);
    const result = store.save('huge.md', huge);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too-large');
    assert.match(result.message, /未写入本地存储/);
    // 「不截断」是关键：半篇稿子比明说没存下更危险
    assert.equal(store.load('huge.md'), null);
  });

  test('刚好 2MB 之内能存下（边界不误杀）', () => {
    const { store } = makeStore();
    const content = 'a'.repeat(DRAFT_LIMITS.singleBytes);
    assert.equal(store.save('edge.md', content).ok, true);
  });

  test('总容量超 10MB 时淘汰最旧的，且不动当前正在编辑的那篇', () => {
    const { store } = makeStore();
    const chunk = 'a'.repeat(1024 * 1024); // 1MB
    for (let i = 1; i <= 10; i += 1) store.save(`old-${i}.md`, chunk);
    // 第 11 篇会把总量推过 10MB
    const result = store.save('current.md', chunk);
    assert.equal(result.ok, true);
    assert.ok(result.evicted.length > 0, '超过总上限必须淘汰，否则写入会失败');
    assert.ok(!result.evicted.includes('current.md'), '不能淘汰用户此刻在编辑的那篇');
    assert.equal(store.load('current.md').content, chunk);
    // 被淘汰的是最旧的
    assert.equal(store.load('old-1.md'), null);
    assert.ok(store.load('old-10.md'), '较新的不该被淘汰');
  });

  test('写入配额真的爆掉时，淘汰后重试一次；仍失败则如实报失败', () => {
    const storage = createMemoryStorage();
    const store = new DraftStore({ storage, owner: 't', now: () => 1_700_000_000_000 });
    store.save('a.md', 'a'.repeat(1000));
    // 注入一个永远写不进大内容的 storage
    const original = storage.setItem;
    storage.setItem = (key, value) => {
      if (String(value).length > 5000) { const error = new Error('QuotaExceededError'); throw error; }
      original.call(storage, key, value);
    };
    const result = store.save('b.md', 'b'.repeat(20000));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'quota');
    assert.match(result.message, /写入失败/);
    // 保存失败必须能被上层看到 —— 静默吞掉就是「显示已保存但其实是空的」
    assert.ok(store.lastError);
  });

  test('usage 统计的是真实字节，不是字符数', () => {
    const { store } = makeStore();
    store.save('a.md', '中'.repeat(100));
    assert.equal(store.usage(), 300);
  });

  test('clearAll 之后一片空白', () => {
    const { store, storage } = makeStore();
    store.save('a.md', 'v1');
    store.save('b.md', 'v2');
    store.clearAll();
    assert.equal(store.list().length, 0);
    assert.equal(store.usage(), 0);
    assert.equal(storage.length, 1, '索引键保留，值为空对象');
  });
});

describe('冲突检测', () => {
  test('来源指纹变了才报冲突，注意不要只看时间戳', () => {
    const { store } = makeStore();
    store.save('a.md', '本地内容', { source: { id: 'github-issue-1', fingerprint: 'fp-old' } });
    // 远端还是上次同步的那个指纹 → 不冲突
    const same = store.save('a.md', '本地内容2', { source: { id: 'github-issue-1', fingerprint: 'fp-old' } });
    assert.equal(same.conflict, null);
    // 远端指纹变了 → 冲突
    // 注意：冲突比较的是「草稿里记的基准指纹」与「本次传入的远端指纹」，
    // 所以要先让草稿把 fp-old 记下来（上面第一次 save 已做到），
    // 再传一个不同的远端指纹。之前写成连续两次传不同指纹，
    // 第二次的基准已经被第一次覆盖成 fp-old —— 那是测试写错了，不是实现。
    const changed = store.save('a.md', '本地内容3', { source: { id: 'github-issue-1', fingerprint: 'fp-new' } });
    assert.ok(changed.conflict);
    assert.equal(changed.conflict.source, 'github-issue-1');
    assert.equal(changed.conflict.remoteFingerprint, 'fp-new');
  });

  test('没有来源信息（纯本地草稿）时不报冲突', () => {
    const { store } = makeStore();
    store.save('a.md', 'x');
    assert.equal(store.save('a.md', 'y').conflict, null);
  });
});

describe('自动保存调度', () => {
  function fakeTimers() {
    const timeouts = new Map();
    const intervals = new Map();
    let next = 1;
    return {
      setTimeout: (fn, ms) => { const id = next++; timeouts.set(id, { fn, ms }); return id; },
      clearTimeout: (id) => { timeouts.delete(id); },
      setInterval: (fn, ms) => { const id = next++; intervals.set(id, { fn, ms }); return id; },
      clearInterval: (id) => { intervals.delete(id); },
      fireTimeouts: () => { const list = [...timeouts.values()]; timeouts.clear(); list.forEach((t) => t.fn()); },
      fireIntervals: () => [...intervals.values()].forEach((i) => i.fn()),
      pendingTimeouts: () => timeouts.size,
    };
  }

  test('停止输入 5 秒后保存一次，中途继续输入会重新计时', () => {
    const timers = fakeTimers();
    let saved = 0;
    const saver = createAutoSaver({ store: null, filename: 'a.md', save: () => { saved += 1; }, timers });
    saver.markDirty();
    saver.markDirty();
    saver.markDirty();
    assert.equal(timers.pendingTimeouts(), 1, '三次输入只该有一个待触发的计时器');
    timers.fireTimeouts();
    assert.equal(saved, 1);
  });

  test('一直打字从不停下时，30 秒兜底保存仍然生效', () => {
    const timers = fakeTimers();
    let saved = 0;
    const saver = createAutoSaver({ store: null, filename: 'a.md', save: () => { saved += 1; }, timers });
    saver.start();
    saver.markDirty();
    // 从没触发过 idle，但兜底计时器到了
    timers.fireIntervals();
    assert.equal(saved, 1);
  });

  test('内容没变过时不重复写盘（省的是每次 30 秒一次的无效写）', () => {
    const timers = fakeTimers();
    let saved = 0;
    const saver = createAutoSaver({ store: null, filename: 'a.md', save: () => { saved += 1; }, timers });
    saver.start();
    timers.fireIntervals();
    assert.equal(saved, 0);
  });

  test('Ctrl+S 立即保存并取消待触发的空闲保存', () => {
    const timers = fakeTimers();
    let saved = 0;
    const saver = createAutoSaver({ store: null, filename: 'a.md', save: () => { saved += 1; }, timers });
    saver.markDirty();
    saver.flush('manual');
    assert.equal(saved, 1);
    assert.equal(timers.pendingTimeouts(), 0, '手动保存后不该再有空闲保存排队（会白写一次）');
  });

  test('stop 之后不再自动写盘（用户在设置里关掉自动保存的场景）', () => {
    const timers = fakeTimers();
    let saved = 0;
    const saver = createAutoSaver({ store: null, filename: 'a.md', save: () => { saved += 1; }, timers });
    saver.start();
    saver.markDirty();
    saver.stop();
    timers.fireTimeouts();
    timers.fireIntervals();
    assert.equal(saved, 0);
  });

  test('切换文件后写到新文件名下', () => {
    const timers = fakeTimers();
    const seen = [];
    const saver = createAutoSaver({ store: null, filename: 'a.md', save: () => seen.push(saver.filename), timers });
    saver.markDirty();
    saver.rename('b.md');
    saver.flush('manual');
    assert.deepEqual(seen, ['b.md']);
  });
});

describe('storage 不可用时降级', () => {
  test('localStorage 读写抛异常时退回内存存储，编辑器仍能打开', () => {
    const global = globalThis;
    const original = Object.getOwnPropertyDescriptor(global, 'localStorage');
    Object.defineProperty(global, 'localStorage', {
      configurable: true,
      value: { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } },
    });
    try {
      const storage = resolveStorage();
      // 退化成内存存储后仍然能存能取，功能不中断
      const store = new DraftStore({ storage, owner: 't' });
      assert.equal(store.save('a.md', 'still works').ok, true);
      assert.equal(store.load('a.md').content, 'still works');
    } finally {
      if (original) Object.defineProperty(global, 'localStorage', original);
      else delete global.localStorage;
    }
  });

  test('内存存储的 key/length 与 Storage 一致', () => {
    const storage = createMemoryStorage();
    storage.setItem('a', '1');
    storage.setItem('b', '2');
    assert.equal(storage.length, 2);
    assert.equal(storage.key(0), 'a');
    storage.removeItem('a');
    assert.equal(storage.length, 1);
  });
});

describe('formatBytes', () => {
  test('人类可读', () => {
    assert.equal(formatBytes(512), '512B');
    assert.equal(formatBytes(2048), '2.0KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0MB');
  });
});

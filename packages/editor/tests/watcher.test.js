/**
 * 文件监听（决策 D4）。
 *
 * 三件事各有一组断言：
 *   1. 范围收敛 —— 内容目录外的事件不触发重建
 *   2. 路径校验 —— 走 resolveProjectFile，包含 symlink 场景
 *   3. 异常隔离 —— 监听器出错、回调出错，都不能拖垮 dev server
 *
 * 用注入的 fsImpl + inject() 而不是造真实文件变动：
 * fs.watch 的时序在不同平台/文件系统上差异极大，真去等它在 CI 里
 * 就是随机红。真实文件变动由 e2e 那条线覆盖（它走真的 dev server）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWatcher } from '../src/studio/watcher.js';
import { resolveProjectFile } from '../src/studio/server.js';

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-watch-'));
  const posts = path.join(root, 'posts');
  fs.mkdirSync(posts, { recursive: true });
  fs.writeFileSync(path.join(posts, 'a.md'), '# A\n');
  fs.writeFileSync(path.join(root, 'secret.env'), 'KEY=1\n');
  return { root, posts };
}

/** 安静地收集 onChange，等过防抖。 */
function collector() {
  const events = [];
  const warnings = [];
  return {
    events,
    warnings,
    onChange: (event) => events.push(event),
    logger: { warn: (msg) => warnings.push(msg), info: () => {}, error: () => {} },
  };
}

const settle = (ms = 260) => new Promise((resolve) => setTimeout(resolve, ms));

describe('监听范围', () => {
  test('内容目录内的变更触发重建，路径是相对项目根的形式', async () => {
    const { root, posts } = tempProject();
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, ...sink }).start();
    try {
      watcher.inject('change', path.join(posts, 'a.md'));
      await settle();
      assert.equal(sink.events.length, 1);
      assert.equal(sink.events[0].path, 'posts/a.md');
    } finally { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('目录外的事件被拒，且留痕', async () => {
    const { root, posts } = tempProject();
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, ...sink }).start();
    try {
      for (const target of [
        path.join(root, 'secret.env'),
        path.join(root, '..', 'outside.md'),
        '/etc/passwd',
        path.join(root, 'node_modules', 'x', 'index.md'),
      ]) {
        watcher.inject('change', target);
      }
      await settle();
      assert.equal(sink.events.length, 0, '目录外的事件不该触发重建');
      assert.equal(watcher.rejected.length, 4, '每一次拒绝都要留痕 —— 这是排查「我改了为什么不重建」的唯一线索');
    } finally { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('内容目录里的深层子目录也管', async () => {
    const { root, posts } = tempProject();
    fs.mkdirSync(path.join(posts, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(posts, 'nested', 'deeper', 'b.md'), '# B\n');
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, ...sink }).start();
    try {
      watcher.inject('change', path.join(posts, 'nested', 'deeper', 'b.md'));
      await settle();
      assert.equal(sink.events.length, 1);
      assert.equal(sink.events[0].path, 'posts/nested/deeper/b.md');
    } finally { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('符号链接（S2-3a 的防线不得在新入口失守）', () => {
  test('指向内容目录之外的软链被拒', async (t) => {
    const { root, posts } = tempProject();
    const link = path.join(posts, 'escape.md');
    try {
      fs.symlinkSync(path.join(root, 'secret.env'), link);
    } catch {
      t.skip('平台不支持符号链接');
      return;
    }
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, ...sink }).start();
    try {
      watcher.inject('change', link);
      await settle();
      assert.equal(sink.events.length, 0, '软链指到目录外时必须拒绝');
      assert.equal(watcher.rejected.length, 1);
    } finally { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('指向内容目录之内的软链放行（不能一刀切）', async (t) => {
    const { root, posts } = tempProject();
    const link = path.join(posts, 'alias.md');
    try {
      fs.symlinkSync(path.join(posts, 'a.md'), link);
    } catch {
      t.skip('平台不支持符号链接');
      return;
    }
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, ...sink }).start();
    try {
      watcher.inject('change', link);
      await settle();
      assert.equal(sink.events.length, 1, '指在内容目录内的软链是正常用法，不该被拒');
    } finally { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('软链目录不递归进去（否则会把整棵外部树拖进来）', async (t) => {
    const { root, posts } = tempProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-outside-'));
    fs.writeFileSync(path.join(outside, 'x.md'), '# X\n');
    try {
      fs.symlinkSync(outside, path.join(posts, 'linkdir'), 'dir');
    } catch {
      t.skip('平台不支持符号链接');
      return;
    }
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, ...sink }).start();
    try {
      watcher.inject('change', path.join(posts, 'linkdir', 'x.md'));
      await settle();
      assert.equal(sink.events.length, 0, '软链目录里的文件在内容目录之外');
    } finally {
      watcher.stop();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('异常隔离', () => {
  test('内容目录不存在时只告警并照常返回（不抛）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emeeek-nowatch-'));
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: path.join(root, 'missing'), resolve: resolveProjectFile, ...sink });
    assert.doesNotThrow(() => watcher.start());
    assert.match(sink.warnings.join('\n'), /内容目录不存在/);
    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('fs.watch 抛错时只告警，不把 start 弄崩', () => {
    const { root, posts } = tempProject();
    const sink = collector();
    const failing = {
      watch: () => { throw new Error('ENOSPC: inotify 用尽'); },
      existsSync: () => true,
      readdirSync: () => [],
    };
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, fsImpl: failing, ...sink });
    assert.doesNotThrow(() => watcher.start());
    assert.match(sink.warnings.join('\n'), /无法监听/);
    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('onChange 抛错不会让监听器死掉，后续事件照常', async () => {
    const { root, posts } = tempProject();
    let calls = 0;
    const warnings = [];
    const watcher = createWatcher({
      root,
      contentDir: posts,
      resolve: resolveProjectFile,
      logger: { warn: (msg) => warnings.push(msg) },
      onChange: () => { calls += 1; throw new Error('rebuild exploded'); },
    }).start();
    try {
      watcher.inject('change', path.join(posts, 'a.md'));
      await settle();
      assert.equal(calls, 1);
      assert.match(warnings.join('\n'), /重建回调出错（已隔离）/);
      // 第二次仍然触发 —— 「坏了一次就永远不工作」比抛错本身更糟
      watcher.inject('change', path.join(posts, 'a.md'));
      await settle();
      assert.equal(calls, 2);
    } finally { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('事件洪泛被合并，不会把重建排成队列', async () => {
    const { root, posts } = tempProject();
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, ...sink }).start();
    try {
      // 模拟一次 git 操作造出的大量事件
      for (let i = 0; i < 400; i += 1) watcher.inject('change', path.join(posts, 'a.md'));
      await settle(400);
      assert.ok(sink.events.length <= 1, `洪泛时应当合并成最多一次重建，实际 ${sink.events.length} 次`);
    } finally { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('stop 之后不再有任何事件', async () => {
    const { root, posts } = tempProject();
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, ...sink }).start();
    watcher.stop();
    watcher.inject('change', path.join(posts, 'a.md'));
    await settle();
    assert.equal(sink.events.length, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('防抖：连续两次变更只重建一次', async () => {
    const { root, posts } = tempProject();
    const sink = collector();
    const watcher = createWatcher({ root, contentDir: posts, resolve: resolveProjectFile, ...sink }).start();
    try {
      watcher.inject('change', path.join(posts, 'a.md'));
      watcher.inject('change', path.join(posts, 'a.md'));
      await settle();
      assert.equal(sink.events.length, 1);
    } finally { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

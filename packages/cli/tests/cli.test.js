import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/index.js';

const run = promisify(execFile);
const BIN = path.resolve(fileURLToPath(new URL('../bin/emeeek.js', import.meta.url)));

/** 跑 CLI 并返回 { code, stdout, stderr }，不因非零退出码抛错。 */
async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { ...options, env: { ...process.env, NO_COLOR: '1' } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('parseArgs 处理 --key value 与 --key=value', () => {
  const { positionals, flags } = parseArgs(['build', '--cwd', '/x', '--port=3000']);
  assert.deepEqual(positionals, ['build']);
  assert.equal(flags.cwd, '/x');
  assert.equal(flags.port, '3000');
});

test('parseArgs 的布尔标志在末尾时为 true', () => {
  const { flags } = parseArgs(['dev', '--open']);
  assert.equal(flags.open, true);
});

test('parseArgs 会把裸标志后的位置参数当成它的值', () => {
  // 这是刻意的取舍：为了支持 `--cwd /path`，裸标志是贪婪的。
  const { positionals, flags } = parseArgs(['build', '--open', 'extra']);
  assert.deepEqual(positionals, ['build']);
  assert.equal(flags.open, 'extra');
});

test('parseArgs 支持 -h / -v 短标志', () => {
  assert.equal(parseArgs(['-h']).flags.help, true);
  assert.equal(parseArgs(['-v']).flags.version, true);
});

test('无参数时输出帮助', async () => {
  const { code, stdout } = await cli([]);
  assert.equal(code, 0);
  assert.match(stdout, /用法: emeeek/);
});

test('--version 输出版本号', async () => {
  const { stdout } = await cli(['--version']);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('未知命令以非零码退出并列出可用命令', async () => {
  const { code, stderr, stdout } = await cli(['nope']);
  assert.equal(code, 1);
  assert.match(stderr + stdout, /未知命令/);
  assert.match(stderr + stdout, /init/);
});

test('init 生成可构建的项目', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    const target = path.join(dir, 'site');
    const init = await cli(['init', target]);
    assert.equal(init.code, 0, init.stderr);

    for (const file of ['emeeek.config.js', '.gitignore']) {
      await assert.doesNotReject(fs.access(path.join(target, file)), `缺少 ${file}`);
    }

    const built = await cli(['build', '--cwd', target]);
    assert.equal(built.code, 0, built.stderr);
    await assert.doesNotReject(fs.access(path.join(target, 'dist', 'index.html')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('init 不覆盖已存在的文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), '// 我自己的配置', 'utf8');
    const { stdout, stderr } = await cli(['init', dir]);
    assert.match(stdout + stderr, /已存在，跳过/);
    assert.equal(await fs.readFile(path.join(dir, 'emeeek.config.js'), 'utf8'), '// 我自己的配置');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('build 在不存在的目录失败，而不是产出空站点', async () => {
  const missing = path.join(os.tmpdir(), `emeeek-missing-${Date.now()}`);
  const { code, stderr } = await cli(['build', '--cwd', missing]);
  assert.equal(code, 1);
  assert.match(stderr, /目录不存在/);
  await assert.rejects(fs.access(missing), '不应创建目录');
});

test('new 需要标题', async () => {
  const { code, stderr } = await cli(['new']);
  assert.equal(code, 1);
  assert.match(stderr, /用法：emeeek new/);
});

test('new 创建草稿文件，重复标题被拒绝', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await cli(['init', dir]);
    const first = await cli(['new', '测试标题', '--tags', 'a,b', '--cwd', dir]);
    assert.equal(first.code, 0, first.stderr);

    const files = await fs.readdir(path.join(dir, 'posts'));
    const created = files.find((f) => f.includes('测试标题'));
    assert.ok(created, `未找到创建的文件，实际：${files.join(', ')}`);

    const content = await fs.readFile(path.join(dir, 'posts', created), 'utf8');
    assert.match(content, /draft: true/);
    assert.match(content, /tags: \[a, b\]/);

    const second = await cli(['new', '测试标题', '--cwd', dir]);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /已存在/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor 在配置有问题时以非零码退出', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default { site: { url: '不是链接' } };`, 'utf8');
    const { code } = await cli(['doctor', '--cwd', dir]);
    assert.equal(code, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('doctor 在项目健康时以 0 退出', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts/a.md'), '---\ntitle: T\n---\n\n正文。', 'utf8');
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default { site: { url: 'https://ok.example.com' } };`, 'utf8');
    const { code, stdout } = await cli(['doctor', '--cwd', dir]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /全部检查通过/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('clean 删除产物目录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await cli(['init', dir]);
    await cli(['build', '--cwd', dir]);
    await assert.doesNotReject(fs.access(path.join(dir, 'dist')));
    const { code } = await cli(['clean', '--cwd', dir]);
    assert.equal(code, 0);
    await assert.rejects(fs.access(path.join(dir, 'dist')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── emeeek theme（P3-1b-3b feature E） ──────────────────────────

test('theme list 列出内置主题并标出当前主题', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default { site: { url: 'https://x.dev' }, theme: { name: 'minimal' } };`, 'utf8');
    const { code, stdout } = await cli(['theme', 'list', '--cwd', dir]);
    assert.equal(code, 0, stdout);
    for (const name of ['aurora', 'minimal', 'inkstone', 'magazine']) {
      assert.match(stdout, new RegExp(name));
    }
    assert.match(stdout, /当前主题：minimal/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('theme switch 改写配置里的 theme.name，注释与其它字段保留', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `// 我的博客\nexport default {\n  site: { url: 'https://x.dev', title: 'T' },\n  theme: { name: 'minimal', darkMode: 'auto' },\n};\n`, 'utf8');
    const { code, stdout } = await cli(['theme', 'switch', 'magazine', '--cwd', dir]);
    assert.equal(code, 0, stdout);
    const after = await fs.readFile(path.join(dir, 'emeeek.config.js'), 'utf8');
    assert.match(after, /name: 'magazine'/);
    assert.match(after, /darkMode: 'auto'/, '未指定的字段应保留');
    assert.match(after, /\/\/ 我的博客/, '注释应保留');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('theme switch --dark 同时改 darkMode', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default { site: { url: 'https://x.dev' }, theme: { name: 'minimal', darkMode: 'auto' } };`, 'utf8');
    await cli(['theme', 'switch', 'aurora', '--dark', '--cwd', dir]);
    const after = await fs.readFile(path.join(dir, 'emeeek.config.js'), 'utf8');
    assert.match(after, /name: 'aurora'/);
    assert.match(after, /darkMode: 'dark'/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('theme switch 未知主题以非零码退出并列出可用项', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default { site: { url: 'https://x.dev' } };`, 'utf8');
    const { code, stderr } = await cli(['theme', 'switch', 'nope', '--cwd', dir]);
    assert.notEqual(code, 0);
    assert.match(stderr + '', /找不到主题/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('theme create 生成可构建的骨架', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts/a.md'), '---\ntitle: T\n---\n\n正文。', 'utf8');
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default { site: { url: 'https://x.dev' }, theme: { name: 'minimal' } };`, 'utf8');
    const created = await cli(['theme', 'create', 'my-theme', '--cwd', dir]);
    assert.equal(created.code, 0, created.stdout);
    await assert.doesNotReject(fs.access(path.join(dir, 'themes/my-theme/theme.json')));

    await cli(['theme', 'switch', 'my-theme', '--cwd', dir]);
    const built = await cli(['build', '--cwd', dir]);
    assert.equal(built.code, 0, built.stdout);
    await assert.doesNotReject(fs.access(path.join(dir, 'dist/index.html')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('theme create 重名时拒绝（除非 --force）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cli-'));
  try {
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default { site: { url: 'https://x.dev' } };`, 'utf8');
    await cli(['theme', 'create', 'dup', '--cwd', dir]);
    const again = await cli(['theme', 'create', 'dup', '--cwd', dir]);
    assert.notEqual(again.code, 0);
    assert.match(again.stderr + '', /已存在/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('theme 无子命令时输出用法', async () => {
  const { code, stdout } = await cli(['theme']);
  assert.equal(code, 0);
  assert.match(stdout, /用法: emeeek theme/);
});

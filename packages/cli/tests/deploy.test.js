import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const BIN = path.resolve(fileURLToPath(new URL('../bin/emeeek.js', import.meta.url)));

async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      ...options,
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** 建一个能通过 deploy 门禁的最小项目。 */
async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-deploy-cli-'));
  await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'posts', 'a.md'), '---\ntitle: A\ndate: 2024-01-01\n---\n\n正文。\n');
  await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default {
  site: { title: 'Deploy Test', url: 'https://deploy.example.test' },
  content: { source: 'local', localDirs: ['posts'] },
};`);
  return dir;
}

test('deploy --target 未知平台以非零码退出并列出可用目标', async () => {
  const dir = await makeProject();
  try {
    const { code, stderr, stdout } = await cli(['deploy', '--target', 'heroku', '--cwd', dir]);
    assert.equal(code, 1);
    assert.match(stderr + stdout, /不认识的部署目标/);
    assert.match(stderr + stdout, /github-pages/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy --dry-run 只预演，不写配置文件', async () => {
  const dir = await makeProject();
  try {
    const { code, stdout, stderr } = await cli(['deploy', '--target', 'vercel', '--dry-run', '--cwd', dir]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /dry-run/);
    await assert.rejects(fs.access(path.join(dir, 'vercel.json')), 'dry-run 不该写盘');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy 默认执行构建（不要求先跑 build）', async () => {
  const dir = await makeProject();
  try {
    const { code, stdout, stderr } = await cli(['deploy', '--target', 'github-pages', '--dry-run', '--cwd', dir]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /构建完成/);
    await assert.doesNotReject(fs.access(path.join(dir, 'dist', 'index.html')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// 说明：CLI 测试只跑 github-pages（mode=actions，本地不推送）。
// 其余平台的推送要外部 CLI 与网络，属于集成测试范畴，由 deploy 模块单测用
// 注入的 runCommand 覆盖 —— 单元测试不该真的去 `npx vercel deploy`。
test('deploy 真实写入平台配置（非 dry-run）', async () => {
  const dir = await makeProject();
  try {
    const { code, stderr } = await cli(['deploy', '--target', 'github-pages', '--no-verify', '--cwd', dir]);
    assert.equal(code, 0, stderr);
    await assert.doesNotReject(fs.access(path.join(dir, '.nojekyll')));
    const yml = await fs.readFile(path.join(dir, '.github/workflows/deploy-pages.yml'), 'utf8');
    assert.match(yml, /deploy-pages@v4/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy 幂等：第二次执行配置文件内容不变（跳过写入）', async () => {
  const dir = await makeProject();
  try {
    await cli(['deploy', '--target', 'github-pages', '--no-verify', '--cwd', dir]);
    const file = path.join(dir, '.nojekyll');
    const stat1 = await fs.stat(file);

    await new Promise((r) => setTimeout(r, 20));
    const { stdout, code, stderr } = await cli(['deploy', '--target', 'github-pages', '--no-verify', '--cwd', dir]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /内容未变，跳过/);

    const stat2 = await fs.stat(file);
    assert.equal(stat2.mtimeMs, stat1.mtimeMs, '幂等被破坏：文件被重写了');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy 在占位域名上中止（example.com 检出）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-deploy-cli-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts', 'a.md'), '---\ntitle: A\ndate: 2024-01-01\n---\n正文');
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default { site: { url: 'https://example.com' }, content: { source: 'local', localDirs: ['posts'] } };`);
    const { code, stderr, stdout } = await cli(['deploy', '--target', 'vercel', '--dry-run', '--cwd', dir]);
    assert.equal(code, 1);
    assert.match(stderr + stdout, /站点地址已配置|部署前检查未通过/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy --target rsync 缺 --host/--path 时在构建前报错', async () => {
  const dir = await makeProject();
  try {
    const { code, stdout, stderr } = await cli(['deploy', '--target', 'rsync', '--cwd', dir]);
    assert.equal(code, 1);
    assert.match(stderr + stdout, /--host/);
    // 关键：不该先花时间构建。
    assert.ok(!/构建完成/.test(stdout), '参数没齐不该开始构建');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy --target rsync 带齐参数可预演', async () => {
  const dir = await makeProject();
  try {
    const { code, stdout, stderr } = await cli([
      'deploy', '--target', 'rsync', '--host', 'root@1.2.3.4', '--path', '/var/www/blog',
      '--dry-run', '--cwd', dir,
    ]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /nginx\.conf|Caddyfile/);
    assert.match(stdout, /rsync/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy 别名 gh 等价于 github-pages', async () => {
  const dir = await makeProject();
  try {
    const a = await cli(['deploy', '--target', 'gh', '--dry-run', '--cwd', dir]);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /GitHub Pages/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deploy 在不存在目录失败并给修复建议', async () => {
  const missing = path.join(os.tmpdir(), `emeeek-missing-${Date.now()}`);
  const { code, stderr } = await cli(['deploy', '--target', 'vercel', '--cwd', missing]);
  assert.equal(code, 1);
  assert.match(stderr, /目录不存在/);
});

test('deploy --no-build 跳过构建（dist 不存在时应被门禁拦下）', async () => {
  const dir = await makeProject();
  try {
    const { code, stderr, stdout } = await cli(['deploy', '--target', 'vercel', '--no-build', '--dry-run', '--cwd', dir]);
    assert.equal(code, 1);
    assert.match(stderr + stdout, /产物目录|部署前检查未通过/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('help 里列出了 deploy 与 drafts', async () => {
  const { stdout } = await cli(['--help']);
  assert.match(stdout, /deploy/);
  assert.match(stdout, /drafts/);
  assert.match(stdout, /--target/);
});

test('drafts 命令列出草稿与定时发布', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-drafts-'));
  try {
    await fs.mkdir(path.join(dir, 'posts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'posts', 'live.md'), '---\ntitle: 已发布\ndate: 2024-01-01\n---\n正文');
    await fs.writeFile(path.join(dir, 'posts', 'draft.md'), '---\ntitle: 草稿文章\ndate: 2024-01-02\ndraft: true\n---\n正文');
    await fs.writeFile(path.join(dir, 'posts', 'future.md'), `---\ntitle: 定时文章\ndate: ${new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10)}\n---\n正文`);
    await fs.writeFile(path.join(dir, 'emeeek.config.js'), `export default { site: { url: 'https://x.test' }, content: { source: 'local', localDirs: ['posts'] } };`);

    const { code, stdout, stderr } = await cli(['drafts', '--cwd', dir]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /已发布：1 篇/);
    assert.match(stdout, /草稿文章/);
    assert.match(stdout, /定时文章/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

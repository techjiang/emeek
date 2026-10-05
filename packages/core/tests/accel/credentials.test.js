import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseCredentials,
  serializeCredentials,
  loadCredentials,
  saveCredentials,
  ensureGitignored,
} from '../../src/accel/credentials.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'emeeek-cred-'));
}

describe('CDN 凭据存储', () => {
  test('解析 key=value，忽略注释与空行', () => {
    const parsed = parseCredentials('# c\nCF_API_KEY=abc\n\nCF_ZONE_ID="z1"\n');
    assert.deepEqual(parsed, { CF_API_KEY: 'abc', CF_ZONE_ID: 'z1' });
  });

  test('序列化带警告头', () => {
    const text = serializeCredentials({ CF_API_KEY: 'x' });
    assert.match(text, /不要提交进版本库/);
    assert.match(text, /CF_API_KEY=x/);
  });

  test('环境变量优先于文件', async () => {
    const cwd = await tmpDir();
    await saveCredentials({ CF_API_KEY: 'from-file', CF_ZONE_ID: 'z' }, { cwd });
    const { values, sources } = await loadCredentials('cloudflare', { cwd, env: { CF_API_KEY: 'from-env' } });
    assert.equal(values.apiKey, 'from-env');
    assert.equal(values.zoneId, 'z');
    assert.equal(sources.apiKey, 'env:CF_API_KEY');
  });

  test('缺少必填凭据时进 missing，不抛错', async () => {
    const cwd = await tmpDir();
    const { missing } = await loadCredentials('cloudflare', { cwd, env: {} });
    assert.deepEqual(missing.map((m) => m.env).sort(), ['CF_API_KEY', 'CF_ZONE_ID']);
  });

  test('凭据文件权限为 0600（负向验证：其他用户读不到）', async () => {
    const cwd = await tmpDir();
    const target = await saveCredentials({ CF_API_KEY: 'x' }, { cwd });
    const stat = await fs.stat(target);
    assert.equal(stat.mode & 0o777, 0o600);
  });

  test('写入保留已有键（合并而非覆盖）', async () => {
    const cwd = await tmpDir();
    await saveCredentials({ CF_API_KEY: 'a' }, { cwd });
    await saveCredentials({ CF_ZONE_ID: 'b' }, { cwd });
    const { values } = await loadCredentials('cloudflare', { cwd, env: {} });
    assert.equal(values.apiKey, 'a');
    assert.equal(values.zoneId, 'b');
  });

  test('ensureGitignored 补写 .gitignore', async () => {
    const cwd = await tmpDir();
    const added = await ensureGitignored(cwd);
    assert.equal(added, true);
    const content = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
    assert.match(content, /\.emeek\//);
  });

  test('已有 .emeek/ 时幂等不重复写', async () => {
    const cwd = await tmpDir();
    await ensureGitignored(cwd);
    assert.equal(await ensureGitignored(cwd), false);
  });

  test('未知提供商报错', async () => {
    const cwd = await tmpDir();
    await assert.rejects(() => loadCredentials('nope', { cwd, env: {} }), /未知的 CDN 提供商/);
  });
});

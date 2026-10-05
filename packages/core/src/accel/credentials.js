import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PROVIDERS } from './providers.js';

/**
 * 凭据存储，优先级：环境变量 > 项目 .emeek/credentials > ~/.emeek/credentials。
 *
 * 为什么要有文件这一层：环境变量在「本地手动跑 emeeek accelerate --purge」时
 * 不方便每次都 export；但写进 emeeek.config.js 会随仓库提交 → 泄露。
 * 所以给一个 git-ignored 的文件位置，并强制校验它不在产物里。
 */

const CRED_PATHS = [
  { scope: 'project', file: (cwd) => path.join(cwd, '.emeek', 'credentials') },
  { scope: 'user', file: () => path.join(os.homedir(), '.emeek', 'credentials') },
];

/** 解析 key=value 形式的凭据文件。注释与空行忽略。 */
export function parseCredentials(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function serializeCredentials(values) {
  const header = [
    '# Emeek CDN 凭据 —— 不要提交进版本库。',
    '# 优先级：环境变量 > 此文件。',
    '',
  ];
  const body = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  return [...header, ...body, ''].join('\n');
}

/**
 * 读取某提供商所需的全部凭据。
 * @returns {Promise<{values: Record<string,string>, missing: Array<{key:string,env:string}>, sources: Record<string,string>}>}
 */
export async function loadCredentials(providerId, { cwd = process.cwd(), env = process.env, home } = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`未知的 CDN 提供商「${providerId}」`);

  const fileValues = {};
  const sources = {};
  for (const entry of CRED_PATHS) {
    const target = entry.scope === 'user' && home ? path.join(home, '.emeek', 'credentials') : entry.file(cwd);
    try {
      const parsed = parseCredentials(await fs.readFile(target, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (fileValues[k] === undefined) {
          fileValues[k] = v;
          sources[k] = `${entry.scope}:${target}`;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const values = {};
  const missing = [];
  for (const field of provider.fields) {
    if (!field.env) continue;
    const fromEnv = env[field.env];
    if (fromEnv) {
      values[field.key] = fromEnv;
      sources[field.key] = `env:${field.env}`;
      continue;
    }
    if (fileValues[field.env]) {
      values[field.key] = fileValues[field.env];
      continue;
    }
    if (field.required) missing.push({ key: field.key, env: field.env });
  }
  return { values, missing, sources };
}

/**
 * 把凭据写入指定作用域的文件（权限 0600）。
 * 只在用户显式执行配置向导时调用。
 */
export async function saveCredentials(values, { cwd = process.cwd(), scope = 'project' } = {}) {
  const entry = CRED_PATHS.find((p) => p.scope === scope);
  if (!entry) throw new Error(`未知的凭据作用域「${scope}」，可用：project / user`);
  const target = entry.file(cwd);
  await fs.mkdir(path.dirname(target), { recursive: true });

  let existing = {};
  try {
    existing = parseCredentials(await fs.readFile(target, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const merged = { ...existing, ...values };
  await fs.writeFile(target, serializeCredentials(merged), { mode: 0o600 });
  await fs.chmod(target, 0o600).catch(() => {});
  return target;
}

/** 确保 .emeek/credentials 不会被提交。返回是否补写了 .gitignore。 */
export async function ensureGitignored(cwd = process.cwd()) {
  const target = path.join(cwd, '.gitignore');
  const line = '.emeek/';
  let content = '';
  try {
    content = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(line) || lines.includes('.emeek') || lines.includes('.emeek/credentials')) return false;
  const next = `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
  await fs.writeFile(target, next);
  return true;
}

export { CRED_PATHS };

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 版本号的唯一真相。
 *
 * 之前 CLI 里写死 '0.1.0'、package.json 里另写一份、构建产物里没有 ———
 * 三处各自为政，改一处忘两处是迟早的事。这里从 package.json 读一次，
 * 全仓库引用这一个常量。
 *
 * 为什么是 core 而不是 CLI：构建产物（<meta name="generator">）也要带版本，
 * 而产物由 core 生成，core 不能反向依赖 CLI。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(HERE, '..', 'package.json');

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version ?? '0.0.0';
  } catch {
    // 读不到就退到 0.0.0：宁可版本号难看，也不要因为一个展示字段让构建崩掉。
    return '0.0.0';
  }
}

export const VERSION = readVersion();

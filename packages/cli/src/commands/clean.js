import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, logger } from '@emeeek/core';

export async function clean({ cwd }) {
  const root = path.resolve(cwd);
  let dir = 'dist';
  try {
    const { config } = await loadConfig(root);
    dir = config.output?.dir ?? 'dist';
  } catch { /* 配置坏了也应能清理产物 */ }

  const target = path.resolve(root, dir);
  try {
    await fs.rm(target, { recursive: true, force: true });
    logger.success(`已清理 ${path.relative(process.cwd(), target) || target}`);
  } catch (error) {
    throw new Error(`清理失败：${error.message}`);
  }
}

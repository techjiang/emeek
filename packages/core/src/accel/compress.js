import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

/**
 * 构建期预压缩。
 *
 * 为什么要预压缩而不是让服务器实时压：
 * Nginx 的 gzip on 是「每个请求每个响应压一遍」，CPU 花在重复劳动上；
 * 预压缩把这份工作挪到构建期一次做完，Nginx 只需 gzip_static on 直接发文件。
 * Brotli 同理（brotli_static）。对静态站来说这是纯赚。
 *
 * 阈值：小于 MIN_SIZE 的文件压缩收益抵不过一个额外的 304 往返，跳过。
 */

const MIN_SIZE = 1024;

/** 可压缩的文本类型。已压缩格式（图片/字体/zip）再压只会更大。 */
const COMPRESSIBLE = ['html', 'htm', 'css', 'js', 'mjs', 'json', 'xml', 'txt', 'svg', 'webmanifest'];

export function shouldCompress(filePath, content, { minSize = MIN_SIZE } = {}) {
  const name = String(filePath).split('/').pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!COMPRESSIBLE.includes(ext)) return false;
  const bytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), 'utf8');
  return bytes >= minSize;
}

/**
 * 生成 gzip 与 brotli 两个变体。两者各有用处：
 * gzip 是全场兜底，brotli 给支持 br 的浏览器再省 15~20%。
 */
export async function compressVariants(content, {
  gzipLevel = zlib.constants.Z_BEST_COMPRESSION,
  brotliQuality = 11,
} = {}) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const [gz, br] = await Promise.all([
    gzip(buf, { level: gzipLevel }),
    brotli(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }),
  ]);
  return {
    gzip: gz,
    brotli: br,
    originalSize: buf.length,
    gzipSize: gz.length,
    brotliSize: br.length,
  };
}

/**
 * 批量预压缩一批文件。
 * @param {Array<{path: string, content: Buffer|string}>} files
 * @returns {Promise<{variants: Array<{path:string,gzip:Buffer,brotli:Buffer,originalSize:number,gzipSize:number,brotliSize:number}>, summary: object}>}
 */
export async function precompress(files, { onProgress } = {}) {
  const variants = [];
  let original = 0;
  let gzipTotal = 0;
  let brotliTotal = 0;
  let skipped = 0;

  for (const file of files) {
    if (!shouldCompress(file.path, file.content)) {
      skipped += 1;
      continue;
    }
    const result = await compressVariants(file.content);
    // 压完更大就别发（小文件偶尔会这样），退化为只发原文件。
    if (result.gzipSize >= result.originalSize && result.brotliSize >= result.originalSize) {
      skipped += 1;
      continue;
    }
    variants.push({ path: file.path, ...result });
    original += result.originalSize;
    gzipTotal += result.gzipSize;
    brotliTotal += result.brotliSize;
    onProgress?.(variants.length);
  }

  return {
    variants,
    summary: {
      count: variants.length,
      skipped,
      originalBytes: original,
      gzipBytes: gzipTotal,
      brotliBytes: brotliTotal,
      gzipRatio: original ? round(gzipTotal / original) : null,
      brotliRatio: original ? round(brotliTotal / original) : null,
    },
  };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

export { COMPRESSIBLE, MIN_SIZE };

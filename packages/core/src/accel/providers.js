/**
 * CDN 提供商注册表。
 *
 * 设计准则与 platforms.js 一致：新增一个 CDN = 往这里加一条，
 * 不在调用侧写 `if (provider === 'cloudflare')`。
 *
 * 每个提供商声明：
 *   - id / name / docs        身份与文档
 *   - fields[]                配置向导要问哪些字段（含 env 名）
 *   - api                     API 端点模板（供 purge / warm 调用）
 *   - chinaAccess             是否具备中国大陆节点能力
 *   - requiresIcp             是否必须 ICP 备案
 *   - buildHeaders()          生成该 CDN 的缓存规则（与具体 API 解耦）
 *
 * API Key 一律从环境变量或凭据文件读，绝不写进配置对象或产物。
 */

const COMMON_CREDENTIALS = {
  apiKeyEnv: 'EMEEEK_CDN_API_KEY',
};

export const PROVIDERS = {
  cloudflare: {
    id: 'cloudflare',
    name: 'Cloudflare',
    docs: 'https://developers.cloudflare.com/cache/',
    free: true,
    chinaAccess: false, // 中国大陆走合作伙伴/Enterprise，免费套餐无大陆节点
    requiresIcp: false,
    fields: [
      { key: 'zone', label: 'Zone（根域名，如 techsauce.cn）', required: true },
      { key: 'zoneId', label: 'Zone ID', required: true, env: 'CF_ZONE_ID' },
      { key: 'apiKey', label: 'API Token（Cache Purge 权限）', required: true, secret: true, env: 'CF_API_KEY' },
    ],
    api: {
      purge: 'https://api.cloudflare.com/client/v4/zones/{zoneId}/purge_cache',
      purgeAuth: 'bearer',
      purgeBody: (targets) => JSON.stringify({ files: targets }),
      warm: null, // Cloudflare 无官方预热 API，靠首次访问回源
    },
    /** Cloudflare 靠 Cache Rules / Page Rules 表达缓存策略。 */
    buildHeaders(policy) {
      return {
        'Cache Rules': [
          { match: '*.{css,js,woff2,svg,png,jpg,webp,avif} (带指纹)', action: policy.immutable },
          { match: '*.html', action: policy.html },
          { match: '/search-index.json', action: policy.data },
        ],
        Brotli: true,
        'Early Hints': true,
      };
    },
  },

  aliyun: {
    id: 'aliyun',
    name: '阿里云 CDN',
    docs: 'https://help.aliyun.com/product/27099.html',
    free: false,
    chinaAccess: true,
    requiresIcp: true,
    fields: [
      { key: 'domain', label: '加速域名（如 cdn.myblog.techsauce.cn）', required: true },
      { key: 'accessKeyId', label: 'AccessKey ID', required: true, env: 'ALIYUN_ACCESS_KEY_ID' },
      { key: 'accessKeySecret', label: 'AccessKey Secret', required: true, secret: true, env: 'ALIYUN_ACCESS_KEY_SECRET' },
      { key: 'icp', label: '域名是否已完成 ICP 备案', type: 'boolean', default: false },
    ],
    api: {
      purge: 'https://cdn.aliyuncs.com/?Action=RefreshObjectCaches&ObjectType=File&ObjectPath={targets}',
      warm: 'https://cdn.aliyuncs.com/?Action=PushObjectCache&ObjectType=File&ObjectPath={targets}',
      purgeAuth: 'hmac-sha1',
    },
    buildHeaders(policy) {
      return {
        '缓存过期时间': [
          { match: '*.{css,js,woff2,svg,png,jpg,webp,avif}', ttl: '365d', action: policy.immutable },
          { match: '*.html', ttl: '5m', action: policy.html },
          { match: '/search-index.json', ttl: '0s', action: policy.noStore },
        ],
        '智能压缩': 'brotli+gzip',
        'HTTP/2': true,
      };
    },
  },

  tencent: {
    id: 'tencent',
    name: '腾讯云 CDN',
    docs: 'https://cloud.tencent.com/document/product/228',
    free: false,
    chinaAccess: true,
    requiresIcp: true,
    fields: [
      { key: 'domain', label: '加速域名', required: true },
      { key: 'secretId', label: 'SecretId', required: true, env: 'TENCENT_SECRET_ID' },
      { key: 'secretKey', label: 'SecretKey', required: true, secret: true, env: 'TENCENT_SECRET_KEY' },
      { key: 'icp', label: '域名是否已完成 ICP 备案', type: 'boolean', default: false },
    ],
    api: {
      purge: 'https://cdn.tencentcloudapi.com/ (PurgeUrlsCache)',
      warm: 'https://cdn.tencentcloudapi.com/ (PushUrlsCache)',
      purgeAuth: 'tc3-hmac-sha256',
    },
    buildHeaders(policy) {
      return {
        '缓存配置': [
          { match: '*.{css,js,woff2,svg,png,jpg,webp,avif}', ttl: '365d', action: policy.immutable },
          { match: '*.html', ttl: '5m', action: policy.html },
          { match: '/search-index.json', ttl: '0s', action: policy.noStore },
        ],
        '智能压缩': 'brotli+gzip',
        'HTTP/2': true,
      };
    },
  },

  custom: {
    id: 'custom',
    name: '自定义 / 自建',
    docs: '',
    free: true,
    chinaAccess: true,
    requiresIcp: false,
    fields: [
      { key: 'domain', label: '加速域名', required: true },
      { key: 'purgeEndpoint', label: '刷新接口地址（可选）', required: false },
    ],
    api: {
      purge: '{purgeEndpoint}',
      warm: null,
      purgeAuth: 'header',
    },
    buildHeaders(policy) {
      return {
        '自建建议': 'Nginx: gzip_static on; brotli_static on; 并按产物清单设置 Cache-Control',
        immutable: policy.immutable,
        html: policy.html,
        data: policy.data,
      };
    },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`未知的 CDN 提供商「${id}」。可用：${PROVIDER_IDS.join(' / ')}`);
  }
  return provider;
}

/**
 * 从环境变量里取某个提供商需要的凭据。
 * 缺哪个返回哪个，不抛错 —— 由调用方决定是提示还是阻断。
 */
export function readCredentialsFromEnv(providerId, env = process.env) {
  const provider = getProvider(providerId);
  const values = {};
  const missing = [];
  for (const field of provider.fields) {
    if (!field.env) continue;
    const value = env[field.env];
    if (value) values[field.key] = value;
    else if (field.required) missing.push({ key: field.key, env: field.env });
  }
  return { values, missing };
}

/**
 * 校验 CDN 配置。返回 { errors, warnings }。
 * 关键负向约束：secret 字段不得出现在配置对象里 —— 必须来自环境/凭据文件。
 */
export function validateCdnConfig(cdn) {
  const errors = [];
  const warnings = [];
  if (!cdn || cdn.enabled === false) return { errors, warnings };
  // provider 未配置 ≠ 配置错误。降级加速（指纹 + 预压缩）不需要 CDN。
  if (!cdn.provider) return { errors, warnings };

  let provider;
  try {
    provider = getProvider(cdn.provider);
  } catch (error) {
    errors.push({ path: 'cdn.provider', message: error.message });
    return { errors, warnings };
  }

  for (const field of provider.fields) {
    const value = cdn[field.key];
    if (field.secret && value !== undefined && value !== null && value !== '') {
      errors.push({
        path: `cdn.${field.key}`,
        message: `${field.label}属于凭据，不能写进配置文件；请用环境变量 ${field.env} 或 ~/.emeek/credentials`,
      });
      continue;
    }
    if (field.required && !field.secret && (value === undefined || value === '')) {
      // 非 secret 必填项允许缺失，但给警告 —— 向导里会补。
      warnings.push({ path: `cdn.${field.key}`, message: `缺少 ${field.label}` });
    }
  }

  if (provider.requiresIcp && !cdn.icp) {
    warnings.push({
      path: 'cdn.icp',
      message: `${provider.name} 在中国大陆提供加速需要 ICP 备案。未备案的域名会被阻断解析。`,
    });
  }
  if (cdn.china?.enabled && !provider.chinaAccess) {
    warnings.push({
      path: 'cdn.china',
      message: `${provider.name} 免费套餐不含中国大陆节点，请把 cdn.china.provider 指向 aliyun/tencent。`,
    });
  }
  return { errors, warnings };
}

export { COMMON_CREDENTIALS };

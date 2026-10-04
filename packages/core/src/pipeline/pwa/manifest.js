/**
 * Web App Manifest（PWA 的「身份声明」）。
 *
 * 为什么由引擎生成、而不是让项目自己放一个 manifest.json：
 * manifest 里最容易写错的两件事都是**构建期才知道的**：
 *
 *   1. `start_url` / `scope` —— 站点可能部署在 `/blog/` 下（basePath），
 *      而 manifest 的路径是相对自身 URL 解析的。手写的 `"/"` 在子路径部署下
 *      会指向「域的根」，于是 PWA 打开的是别人的站点。
 *   2. 图标路径 —— 主题的 favicon 与项目的 icon 来源不同，而 manifest 里
 *      写的每个图标都会被下载并在安装时校验（缺一个就是安装失败，
 *      且失败信息在浏览器控制台里很不显眼）。
 *
 * 所以这里**只输出确实存在的图标**：调用方给「我有哪些图标」，我们据此
 * 生成 icons 数组。宁可不声明图标（浏览器用默认图标，功能照常），
 * 也不声明一个不存在的图标（安装直接被拒，而且看起来像「网站坏了」）。
 */

/** manifest 的标准尺寸档位。声明了尺寸就必须真的有对应文件 —— 见模块注释。 */
export const ICON_SIZES = [192, 512];

/**
 * 生成 manifest 对象。
 *
 * @param {object} opts
 * @param {object} opts.site            站点配置（title / description / language）
 * @param {string} opts.basePath        部署子路径（'' 或 '/blog'）
 * @param {object} opts.icons           实际存在的图标：{ '192': '/assets/icon-192.png', maskable: '...' }
 * @param {string} opts.themeColor      主题色（撒在地址栏 / 任务切换器上）
 * @param {string} opts.backgroundColor 启动画面的背景色
 * @param {string} [opts.display]       standalone | minimal-ui | browser
 */
export function buildManifest({
  site = {}, basePath = '', icons = {}, themeColor = '#ffffff',
  backgroundColor = '#ffffff', display = 'standalone',
} = {}) {
  const base = normalizeBase(basePath);
  const iconList = Object.entries(icons)
    .filter(([size, url]) => url && Number.isFinite(Number(size)))
    .map(([size, url]) => ({
      src: url,
      sizes: `${size}x${size}`,
      type: mimeFor(url),
      purpose: 'any',
    }));

  // maskable 单独一个条目是必要的：Android 会把「any」图标裁成圆形/方形，
  // 而很多图标的重要元素贴着边缘，裁完就没了。没有 maskable 版本时
  // **不声明** —— 拿一张非 maskable 的图冒充 maskable 只会让它被裁得更惨。
  if (icons.maskable) {
    iconList.push({ src: icons.maskable, sizes: '512x512', type: mimeFor(icons.maskable), purpose: 'maskable' });
  }

  const manifest = {
    name: site.title ?? 'Emeek',
    short_name: shortName(site.title ?? 'Emeek'),
    description: site.description ?? '',
    // start_url 必须落在 scope 内，且带 base 前缀 —— 否则子路径部署下
    // 点开 PWA 会跳到域根（不是这个站点）。
    start_url: `${base}/`,
    scope: `${base}/`,
    display,
    // `id` 让浏览器能识别「同一个应用」—— 换了部署路径但 id 相同不算新应用。
    // 不给的话浏览器拿 start_url 当 id，迁移路径就会变成「装了两个」。
    id: `${base}/`,
    lang: site.language ?? 'zh-CN',
    theme_color: themeColor,
    background_color: backgroundColor,
    icons: iconList,
  };
  if (!iconList.length) delete manifest.icons;
  return manifest;
}

/** 短名：桌面 / 主屏显示用的名字。中文按字符截，英文按词截。 */
export function shortName(title) {
  const value = String(title).trim();
  if (/[\u4e00-\u9fff]/.test(value)) return value.length > 8 ? value.slice(0, 8) : value;
  const words = value.split(/\s+/);
  let out = '';
  for (const word of words) {
    if ((out + ' ' + word).trim().length > 12) break;
    out = (out + ' ' + word).trim();
  }
  return out || value.slice(0, 12);
}

function mimeFor(url) {
  if (/\.svg$/i.test(url)) return 'image/svg+xml';
  if (/\.webp$/i.test(url)) return 'image/webp';
  if (/\.jpe?g$/i.test(url)) return 'image/jpeg';
  return 'image/png';
}

function normalizeBase(basePath) {
  const value = String(basePath ?? '').trim();
  if (!value || value === '/') return '';
  return '/' + value.replace(/^\/+|\/+$/g, '');
}

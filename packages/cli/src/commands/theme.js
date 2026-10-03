import fs from 'node:fs/promises';
import path from 'node:path';
import { listAvailableThemes, logger } from '@emeeek/core';

/**
 * `emeeek theme` —— 主题的查看、切换与脚手架（P3-1b-3b feature E）。
 *
 * 子命令：
 *   list                      列出可用主题（项目内 themes/ + 内置）
 *   switch <name> [--dark]    把 emeeek.config.js 的 theme.name 改掉
 *   preview <name>            构建并起预览服务器（等价于切到该主题跑 dev）
 *   create <name>             从模板生成一套自定义主题骨架
 *
 * `switch` 改的是配置文件而不是「记住一个状态」—— 构建结果由配置决定，
 * 让配置成为唯一事实来源，用户下次自己跑 build 得到的是同一个站。
 */

export async function themeCommand({ cwd, positionals, flags }) {
  const root = path.resolve(cwd);
  const [sub, ...rest] = positionals;

  switch (sub) {
    case 'list': return list(root, flags);
    case 'switch': return switchTheme(root, rest[0], flags);
    case 'preview': return preview(root, rest[0], flags);
    case 'create': return create(root, rest[0], flags);
    case undefined:
      logger.raw(THEME_HELP);
      return;
    default:
      logger.error(`未知子命令：theme ${sub}`);
      logger.raw(`\n${THEME_HELP}`);
      process.exitCode = 1;
  }
}

const THEME_HELP = `
用法: emeeek theme <子命令> [选项]

子命令:
  list                      列出可用主题
  switch <name>             切换主题（写入 emeeek.config.js）
  preview <name>            切换并启动预览服务器
  create <name>             生成自定义主题骨架

选项:
  --dark    切换时同时把 darkMode 设为 dark
  --force   create 时覆盖已存在的目录
  --port N  preview 的端口（默认 3000）
`;

async function list(root, flags) {
  const themes = await listAvailableThemes(root);
  if (flags.json) {
    logger.raw(JSON.stringify(themes.map((t) => ({ name: t.name, version: t.meta.version ?? null, description: t.meta.description ?? '', dir: path.relative(root, t.dir) })), null, 2));
    return;
  }
  const current = await readCurrentTheme(root);
  logger.step(`${themes.length} 套可用主题\n`);
  for (const theme of themes) {
    const mark = theme.name === current ? '●' : '○';
    const version = theme.meta.version ? ` v${theme.meta.version}` : '';
    logger.raw(`  ${mark} ${theme.name}${version}`);
    if (theme.meta.description) logger.dim(`      ${theme.meta.description}`);
    logger.dim(`      ${path.relative(root, theme.dir) || '.'}`);
  }
  if (current) logger.raw(`\n  当前主题：${current}`);
}

async function switchTheme(root, name, flags) {
  if (!name) {
    logger.error('用法：emeeek theme switch <name>');
    process.exitCode = 1;
    return;
  }
  await assertKnownTheme(root, name);
  const file = await configFile(root);
  const original = await fs.readFile(file, 'utf8');
  const patched = rewriteTheme(original, { name, darkMode: flags.dark ? 'dark' : undefined });
  if (patched === null) {
    logger.error(`在 ${path.relative(root, file)} 里找不到 theme 段，无法自动切换。`);
    logger.dim('  请手动把 theme.name 改成 ' + name);
    process.exitCode = 1;
    return;
  }
  await fs.writeFile(file, patched, 'utf8');
  logger.success(`已切换到主题「${name}」${flags.dark ? '（强制暗色）' : ''}`);
  logger.dim(`  写入 ${path.relative(root, file)}`);
}

async function preview(root, name, flags) {
  if (name) await switchTheme(root, name, flags);
  const { dev } = await import('./dev.js');
  return dev({ cwd: root, flags: { ...flags, port: flags.port ?? 3000 } });
}

async function create(root, name, flags) {
  if (!name) {
    logger.error('用法：emeeek theme create <name>');
    process.exitCode = 1;
    return;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    logger.error('主题名只能是小写字母、数字与连字符，且以字母开头。');
    process.exitCode = 1;
    return;
  }
  const target = path.join(root, 'themes', name);
  if (!flags.force && await exists(target)) {
    logger.error(`${path.relative(root, target)} 已存在。加 --force 覆盖。`);
    process.exitCode = 1;
    return;
  }
  for (const [rel, content] of Object.entries(TEMPLATE(name))) {
    const file = path.join(target, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
  }
  logger.success(`已生成主题骨架：${path.relative(root, target)}`);
  logger.dim(`  下一步：把 emeeek.config.js 的 theme.name 改成 '${name}'，再跑 emeeek dev`);
  logger.dim('  规范与注意事项见 docs/themes.md');
}

/** 从模板生成一套最小可用主题：index 布局 + head partial + 一点 CSS。 */
function TEMPLATE(name) {
  return {
    'theme.json': JSON.stringify({
      $schema: 'https://emeeek.dev/schema/theme.json',
      name,
      version: '0.1.0',
      author: 'You',
      description: `${name} 主题`,
      entryLayout: 'index',
      layouts: ['index', 'post'],
      features: ['dark-mode', 'light-mode'],
      config: {
        colors: {
          primary: { type: 'color', default: '#111111', label: '标题色' },
          accent: { type: 'color', default: '#2563eb', label: '强调色' },
          background: { type: 'color', default: '#ffffff', label: '背景色' },
          text: { type: 'color', default: '#1f2937', label: '正文色' },
          muted: { type: 'color', default: '#6b7280', label: '次要色' },
        },
        typography: {
          bodyFont: { type: 'font', default: 'system-ui, sans-serif', label: '正文字体' },
          fontSize: { type: 'number', default: 16, min: 12, max: 24, label: '正文字号' },
          lineHeight: { type: 'number', default: 1.75, min: 1.2, max: 2.2, label: '行高' },
        },
        layout: {
          maxWidth: { type: 'number', default: 736, min: 600, max: 1200, label: '内容最大宽度' },
        },
        features: {
          darkMode: { type: 'select', options: ['auto', 'light', 'dark', 'toggle'], default: 'auto', label: '明暗模式' },
        },
      },
    }, null, 2) + '\n',
    'partials/head.html': `<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
<script>{{{ noFlashScript }}}</script>
{{{ themeHeadExtra }}}
{{{ headMeta }}}
`,
    'partials/header.html': `<header class="site-header">
    <a class="brand" href="/">{{ site.title }}</a>
    <nav class="site-nav">
        {% for item in nav %}<a href="{{ item.url }}">{{ item.label }}</a>{% endfor %}
        <button class="icon-button" id="theme-toggle" type="button" aria-label="切换明暗">◐</button>
    </nav>
</header>
`,
    'partials/footer.html': `<footer class="site-footer">
    <p>© {{ year }} {{ site.author }}</p>
    {{{ themeFooterExtra }}}
{{{ themeSwitcherStyle }}}
{{{ themeSwitcher }}}
</footer>
{% if themeJS %}<script>{{{ themeJS }}}</script>{% endif %}
{{{ themeSwitcherScript }}}
`,
    'partials/card.html': `<article class="card">
    <a class="card-link" href="{{ post.url }}">
        <h2 class="card-title">{{ post.title }}</h2>
        {% if post.description %}<p class="card-excerpt">{{ post.description }}</p>{% endif %}
    </a>
</article>
`,
    'layouts/index.html': `<!DOCTYPE html>
<html lang="{{ site.language }}" data-theme="{{ config.theme.darkMode }}" data-theme-mode="{{ config.theme.darkMode }}" {{ themeFeatureAttrs }}>
<head>{% include "head" %}</head>
<body class="layout-index">
    {% include "header" %}
    <main class="site-main">
        <h1>{{ site.title }}</h1>
        <div class="post-list">
            {% for post in posts %}{% include "card" %}{% endfor %}
        </div>
    </main>
    {% include "footer" %}
</body>
</html>
`,
    'layouts/post.html': `<!DOCTYPE html>
<html lang="{{ post.lang || site.language }}" data-theme="{{ config.theme.darkMode }}" data-theme-mode="{{ config.theme.darkMode }}" {{ themeFeatureAttrs }}>
<head>{% include "head" %}</head>
<body class="layout-post">
    {% include "header" %}
    <main class="site-main">
        <article class="post">
            <h1 class="post-title">{{ post.title }}</h1>
            <div class="prose">{{{ post.html }}}</div>
        </article>
    </main>
    {% include "footer" %}
</body>
</html>
`,
    'styles/main.css': `/* ${name} —— 变量优先：主题 CSS 只消费变量，不消费字面量。
   config 项的 default 必须与下面 :root 的值逐字一致（见 docs/themes.md）。 */
:root {
  --primary: #111111;
  --accent: #2563eb;
  --bg: #ffffff;
  --text: #1f2937;
  --text-dim: #6b7280;
  --border: #e5e7eb;
  --max-width: 736px;
}
html[data-theme="dark"] {
  --primary: #f9fafb;
  --bg: #0f1115;
  --text: #d1d5db;
}
body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; }
.site-main { max-width: var(--max-width); margin: 0 auto; padding: 2.5rem 1.25rem; }
.post-list { display: block; }
.card { padding: 1.25rem 0; border-bottom: 1px solid var(--border); }
.card-link { color: inherit; text-decoration: none; }
`,
    'assets/favicon.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="24" font-size="24">◆</text></svg>
`,
  };
}

async function assertKnownTheme(root, name) {
  const themes = await listAvailableThemes(root);
  if (!themes.some((t) => t.name === name)) {
    logger.error(`找不到主题「${name}」。可用：${themes.map((t) => t.name).join(' / ')}`);
    process.exitCode = 1;
    throw new Error(`unknown theme: ${name}`);
  }
}

/** 找到 emeeek.config.js；没有时给出明确提示（不替用户凭空创建）。 */
async function configFile(root) {
  for (const name of ['emeeek.config.js', 'emeeek.config.mjs']) {
    const file = path.join(root, name);
    if (await exists(file)) return file;
  }
  logger.error('找不到 emeeek.config.js。先跑 `emeeek init`，或手动创建。');
  throw new Error('no config file');
}

/** 读出当前主题名，用于 list 里标 ●。读不到就返回 null。 */
async function readCurrentTheme(root) {
  try {
    const { loadConfig } = await import('@emeeek/core');
    const { config } = await loadConfig(root);
    return config.theme?.name ?? 'minimal';
  } catch {
    return null;
  }
}

/**
 * 改写配置里的 theme 段。
 *
 * 用正则替换而不是解析再序列化：配置文件是 JS 模块（可以有注释、表达式），
 * 序列化会丢掉它们。这里只动 `name:` 与 `darkMode:` 两个标量，其余原样保留。
 * 找不到 theme 段时返回 null，由调用方提示用户手动改 —— 不做「猜着改」。
 */
export function rewriteTheme(source, { name, darkMode }) {
  const themeRe = /theme\s*:\s*\{[\s\S]*?\}/;
  const block = themeRe.exec(source);
  if (!block) return null;
  let body = block[0];
  if (/name\s*:/.test(body)) body = body.replace(/name\s*:\s*(['"])[^'"]*\1/, `name: '${name}'`);
  else body = body.replace(/theme\s*:\s*\{/, `theme: { name: '${name}',`);
  if (darkMode && /darkMode\s*:/.test(body)) body = body.replace(/darkMode\s*:\s*(['"])[^'"]*\1/, `darkMode: '${darkMode}'`);
  return source.replace(themeRe, body);
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

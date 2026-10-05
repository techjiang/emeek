import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadConfig,
  loadTheme,
  loadPosts,
  logger,
  validateCdnConfig,
  checkIcp,
  loadCredentials,
  validateAnalyticsConfig,
  listScriptOrigins,
} from '@emeeek/core';

/**
 * 自检。目标是把「构建时才发现的错误」提前到一条命令里，
 * 每条检查都给出可执行的修复建议，而不是只说哪里不对。
 */
export async function doctor({ cwd, flags }) {
  const root = path.resolve(cwd);
  const results = [];
  const check = (name, ok, detail, hint) => {
    results.push({ name, ok, detail, hint });
    return ok;
  };

  logger.step(`诊断 ${root}\n`);

  // 1. Node 版本
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('Node 版本', nodeMajor >= 18, `v${process.versions.node}`, '升级到 Node 18 或更高版本');

  // 2. 配置文件
  let config = null;
  let configPath = null;
  try {
    const loaded = await loadConfig(root);
    config = loaded.config;
    configPath = loaded.configPath;
    check('配置文件', true, configPath ? path.relative(root, configPath) : '未找到，使用内置默认值', null);
    if (loaded.warnings.length) {
      for (const w of loaded.warnings) check(`配置警告 ${w.path}`, false, w.message, null);
    }
  } catch (error) {
    check('配置文件', false, error.message, '检查 emeeek.config.js 的语法与字段名');
  }

  // 3. 内容目录
  if (config) {
    const dirs = config.content.localDirs ?? ['posts'];
    for (const dir of dirs) {
      const abs = path.resolve(root, dir);
      const ok = await isDirectory(abs);
      check(`内容目录 ${dir}`, ok, ok ? abs : '不存在', `创建目录 ${dir}/ 并放入 .md 文件，或从 content.localDirs 中移除`);
    }

    // 4. 内容可读性
    try {
      const posts = await loadPosts(root, config);
      const drafts = posts.filter((p) => p.draft).length;
      check('内容解析', posts.length > 0, `共 ${posts.length} 篇（${drafts} 篇草稿）`, posts.length === 0 ? '还没有文章，运行 emeeek new "标题" 创建一篇' : null);
      const noDate = posts.filter((p) => !p.date).length;
      if (noDate) check('文章日期', false, `${noDate} 篇缺少日期`, '在 front-matter 加 date，或用 YYYY-MM-DD-title.md 命名文件');
    } catch (error) {
      // 只有纯 Issues 源才会因网络失败而中断，此时报错原因在远端而非 Markdown。
      check('内容解析', false, error.message, config.content.source === 'github-issues'
        ? '检查 content.repo、GITHUB_TOKEN 与网络连通性'
        : '检查 Markdown 文件的 front-matter 是否为合法 YAML');
    }

    // 5. GitHub Issues 连通性
    if (config.content.source !== 'local') {
      const repo = config.content.repo;
      if (!repo) {
        check('Issues 仓库', false, 'content.repo 未配置', "设置 content.repo = 'owner/repo'");
      } else {
        const token = process.env.GITHUB_TOKEN;
        try {
          const headers = { accept: 'application/vnd.github+json', 'user-agent': 'Emeek' };
          if (token) headers.authorization = `Bearer ${token}`;
          const response = await fetch(`https://api.github.com/repos/${repo}`, { headers });
          check('Issues 仓库连通', response.ok, `${repo} → HTTP ${response.status}`, response.status === 404 ? '确认仓库名拼写与访问权限' : response.status === 403 ? '设置 GITHUB_TOKEN 环境变量以避免限流' : null);
        } catch (error) {
          check('Issues 仓库连通', false, error.message, '检查网络或代理设置');
        }
        if (!token) check('GITHUB_TOKEN', false, '未设置', '未认证的 API 请求每小时仅 60 次，建议配置 Token');
      }
    }

    // 6. 主题。提到 try 之外，后面的分析自检要用它判断有没有 stats 布局。
    let theme = null;
    try {
      theme = await loadTheme(root, config);
      check('主题加载', true, `${theme.meta.name} v${theme.meta.version ?? '?'}（${theme.layouts.size} 个布局）`, null);
      const required = ['index', 'post'];
      const missing = required.filter((l) => !theme.layouts.has(l));
      if (missing.length) check('主题完整性', false, `缺少布局：${missing.join(', ')}`, `在主题 layouts/ 中补上这些文件`);
    } catch (error) {
      check('主题加载', false, error.message, '检查 theme.name 是否与 themes/ 下的目录名一致');
    }

    // 7. 输出目录可写
    const outDir = path.resolve(root, config.output?.dir ?? 'dist');
    try {
      await fs.mkdir(outDir, { recursive: true });
      await fs.access(outDir, fs.constants.W_OK);
      check('输出目录可写', true, path.relative(root, outDir), null);
    } catch (error) {
      check('输出目录可写', false, error.message, '检查目录权限');
    }

    // 8. site.url 与部署目标
    check('站点地址', config.site.url !== 'https://example.com', config.site.url, '改成真实域名，否则 sitemap 与 RSS 里的链接不可用');

    // 10. 全球加速。放在 doctor 而不是只在构建日志里，是因为这几项失败的表现是
    // 「能构建、能部署、但中国大陆打不开」——用户不会去翻构建日志找原因。
    await checkAcceleration(root, config, check);

    // 11. 分析。放在这里而不是只在构建日志里，理由是这一块的失败模式
    // 是「静默的」：配了 provider 却因为缺一个字段没注入，页面看起来完全正常。
    await checkAnalytics(root, config, check, theme);

    /**
     * 9. 插件：加载成功与被拒的各列一行。
     *
     * 被拒的插件必须在这里可见 —— 它们的表现是「装了但什么都没发生」，
     * 而那条日志埋在构建输出里通常会被几百行进度盖过去。
     */
    const { loadPlugins } = await import('@emeeek/core');
    const plugins = await loadPlugins(config, root, { logger: { info: () => {}, warn: () => {}, error: () => {} } });
    if (plugins.length) check('已加载插件', true, plugins.map((p) => `${p.name}（${[...p.capabilities ?? []].join(', ') || '无能力声明'}）`).join('、'), null);
    for (const rejected of plugins.rejected ?? []) {
      check(`插件 ${rejected.name}`, false, rejected.reason, '检查 manifest 的 capabilities，或把插件放到项目内');
    }
  }

  logger.raw('');
  const failed = results.filter((r) => !r.ok);
  for (const item of results) {
    if (item.ok) logger.success(`${item.name}：${item.detail}`);
    else {
      logger.error(`${item.name}：${item.detail}`);
      if (item.hint) logger.dim(`    → ${item.hint}`);
    }
  }

  logger.raw('');
  if (failed.length === 0) {
    logger.success('全部检查通过，可以运行 emeeek build');
  } else {
    logger.warn(`${failed.length} 项需要处理`);
    process.exitCode = 1;
  }
  return results;
}

/**
 * 加速自检。
 *
 * 放在 doctor 里而不是只在构建日志里，是因为这几项失败的表现是
 * 「站点能构建、能部署、但中国大陆打不开」——用户不会去翻构建日志。
 */
async function checkAcceleration(root, config, check) {
  const cdn = config.cdn ?? {};
  if (cdn.enabled === false) {
    check('全球加速', true, '已关闭（cdn.enabled = false）', null);
    return;
  }

  const fingerprint = cdn.fingerprint?.enabled !== false;
  const compression = cdn.compression?.enabled !== true ? cdn.compression?.enabled !== false : true;
  check('资源指纹', fingerprint, fingerprint ? '已开启（静态资源长期缓存可用）' : '已关闭，静态资源只能短缓存', '删除 cdn.fingerprint.enabled = false');

  const accelManifest = await readJson(path.join(root, config.output?.dir ?? 'dist', 'acceleration.json'));
  if (accelManifest?.compression) {
    const { count, gzipRatio, brotliRatio } = accelManifest.compression;
    check('预压缩产物', count > 0,
      `${count} 个文件（gzip 省 ${Math.round((1 - gzipRatio) * 100)}% / brotli 省 ${Math.round((1 - brotliRatio) * 100)}%）`,
      compression ? null : '重新构建以生成预压缩产物');
  } else if (compression) {
    check('预压缩产物', true, '尚未构建，构建时生成', null);
  }

  const { errors, warnings } = validateCdnConfig(cdn);
  for (const e of errors) check('CDN 配置', false, `${e.path}: ${e.message}`, '凭据必须走环境变量或 .emeek/credentials');
  for (const w of warnings) check('CDN 配置', true, w.message, null);

  if (!cdn.provider) {
    check('CDN 接入', true, '未配置（降级加速仍然生效）', '需要中国大陆秒开时运行 emeeek accelerate');
  } else {
    const { missing } = await loadCredentials(cdn.provider, { cwd: root });
    if (missing.length) {
      check('CDN 凭据', false, `缺少 ${missing.map((m) => m.env).join(' / ')}`, '用环境变量提供，或运行 emeeek accelerate 写入凭据文件');
    } else {
      check('CDN 凭据', true, '已就绪（来自环境变量或凭据文件）', null);
    }
  }

  const icp = checkIcp({ cdn, site: config.site });
  if (icp.enabled) {
    for (const blocker of icp.blockers) {
      check('中国大陆加速', false, blocker.message, '备案完成并配置大陆加速域名后再启用');
    }
    check('中国大陆加速', icp.blockers.length === 0, icp.blockers.length ? '前置条件未满足' : `已启用（${icp.icp.provider} · ${icp.icp.domain}）`, null);
  }

  const blocked = accelManifest?.blockedHosts ?? [];
  if (blocked.length) {
    check('国内可达性', false, `产物引用了 ${blocked.map((b) => b.host).join(' / ')}`,
      blocked[0].suggestion?.replaceWith ?? '替换为自有 CDN 或系统字体回退');
  } else if (accelManifest) {
    check('国内可达性', true, '无国内不可达的外部引用', null);
  }
}

/**
 * 分析自检。
 *
 * 三件事必须在这里被说清，因为它们都很容易被忽略：
 *   1. 数据到底会不会发出去（`origin` 为 null 就是站内，不发第三方）
 *   2. 开了 PV 但没有 endpoint（探针会构建失败，但那时已经在构建了）
 *   3. 用了 custom provider —— 它破坏「零第三方请求」承诺，必须显式警告
 */
async function checkAnalytics(root, config, check, theme) {
  const analytics = config.analytics ?? {};
  const statsPage = analytics.statsPage ?? {};

  if (analytics.enabled !== true) {
    check('分析', true, '未启用（产物里零统计脚本）', '需要时在 emeeek.config.js 打开 analytics.enabled');
  } else {
    const { errors, warnings } = validateAnalyticsConfig(analytics);
    for (const e of errors) check('分析配置', false, `${e.path}: ${e.message}`, '见 docs/analytics.md');
    for (const w of warnings) check('分析配置', true, w.message, null);

    if (!errors.length) {
      const provider = analytics.provider ?? 'builtin';
      const builtinPv = provider === 'builtin' && analytics.builtin?.trackPageViews === true;
      const origin = provider === 'plausible' ? 'plausible.io'
        : provider === 'goatcounter' ? 'gc.zgo.at'
          : builtinPv ? safeHost(analytics.builtin?.endpoint) : null;
      check('分析数据去向', true,
        origin ? `${provider} → ${origin}` : `${provider}（站内，不发往第三方）`,
        origin ? `CSP 需放行 ${origin}，见 docs/analytics.md 的 CSP 一节` : null);

      if (provider === 'custom') {
        check('自定义分析脚本', true,
          '已启用 —— 它会破坏「零第三方请求」承诺，请自行确认脚本内容',
          '脚本由你负责；Emeek 只保证 </script> 不会提前结束脚本块');
      }
      check('已知分析域名', true, listScriptOrigins().join(' / '), null);
    }
  }

  if (statsPage.enabled === true) {
    const hasStatsLayout = theme?.layouts?.has?.('stats') === true;
    check('统计页', hasStatsLayout,
      hasStatsLayout
        ? `${statsPage.path ?? '/stats/'}（零 JavaScript，纯 SVG 图表）`
        : `主题「${theme?.meta?.name ?? '?'}」没有 layouts/stats.html`,
      hasStatsLayout ? null : '换一个内置主题，或给主题补一个 stats 布局');
    if (statsPage.nav === false) check('统计页导航', true, '不在导航里显示（nav: false）', null);
  } else {
    check('统计页', true, '未启用', 'analytics.statsPage.enabled = true 可开启');
  }
}

/** 从 URL 取 host，取不到就返回 null（不抛）。 */
function safeHost(url) {
  try {
    return new URL(String(url)).hostname;
  } catch { return null; }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function isDirectory(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch { return false; }
}

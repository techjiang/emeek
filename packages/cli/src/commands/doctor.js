import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, loadTheme, loadPosts, logger } from '@emeeek/core';

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

    // 6. 主题
    try {
      const theme = await loadTheme(root, config);
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

async function isDirectory(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch { return false; }
}

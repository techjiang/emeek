import { logger, VERSION } from '@emeeek/core';
import { init } from './commands/init.js';
import { build } from './commands/build.js';
import { dev } from './commands/dev.js';
import { studio } from './commands/studio.js';
import { doctor } from './commands/doctor.js';
import { clean } from './commands/clean.js';
import { newPost } from './commands/new.js';
import { themeCommand } from './commands/theme.js';
import { deploy } from './commands/deploy.js';
import { drafts } from './commands/drafts.js';
import { accelerate } from './commands/accelerate.js';

const COMMANDS = {
  init: { run: init, desc: '初始化一个新项目' },
  build: { run: build, desc: '构建静态站点到 dist/' },
  dev: { run: dev, desc: '本地预览（含热重载）' },
  studio: { run: studio, desc: '打开 Emeek Studio 编辑器' },
  doctor: { run: doctor, desc: '诊断环境、配置与主题' },
  clean: { run: clean, desc: '清理构建产物' },
  new: { run: newPost, desc: '新建一篇文章' },
  theme: { run: themeCommand, desc: '查看 / 切换 / 创建主题' },
  deploy: { run: deploy, desc: '构建并部署到目标平台' },
  drafts: { run: drafts, desc: '列出草稿与定时发布的文章' },
  accelerate: { run: accelerate, desc: '全球加速：CDN 集成 / 资源指纹 / 缓存策略 / 刷新预热' },
};

const HELP = `
Emeek v${VERSION} —— 基于 Gmeek 理念的下一代知识站引擎

用法: emeeek <command> [options]

命令:
  init     初始化项目（生成 emeeek.config.js 与示例文章）
  build    构建静态站点
  dev      本地开发预览
  studio   打开 Emeek Studio 编辑器（写作 + 实时预览）
  new      新建文章
  theme    查看 / 切换 / 创建主题（list / switch / preview / create）
  deploy   构建 + 校验 + 部署到目标平台
  drafts   列出草稿与定时发布
  doctor   诊断配置与依赖
  clean    清理 dist/
  accelerate 全球加速（配置向导 / --test / --purge / --warm / --fanout）

选项:
  --cwd <dir>   指定项目目录（默认当前目录）
  -h, --help    显示帮助
  -v, --version 显示版本

deploy 选项:
  --target <平台>   github-pages / cloudflare / vercel / netlify / rsync / docker
  --preview         预览部署（不发布到生产）
  --dry-run         只生成配置与预演，不推送
  --no-build        跳过构建，直接用现有 dist/
  --no-verify       跳过部署后的在线验证
  --host --path     自托管（rsync）必填
  --url <地址>      验证时使用的地址（默认 site.url）

accelerate 选项:
  （无）            配置向导：选 CDN → 填凭据 → 写配置
  --test            实测加速效果（多区域 TTFB 对比）
  --purge           刷新 CDN 缓存
  --warm            预热 CDN
  --fanout          多源站推送规划（幂等）
  --plan            加速规划（字体子集分片 / 图片建议）
  --dry-run         只列出将刷新的 URL，不发请求

示例:
  emeeek init my-blog
  cd my-blog && emeeek dev
  emeeek studio --cwd my-blog     # 写作编辑器，预览与 build 逐字节一致
  emeeek theme list               # 列出可用主题
  emeeek theme switch magazine    # 切换主题（写入 emeeek.config.js）
  emeeek deploy --target vercel   # 构建 + 部署一条命令
  emeeek deploy --target rsync --host root@1.2.3.4 --path /var/www/blog

零配置即可运行：没有 emeeek.config.js 时使用内置默认值。
`;

export async function run(argv) {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals.shift();

  // 版本必须比帮助先判断：`emeeek --version` 没有位置参数，
  // 若先走「无命令 → 帮助」的分支，版本号就会被帮助文本盖掉。
  if (flags.version || flags.v || command === 'version') {
    logger.raw(VERSION);
    return;
  }
  if (flags.help || flags.h || command === 'help' || !command) {
    logger.raw(HELP);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    logger.error(`未知命令：${command}`);
    logger.raw(`\n可用命令：${Object.keys(COMMANDS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  await handler.run({ positionals, flags, cwd: flags.cwd ? String(flags.cwd) : process.cwd() });
}

/**
 * 解析 `--key value`、`--key=value`、`--flag` 与位置参数。
 *
 * 裸 `--flag` 后面若跟着一个不以 `-` 开头的 token，它会被当作该 flag 的值 ——
 * 这是为了 `--cwd /path` 能写。需要明确布尔语义时用 `--flag=true`，
 * 或把布尔 flag 放在位置参数之后。
 */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      flags[key] = flags[key] ? flags[key] : true;
      flags[key === 'h' ? 'help' : key === 'v' ? 'version' : key] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

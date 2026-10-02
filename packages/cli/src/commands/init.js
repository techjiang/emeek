import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@emeeek/core';

const TEMPLATES = {
  'emeeek.config.js': `// Emeek 配置 —— 所有项都有默认值，删掉任意一行都能跑
export default {
  site: {
    title: '我的知识宇宙',
    description: '用 Emeek 驱动的个人博客',
    url: 'https://example.com',
    author: '你的名字',
    language: 'zh-CN',
  },
  content: {
    // local = 读本地 Markdown；github-issues = 读 GitHub Issues；hybrid = 两者都读
    source: 'local',
    localDirs: ['posts'],
  },
  theme: {
    name: 'minimal',
    darkMode: 'auto', // auto | light | dark
  },
  // 想让 GitHub Issues 变成 CMS，把 content.source 改成 'github-issues'
  // 并填上 content.repo = 'owner/repo'，再给文章 Issue 打上 publish 标签。
};
`,

  'posts/hello-emeeek.md': `---
title: 你好，Emeek
date: ${new Date().toISOString().slice(0, 10)}
tags: [Emeek, 开始]
description: 第一篇文章，介绍这个站点是怎么构建起来的。
---

# 你好，Emeek

这个站点由 **Emeek** 构建 —— 一个用 Markdown 写文章、零成本部署的静态站点引擎。

## 为什么是 Emeek

它继承了三件事：

- 内容即 Markdown 文件（或 GitHub Issue）
- 构建即一条命令：\`emeeek build\`
- 部署即一片静态文件，没有服务器，没有数据库

## 快速上手

\`\`\`bash
emeeek dev     # 本地预览，改文件自动重建
emeeek build   # 产出 dist/，丢到任意静态托管即可
\`\`\`

## Markdown 支持什么

表格、任务列表、脚注[^1]、代码高亮、双向链接 \`[[文章标题]]\` 都在。

| 特性 | 状态 |
| ---- | :--: |
| 双向链接 | ✅ |
| 全文搜索 | ✅ |

- [x] 写第一篇文章
- [ ] 把它发布出去

[^1]: 脚注也会被正确渲染，并生成回跳链接。
`,

  'posts/writing-guide.md': `---
title: 写作指南
date: ${new Date().toISOString().slice(0, 10)}
tags: [指南]
---

# 写作指南

在 \`posts/\` 目录下新建 \`.md\` 文件即可。文件名会变成 URL：

\`\`\`
posts/writing-guide.md  →  /posts/writing-guide.html
\`\`\`

## front-matter 字段

\`\`\`yaml
---
title: 文章标题
date: 2024-01-01
tags: [标签一, 标签二]
description: 用于列表页摘要和 SEO 描述
draft: false        # true 则构建时跳过
pinned: false       # true 则置顶
lang: zh-CN         # 多语言站点用
---
\`\`\`

## 链接到其他文章

用 \`[[文章标题]]\` 或 \`[[文章标题|显示文字]]\`，Emeek 会在构建期解析成真实链接。
`,
};

export async function init({ positionals, cwd }) {
  const target = path.resolve(cwd, positionals[0] ?? '.');
  logger.step(`初始化项目：${target}`);

  await fs.mkdir(target, { recursive: true });
  let created = 0;

  for (const [file, content] of Object.entries(TEMPLATES)) {
    const full = path.join(target, file);
    if (await exists(full)) {
      logger.warn(`${file} 已存在，跳过`);
      continue;
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    logger.success(`创建 ${file}`);
    created += 1;
  }

  await fs.writeFile(path.join(target, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');

  logger.raw('');
  logger.success(`初始化完成，创建了 ${created} 个文件`);
  logger.raw('\n下一步：');
  if (positionals[0]) logger.raw(`  cd ${positionals[0]}`);
  logger.raw('  npx emeeek dev      # 本地预览');
  logger.raw('  npx emeeek build    # 构建到 dist/');
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

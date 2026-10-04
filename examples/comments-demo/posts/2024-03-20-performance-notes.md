---
title: 把首屏做到一次请求
date: 2024-03-20
tags: [Emeek, 性能]
description: 关键 CSS 内联、零外部字体、代码高亮在构建期完成 —— 这三件事让首屏只剩一次请求。
issue: 3
---

# 把首屏做到一次请求

性能不是优化出来的，是设计出来的。Emeek 的默认主题从第一天起就按「一次请求」来设计。

## 一次请求意味着什么

- 没有外部字体：用系统字体栈，零 FOIT/FOUT
- 没有 CSS 文件：样式表内联进 `<head>`
- 没有 JS 阻塞：交互脚本放在 `</body>` 前，且只在需要时初始化
- 高亮在构建期完成：浏览器不下载任何语法定义

## 代价是什么

内联 CSS 的代价是无法跨页面缓存。所以这里有一条阈值：

```javascript
// 主题 CSS 超过阈值就退回外链，避免首屏 HTML 膨胀
if (Buffer.byteLength(css) > 24 * 1024) {
  return html.replace('</head>', '<link rel="stylesheet" href="/assets/theme.css" />');
}
```

宁可损失一点缓存收益，也不让首屏 HTML 变成几百 KB。

## 下一步

图片的 WebP 重编码与响应式 `srcset` 需要原生依赖，
留给 Phase 4 处理 —— 现在只做懒加载和属性补全，不假装已经做了压缩。

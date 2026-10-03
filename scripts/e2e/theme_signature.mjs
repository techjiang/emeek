#!/usr/bin/env node
/**
 * 首页「版面结构」签名 —— e2e 判据的纯函数部分。
 *
 * 为什么单独一个模块、还进单测：
 *   e2e 的「4 套主题两两可辨」依赖它把渲染快照压成可比较的签名。
 *   如果这个函数写错（比如把列数永远算成 0），两套不同的主题会被判成相同，
 *   e2e 要么全红要么全绿，而它看起来“在比对”。这里把纯逻辑拎出来，
 *   用毫秒级的单测钉住，e2e 只负责“把真浏览器的结果喂进来”。
 *
 * 输入是 Playwright evaluate 出来的结构快照（见 theme.py 的 LAYOUT_PROBE）。
 */

/** 把 "928px 192px" 数成 2；"none" 数成 0。 */
export function countColumns(value) {
  const parts = String(value ?? '')
    .split(/\s+/)
    .filter((part) => part && part !== 'none');
  return parts.length;
}

/**
 * 结构快照 → 可比较的签名。
 * 每一项都是「布局维度」，任意两套主题至少一项不同即视为可辨。
 */
export function layout_signature(metrics = {}) {
  return {
    'main-display': metrics.mainDisplay ?? '',
    'main-columns': countColumns(metrics.mainCols),
    'main-flex': metrics.mainFlex ?? '',
    'main-children': metrics.mainChildCount ?? 0,
    'list-display': metrics.listDisplay ?? '',
    'list-columns': countColumns(metrics.listCols),
    'list-flex': metrics.listFlex ?? '',
    'lead-card': Boolean(metrics.hasLeadCard),
    hero: Boolean(metrics.hasHero),
    'section-number': Boolean(metrics.hasSectionNumber),
  };
}

/** 两个签名之间不同的维度名。 */
export function signatureDiff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]);
}

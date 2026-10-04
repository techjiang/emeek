---
title: Markdown 语法支持一览
date: 2024-02-03
tags: [Emeek, 指南]
description: 表格、任务列表、脚注、代码高亮、双向链接 —— 渲染器支持的全部语法。
---

# Markdown 语法支持一览

Emeek 的渲染器是自研的，零依赖，所以能力边界是明确的 —— 这里就是全部。

## 基础排版

**粗体**、*斜体*、***两者***、~~删除线~~、`行内代码`，以及 ==高亮==。

## 列表与任务

- 无序列表
- 嵌套的列表
  - 第二层
  - 还是第二层

1. 有序列表
2. 第二项

任务列表：

- [x] 已经完成的事
- [ ] 还没做的事

## 表格

表格支持对齐声明，小屏下会自动变成可横向滚动，不会撑破布局：

| 左对齐 | 居中 | 右对齐 |
| :----- | :--: | -----: |
| 内容 | 内容 | 123 |
| 更长的内容 | 短 | 4 |

## 代码高亮

内置一组通用 token 规则，覆盖主流语言：

```javascript
// 计算斐波那契数列
function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

const result = fib(10);
console.log(`结果：${result}`);
```

```python
def quicksort(items):
    if len(items) <= 1:
        return items
    pivot = items[len(items) // 2]
    left = [x for x in items if x < pivot]
    return quicksort(left) + [pivot]
```

## 引用与脚注

> 引用块会渲染成带左侧强调线的样式，适合放摘录或结论。
>
> 支持多段。

脚注同样支持[^design]，并且会生成回跳链接。

[^design]: 脚注定义放在正文任意位置即可，渲染时统一收集到底部。

## 链接与双向链接

普通链接：[Gmeek 的仓库](https://github.com/Meekdai/Gmeek)。

双向链接：`[[为什么我们还需要一个静态博客引擎]]` 会在构建期解析成真实链接 →
[[为什么我们还需要一个静态博客引擎|点这里看那篇文章]]。

如果目标文章不存在，它会渲染成一个带虚线标注的不可点击文本，并提示「未找到文章」——
而不是静默失败，或者自动创建一个空页面。

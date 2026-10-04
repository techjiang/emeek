# 长文导航

目录 / 锚点 / 阅读进度。三件事都由引擎算，主题只摆放。

---

## 一、目录只放一处

P3-3c 之前这里是**重复渲染**的：

```
post.tocHtml   ← Phase 1 的产物，塞在正文上方
post.toc     ← P3-1 加的侧边栏，从同一份数据又渲染了一份
```

结果是 3 套主题（minimal / aurora / inkstone）的长文页上**同一份目录
出现两次**，内容与锚点完全一样。看起来像设计，实际是两代代码叠在一起，
谁也没觉得该删掉旧的。这类重复不报错、不让测试变红，只是让页面多一块
没人想要的区域。

现在由 `buildReadingNav()` 决定**放一处**：

| `placement` | 什么时候 | 主题做什么 |
| --- | --- | --- |
| `sidebar` | 布局里有 `include "sidebar"` | 侧栏渲染目录，正文上方不重复 |
| `inline` | 布局里没有侧栏位置 | 正文上方渲染目录 |
| `none` | 章节少于 3 节 | 不渲染（连进度条也给） |

### 判据读的是布局源码，不是配置项

```js
hasSidebar: /include\s+["']sidebar["']/.test(postLayoutSource)
```

`theme.json` 里也有一个 `sidebar` 配置项，但它是**用户可覆盖的开关**。
用户关掉侧边栏时，那片空间仍然存在（只是空的）—— 目录不该因此
从侧栏跑到正文上方。布局源码才是「这片空间在不在」的事实。

### 章节少于 3 节不给目录

一篇文章只有 2 个 h2 时，目录比它索引的内容还占地方。
进度条用同一个阈值：一共一屏就看完的内容，顶部那条线从 0 走到 100%
只在一瞬间，它带来的是「页面在动」而不是「读到哪了」。

## 二、锚点

每个标题都有 `id`（由渲染器生成），并带一个复制按钮：

```html
<h2 id="摩擦在哪">摩擦在哪<a class="anchor" href="#摩擦在哪" aria-label="锚点链接">#</a></h2>
```

目录项与锚点**共用一个 id**。两个地方各算一次 id 必然会漂移，
而漂移的表现是「目录点下去没反应」—— 只有真去点的人能看到。

`buildToc` 走的是**已渲染的 HTML**，不是 Markdown 源，理由就是这个。

## 三、阅读进度

```html
<div class="reading-progress" aria-hidden="true"><span class="reading-bar" data-reading-bar></span></div>
```

`aria-hidden` 是必须的：进度条是**纯装饰**。屏幕阅读器读者需要的是
「文档还剩多少」这个信息，而一个内容一直在变、每次滚动都触发播报的
元素只会干扰。

脚本写入 `data-reading-ratio`（0~1），主题可以据此做任何事。

## 四、当前章节的高亮：这里踩过一个真实的坑

第一版用的是「窄带 IntersectionObserver」：

```js
{ rootMargin: '-10% 0px -70% 0px' }    // ❌
```

造出视口上方 10%~30% 的一条窄带，命中窄带的标题才算当前章节。
看起来合理，实测**完全不工作**：

```
视口 800px 时窄带只有 160px 高（y=80..240）
而相邻两个 h2 之间往往有 300~500px
→ 滚动时没有任何标题落进窄带
→ 目录高亮从头到尾一次都不亮
```

页面上看不出任何异常：没有报错、目录在、点击也能跳 —— 只是滚到哪都不亮。

**根因是把「当前章节」交给几何判定（它在不在某条带里），
而它本质上是顺序判定**：读者滚到 y 位置时所在的是「最后一个已经滚过
视口上沿的标题」那一节。

所以现在：Observer 只负责**什么时候重算**，判定用顺序遍历。

```js
var line = window.innerHeight * 0.3;   // 判定线
var found = null;
for (var i = 0; i < headings.length; i += 1) {
  if (headings[i].getBoundingClientRect().top <= line) found = headings[i].id;
  else break;   // 标题在文档里有序，第一个超出判定线的之后都不用了
}
```

判定线取视口 30%：一个标题刚出现在视口底部时，读者其实还在读上一节 ——
用它会让目录提前跳到下一节。

一个都没过线时（页面顶部）高亮**第一节**而不是不高亮：读者刚打开文章时
目录一项都不亮看起来像「目录坏了」，而此刻正确的答案就是「马上要看的就是它」。

## 五、三个只有真浏览器能发现的坑

`scripts/e2e/reading.mjs` 在 4 套主题上跑 40 项断言，抓到了这三个：

### 1. 脚本只认一种目录落位

```js
document.querySelectorAll('.toc-list a[data-heading]')   // ❌
```

而 4 套主题的默认落位是 `.sidebar-toc` —— 拿到空集直接 return。
页面上看不出异常（没报错、目录在、点击也能跳），只是滚到哪都不亮。

现在两个选择器都写：

```js
document.querySelectorAll('.toc-list a[data-heading], .sidebar-toc a[data-heading]')
```

### 2. 脚本在侧栏目录之前执行

`{% include "reading" %}` 摆在正文区域，而侧栏 TOC 在 HTML 里
**晚 10KB** 才出现。脚本直接跑，`querySelectorAll` 拿到空集。

所以脚本先判断 `document.readyState`：

```js
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
  return;
}
init();
```

用 readyState 判断而不是无条件挂事件 —— 脚本被放到页面靠后位置时
`DOMContentLoaded` 可能已经错过了，那时候挂监听器永远不会触发。

### 3. 模板字符串里的反引号

脚本是生成出来的模板字符串，我在注释里写了 `` `{% include "reading" %}` ``
—— 那个反引号把模板字符串**提前截断了**，产出的是一段残缺脚本。
构建不报错（模板字符串语法本身合法），页面上的表现是脚本整段不执行。

**生成脚本的模板字符串里不能出现反引号。** 单测里有一条专门断言这件事。

## 六、性能上的两个决定

**用 requestAnimationFrame 合帧**：滚动一秒能触发几十次事件，
每次都算布局会让主线程在长文页上肉眼可见地忙起来。

**高亮项自动滚进可视区**，但只在它确实在框外时才滚 ——
否则目录会在读者滚动时自己抖动。

## 七、验收

```bash
node scripts/e2e/reading.mjs         # 真浏览器：4 主题 × 10 项 = 40/40
node --test packages/core/tests/reading/   # 单测：落位决策 / 阈值 / 骨架 / 脚本
```

e2e 断言的四件事：

1. 每个目录项都指向**真实存在**的标题（`href` 与 `id` 是两处生成的）
2. 点击目录项真的会跳（滚动后目标进入视口）
3. 滚动时高亮的确实是「最后一个已滚过判定线的章节」
4. 进度条增长、滚到底接近 100%、不回退到负数

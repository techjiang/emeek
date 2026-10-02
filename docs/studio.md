# Emeek Studio 编辑器

用 `emeeek studio` 打开的 Markdown 编辑器。左边写，右边看，**右边看到的与 `emeeek build` 输出的是同一份 HTML**。

```bash
emeeek studio                    # 默认 http://localhost:3000/studio
emeeek studio --port 4000        # 换端口
emeeek studio --cwd my-blog      # 指定项目目录
```

## 一条不能破的线：预览 = 构建

编辑器预览和构建产物**必须渲染等价**。这不是「尽量一致」，是硬约束。

实现上只有一条路能做到 —— 两边调用同一个渲染函数：

```
emeeek build  →  @emeeek/core/render 的 renderArticle()
编辑器预览     →  @emeeek/core/render 的 renderArticle()
```

编辑器里**不存在**第二份 Markdown 解析器。测试里有一条专门盯着这件事：
扫 `packages/editor/src` 下所有文件，出现自建渲染器的特征就报错。

「渲染等价」的比较方式：两边用同一份 HTML 解析规则得到结构化树，再比规范序列化。
这样比的是**看到的东西**，而不是序列化方言：

| 忽略（不承载渲染结果） | 不忽略（测试真正在守的） |
| --- | --- |
| 属性书写顺序 | 标签名与嵌套层级 |
| `<img />` vs `<img>` | 任何属性的存在与取值 |
| 标签名大小写 | `<pre>` 内部空白 |
| `&apos;` vs `'` | 标题锚点、图片懒加载、代码高亮 |
| 元素间连续空白 | |

一致性测试覆盖 11 个 fixture + 7 篇仓库真实文档 + examples 里的示例文章。
运行：

```bash
node --test packages/editor/tests/consistency.test.js
```

## 编辑器能力

| 能力 | 说明 |
| --- | --- |
| CodeMirror 6 | 可编程扩展装配，主题/换行/只读都是 Compartment 热切换，不重建视图 |
| 双栏预览 | 防抖 200ms，内容未变时命中缓存（0.2ms） |
| 代码块高亮 | 37 种语言，语法包**按需加载**（见下） |
| 目录导航 | 语法树抽标题（代码块里的 `#` 不算），点击跳转，光标联动高亮 |
| 自动补全 | `[[` 文章链接 / <code>```</code> 语言 / `![` 图片路径 / 行首模板 |
| 工具栏 | 14 个格式按钮，与快捷键走同一批命令对象 |
| 图片拖拽粘贴 | 有上传接口就上传，没有就用本地预览并**明确标记未上传** |
| 主题 | One Dark / GitHub Light / Dracula / One Light |
| 草稿 | localStorage 自动保存，`Ctrl+S` 立即保存 |

## 快捷键

按 `F1` 在编辑器里看全表。常用：

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+U` | 加粗 / 斜体 / 下划线 |
| `Ctrl+K` / `Ctrl+Shift+I` | 链接 / 图片 |
| `Ctrl+Shift+C` / `M` / `T` | 代码块 / 公式 / 表格 |
| `Ctrl+Shift+1` / `2` / `3` | H1 / H2 / H3 |
| `Ctrl+S` | 保存草稿 |
| `Ctrl+Shift+P` | 切换预览模式 |
| `Ctrl+Shift+B` | 切换暗色/亮色 |
| `Alt+↑` / `Alt+↓` | 上下移动段落 |
| `Ctrl+F` / `H` / `G` | 查找 / 替换 / 跳转到行 |

macOS 上 `Mod` 是 `Cmd`。

## 语言高亮：37 种，按需加载

语言清单是**显式**的，每一项用真正的 `import()`：

```
Web      JavaScript TypeScript HTML CSS
后端     Python Java Go Rust PHP Ruby C C++ C# Swift Kotlin Scala Dart Perl Lua R Erlang
数据     JSON YAML TOML SQL
标记     Markdown LaTeX XML
Shell    Shell PowerShell Dockerfile Nginx
其它     CMake Diff Properties
```

**没有** Svelte / GraphQL / Elixir / Vue SFC：`@codemirror` 生态没有对应语法包，
硬列上去就是「列了没实现」。它们按纯文本渲染，补全面板会明确告知
「无语法支持」。清单里每一种语言都有测试真的加载一次。

### 为什么不用 `@codemirror/language-data`

它注册了 143 种语言，看起来是免费的懒加载。**实测不是**：它的 `load()` 是
`Promise.resolve().then(() => init_distN())` 的形式，打包器无法把它拆成异步块，
于是 143 个语法解析器全被打进入口 bundle —— **2.9MB 全在首屏**。

换成显式清单 + 真动态 import 之后：

| | 入口 | 按需 chunk |
| --- | --- | --- |
| `language-data` | 2.9MB | 0（全在入口） |
| 显式清单 | **276KB** | 38 个，共 1.7MB |

CI 里有体积门禁（`pnpm check:studio-bundle`），超过 600KB 直接失败。

## 增量渲染：为什么这里只有「结果缓存」

你可能会疑惑预览面板上显示的「复用 N 块」为什么大多是 0。原因是**分块渲染做不到正确**。

试过三种切分策略，每一种都在真实样例上翻车：

| 策略 | 翻车方式 |
| --- | --- |
| 按空行切 | 引用块裂成 4 个 `<blockquote>`；列表的缩进续行掉到列表外 |
| 按顶层块切 | 相邻任务项被切成 3 个 `<ul>`；`## 标题` 去重计数归零（`标题-2` 消失） |
| 按顶层块 + 续行判定 | 脚注 id 前缀按块内容算，与整篇渲染不同 |

根因是渲染器**带有跨块状态**：标题锚点去重计数、脚注 id 指纹、相邻列表项合并、
脚注定义收集。不做状态传递就不可能正确，而状态传递要把 core 的渲染器改成
有状态对象 —— 那会毁掉「`renderMarkdown` 是纯函数」这条更重要的性质。

所以现在的实现是：

```
内容没变（指纹相同）→ 直接复用上次 HTML（0.2ms）
内容有变             → 整篇渲染（永远正确）
```

`reused` 表示「整篇结果与上次相同」，省的是 **DOM 更新与 iframe 重排**，
而不是 CPU。大文档打字的手感靠 **200ms 防抖**保证，不靠分块。

如果将来真要做到部分重渲染，正确路径是给 core 渲染器加一个可传入/可导出的
`state`（headingSeq / footnotes / docId），而不是在块边界上猜。

## 性能（实测）

复现：`pnpm benchmark:preview`

| 场景 | p50 | 目标 | 状态 |
| --- | --- | --- | --- |
| 打开 10KB 文档 | 2.9ms | < 500ms | ✅ |
| 打字后重渲染（10KB） | 2.7ms | < 200ms | ✅ |
| 预览整篇渲染（10KB） | 2.3ms | < 200ms | ✅ |
| 大文件整篇渲染（100KB） | 30.6ms | < 500ms | ✅ |
| 大文件打字后重渲染（100KB） | 26.0ms | < 200ms | ✅ |
| 内容未变（命中缓存） | 0.2ms | < 1ms | ✅ |

渲染复杂度是线性的（实测 ~0.25 µs/字符）。100KB 文档 26ms > 60fps 的 16ms 预算，
但编辑器有 200ms 防抖，所以用户感知不到延迟。

## 词表：408KB，惰性加载

中文分词需要一份 408KB 的词表。它**不进首屏**：

- `studio.html` 里没有任何对词表的引用
- 只有点了「快速摘要 / 关键词提取」才会请求 `/__studio/dict/zh-words.txt.gz`
- 浏览器用 `DecompressionStream('gzip')` 解压（原生，零依赖）
- 解压后的字节交给 `@emeeek/core` 的分词器 —— 分词逻辑只有一份

## AI 面板

本期只有框架 + **只读的本地分析**（摘要 / 关键词 / 可读性 / SEO）。

续写 / 改写 / 扩写 / 精简需要模型能力，本地没有替代。
没配 API Key 时点下去会明确告诉你缺什么：

> AI 写作辅助需要配置 API Key
> 当前仅支持本地分析功能（摘要 / 关键词 / 可读性 / SEO）。

**不返回任何猜测的续写，也不降级成「从原文抽几句话拼一个结果」。**
在编辑流程里塞进不该出现的话，比什么都不做更糟。

## 结构

```
packages/editor/
  src/
    editor/          编辑器内核（可在任意页面嵌入）
      index.js       装配：扩展 Compartment、API
      commands.js    编辑命令（工具栏与快捷键共用）
      autocomplete.js 补全数据源
      languages.js   语言注册表（显式清单 + 真懒加载）
      outline.js     目录抽取与联动
      themes.js      4 套主题
      markdown-style.js  文档结构的语法样式
      stats.js       字数 / 阅读时长 / 行列
      drop-image.js  拖拽与粘贴
    preview/         预览层
      index.js       渲染入口（调用 core）+ 结果缓存
      dom.js         HTML 规范化（一致性测试用）
      strip.js       纯文本剥离
    studio/          Studio 应用
      server.js      HTTP 服务（页面/打包/词表/上传/站点索引）
      bundle.js      esbuild 打包（代码分割 + node: 桩）
      client.js      浏览器端装配
      welcome.js     首篇示例
    assets/          HTML / CSS
  tests/
    consistency.test.js  预览 ≡ 构建（生命线）
    preview.test.js      渲染、缓存、规范化
    editor.test.js       命令、目录、统计（无 DOM）
    dom.test.js          编辑器装配、主题（jsdom）
    autocomplete.test.js 补全数据源
    drop-image.test.js   图片上传与本地标记
    studio.test.js       服务端集成 + 打包
    bench/preview-bench.mjs  性能基准
```

## 嵌入到自己的页面

编辑器内核不依赖 Studio 服务端，可以单独用：

```js
import { createEmeekEditor } from '@emeeek/editor';

const editor = createEmeekEditor({
  doc: '# 标题',
  parent: document.getElementById('editor'),
  theme: 'one-dark',
  onChange: (text) => { preview.srcdoc = updatePreview(text); },
});
```

预览渲染也是独立导出：

```js
import { updatePreview } from '@emeeek/editor';
document.querySelector('#preview').innerHTML = updatePreview(markdown);
```

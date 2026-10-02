# 主题开发

主题是「数据 + 模板」，不是「可执行代码」—— 模板引擎没有任意 JS 执行能力，
这意味着第三方主题的风险面很小。

## 目录结构

```
my-theme/
├── theme.json           # 元数据（必需）
├── layouts/             # 页面模板
│   ├── index.html       # 首页（必需）
│   ├── post.html        # 文章页（必需）
│   ├── archive.html
│   ├── tags.html
│   ├── about.html
│   └── 404.html
├── partials/            # 可复用片段
│   ├── header.html
│   ├── footer.html
│   ├── card.html
│   ├── sidebar.html
│   ├── pagination.html
│   ├── related.html
│   └── comments.html
├── styles/*.css         # 全部内联进 <head>
├── scripts/*.js         # 全部内联到 </body> 前
└── assets/              # 原样拷贝到 dist/assets/
```

## theme.json

```json
{
  "name": "my-theme",
  "version": "1.0.0",
  "author": "You",
  "description": "一句话描述",
  "entryLayout": "index",
  "layouts": ["index", "post", "archive", "tags", "about", "404"]
}
```

`entryLayout` 是兜底布局：某个页面类型没有对应模板时用它渲染。

## 模板语法

三种标记：

| 语法 | 含义 |
| --- | --- |
| `{{ expr }}` | 输出并 HTML 转义 |
| `{{{ expr }}}` | 输出原始 HTML（正文、SEO 片段等） |
| `{% tag %}` | 流程控制 |

### 变量

变量从作用域解析：循环变量优先，其次页面数据。

```html
<h1>{{ site.title }}</h1>
<p>{{ post.description }}</p>
```

### 条件

```html
{% if post.pinned %}★{% endif %}
{% if pagination.total > 1 %}...{% else %}...{% endif %}
{% if a %}A{% else if b %}B{% else %}C{% endif %}
```

### 循环

```html
{% for post in posts %}
  <a href="{{ post.url }}">{{ post.title }}</a>
  <span>{{ loop.index }}</span>
{% endfor %}

{% for name, count in tagCounts %}{{ name }}: {{ count }}{% endfor %}
```

- 数组单变量形式：`{% for x in xs %}`，`x` 是元素
- 数组双变量形式：`{% for x, i in xs %}`，`x` 是元素、`i` 是下标
- 对象双变量形式：`{% for k, v in map %}`，`k` 是键、`v` 是值
- `loop.index` / `loop.first` / `loop.last` 在单变量形式下可用

### 引入片段

```html
{% include "header" %}

{% for post in posts %}{% include "card" %}{% endfor %}
```

`include` 会把当前循环作用域一并传进去，所以 `card.html` 里可以直接用 `post`。

## 页面数据

所有布局都能拿到：

| 变量 | 说明 |
| --- | --- |
| `site` | 站点信息（title / description / url / author / language） |
| `config` | 完整配置对象 |
| `nav` | 导航项 `[{ title, url }]` |
| `allTags` | 全部标签，按文章数降序 |
| `year` | 当前年份 |
| `tagUrl` | 标签名 → URL 的映射函数 |
| `headMeta` | 预生成的 `<title>` / meta / canonical 片段 |
| `searchIndexUrl` | 搜索索引地址，未启用搜索时为 `null` |
| `type` | 页面类型：`home` / `article` / `website` |

首页额外有 `posts`（文章卡片数组）、`pinned`、`pagination`。
文章页额外有 `post`（含 `html` / `toc` / `tocHtml` / `readingTime` / `wordCount` / `backlinks` / `tagLinks`）、`related`、`jsonLd`。

> `headMeta` 必须用 `{{{ headMeta }}}` 三花括号输出。

## 样式与脚本

`styles/` 下的 CSS 按文件名顺序拼接，内联进 `<head>`；
`scripts/` 下的 JS 拼接后内联到 `</body>` 前。没有打包步骤，也就没有构建配置。

```
styles/main.css     →  <style>…</style>
scripts/main.js     →  <script>…</script>
```

## 主题配置

`config.theme` 里的值在模板中通过 `config.theme.*` 访问：

```html
<html data-theme="{{ config.theme.darkMode }}">
```

## 本地调试

把主题放在项目里，用相对路径引用：

```javascript
theme: { name: './my-theme' }
```

或者放在 `themes/my-theme/`，直接用目录名：

```javascript
theme: { name: 'my-theme' }
```

配合 `emeeek dev`，改主题文件后页面自动刷新。

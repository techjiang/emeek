# 主题系统

主题是「数据 + 模板」，不是「可执行代码」—— 模板引擎没有任意 JS 执行能力，
主题配置也无法注入 `<script>`。这是 Phase 1 定下、S2-3b 加固、P3-1 继续维持的边界。

## 4 套内置主题

| 主题 | 设计语言 | 暗色为主 | 亮色 | 适用 |
| --- | --- | --- | --- | --- |
| **Aurora** | 极光渐变、毛玻璃、发光边框 | ✅ 独立设计 | 「极昼」变体 | 技术博客、开发者个人站 |
| **Minimal** | 极简黑白、排版为王、零装饰 | 灰阶（非纯黑） | 纯白 | 长文阅读、纯文字博客 |
| **Inkstone** | 水墨风、宣纸质感、印章 | 深褐墨底「夜读」 | 暖白宣纸 | 中文长文、文化博客 |
| Magazine | 杂志风、多栏网格、色带 | 待补 | 待补 | 生活博客、图文并茂 |

**「各有特色」不是换颜色。** 四套主题在排版密度、间距、装饰、字体、布局上都必须不同。
判据见 [`scripts/e2e/theme.mjs`](../scripts/e2e/theme.mjs)：同一页面下两套主题至少
两项计算样式不同（背景、圆角、字体、卡片宽度…）。

预览图：`packages/theme-<name>/preview.png`（暗色）与 `preview-light.png`（亮色）。

## 目录结构

```
my-theme/
├── theme.json           # 元数据 + 可配置项声明（必需）
├── preview.png          # 预览图 512x256（暗色）
├── preview-light.png    # 预览图 512x256（亮色）
├── layouts/             # 页面模板
│   ├── index.html       # 首页（必需）
│   ├── post.html
│   ├── archive.html
│   ├── tags.html
│   ├── about.html
│   └── 404.html
├── partials/            # 可复用片段
│   ├── head.html        # 承载首帧脚本与注入点
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

## theme.json —— 主题规范

`$schema` 指向 [`packages/core/schema/theme.json`](../packages/core/schema/theme.json)，
编辑器里能直接拿到补全与校验。

```json
{
  "$schema": "https://emeeek.dev/schema/theme.json",
  "name": "aurora",
  "version": "1.0.0",
  "author": "Emeek Team",
  "description": "极光渐变暗色科技感主题",
  "preview": "preview.png",
  "entryLayout": "index",
  "layouts": ["index", "post", "archive", "tags", "about", "404"],
  "features": ["dark-mode", "syntax-highlight", "math", "mermaid"],
  "compatible": ">=1.0.0",
  "config": {
    "colors": {
      "primary": { "type": "color", "default": "#8b5cf6", "label": "强调色" }
    },
    "typography": {
      "fontSize": { "type": "number", "default": 16, "min": 12, "max": 24, "label": "正文字号" }
    },
    "layout": {
      "maxWidth": { "type": "number", "default": 736, "min": 600, "max": 1200 }
    },
    "features": {
      "darkMode": { "type": "select", "options": ["auto", "light", "dark", "toggle"], "default": "auto" }
    }
  }
}
```

### 字段

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `name` | ✅ | 主题标识，小写字母数字与连字符 |
| `version` | | semver |
| `entryLayout` | | 兜底布局，默认 `index` |
| `layouts` | | 实现的页面布局清单。声明了就必须含 `index` |
| `features` | | 能力标记：`dark-mode` / `syntax-highlight` / `math` / `mermaid` / `toc` / `search` … 未知值只告警 |
| `compatible` | | 兼容的引擎版本范围 |
| `config` | | 可配置项声明，见下 |

### `config` —— 可配置项

四个固定分组：`colors` / `typography` / `layout` / `features`。每项是一个**描述符**：

| `type` | 必需字段 | 说明 |
| --- | --- | --- |
| `color` | `default`（`#RGB`/`#RRGGBB`/`#RRGGBBAA`） | 颜色 |
| `font` | `default`（字体串） | 字体族 |
| `number` | `default` + `min` + `max` | 数值，超范围自动夹紧 |
| `boolean` | `default` | 开关 |
| `select` | `default` + `options`（非空，default 必须在内） | 枚举 |
| `string` | `default` | 文本 |

**没有默认值的配置项等于不存在** —— 校验会报错。零配置原则要求每个可配置项都能自解释。

### ⚠️ 主题开发须知：config 默认值会覆盖 CSS 里的同名字面量

这是主题作者最容易踩的坑，两套主题各踩过一次（Inkstone 的 `muted`、
Magazine 的渐变端点）。机制本身没错，但触发是静默的：

```
theme.json 的每个 config 项都会生成一个 CSS 变量覆盖块
  → 该块排在主题 CSS **之后**（同权重 :root，后写生效）
  → 于是 CSS 里精挑的 --text-dim 会被 config.muted 的默认值悄悄盖回去
  → 改 CSS 不生效，且没有任何报错
```

**规则**：`theme.json` 里 config 项的 `default` 必须与 CSS 里的实际颜色**逐字一致**。

```jsonc
// theme.json
"muted": { "type": "color", "default": "#6f6a60" }
```
```css
/* styles/main.css —— 必须同为 #6f6a60，不能是别的「差不多的」灰 */
:root { --text-dim: #6f6a60; }
```

改动配色时**两处一起改**。四套内置主题都有「config 与 CSS 一致性」断言钉死这件事
（见 `packages/core/tests/theme/*.test.js`），新主题建议照抄这几条断言。

对照度也要一起盯：`muted` 这类浅色最容易掉到 AA（4.5:1）以下 ——
Inkstone 的 `#8a8a8a` 在暖白纸底上只有 3.04:1，Lighthouse a11y 直接掉到 95。

### 校验

加载主题时都会过一遍规范校验：

- **error** → 拒绝加载，错误信息带路径
- **warning** → 打印但不阻塞（未知 feature、非标准布局名、版本号不像 semver…）

模块：[`packages/core/src/theme/spec.js`](../packages/core/src/theme/spec.js)。

## 主题加载器

解析顺序（`packages/core/src/pipeline/render/theme.js`）：

```
显式路径（./my-theme、/abs/path）
  > <项目>/themes/<name>
  > <项目>/packages/theme-<name>
  > <仓库>/packages/theme-<name>   ← 内置主题
```

内置主题随 core 分发，所以「什么都不配」也能构建 —— 零配置原则的落点之一。

## CSS 变量体系

主题的**可配置性**与**明暗配色**是两个正交维度：

- 可配置项（用户改）→ `theme.json` 的 `config` → CSS 自定义属性
- 明暗配色（主题作者设计）→ 主题 CSS 里的两套字面值

### 变量映射

| config 分组 | 键 | CSS 变量 |
| --- | --- | --- |
| `colors` | `primary` | `--primary` |
| | `accent` | `--accent` |
| | `background` | `--bg` |
| | `surface` | `--bg-soft` |
| | `text` | `--text` |
| | `muted` | `--text-dim` |
| | `border` | `--border` |
| | `code` | `--bg-code` |
| `typography` | `headingFont` | `--font-heading` |
| | `bodyFont` | `--font-body` |
| | `codeFont` | `--font-mono` |
| | `fontSize` | `--font-size-base`（带 `px`） |
| | `lineHeight` | `--line-height-base`（无单位） |
| `layout` | `maxWidth` | `--max-width`（带 `px`） |
| | `sidebar` | `--show-sidebar`（`0`/`1`） |
| | `toc` | `--show-toc` |
| | `footer` | `--show-footer` |
| | `radius` / `gap` | `--radius` / `--section-gap` |

主题 CSS **只消费变量、不消费字面量** —— 这是「换主题只换变量」的落点。

### 写入时机

变量覆盖块由构建期生成，**排在主题 CSS 之后**：

```html
<style>/* 主题 CSS：内置默认配色 */</style>
<style>/* 变量覆盖：主题默认值 ← 用户覆盖值 */</style>
```

顺序不能反。两者选择器都是同权重的 `:root`，谁后写谁生效。
放前面会被主题 CSS 盖掉，于是「用户改了主色却不生效」。

模块：[`packages/core/src/theme/vars.js`](../packages/core/src/theme/vars.js)。

## 自定义配置

```javascript
// emeeek.config.js
export default {
  site: { title: '我的博客', url: 'https://example.com' },
  theme: {
    name: 'aurora',
    darkMode: 'auto',                    // auto | light | dark | toggle
    customCSS: '/assets/custom.css',     // 覆盖主题样式
    customHead: '<meta name="verify" content="…">',
    customFooter: '<span>备案号</span>',
    colors: { primary: '#ff6b6b', accent: '#4ecdc4' },   // 覆盖主题配置项
    typography: { fontSize: 18, headingFont: 'Inter' },
    layout: { maxWidth: 720, sidebar: false },
  },
};
```

### 优先级

```
用户自定义配置  >  选定主题的 theme.json config  >  内置默认值
```

> 引擎的 `defaultConfig()` **刻意不给颜色/字体默认值** —— 那会在合并时盖掉主题自己的
> 默认值（加载 aurora 却拿到 minimal 的黑白配色，且看不出是谁改的）。
> 颜色与字体的默认值只由主题提供。

### 安全边界（S2-3b 标准，不回退）

| 注入点 | 规则 |
| --- | --- |
| `customCSS` | 只进 `<style>`；`</style>` 序列被打散（这是唯一的样式上下文逃逸口）；`expression()` / `-moz-binding` 被中立化 |
| `customHead` | 白名单标签（`meta` / `link` / `style` / `title` / `noscript`）；`<script>` 连内容一起移除；`on*` 剥掉；`http-equiv=refresh` 的 URL 只允许 http(s)/相对路径 |
| `customFooter` | 白名单标签（无 `script`）；注入位置写死在 footer，**不做任意位置注入** |

「不允许通过主题配置注入 `<script>`」与 S2-3b 的 XSS 标准一致。
模块：[`packages/core/src/theme/inject.js`](../packages/core/src/theme/inject.js)。

### 覆盖链与校验

配置值沿四层合并，后者覆盖前者：

```
1. 主题 theme.json 的 config 默认值
2. emeeek.config.js 的 theme.colors / typography / layout / features
3. 运行时用户偏好（Studio 面板 / 页面 localStorage）
4. emeeek dev 热更新即时生效
```

第 2、3 层在加载主题时统一过 [`packages/core/src/theme/override.js`](../packages/core/src/theme/override.js)
校验：每一项都必须对得上主题声明的描述符（`type` / `min` / `max` / `options`）。

- 合法值被规范化接受
- 越界数字被**夹紧**到边界（不拒绝，但也不放行）
- 拼错的键、类型不符的值被**明确拒绝**并给出原因 —— 不静默丢弃

> 这条是 Inkstone 教训的延伸：`config 默认值 = CSS 实际颜色` 防的是「配置悄悄盖掉 CSS」；
> 覆盖链校验防的是「用户改了却不生效，且没人说为什么」。

### Studio 主题配置面板

`emeeek dev` 起 Studio 后，工具栏的「🎨」按钮打开面板：

- 控件类型完全由主题描述符决定（`color` → 取色器，`number` → 滑块，`boolean` → 开关，`select` → 下拉）
- 改一项 → 页面即时预览（写进预览 iframe 的 `:root` 变量块）
- 「恢复默认」清掉本机偏好
- 被拒的值当场列出原因，不静默失效

偏好存在浏览器 `localStorage`（键 `emeeek:theme-prefs`），**不进构建产物**。
面板依赖 Studio 服务端的 `/__studio/theme/config` 与 `/__studio/theme/override`
两个接口；没有服务端时面板不显示（不做「面板在但改不动」的假界面）。

### 运行时主题切换按钮（站点内）

站点可以挂一个右下角的切换浮层。默认**关闭**；在 `theme.switcher` 里开启：

```javascript
theme: {
  name: 'minimal',
  switcher: {
    enabled: true,
    position: 'bottom-right',        // 或 'bottom-left'
    darkToggle: true,                // 是否提供亮暗切换
    themes: [
      { name: 'minimal', label: '极简', url: '/' },
      { name: 'magazine', label: '杂志', url: '/magazine/' },
      { name: 'inkstone', label: '水墨' },   // 无 url → 灰态「仅此站」
    ],
  },
}
```

- 每项 `url` 必须是**真实存在**的另一套主题产物；没有 `url` 的主题标「仅此站」灰态，
  **不给点了没反应的死链接**
- 亮暗切换与站点既有的 `emeeek-theme` 契约共用（localStorage 持久化）
- 无 JS 时 `<noscript>` 隐藏整个浮层（不留死按钮）
- 主题名 / label / url 都过转义，配置里塞 `<script>` 不会变成注入

模块：[`packages/core/src/theme/switcher.js`](../packages/core/src/theme/switcher.js)。

## 暗色 / 亮色模式

### 策略

| `darkMode` | 行为 |
| --- | --- |
| `auto`（默认） | 跟随系统 `prefers-color-scheme`，系统变化时实时跟随 |
| `light` | 强制亮色，忽略系统与按钮 |
| `dark` | 强制暗色 |
| `toggle` | 同 `auto`，但页面提供切换按钮 |

### 属性契约

```html
<html data-theme="light|dark"        <!-- 实际生效的配色，样式只看这一个 -->
      data-theme-mode="auto|light|dark" <!-- 用户的策略选择 -->
      data-feature-math …>            <!-- 功能开关 -->
```

### 首帧无闪烁

一段同步内联脚本（`theme/inject.js` 的 `buildNoFlashScript`）放在 `<head>` 里、
**样式生效之前**决定 `data-theme`：

```js
(function(){try{var m=null;var d=m||localStorage.getItem('emeeek-theme')||'auto';
var dark=d==='dark'||(d!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);
var r=document.documentElement;r.setAttribute('data-theme',dark?'dark':'light');
r.setAttribute('data-theme-mode',d);}catch(e){}})();
```

要点：

- **同步**，不是 `DOMContentLoaded` —— 异步就会先渲染亮色再翻黑，闪一下
- **`try/catch`** —— 隐私模式下 `localStorage` 会抛，不能让页面白屏
- **`<head>` 第一个脚本** —— 早于任何样式表
- 主题 CSS 另有 `@media (prefers-color-scheme: dark)` 兜底：脚本未运行（禁用 JS）时仍跟随系统

### 每套主题两套配色独立设计

暗色不是「背景变黑、文字变白」。代码高亮、引用块、表格、卡片都要有暗色版本，
且暗色配色要单独选。例：Aurora 亮色用 `#f7f8fd` 带冷暖过渡的底，而非纯白。

## 模板语法

三种标记：

| 语法 | 含义 |
| --- | --- |
| `{{ expr }}` | 输出并 HTML 转义 |
| `{{{ expr }}}` | 输出原始 HTML（正文、SEO 片段、首帧脚本等） |
| `{% tag %}` | 流程控制 |

### 变量 / 条件 / 循环

```html
<h1>{{ site.title }}</h1>

{% if post.pinned %}★{% endif %}
{% if pagination.total > 1 %}…{% else %}…{% endif %}

{% for post in posts %}{{ post.title }}{% endfor %}
{% for name, count in tagCounts %}{{ name }}: {{ count }}{% endfor %}
```

- `{% for x in xs %}`：`x` 是元素
- `{% for x, i in xs %}`：`x` 元素、`i` 下标
- `{% for k, v in map %}`：`k` 键、`v` 值
- `loop.index` / `loop.first` / `loop.last` 可用

### include

```html
{% include "head" %}
{% for post in posts %}{% include "card" %}{% endfor %}
```

`include` 会带上当前作用域，所以 `card.html` 里能直接用 `post`。

## 页面数据

所有布局都能拿到：

| 变量 | 说明 |
| --- | --- |
| `site` | 站点信息 |
| `config` | 完整配置对象 |
| `nav` | 导航项 |
| `allTags` | 全部标签，按文章数降序 |
| `year` | 当前年份 |
| `headMeta` | 预生成的 `<title>` / meta / canonical 片段 |
| `searchIndexUrl` | 搜索索引地址，未启用时为 `null` |
| `themeFeatureAttrs` | 功能开关属性串 |
| `themeHeadExtra` | `customHead`（已消毒） |
| `themeFooterExtra` | `customFooter`（已消毒） |
| `noFlashScript` | 首帧脚本，**必须**用 `{{{ }}}` 包在 `<script>` 里 |

首页额外：`posts`、`pinned`、`pagination`。
文章页额外：`post`（含 `html` / `toc` / `tocHtml` / `readingTime` / `wordCount` / `backlinks` / `tagLinks`）、`related`、`jsonLd`。

### head partial 的标准写法

```html
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
<script>{{{ noFlashScript }}}</script>
{{{ themeHeadExtra }}}
{{{ headMeta }}}
```

## 样式与脚本

`styles/` 下的 CSS 按文件名顺序拼接，内联进 `<head>`；
`scripts/` 下的 JS 拼接后内联到 `</body>` 前。没有打包步骤，也就没有构建配置。

> **体量阈值**：CSS 超过 24KB 会自动退回外链 `/assets/theme.css`，避免首屏 HTML 膨胀。

## 本地调试

```javascript
theme: { name: './my-theme' }     // 相对路径
theme: { name: 'my-theme' }       // themes/my-theme/
theme: { name: 'aurora' }         // 内置
```

配合 `emeeek dev`，改主题文件后页面自动刷新。

## 工具与脚本

主题清单**动态扫 `packages/theme-*`**（见 `scripts/lib/themes.mjs`）——
新加一套主题，下面所有脚本自动带上它，不需要改脚本。

| 脚本 | 用途 |
| --- | --- |
| `node scripts/screenshots/capture.mjs [主题…]` | 每套主题 × 亮暗 × 桌面/移动 截图 → `docs/assets/themes/` |
| `node scripts/preview-images.mjs [主题…]` | 生成 `preview.png` / `preview-light.png`（512×256） |
| `node scripts/lighthouse-themes.mjs [主题…]` | 每套主题的 Lighthouse 门禁（≥90，桌面+移动） |
| `node scripts/e2e/theme.mjs [主题…]` | 主题系统 e2e（首帧无闪烁 / 切换 / 亮暗可辨 / 4 套两两布局可辨） |

只跑一套：`node scripts/screenshots/capture.mjs magazine`（或 `--theme magazine`）。
只跑一套截图时，`docs/assets/themes/manifest.json` 会**合并**新条目而不是覆盖 ——
单跑一套不会把其它主题的清单抹掉。

所有脚本打开产物一律走本地 HTTP 服务，**不用 `file://`**：
CSS 超过 24KB 的主题（Magazine）会把样式退回外链 `/assets/theme.css`，
而 `file://` 下 `/assets/...` 会指向文件系统根目录、样式 404 ——
截图会拍到没有样式的裸 HTML（亮暗两版还会逐字节相同）。

## CLI

```bash
emeeek theme list                     # 列出可用主题（项目内 themes/ + 内置），当前主题标 ●
emeeek theme list --json              # 机器可读
emeeek theme switch aurora            # 切换主题（写入 emeeek.config.js）
emeeek theme switch inkstone --dark   # 切换 + 强制暗色
emeeek theme preview magazine         # 切换并起预览服务器（等价于切到该主题跑 dev）
emeeek theme create my-theme          # 从模板生成一套自定义主题骨架
emeeek theme create my-theme --force  # 覆盖已存在的目录
```

`theme list` 与 `switch` 都按当前 `--cwd` 的项目解析：先看项目内 `themes/`，
再看内置。`switch` 只改 `theme.name`（和 `--dark` 时的 `darkMode`），
配置文件里的注释与其它字段原样保留 —— 它是 JS 模块，不做「解析再序列化」。

`theme create` 生成的骨架开箱即可构建（`layouts/index.html` + `layouts/post.html` +
标准 partials），`theme.json` 的 config 默认值与 `styles/main.css` 里的变量一致。

## 从零写一套主题

1. `mkdir -p packages/theme-mine/{layouts,partials,styles,scripts,assets}`
2. 写 `theme.json`（至少 `name` + `layouts: ["index"]`）
3. 从 `packages/theme-minimal/` 拷 `partials/head.html` 的骨架（首帧脚本 + 注入点）
4. 写 `layouts/*.html`，用 `{% include "head" %}` 统一 head
5. 写 `styles/main.css`：`:root` 放暗色默认值，`html[data-theme="light"]` 放亮色
   （改色前先读上面的「主题开发须知」—— config 与 CSS 必须同步）
6. `emeeek dev --cwd examples/themes-demo` 看效果（改配置里的 `theme.name`）
7. `node scripts/e2e/theme.mjs` + `node scripts/lighthouse-themes.mjs` 自检
8. `node scripts/screenshots/capture.mjs mytheme` 出图（8 张，亮暗 × 桌面/移动 × 首页/文章页）

## P3-1 交付清单

主题系统（P3-1）的完整交付。三层能力：

| 层 | 交付 | 位置 |
| --- | --- | --- |
| 规范与加载 | theme.json 规范 + 校验器 + 加载器 + 变量映射 | `packages/core/src/theme/`、`pipeline/render/theme.js` |
| 4 套内置主题 | Aurora / Minimal / Inkstone / Magazine，版面两两不同 | `packages/theme-*/` |
| 配置与工具 | 覆盖链 + Studio 面板 + `emeeek theme` CLI + 运行时切换 | `theme/override.js`、`cli/commands/theme.js`、`theme/switcher.js` |

验收基线（全部可复现）：

```
$ npm test
ℹ tests 866 / pass 866 / fail 0

$ node scripts/e2e/theme.mjs
 28/28 通过

$ node scripts/e2e/xss.mjs
 60/60 通过

$ bash scripts/e2e/negative-check.sh
 ── 25 条防线被守住，0 条没守住

$ node scripts/lighthouse-themes.mjs
 ✔ 全部 32 项 ≥ 90（32/32 全 100）

$ node scripts/check-studio-bundle.mjs
 入口 360KB（预算 600KB）✔
```

（e2e 合计 96 条：xss 60 + draft-mobile 13 + dev-integration 7 + ai-panel 16。）

### 三条不变量

1. **主题是数据 + 模板，不是可执行代码** —— 模板引擎无任意 JS 执行，配置注入位置写死。
2. **颜色/字体/布局的值只有一条来源** —— 主题 `theme.json` 的 config；引擎不提供默认颜色。
3. **「可见」必须可测** —— 4 套主题两两可辨由「计算样式 ≥5 项」与「版面结构 ≥1 项」两层断言守住。

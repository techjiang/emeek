# PWA（离线能力）

**默认关闭。** 打开它需要显式写 `pwa.enabled: true`。

这条默认值不是随手定的：Service Worker 是本仓库里唯一一个
**装上之后还会继续影响后续访问**的东西。页面上的 bug 刷新就没了；
SW 的 bug 会让读者看到昨天、甚至上周的页面，而且我们修了也没用 ——
他手上的那个 SW 还在用旧缓存。

「零配置即可运行」的代价不该是「零配置就给访客装一个 Service Worker」。

```javascript
// emeeek.config.js
export default {
  site: { title: '我的博客', url: 'https://example.com' },
  pwa: {
    enabled: true,
    themeColor: '#2563eb',
    icons: { 192: '/assets/icon-192.png', 512: '/assets/icon-512.png' },
    precachePosts: 5,
  },
};
```

产出的三样东西：

```
/manifest.webmanifest   应用身份（名称 / 图标 / start_url / display）
/sw.js                  离线缓存
/offline.html           断网回落页
```

---

## 一、缓存一定会被替换掉

这是这一层唯一真正难的地方。

Service Worker 的更新判定是**逐字节比较脚本内容**。如果脚本是一份固定文本：

```js
const CACHE = 'emeeek-v1';   // ← 永远不变
```

那么无论站点内容怎么改，浏览器都会认为「没有新版本」——
不会触发 install，不会删旧缓存。读者会一直看到第一次访问时的那个版本。
这是一个**只会往坏的方向走**的 bug：出问题的当下没人能察觉，
等到察觉时已经不知道有多少读者卡在哪个版本上了。

所以缓存名必须带**全部产物的内容指纹**：

```js
const CACHE = 'emeeek-74ba5e19';   // 内容变了它才变
```

指纹的计算输入是**站点全部产物**（页面 HTML、sitemap、feed、离线页、manifest），
不是构建时间。用构建时间的话，每次 CI 重建都会让所有访客的缓存作废 ——
内容一个字都没改，却让每个人重新下载一遍。

这类 bug 的表现只是「带宽涨了」，没有任何页面看起来不对。
所以 `check-perf.mjs` 会直接断言缓存名带指纹，
`scripts/e2e/perf-negative.sh` 里有一条削弱它会变红。

## 二、导航 network-first，静态资源 stale-while-revalidate

```js
// HTML 是「内容」，必须最新 —— 断网才回落缓存
if (request.mode === 'navigate') {
  fetch(request).catch(() => caches.match(request).then(hit => hit || caches.match(OFFLINE)));
  return;
}

// 静态资源地址带构建指纹，先用缓存立刻渲染，后台再更新
caches.match(request).then(hit => hit || fetch(request));
```

如果反过来（HTML 也 cache-first），Lighthouse 的分数会更好看 ——
因为页面秒开，没有网络往返。代价是读者**永远看不到新文章**，
而且我们没有任何办法纠正（他手上的 SW 不会自己更新）。

分数是手段，不是目的。这里选的是后者。

## 三、不做 `skipWaiting()` 自动接管

新 SW 安装完就立刻接管已打开的页面，会让页面上的 CSS/JS 突然换来源 ——
可能拿到「新 CSS + 旧 JS」这种不匹配的组合，表现是页面莫名其妙地错位。

所以新 SW 起来后**等所有标签页关掉**再接管。

慢，但不会让正在阅读的人看到半新半旧的页面。

代价要说清楚：读者「关掉标签页再打开」才会拿到新版本。
对一个博客来说这是可以接受的（内容不是实时数据），
对一个后台系统就不一定了 —— 这也是为什么它默认关。

## 四、预缓存不是「全站都拿过来」

`precachePosts` 默认 5。

预缓存发生在 install 阶段，也就是**首屏之后**。把全部页面塞进去，
等于每个首次访客在读完首屏之后，后台偷偷下载整个站点。
对流量敏感的场景（多页部署、按带宽计费）这是实打实的成本。

预缓存里放的是「断网时真的想看的」：首页 + 离线页 + manifest + 最近几篇。

`check-perf.mjs` 对条目数有上限（12），并在 `examples/pwa-demo`
（12 篇文章）上验证这条上限真的会触发 —— 在只有 3 篇的站点上，
「全站预缓存」与正确做法产出完全一样，检查是空转的。

## 五、离线页

离线页的唯一职责是「告诉读者发生了什么，并给出可行的下一步」。

只说「你离线了」是不够的：读者看到白屏的第一反应是「网站坏了」，
第二反应是反复刷新（每次都失败）。一个说清楚「你离线了、这几篇已经存好了、
联网后会恢复」的页面，把一次「网站坏了」变成一次「暂时没网」。

三条实现约束：

1. **样式内联，不引外部 CSS**。离线页必须在任何资源都没拿到的情况下
   也能正常显示 —— 引一份可能没被缓存的样式表，就会得到一个裸 HTML。
2. **必须进预缓存**。它自己也要靠网络拿的话，它就永远用不上。
   用 `addAll` 而不是逐个 `add`：任何一个失败就让整个 install 失败，
   好过「装上一个缺了离线页的 SW」（断网时表现成白屏）。
3. **`noindex`**。它是路牌，不是内容。

## 六、安装提示默认关

`installPrompt: false`。

一个「安装到桌面」的横幅在第一次访问就弹出来，是最常被抱怨的 Web 行为之一。
它对站点主人的价值（留存）与对读者的打扰不成比例。

打开它时也有节制：

- 只在读者**读过至少一篇文章**后才可能弹（localStorage 计数）
- 点过「以后再说」之后**永久**不再出现（不是 sessionStorage）
- 不由我们计时 —— 用浏览器给的 `beforeinstallprompt`，它本身就有节制

## 七、图标必须真的存在

manifest 里声明的每个图标，浏览器都会在**安装时**下载并校验。
缺一个就是「安装失败」，而失败信息在浏览器控制台里很不显眼 ——
表现成「PWA 功能好像没做」。

所以 `icons` 只写你确实生成了的档位。宁可不声明图标
（浏览器用默认图标，功能照常），也不声明一个不存在的：

```javascript
icons: { 192: '/assets/icon-192.png', 512: '/assets/icon-512.png' }
// 不要写 { 192: '/icon.png', 512: '/icon.png' } —— 尺寸对不上一样会被拒
```

`check-perf.mjs` 会逐个检查 manifest 里声明的图标是否真的在产物里。

## 八、验收

```bash
node scripts/check-perf.mjs --pwa      # PWA 专项自检（用 examples/pwa-demo）
bash scripts/e2e/perf-negative.sh      # 13 条性能防线逐条削弱，必须变红
node scripts/e2e/pwa.mjs               # 真浏览器：注册 / 离线 / 缓存更新
```

`examples/pwa-demo` 是专门为这些检查存在的示例站 ——
在没开 PWA 的站点上，整套 PWA 检查是空转的（只输出一句「未启用」），
永远绿。**开了 PWA 的站点单独一个示例，就是为了让这些检查有对象。**

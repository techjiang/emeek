# 关于 Emeek

## 这是什么

**Emeek**（Extra-ordinary Meek）是一个用 Markdown 写文章、一条命令构建、
零成本部署的知识站引擎。

它的前身是 [Gmeek](https://github.com/Meekdai/Gmeek)。Gmeek 的三根支柱
被原样继承 —— 因为这三条一条都不能删，删了就不是同一个东西了：

- **内容即 Issue 或 Markdown** —— GitHub 就是 CMS
- **构建即一条命令** —— `emeek build`
- **部署即一片静态文件** —— 没有服务器，没有数据库

Emeek 做的事是**把这三根支柱之外的整条链补齐**：

| 阶段 | Gmeek | Emeek |
| --- | --- | --- |
| 内容源 | GitHub Issues | Issues + 本地 Markdown + hybrid |
| 写作 | GitHub 网页 | 内置 Studio（CodeMirror 6 + 双栏预览） |
| 阅读 | 列表 + 详情 | 全文搜索 + 订阅 + 评论 + 长文导航 |
| 发现 | — | SEO 全量 + sitemap + JSON-LD + RSS/Atom |
| 性能 | — | 资源指纹 + 预压缩 + PWA + CDN 加速 |
| 部署 | GitHub Pages | 六平台 + CI/CD + 多源站故障转移 |
| 数据 | — | 默认零追踪 + 构建期推断 + 零 JS 统计页 |

## 设计哲学

**零依赖。** 不是营销词，是硬约束：不引入 DOMPurify、不引 QR 库、不引图表库。
每一项都窄到可以自己写准，引入一个库反而要面对它自己的配置面。代价是要自己写，
收益是产物里没有任何第三方代码 —— **零外部网络请求**。

**默认安全、默认不追踪。** `analytics.enabled` 默认 `false`，
此时产物里**不存在**任何统计 `<script>` —— 不是「加载了但不发」，是根本不生成。

**默认值都站「安全的那一侧」。** PWA 默认关（Service Worker 是唯一
「装上后还影响后续访问」的东西）；响应式图片默认关（没有候选集时生成 srcset 就是编造地址）；
`workflow.validate` 默认 `warn`（校验是新加的关，在用户调好内容前挡构建是越界，但问题必须被说出来）。

**判定只有一处。** 草稿/发布/定时由 `partitionPosts` 单点决定；
链接/图片/双向链接共用同一个 `sanitizeUrl`；路径守门收敛到一处 `resolveProjectFile`。

**默认拒绝。** URL 走白名单（`http/https/mailto/tel` + 相对路径），
被拒的退回纯文本而不是生成一个危险的标签。插件凭证访问**不在能力表里** ——
名字不存在，所以无法声明。**不靠审核，靠不存在。**

## 谁做的

**Emeek 由 科技酱 开发并维护。**

- GitHub：https://github.com/techjiang
- 项目仓库：https://github.com/techjiang/emeek
- 博客：https://techjiang.github.io
- 邮箱：techjiang@example.com

QQ 交流群见 [README 的作者与交流](../README.md#作者与交流)。

## 愿景

个人知识站不该需要一个运维团队。

「写文章」这件事的成本应该只在**写**上 —— 不该花在建站、配服务器、
选数据库、盯 uptime 上。Emeek 的答案是：把内容变成 Markdown，
把构建变成一条命令，把部署变成一片静态文件。

**发布不需要仪式感。** 开一个 Issue、打一个标签，剩下的引擎做。

## 版本

当前 **1.0.0**。变更记录见 [CHANGELOG](../CHANGELOG.md)。

## License

MIT —— 见 [LICENSE](../LICENSE)。

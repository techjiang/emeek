# 贡献指南

欢迎贡献。Emeek 的代码库有它自己的品味，先读这一页再动手，
能省掉一轮 review 往返。

## 开发环境

```bash
git clone https://github.com/techjiang/emeek.git
cd emeek
pnpm install
pnpm test              # 1739 个测试
```

仓库是 pnpm workspace：

```
packages/
  core/      引擎：内容管线 / 渲染 / 主题加载 / 搜索 / 插件 / 部署 / 加速
  cli/       命令行
  editor/    Emeek Studio（CodeMirror 6）
  theme-*/   4 套内置主题
```

## 两条核心约定

违反这两条，PR 不会被合。

### 1. 预览必须等于构建

**不允许存在第二份 Markdown 渲染器。** 编辑器预览与构建产物调的是同一个函数。
`packages/editor/tests/consistency.test.js` 逐节点比对，并且有一条测试**扫源码** ——
出现自建渲染器的特征就报错。

理由：两份渲染器必然分叉。用户看到预览和发布不一样，会归咎于「玄学」，
而实际是两份代码在漂移。

### 2. 判定只有一处

草稿 / 发布 / 定时三态由 `partitionPosts` **单点**决定。构建、`emeek drafts`、
校验读同一份。「命令说已发布」和「产物里有它」结构上不可能分叉。

新增类似判定时先问：**能不能复用已有的那个？** 重复实现就是留两份真相。

## 每个 Bug 修都要有负向验证

修一个 bug 只加「它会通过」的测试是不够的 —— 那不能证明防线存在。
必须加一条**削弱防线后变红**的验证，进 `scripts/e2e/negative-check.sh`：

```bash
# 削弱前的 diff 必须非空，否则说明 sed 没匹配上 —— 那这条负向验证本身就是假的
sed -i 's/正确实现/错误实现/' src/foo.js
diff <(git show HEAD:src/foo.js) src/foo.js || fail "削弱没生效"
node --test tests/foo.test.js && fail "削弱后测试仍然通过 —— 防线没守住"
git checkout src/foo.js
```

这套机制抓到过两次**假验证**：`sed` 表达式没匹配上，「削弱后仍然通过」
其实是**什么都没改**。

## 提交与 PR

提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(search): 支持拼音模糊匹配
fix(qr): 修正 v5+ 分块短块在前的排序
docs(themes): 补充主题变量清单
test(workflow): 草稿绝不进生产的全产物扫描
```

PR 描述里写清：

- **为什么**（不只是做了什么）
- 验证命令 + 实测输出
- 有没有破坏性变更

## 代码风格

- **注释写「为什么」，不写「是什么」** —— 代码本身说明了做什么
- 但**不写废话注释**。`// 递增计数器` 是噪音
- 中文注释（项目主语言），标识符英文
- 零运行时依赖是硬约束 —— 新增依赖要在 PR 里论证

## 测试门禁

PR 必须让这些全绿：

```bash
pnpm test                            # 1739 单元/集成
bash scripts/e2e/negative-check.sh   # 105 条负向验证
pnpm check:seo                       # SEO 自检
pnpm check:shortcuts                 # 快捷键声明审计
bash scripts/e2e/check-no-secrets.sh # 产物无凭据
```

## 文档

改功能就改文档。docs/ 下每篇都要有**可运行的代码示例** ——
只描述不举例的文档与没有文档差不多。

## 不做的事

有些 PR 方向是对的但和项目定位冲突，会被婉拒：

- **引入运行时依赖**（DOMPurify、QR 库、图表库…）—— 需求窄到可以自己写准
- **给分析服务提供默认第三方 SDK**
- **插件沙箱（VM/Worker）** —— 是另一个量级的工作
- **草稿云同步** —— 与「内容即 Issue」的定位冲突
- **分块增量渲染** —— 渲染器带跨块状态，正确路径是给 core 加可注入 `state`

详见 [CHANGELOG 的「不做的事」](../CHANGELOG.md)。

## 行为准则

技术讨论对事不对人。指出问题时说清**为什么**，并给出**怎么改**。
「这样不行」不是评审意见。

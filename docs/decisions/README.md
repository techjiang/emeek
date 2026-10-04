# 决策记录

每一份记录的都是**已经拍板、并且已经落地**的技术决策，包含：

- 决策本身与理由
- 为什么不是别的做法（被否掉的那些才是这份文档的价值）
- 验收方式与**负向证据**（削弱它 → 测试必须红）

| 编号 | 决策 | 落地点 |
| --- | --- | --- |
| [D1](0001-api-key-storage.md) | API Key 分层存储 | `packages/editor/src/studio/keyring.js`、`ai-proxy.js` |
| [D2](0002-markdown-sanitize.md) | Markdown 预览消毒是根风险 | `packages/core/src/pipeline/parse/sanitize-*.js` |
| [D3](0003-draft-safety-mobile.md) | 移动端与草稿系统联动验证 | `packages/editor/src/studio/drafts.js`、client 侧落盘时机 |
| [D4](0004-watch-and-plugin-scope.md) | 监听与插件范围收敛 | `packages/editor/src/studio/watcher.js`、`plugin-api.js` |
| [D5](0005-shortcut-declaration.md) | 快捷键表是声明面 | `packages/editor/src/studio/shortcuts.js`、`scripts/check-shortcuts.mjs` |
| [D6](0006-deploy-architecture.md) | 部署是一等公民 | `packages/core/src/deploy/`、`scripts/e2e/weaken.py` |

负向验证统一入口：`bash scripts/e2e/negative-check.sh`

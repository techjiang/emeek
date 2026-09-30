import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, mergeConfig } from '../src/config/defaults.js';
import { validateConfig } from '../src/config/schema.js';

test('默认配置自带可用的站点信息', () => {
  const config = defaultConfig();
  assert.ok(config.site.title);
  assert.ok(config.site.url);
  assert.equal(config.content.source, 'local');
});

test('深合并，数组整体替换', () => {
  const merged = mergeConfig(defaultConfig(), {
    site: { title: '自定义' },
    content: { localDirs: ['notes'] },
  });
  assert.equal(merged.site.title, '自定义');
  assert.equal(merged.site.description, defaultConfig().site.description, '未覆盖的字段应保留默认值');
  assert.deepEqual(merged.content.localDirs, ['notes']);
});

test('undefined 不覆盖默认值', () => {
  const merged = mergeConfig(defaultConfig(), { site: { title: undefined } });
  assert.equal(merged.site.title, defaultConfig().site.title);
});

test('校验通过默认配置', () => {
  const { errors } = validateConfig(defaultConfig());
  assert.deepEqual(errors, []);
});

test('URL 不合法时报错', () => {
  const config = defaultConfig();
  config.site.url = 'not-a-url';
  const { errors } = validateConfig(config);
  assert.ok(errors.some((e) => e.path === 'site.url'));
});

test('枚举值不合法时报错', () => {
  const config = defaultConfig();
  config.content.source = 'ftp';
  config.theme.darkMode = 'blink';
  config.deploy.target = 'floppy';
  const { errors } = validateConfig(config);
  const paths = errors.map((e) => e.path).sort();
  // source 非法时，连带的 content.repo 校验也会失败，这里只断言关键词都报到了。
  assert.deepEqual(paths, ['content.repo', 'content.source', 'deploy.target', 'theme.darkMode']);
});

test('github-issues 源缺 repo 时报错', () => {
  const config = defaultConfig();
  config.content.source = 'github-issues';
  config.content.repo = '';
  const { errors } = validateConfig(config);
  assert.ok(errors.some((e) => e.path === 'content.repo'));
});

test('数字字段必须为正整数', () => {
  const config = defaultConfig();
  config.feed.limit = -1;
  const { errors } = validateConfig(config);
  assert.ok(errors.some((e) => e.path === 'feed.limit'));
});

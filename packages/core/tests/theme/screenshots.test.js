import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 主题截图产物的护栏。
 *
 * 截图是主题验收的一部分（「亮暗 × 桌面/移动 × 首页/文章页」8 张），
 * 但它此前完全没有断言 —— 于是出过一次安静的失败：
 *
 *   截图脚本用 file:// 打开产物，而 CSS > 24KB 的主题（Magazine）会把样式
 *   改成外链 /assets/theme.css。file:// 下 `/assets/...` 指向文件系统根目录，
 *   样式表 404，暗色根本没生效 —— 亮暗两张截图**字节完全相同**，
 *   而产物目录里看上去「8 张齐全」。
 *
 * 这里钉两件事，正是那条失败能穿过的两个缺口：
 *   1. 清单里 4 套主题齐全（单跑一套时不能把别人的条目抹掉）
 *   2. 亮暗两版必须真的不同（暗色没生效时同尺寸 PNG 会逐字节一致）
 */

const REPO = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const OUT = path.join(REPO, 'docs/assets/themes');

/**
 * 主题清单动态扫 packages/theme-*，而不是写死 ——
 * 新主题加进来时，截图覆盖断言必须跟着扩展，否则「清单里缺第 5 套」
 * 会静默通过（这正是「加主题忘了改脚本」那类问题的对称面）。
 */
const THEMES = fs.readdirSync(path.join(REPO, 'packages'))
  .filter((name) => name.startsWith('theme-'))
  .filter((name) => fs.existsSync(path.join(REPO, 'packages', name, 'theme.json')))
  .map((name) => {
    const meta = JSON.parse(fs.readFileSync(path.join(REPO, 'packages', name, 'theme.json'), 'utf8'));
    return typeof meta.name === 'string' && meta.name ? meta.name : name.replace(/^theme-/, '');
  })
  .sort();
const DEVICES = ['desktop', 'mobile'];
const PAGES = ['home', 'post'];
const MODES = ['light', 'dark'];

const manifest = () => JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const rel = (t, p, d, m) => `${t}-${p}-${d}-${m}.png`;

test('截图清单覆盖全部内置主题 × 亮暗 × 桌面/移动 × 首页/文章页', () => {
  const rows = manifest();
  for (const theme of THEMES) {
    for (const page of PAGES) {
      for (const device of DEVICES) {
        for (const mode of MODES) {
          const hit = rows.find(
            (r) => r.theme === theme && r.page === page && r.device === device && r.mode === mode,
          );
          assert.ok(hit, `清单缺 ${rel(theme, page, device, mode)}（共需 ${THEMES.length * 8} 条）`);
        }
      }
    }
  }
});

test('清单里的每条都对应一个真实存在、非空的 PNG', () => {
  for (const row of manifest()) {
    const file = path.join(REPO, row.file);
    assert.ok(fs.existsSync(file), `清单指向的文件不存在：${row.file}`);
    assert.ok(fs.statSync(file).size > 1024, `${row.file} 只有 ${fs.statSync(file).size} 字节，像是空图`);
  }
});

test('每套主题的亮暗截图必须真的不同（暗色没生效时会逐字节相同）', () => {
  for (const theme of THEMES) {
    for (const page of PAGES) {
      for (const device of DEVICES) {
        const light = fs.readFileSync(path.join(OUT, rel(theme, page, device, 'light')));
        const dark = fs.readFileSync(path.join(OUT, rel(theme, page, device, 'dark')));
        // PNG 同尺寸下逐字节比较即可：暗色生效则排版相同、像素必然不同。
        assert.ok(
          !light.equals(dark),
          `${rel(theme, page, device, 'light')} 与暗色版逐字节相同 —— 截图时样式表很可能没加载`,
        );
      }
    }
  }
});

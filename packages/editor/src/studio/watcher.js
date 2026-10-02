/**
 * 文件监听（决策 D4）。
 *
 * ## 范围：内容目录，不是项目根
 *
 * 理由有两个，缺一个都不足以说服人：
 *
 *   **安全** —— 监听项目根意味着 `.env`、`node_modules`、`.git` 的变动
 *   都会进管线。用户改一次 `.env` 触发一次全站重建是一回事，
 *   而「编辑器的热更新提示里出现 .env 的路径」是另一回事。
 *
 *   **可用** —— 编辑器里跑一次 `git status`（切分支、装依赖）就能造出
 *   成百上千个事件。dev server 会被自己的监听器打瘫，而用户只觉得
 *   「编辑器卡死了」。
 *
 * ## 路径校验：走 resolveProjectFile，不自己写一遍
 *
 * 事件里的路径看起来「来自文件系统」，比客户端传来的可信 —— 但符号链接
 * 让这两者没有区别：`posts/escape.md` 的父目录老老实实待在 posts/ 里，
 * 文件本身却指向 /etc/passwd。S2-3a 在 HTTP 那条入口已经踩过这个洞并
 * 装好了防线（resolveProjectFile 的 realpath 判定），新入口必须复用同一条，
 * 不允许「再写一遍差不多的判断」—— 多一份实现就多一次漏看 realpath 的机会。
 *
 * ## 异常隔离
 *
 * 某个路径 watch 失败（权限、文件被删、平台限制、inotify 句柄耗尽）
 * 只记一条警告，dev server 继续跑。**监听挂了不是致命的，拖垮 dev server 才是。**
 * 所以这里还有一道「事件洪泛」刹车：单次窗口内事件超过阈值就合并成一次，
 * 而不是让它们排队把主线程占满。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 一次重建最多等多久（合并密集事件）。 */
const DEBOUNCE_MS = 120;
/** 事件洪泛阈值：窗口内超过这个数量就只发一次。 */
const FLOOD_LIMIT = 200;

/**
 * @param {object} options
 *   root        项目根（resolveProjectFile 需要）
 *   contentDir  内容目录（监听范围）
 *   onChange    (event) => void，event 里带 path/reason
 *   logger      日志口
 *   resolve     路径校验函数，默认注入 resolveProjectFile（测试可替换）
 */
export function createWatcher({
  root,
  contentDir,
  onChange = () => {},
  logger = console,
  resolve = null,
  fsImpl = fs,
} = {}) {
  const watchers = [];
  const rejected = [];
  let timer = null;
  let closed = false;
  let windowCount = 0;
  let windowOpenedAt = Date.now();
  let coalesced = 0;

  const base = path.resolve(contentDir);

  /**
   * 把事件路径归一化成「相对项目根」的形式，再过校验。
   * @returns {null | {absolute: string, relative: string}}
   */
  function admit(target) {
    if (!target) return null;
    const absolute = path.resolve(String(target));
    // 先做一次廉价的范围预筛（挡掉 node_modules / .git 的高频噪音），
    // 再交给权威的 resolveProjectFile —— 预筛只是省开销，不作为安全依据
    if (!absolute.startsWith(base + path.sep) && absolute !== base) return null;
    if (!resolve) return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') };
    const verified = resolve(root, contentDir, path.relative(root, absolute));
    // 注意：resolve 返回 null 表示**拒绝**。这里不降级放行 ——
    // 「校验失败就饶过」正是防线失效的方式。
    return verified;
  }

  function emit(reason, target) {
    if (closed) return;
    const verified = admit(target);
    if (!verified) {
      // 被拒的事件要留痕：这是「目录外路径被拒」的测试所断言的东西，
      // 也是排查「我改了文件为什么没重建」时唯一的线索
      if (target) {
        rejected.push({ reason, target: String(target), at: Date.now() });
        logger.warn?.(`[watch] 拒绝目录外事件：${String(target).replace(root, '.')}`);
      }
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      clearTimeout(timer);
      timer = null;
      // 洪泛刹车：一个窗口里的事件数超阈值就合并
      const now = Date.now();
      if (now - windowOpenedAt > 1000) { windowOpenedAt = now; windowCount = 0; }
      windowCount += 1;
      if (windowCount > FLOOD_LIMIT) {
        coalesced += 1;
        if (coalesced === 1) logger.warn?.(`[watch] 事件过于密集（>${FLOOD_LIMIT}/秒），已合并重建，避免拖垮 dev server`);
        return;
      }
      try {
        onChange({ reason, path: verified.relative, absolute: verified.absolute });
      } catch (error) {
        // 回调抛错绝不能让监听器一起死 —— 这是「监听器异常隔离」的核心一条
        logger.warn?.(`[watch] 重建回调出错（已隔离）：${error.message}`);
      }
    }, DEBOUNCE_MS);
  }

  function watchDir(dir, depth = 0) {
    if (closed) return;
    let watcher;
    try {
      watcher = fsImpl.watch(dir, { persistent: true }, (_event, filename) => {
        emit('change', filename ? path.join(dir, String(filename)) : dir);
      });
    } catch (error) {
      // 目录不存在 / 权限不足 / inotify 用尽：记一条就走，不做任何重试风暴
      logger.warn?.(`[watch] 无法监听 ${path.relative(root, dir)}：${error.message}（该目录的变更将不会被发现）`);
      return;
    }
    watcher.on?.('error', (error) => {
      logger.warn?.(`[watch] 监听 ${path.relative(root, dir)} 出错：${error.message}`);
    });
    watchers.push(watcher);

    // fs.watch 在 Linux 上不递归，自己进一层（深度上限 3，与文件列表一致）
    if (depth >= 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = path.join(dir, entry.name);
      // 子目录也要在内容目录内（软链目录能指到外面）
      const verified = admit(child);
      if (!verified) continue;
      watchDir(child, depth + 1);
    }
  }

  return {
    start() {
      if (closed) return this;
      try {
        if (!fs.existsSync(base)) {
          logger.warn?.(`[watch] 内容目录不存在：${path.relative(root, base)}（改完配置后重启即可）`);
          return this;
        }
      } catch { /* stat 失败也当不存在处理 */ }
      watchDir(base, 0);
      return this;
    },
    stop() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* 关不掉不影响退出 */ }
      }
      watchers.length = 0;
      return this;
    },
    /** 测试用：手动投一个事件，不必造真实的文件变动。 */
    inject(reason, target) { emit(reason, target); return this; },
    /** 被拒的事件（测试与诊断都看它）。 */
    get rejected() { return rejected; },
    get watching() { return watchers.length; },
    get flooded() { return coalesced; },
    get contentDir() { return base; },
  };
}

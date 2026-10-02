/**
 * jsdom 环境搭建。
 *
 * 为什么要抽成共享模块：每个用到 DOM 的测试文件都要装一遍全局，
 * 而漏掉一个全局（比如 Window）会让 CodeMirror 在测量阶段抛
 * 「Window is not defined」—— 那个报错离真正的原因很远，很难定位。
 * 装一次、装全，比在每个文件里各写一遍安全。
 */
export async function setupDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;

  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Node: window.Node,
    Element: window.Element,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    File: window.File,
    // 不覆盖 Blob / Request / Response：Node 自带这些全局且是「原生」实现，
    // 覆盖成 jsdom 的版本会让 Node 的 Blob 校验失败
    //（实测报 "obj argument must be an instance of Blob"）。
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    DOMRect: window.DOMRect,
    Window: window.Window,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  for (const [key, value] of Object.entries(globals)) {
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }

  /**
   * URL.createObjectURL 的桩。
   *
   * Node 的 URL 上其实有这个方法，但它要求参数是 Node 的 Blob，
   * jsdom 造出来的 File 不满足。这里的返回值只用于断言「插入了本地预览链接」，
   * 不需要真的能解析 —— 所以就返回一个稳定的假 URL。
   */
  Object.defineProperty(globalThis.URL, 'createObjectURL', {
    value: (file) => `blob:local-preview/${encodeURIComponent(file?.name ?? 'file')}`,
    writable: true,
    configurable: true,
  });
  return dom;
}

export function createHost() {
  const host = document.getElementById('host');
  host.innerHTML = '';
  return host;
}

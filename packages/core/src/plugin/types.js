/**
 * 插件契约的类型文档（JSDoc 形式，构建期不产出额外代码）。
 *
 * @typedef {Object} EmeekPlugin
 * @property {string} name        插件名，建议带作用域前缀
 * @property {string} version
 * @property {string} [description]
 * @property {Object} [hooks]
 * @property {Function} [hooks.onContentLoad]  内容读取后，可改写 posts[]
 * @property {Function} [hooks.onBeforeRender] Markdown 渲染完、写模板前
 * @property {Function} [hooks.onAfterRender]  输出前
 * @property {Function} [hooks.onBuildComplete] 全部产物写完后
 * @property {Array} [pages]       额外页面定义 { path, layout, data }
 * @property {Object} [helpers]    模板 helper
 * @property {Array} [commands]    CLI 子命令
 */
export {};

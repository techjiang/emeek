const COLORS = { reset: '\u001b[0m', dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', blue: '\u001b[34m', cyan: '\u001b[36m' };

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (color, text) => (useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text);

export const logger = {
  info: (msg) => console.log(`${paint('blue', 'ℹ')} ${msg}`),
  success: (msg) => console.log(`${paint('green', '✔')} ${msg}`),
  warn: (msg) => console.warn(`${paint('yellow', '⚠')} ${msg}`),
  error: (msg) => console.error(`${paint('red', '✖')} ${msg}`),
  step: (msg) => console.log(`${paint('cyan', '▸')} ${msg}`),
  dim: (msg) => console.log(paint('dim', msg)),
  raw: (msg) => console.log(msg),
};

/** 无进度条时的最小进度反馈：原地刷新百分比，非 TTY 下退化为不输出。 */
export function progress(label, total) {
  if (!process.stdout.isTTY || !total) return { tick() {}, done() {} };
  let current = 0;
  return {
    tick() {
      current += 1;
      const pct = Math.round((current / total) * 100);
      process.stdout.write(`\r${paint('cyan', '▸')} ${label} ${pct}%`);
    },
    done() {
      process.stdout.write(`\r${paint('green', '✔')} ${label} 100%\n`);
    },
  };
}

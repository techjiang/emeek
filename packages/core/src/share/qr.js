/**
 * 极简 QR 编码器（字节模式）—— 只够用来画「当前文章地址」的二维码。
 *
 * ── 为什么不引第三方库 ──
 *
 * 常见做法是 `qrcode` / `qrcode-generator`（几十 KB）。但本站的约束是
 * **零外部依赖**：一个 316KB 的中文词表是为了分词质量才破例的，
 * 而二维码只服务「分享到微信」这一件事 —— 为一个按钮背一个库不划算，
 * 而且库的代码路径里还有我们不需要的 SVG/终端/多模式编码。
 *
 * ── 这个实现做了什么、没做什么 ──
 *
 * 做：
 *   · 字节模式（UTF-8 八位字节）—— 分享地址是 ASCII，但标题可能不是
 *   · 版本 1~10 自动选最小可用版本
 *   · 纠错等级 L/M/Q/H 全支持（默认 M，扫码最稳的折中）
 *   · 掩码 8 种全算，按标准罚分选最优
 *
 * 不做：
 *   · 数字/字母数字模式（更省位，但我们只编地址，省下来也不影响可用性）
 *   · 结构化追加、Kanji 模式、版本信息 > 10
 *
 * 版本的硬上限是 10（57×57），容量约 213 字节（M 级）。足够任何
 * 正常长度的文章地址 —— 超过时**显式抛错**，而不是静默截断地址
 * （截断的二维码扫出来是一个错的地址，比没有二维码更糟）。
 *
 * 参考：ISO/IEC 18004。测试用「同一输入两次编码恒等」「格式信息校验位
 * 自洽」「版本容量边界」等可断言的属性，而不是拿一张图去比像素。
 */

/**
 * RS 分块表（ISO/IEC 18004 表 9），版本 1-10。
 *
 * 每一项是 `[块数, 每块总码字数, 每块数据码字数]`。一个版本可以有
 * 两种不同大小的块（如 v5-Q 是 2 个 15 字节块 + 2 个 16 字节块）。
 *
 * **顺序有意义：短块在前。** 交织时按块顺序逐位取（见 interleave），
 * 两种块混在一起时「哪个块先」会决定每个字节落到哪一格。
 * 第一版我按「数据多的在前」排，v1-v4 全对（那时块都等长），
 * 从 v5-Q 开始全错 —— 而且错得极隐蔽：纠错码字、格式信息、版本信息
 * 全都对，只有数据字节的**位置**错位，任何解码器都读不出来。
 *
 * ── 为什么是「表」而不是「算」──
 *
 * 第一版我用「EC 码字总数 + 块数」两张表去**算**每块的纠错长度
 * （`totalEc / blocks`）。它对 v1/v2 是对的，从 v3-H 开始全错 ——
 * 因为块大小并不总是均分的（v7-H 是 4 个 13 字节块 + 1 个 14 字节块）。
 * 症状是：矩阵结构完全自洽、格式信息正确、数据位回读完全一致，
 * 但**任何解码器都读不出来**，因为纠错码字数不对。
 *
 * 那张算出来的表还犯了一个更隐蔽的错：它把「总纠错码字数」当成了
 * 每块的长度。v3-H 真实是每块 22 个纠错码字（共 44），表里写的是 22。
 *
 * 教训：这类有权威表的常量，抄表比推导安全。推导看起来更优雅，
 * 但一旦错了，错的是「所有非平凡输入」，而写表最多错几行。
 */
const RS_BLOCK_TABLE = {
  1: { L: [[1, 26, 19]], M: [[1, 26, 16]], Q: [[1, 26, 13]], H: [[1, 26, 9]] },
  2: { L: [[1, 44, 34]], M: [[1, 44, 28]], Q: [[1, 44, 22]], H: [[1, 44, 16]] },
  3: { L: [[1, 70, 55]], M: [[1, 70, 44]], Q: [[2, 35, 17]], H: [[2, 35, 13]] },
  4: { L: [[1, 100, 80]], M: [[2, 50, 32]], Q: [[2, 50, 24]], H: [[4, 25, 9]] },
  5: { L: [[1, 134, 108]], M: [[2, 67, 43]], Q: [[2, 33, 15], [2, 34, 16]], H: [[2, 33, 11], [2, 34, 12]] },
  6: { L: [[2, 86, 68]], M: [[4, 43, 27]], Q: [[4, 43, 19]], H: [[4, 43, 15]] },
  7: { L: [[2, 98, 78]], M: [[4, 49, 31]], Q: [[2, 32, 14], [4, 33, 15]], H: [[4, 39, 13], [1, 40, 14]] },
  8: { L: [[2, 121, 97]], M: [[2, 60, 38], [2, 61, 39]], Q: [[4, 40, 18], [2, 41, 19]], H: [[4, 40, 14], [2, 41, 15]] },
  9: { L: [[2, 146, 116]], M: [[3, 58, 36], [2, 59, 37]], Q: [[4, 36, 16], [4, 37, 17]], H: [[4, 36, 12], [4, 37, 13]] },
  10: { L: [[2, 86, 68], [2, 87, 69]], M: [[4, 69, 43], [1, 70, 44]], Q: [[6, 43, 19], [2, 44, 20]], H: [[6, 43, 15], [2, 44, 16]] },
};

/** 展开成逐块描述：[{ total, data }]。 */
export function rsBlocks(version, level) {
  const spec = RS_BLOCK_TABLE[version]?.[level];
  if (!spec) throw new Error(`没有版本 ${version} / 等级 ${level} 的分块定义`);
  const blocks = [];
  for (const [count, total, data] of spec) {
    for (let i = 0; i < count; i += 1) blocks.push({ total, data });
  }
  return blocks;
}

/** 版本 → 尺寸（模块数，不含静默区）。 */
export const sizeOf = (version) => version * 4 + 17;

/** 版本 → 可容纳的字节数（给定纠错等级）。 */
export function capacityBytes(version, level = 'M') {
  const blocks = RS_BLOCK_TABLE[version]?.[level];
  if (!blocks) throw new Error(`没有版本 ${version} / 等级 ${level} 的分块定义`);
  const dataCodewords = blocks.reduce((sum, [count, , data]) => sum + count * data, 0);
  const header = version >= 10 ? 4 + 16 : 4 + 8;
  return Math.floor((dataCodewords * 8 - header) / 8);
}

export const QR_CAPACITY = { maxVersion: 10, levels: ['L', 'M', 'Q', 'H'] };

/**
 * 编码一个字符串为 QR 模块矩阵。
 *
 * @param {string} text
 * @param {{ level?: 'L'|'M'|'Q'|'H', version?: number }} options
 * @returns {{ version:number, size:number, level:string, matrix:boolean[][], modules:number }}
 *   matrix[y][x] === true 表示该模块是黑块。**不含静默区** ——
 *   渲染端负责在外围留 4 模块的白边（这是扫码成功率的关键，不能省）。
 */
export function encodeQr(text, { level = 'M', version = null } = {}) {
  if (!QR_CAPACITY.levels.includes(level)) throw new Error(`不支持的纠错等级：${level}`);
  const bytes = utf8Bytes(String(text ?? ''));

  let chosen = version;
  if (chosen == null) {
    for (let v = 1; v <= QR_CAPACITY.maxVersion; v += 1) {
      if (bytes.length <= capacityBytes(v, level)) { chosen = v; break; }
    }
    if (chosen == null) {
      throw new Error(
        `二维码内容过长（${bytes.length} 字节），当前实现最高支持版本 ${QR_CAPACITY.maxVersion}`
        + `（${level} 级容量 ${capacityBytes(QR_CAPACITY.maxVersion, level)} 字节）。`
        + '这是一条显式错误 —— 静默截断会扫出一个错误的地址。',
      );
    }
  } else if (bytes.length > capacityBytes(chosen, level)) {
    throw new Error(`内容 ${bytes.length} 字节超过版本 ${chosen} 的 ${level} 级容量`);
  }

  const dataBits = encodeData(bytes, chosen);
  const codewords = toCodewords(dataBits, chosen, level);
  const finalBits = interleave(codewords, chosen, level);
  return buildMatrix(finalBits, chosen, level);
}

function utf8Bytes(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

/** 数据段：模式指示符(0100) + 字符计数 + 数据 + 终止符 + 补齐到码字边界。 */
function encodeData(bytes, version) {
  const bits = [];
  push(bits, 0b0100, 4);
  push(bits, bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) push(bits, byte, 8);
  return bits;
}

/** 补齐：终止符 + 字节对齐 + 0xEC/0x11 交替填充。 */
function toCodewords(dataBits, version, level) {
  const blocks = rsBlocks(version, level);
  const capacityBits = blocks.reduce((sum, b) => sum + b.data, 0) * 8;

  const bits = [...dataBits];
  // 终止符最多 4 个 0。
  push(bits, 0, Math.min(4, capacityBits - bits.length));
  // 补齐到字节边界。
  while (bits.length % 8 !== 0) bits.push(0);
  // 补齐码字：0xEC / 0x11 交替，直到填满数据区。
  const padBytes = [0xec, 0x11];
  let i = 0;
  while (bits.length < capacityBits) {
    push(bits, padBytes[i % 2], 8);
    i += 1;
  }
  return bits;
}

/**
 * 分块 + RS 纠错 + 交织，得到最终码字序列。
 *
 * 分块**完全由 rsBlocks 的表决定** —— 不再做任何「总数除以块数」的算术。
 * 交织规则（标准 §8.6）：依次取各块的第 0 个数据码字、各块的第 1 个……
 * 数据取完后同法取纠错码字。块长不等时短块跳过。
 */
function interleave(dataBits, version, level) {
  const blocks = rsBlocks(version, level);
  const dataBytes = bitsToBytes(dataBits);

  const chunks = [];
  const ecChunks = [];
  let offset = 0;
  for (const block of blocks) {
    const chunk = dataBytes.slice(offset, offset + block.data);
    offset += block.data;
    chunks.push(chunk);
    ecChunks.push(rsEncode(chunk, block.total - block.data));
  }

  const out = [];
  const maxData = Math.max(...chunks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of chunks) if (i < block.length) out.push(block[i]);
  }
  const maxEc = Math.max(...ecChunks.map((b) => b.length));
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of ecChunks) if (i < block.length) out.push(block[i]);
  }
  return out;
}

/** GF(256) 上的 Reed-Solomon 纠错码字生成。 */
function rsEncode(data, ecLength) {
  const gen = rsGenerator(ecLength);
  const res = new Array(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLength; i += 1) {
      res[i] ^= gfMul(gen[i + 1] ?? 0, factor);
    }
  }
  return res;
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    // 乘上 (x - α^i)
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// GF(256) 的指数/对数表（本原多项式 0x11D，QR 标准）。
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}());

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function bitsToBytes(bits) {
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    out.push(byte);
  }
  return out;
}

function push(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
}

/** 构建功能图形 + 数据 + 掩码，返回最终矩阵。 */
function buildMatrix(codewords, version, level) {
  const size = sizeOf(version);
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  placeFinder(modules, reserved, 0, 0, size);
  placeFinder(modules, reserved, size - 7, 0, size);
  placeFinder(modules, reserved, 0, size - 7, size);
  placeTiming(modules, reserved, size);
  placeAlignment(modules, reserved, version, size);
  reserveFormat(reserved, size, version);
  placeDarkModule(modules, size);
  placeVersionInfo(modules, version, size);

  const dataBits = [];
  for (const cw of codewords) push(dataBits, cw, 8);

  // 8 种掩码全算一遍，按标准罚分选最低的。
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => [...row]);
    placeData(candidate, reserved, dataBits, mask, size);
    placeFormat(candidate, level, mask, size);
    const score = penalty(candidate, size);
    if (!best || score < best.score) best = { score, matrix: candidate, mask };
  }
  return {
    version, size, level, mask: best.mask, matrix: best.matrix.map((row) => row.map(Boolean)), modules: size * size,
  };
}

function placeFinder(m, r, x, y, size) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const cx = x + dx;
      const cy = y + dy;
      if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
      r[cy][cx] = true;
      const isBorderRow = dy === 0 || dy === 6 || dx === 0 || dx === 6;
      const isCenter = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
      const inPattern = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      m[cy][cx] = inPattern ? (isBorderRow || isCenter) : false;
    }
  }
}

function placeTiming(m, r, size) {
  for (let i = 8; i < size - 8; i += 1) {
    const value = i % 2 === 0;
    m[6][i] = value; r[6][i] = true;
    m[i][6] = value; r[i][6] = true;
  }
}

/** 对齐图案的中心坐标表（版本 1 没有对齐图案）。 */
const ALIGN_CENTERS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

function placeAlignment(m, r, version, size) {
  const centers = ALIGN_CENTERS[version] ?? [];
  for (const cy of centers) {
    for (const cx of centers) {
      // 跳过与定位图案重叠的角。
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          r[y][x] = true;
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          m[y][x] = ring !== 1;
        }
      }
    }
  }
}

function reserveFormat(r, size, version) {
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) { r[8][i] = true; r[i][8] = true; }
  }
  for (let i = 0; i < 8; i += 1) {
    r[8][size - 1 - i] = true;
    r[size - 1 - i][8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        r[size - 11 + j][i] = true;
        r[i][size - 11 + j] = true;
      }
    }
  }
}

function placeDarkModule(m, size) {
  m[size - 8][8] = true;
}

/** 之字形填充数据位，跳过功能区。 */
function placeData(m, r, bits, mask, size) {
  let index = 0;
  let upwards = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1; // 跳过垂直定时图案那一列
    for (let step = 0; step < size; step += 1) {
      const y = upwards ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (r[y][x]) continue;
        const bit = index < bits.length ? bits[index] === 1 : false;
        index += 1;
        m[y][x] = bit !== applyMask(mask, x, y);
      }
    }
    upwards = !upwards;
  }
}

function applyMask(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

/**
 * 版本信息（版本 ≥ 7 才有）。
 *
 * 18 位：6 位版本号 + 12 位 BCH(18,6) 校验。分两处摆，各 3×6。
 * 少了它，版本 ≥ 7 的二维码结构看起来完全正常，但解码器不知道
 * 自己该按哪个版本去读 —— 症状就是「v6 及以下都能扫，v7 开始全扫不出」。
 * 这个现象的边界太干净了，一旦出现基本可以直接定位到这里。
 */
function placeVersionInfo(m, version, size) {
  if (version < 7) return;
  let value = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((value >> i) & 1) value ^= 0x1f25 << (i - 12);
  }
  const bits = (version << 12) | value;
  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    // 左下角 3 宽 × 6 高
    m[size - 11 + col][row] = bit;
    // 右上角 6 宽 × 3 高
    m[row][size - 11 + col] = bit;
  }
}

/**
 * 格式信息：5 bit（等级 2 + 掩码 3）+ 10 bit BCH，再与 0x5412 异或。
 *
 * ── 这里的位序踩过一个真实的坑，记下来 ──
 *
 * 格式串一共 15 位。第一版我按「bit 0 放 (8,0)、bit 1 放 (8,1)…」写，
 * 也就是 LSB 在前。矩阵的数据区与功能图形全部正确，但**任何解码器都读不出来** ——
 * 因为格式信息是解码器定位掩码与纠错等级的入口，它错了后面全白搭。
 *
 * 正确顺序是 **MSB 在前**：bit 14 放 (8,0)、bit 13 放 (8,1)…。
 * 这个 bug 的形态很值得记住：数据全对、结构自洽、矩阵看起来也挺像，
 * 只有拿真解码器读一遍才会暴露。所以那个「矩阵能解码」的测试不是形式主义。
 *
 * 两个副本各自的位置列表写死在下面（跳过定时图案 (8,6) 与 (6,8)），
 * 而不是用循环 + 下标算术拼 —— 后者正是第一版写出反向位序的原因：
 * 算术式里哪一位对应哪个坐标，读代码的人必须自己在心里跑一遍。
 */
function placeFormat(m, level, mask, size) {
  const LEVEL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
  const data = (LEVEL_BITS[level] << 3) | mask;
  let value = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >> i) & 1) value ^= 0x537 << (i - 10);
  }
  const bits = ((data << 10) | value) ^ 0x5412;

  // copy1[i] 是「第 14-i 位」（MSB 在前）的坐标。顺序即线上位序。
  const copy1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const copy2 = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
    [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
    [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];

  for (const positions of [copy1, copy2]) {
    positions.forEach(([y, x], index) => {
      m[y][x] = ((bits >> (14 - index)) & 1) === 1;
    });
  }
}

/** 标准罚分。只影响「选哪种掩码」，不影响可扫性，但最优掩码扫得更稳。 */
function penalty(m, size) {
  let score = 0;
  // 规则 1：行/列上连续同色 ≥5。
  for (let y = 0; y < size; y += 1) {
    let run = 1;
    for (let x = 1; x < size; x += 1) {
      if (m[y][x] === m[y][x - 1]) run += 1;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  for (let x = 0; x < size; x += 1) {
    let run = 1;
    for (let y = 1; y < size; y += 1) {
      if (m[y][x] === m[y - 1][x]) run += 1;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  // 规则 2：2×2 同色块。
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }
  // 规则 4：黑白比例偏离 50%。
  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (m[y][x]) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** 便捷别名：矩阵（含静默区可选）。 */
export function qrMatrix(text, options = {}) {
  return encodeQr(text, options).matrix;
}

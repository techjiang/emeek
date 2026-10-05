import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, capacityBytes, qrMatrix, rsBlocks, QR_CAPACITY } from '../../src/share/qr.js';

/**
 * QR 编码器的测试。
 *
 * ── 为什么不「拿一张参考图比像素」──
 *
 * 那需要把一张图签进仓库，而且只能覆盖它那一个输入。
 * 这里测的是**结构性质**：同一个输入两次编码恒等、版本随内容单调增长、
 * 容量边界、功能图形就位、格式信息自洽。
 *
 * 另外还有一层在 e2e：脚本用 OpenCV 的真实解码器逐张扫码，
 * 确认「编出来的东西真的能被读出来」。那才是这一层最终要保证的事 ——
 * 单测能证明「结构没坏」，但只有真解码器能证明「它还叫二维码」。
 */

describe('二维码编码器', () => {
  test('同一输入两次编码逐格相同（无随机性）', () => {
    const a = encodeQr('https://example.com/a');
    const b = encodeQr('https://example.com/a');
    assert.equal(a.version, b.version);
    assert.equal(a.mask, b.mask);
    assert.deepEqual(a.matrix, b.matrix);
  });

  test('尺寸 = 版本 × 4 + 17', () => {
    for (let v = 1; v <= 10; v += 1) {
      const r = encodeQr('x', { version: v });
      assert.equal(r.size, v * 4 + 17, `版本 ${v}`);
      assert.equal(r.matrix.length, r.size);
      assert.equal(r.matrix[0].length, r.size);
    }
  });

  test('版本随内容单调增长（不跳版、不倒挂）', () => {
    let last = 0;
    for (let n = 1; n <= 200; n += 7) {
      const { version } = encodeQr('a'.repeat(n), { level: 'M' });
      assert.ok(version >= last, `长度 ${n} 时版本 ${version} 小于之前的 ${last}`);
      last = version;
    }
  });

  test('容量边界：刚好装得下 / 多一个字节就抛错', () => {
    for (let v = 1; v <= 10; v += 1) {
      const cap = capacityBytes(v, 'M');
      // 刚好装得下
      assert.equal(encodeQr('a'.repeat(cap), { level: 'M', version: v }).version, v);
      // 多一个 → 必须抛，且错误信息说清是容量问题（不是静默截断）
      assert.throws(
        () => encodeQr('a'.repeat(cap + 1), { level: 'M', version: v }),
        /超过版本/,
        `版本 ${v} 容量 ${cap}`,
      );
    }
  });

  test('超过实现的最高版本时显式抛错（不静默截断地址）', () => {
    assert.throws(
      () => encodeQr('x'.repeat(500), { level: 'H' }),
      /内容过长/,
      '超长内容必须报错 —— 截断的二维码扫出来是一个错的地址',
    );
  });

  test('功能图形：三个定位图案 + 定时图案 + 暗模块', () => {
    const { matrix, size } = encodeQr('https://example.com/');
    // 定位图案左上角 7×7 的外框
    for (let i = 0; i < 7; i += 1) {
      assert.equal(matrix[0][i], true, `顶边 ${i}`);
      assert.equal(matrix[i][0], true, `左边 ${i}`);
      assert.equal(matrix[6][i], true, `顶边内侧 ${i}`);
    }
    // 定时图案（第 6 行 / 第 6 列）黑白交替
    for (let i = 8; i < size - 8; i += 1) {
      assert.equal(matrix[6][i], i % 2 === 0, `横定时 ${i}`);
      assert.equal(matrix[i][6], i % 2 === 0, `竖定时 ${i}`);
    }
    // 暗模块固定在 (size-8, 8)
    assert.equal(matrix[size - 8][8], true, '暗模块必须存在');
  });

  test('格式信息两处副本一致（不一致的解码器会读错掩码）', () => {
    const { matrix, size } = encodeQr('https://example.com/test');
    const c1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    const c2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
    for (let i = 0; i < 15; i += 1) {
      assert.equal(matrix[c1[i][0]][c1[i][1]], matrix[c2[i][0]][c2[i][1]], `第 ${i} 位两处不一致`);
    }
  });

  test('格式信息与标准值一致（位序错了任何解码器都读不出来）', () => {
    // 格式信息 = (纠错等级 2bit << 3 | 掩码 3bit) 经 BCH(15,5) 再异或 0x5412。
    // 这里按标准独立算一遍，与编码器写进矩阵的 15 位逐位比对。
    // 为什么不能只比「两处副本一致」：位序整体反向时两处副本仍然一致，
    // 那条断言会绿 —— 而矩阵已经无法解码了。
    const LEVEL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
    const expected = (level, mask) => {
      const data = (LEVEL_BITS[level] << 3) | mask;
      let v = data << 10;
      for (let i = 14; i >= 10; i -= 1) if ((v >> i) & 1) v ^= 0x537 << (i - 10);
      return ((data << 10) | v) ^ 0x5412;
    };
    for (const level of ['L', 'M', 'Q', 'H']) {
      const { matrix, mask } = encodeQr('https://example.com/format', { level });
      const bits = expected(level, mask);
      const c1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
      const got = c1.reduce((acc, [y, x], i) => acc | ((matrix[y][x] ? 1 : 0) << (14 - i)), 0);
      assert.equal(got, bits, `${level} 级掩码 ${mask} 的格式信息与标准不符`);
    }
  });

  test('版本 ≥ 7 必须摆版本信息（否则解码器不知道按哪个版本读）', () => {
    const v6 = encodeQr('x'.repeat(100), { level: 'M', version: 6 });
    const v7 = encodeQr('x'.repeat(100), { level: 'M', version: 7 });
    // 版本信息区域在 v6 里是数据区（内容不同应不一样），但关键是 v7 一定非空。
    const region = (m, size) => {
      const cells = [];
      for (let i = 0; i < 6; i += 1) for (let j = 0; j < 3; j += 1) cells.push(m[size - 11 + j][i]);
      return cells;
    };
    assert.notDeepEqual(region(v7.matrix, v7.size), region(v6.matrix, v6.size));
    // v7 的版本信息在两个位置都存在且一致
    const size = v7.size;
    for (let i = 0; i < 18; i += 1) {
      const row = Math.floor(i / 3), col = i % 3;
      assert.equal(v7.matrix[size - 11 + col][row], v7.matrix[row][size - 11 + col], `版本信息第 ${i} 位`);
    }
  });

  test('分块表：短块在前（顺序影响交织后字节的落位）', () => {
    // v5-Q 是 2 个 15 字节块 + 2 个 16 字节块。顺序错了数据会整体错位 ——
    // 而那种错在任何结构性断言下都看不出来，只有真解码器能发现。
    const blocks = rsBlocks(5, 'Q');
    assert.deepEqual(blocks.map((b) => b.data), [15, 15, 16, 16]);
    assert.deepEqual(rsBlocks(1, 'M').map((b) => b.data), [16]);
    assert.deepEqual(rsBlocks(10, 'H').map((b) => b.data), [15, 15, 15, 15, 15, 15, 16, 16]);
  });

  test('分块表：每块总长 = 数据 + 纠错，且总数与版本容量一致', () => {
    for (let v = 1; v <= 10; v += 1) {
      for (const level of ['L', 'M', 'Q', 'H']) {
        const blocks = rsBlocks(v, level);
        const total = blocks.reduce((s, b) => s + b.total, 0);
        const data = blocks.reduce((s, b) => s + b.data, 0);
        assert.ok(data > 0);
        assert.ok(total > data);
        // 容量换算：数据码字总数决定可容纳字节数
        assert.equal(capacityBytes(v, level), Math.floor((data * 8 - (v >= 10 ? 20 : 12)) / 8));
      }
    }
  });

  test('不支持的纠错等级显式抛错', () => {
    assert.throws(() => encodeQr('x', { level: 'Z' }), /纠错等级/);
  });

  test('中文内容按 UTF-8 编码（标题里有中文也能扫）', () => {
    const r = encodeQr('你好，世界 Emeek 博客', { level: 'M' });
    assert.ok(r.size >= 21);
    assert.deepEqual(qrMatrix('你好，世界 Emeek 博客'), r.matrix);
  });
});

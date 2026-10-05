/**
 * 分享的浏览器端脚本（P3-4b-rest C）。
 *
 * 只有两件事需要浏览器端做：
 *   1. 微信二维码 —— 微信没有 web 分享端点，只能扫码
 *   2. 复制链接 —— 需要 Clipboard API
 *
 * 其余平台全是构建期算好的 <a href>，不经过这里。
 *
 * ── 为什么二维码要在这儿重写一遍编码器 ──
 *
 * qr.js 是 ESM 模块，而这段脚本要内联进页面（零外部请求）。
 * 构建期可以 import qr.js 生成矩阵然后**序列化进页面**吗？可以，但那样
 * 每篇文章的产物里都会塞一份完整矩阵（几百个布尔值 + 一堆引号），
 * 而绝大多数访客从不点「微信」。
 *
 * 所以这里放一份「只在点击时才跑」的紧凑编码器。它与 qr.js 是同一算法
 * （同一份表、同一份位序），一致性由测试钉住：同一个地址，
 * 浏览器端的矩阵必须与 qr.js 构建期的矩阵逐格相同。
 * 这不是「重复实现」—— 是同一算法的两个宿主（构建期 / 运行时），
 * 而两者一致是有断言保证的。
 */
export const SHARE_CLIENT = `(function () {
  'use strict';

  // ── QR 编码器（字节模式，版本 1-10，纠错 M）─────────────────
  // 与 core/share/qr.js 同一算法。表与位序必须一致 —— 有测试钉住。

  var RS_BLOCK = {
    1:{M:[[1,26,16]]}, 2:{M:[[1,44,28]]}, 3:{M:[[1,70,44]]},
    4:{M:[[2,50,32]]}, 5:{M:[[2,67,43]]}, 6:{M:[[4,43,27]]},
    7:{M:[[4,49,31]]}, 8:{M:[[2,60,38],[2,61,39]]},
    9:{M:[[3,58,36],[2,59,37]]}, 10:{M:[[4,69,43],[1,70,44]]}
  };
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j += 1) EXP[j] = EXP[j - 255];
  }());
  function gfMul(a, b) { if (!a || !b) return 0; return EXP[LOG[a] + LOG[b]]; }

  function rsBlocks(v) {
    var spec = RS_BLOCK[v].M, out = [];
    for (var i = 0; i < spec.length; i += 1) {
      for (var k = 0; k < spec[i][0]; k += 1) out.push({ total: spec[i][1], data: spec[i][2] });
    }
    return out;
  }

  function rsEncode(data, ecLen) {
    var gen = [1];
    for (var i = 0; i < ecLen; i += 1) {
      var next = new Array(gen.length + 1).fill(0);
      for (var j = 0; j < gen.length; j += 1) {
        next[j] ^= gfMul(gen[j], 1);
        next[j + 1] ^= gfMul(gen[j], EXP[i]);
      }
      gen = next;
    }
    var res = new Array(ecLen).fill(0);
    for (var d = 0; d < data.length; d += 1) {
      var factor = data[d] ^ res[0];
      res.shift(); res.push(0);
      for (var e = 0; e < ecLen; e += 1) res[e] ^= gfMul(gen[e + 1], factor);
    }
    return res;
  }

  function utf8(text) {
    var out = [];
    for (var i = 0; i < text.length; i += 1) {
      var c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff) {
        var c2 = text.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i += 1;
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }
  function pushBit(bits, value, len) { for (var i = len - 1; i >= 0; i -= 1) bits.push((value >> i) & 1); }

  function capacity(v) {
    var blocks = rsBlocks(v), total = 0;
    for (var i = 0; i < blocks.length; i += 1) total += blocks[i].data;
    return Math.floor((total * 8 - (v >= 10 ? 20 : 12)) / 8);
  }

  function encode(text) {
    var bytes = utf8(text), version = 0;
    for (var v = 1; v <= 10; v += 1) { if (bytes.length <= capacity(v)) { version = v; break; } }
    if (!version) throw new Error('内容过长，无法生成二维码');

    var bits = [];
    pushBit(bits, 4, 4);
    pushBit(bits, bytes.length, version >= 10 ? 16 : 8);
    for (var b = 0; b < bytes.length; b += 1) pushBit(bits, bytes[b], 8);

    var blocks = rsBlocks(version), dataTotal = 0;
    for (var i = 0; i < blocks.length; i += 1) dataTotal += blocks[i].data;
    var cap = dataTotal * 8;
    pushBit(bits, 0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    var pad = [0xec, 0x11], p = 0;
    while (bits.length < cap) { pushBit(bits, pad[p % 2], 8); p += 1; }

    var dataBytes = [];
    for (var k = 0; k < bits.length; k += 8) {
      var byte = 0;
      for (var m = 0; m < 8; m += 1) byte = (byte << 1) | bits[k + m];
      dataBytes.push(byte);
    }

    var chunks = [], ecChunks = [], off = 0;
    for (var bi = 0; bi < blocks.length; bi += 1) {
      var chunk = dataBytes.slice(off, off + blocks[bi].data);
      off += blocks[bi].data;
      chunks.push(chunk);
      ecChunks.push(rsEncode(chunk, blocks[bi].total - blocks[bi].data));
    }
    var stream = [], maxD = Math.max.apply(null, chunks.map(function (c) { return c.length; }));
    for (var di = 0; di < maxD; di += 1) for (var ci = 0; ci < chunks.length; ci += 1) if (di < chunks[ci].length) stream.push(chunks[ci][di]);
    var maxE = Math.max.apply(null, ecChunks.map(function (c) { return c.length; }));
    for (var ei = 0; ei < maxE; ei += 1) for (var cj = 0; cj < ecChunks.length; cj += 1) if (ei < ecChunks[cj].length) stream.push(ecChunks[cj][ei]);

    return buildMatrix(stream, version);
  }

  var ALIGN = {1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]};

  function buildMatrix(stream, version) {
    var size = version * 4 + 17, y, x, i, j;
    var m = [], r = [];
    for (y = 0; y < size; y += 1) { m.push(new Array(size).fill(null)); r.push(new Array(size).fill(false)); }

    function finder(fx, fy) {
      for (var dy = -1; dy <= 7; dy += 1) for (var dx = -1; dx <= 7; dx += 1) {
        var cx = fx + dx, cy = fy + dy;
        if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
        r[cy][cx] = true;
        var border = dy === 0 || dy === 6 || dx === 0 || dx === 6;
        var center = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
        var inP = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        m[cy][cx] = inP ? (border || center) : false;
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    for (i = 8; i < size - 8; i += 1) {
      var tv = i % 2 === 0;
      m[6][i] = tv; r[6][i] = true; m[i][6] = tv; r[i][6] = true;
    }

    var centers = ALIGN[version];
    for (var ay = 0; ay < centers.length; ay += 1) for (var ax = 0; ax < centers.length; ax += 1) {
      var cy = centers[ay], cx = centers[ax];
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2 += 1) for (var dx2 = -2; dx2 <= 2; dx2 += 1) {
        var px = cx + dx2, py = cy + dy2;
        r[py][px] = true;
        m[py][px] = Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1;
      }
    }

    for (i = 0; i < 9; i += 1) if (i !== 6) { r[8][i] = true; r[i][8] = true; }
    for (i = 0; i < 8; i += 1) { r[8][size - 1 - i] = true; r[size - 1 - i][8] = true; }
    if (version >= 7) for (i = 0; i < 6; i += 1) for (j = 0; j < 3; j += 1) { r[size - 11 + j][i] = true; r[i][size - 11 + j] = true; }
    m[size - 8][8] = true;

    if (version >= 7) {
      var vv = version << 12;
      for (i = 17; i >= 12; i -= 1) if ((vv >> i) & 1) vv ^= 0x1f25 << (i - 12);
      var vbits = (version << 12) | vv;
      for (i = 0; i < 18; i += 1) {
        var vb = ((vbits >> i) & 1) === 1;
        m[size - 11 + (i % 3)][Math.floor(i / 3)] = vb;
        m[Math.floor(i / 3)][size - 11 + (i % 3)] = vb;
      }
    }

    var dataBits = [];
    for (i = 0; i < stream.length; i += 1) pushBit(dataBits, stream[i], 8);

    var best = null;
    for (var mask = 0; mask < 8; mask += 1) {
      var cand = m.map(function (row) { return row.slice(); });
      placeData(cand, r, dataBits, mask, size);
      placeFormat(cand, mask, size);
      var score = penalty(cand, size);
      if (!best || score < best.score) best = { score: score, m: cand };
    }
    return best.m;
  }

  function maskAt(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  function placeData(m, r, bits, mask, size) {
    var index = 0, up = true;
    for (var right = size - 1; right > 0; right -= 2) {
      if (right === 6) right -= 1;
      for (var step = 0; step < size; step += 1) {
        var y = up ? size - 1 - step : step;
        for (var k = 0; k < 2; k += 1) {
          var x = k === 0 ? right : right - 1;
          if (r[y][x]) continue;
          var bit = index < bits.length ? bits[index] === 1 : false;
          index += 1;
          m[y][x] = bit !== maskAt(mask, x, y);
        }
      }
      up = !up;
    }
  }

  function placeFormat(m, mask, size) {
    var data = mask, value = data << 10;
    for (var i = 14; i >= 10; i -= 1) if ((value >> i) & 1) value ^= 0x537 << (i - 10);
    var bits = ((data << 10) | value) ^ 0x5412;
    var c1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    var c2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
    for (var c = 0; c < 2; c += 1) {
      var pos = c === 0 ? c1 : c2;
      for (var j = 0; j < pos.length; j += 1) m[pos[j][0]][pos[j][1]] = ((bits >> (14 - j)) & 1) === 1;
    }
  }

  function penalty(m, size) {
    var score = 0, x, y, run;
    for (y = 0; y < size; y += 1) { run = 1; for (x = 1; x < size; x += 1) { if (m[y][x] === m[y][x-1]) run += 1; else { if (run >= 5) score += run - 2; run = 1; } } if (run >= 5) score += run - 2; }
    for (x = 0; x < size; x += 1) { run = 1; for (y = 1; y < size; y += 1) { if (m[y][x] === m[y-1][x]) run += 1; else { if (run >= 5) score += run - 2; run = 1; } } if (run >= 5) score += run - 2; }
    for (y = 0; y < size - 1; y += 1) for (x = 0; x < size - 1; x += 1) { var v = m[y][x]; if (v === m[y][x+1] && v === m[y+1][x] && v === m[y+1][x+1]) score += 3; }
    var dark = 0;
    for (y = 0; y < size; y += 1) for (x = 0; x < size; x += 1) if (m[y][x]) dark += 1;
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }

  /**
   * 画布几何：由矩阵尺寸算出画布边长与单模块像素。
   *
   * 单独抽出来是为了**可测**。静默区（quiet zone = 4 个模块的白边）
   * 是扫码成功率的硬条件 —— 少了它很多解码器直接读不出来，
   * 而这一点在「画布看起来还是一个二维码」时完全看不出来。
   * 所以它必须是一个能被单测断言的纯函数，而不是藏在绘制循环里的一个 var。
   */
  function qrLayout(moduleCount, target) {
    var quiet = 4;
    var scale = Math.max(2, Math.floor((target || 240) / (moduleCount + quiet * 2)));
    var px = (moduleCount + quiet * 2) * scale;
    return { quiet: quiet, scale: scale, px: px, modules: moduleCount };
  }

  /** 把矩阵画到 canvas，四周留 4 模块静默区（扫码成功率的硬条件，不能省）。 */
  function drawQr(canvas, text) {
    var matrix = encode(text);
    var size = matrix.length;
    var g = qrLayout(size, 240);
    canvas.width = g.px; canvas.height = g.px;
    canvas.setAttribute('data-qr-size', String(size));
    canvas.setAttribute('data-qr-quiet', String(g.quiet));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, g.px, g.px);
    ctx.fillStyle = '#000000';
    for (var y = 0; y < size; y += 1) for (var x = 0; x < size; x += 1) {
      if (matrix[y][x]) ctx.fillRect((x + g.quiet) * g.scale, (y + g.quiet) * g.scale, g.scale, g.scale);
    }
  }

  // ── 挂载 ──────────────────────────────────────────────────
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  function init() {
    var roots = document.querySelectorAll('[data-share]');
    if (!roots.length) return;

    Array.prototype.forEach.call(roots, function (root) {
      var url = root.getAttribute('data-share-url') || location.href;
      var title = root.getAttribute('data-share-title') || document.title;

      // 微信：点击后在原地展开二维码。用 <details> 的语义而不是自造开关 ——
      // 无 JS 时它只是一个折叠块（里面有 canvas 的容器），
      // 有 JS 时点开才画。这样「没有 JS」与「有 JS」都不会出现
      // 「点了没反应」的死按钮。
      var wechat = root.querySelector('[data-share-wechat]');
      var panel = root.querySelector('[data-share-qr]');
      if (wechat && panel) {
        wechat.addEventListener('click', function (event) {
          event.preventDefault();
          var canvas = panel.querySelector('canvas');
          if (!canvas) return;
          if (!panel.hasAttribute('data-drawn')) {
            try {
              drawQr(canvas, url);
              panel.setAttribute('data-drawn', '1');
            } catch (error) {
              // 编不出来（地址太长）时明确说清，而不是留一块白。
              panel.setAttribute('data-qr-error', error && error.message ? error.message : '生成失败');
              return;
            }
          }
          var open = panel.hasAttribute('data-open');
          if (open) panel.removeAttribute('data-open'); else panel.setAttribute('data-open', '1');
          wechat.setAttribute('aria-expanded', open ? 'false' : 'true');
        });
      }

      // 复制链接
      var copy = root.querySelector('[data-share-copy]');
      if (copy) {
        copy.addEventListener('click', function (event) {
          event.preventDefault();
          var done = function () {
            copy.setAttribute('data-copied', '1');
            // 反馈是瞬时的：按钮自己变成「已复制」，1.6s 后回退。
            // 不用 toast —— 那要往页面里插一个浮层，而这一步只是确认。
            setTimeout(function () { copy.removeAttribute('data-copied'); }, 1600);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done, function () { fallback(); });
          } else { fallback(); }
          // 老浏览器/非安全上下文没有 Clipboard API。用 execCommand 兜底，
          // 它已废弃但在 http（本地预览常见）下仍可用。
          function fallback() {
            var ta = document.createElement('textarea');
            ta.value = url;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { copy.setAttribute('data-copied', 'failed'); }
            document.body.removeChild(ta);
          }
        });
      }

      // 移动端「分享」总开关：窄屏时按钮组折叠，点这里展开。
      var toggle = root.querySelector('[data-share-toggle]');
      if (toggle) {
        toggle.addEventListener('click', function () {
          var open = root.hasAttribute('data-open');
          if (open) root.removeAttribute('data-open'); else root.setAttribute('data-open', '1');
          toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
        });
      }
    });
  }
}());
`;

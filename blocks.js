/* 积木图纸: 上传图片 -> 量化到游戏积木色板 -> 2D 搭建图纸
   遵循《积木图纸生成器说明.md》(flat2d): 每逻辑格 = 1 积木 = 2×2×2,
   unit=2, layers=1; OKLab 最近色映射, 可选抖动与小区域清理;
   导出 PNG/SVG/CSV/JSON 与游戏放置清单 */
import { getGameData } from "./engine/client.js";

const $ = (s) => document.querySelector(s);
const MAX_BLOCKS = 80;                      // 单边最大积木数(用户上限)
const DEF_BLOCKS = 40;                      // 默认图纸尺寸
const ALPHA_TH = 16 / 255;                  // alpha 低于此值视为空格

/* ---------------- 色板 ---------------- */
const RAW_COLORS = `肉粉 #E3C2A2
亮粉 #EE9CCD
桃粉 #EFA59E
珊瑚粉 #ED888E
玫粉 #F06C89
深玫粉 #CB4C66
勃艮第红 #AA3747
深酒红 #722223
亮橙红 #EF8D49
橙红 #E27B4B
珊瑚橙 #F3706A
糖果红 #E05445
粉棕 #B87357
红棕 #B15935
深红棕 #763A21
浅黄绿 #D3E486
嫩黄 #E0E564
嫩黄绿 #AEE44A
青苹果 #96CE76
豆绿 #8DC254
草绿 #56B74C
橄榄绿 #4B8F3F
深绿 #376D2C
墨绿 #35572B
春日青 #A7EABD
青绿 #88C2A5
婴儿蓝 #9FBED5
浅蓝 #7CBAE0
晴空蓝 #50A7E1
蓝紫 #503C9F
奶白蓝 #C2DDDC
蒂芙尼蓝 #9ADECC
水绿蓝 #4CBF85
青蓝 #3E9FA3
深海蓝 #0A6984
孔雀蓝 #166A66
矢车菊蓝 #668EE2
浅蓝紫 #6A73D5
宝蓝 #3443C2
普鲁士蓝 #2C3468
牛仔蓝 #113F48
墨蓝 #21203F
深蓝紫 #27113B
米白 #E3DEB4
浅米黄 #DFDEA1
月光黄 #E8DD94
陶土暖棕 #DEA451
燕麦浅棕 #DAC269
柠檬黄 #EBDC49
汽水橙 #EDB62E
浅橙棕 #E5AB73
燕麦棕 #C09843
焦糖浅棕 #B57A2D
巧克力棕 #735023
咖啡棕 #624732
深可可棕 #3F2F1A
炭棕 #2F291D
无暇白 #E9EAEA
云朵白 #DEDBCD
灰冰蓝 #C5C8C8
灰蓝 #ADB2BD
灰紫藕粉 #C7B9B0
浅灰 #A7A69C
深灰粉 #917969
深灰紫 #877C80
深灰 #6A624A
暗夜黑 #0C0E10
幻彩 #DED5E4
奶白紫 #D7C2E1
樱花紫 #D09DC2
紫藤 #BD91C9
霓虹紫 #9D65C0
葡萄紫 #77517D
茄皮紫 #452740`;

/* sRGB -> OKLab (一次预计算色板, 匹配用加权欧氏距离) */
function srgbToOklab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}
const PALETTE = RAW_COLORS.trim().split("\n").map((line, i) => {
  const [name, hex] = line.split(" ");
  const k = srgbToOklab(hex);
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return {
    id: "B" + String(i + 1).padStart(2, "0"),
    name, hex, lab: k,
    textOn: lum > 140 ? "dark" : "light",      // 图例/格内文字色
  };
});

/* ---------------- 流水线 ---------------- */
let srcBitmap = null;        // 解码后的源图(EXIF 已校正)
let cells = null;            // 当前图纸: Uint16Array, 0xFFFF=空格, 其余为色板下标
let pat = { w: DEF_BLOCKS, h: DEF_BLOCKS };
let brush = null;            // 画笔: 色板下标 | "erase" | null(未选择)
let cellsDirty = false;      // 已被手绘/导入修改, 重新生成前需确认
let view = null;             // 最近一次渲染的度量(px/pad/w/h), 画笔命中换算用

async function loadFile(file) {
  srcBitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
}

/* fit 计算源图采样区域(空隙在逻辑格侧) */
function fitRect(sw, sh, W, H, fit) {
  if (fit === "stretch") return { x: 0, y: 0, w: sw, h: sh };
  const scale = fit === "cover"
    ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const w = sw * scale, h = sh * scale;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

/* 面积加权平均: 每逻辑格对采样区域做 2×2 子采样积分(放大用 nearest) */
function sampleGrid(bitmap, W, H, fit, background, bgHex) {
  const r = fitRect(bitmap.width, bitmap.height, W, H, fit);
  const upscale = r.w < W;                        // 放大: nearest 保块感
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d", { willReadFrequently: true });
  c.imageSmoothingEnabled = !upscale;
  c.imageSmoothingQuality = "high";
  if (background !== "empty") {
    c.fillStyle = bgHex;
    c.fillRect(0, 0, W, H);
  }
  c.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, W, H);
  const img = c.getImageData(0, 0, W, H);
  const px = img.data;
  const bg = background === "custom" ? hexRgb(bgHex) : [255, 255, 255];
  const out = new Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = px[i * 4 + 3] / 255;
    if (background === "empty" && a < ALPHA_TH) { out[i] = null; continue; }
    // 半透明与底色合成, 避免边缘直接丢弃
    out[i] = [
      px[i * 4] * a + bg[0] * (1 - a),
      px[i * 4 + 1] * a + bg[1] * (1 - a),
      px[i * 4 + 2] * a + bg[2] * (1 - a),
    ];
  }
  return out;
}

function hexRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToOklab(r, g, b) {
  const c = [r / 255, g / 255, b / 255]
    .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

/* OKLab 最近色(色板色禁用集可配) */
function nearest(lab, enabled) {
  let best = -1, bd = 1e9;
  for (let k = 0; k < PALETTE.length; k++) {
    if (enabled && !enabled[k]) continue;
    const p = PALETTE[k].lab;
    const d = (lab[0] - p.L) ** 2 + (lab[1] - p.a) ** 2 + (lab[2] - p.b) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best < 0 ? 0 : best;
}

/* 4×4 Bayer 有序抖动 */
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
  .map((row) => row.map((v) => (v + 0.5) / 16 - 0.5));

function quantize(rgbArr, W, H, { dither, strength, enabled }) {
  const out = new Uint16Array(W * H);
  const err = new Float32Array(W * H * 3);        // FS 误差缓存(OKLab)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const rgb = rgbArr[i];
    if (rgb === null) { out[i] = 0xffff; continue; }
    let lab = rgbToOklab(rgb[0], rgb[1], rgb[2]);
    if (dither === "floyd_steinberg") {
      lab = [lab[0] + err[i * 3], lab[1] + err[i * 3 + 1], lab[2] + err[i * 3 + 2]];
    } else if (dither === "ordered") {
      const d = BAYER[y & 3][x & 3] * 0.12 * strength;
      lab = [lab[0] + d, lab[1] + d, lab[2] - d];
    }
    const k = nearest(lab, enabled);
    out[i] = k;
    if (dither === "floyd_steinberg") {
      const p = PALETTE[k].lab;
      const e = [lab[0] - p.L, lab[1] - p.a, lab[2] - p.b];
      const push = (xx, yy, w) => {
        if (xx < 0 || xx >= W || yy >= H) return;
        const j = (yy * W + xx) * 3;
        err[j] += e[0] * w; err[j + 1] += e[1] * w; err[j + 2] += e[2] * w;
      };
      push(x + 1, y, 7 / 16); push(x - 1, y + 1, 3 / 16);
      push(x, y + 1, 5 / 16); push(x + 1, y + 1, 1 / 16);
    }
  }
  return out;
}

/* 清理: 3×3 众数滤波 1 次 + 小连通域(<minRegion, 4连通)并入相邻占比最高色 */
function cleanup(c, W, H, minRegion) {
  const a = c.slice();
  if (minRegion > 1) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (a[i] === 0xffff) continue;
      const cnt = new Map();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const v = a[yy * W + xx];
        if (v === 0xffff) continue;
        cnt.set(v, (cnt.get(v) || 0) + 1);
      }
      let bv = a[i], bn = 0;
      for (const [v, n] of cnt) if (n > bn || (n === bn && v === a[i])) { bv = v; bn = n; }
      c[i] = bv;
    }
    // 连通域合并
    const seen = new Uint8Array(W * H);
    const stack = [];
    for (let s = 0; s < W * H; s++) {
      if (seen[s] || a[s] === 0xffff) continue;
      const color = a[s];
      const region = [];
      stack.length = 0; stack.push(s); seen[s] = 1;
      while (stack.length) {
        const i = stack.pop();
        region.push(i);
        const x = i % W, y = (i / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (!seen[j] && a[j] === color) { seen[j] = 1; stack.push(j); }
        }
      }
      if (region.length >= minRegion) continue;
      const around = new Map();                    // 相邻(含对角)非同色占比
      for (const i of region) {
        const x = i % W, y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H || (!dx && !dy)) continue;
          const j = yy * W + xx;
          const v = a[j];
          if (v !== 0xffff && v !== color) around.set(v, (around.get(v) || 0) + 1);
        }
      }
      let bv = 0xffff, bn = -1;
      for (const [v, n] of around) if (n > bn) { bv = v; bn = n; }
      for (const i of region) c[i] = bv;           // 无相邻色则并入空格
    }
  }
  return c;
}

/* ---------------- 渲染(视口模式: 画布吸顶随滚动重绘, 支持缩放) ---------------- */
const PAD = 28;                                // 行列标号区宽度
let zoom = 1;                                  // 1 = 适应容器宽度
let drawPending = false;

function baseCellPx() {
  const wrap = $("#blk-canvas-wrap");
  const avail = Math.max(140, wrap.clientWidth - 6);
  return Math.max(3, Math.floor((avail - PAD) / Math.max(pat.w, pat.h)));
}

/* 布局: 滚动容器内容尺寸 + 视口尺寸画布, 实际绘制由 drawViewport 完成 */
function renderBlueprint() {
  const wrap = $("#blk-canvas-wrap"), cv = $("#blk-canvas");
  if (!cells || !wrap) return;
  const px = Math.max(1, Math.round(baseCellPx() * zoom));
  view = { px, pad: PAD, w: pat.w * px + PAD, h: pat.h * px + PAD };
  $("#blk-sizer").style.width = view.w + "px";
  $("#blk-sizer").style.height = view.h + "px";
  const dpr = window.devicePixelRatio || 1;
  const vw = wrap.clientWidth, vh = wrap.clientHeight;
  cv.style.width = vw + "px";
  cv.style.height = vh + "px";
  cv.width = Math.round(vw * dpr);
  cv.height = Math.round(vh * dpr);
  drawViewport();
}

function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; drawViewport(); });
}

/* 只画可视区域: 任意缩放级别下位图始终为视口尺寸, 清晰且省内存 */
function drawViewport() {
  const wrap = $("#blk-canvas-wrap"), cv = $("#blk-canvas");
  if (!cells || !view) return;
  const dpr = window.devicePixelRatio || 1;
  const vw = cv.width / dpr, vh = cv.height / dpr;
  const g = cv.getContext("2d");
  const sl = wrap.scrollLeft, st = wrap.scrollTop;
  const px = view.px;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, vw, vh);
  const x0 = Math.max(0, Math.floor((sl - PAD) / px) - 1);
  const x1 = Math.min(pat.w, Math.ceil((sl + vw - PAD) / px) + 1);
  const y0 = Math.max(0, Math.floor((st - PAD) / px) - 1);
  const y1 = Math.min(pat.h, Math.ceil((st + vh - PAD) / px) + 1);
  g.save();
  g.translate(PAD - sl, PAD - st);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const v = cells[y * pat.w + x];
    if (v === 0xffff) continue;
    g.fillStyle = PALETTE[v].hex;
    g.fillRect(x * px, y * px, px, px);
  }
  if (px >= 4) {
    const gy0 = Math.max(0, y0 * px), gy1 = Math.min(pat.h * px, y1 * px);
    const gx0 = Math.max(0, x0 * px), gx1 = Math.min(pat.w * px, x1 * px);
    g.lineWidth = 1;
    g.strokeStyle = "rgba(0,0,0,.12)";
    g.beginPath();
    for (let x = x0; x <= x1; x++) { g.moveTo(x * px + .5, gy0); g.lineTo(x * px + .5, gy1); }
    for (let y = y0; y <= y1; y++) { g.moveTo(gx0, y * px + .5); g.lineTo(gx1, y * px + .5); }
    g.stroke();
    g.strokeStyle = "rgba(0,0,0,.45)";
    g.beginPath();
    for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) { g.moveTo(x * px + .5, gy0); g.lineTo(x * px + .5, gy1); }
    for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) { g.moveTo(gx0, y * px + .5); g.lineTo(gx1, y * px + .5); }
    g.stroke();
  }
  g.strokeStyle = "#221E33"; g.lineWidth = 1.5;
  g.strokeRect(-.5, -.5, pat.w * px + 1, pat.h * px + 1);
  /* 放大后格内显示颜色名: 自动缩字号, 放不下不显示; 按格色深浅选字色并加反色描边 */
  if (px >= 36) {
    g.textAlign = "center"; g.textBaseline = "middle";
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const v = cells[y * pat.w + x];
      if (v === 0xffff) continue;
      const p = PALETTE[v];
      let fs = Math.min(Math.floor(px * 0.34), 20);
      do {
        g.font = fs + "px sans-serif";
        if (g.measureText(p.name).width <= px - 3) break;
        fs--;
      } while (fs >= 9);
      if (fs < 9) continue;
      const dark = p.textOn === "dark";
      g.lineWidth = Math.max(1, fs / 16);
      g.strokeStyle = dark ? "rgba(255,255,255,.9)" : "rgba(0,0,0,.55)";
      g.fillStyle = dark ? "#101014" : "#FFFFFF";
      const cx = (x + .5) * px, cy = (y + .5) * px;
      g.strokeText(p.name, cx, cy);
      g.fillText(p.name, cx, cy);
    }
  }
  g.restore();
  /* 吸顶行列标号(视口坐标, 步长随缩放自适应) */
  if (px >= 4) {
    let step = 1;
    for (const s of [1, 2, 5, 10, 20, 50]) { step = s; if (s * px >= 34) break; }
    g.fillStyle = "#FFFFFF";
    g.fillRect(0, 0, vw, PAD - 4);
    g.fillRect(0, 0, PAD - 4, vh);
    g.fillStyle = "#221E33";
    g.font = "10px sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    for (let x = 0; x <= pat.w; x += step) {
      const sx = PAD + x * px - sl;
      if (sx < PAD - 2 || sx > vw) continue;
      g.fillText(String(x), sx, (PAD - 4) / 2);
    }
    g.textAlign = "right";
    for (let y = 0; y <= pat.h; y += step) {
      const sy = PAD + y * px - st;
      if (sy < PAD - 2 || sy > vh) continue;
      g.fillText(String(y), PAD - 8, sy);
    }
  }
}

function updateZoomLabel() {
  const el = $("#blk-zoom-val");
  if (el) el.textContent = Math.round(zoom * 100) + "%";
}

/* 最小缩放: 整张图纸完整落入可视区(全貌), 但不小于 8%; 格子像素向下取整防进位溢出 */
function minZoom() {
  const wrap = $("#blk-canvas-wrap");
  const fitPx = Math.floor((wrap.clientHeight - 10 - PAD) / Math.max(pat.w, pat.h));
  return Math.max(0.08, Math.min(1, fitPx / baseCellPx()));
}

/* 缩放并保持锚点(光标/中心)所在格不动 */
function setZoom(nz, anchor) {
  nz = Math.max(minZoom(), Math.min(20, nz));
  if (nz === zoom) { updateZoomLabel(); return; }
  const wrap = $("#blk-canvas-wrap"), cv = $("#blk-canvas");
  const r = cv.getBoundingClientRect();
  const ax = anchor ? anchor.x - r.left : wrap.clientWidth / 2;
  const ay = anchor ? anchor.y - r.top : wrap.clientHeight / 2;
  const gx = (wrap.scrollLeft + ax - PAD) / view.px;
  const gy = (wrap.scrollTop + ay - PAD) / view.px;
  zoom = nz;
  renderBlueprint();
  wrap.scrollLeft = Math.max(0, gx * view.px + PAD - ax);
  wrap.scrollTop = Math.max(0, gy * view.px + PAD - ay);
  drawViewport();
  updateZoomLabel();
}

function countsOf(c) {
  const m = new Map();
  for (const v of c) if (v !== 0xffff) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function renderLegend() {
  const rows = countsOf(cells);
  const total = rows.reduce((s, [, n]) => s + n, 0);
  $("#blk-legend").innerHTML = rows.map(([k, n]) => {
    const p = PALETTE[k];
    return `<span class="blk-lg"><i style="background:${p.hex}"></i>` +
      `${p.name}<b>${n}</b></span>`;
  }).join("") || `<span class="hint">暂无内容</span>`;
  $("#blk-summary").innerHTML =
    `图纸 <b>${pat.w}×${pat.h}</b> 格（每格 1 积木 = 2×2×2，物理 <b>${pat.w * 2}×${pat.h * 2}×2</b>）` +
    ` · 共需积木 <b>${total}</b> 颗 · 空格 <b>${pat.w * pat.h - total}</b> · 用色 <b>${rows.length}</b> 种`;
}

/* ---------------- 手绘编辑 ---------------- */
function updateBrushUI() {
  const el = $("#blk-brush");
  $("#blk-eraser").classList.toggle("primary", brush === "erase");
  document.querySelectorAll("#blk-palette .blk-chip").forEach((b) =>
    b.classList.toggle("sel", brush === +b.dataset.k));
  if (brush === "erase") {
    el.innerHTML = `画笔：<i class="blk-swatch" style="background:
      repeating-linear-gradient(45deg,#fff 0 3px,#eee 3px 6px)"></i>橡皮擦`;
  } else if (brush === null || brush === undefined) {
    el.innerHTML = `画笔：<b>未选择</b>（点下方色板选色）`;
  } else {
    const p = PALETTE[brush];
    el.innerHTML = `画笔：<i class="blk-swatch" style="background:${p.hex}"></i>` +
      `${p.name} <span class="hint">${p.id} ${p.hex}</span>`;
  }
}

/* 指针事件 -> 逻辑格坐标(画布吸顶, 需叠加滚动偏移) */
function cellFromEvent(e) {
  if (!view || !cells) return null;
  const wrap = $("#blk-canvas-wrap");
  const r = $("#blk-canvas").getBoundingClientRect();
  const lx = e.clientX - r.left + wrap.scrollLeft;
  const ly = e.clientY - r.top + wrap.scrollTop;
  const x = Math.floor((lx - PAD) / view.px);
  const y = Math.floor((ly - PAD) / view.px);
  if (x < 0 || y < 0 || x >= pat.w || y >= pat.h) return null;
  return { x, y };
}

function setCell(x, y, val) {
  const i = y * pat.w + x;
  if (cells[i] === val) return;
  cells[i] = val;
  scheduleDraw();
}

/* 两格之间补插值, 快速拖动不漏格 */
function strokeLine(a, b, val) {
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
  for (let s = 0; s <= n; s++)
    setCell(Math.round(a.x + (b.x - a.x) * s / n),
      Math.round(a.y + (b.y - a.y) * s / n), val);
}

function bindCanvasEditing() {
  const cv = $("#blk-canvas");
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  let last = null, eraseMode = false;
  cv.addEventListener("pointerdown", (e) => {
    if (!cells) return;
    const c = cellFromEvent(e);
    if (!c) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针 */ }
    eraseMode = e.button === 2 || brush === "erase";
    if (!eraseMode && brush === null) {
      $("#blk-summary").textContent = "请先在色板中选择画笔颜色（或点橡皮擦）";
      return;
    }
    last = c;
    setCell(c.x, c.y, eraseMode ? 0xffff : brush);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!last) return;
    const c = cellFromEvent(e);
    if (!c) return;
    strokeLine(last, c, eraseMode ? 0xffff : brush);
    last = c;
  });
  const finish = () => {
    if (!last) return;
    last = null;
    cellsDirty = true;
    saveState();
    drawViewport();
    renderLegend();
  };
  cv.addEventListener("pointerup", finish);
  cv.addEventListener("pointercancel", finish);
}

/* ---------------- 本地持久化(刷新/重开不丢) ---------------- */
const LS_KEY = "yimo.blocks.v1";
function saveState() {
  if (!cells) return;
  try {
    localStorage.setItem(LS_KEY,
      JSON.stringify({ w: pat.w, h: pat.h, cells: Array.from(cells) }));
  } catch { /* 存储满等异常忽略 */ }
}
function loadState() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (d && d.w && d.h && Array.isArray(d.cells) && d.cells.length === d.w * d.h) {
      pat = { w: d.w, h: d.h };
      cells = new Uint16Array(d.cells);
      $("#blk-w").value = pat.w;
      $("#blk-h").value = pat.h;
      return true;
    }
  } catch { /* 坏数据忽略 */ }
  return false;
}

/* ---------------- JSON 导入 ---------------- */
function expandRLE(rle) {
  const out = [];
  for (const [v, n] of rle) for (let i = 0; i < n; i++) out.push(v ?? null);
  return out;
}

async function importJson(file) {
  const fail = (msg) => { $("#blk-summary").textContent = "导入失败: " + msg; };
  let j;
  try { j = JSON.parse(await file.text()); }
  catch { return fail("不是合法的 JSON 文件"); }
  const w = j?.size?.w, h = j?.size?.h;
  if (!w || !h) return fail("缺少 size.w / size.h");
  if (w > MAX_BLOCKS || h > MAX_BLOCKS)
    return fail(`尺寸 ${w}×${h} 超出上限 ${MAX_BLOCKS}×${MAX_BLOCKS}`);
  let flat;
  if (Array.isArray(j.cells_rle)) flat = expandRLE(j.cells_rle);
  else if (Array.isArray(j.cells)) flat = j.cells.map((v) => (v == null || v === "" ? null : v));
  else if (Array.isArray(j.placement)) {
    flat = new Array(w * h).fill(null);
    for (const p of j.placement) {
      if (p.x < 0 || p.x >= w || p.y < 0 || p.y >= h) return fail("placement 坐标越界");
      flat[p.y * w + p.x] = p.color_id;
    }
  } else return fail("缺少 cells / cells_rle / placement 数据");
  if (flat.length !== w * h)
    return fail(`cells 长度 ${flat.length} 与尺寸 ${w}×${h} 不符`);
  const idx = new Map(PALETTE.map((p, k) => [p.id, k]));
  const arr = new Uint16Array(w * h).fill(0xffff);
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] == null) continue;
    const k = idx.get(flat[i]);
    if (k === undefined) return fail(`未知颜色 id: ${flat[i]}`);
    arr[i] = k;
  }
  pat = { w, h };
  cells = arr;
  cellsDirty = false;
  saveState();
  $("#blk-w").value = w; $("#blk-h").value = h;
  renderBlueprint();
  renderLegend();
  $("#blk-summary").innerHTML =
    `已导入 <b>${file.name}</b>（${w}×${h}），可继续用画笔编辑 · 共需积木 ` +
    `<b>${w * h - flat.filter((v) => v == null).length}</b> 颗`;
}


function download(name, blob) {
  const a = document.createElement("a");
  a.download = name;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportPng() {
  if (!cells) return;
  const px = 8, pad = 30;
  const w = pat.w * px + pad, h = pat.h * px + pad + 60;
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const g = off.getContext("2d");
  g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#57449F"; g.font = "700 16px sans-serif";
  g.fillText(`积木图纸 ${pat.w}×${pat.h}（1 格=1 积木=2×2×2）`, 14, 20);
  for (let y = 0; y < pat.h; y++) for (let x = 0; x < pat.w; x++) {
    const v = cells[y * pat.w + x];
    if (v === 0xffff) continue;
    g.fillStyle = PALETTE[v].hex;
    g.fillRect(pad + x * px, pad + y * px, px, px);
  }
  g.strokeStyle = "rgba(0,0,0,.35)";
  g.beginPath();
  for (let x = 0; x <= pat.w; x += 10) { g.moveTo(pad + x * px + .5, pad); g.lineTo(pad + x * px + .5, pad + pat.h * px); }
  for (let y = 0; y <= pat.h; y += 10) { g.moveTo(pad, pad + y * px + .5); g.lineTo(pad + pat.w * px, pad + y * px + .5); }
  g.stroke();
  /* 图例 */
  const rows = countsOf(cells);
  let lx = 14, ly = h - 46;
  g.font = "12px sans-serif";
  for (const [k, n] of rows) {
    const label = `${PALETTE[k].name}×${n}`;
    const tw = g.measureText(label).width + 20;
    if (lx + tw > w - 14) { lx = 14; ly += 18; }
    g.fillStyle = PALETTE[k].hex; g.fillRect(lx, ly - 9, 10, 10);
    g.fillStyle = "#221E33"; g.fillText(label, lx + 14, ly);
    lx += tw;
  }
  off.toBlob((b) => download(`积木图纸_${pat.w}x${pat.h}.png`, b), "image/png");
}

function exportSvg() {
  if (!cells) return;
  const px = 8, pad = 30;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${pat.w * px + pad}" height="${pat.h * px + pad}">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<text x="14" y="20" font-family="sans-serif" font-weight="700" font-size="14" fill="#57449F">积木图纸 ${pat.w}×${pat.h}（1格=1积木=2×2×2）</text>`;
  let cur = null, run = 0;
  const flush = (y, x0) => {
    if (cur === null || cur === undefined) return;
    s += `<rect x="${pad + x0 * px}" y="${pad + y * px}" width="${run * px}" height="${px}" fill="${PALETTE[cur].hex}"/>`;
  };
  for (let y = 0; y < pat.h; y++) {
    for (let x = 0; x <= pat.w; x++) {
      const v = x < pat.w ? cells[y * pat.w + x] : null;
      const key = v === 0xffff ? null : v;
      if (x > 0 && key === cur) { run++; continue; }
      flush(y, x - run);
      cur = key; run = key === null ? 0 : 1;
    }
  }
  for (let x = 0; x <= pat.w; x += 10)
    s += `<line x1="${pad + x * px}" y1="${pad}" x2="${pad + x * px}" y2="${pad + pat.h * px}" stroke="rgba(0,0,0,.35)"/>`;
  for (let y = 0; y <= pat.h; y += 10)
    s += `<line x1="${pad}" y1="${pad + y * px}" x2="${pad + pat.w * px}" y2="${pad + y * px}" stroke="rgba(0,0,0,.35)"/>`;
  s += `</svg>`;
  download(`积木图纸_${pat.w}x${pat.h}.svg`,
    new Blob([s], { type: "image/svg+xml" }));
}

function buildJson() {
  const arr = [];
  for (const v of cells) arr.push(v === 0xffff ? null : PALETTE[v].id);
  const counts = {};
  const placement = [];
  for (let y = 0; y < pat.h; y++) for (let x = 0; x < pat.w; x++) {
    const v = cells[y * pat.w + x];
    if (v === 0xffff) continue;
    const id = PALETTE[v].id;
    counts[id] = (counts[id] || 0) + 1;
    placement.push({ x, y, layer: 0, color_id: id });
  }
  return {
    version: 1, unit: 2, mode: "flat2d",
    size: { w: pat.w, h: pat.h, layers: 1 },
    physical: { width: pat.w * 2, height: pat.h * 2, depth: 2 },
    origin: "top_left", palette_id: "game_blocks",
    cells: arr, counts,
    total_blocks: placement.length,
    empty_cells: pat.w * pat.h - placement.length,
    placement,
  };
}

function exportCsv() {
  if (!cells) return;
  let s = "x,y,color_id,name\n";
  for (let y = 0; y < pat.h; y++) for (let x = 0; x < pat.w; x++) {
    const v = cells[y * pat.w + x];
    if (v === 0xffff) continue;
    s += `${x},${y},${PALETTE[v].id},${PALETTE[v].name}\n`;
  }
  download(`积木图纸_${pat.w}x${pat.h}.csv`, new Blob(["\ufeff" + s], { type: "text/csv" }));
}

function exportJson() {
  if (!cells) return;
  download(`积木图纸_${pat.w}x${pat.h}.json`,
    new Blob([JSON.stringify(buildJson(), null, 1)], { type: "application/json" }));
}

/* ---------------- UI ---------------- */
function renderPaletteChips() {
  $("#blk-palette").innerHTML = PALETTE.map((p, k) =>
    `<button type="button" class="blk-chip" data-k="${k}" title="${p.name} ${p.hex}" style="--c:${p.hex}"></button>`
  ).join("");
}

/* ---------------- 拼豆/网格图纸识别 ---------------- */
/* 源图降采样到最长边 2048 的画布, 供逐格采样 */
function bitmapCanvas() {
  const s = Math.min(1, 2048 / Math.max(srcBitmap.width, srcBitmap.height));
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(srcBitmap.width * s));
  cv.height = Math.max(1, Math.round(srcBitmap.height * s));
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.drawImage(srcBitmap, 0, 0, cv.width, cv.height);
  return cv;
}

/* 自动定位网格区域: 图案纸面为中性浅色(红蓝差小), 珠子为鲜艳色或深色文字;
   米色表头/页边暖白红蓝差大且无鲜艳色, 被排除; 取行列上最长内容带(允许小断缝) */
function detectGridRect(px, w, h) {
  const paperC = (r, g, b) => Math.abs(r - b) <= 12 && Math.abs(r - g) <= 8 && r > 228;
  const vividC = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 45;
  const span = (frac, total) => {
    const runs = []; let s = -1;
    for (let i = 0; i < total; i++) {
      if (frac[i] >= 0.12) { if (s < 0) s = i; }
      else if (s >= 0) { runs.push([s, i - 1]); s = -1; }
    }
    if (s >= 0) runs.push([s, total - 1]);
    const gap = Math.max(12, Math.round(total * 0.02));
    const merged = [];
    for (const r of runs) {
      if (merged.length && r[0] - merged[merged.length - 1][1] <= gap)
        merged[merged.length - 1][1] = r[1];
      else merged.push([...r]);
    }
    merged.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    return (merged[0] && merged[0][1] - merged[0][0] > total * 0.25)
      ? merged[0] : [0, total - 1];
  };
  const colFrac = new Float32Array(w), rowFrac = new Float32Array(h);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (paperC(px[i], px[i + 1], px[i + 2]) || vividC(px[i], px[i + 1], px[i + 2])) n++;
    }
    colFrac[x] = n / h;
  }
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (paperC(px[i], px[i + 1], px[i + 2]) || vividC(px[i], px[i + 1], px[i + 2])) n++;
    }
    rowFrac[y] = n / w;
  }
  const [x0, x1] = span(colFrac, w);
  const [y0, y1] = span(rowFrac, h);
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/* 逐格采样: 每格 7×7 取样点 -> 色板最近色众数;
   众数为中性白且格内无编号文字(与众数色距>0.16 的样点<3)时视为空格 */
function gridSample(W, H, enabled) {
  const cv = bitmapCanvas();
  const g = cv.getContext("2d");
  const px = g.getImageData(0, 0, cv.width, cv.height).data;
  const rect = detectGridRect(px, cv.width, cv.height);
  rect.x0 += Math.max(0, +$("#blk-ml").value || 0);
  rect.y0 += Math.max(0, +$("#blk-mt").value || 0);
  rect.x1 -= Math.max(0, +$("#blk-mr").value || 0);
  rect.y1 -= Math.max(0, +$("#blk-mb").value || 0);
  if (rect.x1 - rect.x0 < W || rect.y1 - rect.y0 < H) {
    $("#blk-summary").textContent =
      `识别到的网格区域过小（${rect.x1 - rect.x0}×${rect.y1 - rect.y0}px），请调整裁边后重试`;
    return null;
  }
  const cw = (rect.x1 - rect.x0) / W, ch = (rect.y1 - rect.y0) / H;
  const out = new Uint16Array(W * H);
  const tally = new Array(PALETTE.length);
  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
    tally.fill(0);
    let n = 0;
    for (let sy = 0; sy < 7; sy++) for (let sx = 0; sx < 7; sx++) {
      const fx = Math.round(rect.x0 + (cx + 0.12 + 0.76 * sx / 6) * cw);
      const fy = Math.round(rect.y0 + (cy + 0.12 + 0.76 * sy / 6) * ch);
      if (fx < 0 || fy < 0 || fx >= cv.width || fy >= cv.height) continue;
      const i = (fy * cv.width + fx) * 4;
      if (px[i + 3] < 16) continue;
      tally[nearest(rgbToOklab(px[i], px[i + 1], px[i + 2]), enabled)]++;
      n++;
    }
    if (!n) { out[cy * W + cx] = 0xffff; continue; }
    let k = 0, best = -1;
    for (let t = 0; t < tally.length; t++) if (tally[t] > best) { best = tally[t]; k = t; }
    /* 编号文字检测: 与众数色明显不同的样点数 */
    let off = 0;
    const mp = PALETTE[k].lab;
    for (let sy = 0; sy < 7; sy++) for (let sx = 0; sx < 7; sx++) {
      const fx = Math.round(rect.x0 + (cx + 0.12 + 0.76 * sx / 6) * cw);
      const fy = Math.round(rect.y0 + (cy + 0.12 + 0.76 * sy / 6) * ch);
      if (fx < 0 || fy < 0 || fx >= cv.width || fy >= cv.height) continue;
      const i = (fy * cv.width + fx) * 4;
      if (px[i + 3] < 16) continue;
      const l = rgbToOklab(px[i], px[i + 1], px[i + 2]);
      if ((l[0] - mp.L) ** 2 + (l[1] - mp.a) ** 2 + (l[2] - mp.b) ** 2 > 0.16 * 0.16) off++;
    }
    const hex = PALETTE[k].hex, nn = parseInt(hex.slice(1), 16);
    const r = (nn >> 16) & 255, gg = (nn >> 8) & 255, b = nn & 255;
    const paperLike = Math.min(r, gg, b) > 225 && Math.max(r, gg, b) - Math.min(r, gg, b) <= 10;
    out[cy * W + cx] = (paperLike && off < 3) ? 0xffff : k;
  }
  return out;
}

function generate() {
  if (!srcBitmap) { $("#blk-summary").textContent = "请先上传图片（或直接导入 JSON / 用画笔绘制）"; return; }
  if (cellsDirty && !confirm("当前图纸已被修改，重新生成将覆盖这些改动，继续？")) return;
  const W = Math.max(1, Math.min(MAX_BLOCKS, +$("#blk-w").value || DEF_BLOCKS));
  const H = Math.max(1, Math.min(MAX_BLOCKS, +$("#blk-h").value || DEF_BLOCKS));
  $("#blk-w").value = W; $("#blk-h").value = H;
  pat = { w: W, h: H };
  const enabled = new Array(PALETTE.length).fill(true);
  let disabledN = 0;
  document.querySelectorAll("#blk-palette .blk-chip").forEach((b) => {
    if (b.classList.contains("off")) { enabled[+b.dataset.k] = false; disabledN++; }
  });
  if (disabledN >= PALETTE.length) { $("#blk-summary").textContent = "色板已全部禁用"; return; }
  if ($("#blk-grid").checked) {                 // 拼豆/网格图纸模式
    const g = gridSample(W, H, enabled);
    if (g === null) return;
    cells = g;
    cellsDirty = false;
    saveState();
    renderBlueprint();
    renderLegend();
    return;
  }
  const rgbArr = sampleGrid(srcBitmap, W, H, "stretch",
    document.querySelector('input[name=blk-bg]:checked').value,
    $("#blk-bg-hex").value);
  let c = quantize(rgbArr, W, H, { dither: "off", strength: 0, enabled });
  if ($("#blk-cleanup").checked)
    c = cleanup(c, W, H, Math.max(1, +$("#blk-min-region").value || 2));
  cells = c;
  cellsDirty = false;                          // 已按当前参数重建, 后续调参不再提示覆盖
  saveState();
  renderBlueprint();
  renderLegend();
}

function bindEvents() {
  $("#blk-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await loadFile(f);
      $("#blk-fname").textContent = `${f.name}（${srcBitmap.width}×${srcBitmap.height}）`;
      generate();
    } catch (err) {
      $("#blk-summary").textContent = "图片解码失败: " + err.message;
    }
  });
  ["#blk-w", "#blk-h", "#blk-cleanup", "#blk-min-region",
    "#blk-mt", "#blk-mb", "#blk-ml", "#blk-mr"].forEach((s) =>
    $(s).addEventListener("change", () => { if (srcBitmap) generate(); }));   // change: 输入确认后才重建, 避免逐键触发
  $("#blk-grid").addEventListener("change", (e) => {
    $("#blk-grid-row").classList.toggle("hidden", !e.target.checked);
    $("#blk-cleanup").disabled = e.target.checked;      // 网格模式逐格取色, 无需清理
    $("#blk-min-region").disabled = e.target.checked;
    if (srcBitmap) generate();
  });
  document.querySelectorAll('input[name=blk-bg]').forEach((r) =>
    r.addEventListener("change", () => {
      $("#blk-bg-hex").disabled =
        document.querySelector('input[name=blk-bg]:checked').value === "empty";
      if (srcBitmap) generate();
    }));
  $("#blk-bg-hex").addEventListener("input", () => { if (srcBitmap) generate(); });
  $("#blk-palette").addEventListener("click", (e) => {     // 左键: 选画笔
    const b = e.target.closest(".blk-chip");
    if (!b) return;
    brush = +b.dataset.k;
    updateBrushUI();
  });
  $("#blk-palette").addEventListener("contextmenu", (e) => { // 右键: 禁用/恢复该色
    const b = e.target.closest(".blk-chip");
    if (!b) return;
    e.preventDefault();
    b.classList.toggle("off");
    if (srcBitmap) generate();
  });
  $("#blk-eraser").addEventListener("click", () => {
    brush = brush === "erase" ? null : "erase";
    updateBrushUI();
  });
  $("#blk-clear").addEventListener("click", () => {
    if (!cells) return;
    if (!confirm("清空当前图纸的所有积木？")) return;
    cells.fill(0xffff);
    cellsDirty = true;
    saveState();
    renderBlueprint();
    renderLegend();
  });
  $("#blk-json").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) await importJson(f);
  });
  /* 缩放: 按钮 / Ctrl+滚轮(锚点=光标) / 适应宽度 */
  $("#blk-zoom-in").addEventListener("click", () => setZoom(zoom * 1.35, null));
  $("#blk-zoom-out").addEventListener("click", () => setZoom(zoom / 1.35, null));
  $("#blk-zoom-reset").addEventListener("click", () => {
    zoom = 1;
    renderBlueprint();
    updateZoomLabel();
  });
  const wrap = $("#blk-canvas-wrap");
  wrap.addEventListener("scroll", scheduleDraw);
  wrap.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  window.addEventListener("resize", () => renderBlueprint());
  bindCanvasEditing();
  $("#blk-gen").addEventListener("click", generate);
  $("#blk-exp-png").addEventListener("click", exportPng);
  $("#blk-exp-svg").addEventListener("click", exportSvg);
  $("#blk-exp-csv").addEventListener("click", exportCsv);
  $("#blk-exp-json").addEventListener("click", exportJson);
}

let inited = false;
export function initBlocks() {
  if (inited) { renderBlueprint(); return; }   // 再次进入页签时按当前容器宽度重排
  inited = true;
  renderPaletteChips();
  bindEvents();
  const restored = !cells && loadState();      // 恢复上次编辑的图纸
  if (!cells) cells = new Uint16Array(DEF_BLOCKS * DEF_BLOCKS).fill(0xffff);
  renderBlueprint();
  renderLegend();
  updateBrushUI();
  updateZoomLabel();
  $("#blk-summary").textContent = restored
    ? `已恢复上次编辑的图纸（${pat.w}×${pat.h}），可继续编辑、重新生成或导出`
    : "上传图片、导入 JSON，或直接用画笔在空白图纸上绘制（1 格 = 1 积木 = 2×2×2）";
}

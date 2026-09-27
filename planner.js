/* 家园规划: 320x320 游戏单位的网格画布上摆放建筑
   网格基准 1 单位/格, 土地 4x4 块(各 80x80 格);
   建筑可旋转、可跨土地格(但所有覆盖格必须在已解锁土地上);
   日光灯/热能炉/制冷机有 36x36 影响范围, 光照独立于温度(温度=范围内取值求和);
   电力系统: 噼啪发电桩(8x8, 覆盖44x44, 发电600W)与噼啪电线杆(6x6, 覆盖28x28)
   依靠覆盖区任意 1 格重合联通中转; 用电建筑任意 1 格与联通覆盖重合即通电;
   光照与温度影响作物生长效率, 不构成种植门槛;
   画布支持缩放(滚轮/按钮)与平移(空白处拖动) */
import { getGameData } from "./engine/client.js";

const UNIT = 1;                    // 每格游戏单位
const PLOT_CELLS = 80;             // 每块土地的格数(80 单位)
const GRID = PLOT_CELLS * 4;       // 全图 320x320 格
const PX = 2;                      // 每格像素(基础视图)
const CANVAS = GRID * PX;          // 640

/* 视图: scale 缩放, ox/oy 平移(基础画布像素) */
const view = { scale: 1, ox: 0, oy: 0 };
const MAX_SCALE = 8;
const MIN_SCALE = 0.25;              // 允许缩小到 25% 看全貌
function clampView() {
  const m = CANVAS * view.scale;
  if (m <= CANVAS) {                 // 视图小于画布: 居中
    view.ox = (CANVAS - m) / 2;
    view.oy = (CANVAS - m) / 2;
  } else {
    view.ox = Math.min(0, Math.max(CANVAS - m, view.ox));
    view.oy = Math.min(0, Math.max(CANVAS - m, view.oy));
  }
}
function zoomAt(bx, by, k) {
  const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * k));
  k = ns / view.scale;
  view.ox = bx - (bx - view.ox) * k;
  view.oy = by - (by - view.oy) * k;
  view.scale = ns;
  clampView();
  updateZoomLabel();
  draw();
}
function updateZoomLabel() {
  const el = $("#plan-zoom-val");
  if (el) el.textContent = Math.round(view.scale * 100) + "%";
}

const PALETTE = ["#1D4ED8", "#C2410C", "#0F766E", "#7C3AED", "#BE185D",
  "#4D7C0F", "#92400E", "#0E7490", "#6D28D9", "#B91C1C", "#475569",
  "#A16207", "#15803D", "#86198F", "#9A3412", "#1E3A8A", "#0F766E",
  "#BE185D", "#92400E", "#6D28D9", "#4D7C0F", "#C2410C", "#15803D"];
const colorCache = {};
const colorOf = (name) => {
  if (!(name in colorCache))
    colorCache[name] = PALETTE[Object.keys(colorCache).length % PALETTE.length];
  return colorCache[name];
};

let GD = null;                      // game_data
let userCounts = null;              // 生产计算页登记的建筑数量(覆盖等级默认)
const plan = { level: 10, items: [] };   // items: {id,name,x,y,w,h,mode?}
let nextId = 1;
let sel = null;                     // 面板选中的建筑名
let selRot = false;                 // 面板放置时的旋转
let drag = null;                    // {item, dx, dy, moved, ox, oy}
let delMode = false;
let showZones = true;
let cropColorMode = false;
let lastTouched = null;             // R 旋转作用对象
let hoverInfo = "";
let pickerFor = null;               // 正在指定作物的建筑

const TEMP_LABEL = { 2: "炎热", 1: "温暖", 0: "", "-1": "凉爽", "-2": "冰冻" };

/* 温度设备: 模式 -> 生成的效果图标文件(static/icons/fx-*.png, 生图API产出) */
const DEVICE_ICONS = {
  日光灯: { "": "fx-light" },
  热能炉: { "温暖": "fx-warm", "炎热": "fx-hot" },
  制冷机: { "凉爽": "fx-cool", "冰冻": "fx-freeze" },
};
/* 需求缺口 -> 用于角标的效果图标 */
const REQ_ICON = { 光照: "fx-light", 温暖: "fx-warm", 炎热: "fx-hot", 凉爽: "fx-cool", 冰冻: "fx-freeze" };
const ICON_CACHE = {};
function iconImg(file) {
  if (!ICON_CACHE[file]) {
    const im = new Image();
    im.onload = () => draw();                    // 异步加载完重绘
    im.src = "./icons/" + file + ".png";
    ICON_CACHE[file] = im;
  }
  return ICON_CACHE[file];
}

const $ = (s) => document.querySelector(s);
const canvas = () => $("#plan-canvas");
const ctx = () => canvas().getContext("2d");

/* ---------------- 几何 ---------------- */
function unlockedPlots() {
  const s = new Set();
  for (const l of GD.land_unlock)
    if (l.level <= plan.level) s.add(l.x + "," + l.y);
  return s;
}
function onUnlocked(x, y, w, h) {
  const plots = unlockedPlots();
  for (let px = Math.floor(x / PLOT_CELLS); px <= Math.floor((x + w - 1) / PLOT_CELLS); px++)
    for (let py = Math.floor(y / PLOT_CELLS); py <= Math.floor((y + h - 1) / PLOT_CELLS); py++)
      if (!plots.has(px + "," + py)) return false;
  return true;
}
function fits(item, nx, ny, ignoreId) {
  if (nx < 0 || ny < 0 || nx + item.w > GRID || ny + item.h > GRID) return false;
  if (!onUnlocked(nx, ny, item.w, item.h)) return false;
  for (const o of plan.items)
    if (o.id !== ignoreId &&
        nx < o.x + o.w && o.x < nx + item.w &&
        ny < o.y + o.h && o.y < ny + item.h) return false;
  return true;
}

/* 影响范围: 36x36 单位=18x18 格, 以建筑中心为中心 */
function zones() {
  const out = [];
  for (const it of plan.items) {
    const eff = GD.building_effects[it.name];
    if (!eff) continue;
    const half = Math.round(eff.range / UNIT / 2);           // 18 格
    const zx = Math.round(it.x + it.w / 2 - half);
    const zy = Math.round(it.y + it.h / 2 - half);
    const z = { name: it.name, x: zx, y: zy, w: half * 2, h: half * 2 };
    if (eff.effect === "光照") z.light = true;
    else if (eff.effect === "电力") {
      z.power = true;
      z.gen = (it.mode != null && eff.modes) ? (eff.modes[it.mode] || 0) : 0;
    }
    else z.temp = it.mode != null ? eff.modes[it.mode] : 0;
    out.push(z);
  }
  return out;
}

/* 电力系统: 发电桩产生覆盖, 电线杆覆盖与发电桩/已联通电线杆任意 1 格重合即联通;
   用电建筑任意 1 格与联通覆盖重合即接入电网, 全部接入, 无分配取舍;
   实时效率 = min(120%, 总供电 ÷ 接入总功耗) —— 冗余 ≥20% 时为 120% */
function powerState() {
  const gens = [], poles = [];
  for (const it of plan.items) {
    const eff = GD.building_effects[it.name];
    if (!eff || eff.effect !== "电力") continue;
    const half = Math.round(eff.range / UNIT / 2);
    const cov = {
      x: Math.round(it.x + it.w / 2 - half),
      y: Math.round(it.y + it.h / 2 - half),
      w: half * 2, h: half * 2, it,
    };
    (z_genW(eff, it) > 0 ? gens : poles).push(cov);
  }
  const conn = gens.map((g) => g);               // 联通覆盖(含发电桩)
  const done = new Set();
  let changed = true;
  while (changed) {                              // 电线杆中转泛洪
    changed = false;
    poles.forEach((p, i) => {
      if (!done.has(i) && conn.some((c) => hit(c, p))) {
        conn.push(p); done.add(i); changed = true;
      }
    });
  }
  const connPoles = poles.filter((_, i) => done.has(i));
  const discPoles = poles.filter((_, i) => !done.has(i));
  const genW = gens.reduce((s, g) => s + z_genW(GD.building_effects[g.it.name], g.it), 0);
  const raws = rawMatBuildings();
  const candidates = [];                         // 覆盖内耗电建筑(仅需要原材料者)
  for (const it of plan.items) {
    const w = GD.building_powers && GD.building_powers[it.name];
    if (!w || !raws.has(it.name)) continue;      // 不需要原材料的建筑永不接入电网
    if (conn.some((c) => hit(it, c))) candidates.push({ it, w });
  }
  /* 接入负载不超过总供电; 在此范围内接入座数越多越好(小功耗优先贪心) */
  const order = [...candidates].sort((a, b) => a.w - b.w || a.it.id - b.it.id);
  const fed = new Set();
  let usedW = 0;
  for (const c of order) {
    if (usedW + c.w <= genW + 1e-9) { fed.add(c.it.id); usedW += c.w; }
  }
  const eff = usedW > 0 ? Math.min(1.2, genW / usedW) : 0;    // 实时效率
  const consumers = plan.items.filter((it) => GD.building_powers && GD.building_powers[it.name]);
  return { gens, poles, conn, connPoles, discPoles, candidates, fed, usedW, genW, eff, consumers };
}
function z_genW(eff, it) {
  return (it.mode != null && eff.modes) ? (eff.modes[it.mode] || 0) : 0;
}
/* 需要原材料的建筑(配方含输入) —— 只有这类建筑接入电网(用户设定),
   水井/矿山/游玩类等不需要原材料的建筑不接入 */
let rawMatCache = null;
function rawMatBuildings() {
  if (!rawMatCache)
    rawMatCache = new Set((GD.recipes || [])
      .filter((r) => (r.inputs || []).length).map((r) => r.building));
  return rawMatCache;
}
const hit = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/* 电力悬停提示: 发电桩/电线杆显示联通状态, 用电建筑显示接入与实时效率 */
function powerTag(it) {
  const eff = GD.building_effects[it.name];
  if (eff && eff.effect === "电力") {
    const w = z_genW(eff, it);
    if (w > 0) return ` · ⚡发电 ${w}W · 覆盖 ${eff.range}×${eff.range}`;
    const ps = powerState();
    return ps.connPoles.some((p) => p.it === it)
      ? " · ⚡已联通（中转供电）"
      : " · ⚠ 未联通电网（需与发电桩或其他已联通电线杆覆盖重合）";
  }
  const w = GD.building_powers && GD.building_powers[it.name];
  if (!w || !rawMatBuildings().has(it.name)) return "";   // 不需要原材料永不接入
  const ps = powerState();
  const on = ps.candidates.some((c) => c.it.id === it.id);
  return on
    ? ` · ⚡通电 效率${Math.round(ps.eff * 100)}% -${w}W`
    : " · ⚡未接电（发电覆盖区外，手动模式 100%）";
}

/* 建筑获得的效果: 任意 1 格落在范围内即生效, 仅对田地/林地有意义 */
function effectOf(item) {
  const zs = zones().filter((z) => hit(item, z));
  return {
    light: zs.some((z) => z.light),
    temp: Math.max(-2, Math.min(2, zs.reduce((s, z) => s + (z.temp || 0), 0))),
  };
}

/* 作物需求校验: 有作物且有需求时, 光照需在场、温度需等于目标状态;
   返回 {req, met, missing[]} —— 满足时画面无变化, 不满足标红示警 */
function reqStatus(item) {
  const none = { req: null, met: true, missing: [] };
  if ((item.name !== "田地" && item.name !== "林地") || !item.crop) return none;
  const req = GD.crop_requirements && GD.crop_requirements[item.crop.name];
  if (!req) return none;
  const e = effectOf(item);
  const missing = [];
  if (req.light && !e.light) missing.push("光照");
  if (req.temp != null && e.temp !== req.temp) missing.push(TEMP_LABEL[req.temp]);
  return { req, met: !missing.length, missing };
}

/* ---------------- 渲染 ---------------- */
const cy2px = (y) => (GRID - y) * PX;          // 游戏 y 向上 -> 画布向下

function draw() {
  const cv = canvas();
  const c = ctx();
  c.setTransform(cv.width / CANVAS, 0, 0, cv.width / CANVAS, 0, 0);   // 适配画布实际分辨率
  c.clearRect(0, 0, CANVAS, CANVAS);
  c.save();
  c.translate(view.ox, view.oy);
  c.scale(view.scale, view.scale);
  const plots = unlockedPlots();
  /* 土地底色 */
  for (let px = 0; px < 4; px++)
    for (let py = 0; py < 4; py++) {
      const x = px * PLOT_CELLS * PX, y = (3 - py) * PLOT_CELLS * PX;
      c.fillStyle = plots.has(px + "," + py) ? "#FDFCFF" : "#E9E7F0";
      c.fillRect(x, y, PLOT_CELLS * PX, PLOT_CELLS * PX);
      c.strokeStyle = plots.has(px + "," + py) ? "#C9C2E3" : "#D8D5E5";
      c.lineWidth = 2;
      c.strokeRect(x + 1, y + 1, PLOT_CELLS * PX - 2, PLOT_CELLS * PX - 2);
      if (!plots.has(px + "," + py)) {           // 未解锁: 斜线纹
        c.save();
        c.beginPath();
        c.rect(x, y, PLOT_CELLS * PX, PLOT_CELLS * PX);
        c.clip();
        c.strokeStyle = "#D5D2E4"; c.lineWidth = 1;
        for (let i = -PLOT_CELLS * PX; i < PLOT_CELLS * PX; i += 12) {
          c.beginPath(); c.moveTo(x + i, y + PLOT_CELLS * PX); c.lineTo(x + i + PLOT_CELLS * PX, y); c.stroke();
        }
        c.restore();
      }
    }
  /* 网格: 每 4 单位一格(加粗), 放大后追加 1x1 细格 */
  c.strokeStyle = "#E3E0F0"; c.lineWidth = 1;
  c.beginPath();
  for (let i = 4; i < GRID; i += 4) {
    if (i % PLOT_CELLS === 0) continue;
    c.moveTo(i * PX, 0); c.lineTo(i * PX, CANVAS);
    c.moveTo(0, i * PX); c.lineTo(CANVAS, i * PX);
  }
  c.stroke();
  if (view.scale >= 2) {
    c.strokeStyle = "#F1EFF8";
    c.beginPath();
    for (let i = 1; i < GRID; i++) {
      if (i % 4 === 0) continue;
      c.moveTo(i * PX, 0); c.lineTo(i * PX, CANVAS);
      c.moveTo(0, i * PX); c.lineTo(CANVAS, i * PX);
    }
    c.stroke();
  }
  /* 影响范围 */
  if (showZones) {
    const ps = powerState();
    for (const z of zones()) {
      if (z.power) {                           // 电力覆盖: 联通绿 / 未联通灰
        const on = ps.conn.some((c2) => hit(c2, z));
        c.fillStyle = on ? "rgba(22,163,74,.09)" : "rgba(100,116,139,.07)";
        c.fillRect(z.x * PX, cy2px(z.y + z.h), z.w * PX, z.h * PX);
        c.strokeStyle = on ? "rgba(22,163,74,.5)" : "rgba(100,116,139,.4)";
        c.setLineDash([5, 4]); c.lineWidth = 1;
        c.strokeRect(z.x * PX, cy2px(z.y + z.h), z.w * PX, z.h * PX);
        c.setLineDash([]);
        continue;
      }
      c.fillStyle = z.light ? "rgba(246,169,60,.13)"
        : z.temp > 0 ? "rgba(226,97,97,.11)" : "rgba(82,157,231,.11)";
      c.fillRect(z.x * PX, cy2px(z.y + z.h), z.w * PX, z.h * PX);
      c.strokeStyle = z.light ? "rgba(246,169,60,.5)"
        : z.temp > 0 ? "rgba(226,97,97,.45)" : "rgba(82,157,231,.45)";
      c.setLineDash([5, 4]); c.lineWidth = 1;
      c.strokeRect(z.x * PX, cy2px(z.y + z.h), z.w * PX, z.h * PX);
      c.setLineDash([]);
    }
  }
  /* 建筑 */
  for (const it of plan.items) {
    const ok = onUnlocked(it.x, it.y, it.w, it.h);
    let fill = ok ? colorOf(it.name) : "#DC2626";
    if (cropColorMode && it.crop && ok) fill = colorOf("作物:" + it.crop.name);
    drawItem(it, fill, 1);
  }
  /* 拖拽幽灵 */
  if (drag && drag.moved) {
    const ok = fits(drag.item, drag.item.x, drag.item.y, drag.item.id);
    drawItem(drag.item, ok ? "#16A34A" : "#DC2626", 0.45);
  }
  c.restore();
  $("#plan-info").textContent = hoverInfo;
}

/* 地块渲染体系(Bento/极简): 类别色只作描边与浅底(16%色+84%白), 深色字替代白字阴影 */
const pastelCache = {};
function pastelOf(hex) {
  if (!pastelCache[hex]) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (v) => Math.round(v * 0.16 + 255 * 0.84);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    pastelCache[hex] = { fill: `rgb(${mix(r)},${mix(g)},${mix(b)})` };
  }
  return pastelCache[hex];
}
function rrect(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
}

function drawItem(it, color, alpha) {
  const c = ctx();
  const x = it.x * PX, y = cy2px(it.y + it.h), w = it.w * PX, h = it.h * PX;
  const rad = Math.max(1, Math.min(3, w * 0.16, h * 0.16));
  c.globalAlpha = alpha;
  rrect(c, x + .5, y + .5, w - 1, h - 1, rad);
  c.fillStyle = pastelOf(color).fill;
  c.fill();
  c.lineWidth = 1.5;
  c.strokeStyle = color;
  c.stroke();
  if (lastTouched && lastTouched.id === it.id) {         // 选中: 品牌紫内圈
    rrect(c, x + 2.5, y + 2.5, w - 5, h - 5, Math.max(0, rad - 2));
    c.strokeStyle = "#57449F"; c.lineWidth = 1.5;
    c.stroke();
  }
  c.globalAlpha = 1;
  /* 需求缺口角标: 右上角透明PNG图标(光/热/冷), 画在文字层之下 */
  const st = reqStatus(it);
  if (st.req && !st.met) {
    const d = Math.max(7, Math.min(12, w * 0.45, h * 0.45));
    const n = Math.min(2, st.missing.length);
    st.missing.slice(0, n).forEach((m, k) => {
      const im = iconImg(REQ_ICON[m]);
      if (im.complete && im.naturalWidth)
        c.drawImage(im, x + w - n * d + k * d - 1, y + 1, d, d);
    });
  }
  /* 设备建筑: 只显示效果图标, 不显示名字 */
  const modesDev = DEVICE_ICONS[it.name];
  if (modesDev) {
    const file = modesDev[it.mode] || Object.values(modesDev)[0];
    const im = iconImg(file);
    if (im.complete && im.naturalWidth) {
      const pad = Math.max(1, Math.min(w, h) * 0.12);
      c.drawImage(im, x + pad, y + pad, w - 2 * pad, h - 2 * pad);
    }
    return;
  }
  /* 文字: 全名、深色、无底板; 按实测文字宽度收缩字号, 必不出矩形,
     单行过小且高度放得下时对半折两行 */
  const full = it.crop ? it.crop.name : it.name;
  const fitFont = (lines) => {
    let fs = Math.min(10, (h - 2.5) / lines.length * 0.92);
    c.font = "600 " + fs.toFixed(2) + "px sans-serif";
    const tw = Math.max(...lines.map((l) => c.measureText(l).width));
    if (tw > w - 2.5) fs *= (w - 2.5) / tw;
    return fs;
  };
  let lines = [full];
  let fs = fitFont(lines);
  if (fs < 3.4 && full.length >= 3) {
    const half = Math.ceil(full.length / 2);
    const cand = [full.slice(0, half), full.slice(half)];
    const fs2 = fitFont(cand);
    if (fs2 > fs) { lines = cand; fs = fs2; }
  }
  c.fillStyle = "#221E33";
  c.font = "600 " + fs.toFixed(2) + "px sans-serif";
  c.textAlign = "center"; c.textBaseline = "middle";
  lines.forEach((l, i) =>
    c.fillText(l, x + w / 2, y + h / 2 + (i - (lines.length - 1) / 2) * fs * 1.12));
}

/* ---------------- 面板/统计 ---------------- */
function sizeOf(name) { return GD.building_sizes[name]; }
/* 该等级是否有完整官方解锁数据(含田地/林地计数的等级包);
   有则自动填入对应数额(优先于用户登记), 没有则依赖用户输入 */
function fullLevelCounts() {
  const m = GD.level_counts[String(plan.level)];
  return (m && m["田地"] != null && m["林地"] != null) ? m : null;
}
function limitOf(name) {
  const full = fullLevelCounts();
  if (full) return full[name];                 // 10/11/12 级: 官方数量自动填入
  const uc = userCounts && userCounts[name];
  if (uc != null) return uc;                   // 计算页登记数量优先
  const m = GD.level_counts[String(plan.level)];
  return m ? m[name] : undefined;             // undefined = 数量不限(暂定)
}
function placedCount(name) { return plan.items.filter((i) => i.name === name).length; }

function renderPalette() {
  const bar = $("#plan-palette");
  bar.innerHTML = Object.keys(GD.building_sizes)
    .filter((n) => sizeOf(n))                  // 尺寸未知的暂不可放置
    .map((n) => {
      const [w, h] = sizeOf(n);
      const lim = limitOf(n);
      const cnt = placedCount(n);
      const over = lim != null && cnt > lim;
      const cls = "pchip" + (sel === n ? " on" : "") + (over ? " over" : "");
      return `<button type="button" class="${cls}" data-b="${n}">` +
        `<b>${n}</b><span>${w}×${h}</span>` +
        `<i>${lim == null ? "∞" : cnt + "/" + lim}</i></button>`;
    }).join("");
}

function renderStats() {
  const n = plan.items.length;
  const bad = plan.items.filter((i) => !onUnlocked(i.x, i.y, i.w, i.h)).length;
  const farms = plan.items.filter((i) => i.name === "田地" || i.name === "林地");
  const unmet = farms.filter((i) => {
    const st = reqStatus(i);
    return st.req && !st.met;
  });
  const ps = powerState();
  const lvCounts = GD.level_counts[String(plan.level)] || {};
  const availGen = lvCounts["噼啪发电桩"] || 0;
  const availPole = lvCounts["噼啪电线杆"] || 0;
  $("#plan-stats").innerHTML =
    `已放置 <b>${n}</b> 座建筑` +
    (bad ? `，<span class="bad">⚠ ${bad} 座压在未解锁土地上</span>` : "") +
    (farms.length ? `；田地+林地 <b>${farms.length}</b> 座，已指定作物 ${farms.filter((i) => i.crop).length} 座` : "") +
    (unmet.length ? `，<span class="bad">⚠ ${unmet.length} 座作物需求未满足</span>` : "") +
    (ps.consumers.length || ps.gens.length
      ? `；⚡ 发电 <b>${ps.genW}W</b>，接入 <b>${ps.candidates.length}</b> 座（负载 ${ps.usedW}W），` +
        `效率 <b>${Math.round(ps.eff * 100)}%</b>` +
        (ps.eff > 0 && ps.eff < 1 ? ` <span class="bad">⚠ 已低于手动模式</span>` : "")
      : availGen > 0
        ? `；⚡ 本级可建噼啪发电桩 ×${availGen}、噼啪电线杆 ×${availPole}` +
          `（在左侧建筑面板选中后于图上点击摆放，覆盖内的用电建筑自动接入）`
        : "");
}

/* ---------------- 交互 ---------------- */
function cellFromEvent(e) {
  const r = canvas().getBoundingClientRect();
  const css = CANVAS / r.width;                     // css 像素 -> 基础画布像素
  const bx = (e.clientX - r.left) * css;
  const by = (e.clientY - r.top) * css;
  const gx = (bx - view.ox) / view.scale / PX;      // -> 基础网格像素 -> 格
  const gy = (by - view.oy) / view.scale / PX;
  return { x: Math.floor(gx), y: Math.floor(GRID - gy) };
}
function baseFromEvent(e) {                          // 用于缩放锚点
  const r = canvas().getBoundingClientRect();
  const css = CANVAS / r.width;
  return { bx: (e.clientX - r.left) * css, by: (e.clientY - r.top) * css };
}
function itemAt(x, y) {
  for (let i = plan.items.length - 1; i >= 0; i--) {
    const it = plan.items[i];
    if (x >= it.x && x < it.x + it.w && y >= it.y && y < it.y + it.h) return it;
  }
  return null;
}
function placeAt(cell) {
  const [w0, h0] = sizeOf(sel);
  const w = selRot ? h0 / UNIT : w0 / UNIT;
  const h = selRot ? w0 / UNIT : h0 / UNIT;
  const it = { id: nextId++, name: sel, x: cell.x, y: cell.y, w, h };
  const lim = limitOf(sel);
  if (lim != null && placedCount(sel) >= lim) {
    hoverInfo = `${sel} 已达数量上限 ${lim}`;
    draw(); return;
  }
  /* 点哪放哪: 光标作为建筑中心 */
  it.x = Math.round(cell.x - w / 2);
  it.y = Math.round(cell.y - h / 2);
  if (!fits(it, it.x, it.y)) {
    /* 中心不行就尝试贴着光标放置 */
    it.x = cell.x; it.y = cell.y;
    if (!fits(it, it.x, it.y)) { hoverInfo = "此处无法放置"; draw(); return; }
  }
  const eff = GD.building_effects[sel];
  if (eff && eff.modes) it.mode = Object.keys(eff.modes)[0];
  plan.items.push(it);
  lastTouched = it;
  hoverInfo = `放置 ${sel}`;
  save(); renderPalette(); renderStats(); draw();
}

let pan = null;                     // 空白处拖动平移

function bindEvents() {
  const cv = canvas();
  cv.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    const cell = cellFromEvent(e);
    const it = itemAt(cell.x, cell.y);
    if (delMode && it) { removeItem(it); return; }
    if (sel && !it) { placeAt(cell); return; }
    if (it) {
      lastTouched = it;
      drag = { item: it, dx: cell.x - it.x, dy: cell.y - it.y, moved: false, ox: it.x, oy: it.y };
      cv.setPointerCapture(e.pointerId);
    } else {
      lastTouched = null;
      pan = { sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
      cv.setPointerCapture(e.pointerId);
    }
    draw();
  });
  cv.addEventListener("pointermove", (e) => {
    if (pan) {
      const r = canvas().getBoundingClientRect();
      const css = CANVAS / r.width;
      view.ox = pan.ox + (e.clientX - pan.sx) * css;
      view.oy = pan.oy + (e.clientY - pan.sy) * css;
      clampView();
      draw();
      return;
    }
    const cell = cellFromEvent(e);
    if (drag) {
      const nx = cell.x - drag.dx, ny = cell.y - drag.dy;
      if (nx !== drag.item.x || ny !== drag.item.y) {
        drag.item.x = Math.max(0, Math.min(GRID - drag.item.w, nx));
        drag.item.y = Math.max(0, Math.min(GRID - drag.item.h, ny));
        drag.moved = true;
      }
      draw();
    } else {
      const it = itemAt(cell.x, cell.y);
      hoverInfo = it
        ? `${it.name} ${it.w * UNIT}×${it.h * UNIT}` +
          (it.crop ? ` · ${it.crop.name}${it.crop.manual ? "（手动）" : ""}` : "") +
          powerTag(it) +
          ((it.name === "田地" || it.name === "林地")
            ? (() => {
                const st = reqStatus(it);
                const e = effectOf(it);
                let s = `（${e.light ? "☀光照 " : ""}${TEMP_LABEL[e.temp] || "普通"}`;
                if (st.req) {
                  const need = [st.req.light ? "光照" : null,
                    st.req.temp != null ? TEMP_LABEL[st.req.temp] : null]
                    .filter(Boolean).join("+");
                  s += `，需${need}` + (st.met ? " ✓" : ` 缺${st.missing.join("、")}`);
                }
                return s + "）";
              })()
            : "")
        : "";
      draw();
    }
  });
  cv.addEventListener("pointerup", () => {
    pan = null;
    if (!drag) return;
    const it = drag.item;
    if (!drag.moved) {
      const eff = GD.building_effects[it.name];
      if (eff && eff.modes) {                 // 原地点击: 切换模式
        const ks = Object.keys(eff.modes);
        it.mode = ks[(ks.indexOf(it.mode) + 1) % ks.length];
        hoverInfo = `${it.name} → ${it.mode}`;
      } else {
        openCropPicker(it);                   // 原地点击: 指定/查看作物
      }
    } else if (!fits(it, it.x, it.y, it.id)) {
      it.x = drag.ox; it.y = drag.oy;         // 放不下回弹
      hoverInfo = "无法移到该位置";
    } else {
      hoverInfo = `移动 ${it.name}`;
    }
    drag = null;
    save(); renderPalette(); renderStats(); draw();
  });
  cv.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const cell = cellFromEvent(e);
    const it = itemAt(cell.x, cell.y);
    if (it) removeItem(it);
  });
  cv.addEventListener("pointerleave", () => { hoverInfo = ""; draw(); });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const b = baseFromEvent(e);
    zoomAt(b.bx, b.by, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });

  document.addEventListener("keydown", (e) => {
    if ($("#tab-plan").classList.contains("hidden")) return;
    if (e.key === "Escape") {                 // 取消面板选择/拆除模式
      sel = null;
      delMode = false;
      $("#plan-del").classList.toggle("on", false);
      renderPalette(); draw();
      return;
    }
    if (e.key !== "r" && e.key !== "R") return;
    if (drag || !lastTouched) return;
    const it = lastTouched;
    [it.w, it.h] = [it.h, it.w];
    if (!fits(it, it.x, it.y, it.id)) {
      [it.w, it.h] = [it.h, it.w];
      hoverInfo = "旋转后放不下";
    } else {
      hoverInfo = `旋转 ${it.name}`;
    }
    save(); draw();
  });

  $("#plan-palette").addEventListener("click", (e) => {
    const b = e.target.closest(".pchip");
    if (!b) return;
    sel = sel === b.dataset.b ? null : b.dataset.b;
    delMode = false;
    $("#plan-del").classList.toggle("on", false);
    renderPalette(); draw();
  });
  $("#plan-level").addEventListener("change", (e) => {
    plan.level = +e.target.value;
    save(); renderPalette(); renderStats(); draw();
  });
  $("#plan-del").addEventListener("click", (e) => {
    delMode = !delMode;
    sel = null;
    e.currentTarget.classList.toggle("on", delMode);
    renderPalette(); draw();
  });
  $("#plan-zones").addEventListener("change", (e) => {
    showZones = e.target.checked; draw();
  });
  $("#plan-zoom-in").addEventListener("click", () =>
    zoomAt(CANVAS / 2, CANVAS / 2, 1.5));
  $("#plan-zoom-out").addEventListener("click", () =>
    zoomAt(CANVAS / 2, CANVAS / 2, 1 / 1.5));
  $("#plan-zoom-reset").addEventListener("click", () => {
    view.scale = 1; view.ox = 0; view.oy = 0;
    updateZoomLabel(); draw();
  });
  $("#plan-import").addEventListener("click", importPlan);
  $("#plan-auto").addEventListener("click", autoLayout);
  $("#plan-crop-color").addEventListener("change", (e) => {
    cropColorMode = e.target.checked; draw();
  });
  $("#plan-picker-list").addEventListener("click", (e) => {
    const c = e.target.closest("[data-crop]");
    if (!c || !pickerFor) return;
    pickerFor.crop = { name: c.dataset.crop, manual: true };
    hoverInfo = `${pickerFor.name} → ${c.dataset.crop}（手动）`;
    closeCropPicker();
    save(); draw();
  });
  $("#plan-picker-clear").addEventListener("click", () => {
    if (pickerFor) { delete pickerFor.crop; save(); draw(); }
    closeCropPicker();
  });
  $("#plan-picker-close").addEventListener("click", closeCropPicker);
  $("#plan-clear").addEventListener("click", () => {
    if (!confirm("清空全部已放置的建筑？")) return;
    plan.items = [];
    save(); renderPalette(); renderStats(); draw();
  });
  $("#plan-export").addEventListener("click", exportPng);
}

function removeItem(it) {
  plan.items = plan.items.filter((o) => o.id !== it.id);
  if (lastTouched && lastTouched.id === it.id) lastTouched = null;
  if (pickerFor && pickerFor.id === it.id) closeCropPicker();
  hoverInfo = `拆除 ${it.name}`;
  save(); renderPalette(); renderStats(); draw();
}

/* ---------------- 作物指定与导入 ---------------- */
function cropOptions(building) {
  const seen = new Set();
  return GD.recipes
    .filter((r) => r.building === building)
    .filter((r) => r.req_level == null || r.req_level <= plan.level)
    .filter((r) => { if (seen.has(r.name)) return false; seen.add(r.name); return true; })
    .map((r) => ({ name: r.name, seasonal: !!r.is_seasonal }));
}
function openCropPicker(it) {
  pickerFor = it;
  $("#plan-picker-title").textContent =
    `给「${it.name}」指定产物${it.crop ? `（当前: ${it.crop.name}${it.crop.manual ? " 手动" : " 自动"}）` : "（当前: 未指定）"}`;
  $("#plan-picker-list").innerHTML = cropOptions(it.name)
    .map((o) => `<button type="button" class="pchip" data-crop="${o.name}">` +
      `<b>${o.seasonal ? "★" : ""}${o.name}</b></button>`).join("") ||
    `<span class="hint">该建筑暂无可用配方</span>`;
  $("#plan-crop-picker").classList.remove("hidden");
}
function closeCropPicker() {
  pickerFor = null;
  $("#plan-crop-picker").classList.add("hidden");
}

/* 从生产计算结果提取田地/林地的作物地块序列
   分段模式: 每产物取最大实例数; 普通模式: 复用甘特排程的贪心填充,
   每块地取累计时长最长的作物(与"种植与生产安排"一致) */
function cropsFromResult(r) {
  const out = { 田地: [], 林地: [] };
  for (const b of Object.keys(out)) {
    if (r.segments && r.segments.length > 1) {
      const best = new Map();
      for (const seg of r.segments)
        for (const it of (seg.buildings || {})[b] || [])
          best.set(it.label, Math.max(best.get(it.label) || 0, it.instances));
      for (const [label, n] of best)
        out[b].push(...Array(n).fill(label));
      continue;
    }
    const u = (r.utilization || []).find((x) => x.building === b);
    const count = u ? u.count : 0;
    if (!count) continue;
    const T = r.hours * 3600;
    const rows = Array.from({ length: count }, () => ({ cursor: 0, agg: new Map() }));
    for (const it of (r.plan || [])) {
      if (it.building !== b || it.ttype !== "生长" || !it.batches_int) continue;
      let rem = it.batches_int;
      const t = it.time_per_batch;
      while (rem > 0) {
        let bestI = -1;
        for (let i = 0; i < count; i++) {
          if (T - rows[i].cursor < t) continue;
          if (bestI < 0 || rows[i].cursor < rows[bestI].cursor) bestI = i;
        }
        if (bestI < 0) break;
        const take = Math.min(rem, Math.floor((T - rows[bestI].cursor) / t));
        const row = rows[bestI];
        row.cursor += take * t;
        row.agg.set(it.label, (row.agg.get(it.label) || 0) + take * t);
        rem -= take;
      }
    }
    for (const row of rows) {
      let top = null, topT = -1;
      for (const [l, sec] of row.agg)
        if (sec > topT) { top = l; topT = sec; }
      out[b].push(top);                       // null = 该块地闲置
    }
  }
  return out;
}

/* ================= 一键布局 v2(分层规则生成, 规格Route C改编) =================
   隐形步道=chunk接缝+农田横中缝(默认保留, 去缝能多满足光温需求才去除);
   设备锚定农田块中心, 服务区极限排布: 田位6x6步距8/树位4x4步距16, 均保证
   至少1格落在36x36范围内(任意1格即生效), 树格数按精确满足数择优, 余位由
   普通池补满; 生产沿竖缝两翼按同类型建筑(用户分组)聚簇; 仓储品字居中;
   林业/孵化/装饰独立功能区 */
function autoLayout() {
  const r = window.__yimoResult;
  if (!r || !r.ok) {
    hoverInfo = "请先在「生产计算」页计算一次方案";
    draw(); return;
  }
  if (plan.items.length && !confirm("一键布局会覆盖现有布局（含作物指定），继续？"))
    return;
  /* 完整数据等级(10/11/12)自动按官方数量布局; 其他等级登记数量覆盖等级默认 */
  const counts = fullLevelCounts()
    ? Object.assign({}, fullLevelCounts())
    : Object.assign({}, GD.level_counts[String(plan.level)] || {}, userCounts || {});
  const seqs = cropsFromResult(r);
  const items = [];
  let id = 1;
  const size = (n) => GD.building_sizes[n];

  /* 隐形步道(不渲染, 仅作避让): chunk 接缝宽2 + 农田块横中缝(可按块去除) */
  const roads = [];
  const roadHit = (x, y, w, h) => roads.some((t) =>
    x < t.x + t.w && t.x < x + w && y < t.y + t.h && t.y < y + h);
  /* 电网覆盖矩形(发电桩+已补电线杆, 随布局推进扩大) */
  const covRect = (o) => {
    const h2 = Math.round(GD.building_effects[o.name].range / UNIT / 2);
    const c2 = Math.round(size(o.name)[0] / UNIT / 2);
    return { x: o.x + c2 - h2, y: o.y + c2 - h2, w: h2 * 2, h: h2 * 2 };
  };
  const gridCovs = () => items
    .filter((o) => o.name === "噼啪发电桩" || o.name === "噼啪电线杆")
    .map(covRect);
  const rawsG = rawMatBuildings();
  /* 不接入电网的设施(避让供电覆盖区): 除田地/林地(土地)与电力设施本体、
     需要原材料的建筑之外的一切建筑 */
  const isProtected = (n) => n !== "田地" && n !== "林地" &&
    n !== "噼啪发电桩" && n !== "噼啪电线杆" &&
    !(GD.building_powers && GD.building_powers[n] && rawsG.has(n));
  const canPlace = (n, x, y) => {
    const sz = size(n);
    if (!sz) return null;
    const w = sz[0] / UNIT, h = sz[1] / UNIT;
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x + w > GRID || y + h > GRID) return null;
    if (!onUnlocked(x, y, w, h)) return null;
    if (roadHit(x, y, w, h)) return null;
    for (const o of items)
      if (x < o.x + o.w && o.x < x + w && y < o.y + o.h && o.y < y + h) return null;
    /* 不接入电网的设施避让供电覆盖区(电力设施本身豁免) */
    if (isProtected(n) && gridCovs().some((z) =>
      x < z.x + z.w && z.x < x + w && y < z.y + z.h && z.y < y + h)) return null;
    return { id: id++, name: n, x, y, w, h };
  };
  const put = (n, x, y, opt) => {
    const it = canPlace(n, x, y);
    if (it) { Object.assign(it, opt || {}); items.push(it); }
    return it;
  };

  /* 区域与 chunk 掩码(公共列) */
  const plots = [...unlockedPlots()].map((t) => t.split(",").map(Number));
  const rowsMap = new Map();
  plots.forEach(([px, py]) => {
    if (!rowsMap.has(py)) rowsMap.set(py, new Set());
    rowsMap.get(py).add(px);
  });
  let cols = null;
  for (const st of rowsMap.values())
    cols = cols == null ? [...st] : cols.filter((x) => st.has(x));
  if (!cols || !cols.length) cols = [Math.max(...plots.map((q) => q[0]))];
  const minX = Math.min(...cols) * PLOT_CELLS;
  const maxX = (Math.max(...cols) + 1) * PLOT_CELLS;
  const minY = Math.min(...rowsMap.keys()) * PLOT_CELLS;
  const maxY = (Math.max(...rowsMap.keys()) + 1) * PLOT_CELLS;
  const W = maxX - minX, H = maxY - minY;
  const RCX = minX + W / 2, RCY = minY + H / 2;

  /* 土地格之间连续, 功能区可跨格布局、一格可容多个功能区:
     不设接缝步道, 区间分隔只由隐形主路(宽4)承担 */

  /* chunk 分区: 中行中部=生产, 其余=农田, 顶行=林业(左端=孵蛋区, 其余=装饰) */
  const pys = [...rowsMap.keys()].sort((a, b) => a - b);
  const chunksAll = [];
  for (const py of pys) for (const px of cols)
    if (rowsMap.get(py).has(px)) chunksAll.push({ px, py });
  const midPy = pys[Math.floor((pys.length - 1) / 2)];
  const topPy = pys[pys.length - 1];
  const cxOf = (c) => c.px * PLOT_CELLS + 40;
  let farmChunks = chunksAll.filter((c) =>
    c.py < midPy || (c.py === midPy && Math.abs(cxOf(c) - RCX) > PLOT_CELLS + 40));
  const prodChunks = chunksAll.filter((c) => c.py === midPy && !farmChunks.includes(c));
  if (!farmChunks.length && prodChunks.length > 1) {
    prodChunks.sort((a, b) => Math.abs(cxOf(b) - RCX) - Math.abs(cxOf(a) - RCX));
    farmChunks.push(...prodChunks.splice(1));          // 单行退化: 中块生产侧块农田
  }
  let forestChunks = chunksAll.filter((c) => c.py > midPy);
  if (!forestChunks.length) forestChunks = [farmChunks[farmChunks.length - 1]];
  const topChunks = chunksAll.filter((c) => c.py === topPy);
  /* 孵化区固定在 (2,0) 块(该块设备服务区常年填不满, 正好利用) */
  const hatchChunk = chunksAll.find((c) => c.px === 2 && c.py === 0) ||
    topChunks[0] || farmChunks[0];

  /* 农田块横中缝(默认保留; 仅当去除能提升满足数时去除) */
  const laneKey = (c) => c.px + "," + c.py;
  const lanes = new Map();
  farmChunks.forEach((c) => {
    lanes.set(laneKey(c), {
      x: c.px * PLOT_CELLS, y: c.py * PLOT_CELLS + 39,
      w: PLOT_CELLS, h: 2,
    });
  });
  const addLane = (c) => {
    const l = lanes.get(laneKey(c));
    if (l && !roads.includes(l)) roads.push(l);
  };
  const dropLane = (c) => {
    const l = lanes.get(laneKey(c));
    const i = roads.indexOf(l);
    if (i >= 0) roads.splice(i, 1);
  };
  farmChunks.forEach((c) => {
    if (c !== hatchChunk) addLane(c);           // 孵化块无农田中缝
  });

  /* 作物需求分组 + 温差就近(田地与林地一起统计) */
  const reqOf = (name) => (GD.crop_requirements || {})[name] || {};
  const treeN = counts.林地 || 0;
  const fieldCrops = seqs.田地.slice(0, counts.田地 || 0);
  while (fieldCrops.length < (counts.田地 || 0)) fieldCrops.push(null);
  const treeCropsAll = seqs.林地.slice(0, treeN);
  while (treeCropsAll.length < treeN) treeCropsAll.push(null);
  let warmN = 0, hotN = 0, coolN = 0, freezeN = 0;
  for (const c of [...fieldCrops, ...treeCropsAll]) {
    if (c == null) continue;
    const t = reqOf(c).temp;
    if (t === 1) warmN++; else if (t === 2) hotN++;
    else if (t === -1) coolN++; else if (t === -2) freezeN++;
  }
  const furnaceMode = warmN >= hotN ? "温暖" : "炎热";
  const coolerMode = coolN >= freezeN ? "凉爽" : "冰冻";
  const MODE_TEMPV = { 温暖: 1, 炎热: 2, 凉爽: -1, 冰冻: -2 };
  const fv = MODE_TEMPV[furnaceMode], cv = MODE_TEMPV[coolerMode];
  const queues = { lamp: [], furn: [], cool: [] };
  const plainFields = [], plainTrees = [];
  const classify = (c, tree) => {
    if (c == null) { (tree ? plainTrees : plainFields).push(null); return; }
    const q = reqOf(c);
    const item = { name: c, tree };
    const plain = () => (tree ? plainTrees : plainFields).push(item);
    if (q.light) {
      if (counts.日光灯) { item.exact = true; item.target = "lamp"; queues.lamp.push(item); }
      else plain();
      return;
    }
    if (q.temp != null) {
      let best = { k: null, d: Math.abs(q.temp) };
      if (counts.热能炉) { const d = Math.abs(fv - q.temp); if (d <= best.d) best = { k: "furn", d }; }
      if (counts.制冷机) { const d = Math.abs(cv - q.temp); if (d < best.d) best = { k: "cool", d }; }
      if (best.k) { item.exact = best.d === 0; item.target = best.k; queues[best.k].push(item); }
      else plain();
      return;
    }
    plain();
  };
  fieldCrops.forEach((c) => classify(c, false));
  treeCropsAll.forEach((c) => classify(c, true));

  /* 设备锚定农田块(近中的块优先, 避开孵化功能区;
     锚位不足时补顶行其他已解锁块, 保证设备互不共块) */
  let sortedFarm = farmChunks
    .filter((c) => c !== hatchChunk)
    .sort((a, b) => Math.abs(cxOf(a) - RCX) - Math.abs(cxOf(b) - RCX));
  if (sortedFarm.length < 3) {
    const have = new Set([...sortedFarm, hatchChunk].map((c) => c.px + "," + c.py));
    const extras = [...(rowsMap.get(pys[0]) || [])]
      .filter((px) => !have.has(px + "," + pys[0]))
      .map((px) => ({ px, py: pys[0] }))
      .sort((a, b) => Math.abs(cxOf(a) - RCX) - Math.abs(cxOf(b) - RCX));
    sortedFarm = sortedFarm.concat(extras).slice(0, 3);
  }
  const devDefs = [];
  if (counts.日光灯) devDefs.push({ dev: "日光灯", key: "lamp" });
  if (counts.热能炉) devDefs.push({ dev: "热能炉", mode: furnaceMode, key: "furn" });
  if (counts.制冷机) devDefs.push({ dev: "制冷机", mode: coolerMode, key: "cool" });
  /* 需求多的设备优先占更居中的块; 只服务林地的设备(队列全为树)锚林地块,
     其余锚农田块 —— 田地只与田地、林地只与林地排在一起 */
  devDefs.sort((a, b) => queues[b.key].length - queues[a.key].length);
  const forestSorted = [...forestChunks].sort((a, b) =>
    Math.abs(cxOf(a) - RCX) - Math.abs(cxOf(b) - RCX));
  const usedDevChunks = new Set([hatchChunk].map((c) => c.px + "," + c.py));
  devDefs.forEach((d) => {
    const q = queues[d.key];
    const ex = q.filter((x) => x.exact);
    const treeOnly = ex.length > 0 && ex.every((x) => x.tree);
    d.treeAnchor = treeOnly;
    const pool = treeOnly ? forestSorted : sortedFarm;
    const c = pool.find((c2) => !usedDevChunks.has(c2.px + "," + c2.py)) || pool[0];
    usedDevChunks.add(c.px + "," + c.py);
    d.ax = c.px * PLOT_CELLS + 40;
    d.ay = c.py * PLOT_CELLS + 40;
    d.chunk = c;
  });

  const packAnchor = (d) => {
    const q = [...queues[d.key]].sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
    const [dw, dh] = size(d.dev);
    const devThere = items.some((o) => o.name === d.dev &&
      o.x + o.w / 2 === d.ax && o.y + o.h / 2 === d.ay);
    if (!devThere && !put(d.dev, d.ax - dw / UNIT / 2, d.ay - dh / UNIT / 2,
      d.mode ? { mode: d.mode } : {})) {
      q.forEach((x) => { if (x.placed === undefined) x.placed = false; });
      return 0;
    }
    /* 影响范围36x36; 田位6x6步距8(自-7起)/树位4x4步距16(自-15起),
       每个位至少1格落在范围内(任意1格即生效); x/y 坐标各自独立成列 */
    const zx = d.ax - 18, zy = d.ay - 18;
    const xs = [], ys = [], txs = [], tys = [];
    for (let i = 0; i < 6; i++) { xs.push(zx - 7 + i * 8); ys.push(zy - 7 + i * 8); }
    for (let i = 0; i < 4; i++) { txs.push(zx - 15 + i * 16); tys.push(zy - 15 + i * 16); }
    const freeAt = (x, y, w, h) => onUnlocked(x, y, w, h) && !roadHit(x, y, w, h) &&
      !items.some((o) => x < o.x + o.w && o.x < x + w && y < o.y + o.h && o.y < y + h);
    const cellOf = (v, base) => Math.min(3, Math.max(0, Math.floor((v - base) / 16)));
    const fieldSlots = [];
    for (const sx of xs) for (const sy of ys)
      if (freeAt(sx, sy, 8, 8))
        fieldSlots.push({ x: sx, y: sy,
          ci: cellOf(sx, zx - 15), cj: cellOf(sy, zy - 15),
          dist: Math.abs(sx + 4 - d.ax) + Math.abs(sy + 4 - d.ay) });
    /* 树格: 角/边格内含田位少, 优先占用(代价小) */
    const cells = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
      if (freeAt(txs[i], tys[j], 16, 16))
        cells.push({ i, j,
          nf: fieldSlots.filter((s) => s.ci === i && s.cj === j).length,
          dist: Math.abs(txs[i] + 8 - d.ax) + Math.abs(tys[j] + 8 - d.ay) });
    cells.sort((a, b) => a.nf - b.nf || a.dist - b.dist);
    /* 同一种光温的田地/林地共用本设备服务区(混种);
       树锚设备不摆田地(错配项本就不满足, 转普通填充归位田地区);
       田锚设备上若有同需求树木(混排精确项)则一并摆放 */
    const hasExactTree = q.some((x) => x.exact && x.tree);
    const qT = d.treeAnchor || hasExactTree
      ? q.filter((x) => x.tree && !x.placed) : [];
    const qF = d.treeAnchor ? [] : q.filter((x) => !x.tree && !x.placed);
    /* 树格数 k 择优: k 棵树 + 剩余田位, 精确满足数最大化 */
    let usedNf = 0;
    const cum = cells.map((c2) => (usedNf += c2.nf));
    let bestK = 0, bestSat = -1, bestTot = -1;
    for (let k = 0; k <= Math.min(qT.length, cells.length); k++) {
      const capF = Math.max(0, fieldSlots.length - (k ? cum[k - 1] : 0));
      const sat = Math.min(qT.filter((x) => x.exact).length, k) +
        Math.min(qF.filter((x) => x.exact).length, capF);
      const tot = Math.min(qT.length, k) + Math.min(qF.length, capF);
      if (sat > bestSat || (sat === bestSat && tot > bestTot)) {
        bestSat = sat; bestTot = tot; bestK = k;
      }
    }
    let sat = 1000;                             // 设备放上本身就是最大收益
    const usedCells = cells.slice(0, bestK);
    qT.slice(0, bestK).forEach((it, k2) => {
      const c2 = usedCells[k2];
      it.placed = !!put("林地", txs[c2.i], tys[c2.j],
        { crop: { name: it.name, manual: false } });
      if (it.placed && it.exact) sat++;
    });
    const usedSet = new Set(usedCells.map((c2) => c2.i + "," + c2.j));
    const slots = fieldSlots
      .filter((s) => !usedSet.has(s.ci + "," + s.cj))
      .sort((a, b) => a.dist - b.dist);
    for (const it of qF) {
      let ok = false;
      for (const s of slots) {
        if (s.used) continue;
        if (put("田地", s.x, s.y, { crop: { name: it.name, manual: false } })) {
          s.used = true; ok = true; break;
        }
      }
      it.placed = ok;
      if (ok && it.exact) sat++;
    }
    /* 服务区内剩余槽位由普通填充按距设备序继续补位(同地类/同需求混排) */
    return sat;
  };
  const clearAnchorArea = (devs) => {           // 回滚这些锚点服务区内的产物(评估用)
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const inAny = devs.some((d) =>
        it.x < d.ax + 33 && d.ax - 33 < it.x + it.w &&
        it.y < d.ay + 33 && d.ay - 33 < it.y + it.h);
      const isDev = devs.some((d) => d.dev === it.name);
      if (inAny && (isDev || it.name === "田地" || it.name === "林地"))
        items.splice(i, 1);
    }
  };

  /* 支路规则: 带中缝排一次; 精确需求未全放下时去缝重排, 满足数更多才采用;
     定案后普通池补满服务区空位 */
  const doneChunks = new Set();
  devDefs.forEach((d) => {
    const k = laneKey(d.chunk);
    if (doneChunks.has(k)) return;
    doneChunks.add(k);
    const devsInChunk = devDefs.filter((x) => laneKey(x.chunk) === k);
    const run = () => devsInChunk.reduce((s2, x) => s2 + packAnchor(x), 0);
    const resetPlaced = () => devsInChunk.forEach((x) =>
      queues[x.key].forEach((it2) => { delete it2.placed; }));
    const keepSat = run();
    const devIn = (x) => items.some((o) => o.name === x.dev &&
      o.x + o.w / 2 === x.ax && o.y + o.h / 2 === x.ay);
    const allIn = devsInChunk.every(devIn) && devsInChunk.every((x) =>
      queues[x.key].every((it2) => !it2.exact || it2.placed === true));
    if (!allIn) {
      dropLane(d.chunk);
      clearAnchorArea(devsInChunk);
      resetPlaced();
      if (run() <= keepSat) {                    // 去缝无益 -> 恢复带缝版
        clearAnchorArea(devsInChunk);
        resetPlaced();
        addLane(d.chunk);
        run();
      }
    }
  });

  /* 噼啪发电桩: 供电优先于功能区排布 —— 先于普通填充与功能区装箱,
     在生产带中心选址(自由格点中距带质心最近); 后续一切摆放自动避让其覆盖区,
     需要原材料的建筑则向覆盖区内聚集 */
  if (counts.噼啪发电桩) {
    const pc = prodChunks.length ? prodChunks : chunksAll;
    const bcx = pc.reduce((s, c) => s + c.px * PLOT_CELLS + 40, 0) / pc.length;
    const bcy = pc.reduce((s, c) => s + c.py * PLOT_CELLS + 40, 0) / pc.length;
    let best = null, bd = 1e9;
    for (let y = minY + 4; y + 8 <= maxY - 4; y += 2)
      for (let x = minX + 4; x + 8 <= maxX - 4; x += 2) {
        if (!onUnlocked(x, y, 8, 8) || roadHit(x, y, 8, 8)) continue;
        if (items.some((o) => x < o.x + o.w && o.x < x + 8 && y < o.y + o.h && o.y < y + 8)) continue;
        const d = Math.abs(x + 4 - bcx) + Math.abs(y + 4 - bcy);
        if (d < bd) { bd = d; best = { x, y }; }
      }
    if (best) put("噼啪发电桩", best.x, best.y, { mode: "发电" });
    else dropped++;
  }

  /* 普通填充: 与设备槽位同源格点(chunk+7, 步距=尺寸);
     锚定块内按距设备由近到远落位 —— 无需求作物延续需求作物的排布方式
     (先补服务区空位, 再同心外扩), 其余块按行序铺满 */
  const fillGrid = (chunkList, name, pitch, list, off) => {
    let i = 0;
    for (const c of chunkList) {
      const dev = devDefs.find((d) => d.chunk === c);
      const pos = [];
      for (let y = c.py * PLOT_CELLS + off; y + pitch <= (c.py + 1) * PLOT_CELLS; y += pitch)
        for (let x = c.px * PLOT_CELLS + off; x + pitch <= (c.px + 1) * PLOT_CELLS; x += pitch)
          pos.push({ x, y, d: dev ? Math.abs(x + pitch / 2 - dev.ax) + Math.abs(y + pitch / 2 - dev.ay) : 0 });
      if (dev) pos.sort((a, b) => a.d - b.d);
      for (const p of pos) {
        if (i >= list.length) break;
        const f = list[i];
        if (put(name, p.x, p.y, f != null && f.name ? { crop: { name: f.name, manual: false } } : {}))
          i++;
      }
    }
    return list.slice(i);
  };
  const leftovers = [];
  let dropped = 0;
  for (const key of ["lamp", "furn", "cool"])
    queues[key].forEach((x) => { if (x.placed !== true) leftovers.push(x); });
  const fieldFill = plainFields.concat(leftovers.filter((x) => x && !x.tree && x.name));
  const treeFill = plainTrees.concat(leftovers.filter((x) => x && x.tree && x.name));
  const notFn = (ex) => (c) => c !== ex;                 // 功能区专用块不参与普通填充
  /* 孵化区: 固定于 (2,0) 块下部, 5x2 网格; 上部空区由普通田地填充 */
  const hn = counts.孵化器 || 0;
  if (hn && hatchChunk) {
    const hx = hatchChunk.px * PLOT_CELLS + Math.floor((PLOT_CELLS - 5 * 10 + 2) / 2);
    const hy = hatchChunk.py * PLOT_CELLS + PLOT_CELLS - 20;
    for (let k = 0; k < hn; k++)
      put("孵化器", hx + (k % 5) * 10, hy + Math.floor(k / 5) * 10);
  }

  /* 无需求作物优先填设备锚定块(延续需求作物的径向排布), 再溢出到其余块;
     田地填充走农田块(田设备块优先), 林地填充走林地块+混种设备块(树设备块优先) */
  const anchorSet = new Set(devDefs.map((d) => d.chunk));
  const orderedFarm = [
    ...farmChunks.filter((c) => anchorSet.has(c)),
    ...farmChunks.filter((c) => !anchorSet.has(c)),
  ];
  const treeDevChunks = new Set(devDefs.filter((d) => d.treeAnchor).map((d) => d.chunk));
  const mixedDevChunks = new Set(devDefs.filter((d) => !d.treeAnchor &&
    queues[d.key].some((x) => x.exact && x.tree)).map((d) => d.chunk));
  const orderedForest = [
    ...forestChunks.filter((c) => treeDevChunks.has(c) || mixedDevChunks.has(c)),
    ...forestChunks.filter((c) => !treeDevChunks.has(c) && !mixedDevChunks.has(c)),
    ...[...mixedDevChunks].filter((c) => !forestChunks.includes(c)),
  ];
  const spillF = fillGrid(orderedFarm, "田地", 8, fieldFill, 7);
  const spillT = fillGrid(orderedForest, "林地", 16, treeFill, 7);
  dropped += spillF.length + spillT.length;              // 田/林放不下也计入提示
  /* 装饰(舞力能量机+迷立方制造机)已并入生产功能区, 不再单独占顶行块 */

  /* 生产区: 同类型建筑各成一个功能区; 功能区之间以隐形主路(宽4)分隔 */
  const skip = new Set(["田地", "林地", "日光灯", "热能炉", "制冷机",
    "仓储单元", "孵化器", "噼啪发电桩", "噼啪电线杆"]);   // 发电桩由末尾专用选址摆放, 电线杆手动
  /* 同类型建筑分组(用户定义): 每个功能区=一个方形块, 块间隐形主路(宽4)分隔;
     装饰(舞力能量机+迷立方制造机)自成一个功能区; 未分组的(木工台/风味腌制罐)各自成区 */
  const TYPE_GROUPS = [
    ["采蜜鸟屋", "汐语沙堡", "绵云草床", "星落吊床", "花舞风车", "留声制香台", "摩天轮纺车", "手作台"],
    ["矿山", "烟囱煅烧炉", "木工台"],
    ["熬制锅", "蹦蹦酿造桶", "超旺灶台", "音乐烘干机", "抓夹烹饪炉", "水井", "旋转木马磨坊", "风味腌制罐"],
    ["舞力能量机", "迷立方制造机"],
  ];
  const chain = [];
  for (const n of Object.keys(GD.building_sizes)) {
    if (skip.has(n) || !size(n)) continue;
    for (let k = 0; k < (counts[n] || 0); k++) chain.push(n);
  }
  const zonesSeq = [], zoneIdx = new Map();     // 区序=组内首成员的链序
  for (const n of chain) {
    const g = TYPE_GROUPS.findIndex((gr) => gr.includes(n));
    let z;
    if (g < 0) z = { names: [] };
    else if (!(z = zoneIdx.get(g))) {
      z = { names: [] };
      zoneIdx.set(g, z);
      zonesSeq.push(z);
    }
    if (g < 0) zonesSeq.push(z);
    z.names.push(n);
  }
  /* 矩形装箱: 正方形不可行时的退化方案(原货架扫描) */
  const packRect = (names, maxH, maxW) => {
    const runs = [];
    for (const n of names) {
      const r = runs[runs.length - 1];
      if (r && r.n === n) r.c++;
      else runs.push({ n, c: 1 });
    }
    const units = runs.map((r) => {
      const s = size(r.n);
      const w = s[0] / UNIT, h = s[1] / UNIT;
      return { n: r.n, w, h, c: r.c, rw: r.c * w + (r.c - 1) * 2 };
    });
    const pack = (target) => {
      const out = [];
      let x = 0, y = 0, rowH = 0;
      for (const u of units) {
        if (x > 0 && x + u.rw > target && u.rw <= target) {
          x = 0; y += rowH + 2; rowH = 0;
        }
        for (let k = 0; k < u.c; k++) {
          if (x > 0 && x + u.w > target) { x = 0; y += rowH + 2; rowH = 0; }
          out.push({ n: u.n, w: u.w, h: u.h, x, y });
          x += u.w + 2; rowH = Math.max(rowH, u.h);
        }
      }
      return { rects: out,
        w: Math.max(...out.map((o) => o.x + o.w)), h: y + rowH };
    };
    const area = units.reduce((s, u) => s + u.c * u.w * u.h, 0);
    const maxUW = Math.max(...units.map((u) => u.w));
    const tMax = Math.max(maxW, maxUW);
    let best = null;
    for (let t = Math.max(maxUW, Math.floor(Math.sqrt(area))); t <= tMax; t++) {
      const pk = pack(t);
      const score = (pk.h <= maxH ? 0 : 10000) +
        Math.max(pk.w, pk.h) * 100 + Math.abs(pk.w - pk.h);
      if (!best || score < best.score) best = { score, pk };
      if (pk.w >= pk.h && pk.h <= maxH) break;
    }
    if (!best) best = { pk: pack(tMax) };
    const rowMap = new Map();
    for (const o of best.pk.rects) {
      if (!rowMap.has(o.y)) rowMap.set(o.y, []);
      rowMap.get(o.y).push(o);
    }
    for (const r of rowMap.values()) {
      const shift = Math.floor((best.pk.w - Math.max(...r.map((o) => o.x + o.w))) / 2);
      if (shift > 0) r.forEach((o) => { o.x += shift; });
    }
    return best.pk;
  };

  /* 功能区装箱(矩形均匀间隔装箱算法规格 §5.1 货架 + §7.1 最小正方形):
     同种连排尽量不拆行; 行内水平 gutter 与行间竖直 gutter 统一为 2;
     外接为严格正方形 —— 自下界递增边长 S 取首个可行值,
     依次尝试 链序整组/链序逐座/高度降序逐座(§5.1 两种排序);
     行内水平居中、行栈竖直居中(对称); 均不可行退化为矩形 */
  const packZone = (names, maxSide, wideCap) => {
    const G = 2;
    const runs = [];
    for (const n of names) {
      const r = runs[runs.length - 1];
      if (r && r.n === n) r.c++;
      else runs.push({ n, c: 1 });
    }
    const units = runs.map((r) => {
      const s = size(r.n);
      const w = s[0] / UNIT, h = s[1] / UNIT;
      return { n: r.n, w, h, c: r.c, rw: r.c * w + (r.c - 1) * G };
    });
    const packIn = (S, order, keepRuns) => {     // 均匀 gutter 货架装箱
      const rows = [];
      let cur = null;
      const start = () => { cur = { items: [], w: 0, h: 0 }; rows.push(cur); };
      for (const u of order) {
        if (!cur) start();
        if (keepRuns && cur.items.length) {
          if (cur.w + G + u.rw <= S) cur.w += G;
          else if (u.rw <= S) start();           // 整组独占新行
        }
        for (let k = 0; k < u.c; k++) {
          if (cur.w && cur.w + G + u.w > S) start();   // 放不下换行
          else if (cur.w) cur.w += G;
          cur.items.push({ n: u.n, w: u.w, h: u.h });
          cur.w += u.w;
          cur.h = Math.max(cur.h, u.h);
        }
      }
      const W = Math.max(...rows.map((r) => r.w));
      const H = rows.reduce((s, r) => s + r.h, 0) + G * (rows.length - 1);
      return W <= S && H <= S ? { rows, W, H } : null;
    };
    const area = units.reduce((s, u) => s + u.c * u.w * u.h, 0);
    const lb = Math.max(...units.map((u) => u.w), Math.ceil(Math.sqrt(area)));
    const byH = [...units].sort((a, b) => b.h - a.h || b.w - a.w);
    for (let S = lb; S <= maxSide; S++) {
      /* 链序整组 -> 高度降序整组(同名天然连排) -> 两种逐座兜底 */
      const p = packIn(S, units, true) || packIn(S, byH, true) ||
        packIn(S, units, false) || packIn(S, byH, false);
      if (!p) continue;
      const rects = [];
      let y = Math.floor((S - p.H) / 2);         // 行栈竖直居中
      for (const r of p.rows) {
        let x = Math.floor((S - r.w) / 2);       // 行内水平居中
        for (const it of r.items) {
          rects.push({ n: it.n, x, y });
          x += it.w + G;
        }
        y += r.h + G;
      }
      return { rects, w: S, h: S };
    }
    return packRect(names, maxSide, wideCap || maxSide);   // 兜底
  };
  /* 功能区块沿生产带连续排布(可跨土地格): 同带横向推进(块间主路4),
     放不下换新带(带间主路4); 步进1避开奇偶锁死; 块高以生产带高为上限 */
  const ROAD = 4;
  const pL = minX + 4, pR = maxX - 4;
  const pT = Math.max(minY + 4, midPy * PLOT_CELLS + 4), pB = maxY - 4;
  const maxSide = Math.min(pB - pT, pR - pL);
  let bandTop = pT, rowH = 0;
  const fitsAll = (bx, by, pk) => {             // bbox 粗查(路/界/占用)通过后逐座精查
    if (!onUnlocked(bx, by, pk.w, pk.h) || roadHit(bx, by, pk.w, pk.h)) return false;
    /* 与已有建筑保持主路间隔(外扩ROAD) */
    if (items.some((o) => bx - ROAD < o.x + o.w && o.x < bx + pk.w + ROAD &&
      by - ROAD < o.y + o.h && o.y < by + pk.h + ROAD)) return false;
    return pk.rects.every((r) => canPlace(r.n, bx + r.x, by + r.y));
  };
  /* 先统一装箱, 按块高降序落位(FFDH): 同带高度趋同, 区间空隙收敛到主路宽 */
  const zonePacks = zonesSeq
    .map((z, i) => ({ i, pk: packZone(z.names, maxSide, pR - pL) }))
    .filter((o) => o.pk.rects.length)
    .sort((a, b) => b.pk.h - a.pk.h || a.i - b.i);
  for (const zo of zonePacks) {
    const pk = zo.pk;
    let at = null;
    while (bandTop + pk.h <= pB && !at) {
      for (let dy = 0; bandTop + dy + pk.h <= pB && !at; dy += 1)
        for (let dx = 0; pL + dx + pk.w <= pR && !at; dx += 1)
          if (fitsAll(pL + dx, bandTop + dy, pk)) at = [pL + dx, bandTop + dy];
      if (!at) { bandTop += rowH + ROAD; rowH = 0; }        // 换新带
    }
    if (at) {
      pk.rects.forEach((r) => put(r.n, at[0] + r.x, at[1] + r.y));
      rowH = Math.max(rowH, (at[1] - bandTop) + pk.h);
    } else {                                    // 生产带塞不下: 从当前带位起逐个兜底
      pk.rects.forEach((r) => {
        const s = size(r.n), w = s[0] / UNIT, h = s[1] / UNIT;
        let ok = false;
        for (let y2 = Math.max(pT, bandTop); y2 + h <= pB && !ok; y2 += 2)
          for (let x2 = pL; x2 + w <= pR && !ok; x2 += 2)
            ok = !!put(r.n, x2, y2);
        if (!ok) for (let y2 = pT; y2 + h <= pB && !ok; y2 += 2)
          for (let x2 = pL; x2 + w <= pR && !ok; x2 += 2) ok = !!put(r.n, x2, y2);
        if (!ok) dropped++;
      });
    }
  }

  /* 仓储选址(仓储建筑选址算法.md §4.2/§5.1): 距离=L1 到建筑矩形最近点,
     目标=最小化加权总服务距离; k 座用 Lloyd 交替(分配->各簇加权中位数->吸附
     最近可行格点), 候选=全图可容纳 8x8 的格点(不压建筑/步道/未解锁地) */
  if (counts.仓储单元) {
    const serves = items.filter((it) => it.name !== "仓储单元");
    const l1 = (wx, wy, b) => {
      const dx = Math.max(0, Math.max(b.x - (wx + 8), wx - (b.x + b.w)));
      const dy = Math.max(0, Math.max(b.y - (wy + 8), wy - (b.y + b.h)));
      return dx + dy;
    };
    const cands = [];
    for (let y = minY + 4; y + 8 <= maxY - 4; y += 4)
      for (let x = minX + 4; x + 8 <= maxX - 4; x += 4)
        if (onUnlocked(x, y, 8, 8) && !roadHit(x, y, 8, 8) &&
          !items.some((o) => x < o.x + o.w && o.x < x + 8 && y < o.y + o.h && o.y < y + 8))
          cands.push({ x, y, cov: gridCovs().some((z) =>
            z.x < x + 8 && x < z.x + z.w && z.y < y + 8 && y < z.y + z.h) });
    const med = (arr) => {
      const a = [...arr].sort((p, q) => p - q);
      return a[a.length >> 1] || 0;
    };
    /* 吸附到距目标点最近且与已选仓储不冲突的候选格; 优先供电覆盖区外的格子 */
    const snap = (tx, ty, taken) => {
      let best = null, bd = 1e9;
      const free = cands.filter((c) =>
        !taken.some((t) => Math.abs(c.x - t.x) < 8 && Math.abs(c.y - t.y) < 8));
      for (const c of (free.some((c2) => !c2.cov) ? free.filter((c2) => !c2.cov) : free)) {
        const d = Math.abs(c.x + 4 - tx) + Math.abs(c.y + 4 - ty);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    };
    /* 初始种子: 最远点遍历(建筑中心, 确定性) */
    const cs = serves.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 }));
    const whN = Math.min(counts.仓储单元, Math.max(1, cs.length));
    const seeds = [];
    if (cs.length) {
      let s0 = cs[0];
      for (const c of cs)
        if (Math.abs(c.x - RCX) + Math.abs(c.y - RCY) <
          Math.abs(s0.x - RCX) + Math.abs(s0.y - RCY)) s0 = c;
      seeds.push(s0);
      while (seeds.length < whN) {
        let far = null, fd = -1;
        for (const c of cs) {
          const d = Math.min(...seeds.map((s) =>
            Math.abs(c.x - s.x) + Math.abs(c.y - s.y)));
          if (d > fd) { fd = d; far = c; }
        }
        seeds.push(far);
      }
    }
    let whs = seeds.map((s) => snap(s.x, s.y, []));
    for (let it2 = 0; it2 < 6 && whs.every(Boolean); it2++) {
      const taken = [];
      const next = [];
      for (let j = 0; j < whs.length; j++) {
        const ds = serves.map((b) => whs.map((w) => l1(w.x, w.y, b)));
        const cluster = serves.filter((b, i2) => {
          const m = Math.min(...ds[i2]);
          return ds[i2].indexOf(m) === j;
        });
        let c = whs[j];
        if (cluster.length) {
          const mx = med(cluster.map((b) => b.x + b.w / 2));
          const my = med(cluster.map((b) => b.y + b.h / 2));
          c = snap(mx, my, taken) || whs[j];
        }
        if (c) taken.push(c);
        next.push(c);
      }
      const same = next.every((c, j) => c === whs[j]);
      whs = next;
      if (same) break;
    }
    let placedWh = 0;
    whs.forEach((w) => { if (w && put("仓储单元", w.x, w.y)) placedWh++; });
    for (let k = placedWh; k < counts.仓储单元; k++) {   // 兜底扫描
      let ok = false;
      for (let y2 = minY + 4; y2 + 8 <= maxY - 4 && !ok; y2 += 4)
        for (let x2 = minX + 4; x2 + 8 <= maxX - 4 && !ok; x2 += 4)
          ok = !!put("仓储单元", x2, y2);
      if (!ok) dropped++;
    }
  }

  /* 噼啪电线杆自动补位: 供电尚有余量时, 为覆盖外的加工建筑补杆延伸电网
     (杆 28x28 须与已联通电网任意 1 格重合); 评分 = 新增接入功率最大,
     并避让不接入电网的建筑(水井/矿山/游玩机等); 无益即停止 */
  if (counts.噼啪发电桩 && counts.噼啪电线杆) {
    const rawsG = rawMatBuildings();
    const halfP = Math.round(GD.building_effects["噼啪电线杆"].range / UNIT / 2);
    const genW2 = counts.噼啪发电桩 *
      (GD.building_effects["噼啪发电桩"].modes["发电"] || 0);
    const consumersG = items.filter((it) =>
      GD.building_powers[it.name] && rawsG.has(it.name));
    for (let k = 0; k < counts.噼啪电线杆; k++) {
      const allCovs = items.filter((o) => o.name === "噼啪发电桩" || o.name === "噼啪电线杆")
        .map((o) => { const z = covRect(o); z.isGen = o.name === "噼啪发电桩"; return z; });
      const conn = allCovs.filter((z) => z.isGen);
      let ch2 = true;
      while (ch2) {                              // 与电网重合的杆才算联通
        ch2 = false;
        for (const z of allCovs) {
          if (z.isGen || conn.includes(z)) continue;
          if (conn.some((c3) => hit(c3, z))) { conn.push(z); ch2 = true; }
        }
      }
      const hitConn = (b) => conn.some((z) => hit(z, b));
      const idle = genW2 - Math.min(genW2,
        consumersG.reduce((s, b) => s + (hitConn(b) ? GD.building_powers[b.name] : 0), 0));
      const unc = consumersG.filter((b) => !hitConn(b))
        .sort((a, b) => GD.building_powers[b.name] - GD.building_powers[a.name]);
      if (!unc.length || idle <= 0) break;
      let best = null, bs = 0;
      for (let y = minY + 3; y + 6 <= maxY - 3; y += 3)
        for (let x = minX + 3; x + 6 <= maxX - 3; x += 3) {
          if (!onUnlocked(x, y, 6, 6) || roadHit(x, y, 6, 6)) continue;
          if (items.some((o) => x < o.x + o.w && o.x < x + 6 && y < o.y + o.h && o.y < y + 6)) continue;
          const pcov = { x: x + 3 - halfP, y: y + 3 - halfP, w: halfP * 2, h: halfP * 2 };
          if (!conn.some((z) => hit(z, pcov))) continue;     // 须与已联通电网重合
          let s = 0, sN = 0;
          for (const b of unc)
            if (pcov.x < b.x + b.w && b.x < pcov.x + pcov.w &&
                pcov.y < b.y + b.h && b.y < pcov.y + pcov.h) s += GD.building_powers[b.name];
          for (const b of items) if (isProtected(b.name) && hit(pcov, b)) sN++;
          if (sN > 0) continue;                    // 杆覆盖不得罩住不接入电网的设施
          s = s * 10000;
          if (s > bs) { bs = s; best = { x, y }; }
        }
      if (!best || bs <= 0) break;
      put("噼啪电线杆", best.x, best.y);
    }
  }

  plan.items = items;
  nextId = id;                                  // 后续手动放置不与布局 id 冲突
  sel = null; delMode = false; lastTouched = null;
  $("#plan-del").classList.remove("on");
  hoverInfo = `一键布局完成：${items.length} 座建筑（${plan.level} 级）` +
    (dropped ? `，${dropped} 座因空间不足未放置` : "");
  save(); renderPalette(); renderStats(); draw();
}

/* 一键导入生产方案: 按摆放顺序给田地/林地分配作物, 手动指定的保留 */
function importPlan() {
  const r = window.__yimoResult;
  if (!r || !r.ok) {
    hoverInfo = "请先在「生产计算」页计算一次方案";
    draw(); return;
  }
  const seqs = cropsFromResult(r);
  let assigned = 0, kept = 0, empty = 0;
  for (const b of ["田地", "林地"]) {
    const fields = plan.items
      .filter((i) => i.name === b)
      .sort((a, c) => a.id - c.id);
    const seq = seqs[b] || [];
    if (!fields.length) continue;
    fields.forEach((f, k) => {
      if (f.crop && f.crop.manual) { kept++; return; }
      if (seq[k] != null) {
        f.crop = { name: seq[k], manual: false };
        assigned++;
      } else if (f.crop) {
        delete f.crop; empty++;
      }
    });
  }
  hoverInfo = `导入完成：自动分配 ${assigned} 块` +
    (kept ? `，手动指定保留 ${kept} 块` : "") +
    (empty ? `，清除 ${empty} 块` : "") +
    (!assigned && !kept ? "（请先摆放田地/林地）" : "");
  save(); draw();
}

/* ---------------- 导出 PNG ---------------- */
function exportPng() {
  const sv = { ...view };                     // 导出用完整视图
  view.scale = 1; view.ox = 0; view.oy = 0;
  draw();
  /* 图例条目先量宽分行(顶部), 画布高度随之确定, 不再截断 */
  const byName = {};
  for (const it of plan.items) byName[it.name] = (byName[it.name] || 0) + 1;
  const mc = document.createElement("canvas").getContext("2d");
  mc.font = "12px sans-serif";
  const W = CANVAS + 80;
  const rows = [];
  let row = [], lx = 0;
  for (const [name, cnt] of Object.entries(byName)) {
    const label = `${name}×${cnt}`;
    const wLab = 28 + mc.measureText(label).width;
    if (lx + wLab > W - 80 && row.length) { rows.push(row); row = []; lx = 0; }
    row.push(label); lx += wLab;
  }
  if (row.length) rows.push(row);
  const legY0 = 46, legH = rows.length * 20 + 8;
  const H = 34 + legH + 12 + CANVAS + 40;
  const off = document.createElement("canvas");
  off.width = W * 2; off.height = H * 2;
  const c = off.getContext("2d");
  c.scale(2, 2);
  c.fillStyle = "#FFFFFF"; c.fillRect(0, 0, W, H);
  c.fillStyle = "#57449F"; c.font = "700 18px sans-serif";
  c.fillText(`伊莫·家园规划（${plan.level} 级 · ${unlockedPlots().size} 块土地）`, 20, 26);
  /* 图例(顶部, 分行完整显示) */
  c.font = "12px sans-serif";
  rows.forEach((r, i) => {
    let x = 40;
    for (const label of r) {
      const name = label.slice(0, label.indexOf("×"));
      c.fillStyle = colorOf(name); c.fillRect(x, legY0 + i * 20 - 9, 10, 10);
      c.fillStyle = "#221E33"; c.fillText(label, x + 14, legY0 + i * 20);
      x += 28 + c.measureText(label).width;
    }
  });
  c.drawImage(canvas(), 40, legY0 + legH + 12, CANVAS, CANVAS);
  const a = document.createElement("a");
  a.download = `伊莫家园规划_${plan.level}级.png`;
  a.href = off.toDataURL("image/png");
  a.click();
  Object.assign(view, sv);                    // 恢复用户视图
  draw();
}

/* ---------------- 持久化 ---------------- */
const KEY = "yimo.plan.v1";
function save() {
  localStorage.setItem(KEY, JSON.stringify({ level: plan.level, items: plan.items, nextId }));
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (Array.isArray(d.items)) {
      d.items.forEach((it) => { if (it.name === "孵蛋器") it.name = "孵化器"; });
      plan.items = d.items.filter((it) => sizeOf(it.name));
      plan.level = d.level || 10;
      nextId = d.nextId || plan.items.length + 1;
    }
  } catch { /* 忽略坏数据 */ }
}

/* ---------------- 与生产计算页同步 ----------------
   计算页设定(等级/建筑数量)登记进 localStorage("yimo.v1")后,
   切到规划页时同步: 等级联动下拉框, 数量覆盖等级默认(调色板/一键布局) */
export function syncPlanner() {
  if (!GD) return;
  let d = {};
  try { d = JSON.parse(localStorage.getItem("yimo.v1") || "{}"); } catch { d = {}; }
  const lv = d.settings && d.settings.level;
  if (lv >= 1 && lv <= 16 && lv !== plan.level) {
    plan.level = lv;
    const sel = $("#plan-level");
    if (sel) sel.value = String(lv);
  }
  userCounts = d.counts && typeof d.counts === "object" ? d.counts : null;
  save(); renderPalette(); renderStats(); draw();
}

/* ---------------- 初始化 ---------------- */
function resizeCanvas() {           // 画布跟随容器宽度, 分辨率随 dpr
  const cv = canvas();
  const w = cv.clientWidth || 640;
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(320, Math.round(w * dpr));
  if (cv.width !== px) { cv.width = px; cv.height = px; }
  draw();
}

export function initPlanner() {
  if (GD) return;
  getGameData().then((d) => {
    GD = d;
    load();
    /* 计算页登记的等级/建筑数量先行同步(下拉框据此选中) */
    let sv = {};
    try { sv = JSON.parse(localStorage.getItem("yimo.v1") || "{}"); } catch { sv = {}; }
    const slv = sv.settings && sv.settings.level;
    if (slv >= 1 && slv <= 16) plan.level = slv;
    userCounts = sv.counts && typeof sv.counts === "object" ? sv.counts : null;
    const selEl = $("#plan-level");
    selEl.innerHTML = Array.from({ length: 16 }, (_, i) =>
      `<option value="${i + 1}"${i + 1 === plan.level ? " selected" : ""}>${i + 1} 级（${i + 1} 块土地）</option>`).join("");
    bindEvents();
    renderPalette(); renderStats();
    new ResizeObserver(() => resizeCanvas()).observe(canvas());
    resizeCanvas();
  });
}

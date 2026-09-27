/* 伊莫家园生产计算器 前端逻辑(纯前端: 本地引擎 + localStorage) */
import { getEngine, getGameData } from "./engine/client.js";
import { store } from "./engine/store.js";
import { initPlanner, syncPlanner } from "./planner.js?v=115";
import { initBlocks } from "./blocks.js?v=115";

"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const fmt = (n) =>
  n == null || isNaN(n) ? "—" :
  Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
const fmt1 = (n) =>
  n == null || isNaN(n) ? "—" :
  Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 1 });

/* 高区分度配色: 相邻色相/明度差异大, 白字对比度均≥4.5:1 */
const PALETTE = ["#1D4ED8", "#C2410C", "#0F766E", "#7C3AED", "#BE185D",
  "#4D7C0F", "#92400E", "#0E7490", "#6D28D9", "#B91C1C", "#475569",
  "#A16207", "#15803D", "#86198F", "#9A3412", "#1E3A8A"];
const colorCache = {};
const colorOf = (label) => {
  if (!(label in colorCache))
    colorCache[label] = PALETTE[Object.keys(colorCache).length % PALETTE.length];
  return colorCache[label];
};
/* 背景色上用黑字还是白字(相对亮度) */
const inkOn = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? "#1F2937" : "#FFFFFF";
};

const state = {
  level: null, hours: 24, coeff: 1.0,
  buildings: [], recipes: [], stock: {}, buildingEff: {},
  pins: [],
  products: [], prodSort: { k: "net_per_hour", dir: -1 },
  lastResult: null,
  creatures: [], formLabels: {},
};

/* 与后端 unique_label 一致的配方显示名(同名碰撞时高产版加"高速", 不显示等级) */
function recipeLabel(r) {
  const sibs = state.recipes.filter((x) => x.building === r.building && x.name === r.name);
  if (new Set(sibs.map((x) => x.output_qty)).size < 2)
    return r.name;
  const rate = (x) => {
    const t = x.grow_time_sec != null ? x.grow_time_sec : x.workload;
    return t ? x.output_qty / t : x.output_qty;
  };
  const mx = Math.max(...sibs.map(rate));
  const top = sibs.filter((x) => rate(x) === mx);
  return top.length === 1 && top[0].id === r.id ? `${r.name}(高速)` : r.name;
}

/* ---------------- 工具 ---------------- */
function chart(id) {
  const el = $("#" + id);
  if (!el.__chart) el.__chart = echarts.init(el);
  return el.__chart;
}
window.addEventListener("resize", () =>
  $$(".chart").forEach((el) => el.__chart && el.__chart.resize()));

function showError(msg) {
  const b = $("#error-banner");
  b.textContent = msg;
  b.classList.toggle("hidden", !msg);
}

function levelValue() {
  const v = parseInt($("#level").value, 10);
  return isNaN(v) ? null : v;
}
function collectCounts() {
  const out = {};
  $$("#building-editor input").forEach((i) => {
    const v = parseInt(i.value, 10);
    out[i.dataset.b] = isNaN(v) ? 0 : v;
  });
  return out;
}
function coeffValue() {
  const v = parseFloat($("#coeff").value);
  return (isNaN(v) ? 100 : v) / 100;
}
function hoursValue() {
  const sel = $("#hours").value;
  if (sel !== "custom") return parseFloat(sel);
  const v = parseFloat($("#hours-custom").value);
  return isNaN(v) ? 24 : v;
}
function switchValue() {
  return $("#opt-lazy").checked ? parseInt($("#max-switch").value, 10) : 0;
}
function recipesValue() {
  if (!$("#opt-lazy").checked) return null;
  const v = $("#max-recipes").value;
  return v === "" ? null : parseInt(v, 10);
}
/* ---------------- 最优方案 ---------------- */
async function runOptimize() {
  const btn = $("#btn-run");
  btn.disabled = true; btn.textContent = "计算中…";
  showError("");
  try {
    let pinData;
    try { pinData = collectPinRows(); }
    catch (e) { showError(e.message); return; }
    await new Promise((r) => setTimeout(r, 30));   // 让"计算中"先渲染
    const engine = await getEngine();
    const result = await engine.optimize({
      level: levelValue(),
      hours: hoursValue(),
      coeff: coeffValue(),
      counts: collectCounts(),
      excludeSeasonal: !$("#opt-use-seasonal").checked,
      lazy: $("#opt-lazy").checked,
      maxSwitches: switchValue(),
      maxRecipes: recipesValue(),
      stock: collectStockRows(),
      buildingEff: collectEffRows(),
      pins: pinData,
    });
    if (!result.ok) throw new Error(result.message);
    state.lastResult = result;
    window.__yimoResult = result;          // 供家园规划页导入作物安排
    state.level = levelValue(); state.hours = result.hours;
    renderOverview(result);
    renderArrangement(result);
    renderSellChart(result);
    renderNetChart(result);
    renderPinUsed(result);
    renderStockUsed(result);
    renderPlanTable(result);
    renderFlows(result);
    renderExcluded(result);
  } catch (e) {
    showError("计算失败: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "计算最优方案";
  }
}

function renderOverview(r) {
  $("#ov-lp").textContent = fmt(r.total_lp);
  $("#ov-int").textContent = fmt(r.total_int);
  $("#ov-int-k").textContent = r.lazy ? "懒人方案总价值" : "整数可行方案";
  $("#ov-ratio").textContent = r.lazy
    ? (r.segments && r.segments.length > 1
        ? `分 ${r.segments.length} 个时段（统一切换）`
        : switchValue() > 0 ? "未触发切换（全程一种配方更优）" : "每个建筑全程不换配方")
    : `达成率 ${(r.ratio * 100).toFixed(2)}%（轮次取整后）`;
  const lazyDesc = r.lazy
    ? ` · 懒人模式${switchValue() > 0 ? `(原料类最多换${switchValue()}次)` : ""}` +
      (recipesValue() ? ` · 原料类≤${recipesValue()}种` : "")
    : "";
  const effDesc = Object.keys(r.building_eff || {}).length
    ? ` · 精细效率${Object.keys(r.building_eff).length}项` : "";
  const pinDesc = r.pins && r.pins.length
    ? ` · 自定义${r.pins.length}项` : "";
  $("#ov-cond").textContent =
    `等级${r.level == null ? "不限" : r.level} · ${r.hours}h · ` +
    `系数${(r.work_coefficient * 100).toFixed(0)}%` +
    `${$("#opt-use-seasonal").checked ? " · 含赛季配方" : ""}` +
    lazyDesc + effDesc + pinDesc +
    `${Object.keys(r.stock || {}).length ? " · 含存量" : ""}`;
  $("#ov-kinds").textContent = r.sells.length;
  $("#ov-top").textContent = r.sells.length
    ? `价值最高: ${r.sells[0].item} ${fmt(r.sells[0].value)}`
    : "";
  $("#ov-bn-k").textContent = "平均每小时净利润";
  $("#ov-bn").textContent = r.total_int ? fmt(r.total_int / r.hours) : "—";
  $("#ov-bn2").textContent = `总净利润 ${fmt(r.total_int)} ÷ ${r.hours}h`;
}

/* 各产物净利润: 仅计实际出售的盈余价值, 中间产物自耗不计收益 */
function netAgg(r) {
  return r.sells
    .map((s) => ({ label: s.item, qty: s.surplus,
                   net: s.value, perHour: s.value / r.hours }))
    .sort((x, y) => y.net - x.net);
}

/* ---------------- 种植与生产安排 ---------------- */
/* 秒 -> "40分钟" / "2分42秒" / "6小时46分" */
function timeStr(sec) {
  sec = Math.round(sec);
  if (sec < 90) return `${sec}秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m}分${s}秒` : `${m}分钟`;
  }
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return m ? `${h}小时${m}分` : `${h}小时`;
}

/* 种植类: 轮次拆成 "X块×Y轮·Z时长" 的整数安排(每组并行, 各显各自时长) */
function growSplit(batches, cycles) {
  const full = Math.floor(batches / cycles);
  const rem = batches % cycles;
  const parts = [];
  if (full > 0) parts.push({ blocks: full, cycles });
  if (rem > 0) parts.push({ blocks: 1, cycles: rem });
  return { parts, slots: full + (rem > 0 ? 1 : 0) };
}
/* "8块×36轮·24小时＋1块×1轮·40分钟" */
function growPartsStr(g, timePerBatch) {
  return g.parts.map((pt) =>
    `${pt.blocks}块×${pt.cycles}轮·${timeStr(pt.cycles * timePerBatch)}`)
    .join("＋");
}
/* ---------------- 地块甘特图(田地/林地): 每块地一行的时间轴 ---------------- */
const GANTT_BUILDINGS = new Set(["田地", "林地"]);

/* 把方案轮次落到每块地上:
   普通模式 —— 最少换茬贪心: 作物按计划顺序装入"游标最早"的地,
   整块装满, 零头地由后续作物接续;
   懒人分时段 —— 按各时段实例数直接分配, 同作物尽量粘在同一块地 */
function ganttData(r, building) {
  const T = r.hours * 3600;
  const u = r.utilization.find(x => x.building === building);
  const count = u ? u.count : 0;
  if (!count) return null;
  const rows = Array.from({ length: count }, () => ({ cursor: 0, segs: [] }));
  if (r.segments && r.segments.length > 1) {
    const owner = new Map();               // label -> [rowIdx]
    for (const seg of r.segments) {
      const items = seg.buildings[building] || [];
      const need = new Map(items.map(x => [x.label, x.instances]));
      if (items.reduce((sm, x) => sm + x.instances, 0) > count) return null;
      for (const [label, idxs] of owner) {   // 回收多余地块
        const keep = need.get(label) || 0;
        while (idxs.length > keep) idxs.pop();
      }
      const occupied = new Set([...owner.values()].flat());
      const free = rows.map((_, i) => i).filter(i => !occupied.has(i));
      for (const [label, inst] of need) {
        let have = (owner.get(label) || []).length;
        if (!owner.has(label)) owner.set(label, []);
        while (have < inst) {
          const i = free.shift();
          if (i == null) return null;
          owner.get(label).push(i);
          have++;
        }
      }
      const s0 = seg.start_h * 3600, s1 = seg.end_h * 3600;
      for (const [label, idxs] of owner)
        for (const i of idxs) {
          rows[i].segs.push({ label, from: s0, to: s1 });
          rows[i].cursor = s1;
        }
    }
    return { rows, T, count };
  }
  const items = r.plan.filter(p => p.building === building &&
    p.ttype === "生长" && p.batches_int > 0);
  if (!items.length) return null;
  for (const it of items) {
    let rem = it.batches_int;
    const t = it.time_per_batch;
    while (rem > 0) {
      let best = -1;
      for (let i = 0; i < count; i++) {
        if (T - rows[i].cursor < t) continue;
        if (best < 0 || rows[i].cursor < rows[best].cursor) best = i;
      }
      if (best < 0) break;                 // 容差内放不下的尾差忽略
      const take = Math.min(rem, Math.floor((T - rows[best].cursor) / t));
      const row = rows[best];
      row.segs.push({ label: it.label, from: row.cursor,
        to: row.cursor + take * t, cycles: take });
      row.cursor += take * t;
      rem -= take;
    }
  }
  return { rows, T, count };
}
function renderGantt(r, building) {
  const g = ganttData(r, building);
  if (!g || !g.rows.some(rw => rw.segs.length)) return "";
  const T = g.T;
  const stepH = r.hours <= 6 ? 2 : r.hours <= 24 ? 6 : 12;
  const ticks = [];
  for (let h = 0; h < r.hours - 1e-6; h += stepH) ticks.push(h);
  ticks.push(r.hours);
  const rowsHtml = g.rows.map((rw, i) => {
    const segs = rw.segs.map(sg => {
      const w = (sg.to - sg.from) / T * 100;
      const c = colorOf(sg.label);
      const txt = w > 13 ? `${sg.label}·${timeStr(sg.to - sg.from)}`
        : w > 5.5 ? sg.label : "";
      return `<div class="g-seg${w <= 13 && w > 5.5 ? " brief" : ""}" ` +
        `style="left:${sg.from / T * 100}%;width:${w}%;` +
        `background:${c};color:${inkOn(c)}" ` +
        `title="${sg.label}${sg.cycles ? " " + sg.cycles + "轮" : ""} · ${timeStr(sg.from)}起 ${timeStr(sg.to - sg.from)}">${txt}</div>`;
    }).join("");
    return `<div class="g-row"><span class="g-lbl">${i + 1}号</span>` +
      `<div class="g-track">${segs}</div></div>`;
  }).join("");
  const collapsed = g.count > 14;
  return `<div class="gantt"><div class="g-head">${building} · ${g.count} 块 · 逐块时间轴` +
    `<span class="hint">${r.segments && r.segments.length > 1
      ? "按懒人分时段方案绘制" : "最少换茬的一种可行排布"}</span></div>` +
    `<div class="g-axis">${ticks.map(h =>
      `<span style="left:${h / r.hours * 100}%">${h % 1 ? (+h).toFixed(1) : h}h</span>`).join("")}</div>` +
    `<div class="g-rows${collapsed ? " collapsed" : ""}">${rowsHtml}</div>` +
    `${collapsed ? `<button class="g-toggle" type="button">展开全部 ${g.count} 块</button>` : ""}</div>`;
}
function bindGanttToggles(scope) {
  scope.querySelectorAll(".g-toggle").forEach(btn => {
    btn.onclick = () => {
      btn.previousElementSibling.classList.remove("collapsed");
      btn.remove();
    };
  });
}

function renderArrangement(r) {
  const body = $("#arr-body");
  const hint = $("#arr-hint");
  const T = r.hours * 3600;

  if (r.segments && r.segments.length > 1) {
    // 分时段: 时间线表格 (所有建筑统一切换)
    hint.textContent =
      `懒人模式 · 全程分 ${r.segments.length} 个时段，所有建筑在 ` +
      r.segments.slice(1).map((s) => `第 ${s.start_h} 小时`).join(" 和 ") + " 统一换配方。";
    const segs = r.segments;
    let html = "";
    for (const b of ["田地", "林地"]) html += renderGantt(r, b);
    html += `<table class="seg-table"><thead><tr><th>建筑</th>`;
    for (const s of segs)
      html += `<th>${fmt1(s.start_h)} – ${fmt1(s.end_h)} 小时</th>`;
    html += `</tr></thead><tbody>`;
    const bNames = [...new Set(segs.flatMap((s) => Object.keys(s.buildings)))];
    for (const b of bNames) {
      const cnt = r.utilization.find((u) => u.building === b)?.count ?? "";
      html += `<tr><td><b>${b}</b><br><span class="hint">${cnt} 座</span></td>`;
      for (const s of segs) {
        const items = s.buildings[b];
        html += `<td>${items
          ? items.map((x) =>
              `<span style="white-space:nowrap"><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorOf(x.label)}"></span>` +
              `${x.label} <b>${x.instances}</b>${x.unit}·${fmt(x.batches)}轮</span>`).join("<br>")
          : `<span class="hint">闲置</span>`}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    html = `<div class="table-wrap">${html}</div>`;
    // 制造类建筑不受切换限制, 单独列出
    const flex = r.plan.filter((p) => p.flexible);
    if (flex.length) {
      html += `<div class="mt arr-b"><div class="arr-head">制造类建筑` +
        `<span class="cap">材料到了就加工 · 全程灵活换配方</span></div>` +
        `<div class="arr-items">` +
        flex.map((p) =>
          `<span class="it"><span class="dot" style="background:${colorOf(p.label)}"></span>` +
          `<b>${p.seasonal ? "★" : ""}${p.building}·${p.label}</b> ` +
          `${fmt(p.batches)}轮（单轮${timeStr(p.time_per_batch)}）</span>`).join("") +
        `</div></div>`;
    }
    body.innerHTML = html;
    bindGanttToggles(body);
    return;
  }

  // 全程单段: 每建筑比例条 + 整数口径明细
    hint.textContent = r.lazy
      ? (r.max_recipes
        ? `原料建筑最多 ${r.max_recipes === 1 ? "一" : r.max_recipes} 种产物，自定义生产不占额；制造建筑不限。`
        : "原料建筑每块地全程一种产物；制造建筑不限。")
      : "如 9块×18轮＋1块×12轮：9 块地各种 18 轮，另 1 块种 12 轮。";
  const capBy = {};
  r.utilization.forEach((u) => (capBy[u.building] = u.cap));
  const order = [...r.utilization].sort((a, b) => b.pct - a.pct);
  const byB = {};
  for (const p of r.plan) (byB[p.building] = byB[p.building] || []).push(p);

  let html = "";
  for (const u of order) {
    const ps = byB[u.building];
    if (!ps || !ps.length) continue;
    html += `<div class="arr-b"><div class="arr-head">${u.building}` +
      `<span class="cap">${u.count} ${ps[0].unit === "地块" ? "块田" : "座"} · ` +
      `利用率 ${(u.pct * 100).toFixed(0)}%</span></div>`;
    if (GANTT_BUILDINGS.has(u.building))
      html += renderGantt(r, u.building);
    html += `<div class="arr-bar">`;
    for (const p of ps) {
      const share = Math.min(1, (p.batches_int * p.time_per_batch) / (capBy[u.building] || 1));
      if (share <= 0.0005) continue;
      const slotsInt = p.ttype === "生长"
        ? growSplit(p.batches_int, Math.floor(T / p.time_per_batch)).slots
        : (p.flexible || p.slots == null ? null : Math.max(1, Math.round(p.slots || 1)));
      const bg = colorOf(p.label);
      const label = share > 0.07
        ? `${p.label}${slotsInt ? ` ${fmt(slotsInt)}${p.unit}` : ""}` : "";
      html += `<div class="seg" style="width:${(share * 100).toFixed(2)}%;` +
        `background:${bg};color:${inkOn(bg)}" ` +
        `title="${p.label} ${(share * 100).toFixed(1)}%">${label}</div>`;
    }
    html += `</div><div class="arr-items">`;
    for (const p of ps) {
      if (!p.flexible && p.batches_int <= 0) continue;
      let txt;
      if (p.ttype === "生长") {
        const cycles = Math.floor(T / p.time_per_batch);
        const g = growSplit(p.batches_int, cycles);
        txt = `${growPartsStr(g, p.time_per_batch)}（每轮${timeStr(p.time_per_batch)}，共${fmt(p.batches_int)}轮）`;
      } else if (p.chain) {
        txt = `${fmt(p.batches)}轮（单轮${timeStr(p.time_per_batch)}，加工链环节）`;
      } else if (p.flexible) {
        txt = `${fmt(p.batches)}轮（单轮${timeStr(p.time_per_batch)}，` +
          `累计${timeStr(p.batches * p.time_per_batch)}，按材料灵活换配方）`;
      } else {
        txt = `${fmt(p.batches_int)}轮（单轮${timeStr(p.time_per_batch)}，` +
          `累计${timeStr(p.batches_int * p.time_per_batch)}` +
          `${r.lazy ? `，峰值${fmt(p.slots)}座` : ""}）`;
      }
      html += `<span class="it"><span class="dot" style="background:${colorOf(p.label)}"></span>` +
        `<b>${p.seasonal ? "★" : ""}${p.label}</b> ${txt}</span>`;
    }
    html += `</div></div>`;
  }
  body.innerHTML = html ||
    `<div class="hint">当前条件下没有需要安排的生产。</div>`;
  bindGanttToggles(body);
}

/* ---------------- 图表 ---------------- */
function renderSellChart(r) {
  chart("chart-sell").setOption({
    color: PALETTE,
    tooltip: { trigger: "item", formatter: (p) =>
      `${p.name}<br/>${fmt(p.value)}（${p.percent}%）` },
    legend: { type: "scroll", orient: "vertical", right: 0, top: "middle",
      textStyle: { fontSize: 11, color: "#334155" } },
    series: [{
      type: "pie", radius: ["42%", "70%"], center: ["38%", "50%"],
      itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 2 },
      label: { formatter: "{b}\n{d}%", fontSize: 11, color: "#334155" },
      data: r.sells.map((s) => ({ name: s.item, value: Math.round(s.value) })),
    }],
  }, true);
}

/* 横向条形图通用绘制(产物净利润) */
function renderHBar(elId, rows, valueKey) {
  const el = $("#" + elId);
  el.style.height = Math.max(300, rows.length * 28 + 46) + "px";
  if (el.__chart) { el.__chart.dispose(); el.__chart = null; }
  el.__chart = echarts.init(el);
  el.__chart.setOption({
    tooltip: { trigger: "item", formatter: (p) => {
      const d = rows[p.dataIndex];
      return `<b>${d.label}</b><br/>净利润 ${fmt(d.net)}<br/>` +
        `每小时 ${fmt(d.perHour)}<br/>出售 ${fmt(d.qty)}`;
    } },
    grid: { left: 8, right: 78, top: 6, bottom: 4, containLabel: true },
    xAxis: { type: "value",
      axisLabel: { formatter: (v) => fmtCompact(v), color: "#334155" },
      splitLine: { lineStyle: { color: "#E2E8F0" } } },
    yAxis: { type: "category", data: rows.map((x) => x.label),
      axisLabel: { fontSize: 11, color: "#334155" } },
    series: [{
      type: "bar",
      data: rows.map((x) => ({
        value: Math.round(x[valueKey]),
        itemStyle: { color: colorOf(x.label), borderRadius: [0, 3, 3, 0] },
      })),
      barMaxWidth: 13,
      label: { show: true, position: "right", fontSize: 10, color: "#334155",
        formatter: (p) => fmtCompact(p.value) },
    }],
  });
}

/* 数值紧凑格式: 34.5万 / 1,234 */
function fmtCompact(v) {
  v = Number(v);
  if (Math.abs(v) >= 10000)
    return (v / 10000).toFixed(v % 10000 === 0 ? 0 : 1) + "万";
  return v.toLocaleString("zh-CN");
}

function renderNetChart(r) {
  const rows = netAgg(r).reverse();          // 倒序供横向条形自下而上
  $("#net-title").innerHTML =
    `产物净利润（${r.hours} 小时内）` +
    `<span class="hint">只计实际卖出的部分，自用材料不计</span>`;
  renderHBar("chart-net", rows, "net");
}

function renderRankChart() {
  const rows = state.products
    .filter((p) => p.available && p.net_per_hour != null)
    .sort((a, b) => b.net_per_hour - a.net_per_hour)
    .slice(0, 15)
    .reverse()
    .map((p) => ({ ...p,
      matstr: (p.materials || []).map((m) => `${m.item}×${m.qty ?? "?"}`).join("、") }));
  chart("chart-rank").setOption({
    tooltip: { formatter: (p) => {
      const r = rows[p.dataIndex];
      const mats = (r.materials || []).map((m) =>
        `${m.item}×${m.qty ?? "?"}（${fmt(m.cost)}）`).join("<br/>");
      return `<b>${r.label}</b>（${r.building}）<br/>净收益 ${fmt(r.net_per_hour)}/小时` +
        `<br/>单轮净收益 ${fmt(r.net)} · ${fmt1(r.time)}s<br/>材料：<br>${mats || "无"}`;
    } },
    grid: { left: 6, right: 72, top: 8, bottom: 2, containLabel: true },
    xAxis: { type: "value",
      axisLabel: { formatter: (v) => fmtCompact(v), color: "#334155" } },
    yAxis: { type: "category", data: rows.map((r) => r.label),
      axisLabel: { fontSize: 11, color: "#334155" } },
    series: [{
      type: "bar",
      data: rows.map((r) => ({
        value: Math.round(r.net_per_hour),
        itemStyle: { color: colorOf(r.label), borderRadius: [0, 3, 3, 0] },
      })),
      label: { show: true, position: "right", fontSize: 10, color: "#334155",
        formatter: (p) => fmtCompact(p.value) },
      barMaxWidth: 14,
    }],
  }, true);
}

/* ---------------- 方案明细表 ---------------- */
function renderPlanTable(r) {
  const tbody = $("#plan-table tbody");
  const groups = new Map();
  for (const p of r.plan) {
    if (!groups.has(p.building)) groups.set(p.building, []);
    groups.get(p.building).push(p);
  }
  const order = [...r.utilization].sort((a, b) => b.pct - a.pct)
    .map((u) => u.building);
  let html = "";
  for (const b of [...order, ...groups.keys()].filter((v, i, a) => a.indexOf(v) === i)) {
    const ps = groups.get(b);
    if (!ps || !ps.length) continue;
    const u = r.utilization.find((x) => x.building === b);
    html += `<tr class="group"><td colspan="6">${b}（${u.count}座）　利用率 ` +
      `<b>${(u.pct * 100).toFixed(0)}%</b>${u.idle ? "　闲置" : ""}</td></tr>`;
    for (const p of ps) {
      let occupy;
      if (p.chain) {
        occupy = `累计${timeStr(p.batches * p.time_per_batch)} · 加工链`;
      } else if (p.flexible) {
        occupy = `累计${timeStr(p.batches * p.time_per_batch)} · 灵活换配方`;
      } else if (p.ttype === "生长" && !r.segments) {
        occupy = growPartsStr(
          growSplit(p.batches_int, Math.floor(r.hours * 3600 / p.time_per_batch)),
          p.time_per_batch);
      } else if (r.segments) {
        occupy = `峰值${fmt(p.slots)}${p.unit}`;
      } else {
        occupy = `累计${timeStr(p.batches_int * p.time_per_batch)}` +
          (r.lazy ? ` · 峰值${fmt(p.slots)}座` : "");
      }
      html += `<tr><td></td>` +
        `<td>${p.seasonal ? '<span class="star">★</span>' : ""}${p.label}</td>` +
        `<td class="ok">${fmt(p.batches_int)}</td>` +
        `<td>${fmt1(p.batches)}</td>` +
        `<td>${timeStr(p.time_per_batch)}</td>` +
        `<td>${occupy}</td></tr>`;
    }
  }
  tbody.innerHTML = html ||
    `<tr><td colspan="6" style="text-align:center;color:#64748B">无可用方案</td></tr>`;
}

function renderFlows(r) {
  const rows = Object.entries(r.flows)
    .map(([item, f]) => ({ item, ...f }))
    .sort((a, b) => b.value - a.value);
  $("#flow-table tbody").innerHTML = rows.map((f) => {
    const dests = (f.consumers || []).map((c) =>
      `<span class="dest">${c.label} <b>${fmt1(c.qty)}</b>` +
      `<i>${Math.round(c.pct * 100)}%</i></span>`).join("");
    const more = f.consumers_more > 0
      ? `<span class="dest">等 ${f.consumers_more} 项…</span>` : "";
    return `<tr><td>${f.item}</td><td>${fmt1(f.produced)}</td>` +
      `<td>${fmt1(f.consumed)}</td>` +
      `<td class="${f.surplus > 0.5 ? "ok" : ""}">${fmt1(f.surplus)}</td>` +
      `<td>${fmt(f.value)}</td>` +
      `<td>${fmt1(f.produced / r.hours)}</td>` +
      `<td>${fmt1(f.consumed / r.hours)}</td>` +
      `<td class="dests">${dests ? dests + more : "—"}</td></tr>`;
  }).join("");
}

function renderExcluded(r) {
  $("#excluded-list").innerHTML = r.excluded.length
    ? r.excluded.map((e) => `<span>${e.building}·${e.name}（${e.reason}）</span>`).join("")
    : "<span style='background:#F1EDFB;color:#57449F;border-color:#D9D0F2'>无</span>";
}

/* ---------------- 存量资源 ---------------- */
/* 与自定义生产一致: 待填虚线 / 已填实线高亮, 填完最后一行自动追加空白行 */
function stockRow(item = "", qty = "") {
  const div = document.createElement("div");
  div.className = "stock-row";
  div.innerHTML =
    `<input class="s-item" list="item-names" value="${item}" placeholder="资源名称" aria-label="资源名称">` +
    `<input class="s-qty" type="number" min="0" value="${qty}" placeholder="数量" aria-label="数量">` +
    `<button class="ghost" type="button" title="删除此行">×</button>`;
  const iItem = div.querySelector(".s-item");
  const iQty = div.querySelector(".s-qty");
  const updateFilled = () =>
    div.classList.toggle("filled",
      !!(iItem.value.trim() && parseFloat(iQty.value) > 0));
  const autoGrow = () => {
    if (div.classList.contains("filled") &&
        div === $("#stock-rows").lastElementChild)
      $("#stock-rows").appendChild(stockRow());
  };
  iItem.addEventListener("input", updateFilled);
  iQty.addEventListener("input", () => { updateFilled(); autoGrow(); });
  updateFilled();
  div.querySelector("button").onclick = () => div.remove();
  return div;
}

function renderStockRows() {
  const box = $("#stock-rows");
  box.innerHTML = "";
  for (const [item, qty] of Object.entries(state.stock))
    box.appendChild(stockRow(item, qty));
  box.appendChild(stockRow());                    // 始终留一行空白便于录入
  $("#stock-status").textContent = Object.keys(state.stock).length
    ? `已保存 ${Object.keys(state.stock).length} 项存量` : "暂无保存的存量";
}

function collectStockRows() {
  const out = {};
  $$("#stock-rows .stock-row").forEach((row) => {
    const item = row.querySelector(".s-item").value.trim();
    const qty = parseFloat(row.querySelector(".s-qty").value);
    if (item && !isNaN(qty) && qty > 0) out[item] = qty;
  });
  return out;
}

function persistStock() {
  state.stock = collectStockRows();
  store.save({ stock: state.stock });
  $("#stock-status").textContent = Object.keys(state.stock).length
    ? `已存 ${Object.keys(state.stock).length} 项（本机自动保存）`
    : "已清空（本机自动保存）";
}

function renderStockUsed(r) {
  const el = $("#stock-used");
  const entries = Object.entries(r.stock_used || {});
  if (!entries.length) {
    el.classList.add("hidden");
    return;
  }
  entries.sort((a, b) => b[1].value - a[1].value);
  const total = entries.reduce((s, [, v]) => s + v.value, 0);
  el.innerHTML = `<b>本方案动用存量：</b>` +
    entries.map(([it, v]) => `${it} ×${fmt(v.qty)}`).join("、") +
    `　<span class="hint">（价值 ${fmt(total)}）</span>`;
  el.classList.remove("hidden");
}

/* ---------------- 自定义生产(填入即生效) ---------------- */
/* 新行以占位符开始(虚线待填样式), 选好建筑+产物后变为已添加样式 */
function pinRow(building = "", recipeId = "", n = "") {
  const div = document.createElement("div");
  div.className = "pin-row";
  /* 只显示当前等级能够产出的产物(等级不限时显示全部); 已保存的超等级项保留显示 */
  const lv = levelValue();
  const lvOk = (r) => lv == null || r.req_level == null || r.req_level <= lv;
  const avail = state.recipes.filter((r) => lvOk(r) || r.id == recipeId);
  const bNames = new Set(avail.map((r) => r.building));
  if (building) bNames.add(building);          // 已保存的建筑不在等级范围内也保留
  const bOpts = `<option value=""${building ? "" : " selected"} disabled>选择建筑…</option>` +
    state.buildings.filter((b) => bNames.has(b.name)).map((b) =>
      `<option${b.name === building ? " selected" : ""}>${b.name}</option>`).join("");
  div.innerHTML =
    `<select class="p-building" aria-label="自定义建筑">${bOpts}</select>` +
    `<select class="p-recipe" aria-label="自定义产物">` +
    `<option value="" disabled selected>选择产物…</option></select>` +
    `<input class="p-n" type="number" min="1" placeholder="全部" value="${n}" ` +
    `title="留空＝整个建筑；填数字＝保底几个实例" aria-label="自定义数量">` +
    `<button class="ghost" type="button" title="删除此行">×</button>`;
  const bSel = div.querySelector(".p-building");
  const rSel = div.querySelector(".p-recipe");
  let curRid = recipeId;
  const updateFilled = () =>
    div.classList.toggle("filled", !!(bSel.value && rSel.value));
  const fillRecipes = () => {
    const rs = avail.filter((r) => r.building === bSel.value);
    rSel.innerHTML = `<option value=""${curRid ? "" : " selected"} disabled>选择产物…</option>` +
      rs.map((r) => `<option value="${r.id}"${r.id == curRid ? " selected" : ""}>` +
        `${recipeLabel(r)}</option>`).join("");
    updateFilled();
  };
  const autoGrow = () => {            // 填完最后一行时自动追加一行空白
    if (div.classList.contains("filled") &&
        div === $("#pin-rows").lastElementChild)
      $("#pin-rows").appendChild(pinRow());
  };
  fillRecipes();
  bSel.addEventListener("change", () => { curRid = ""; fillRecipes(); });
  rSel.addEventListener("change", () => { updateFilled(); autoGrow(); });
  div.querySelector("button").onclick = () => div.remove();
  return div;
}

function renderPinRows() {
  const box = $("#pin-rows");
  box.innerHTML = "";
  for (const p of state.pins)
    box.appendChild(pinRow(p.building, p.recipe_id, p.n ?? ""));
  box.appendChild(pinRow());                   // 留一行空白便于新增
  $("#pin-status").textContent = state.pins.length
    ? `已保存 ${state.pins.length} 项：` + state.pins.map((p) => {
        const r = state.recipes.find((x) => x.id === p.recipe_id);
        return `${p.building}→${r ? recipeLabel(r) : "?"}${p.n ? `×${p.n}` : ""}`;
      }).join("、")
    : "";
}

/* 面板当前内容的即时收集(计算时直接生效, 保存仅持久化);
   同建筑可多项部分自定义, 实例合计不得超过建筑数量 */
function collectPinRows() {
  const pins = [];
  const sum = {}, whole = {}, seen = new Set();
  $$("#pin-rows .pin-row").forEach((row) => {
    const b = row.querySelector(".p-building").value;
    const rid = parseInt(row.querySelector(".p-recipe").value, 10);
    if (!b || isNaN(rid)) return;              // 未填写的行跳过
    const key = `${b}#${rid}`;
    if (seen.has(key)) {
      const r = state.recipes.find((x) => x.id === rid);
      throw new Error(`自定义生产重复：${b}·${r ? recipeLabel(r) : rid}`);
    }
    seen.add(key);
    const cnt = state.buildings.find((x) => x.name === b)?.count ?? 1;
    const nv = parseInt(row.querySelector(".p-n").value, 10);
    const hasN = !isNaN(nv) && nv >= 1;
    if (!hasN) {                               // 整建筑全力
      if (whole[b] || sum[b])
        throw new Error(`${b} 已有整建筑自定义项，不能再叠加其他项`);
      whole[b] = true;
    } else {                                   // 部分自定义
      if (whole[b])
        throw new Error(`${b} 已有整建筑自定义项，不能再叠加其他项`);
      sum[b] = (sum[b] || 0) + nv;
      if (sum[b] > cnt)
        throw new Error(`${b} 的自定义实例合计 ${sum[b]}，超过拥有数量 ${cnt}`);
    }
    pins.push({ building: b, recipe_id: rid, ...(hasN ? { n: nv } : {}) });
  });
  return pins;
}

function collectEffRows() {
  const effs = {};
  $$("#eff-rows input").forEach((i) => {
    if (i.value === "") return;
    const v = parseFloat(i.value);
    if (!isNaN(v) && v > 0 && Math.abs(v - 100) > 1e-9)
      effs[i.dataset.b] = v / 100;
  });
  return effs;
}

function persistPins() {
  let pins;
  try { pins = collectPinRows(); }
  catch (e) { showError(e.message); return; }
  state.pins = pins;
  store.save({ pins: pins.map((p) => {
    const r = state.recipes.find((x) => x.id === p.recipe_id);
    return { building: p.building, product: r ? r.name : "", n: p.n };
  }) });
  $("#pin-status").textContent = pins.length
    ? `已设 ${pins.length} 项：` + pins.map((p) => {
        const r = state.recipes.find((x) => x.id === p.recipe_id);
        return `${p.building}→${r ? recipeLabel(r) : "?"}${p.n ? `×${p.n}` : ""}`;
      }).join("、") + "（本机自动保存）"
    : "";
  showError("");
}
function persistCounts() {
  store.save({ counts: collectCounts() });
}

function renderPinUsed(r) {
  const el = $("#pin-used");
  if (!r.pins || !r.pins.length) {
    el.classList.add("hidden");
    return;
  }
  el.innerHTML = `<b>自定义生产：</b>` +
    r.pins.map((p) => `${p.building} → ${p.label}${p.n ? ` ×${p.n}（部分）` : ""}`).join("、") +
    `　<span class="hint">（${r.pins.some((p) => p.n)
      ? "保底产能，其余自由安排" : "整个建筑只做这个"}）</span>`;
  el.classList.remove("hidden");
}


/* ---------------- 产物收益 ---------------- */
async function loadProducts() {
  const engine = await getEngine();
  state.products = await engine.productAnalysis({
    level: levelValue(),
    coeff: coeffValue(),
    excludeSeasonal: !$("#opt-use-seasonal").checked,
    buildingEff: collectEffRows(),
  });
  renderProducts();
  renderRankChart();
}

function renderProducts() {
  const bfilter = $("#f-building").value;
  const q = $("#f-search").value.trim().toLowerCase();
  const onlyAvail = $("#f-avail").checked;
  const onlyPos = $("#f-positive").checked;

  let rows = state.products.map((p) => ({
    ...p,
    matstr: (p.seed_price ? `种子${fmt(p.seed_price)}、` : "") +
      (p.materials || []).map((m) => `${m.item}×${m.qty ?? "?"}`).join("、"),
  }));
  if (bfilter) rows = rows.filter((p) => p.building === bfilter);
  if (onlyAvail) rows = rows.filter((p) => p.available);
  if (onlyPos) rows = rows.filter((p) => p.net > 0);
  if (q) rows = rows.filter((p) =>
    (p.label + p.building + p.matstr).toLowerCase().includes(q));

  const { k, dir } = state.prodSort;
  rows.sort((a, b) => {
    const av = a[k], bv = b[k];
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string") return dir * av.localeCompare(bv, "zh");
    return dir * (av - bv);
  });

  $("#prod-table tbody").innerHTML = rows.map((p) => {
    const status = p.available
      ? '<td class="ok">✓ 可用</td>'
      : `<td class="bad">${p.reason || "不可用"}</td>`;
    const matTip = (p.materials || []).map((m) =>
      `${m.item}×${m.qty ?? "?"}（${fmt(m.cost)}）`).join("\n");
    return `<tr>` +
      `<td>${p.seasonal ? '<span class="star">★</span>' : ""}${p.label}</td>` +
      `<td>${p.building}</td>` +
      `<td>${p.req_level == null ? "—" : p.req_level}</td>` +
      `<td>${p.time == null ? "—" : fmt1(p.time)}</td>` +
      `<td>${fmt1(p.output_qty)}</td>` +
      `<td>${p.sell_price == null ? "不可售" : fmt(p.sell_price)}</td>` +
      `<td>${fmt(p.gross)}</td>` +
      `<td>${fmt(p.cost)}</td>` +
      `<td class="${p.net > 0 ? "ok" : "bad"}">${fmt(p.net)}</td>` +
      `<td><b>${p.net_per_hour == null ? "—" : fmt(p.net_per_hour)}</b></td>` +
      status +
      `<td class="matlist" title="${matTip.replace(/"/g, "&quot;")}">${p.matstr || "—"}</td>` +
      `</tr>`;
  }).join("") ||
    `<tr><td colspan="12" style="text-align:center;color:#64748B">没有匹配的产物</td></tr>`;

  $$("#prod-table thead th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === k);
    th.textContent = th.textContent.replace(/ [↑↓]$/, "");
    if (th.dataset.k === k) th.textContent += dir > 0 ? " ↑" : " ↓";
  });
}

/* ---------------- 数据管理 ---------------- */
function renderBuildingEditor() {
  $("#building-editor").innerHTML = state.buildings.map((b) =>
    `<label>${b.name}<input data-b="${b.name}" type="number" min="0" ` +
    `value="${b.count ?? 1}" aria-label="${b.name}数量"></label>`).join("");
  const opts = state.buildings.map((b) =>
    `<option value="${b.name}">${b.name}</option>`).join("");
  $("#f-building").innerHTML =
    `<option value="">全部建筑</option>` + opts;
}

async function refreshData() {
  const engine = await getEngine();
  const gdata = await getGameData();
  const d = store.load();
  const counts = d.counts || {};
  state.buildings = engine.buildings.map((b) => ({
    name: b.name, count: counts[b.name] != null ? counts[b.name] : b.count }));
  state.recipes = engine.recipes;
  state.creatures = gdata.creatures || [];
  state.formLabels = gdata.form_labels || {};
  state.stock = d.stock || {};
  state.buildingEff = d.eff || {};
  state.pins = (d.pins || [])
    .map((p) => {
      const r = state.recipes.find((x) =>
        x.building === p.building && x.name === p.product);
      return r ? { building: p.building, recipe_id: r.id, n: p.n } : null;
    })
    .filter(Boolean);
  restoreSettings(d.settings || {});
  renderBuildingEditor();
  renderStockRows();
  renderEffRows();
  renderPinRows();
  $("#stock-status").textContent = Object.keys(state.stock).length
    ? `已存 ${Object.keys(state.stock).length} 项（本机）` : "";
  const names = [...new Set(state.recipes.flatMap((r) =>
    [r.name, r.extra_product, ...r.inputs.map((i) => i.item)].filter(Boolean)))]
    .sort((a, b) => a.localeCompare(b, "zh"));
  $("#item-names").innerHTML = names.map((n) => `<option value="${n}">`).join("");
  await loadProducts();
  initYimo();
}

/* ---------------- 本机设置恢复/自动保存 ---------------- */
function restoreSettings(s) {
  if (s.level == null && !s.mig10) {     // 一次性迁移: 默认等级10
    s.level = 10;
    s.mig10 = true;
    store.save({ settings: s });
  }
  if ("level" in s) $("#level").value = s.level == null ? "" : s.level;
  if (s.hours) {
    $("#hours").value = String(s.hours);
    if (s.hoursCustom != null) $("#hours-custom").value = s.hoursCustom;
    $("#hours-custom").classList.toggle("hidden", $("#hours").value !== "custom");
  }
  if (s.coeff != null) $("#coeff").value = s.coeff;
  if (s.useSeasonal) $("#opt-use-seasonal").checked = true;
  if (s.lazy) $("#opt-lazy").checked = true;
  if (s.maxRecipes != null) $("#max-recipes").value = String(s.maxRecipes);
  if (s.maxSwitch != null) $("#max-switch").value = String(s.maxSwitch);
  syncLazyControls();
}
function saveSettings() {
  store.save({ settings: {
    level: $("#level").value === "" ? null : parseInt($("#level").value, 10),
    hours: $("#hours").value,
    hoursCustom: $("#hours-custom").value,
    coeff: $("#coeff").value,
    useSeasonal: $("#opt-use-seasonal").checked,
    lazy: $("#opt-lazy").checked,
    maxRecipes: $("#max-recipes").value,
    maxSwitch: $("#max-switch").value,
    mig10: true,
  } });
}

/* ---------------- 事件绑定与初始化 ---------------- */
$("#btn-run").addEventListener("click", async () => {
  await Promise.all([runOptimize(), loadProducts()]);
});

$("#hours").addEventListener("change", () =>
  $("#hours-custom").classList.toggle("hidden", $("#hours").value !== "custom"));

function syncLazyControls() {
  const on = $("#opt-lazy").checked;
  $("#sw-wrap").classList.toggle("hidden", !on);
  $("#sw2-wrap").classList.toggle("hidden", !on);
  const uniform = $("#max-recipes").value === "1";
  $("#max-switch").disabled = uniform;        // 整齐划一时切换无意义
  if (uniform) $("#max-switch").value = "0";
}
$("#opt-lazy").addEventListener("change", syncLazyControls);
$("#max-recipes").addEventListener("change", syncLazyControls);

$("#f-building").addEventListener("change", renderProducts);
$("#f-search").addEventListener("input", renderProducts);
$("#f-avail").addEventListener("change", renderProducts);
$("#f-positive").addEventListener("change", renderProducts);

$("#btn-stock-add").addEventListener("click", () =>
  $("#stock-rows").appendChild(stockRow()));

/* ---------------- 工作效率(填入即生效) ---------------- */
/* 已填入效率的建筑高亮显示, 区别于跟随全局系数的默认项 */
function renderEffRows() {
  const wl = [...new Set(state.recipes
    .filter((r) => r.workload != null).map((r) => r["building"]))]
    .sort((a, b) => a.localeCompare(b, "zh"));
  $("#eff-rows").innerHTML = wl.map((b) => {
    const v = state.buildingEff[b];
    return `<label class="eff-cell${v ? " filled" : ""}">${b}` +
      `<span style="display:flex;align-items:center;gap:4px">` +
      `<input data-b="${b}" type="number" min="5" max="1000" step="5" ` +
      `value="${v ? Math.round(v * 100) : ""}" placeholder="全局" ` +
      `aria-label="${b}效率">%</span></label>`;
  }).join("");
  $$("#eff-rows input").forEach((i) =>
    i.addEventListener("input", () =>
      i.closest(".eff-cell").classList.toggle("filled", i.value !== "")));
  $("#eff-status").textContent = Object.keys(state.buildingEff).length
    ? `已保存 ${Object.keys(state.buildingEff).length} 项覆盖（${Object.entries(state.buildingEff)
        .map(([b, e]) => `${b} ${Math.round(e * 100)}%`).join("、")}）`
    : "其余建筑跟随全局系数";
}

function persistEff() {
  state.buildingEff = collectEffRows();
  store.save({ eff: state.buildingEff });
  $("#eff-status").textContent = Object.keys(state.buildingEff).length
    ? `已设 ${Object.keys(state.buildingEff).length} 项（本机自动保存）`
    : "其余建筑跟随全局系数";
}


$("#btn-pin-add").addEventListener("click", () =>
  $("#pin-rows").appendChild(pinRow()));

$$("#prod-table thead th").forEach((th) => {
  if (!th.dataset.k) return;
  th.addEventListener("click", () => {
    const k = th.dataset.k;
    state.prodSort = {
      k,
      dir: state.prodSort.k === k ? -state.prodSort.dir : -1,
    };
    renderProducts();
  });
});

/* 本机自动保存(去抖 350ms): 建筑数量/存量/效率/自定义/顶部设置 */
let saveTimer = null;
const autoSave = (fn) => () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(fn, 350);
};
let recomputeTimer = null;
$("#building-editor").addEventListener("input", autoSave(() => {
  persistCounts();
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => runOptimize(), 800);  // 数量变化自动重算
}));
$("#stock-rows").addEventListener("input", autoSave(persistStock));
$("#eff-rows").addEventListener("input", autoSave(persistEff));
$("#pin-rows").addEventListener("change", autoSave(persistPins));
$("#pin-rows").addEventListener("input", autoSave(persistPins));
["#level", "#hours", "#hours-custom", "#coeff", "#opt-use-seasonal",
 "#opt-lazy", "#max-recipes", "#max-switch"].forEach((sel) => {
  const el = $(sel);
  el.addEventListener("change", saveSettings);
  el.addEventListener("input", autoSave(saveSettings));
});

/* ================= 伊莫图鉴 tab ================= */
/* 能力ID -> 展示名(库内为 wiki 原名: 岩/割除/特殊/采香产香) */
const ABILITY_NAMES = {
  1000: "火", 1001: "草", 1002: "水", 1003: "土", 1004: "电", 1005: "冰",
  1006: "风", 1007: "暗", 1008: "光", 1100: "搬运", 1101: "手工",
  1102: "游玩", 1103: "制香",
};
/* 伊莫属性展示名: 库内"岩"游戏内叫"土" */
const EL_DISPLAY = { "岩": "土" };
const elName = (e) => EL_DISPLAY[e] || e;
/* 属性 -> 元素能力ID(取对应图标, 岗位属性条件折算成能力筛选) */
const EL_ABID = {
  "火": 1000, "草": 1001, "水": 1002, "岩": 1003, "电": 1004,
  "冰": 1005, "风": 1006, "暗": 1007, "光": 1008,
};
const abIcon = (id) => `./icons/${id}.png`;
const STAGE_NAMES = { "1": "新生期", "2": "成长期", "3": "成熟期" };

/* 家族=进化链成员编号(供岗位推荐"XX家族"筛选) */
const FAMILY_SERIALS = {
  "云朵羊": ["017", "018", "019"],           // 云朵羊/蓬蓬羊/眠眠羊
  "羞羞獭": ["049", "050", "051", "052"],    // 羞羞獭/泡泡獭/漂漂獭/胖胖獭
  "采蜜鸟": ["038", "039"],                  // 采蜜鸟/香氛鸟
};

/* 建筑岗位条件: mbti 为后天养成性格(仅展示); kind/v 为可筛选的先天条件
   (element 的 v 用库内属性值, 展示时经 elName 转换) */
const STATION_TRAITS = {
  "矿山":         { mbti: "P", kind: "element", v: "岩", text: "土属性" },
  "烟囱煅烧炉":   { mbti: "S", kind: "element", v: "火", text: "火属性" },
  "木工台":       { mbti: "E", kind: "ability", v: 1101, text: "手工属性" },
  "绵云草床":     { mbti: "J", kind: "family",  v: "云朵羊", text: "云朵羊家族" },
  "汐语沙堡":     { mbti: "J", kind: "family",  v: "羞羞獭", text: "羞羞獭家族" },
  "采蜜鸟屋":     { mbti: "I", kind: "family",  v: "采蜜鸟", text: "采蜜鸟家族", icon: 1103 },
  "水井":         { mbti: "F", kind: "element", v: "水", text: "水属性" },
  "手作台":       { mbti: "J", kind: "ability", v: 1101, text: "手工属性" },
  "旋转木马磨坊": { mbti: "T", kind: "element", v: "风", text: "风属性" },
  "摩天轮纺车":   { mbti: "F", kind: "element", v: "风", text: "风属性" },
  "风味腌制罐":   { mbti: "P", kind: "element", v: "暗", text: "暗属性" },
  "超旺灶台":     { mbti: "N", kind: "element", v: "火", text: "火属性" },
  "蹦蹦酿造桶":   { mbti: "E", kind: "element", v: "水", text: "水属性" },
  "音乐烘干机":   { mbti: "N", kind: "element", v: "暗", text: "暗属性" },
  "熬制锅":       { mbti: "T", kind: "element", v: "火", text: "火属性" },
  "留声制香台":   { mbti: "I", kind: "family",  v: "采蜜鸟", text: "采蜜鸟家族", icon: 1103 },
  "抓夹烹饪炉":   { mbti: "S", kind: "element", v: "火", text: "火属性" },
  /* 库外建筑(暂无配方数据): 仅出现在岗位推荐, 无性格要求 */
  "日光灯":       { mbti: "",  kind: "element", v: "光", text: "光属性" },
  "热能炉":       { mbti: "",  kind: "element", v: "火", text: "火属性" },
  "制冷机":       { mbti: "",  kind: "element", v: "冰", text: "冰属性" },
};
const MBTI_DESC = {
  E: "外向", I: "内向", S: "实感", N: "直觉",
  T: "思考", F: "情感", J: "条理", P: "随性",
};

const yimoFilter = {
  abilities: new Set(),
  level: 0, family: "", q: "",
};
let yimoReady = false;

/* 页签切换: 品牌名/页面标题随页签变化 */
const TAB_TITLES = {
  calc: "伊莫·家园生产计算",
  yimo: "伊莫·家园图鉴",
  plan: "伊莫·家园规划",
  blocks: "伊莫·积木图纸",
};
function switchTab(name) {
  $$("#main-tabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tab-page").forEach((el) => el.classList.toggle("hidden", el.id !== "tab-" + name));
  const title = TAB_TITLES[name] || TAB_TITLES.calc;
  $("#brand").textContent = title;
  document.title = title;
  if (name === "calc")               // 隐藏期间尺寸变化的图表重排
    $$(".chart").forEach((el) => el.__chart && el.__chart.resize());
  if (name === "plan")               // 计算页设定登记后同步到规划页
    syncPlanner();
  if (name === "blocks")
    initBlocks();
}
$("#main-tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (b) switchTab(b.dataset.tab);
});

function yimoMatch(f) {
  const ab = {};
  for (const [id, lv] of f.abilities) ab[id] = lv;
  if (yimoFilter.abilities.size) {   // 所选能力类型全部具备且达到等级
    for (const id of yimoFilter.abilities)
      if (!(ab[id] != null && ab[id] >= Math.max(yimoFilter.level, 1)))
        return false;
  } else if (yimoFilter.level >= 2) { // 未选类型: 任意能力达到该等级即可
    if (!f.abilities.some(([, lv]) => lv >= yimoFilter.level)) return false;
  }
  if (yimoFilter.family &&
      !FAMILY_SERIALS[yimoFilter.family].includes(f.serial))
    return false;
  if (yimoFilter.q && !f.name.includes(yimoFilter.q) &&
      !f.serial.includes(yimoFilter.q))
    return false;
  return true;
}

function renderYimo() {
  const forms = state.creatures.filter(yimoMatch);
  const bySerial = new Map();
  for (const f of forms) {
    if (!bySerial.has(f.serial)) bySerial.set(f.serial, []);
    bySerial.get(f.serial).push(f);
  }
  const hot = (id) => yimoFilter.abilities.has(id);
  $("#yimo-results").innerHTML = [...bySerial.values()].map((fs) => {
    const head = fs[0];
    const rows = fs.map((f) => {
      const fl = state.formLabels[f.form] || f.form;
      const abs = f.abilities.map(([id, lv]) =>
        `<span class="yab${hot(id) ? " hot" : ""}"><img src="${abIcon(id)}" alt="">${ABILITY_NAMES[id] || id}<i>Lv${lv}</i></span>`).join("");
      return `<div class="yrow"><span class="yform">${fl}</span>` +
        `<span class="ystage">${STAGE_NAMES[f.stage] || ""}</span>` +
        `<span class="yabs">${abs}</span></div>`;
    }).join("");
    return `<div class="ycard"><div class="yhead">` +
      `<span class="ysn">${head.serial}</span><b>${head.name}</b>` +
      `<span class="yel">${head.element.split("/").map(elName).join("/")}</span></div>${rows}</div>`;
  }).join("") || `<div class="hint">没有符合条件的伊莫形态，试试放宽筛选</div>`;
  $("#yimo-count").textContent =
    `共 ${bySerial.size} 只伊莫 · ${forms.length} 个形态`;
}

/* 岗位条件(不含性格)在图鉴中的匹配形态数 */
function stationCount(t) {
  if (t.kind === "ability")
    return state.creatures.filter((f) =>
      f.abilities.some(([id]) => id === t.v)).length;
  if (t.kind === "element")
    return state.creatures.filter((f) => f.element.split("/").includes(t.v)).length;
  return state.creatures.filter((f) =>
    FAMILY_SERIALS[t.v].includes(f.serial)).length;
}

/* 无需岗位推荐的建筑: 田地/林地种什么都行;
   设备类(光照/温度/仓储/舞力能量机/迷立方制造机)无岗位概念, 不进岗位区 */
const STATION_HIDDEN = new Set([
  "田地", "林地", "日光灯", "热能炉", "制冷机",
  "仓储单元", "舞力能量机", "迷立方制造机", "孵化器",
]);

/* 不在库内但有岗位条件的建筑 */
const EXTRA_STATIONS = [];          /* 设备建筑已入库, 无额外岗位建筑 */

/* 岗位选中态: 点击岗位卡后高亮, 手动改动筛选条件即取消 */
let stationSel = "";
function clearStationSel() {
  if (!stationSel) return;
  stationSel = "";
  $$("#station-grid .stcard.sel").forEach((c) => c.classList.remove("sel"));
}

/* 排序键 = 所需属性(能力ID): 元素按 1000~1008, 家族按图标能力(1102/1103),
   手工1101; 无条件(待补充)排最后; 同键保持原有先后 */
function stationSortKey(name) {
  const t = STATION_TRAITS[name];
  if (!t) return 9999;
  if (t.kind === "ability") return t.v;
  if (t.kind === "element") return EL_ABID[t.v];
  return t.icon || 1102;
}

function renderStations() {
  const names = [...state.buildings.map((b) => b.name), ...EXTRA_STATIONS]
    .filter((n) => !STATION_HIDDEN.has(n))
    .map((n, i) => [n, i])
    .sort((a, b) => stationSortKey(a[0]) - stationSortKey(b[0]) || a[1] - b[1])
    .map(([n]) => n);
  $("#station-grid").innerHTML = names
    .map((name) => {
      const t = STATION_TRAITS[name];
      if (!t)
        return `<div class="stcard missing"><div class="stb">${name}</div>` +
          `<div class="streq muted">数据待补充</div></div>`;
      const icon = t.kind === "ability" ? t.v
        : t.kind === "element" ? EL_ABID[t.v]
        : (t.icon || 1102);                // 家族专供建筑: 默认游玩, 采香家族用制香
      const badge = t.mbti
        ? `<span class="stmbti ${"INFP".includes(t.mbti) ? "warm" : "cool"}" title="${MBTI_DESC[t.mbti] || ""}性格">${t.mbti}</span>`
        : `<span class="stmbti none" title="无性格要求">?</span>`;
      return `<div class="stcard${name === stationSel ? " sel" : ""}" data-station="${name}" role="button" tabindex="0">` +
        `<div class="stb">${name}</div>` +
        `<div class="streq">${badge}` +
        (icon ? `<img class="sico" src="${abIcon(icon)}" alt="">` : "") +
        `${t.text}<span class="stcnt">${stationCount(t)} 形态</span></div></div>`;
    }).join("");
}

function syncYimoChips() {
  $$("#ab-chips .chip").forEach((c) =>
    c.classList.toggle("on", yimoFilter.abilities.has(+c.dataset.ab)));
  $$("#lv-chips .chip").forEach((c) =>
    c.classList.toggle("on", +c.dataset.lv === yimoFilter.level));
  $("#family-tag-row").classList.toggle("hidden", !yimoFilter.family);
  $("#family-tags").innerHTML = yimoFilter.family
    ? `<button type="button" class="chip on">${yimoFilter.family}家族 ✕</button>` : "";
}

function buildYimoChips() {
  const abCnt = {};
  for (const f of state.creatures) {
    for (const [id] of f.abilities) abCnt[id] = (abCnt[id] || 0) + 1;
  }
  $("#ab-chips").innerHTML = Object.keys(ABILITY_NAMES)
    .filter((id) => abCnt[id])
    .map((id) =>
      `<button type="button" class="chip" data-ab="${id}">` +
      `<img class="cico" src="${abIcon(id)}" alt="">${ABILITY_NAMES[id]}<i>${abCnt[id]}</i></button>`).join("");
  $("#lv-chips").innerHTML = [[0, "全部"], [2, "Lv2+"], [3, "Lv3+"], [4, "Lv4"]]
    .map(([v, t]) =>
      `<button type="button" class="chip${v === 0 ? " on" : ""}" data-lv="${v}">${t}</button>`).join("");
}

function resetYimoFilter() {
  clearStationSel();
  yimoFilter.abilities.clear();
  yimoFilter.level = 0;
  yimoFilter.family = "";
  yimoFilter.q = "";
  $("#yimo-search").value = "";
  syncYimoChips();
  renderYimo();
}

/* 点击岗位卡片 -> 按该岗位先天条件筛选(性格为后天养成不参与)
   属性条件折算为对应的元素能力(如 风属性 -> 能力"风") */
function applyStationFilter(name) {
  const t = STATION_TRAITS[name];
  if (!t) return;
  stationSel = name;
  yimoFilter.abilities.clear();
  yimoFilter.family = "";
  if (t.kind === "ability") yimoFilter.abilities.add(t.v);
  else if (t.kind === "element") yimoFilter.abilities.add(EL_ABID[t.v]);
  else yimoFilter.family = t.v;
  $$("#station-grid .stcard").forEach((c) =>
    c.classList.toggle("sel", c.dataset.station === name));
  syncYimoChips();
  renderYimo();
  $("#yimo-results").scrollIntoView({ behavior: "smooth", block: "start" });
}

let yimoSearchTimer = null;
function initYimo() {
  if (yimoReady || !state.creatures.length) return;
  yimoReady = true;
  buildYimoChips();
  renderStations();
  syncYimoChips();
  renderYimo();
  $("#ab-chips").addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (!c) return;
    clearStationSel();
    const id = +c.dataset.ab;
    yimoFilter.abilities.has(id) ? yimoFilter.abilities.delete(id)
      : yimoFilter.abilities.add(id);
    syncYimoChips();
    renderYimo();
  });
  $("#lv-chips").addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (!c) return;
    clearStationSel();
    yimoFilter.level = +c.dataset.lv;
    syncYimoChips();
    renderYimo();
  });
  $("#family-tags").addEventListener("click", () => {
    clearStationSel();
    yimoFilter.family = "";
    syncYimoChips();
    renderYimo();
  });
  $("#yimo-search").addEventListener("input", () => {
    clearTimeout(yimoSearchTimer);
    yimoSearchTimer = setTimeout(() => {
      yimoFilter.q = $("#yimo-search").value.trim();
      renderYimo();
    }, 150);
  });
  $("#yimo-reset").addEventListener("click", resetYimoFilter);
  $("#station-grid").addEventListener("click", (e) => {
    const card = e.target.closest(".stcard[data-station]");
    if (card) applyStationFilter(card.dataset.station);
  });
  $("#station-grid").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".stcard[data-station]");
    if (card) { e.preventDefault(); applyStationFilter(card.dataset.station); }
  });
}

/* ---------------- 访问统计(GoatCounter) ----------------
   注册 goatcounter.com 后: Settings→API→Create key(只勾 Read statistics),
   把 site 与 token 填到下面, 并把 demo 改为 false 即启用真实数据 */
const GOAT = {
  site: "https://emilio.goatcounter.com",
  token: "1cveakv36lx6w15i9um2hsbpcn14bu8woakh7wvd2igbmew3br4",
};
/* 总访问=全部浏览量; 当前在线=今日当前小时的访问量(API仅支持按小时) */
async function goatFetch() {
  try {
    const r = await fetch(`${GOAT.site}/api/v0/stats/total?start=2000-01-01`,
      { headers: { Authorization: `Bearer ${GOAT.token}` } });
    if (!r.ok) return null;
    const d = await r.json();
    const today = new Date().toISOString().slice(0, 10);
    const row = (d.stats || []).find((x) => x.day === today);
    return { total: d.total || 0, hour: (row && row.hourly[new Date().getHours()]) || 0 };
  } catch { return null; }
}
function renderStats(total, online) {
  const bar = $("#stats-bar");
  if (total == null && online == null) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  if (total != null) $("#st-total").textContent = total.toLocaleString("zh-CN");
  if (online != null) $("#st-online").textContent = online.toLocaleString("zh-CN");
}
async function refreshStats() {
  const d = await goatFetch();
  renderStats(d ? d.total : null, d ? d.hour : null);
}
async function initAnalytics() {
  if (!GOAT.site || !GOAT.token) return;
  const sc = document.createElement("script");
  sc.async = true;
  sc.dataset.goatcounter = `${GOAT.site}/count`;
  sc.src = "https://gc.zgo.at/count.v3.js";
  document.head.appendChild(sc);
  await refreshStats();
  setInterval(refreshStats, 60000);
}

(async function init() {
  try {
    await refreshData();
    await runOptimize();
  } catch (e) {
    showError("初始化失败: " + e.message);
  }
  initAnalytics();
  initPlanner();
})();

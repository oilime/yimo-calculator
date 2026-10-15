/* 伊莫家园生产计算 —— 浏览器端计算核心
   由 yimo_core.py 逐函数移植, 求解器通过注入的 solve 函数(HiGHS WASM)执行,
   结果结构与 Python 后端保持一致(同一套 snake_case 字段)。

   solve(model) 接口:
     model = { n, obj: [max 目标系数], rows: [[col, coef]...] (Ax<=ub),
               ub: [...], lo: [...], hi: [...], ints: [bool...],
               gap?: number, timeLimit?: number }
     返回 x 数组(Float64), 不可行/失败返回 null */
"use strict";

const PIN_BONUS = 1e4;

function outItems(rec) {
  const d = { [rec.name]: rec.output_qty };
  if (rec.extra_product && rec.extra_qty) {
    d[rec.extra_product] = (d[rec.extra_product] || 0) + Number(rec.extra_qty);
  }
  return d;
}

function recipeTime(rec, coeff, buildingEff) {
  if (rec.grow_time_sec != null) return [Number(rec.grow_time_sec), "生长"];
  if (rec.workload != null) {
    let eff = coeff;
    if (buildingEff && buildingEff[rec.building] != null) {
      eff = Number(buildingEff[rec.building]) || coeff;
    }
    let t = Number(rec.workload) / eff;
    if (!rec.inputs || !rec.inputs.length)
      t /= 1.25;                   // 直接产出型工作量建筑(水井/矿山等): 再÷1.25
    return [t, "工作"];
  }
  return [null, null];
}

function uniqueLabel(recipes) {
  const rate = (r) => {
    const t = recipeTime(r, 1.0)[0];
    return t ? r.output_qty / t : r.output_qty;
  };
  for (const rec of recipes) rec.label = rec.name;
  const byB = new Map();
  for (const r of recipes) {
    if (!byB.has(r.building)) byB.set(r.building, []);
    byB.get(r.building).push(r);
  }
  for (const rs of byB.values()) {
    const byName = new Map();
    for (const r of rs) {
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name).push(r);
    }
    for (const [name, group] of byName) {
      if (new Set(group.map((r) => r.output_qty)).size < 2) continue;
      const mx = Math.max(...group.map(rate));
      const top = group.filter((r) => rate(r) === mx);
      if (top.length === 1) top[0].label = `${name}(高速)`;
    }
  }
  return recipes;
}

function priceMap(recipes) {
  const pm = {};
  const warn = [];
  for (const rec of recipes) {
    let p = rec.sell_price;
    if (p == null) continue;
    p = Number(p);
    if (pm[rec.name] != null && pm[rec.name] !== p) {
      warn.push(`${rec.name}: ${pm[rec.name]} 与 ${p} 不一致, 取 ${Math.max(p, pm[rec.name])}`);
      p = Math.max(p, pm[rec.name]);
    }
    pm[rec.name] = p;
  }
  return { pm, warn };
}

function filterAvailable(recipes, level, excludeSeasonal, keepIds) {
  keepIds = new Set(keepIds || []);
  const pool = [...recipes];
  const drops = [];                       // [{rec, reason}]
  const drop = (rec, reason) => {
    pool.splice(pool.indexOf(rec), 1);
    drops.push({ rec, reason });
  };
  if (excludeSeasonal) {
    for (const r of [...pool]) {
      if (r.is_seasonal && !keepIds.has(r.id)) drop(r, "赛季配方(已排除)");
    }
  }
  if (level != null) {
    for (const r of [...pool]) {
      if (!(r.req_level == null || r.req_level <= level))
        drop(r, `等级要求 ${r.req_level}`);
    }
  }
  for (;;) {                              // 材料无来源闭包
    const producible = new Set();
    for (const rec of pool) for (const i in outItems(rec)) producible.add(i);
    const bad = [];
    for (const rec of pool) {
      const miss = [...new Set(rec.inputs
        .filter((i) => !producible.has(i.item)).map((i) => i.item))].sort();
      const noTime = recipeTime(rec, 1.0)[0] == null;
      if (miss.length || noTime)
        bad.push({ rec, reason: miss.length ? `材料无来源: ${miss.join("、")}` : "缺少时间数据" });
    }
    if (!bad.length) break;
    for (const b of bad) drop(b.rec, b.reason);
  }
  if (excludeSeasonal && keepIds.size) {   // 自定义重纳入 -> 衍生连锁重纳入
    const lvOk = (rec) => level == null || rec.req_level == null || rec.req_level <= level;
    for (;;) {
      const producible = new Set();
      for (const rec of pool) for (const i in outItems(rec)) producible.add(i);
      const readd = [];
      for (const d of drops) {
        if (!d.rec.inputs.length) continue;
        if (d.reason === "赛季配方(已排除)" || d.reason.startsWith("材料无来源")) {
          const miss = d.rec.inputs.some((i) => !producible.has(i.item));
          if (!miss && recipeTime(d.rec, 1.0)[0] != null && lvOk(d.rec))
            readd.push(d);
        }
      }
      if (!readd.length) break;
      for (const d of readd) {
        drops.splice(drops.indexOf(d), 1);
        pool.push(d.rec);
      }
    }
  }
  return [pool, drops.map((d) => ({
    building: d.rec.building, name: d.rec.name, reason: d.reason }))];
}

function bcountOf(recipes, counts, b) {
  if (counts && counts[b] != null) return Math.trunc(counts[b]);
  const src = recipes.find((r) => r.building === b);
  return Math.trunc(src ? src.building_count : 1);
}

/* ---------------- 加工链 ---------------- */
function materialChains(recipes, level, excludeSeasonal, coeff, buildingEff, counts, T) {
  const consumers = {};
  for (const r of recipes) {
    for (const i of r.inputs) {
      (consumers[i.item] = consumers[i.item] || []).push(r);
    }
  }
  const chains = [];
  for (const b of [...new Set(recipes.map((r) => r.building))].sort()) {
    const rs = recipes.filter((r) => r.building === b);
    if (!rs.length || rs.some((r) => r.inputs.length !== 1)) continue;
    if (rs.some((r) => r.sell_price != null)) continue;
    if (rs.some((r) => (consumers[r.name] || []).some((c) => c.building !== b))) continue;
    const bases = new Set(rs.map((r) => r.inputs[0].item));
    for (const r of rs) bases.delete(r.name);
    if (bases.size !== 1) continue;
    const root = [...bases][0];
    const byIn = {};
    let linear = true;
    for (const r of rs) {
      const it = r.inputs[0].item;
      if (byIn[it]) { linear = false; break; }
      byIn[it] = r;
    }
    const seq = [];
    const walked = new Set();
    let cur = root;
    while (byIn[cur] && !walked.has(cur)) {
      walked.add(cur);
      seq.push(byIn[cur]);
      cur = byIn[cur].name;
    }
    if (!linear || seq.length !== rs.length || walked.has(cur)) continue;
    const cnt = bcountOf(recipes, counts, b);
    const tiers = [];
    for (const r of seq) {
      if (excludeSeasonal && r.is_seasonal) break;
      if (level != null && r.req_level && r.req_level > level) break;
      const t = recipeTime(r, coeff, buildingEff)[0];
      if (t == null) break;
      tiers.push([r, t]);
    }
    if (!tiers.length) continue;
    const mult = new Array(tiers.length).fill(1);
    for (let j = tiers.length - 2; j >= 0; j--)
      mult[j] = mult[j + 1] * Number(tiers[j + 1][0].inputs[0].qty || 0);
    const rootPer = mult[0] * Number(tiers[0][0].inputs[0].qty || 0);
    const secPer = tiers.reduce((s, [, t], j) => s + t * mult[j], 0);
    const nextReq = tiers.length < seq.length ? seq[tiers.length].req_level : null;
    chains.push({ building: b, count: cnt, root, cap: T * cnt, tiers, mult,
                  rootPer, secPer, topLabel: tiers[tiers.length - 1][0].label, nextReq });
  }
  return chains;
}

function mergeChains(chains, res, pm) {
  const plan = res.plan, util = res.utilization;
  const flows = res.flows, stockUsed = res.stock_used;
  const stock = res.stock || {};
  const summary = [];
  for (const ch of chains) {
    const producedLp = ((flows[ch.root] || {}).produced) || 0;
    const supply = Number(stock[ch.root] || 0) + Number(producedLp);
    if (supply <= 0) continue;
    const { rootPer, secPer } = ch;
    let u = util.find((x) => x.building === ch.building);
    const usedLp = u ? u.used : 0;
    const capLeft = Math.max(0, ch.cap - usedLp);
    const qStock = rootPer ? Math.trunc(supply / rootPer + 1e-9) : 0;
    const qCap = secPer ? Math.trunc(capLeft / secPer + 1e-9) : 0;
    const q = Math.max(0, Math.min(qStock, qCap));
    const tiers = ch.tiers;
    let note = "";
    if (q <= 0) {
      note = qStock <= 0 ? `材料不足以加工一件${ch.topLabel}`
                         : `时长内产能不足以加工一件${ch.topLabel}`;
    } else {
      if (ch.nextReq) note = `等级不足${ch.nextReq}，最高加工至${ch.topLabel}`;
      const left = supply - q * rootPer;
      if (left > 0.5)
        note = (note ? note + "；" : "") + `剩余${ch.root}×${Math.round(left)}未加工`;
    }
    const detail = tiers.map(([r, t], j) => ({
      label: r.label, name: r.name, qty: Math.round(q * ch.mult[j]), time: t,
    }));
    summary.push({ building: ch.building, root: ch.root, top_label: ch.topLabel,
      top_qty: q, note,
      tiers: q > 0 ? detail.map((d) => ({ label: d.label, qty: d.qty })) : [] });
    if (q <= 0) continue;
    if (!u) {
      u = { building: ch.building, count: ch.count, used: 0, cap: ch.cap,
            pct: 0, dual: 0, idle: true };
      util.push(u);
    }
    u.used += q * secPer;
    u.pct = u.cap ? u.used / u.cap : 0;
    u.idle = false;
    for (const d of detail) {
      plan.push({ building: ch.building, count: ch.count, label: d.label,
        seasonal: false, batches: d.qty, batches_int: d.qty,
        time_per_batch: Math.round(d.time * 10) / 10, ttype: "工作",
        unit: "席位", flexible: true, chain: true, net_per_batch: 0 });
    }
    const flow = (it) => flows[it] || (flows[it] = {
      produced: 0, consumed: 0, surplus: 0, value: 0, consumers: [], consumers_more: 0 });
    const qty0 = q * rootPer;
    const f0 = flow(ch.root);
    f0.consumed += qty0;
    f0.consumers.push({ building: ch.building, label: detail[0].label, qty: qty0, pct: 1 });
    detail.forEach((d, j) => {
      const f = flow(d.name);
      f.produced += d.qty * tiers[j][0].output_qty;
      if (j + 1 < detail.length) {
        const need = detail[j + 1].qty * Number(tiers[j + 1][0].inputs[0].qty || 0);
        f.consumed += need;
        f.consumers.push({ building: ch.building, label: detail[j + 1].label,
                           qty: need, pct: 1 });
      }
    });
    for (const it of [ch.root, ...detail.map((d) => d.name)]) {
      const f = flows[it];
      if (f.consumed > 1e-9)
        for (const c of f.consumers) c.pct = c.qty / f.consumed;
      f.surplus = f.produced - f.consumed;
      f.value = f.surplus * (pm[it] || 0);
    }
    const draw = Math.max(0, qty0 - Number(producedLp));
    if (draw > 0.5) {
      const su = stockUsed[ch.root] || (stockUsed[ch.root] = { qty: 0, value: 0 });
      su.qty += draw;
    }
  }
  res.chains = summary;
  const out = {};
  for (const k in flows) {
    const v = flows[k];
    if (v.produced > 0.5 || v.consumed > 0.5) out[k] = v;
  }
  res.flows = out;
  return res;
}

/* ---------------- 整数方案兜底(贪心) ---------------- */
function integerPlanGreedy(pool, x, items, T, bcount, stock) {
  const n = {};
  pool.forEach((r, k) => { n[r.id] = Math.floor(x[k] + 1e-9); });
  stock = stock || {};
  const usedTime = (bd) => pool.reduce((s, r) =>
    r.building === bd ? s + r.time * n[r.id] : s, 0);
  const balance = (it) => {
    let p = 0, cn = 0;
    for (const r of pool) {
      const oi = outItems(r);
      if (it in oi) p += oi[it] * n[r.id];
      cn += r.inputs.filter((i) => i.item === it)
        .reduce((s, i) => s + (i.qty || 0), 0) * n[r.id];
    }
    return p - cn;
  };
  for (let round = 0; round < 2000; round++) {
    const deficits = items.filter((it) => balance(it) < -(stock[it] || 0) - 1e-9);
    if (!deficits.length) break;
    for (const it of deficits) {
      const producers = pool.filter((r) => it in outItems(r) &&
        usedTime(r.building) + r.time <= T * bcount(r.building) + 1e-9);
      if (producers.length) {
        const best = producers.reduce((a, b) =>
          a.time / outItems(a)[it] < b.time / outItems(b)[it] ? a : b);
        n[best.id] += 1;
      } else {
        const cons = pool.filter((r) => r.inputs.some((i) => i.item === it) && n[r.id] > 0);
        if (cons.length) {
          const worst = cons.reduce((a, b) =>
            (a.outval - a.inval) < (b.outval - b.inval) ? a : b);
          n[worst.id] -= 1;
        }
      }
    }
  }
  for (let round = 0; round < 1000000; round++) {
    const deficits = items.filter((it) => balance(it) < -(stock[it] || 0) - 1e-9);
    if (!deficits.length) break;
    const cons = pool.filter((r) =>
      r.inputs.some((i) => i.item === deficits[0]) && n[r.id] > 0);
    if (!cons.length) break;
    const worst = cons.reduce((a, b) => (a.outval - a.inval) < (b.outval - b.inval) ? a : b);
    n[worst.id] -= 1;
  }
  return n;
}

/* ---------------- 主入口 ---------------- */
export function createEngine(gameData, solve) {
  const recipesAll = uniqueLabel(gameData.recipes.map((r) => ({ ...r })));

  function productAnalysis({ level, coeff, excludeSeasonal, buildingEff }) {
    const { pm } = priceMap(recipesAll);
    const [avail] = [filterAvailable(recipesAll, level, excludeSeasonal)[0]];
    const availSet = new Set(avail.map((r) => r.id));
    const levelPool = level == null ? [...recipesAll]
      : recipesAll.filter((r) => r.req_level == null || r.req_level <= level);
    const rows = [];
    for (const rec of recipesAll) {
      const [t, ttype] = recipeTime(rec, coeff, buildingEff);
      const outs = outItems(rec);
      const gross = Object.entries(outs).reduce((s, [i, q]) => s + q * (pm[i] || 0), 0);
      const mats = rec.inputs.map((inp) => ({
        item: inp.item, qty: inp.qty, price: pm[inp.item] != null ? pm[inp.item] : null,
        cost: (inp.qty || 0) * (pm[inp.item] || 0),
      }));
      let cost = mats.reduce((s, m) => s + m.cost, 0);
      if (rec.seed_price != null && Number(rec.seed_price) > 0)
        cost += Number(rec.seed_price);                // 每轮种子
      const net = gross - cost;
      let reason = "";
      if (!availSet.has(rec.id)) {
        if (rec.is_seasonal && excludeSeasonal) reason = "赛季配方(已排除)";
        else if (!levelPool.includes(rec)) reason = `等级 ${rec.req_level}`;
        else reason = "材料无来源/缺时间";
      }
      rows.push({
        id: rec.id, label: rec.label, name: rec.name, building: rec.building,
        req_level: rec.req_level, seasonal: !!rec.is_seasonal, ttype, time: t,
        output_qty: rec.output_qty, sell_price: rec.sell_price,
        extra_product: rec.extra_product, extra_qty: rec.extra_qty,
        gross, cost, net, seed_price: rec.seed_price,
        net_per_hour: t ? net / t * 3600 : null,
        materials: mats, available: availSet.has(rec.id), reason,
      });
    }
    return rows;
  }

  function optimize(opts) {
    const {
      level = null, hours = 24, coeff = 1.0, counts = null,
      excludeSeasonal = false, lazy = false, stock = null,
      buildingEff = null, pins = null, upgradeFirst = false,
    } = opts;
    const T = Number(hours) * 3600;
    const recipes = recipesAll.map((r) => ({ ...r }));
    const keepIds = new Set();
    if (pins) {
      for (const p of pins) {
        const rid = parseInt(p && p.recipe_id, 10);
        if (isNaN(rid)) return { ok: false, message: "自定义生产项缺少有效 recipe_id", excluded: [] };
        keepIds.add(rid);
      }
    }
    let [pool, excluded] = filterAvailable(recipes, level, excludeSeasonal, keepIds);
    /* 升级优先: 林地/矿山只保留解锁等级最高一档的产物(如15级林地=高速枫糖汁/椰子/天然橡胶) */
    if (upgradeFirst) {
      const keepUF = new Set();
      const topTier = {};
      for (const r of pool) {
        if (r.building !== "林地" && r.building !== "矿山") continue;
        topTier[r.building] = Math.max(topTier[r.building] ?? -1, r.req_level ?? -1);
      }
      for (const r of pool) {
        if (r.building !== "林地" && r.building !== "矿山") { keepUF.add(r.id); continue; }
        if ((r.req_level ?? -1) === topTier[r.building]) keepUF.add(r.id);
      }
      const droppedUF = pool.filter((r) => !keepUF.has(r.id));
      for (const r of droppedUF) excluded.push({
        building: r.building, name: r.label,
        reason: "升级优先：仅保留最高解锁档产物" });
      pool = pool.filter((r) => keepUF.has(r.id));
    }
    const chains = materialChains(recipes, level, excludeSeasonal, coeff,
                                  buildingEff, counts, T);
    if (chains.length) {
      const cb = new Set(chains.map((c) => c.building));
      pool = pool.filter((r) => !cb.has(r.building));
    }
    const { pm, warn } = priceMap(recipes);

    const banned = new Set();
    const pinApplied = [];
    const partial = {};
    const seasonalCap = {};
    if (pins && pins.length) {
      const recipesById = new Map(recipes.map((r) => [r.id, r]));
      const poolIds = new Set(pool.map((r) => r.id));
      const cntOf = {};
      const entries = [];
      const seenRid = new Set();
      for (const p of pins) {
        const rid = parseInt(p.recipe_id, 10);
        if (isNaN(rid)) return { ok: false, message: "自定义生产项缺少有效 recipe_id", excluded };
        if (seenRid.has(rid))
          return { ok: false, message: `自定义生产存在重复项(id=${rid})`, excluded };
        seenRid.add(rid);
        if (!poolIds.has(rid)) {
          const src = recipesById.get(rid);
          if (!src) return { ok: false, message: `自定义生产的配方不存在(id=${rid})`, excluded };
          const why = (excluded.find((e) =>
            e.building === src.building && e.name === src.name) || {}).reason
            || "当前条件不可用";
          return { ok: false,
            message: `自定义生产不可用: ${src.building}·${src.label}（${why}）`, excluded };
        }
        const pr = pool.find((r) => r.id === rid);
        if (cntOf[pr.building] == null)
          cntOf[pr.building] = bcountOf(recipes, counts, pr.building);
        const n = (p.n != null && Number(p.n) > 0) ? Math.trunc(Number(p.n)) : null;
        entries.push([pr, rid, n]);
      }
      const wholeIds = new Set(), wholeBuildings = new Set(), partSum = {};
      for (const [pr, rid, n] of entries) {
        const b = pr.building, cnt = cntOf[b];
        if (n == null || n >= cnt) {
          if (wholeBuildings.has(b) || partSum[b] != null)
            return { ok: false, message: `建筑 ${b} 已有整建筑自定义项，不能再叠加其他项`, excluded };
          wholeIds.add(rid);
          wholeBuildings.add(b);
          pinApplied.push({ building: b, label: pr.label, recipe_id: rid });
        } else {
          if (wholeBuildings.has(b))
            return { ok: false, message: `建筑 ${b} 已有整建筑自定义项，不能再叠加其他项`, excluded };
          partSum[b] = (partSum[b] || 0) + n;
          partial[rid] = n;
          if (excludeSeasonal && pr.is_seasonal) seasonalCap[rid] = n;
          pinApplied.push({ building: b, label: pr.label, recipe_id: rid, n });
        }
      }
      for (const b in partSum) {
        if (partSum[b] > cntOf[b])
          return { ok: false,
            message: `建筑 ${b} 的自定义实例合计 ${partSum[b]}，超过拥有数量 ${cntOf[b]}`,
            excluded };
      }
      for (const r of pool) {
        if (wholeBuildings.has(r.building) && !wholeIds.has(r.id)) banned.add(r.id);
      }
    }
    const stockSrc = stock || {};
    const stockN = {};
    for (const k in stockSrc) {
      const v = Number(stockSrc[k]);
      if (v > 0) stockN[String(k)] = v;
    }
    const known = new Set(recipes.map((r) => r.name));
    for (const r of recipes) {
      if (r.extra_product) known.add(r.extra_product);
      for (const i of r.inputs) known.add(i.item);
    }
    const unknown = Object.keys(stockN).filter((k) => !known.has(k)).sort();
    let warns = [...warn];
    if (unknown.length) warns.push(`存量中未知物品被忽略: ${unknown.join("、")}`);
    if (!pool.length)
      return { ok: false, message: "当前等级下没有可用配方", excluded };

    for (const rec of pool) {
      const [t, ttype] = recipeTime(rec, coeff, buildingEff);
      rec.time = t; rec.ttype = ttype;
      rec.outval = Object.entries(outItems(rec))
        .reduce((s, [i, q]) => s + q * (pm[i] || 0), 0);
      rec.inval = rec.inputs.reduce((s, i) => s + (i.qty || 0) * (pm[i.item] || 0), 0);
    }
    for (const rec of pool) {
      rec.coeff = rec.outval - rec.inval;
      if (rec.seed_price != null && Number(rec.seed_price) > 0)
        rec.coeff -= Number(rec.seed_price);           // 每轮种植消耗一粒种子
    }

    if (lazy) {
      const res = optimizeLazy(pool, T, coeff, level, hours, counts, pm, warns,
        stockN, banned,
        new Set(pinApplied.filter((p) => !p.n).map((p) => p.recipe_id)),
        pinApplied, partial, seasonalCap, excluded, solve);
      res.building_eff = buildingEff || {};
      res.pins = pinApplied;
      if (!res.ok) return res;
      return mergeChains(chains, res, pm);
    }

    const items = [...new Set(pool.flatMap((r) => [
      ...Object.keys(outItems(r)), ...r.inputs.map((i) => i.item)]))].sort();
    const buildings = [...new Set(pool.map((r) => r.building))].sort();
    const ri = new Map(pool.map((r, k) => [r.id, k]));
    const bcount = (b) => bcountOf(recipes, counts, b);

    // 约束: 产能 / 物料平衡
    const rows = [], ubs = [];
    for (const bd of buildings) {
      const row = [];
      pool.forEach((r, k) => { if (r.building === bd) row.push([k, r.time]); });
      rows.push(row);
      ubs.push(T * bcount(bd));
    }
    for (const it of items) {
      const row = [];
      pool.forEach((r, k) => {
        let a = 0;
        for (const i of r.inputs) if (i.item === it) a += (i.qty || 0);
        const oi = outItems(r);
        if (it in oi) a -= oi[it];
        if (a) row.push([k, a]);
      });
      rows.push(row);
      ubs.push(Number(stockN[it] || 0));
    }
    const pinIds = new Set(pinApplied.filter((p) => !p.n).map((p) => p.recipe_id));
    const obj = pool.map((r) =>
      r.coeff + (pinIds.has(r.id) ? PIN_BONUS * r.time : 0));
    const lo = pool.map((r) => {
      if (banned.has(r.id)) return 0;
      if (seasonalCap[r.id] != null) return seasonalCap[r.id] * T / r.time;
      if (partial[r.id] != null) return partial[r.id] * T / r.time;
      return 0;
    });
    const hi = pool.map((r) => {
      if (banned.has(r.id)) return 0;
      if (seasonalCap[r.id] != null) return seasonalCap[r.id] * T / r.time;
      return Infinity;
    });
    const sol = solve({ n: pool.length, obj, rows, ub: ubs, lo, hi,
                        ints: null, maximize: true });
    if (!sol) {
      return { ok: false,
        message: partial.size
          ? "材料不足以支撑部分自定义生产（尝试减小自定义数量、提供存量或缩短时长）"
          : "求解失败", excluded };
    }
    const x = sol;
    let x2 = x;
    if (pinIds.size || partial.size) {
      const lo2 = pool.map((r, k) => {
        if (pinIds.has(r.id)) return Math.max(x[k], 0);
        if (seasonalCap[r.id] != null) return seasonalCap[r.id] * T / r.time;
        if (partial[r.id] != null && !banned.has(r.id)) return partial[r.id] * T / r.time;
        return 0;
      });
      const hi2 = pool.map((r) => {
        if (banned.has(r.id)) return 0;
        if (seasonalCap[r.id] != null) return seasonalCap[r.id] * T / r.time;
        return Infinity;
      });
      const sol2 = solve({ n: pool.length,
        obj: pool.map((r) => r.coeff), rows, ub: ubs, lo: lo2, hi: hi2,
        ints: null, maximize: true });
      if (sol2) x2 = sol2;
    }
    const totalLp = pool.reduce((s, r, k) => s + r.coeff * x2[k], 0);

    // 整数方案(MILP)
    const loInt = pool.map((r, k) => {
      if (banned.has(r.id)) return 0;
      if (seasonalCap[r.id] != null) return Math.floor(seasonalCap[r.id] * T / r.time + 1e-9);
      if (partial[r.id] != null) return Math.floor(partial[r.id] * T / r.time + 1e-9);
      if (pinIds.has(r.id)) return Math.floor(x2[k]);
      return 0;
    });
    const hiInt = pool.map((r) => {
      if (banned.has(r.id)) return 0;
      if (seasonalCap[r.id] != null) return Math.floor(seasonalCap[r.id] * T / r.time + 1e-9);
      return Math.floor(T * bcount(r.building) / r.time);
    });
    let nMap = null;
    const solI = solve({ n: pool.length, obj: pool.map((r) => r.coeff),
      rows, ub: ubs, lo: loInt, hi: hiInt,
      ints: pool.map(() => true), maximize: true, gap: 0.001, timeLimit: 30 });
    if (solI) {
      nMap = {};
      pool.forEach((r, k) => { nMap[r.id] = Math.round(solI[k]); });
    } else {
      nMap = integerPlanGreedy(pool, x2, items, T, bcount, stockN);
    }
    const totalInt = pool.reduce((s, r) => s + r.coeff * nMap[r.id], 0);

    for (const pe of pinApplied) {
      if (x2[ri.get(pe.recipe_id)] < 0.01)
        warns.push(`自定义生产未生效: ${pe.building}·${pe.label}（材料不足，该建筑无产出）`);
    }

    // 输出结构
    const plan = [], util = [], flows = {};
    const consBy = {};
    for (const it of items) consBy[it] = {};
    for (const it of items) {
      let p = 0, cn = 0;
      for (const r of pool) {
        const k = ri.get(r.id);
        const oi = outItems(r);
        if (it in oi) p += oi[it] * x2[k];
        const need = r.inputs.filter((i) => i.item === it)
          .reduce((s, i) => s + (i.qty || 0), 0);
        if (need) {
          cn += need * x2[k];
          if (x2[k] > 1e-9) {
            const key = `${r.building}|${r.label}`;
            consBy[it][key] = (consBy[it][key] || 0) + need * x2[k];
          }
        }
      }
      const consumers = Object.entries(consBy[it])
        .map(([key, q]) => {
          const [b, l] = key.split("|");
          return { building: b, label: l, qty: q, pct: cn ? q / cn : 0 };
        })
        .filter((c) => c.qty > 1e-6).sort((a, b) => b.qty - a.qty);
      flows[it] = { produced: p, consumed: cn, surplus: p - cn,
        value: (p - cn) * (pm[it] || 0),
        consumers: consumers.slice(0, 6),
        consumers_more: Math.max(0, consumers.length - 6) };
    }
    const sells = items.filter((it) => flows[it].value > 0.5)
      .map((it) => ({ item: it, ...flows[it] }))
      .sort((a, b) => b.value - a.value);
    const stockUsed = {};
    for (const it of items) {
      const d = flows[it].consumed - flows[it].produced;
      if (d > 0.5) stockUsed[it] = { qty: d, value: d * (pm[it] || 0) };
    }

    for (const bd of buildings) {
      const cap = T * bcount(bd);
      const used = pool.filter((r) => r.building === bd)
        .reduce((s, r) => s + r.time * x2[ri.get(r.id)], 0);
      const mine = pool.filter((r) => r.building === bd && nMap[r.id] >= 1)
        .sort((a, b) => x2[ri.get(b.id)] - x2[ri.get(a.id)]);
      for (const r of mine) {
        const xv = x2[ri.get(r.id)];
        plan.push({
          building: bd, count: bcount(bd), label: r.label,
          source: r.source || null,
          seasonal: !!r.is_seasonal, batches: Math.round(xv * 100) / 100,
          batches_int: nMap[r.id], time_per_batch: Math.round(r.time * 10) / 10,
          ttype: r.ttype, unit: r.ttype === "生长" ? "地块" : "席位",
          slots: Math.round(xv / (T / r.time) * 100) / 100,
          net_per_batch: Math.round(r.coeff * 10) / 10,
        });
      }
      util.push({ building: bd, count: bcount(bd), used, cap,
        pct: cap ? used / cap : 0, dual: 0, idle: !mine.length });
    }

    return mergeChains(chains, {
      ok: true, level, hours, work_coefficient: coeff,
      total_lp: totalLp, total_int: totalInt,
      ratio: totalLp ? Math.min(1.0, totalInt / totalLp) : 0,
      plan, utilization: util, sells,
      flows, stock_used: stockUsed, stock: stockN,
      building_eff: buildingEff || {}, pins: pinApplied,
      excluded, warnings: warns, segments: null, lazy: false, duals_available: false,
    }, pm);
  }

  /* ---------------- 懒人模式 ---------------- */
  function optimizeLazy(pool, T, coeff, level, hours, counts, pm, warn,
                        stock, banned, pinIds,
                        pinApplied, partial, seasonalCap, excluded, solve) {
    const partialK = {};
    pool.forEach((r, k) => { if (partial[r.id] != null) partialK[k] = partial[r.id]; });
    const capK = {};
    pool.forEach((r, k) => { if (seasonalCap[r.id] != null) capK[k] = seasonalCap[r.id]; });
    const bcount = (b) => bcountOf(pool, counts, b);
    const items = [...new Set(pool.flatMap((r) => [
      ...Object.keys(outItems(r)), ...r.inputs.map((i) => i.item)]))].sort();
    const buildings = [...new Set(pool.map((r) => r.building))].sort();
    const delta = pool.map((r) => {
      const d = {};
      for (const i of r.inputs) d[i.item] = (d[i.item] || 0) + (i.qty || 0);
      for (const [it, q] of Object.entries(outItems(r)))
        d[it] = (d[it] || 0) - q;
      return d;
    });
    const rawK = pool.map((r, k) => (!r.inputs.length ? k : -1)).filter((k) => k >= 0);
    const mfgK = pool.map((r, k) => (r.inputs.length ? k : -1)).filter((k) => k >= 0);

    function buildModel(segs) {
      const S = segs.length;
      const KK = pool.map((r) =>
        segs.map(([s0, e]) => Math.trunc((e - s0) / r.time + 1e-6)));
      const vi = {};
      let nv = 0;
      for (const k of rawK) {
        if (banned.has(pool[k].id)) continue;
        for (let s = 0; s < S; s++) if (KK[k][s] > 0) vi[`${k},${s}`] = nv++;
      }
      const nVR = nv;
      /* 制造建筑两层变量: zi=整数席位数(限配方种类, 有几座最多几种),
         xi=连续轮次(材料到了就跑, r <= 满轮*席位) —— 每座全程只碰一个配方,
         但不必跑满全天 */
      const zi = {};
      for (const k of mfgK) {
        if (banned.has(pool[k].id)) continue;
        if (KK[k][0] > 0) zi[k] = nv++;
      }
      const nVI = nv;
      const xi = {};
      for (const k in zi) xi[k] = nv++;
      const nAll = nv;
      const obj = new Array(nAll).fill(0);
      for (const key in vi) {
        const [k, s] = key.split(",").map(Number);
        const bonus = pinIds.has(pool[k].id) ? PIN_BONUS * pool[k].time : 0;
        obj[vi[key]] = KK[k][s] * (pool[k].coeff + bonus);
      }
      for (const k in xi) {
        const bonus = pinIds.has(pool[k].id) ? PIN_BONUS * pool[k].time : 0;
        obj[xi[k]] = pool[k].coeff + bonus;   // 按轮计价
      }
      const rows = [], ub = [];
      for (const bd of buildings) {
        if (rawK.some((k) => pool[k].building === bd)) {
          for (let s = 0; s < S; s++) {
            const row = [];
            for (const k of rawK) {
              if (pool[k].building === bd && vi[`${k},${s}`] != null)
                row.push([vi[`${k},${s}`], 1]);
            }
            rows.push(row);
            ub.push(bcount(bd));
          }
        }
        if (mfgK.some((k) => pool[k].building === bd)) {
          const row = [];
          for (const k of mfgK)
            if (pool[k].building === bd && zi[k] != null) row.push([zi[k], 1]);
          rows.push(row);
          ub.push(bcount(bd));
        }
      }
      for (const k in xi) rows.push([[xi[k], 1], [zi[k], -KK[k][0]]]);   // r <= KK*z
      for (const it of items) {
        for (let j = 0; j < S; j++) {
          const row = [];
          for (let k = 0; k < pool.length; k++) {
            const d = delta[k][it];
            if (!d) continue;
            if (xi[k] != null) row.push([xi[k], d]);
            else for (let s = 0; s <= j; s++)
              if (vi[`${k},${s}`] != null) row.push([vi[`${k},${s}`], KK[k][s] * d]);
          }
          rows.push(row);
          ub.push(Number((stock || {})[it] || 0));
        }
      }
      const lo = new Array(nAll).fill(0);
      for (const k in partialK) {
        if (zi[k] != null) lo[zi[k]] = Math.min(partialK[k], bcount(pool[k].building));
        else for (let s = 0; s < S; s++)
          if (vi[`${k},${s}`] != null)
            lo[vi[`${k},${s}`]] = Math.min(partialK[k], bcount(pool[k].building));
      }
      const hiArr = [];
      for (const key in vi) {
        const k = +key.split(",")[0];
        hiArr[vi[key]] = capK[k] != null
          ? Math.min(capK[k], bcount(pool[k].building))
          : bcount(pool[k].building);
      }
      const mfgHi = (k) => capK[k] != null
        ? Math.min(capK[k], bcount(pool[k].building))
        : bcount(pool[k].building);
      for (const k in zi) hiArr[zi[k]] = mfgHi(k);
      for (const k in xi) hiArr[xi[k]] = KK[k][0] * mfgHi(k);
      const ints = [
        ...new Array(nVR).fill(true),
        ...new Array(nVI - nVR).fill(true),      // 席位整数
        ...new Array(nAll - nVI).fill(false),    // 轮次连续
      ];
      return { n: nAll, obj, rows, ub, lo, hi: hiArr, ints,
               vi, xi, zi, KK, segs, rawOrder: Object.keys(vi).length ? nVR : 0 };
    }

    function solveMilp(m, gap, tl) {
      const sol = solve({ n: m.n, obj: m.obj, rows: m.rows, ub: m.ub,
        lo: m.lo, hi: m.hi, ints: m.ints, maximize: true, gap, timeLimit: tl });
      if (!sol) return [null, null];
      const yv = {};
      for (const key in m.vi) {
        const y = Math.round(sol[m.vi[key]]);
        if (y > 0) yv[key] = y;
      }
      const xv = {};                          // 制造建筑: 轮次(连续)
      for (const k in m.xi) {
        const x = Math.max(0, sol[m.xi[k]]);
        if (x > 1e-6) xv[k] = x;
      }
      const zv = {};                          // 制造建筑: 席位(整数)
      for (const k in m.zi) {
        const z = Math.round(Math.max(0, sol[m.zi[k]]));
        if (z > 0) zv[k] = z;
      }
      const total =
        Object.entries(yv).reduce((s, [key, y]) => {
          const [k, sg] = key.split(",").map(Number);
          return s + m.KK[k][sg] * pool[k].coeff * y;
        }, 0) +
        Object.entries(xv).reduce((s, [k, x]) => s + pool[k].coeff * x, 0);
      return [total, [yv, xv, zv]];
    }

    function segsFrom(...switchH) {
      const cuts = [0, ...switchH.map((h) => h * 3600), T];
      for (let i = 0; i < cuts.length - 1; i++)
        if (cuts[i] >= cuts[i + 1]) throw new Error("bad cuts");
      const out = [];
      for (let i = 0; i < cuts.length - 1; i++) out.push([cuts[i], cuts[i + 1]]);
      return out;
    }

    const finals = [];
    const m0 = buildModel(segsFrom());
    {
      const [t0, y0] = solveMilp(m0);
      if (t0 != null) finals.push([t0, y0, m0]);
    }

    if (!finals.length) {
      return { ok: false, message: "懒人模式求解失败" +
        (Object.keys(partialK).length ? "（部分自定义生产可能材料不足，尝试减小自定义数量或提供存量）" : ""),
        excluded: [] };
    }
    finals.sort((a, b) => b[0] - a[0]);
    const [total, [yv, xvRaw, zvRaw], m] = finals[0];
    const segs = m.segs, KK = m.KK;
    const S = segs.length;
    const xv = xvRaw;

    const agg = {};
    for (const key in yv) {
      const y = yv[key];
      const [k, s] = key.split(",").map(Number);
      const a = agg[k] || (agg[k] = { batches: 0, peak: 0 });
      a.batches += KK[k][s] * y;
      a.peak = Math.max(a.peak, y);
    }
    for (const k in xv) {                     // 轮次直接累计, 峰值=席位数
      const a = agg[k] || (agg[k] = { batches: 0, peak: 0 });
      a.batches += xv[k];
      a.peak = Math.max(a.peak, zvRaw ? (zvRaw[k] || 0) : Math.ceil(xv[k] / KK[k][0]));
    }

    const plan = [], util = [], flows = {};
    const consBy = {};
    for (const it of items) consBy[it] = {};
    for (const it of items) {
      let p = 0, cn = 0;
      for (const key in yv) {
        const [k, s] = key.split(",").map(Number);
        const r = pool[k];
        const y = yv[key];
        const oi = outItems(r);
        if (it in oi) p += oi[it] * KK[k][s] * y;
        const need = r.inputs.filter((i) => i.item === it)
          .reduce((s2, i) => s2 + (i.qty || 0), 0);
        if (need) {
          const q = KK[k][s] * y * need;
          cn += q;
          const ckey = `${r.building}|${r.label}`;
          consBy[it][ckey] = (consBy[it][ckey] || 0) + q;
        }
      }
      for (const k in xv) {
        const r = pool[k], x = xv[k];
        const oi = outItems(r);
        if (it in oi) p += oi[it] * x;
        const need = r.inputs.filter((i) => i.item === it)
          .reduce((s2, i) => s2 + (i.qty || 0), 0);
        if (need) {
          cn += x * need;
          const ckey = `${r.building}|${r.label}`;
          consBy[it][ckey] = (consBy[it][ckey] || 0) + x * need;
        }
      }
      const consumers = Object.entries(consBy[it])
        .map(([key, q]) => {
          const [b, l] = key.split("|");
          return { building: b, label: l, qty: q, pct: cn ? q / cn : 0 };
        })
        .filter((c) => c.qty > 1e-6).sort((a, b) => b.qty - a.qty);
      flows[it] = { produced: p, consumed: cn, surplus: p - cn,
        value: (p - cn) * (pm[it] || 0),
        consumers: consumers.slice(0, 6),
        consumers_more: Math.max(0, consumers.length - 6) };
    }
    const sells = items.filter((it) => flows[it].value > 0.5)
      .map((it) => ({ item: it, ...flows[it] }))
      .sort((a, b) => b.value - a.value);
    const stockUsed = {};
    for (const it of items) {
      const d = flows[it].consumed - flows[it].produced;
      if (d > 0.5) stockUsed[it] = { qty: d, value: d * (pm[it] || 0) };
    }

    for (const pe of pinApplied) {
      const k = pool.findIndex((r) => r.id === pe.recipe_id);
      const bt = (agg[k] || {}).batches || 0;
      if (bt < 0.01)
        warn.push(`自定义生产未生效: ${pe.building}·${pe.label}（材料不足，该建筑无产出）`);
    }

    for (const bd of buildings) {
      const cap = T * bcount(bd);
      let used = 0;
      const mine = [];
      for (const k in agg) {
        const r = pool[k];
        if (r.building !== bd) continue;
        used += r.time * agg[k].batches;
        mine.push([r, k]);
      }
      mine.sort((a, b) => agg[b[1]].batches - agg[a[1]].batches);
      for (const [r, k] of mine) {
        const flex = r.inputs.length > 0;
        plan.push({
          building: bd, count: bcount(bd), label: r.label,
          source: r.source || null, seasonal: !!r.is_seasonal,
          batches: Math.round(agg[k].batches * 100) / 100,
          batches_int: Math.round(agg[k].batches),
          time_per_batch: Math.round(r.time * 10) / 10,
          ttype: r.ttype, unit: r.ttype === "生长" ? "地块" : "席位",
          slots: agg[k].peak,
          flexible: flex,
          net_per_batch: Math.round(r.coeff * 10) / 10,
        });
      }
      util.push({ building: bd, count: bcount(bd), used, cap,
        pct: cap ? used / cap : 0, dual: 0, idle: !mine.length });
    }

    let segments = null;
    if (S > 1) {
      segments = [];
      segs.forEach(([s0, e], s) => {
        const perBuilding = {};
        for (const key in yv) {
          const [k, s2] = key.split(",").map(Number);
          if (s2 !== s) continue;
          const r = pool[k];
          (perBuilding[r.building] = perBuilding[r.building] || []).push({
            label: r.label, instances: yv[key], batches: KK[k][s2] * yv[key],
            unit: r.ttype === "生长" ? "地块" : "席位",
          });
        }
        for (const b in perBuilding)
          perBuilding[b].sort((a, b2) => b2.instances - a.instances);
        segments.push({ start_h: Math.round(s0 / 3600 * 100) / 100,
          end_h: Math.round(e / 3600 * 100) / 100, buildings: perBuilding });
      });
    }

    return { ok: true, level, hours, work_coefficient: coeff,
      total_lp: total, total_int: total, ratio: 1.0,
      plan, utilization: util, sells,
      flows, stock_used: stockUsed, stock: stock || {},
      excluded, warnings: warn, segments,
      lazy: true, duals_available: false };
  }

  return { optimize, productAnalysis, recipes: recipesAll,
           filterAvailable, materialChains };
}

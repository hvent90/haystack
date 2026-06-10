// Self-contained HTML for GET /debug/metrics. Vanilla JS + canvas, no external deps.
export const METRICS_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Haystack server metrics</title>
<style>
  :root {
    --bg: #0b0e14;
    --panel: #141a24;
    --panel2: #1b2330;
    --border: #273142;
    --fg: #d7dde7;
    --muted: #8b97a8;
    --accent: #5cc8ff;
    --good: #4ade80;
    --warn: #fbbf24;
    --bad: #f87171;
    --c-advance: #5cc8ff;
    --c-build: #a78bfa;
    --c-hash: #f0a868;
    --c-flush: #4ade80;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    background: var(--panel); position: sticky; top: 0; z-index: 10;
  }
  header h1 { font-size: 15px; margin: 0; letter-spacing: 0.5px; }
  header .spacer { flex: 1; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button, select {
    background: var(--panel2); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 5px 10px; font: inherit; cursor: pointer;
  }
  button:hover, select:hover { border-color: var(--accent); }
  button.on { background: #16384a; border-color: var(--accent); color: var(--accent); }
  a.btn {
    text-decoration: none; display: inline-block;
    background: var(--panel2); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 5px 10px;
  }
  a.btn:hover { border-color: var(--accent); }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .seg button { border: none; border-radius: 0; border-right: 1px solid var(--border); }
  .seg button:last-child { border-right: none; }
  main { padding: 16px; display: grid; gap: 16px; max-width: 1400px; margin: 0 auto; }
  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px;
  }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--muted); margin: 0 0 12px; font-weight: 600; }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 10px; }
  .stat {
    background: var(--panel2); border: 1px solid var(--border);
    border-radius: 8px; padding: 9px 11px;
  }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 19px; margin-top: 3px; font-weight: 600; }
  .stat .sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .stat.bad { border-color: var(--bad); background: #2a1518; }
  .stat.bad .value { color: var(--bad); }
  .stat.good .value { color: var(--good); }
  .stat.warn .value { color: var(--warn); }
  canvas { display: block; width: 100%; border-radius: 6px; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: var(--muted); font-size: 11px; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .swatch { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
  .bars { display: grid; gap: 6px; }
  .barrow { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 10px; }
  .barrow .name { color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bartrack { position: relative; height: 22px; background: var(--panel2); border-radius: 4px; overflow: hidden; }
  .barfill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
  .barfill.p50 { background: rgba(92,200,255,0.30); }
  .barfill.p95 { background: rgba(92,200,255,0.55); }
  .barfill.p99 { background: rgba(247,113,113,0.30); }
  .barfill.max { outline: 1px dashed rgba(255,255,255,0.25); outline-offset: -1px; }
  .bartrack .txt { position: absolute; right: 6px; top: 0; bottom: 0; display: flex; align-items: center;
    font-size: 11px; color: var(--fg); white-space: nowrap; }
  .empty { padding: 28px; text-align: center; color: var(--muted); }
  .empty .big { font-size: 16px; color: var(--fg); margin-bottom: 6px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  .status-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: var(--muted); }
  .status-dot.live { background: var(--good); box-shadow: 0 0 6px var(--good); }
  .status-dot.err { background: var(--bad); }
  .muted { color: var(--muted); }
  .nowrap { white-space: nowrap; }
</style>
</head>
<body>
<header>
  <h1>HAYSTACK / server metrics</h1>
  <span class="status-dot" id="dot"></span>
  <span class="muted nowrap" id="conn">idle</span>
  <span class="spacer"></span>
  <div class="controls">
    <div class="seg" id="windowSeg">
      <button data-w="300">5m</button>
      <button data-w="900" class="on">15m</button>
      <button data-w="3600">1h</button>
      <button data-w="0">all</button>
    </div>
    <button id="liveBtn">Live tick view</button>
    <button id="refreshBtn" class="on">Auto-refresh</button>
    <button id="reloadBtn">Refresh now</button>
    <a class="btn" id="profBtn" href="/debug/profile?seconds=10">Download CPU profile</a>
  </div>
</header>

<main>
  <div id="emptyBanner" class="panel empty" style="display:none">
    <div class="big">no metrics yet</div>
    <div>is the load test running? the server needs to publish ticks before data appears.</div>
  </div>

  <section class="panel">
    <h2>Status <span class="muted" id="budgetLabel"></span></h2>
    <div class="stats" id="statusStats"></div>
  </section>

  <section class="panel">
    <h2>Partition phases (stacked mean ms) + publishAll.total p95/p99 + peers</h2>
    <canvas id="stackChart" height="280"></canvas>
    <div class="legend" id="stackLegend"></div>
  </section>

  <div class="grid2">
    <section class="panel">
      <h2>Cadence — tick.interval vs budget + loop.lag p99</h2>
      <canvas id="cadenceChart" height="240"></canvas>
      <div class="legend" id="cadenceLegend"></div>
    </section>
    <section class="panel">
      <h2>Per-phase percentiles (latest bucket, by p95 desc)</h2>
      <div class="bars" id="phaseBars"></div>
      <div class="legend">
        <span><span class="swatch" style="background:rgba(92,200,255,0.3)"></span>p50</span>
        <span><span class="swatch" style="background:rgba(92,200,255,0.55)"></span>p95</span>
        <span><span class="swatch" style="background:rgba(247,113,113,0.3)"></span>p99</span>
        <span><span class="swatch" style="background:transparent;outline:1px dashed rgba(255,255,255,0.4)"></span>max</span>
      </div>
    </section>
  </div>

  <section class="panel" id="livePanel" style="display:none">
    <h2>Live publish-tick breakdown (icicle of mean ms over last N ticks)</h2>
    <canvas id="flameChart" height="220"></canvas>
    <div class="legend" id="flameLegend"></div>
    <h2 style="margin-top:16px">Per-tick total ms (overruns in red)</h2>
    <canvas id="sparkChart" height="120"></canvas>
    <div class="stats" id="liveStats" style="margin-top:12px"></div>
  </section>
</main>

<script>
"use strict";
(function () {
  // ----- palette -----
  var COL = {
    advance: "#5cc8ff", build: "#a78bfa", hash: "#f0a868", flush: "#4ade80",
    p95: "#fbbf24", p99: "#f87171", budget: "#94a3b8", peers: "#c084fc",
    interval50: "#5cc8ff", interval95: "#a78bfa", interval99: "#f87171",
    lag: "#f0a868", grid: "#273142", axis: "#8b97a8", fg: "#d7dde7",
    bad: "#f87171", good: "#4ade80"
  };
  var PHASE_COLORS = {
    "publish.advance": COL.advance,
    "publish.buildShared": COL.build,
    "publish.computeHashes": COL.hash,
    "publish.flushPeers": COL.flush
  };
  var TIMING_PHASES = [
    "publishAll.total", "publish.advance", "publish.buildShared", "publish.computeHashes",
    "publish.flushPeers", "sim.syncShips", "sim.step", "sim.persistShips", "sim.persistMeta",
    "peer.getPilotView", "peer.hashing", "peer.stringify", "peer.send",
    "tick.interval", "loop.lag", "gc.pauseMs"
  ];

  // ----- state -----
  var state = {
    windowSec: 900,
    autoRefresh: true,
    liveView: false,
    timer: null,
    budgetMs: 33.3333,
    data: null,   // last /data response
    live: null    // last /live response
  };

  function $(id) { return document.getElementById(id); }
  function fmt(n, d) {
    if (n === null || n === undefined || isNaN(n)) return "--";
    var p = d === undefined ? 1 : d;
    return Number(n).toFixed(p);
  }
  function fmtInt(n) {
    if (n === null || n === undefined || isNaN(n)) return "--";
    return Math.round(n).toString();
  }

  // ----- canvas helpers -----
  function setupCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
    var cssH = canvas.clientHeight || parseInt(canvas.getAttribute("height"), 10) || 200;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: cssW, h: cssH };
  }
  function clearCtx(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
  }
  function drawEmpty(ctx, w, h, msg) {
    ctx.fillStyle = COL.axis;
    ctx.font = "13px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(msg || "no data in window", w / 2, h / 2);
    ctx.textAlign = "left";
  }
  function niceCeil(v) {
    if (v <= 0 || !isFinite(v)) return 1;
    var pow = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / pow;
    var step;
    if (n <= 1) step = 1; else if (n <= 2) step = 2; else if (n <= 5) step = 5; else step = 10;
    return step * pow;
  }
  function fmtClock(epochSec) {
    var dte = new Date(epochSec * 1000);
    var hh = ("0" + dte.getHours()).slice(-2);
    var mm = ("0" + dte.getMinutes()).slice(-2);
    var ss = ("0" + dte.getSeconds()).slice(-2);
    return hh + ":" + mm + ":" + ss;
  }

  // generic axes draw; returns plot rect
  function drawAxes(ctx, w, h, maxY, xMinSec, xMaxSec, yLabel) {
    var padL = 46, padR = 12, padT = 10, padB = 26;
    var px = padL, py = padT, pw = w - padL - padR, ph = h - padT - padB;
    if (pw < 10) pw = 10;
    if (ph < 10) ph = 10;
    // y grid
    ctx.strokeStyle = COL.grid;
    ctx.fillStyle = COL.axis;
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var yv = (maxY * i) / ticks;
      var yp = py + ph - (yv / maxY) * ph;
      ctx.beginPath();
      ctx.moveTo(px, yp);
      ctx.lineTo(px + pw, yp);
      ctx.stroke();
      ctx.fillText(fmt(yv, yv < 10 ? 1 : 0), px - 5, yp);
    }
    // x labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    if (xMaxSec > xMinSec) {
      var xticks = 4;
      for (var j = 0; j <= xticks; j++) {
        var frac = j / xticks;
        var xp = px + frac * pw;
        var sec = xMinSec + frac * (xMaxSec - xMinSec);
        ctx.fillText(fmtClock(sec), xp, py + ph + 5);
      }
    }
    // y label
    if (yLabel) {
      ctx.save();
      ctx.translate(11, py + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillStyle = COL.axis;
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    return { px: px, py: py, pw: pw, ph: ph };
  }
  function xPos(rect, sec, minS, maxS) {
    if (maxS <= minS) return rect.px + rect.pw / 2;
    return rect.px + ((sec - minS) / (maxS - minS)) * rect.pw;
  }
  function yPos(rect, v, maxY) {
    if (maxY <= 0) return rect.py + rect.ph;
    return rect.py + rect.ph - (v / maxY) * rect.ph;
  }

  // ----- data shaping -----
  // Build index: metric -> array of buckets sorted by ts, each {ts,count,sum,min,max,p50,p95,p99}
  function indexRows(rows) {
    var byMetric = {};
    if (!rows) return byMetric;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r.metric !== "string") continue;
      var arr = byMetric[r.metric];
      if (!arr) { arr = []; byMetric[r.metric] = arr; }
      arr.push(r);
    }
    for (var m in byMetric) {
      if (Object.prototype.hasOwnProperty.call(byMetric, m)) {
        byMetric[m].sort(function (a, b) { return a.ts_bucket - b.ts_bucket; });
      }
    }
    return byMetric;
  }
  function meanMs(r) {
    if (!r || !r.count) return 0;
    return r.sum / r.count;
  }
  function latestBucket(arr) {
    if (!arr || arr.length === 0) return null;
    return arr[arr.length - 1];
  }
  // value of a percentile field from latest bucket
  function latestVal(byMetric, metric, field) {
    var arr = byMetric[metric];
    var b = latestBucket(arr);
    if (!b) return null;
    var v = b[field];
    return (v === undefined || v === null) ? null : v;
  }
  // counters: sum per bucket is per-second rate; report latest sum
  function latestCounterRate(byMetric, metric) {
    var arr = byMetric[metric];
    var b = latestBucket(arr);
    if (!b) return null;
    return b.sum;
  }
  // gauges: p50=avg, max, min
  function latestGauge(byMetric, metric, field) {
    var arr = byMetric[metric];
    var b = latestBucket(arr);
    if (!b) return null;
    var v = b[field];
    return (v === undefined || v === null) ? null : v;
  }

  // ----- VIEW A: status header -----
  function renderStatus(byMetric, budgetMs) {
    var host = $("statusStats");
    host.innerHTML = "";
    var totP50 = latestVal(byMetric, "publishAll.total", "p50");
    var totP95 = latestVal(byMetric, "publishAll.total", "p95");
    var totP99 = latestVal(byMetric, "publishAll.total", "p99");
    var totMax = latestVal(byMetric, "publishAll.total", "max");
    var ivP50 = latestVal(byMetric, "tick.interval", "p50");
    var ivP99 = latestVal(byMetric, "tick.interval", "p99");
    var peers = latestGauge(byMetric, "gauge.tick.peers", "p50");
    var advPerTick = latestGauge(byMetric, "gauge.sim.advancesPerTick", "p50");
    var overruns = latestCounterRate(byMetric, "counter.tick.overruns");
    var lagP99 = latestVal(byMetric, "loop.lag", "p99");
    var gcRate = latestCounterRate(byMetric, "counter.gc.count");

    function card(label, value, sub, cls) {
      var d = document.createElement("div");
      d.className = "stat" + (cls ? " " + cls : "");
      var lab = document.createElement("div"); lab.className = "label"; lab.textContent = label;
      var val = document.createElement("div"); val.className = "value"; val.textContent = value;
      var s = document.createElement("div"); s.className = "sub"; s.textContent = sub || "";
      d.appendChild(lab); d.appendChild(val); d.appendChild(s);
      host.appendChild(d);
    }

    var totBad = (totP95 !== null && totP95 > budgetMs);
    card("publishAll.total p95", totP95 === null ? "--" : fmt(totP95) + "ms",
      "p50 " + fmt(totP50) + " / p99 " + fmt(totP99) + " / max " + fmt(totMax),
      totBad ? "bad" : (totP95 !== null ? "good" : ""));

    var ivBad = (ivP99 !== null && ivP99 > budgetMs);
    card("tick.interval p99", ivP99 === null ? "--" : fmt(ivP99) + "ms",
      "p50 " + fmt(ivP50) + " (target " + fmt(budgetMs) + ")",
      ivBad ? "bad" : (ivP99 !== null ? "good" : ""));

    card("peers", peers === null ? "--" : fmtInt(peers), "gauge.tick.peers", "");

    var advBad = (advPerTick !== null && advPerTick > 1.05);
    card("advances / tick", advPerTick === null ? "--" : fmt(advPerTick, 2),
      ">1 = double-advance bug", advBad ? "warn" : (advPerTick !== null ? "good" : ""));

    card("tick.overruns /s", overruns === null ? "--" : fmtInt(overruns),
      "counter.tick.overruns", (overruns && overruns > 0) ? "warn" : "");

    var lagBad = (lagP99 !== null && lagP99 > budgetMs);
    card("loop.lag p99", lagP99 === null ? "--" : fmt(lagP99) + "ms", "event-loop lag",
      lagBad ? "bad" : (lagP99 !== null ? "good" : ""));

    card("gc pauses /s", gcRate === null ? "--" : fmtInt(gcRate),
      "counter.gc.count", (gcRate && gcRate > 5) ? "warn" : "");

    card("budget", fmt(budgetMs) + "ms", "30Hz tick budget", "");
  }

  // ----- VIEW B: stacked-area timeseries -----
  function renderStack(byMetric, budgetMs) {
    var canvas = $("stackChart");
    var s = setupCanvas(canvas);
    var ctx = s.ctx, w = s.w, h = s.h;
    clearCtx(ctx, w, h);

    var partitions = ["publish.advance", "publish.buildShared", "publish.computeHashes", "publish.flushPeers"];
    // collect union of ts buckets across partitions + overlays
    var tsSet = {};
    var i, k;
    for (i = 0; i < partitions.length; i++) {
      var arr = byMetric[partitions[i]];
      if (arr) for (k = 0; k < arr.length; k++) tsSet[arr[k].ts_bucket] = true;
    }
    var totArr = byMetric["publishAll.total"] || [];
    for (k = 0; k < totArr.length; k++) tsSet[totArr[k].ts_bucket] = true;
    var allTs = Object.keys(tsSet).map(Number).sort(function (a, b) { return a - b; });
    if (allTs.length === 0) { drawEmpty(ctx, w, h, "no phase data in window"); return; }

    var minS = allTs[0], maxS = allTs[allTs.length - 1];

    // per-metric lookup ts->mean ms
    function meanLookup(metric) {
      var a = byMetric[metric] || [];
      var map = {};
      for (var z = 0; z < a.length; z++) map[a[z].ts_bucket] = meanMs(a[z]);
      return map;
    }
    function fieldLookup(metric, field) {
      var a = byMetric[metric] || [];
      var map = {};
      for (var z = 0; z < a.length; z++) {
        var v = a[z][field];
        map[a[z].ts_bucket] = (v === undefined || v === null) ? 0 : v;
      }
      return map;
    }
    var partMaps = partitions.map(meanLookup);
    var p95Map = fieldLookup("publishAll.total", "p95");
    var p99Map = fieldLookup("publishAll.total", "p99");
    var peersA = byMetric["gauge.tick.peers"] || [];
    var peersMap = {};
    var maxPeers = 1;
    for (k = 0; k < peersA.length; k++) {
      var pv = peersA[k].p50;
      pv = (pv === undefined || pv === null) ? 0 : pv;
      peersMap[peersA[k].ts_bucket] = pv;
      if (pv > maxPeers) maxPeers = pv;
    }

    // determine maxY from stacked sums and p99
    var maxY = budgetMs;
    for (i = 0; i < allTs.length; i++) {
      var t = allTs[i];
      var stackSum = 0;
      for (k = 0; k < partMaps.length; k++) stackSum += (partMaps[k][t] || 0);
      if (stackSum > maxY) maxY = stackSum;
      if ((p99Map[t] || 0) > maxY) maxY = p99Map[t] || 0;
    }
    maxY = niceCeil(maxY * 1.05);

    var rect = drawAxes(ctx, w, h, maxY, minS, maxS, "ms");

    // stacked areas (paint from bottom up)
    var cum = {};
    for (i = 0; i < allTs.length; i++) cum[allTs[i]] = 0;
    for (k = 0; k < partitions.length; k++) {
      var col = PHASE_COLORS[partitions[k]];
      ctx.beginPath();
      // bottom edge (previous cum) left->right then top edge right->left
      for (i = 0; i < allTs.length; i++) {
        var tt = allTs[i];
        var xp = xPos(rect, tt, minS, maxS);
        var yb = yPos(rect, cum[tt], maxY);
        if (i === 0) ctx.moveTo(xp, yb); else ctx.lineTo(xp, yb);
      }
      for (i = allTs.length - 1; i >= 0; i--) {
        var tt2 = allTs[i];
        var xp2 = xPos(rect, tt2, minS, maxS);
        var top = cum[tt2] + (partMaps[k][tt2] || 0);
        ctx.lineTo(xp2, yPos(rect, top, maxY));
        cum[tt2] = top;
      }
      ctx.closePath();
      ctx.fillStyle = hexA(col, 0.55);
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // budget line
    drawHLine(ctx, rect, budgetMs, maxY, COL.budget, [5, 4]);

    // p95 / p99 overlay lines
    drawSeriesLine(ctx, rect, allTs, p95Map, maxY, minS, maxS, COL.p95, 1.8);
    drawSeriesLine(ctx, rect, allTs, p99Map, maxY, minS, maxS, COL.p99, 1.8);

    // peers secondary axis (right) — scale to its own max
    if (peersA.length > 0) {
      var peersTs = peersA.map(function (r) { return r.ts_bucket; });
      ctx.beginPath();
      var started = false;
      for (i = 0; i < peersTs.length; i++) {
        var pt = peersTs[i];
        var xpp = xPos(rect, pt, minS, maxS);
        var ypp = rect.py + rect.ph - ((peersMap[pt] || 0) / maxPeers) * rect.ph;
        if (!started) { ctx.moveTo(xpp, ypp); started = true; } else ctx.lineTo(xpp, ypp);
      }
      ctx.strokeStyle = COL.peers;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // right axis label
      ctx.fillStyle = COL.peers;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.fillText("peers max " + fmtInt(maxPeers), rect.px + rect.pw, rect.py + 4);
      ctx.textAlign = "left";
    }

    legend($("stackLegend"), [
      ["advance", PHASE_COLORS["publish.advance"]],
      ["buildShared", PHASE_COLORS["publish.buildShared"]],
      ["computeHashes", PHASE_COLORS["publish.computeHashes"]],
      ["flushPeers", PHASE_COLORS["publish.flushPeers"]],
      ["total p95", COL.p95],
      ["total p99", COL.p99],
      ["budget", COL.budget],
      ["peers (right)", COL.peers]
    ]);
  }

  function hexA(hex, a) {
    var c = hex.replace("#", "");
    var r = parseInt(c.substring(0, 2), 16);
    var g = parseInt(c.substring(2, 4), 16);
    var b = parseInt(c.substring(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  function drawHLine(ctx, rect, v, maxY, color, dash) {
    var yp = yPos(rect, v, maxY);
    ctx.beginPath();
    ctx.moveTo(rect.px, yp);
    ctx.lineTo(rect.px + rect.pw, yp);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function drawSeriesLine(ctx, rect, allTs, map, maxY, minS, maxS, color, lw) {
    var started = false, n = 0, lastX = 0, lastY = 0;
    ctx.beginPath();
    for (var i = 0; i < allTs.length; i++) {
      var t = allTs[i];
      if (!(t in map)) continue;
      var xp = xPos(rect, t, minS, maxS);
      var yp = yPos(rect, map[t], maxY);
      if (!started) { ctx.moveTo(xp, yp); started = true; } else ctx.lineTo(xp, yp);
      lastX = xp; lastY = yp; n++;
    }
    if (n === 1) {
      // single point: draw a dot so it's visible
      ctx.arc(lastX, lastY, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else if (n > 1) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw || 1.5;
      ctx.stroke();
    }
  }
  function legend(host, items) {
    host.innerHTML = "";
    for (var i = 0; i < items.length; i++) {
      var sp = document.createElement("span");
      var sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = items[i][1];
      sp.appendChild(sw);
      sp.appendChild(document.createTextNode(items[i][0]));
      host.appendChild(sp);
    }
  }

  // ----- VIEW C: cadence -----
  function renderCadence(byMetric, budgetMs) {
    var canvas = $("cadenceChart");
    var s = setupCanvas(canvas);
    var ctx = s.ctx, w = s.w, h = s.h;
    clearCtx(ctx, w, h);

    var iv = byMetric["tick.interval"] || [];
    var lag = byMetric["loop.lag"] || [];
    if (iv.length === 0 && lag.length === 0) { drawEmpty(ctx, w, h, "no cadence data"); return; }

    var tsSet = {};
    var i;
    for (i = 0; i < iv.length; i++) tsSet[iv[i].ts_bucket] = true;
    for (i = 0; i < lag.length; i++) tsSet[lag[i].ts_bucket] = true;
    var allTs = Object.keys(tsSet).map(Number).sort(function (a, b) { return a - b; });
    var minS = allTs[0], maxS = allTs[allTs.length - 1];

    function fld(arr, field) {
      var map = {};
      for (var z = 0; z < arr.length; z++) {
        var v = arr[z][field];
        map[arr[z].ts_bucket] = (v === undefined || v === null) ? 0 : v;
      }
      return map;
    }
    var iv50 = fld(iv, "p50"), iv95 = fld(iv, "p95"), iv99 = fld(iv, "p99");
    var lag99 = fld(lag, "p99");

    var maxY = budgetMs * 1.5;
    for (i = 0; i < allTs.length; i++) {
      var t = allTs[i];
      maxY = Math.max(maxY, iv99[t] || 0, iv95[t] || 0, lag99[t] || 0);
    }
    maxY = niceCeil(maxY * 1.05);

    var rect = drawAxes(ctx, w, h, maxY, minS, maxS, "ms");
    drawHLine(ctx, rect, budgetMs, maxY, COL.budget, [5, 4]);
    // budget label
    ctx.fillStyle = COL.budget;
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("budget " + fmt(budgetMs), rect.px + 4, yPos(rect, budgetMs, maxY) - 3);

    drawSeriesLine(ctx, rect, allTs, iv50, maxY, minS, maxS, COL.interval50, 1.6);
    drawSeriesLine(ctx, rect, allTs, iv95, maxY, minS, maxS, COL.interval95, 1.4);
    drawSeriesLine(ctx, rect, allTs, iv99, maxY, minS, maxS, COL.interval99, 1.6);
    drawSeriesLine(ctx, rect, allTs, lag99, maxY, minS, maxS, COL.lag, 1.4);

    legend($("cadenceLegend"), [
      ["interval p50", COL.interval50],
      ["interval p95", COL.interval95],
      ["interval p99", COL.interval99],
      ["loop.lag p99", COL.lag],
      ["budget", COL.budget]
    ]);
  }

  // ----- VIEW D: per-phase percentile bars -----
  function renderPhaseBars(byMetric) {
    var host = $("phaseBars");
    host.innerHTML = "";
    var phases = [
      "publishAll.total", "publish.advance", "publish.buildShared", "publish.computeHashes",
      "publish.flushPeers", "sim.syncShips", "sim.step", "sim.persistShips", "sim.persistMeta",
      "peer.getPilotView", "peer.hashing", "peer.stringify", "peer.send",
      "tick.interval", "loop.lag", "gc.pauseMs"
    ];
    var rows = [];
    for (var i = 0; i < phases.length; i++) {
      var b = latestBucket(byMetric[phases[i]]);
      if (!b) continue;
      rows.push({
        name: phases[i],
        p50: numOr0(b.p50), p95: numOr0(b.p95), p99: numOr0(b.p99), max: numOr0(b.max)
      });
    }
    if (rows.length === 0) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = "no timing buckets yet";
      host.appendChild(e);
      return;
    }
    rows.sort(function (a, b) { return b.p95 - a.p95; });
    var globalMax = 0;
    for (i = 0; i < rows.length; i++) globalMax = Math.max(globalMax, rows[i].max);
    if (globalMax <= 0) globalMax = 1;

    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var row = document.createElement("div"); row.className = "barrow";
      var nm = document.createElement("div"); nm.className = "name"; nm.textContent = r.name; nm.title = r.name;
      var track = document.createElement("div"); track.className = "bartrack";
      function bar(cls, val) {
        var f = document.createElement("div");
        f.className = "barfill " + cls;
        f.style.width = Math.max(0, Math.min(100, (val / globalMax) * 100)) + "%";
        return f;
      }
      // draw widest first so narrower overlay on top
      track.appendChild(bar("max", r.max));
      track.appendChild(bar("p99", r.p99));
      track.appendChild(bar("p95", r.p95));
      track.appendChild(bar("p50", r.p50));
      var txt = document.createElement("div"); txt.className = "txt";
      txt.textContent = "p50 " + fmt(r.p50) + " · p95 " + fmt(r.p95) + " · p99 " + fmt(r.p99) + " · max " + fmt(r.max);
      track.appendChild(txt);
      row.appendChild(nm); row.appendChild(track);
      host.appendChild(row);
    }
  }
  function numOr0(v) { return (v === undefined || v === null || isNaN(v)) ? 0 : v; }

  // ----- VIEW E: flame/icicle + sparkline (from /live) -----
  var FLAME_TREE = {
    root: "publishAll.total",
    row1: ["publish.advance", "publish.buildShared", "publish.computeHashes", "publish.flushPeers"],
    under: {
      "publish.advance": ["sim.syncShips", "sim.step", "sim.persistShips", "sim.persistMeta"],
      "publish.flushPeers": ["peer.getPilotView", "peer.hashing", "peer.stringify", "peer.send"]
    }
  };
  var FLAME_COLORS = {
    "publishAll.total": "#3b4a5e",
    "publish.advance": COL.advance, "publish.buildShared": COL.build,
    "publish.computeHashes": COL.hash, "publish.flushPeers": COL.flush,
    "sim.syncShips": "#7dd3fc", "sim.step": "#38bdf8", "sim.persistShips": "#0ea5e9", "sim.persistMeta": "#0284c7",
    "peer.getPilotView": "#86efac", "peer.hashing": "#4ade80", "peer.stringify": "#22c55e", "peer.send": "#16a34a"
  };
  function avgPhases(ticks, n) {
    var sums = {};
    var cnt = 0;
    var start = Math.max(0, ticks.length - n);
    for (var i = start; i < ticks.length; i++) {
      var ph = ticks[i].phases || {};
      for (var key in ph) {
        if (Object.prototype.hasOwnProperty.call(ph, key)) {
          sums[key] = (sums[key] || 0) + (ph[key] || 0);
        }
      }
      // total may live on tick.total
      if (typeof ticks[i].total === "number") sums["publishAll.total"] = (sums["publishAll.total"] || 0) + ticks[i].total;
      cnt++;
    }
    var avg = {};
    if (cnt === 0) return avg;
    for (var k in sums) {
      if (Object.prototype.hasOwnProperty.call(sums, k)) avg[k] = sums[k] / cnt;
    }
    return avg;
  }
  function renderFlame(live) {
    var canvas = $("flameChart");
    var s = setupCanvas(canvas);
    var ctx = s.ctx, w = s.w, h = s.h;
    clearCtx(ctx, w, h);
    var ticks = (live && live.ticks) ? live.ticks : [];
    if (ticks.length === 0) { drawEmpty(ctx, w, h, "no live ticks — enable Live / load test"); return; }

    var N = Math.min(30, ticks.length);
    var avg = avgPhases(ticks, N);
    var total = avg["publishAll.total"];
    if (!total || total <= 0) {
      // derive from row1 sum if total missing
      total = 0;
      for (var ri = 0; ri < FLAME_TREE.row1.length; ri++) total += (avg[FLAME_TREE.row1[ri]] || 0);
    }
    if (total <= 0) { drawEmpty(ctx, w, h, "live phases all zero"); return; }

    var padX = 6, padTop = 6;
    var rowH = 44, gap = 6;
    var fullW = w - padX * 2;
    var x0 = padX;

    function cell(x, wpx, y, label, ms, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, Math.max(0, wpx - 1), rowH);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      if (wpx > 34) {
        var t1 = label;
        var t2 = fmt(ms) + "ms";
        clipText(ctx, t1, x + 4, y + 5, wpx - 8);
        clipText(ctx, t2, x + 4, y + 19, wpx - 8);
      }
    }
    function clipText(ctx2, txt, x, y, maxw) {
      ctx2.save();
      ctx2.beginPath();
      ctx2.rect(x, y - 2, maxw, 14);
      ctx2.clip();
      ctx2.fillStyle = "rgba(10,12,18,0.85)";
      ctx2.fillText(txt, x, y);
      ctx2.restore();
    }

    // row0
    var y0 = padTop;
    cell(x0, fullW, y0, "publishAll.total", total, FLAME_COLORS["publishAll.total"]);

    // row1 partition by mean ms; width proportional to its own ms vs total
    var y1 = y0 + rowH + gap;
    var cx = x0;
    var row1 = FLAME_TREE.row1;
    var childX = {};
    var childW = {};
    for (var i = 0; i < row1.length; i++) {
      var name = row1[i];
      var ms = avg[name] || 0;
      var wpx = (ms / total) * fullW;
      cell(cx, wpx, y1, shortName(name), ms, FLAME_COLORS[name]);
      childX[name] = cx;
      childW[name] = wpx;
      cx += wpx;
    }

    // row2 under advance and flushPeers
    var y2 = y1 + rowH + gap;
    drawChildren("publish.advance", childX, childW, y2, avg);
    drawChildren("publish.flushPeers", childX, childW, y2, avg);

    function drawChildren(parent, cxMap, cwMap, y, avgMap) {
      var kids = FLAME_TREE.under[parent] || [];
      var parentW = cwMap[parent] || 0;
      var parentX = cxMap[parent] || 0;
      // sum of kids ms (scale within parent's pixel width)
      var sum = 0;
      var ki;
      for (ki = 0; ki < kids.length; ki++) sum += (avgMap[kids[ki]] || 0);
      if (sum <= 0 || parentW <= 1) return;
      var kx = parentX;
      for (ki = 0; ki < kids.length; ki++) {
        var kn = kids[ki];
        var kms = avgMap[kn] || 0;
        var kw = (kms / sum) * parentW;
        cell(kx, kw, y, shortName(kn), kms, FLAME_COLORS[kn]);
        kx += kw;
      }
    }
    function shortName(n) {
      var parts = n.split(".");
      return parts.length > 1 ? parts[parts.length - 1] : n;
    }

    var leg = [];
    leg.push(["total", FLAME_COLORS["publishAll.total"]]);
    for (i = 0; i < row1.length; i++) leg.push([shortName(row1[i]), FLAME_COLORS[row1[i]]]);
    legend($("flameLegend"), leg);
  }

  function renderSpark(live) {
    var canvas = $("sparkChart");
    var s = setupCanvas(canvas);
    var ctx = s.ctx, w = s.w, h = s.h;
    clearCtx(ctx, w, h);
    var ticks = (live && live.ticks) ? live.ticks : [];
    if (ticks.length === 0) { drawEmpty(ctx, w, h, "no live ticks"); return; }

    var budget = (live && live.budgetMs) ? live.budgetMs : state.budgetMs;
    var maxY = budget * 1.5;
    var i;
    for (i = 0; i < ticks.length; i++) maxY = Math.max(maxY, ticks[i].total || 0);
    maxY = niceCeil(maxY * 1.05);

    var padL = 40, padR = 8, padT = 8, padB = 16;
    var px = padL, py = padT, pw = w - padL - padR, ph = h - padT - padB;
    // y grid (2 lines)
    ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.axis;
    ctx.font = "10px ui-monospace, monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (i = 0; i <= 2; i++) {
      var yv = (maxY * i) / 2;
      var yp = py + ph - (yv / maxY) * ph;
      ctx.beginPath(); ctx.moveTo(px, yp); ctx.lineTo(px + pw, yp); ctx.stroke();
      ctx.fillText(fmt(yv, 0), px - 5, yp);
    }
    // budget line
    var by = py + ph - (budget / maxY) * ph;
    ctx.beginPath(); ctx.moveTo(px, by); ctx.lineTo(px + pw, by);
    ctx.strokeStyle = COL.budget; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);

    var n = ticks.length;
    var bw = pw / n;
    for (i = 0; i < n; i++) {
      var t = ticks[i];
      var val = t.total || 0;
      var bh = (val / maxY) * ph;
      var bx = px + i * bw;
      ctx.fillStyle = t.overrun ? COL.bad : COL.good;
      ctx.globalAlpha = t.overrun ? 0.95 : 0.7;
      ctx.fillRect(bx, py + ph - bh, Math.max(1, bw - 0.5), bh);
    }
    ctx.globalAlpha = 1;

    // live stats
    var host = $("liveStats");
    host.innerHTML = "";
    var sumAdv = 0, sumTot = 0, overruns = 0, sumPeers = 0;
    for (i = 0; i < n; i++) {
      sumAdv += (ticks[i].advances || 0);
      sumTot += (ticks[i].total || 0);
      sumPeers += (ticks[i].peers || 0);
      if (ticks[i].overrun) overruns++;
    }
    function card(label, value, sub, cls) {
      var d = document.createElement("div");
      d.className = "stat" + (cls ? " " + cls : "");
      var lab = document.createElement("div"); lab.className = "label"; lab.textContent = label;
      var val = document.createElement("div"); val.className = "value"; val.textContent = value;
      var sb = document.createElement("div"); sb.className = "sub"; sb.textContent = sub || "";
      d.appendChild(lab); d.appendChild(val); d.appendChild(sb);
      host.appendChild(d);
    }
    var meanAdv = n ? sumAdv / n : 0;
    card("mean advances / tick", fmt(meanAdv, 2), ">1 = double-advance", meanAdv > 1.05 ? "warn" : "good");
    card("mean total", fmt(n ? sumTot / n : 0) + "ms", "over " + n + " ticks", "");
    card("overruns", fmtInt(overruns), "of " + n + " ticks", overruns > 0 ? "warn" : "good");
    card("mean peers", fmtInt(n ? sumPeers / n : 0), "live", "");
  }

  // ----- fetch + orchestration -----
  function setConn(text, cls) {
    $("conn").textContent = text;
    var dot = $("dot");
    dot.className = "status-dot" + (cls ? " " + cls : "");
  }

  function refresh() {
    var until = Math.floor(Date.now() / 1000);
    var since = state.windowSec > 0 ? until - state.windowSec : 0;
    var url = "/debug/metrics/data?since=" + since + "&until=" + until;
    setConn("loading…", state.autoRefresh ? "live" : "");
    fetch(url, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        state.data = j;
        if (j && typeof j.budgetMs === "number" && j.budgetMs > 0) state.budgetMs = j.budgetMs;
        $("budgetLabel").textContent = "(budget " + fmt(state.budgetMs) + "ms / " +
          fmt(1000 / state.budgetMs, 1) + "Hz)";
        var rows = (j && j.rows) ? j.rows : [];
        var byMetric = indexRows(rows);
        var hasData = rows.length > 0;
        $("emptyBanner").style.display = hasData ? "none" : "block";
        renderStatus(byMetric, state.budgetMs);
        renderStack(byMetric, state.budgetMs);
        renderCadence(byMetric, state.budgetMs);
        renderPhaseBars(byMetric);
        setConn("updated " + fmtClock(until), state.autoRefresh ? "live" : "");
      })
      .catch(function (err) {
        setConn("error: " + err.message, "err");
      });

    if (state.liveView) refreshLive();
  }

  function refreshLive() {
    fetch("/debug/metrics/live", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        state.live = j;
        if (j && typeof j.budgetMs === "number" && j.budgetMs > 0) state.budgetMs = j.budgetMs;
        renderFlame(j);
        renderSpark(j);
      })
      .catch(function (err) {
        var c = $("flameChart");
        var s = setupCanvas(c);
        clearCtx(s.ctx, s.w, s.h);
        drawEmpty(s.ctx, s.w, s.h, "live error: " + err.message);
      });
  }

  function startTimer() {
    stopTimer();
    if (state.autoRefresh) {
      state.timer = setInterval(refresh, 2000);
    }
  }
  function stopTimer() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  // ----- wire up controls -----
  function initControls() {
    var seg = $("windowSeg");
    var btns = seg.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        for (var k = 0; k < btns.length; k++) btns[k].classList.remove("on");
        this.classList.add("on");
        state.windowSec = parseInt(this.getAttribute("data-w"), 10) || 0;
        refresh();
      });
    }
    $("refreshBtn").addEventListener("click", function () {
      state.autoRefresh = !state.autoRefresh;
      this.classList.toggle("on", state.autoRefresh);
      startTimer();
      if (state.autoRefresh) refresh();
      else setConn("paused", "");
    });
    $("liveBtn").addEventListener("click", function () {
      state.liveView = !state.liveView;
      this.classList.toggle("on", state.liveView);
      $("livePanel").style.display = state.liveView ? "block" : "none";
      if (state.liveView) refreshLive();
    });
    $("reloadBtn").addEventListener("click", function () { refresh(); });
  }

  // redraw (no refetch) on resize so canvases stay crisp
  var resizeT = null;
  window.addEventListener("resize", function () {
    if (resizeT) clearTimeout(resizeT);
    resizeT = setTimeout(function () {
      if (state.data) {
        var byMetric = indexRows((state.data && state.data.rows) ? state.data.rows : []);
        renderStack(byMetric, state.budgetMs);
        renderCadence(byMetric, state.budgetMs);
      }
      if (state.liveView && state.live) { renderFlame(state.live); renderSpark(state.live); }
    }, 120);
  });

  initControls();
  refresh();
  startTimer();
})();
</script>
</body>
</html>`;

'use strict';
/* ==========================================================================
   Poke Kitchen — canonical shared kitchen simulation.

   The world is a pure function of (shared order set, Date.now()):
   every browser folds the same event timeline from unix epoch and derives
   identical Poke position, current step, progress, and served orders —
   refreshes and new visitors tune into the same continuous state.
   Orders sync over public MQTT (orders topic) + state topic carries
   heartbeats, sync-on-join, and a leader-published retained snapshot.
   Offline/disconnected → the same engine runs on the local order set.
   ========================================================================== */

const W = 960, H = 620;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const $ = s => document.querySelector(s);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ------------------------------------------------------------------ stations */
const STATIONS = [
  { id: 'prep',  name: 'Cutting Board · Prep', short: 'Prep',
    x: 48,  y: 58,  w: 186, h: 104, color: '#41522f', edge: '#5f7a42',
    desc: 'Chop, stack, and prep ingredients. Leaf bits fly when Poke gets going.',
    front: { x: 141, y: 200 } },
  { id: 'grill', name: 'Stove / Grill', short: 'Grill',
    x: 272, y: 58,  w: 186, h: 104, color: '#4a3527', edge: '#6b4a32',
    desc: 'Sear patties, simmer compute broth, bake banana bread.',
    front: { x: 365, y: 200 } },
  { id: 'fryer', name: 'Fryer — 120kg Station', short: 'Fryer',
    x: 496, y: 58,  w: 186, h: 104, color: '#5a4527', edge: '#8a6a38',
    desc: 'Golden batches by the hundredweight. Fry sauce on tap: pH 5.8.',
    front: { x: 589, y: 200 } },
  { id: 'c602',  name: 'Taylor C602', short: 'C602',
    x: 720, y: 58,  w: 192, h: 104, color: '#31404f', edge: '#4d6378',
    desc: 'Soft-serve & shake churn. Classic Taylor — appreciates regular lubrication.',
    front: { x: 816, y: 200 } },
  { id: 'rail',  name: 'Order Ticket Rail', short: 'Rail',
    x: 48,  y: 452, w: 200, h: 112, color: '#3d3350', edge: '#5d4f78',
    desc: 'Fresh tickets clip up here — shared live with every visitor.',
    front: { x: 148, y: 414 } },
  { id: 'plate', name: 'Plating Counter', short: 'Plating',
    x: 372, y: 452, w: 216, h: 112, color: '#54432a', edge: '#7a6238',
    desc: 'Final garnish, dome cloche, and out the pass.',
    front: { x: 480, y: 414 } },
];
const stationById = id => STATIONS.find(s => s.id === id);

/* ------------------------------------------------------------------ recipes */
const RECIPES = [
  { key: 'burger', name: 'Poke Smash Burger', icon: '🍔', steps: [
    ['prep',  'Chop toppings', 2.2], ['grill', 'Grill patty', 3.0], ['plate', 'Stack & plate', 1.6]]},
  { key: 'fries', name: '120kg Hot Fries', icon: '🍟', steps: [
    ['prep',  'Cut potatoes', 2.0], ['fryer', 'Fry batch', 3.2], ['plate', 'Salt & plate', 1.4]]},
  { key: 'broth', name: 'Compute Broth', icon: '🍲', steps: [
    ['prep',  'Dice modules', 2.4], ['grill', 'Simmer broth', 3.6], ['plate', 'Ladle & plate', 1.6]]},
  { key: 'bread', name: 'Banana Bread', icon: '🍌', steps: [
    ['prep',  'Mash bananas', 2.2], ['grill', 'Bake loaf', 3.4], ['plate', 'Slice & plate', 1.5]]},
  { key: 'shake', name: 'C602 Shake', icon: '🥤', steps: [
    ['c602',  'Churn shake', 3.0], ['plate', 'Top & serve', 1.4]]},
];
const recipeByKey = k => RECIPES.find(r => r.key === k);

/* ==========================================================================
   CANONICAL WORLD — deterministic epoch-folded timeline.
   Input: worldOrders (Map id -> {id, key, at, origin}).
   Output: identical on every client for the same now.
   ========================================================================== */
const SPEED = 200;                      // px/s — fixed, part of the protocol
const HOME = { x: 480, y: 330 };
const AMBIENT_PERIOD = 15000;           // ambient ticket slots on the epoch grid
const SIM_WINDOW = 10 * 60 * 1000;      // fold at most this far back
const worldOrders = new Map();
let ambientCount = 0;                   // derived during fold, for recipe cycling

function cmpOrders(a, b) { return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

/* Fold the timeline. Returns the world state at unix-ms `now`:
   { poke:{x,y,state,station,progress,label,orderId}, tickets:[...], served, servedIds }
   Deterministic: no Math.random, no local clocks — only `now`. */
const SERVE_FLASH = 1400;
function simulate(now) {
  const winStart = now - SIM_WINDOW;
  const pending = [...worldOrders.values()]
    .filter(o => o.at > winStart - 60000)
    .sort(cmpOrders);

  let cursor = winStart;                // timeline cursor (epoch ms)
  let pos = { ...HOME };
  let qi = 0;
  let ambN = Math.floor(winStart / AMBIENT_PERIOD);  // ambient slot index
  const worked = [];                    // every order folded (real + ambient)
  const events = [];
  let served = 0;
  const servedIds = new Set();

  let guard = 0;
  while (cursor <= now && guard++ < 400) {
    const nextReal = qi < pending.length ? pending[qi] : null;
    const slotT = (ambN + 1) * AMBIENT_PERIOD;
    if (slotT < cursor) { ambN++; continue; }          // slot passed while busy → skip
    let o;
    if (nextReal && nextReal.at <= slotT) {
      o = nextReal; qi++;                              // real order beats the slot
    } else {
      // Poke is free at this ambient slot → deterministic filler ticket
      o = { id: 'amb' + ambN, key: RECIPES[ambN % RECIPES.length].key, at: slotT, origin: 'ambient' };
      ambN++;
    }

    const r = recipeByKey(o.key);
    if (!r) continue;

    let start = Math.max(o.at, cursor);
    let stepIdx = 0;
    for (const [stId, label, dur] of r.steps) {
      const front = stationById(stId).front;
      const walkMs = dist(pos, front) / SPEED * 1000;
      events.push({ type: 'walk', t0: start, t1: start + walkMs, from: { ...pos }, to: front, order: o, stepIdx, label: '→ ' + stationById(stId).short });
      start += walkMs;
      events.push({ type: 'work', t0: start, t1: start + dur * 1000, at: front, order: o, stepIdx, label, station: stId });
      start += dur * 1000;
      pos = { ...front };
      stepIdx++;
    }
    o.servedAt = start;                  // epoch when this order leaves the pass
    cursor = start;
    worked.push(o);
  }

  // Tickets + served count
  const tickets = [];
  for (const o of worked) {
    if (o.servedAt <= now) {
      served++;
      servedIds.add(o.id);
      if (now - o.servedAt < SERVE_FLASH)
        tickets.push({ ...o, status: 'served', idx: recipeByKey(o.key).steps.length });
      continue;
    }
    // steps completed for this order by `now`
    let idx = 0, started = false;
    for (const e of events) {
      if (e.order !== o) continue;
      if (e.t1 <= now) { if (e.type === 'work') idx++; }
      else if (e.t0 <= now) { started = true; break; }
      else break;
    }
    tickets.push({ ...o, status: started ? 'cooking' : 'queued', idx });
  }
  // real orders not yet folded (arriving later) still show as queued
  for (const o of pending.slice(qi))
    if (!servedIds.has(o.id)) tickets.push({ ...o, status: 'queued', idx: 0 });

  // Poke: the event covering now
  let pokeState = null;
  for (const e of events) {
    if (e.t0 <= now && now < e.t1) {
      if (e.type === 'walk') {
        const p = (now - e.t0) / (e.t1 - e.t0 || 1);
        pokeState = {
          x: e.from.x + (e.to.x - e.from.x) * p,
          y: e.from.y + (e.to.y - e.from.y) * p,
          state: 'walk', station: null, progress: 0,
          label: e.label, orderId: e.order.id, stepIdx: e.stepIdx,
        };
      } else {
        pokeState = {
          x: e.at.x, y: e.at.y, state: 'work',
          station: e.station, progress: (now - e.t0) / (e.t1 - e.t0),
          label: e.label + '…', orderId: e.order.id, stepIdx: e.stepIdx,
        };
      }
      break;
    }
  }
  if (!pokeState) {
    // idle: deterministic gentle wander around HOME (pure function of time)
    const seg = Math.floor(now / 5000);
    const ph = (now % 5000) / 5000;
    const h = n => { let x = Math.imul(n ^ 0x9e3779b9, 2654435761); return ((x ^ (x >>> 15)) >>> 0) / 4294967295; };
    const w1 = { x: HOME.x + (h(seg) - .5) * 220, y: HOME.y + (h(seg * 7 + 1) - .5) * 120 };
    const w2 = { x: HOME.x + (h(seg + 1) - .5) * 220, y: HOME.y + (h(seg + 1) * 7 + 1 - .5) * 120 };
    const e2 = ph < .5 ? 2 * ph * ph : 1 - Math.pow(-2 * ph + 2, 2) / 2;
    pokeState = { x: w1.x + (w2.x - w1.x) * e2, y: w1.y + (w2.y - w1.y) * e2,
      state: 'idle', station: null, progress: 0, label: '', orderId: null, stepIdx: 0 };
  }

  ambientCount = ambN;
  return { poke: pokeState, tickets, served, servedIds };
}

/* ------------------------------------------------------------------ DOM */
const logEl = $('#log'), ticketsEl = $('#tickets'), railCount = $('#rail-count');
const tooltipEl = $('#tooltip'), hintEl = $('#mode-hint');
const t0 = Date.now();
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function log(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = 'log-line log-' + type;
  line.innerHTML = `<span class="ts">${fmtClock(Date.now() - t0)}</span><span>${msg}</span>`;
  logEl.prepend(line);
  while (logEl.children.length > 70) logEl.lastChild.remove();
}

let lastTicketsKey = '';
let mode = 'auto';
function renderTickets(sim) {
  const rows = sim.tickets;
  railCount.textContent = rows.length;
  $('#stat-queue').textContent = rows.filter(t => t.status !== 'served').length;
  $('#stat-served').textContent = sim.served;
  const key = rows.map(t => t.id + ':' + t.status + ':' + t.idx).join('|') + mode;
  if (key === lastTicketsKey) return;
  lastTicketsKey = key;
  if (!rows.length) {
    ticketsEl.className = 'tickets empty';
    ticketsEl.innerHTML = '<div class="empty-note">No orders — the rail is quiet.</div>';
    return;
  }
  ticketsEl.className = 'tickets';
  ticketsEl.innerHTML = '';
  let num = 0;
  for (const t of rows) {
    num++;
    const r = recipeByKey(t.key);
    const el = document.createElement('div');
    el.className = 'ticket ' + t.status + (t.status === 'served' ? ' flash' : '') +
      (mode === 'manual' && t.status === 'queued' ? ' clickable' : '');
    const dots = r.steps.map((_, i) =>
      `<div class="step-dot ${i < t.idx ? 'done' : i === t.idx && t.status === 'cooking' ? 'now' : ''}"></div>`).join('');
    const tag = t.origin === 'remote' ? ' · 🌐' : t.origin === 'ambient' ? ' · ~' : '';
    el.innerHTML = `
      <div class="t-icon">${r.icon}</div>
      <div class="t-body">
        <div class="t-name">${r.name} <span class="t-num">#${num}${tag}</span></div>
        <div class="t-steps">${dots}</div>
      </div>
      <div class="t-status ${t.status === 'served' ? 'done' : ''}">${t.status === 'served' ? 'SERVED' : t.status.toUpperCase()}</div>`;
    if (mode === 'manual' && t.status === 'queued') {
      el.addEventListener('click', () => {
        manual.ticket = t;
        log(`Sandbox: you called ${r.name} — click stations to cook it locally.`, 'manual');
      });
    }
    ticketsEl.appendChild(el);
  }
}

/* ------------------------------------------------------------------ audio */
let actx = null, soundOn = false;
function blip(kind) {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    if (kind === 'serve') { o.frequency.setValueAtTime(660, t); o.frequency.setValueAtTime(880, t + .09); }
    else if (kind === 'order') { o.frequency.setValueAtTime(520, t); o.frequency.setValueAtTime(390, t + .07); }
    else { o.frequency.setValueAtTime(440, t); }
    g.gain.setValueAtTime(.06, t);
    g.gain.exponentialRampToValueAtTime(.0001, t + .22);
    o.start(t); o.stop(t + .24);
  } catch (e) { /* audio unavailable */ }
}

/* ==========================================================================
   NETWORK — public MQTT over WebSocket (no keys, no backend).
   orders:  {type:'order', id, key, at}           — canonical order event
   state:   hb / sync-req / sync-state / world    — catch-up + presence
   ========================================================================== */
const NET = {
  client: null, status: 'off', fails: 0, bi: 0,
  brokers: ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'],
  topics: { orders: 'communitypoke/kitchen/orders', state: 'communitypoke/kitchen/state' },
  clientId: 'poke-' + uid(),
  peers: new Map(), hbT: 0, worldT: 0,
};

function netChip() {
  const el = $('#net-status');
  if (!el) return;
  const map = { live: ['#7cc96f', 'LIVE'], connecting: ['#eab54d', 'SYNCING'], off: ['#e2654f', 'LOCAL'] };
  const [c, label] = map[NET.status] || map.off;
  const n = NET.peers.size + 1;
  el.innerHTML = `<span class="net-dot" style="background:${c}"></span>${label}${NET.status === 'live' ? ` · ${n} chef${n > 1 ? 's' : ''}` : ''}`;
}
function netPublish(topic, obj, opts) {
  if (NET.status !== 'live' || !NET.client) return;
  try { NET.client.publish(topic, JSON.stringify(obj), Object.assign({ qos: 0 }, opts || {})); } catch (e) {}
}
function isLeader() {
  let ids = [NET.clientId, ...NET.peers.keys()];
  return NET.clientId === ids.sort()[0];
}
function ordersSnapshot() {
  return [...worldOrders.values()]
    .filter(o => Date.now() - o.at < SIM_WINDOW)
    .map(o => ({ id: o.id, key: o.key, at: o.at }));
}
function mergeOrder(o, origin) {
  if (!o || typeof o.id !== 'string' || !recipeByKey(o.key) || typeof o.at !== 'number') return false;
  if (Math.abs(o.at - Date.now()) > SIM_WINDOW * 6) return false;   // absurd clock → ignore
  if (worldOrders.has(o.id)) return false;
  worldOrders.set(o.id, { id: o.id, key: o.key, at: o.at, origin });
  return true;
}
function onNetMessage(topic, payload) {
  let m;
  try { m = JSON.parse(payload.toString()); } catch (e) { return; }
  if (!m || m.from === NET.clientId) return;
  if (topic === NET.topics.orders && m.type === 'order' && m.order) {
    if (mergeOrder(m.order, 'remote')) {
      const r = recipeByKey(m.order.key);
      log(`🎟 ${r.icon} ${r.name} clipped by a visitor 🌐`, 'order');
      blip('order');
    }
  } else if (topic === NET.topics.state) {
    if (m.type === 'hb' && m.id) {
      NET.peers.set(m.id, { ts: Date.now() });
      netChip();
    } else if (m.type === 'sync-req' && m.id) {
      netPublish(NET.topics.state,
        { type: 'sync-state', to: m.id, from: NET.clientId, orders: ordersSnapshot() });
    } else if (m.type === 'sync-state' && m.to === NET.clientId && Array.isArray(m.orders)) {
      let added = 0;
      for (const o of m.orders) if (mergeOrder(o, 'remote')) added++;
      if (added) log(`Caught up: merged ${added} shared order${added > 1 ? 's' : ''}.`, 'info');
    } else if (m.type === 'world' && Array.isArray(m.orders)) {
      // retained leader snapshot — instant catch-up for fresh visitors
      for (const o of m.orders) mergeOrder(o, 'remote');
    }
  }
}
function netConnect() {
  if (!window.mqtt) { NET.status = 'off'; netChip(); return; }
  NET.status = 'connecting'; netChip();
  const url = NET.brokers[NET.bi];
  let c;
  try {
    c = mqtt.connect(url, {
      clientId: NET.clientId, keepalive: 30, clean: true,
      reconnectPeriod: 5000, connectTimeout: 9000,
    });
  } catch (e) { NET.status = 'off'; netChip(); return; }
  NET.client = c;
  c.on('connect', () => {
    NET.status = 'live'; NET.fails = 0; netChip();
    c.subscribe(NET.topics.orders);
    c.subscribe(NET.topics.state);
    netPublish(NET.topics.state, { type: 'sync-req', id: NET.clientId, from: NET.clientId });
    netPublish(NET.topics.state, { type: 'hb', id: NET.clientId, from: NET.clientId });
    log(`World link up (${url.replace('wss://', '').split('/')[0]}) — sharing one kitchen.`, 'info');
  });
  c.on('message', onNetMessage);
  c.on('error', () => {
    NET.fails++;
    if (NET.status !== 'live' && NET.fails >= 3) {
      NET.bi = (NET.bi + 1) % NET.brokers.length;
      NET.fails = 0;
      try { c.end(true); } catch (e) {}
      NET.client = null;
      netConnect();
    }
  });
  c.on('close', () => { if (NET.status !== 'off') { NET.status = 'connecting'; netChip(); } });
  c.on('offline', () => { if (NET.status !== 'off') { NET.status = 'connecting'; netChip(); } });
}
function netTick(dt) {
  if (NET.status !== 'live') return;
  NET.hbT += dt; NET.worldT += dt;
  if (NET.hbT > 20) {
    NET.hbT = 0;
    netPublish(NET.topics.state, { type: 'hb', id: NET.clientId, from: NET.clientId });
  }
  // deterministic leader publishes a retained world snapshot for newcomers
  if (NET.worldT > 4 && isLeader()) {
    NET.worldT = 0;
    netPublish(NET.topics.state,
      { type: 'world', from: NET.clientId, orders: ordersSnapshot() }, { retain: true });
  }
  const now = Date.now();
  let changed = false;
  for (const [id, p] of NET.peers) if (now - p.ts > 75000) { NET.peers.delete(id); changed = true; }
  if (changed) netChip();
}

/* ------------------------------------------------------------------ orders */
function submitOrder(key) {
  const r = recipeByKey(key);
  if (!r) return;
  const o = { id: uid(), key: r.key, at: Date.now() };
  worldOrders.set(o.id, { ...o, origin: 'local' });
  netPublish(NET.topics.orders, { type: 'order', from: NET.clientId, order: o });
  log(`🎟 Ticket: ${r.icon} ${r.name} — sent to the shared rail.`, 'order');
  blip('order');
}

/* ------------------------------------------------------------------ particles */
let particles = [];
function burst(x, y, type, n) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(15, 70);
    particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 20,
      life: rand(.4, 1), t: 0, size: rand(1.5, 3.5), type,
    });
  }
}
function workParticles(st, dt) {
  const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
  if (Math.random() < dt * 14) {
    if (st.id === 'prep') particles.push({ x: cx + rand(-30, 30), y: cy, vx: rand(-40, 40), vy: rand(-70, -20), life: .5, t: 0, size: rand(1.5, 3), type: 'leaf' });
    if (st.id === 'grill') particles.push({ x: cx + rand(-26, 26), y: cy - 8, vx: rand(-8, 8), vy: rand(-45, -20), life: .9, t: 0, size: rand(2, 4.5), type: 'smoke' });
    if (st.id === 'fryer') particles.push({ x: cx + rand(-30, 30), y: cy + rand(-8, 8), vx: 0, vy: rand(-30, -12), life: .6, t: 0, size: rand(1.5, 3.5), type: 'bubble' });
    if (st.id === 'c602') particles.push({ x: cx + rand(-14, 14), y: cy + rand(-6, 14), vx: rand(-6, 6), vy: rand(-14, -4), life: .7, t: 0, size: rand(1.5, 3), type: 'swirl' });
    if (st.id === 'plate') particles.push({ x: cx + rand(-24, 24), y: cy + rand(-12, 4), vx: rand(-16, 16), vy: rand(-30, -10), life: .6, t: 0, size: rand(1.5, 3), type: 'sparkle' });
  }
}
const PARTICLE_COLORS = {
  leaf: '#8fce6b', smoke: 'rgba(200,190,170,.5)', bubble: '#ffd76a',
  swirl: '#a8d8ff', sparkle: '#ffe9a0', grease: '#f0924f',
};

/* ------------------------------------------------------------------ drawing */
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function drawFloor() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2b2015'); g.addColorStop(1, '#241a10');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,235,200,.028)';
  for (let y = 180; y < H - 40; y += 40)
    for (let x = 0; x < W; x += 40)
      if (((x + y) / 40) % 2 === 0) ctx.fillRect(x, y, 40, 40);
  ctx.fillStyle = '#1c1309';
  ctx.fillRect(0, 0, W, 52);
  ctx.fillStyle = 'rgba(234,181,77,.25)';
  ctx.fillRect(0, 50, W, 3);
  ctx.fillStyle = 'rgba(124,201,111,.06)';
  ctx.fillRect(0, 53, W, 8);
}
function drawStation(st, time, busy) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 5;
  rr(st.x, st.y, st.w, st.h, 12); ctx.fillStyle = st.color; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2; ctx.strokeStyle = busy ? '#eab54d' : st.edge; ctx.stroke();
  ctx.restore();

  const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
  if (st.id === 'prep') {
    rr(cx - 46, cy - 20, 92, 40, 6); ctx.fillStyle = '#caa06a'; ctx.fill();
    rr(cx - 46, cy - 20, 92, 40, 6); ctx.strokeStyle = '#8a6a42'; ctx.stroke();
    const kb = busy ? Math.sin(time * 18) * 8 : 0;
    ctx.save(); ctx.translate(cx + 28, cy - 14 - kb); ctx.rotate(.3);
    ctx.fillStyle = '#d8d8d8'; ctx.fillRect(-2, -16, 4, 16);
    ctx.fillStyle = '#5a4632'; ctx.fillRect(-3, 0, 6, 12);
    ctx.restore();
    ctx.fillStyle = '#7cc96f';
    ctx.beginPath(); ctx.arc(cx - 20, cy + 4, 4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(cx - 8, cy - 4, 4, 0, 7); ctx.fill();
  }
  if (st.id === 'grill') {
    for (let i = 0; i < 4; i++) {
      const bx = cx - 42 + (i % 2) * 56, by = cy - 18 + Math.floor(i / 2) * 36;
      ctx.beginPath(); ctx.arc(bx, by, 14, 0, 7);
      ctx.fillStyle = busy && i === 0 ? '#a04028' : '#241a12';
      ctx.fill(); ctx.strokeStyle = '#0f0a06'; ctx.stroke();
      if (busy && i === 0) {
        ctx.beginPath(); ctx.arc(bx, by, 8 + Math.sin(time * 14) * 2, 0, 7);
        ctx.fillStyle = '#e2654f'; ctx.fill();
      }
    }
    ctx.beginPath(); ctx.arc(cx - 42, cy - 18, 16, 0, 7);
    ctx.strokeStyle = '#111'; ctx.lineWidth = 3; ctx.stroke();
  }
  if (st.id === 'fryer') {
    rr(cx - 50, cy - 24, 100, 48, 6); ctx.fillStyle = '#8a6428'; ctx.fill();
    rr(cx - 44, cy - 18, 88, 36, 4); ctx.fillStyle = '#c8932e'; ctx.fill();
    ctx.beginPath();
    for (let x = -44; x <= 44; x += 4)
      ctx.lineTo(cx + x, cy - 18 + Math.sin(time * 4 + x / 8) * 1.5);
    ctx.strokeStyle = '#f0c060'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#2b1d0d';
    ctx.font = '700 10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('120kg · pH 5.8', cx, cy + 34);
  }
  if (st.id === 'c602') {
    rr(cx - 40, cy - 30, 80, 60, 10); ctx.fillStyle = '#d8dde2'; ctx.fill();
    rr(cx - 40, cy - 30, 80, 60, 10); ctx.strokeStyle = '#8b95a0'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx - 18, cy - 34, 8, 0, 7); ctx.fillStyle = '#7cc96f'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 18, cy - 34, 8, 0, 7); ctx.fillStyle = '#eab54d'; ctx.fill();
    ctx.fillStyle = '#333'; ctx.fillRect(cx - 12, cy - 4, 8, 10); ctx.fillRect(cx + 4, cy - 4, 8, 10);
    if (busy) {
      ctx.save(); ctx.translate(cx, cy + 14); ctx.rotate(time * 6);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, 4.5); ctx.stroke();
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(cx, cy + 14, 9, 0, 7);
      ctx.strokeStyle = '#aab'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.fillStyle = '#31404f'; ctx.font = '700 9px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('TAYLOR C602', cx, cy - 38);
    // ambient lube drip — cosmetic, not on the canonical timeline
    if (Math.floor(time / 3) % 4 === 0 && time % 3 < 1.2)
      particles.push({ x: cx + rand(-8, 8), y: cy + 6, vx: 0, vy: 18, life: .5, t: 0, size: 2, type: 'grease' });
  }
  if (st.id === 'rail') {
    ctx.fillStyle = '#8a7a5a'; ctx.fillRect(st.x + 10, st.y + 16, st.w - 20, 6);
    const open = lastSimTickets.filter(t => t.status !== 'served').slice(0, 6);
    open.forEach((t, i) => {
      const px = st.x + 22 + i * 28, sway = Math.sin(time * 2 + i) * 2;
      ctx.save(); ctx.translate(px, st.y + 22); ctx.rotate(sway * .02);
      ctx.fillStyle = t.status === 'cooking' ? '#ffe9a0' : '#f5eedd';
      ctx.fillRect(-10, 0, 20, 30);
      ctx.fillStyle = '#8a7a5a'; ctx.fillRect(-10, 0, 20, 5);
      ctx.restore();
    });
    ctx.fillStyle = '#c8b890'; ctx.font = '700 10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(open.length ? `${open.length} on the rail` : 'rail empty', cx, st.y + st.h - 16);
  }
  if (st.id === 'plate') {
    rr(cx - 70, cy - 18, 140, 36, 8); ctx.fillStyle = '#6a5636'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx - 30, cy, 22, 12, 0, 0, 7);
    ctx.fillStyle = '#eee'; ctx.fill(); ctx.strokeStyle = '#999'; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx - 30, cy, 12, 7, 0, 0, 7);
    ctx.fillStyle = '#ddd'; ctx.fill();
    if (busy) {
      ctx.beginPath(); ctx.arc(cx + 30, cy, 16, Math.PI, 0);
      ctx.fillStyle = '#c8ccd4'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 30, cy - 16, 3, 0, 7); ctx.fill();
    }
  }
  ctx.fillStyle = '#f0e2c4';
  ctx.font = '700 11px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(st.short, cx, st.y < 200 ? st.y + st.h + 18 : st.y - 10);
}
function drawPokeSprite(x, y, walking, time, facing) {
  const bob = walking ? Math.abs(Math.sin(time * 11)) * 3 : Math.sin(time * 1.6) * 1.2;
  const sway = Math.sin(time * 2.2) * (walking ? 3 : 1.4);
  ctx.save();
  ctx.translate(x, y - bob);
  ctx.beginPath(); ctx.ellipse(0, 26 + bob, 18, 6, 0, 0, 7);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fill();
  const step = walking ? Math.sin(time * 11) * 4 : 0;
  ctx.fillStyle = '#7a5a3a';
  ctx.beginPath(); ctx.ellipse(-7, 24 + Math.max(0, step), 5, 3.4, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(7, 24 + Math.max(0, -step), 5, 3.4, 0, 0, 7); ctx.fill();
  rr(-11, -8, 22, 32, 9); ctx.fillStyle = '#b98a5e'; ctx.fill();
  ctx.strokeStyle = '#7a5a3a'; ctx.lineWidth = 1.5; ctx.stroke();
  rr(-9, 6, 18, 16, 5); ctx.fillStyle = '#f2ead8'; ctx.fill();
  ctx.fillStyle = '#7cc96f'; ctx.font = '700 7px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('PK', 0, 17);
  ctx.fillStyle = '#2b1d10';
  ctx.beginPath(); ctx.arc(-4 + facing, -1, 1.7, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(4 + facing, -1, 1.7, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(0 + facing, 2.5, 2.6, 0.2, Math.PI - 0.2);
  ctx.strokeStyle = '#2b1d10'; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.fillStyle = 'rgba(226,101,79,.5)';
  ctx.beginPath(); ctx.arc(-8, 2, 2.4, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(8, 2, 2.4, 0, 7); ctx.fill();
  ctx.lineCap = 'round';
  const fronds = [[-1.5, 3.2, '#3f7d3b'], [-0.8, 3.9, '#55984a'], [0, 4.4, '#7cc96f'], [0.8, 3.9, '#55984a'], [1.5, 3.2, '#3f7d3b']];
  for (const [ang, len, col] of fronds) {
    const a = -Math.PI / 2 + ang + sway * .02;
    ctx.strokeStyle = col; ctx.lineWidth = 4.4;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.quadraticCurveTo(Math.cos(a) * 9 * len / 4.4, -8 + Math.sin(a) * 9 * len / 4.4,
      Math.cos(a) * 13 * len / 4.4 + sway, -8 + Math.sin(a) * 13 * len / 4.4 + 4);
    ctx.stroke();
  }
  ctx.fillStyle = '#6b4a2a';
  ctx.beginPath(); ctx.arc(-4, -9, 2.2, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(4, -9, 2.2, 0, 7); ctx.fill();
  ctx.save(); ctx.translate(0, -20); ctx.rotate(sway * .012);
  rr(-8, -2, 16, 7, 2.4); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.beginPath(); ctx.arc(-4, -6, 5.4, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(4, -6, 5.4, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(0, -9, 6.4, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.12)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
  ctx.restore();
  return bob;
}
let pokeFacing = 1, pokeLastX = 480;
function drawPoke(sim, time) {
  const p = sim.poke;
  if (p.state === 'walk' && Math.abs(p.x - pokeLastX) > .5) pokeFacing = p.x < pokeLastX ? -1 : 1;
  pokeLastX = p.x;
  const bob = drawPokeSprite(p.x, p.y, p.state === 'walk', time, pokeFacing);

  if (p.label) {
    ctx.font = '600 11px system-ui';
    const tw = ctx.measureText(p.label).width + 16;
    const cy2 = p.y - 52 - bob;
    rr(clamp(p.x - tw / 2, 6, W - tw - 6), cy2 - 20, tw, 19, 9);
    ctx.fillStyle = 'rgba(20,14,8,.9)'; ctx.fill();
    ctx.strokeStyle = '#eab54d'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#ffe9a0'; ctx.textAlign = 'center';
    ctx.fillText(p.label, clamp(p.x, 6 + tw / 2, W - 6 - tw / 2), cy2 - 6.5);
  }
  if (p.state === 'work') {
    ctx.beginPath(); ctx.arc(p.x, p.y - 30 - bob, 11, -Math.PI / 2, -Math.PI / 2 + p.progress * Math.PI * 2);
    ctx.strokeStyle = '#7cc96f'; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y - 30 - bob, 11, 0, 7);
    ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 1; ctx.stroke();
  }
}
function drawParticles() {
  for (const p of particles) {
    const a = clamp(1 - p.t / p.life, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = PARTICLE_COLORS[p.type] || '#fff';
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ manual sandbox (local only) */
const manual = { x: 480, y: 330, tx: 0, ty: 0, walking: false, work: null, ticket: null, marker: null };
function manualClick(mx, my) {
  const st = STATIONS.find(s => mx >= s.x && mx <= s.x + s.w && my >= s.y && my <= s.y + s.h);
  manual.work = null;
  if (st) {
    manual.tx = st.front.x; manual.ty = st.front.y; manual.walking = true;
    manual.station = st;
    log(`You sent Poke to the ${st.short} (local sandbox).`, 'manual');
  } else {
    manual.tx = clamp(mx, 40, W - 40); manual.ty = clamp(my, 180, H - 60);
    manual.walking = true; manual.station = null;
    manual.marker = { x: mx, y: my, t: 1.4 };
  }
}
canvas.addEventListener('click', e => {
  if (mode !== 'manual') return;
  const r = canvas.getBoundingClientRect();
  manualClick((e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height));
});
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (W / r.width);
  const my = (e.clientY - r.top) * (H / r.height);
  const st = STATIONS.find(s => mx >= s.x && mx <= s.x + s.w && my >= s.y && my <= s.y + s.h);
  if (st) {
    tooltipEl.innerHTML = `<b>${st.name}</b><br><span class="tt-desc">${st.desc}</span>`;
    tooltipEl.classList.remove('hidden');
    const wr = canvas.getBoundingClientRect();
    tooltipEl.style.left = clamp(e.clientX - wr.left + 14, 4, wr.width - 250) + 'px';
    tooltipEl.style.top = clamp(e.clientY - wr.top - 10, 4, wr.height - 60) + 'px';
  } else tooltipEl.classList.add('hidden');
});
canvas.addEventListener('mouseleave', () => tooltipEl.classList.add('hidden'));

function updateManual(dt, time) {
  if (manual.walking) {
    const dx = manual.tx - manual.x, dy = manual.ty - manual.y;
    const d = Math.hypot(dx, dy);
    if (d < 4) {
      manual.walking = false;
      if (manual.station) {
        manual.work = { st: manual.station, t: 0, dur: manual.ticket ? 2.0 : 1.2 };
        if (manual.ticket) {
          const r = recipeByKey(manual.ticket.key);
          log(`Sandbox: ${r.steps[0][1]} @ ${manual.station.short}`, 'manual');
        } else {
          log(`Poke inspects the ${manual.station.short}.`, 'manual');
        }
      }
    } else {
      const sp = clamp(d * 4, 60, SPEED);
      manual.x += dx / d * sp * dt;
      manual.y += dy / d * sp * dt;
    }
  }
  if (manual.work) {
    manual.work.t += dt;
    workParticles(manual.work.st, dt);
    if (manual.work.t >= manual.work.dur) {
      if (manual.ticket && manual.station.id === 'plate') {
        burst(manual.work.st.x + manual.work.st.w / 2, manual.work.st.y + 30, 'sparkle', 22);
        log(`Sandbox: plated ${recipeByKey(manual.ticket.key).name} (local only — shared rail untouched).`, 'manual');
        manual.ticket = null;
        blip('serve');
      }
      manual.work = null;
    }
  }
  if (manual.marker) { manual.marker.t -= dt; if (manual.marker.t <= 0) manual.marker = null; }
}

/* ------------------------------------------------------------------ transitions → log/sfx/particles */
let lastEventKey = '';
let knownServed = new Set();
let servedSeeded = false;
function observeTransitions(sim) {
  const p = sim.poke;
  const key = p.orderId ? p.orderId + ':' + p.stepIdx + ':' + p.state : 'idle';
  if (key !== lastEventKey) {
    lastEventKey = key;
    if (p.state === 'work') {
      log(`👨‍🍳 ${p.label} @ ${stationById(p.station).short}`, 'action');
    }
  }
  if (!servedSeeded) {           // don't spam history on first frame
    servedSeeded = true;
    knownServed = new Set(sim.servedIds);
    return;
  }
  for (const id of sim.servedIds) {
    if (!knownServed.has(id)) {
      knownServed.add(id);
      const o = worldOrders.get(id);
      const name = o ? recipeByKey(o.key).name : (id.startsWith('amb') ? 'a house special' : 'an order');
      log(`🍽 Served ${name} — nice plating, Poke.`, 'serve');
      const st = stationById('plate');
      burst(st.x + st.w / 2, st.y + 30, 'sparkle', 26);
      blip('serve');
    }
  }
  if (knownServed.size > 500) knownServed = new Set([...knownServed].slice(-200));
}

/* ------------------------------------------------------------------ main loop */
let lastSimTickets = [];
let last = 0;
const dbg = {};
window.PK = { simulate, worldOrders, dbg };
function frame(ts) {
  const dt = Math.min((ts - last) / 1000 || 0, .05);
  last = ts;
  const time = ts / 1000;
  const now = Date.now();

  const sim = simulate(now);
  lastSimTickets = sim.tickets;
  dbg.sim = sim;
  observeTransitions(sim);
  renderTickets(sim);

  netTick(dt);

  // particles
  for (const p of particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.type === 'smoke') p.vy -= 60 * dt; else p.vy += 24 * dt; }
  particles = particles.filter(p => p.t < p.life);

  drawFloor();
  const busyStation = sim.poke.state === 'work' ? sim.poke.station : null;
  for (const st of STATIONS) drawStation(st, time, busyStation === st.id);
  if (busyStation) workParticles(stationById(busyStation), dt);
  drawParticles();

  if (mode === 'auto') {
    drawPoke(sim, time);
  } else {
    updateManual(dt, time);
    drawPokeSprite(manual.x, manual.y, manual.walking, time, 1);
    if (manual.work) {
      ctx.beginPath(); ctx.arc(manual.x, manual.y - 30, 11, -Math.PI / 2, -Math.PI / 2 + (manual.work.t / manual.work.dur) * Math.PI * 2);
      ctx.strokeStyle = '#b78ef0'; ctx.lineWidth = 3; ctx.stroke();
    }
    if (manual.marker) {
      const m = manual.marker, a = clamp(m.t / 1.4, 0, 1);
      ctx.save(); ctx.globalAlpha = a;
      ctx.strokeStyle = '#b78ef0'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(m.x, m.y, 10 + (1 - a) * 8, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(m.x - 4, m.y - 4); ctx.lineTo(m.x + 4, m.y + 4);
      ctx.moveTo(m.x + 4, m.y - 4); ctx.lineTo(m.x - 4, m.y + 4); ctx.stroke();
      ctx.restore();
    }
  }

  // keep the shared order set bounded
  if (worldOrders.size > 500) {
    const cutoff = now - SIM_WINDOW;
    for (const [id, o] of worldOrders) if (o.at < cutoff) worldOrders.delete(id);
  }

  $('#stat-clock').textContent = fmtClock(now - t0);
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ UI wiring */
function setMode(m) {
  mode = m;
  $('#btn-auto').classList.toggle('active', m === 'auto');
  $('#btn-manual').classList.toggle('active', m === 'manual');
  canvas.classList.toggle('manual', m === 'manual');
  hintEl.classList.toggle('hidden', m !== 'manual');
  if (m === 'manual') {
    const p = dbg.sim ? dbg.sim.poke : { x: 480, y: 330 };
    manual.x = p.x; manual.y = p.y;
    manual.tx = p.x; manual.ty = p.y;
    manual.station = null; manual.work = null; manual.walking = false;
    log('Manual sandbox — you drive a local Poke; the shared shift keeps running.', 'manual');
  } else {
    log('Autonomous mode — canonical shared shift.', 'info');
  }
  lastTicketsKey = '';
}
$('#btn-auto').addEventListener('click', () => setMode('auto'));
$('#btn-manual').addEventListener('click', () => setMode('manual'));
$('#btn-order').addEventListener('click', () => submitOrder(pick(RECIPES).key));
$('#btn-sound').addEventListener('click', e => {
  soundOn = !soundOn;
  e.currentTarget.classList.toggle('on', soundOn);
  e.currentTarget.textContent = soundOn ? '🔊 Sound' : '🔇 Sound';
  if (soundOn) blip('order');
});
const orderForm = $('#order-form');
if (orderForm) {
  const sel = $('#order-select');
  RECIPES.forEach(r => {
    const o = document.createElement('option');
    o.value = r.key; o.textContent = `${r.icon} ${r.name}`;
    sel.appendChild(o);
  });
  orderForm.addEventListener('submit', e => {
    e.preventDefault();
    submitOrder(sel.value);
  });
}

/* ------------------------------------------------------------------ boot */
log('🌴 Poke clocked in. Canonical shared shift — refreshes tune back into the same world.', 'info');
netConnect();
setInterval(netChip, 5000);
requestAnimationFrame(frame);

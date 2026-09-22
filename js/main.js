'use strict';
/* ==========================================================================
   Poke Kitchen — autonomous 2D kitchen shift starring Poke the palm-tree chef.
   Vanilla canvas + MQTT-over-WebSocket shared order rail (no backend).
   ========================================================================== */

const W = 960, H = 620;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const $ = s => document.querySelector(s);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const easeInOut = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

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

/* ------------------------------------------------------------------ state */
let mode = 'auto';                 // 'auto' | 'manual'
let tickets = [];                  // order rail
const seenOrderIds = new Set();
let ticketCounter = 1;
let served = 0;
let shiftStart = performance.now();
let ambientTimer = 6;              // first ambient order lands quickly
let lubeTimer = rand(30, 50);      // C602 maintenance event
let idleWanderT = 0;

const poke = {
  x: 480, y: 330, tx: 480, ty: 330,
  speed: 200, walking: false, bob: 0, facing: 1,
  work: null,                      // {step,t,dur,station}
  ticket: null,                    // active ticket
  say: '', sayT: 0,
  manualTarget: null,              // click marker for manual mode
  afterArrive: null,
};

let particles = [];

/* ------------------------------------------------------------------ DOM */
const logEl = $('#log'), ticketsEl = $('#tickets'), railCount = $('#rail-count');
const tooltipEl = $('#tooltip'), hintEl = $('#mode-hint');

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function log(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = 'log-line log-' + type;
  line.innerHTML = `<span class="ts">${fmtClock(performance.now() - shiftStart)}</span><span>${msg}</span>`;
  logEl.prepend(line);
  while (logEl.children.length > 70) logEl.lastChild.remove();
}
function renderTickets() {
  railCount.textContent = tickets.length;
  $('#stat-queue').textContent = tickets.length;
  if (!tickets.length) {
    ticketsEl.className = 'tickets empty';
    ticketsEl.innerHTML = '<div class="empty-note">No orders — the rail is quiet.</div>';
    return;
  }
  ticketsEl.className = 'tickets';
  ticketsEl.innerHTML = '';
  for (const t of tickets) {
    const el = document.createElement('div');
    const cooking = t.status === 'cooking';
    el.className = 'ticket ' + (cooking ? 'cooking' : 'queued') + (mode === 'manual' && !cooking ? ' clickable' : '');
    el.dataset.id = t.id;
    const dots = t.steps.map((_, i) =>
      `<div class="step-dot ${i < t.idx ? 'done' : i === t.idx && cooking ? 'now' : ''}"></div>`).join('');
    el.innerHTML = `
      <div class="t-icon">${t.icon}</div>
      <div class="t-body">
        <div class="t-name">${t.name} <span class="t-num">#${t.num}${t.origin === 'remote' ? ' · 🌐' : ''}</span></div>
        <div class="t-steps">${dots}</div>
      </div>
      <div class="t-status">${cooking ? 'COOKING' : 'QUEUED'}</div>`;
    if (mode === 'manual' && !cooking) {
      el.addEventListener('click', () => {
        if (!poke.ticket) { startTicket(t); log(`You called ticket #${t.num} — click stations to cook it.`, 'manual'); }
      });
    }
    ticketsEl.appendChild(el);
  }
}
function flashTicket(id) {
  const el = ticketsEl.querySelector(`[data-id="${id}"]`);
  if (el) el.classList.add('flash');
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
    else if (kind === 'chop') { o.frequency.setValueAtTime(220, t); o.type = 'square'; }
    else { o.frequency.setValueAtTime(440, t); }
    g.gain.setValueAtTime(.06, t);
    g.gain.exponentialRampToValueAtTime(.0001, t + .22);
    o.start(t); o.stop(t + .24);
  } catch (e) { /* audio unavailable */ }
}

/* ==========================================================================
   NETWORK — public MQTT over WebSocket. Shared order rail, presence, sync.
   No keys, no backend; degrades to local sim when offline.
   ========================================================================== */
const NET = {
  client: null, status: 'off', fails: 0, bi: 0,
  brokers: ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'],
  topics: { orders: 'communitypoke/kitchen/orders', state: 'communitypoke/kitchen/state' },
  clientId: 'poke-' + uid(),
  peers: new Map(), hbT: 0, switchTimer: null,
};

function netChip() {
  const el = $('#net-status');
  if (!el) return;
  const map = {
    live: ['#7cc96f', 'LIVE'], connecting: ['#eab54d', 'SYNCING'],
    off: ['#e2654f', 'LOCAL'],
  };
  const [c, label] = map[NET.status] || map.off;
  const n = NET.peers.size + 1;
  el.innerHTML = `<span class="net-dot" style="background:${c}"></span>${label}${NET.status === 'live' ? ` · ${n} chef${n > 1 ? 's' : ''}` : ''}`;
}
function netPublish(topic, obj) {
  if (NET.status !== 'live' || !NET.client) return;
  try { NET.client.publish(topic, JSON.stringify(obj), { qos: 0 }); } catch (e) { /* ignore */ }
}
function netFail() {
  NET.fails++;
  if (NET.status !== 'live') {
    if (NET.fails >= 3) {                       // give this broker up, try the next
      NET.bi = (NET.bi + 1) % NET.brokers.length;
      NET.fails = 0;
      try { NET.client && NET.client.end(true); } catch (e) {}
      NET.client = null;
      netConnect();
      return;
    }
  }
  if (NET.status === 'live') { NET.status = 'connecting'; netChip(); }
}
function onNetMessage(topic, payload) {
  let m;
  try { m = JSON.parse(payload.toString()); } catch (e) { return; }
  if (!m || m.from === NET.clientId) return;
  if (topic === NET.topics.orders && m.type === 'order' && m.order) {
    if (seenOrderIds.has(m.order.id)) return;                       // dedupe
    addOrderFromNet(m.order);
  } else if (topic === NET.topics.state) {
    if (m.type === 'hb' && m.id) {
      NET.peers.set(m.id, { ts: Date.now(), served: m.served | 0 });
      netChip();
    } else if (m.type === 'sync-req' && m.id) {
      const open = tickets.filter(t => t.status !== 'served')
        .map(t => ({ id: t.id, key: t.key, num: t.num }));
      if (open.length) netPublish(NET.topics.state,
        { type: 'sync-state', to: m.id, from: NET.clientId, orders: open });
    } else if (m.type === 'sync-state' && m.to === NET.clientId && Array.isArray(m.orders)) {
      let added = 0;
      for (const o of m.orders) {
        if (!seenOrderIds.has(o.id) && recipeByKey(o.key)) {
          addOrderFromNet(o, true); added++;
        }
      }
      if (added) log(`Synced ${added} open order${added > 1 ? 's' : ''} from another visitor's rail.`, 'info');
    } else if (m.type === 'served') {
      log(`🌐 A visitor's Poke served ${m.name || 'an order'}.`, 'info');
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
    netPublish(NET.topics.state, { type: 'hb', id: NET.clientId, from: NET.clientId, served });
    log(`Order rail linked (${url.replace('wss://', '').split('/')[0]}) — tickets are shared live.`, 'info');
  });
  c.on('message', onNetMessage);
  c.on('error', netFail);
  c.on('close', () => { if (NET.status !== 'off') { NET.status = 'connecting'; netChip(); } });
  c.on('offline', () => { if (NET.status !== 'off') { NET.status = 'connecting'; netChip(); } });
}
function netTick(dt) {
  if (NET.status !== 'live') return;
  NET.hbT += dt;
  if (NET.hbT > 25) {
    NET.hbT = 0;
    netPublish(NET.topics.state, { type: 'hb', id: NET.clientId, from: NET.clientId, served });
  }
  // prune stale peers
  const now = Date.now();
  let changed = false;
  for (const [id, p] of NET.peers) if (now - p.ts > 75000) { NET.peers.delete(id); changed = true; }
  if (changed) netChip();
}

/* ------------------------------------------------------------------ orders */
function makeTicket(key, origin) {
  const r = recipeByKey(key);
  return {
    id: uid(), key: r.key, num: ticketCounter++, name: r.name, icon: r.icon,
    steps: r.steps.map(([station, label, dur]) => ({ station, label, dur })),
    idx: 0, status: 'queued', origin,
  };
}
function addOrder(key, origin) {
  const t = makeTicket(key, origin);
  seenOrderIds.add(t.id);
  tickets.push(t);
  renderTickets();
  const tag = origin === 'remote' ? ' (from a visitor 🌐)' : '';
  log(`🎟 Ticket #${t.num}: ${t.name}${tag}`, 'order');
  blip('order');
  return t;
}
function addOrderFromNet(o, quiet) {
  const r = recipeByKey(o.key);
  if (!r || seenOrderIds.has(o.id)) return null;
  seenOrderIds.add(o.id);
  const t = {
    id: o.id, key: r.key, num: o.num || ticketCounter++, name: r.name, icon: r.icon,
    steps: r.steps.map(([st, lb, d]) => ({ station: st, label: lb, dur: d })),
    idx: 0, status: 'queued', origin: 'remote',
  };
  ticketCounter = Math.max(ticketCounter, t.num + 1);
  tickets.push(t);
  renderTickets();
  if (!quiet) { log(`🎟 Ticket #${t.num}: ${t.name} (from a visitor 🌐)`, 'order'); blip('order'); }
  return t;
}
function submitOrder(key) {
  const t = addOrder(key, 'local');
  netPublish(NET.topics.orders,
    { type: 'order', from: NET.clientId, order: { id: t.id, key: t.key, num: t.num } });
}

function startTicket(t) {
  t.status = 'cooking';
  poke.ticket = t;
  renderTickets();
}

function serveTicket(t) {
  served++;
  $('#stat-served').textContent = served;
  t.status = 'served';
  flashTicket(t.id);
  const st = stationById('plate');
  burst(st.x + st.w / 2, st.y + 30, 'sparkle', 26);
  log(`🍽 Served ${t.name} (#${t.num}) — nice plating, Poke.`, 'serve');
  blip('serve');
  netPublish(NET.topics.state, { type: 'served', from: NET.clientId, name: t.name });
  setTimeout(() => {
    tickets = tickets.filter(x => x.id !== t.id);
    renderTickets();
  }, 1100);
}

/* ------------------------------------------------------------------ movement & work */
function walkTo(x, y, label, afterArrive) {
  poke.tx = x; poke.ty = y;
  poke.walking = true;
  poke.say = label || '';
  poke.sayT = 1.6;
  poke.afterArrive = afterArrive || null;
}
function near(a, b, c, d) { return Math.hypot(a - c, b - d) < 5; }

function startWork(step) {
  const st = stationById(step.station);
  poke.work = { step, t: 0, dur: step.dur, station: st };
  poke.say = step.label + '…';
  poke.sayT = step.dur + .4;
  log(`👨‍🍳 ${step.label} @ ${st.short}`, 'action');
}
function finishWork() {
  const t = poke.ticket;
  if (t) {
    t.idx++;
    renderTickets();
    if (t.idx >= t.steps.length) { poke.work = null; serveTicket(t); poke.ticket = null; return; }
  }
  poke.work = null;
}
function gotoStep(step) {
  const st = stationById(step.station);
  walkTo(st.front.x, st.front.y, '→ ' + st.short, () => startWork(step));
}

/* ------------------------------------------------------------------ autonomous brain */
function autoBrain(dt) {
  if (poke.work) return;
  if (poke.ticket) {
    const step = poke.ticket.steps[poke.ticket.idx];
    gotoStep(step);
    return;
  }
  const next = tickets.find(t => t.status === 'queued');
  if (next) { startTicket(next); return; }

  // idle: occasional C602 lubrication, else wander to a cozy spot
  lubeTimer -= dt;
  if (lubeTimer <= 0) {
    lubeTimer = rand(40, 70);
    const st = stationById('c602');
    walkTo(st.front.x, st.front.y, '→ C602 (maintenance)', () => {
      poke.work = { step: { station: 'c602', label: 'Lubricating the C602' }, t: 0, dur: 2.6, station: st, maint: true };
      poke.say = 'Lubricating…'; poke.sayT = 3;
      log('🔧 Routine lube on the Taylor C602 — keeps the swirl smooth.', 'maint');
      burst(st.x + st.w / 2, st.y + st.h / 2, 'grease', 14);
      setTimeout(() => { poke.work = null; }, 2600);
    });
    return;
  }
  idleWanderT -= dt;
  if (idleWanderT <= 0) {
    idleWanderT = rand(2.5, 5);
    walkTo(rand(200, 760), rand(250, 400), '', null);
  }
}

/* ------------------------------------------------------------------ manual control */
canvas.addEventListener('click', e => {
  if (mode !== 'manual') return;
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (W / r.width);
  const my = (e.clientY - r.top) * (H / r.height);
  const st = STATIONS.find(s => mx >= s.x && mx <= s.x + s.w && my >= s.y && my <= s.y + s.h);
  if (st) {
    walkTo(st.front.x, st.front.y, '→ ' + st.short, () => {
      const t = poke.ticket;
      if (t && t.status === 'cooking') {
        const step = t.steps[t.idx];
        if (step && step.station === st.id) { startWork(step); return; }
        log(`Nothing to do at ${st.short} for ticket #${t.num} — next step is ${stationById(step.station).short}.`, 'manual');
      } else {
        poke.work = { step: { station: st.id, label: 'Inspecting' }, t: 0, dur: 1.1, station: st, maint: true };
        poke.say = 'Inspecting…'; poke.sayT = 1.4;
        log(`You sent Poke to inspect the ${st.short}.`, 'manual');
        setTimeout(() => { poke.work = null; }, 1100);
      }
    });
  } else {
    poke.manualTarget = { x: mx, y: my, t: 1.4 };
    walkTo(clamp(mx, 40, W - 40), clamp(my, 180, H - 60), '', null);
  }
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

/* ------------------------------------------------------------------ particles */
function burst(x, y, type, n) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(15, 70);
    particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 20,
      life: rand(.4, 1), t: 0, size: rand(1.5, 3.5), type,
    });
  }
}
function workParticles(st, type, dt) {
  const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
  if (Math.random() < dt * 14) {
    if (type === 'prep') particles.push({ x: cx + rand(-30, 30), y: cy, vx: rand(-40, 40), vy: rand(-70, -20), life: .5, t: 0, size: rand(1.5, 3), type: 'leaf' });
    if (type === 'grill') particles.push({ x: cx + rand(-26, 26), y: cy - 8, vx: rand(-8, 8), vy: rand(-45, -20), life: .9, t: 0, size: rand(2, 4.5), type: 'smoke' });
    if (type === 'fryer') particles.push({ x: cx + rand(-30, 30), y: cy + rand(-8, 8), vx: 0, vy: rand(-30, -12), life: .6, t: 0, size: rand(1.5, 3.5), type: 'bubble' });
    if (type === 'c602') particles.push({ x: cx + rand(-14, 14), y: cy + rand(-6, 14), vx: rand(-6, 6), vy: rand(-14, -4), life: .7, t: 0, size: rand(1.5, 3), type: 'swirl' });
    if (type === 'plate') particles.push({ x: cx + rand(-24, 24), y: cy + rand(-12, 4), vx: rand(-16, 16), vy: rand(-30, -10), life: .6, t: 0, size: rand(1.5, 3), type: 'sparkle' });
    if (type === 'grease') particles.push({ x: cx + rand(-20, 20), y: cy, vx: rand(-10, 10), vy: rand(-24, -8), life: .6, t: 0, size: rand(1.5, 3), type: 'grease' });
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
function drawFloor(time) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2b2015'); g.addColorStop(1, '#241a10');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // checker tiles on the open floor
  ctx.fillStyle = 'rgba(255,235,200,.028)';
  for (let y = 180; y < H - 40; y += 40)
    for (let x = 0; x < W; x += 40)
      if (((x + y) / 40) % 2 === 0) ctx.fillRect(x, y, 40, 40);
  // back wall
  ctx.fillStyle = '#1c1309';
  ctx.fillRect(0, 0, W, 52);
  ctx.fillStyle = 'rgba(234,181,77,.25)';
  ctx.fillRect(0, 50, W, 3);
  // wall trim glow
  ctx.fillStyle = 'rgba(124,201,111,.06)';
  ctx.fillRect(0, 53, W, 8);
}
function drawStation(st, time) {
  const busy = poke.work && poke.work.station.id === st.id;
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
    // knife
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
    // pan
    ctx.beginPath(); ctx.arc(cx - 42, cy - 18, 16, 0, 7);
    ctx.strokeStyle = '#111'; ctx.lineWidth = 3; ctx.stroke();
  }
  if (st.id === 'fryer') {
    rr(cx - 50, cy - 24, 100, 48, 6); ctx.fillStyle = '#8a6428'; ctx.fill();
    rr(cx - 44, cy - 18, 88, 36, 4); ctx.fillStyle = '#c8932e'; ctx.fill();
    // oil surface wobble
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
    // hoppers
    ctx.beginPath(); ctx.arc(cx - 18, cy - 34, 8, 0, 7); ctx.fillStyle = '#7cc96f'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 18, cy - 34, 8, 0, 7); ctx.fillStyle = '#eab54d'; ctx.fill();
    // spouts + swirl
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
  }
  if (st.id === 'rail') {
    ctx.fillStyle = '#8a7a5a'; ctx.fillRect(st.x + 10, st.y + 16, st.w - 20, 6);
    const open = tickets.filter(t => t.status !== 'served').slice(0, 6);
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
  // label
  ctx.fillStyle = '#f0e2c4';
  ctx.font = '700 11px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(st.short, cx, st.y < 200 ? st.y + st.h + 18 : st.y - 10);
}
function drawPoke(time) {
  const { x, y } = poke;
  const bob = poke.walking ? Math.abs(Math.sin(poke.bob)) * 3 : Math.sin(time * 1.6) * 1.2;
  const sway = Math.sin(time * 2.2) * (poke.walking ? 3 : 1.4);
  ctx.save();
  ctx.translate(x, y - bob);

  // shadow
  ctx.beginPath(); ctx.ellipse(0, 26 + bob, 18, 6, 0, 0, 7);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fill();

  // feet
  const step = poke.walking ? Math.sin(poke.bob) * 4 : 0;
  ctx.fillStyle = '#7a5a3a';
  ctx.beginPath(); ctx.ellipse(-7, 24 + Math.max(0, step), 5, 3.4, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(7, 24 + Math.max(0, -step), 5, 3.4, 0, 0, 7); ctx.fill();

  // trunk
  rr(-11, -8, 22, 32, 9); ctx.fillStyle = '#b98a5e'; ctx.fill();
  ctx.strokeStyle = '#7a5a3a'; ctx.lineWidth = 1.5; ctx.stroke();
  // apron
  rr(-9, 6, 18, 16, 5); ctx.fillStyle = '#f2ead8'; ctx.fill();
  ctx.fillStyle = '#7cc96f'; ctx.font = '700 7px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('PK', 0, 17);

  // face
  ctx.fillStyle = '#2b1d10';
  ctx.beginPath(); ctx.arc(-4 + poke.facing, -1, 1.7, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(4 + poke.facing, -1, 1.7, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(0 + poke.facing, 2.5, 2.6, 0.2, Math.PI - 0.2);
  ctx.strokeStyle = '#2b1d10'; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.fillStyle = 'rgba(226,101,79,.5)';
  ctx.beginPath(); ctx.arc(-8, 2, 2.4, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(8, 2, 2.4, 0, 7); ctx.fill();

  // fronds
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
  // coconuts
  ctx.fillStyle = '#6b4a2a';
  ctx.beginPath(); ctx.arc(-4, -9, 2.2, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(4, -9, 2.2, 0, 7); ctx.fill();

  // chef hat
  ctx.save(); ctx.translate(0, -20); ctx.rotate(sway * .012);
  rr(-8, -2, 16, 7, 2.4); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.beginPath(); ctx.arc(-4, -6, 5.4, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(4, -6, 5.4, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(0, -9, 6.4, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.12)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  ctx.restore();

  // speech / action chip
  if (poke.sayT > 0 && poke.say) {
    ctx.font = '600 11px system-ui';
    const tw = ctx.measureText(poke.say).width + 16;
    const cy2 = y - 52 - bob;
    rr(clamp(x - tw / 2, 6, W - tw - 6), cy2 - 20, tw, 19, 9);
    ctx.fillStyle = 'rgba(20,14,8,.9)'; ctx.fill();
    ctx.strokeStyle = '#eab54d'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#ffe9a0'; ctx.textAlign = 'center';
    ctx.fillText(poke.say, clamp(x, 6 + tw / 2, W - 6 - tw / 2), cy2 - 6.5);
  }

  // work progress ring
  if (poke.work && !poke.work.maint) {
    const p = poke.work.t / poke.work.dur;
    ctx.beginPath(); ctx.arc(x, y - 30 - bob, 11, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    ctx.strokeStyle = '#7cc96f'; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y - 30 - bob, 11, 0, 7);
    ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 1; ctx.stroke();
  }

  // manual click marker
  if (poke.manualTarget) {
    poke.manualTarget.t -= 1 / 60;
    const m = poke.manualTarget, a = clamp(m.t / 1.4, 0, 1);
    ctx.save(); ctx.globalAlpha = a;
    ctx.strokeStyle = '#b78ef0'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(m.x, m.y, 10 + (1 - a) * 8, 0, 7); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(m.x - 4, m.y - 4); ctx.lineTo(m.x + 4, m.y + 4);
    ctx.moveTo(m.x + 4, m.y - 4); ctx.lineTo(m.x - 4, m.y + 4); ctx.stroke();
    ctx.restore();
    if (m.t <= 0) poke.manualTarget = null;
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

/* ------------------------------------------------------------------ update */
function update(dt, time) {
  // movement with eased interpolation
  if (poke.walking) {
    const dx = poke.tx - poke.x, dy = poke.ty - poke.y;
    const d = Math.hypot(dx, dy);
    if (d < 4) {
      poke.walking = false;
      poke.x = poke.tx; poke.y = poke.ty;
      const f = poke.afterArrive; poke.afterArrive = null;
      if (f) f();
    } else {
      const sp = clamp(d * 4, 60, poke.speed);
      poke.x += dx / d * sp * dt;
      poke.y += dy / d * sp * dt;
      poke.facing = dx < -1 ? -1 : dx > 1 ? 1 : poke.facing;
      poke.bob += dt * 11;
    }
  } else if (mode === 'auto') {
    autoBrain(dt);
  }

  if (poke.sayT > 0) poke.sayT -= dt;

  // work step progress
  if (poke.work) {
    poke.work.t += dt;
    workParticles(poke.work.station, poke.work.station.id, dt);
    if (poke.work.t >= poke.work.dur) finishWork();
  }

  // ambient order spawner (local only — shared rail is driven by visitors)
  ambientTimer -= dt;
  if (ambientTimer <= 0) {
    ambientTimer = rand(11, 17);
    if (tickets.filter(t => t.status !== 'served').length < 5)
      addOrder(pick(RECIPES).key, 'ambient');
  }

  // particles
  for (const p of particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 60 * dt * (p.type === 'smoke' ? -1 : 0.4); }
  particles = particles.filter(p => p.t < p.life);

  netTick(dt);

  $('#stat-clock').textContent = fmtClock(performance.now() - shiftStart);
}

let last = 0;
function frame(ts) {
  const dt = Math.min((ts - last) / 1000 || 0, .05);
  last = ts;
  const time = ts / 1000;
  update(dt, time);
  drawFloor(time);
  for (const st of STATIONS) drawStation(st, time);
  drawParticles();
  drawPoke(time);
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ UI wiring */
function setMode(m) {
  mode = m;
  $('#btn-auto').classList.toggle('active', m === 'auto');
  $('#btn-manual').classList.toggle('active', m === 'manual');
  canvas.classList.toggle('manual', m === 'manual');
  hintEl.classList.toggle('hidden', m !== 'manual');
  if (m === 'manual') log('Manual mode — Poke takes your clicks now. The rail stays shared.', 'manual');
  else log('Autonomous mode — Poke runs the shift.', 'info');
  renderTickets();
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
log('🌴 Poke clocked in. Autonomous shift starting — rail is live-shared when connected.', 'info');
addOrder('burger', 'ambient');
addOrder('fries', 'ambient');
netConnect();
setInterval(netChip, 5000);
requestAnimationFrame(frame);

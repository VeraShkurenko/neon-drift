// NEON DRIFT — authoritative multiplayer game server (Node.js + Socket.io)
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const BOT_TARGET = Number(process.env.BOTS ?? 6); // bots keep the arena alive

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

// ---------- World config ----------
const W = 4000, H = 4000;
const ORB_COUNT = 750;
const MINE_COUNT = 16;
const TICK_HZ = 60, SEND_HZ = 20;
const START_MASS = 20;
const SHIELD_MS = 3000;
const COLORS = ['#00f5ff', '#ff2bd6', '#7cff4f', '#ffd400', '#ff6a2b', '#9b5cff', '#ff4d6d', '#2bffb1'];
const BOT_NAMES = ['Nova', 'Pixel', 'Glitch', 'Vortex', 'Comet', 'Zap', 'Echo', 'Blitz', 'Orbit', 'Quark', 'Neon', 'Flux', 'Spark', 'Drift', 'Photon'];

const radiusOf = m => 4 + Math.sqrt(m) * 5;
const orbRadius = v => 4 + v * 1.2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let nextId = 1;
const players = new Map(); // id -> player (humans + bots), only alive ones are "in arena"
const orbs = new Map();
let mines = [];
let addedOrbs = [], removedOrbs = [];
let minesDirty = false;

// ---------- Orbs ----------
function spawnOrb(x, y, v, c) {
  const id = nextId++;
  const o = {
    id,
    x: x ?? rand(30, W - 30),
    y: y ?? rand(30, H - 30),
    v: v ?? (Math.random() < 0.03 ? 8 : Math.random() < 0.25 ? 2 : 1),
    c: c ?? Math.floor(Math.random() * COLORS.length),
  };
  o.x = clamp(o.x, 10, W - 10); o.y = clamp(o.y, 10, H - 10);
  orbs.set(id, o);
  addedOrbs.push(packOrb(o));
  return o;
}
const packOrb = o => [o.id, Math.round(o.x), Math.round(o.y), +o.v.toFixed(1), o.c];
function removeOrb(id) { if (orbs.delete(id)) removedOrbs.push(id); }
for (let i = 0; i < ORB_COUNT; i++) spawnOrb();

// ---------- Mines (hazards that pop big players) ----------
function placeMine() { return { id: nextId++, x: rand(150, W - 150), y: rand(150, H - 150), r: 42 }; }
for (let i = 0; i < MINE_COUNT; i++) mines.push(placeMine());

// ---------- Players ----------
function sanitizeName(n) {
  n = String(n ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return n || 'Гравець';
}

function safeSpawnPoint() {
  let best = null, bestD = -1;
  for (let i = 0; i < 12; i++) {
    const x = rand(200, W - 200), y = rand(200, H - 200);
    let d = Infinity;
    for (const p of players.values()) if (p.alive) d = Math.min(d, Math.hypot(p.x - x, p.y - y) - radiusOf(p.mass));
    if (d > bestD) { bestD = d; best = { x, y }; }
  }
  return best;
}

function createPlayer({ id, name, color, bot = false, socketId = null }) {
  const sp = safeSpawnPoint();
  const p = {
    id, name, color, bot, socketId,
    x: sp.x, y: sp.y, vx: 0, vy: 0,
    mass: START_MASS, maxMass: START_MASS,
    input: { a: 0, t: 0, b: false },
    alive: true, kills: 0,
    spawnedAt: Date.now(), dropTimer: 0,
    ai: bot ? { target: null, think: 0, wander: rand(0, Math.PI * 2) } : null,
  };
  players.set(id, p);
  broadcastRoster();
  return p;
}

function rosterPayload() {
  const r = {};
  for (const p of players.values()) if (p.alive) r[p.id] = { n: p.name, c: p.color, b: p.bot };
  return r;
}
let rosterTimer = null;
function broadcastRoster() {
  if (rosterTimer) return;
  rosterTimer = setTimeout(() => { rosterTimer = null; io.emit('roster', rosterPayload()); }, 0);
}

function killPlayer(victim, killer) {
  victim.alive = false;
  const lifeMs = Date.now() - victim.spawnedAt;
  if (killer) {
    killer.kills++;
    if (!killer.bot) io.sockets.sockets.get(killer.socketId)?.emit('kill', { kills: killer.kills });
    io.emit('feed', { k: killer.name, kc: killer.color, v: victim.name, vc: victim.color });
  } else {
    io.emit('feed', { k: null, v: victim.name, vc: victim.color });
  }
  if (!victim.bot) {
    const s = io.sockets.sockets.get(victim.socketId);
    s?.emit('dead', {
      by: killer ? killer.name : 'міна',
      score: Math.floor(victim.mass),
      best: Math.floor(victim.maxMass),
      kills: victim.kills,
      time: Math.round(lifeMs / 1000),
    });
  }
  players.delete(victim.id);
  broadcastRoster();
  if (victim.bot) setTimeout(spawnBot, rand(2000, 5000));
}

// ---------- Bots ----------
let botNameIdx = Math.floor(Math.random() * BOT_NAMES.length);
function spawnBot() {
  const bots = [...players.values()].filter(p => p.bot).length;
  if (bots >= BOT_TARGET) return;
  const name = '🤖 ' + BOT_NAMES[botNameIdx++ % BOT_NAMES.length];
  createPlayer({ id: nextId++, name, color: COLORS[Math.floor(Math.random() * COLORS.length)], bot: true });
}
for (let i = 0; i < BOT_TARGET; i++) spawnBot();

function botThink(b, dt) {
  const ai = b.ai;
  ai.think -= dt;
  if (ai.think > 0) return;
  ai.think = rand(0.15, 0.35);
  const r = radiusOf(b.mass);
  let fx = 0, fy = 0, threat = false, boost = false;
  let chase = null, chaseD = Infinity;
  for (const o of players.values()) {
    if (o === b || !o.alive) continue;
    const d = Math.hypot(o.x - b.x, o.y - b.y);
    const or = radiusOf(o.mass);
    if (o.mass > b.mass * 1.2 && d < 380 + or) {
      fx -= (o.x - b.x) / d; fy -= (o.y - b.y) / d; threat = true;
      if (d < or + r + 120) boost = true;
    } else if (b.mass > o.mass * 1.4 && d < 350 + r && d < chaseD && Date.now() - o.spawnedAt > SHIELD_MS + 2000 && (o.bot || Math.random() < 0.55)) {
      chase = o; chaseD = d;
    }
  }
  // avoid mines when big
  if (r > 60) for (const m of mines) {
    const d = Math.hypot(m.x - b.x, m.y - b.y);
    if (d < r + m.r + 90) { fx -= (m.x - b.x) / d * 1.5; fy -= (m.y - b.y) / d * 1.5; threat = true; }
  }
  if (threat) {
    b.input = { a: Math.atan2(fy, fx), t: 1, b: boost && b.mass > 30 };
    return;
  }
  if (chase) {
    b.input = { a: Math.atan2(chase.y - b.y, chase.x - b.x), t: 1, b: chaseD < 260 && b.mass > 40 && Math.random() < 0.5 };
    return;
  }
  let best = null, bestScore = -Infinity;
  for (const o of orbs.values()) {
    const d = Math.hypot(o.x - b.x, o.y - b.y);
    if (d > 600) continue;
    const s = o.v * 40 - d;
    if (s > bestScore) { bestScore = s; best = o; }
  }
  if (best) b.input = { a: Math.atan2(best.y - b.y, best.x - b.x), t: 1, b: false };
  else { ai.wander += rand(-0.6, 0.6); b.input = { a: ai.wander, t: 0.8, b: false }; }
  // steer away from walls
  if (b.x < 150 || b.x > W - 150 || b.y < 150 || b.y > H - 150) b.input.a = Math.atan2(H / 2 - b.y, W / 2 - b.x);
}

// ---------- Simulation ----------
function step(dt) {
  const now = Date.now();
  for (const p of players.values()) {
    if (!p.alive) continue;
    if (p.bot) botThink(p, dt);
    const r = radiusOf(p.mass);
    let speed = 320 * Math.pow(26 / r, 0.5) * (p.bot ? 0.9 : 1);
    const boosting = p.input.b && p.mass > 12;
    p.boosting = boosting;
    if (boosting) {
      speed *= 1.85;
      p.dropTimer -= dt;
      if (p.dropTimer <= 0) {
        p.dropTimer = 0.07;
        const cost = Math.max(0.6, p.mass * 0.006);
        p.mass -= cost;
        const back = p.input.a + Math.PI + rand(-0.4, 0.4);
        spawnOrb(p.x + Math.cos(back) * (r + 8), p.y + Math.sin(back) * (r + 8), cost * 0.75, COLORS.indexOf(p.color) >= 0 ? COLORS.indexOf(p.color) : 0);
      }
    }
    const t = clamp(p.input.t, 0, 1);
    const tx = Math.cos(p.input.a) * speed * t, ty = Math.sin(p.input.a) * speed * t;
    const k = Math.min(1, dt * (boosting ? 9 : 6));
    p.vx += (tx - p.vx) * k; p.vy += (ty - p.vy) * k;
    p.x = clamp(p.x + p.vx * dt, r * 0.5, W - r * 0.5);
    p.y = clamp(p.y + p.vy * dt, r * 0.5, H - r * 0.5);
    // slow decay for big players keeps the game fair
    if (p.mass > 150) p.mass -= p.mass * 0.0025 * dt;
  }

  // orbs
  for (const p of players.values()) {
    if (!p.alive) continue;
    const r = radiusOf(p.mass);
    for (const o of orbs.values()) {
      const dx = o.x - p.x, dy = o.y - p.y;
      const rr = r + orbRadius(o.v) * 0.3;
      if (dx * dx + dy * dy < rr * rr) {
        p.mass += o.v;
        removeOrb(o.id);
      }
    }
    p.maxMass = Math.max(p.maxMass, p.mass);
  }

  // player vs player
  const list = [...players.values()].filter(p => p.alive);
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const a = list[i], b = list[j];
      if (!a.alive || !b.alive) continue;
      if (a.mass < b.mass * 1.2) continue;
      if (now - b.spawnedAt < SHIELD_MS) continue;
      const ra = radiusOf(a.mass), rb = radiusOf(b.mass);
      if (Math.hypot(a.x - b.x, a.y - b.y) < ra - rb * 0.35) {
        a.mass += b.mass * 0.8;
        a.maxMass = Math.max(a.maxMass, a.mass);
        killPlayer(b, a);
      }
    }
  }

  // mines pop big players
  for (const m of mines) {
    for (const p of players.values()) {
      if (!p.alive) continue;
      const r = radiusOf(p.mass);
      if (r < m.r * 1.4) continue; // small players can hide behind mines
      if (Math.hypot(p.x - m.x, p.y - m.y) < r + m.r * 0.6) {
        const lost = p.mass * 0.4;
        p.mass -= lost;
        const n = Math.min(40, Math.ceil(lost / 3));
        for (let i = 0; i < n; i++) {
          const ang = rand(0, Math.PI * 2), dist = rand(r, r + 260);
          spawnOrb(p.x + Math.cos(ang) * dist, p.y + Math.sin(ang) * dist, lost / n * 0.8, COLORS.indexOf(p.color) >= 0 ? COLORS.indexOf(p.color) : 0);
        }
        Object.assign(m, placeMine());
        minesDirty = true;
        io.emit('boom', { x: Math.round(p.x), y: Math.round(p.y), id: p.id });
        break;
      }
    }
  }

  // refill orbs
  let deficit = ORB_COUNT - orbs.size;
  for (let i = 0; i < Math.min(deficit, 8); i++) spawnOrb();
}

let last = process.hrtime.bigint();
setInterval(() => {
  const nowNs = process.hrtime.bigint();
  const dt = Math.min(0.1, Number(nowNs - last) / 1e9);
  last = nowNs;
  step(dt);
}, 1000 / TICK_HZ);

// ---------- Networking ----------
setInterval(() => {
  const now = Date.now();
  const p = [];
  for (const pl of players.values()) {
    if (!pl.alive) continue;
    const flags = (pl.boosting ? 1 : 0) | (now - pl.spawnedAt < SHIELD_MS ? 2 : 0);
    p.push([pl.id, Math.round(pl.x), Math.round(pl.y), +pl.mass.toFixed(1), flags]);
  }
  io.emit('s', { t: now, p, oa: addedOrbs, or: removedOrbs });
  addedOrbs = []; removedOrbs = [];
  if (minesDirty) { minesDirty = false; io.emit('mines', mines); }
}, 1000 / SEND_HZ);

setInterval(() => {
  const all = [...players.values()].filter(p => p.alive).sort((a, b) => b.mass - a.mass);
  io.emit('lb', {
    top: all.slice(0, 10).map(p => [p.id, p.name, Math.floor(p.mass), p.color]),
    total: all.length,
    humans: all.filter(p => !p.bot).length,
    ranks: Object.fromEntries(all.map((p, i) => [p.id, i + 1])),
  });
}, 500);

io.on('connection', socket => {
  let me = null;
  socket.emit('init', {
    w: W, h: H, colors: COLORS,
    orbs: [...orbs.values()].map(packOrb),
    mines, roster: rosterPayload(),
  });

  socket.on('join', data => {
    if (me && me.alive) return;
    const name = sanitizeName(data?.name);
    const color = COLORS.includes(data?.color) ? data.color : COLORS[0];
    me = createPlayer({ id: nextId++, name, color, socketId: socket.id });
    socket.emit('joined', { id: me.id });
  });

  socket.on('input', d => {
    if (!me || !me.alive || !d) return;
    const a = Number(d.a), t = Number(d.t);
    if (Number.isFinite(a)) me.input.a = a;
    if (Number.isFinite(t)) me.input.t = clamp(t, 0, 1);
    me.input.b = !!d.b;
  });

  socket.on('ping_', cb => typeof cb === 'function' && cb(Date.now()));

  socket.on('disconnect', () => {
    if (me && me.alive) { me.alive = false; players.delete(me.id); broadcastRoster(); }
  });
});

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  console.log(`NEON DRIFT running:  http://localhost:${PORT}` + (lan ? `   (LAN: http://${lan.address}:${PORT})` : ''));
});

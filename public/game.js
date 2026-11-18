// NEON DRIFT — client
(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('game'), ctx = canvas.getContext('2d');
  const mini = $('minimap'), mctx = mini.getContext('2d');
  const radiusOf = m => 4 + Math.sqrt(m) * 5;
  const orbRadius = v => 4 + v * 1.2;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  // ---------- state ----------
  let W = 4000, H = 4000, COLORS = ['#00f5ff', '#ff2bd6', '#7cff4f', '#ffd400', '#ff6a2b', '#9b5cff', '#ff4d6d', '#2bffb1'];
  const orbs = new Map();       // id -> {x,y,v,c,born}
  const absorbing = [];         // orbs being sucked into a player
  let mines = [];
  let roster = {};
  const snaps = [];             // interpolation buffer
  let timeOffset = null;
  let myId = null, alive = false, connected = false;
  let myMass = 0, myKills = 0, lastScore = 0;
  let lb = { top: [], ranks: {}, total: 0 };
  const particles = [];
  const cam = { x: 2000, y: 2000, zoom: 0.6, shake: 0 };
  let dpr = 1, vw = 0, vh = 0;
  const pointer = { x: 0, y: 0, active: false };
  let boostKey = false, boostMouse = false, boostTouch = false;
  let selectedColor = store.get('nd_color') || COLORS[0];

  // ---------- canvas sizing ----------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth; vh = window.innerHeight;
    canvas.width = vw * dpr; canvas.height = vh * dpr;
    const ms = mini.getBoundingClientRect().width || 160;
    mini.width = ms * dpr; mini.height = ms * dpr;
  }
  window.addEventListener('resize', resize); resize();

  // ---------- orb sprites (pre-rendered glow) ----------
  const sprites = {};
  function sprite(color) {
    if (sprites[color]) return sprites[color];
    const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.18, color); grd.addColorStop(0.42, color + '88'); grd.addColorStop(1, color + '00');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    return (sprites[color] = c);
  }

  // ---------- menu ----------
  const nickInput = $('nick');
  nickInput.value = store.get('nd_nick') || '';
  function buildSwatches() {
    const box = $('colors'); box.innerHTML = '';
    if (!COLORS.includes(selectedColor)) selectedColor = COLORS[0];
    COLORS.forEach(c => {
      const d = document.createElement('div');
      d.className = 'swatch' + (c === selectedColor ? ' active' : '');
      d.style.background = c; d.style.color = c;
      d.onclick = () => { selectedColor = c; store.set('nd_color', c); buildSwatches(); };
      box.appendChild(d);
    });
  }
  buildSwatches();

  function play() {
    if (!connected) return;
    const name = nickInput.value.trim().slice(0, 16) || 'Гравець';
    nickInput.value = name;
    store.set('nd_nick', name); store.set('nd_color', selectedColor);
    socket.emit('join', { name, color: selectedColor });
  }
  $('playBtn').onclick = play;
  nickInput.addEventListener('keydown', e => { if (e.key === 'Enter') play(); });
  $('againBtn').onclick = play;
  $('menuBtn').onclick = () => { $('death').classList.add('hidden'); $('menu').classList.remove('hidden'); nickInput.focus(); };

  // ---------- network ----------
  const socket = io();
  const statusEl = $('status');
  socket.on('connect', () => { connected = true; statusEl.textContent = '● Сервер онлайн'; statusEl.className = 'status ok'; $('playBtn').disabled = false; });
  socket.on('disconnect', () => {
    connected = false; statusEl.textContent = 'З’єднання втрачено… перепідключення'; statusEl.className = 'status';
    if (alive) { alive = false; showMenu(); }
  });
  $('playBtn').disabled = true;

  socket.on('init', d => {
    W = d.w; H = d.h; COLORS = d.colors; buildSwatches();
    orbs.clear();
    for (const o of d.orbs) orbs.set(o[0], { x: o[1], y: o[2], v: o[3], c: o[4], born: 0 });
    mines = d.mines; roster = d.roster;
    cam.x = W / 2; cam.y = H / 2;
  });
  socket.on('roster', r => { roster = r; });
  socket.on('mines', m => { mines = m; });
  socket.on('joined', d => {
    myId = d.id; alive = true; myKills = 0; lastScore = -1; myMass = 20; $('kills').textContent = '0';
    $('menu').classList.add('hidden'); $('death').classList.add('hidden'); $('hud').classList.remove('hidden');
    canvas.focus();
  });
  socket.on('s', s => {
    const now = performance.now();
    const off = s.t - Date.now();
    timeOffset = timeOffset === null ? off : lerp(timeOffset, off, 0.05);
    const map = new Map();
    for (const p of s.p) map.set(p[0], p);
    snaps.push({ t: s.t, p: map });
    while (snaps.length > 30) snaps.shift();
    for (const o of s.oa) orbs.set(o[0], { x: o[1], y: o[2], v: o[3], c: o[4], born: now });
    for (const id of s.or) {
      const o = orbs.get(id); if (!o) continue;
      orbs.delete(id);
      // find who ate it to animate absorption
      let best = null, bd = Infinity;
      for (const p of s.p) { const d = Math.hypot(p[1] - o.x, p[2] - o.y) - radiusOf(p[3]); if (d < bd) { bd = d; best = p[0]; } }
      if (best !== null && bd < 60 && absorbing.length < 300) absorbing.push({ ...o, to: best, t0: now });
    }
    const mine = map.get(myId);
    if (alive && mine) {
      myMass = mine[3];
    }
  });
  socket.on('lb', d => { lb = d; renderLeaderboard(); });
  socket.on('feed', f => addFeed(f));
  socket.on('kill', d => { myKills = d.kills; $('kills').textContent = myKills; });
  socket.on('boom', b => {
    burst(b.x, b.y, '#ff4d6d', 40, 500);
    if (b.id === myId) cam.shake = 18;
  });
  socket.on('dead', d => {
    alive = false;
    const me = lastPos;
    if (me) burst(me.x, me.y, selectedColor, 60, 600);
    cam.shake = 14;
    $('deathBy').innerHTML = d.by === 'міна' ? 'Тебе зруйнувала <b>міна</b>' : `Тебе поглинув <b></b>`;
    if (d.by !== 'міна') $('deathBy').querySelector('b').textContent = d.by;
    $('dScore').textContent = d.score; $('dBest').textContent = d.best;
    $('dKills').textContent = d.kills; $('dTime').textContent = fmtTime(d.time);
    $('againNick').textContent = 'як ' + (nickInput.value || 'Гравець');
    setTimeout(() => { if (!alive) { $('hud').classList.add('hidden'); $('death').classList.remove('hidden'); } }, 700);
  });
  const fmtTime = s => s >= 60 ? `${Math.floor(s / 60)}хв ${s % 60}с` : `${s}с`;
  function showMenu() { $('hud').classList.add('hidden'); $('death').classList.add('hidden'); $('menu').classList.remove('hidden'); }

  // ---------- HUD ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function renderLeaderboard() {
    $('online').textContent = `${lb.humans ?? 0} 👤 · ${lb.total}`;
    let html = '';
    let meShown = false;
    lb.top.forEach(([id, name, score, color], i) => {
      const me = id === myId && alive; if (me) meShown = true;
      html += `<li class="${me ? 'me' : ''}"><span class="pos">${i + 1}</span><span class="dot" style="background:${esc(color)};color:${esc(color)}"></span><span class="nm">${esc(name)}</span><span class="sc">${score}</span></li>`;
    });
    if (alive && !meShown && lb.ranks[myId]) {
      html += `<li class="sep">⋯</li><li class="me"><span class="pos">${lb.ranks[myId]}</span><span class="dot" style="background:${esc(selectedColor)};color:${esc(selectedColor)}"></span><span class="nm">${esc(nickInput.value)}</span><span class="sc">${Math.floor(myMass)}</span></li>`;
    }
    $('lbList').innerHTML = html;
    $('rank').textContent = '#' + (lb.ranks[myId] ?? '–');
  }
  function addFeed(f) {
    const el = document.createElement('div'); el.className = 'feed-item';
    if (f.k) {
      el.innerHTML = `<b style="color:${esc(f.kc)}">${esc(f.k)}</b> поглинув <b style="color:${esc(f.vc)}">${esc(f.v)}</b>`;
    } else el.innerHTML = `💥 <b style="color:${esc(f.vc)}">${esc(f.v)}</b> підірвався`;
    const feed = $('feed'); feed.prepend(el);
    while (feed.children.length > 4) feed.lastChild.remove();
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }, 4000);
  }
  function updateScore() {
    const s = Math.floor(myMass);
    if (s !== lastScore) {
      const el = $('score'); el.textContent = s;
      if (s > lastScore) { el.classList.add('bump'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('bump'), 120); }
      lastScore = s;
    }
  }

  // ---------- input ----------
  canvas.addEventListener('mousemove', e => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.active = true; });
  canvas.addEventListener('mousedown', e => { if (e.button === 0 || e.button === 2) boostMouse = true; });
  window.addEventListener('mouseup', () => { boostMouse = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && alive) { boostKey = true; e.preventDefault(); }
    if (e.key === 'Enter' && !$('death').classList.contains('hidden')) play();
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') boostKey = false; });
  const touchMove = e => {
    for (const t of e.touches) if (t.target === canvas) { pointer.x = t.clientX; pointer.y = t.clientY; pointer.active = true; }
    e.preventDefault();
  };
  canvas.addEventListener('touchstart', touchMove, { passive: false });
  canvas.addEventListener('touchmove', touchMove, { passive: false });
  const bb = $('boostBtn');
  bb.addEventListener('touchstart', e => { boostTouch = true; bb.classList.add('on'); e.preventDefault(); }, { passive: false });
  bb.addEventListener('touchend', e => { boostTouch = false; bb.classList.remove('on'); e.preventDefault(); }, { passive: false });

  let lastSent = '';
  setInterval(() => {
    if (!alive || !pointer.active) return;
    const dx = pointer.x - vw / 2, dy = pointer.y - vh / 2;
    const r = radiusOf(myMass) * cam.zoom;
    const a = Math.atan2(dy, dx);
    const t = clamp((Math.hypot(dx, dy) - r * 0.2) / (r + 120), 0, 1);
    const b = boostKey || boostMouse || boostTouch;
    const msg = { a: +a.toFixed(3), t: +t.toFixed(2), b };
    const key = JSON.stringify(msg);
    if (key !== lastSent) { socket.emit('input', msg); lastSent = key; }
  }, 33);

  // ---------- particles ----------
  function burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * speed;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, decay: 0.8 + Math.random(), size: 3 + Math.random() * 6, color });
    }
  }

  // ---------- interpolation ----------
  function interpolated() {
    const out = new Map();
    if (!snaps.length) return out;
    const rt = Date.now() + (timeOffset || 0) - 110;
    let a = snaps[0], b = null;
    for (let i = 0; i < snaps.length; i++) {
      if (snaps[i].t <= rt) a = snaps[i]; else { b = snaps[i]; break; }
    }
    if (!b) b = a;
    const t = b.t === a.t ? 1 : clamp((rt - a.t) / (b.t - a.t), 0, 1);
    for (const [id, pb] of b.p) {
      const pa = a.p.get(id) || pb;
      out.set(id, { id, x: lerp(pa[1], pb[1], t), y: lerp(pa[2], pb[2], t), m: lerp(pa[3], pb[3], t), f: pb[4] });
    }
    return out;
  }

  // ---------- rendering ----------
  let lastPos = null;
  let last = performance.now();
  let idleAng = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    try { render(now); } catch (e) { console.error(e); }
  }
  function render(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const ps = interpolated();
    const me = ps.get(myId);

    // camera
    let tz;
    const screenK = Math.min(vw, vh) / 900;
    if (alive && me) {
      lastPos = { x: me.x, y: me.y };
      cam.x = lerp(cam.x, me.x, Math.min(1, dt * 10));
      cam.y = lerp(cam.y, me.y, Math.min(1, dt * 10));
      tz = clamp(Math.pow(30 / radiusOf(me.m), 0.38), 0.4, 1.05) * Math.max(0.6, screenK) * 1.15;
    } else if (!alive && lastPos && $('menu').classList.contains('hidden')) {
      tz = cam.zoom; // linger on death spot
    } else {
      idleAng += dt * 0.05;
      cam.x = lerp(cam.x, W / 2 + Math.cos(idleAng) * 900, dt * 0.5);
      cam.y = lerp(cam.y, H / 2 + Math.sin(idleAng * 1.3) * 900, dt * 0.5);
      tz = 0.55 * Math.max(0.6, screenK);
    }
    cam.zoom = lerp(cam.zoom, tz, Math.min(1, dt * 3));
    cam.shake *= Math.pow(0.02, dt);
    const sx = (Math.random() - 0.5) * cam.shake, sy = (Math.random() - 0.5) * cam.shake;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#07070f'; ctx.fillRect(0, 0, vw, vh);
    const z = cam.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (vw / 2 - cam.x * z + sx), dpr * (vh / 2 - cam.y * z + sy));

    const viewL = cam.x - vw / 2 / z - 100, viewR = cam.x + vw / 2 / z + 100;
    const viewT = cam.y - vh / 2 / z - 100, viewB = cam.y + vh / 2 / z + 100;
    const inView = (x, y, r) => x + r > viewL && x - r < viewR && y + r > viewT && y - r < viewB;

    drawGrid(viewL, viewR, viewT, viewB, now);

    // orbs
    for (const o of orbs.values()) {
      if (!inView(o.x, o.y, 20)) continue;
      const age = o.born ? clamp((now - o.born) / 300, 0, 1) : 1;
      const pulse = 1 + Math.sin(now / 300 + o.x) * 0.12;
      const r = orbRadius(o.v) * 2.6 * pulse * age;
      ctx.drawImage(sprite(COLORS[o.c] || '#ffffff'), o.x - r, o.y - r, r * 2, r * 2);
    }
    for (let i = absorbing.length - 1; i >= 0; i--) {
      const o = absorbing[i]; const k = (now - o.t0) / 180; const tgt = ps.get(o.to);
      if (k >= 1 || !tgt) { absorbing.splice(i, 1); continue; }
      const x = lerp(o.x, tgt.x, k * k), y = lerp(o.y, tgt.y, k * k), r = orbRadius(o.v) * 2.6 * (1 - k);
      ctx.drawImage(sprite(COLORS[o.c] || '#ffffff'), x - r, y - r, r * 2, r * 2);
    }

    // mines
    for (const m of mines) if (inView(m.x, m.y, m.r * 2)) drawMine(m, now);

    // players (small first so bigger ones overlap)
    const sorted = [...ps.values()].sort((a, b) => a.m - b.m);
    for (const p of sorted) {
      const r = radiusOf(p.m);
      if (!inView(p.x, p.y, r + 60)) continue;
      const info = roster[p.id] || { n: '???', c: '#ffffff' };
      if (p.f & 1 && Math.random() < 0.8) {
        particles.push({ x: p.x + (Math.random() - 0.5) * r, y: p.y + (Math.random() - 0.5) * r, vx: 0, vy: 0, life: 1, decay: 2.2, size: 3 + r * 0.12, color: info.c });
      }
      drawPlayer(p, r, info, now);
    }

    // particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.life -= q.decay * dt;
      if (q.life <= 0) { particles.splice(i, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.94; q.vy *= 0.94;
      ctx.globalAlpha = q.life;
      const s = q.size * (0.5 + q.life);
      ctx.drawImage(sprite(q.color), q.x - s, q.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;

    // names on top of everything
    for (const p of sorted) {
      const r = radiusOf(p.m);
      if (!inView(p.x, p.y, r + 60)) continue;
      drawLabel(p, r, roster[p.id] || { n: '???', c: '#ffffff' });
    }

    if (alive) updateScore();
    drawMinimap(ps, now);
  }

  function drawGrid(l, r, t, b, now) {
    const step = 64;
    ctx.lineWidth = 1 / cam.zoom;
    ctx.strokeStyle = 'rgba(90,110,255,0.09)';
    ctx.beginPath();
    for (let x = Math.max(0, Math.floor(l / step) * step); x <= Math.min(W, r); x += step) { ctx.moveTo(x, Math.max(0, t)); ctx.lineTo(x, Math.min(H, b)); }
    for (let y = Math.max(0, Math.floor(t / step) * step); y <= Math.min(H, b); y += step) { ctx.moveTo(Math.max(0, l), y); ctx.lineTo(Math.min(W, r), y); }
    ctx.stroke();
    // world border
    ctx.save();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ff2bd6';
    ctx.shadowColor = '#ff2bd6'; ctx.shadowBlur = 30;
    ctx.globalAlpha = 0.7 + Math.sin(now / 400) * 0.2;
    ctx.strokeRect(0, 0, W, H);
    ctx.restore();
  }

  function drawMine(m, now) {
    const spikes = 12, rot = now / 1500, pulse = 1 + Math.sin(now / 250 + m.id) * 0.06;
    ctx.save();
    ctx.translate(m.x, m.y); ctx.rotate(rot);
    ctx.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2;
      const rr = (i % 2 ? m.r * 0.72 : m.r * 1.12) * pulse;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,40,80,0.18)';
    ctx.strokeStyle = '#ff2850'; ctx.lineWidth = 3;
    ctx.shadowColor = '#ff2850'; ctx.shadowBlur = 20;
    ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.arc(0, 0, m.r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = '#ff2850'; ctx.fill();
    ctx.restore();
  }

  function drawPlayer(p, r, info, now) {
    const c = info.c;
    const n = Math.max(24, Math.min(64, Math.floor(r / 2)));
    const seed = p.id * 1.7;
    ctx.save();
    ctx.translate(p.x, p.y);
    // body (wobbly membrane)
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = Math.sin(a * 5 + now / 260 + seed) * 0.025 + Math.sin(a * 3 - now / 410 + seed) * 0.02;
      const rr = r * (1 + w);
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
    g.addColorStop(0, c + 'cc'); g.addColorStop(0.7, c + '55'); g.addColorStop(1, c + '22');
    ctx.fillStyle = g;
    ctx.shadowColor = c; ctx.shadowBlur = p.f & 1 ? 45 : 25;
    ctx.fill();
    ctx.lineWidth = Math.max(3, r * 0.07);
    ctx.strokeStyle = c;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // inner core
    ctx.beginPath(); ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fill();
    // spawn shield
    if (p.f & 2) {
      ctx.rotate(now / 500);
      ctx.setLineDash([10, 8]);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath(); ctx.arc(0, 0, r + 10, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    // own indicator ring
    if (p.id === myId) {
      ctx.save();
      ctx.globalAlpha = 0.35 + Math.sin(now / 300) * 0.15;
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  function drawLabel(p, r, info) {
    const fs = clamp(r * 0.38, 14, 34) / Math.max(0.75, cam.zoom) * 0.85;
    ctx.save();
    ctx.font = `700 ${fs}px Inter, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = fs * 0.22; ctx.strokeStyle = 'rgba(5,5,15,0.85)';
    const y = p.y - r - 10;
    ctx.strokeText(info.n, p.x, y);
    ctx.fillStyle = p.id === myId ? '#ffffff' : '#e9ecff';
    ctx.fillText(info.n, p.x, y);
    if (r > 34) {
      ctx.font = `800 ${clamp(r * 0.32, 12, 40)}px Orbitron, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(Math.floor(p.m), p.x, p.y);
    }
    ctx.restore();
  }

  function drawMinimap(ps, now) {
    if ($('hud').classList.contains('hidden')) return;
    const s = mini.width, k = s / W;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.clearRect(0, 0, s, s);
    mctx.fillStyle = 'rgba(255,40,80,0.5)';
    for (const m of mines) { mctx.fillRect(m.x * k - 1.5 * dpr, m.y * k - 1.5 * dpr, 3 * dpr, 3 * dpr); }
    const top = new Set(lb.top.slice(0, 5).map(t => t[0]));
    for (const p of ps.values()) {
      const isMe = p.id === myId;
      if (!isMe && !top.has(p.id)) continue;
      const info = roster[p.id] || { c: '#ffffff' };
      mctx.fillStyle = isMe ? '#fff' : info.c;
      mctx.beginPath();
      mctx.arc(p.x * k, p.y * k, (isMe ? 4 + Math.sin(now / 200) : 3) * dpr, 0, Math.PI * 2);
      mctx.fill();
    }
    // viewport rect
    const z = cam.zoom;
    mctx.strokeStyle = 'rgba(255,255,255,0.25)'; mctx.lineWidth = dpr;
    mctx.strokeRect((cam.x - vw / 2 / z) * k, (cam.y - vh / 2 / z) * k, (vw / z) * k, (vh / z) * k);
  }

  requestAnimationFrame(frame);
  nickInput.focus();
})();

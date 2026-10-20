'use strict';
/**
 * Void Striker 2 co-op server.
 *
 * Speaks the protocol the game client expects:
 *   POST /api/session   -> { token, player:{id,name}, receipts }
 *   WS   /ws            -> hello / create / join / leave / ready / start / input / action
 * The server is authoritative: it simulates the round and broadcasts snapshots.
 *
 * Run:  npm install && npm start      (PORT env var, default 8080)
 * Also serves the game itself at "/" when GAME_FILE (default ./public/index.html) exists,
 * which makes local testing a one-command affair.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ETYPES, ELITES, BTYPES, DETHER_DEF } = require('./gamedata.js');

const PORT = Number(process.env.PORT) || 8080;
const GAME_FILE = process.env.GAME_FILE || path.join(__dirname, 'public', 'index.html');
const CG_PUBLIC_KEY = process.env.CG_PUBLIC_KEY || ''; // optional PEM; verifies CrazyGames user tokens
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);

// ── constants shared with the client ────────────────────────────────────
const ARENA = 36, BOUND = 34.5, MAX_SEATS = 5;
const ALLY_COUNTS = [0, 1, 3, 5, 7, 9];
const TICK = 1 / 20;
const RECONNECT_GRACE_MS = 30000;
const EMPTY_ROOM_MS = 60000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const int = (v, lo, hi) => clamp(Math.floor(num(v)), lo, hi);
const rid = bytes => crypto.randomBytes(bytes).toString('hex').toUpperCase();
const rnd = (a, b) => a + Math.random() * (b - a);

// ── players / sessions ──────────────────────────────────────────────────
const sessions = new Map(); // token -> record
const players = new Map();  // id -> record  { id,name,token,ws,room,receipts }

function cleanName(s) {
  const t = String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 18);
  return t || null;
}
function decodeJwt(token) {
  try {
    const [h, p, sig] = String(token).split('.');
    if (!h || !p || !sig) return null;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    let verified = false;
    if (CG_PUBLIC_KEY && header.alg === 'RS256') {
      verified = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), CG_PUBLIC_KEY, Buffer.from(sig, 'base64url'));
      if (verified && payload.exp && payload.exp * 1000 < Date.now()) verified = false;
    }
    return { payload, verified };
  } catch { return null; }
}
function createSession(body) {
  const jwt = body.cgToken ? decodeJwt(body.cgToken) : null;
  // Verified CrazyGames users get a stable account id. Everyone else is a guest.
  if (jwt?.verified && jwt.payload.userId) {
    const id = 'cg:' + String(jwt.payload.userId).slice(0, 64);
    let p = players.get(id);
    if (!p) { p = { id, name: cleanName(jwt.payload.username) || 'Pilot', ws: null, room: null, receipts: [] }; players.set(id, p); }
    else if (cleanName(jwt.payload.username)) p.name = cleanName(jwt.payload.username);
    const token = rid(24); sessions.set(token, p); p.token = token;
    return p;
  }
  if (typeof body.resumeToken === 'string' && sessions.has(body.resumeToken)) {
    const p = sessions.get(body.resumeToken);
    if (p.id.startsWith('guest:')) return p;
  }
  const id = 'guest:' + rid(6);
  // The username claim of an unverified token is display-only and never trusted for identity.
  const name = cleanName(jwt?.payload?.username) || 'Pilot-' + id.slice(-4);
  const p = { id, name, ws: null, room: null, receipts: [] };
  players.set(id, p);
  const token = rid(24); sessions.set(token, p); p.token = token;
  return p;
}

// ── room / round model ──────────────────────────────────────────────────
const rooms = new Map();

function newSeat(p) {
  return {
    id: p.id, name: p.name, ready: false, connected: true, reserved: false, reserveUntil: 0,
    participant: false, alive: false, colorSlot: 0,
    loadout: defaultLoadout(),
    x: 0, z: 0, a: 0, hp: 100, maxHp: 100, sh: 100, maxSh: 100, ammo: 30, reload: 0,
    kills: 0, novas: 3, satT: 0, satCD: 0, hexT: 0, hexHP: 0, hexCD: 0, overT: 0, overCD: 0, repairCD: 0,
    speedT: 0, bulletT: 0, uses: [], damage: 0, healing: 0,
    // server-only
    input: { x: 0, z: 0, a: 0, fire: false }, shootCD: 0, shRegenCD: 0, pulseCD: 0, dashT: 0, dashCD: 0, satFire: 0,
    score: 0, bosses: 0, stats: {}, deathTime: null, speedUses: 0, bulletUses: 0, lastHit: 0,
  };
}
function defaultLoadout() {
  return { skill: 0, firepower: 1, aegisLevel: 0, armorLevel: 0, overclockLevel: 0, repairLevel: 0, speed: 0, bullet: 0, equipSpeed: false, equipBullet: false, shipHull: 'striker', shipSkin: 'cyan' };
}
function sanitizeLoadout(l) {
  l = l && typeof l === 'object' ? l : {};
  const hulls = ['striker', 'razor', 'manta', 'eclipse'], skins = ['cyan', 'solar', 'ion', 'crimson', 'polar'];
  return {
    skill: int(l.skill, 0, 5), firepower: int(l.firepower, 1, 5), aegisLevel: int(l.aegisLevel, 0, 5),
    armorLevel: int(l.armorLevel, 0, 5), overclockLevel: int(l.overclockLevel, 0, 5), repairLevel: int(l.repairLevel, 0, 5),
    speed: int(l.speed, 0, 9999), bullet: int(l.bullet, 0, 9999), equipSpeed: !!l.equipSpeed, equipBullet: !!l.equipBullet,
    shipHull: hulls.includes(l.shipHull) ? l.shipHull : 'striker', shipSkin: skins.includes(l.shipSkin) ? l.shipSkin : 'cyan',
  };
}

function createRoom() {
  let id; do { id = rid(8); } while (rooms.has(id));
  const room = {
    id, phase: 'lobby', host: null, seats: new Map(), nextWave: Number(process.env.DEBUG_START_WAVE) || 1, roundId: null,
    time: 0, wave: 1, score: 0, enemies: [], bullets: [], enemyBullets: [], events: [], nextId: 1,
    spawnQueue: 0, spawnT: 0, waveT: 0, blockEnd: 5, bossAlive: false, bossesKilled: 0,
    emptySince: Date.now(), dirty: true, endTimer: 0, victory: false,
  };
  rooms.set(id, room); return room;
}
const connectedSeats = room => [...room.seats.values()].filter(s => s.connected);
const occupied = room => [...room.seats.values()].filter(s => s.connected || s.reserved).length;

function send(p, msg) {
  const ws = p.ws; if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
}
function broadcast(room, msg) {
  const data = JSON.stringify(msg), snap = msg.type === 'snapshot';   // serialize once per room, not once per client
  for (const s of room.seats.values()) {
    if (!s.connected) continue;
    const ws = players.get(s.id)?.ws; if (!ws || ws.readyState !== 1) continue;
    if (snap && ws.bufferedAmount > 262144) continue;                   // slow client: drop this snapshot instead of queueing lag
    try { ws.send(data); } catch { /* socket closing */ }
  }
}

function pickColorSlot(room) {
  const used = new Set([...room.seats.values()].filter(s => s.connected || s.reserved).map(s => s.colorSlot));
  for (let i = 0; i < MAX_SEATS; i++) if (!used.has(i)) return i;
  return 0;
}
function joinRoom(p, room) {
  let seat = room.seats.get(p.id);
  if (!seat) {
    if (occupied(room) >= MAX_SEATS) return send(p, { type: 'error', message: 'This squad is full.' });
    seat = newSeat(p); seat.colorSlot = pickColorSlot(room); room.seats.set(p.id, seat);
  }
  seat.connected = true; seat.reserved = false; seat.name = p.name;
  if (!room.host || !room.seats.get(room.host)?.connected) room.host = p.id;
  p.room = room.id; room.emptySince = 0; room.dirty = true;
  send(p, { type: 'joined', room: room.id, playerId: p.id });
  send(p, snapshot(room));
}
function leaveRoom(p, notify = true) {
  const room = rooms.get(p.room); p.room = null;
  if (!room) return;
  const seat = room.seats.get(p.id);
  if (seat) {
    if (room.phase === 'playing' && seat.participant && seat.alive) { seat.alive = false; seat.deathTime = room.time; }
    room.seats.delete(p.id);
  }
  if (room.host === p.id) room.host = connectedSeats(room)[0]?.id || null;
  if (!connectedSeats(room).length) room.emptySince = Date.now();
  room.dirty = true;
  if (notify) send(p, { type: 'left' });
}

// ── snapshot ────────────────────────────────────────────────────────────
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
function snapshot(room) {
  return {
    type: 'snapshot', room: room.id, phase: room.phase, roundId: room.roundId, host: room.host,
    time: r2(room.time), wave: room.wave, score: Math.floor(room.score), nextWave: room.nextWave, seats: occupied(room),
    players: [...room.seats.values()].map(s => ({
      id: s.id, name: s.name, ready: s.ready, alive: s.alive, connected: s.connected, reserved: s.reserved,
      participant: s.participant, colorSlot: s.colorSlot, loadout: s.loadout,
      x: r2(s.x), z: r2(s.z), a: r2(s.a), hp: Math.ceil(s.hp), maxHp: s.maxHp, sh: Math.ceil(s.sh), maxSh: s.maxSh,
      bst: 1, dr: s.dr || {}, rg: !!s.rg, ammo: s.ammo, reload: r2(s.reload), kills: s.kills, novas: s.novas,
      satT: r1(s.satT), satCD: r1(s.satCD), hexT: r1(s.hexT), hexHP: Math.ceil(s.hexHP), hexCD: r1(s.hexCD),
      overT: r1(s.overT), overCD: r1(s.overCD), repairCD: r1(s.repairCD), speedT: r1(s.speedT), bulletT: r1(s.bulletT),
      uses: s.uses, damage: Math.floor(s.damage), healing: Math.floor(s.healing),
    })),
    drops: (room.drops || []).map(d => ({ id: d.id, k: d.k, x: r2(d.x), z: r2(d.z) })),
    enemies: room.enemies.map(e => ({ id: e.id, kind: e.kind, idx: e.idx, x: r2(e.x), z: r2(e.z), hp: Math.ceil(e.hp), maxHp: e.maxHp, flash: e.flash > 0 ? 1 : 0, bars: e.bars, totalBars: e.totalBars })),
    bullets: room.bullets.slice(0, 180).map(b => ({ id: b.id, x: r2(b.x), z: r2(b.z), vx: r1(b.vx), vz: r1(b.vz), source: b.source })),
    enemyBullets: room.enemyBullets.slice(0, 120).map(b => ({ id: b.id, x: r2(b.x), z: r2(b.z), vx: r1(b.vx), vz: r1(b.vz) })),
  };
}

// ── round control ───────────────────────────────────────────────────────
function startRound(room) {
  const ready = connectedSeats(room).filter(s => s.ready);
  if (!ready.length) return;
  room.phase = 'playing'; room.roundId = rid(8).toLowerCase() + Date.now().toString(36);
  room.time = 0; room.score = 0; room.enemies = []; room.bullets = []; room.enemyBullets = []; room.events = []; room.drops = []; room.bossSeen = room.nextWave > 5; room.bossT = 0;
  room.wave = room.nextWave; room.blockEnd = room.nextWave + 4; room.victory = false; room.bossesKilled = 0;
  room.waveT = 0; room.bossAlive = false; room.endTimer = 0; room.spawnQueue = 0; room.spawnT = 0;
  startWave(room);
  let i = 0;
  for (const s of room.seats.values()) {
    const part = s.connected && s.ready;
    s.participant = part; s.alive = part; s.deathTime = null;
    s.maxHp = 100 + s.loadout.armorLevel * 20; s.hp = s.maxHp; s.maxSh = 100; s.sh = 100; s.ammo = 30; s.reload = 0;
    s.kills = 0; s.novas = 3; s.satT = s.satCD = s.hexT = s.hexHP = s.hexCD = s.overT = s.overCD = s.repairCD = s.speedT = s.bulletT = 0;
    s.uses = []; s.damage = 0; s.healing = 0; s.score = 0; s.bosses = 0; s.stats = {}; s.speedUses = 0; s.bulletUses = 0;
    s.dr = {}; s.rg = false; s.dmgT = 0; s.orbPts = 0; s.shootCD = 0; s.pulseCD = 0; s.dashT = s.dashCD = 0; s.input = { x: 0, z: 0, a: 0, fire: false };
    const ang = (i++ / Math.max(1, ready.length)) * Math.PI * 2; s.x = Math.cos(ang) * 2.5; s.z = Math.sin(ang) * 2.5;
    if (part) {
      for (const t of ['speed', 'bullet']) {
        const eq = t === 'speed' ? s.loadout.equipSpeed : s.loadout.equipBullet;
        if (eq && s.loadout[t] > 0) useBoost(room, s, t, true);
      }
    }
    s.ready = false;
  }
  room.dirty = true;
}
function useBoost(room, s, type, initial = false) {
  const used = type === 'speed' ? s.speedUses : s.bulletUses;
  if (s.loadout[type] - used <= 0) return;
  if (type === 'speed') s.speedUses++; else s.bulletUses++;
  s.uses.push({ id: `${room.roundId}:${s.id}:${initial ? 'initial:' : ''}${type}:${used}`, type });
  s[type === 'speed' ? 'speedT' : 'bulletT'] = 20;
}
function playerScale(room) { return 1 + 0.5 * Math.max(0, [...room.seats.values()].filter(s => s.participant).length - 1); }

function startWave(room) {
  const wave = room.wave, scale = playerScale(room);
  room.waveT = 0; room.spawnT = 0;
  if (wave % 5 === 0) {
    const detherPos = wave % 75 || 75;
    if (wave % 25 === 0) spawnDether(room, detherPos);
    else spawnBoss(room);
    room.spawnQueue = Math.floor(4 * scale);
  } else {
    room.spawnQueue = Math.max(3, Math.floor((5 + wave * 1.3) * scale * (0.5 + 0.5 * easeMul(room))));
  }
}
// Easy opening: until the first boss of a round appears, enemies are weak; then difficulty ramps back to normal over 20 s.
function easeMul(room) { return room.bossSeen ? Math.min(1, 0.3 + 0.7 * ((room.time - (room.bossT || 0)) / 20)) : 0.3; }
function hpScale(room) { return (1 + (room.wave - 1) * 0.06) * (1 + 0.35 * (playerScale(room) - 1)) * easeMul(room); }
function edgeSpawn() {
  const a = Math.random() * Math.PI * 2, r = ARENA - 2;
  return { x: clamp(Math.cos(a) * r, -BOUND, BOUND), z: clamp(Math.sin(a) * r, -BOUND, BOUND) };
}
function spawnEnemy(room) {
  const wave = room.wave;
  const tierMax = wave >= 28 ? 4 : wave >= 16 ? 3 : wave >= 8 ? 2 : 1;
  const pool = []; ETYPES.forEach((t, i) => { if (t.tier <= tierMax) pool.push(i); });
  const elite = wave > 2 && Math.random() < 0.08;
  const idx = elite ? Math.floor(Math.random() * ELITES.length) : pool[Math.floor(Math.random() * pool.length)];
  const t = elite ? ELITES[idx] : ETYPES[idx], pos = edgeSpawn(), hp = Math.floor(t.hp * hpScale(room));
  room.enemies.push({
    id: room.nextId++, kind: elite ? 'elite' : 'enemy', idx, x: pos.x, z: pos.z, hp, maxHp: hp, spd: t.spd, atk: t.atk, ranged: !!t.ranged,
    pts: t.pts, sz: t.sz, flash: 0, cd: rnd(0.5, 2), hitCD: 0, bars: 0, totalBars: 0, splits: !!t.splits, isBoss: false,
  });
}
function getBossType(wave) {
  const idx = Math.floor(wave / 5) - 1;
  if (idx < BTYPES.length) return Object.assign({}, BTYPES[idx]);
  const tier = Math.floor(idx / BTYPES.length) + 1, base = Object.assign({}, BTYPES[idx % BTYPES.length]);
  base.hp = Math.floor(base.hp * Math.pow(3, tier)); base.pts = Math.floor(base.pts * (1 + tier * 0.4));
  return base;
}
function spawnBoss(room) {
  room.bossSeen = true; room.bossT = room.time;
  const b = getBossType(room.wave), hp = Math.floor((b.hp + room.wave * 40) * (1 + 0.6 * (playerScale(room) - 1)));
  room.enemies.push({
    id: room.nextId++, kind: 'boss', idx: 0, x: 0, z: -ARENA + 7, hp, maxHp: hp, spd: b.spd, atk: 30, ranged: true,
    pts: b.pts, sz: b.sz, flash: 0, cd: 2, hitCD: 0, bars: 0, totalBars: 0, isBoss: true, rings: b.rings || 3, burstCD: 2.5,
  });
  room.bossAlive = true;
}
function spawnDether(room, pos) {
  room.bossSeen = true; room.bossT = room.time;
  const cycle = Math.floor((room.wave - 1) / 75), base = DETHER_DEF[pos === 75 ? 0 : pos] || DETHER_DEF[25];
  const scale = Math.pow(1.5, cycle), bars = base.bars;
  const hp = Math.floor(base.hp * scale * (1 + 0.6 * (playerScale(room) - 1)) / bars);
  room.enemies.push({
    id: room.nextId++, kind: 'dether', idx: 0, x: 0, z: -ARENA + 7, hp, maxHp: hp, spd: Math.min(base.spd + cycle * 0.15, 3.5), atk: 40, ranged: true,
    pts: Math.floor(base.pts * scale), sz: base.sz, flash: 0, cd: 2, hitCD: 0, bars, totalBars: bars, isBoss: true, rings: 5, burstCD: 2,
  });
  room.bossAlive = true;
}

const SPECIALS = { overdrive: 10, timewarp: 8, multishot: 6, lifesteal: 8.3, voidcloak: 5 }, SPECIAL_KEYS = [...Object.keys(SPECIALS), 'railgun'], PUS = ['rapid', 'shield', 'damage', 'health', 'nova'];
let _inMS = false;
const pickOne = a => a[Math.floor(Math.random() * a.length)];
function addDrop(room, x, z, k, life) { (room.drops ||= []).push({ id: room.nextId++, k, x: clamp(x + rnd(-1.5, 1.5), -BOUND, BOUND), z: clamp(z + rnd(-1.5, 1.5), -BOUND, BOUND), life }); }
function addOrb(room, x, z, v, big) {
  const d = (room.drops ||= []); let n = 0; for (const o of d) if (o.k === 'orb' || o.k === 'orbbig') n++;
  if (n > 30) { const i = d.findIndex(o => o.k === 'orb' || o.k === 'orbbig'); if (i >= 0) d.splice(i, 1); }
  d.push({ id: room.nextId++, k: big ? 'orbbig' : 'orb', v, x: clamp(x + rnd(-2.5, 2.5), -BOUND, BOUND), z: clamp(z + rnd(-2.5, 2.5), -BOUND, BOUND), life: 12 });
}
function rollDrops(room, e) {
  if (e.isShrapnel) return;
  if (e.isBoss) { for (let i = 0; i < 7; i++) addOrb(room, e.x, e.z, Math.floor(e.pts / 7), true); }
  else addOrb(room, e.x, e.z, Math.floor(e.pts / 3), false);
  if (e.isBoss) { for (let i = 0; i < 2; i++) addDrop(room, e.x, e.z, pickOne(SPECIAL_KEYS), 11.7); }
  else if (e.kind === 'elite') addDrop(room, e.x, e.z, pickOne(SPECIAL_KEYS), 11.7);
  else if (Math.random() < (room.bossSeen ? 0.16 : 0.28)) addDrop(room, e.x, e.z, pickOne(PUS), 8);
}
function applyDrop(room, s, k) {
  s.dr ||= {};
  if (k in SPECIALS) s.dr[k] = (s.dr[k] || 0) + SPECIALS[k];
  else if (k === 'railgun') s.rg = true;
  else if (k === 'rapid') s.overT = Math.max(s.overT, 5);
  else if (k === 'shield') s.sh = s.maxSh;
  else if (k === 'damage') s.dmgT = 4.7;
  else if (k === 'health') { const h = Math.min(s.maxHp - s.hp, 45); s.hp += h; s.healing += h; }
  else if (k === 'nova') s.novas = Math.min(9, s.novas + 1);
  room.events.push({ type: 'pickup', id: s.id, k });
}
function damagePlayer(room, s, dmg) {
  if (!s.alive || dmg <= 0) return;
  if (process.env.DEBUG_GOD || (s.dr && s.dr.voidcloak > 0)) return;
  dmg *= easeMul(room);
  s.shRegenCD = 3;
  if (s.hexT > 0 && s.hexHP > 0) { const a = Math.min(s.hexHP, dmg); s.hexHP -= a; dmg -= a; if (s.hexHP <= 0) s.hexT = 0; }
  const toSh = Math.min(s.sh, dmg); s.sh -= toSh; dmg -= toSh;
  s.hp -= dmg;
  if (s.hp <= 0) { s.hp = 0; s.alive = false; s.deathTime = room.time; }
}
function killEnemy(room, e, killer) {
  room.score += e.pts;
  rollDrops(room, e);
  if (killer && killer.dr && killer.dr.lifesteal > 0) killer.hp = Math.min(killer.maxHp, killer.hp + 12);
  if (killer) { killer.kills++; killer.score += e.pts; if (e.isBoss) killer.bosses++; }
  room.events.push({ type: 'kill', x: r2(e.x), z: r2(e.z), col: e.kind === 'boss' || e.kind === 'dether' ? 0xffaa00 : 0xff2244 });
  if (e.splits) for (let i = 0; i < 2; i++) {
    const hp = Math.max(20, Math.floor(e.maxHp * 0.35));
    room.enemies.push({ id: room.nextId++, kind: e.kind, idx: e.idx, x: e.x + rnd(-1, 1), z: e.z + rnd(-1, 1), hp, maxHp: hp, spd: e.spd * 1.2, atk: e.atk, ranged: false, pts: Math.floor(e.pts * 0.2), sz: e.sz * 0.7, flash: 0, cd: 1, hitCD: 0, bars: 0, totalBars: 0, splits: false, isBoss: false });
  }
  if (e.isBoss) { room.bossAlive = false; room.bossesKilled++; }
}
function hurtEnemy(room, e, dmg, owner) {
  if (e.hp <= 0) return;
  e.hp -= dmg; e.flash = 0.08;
  if (owner) owner.damage += Math.min(dmg, Math.max(0, e.hp + dmg));
  if (e.hp <= 0) {
    if (e.totalBars && e.bars > 1) { e.bars--; e.hp = e.maxHp; room.events.push({ type: 'kill', x: r2(e.x), z: r2(e.z), col: 0xffdd00 }); return; }
    e.dead = true; killEnemy(room, e, owner);
  }
}
function nearestAlive(room, x, z) {
  let best = null, bd = Infinity;
  for (const s of room.seats.values()) {
    if (!s.alive) continue;
    const d = (s.x - x) ** 2 + (s.z - z) ** 2; if (d < bd) { bd = d; best = s; }
  }
  return best;
}
function nearestEnemy(room, x, z, range = 40) {
  let best = null, bd = range * range;
  for (const e of room.enemies) { const d = (e.x - x) ** 2 + (e.z - z) ** 2; if (d < bd) { bd = d; best = e; } }
  return best;
}
function shootBullet(room, s, ang, dmg, source = 'player', ox = s.x, oz = s.z) {
  const speed = source === 'satellite' ? 36 : 43;
  if (source === 'player') {
    if (s.dmgT > 0) dmg *= 2;
    if (s.dr && s.dr.multishot > 0 && !_inMS) { _inMS = true; for (const o of [-0.28, -0.14, 0.14, 0.28]) shootBullet(room, s, ang + o, dmg, 'player', ox, oz); _inMS = false; }
  }
  room.bullets.push({ id: room.nextId++, x: ox, z: oz, vx: Math.sin(ang) * speed, vz: Math.cos(ang) * speed, dmg, owner: s.id, life: 1.6, source, pierce: !!(source === 'player' && s.dr && s.dr.overdrive > 0) });
}

function tickRoom(room, dt) {
  room.time += dt;
  const seats = [...room.seats.values()], alive = seats.filter(s => s.alive);
  const scale = playerScale(room);

  // players
  for (const s of seats) {
    if (!s.alive) continue;
    const inp = s.input, len = Math.hypot(inp.x, inp.z) || 1;
    let speed = (s.speedT > 0 ? 6.75 : 5) * (inp.boost ? 1.75 : 1); if (s.dashT > 0) speed *= 3.2;
    s.x = clamp(s.x + (inp.x / Math.max(1, len)) * speed * dt, -BOUND, BOUND);
    s.z = clamp(s.z + (inp.z / Math.max(1, len)) * speed * dt, -BOUND, BOUND);
    s.a = inp.a;
    for (const k of ['satT', 'hexT', 'overT', 'speedT', 'bulletT', 'dashT', 'dmgT']) if (s[k] > 0) s[k] = Math.max(0, s[k] - dt);
    if (s.dr) for (const k in s.dr) { s.dr[k] -= dt; if (s.dr[k] <= 0) delete s.dr[k]; }
    for (const k of ['satCD', 'hexCD', 'overCD', 'repairCD', 'pulseCD', 'dashCD']) if (s[k] > 0) s[k] = Math.max(0, s[k] - dt);
    if (s.satT === 0 && s.satCD === 0 && s._satRan) { s._satRan = false; }
    // shield regen
    if (s.shRegenCD > 0) s.shRegenCD -= dt; else if (s.sh < s.maxSh) s.sh = Math.min(s.maxSh, s.sh + 6 * dt);
    // reload / fire
    if (s.reload > 0) { s.reload -= dt; if (s.reload <= 0) { s.reload = 0; s.ammo = 30; } }
    if (s.shootCD > 0) s.shootCD -= dt;
    if (inp.fire && s.reload === 0 && s.ammo > 0 && s.shootCD <= 0) {
      const rapid = s.overT > 0 || s.bulletT > 0;
      s.shootCD = rapid ? 0.07 : Math.max(0.09, 0.21 - Math.floor(s.kills / 8) * 0.008);
      s.ammo--;
      const dmg = 22 * (1 + (s.loadout.firepower - 1) * 0.25) * (s.bulletT > 0 ? 1.5 : 1) * (s.overT > 0 ? 1.4 : 1);
      shootBullet(room, s, inp.a, dmg);
      const lvl = 1 + Math.floor(s.kills / 8);
      if (lvl >= 5 || s.bulletT > 0) { shootBullet(room, s, inp.a + 0.16, dmg * 0.7); shootBullet(room, s, inp.a - 0.16, dmg * 0.7); }
      if (s.ammo <= 0) s.reload = 1.5;
    }
    // satellites
    if (s.satT > 0) {
      s.satFire -= dt;
      if (s.satFire <= 0) {
        s.satFire = 0.55;
        const n = ALLY_COUNTS[s.loadout.skill] || 0;
        for (let i = 0; i < n; i++) {
          const ang = i * Math.PI * 2 / n + room.time * 0.24, ox = s.x + Math.cos(ang) * 2.7, oz = s.z + Math.sin(ang) * 2.7;
          const t = nearestEnemy(room, ox, oz, 30); if (t) shootBullet(room, s, Math.atan2(t.x - ox, t.z - oz), 14, 'satellite', ox, oz);
        }
      }
    }
  }

  room.twS = seats.some(s => s.alive && s.dr && s.dr.timewarp > 0) ? 0.4 : 1;
  if (room.drops && room.drops.length) {
    for (const d of room.drops) {
      d.life -= dt; if (d.life <= 0) continue;
      for (const s of seats) { const orb = d.k === 'orb' || d.k === 'orbbig'; if (s.alive && (s.x - d.x) ** 2 + (s.z - d.z) ** 2 < (orb ? 1.96 : 1.7)) { if (orb) { s.orbPts = (s.orbPts || 0) + Math.max(1, Math.floor(d.v / 5)); room.events.push({ type: 'pickup', id: s.id, k: 'orb' }); } else applyDrop(room, s, d.k); d.life = 0; break; } }
    }
    room.drops = room.drops.filter(d => d.life > 0);
  }
  // friendly bullets
  for (const b of room.bullets) {
    const px = b.x, pz = b.z;
    b.x += b.vx * dt; b.z += b.vz * dt; b.life -= dt;
    if (Math.abs(b.x) > ARENA + 2 || Math.abs(b.z) > ARENA + 2) b.life = 0;
    if (b.life <= 0) continue;
    const sx = b.x - px, sz = b.z - pz, sl = sx * sx + sz * sz || 1e-9;
    let hit = null, ht = 2;
    for (const e of room.enemies) {          // swept test: closest point on this tick's path to the enemy
      if (e.dead || (b.hit && b.hit.has(e.id))) continue;
      let t = ((e.x - px) * sx + (e.z - pz) * sz) / sl; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = px + sx * t - e.x, cz = pz + sz * t - e.z, r = e.sz + 0.45;
      if (cx * cx + cz * cz < r * r) {
        if (b.pierce) { (b.hit ||= new Set()).add(e.id); hurtEnemy(room, e, b.dmg, room.seats.get(b.owner)); }
        else if (t < ht) { ht = t; hit = e; }
      }
    }
    if (hit) { hurtEnemy(room, hit, b.dmg, room.seats.get(b.owner)); b.life = 0; }
  }
  room.bullets = room.bullets.filter(b => b.life > 0);

  // enemies
  for (const e of room.enemies) {
    if (e.dead) continue;
    if (e.flash > 0) e.flash -= dt;
    const target = nearestAlive(room, e.x, e.z);
    if (!target) continue;
    const dx = target.x - e.x, dz = target.z - e.z, dist = Math.hypot(dx, dz) || 1;
    const keep = e.isBoss ? 10 : e.ranged ? 11 : 0;
    const dir = dist > keep ? 1 : dist < keep - 3 ? -0.6 : 0;
    const spd = e.spd * (e.isBoss ? 1 : 1.1) * (room.twS || 1) * (e.isBoss ? 1 : 0.75 + 0.25 * easeMul(room));
    e.x = clamp(e.x + (dx / dist) * spd * dir * dt, -ARENA, ARENA); e.z = clamp(e.z + (dz / dist) * spd * dir * dt, -ARENA, ARENA);
    if (e.hitCD > 0) e.hitCD -= dt;
    if (!e.ranged || e.isBoss) {
      for (const s of alive) {
        if (!s.alive) continue;
        if ((s.x - e.x) ** 2 + (s.z - e.z) ** 2 < (e.sz + 0.8) ** 2 && e.hitCD <= 0) { damagePlayer(room, s, e.atk * (e.isBoss ? 0.4 : 0.45)); e.hitCD = 0.7; }
      }
    }
    if (e.ranged || e.isBoss) {
      e.cd -= dt;
      if (e.isBoss) {
        e.burstCD -= dt;
        if (e.burstCD <= 0) {
          e.burstCD = e.totalBars ? 2.2 : 3;
          const n = 8 + e.rings * 2, off = Math.random() * Math.PI * 2;
          for (let i = 0; i < n && room.enemyBullets.length < 120; i++) {
            const a = off + i * Math.PI * 2 / n; room.enemyBullets.push({ id: room.nextId++, x: e.x, z: e.z, vx: Math.sin(a) * 10, vz: Math.cos(a) * 10, dmg: 10 + room.wave * 0.4, life: 4 });
          }
        }
      }
      if (e.cd <= 0) {
        e.cd = e.isBoss ? 1.4 : rnd(1.6, 2.6);
        const a = Math.atan2(dx, dz); if (room.enemyBullets.length < 120) room.enemyBullets.push({ id: room.nextId++, x: e.x, z: e.z, vx: Math.sin(a) * 12, vz: Math.cos(a) * 12, dmg: Math.max(5, e.atk * 0.4), life: 4 });
      }
    }
  }
  room.enemies = room.enemies.filter(e => !e.dead);

  // hostile bullets
  for (const b of room.enemyBullets) {
    b.x += b.vx * dt; b.z += b.vz * dt; b.life -= dt;
    if (Math.abs(b.x) > ARENA + 2 || Math.abs(b.z) > ARENA + 2) b.life = 0;
    if (b.life <= 0) continue;
    for (const s of alive) if (s.alive && (s.x - b.x) ** 2 + (s.z - b.z) ** 2 < 0.8) { damagePlayer(room, s, b.dmg); b.life = 0; break; }
  }
  room.enemyBullets = room.enemyBullets.filter(b => b.life > 0);

  // wave spawning / progression
  room.waveT += dt; room.spawnT -= dt;
  if (room.spawnQueue > 0 && room.spawnT <= 0 && room.enemies.length < 60 * scale) {
    room.spawnT = Math.max(0.25, 0.9 - room.wave * 0.01);
    const burst = Math.min(room.spawnQueue, 1 + Math.floor(room.wave / 10)); for (let i = 0; i < burst; i++) spawnEnemy(room); room.spawnQueue -= burst;
  }
  const waveDone = room.spawnQueue === 0 && room.enemies.length === 0;
  if (room.wave < room.blockEnd) {
    if (waveDone || room.waveT > 35) { room.wave++; startWave(room); }
  } else if (!room.bossAlive && waveDone && room.bossesKilled > 0) {
    room.victory = true; endRound(room);
  }
  if (!seats.some(s => s.participant && s.alive)) endRound(room);

  if (room.events.length) { broadcast(room, { type: 'events', events: room.events.splice(0, 40) }); }
}

function endRound(room) {
  if (room.phase !== 'playing') return;
  room.phase = 'ended';
  const parts = [...room.seats.values()].filter(s => s.participant);
  const teamDamage = parts.reduce((t, s) => t + s.damage, 0) || 1;
  for (const s of parts) {
    const p = players.get(s.id); if (!p) continue;
    const personalScore = Math.floor(s.score + room.score * 0.1 * (s.damage / teamDamage));
    const points = Math.floor(personalScore / 10) + (room.victory ? room.blockEnd * 10 : 0) + (s.orbPts || 0);
    const survival = Math.floor(s.deathTime ?? room.time);
    const receipt = {
      id: `${room.roundId}:${s.id}`, roundId: room.roundId, points, uses: s.uses.slice(), personalScore, wave: room.wave, survival, victory: room.victory,
      stats: { kills: s.kills, bosses: s.bosses, detherDefeats: 0, detherSupremeDefeats: 0, detherGeneralDefeats: 0 },
      missionStats: { version: 1, eligible: true, contributors: parts.length, victory: room.victory, survived: s.alive, fullSquad: parts.length === MAX_SEATS, damage: Math.floor(s.damage), healing: Math.floor(s.healing), kills: s.kills, bosses: s.bosses },
    };
    p.receipts.push(receipt); if (p.receipts.length > 40) p.receipts.shift();
    send(p, { type: 'rewards', receipts: [receipt] });
  }
  if (room.victory) room.nextWave = room.blockEnd + 1;
  for (const s of room.seats.values()) { s.ready = false; }
  room.dirty = true;
}

// ── actions ─────────────────────────────────────────────────────────────
function handleAction(room, s, key) {
  if (room.phase !== 'playing' || !s.alive) return;
  const L = s.loadout;
  switch (key) {
    case 'reload': if (s.reload === 0 && s.ammo < 30) s.reload = 1.5; break;
    case 'speed': case 'bullet': useBoost(room, s, key); break;
    case 'satellite': if (L.skill > 0 && s.satT === 0 && s.satCD === 0) { s.satT = 10; s.satCD = 25; s.satFire = 0; } break;
    case 'hex': if (L.aegisLevel > 0 && s.hexT === 0 && s.hexCD === 0) { s.hexT = 8; s.hexHP = 80 + L.aegisLevel * 40; s.hexCD = 25; } break;
    case 'overclock': if (L.overclockLevel > 0 && s.overT === 0 && s.overCD === 0) { s.overT = 6 + L.overclockLevel; s.overCD = 30; } break;
    case 'repair': if (L.repairLevel > 0 && s.repairCD === 0) {
      const heal = s.maxHp * (0.25 + 0.1 * L.repairLevel); const before = s.hp; s.hp = Math.min(s.maxHp, s.hp + heal); s.healing += s.hp - before; s.repairCD = 30;
      for (const o of room.seats.values()) if (o !== s && o.alive && (o.x - s.x) ** 2 + (o.z - s.z) ** 2 < 100) { const b = o.hp; o.hp = Math.min(o.maxHp, o.hp + heal * 0.5); s.healing += o.hp - b; }
    } break;
    case 'nova': if (s.novas > 0) { s.novas--; for (const e of room.enemies) if ((e.x - s.x) ** 2 + (e.z - s.z) ** 2 < 196) hurtEnemy(room, e, e.isBoss ? 250 : 220, s); room.enemyBullets = []; } break;
    case 'pulse': if (s.pulseCD === 0) { s.pulseCD = 12; for (const e of room.enemies) { const dx = e.x - s.x, dz = e.z - s.z, d = Math.hypot(dx, dz) || 1; if (d < 9) { e.x = clamp(e.x + dx / d * 4, -ARENA, ARENA); e.z = clamp(e.z + dz / d * 4, -ARENA, ARENA); hurtEnemy(room, e, 40, s); } } room.enemyBullets = room.enemyBullets.filter(b => (b.x - s.x) ** 2 + (b.z - s.z) ** 2 > 81); } break;
    case 'railgun': if (s.rg && s.alive) { s.rg = false; const dx = Math.sin(s.a), dz = Math.cos(s.a); for (const e of [...room.enemies]) { const tx = e.x - s.x, tz = e.z - s.z; if (tx * dx + tz * dz < 0) continue; if (Math.abs(tx * dz - tz * dx) < 2.5 + e.sz * 0.5) hurtEnemy(room, e, 330, s); } } break;
    case 'dash': if (s.dashCD === 0) { s.dashT = 0.15; s.dashCD = 2.8; } break;
    default: break; // railgun and unknown keys are ignored
  }
}

// ── HTTP + WebSocket ────────────────────────────────────────────────────
function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ALLOWED_ORIGINS.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
const ipHits = new Map();
function rateLimited(ip) {
  const now = Date.now(), h = (ipHits.get(ip) || []).filter(t => now - t < 60000); h.push(now); ipHits.set(ip, h); return h.length > 60;
}
const server = http.createServer((req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, build: 'r9-mobile', rooms: rooms.size, players: players.size })); }
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const ip = req.socket.remoteAddress || '';
    if (rateLimited(ip)) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Too many requests. Wait a minute.' })); }
    let body = ''; req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      let data = {}; try { data = JSON.parse(body || '{}'); } catch { /* empty body */ }
      const p = createSession(data || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: p.token, player: { id: p.id, name: p.name }, receipts: p.receipts }));
    });
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && fs.existsSync(GAME_FILE)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(GAME_FILE).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
setInterval(() => { for (const c of wss.clients) { if (c.isAlive === false) { c.terminate(); continue; } c.isAlive = false; try { c.ping(); } catch {} } }, 25000);
wss.on('connection', ws => {
  try { ws._socket.setNoDelay(true); } catch {}
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  let me = null, msgs = 0, windowStart = Date.now();
  const authTimer = setTimeout(() => { if (!me) ws.close(4008, 'Authentication timed out'); }, 8000);
  ws.on('message', raw => {
    const now = Date.now(); if (now - windowStart > 1000) { windowStart = now; msgs = 0; }
    if (++msgs > 60) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    if (!me) {
      if (m.type !== 'hello') return;
      const p = sessions.get(String(m.token));
      if (!p) return ws.close(4003, 'Session expired. Reload the game.');
      clearTimeout(authTimer);
      if (p.ws && p.ws !== ws && p.ws.readyState === 1) p.ws.close(4001, 'Connected elsewhere');
      p.ws = ws; me = p;
      const room = rooms.get(p.room);
      if (room) { const seat = room.seats.get(p.id); if (seat) { seat.connected = true; seat.reserved = false; room.dirty = true; } }
      return send(p, { type: 'hello', receipts: p.receipts });
    }
    const room = rooms.get(me.room), seat = room?.seats.get(me.id);
    switch (m.type) {
      case 'create': { if (room) leaveRoom(me, false); joinRoom(me, createRoom()); break; }
      case 'join': {
        const code = String(m.room || '').toUpperCase();
        if (!/^[A-F0-9]{16}$/.test(code)) return send(me, { type: 'error', message: 'That squad code is not valid.' });
        const target = rooms.get(code);
        if (!target) return send(me, { type: 'error', message: 'That squad is no longer available.' });
        if (room && room !== target) leaveRoom(me, false);
        joinRoom(me, target); break;
      }
      case 'leave': if (room) leaveRoom(me); else send(me, { type: 'left' }); break;
      case 'ready': if (seat && room.phase !== 'playing') { seat.ready = !!m.ready; seat.loadout = sanitizeLoadout(m.loadout); room.dirty = true; } break;
      case 'start': if (room && seat && room.host === me.id && room.phase !== 'playing') startRound(room); break;
      case 'input': if (seat) { seat.input = { x: clamp(Math.round(num(m.x)), -1, 1), z: clamp(Math.round(num(m.z)), -1, 1), a: num(m.a), fire: !!m.fire, boost: !!m.boost }; } break;
      case 'action': if (room && seat && typeof m.key === 'string') handleAction(room, seat, m.key.slice(0, 20)); break;
      default: break;
    }
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!me || me.ws !== ws) return;
    me.ws = null;
    const room = rooms.get(me.room), seat = room?.seats.get(me.id);
    if (!seat) return;
    seat.connected = false; seat.input = { x: 0, z: 0, a: seat.a, fire: false }; room.dirty = true;
    if (room.phase === 'playing' && seat.participant) { seat.reserved = true; seat.reserveUntil = Date.now() + RECONNECT_GRACE_MS; }
    else if (room.phase !== 'playing') leaveRoom(me, false);
    if (room.host === me.id) room.host = connectedSeats(room)[0]?.id || room.host;
    if (!connectedSeats(room).length) room.emptySince = Date.now();
  });
  ws.on('error', () => {});
});

// ── main loop ───────────────────────────────────────────────────────────
let last = Date.now(), slow = 0;
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
  for (const room of rooms.values()) {
    for (const s of room.seats.values()) {
      if (s.reserved && now > s.reserveUntil) { s.reserved = false; s.alive = false; if (s.deathTime == null) s.deathTime = room.time; if (!s.connected) { const p = players.get(s.id); if (p?.room === room.id) p.room = null; room.seats.delete(s.id); if (room.host === s.id) room.host = connectedSeats(room)[0]?.id || null; } room.dirty = true; }
    }
    if (room.phase === 'playing') { tickRoom(room, dt); broadcast(room, snapshot(room)); }
    else if (room.dirty) { broadcast(room, snapshot(room)); room.dirty = false; }
    if (!connectedSeats(room).length && !room.seats.size || (room.emptySince && now - room.emptySince > EMPTY_ROOM_MS && !connectedSeats(room).length)) rooms.delete(room.id);
  }
  // housekeeping
  if (++slow % 600 === 0) { for (const [ip, h] of ipHits) if (!h.length || now - h[h.length - 1] > 60000) ipHits.delete(ip); }
}, TICK * 1000);

server.listen(PORT, () => console.log(`Void Striker 2 co-op server listening on :${PORT}` + (fs.existsSync(GAME_FILE) ? ` (serving ${GAME_FILE})` : '')));

// Generated from the game's own tables so the server and client agree on enemy stats.
const ETYPES = [
  // ── Tier 1: wave 1+ ──────────────────────────────────────────
  {name:'Drone',    col:0xff2244,em:0xff0022,hp:55,  spd:2.6,sz:0.65,pts:100, atk:8,  ranged:false, tier:1},
  {name:'Tank',     col:0xff6600,em:0xee4400,hp:180, spd:1.5,sz:1.25,pts:260, atk:16, ranged:false, tier:1},
  {name:'Ghost',    col:0xcc00ff,em:0xaa00ee,hp:95,  spd:3.6,sz:0.52,pts:190, atk:11, ranged:false, tier:1},
  {name:'Sentry',   col:0x00dd88,em:0x00bb66,hp:130, spd:0.7,sz:0.95,pts:220, atk:0,  ranged:true,  tier:1},
  {name:'Striker',  col:0xff0066,em:0xff0044,hp:75,  spd:4.6,sz:0.55,pts:150, atk:22, ranged:false, tier:1},
  // ── Tier 2: wave 8+ (new shapes) ─────────────────────────────
  {name:'Orbiter',  col:0x00ccff,em:0x0088cc,hp:110, spd:2.2,sz:0.70,pts:280, atk:12, ranged:true,  tier:2, geo:'torus'},
  {name:'Crusher',  col:0xff8800,em:0xff5500,hp:240, spd:1.8,sz:1.10,pts:340, atk:20, ranged:false, tier:2, geo:'dodec'},
  {name:'Specter',  col:0xaa44ff,em:0x8800ff,hp:85,  spd:5.2,sz:0.48,pts:240, atk:14, ranged:false, tier:2, geo:'knot'},
  {name:'Splitter', col:0x00ff44,em:0x00cc22,hp:200, spd:1.6,sz:1.00,pts:320, atk:14, ranged:false, tier:2, geo:'dodec', splits:true},
  // ── Tier 3: wave 16+ (harder shapes) ─────────────────────────
  {name:'Pulsar',   col:0xff44aa,em:0xff0088,hp:160, spd:1.4,sz:0.85,pts:420, atk:0,  ranged:true,  tier:3, geo:'torus'},
  {name:'Colossus', col:0x44ffaa,em:0x00dd88,hp:380, spd:1.0,sz:1.55,pts:560, atk:28, ranged:false, tier:3, geo:'dodec'},
  {name:'Warp',     col:0xffdd00,em:0xffaa00,hp:120, spd:6.0,sz:0.44,pts:360, atk:18, ranged:false, tier:3, geo:'knot'},
  // ── Tier 4: wave 28+ (elite-tier regulars) ───────────────────
  {name:'Reaver',   col:0xff1144,em:0xff0033,hp:290, spd:2.8,sz:0.90,pts:700, atk:30, ranged:true,  tier:4, geo:'torus'},
  {name:'Goliath',  col:0x8888ff,em:0x5555ff,hp:520, spd:0.9,sz:1.65,pts:900, atk:35, ranged:false, tier:4, geo:'dodec'},
];
const ELITES = [
  {name:'ALPHA REAPER', col:0xffdd00,em:0xffaa00,hp:320,spd:3.2,sz:0.85,pts:800,  atk:18,ranged:false,badge:'👁 ELITE',       glow:0xffdd00,geo:null},
  {name:'PHANTOM',      col:0x00ffcc,em:0x00ddaa,hp:180,spd:5.5,sz:0.55,pts:650,  atk:14,ranged:false,badge:'👻 PHANTOM',     glow:0x00ffcc,geo:null},
  {name:'WARLORD',      col:0xff4488,em:0xff2266,hp:500,spd:1.2,sz:1.6, pts:1200, atk:25,ranged:true, badge:'💀 WARLORD',     glow:0xff4488,geo:null},
  {name:'OBLITERATOR',  col:0x88ffff,em:0x44dddd,hp:260,spd:2.0,sz:1.0, pts:900,  atk:0, ranged:true, badge:'⚡ OBLITERATOR', glow:0x88ffff,geo:null},
  {name:'VOIDSPINNER',  col:0xff00ff,em:0xcc00cc,hp:300,spd:2.8,sz:0.90,pts:1050, atk:16,ranged:true, badge:'🌀 VOIDSPINNER', glow:0xff00ff,geo:'torus'},
  {name:'HEXLORD',      col:0x44ffff,em:0x00cccc,hp:440,spd:1.5,sz:1.20,pts:1400, atk:22,ranged:false,badge:'🔷 HEXLORD',     glow:0x44ffff,geo:'dodec'},
  {name:'KNIGHTMARE',   col:0xffaa00,em:0xff7700,hp:210,spd:5.0,sz:0.62,pts:950,  atk:20,ranged:false,badge:'⚔ KNIGHTMARE',  glow:0xffaa00,geo:'knot'},
  {name:'BEHEMOTH',     col:0xff3300,em:0xff1100,hp:800,spd:0.8,sz:2.00,pts:2000, atk:40,ranged:false,badge:'🔥 BEHEMOTH',    glow:0xff3300,geo:'dodec'},
  {name:'HIVE LORD',    col:0x00ff44,em:0x00cc22,hp:450,spd:1.8,sz:1.30,pts:1600, atk:18,ranged:false,badge:'🪲 HIVE LORD',    glow:0x00ff44,geo:'dodec',splits:true},
];
const BTYPES = [
  // ── Cycle 1: Waves 5–125 (Boss 1–25) ─────────────────────
  {name:'VOID HERALD',     col:0xff2244,em:0xff0022,hp:900,  spd:1.3, sz:2.0,pts:1000, rings:3,geo:'ico', ringTilt:[0.22,0.38,0.18]},
  {name:'IRON TYRANT',     col:0xff6600,em:0xee3300,hp:1400, spd:0.9, sz:2.6,pts:2000, rings:3,geo:'cube',ringTilt:[0.28,0.20,0.40]},
  {name:'VOID REAPER',     col:0xff0000,em:0xff0000,hp:1900, spd:1.1, sz:2.4,pts:3000, rings:4,geo:'ico', ringTilt:[0.22,0.35,0.15,0.45]},
  {name:'PLASMA WRAITH',   col:0x00ccff,em:0x0088cc,hp:2400, spd:1.6, sz:1.8,pts:4000, rings:3,geo:'oct', ringTilt:[0.30,0.18,0.42]},
  {name:'TITAN PRIME',     col:0xff4400,em:0xff2200,hp:3000, spd:0.85,sz:3.0,pts:5000, rings:4,geo:'cube',ringTilt:[0.25,0.40,0.20,0.35]},
  {name:'NEXUS WARDEN',    col:0xaa00ff,em:0x8800ff,hp:3600, spd:1.4, sz:1.9,pts:6000, rings:4,geo:'ico', ringTilt:[0.32,0.18,0.44,0.28]},
  {name:'STELLAR DREAD',   col:0x00ff88,em:0x00cc66,hp:4400, spd:1.2, sz:2.2,pts:7000, rings:5,geo:'oct', ringTilt:[0.20,0.38,0.15,0.42,0.26]},
  {name:'OMEGA CRUSHER',   col:0xffdd00,em:0xffaa00,hp:5200, spd:0.95,sz:3.2,pts:7500, rings:4,geo:'cube',ringTilt:[0.30,0.22,0.48,0.16]},
  {name:'ABYSS SOVEREIGN', col:0x8800ff,em:0x6600cc,hp:6200, spd:1.5, sz:2.1,pts:8500, rings:5,geo:'ico', ringTilt:[0.26,0.40,0.18,0.44,0.30]},
  {name:'ENTROPY ENGINE',  col:0xff0088,em:0xcc0066,hp:7500, spd:1.3, sz:2.8,pts:10000,rings:5,geo:'cube',ringTilt:[0.22,0.36,0.48,0.16,0.38]},
  {name:'ZERO HERALD',     col:0xffffff,em:0xaaddff,hp:9000, spd:1.6, sz:2.0,pts:11000,rings:6,geo:'oct', ringTilt:[0.20,0.34,0.48,0.14,0.40,0.28]},
  {name:'VOID SOVEREIGN',  col:0xff2200,em:0xff1100,hp:11000,spd:1.8, sz:3.4,pts:12000,rings:6,geo:'ico', ringTilt:[0.24,0.38,0.16,0.44,0.28,0.36]},
  {name:'DARK HERALD',     col:0x440088,em:0x220066,hp:12500,spd:1.4, sz:2.3,pts:13000,rings:4,geo:'oct', ringTilt:[0.18,0.42,0.28,0.36]},
  {name:'PULSE TYRANT',    col:0x00ffdd,em:0x00ccaa,hp:14000,spd:1.0, sz:3.0,pts:14000,rings:5,geo:'cube',ringTilt:[0.26,0.42,0.16,0.38,0.24]},
  {name:'NOVA WARDEN',     col:0xffaa00,em:0xff8800,hp:15800,spd:1.7, sz:2.1,pts:15000,rings:5,geo:'ico', ringTilt:[0.30,0.18,0.44,0.22,0.40]},
  {name:'SHARD PRIME',     col:0x88ffff,em:0x44dddd,hp:17500,spd:1.2, sz:2.6,pts:16000,rings:6,geo:'oct', ringTilt:[0.22,0.38,0.14,0.46,0.30,0.18]},
  {name:'VORTEX CRUSHER',  col:0xff44aa,em:0xcc2288,hp:19500,spd:1.5, sz:2.9,pts:17000,rings:5,geo:'cube',ringTilt:[0.28,0.44,0.18,0.36,0.24]},
  {name:'ECLIPSE SOVEREIGN',col:0x220044,em:0x440088,hp:22000,spd:1.3, sz:3.2,pts:18000,rings:6,geo:'ico', ringTilt:[0.20,0.36,0.48,0.16,0.42,0.28]},
  {name:'RIFT ENGINE',     col:0x00ff44,em:0x00dd22,hp:24500,spd:1.9, sz:2.0,pts:19000,rings:4,geo:'oct', ringTilt:[0.24,0.40,0.16,0.34]},
  {name:'CHAOS TYRANT',    col:0xff8800,em:0xff6600,hp:27000,spd:1.1, sz:3.5,pts:20000,rings:6,geo:'cube',ringTilt:[0.30,0.20,0.44,0.14,0.38,0.26]},
  {name:'OBLIVION HERALD', col:0x6600cc,em:0x4400aa,hp:30000,spd:1.6, sz:2.4,pts:21000,rings:5,geo:'ico', ringTilt:[0.22,0.40,0.18,0.44,0.30]},
  {name:'TITAN OMEGA',     col:0xff2200,em:0xff1100,hp:33500,spd:1.0, sz:3.8,pts:22000,rings:6,geo:'cube',ringTilt:[0.28,0.16,0.42,0.24,0.38,0.20]},
  {name:'ZERO SOVEREIGN',  col:0xaaffff,em:0x88dddd,hp:37000,spd:2.0, sz:2.2,pts:23000,rings:5,geo:'oct', ringTilt:[0.20,0.38,0.16,0.44,0.28]},
  {name:'NEXUS PRIME',     col:0xff00cc,em:0xcc0099,hp:41000,spd:1.4, sz:3.0,pts:24000,rings:6,geo:'ico', ringTilt:[0.24,0.42,0.18,0.36,0.28,0.46]},
  {name:'THE VOID ABSOLUTE',col:0x000000,em:0xff0000,hp:46000,spd:2.2, sz:4.0,pts:25000,rings:6,geo:'cube',ringTilt:[0.30,0.18,0.44,0.22,0.40,0.14]},
];
const DETHER_DEF={25:{name:'DETHER',bars:3,bgHex:'#1a1200',bossCol:0xffdd00,bossEm:0xffaa00,sz:4.4,spd:1.5,hp:20000,pts:50000},50:{name:'DETHER SUPREME',bars:5,bgHex:'#1a0800',bossCol:0xff6600,bossEm:0xff3300,sz:5.0,spd:1.7,hp:36000,pts:100000},75:{name:'DETHER GENERAL',bars:7,bgHex:'#1a0000',bossCol:0xff1100,bossEm:0xff0000,sz:5.6,spd:2.0,hp:58000,pts:200000},0:{name:'DETHER GENERAL',bars:7,bgHex:'#1a0000',bossCol:0xff1100,bossEm:0xff0000,sz:5.6,spd:2.0,hp:58000,pts:200000}};
module.exports={ETYPES,ELITES,BTYPES,DETHER_DEF};

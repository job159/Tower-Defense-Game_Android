// Versus maps: mirror-symmetric 22 x 9 battlefields; every match is played on one picked at random.
//
// A definition describes the LEFT lane only (columns 0-10, rows 0-8; the seam to the opponent's half runs
// between columns 10 and 11): `lane` is the ground route (axis-aligned waypoints, gate first, core last;
// [c, r, 'w'] = the segment ending there is a warp tunnel), `air` the flyers' free-form route, and voids /
// decor / nodes as in levels.js. versusLevel() mirrors everything into the right lane, so both players
// always defend exactly the same layout. `glow` tints the light under the platform (the map's identity
// colour); lanes stay cyan (yours) and magenta (the opponent's) on every map.
//
// Fairness rules all maps follow (compare them with `node tools/versus-sim.mjs --map all`): a ground route
// of 25-32 tiles (the original 雙子要塞 is 28; a tunnel's hidden stretch doesn't count), an air route about
// 0.42-0.48 of that, 56-68 buildable tiles within reach of the lane, 1-3 power nodes per half, the lane stays
// in its own half and runs along the seam for at most 2 tiles, and the core sits 6+ columns from the seam.
export const VS_COLS = 22, VS_ROWS = 9, VS_HALF = VS_COLS / 2;

const flip = (c) => VS_COLS - 1 - c;
const mirror = (wp) => wp.map(([c, r, f]) => (f ? [flip(c), r, f] : [flip(c), r]));
const mirrorTiles = (list) => [...list, ...list.map(([c, r, x]) => (x === undefined ? [flip(c), r] : [flip(c), r, x]))];

export const VS_MAP_DEFS = [
  { // the original map: a Z through three long rows
    id: 900, name: '雙子要塞', en: 'TWIN BASTION', desc: '經典 Z 字路線，攻守均衡', glow: 0x5a2cff,
    lane: [[10, 0], [10, 1], [2, 1], [2, 4], [8, 4], [8, 7], [1, 7]],
    air: [[10, 0], [6, 3], [3, 5], [1, 7]],
    voids: [[0, 0], [0, 8]], decor: [[4, 8]], nodes: [[6, 2], [5, 6]],
  },
  { // vertical serpentine: three long columns, the strips between them see two of them
    id: 901, name: '長蛇峽谷', en: 'SERPENT CANYON', desc: '三道長直路，夾在中間的砲塔火力加倍', glow: 0xff7a2a,
    lane: [[9, 8], [9, 1], [6, 1], [6, 7], [3, 7], [3, 1], [1, 1]],
    air: [[9, 8], [6.5, 5], [3.5, 3], [1, 1]],
    voids: [[0, 7], [0, 8], [10, 0]], decor: [[8, 0], [4, 8]], nodes: [[7, 4], [4, 4]],
  },
  { // spiral into a core in the middle of the half: the eye is the killzone
    id: 902, name: '漩渦之眼', en: 'VORTEX EYE', desc: '路線螺旋繞向中央的核心', glow: 0x1ad8ff,
    lane: [[8, 0], [8, 7], [2, 7], [2, 2], [6, 2], [6, 5], [4, 5], [4, 4]],
    air: [[8, 0], [9.1, 3.4], [7, 6.1], [4, 4]],
    voids: [[0, 0], [0, 8]], decor: [[10, 1], [0, 4]], nodes: [[5, 3], [7, 5]],
  },
  { // the gates stand back to back on the seam: packs burst out of the middle and loop round the heart
    id: 903, name: '次元裂隙', en: 'RIFT GATE', desc: '敵軍從中央裂隙湧出，繞過中心直撲核心', glow: 0xff2fd0,
    lane: [[10, 4], [8, 4], [8, 7], [4, 7], [4, 4], [6, 4], [6, 1], [1, 1], [1, 6]],
    air: [[10, 4], [7, 2.5], [3.5, 3], [1, 6]],
    voids: [[0, 8], [10, 0]], decor: [[0, 0], [10, 8]], nodes: [[7, 4], [2, 3]],
  },
  { // the lane loops over itself: towers by the crossing hit four arms
    id: 904, name: '交叉火網', en: 'CROSSFIRE', desc: '路線交叉而過，十字路口是火力焦點', glow: 0xff3d4a,
    lane: [[4, 0], [4, 6], [9, 6], [9, 2], [1, 2], [1, 6]],
    air: [[4, 0], [7, 2.6], [5.5, 5.5], [1, 6]],
    voids: [[10, 0], [0, 0], [0, 8]], decor: [[6, 4], [3, 4]], nodes: [[3, 1], [7, 7]],
  },
  { // a warp tunnel dives under the lane and surfaces behind it
    id: 905, name: '量子躍遷', en: 'QUANTUM LEAP', desc: '敵人潛入量子隧道，從另一端冒出——在出口埋伏', glow: 0x7a5cff,
    lane: [[9, 0], [9, 6], [3, 6], [3, 8], [7, 8], [7, 4, 'w'], [4, 4], [4, 0], [0, 0]],
    air: [[9, 0], [7, 3], [3, 3.2], [0, 0]],
    voids: [[0, 8], [10, 0]], decor: [], nodes: [[6, 5], [6, 3]],
  },
  { // a chasm splits the platform; the lane hugs both rims and crosses on a narrow bridge
    id: 906, name: '斷崖天橋', en: 'SKY BRIDGE', desc: '斷崖橫貫全場，只靠天橋相連——懸空的石柱是要地', glow: 0x2f6bff,
    lane: [[9, 0], [9, 1], [6, 1], [6, 3], [1, 3], [1, 5], [8, 5], [8, 7], [2, 7]],
    air: [[9, 0], [6, 2.2], [3.6, 4.2], [4.4, 6.4], [2, 7]],
    voids: [[0, 4], [2, 4], [3, 4], [4, 4], [6, 4], [8, 4], [9, 4], [10, 4]], decor: [], nodes: [[5, 4], [7, 4]],
  },
  { // tight hairpins climb the seam side, then a long run sweeps round to the core
    id: 907, name: '盤山險道', en: 'SWITCHBACK', desc: '連續髮夾彎，彎道之間是黃金砲位', glow: 0x3dff8a,
    lane: [[9, 8], [9, 7], [6, 7], [6, 5], [9, 5], [9, 3], [6, 3], [6, 1], [2, 1], [2, 7]],
    air: [[9, 8], [7.4, 5.4], [4, 3.6], [2, 7]],
    voids: [[0, 0], [10, 0], [0, 8]], decor: [], nodes: [[7, 4], [4, 4]],
  },
  { // broken ground: holes everywhere, so the good spots are few
    id: 908, name: '碎星荒原', en: 'SHATTERED FIELD', desc: '地面支離破碎，能蓋砲塔的位置有限', glow: 0xb04dff,
    lane: [[9, 0], [9, 3], [6, 3], [6, 1], [3, 1], [3, 5], [7, 5], [7, 7], [1, 7]],
    air: [[9, 0], [7, 2.4], [4.4, 3.6], [2.4, 5.6], [1, 7]],
    voids: [[0, 0], [0, 1], [1, 4], [5, 3], [9, 5], [10, 6], [4, 8], [5, 8], [0, 8], [8, 1]], decor: [], nodes: [[7, 2], [4, 6]],
  },
  { // the gate stands at a pit in the middle: the lane rings the arena from the inside out
    id: 909, name: '虛空湧泉', en: 'VOID SPRING', desc: '敵人從場中央的深淵爬出，沿外圈繞向核心', glow: 0x9a2cff,
    lane: [[6, 3], [6, 1], [9, 1], [9, 7], [3, 7], [3, 2], [1, 2], [1, 7]],
    air: [[6, 3], [8, 2.6], [7.4, 5.8], [4.2, 5.4], [1, 7]],
    voids: [[5, 4], [6, 4], [7, 4]], decor: [], nodes: [[7, 3], [2, 5], [4, 4]],
  },
  { // a circuit-board trace with nine bends and three power nodes
    id: 910, name: '能量矩陣', en: 'POWER GRID', desc: '九道彎與三座能量節點，善用節點以少擋多', glow: 0xffc93d,
    lane: [[0, 5], [5, 5], [5, 8], [9, 8], [9, 4], [7, 4], [7, 1], [4, 1], [4, 3], [1, 3], [1, 1]],
    air: [[0, 5], [3.2, 6.2], [6, 4.2], [3.4, 2.2], [1, 1]],
    voids: [[10, 0], [0, 8]], decor: [[6, 4], [7, 6], [5, 3]], nodes: [[2, 2], [3, 6], [8, 3]],
  },
  { // out to the seam and back: a big hook that ends in one long straight
    id: 911, name: '迴旋鏢', en: 'BOOMERANG', desc: '繞到最遠處再折返，最後的長直道是決戰點', glow: 0x7fe8ff,
    lane: [[3, 8], [3, 4], [6, 4], [6, 7], [9, 7], [9, 1], [1, 1], [1, 3]],
    air: [[3, 8], [5.2, 5.6], [6.8, 3], [3.6, 2.6], [1, 3]],
    voids: [[0, 8], [10, 0]], decor: [], nodes: [[5, 2], [8, 5]],
  },
];

// Full level object for a map; `base` supplies the shared versus rules (credits, waves, abilities, pool...).
export function versusLevel(def, base = {}) {
  return {
    ...base,
    id: def.id, name: def.name, en: def.en, desc: def.desc, glow: def.glow,
    cols: VS_COLS, rows: VS_ROWS, versus: true, half: VS_HALF,
    paths: [def.lane, mirror(def.lane)],
    airPaths: [def.air, mirror(def.air)],
    voids: mirrorTiles(def.voids || []), decor: mirrorTiles(def.decor || []), nodes: mirrorTiles(def.nodes || []),
  };
}

export const VS_MAP_IDS = VS_MAP_DEFS.map((d) => d.id);

// Deterministic map for a match seed: the fallback when an online 'start' message names no known map.
export function mapIdForSeed(seed) {
  const n = Math.abs(Math.floor(Number(seed) || 0));
  return VS_MAP_IDS[n % VS_MAP_IDS.length];
}

// The map named in an online 'start' message { seed, map }; a missing or unknown id falls back to the seed's.
export function mapIdFromStart(data) {
  const id = Number(data && data.map);
  return VS_MAP_IDS.includes(id) ? id : mapIdForSeed(data && data.seed);
}

// A random map that avoids the most recently played ones (`recent`: ids, newest last).
export function pickMapId(recent = [], rand = Math.random) {
  const skip = new Set((recent || []).slice(-Math.min(4, VS_MAP_IDS.length - 1)));
  const pool = VS_MAP_IDS.filter((id) => !skip.has(id));
  return pool[Math.floor(rand() * pool.length)] ?? VS_MAP_IDS[0];
}

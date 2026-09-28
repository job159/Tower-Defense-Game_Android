// Game balance data: damage model, towers, enemies, abilities, research. Pure data — no rendering code.
// Distances are in tiles, times in seconds, rates in attacks per second.

// ---------------------------------------------------------------- damage model
export const DAMAGE_TYPES = {
  kinetic:   { name: '動能', color: '#9fdcff' },
  explosive: { name: '爆炸', color: '#ff9a3d' },
  energy:    { name: '能量', color: '#ff5fae' },
  electric:  { name: '電磁', color: '#b98bff' },
  cryo:      { name: '冷凍', color: '#8fe8ff' },
  thermal:   { name: '熱能', color: '#ff6a2a' },
};
export const DAMAGE_ORDER = ['kinetic', 'explosive', 'energy', 'electric', 'cryo', 'thermal'];

// Damage multipliers by armor class. Flat armor (per hit) is separate and only on some units.
export const ARMOR_CLASSES = {
  light:      { name: '輕型', desc: '怕爆炸與熱能', mul: { kinetic: 1.0, explosive: 1.2, energy: 1.0, electric: 1.0, cryo: 1.0, thermal: 1.35 } },
  heavy:      { name: '重裝', desc: '抗動能與熱能，怕能量', mul: { kinetic: 0.6, explosive: 1.0, energy: 1.35, electric: 0.8, cryo: 0.8, thermal: 0.7 } },
  reflective: { name: '反射', desc: '反射能量與電磁，怕動能', mul: { kinetic: 1.3, explosive: 1.1, energy: 0.3, electric: 0.55, cryo: 1.0, thermal: 1.0 } },
  aerial:     { name: '飛行', desc: '只有對空砲塔能攻擊', mul: { kinetic: 1.0, explosive: 0.85, energy: 1.15, electric: 1.15, cryo: 1.0, thermal: 0.6 } },
  fortified:  { name: '堡壘', desc: '首領級：大幅抵抗所有動能與控制', mul: { kinetic: 0.55, explosive: 0.8, energy: 1.2, electric: 0.9, cryo: 0.6, thermal: 0.6 } },
};
// Multipliers against energy shields (the shield layer absorbs damage first).
export const SHIELD_MUL = { kinetic: 1.0, explosive: 0.8, energy: 0.7, electric: 2.0, cryo: 0.5, thermal: 0.5 };

export const THERMAL_SHOCK = { pct: 0.08, bossPct: 0.02, cap: 600, cooldown: 1.5 };
export const FROZEN_BONUS = 0.4;
export const BURN = { time: 3, maxStacks: 3 };

// ---------------------------------------------------------------- towers
export const TOWER_ORDER = ['pulse', 'mortar', 'cryo', 'tesla', 'laser', 'inferno', 'sam', 'sensor', 'amp', 'carrier', 'mines'];
// Campaign level at which each tower becomes available.
export const UNLOCK_AT = { pulse: 1, mortar: 1, cryo: 1, tesla: 2, laser: 3, inferno: 3, sam: 4, sensor: 4, amp: 5, carrier: 5, mines: 6 };
export const LOADOUT_SIZE = 6;

// Each tower: 3 levels, then specialization a|b (level 4) and its ultimate (level 5, needs research).
// attack kinds: bullet | rail | shell | frost | aura | tesla | beam | missile | flame | napalm | drones | sensor | mines | support
export const TOWERS = {
  pulse: {
    name: '脈衝砲', en: 'PULSE CANNON', color: 0x22c8ff, role: '速射', roleDesc: '便宜的速射砲，對地對空都能打', cost: 100, type: 'kinetic',
    desc: '高射速動能彈，對地對空皆可。便宜可靠的前期主力。',
    air: true, ground: true, attack: 'bullet', projSpeed: 15,
    levels: [
      { damage: 11, rate: 2.4, range: 2.6 },
      { cost: 75, damage: 19, rate: 2.7, range: 2.8 },
      { cost: 135, damage: 31, rate: 3.0, range: 3.0 },
    ],
    specs: {
      a: { name: '加特林', en: 'GATLING', cost: 250, damage: 20, rate: 9.5, range: 3.0,
        desc: '超高射速彈幕，對輕型單位極強；重裝甲會削弱每一發。',
        ult: { name: '毀滅者', en: 'DEVASTATOR', cost: 420, damage: 24, rate: 10, range: 3.2, spinup: 1.0,
          desc: '持續開火 3 秒內射速逐步提升至 2 倍。' } },
      b: { name: '軌道炮', en: 'RAILGUN', cost: 290, damage: 230, rate: 0.7, range: 4.6, attack: 'rail', armorPierce: true, pierceResist: true, pierce: true,
        desc: '超長射程電磁貫穿彈：無視裝甲與抗性，穿透直線上所有敵人。',
        ult: { name: '磁軌超載', en: 'OVERCHARGE', cost: 480, damage: 300, rate: 0.75, range: 5.0, overcharge: 4,
          desc: '每第 4 發為超載彈：3 倍傷害並癱瘓 1 秒。' } },
    },
  },
  mortar: {
    name: '電漿迫擊砲', en: 'PLASMA MORTAR', color: 0xff8c1a, role: '範圍轟炸', roleDesc: '大範圍爆炸清群，只能打地面', cost: 150, type: 'explosive',
    desc: '拋射電漿彈造成範圍爆炸。只能攻擊地面，範圍攻擊可暴露隱形單位。',
    air: false, ground: true, attack: 'shell', minRange: 0.9,
    levels: [
      { damage: 42, rate: 0.55, range: 3.4, splash: 1.0 },
      { cost: 115, damage: 64, rate: 0.6, range: 3.6, splash: 1.1 },
      { cost: 170, damage: 100, rate: 0.65, range: 3.8, splash: 1.2 },
    ],
    specs: {
      a: { name: '集束彈', en: 'CLUSTER', cost: 300, damage: 125, rate: 0.65, range: 3.9, splash: 1.2, cluster: 6, clusterDamage: 42,
        desc: '落地後再散射 6 枚子彈，覆蓋大片區域。',
        ult: { name: '連環爆', en: 'CHAIN CLUSTER', cost: 450, damage: 160, rate: 0.7, range: 4.0, splash: 1.3, cluster: 10, clusterDamage: 60,
          desc: '散射 10 枚子彈，地毯式轟炸。' } },
      b: { name: '奇點砲', en: 'SINGULARITY', cost: 330, damage: 150, rate: 0.5, range: 3.9, splash: 1.3, well: { time: 2.6, radius: 1.4, slow: 0.75, dps: 45, pull: 0 },
        desc: '製造重力奇點，困住並持續撕裂範圍內的敵人。',
        ult: { name: '事件視界', en: 'EVENT HORIZON', cost: 500, damage: 200, rate: 0.5, range: 4.1, splash: 1.4, well: { time: 3.2, radius: 1.6, slow: 0.85, dps: 90, pull: 0.7 },
          desc: '奇點會把敵人往回拉，強制延長它們的路程。' } },
    },
  },
  cryo: {
    name: '冷凍發射器', en: 'CRYO EMITTER', color: 0xdff5ff, role: '減速控場', roleDesc: '減速、冰凍敵人，替其他砲塔創造輸出時間', cost: 120, type: 'cryo',
    desc: '冰晶使敵人減速。與熱能攻擊交錯會觸發「熱衝擊」爆發傷害。',
    air: true, ground: true, attack: 'frost', projSpeed: 11,
    levels: [
      { damage: 8, rate: 1.4, range: 2.4, slow: 0.3, slowTime: 1.6 },
      { cost: 90, damage: 13, rate: 1.5, range: 2.6, slow: 0.4, slowTime: 1.8 },
      { cost: 140, damage: 20, rate: 1.6, range: 2.8, slow: 0.5, slowTime: 2.0, splash: 0.8 },
    ],
    specs: {
      a: { name: '絕對零度', en: 'ABSOLUTE ZERO', cost: 260, damage: 32, rate: 1.6, range: 2.9, slow: 0.55, slowTime: 2.2, splash: 0.9, freeze: 0.14, freezeTime: 1.3,
        desc: '機率完全凍結敵人；凍結中的敵人受到的傷害 +40%。',
        ult: { name: '碎冰風暴', en: 'SHATTER STORM', cost: 420, damage: 44, rate: 1.7, range: 3.1, slow: 0.6, slowTime: 2.4, splash: 1.0, freeze: 0.2, freezeTime: 1.5, shatter: 0.35,
          desc: '被冰凍的敵人死亡時碎裂，對周圍造成其最大生命 35% 的冰爆。' } },
      b: { name: '寒霜力場', en: 'FROST FIELD', cost: 280, damage: 18, rate: 4, range: 2.6, attack: 'aura', slow: 0.45, slowTime: 0.6, vuln: 0.22,
        desc: '持續冰凍力場：範圍內敵人減速，且受到的所有傷害 +22%。',
        ult: { name: '絕對寒域', en: 'DEEP FREEZE', cost: 440, damage: 30, rate: 4, range: 3.0, attack: 'aura', slow: 0.55, slowTime: 0.6, vuln: 0.3, noHeal: true,
          desc: '力場內敵人無法治療、再生或恢復護盾；易傷提升至 30%。' } },
    },
  },
  tesla: {
    name: '特斯拉線圈', en: 'TESLA COIL', color: 0xa65cff, role: '連鎖破盾', roleDesc: '閃電在敵群間連鎖跳躍，對護盾加倍', cost: 175, type: 'electric',
    desc: '連鎖閃電在敵人間跳躍。電磁傷害對護盾加倍。',
    air: true, ground: true, attack: 'tesla', chainRange: 1.7,
    levels: [
      { damage: 28, rate: 0.85, range: 2.5, chain: 3, falloff: 0.8 },
      { cost: 130, damage: 42, rate: 0.9, range: 2.6, chain: 4, falloff: 0.8 },
      { cost: 190, damage: 60, rate: 0.95, range: 2.8, chain: 5, falloff: 0.82 },
    ],
    specs: {
      a: { name: '風暴核心', en: 'STORM CORE', cost: 330, damage: 74, rate: 1.2, range: 3.0, chain: 9, falloff: 0.88,
        desc: '閃電可跳躍 9 個目標，專門清除密集敵群。',
        ult: { name: '雷暴', en: 'THUNDERSTORM', cost: 480, damage: 90, rate: 1.3, range: 3.2, chain: 10, falloff: 0.9, storm: 4,
          desc: '每第 4 次放電化為雷暴，以 150% 傷害打擊範圍內所有敵人。' } },
      b: { name: 'EMP 過載', en: 'EMP OVERLOAD', cost: 330, damage: 96, rate: 1.0, range: 3.0, chain: 4, falloff: 0.85, shieldMul: 2, stun: 0.6, emp: 4,
        desc: '癱瘓目標並關閉護盾再生；對護盾傷害 4 倍。',
        ult: { name: '電磁脈衝場', en: 'EMP FIELD', cost: 480, damage: 130, rate: 1.05, range: 3.2, chain: 5, falloff: 0.85, shieldMul: 3, stun: 0.8, emp: 999,
          desc: '被擊中的護盾永久失效；對護盾傷害 6 倍。' } },
    },
  },
  laser: {
    name: '聚焦雷射', en: 'FOCUS LASER', color: 0xff2da0, role: '破甲殺手', roleDesc: '光束鎖定越久越痛，專打重甲與首領', cost: 210, type: 'energy',
    desc: '持續光束，鎖定越久傷害越高。能量傷害熔穿重裝甲，但會被反射單位彈開。',
    air: true, ground: true, attack: 'beam',
    levels: [
      { dpsMin: 24, dpsMax: 120, ramp: 2.5, range: 2.8 },
      { cost: 160, dpsMin: 36, dpsMax: 180, ramp: 2.5, range: 2.9 },
      { cost: 230, dpsMin: 52, dpsMax: 270, ramp: 2.5, range: 3.0 },
    ],
    specs: {
      a: { name: '稜鏡分光', en: 'PRISM SPLIT', cost: 380, dpsMin: 44, dpsMax: 220, ramp: 2.2, range: 3.1, beams: 3,
        desc: '光束一分為三，同時鎖定三個目標。',
        ult: { name: '稜鏡矩陣', en: 'PRISM MATRIX', cost: 560, dpsMin: 60, dpsMax: 300, ramp: 2.0, range: 3.3, beams: 5,
          desc: '五道光束同時鎖定。' } },
      b: { name: '殲滅光束', en: 'ANNIHILATOR', cost: 420, dpsMin: 80, dpsMax: 720, ramp: 3.5, range: 3.3,
        desc: '極限聚能，鎖定後傷害飆升至驚人數值。首領剋星。',
        ult: { name: '貫穿光束', en: 'PIERCING LANCE', cost: 620, dpsMin: 110, dpsMax: 950, ramp: 3.5, range: 3.6, lance: 0.4,
          desc: '光束貫穿直線上所有敵人（40% 傷害）。' } },
    },
  },
  inferno: {
    name: '焚化者', en: 'INFERNO', color: 0xff2e2e, role: '近距燃燒', roleDesc: '短距離火焰與燃燒疊加，阻止再生', cost: 140, type: 'thermal',
    desc: '短距離扇形火焰，點燃敵人造成持續燃燒（可疊 3 層，燃燒中無法再生）。只能攻擊地面。',
    air: false, ground: true, attack: 'flame',
    levels: [
      { dps: 26, range: 1.9, cone: 60, burn: 10 },
      { cost: 100, dps: 42, range: 2.0, cone: 60, burn: 15 },
      { cost: 150, dps: 64, range: 2.1, cone: 70, burn: 22 },
    ],
    specs: {
      a: { name: '等離子噴流', en: 'PLASMA JET', cost: 280, dps: 130, range: 2.7, cone: 36, burn: 30, armorPierce: true,
        desc: '高溫窄束噴流，射程更遠並無視護甲。',
        ult: { name: '太陽噴焰', en: 'SOLAR FLARE', cost: 450, dps: 230, range: 3.0, cone: 40, burn: 45, armorPierce: true, spread: 1.2,
          desc: '燃燒中的敵人死亡時會點燃周圍 1.2 格內的敵人。' } },
      b: { name: '燃燒彈', en: 'NAPALM', cost: 260, attack: 'napalm', damage: 50, rate: 0.6, range: 3.3, splash: 0.9, pool: { time: 4, radius: 0.9, dps: 45, slow: 0 },
        desc: '拋射燃燒彈，在路徑上留下持續燃燒的火海。',
        ult: { name: '煉獄場', en: 'INFERNO FIELD', cost: 420, attack: 'napalm', damage: 80, rate: 0.65, range: 3.6, splash: 1.1, pool: { time: 7, radius: 1.2, dps: 85, slow: 0.3 },
          desc: '火海更大、持續更久，並使敵人減速 30%。' } },
    },
  },
  sam: {
    name: '追蹤飛彈', en: 'SAM LAUNCHER', color: 0xffd83d, role: '防空專精', roleDesc: '超遠程追蹤飛彈，專門擊落飛行單位', cost: 160, type: 'explosive',
    desc: '長射程追蹤飛彈，防空專精：優先攻擊空中目標並造成 2.2 倍傷害；對地傷害減半。',
    air: true, ground: true, attack: 'missile', airMul: 2.2, groundMul: 0.5, preferAir: true,
    levels: [
      { damage: 44, rate: 0.9, range: 4.0, splash: 0.6, missiles: 1 },
      { cost: 120, damage: 66, rate: 0.9, range: 4.2, splash: 0.6, missiles: 2 },
      { cost: 180, damage: 96, rate: 0.95, range: 4.4, splash: 0.7, missiles: 2 },
    ],
    specs: {
      a: { name: '蜂群飛彈', en: 'SWARM', cost: 320, damage: 36, rate: 0.9, range: 4.6, splash: 0.6, missiles: 6,
        desc: '每輪齊射 6 枚微型飛彈，自動分散鎖定。',
        ult: { name: '分裂彈頭', en: 'MIRV', cost: 460, damage: 44, rate: 0.9, range: 4.8, splash: 0.6, missiles: 6, mirv: 3,
          desc: '每枚飛彈命中後再分裂為 3 枚子飛彈。' } },
      b: { name: '重型彈頭', en: 'HEAVY WARHEAD', cost: 340, damage: 470, rate: 0.55, range: 4.8, splash: 1.3, missiles: 1,
        desc: '巨型彈頭，大範圍毀滅性爆炸。',
        ult: { name: '戰術核彈', en: 'TACTICAL NUKE', cost: 520, damage: 560, rate: 0.55, range: 5.0, splash: 1.4, missiles: 1, nuke: 5,
          desc: '每第 5 發為核彈：3 倍傷害、超大範圍，並留下輻射區。' } },
    },
  },
  sensor: {
    name: '感測陣列', en: 'SENSOR ARRAY', color: 0x9dff3d, role: '偵測標記', roleDesc: '揭露隱形單位並標記敵人承受更多傷害', cost: 130, type: 'energy',
    desc: '偵測範圍內的隱形單位，並定期標記敵人使其受到更多傷害。',
    air: true, ground: true, attack: 'sensor',
    levels: [
      { range: 3.2, mark: 0.15, marks: 3 },
      { cost: 90, range: 3.6, mark: 0.2, marks: 4 },
      { cost: 140, range: 4.0, mark: 0.25, marks: 5 },
    ],
    specs: {
      a: { name: '標定雷達', en: 'TARGET PAINTER', cost: 240, range: 4.2, mark: 0.35, marks: 99,
        desc: '標記範圍內所有敵人，受到傷害 +35%。',
        ult: { name: '獵殺指令', en: 'KILL ORDER', cost: 380, range: 4.6, mark: 0.45, marks: 99, shred: 0.5,
          desc: '被標記的敵人護甲減半，受到傷害 +45%。' } },
      b: { name: '干擾站', en: 'JAMMER', cost: 260, range: 3.8, mark: 0.15, marks: 3, jam: 0.2,
        desc: '範圍內敵人減速 20%，且無法使用技能（治療、瞬移、召喚、EMP、隱形）。',
        ult: { name: '全頻干擾', en: 'FULL SPECTRUM', cost: 400, range: 4.8, mark: 0.2, marks: 4, jam: 0.3, noShield: true,
          desc: '干擾範圍擴大，減速 30%，範圍內護盾無法恢復。' } },
    },
  },
  amp: {
    name: '增幅信標', en: 'AMPLIFIER', color: 0x3dff7a, role: '增幅支援', roleDesc: '不攻擊，強化周圍砲塔的傷害與射程', cost: 190, type: 'energy',
    desc: '強化周圍 8 格內砲塔的傷害與射程（不可疊加，取最強者）。',
    air: false, ground: false, attack: 'support',
    levels: [
      { range: 1.5, buffDamage: 0.15, buffRange: 0.08 },
      { cost: 140, range: 1.5, buffDamage: 0.2, buffRange: 0.1 },
      { cost: 200, range: 1.5, buffDamage: 0.25, buffRange: 0.12 },
    ],
    specs: {
      a: { name: '超頻陣列', en: 'OVERDRIVE', cost: 300, range: 1.5, buffDamage: 0.35, buffRange: 0.12, buffRate: 0.2,
        desc: '強化傷害 +35% 並提升射速 +20%。',
        ult: { name: '超載核心', en: 'OVERLOAD CORE', cost: 440, range: 1.5, buffDamage: 0.5, buffRange: 0.15, buffRate: 0.3,
          desc: '強化傷害 +50%、射速 +30%。' } },
      b: { name: '資源回收站', en: 'SALVAGE', cost: 280, range: 1.5, buffDamage: 0.25, buffRange: 0.12, income: 45, salvage: 0.5, salvageRange: 3,
        desc: '每波額外 +45 資金；3 格內擊殺的敵人賞金 +50%。',
        ult: { name: '量子精煉', en: 'QUANTUM REFINERY', cost: 420, range: 1.5, buffDamage: 0.3, buffRange: 0.12, income: 90, salvage: 0.75, salvageRange: 3.5, interest: 0.02,
          desc: '每波 +90 資金、賞金 +75%，利息率 +2%。' } },
    },
  },
  carrier: {
    name: '無人機母艦', en: 'DRONE CARRIER', color: 0x5a78ff, role: '廣域無人機', roleDesc: '無人機在大範圍內自主追擊', cost: 180, type: 'kinetic',
    desc: '派出無人機在大範圍內自主追擊敵人，對地對空皆可。',
    air: true, ground: true, attack: 'drones',
    levels: [
      { drones: 2, damage: 8, rate: 3, range: 3.5, kind: 'drone' },
      { cost: 130, drones: 3, damage: 10, rate: 3, range: 3.5, kind: 'drone' },
      { cost: 190, drones: 4, damage: 13, rate: 3, range: 3.8, kind: 'drone' },
    ],
    specs: {
      a: { name: '蜂群艦', en: 'SWARM BAY', cost: 320, drones: 7, damage: 11, rate: 3.5, range: 4.0, kind: 'swarm',
        desc: '7 架蜂群無人機，數量壓制。',
        ult: { name: '奈米蜂群', en: 'NANO SWARM', cost: 460, drones: 10, damage: 14, rate: 3.5, range: 4.2, kind: 'swarm', droneMark: 0.15,
          desc: '10 架無人機，命中時標記敵人（受到傷害 +15%）。' } },
      b: { name: '砲艇', en: 'GUNSHIP', cost: 340, drones: 2, damage: 55, rate: 1.2, range: 4.2, kind: 'gunship', splash: 0.6, dtype: 'explosive',
        desc: '2 艘重裝砲艇，發射爆炸火箭。',
        ult: { name: '空中堡壘', en: 'SKY FORTRESS', cost: 480, drones: 3, damage: 80, rate: 1.3, range: 4.6, kind: 'gunship', splash: 0.8, dtype: 'explosive', preferAir: true,
          desc: '3 艘砲艇，優先攻擊空中目標。' } },
    },
  },
  mines: {
    name: '地雷佈設器', en: 'MINE LAYER', color: 0x2dffd0, role: '路面陷阱', roleDesc: '在路徑上佈雷，地面敵人踩到即爆', cost: 150, type: 'explosive',
    desc: '在射程內的路徑上佈設地雷，地面敵人踩到即爆炸。',
    air: false, ground: true, attack: 'mines',
    levels: [
      { damage: 90, splash: 0.8, rate: 0.4, max: 6, range: 2.4, kind: 'std' },
      { cost: 110, damage: 140, splash: 0.8, rate: 0.4, max: 8, range: 2.5, kind: 'std' },
      { cost: 160, damage: 200, splash: 0.9, rate: 0.5, max: 10, range: 2.6, kind: 'std' },
    ],
    specs: {
      a: { name: 'EMP 地雷', en: 'EMP MINES', cost: 260, damage: 180, splash: 0.9, rate: 0.5, max: 10, range: 2.7, kind: 'emp', dtype: 'electric', stun: 1.2, shieldMul: 2,
        desc: '電磁地雷：癱瘓 1.2 秒並重創護盾。',
        ult: { name: '連鎖雷網', en: 'CHAIN GRID', cost: 380, damage: 240, splash: 1.0, rate: 0.55, max: 12, range: 2.9, kind: 'emp', dtype: 'electric', stun: 1.5, shieldMul: 2, chainMines: 1.5,
          desc: '引爆時連鎖引爆 1.5 格內的其他地雷。' } },
      b: { name: '集束地雷', en: 'CLUSTER MINES', cost: 280, damage: 320, splash: 1.2, rate: 0.45, max: 12, range: 2.7, kind: 'cluster',
        desc: '高威力大範圍地雷。',
        ult: { name: '震撼彈', en: 'SEISMIC CHARGES', cost: 420, damage: 480, splash: 1.4, rate: 0.5, max: 12, range: 2.9, kind: 'cluster', knockback: 0.8,
          desc: '爆炸將敵人震退 0.8 格。' } },
    },
  },
};

export const TARGET_MODES = ['first', 'last', 'strong', 'close'];
export const TARGET_LABEL = { first: '最前', last: '最後', strong: '最強', close: '最近' };

// Veterancy: rank thresholds in (damage dealt / credits invested); bonus per rank.
export const VETERANCY = { thresholds: [12, 40, 100], damage: 0.08, range: 0.04 };
export const POWER_NODE = { damage: 0.2, range: 0.12 };

// ---------------------------------------------------------------- enemies
// cls = armor class; hp/speed are wave-1 baselines (hp scales with wave). threat = wave-budget cost; dmg = lives lost on leak.
export const ENEMIES = {
  scout:    { name: '偵察無人機', cls: 'light', hp: 26, speed: 2.1, armor: 0, reward: 3, dmg: 1, threat: 1, interval: 0.45, radius: 0.22,
    desc: '速度極快的輕型無人機，成群出現。' },
  walker:   { name: '步行機甲', cls: 'light', hp: 62, speed: 1.25, armor: 1, reward: 5, dmg: 1, threat: 2, interval: 0.8, radius: 0.28,
    desc: '標準步兵機甲，具有輕微裝甲。' },
  flyer:    { name: '攻擊艇', cls: 'aerial', hp: 58, speed: 1.5, armor: 0, reward: 6, dmg: 1, threat: 2.5, interval: 0.9, radius: 0.3, air: true,
    desc: '飛行單位，只有對空砲塔能攻擊；走捷徑飛越地形。' },
  shield:   { name: '護盾機', cls: 'light', hp: 64, speed: 1.1, armor: 0, reward: 8, dmg: 1, threat: 3.2, interval: 1.0, radius: 0.3, shield: 90,
    desc: '能量護盾先吸收傷害，停止受擊後再生。電磁傷害對護盾加倍。' },
  stalker:  { name: '閃現獵手', cls: 'light', hp: 80, speed: 1.35, armor: 1, reward: 7, dmg: 1, threat: 3, interval: 0.9, radius: 0.26, blink: { every: 3.2, dist: 1.6 },
    desc: '週期性向前瞬移一段距離。' },
  medic:    { name: '維修機', cls: 'light', hp: 96, speed: 1.05, armor: 1, reward: 9, dmg: 1, threat: 3.5, interval: 1.6, radius: 0.3, heal: { every: 2.5, radius: 1.6, amount: 0.12 },
    desc: '定期修復周圍友軍 12% 生命值。優先擊破！' },
  berserker: { name: '狂暴者', cls: 'light', hp: 150, speed: 1.0, armor: 1, reward: 11, dmg: 1, threat: 4.5, interval: 1.0, radius: 0.3, berserk: 1.2,
    desc: '生命越低速度越快，最高可達 2.2 倍。' },
  splitter: { name: '母巢載具', cls: 'heavy', hp: 170, speed: 0.95, armor: 2, reward: 10, dmg: 2, threat: 4.5, interval: 1.5, radius: 0.36, split: { type: 'mini', count: 3 },
    desc: '被摧毀時釋放 3 架小型無人機。' },
  mirror:   { name: '鏡面機', cls: 'reflective', hp: 120, speed: 1.15, armor: 1, reward: 10, dmg: 1, threat: 4, interval: 1.0, radius: 0.3,
    desc: '鏡面裝甲反射能量與電磁攻擊（僅受 30%/55%），怕動能。' },
  phantom:  { name: '幽影', cls: 'light', hp: 70, speed: 1.7, armor: 0, reward: 9, dmg: 1, threat: 3.5, interval: 0.8, radius: 0.26, cloak: true,
    desc: '隱形！只有被感測陣列或英雄偵測到、或被範圍攻擊暴露時才能被鎖定。' },
  tank:     { name: '重裝坦克', cls: 'heavy', hp: 240, speed: 0.75, armor: 5, reward: 14, dmg: 2, threat: 6, interval: 1.8, radius: 0.4,
    desc: '厚重裝甲削弱每次命中，並抵抗動能。用雷射、軌道炮或爆炸對付。' },
  regenerator: { name: '再生體', cls: 'heavy', hp: 210, speed: 0.9, armor: 2, reward: 13, dmg: 2, threat: 5, interval: 1.4, radius: 0.34, regen: { rate: 0.04, delay: 1.0 },
    desc: '停止受擊 1 秒後每秒回復 4% 生命。燃燒可阻止再生。' },
  disruptor: { name: '干擾者', cls: 'light', hp: 140, speed: 1.0, armor: 1, reward: 14, dmg: 1, threat: 5.5, interval: 1.6, radius: 0.3, emp: { every: 5, radius: 1.8, time: 2.5 },
    desc: '每 5 秒釋放 EMP，使周圍 1.8 格內的砲塔停擺 2.5 秒。' },
  juggernaut: { name: '主宰者', cls: 'heavy', hp: 520, speed: 0.6, armor: 8, reward: 24, dmg: 3, threat: 10, interval: 2.4, radius: 0.46, ccImmune: true,
    desc: '免疫減速、凍結與癱瘓的巨型裝甲單位。' },
  hive:     { name: '蜂巢艦', cls: 'aerial', hp: 230, speed: 1.0, armor: 1, reward: 14, dmg: 2, threat: 6, interval: 1.8, radius: 0.4, air: true, split: { type: 'swarmling', count: 4 },
    desc: '飛行載具，被擊落時釋放 4 隻蜂群機。' },
  mini:     { name: '子機', cls: 'light', hp: 16, speed: 2.3, armor: 0, reward: 1, dmg: 1, threat: 0.5, interval: 0.3, radius: 0.16, hidden: true },
  swarmling: { name: '蜂群機', cls: 'aerial', hp: 18, speed: 2.4, armor: 0, reward: 1, dmg: 1, threat: 0.6, interval: 0.3, radius: 0.16, air: true, hidden: true },
  // bosses
  colossus: { name: '巨像', cls: 'fortified', hp: 2400, speed: 0.5, armor: 8, reward: 150, dmg: 10, threat: 60, interval: 3, radius: 0.8, boss: true,
    summon: { type: 'walker', every: 6, count: 2 }, enrage: { at: 0.5, speed: 1.3, summon: { type: 'tank', every: 8, count: 1 } },
    desc: '首領：高裝甲巨型機甲，不斷召喚步行機甲；生命低於一半時狂暴並召喚坦克。' },
  mothership: { name: '母艦', cls: 'aerial', hp: 3600, speed: 0.45, armor: 4, reward: 200, dmg: 15, threat: 80, interval: 3, radius: 0.9, boss: true, air: true,
    summon: { type: 'flyer', every: 5, count: 2 }, burst: { at: 0.5, type: 'hive', count: 2 },
    desc: '首領：飛行母艦，持續釋放攻擊艇；半血時放出蜂巢艦。' },
  dreadnought: { name: '無畏戰艦', cls: 'fortified', hp: 3000, speed: 0.42, armor: 10, reward: 260, dmg: 15, threat: 90, interval: 3, radius: 0.9, boss: true,
    shield: 1600, shieldRegen: 0.06, emp: { every: 11, radius: 2.5, time: 2.5 },
    desc: '首領：巨型護盾（需電磁武器擊破）並週期性 EMP 癱瘓大片砲塔。' },
  queen:    { name: '蜂后', cls: 'aerial', hp: 3200, speed: 0.6, armor: 3, reward: 240, dmg: 15, threat: 85, interval: 3, radius: 0.85, boss: true, air: true,
    summon: { type: 'swarmling', every: 2.5, count: 3 }, cloakPulse: { at: 0.6, every: 8, time: 3 },
    desc: '首領：不斷孵出蜂群機；生命低於 60% 後會週期性隱形。' },
  omega:    { name: '終焉', cls: 'fortified', hp: 9000, speed: 0.38, armor: 12, reward: 800, dmg: 30, threat: 200, interval: 3, radius: 1.1, boss: true,
    shield: 3000, shieldRegen: 0.04, emp: { every: 10, radius: 3, time: 3 }, summon: { type: 'juggernaut', every: 12, count: 1 }, phase2: { at: 0.5, into: 'omega2' },
    desc: '最終首領：護盾、EMP、召喚主宰者；半血時升空化為飛行型態。' },
  omega2:   { name: '終焉·升天', cls: 'aerial', hp: 9000, speed: 0.6, armor: 8, reward: 0, dmg: 30, threat: 0, interval: 3, radius: 1.1, boss: true, air: true, hidden: true,
    summon: { type: 'hive', every: 7, count: 1 }, emp: { every: 7, radius: 3.2, time: 2.5 },
    desc: '終焉的第二型態：高速飛行、召喚蜂巢艦。' },
};

// ---------------------------------------------------------------- commander abilities (one tap, whole field)
export const ABILITIES = {
  // damage is multiplied by the wave's HP curve (waves.js hpScale) so it stays relevant all game
  thunder: { name: '雷霆審判', cooldown: 120, damage: 80, bossMul: 0.5, stun: 0.5,
    desc: '雷霆轟擊全場所有敵人：傷害隨波次成長、無視護甲、對護盾加倍，並短暫麻痺、暴露隱形。首領只受一半傷害。' },
  stasis:  { name: '時停力場', cooldown: 95, time: 5, slow: 0.65, bossSlow: 0.35, desc: '全場敵人大幅減速 5 秒。' },
};
export const ABILITY_ORDER = ['thunder', 'stasis'];

// ---------------------------------------------------------------- economy
export const ECONOMY = { interest: 0.03, interestCapBase: 20, interestCapPerWave: 4, refund: 0.7 };

// ---------------------------------------------------------------- research (bought with stars; costs[i] = price of level i+1)
export const RESEARCH = [
  { id: 'credits', group: 'eco', name: '啟動資金', desc: '每關起始資金 +50 / +100 / +150', costs: [1, 2, 3], values: [50, 100, 150] },
  { id: 'interest', group: 'eco', name: '複利演算', desc: '每波利息率 +1% / +2%（基礎 3%）', costs: [2, 3], values: [0.01, 0.02] },
  { id: 'bounty', group: 'eco', name: '賞金協議', desc: '擊殺賞金 +10% / +20%', costs: [2, 3], values: [0.1, 0.2] },
  { id: 'refund', group: 'eco', name: '回收效率', desc: '出售返還 80% / 90%', costs: [1, 2], values: [0.8, 0.9] },
  { id: 'discount', group: 'eco', name: '模組量產', desc: '建造與升級費用 -5% / -10%', costs: [2, 3], values: [0.05, 0.1] },
  { id: 'damage', group: 'war', name: '武器校準', desc: '全砲塔傷害 +5% / +10% / +15%', costs: [2, 3, 4], values: [0.05, 0.1, 0.15] },
  { id: 'range', group: 'war', name: '光學延伸', desc: '全砲塔射程 +5% / +10%', costs: [2, 3], values: [0.05, 0.1] },
  { id: 'veteran', group: 'war', name: '老兵訓練', desc: '砲塔累積經驗 +50% / +100%', costs: [2, 3], values: [0.5, 1.0] },
  { id: 'lives', group: 'cmd', name: '核心強化', desc: '核心耐久 +5 / +10', costs: [1, 2], values: [5, 10] },
  { id: 'cooldown', group: 'cmd', name: '冷卻迴路', desc: '技能冷卻 -15% / -30%', costs: [2, 3], values: [0.15, 0.3] },
  { id: 'thunder', group: 'cmd', name: '雷霆增幅', desc: '雷霆審判傷害 +30% / +60%', costs: [2, 3], values: [0.3, 0.6] },
  ...TOWER_ORDER.map((t) => ({ id: `ult_${t}`, group: 'ult', tower: t, name: `終極協議：${TOWERS[t].name}`, desc: `解鎖${TOWERS[t].name}的第 5 級終極型態`, costs: [3], values: [1] })),
];
export const RESEARCH_GROUPS = { eco: '經濟', war: '軍火', cmd: '指揮', ult: '終極協議' };

// ---------------------------------------------------------------- helpers
export function towerBaseStats(type, level, spec) {
  const def = TOWERS[type];
  const s = { ...def.levels[Math.min(level, 3) - 1] };
  delete s.cost;
  if (spec && level >= 4) {
    const sp = def.specs[spec];
    const src = level >= 5 ? { ...stripMeta(sp), ...stripMeta(sp.ult) } : stripMeta(sp);
    for (const k in src) s[k] = src[k];
  }
  return s;
}

function stripMeta(o) {
  const r = {};
  for (const k in o) if (k !== 'cost' && k !== 'name' && k !== 'en' && k !== 'desc' && k !== 'ult') r[k] = o[k];
  return r;
}

// Cost of the next upgrade step: level 2, 3, spec (3->4) or ultimate (4->5).
export function upgradeCost(type, level, spec) {
  const def = TOWERS[type];
  if (level < 3) return def.levels[level].cost;
  if (level === 3 && spec) return def.specs[spec].cost;
  if (level === 4 && spec) return def.specs[spec].ult.cost;
  return 0;
}

// Display info (name/en/desc) for a tower at level/spec.
export function towerInfo(type, level, spec) {
  const def = TOWERS[type];
  if (spec && level >= 5) return def.specs[spec].ult;
  if (spec && level >= 4) return def.specs[spec];
  return def;
}

export function damageType(type, stats) { return (stats && stats.dtype) || TOWERS[type].type; }

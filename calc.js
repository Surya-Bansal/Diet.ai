export const PEOPLE = [
  { id: "surya", name: "Surya" },
  { id: "sahi", name: "Sahi" },
  { id: "nonu", name: "Nonu" },
];

export function listForPerson(personId) {
  return personId === "nonu" ? "nonu" : "home";
}

export function normalizeFood(food) {
  const listId = food.listId === "nonu" ? "nonu" : "home";
  return food.listId === listId ? food : { ...food, listId };
}

export const MEALS = ["Breakfast", "Lunch", "Snack", "Dinner", "Protocol"];

export const VITAMINS = [
  ["vit_a", "A", "mcg"],
  ["vit_b1", "B1", "mg"],
  ["vit_b5", "B5", "mg"],
  ["vit_b6", "B6", "mg"],
  ["vit_b7", "B7", "mcg"],
  ["vit_b9", "B9", "mcg"],
  ["vit_b12", "B12", "mcg"],
  ["vit_c", "C", "mg"],
  ["vit_d", "D", "mcg"],
  ["vit_e", "E", "mg"],
  ["vit_k", "K", "mcg"],
];

export const MINERALS = [
  ["min_ca", "Calcium", "mg"],
  ["min_fe", "Iron", "mg"],
  ["min_zn", "Zinc", "mg"],
  ["min_mg", "Magnesium", "mg"],
  ["min_k", "Potassium", "mg"],
  ["min_i", "Iodine", "mcg"],
];

const VITAMIN_MIN = {
  vit_a: 50, vit_b1: 0.1, vit_b5: 0.5, vit_b6: 0.1, vit_b7: 3,
  vit_b9: 20, vit_b12: 0.5, vit_c: 10, vit_d: 1, vit_e: 1, vit_k: 5,
};

const MINERAL_MIN = {
  min_ca: 50, min_fe: 1, min_zn: 1, min_mg: 20, min_k: 150, min_i: 15,
};

const MICRO_ALIAS = {
  Vit_A_mcg: "vit_a", Vit_B1_mg: "vit_b1", Vit_B5_mg: "vit_b5", Vit_B6_mg: "vit_b6",
  Vit_B7_mcg: "vit_b7", Vit_B9_mcg: "vit_b9", Vit_B12_mcg: "vit_b12", Vit_C_mg: "vit_c",
  Vit_D_mcg: "vit_d", Vit_E_mg: "vit_e", Vit_K_mcg: "vit_k",
  Min_Ca_mg: "min_ca", Min_Fe_mg: "min_fe", Min_Zn_mg: "min_zn",
  Min_Mg_mg: "min_mg", Min_K_mg: "min_k", Min_I_mcg: "min_i",
};

function canonMicro(key) {
  return MICRO_ALIAS[key] || key;
}

export function defaultGoals() {
  const base = {
    kcal: 1800,
    protein: 80,
    fatMax: 60,
    carbMax: 200,
    sugarMax: 36,
    vitamins: { ...VITAMIN_MIN },
    minerals: { ...MINERAL_MIN },
  };
  return {
    surya: { ...base, kcal: 2050, protein: 130, vitamins: { ...VITAMIN_MIN }, minerals: { ...MINERAL_MIN } },
    sahi: { ...base, vitamins: { ...VITAMIN_MIN }, minerals: { ...MINERAL_MIN } },
    nonu: { ...base, vitamins: { ...VITAMIN_MIN }, minerals: { ...MINERAL_MIN } },
  };
}

export function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

export function fromLabelTotals(src) {
  const fat = Number(src.fat) || 0;
  const satKnown = src.sat !== null && src.sat !== undefined && src.sat !== "";
  const sat = satKnown ? Number(src.sat) || 0 : 0;
  const fiber = Number(src.fiber) || 0;
  const sugarKnown = src.sugar !== null && src.sugar !== undefined && src.sugar !== "";
  const sugar = sugarKnown ? Number(src.sugar) || 0 : 0;
  const carb = Number(src.carb) || 0;
  return {
    kcal: round1(src.kcal),
    protein: round1(src.protein),
    fatUnsat: round1(Math.max(0, fat - sat)),
    fatSat: round1(sat),
    fatSplit: satKnown,
    carbOther: round1(Math.max(0, carb - sugar - fiber)),
    sugar: round1(sugar),
    fiber: round1(fiber),
    sugarKnown,
  };
}

export function scaleFood(food, amount, unit) {
  const use = unit || food.unit;
  const basis = use === "count" ? 1 : Number(food.servingGrams);
  const factor = basis ? Number(amount) / basis : 0;
  const n = (v) => round1((Number(v) || 0) * factor);
  const micros = {};
  for (const [k, v] of Object.entries(food.micros || {})) {
    if (v === null || v === undefined || v === "") continue;
    const key = canonMicro(k);
    micros[key] = round1((micros[key] || 0) + Number(v) * factor);
  }
  return {
    kcal: n(food.kcal),
    protein: n(food.protein),
    fatUnsat: n(food.fatUnsat),
    fatSat: n(food.fatSat),
    fatSplit: food.fatSplit !== false,
    carbOther: n(food.carbOther),
    sugar: n(food.sugar),
    fiber: n(food.fiber),
    sugarKnown: food.sugarKnown !== false,
    micros,
    factor,
  };
}

export function fatTotal(row) {
  return (Number(row.fatUnsat) || 0) + (Number(row.fatSat) || 0);
}

export function carbTotal(row) {
  return (Number(row.carbOther) || 0) + (Number(row.sugar) || 0) + (Number(row.fiber) || 0);
}

export function sumEntries(entries) {
  const totals = {
    kcal: 0, protein: 0, fatUnsat: 0, fatSat: 0, fatUnsplit: 0,
    carbOther: 0, sugar: 0, fiber: 0, micros: {},
  };
  for (const e of entries) {
    totals.kcal += Number(e.kcal) || 0;
    totals.protein += Number(e.protein) || 0;
    totals.carbOther += Number(e.carbOther) || 0;
    totals.sugar += Number(e.sugar) || 0;
    totals.fiber += Number(e.fiber) || 0;
    if (e.fatSplit === false) totals.fatUnsplit += fatTotal(e);
    else {
      totals.fatUnsat += Number(e.fatUnsat) || 0;
      totals.fatSat += Number(e.fatSat) || 0;
    }
    for (const [k, v] of Object.entries(e.micros || {})) {
      const key = canonMicro(k);
      totals.micros[key] = (totals.micros[key] || 0) + (Number(v) || 0);
    }
  }
  for (const k of Object.keys(totals)) {
    if (k === "micros") continue;
    totals[k] = round1(totals[k]);
  }
  totals.fat = round1(totals.fatUnsat + totals.fatSat + totals.fatUnsplit);
  totals.carb = round1(totals.carbOther + totals.sugar + totals.fiber);
  return totals;
}

export function hitCount(totals, keys, minimums) {
  let n = 0;
  for (const key of keys) {
    const got = Number(totals.micros[key]) || 0;
    const min = Number(minimums?.[key]) || 0;
    if (got > min) n += 1;
  }
  return n;
}

export function foodsText(entries) {
  return entries.map((e) => {
    if (e.unit === "count") {
      const n = Number(e.amount);
      const shown = Number.isInteger(n) ? String(n) : String(round1(n));
      return `${shown}x ${e.name}`;
    }
    return `${round1(e.amount)}g ${e.name}`;
  }).join("; ");
}

export function mealGroups(entries) {
  const order = [];
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.meal)) {
      map.set(e.meal, []);
      order.push(e.meal);
    }
    map.get(e.meal).push(e);
  }
  return order.map((meal) => ({ meal, entries: map.get(meal), totals: sumEntries(map.get(meal)) }));
}

export function todayISO(d = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export function formatDate(iso) {
  const [y, m, day] = iso.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function selfTest(foods) {
  const lines = [];
  const check = (name, cond, detail) => lines.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " " + detail}`);
  const chicken = foods.find((f) => f.name.startsWith("Chicken Breast"));
  const c = scaleFood(chicken, 180, "g");
  check("chicken 180 kcal", Math.abs(c.kcal - 360) < 0.05, c.kcal);
  check("chicken protein", Math.abs(c.protein - 55.8) < 0.05, c.protein);
  check("chicken fat parts", Math.abs(fatTotal(c) - 14.4) < 0.05, fatTotal(c));
  const whey = foods.find((f) => f.name.includes("Whey"));
  const w = scaleFood(whey, 2, "count");
  check("whey 2 servings", Math.abs(w.kcal - 260) < 0.05, w.kcal);
  const chia = foods.find((f) => f.name.startsWith("Chia"));
  const ch = scaleFood(chia, 24, "g");
  check("chia 24g scales from 15g", Math.abs(ch.kcal - 70 * 24 / 15) < 0.15, ch.kcal);
  const milk = foods.find((f) => f.name.includes("2% Milk"));
  const mk = scaleFood(milk, 250, "g");
  check("milk calories", Math.abs(mk.kcal - 130) < 0.05, mk.kcal);
  check("milk carb parts sum to 13", Math.abs(carbTotal(mk) - 13) < 0.05, carbTotal(mk));
  const oj = foods.find((f) => f.name.includes("Tropicana"));
  const o = scaleFood(oj, 250, "g");
  check("juice carb parts sum to 12", Math.abs(carbTotal(o) - 12) < 0.05, carbTotal(o));
  const berries = foods.find((f) => f.name.includes("berry"));
  const b = scaleFood(berries, 80, "g");
  check("berries carb parts sum to 11", Math.abs(carbTotal(b) - 11) < 0.05, carbTotal(b));
  const split = fromLabelTotals({ kcal: 97, protein: 3.4, fat: 4.4, sat: null, carb: 10.6, sugar: 3.3, fiber: 3.5 });
  check("sambar other carbs", Math.abs(split.carbOther - 3.8) < 0.05, split.carbOther);
  check("sambar fat kept as total", split.fatSplit === false && Math.abs(fatTotal(split) - 4.4) < 0.05, fatTotal(split));
  const plate = scaleFood({ ...split, unit: "g", servingGrams: 100, micros: {} }, 350, "g");
  check("sambar 350g calories", Math.abs(plate.kcal - 339.5) < 0.2, plate.kcal);
  const totals = sumEntries([
    { ...c, fatSplit: true, micros: {} },
    { ...plate, micros: {} },
  ]);
  check("day fat adds", Math.abs(totals.fat - (14.4 + 15.4)) < 0.2, totals.fat);
  check("day carbs add", Math.abs(totals.carb - carbTotal(plate)) < 0.2, totals.carb);
  const greens = scaleFood(foods.find((f) => f.name.includes("Greens")), 1, "count");
  const gday = sumEntries([greens]);
  const mins = defaultGoals().surya;
  check("greens vitamins", hitCount(gday, VITAMINS.map(([k]) => k), mins.vitamins) === 8, hitCount(gday, VITAMINS.map(([k]) => k), mins.vitamins));
  check("greens minerals", hitCount(gday, MINERALS.map(([k]) => k), mins.minerals) === 2, hitCount(gday, MINERALS.map(([k]) => k), mins.minerals));
  const pill = scaleFood(foods.find((f) => f.name.includes("B12")), 1, "count");
  check("b12 pill counts", hitCount(sumEntries([pill]), ["vit_b12"], mins.vitamins) === 1, pill.micros.vit_b12);
  check("nonu has her own list", listForPerson("nonu") === "nonu" && listForPerson("surya") === "home" && listForPerson("sahi") === "home");
  check("sheet foods stay with Surya and Sahi", normalizeFood(foods[0]).listId === "home");
  return lines;
}

import {
  PEOPLE, MEALS, VITAMINS, MINERALS, defaultGoals, listForPerson, normalizeFood,
  scaleFood, sumEntries, hitCount, foodsText, mealGroups, orderedEntries, microValue, referenceAmount,
  todayISO, formatDate, fatTotal, carbTotal, fromLabelTotals, selfTest, round1,
  chartBurn, logChartDates, onGoal,
} from "./calc.js";
import { searchDishes, searchSaved, searchOpenFoodFacts, searchUsda } from "./search.js";
import {
  loadLocal, saveLocal, loadConfig, saveConfig, pullRemote, pushFood, pushEntry,
  removeEntryRemote, removeFoodRemote, pushDay, pushGoals, resetClient,
} from "./store.js";
import foodsSeed from "./data/foods.json" with { type: "json" };
import dishesData from "./data/dishes.json" with { type: "json" };

const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
const preview = params.has("preview");

let dishes = dishesData;
let state = null;
let mode = "local";
let syncError = "";
let ready = false;
let view = params.get("view") || "today";
let searchReturn = "add";
let scrollTarget = "";
let skipCapture = false;
let person = localStorage.getItem("diet-log-person") || "surya";
let date = todayISO();
let notice = "";
let draft = { meal: "Lunch", category: "", foodId: "", amount: "", unit: "", foodQuery: "" };
let plate = [];
let supplementChecks = null;
let lookup = { q: "", saved: [], found: [], status: "", form: null };
let editingId = "";
let editingMeal = "";
let logFrom = "";
let logTo = "";
let logRangeCustom = false;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmt(n) {
  const r = round1(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function kcal(n) {
  return Math.round(Number(n) || 0).toLocaleString("en-US");
}

function personName() {
  return PEOPLE.find((p) => p.id === person)?.name || person;
}

function goals() {
  const base = defaultGoals()[person];
  const saved = state.goals?.[person];
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    vitamins: { ...base.vitamins, ...(saved.vitamins || {}) },
    minerals: { ...base.minerals, ...(saved.minerals || {}) },
    supplements: Array.isArray(saved.supplements) ? saved.supplements : [],
    exercises: Array.isArray(saved.exercises) ? saved.exercises : [...(base.exercises || [])],
  };
}

function dayEntries() {
  return state.entries.filter((e) => e.person === person && e.date === date);
}

const KCAL_PER_STEP = 0.024;
// Net kcal per minute above rest at 63.5 kg. Strength is 5.0 MET, hiking is 6.0 MET.
const KCAL_PER_MIN = 4.4;
const HIKE_KCAL_PER_MIN = 5.6;

function kcalPerMinute(exercise) {
  const name = String(exercise || "").trim().toLowerCase();
  if (name.includes("hik")) return HIKE_KCAL_PER_MIN;
  return KCAL_PER_MIN;
}

function activityCalories(steps, minutes, exercise) {
  const raw = (Number(steps) || 0) * KCAL_PER_STEP + (Number(minutes) || 0) * kcalPerMinute(exercise);
  if (!raw) return 0;
  return round1(raw);
}

function dayMeta() {
  return state.days.find((d) => d.person === person && d.date === date) || { exercise: "", burned: 0, steps: 0, minutes: 0 };
}

function exerciseSets() {
  return (goals().exercises || []).map((name) => String(name).trim()).filter(Boolean);
}

function writeExercises(list) {
  const next = { ...goals(), exercises: list };
  state.goals[person] = next;
  persist();
  cloud(() => pushGoals(person, next));
}

function persist() {
  if (preview) return;
  saveLocal(state);
}

async function cloud(fn) {
  if (mode !== "shared" || preview) return;
  try {
    await fn();
    syncError = "";
  } catch (err) {
    syncError = err.message || String(err);
  }
}

function currentFoods() {
  const listId = listForPerson(person);
  return state.foods.filter((f) => (f.listId || "home") === listId);
}

function categories() {
  return [...new Set(currentFoods().map((f) => f.category))].sort((a, b) => a.localeCompare(b));
}

function foodsInCategory() {
  return currentFoods()
    .filter((f) => f.category === draft.category)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function selectedFood() {
  return currentFoods().find((f) => f.id === draft.foodId) || null;
}

function allowedUnit(food, unit) {
  if (!food) return unit || "g";
  if (unit === food.unit) return unit;
  if (food.unit === "count" && unit === "g" && Number(food.servingGrams) > 0) return "g";
  return food.unit || "g";
}

function selectedUnit() {
  return allowedUnit(selectedFood(), draft.unit);
}

function foodReferenceLabel(food) {
  const amount = referenceAmount(food, food.unit);
  if (food.unit === "count") return `${trimNum(amount)} count`;
  if (food.unit === "ml") return `${trimNum(amount)} ml`;
  return `${trimNum(amount)} g`;
}

function supplementTargets() {
  return (goals().supplements || [])
    .map((item) => ({ foodId: item.foodId, count: Math.max(0, Math.round(Number(item.count) || 0)) }))
    .filter((item) => item.foodId && item.count > 0);
}

function supplementChoices() {
  return currentFoods()
    .filter((food) => food.category === "Supplements")
    .sort((a, b) => a.name.localeCompare(b.name));
}

function takenServings(foodId) {
  return state.entries
    .filter((entry) => entry.person === person && entry.date === date && entry.foodId === foodId && entry.unit === "count")
    .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
}

function ensureSupplementChecks() {
  if (supplementChecks) return;
  supplementChecks = {};
  for (const target of supplementTargets()) supplementChecks[target.foodId] = takenServings(target.foodId);
}

function supplementScore() {
  let goal = 0;
  let taken = 0;
  for (const target of supplementTargets()) {
    if (!currentFoods().some((food) => food.id === target.foodId)) continue;
    goal += target.count;
    taken += takenServings(target.foodId);
  }
  return { goal, taken, pct: goal ? Math.round((taken / goal) * 100) : 0 };
}

function supplementBlock() {
  const targets = supplementTargets();
  ensureSupplementChecks();
  if (!targets.length) {
    return `<h2>Supplements</h2><p class="hint">Set the supplements and daily counts on Goals. They show up here as boxes.</p>`;
  }
  const rows = targets.map((target) => {
    const food = currentFoods().find((item) => item.id === target.foodId);
    if (!food) return "";
    const desired = Number(supplementChecks[target.foodId]) || 0;
    const boxes = Array.from({ length: target.count }, (_, index) => {
      const on = index < desired;
      return `<button type="button" class="tick ${on ? "on" : ""}" data-supp="${esc(food.id)}" data-n="${index + 1}" aria-pressed="${on ? "true" : "false"}" aria-label="${esc(food.name)} ${index + 1}">${on ? "✓" : ""}</button>`;
    }).join("");
    return `<div class="supp"><div><b>${esc(food.name)}</b><div class="hint">${fmt(desired)} of ${target.count}</div></div><div class="ticks">${boxes}</div></div>`;
  }).join("");
  return `<h2>Supplements</h2><p class="hint">Filled boxes are already logged today. Tick what you are taking now, then save. This is separate from the meal.</p><div class="card">${rows}</div><button class="btn secondary" type="button" id="save-supplements">Save supplements</button>`;
}

function writeSupplements(list) {
  const next = { ...goals(), supplements: list };
  state.goals[person] = next;
  persist();
  cloud(() => pushGoals(person, next));
}

function supplementEditor() {
  const foods = supplementChoices();
  const saved = Array.isArray(goals().supplements) ? goals().supplements : [];
  const rows = saved.filter((item) => item.foodId).map((item) => {
    const food = foods.find((entry) => entry.id === item.foodId) || state.foods.find((entry) => entry.id === item.foodId);
    return `
      <div class="supp">
        <div><b>${esc(food?.name || "Removed")}</b></div>
        <input class="mini" data-supp-count="${esc(item.foodId)}" inputmode="numeric" value="${esc(item.count)}" aria-label="Count a day">
        <button type="button" class="textbtn" data-supp-remove="${esc(item.foodId)}">Remove</button>
      </div>`;
  }).join("");
  const options = foods.map((food) => `<option value="${esc(food.id)}">${esc(food.name)}</option>`).join("");
  return `
    <h2>Supplements</h2>
    <p class="hint">Choose what you take and how many in a day. The Add page shows one box for each.</p>
    <div class="card">${rows || `<p class="hint">None yet.</p>`}
      <div class="field"><label class="label" for="supp-food">Add</label>
        <select class="select" id="supp-food"><option value="">Choose</option>${options}</select>
      </div>
      <div class="field"><label class="label" for="supp-count">Count a day</label><input class="textin" id="supp-count" inputmode="numeric" value="1"></div>
      <button class="btn secondary" type="button" id="supp-add">Add supplement</button>
    </div>`;
}

function icon(name) {
  const emoji = { today: "🧾", add: "🍽️", foods: "📕", log: "📜", goals: "🎯" };
  return `<span class="nav-emoji">${emoji[name] || ""}</span>`;
}

function nav(active) {
  const item = (id, label) => `<button type="button" data-nav="${id}" class="${active === id ? "on" : ""}">${icon(id)}${label}</button>`;
  return `<nav class="nav">${item("today", "Record")}${item("add", "Add")}${item("foods", "Menu")}${item("log", "Log")}${item("goals", "Goals")}</nav>`;
}

function banner() {
  if (!ready) return "";
  if (syncError) return `<div class="banner">Shared database error: ${esc(syncError)}. This phone is using its own copy.</div>`;
  if (mode === "local") return `<div class="banner">On this phone only. Open Goals, then Shared database, to connect Surya, Sahi, and Nonu.</div>`;
  return "";
}

function bar(value, goal, color, maxed) {
  const pct = goal ? Math.min(100, (Number(value) / Number(goal)) * 100) : 0;
  const over = maxed && goal && Number(value) > Number(goal);
  return `<div class="bar"><i style="width:${pct}%;background:${over ? "var(--over)" : color}"></i></div>`;
}

function todayView() {
  const entries = orderedEntries(dayEntries());
  const totals = sumEntries(entries);
  const g = goals();
  const meta = dayMeta();
  const groups = mealGroups(entries);
  const vit = hitCount(totals, VITAMINS.map(([k]) => k), g.vitamins);
  const min = hitCount(totals, MINERALS.map(([k]) => k), g.minerals);
  const supp = supplementScore();
  const head = groups.map((group) => `<th>${esc(group.meal)}</th>`).join("");
  const row = (label, pick) => {
    const cells = groups.map((group) => `<td>${pick(group.totals)}</td>`).join("");
    return `<tr><td>${label}</td>${cells}<td class="tot">${pick(totals)}</td></tr>`;
  };
  const matrix = entries.length ? `
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th></th>${head}<th class="tot">Total</th></tr></thead>
      <tbody>
        ${row("Calories", (t) => kcal(t.kcal))}
        ${row("Protein", (t) => `${fmt(t.protein)} g`)}
        ${row("Carbs", (t) => `${fmt(t.carb)} g`)}
        ${row("Fiber", (t) => `${fmt(t.fiber)} g`)}
        ${row("Fat", (t) => `${fmt(t.fat)} g`)}
        ${row("Sugar", (t) => `${fmt(t.sugar)} g`)}
      </tbody>
    </table></div></div>` : "";
  const lines = mealList(entries);
  return `
    <div class="top">
      <div>
        <h1>Record</h1>
        <p class="sub">${esc(formatDate(date))}${meta.exercise ? ` · ${esc(meta.exercise)}` : ""}${meta.minutes ? ` · ${fmt(meta.minutes)} min` : ""}${meta.steps ? ` · ${Number(meta.steps).toLocaleString("en-US")} steps` : ""} · ${kcal(meta.burned)} kcal burned</p>
      </div>
      <select class="who" id="person">${PEOPLE.map((p) => `<option value="${p.id}" ${p.id === person ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
    </div>
    ${banner()}
    <div class="field"><label class="label" for="date">Date</label><input class="textin" id="date" type="date" value="${esc(date)}"></div>
    ${exerciseBlock(meta)}
    <div class="card">
      <div class="metric"><div class="name">Calories</div><div class="val">${kcal(totals.kcal)} <span>of ${kcal(g.kcal)}</span></div>${bar(totals.kcal, g.kcal, "var(--copper)", true)}</div>
      <div class="metric"><div class="name">Protein</div><div class="val">${fmt(totals.protein)} g <span>of ${fmt(g.protein)} g</span></div>${bar(totals.protein, g.protein, "var(--sage)", false)}</div>
      <div class="metric"><div class="name">Fat</div><div class="val">${fmt(totals.fat)} g <span>of ${fmt(g.fatMax)} g max</span></div>${bar(totals.fat, g.fatMax, "var(--wheat)", true)}<div class="note">${fatNote(totals)}</div></div>
      <div class="metric"><div class="name">Carbohydrate</div><div class="val">${fmt(totals.carb)} g <span>of ${fmt(g.carbMax)} g max</span></div>${bar(totals.carb, g.carbMax, "var(--copper)", true)}<div class="note">${fmt(totals.carbOther)} g other · ${fmt(totals.sugar)} g sugar · ${fmt(totals.fiber)} g fiber</div></div>
      <div class="metric"><div class="name">Supplements</div><div class="val">${supp.goal ? `${supp.pct}%` : "—"} <span>${supp.goal ? `${supp.taken} of ${supp.goal}` : "Set on Goals"}</span></div>${supp.goal ? bar(supp.taken, supp.goal, "var(--sage)", true) : ""}</div>
    </div>
    <div class="stats">
      <div class="stat"><b>${fmt(totals.sugar)} g</b><em>Sugar · of ${fmt(g.sugarMax)} g</em></div>
      <div class="stat"><b>${fmt(totals.fiber)} g</b><em>Fiber</em></div>
      <div class="stat"><b>${vit} / ${VITAMINS.length}</b><em>Vitamins</em></div>
      <div class="stat"><b>${min} / ${MINERALS.length}</b><em>Minerals</em></div>
    </div>
    ${matrix}
    <p class="foods"><strong>Foods · </strong>${entries.length ? esc(foodsText(entries)) : "Nothing logged yet."}</p>
    ${lines ? `<div class="card">${lines}</div>` : `<button class="btn" type="button" data-nav="add">Add a food</button>`}`;
}

function mealList(entries) {
  const groups = mealGroups(entries);
  return groups.map((group) => {
    const foods = group.entries.map((entry) => `
      <div class="entry">
        <div>${esc(loggedAmount(entry))} ${esc(entry.name)}
          <div class="hint">${kcal(entry.kcal)} kcal · ${fmt(entry.protein)} g protein</div>
        </div>
        <button type="button" class="x" data-del="${esc(entry.id)}" aria-label="Remove">×</button>
      </div>`).join("");
    return `
      <div class="meal">
        <div class="meal-head">
          <b>${esc(group.meal)}</b>
          <div class="entry-actions">
            <span class="hint">${kcal(group.totals.kcal)} kcal</span>
            <button type="button" class="textbtn" data-meal-edit="${esc(group.meal)}">Edit</button>
          </div>
        </div>
        ${foods}
      </div>`;
  }).join("");
}

function scaleSnapshot(entry, amount) {
  const ratio = Number(amount) / Number(entry.amount);
  const n = (v) => round1((Number(v) || 0) * ratio);
  const micros = {};
  for (const [k, v] of Object.entries(entry.micros || {})) micros[k] = n(v);
  const cholesterolKnown = entry.cholesterolKnown !== false && entry.cholesterol != null && entry.cholesterol !== "";
  return {
    kcal: n(entry.kcal),
    protein: n(entry.protein),
    fatUnsat: n(entry.fatUnsat),
    fatSat: n(entry.fatSat),
    fatSplit: entry.fatSplit !== false,
    carbOther: n(entry.carbOther),
    sugar: n(entry.sugar),
    fiber: n(entry.fiber),
    sugarKnown: entry.sugarKnown !== false,
    cholesterol: cholesterolKnown ? n(entry.cholesterol) : null,
    cholesterolKnown,
    micros,
  };
}

function portionForDraft() {
  const amount = Number(draft.amount);
  if (!(amount > 0)) return null;
  const food = selectedFood();
  if (!food) return null;
  return scaleFood(food, amount, selectedUnit());
}

function linePortion(line) {
  const amount = Number(line.amount);
  if (!(amount > 0)) return null;
  const existing = line.entryId ? state.entries.find((entry) => entry.id === line.entryId) : null;
  if (existing && existing.foodId === line.foodId && existing.unit === line.unit && Number(existing.amount) > 0) {
    return scaleSnapshot(existing, amount);
  }
  const food = currentFoods().find((item) => item.id === line.foodId);
  if (!food) return null;
  return scaleFood(food, amount, line.unit || food.unit);
}

function beginEditMeal(meal) {
  const rows = dayEntries().filter((entry) => entry.meal === meal);
  if (!rows.length) return;
  editingMeal = meal;
  plate = rows.map((entry) => ({
    entryId: entry.id,
    foodId: entry.foodId,
    amount: String(entry.amount),
    unit: entry.unit,
    name: entry.name,
  }));
  draft.meal = meal;
  draft.category = "";
  draft.foodId = "";
  draft.amount = "";
  draft.unit = "";
  draft.foodQuery = "";
  notice = "";
  view = "add";
  render();
}

function fatNote(t) {
  return `${fmt(t.fatUnsat)} g unsaturated · ${fmt(t.fatSat)} g saturated`;
}

function entriesByDate() {
  const byDate = new Map();
  for (const e of state.entries) {
    if (e.person !== person) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  return byDate;
}

function activityBurn(iso) {
  const row = state.days.find((day) => day.person === person && day.date === iso);
  return Number(row?.burned) || 0;
}

function monotonePath(points) {
  const n = points.length;
  if (n < 2) return "";
  const dx = [];
  const slope = [];
  const tangent = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1].x - points[i].x;
    slope[i] = (points[i + 1].y - points[i].y) / dx[i];
  }
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const hypot = a * a + b * b;
    if (hypot > 9) {
      const scale = 3 / Math.sqrt(hypot);
      tangent[i] = scale * a * slope[i];
      tangent[i + 1] = scale * b * slope[i];
    }
  }
  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const span = dx[i];
    const c1x = points[i].x + span / 3;
    const c1y = points[i].y + (tangent[i] * span) / 3;
    const c2x = points[i + 1].x - span / 3;
    const c2y = points[i + 1].y - (tangent[i + 1] * span) / 3;
    path += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${points[i + 1].x.toFixed(1)} ${points[i + 1].y.toFixed(1)}`;
  }
  return path;
}

function logChartSvg(rows, goal) {
  const W = 360;
  const H = 176;
  const L = 48;
  const R = 8;
  const T = 14;
  const B = 22;
  const values = rows.filter((row) => !row.gap).flatMap((row) => [row.eaten, row.burn]);
  values.push(Number(goal) || 0);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = Math.max(40, (hi - lo) * 0.18);
  lo = Math.max(0, Math.floor((lo - pad) / 50) * 50);
  hi = Math.ceil((hi + pad) / 50) * 50;
  if (hi <= lo) hi = lo + 200;
  const x = (index) => L + (rows.length === 1 ? (W - L - R) / 2 : (index * (W - L - R)) / (rows.length - 1));
  const y = (value) => T + ((hi - value) / (hi - lo)) * (H - T - B);
  const ticks = [];
  const addTick = (value) => {
    if (ticks.some((tick) => Math.abs(tick - value) < (hi - lo) * 0.12)) return;
    ticks.push(value);
  };
  addTick(goal);
  addTick(hi);
  addTick(lo);
  const grids = ticks.map((tick) => {
    const yy = y(tick).toFixed(1);
    return `<line x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}" stroke="#31382f"></line><text x="${L - 6}" y="${Number(yy) + 3}" fill="#7d8578" font-size="10" text-anchor="end" font-family="Segoe UI, sans-serif">${kcal(tick)}</text>`;
  }).join("");
  const months = new Set(rows.map((row) => row.date.slice(0, 7)));
  const withMonth = months.size > 1 || rows.length > 14;
  const labelAt = rows.length <= 8
    ? rows.map((_, index) => index)
    : [0, 0.25, 0.5, 0.75, 1].map((part) => Math.round(part * (rows.length - 1)));
  const labels = [...new Set(labelAt)].map((index) => {
    const iso = rows[index].date;
    const [, month, day] = iso.split("-").map(Number);
    const text = withMonth
      ? new Date(Number(iso.slice(0, 4)), month - 1, day).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      : String(day);
    return `<text x="${x(index).toFixed(1)}" y="${H - 4}" fill="#7d8578" font-size="10" text-anchor="middle" font-family="Segoe UI, sans-serif">${esc(text)}</text>`;
  }).join("");
  const goalY = y(goal).toFixed(1);
  const goalLine = `<line x1="${L}" y1="${goalY}" x2="${W - R}" y2="${goalY}" stroke="#d7c4a3" stroke-width="1.6" stroke-dasharray="4 3"></line>`;
  const series = (key, color) => {
    const segments = [];
    let current = [];
    rows.forEach((row, index) => {
      if (row.gap) {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      current.push({ x: x(index), y: y(row[key]), date: row.date });
    });
    if (current.length) segments.push(current);
    const paths = segments
      .filter((points) => points.length > 1)
      .map((points) => `<path d="${monotonePath(points)}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"></path>`)
      .join("");
    const dots = segments.flat().map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="8" fill="transparent" data-date="${esc(point.date)}"></circle><circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.8" fill="${color}" pointer-events="none"></circle>`).join("");
    return paths + dots;
  };
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Eaten, burned, and calorie goal">${grids}${labels}${goalLine}${series("burn", "#b7c7a4")}${series("eaten", "#e0a15c")}</svg>`;
}

function goalDonut(hit, total) {
  const radius = 36;
  const turn = 2 * Math.PI * radius;
  const hitLen = total ? (hit / total) * turn : 0;
  const restLen = turn - hitLen;
  const rings = `
    ${hit < total ? `<circle cx="50" cy="50" r="${radius}" fill="none" stroke="#e07a5f" stroke-width="11" stroke-linecap="butt" stroke-dasharray="${restLen.toFixed(2)} ${turn.toFixed(2)}" stroke-dashoffset="${(-hitLen).toFixed(2)}"></circle>` : ""}
    ${hit > 0 ? `<circle cx="50" cy="50" r="${radius}" fill="none" stroke="#b7c7a4" stroke-width="11" stroke-linecap="butt" stroke-dasharray="${hitLen.toFixed(2)} ${turn.toFixed(2)}"></circle>` : ""}`;
  return `<svg viewBox="0 0 100 100" role="img"><g transform="rotate(-90 50 50)">${rings}</g><text x="50" y="48" text-anchor="middle" fill="#f4f1e8" font-size="13" font-weight="700" font-family="Segoe UI, sans-serif">${hit} of ${total}</text><text x="50" y="62" text-anchor="middle" fill="#7d8578" font-size="9" font-family="Segoe UI, sans-serif">on goal</text></svg>`;
}

function logVisual(byDate, loggedAsc) {
  const g = goals();
  const rest = Number(g.restingBurn) || 0;
  const calendar = logChartDates(loggedAsc, { custom: logRangeCustom, from: logFrom, to: logTo });
  const rows = calendar.map((iso) => {
    const entries = byDate.get(iso);
    if (!entries) return { date: iso, gap: true };
    const totals = sumEntries(entries);
    return { date: iso, gap: false, totals, eaten: totals.kcal, burn: chartBurn(activityBurn(iso), rest) };
  });
  const logged = rows.filter((row) => !row.gap);
  const rangeHint = logRangeCustom
    ? "This chart uses Start and End."
    : "Last 7 logged days. Change Start or End to chart that range.";
  const burnHint = rest > 0 ? ` Burned includes ${kcal(rest)} kcal resting.` : "";
  if (!logged.length) {
    return `<p class="hint">${esc(logRangeCustom && logFrom > logTo ? "Put the earlier day in Start." : "No logged days in this chart.")}</p>`;
  }
  const mean = (pick) => logged.reduce((sum, row) => sum + pick(row), 0) / logged.length;
  const limitBar = (value, limit, color, mode) => {
    const amount = Number(value) || 0;
    const cap = Number(limit) || 0;
    const over = mode === "max" ? cap && amount > cap : mode === "under" ? cap && amount >= cap : false;
    const pct = cap ? Math.min(100, (amount / cap) * 100) : 0;
    return `<div class="bar"><i style="width:${pct}%;background:${over ? "var(--over)" : color}"></i></div>`;
  };
  const averages = [
    ["Calories", `${kcal(mean((row) => row.eaten))}`, `of ${kcal(g.kcal)}`, limitBar(mean((row) => row.eaten), g.kcal, "var(--copper)", "max")],
    ["Burned", `${kcal(mean((row) => row.burn))}`, rest > 0 ? `includes ${kcal(rest)} rest` : "activity", limitBar(mean((row) => row.burn), g.kcal, "var(--sage)", "show")],
    ["Protein", `${fmt(mean((row) => row.totals.protein))} g`, `of ${fmt(g.protein)} g`, limitBar(mean((row) => row.totals.protein), g.protein, "var(--sage)", "min")],
    ["Fat", `${fmt(mean((row) => row.totals.fat))} g`, `of ${fmt(g.fatMax)} g max`, limitBar(mean((row) => row.totals.fat), g.fatMax, "var(--wheat)", "max")],
    ["Sugar", `${fmt(mean((row) => row.totals.sugar))} g`, `under ${fmt(g.sugarMax)} g`, limitBar(mean((row) => row.totals.sugar), g.sugarMax, "var(--copper)", "under")],
    ["Carbohydrate", `${fmt(mean((row) => row.totals.carb))} g`, `of ${fmt(g.carbMax)} g max`, limitBar(mean((row) => row.totals.carb), g.carbMax, "var(--sage)", "max")],
  ].map(([name, value, note, barHtml]) => `<div class="metric"><div class="name">${name}</div><div class="val">${value} <span>${note}</span></div>${barHtml}</div>`).join("");
  const pies = [
    ["kcal", "Calories", "at or under the calorie goal", "over the calorie goal"],
    ["protein", "Protein", "at the protein minimum", "under the protein minimum"],
    ["fat", "Fat", "at or under the fat maximum", "over the fat maximum"],
    ["sugar", "Sugar", "under the sugar maximum", "at or over the sugar maximum"],
    ["carb", "Carbohydrate", "at or under the carbohydrate maximum", "over the carbohydrate maximum"],
  ].map(([kind, name, yes, no]) => {
    const hit = logged.filter((row) => onGoal(kind, row.totals, g)).length;
    return `<div class="pie">${goalDonut(hit, logged.length)}<b>${name}</b><span>${hit} days ${yes}</span><span>${logged.length - hit} days ${no}</span></div>`;
  }).join("");
  return `
    <h2>Calories</h2>
    <div class="card">
      <div class="field" style="margin-top:0">
        <label class="label" for="resting-burn">Resting burn</label>
        <div class="rest-line"><input class="textin" id="resting-burn" inputmode="numeric" value="${esc(rest)}"><span>kcal added on the chart</span></div>
      </div>
      <div class="legend-row"><span><i style="background:#e0a15c"></i>Eaten</span><span><i style="background:#b7c7a4"></i>Burned</span><span><i class="dash"></i>Goal ${kcal(g.kcal)}</span></div>
      ${logChartSvg(rows, g.kcal)}
      <p class="hint">${esc(rangeHint + burnHint)} Days with no food are gaps.</p>
      ${averages}
    </div>
    <h2>Days on goal</h2>
    <div class="pie-grid">${pies}</div>
    <p class="hint">Sage met the goal. Coral missed it. A day with no food is left out.</p>`;
}

function dayButton(d, entries) {
  const t = sumEntries(entries);
  return `<button type="button" class="dayrow" data-date="${esc(d)}"><b>${esc(formatDate(d))}</b><span>${kcal(t.kcal)} kcal · ${fmt(t.protein)} g protein · ${fmt(t.fat)} g fat · ${fmt(t.carb)} g carbs</span></button>`;
}

function logView() {
  const byDate = entriesByDate();
  const dates = [...byDate.keys()].sort().reverse();
  const loggedAsc = [...dates].reverse();
  if (dates.length) {
    if (!logFrom) logFrom = dates[dates.length - 1];
    if (!logTo) logTo = dates[0];
  }
  const readyRange = logFrom && logTo && logFrom <= logTo;
  const ranged = readyRange ? dates.filter((d) => d >= logFrom && d <= logTo) : [];
  const rangeRows = ranged.map((d) => dayButton(d, byDate.get(d))).join("");
  const rangeNote = !dates.length
    ? "Nothing logged yet."
    : !logFrom || !logTo
      ? "Choose a start and an end."
      : logFrom > logTo
        ? "Put the earlier day in Start."
        : ranged.length ? "" : "No days in that range.";
  return `
    <div class="top">
      <div>
        <h1>Log</h1>
        <p class="sub">${esc(personName())}</p>
      </div>
      <select class="who" id="person">${PEOPLE.map((p) => `<option value="${p.id}" ${p.id === person ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
    </div>
    <button class="textbtn centerlink" type="button" id="download">Download ${esc(personName())}'s log</button>
    <h2>Between dates</h2>
    <div class="pair">
      <div class="field"><label class="label" for="log-from">Start</label><input class="textin" id="log-from" type="date" value="${esc(logFrom)}"></div>
      <div class="field"><label class="label" for="log-to">End</label><input class="textin" id="log-to" type="date" value="${esc(logTo)}"></div>
    </div>
    ${logVisual(byDate, loggedAsc)}
    ${rangeRows ? `<div class="card log-card"><div class="log-days">${rangeRows}</div></div>` : `<p class="hint">${esc(rangeNote)}</p>`}
    <button class="textbtn centerlink" type="button" id="download-range">Download this range</button>`;
}

function foodMatches() {
  const q = (draft.foodQuery || "").trim().toLowerCase();
  if (!q) return [];
  return currentFoods()
    .filter((food) => food.name.toLowerCase().includes(q) || food.category.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8);
}

function plateBlock() {
  if (!plate.length) return "";
  const rows = plate.map((line, index) => {
    const food = currentFoods().find((item) => item.id === line.foodId);
    const name = food?.name || line.name || "Food";
    const portion = linePortion(line);
    return `
      <div class="entry">
        <div class="plate-line"><b>${esc(name)}</b>
          <div class="amount"><input id="plate-amount-${index}" data-plate-amount="${index}" inputmode="decimal" value="${esc(line.amount)}" aria-label="Amount of ${esc(name)}"><span class="unit">${esc(unitWord(line.unit))}</span></div>
          <div class="hint">${portion ? `${kcal(portion.kcal)} kcal · ${fmt(portion.protein)} g protein` : "Amount is empty"}</div>
        </div>
        <button type="button" class="x" data-plate="${index}" aria-label="Remove">×</button>
      </div>`;
  }).join("");
  return `<div class="card"><div class="label">This meal</div>${rows}</div>`;
}

function addView() {
  const editing = !!editingMeal;
  const food = selectedFood();
  const unit = selectedUnit();
  const cats = categories();
  const list = foodsInCategory();
  const canGrams = food && food.servingGrams;
  const portion = portionForDraft();
  const matches = foodMatches();
  const countLabel = `${plate.length} ${plate.length === 1 ? "food" : "foods"}`;
  return `
    <div class="top"><div><h1>${editing ? "Edit" : "Add"}</h1><p class="sub">${esc(formatDate(date))} · ${editing ? `Editing ${esc(draft.meal)} · ${countLabel}` : esc(personName())}</p></div></div>
    <div class="field"><div class="label">Meal</div><div class="segs">${MEALS.map((m) => `<button type="button" class="seg ${draft.meal === m ? "on" : ""}" data-meal="${esc(m)}">${esc(m)}</button>`).join("")}</div></div>
    ${plateBlock()}
    <div class="field"><label class="label" for="food-query">Search</label>
      <input class="textin" id="food-query" value="${esc(draft.foodQuery || "")}" placeholder="Search your dishes" autocomplete="off">
    </div>
    ${matches.map((item) => `<button type="button" class="result" data-food="${esc(item.id)}"><b>${esc(item.name)}</b><span>${esc(item.category)} · ${esc(item.servingLabel)} · ${kcal(item.kcal)} kcal</span></button>`).join("")}
    <div class="field"><label class="label" for="category">Category</label>
      <select class="select" id="category"><option value="">Choose</option>${cats.map((c) => `<option ${c === draft.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="field"><label class="label" for="food">Food</label>
      <select class="select" id="food" ${draft.category ? "" : "disabled"}><option value="">Choose</option>${list.map((f) => `<option value="${esc(f.id)}" ${f.id === draft.foodId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>
    </div>
    <div class="field"><label class="label" for="amount">Amount eaten</label>
      <div class="amount"><input id="amount" inputmode="decimal" value="${esc(draft.amount)}" placeholder="0"><span class="unit">${unitWord(unit)}</span></div>
      <p class="hint">${food ? `Numbers are for ${esc(foodReferenceLabel(food))}. This amount is scaled from that.` : "Search, or choose a category and a food."} ${food?.unit === "count" && canGrams ? "You can switch to grams." : ""}</p>
      ${food?.unit === "count" && canGrams ? `<button type="button" class="textbtn" id="unit-toggle">Use ${unit === "count" ? "grams" : "count"} instead</button>` : ""}
    </div>
    <div class="card" id="portion">${portionHTML(portion)}</div>
    <button class="btn secondary" type="button" id="add-another">Add another food</button>
    <button class="btn" type="button" id="save-entry">${editing ? "Save changes" : "Add to today"}</button>
    <button class="centerlink textbtn" type="button" data-nav="search">Food not in the list</button>
    ${editing ? `<button class="centerlink textbtn" type="button" id="cancel-edit">Cancel</button>` : supplementBlock()}`;
}

function portionHTML(portion) {
  if (!portion) return `<div class="hint">The portion appears here before you add it.</div>`;
  return `
    <div class="label">This portion</div>
    <div class="portion" style="margin-top:8px">
      <div><b>${kcal(portion.kcal)}</b><span>kcal</span></div>
      <div><b>${fmt(portion.protein)} g</b><span>protein</span></div>
      <div><b>${fmt(fatTotal(portion))} g</b><span>fat</span></div>
      <div><b>${fmt(carbTotal(portion))} g</b><span>carbohydrate</span></div>
      <div><b>${fmt(portion.sugar)} g</b><span>sugar</span></div>
      <div><b>${fmt(portion.fiber)} g</b><span>fiber</span></div>
      ${portion.cholesterolKnown ? `<div><b>${fmt(portion.cholesterol)} mg</b><span>cholesterol</span></div>` : ""}
    </div>`;
}

function exerciseEditor() {
  const rows = exerciseSets().map((name, index) => `
    <div class="exercise-row">
      <input class="textin" data-exercise-name="${index}" value="${esc(name)}" aria-label="Exercise set ${index + 1}">
      <button type="button" class="textbtn" data-exercise-remove="${index}">Remove</button>
    </div>`).join("");
  return `
    <h2>Exercise sets</h2>
    <p class="hint">These are the choices on Record. A name containing "hik" uses the hiking calorie rate. Any other name uses the gym rate.</p>
    <div class="card">${rows || `<p class="hint">None yet.</p>`}
      <div class="field"><label class="label" for="exercise-add-name">Add</label><input class="textin" id="exercise-add-name" placeholder="Legs"></div>
      <button class="btn secondary" type="button" id="exercise-add">Add exercise</button>
    </div>`;
}

function exerciseBlock(meta) {
  const names = exerciseSets();
  const selected = meta.exercise || "";
  const options = names.map((name) => `<option value="${esc(name)}" ${name === selected ? "selected" : ""}>${esc(name)}</option>`).join("");
  const extra = selected && !names.includes(selected) ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : "";
  return `
    <div class="field">
      <label class="label" for="exercise">Exercise set</label>
      <div class="pair">
        <select class="select" id="exercise">
          <option value="" ${selected ? "" : "selected"}>Choose</option>
          ${options}
          ${extra}
        </select>
        <input class="textin" id="minutes" inputmode="numeric" value="${meta.minutes || ""}" placeholder="Minutes" aria-label="Exercise minutes">
      </div>
    </div>
    <div class="field"><label class="label" for="steps">Steps</label><input class="textin" id="steps" inputmode="numeric" value="${meta.steps || ""}" placeholder="0"></div>
    <div class="field"><label class="label" for="burned">Calories</label><input class="textin" id="burned" inputmode="decimal" value="${meta.burned || ""}" placeholder="0">
      <p class="hint">Steps add 24 kcal per 1,000. Exercise adds about 4.4 kcal per minute, or 5.6 for hiking. Edit it if that guess is off.</p>
    </div>`;
}

function loggedAmount(entry) {
  if (entry.unit === "count") return `${fmt(entry.amount)} count`;
  if (entry.unit === "ml") return `${fmt(entry.amount)} ml`;
  return `${fmt(entry.amount)} g`;
}

function unitWord(unit) {
  if (unit === "count") return "count";
  if (unit === "ml") return "ml";
  return "grams";
}

function trimNum(n) {
  const r = round1(Number(n) || 0);
  return Number.isInteger(r) ? String(r) : String(r);
}

function categoryChoices(selected, isNew) {
  const options = categories().map((c) => `<option value="${esc(c)}" ${!isNew && c === selected ? "selected" : ""}>${esc(c)}</option>`).join("");
  return `
    <div class="field">
      <label class="label" for="nf-cat">Category</label>
      <select class="select" id="nf-cat">
        <option value="" ${!selected && !isNew ? "selected" : ""}>Choose</option>
        ${options}
        <option value="__new__" ${isNew ? "selected" : ""}>New category</option>
      </select>
      ${isNew ? `<input class="textin" id="nf-cat-new" style="margin-top:8px" value="${esc(lookup.form?.newCategoryName || "")}" placeholder="New category">` : ""}
    </div>`;
}

function blankMicros() {
  const micros = {};
  for (const [key] of [...VITAMINS, ...MINERALS]) micros[key] = "";
  return micros;
}

function microsFromFood(food) {
  const micros = blankMicros();
  let any = false;
  for (const [key] of [...VITAMINS, ...MINERALS]) {
    const value = microValue(food?.micros, key);
    if (value == null || value === "") continue;
    micros[key] = value;
    any = true;
  }
  return { micros, showMicros: any };
}

function formFromFood(food) {
  const unit = food.unit === "ml" ? "ml" : food.unit === "count" ? "count" : "g";
  const known = categories().includes(food.category);
  return {
    foodId: food.id,
    name: food.name,
    category: known ? food.category : "",
    newCategory: !known && !!food.category,
    newCategoryName: !known ? (food.category || "") : "",
    kcal: food.kcal,
    protein: food.protein,
    fat: fatTotal(food),
    sat: food.fatSplit === false ? "" : food.fatSat,
    carb: carbTotal(food),
    sugar: food.sugar,
    fiber: food.fiber,
    cholesterol: food.cholesterolKnown && food.cholesterol != null ? food.cholesterol : "",
    source: food.source,
    serving: unit === "count" ? (food.servingCount || 1) : (food.servingGrams ?? ""),
    servingUnit: unit,
    numberBasis: Number(food.perAmount) > 0
      ? Number(food.perAmount)
      : Number(unit === "count" ? (food.servingCount || 1) : (food.servingGrams || 100)),
    ...microsFromFood(food),
  };
}

function formFromSearch(food) {
  const known = categories().includes(food.category);
  return {
    name: food.name,
    category: known ? food.category : "",
    newCategory: !known && !!food.category,
    newCategoryName: !known ? (food.category || "") : "",
    kcal: food.kcal,
    protein: food.protein,
    fat: fatTotal(food),
    sat: food.fatSplit === false ? "" : food.fatSat,
    carb: carbTotal(food),
    sugar: food.sugar,
    fiber: food.fiber,
    cholesterol: food.cholesterolKnown && food.cholesterol != null ? food.cholesterol : "",
    source: food.source,
    serving: "100",
    servingUnit: "g",
    numberBasis: 100,
    ...microsFromFood(food),
  };
}

function searchView() {
  const results = [
    ...lookup.saved.map((f) => ({ kind: "saved", food: f })),
    ...lookup.found.map((f) => ({ kind: "new", food: f })),
  ];
  const form = lookup.form ? confirmForm() : "";
  return `
    <button class="back" type="button" id="search-back">Back</button>
    <h1>New food</h1>
    <p class="sub">Search fills published averages for 100 g. Change the serving size and the numbers update for that serving.</p>
    <div class="field"><label class="label" for="q">Name</label><input class="textin" id="q" value="${esc(lookup.q)}" placeholder="chayote dal sambhar" autocomplete="off"></div>
    <p class="hint">${esc(lookup.status)}</p>
    ${results.map((r, i) => `
      <button type="button" class="result" data-pick="${i}" data-kind="${r.kind}">
        <b>${esc(r.food.name)}</b>
        <span>${r.kind === "saved" ? "Already in the list" : esc(r.food.source)} · ${kcal(r.food.kcal)} kcal / 100 g</span>
      </button>`).join("")}
    ${form}
    <h2>Or type a label</h2>
    <button class="btn" type="button" id="blank-food" style="background:#2a312b;color:var(--text)">Enter numbers myself</button>`;
}

function microEditor(form) {
  const input = (key, label, unit) => `
    <div class="field"><label class="label named">${esc(label)} (${esc(String(unit).toUpperCase())})</label>
      <input class="mini" id="nf-micro-${key}" inputmode="decimal" value="${esc(form.micros?.[key] ?? "")}" placeholder="blank if unknown">
    </div>`;
  return `
    <h2>Vitamins & Minerals</h2>
    <p class="hint">For this serving. Leave a box blank when the label does not list it.</p>
    <div class="pair">${VITAMINS.map(([key, label, unit]) => input(key, label, unit)).join("")}</div>
    <div class="pair">${MINERALS.map(([key, label, unit]) => input(key, label, unit)).join("")}</div>`;
}

function confirmForm(heading = "Confirm this serving", buttonId = "save-food", buttonLabel = "Save to the list") {
  const f = lookup.form;
  const unit = f.servingUnit === "ml" || f.servingUnit === "count" ? f.servingUnit : "g";
  return `
    <div class="card" id="food-editor">
      <div class="editor-head">
        <div class="label">${esc(heading)}</div>
        ${buttonId === "update-food" ? `<button class="textbtn danger" type="button" id="delete-food">Delete dish</button>` : ""}
      </div>
      <div class="field"><label class="label">Name</label><input class="textin" id="nf-name" value="${esc(f.name)}"></div>
      ${categoryChoices(f.category, !!f.newCategory)}
      <div class="pair">
        <div class="field"><label class="label" for="nf-serving">Serving size</label><input class="mini" id="nf-serving" inputmode="decimal" value="${esc(f.serving ?? "")}"></div>
        <div class="field"><label class="label" for="nf-unit">Unit</label>
          <select class="select" id="nf-unit">
            <option value="g" ${unit === "g" ? "selected" : ""}>grams</option>
            <option value="ml" ${unit === "ml" ? "selected" : ""}>ml</option>
            <option value="count" ${unit === "count" ? "selected" : ""}>count</option>
          </select>
        </div>
      </div>
      <p class="hint">The numbers below are for this serving. Changing the serving size updates them.</p>
      <div class="pair">
        <div class="field"><label class="label">Calories</label><input class="mini" id="nf-kcal" inputmode="decimal" value="${esc(f.kcal)}"></div>
        <div class="field"><label class="label">Protein</label><input class="mini" id="nf-protein" inputmode="decimal" value="${esc(f.protein)}"></div>
        <div class="field"><label class="label">Total fat</label><input class="mini" id="nf-fat" inputmode="decimal" value="${esc(f.fat)}"></div>
        <div class="field"><label class="label">Saturated fat</label><input class="mini" id="nf-sat" inputmode="decimal" value="${esc(f.sat)}" placeholder="blank if unknown"></div>
        <div class="field"><label class="label">Total carbohydrate</label><input class="mini" id="nf-carb" inputmode="decimal" value="${esc(f.carb)}"></div>
        <div class="field"><label class="label">Sugar</label><input class="mini" id="nf-sugar" inputmode="decimal" value="${esc(f.sugar)}"></div>
        <div class="field"><label class="label">Fiber</label><input class="mini" id="nf-fiber" inputmode="decimal" value="${esc(f.fiber)}"></div>
        <div class="field"><label class="label">Cholesterol (mg)</label><input class="mini" id="nf-cholesterol" inputmode="decimal" value="${esc(f.cholesterol ?? "")}" placeholder="blank if unknown"></div>
      </div>
      <p class="hint">${esc(f.source || "")} Type the label totals. Saturated fat is subtracted from total fat, and sugar and fiber are subtracted from carbohydrate. Cholesterol is stored as written.</p>
      ${f.showMicros ? microEditor(f) : `<button class="textbtn" type="button" id="show-micros">Vitamins & Minerals</button>`}
      <button class="btn" type="button" id="${buttonId}">${esc(buttonLabel)}</button>
    </div>`;
}

function foodsView() {
  const q = (draft.foodFilter || "").toLowerCase();
  const mine = currentFoods();
  const list = mine
    .filter((f) => !q || f.name.toLowerCase().includes(q) || f.category.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const note = listForPerson(person) === "nonu"
    ? `${mine.length} foods. This list is Nonu's. Surya and Sahi do not see it.`
    : `${mine.length} foods. Shared by Surya and Sahi. Nonu has her own list.`;
  const rows = list.slice(0, 40).map((f) => `
      <button type="button" class="dayrow" data-edit="${esc(f.id)}"><b>${esc(f.name)}</b><span>${esc(f.category)} · ${esc(f.servingLabel)} · ${kcal(f.kcal)} kcal${f.approx ? " · approximate" : ""}</span></button>
    `).join("");
  return `
    <h1>Menu</h1>
    <p class="sub">${esc(note)}</p>
    <button class="btn" type="button" data-nav="search">New food</button>
    <div class="field"><input class="textin" id="food-filter" placeholder="Search" value="${esc(draft.foodFilter || "")}"></div>
    <div class="card">${rows || `<p class="hint">No foods yet. Use New food.</p>`}${list.length > 40 ? `<p class="hint">Showing 40. Search to narrow.</p>` : ""}</div>
    ${editingId ? editFoodCard() : ""}`;
}

function editFoodCard() {
  const f = state.foods.find((food) => food.id === editingId);
  if (!f) return "";
  if (!lookup.form || lookup.form.foodId !== f.id) lookup.form = formFromFood(f);
  return confirmForm("Per this serving", "update-food", "Save changes");
}

function goalsView() {
  const g = goals();
  const nutrient = (list, bag) => list.map(([key, label, unit]) => `
    <div class="field"><label class="label named">${esc(label)} (${esc(String(unit).toUpperCase())}) minimum</label>
      <input class="mini" data-min="${key}" data-bag="${bag}" inputmode="decimal" value="${esc(g[bag][key])}">
    </div>`).join("");
  return `
    <h1>Goals</h1>
    <p class="sub">${esc(personName())}. Sahi and Nonu start on placeholder targets.</p>
    <div class="field"><label class="label">Who</label><select class="select" id="person">${PEOPLE.map((p) => `<option value="${p.id}" ${p.id === person ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
    <div class="pair">
      ${goalInput("kcal", "Calories", g.kcal)}
      ${goalInput("protein", "Protein minimum", g.protein)}
      ${goalInput("fatMax", "Fat maximum", g.fatMax)}
      ${goalInput("carbMax", "Carbohydrate maximum", g.carbMax)}
      ${goalInput("sugarMax", "Sugar maximum", g.sugarMax)}
    </div>
    ${exerciseEditor()}
    <p class="hint">A vitamin or mineral counts when today's foods clear the minimum. Empty cells on a food do not count.</p>
    <details><summary>Vitamin minimums (${VITAMINS.length})</summary>${nutrient(VITAMINS, "vitamins")}</details>
    <details><summary>Mineral minimums (${MINERALS.length})</summary>${nutrient(MINERALS, "minerals")}</details>
    ${supplementEditor()}
    <h2>Shared database</h2>
    <div class="card">
      <p class="foods">Free hosting: put this folder on Cloudflare Pages. Free database: create a Supabase project, run <b>supabase/schema.sql</b>, then paste the project URL and anon key here. Days stay separate for Surya, Sahi, and Nonu. Surya and Sahi share one food list. Nonu has her own.</p>
      <div class="field"><label class="label">Supabase URL</label><input class="textin" id="sb-url" value="${esc(loadConfig().supabaseUrl || "")}" placeholder="https://xxxx.supabase.co"></div>
      <div class="field"><label class="label">Supabase anon key</label><input class="textin" id="sb-key" value="${esc(loadConfig().supabaseKey || "")}" placeholder="eyJ..."></div>
      <div class="field"><label class="label">USDA API key, optional</label><input class="textin" id="usda-key" value="${esc(loadConfig().usdaKey || "")}" placeholder="From fdc.nal.usda.gov"></div>
      <button class="btn" type="button" id="save-config">Connect</button>
      <button class="textbtn centerlink" type="button" id="export">Download backup</button>
      <div class="field"><label class="label">Import backup</label><input class="textin" id="import" type="file" accept="application/json"></div>
      <p class="hint">${mode === "shared" ? "Connected." : "Not connected."}</p>
      <p class="hint">Home screen icon by Freepik from Flaticon.</p>
      ${syncError ? `<p class="warn">${esc(syncError)}</p>` : ""}
    </div>`;
}

function goalInput(key, label, value) {
  return `<div class="field"><label class="label">${label}</label><input class="mini" data-goal="${key}" inputmode="decimal" value="${esc(value)}"></div>`;
}

function captureFoodForm() {
  const name = document.getElementById("nf-name");
  if (!name || !lookup.form) return;
  const picked = document.getElementById("nf-cat")?.value ?? "";
  const typed = document.getElementById("nf-cat-new")?.value ?? "";
  const newCategory = picked === "__new__";
  lookup.form = {
    ...lookup.form,
    name: name.value,
    category: newCategory ? "" : picked,
    newCategory,
    newCategoryName: newCategory ? typed : "",
    kcal: document.getElementById("nf-kcal")?.value ?? "",
    protein: document.getElementById("nf-protein")?.value ?? "",
    fat: document.getElementById("nf-fat")?.value ?? "",
    sat: document.getElementById("nf-sat")?.value ?? "",
    carb: document.getElementById("nf-carb")?.value ?? "",
    sugar: document.getElementById("nf-sugar")?.value ?? "",
    fiber: document.getElementById("nf-fiber")?.value ?? "",
    cholesterol: document.getElementById("nf-cholesterol")?.value ?? "",
    serving: document.getElementById("nf-serving")?.value ?? "",
    servingUnit: document.getElementById("nf-unit")?.value || "g",
  };
  if (document.getElementById("nf-micro-vit_a")) {
    const micros = blankMicros();
    for (const [key] of [...VITAMINS, ...MINERALS]) {
      micros[key] = document.getElementById(`nf-micro-${key}`)?.value ?? "";
    }
    lookup.form.micros = micros;
    lookup.form.showMicros = true;
  }
}

function render() {
  if (!skipCapture) captureFoodForm();
  skipCapture = false;
  const screen = document.querySelector(".screen");
  const prevTop = screen ? screen.scrollTop : (document.scrollingElement?.scrollTop || 0);
  const focus = document.activeElement;
  const focusId = focus?.id;
  const start = focus?.selectionStart;
  const html = {
    today: todayView, add: addView, search: searchView, foods: foodsView, log: logView, goals: goalsView,
  }[view] || todayView;
  const active = view === "search" ? (searchReturn === "foods" ? "foods" : "add") : view;
  app.innerHTML = `<div class="screen">${html()}${notice ? `<p class="warn">${esc(notice)}</p>` : ""}</div>${nav(active)}`;
  const next = document.querySelector(".screen");
  const targetId = scrollTarget;
  scrollTarget = "";
  if (targetId) {
    document.getElementById(targetId)?.scrollIntoView({ block: "start" });
  } else if (next) {
    next.scrollTop = prevTop;
  }
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (start != null && el.setSelectionRange) {
        try { el.setSelectionRange(start, start); } catch { /* number inputs */ }
      }
    }
  }
}

function scaleFormValue(value, factor) {
  if (value === "" || value == null) return value;
  const number = Number(value);
  return Number.isFinite(number) ? String(round1(number * factor)) : value;
}

function applyServingResize() {
  captureFoodForm();
  const form = lookup.form;
  if (!form) return;
  const next = Number(form.serving);
  const prev = Number(form.numberBasis);
  const unit = form.servingUnit || "g";
  if (unit === "count" || !(next > 0) || !(prev > 0) || Math.abs(next - prev) < 0.001) {
    if (next > 0) form.numberBasis = next;
    return;
  }
  const factor = next / prev;
  for (const key of ["kcal", "protein", "fat", "sat", "carb", "sugar", "fiber", "cholesterol"]) {
    form[key] = scaleFormValue(form[key], factor);
  }
  if (form.micros) {
    form.micros = Object.fromEntries(Object.entries(form.micros).map(([key, value]) => [key, scaleFormValue(value, factor)]));
  }
  form.numberBasis = next;
  form.serving = String(next);
  form.source = String(form.source || "").replace(
    /per\s+[\d.]+\s*(g|ml)\b/i,
    `per ${trimNum(next)} ${unit === "ml" ? "ml" : "g"}`,
  );
}

function readForm() {
  const f = lookup.form || {};
  const satRaw = f.sat ?? "";
  const category = (f.newCategory ? f.newCategoryName : f.category) || "";
  return {
    name: (f.name || "").trim(),
    category: category.trim() || "Added foods",
    kcal: f.kcal,
    protein: f.protein,
    fat: f.fat,
    sat: satRaw === "" ? null : satRaw,
    carb: f.carb,
    sugar: f.sugar,
    fiber: f.fiber,
    cholesterol: f.cholesterol,
    serving: f.serving,
    servingUnit: f.servingUnit || "g",
    source: f.source || "Typed from a label",
    micros: f.micros || blankMicros(),
  };
}

function storedMicros(form) {
  const micros = {};
  for (const [key] of [...VITAMINS, ...MINERALS]) {
    const raw = form.micros?.[key];
    if (raw === "" || raw == null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    micros[key] = round1(n);
  }
  return micros;
}

function servingFields(form, existing) {
  const unit = form.servingUnit === "ml" || form.servingUnit === "count" ? form.servingUnit : "g";
  let size = Number(form.serving);
  if (!(size > 0)) size = unit === "count" ? 1 : 100;
  const same = existing && (existing.unit || "g") === unit && (
    unit === "count"
      ? Number(existing.servingCount || 1) === size
      : Number(existing.servingGrams) === size
  );
  const servingLabel = same && existing.servingLabel
    ? existing.servingLabel
    : unit === "count"
      ? `${trimNum(size)} count`
      : `${trimNum(size)} ${unit}`;
  if (unit === "count") {
    return {
      unit,
      servingCount: size,
      servingGrams: existing && existing.unit === "count" ? (existing.servingGrams ?? null) : null,
      servingLabel,
      perAmount: size,
    };
  }
  return { unit, servingCount: null, servingGrams: size, servingLabel, perAmount: size };
}

function foodFromForm(id) {
  const form = readForm();
  const parts = fromLabelTotals(form);
  const existing = state.foods.find((f) => f.id === id);
  return {
    ...(existing || {}),
    id,
    category: form.category,
    name: form.name || existing?.name || "New food",
    ...servingFields(form, existing),
    ...parts,
    micros: storedMicros(form),
    source: form.source || existing?.source || "Typed from a label",
    approx: existing ? existing.approx : true,
    listId: existing?.listId || listForPerson(person),
  };
}

async function saveNewFood() {
  const food = foodFromForm(`custom-${crypto.randomUUID()}`);
  state.foods.push(food);
  persist();
  await cloud(() => pushFood(food));
  draft.category = food.category;
  draft.foodId = food.id;
  draft.unit = food.unit;
  view = searchReturn === "foods" ? "foods" : "add";
  editingId = "";
  lookup.form = null;
  skipCapture = true;
  notice = `${food.name} is in the list.`;
  render();
}

async function updateFood() {
  const food = foodFromForm(editingId);
  const index = state.foods.findIndex((f) => f.id === editingId);
  if (index >= 0) state.foods[index] = { ...state.foods[index], ...food, approx: state.foods[index].approx };
  persist();
  await cloud(() => pushFood(state.foods[index]));
  editingId = "";
  lookup.form = null;
  skipCapture = true;
  notice = "Saved.";
  render();
}

function entryFromLine(food, amount, unit) {
  return {
    id: crypto.randomUUID(),
    person, date, meal: draft.meal,
    foodId: food.id,
    name: food.name,
    amount, unit,
    ...scaleFood(food, amount, unit),
  };
}

function finishEntrySave() {
  plate = [];
  draft.amount = "";
  draft.foodId = "";
  draft.foodQuery = "";
  editingMeal = "";
  supplementChecks = null;
  notice = "";
  view = "today";
  render();
}

async function addEntry() {
  const lines = plate.map((line) => ({ ...line }));
  const food = selectedFood();
  const typed = Number(draft.amount);
  if (food && typed > 0) lines.push({ foodId: food.id, amount: typed, unit: selectedUnit(), name: food.name });
  const usable = lines.filter((line) => Number(line.amount) > 0);
  if (!usable.length && !editingMeal) {
    notice = "Choose a food and an amount.";
    render();
    return;
  }
  const keptIds = new Set();
  const written = [];
  for (const line of usable) {
    const existing = line.entryId ? state.entries.find((entry) => entry.id === line.entryId) : null;
    const source = currentFoods().find((item) => item.id === line.foodId);
    const same = existing && existing.foodId === line.foodId && existing.unit === line.unit && Number(existing.amount) > 0;
    if (!same && !source) continue;
    const useUnit = same ? existing.unit : (line.unit || source.unit);
    const scaled = same ? scaleSnapshot(existing, line.amount) : scaleFood(source, line.amount, useUnit);
    const entry = {
      ...(existing || {}),
      id: existing ? existing.id : crypto.randomUUID(),
      person,
      date,
      meal: draft.meal,
      foodId: same ? existing.foodId : source.id,
      name: same ? existing.name : source.name,
      amount: Number(line.amount),
      unit: useUnit,
      ...scaled,
    };
    const index = state.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) state.entries[index] = entry;
    else state.entries.push(entry);
    keptIds.add(entry.id);
    written.push(entry);
  }
  const removed = editingMeal
    ? state.entries
      .filter((entry) => entry.person === person && entry.date === date && entry.meal === editingMeal && !keptIds.has(entry.id))
      .map((entry) => entry.id)
    : [];
  if (!written.length && !removed.length) {
    notice = "Choose a food and an amount.";
    render();
    return;
  }
  if (removed.length) state.entries = state.entries.filter((entry) => !removed.includes(entry.id));
  persist();
  for (const entry of written) await cloud(() => pushEntry(entry));
  for (const id of removed) await cloud(() => removeEntryRemote(id));
  finishEntrySave();
}

function addAnother() {
  const food = selectedFood();
  const amount = Number(draft.amount);
  if (!food || !(amount > 0)) {
    notice = "Choose a food and an amount.";
    render();
    return;
  }
  plate.push({ foodId: food.id, amount: draft.amount, unit: selectedUnit(), name: food.name });
  draft.foodId = "";
  draft.amount = "";
  draft.foodQuery = "";
  notice = "";
  render();
}

async function saveSupplementTicks() {
  ensureSupplementChecks();
  for (const target of supplementTargets()) {
    const food = currentFoods().find((item) => item.id === target.foodId);
    if (!food) continue;
    const desired = Math.max(0, Math.round(Number(supplementChecks[target.foodId]) || 0));
    let have = takenServings(food.id);
    if (desired > have) {
      const entry = entryFromLine(food, desired - have, "count");
      entry.supplement = true;
      state.entries.push(entry);
      persist();
      await cloud(() => pushEntry(entry));
      continue;
    }
    let extra = have - desired;
    const rows = state.entries.filter((entry) => entry.person === person && entry.date === date && entry.foodId === food.id && entry.unit === "count");
    for (let index = rows.length - 1; index >= 0 && extra > 0; index -= 1) {
      const entry = rows[index];
      const amount = Number(entry.amount) || 0;
      if (amount <= extra + 0.001) {
        extra -= amount;
        state.entries = state.entries.filter((item) => item.id !== entry.id);
        await cloud(() => removeEntryRemote(entry.id));
      } else {
        const nextAmount = round1(amount - extra);
        const scaled = amount > 0 ? scaleSnapshot(entry, nextAmount) : scaleFood(food, nextAmount, "count");
        const updated = { ...entry, amount: nextAmount, ...scaled };
        const at = state.entries.findIndex((item) => item.id === entry.id);
        if (at >= 0) state.entries[at] = updated;
        await cloud(() => pushEntry(updated));
        extra = 0;
      }
    }
    persist();
  }
  supplementChecks = null;
  notice = "Supplements saved.";
  render();
}

async function deleteEntry(id) {
  state.entries = state.entries.filter((e) => e.id !== id);
  persist();
  await cloud(() => removeEntryRemote(id));
  render();
}

async function deleteFood(id) {
  const food = state.foods.find((item) => item.id === id);
  if (!food) return;
  const logged = state.entries.some((entry) => entry.foodId === id);
  const warning = logged
    ? `Delete ${food.name} from the menu? Meals already logged keep their numbers.`
    : `Delete ${food.name} from the menu?`;
  if (!window.confirm(warning)) return;
  state.foods = state.foods.filter((item) => item.id !== id);
  if (editingId === id) editingId = "";
  lookup.form = null;
  persist();
  await cloud(() => removeFoodRemote(id));
  notice = "Dish deleted.";
  render();
}

function zeroSnapshot(entry) {
  return ["kcal", "protein", "fatUnsat", "fatSat", "carbOther", "sugar", "fiber"]
    .every((key) => !Number(entry[key]));
}

function entryUnitNeedsRepair(entry) {
  const food = state.foods.find((f) => f.id === entry.foodId);
  if (!food || food.unit !== "count" || entry.unit === "count") return false;
  if (entry.unit === "g" && Number(food.servingGrams) > 0) return false;
  if (!(Number(entry.amount) > 0)) return false;
  return zeroSnapshot(entry);
}

async function repairEntryUnits() {
  const fixed = [];
  state.entries = state.entries.map((entry) => {
    if (!entryUnitNeedsRepair(entry)) return entry;
    const food = state.foods.find((f) => f.id === entry.foodId);
    const next = { ...entry, unit: "count", ...scaleFood(food, entry.amount, "count") };
    fixed.push(next);
    return next;
  });
  if (!fixed.length) return;
  persist();
  for (const entry of fixed) await cloud(() => pushEntry(entry));
}

function readExerciseName() {
  return document.getElementById("exercise")?.value ?? "";
}

function renameExercise(index, raw) {
  const list = exerciseSets();
  const previous = list[index];
  const name = String(raw || "").trim();
  if (!previous || !name || name === previous) return;
  if (list.some((item, itemIndex) => itemIndex !== index && item === name)) return;
  list[index] = name;
  writeExercises(list);
  const changed = [];
  state.days = state.days.map((day) => {
    if (day.person !== person || day.exercise !== previous) return day;
    const updated = { ...day, exercise: name };
    changed.push(updated);
    return updated;
  });
  if (!changed.length) return;
  persist();
  for (const day of changed) cloud(() => pushDay(day));
}

function matchesCalorieGuess(burnedText, guess) {
  if (burnedText === "") return true;
  const typed = Number(burnedText);
  if (!Number.isFinite(typed)) return false;
  return Math.abs(typed - guess) < 0.05;
}

function saveDayFromInputs(source) {
  const existing = state.days.find((d) => d.person === person && d.date === date) || { steps: 0, burned: 0, minutes: 0, exercise: "" };
  const steps = Number(document.getElementById("steps")?.value) || 0;
  const minutes = Number(document.getElementById("minutes")?.value) || 0;
  const exercise = readExerciseName();
  let burnedText = document.getElementById("burned")?.value ?? "";
  if (source === "activity") {
    const previous = activityCalories(existing.steps, existing.minutes, existing.exercise);
    const stepsOnly = activityCalories(existing.steps, 0, "");
    const following = matchesCalorieGuess(burnedText, previous)
      || ((Number(existing.minutes) || 0) > 0 && matchesCalorieGuess(burnedText, stepsOnly));
    if (following) {
      const next = activityCalories(steps, minutes, exercise);
      burnedText = next ? String(next) : "";
      const box = document.getElementById("burned");
      if (box) box.value = burnedText;
    }
  }
  const day = {
    person,
    date,
    exercise,
    minutes,
    steps,
    burned: Number(burnedText) || 0,
  };
  const index = state.days.findIndex((d) => d.person === person && d.date === date);
  if (index >= 0) state.days[index] = day;
  else state.days.push(day);
  persist();
  cloud(() => pushDay(day));
}

async function repairStepOnlyBurn() {
  const changed = [];
  state.days = state.days.map((day) => {
    const minutes = Number(day.minutes) || 0;
    if (!minutes) return day;
    const stepsOnly = activityCalories(day.steps, 0, "");
    const burned = Number(day.burned) || 0;
    if (Math.abs(burned - stepsOnly) >= 0.05) return day;
    const next = activityCalories(day.steps, minutes, day.exercise);
    if (Math.abs(next - burned) < 0.05) return day;
    const updated = { ...day, burned: next };
    changed.push(updated);
    return updated;
  });
  if (!changed.length) return;
  persist();
  for (const day of changed) await cloud(() => pushDay(day));
}

function saveGoalField(key, value) {
  const next = { ...goals(), [key]: Number(value) || 0 };
  state.goals[person] = next;
  persist();
  cloud(() => pushGoals(person, next));
}

function saveMinimum(bag, key, value) {
  const next = { ...goals(), [bag]: { ...goals()[bag], [key]: Number(value) || 0 } };
  state.goals[person] = next;
  persist();
  cloud(() => pushGoals(person, next));
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadLog(from, to) {
  const header = ["Date", "Exercise", "Steps", "Cal_burned", "Calories", "Protein", "Fat_unsat", "Fat_sat", "Carb_other", "Sugar", "Fibre", "Fat", "Carbohydrate", "Vitamins", "Minerals", "Foods"];
  const lines = [header.join(",")];
  const keys = new Set(state.entries.filter((e) => e.person === person).map((e) => e.date));
  for (const day of state.days) if (day.person === person) keys.add(day.date);
  const rows = [...keys].sort().filter((when) => (!from || when >= from) && (!to || when <= to));
  for (const when of rows) {
    const entries = state.entries.filter((e) => e.person === person && e.date === when);
    const totals = sumEntries(entries);
    const g = state.goals[person] || defaultGoals()[person];
    const meta = state.days.find((d) => d.person === person && d.date === when) || {};
    const cells = [
      when, meta.exercise || "", meta.steps || 0, meta.burned || 0, round1(totals.kcal), totals.protein,
      totals.fatUnsat, totals.fatSat, totals.carbOther, totals.sugar, totals.fiber,
      totals.fat, totals.carb,
      `${hitCount(totals, VITAMINS.map(([k]) => k), g.vitamins)}/${VITAMINS.length}`,
      `${hitCount(totals, MINERALS.map(([k]) => k), g.minerals)}/${MINERALS.length}`,
      foodsText(entries),
    ];
    lines.push(cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","));
  }
  const filename = from && to ? `diet-log-${person}-${from}-to-${to}.csv` : `diet-log-${person}.csv`;
  download(filename, lines.join("\n"), "text/csv");
}

let searchTimer = 0;
async function runSearch(q) {
  lookup.q = q;
  lookup.saved = searchSaved(currentFoods(), q);
  lookup.found = searchDishes(dishes, q);
  lookup.status = q.trim().length < 2 ? "Type at least 2 letters." : "Searching packaged foods…";
  render();
  if (q.trim().length < 2) return;
  try {
    const [off, usda] = await Promise.all([
      searchOpenFoodFacts(q).catch(() => []),
      searchUsda(q, loadConfig().usdaKey || "").catch(() => []),
    ]);
    if (lookup.q !== q) return;
    const seen = new Set(lookup.found.map((f) => f.name.toLowerCase()));
    for (const food of [...usda, ...off]) {
      if (seen.has(food.name.toLowerCase())) continue;
      seen.add(food.name.toLowerCase());
      lookup.found.push(food);
    }
    lookup.status = lookup.found.length ? "Pick a match, then confirm the numbers." : "No published match. Enter the label yourself.";
  } catch (err) {
    lookup.status = "The food search did not answer. You can still type the numbers.";
  }
  render();
}

function applyPreview() {
  person = "surya";
  date = todayISO();
  const add = (meal, match, amount, unit) => {
    const food = state.foods.find((f) => f.name.toLowerCase().includes(match.toLowerCase()));
    if (!food) return;
    const scaled = scaleFood(food, amount, unit);
    state.entries.push({
      id: crypto.randomUUID(), person, date, meal, foodId: food.id, name: food.name, amount, unit, ...scaled,
    });
  };
  add("Lunch", "Chicken Breast", 180, "g");
  add("Snack", "Oikos Pro", 140, "g");
  add("Snack", "berry", 100, "g");
  add("Protocol", "B12", 1, "count");
  add("Protocol", "Greens", 1, "count");
}

function onClick(e) {
  const navBtn = e.target.closest("[data-nav]");
  if (navBtn) {
    const next = navBtn.dataset.nav;
    const keepPlate = next === "search" || (next === "add" && (view === "add" || view === "search"));
    if (!keepPlate) {
      editingMeal = "";
      plate = [];
    }
    if (next === "search") {
      searchReturn = view === "foods" ? "foods" : "add";
      lookup = { q: "", saved: [], found: [], status: "", form: null };
      editingId = "";
      skipCapture = true;
    }
    view = next;
    notice = "";
    if (view !== "search") {
      lookup.form = null;
      skipCapture = true;
    }
    render();
    return;
  }
  const meal = e.target.closest("[data-meal]");
  if (meal) { draft.meal = meal.dataset.meal; render(); return; }
  if (e.target.id === "unit-toggle") {
    draft.unit = selectedUnit() === "count" ? "g" : "count";
    render();
    return;
  }
  if (e.target.id === "save-entry") { addEntry(); return; }
  if (e.target.id === "add-another") { addAnother(); return; }
  if (e.target.id === "save-supplements") { saveSupplementTicks(); return; }
  const plateRemove = e.target.closest("[data-plate]");
  if (plateRemove) {
    plate.splice(Number(plateRemove.dataset.plate), 1);
    render();
    return;
  }
  const foodPick = e.target.closest("[data-food]");
  if (foodPick) {
    const picked = currentFoods().find((item) => item.id === foodPick.dataset.food);
    if (!picked) return;
    draft.category = picked.category;
    draft.foodId = picked.id;
    draft.unit = picked.unit;
    draft.foodQuery = "";
    render();
    return;
  }
  const tick = e.target.closest("[data-supp]");
  if (tick) {
    ensureSupplementChecks();
    const foodId = tick.dataset.supp;
    const n = Number(tick.dataset.n) || 0;
    const current = Number(supplementChecks[foodId]) || 0;
    supplementChecks[foodId] = current === n ? n - 1 : n;
    render();
    return;
  }
  if (e.target.id === "supp-add") {
    const foodId = document.getElementById("supp-food")?.value || "";
    const count = Math.max(1, Math.round(Number(document.getElementById("supp-count")?.value) || 1));
    if (!foodId) {
      notice = "Choose a supplement.";
      render();
      return;
    }
    const list = (goals().supplements || []).filter((item) => item.foodId && item.foodId !== foodId);
    list.push({ foodId, count });
    writeSupplements(list);
    supplementChecks = null;
    notice = "";
    render();
    return;
  }
  if (e.target.id === "exercise-add") {
    const name = document.getElementById("exercise-add-name")?.value.trim() || "";
    const list = exerciseSets();
    if (name && !list.includes(name)) writeExercises([...list, name]);
    notice = "";
    render();
    return;
  }
  const exerciseRemove = e.target.closest("[data-exercise-remove]");
  if (exerciseRemove) {
    const index = Number(exerciseRemove.dataset.exerciseRemove);
    writeExercises(exerciseSets().filter((_, itemIndex) => itemIndex !== index));
    render();
    return;
  }
  const suppRemove = e.target.closest("[data-supp-remove]");
  if (suppRemove) {
    writeSupplements((goals().supplements || []).filter((item) => item.foodId !== suppRemove.dataset.suppRemove));
    supplementChecks = null;
    render();
    return;
  }
  if (e.target.id === "delete-food") { deleteFood(editingId); return; }
  const del = e.target.closest("[data-del]");
  if (del) { deleteEntry(del.dataset.del); return; }
  const mealEdit = e.target.closest("[data-meal-edit]");
  if (mealEdit) { beginEditMeal(mealEdit.dataset.mealEdit); return; }
  const jump = e.target.closest("[data-date]");
  if (jump) { date = jump.dataset.date; view = "today"; render(); return; }
  const edit = e.target.closest("[data-edit]");
  if (edit) {
    skipCapture = true;
    lookup.form = null;
    editingId = edit.dataset.edit;
    scrollTarget = "food-editor";
    render();
    return;
  }
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    const index = Number(pick.dataset.pick);
    const saved = lookup.saved.map((f) => ({ kind: "saved", food: f }));
    const found = lookup.found.map((f) => ({ kind: "new", food: f }));
    const item = [...saved, ...found][index];
    if (!item) return;
    if (item.kind === "saved") {
      draft.category = item.food.category;
      draft.foodId = item.food.id;
      draft.unit = item.food.unit;
      view = "add";
      render();
      return;
    }
    const food = item.food;
    skipCapture = true;
    lookup.form = formFromSearch(food);
    scrollTarget = "food-editor";
    render();
    return;
  }
  if (e.target.id === "search-back") {
    skipCapture = true;
    lookup.form = null;
    view = searchReturn === "foods" ? "foods" : "add";
    render();
    return;
  }
  if (e.target.id === "blank-food") {
    skipCapture = true;
    lookup.form = {
      name: lookup.q, category: "", newCategory: false, newCategoryName: "",
      kcal: "", protein: "", fat: "", sat: "", carb: "", sugar: "", fiber: "", cholesterol: "",
      source: "Typed from a label", serving: "100", servingUnit: "g", numberBasis: 100,
      micros: blankMicros(), showMicros: false,
    };
    scrollTarget = "food-editor";
    render();
    return;
  }
  if (e.target.id === "show-micros") {
    captureFoodForm();
    if (lookup.form) lookup.form.showMicros = true;
    skipCapture = true;
    render();
    return;
  }
  if (e.target.id === "save-food") { captureFoodForm(); saveNewFood(); return; }
  if (e.target.id === "update-food") { captureFoodForm(); updateFood(); return; }
  if (e.target.id === "cancel-edit") {
    editingMeal = "";
    plate = [];
    draft.amount = "";
    draft.foodId = "";
    draft.foodQuery = "";
    view = "today";
    render();
    return;
  }
  if (e.target.id === "download") { downloadLog(); return; }
  if (e.target.id === "download-range") {
    if (!logFrom || !logTo || logFrom > logTo) {
      notice = "Choose a start date and an end date.";
      render();
      return;
    }
    downloadLog(logFrom, logTo);
    return;
  }
  if (e.target.id === "export") {
    download("diet-log-backup.json", JSON.stringify({ foods: state.foods, entries: state.entries, days: state.days, goals: state.goals }, null, 2), "application/json");
  }
  if (e.target.id === "save-config") {
    saveConfig({
      supabaseUrl: document.getElementById("sb-url").value,
      supabaseKey: document.getElementById("sb-key").value,
      usdaKey: document.getElementById("usda-key").value,
    });
    resetClient();
    boot();
  }
}

function onChange(e) {
  if (e.target.id === "person") {
    person = e.target.value;
    localStorage.setItem("diet-log-person", person);
    if (draft.foodId && !currentFoods().some((f) => f.id === draft.foodId)) {
      draft.category = "";
      draft.foodId = "";
      draft.unit = "";
    }
    if (editingId && !currentFoods().some((f) => f.id === editingId)) {
      editingId = "";
      lookup.form = null;
      skipCapture = true;
    }
    logFrom = "";
    logTo = "";
    logRangeCustom = false;
    plate = [];
    editingMeal = "";
    supplementChecks = null;
    draft.foodQuery = "";
    render();
    return;
  }
  if (e.target.id === "date") { date = e.target.value || todayISO(); supplementChecks = null; render(); return; }
  if (e.target.id === "nf-serving") {
    applyServingResize();
    skipCapture = true;
    render();
    return;
  }
  if (e.target.dataset.suppCount) {
    const foodId = e.target.dataset.suppCount;
    const count = Math.max(1, Math.round(Number(e.target.value) || 1));
    writeSupplements((goals().supplements || []).map((item) => item.foodId === foodId ? { ...item, count } : item));
    supplementChecks = null;
    render();
    return;
  }
  if (e.target.id === "exercise") {
    saveDayFromInputs("activity");
    render();
    return;
  }
  const exerciseName = e.target.closest("[data-exercise-name]");
  if (exerciseName) {
    renameExercise(Number(exerciseName.dataset.exerciseName), exerciseName.value);
    render();
    return;
  }
  if (e.target.id === "log-from" || e.target.id === "log-to") {
    logFrom = document.getElementById("log-from")?.value || "";
    logTo = document.getElementById("log-to")?.value || "";
    logRangeCustom = true;
    render();
    return;
  }
  if (e.target.id === "resting-burn") {
    saveGoalField("restingBurn", e.target.value);
    render();
    return;
  }
  if (e.target.id === "nf-cat") { render(); return; }
  if (e.target.id === "category") {
    draft.category = e.target.value;
    draft.foodId = "";
    draft.unit = "";
    render();
    return;
  }
  if (e.target.id === "food") {
    draft.foodId = e.target.value;
    draft.unit = allowedUnit(selectedFood(), "");
    render();
    return;
  }
  if (e.target.dataset.goal) { saveGoalField(e.target.dataset.goal, e.target.value); return; }
  if (e.target.dataset.min) { saveMinimum(e.target.dataset.bag, e.target.dataset.min, e.target.value); return; }
  if (e.target.id === "import" && e.target.files?.[0]) {
    const file = e.target.files[0];
    file.text().then(async (text) => {
      const data = JSON.parse(text);
      if (data.foods) state.foods = data.foods.map(normalizeFood);
      if (data.entries) state.entries = data.entries;
      if (data.days) state.days = data.days;
      if (data.goals) state.goals = { ...defaultGoals(), ...data.goals };
      persist();
      if (mode === "shared") {
        await cloud(async () => {
          for (const food of state.foods) await pushFood(food);
          for (const entry of state.entries) await pushEntry(entry);
          for (const day of state.days) await pushDay(day);
          for (const [who, g] of Object.entries(state.goals)) await pushGoals(who, g);
        });
      }
      notice = "Backup imported.";
      render();
    }).catch(() => { notice = "That file is not a diet log backup."; render(); });
  }
}

function onInput(e) {
  const plateAmount = e.target.closest("[data-plate-amount]");
  if (plateAmount) {
    const index = Number(plateAmount.dataset.plateAmount);
    if (plate[index]) plate[index].amount = e.target.value;
    render();
    return;
  }
  if (e.target.id === "amount") {
    draft.amount = e.target.value;
    const box = document.getElementById("portion");
    if (box) box.innerHTML = portionHTML(portionForDraft());
    return;
  }
  if (e.target.id === "food-query") {
    draft.foodQuery = e.target.value;
    render();
    return;
  }
  if (e.target.id === "minutes" || e.target.id === "steps") { saveDayFromInputs("activity"); return; }
  if (e.target.id === "burned") { saveDayFromInputs(); return; }
  if (e.target.id === "food-filter") {
    draft.foodFilter = e.target.value;
    render();
    return;
  }
  if (e.target.id === "q") {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => runSearch(q), 350);
  }
}

async function applyBundledConfig() {
  try {
    const bundled = await import("./config.local.js");
    if (bundled.supabaseUrl && bundled.supabaseKey) {
      const existing = loadConfig();
      saveConfig({
        supabaseUrl: bundled.supabaseUrl,
        supabaseKey: bundled.supabaseKey,
        usdaKey: existing.usdaKey || "",
      });
    }
  } catch {
    // The hosted site has no config.local.js. Goals still accepts a pasted key.
  }
}

async function boot() {
  await applyBundledConfig();
  state = loadLocal(foodsSeed);
  if (preview) {
    state.entries = [];
    state.days = [];
    applyPreview();
  }
  if (!PEOPLE.some((p) => p.id === person)) person = "surya";
  await repairEntryUnits();
  await repairStepOnlyBurn();
  render();
  if (params.has("e2e")) {
    ready = true;
    await runE2E();
    return;
  }
  if (preview) {
    ready = true;
    render();
    return;
  }
  try {
    const remote = await pullRemote(foodsSeed);
    if (remote.state) {
      const localDays = state.days;
      state = remote.state;
      state.days = state.days.map((day) => {
        if (day.steps != null && day.minutes != null) return day;
        const local = localDays.find((item) => item.person === day.person && item.date === day.date);
        if (!local) return { ...day, steps: day.steps || 0, minutes: day.minutes || 0 };
        return {
          ...day,
          steps: day.steps == null ? (local.steps || 0) : day.steps,
          minutes: day.minutes == null ? (local.minutes || 0) : day.minutes,
        };
      });
      mode = "shared";
      syncError = "";
      saveLocal(state);
      await repairEntryUnits();
      await repairStepOnlyBurn();
    } else {
      mode = "local";
      syncError = remote.error || "";
    }
  } catch (err) {
    mode = "local";
    syncError = err.message || String(err);
  }
  ready = true;
  render();
}

async function runE2E() {
  state.entries = [];
  person = "surya";
  date = todayISO();
  const chicken = state.foods.find((f) => f.name.startsWith("Chicken Breast"));
  draft = { meal: "Lunch", category: chicken.category, foodId: chicken.id, amount: "180", unit: "g" };
  view = "add";
  render();
  await addEntry();
  const samb = searchDishes(dishes, "cayote sambhar")[0];
  lookup.form = {
    name: "Watery chayote dal sambhar",
    category: samb.category,
    kcal: samb.kcal,
    protein: samb.protein,
    fat: fatTotal(samb),
    sat: "",
    carb: carbTotal(samb),
    sugar: samb.sugar,
    fiber: samb.fiber,
    source: samb.source,
  };
  view = "search";
  render();
  await saveNewFood();
  draft.amount = "350";
  draft.unit = "g";
  await addEntry();
  const text = document.body.innerText;
  const pass = text.includes("Chicken") && text.includes("chayote") && text.includes("350");
  const flag = document.createElement("pre");
  flag.id = "e2e";
  flag.textContent = pass ? "E2E PASS" : `E2E FAIL ${text.slice(0, 500)}`;
  app.prepend(flag);
}

if (params.has("selftest")) {
  const lines = selfTest(foodsSeed);
  app.innerHTML = `<pre id="selftest">${lines.join("\n")}</pre>`;
} else {
  app.addEventListener("click", onClick);
  app.addEventListener("change", onChange);
  app.addEventListener("input", onInput);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && mode === "shared") boot();
  });
  boot();
}

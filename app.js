import {
  PEOPLE, MEALS, VITAMINS, MINERALS, defaultGoals, listForPerson, normalizeFood,
  scaleFood, sumEntries, hitCount, foodsText, mealGroups, microValue,
  todayISO, formatDate, fatTotal, carbTotal, fromLabelTotals, selfTest, round1,
} from "./calc.js";
import { searchDishes, searchSaved, searchOpenFoodFacts, searchUsda } from "./search.js";
import {
  loadLocal, saveLocal, loadConfig, saveConfig, pullRemote, pushFood, pushEntry,
  removeEntryRemote, pushDay, pushGoals, resetClient,
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
let draft = { meal: "Lunch", category: "", foodId: "", amount: "", unit: "" };
let lookup = { q: "", saved: [], found: [], status: "", form: null };
let editingId = "";
let editingEntryId = "";
let logFrom = "";
let logTo = "";

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
  };
}

function dayEntries() {
  return state.entries.filter((e) => e.person === person && e.date === date);
}

function dayMeta() {
  return state.days.find((d) => d.person === person && d.date === date) || { exercise: "", burned: 0 };
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
  const entries = dayEntries();
  const totals = sumEntries(entries);
  const g = goals();
  const meta = dayMeta();
  const groups = mealGroups(entries);
  const vit = hitCount(totals, VITAMINS.map(([k]) => k), g.vitamins);
  const min = hitCount(totals, MINERALS.map(([k]) => k), g.minerals);
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
  const lines = entries.map((e) => `
    <div class="entry">
      <div><b>${esc(e.meal)}</b> · ${esc(loggedAmount(e))} ${esc(e.name)}
        <div class="hint">${kcal(e.kcal)} kcal · ${fmt(e.protein)} g protein</div>
      </div>
      <div class="entry-actions">
        <button type="button" class="textbtn" data-entry="${esc(e.id)}">Edit</button>
        <button type="button" class="x" data-del="${esc(e.id)}" aria-label="Remove">×</button>
      </div>
    </div>`).join("");
  return `
    <div class="top">
      <div>
        <h1>Record</h1>
        <p class="sub">${esc(formatDate(date))}${meta.exercise ? ` · ${esc(meta.exercise)}` : ""} · ${kcal(meta.burned)} kcal burned</p>
      </div>
      <select class="who" id="person">${PEOPLE.map((p) => `<option value="${p.id}" ${p.id === person ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
    </div>
    ${banner()}
    <div class="field"><label class="label" for="date">Date</label><input class="textin" id="date" type="date" value="${esc(date)}"></div>
    <div class="pair">
      <div class="field"><label class="label" for="exercise">Exercise</label><input class="textin" id="exercise" value="${esc(meta.exercise)}" placeholder="Rest"></div>
      <div class="field"><label class="label" for="burned">Burned</label><input class="textin" id="burned" inputmode="decimal" value="${meta.burned || ""}" placeholder="0"></div>
    </div>
    <div class="card">
      <div class="metric"><div class="name">Calories</div><div class="val">${kcal(totals.kcal)} <span>of ${kcal(g.kcal)}</span></div>${bar(totals.kcal, g.kcal, "var(--copper)", true)}</div>
      <div class="metric"><div class="name">Protein</div><div class="val">${fmt(totals.protein)} g <span>of ${fmt(g.protein)} g</span></div>${bar(totals.protein, g.protein, "var(--sage)", false)}</div>
      <div class="metric"><div class="name">Fat</div><div class="val">${fmt(totals.fat)} g <span>of ${fmt(g.fatMax)} g max</span></div>${bar(totals.fat, g.fatMax, "var(--wheat)", true)}<div class="note">${fatNote(totals)}</div></div>
      <div class="metric"><div class="name">Carbohydrate</div><div class="val">${fmt(totals.carb)} g <span>of ${fmt(g.carbMax)} g max</span></div>${bar(totals.carb, g.carbMax, "var(--copper)", true)}<div class="note">${fmt(totals.carbOther)} g other · ${fmt(totals.sugar)} g sugar · ${fmt(totals.fiber)} g fiber</div></div>
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

function entryBeingEdited() {
  return state.entries.find((e) => e.id === editingEntryId) || null;
}

function scaleSnapshot(entry, amount) {
  const ratio = Number(amount) / Number(entry.amount);
  const n = (v) => round1((Number(v) || 0) * ratio);
  const micros = {};
  for (const [k, v] of Object.entries(entry.micros || {})) micros[k] = n(v);
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
    micros,
  };
}

function portionForDraft() {
  const amount = Number(draft.amount);
  if (!(amount > 0)) return null;
  const food = selectedFood();
  const unit = selectedUnit();
  const editing = entryBeingEdited();
  if (editing && (!food || (food.id === editing.foodId && unit === editing.unit)) && Number(editing.amount) > 0) {
    return scaleSnapshot(editing, amount);
  }
  if (!food) return null;
  return scaleFood(food, amount, unit);
}

function beginEditEntry(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  editingEntryId = id;
  date = entry.date;
  const food = currentFoods().find((f) => f.id === entry.foodId);
  draft.meal = entry.meal;
  draft.category = food ? food.category : "";
  draft.foodId = food ? food.id : "";
  draft.amount = String(entry.amount);
  draft.unit = allowedUnit(food, entry.unit);
  notice = "";
  view = "add";
  render();
}

function fatNote(t) {
  const known = `${fmt(t.fatUnsat)} g unsaturated · ${fmt(t.fatSat)} g saturated`;
  if (t.fatUnsplit > 0) return `${known} · ${fmt(t.fatUnsplit)} g without a split`;
  return known;
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

function dayButton(d, entries) {
  const t = sumEntries(entries);
  return `<button type="button" class="dayrow" data-date="${esc(d)}"><b>${esc(formatDate(d))}</b><br><span>${kcal(t.kcal)} kcal · ${fmt(t.protein)} g protein · ${fmt(t.fat)} g fat · ${fmt(t.carb)} g carbs</span></button>`;
}

function logView() {
  const byDate = entriesByDate();
  const dates = [...byDate.keys()].sort().reverse();
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
    ${rangeRows ? `<div class="card">${rangeRows}</div>` : `<p class="hint">${esc(rangeNote)}</p>`}
    <button class="textbtn centerlink" type="button" id="download-range">Download this range</button>`;
}

function addView() {
  const editing = entryBeingEdited();
  const food = selectedFood();
  const unit = selectedUnit();
  const cats = categories();
  const list = foodsInCategory();
  const canGrams = food && food.servingGrams;
  const portion = portionForDraft();
  return `
    <div class="top"><div><h1>${editing ? "Edit" : "Add"}</h1><p class="sub">${esc(formatDate(date))} · ${editing ? `Editing ${esc(editing.name)}` : esc(personName())}</p></div></div>
    <div class="field"><div class="label">Meal</div><div class="segs">${MEALS.map((m) => `<button type="button" class="seg ${draft.meal === m ? "on" : ""}" data-meal="${esc(m)}">${esc(m)}</button>`).join("")}</div></div>
    <div class="field"><label class="label" for="category">Category</label>
      <select class="select" id="category"><option value="">Choose</option>${cats.map((c) => `<option ${c === draft.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="field"><label class="label" for="food">Food</label>
      <select class="select" id="food" ${draft.category ? "" : "disabled"}><option value="">Choose</option>${list.map((f) => `<option value="${esc(f.id)}" ${f.id === draft.foodId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>
    </div>
    <div class="field"><label class="label" for="amount">Amount</label>
      <div class="amount"><input id="amount" inputmode="decimal" value="${esc(draft.amount)}" placeholder="0"><span class="unit">${unitWord(unit)}</span></div>
      <p class="hint">${food ? `List serving is ${esc(food.servingLabel)}.` : "Choose a food."} ${food?.unit === "count" && canGrams ? "You can switch to grams." : ""}</p>
      ${food?.unit === "count" && canGrams ? `<button type="button" class="textbtn" id="unit-toggle">Use ${unit === "count" ? "grams" : "count"} instead</button>` : ""}
    </div>
    <div class="card" id="portion">${portionHTML(portion)}</div>
    <button class="centerlink textbtn" type="button" data-nav="search">Food not in the list</button>
    ${editing ? `<button class="centerlink textbtn" type="button" id="cancel-edit">Cancel</button>` : ""}`;
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
    </div>
    <button class="btn" type="button" id="save-entry">${editingEntryId ? "Save changes" : "Add to today"}</button>`;
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
    source: food.source,
    serving: unit === "count" ? (food.servingCount || 1) : (food.servingGrams ?? ""),
    servingUnit: unit,
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
    source: food.source,
    serving: "100",
    servingUnit: "g",
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
    <p class="sub">Search fills published averages for 100 g. Set the serving, then confirm the numbers for that serving.</p>
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
    <div class="field"><label class="label">${esc(label)} (${esc(unit)})</label>
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
      <div class="label">${esc(heading)}</div>
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
      <p class="hint">The numbers below are for this serving.</p>
      <div class="pair">
        <div class="field"><label class="label">Calories</label><input class="mini" id="nf-kcal" inputmode="decimal" value="${esc(f.kcal)}"></div>
        <div class="field"><label class="label">Protein</label><input class="mini" id="nf-protein" inputmode="decimal" value="${esc(f.protein)}"></div>
        <div class="field"><label class="label">Total fat</label><input class="mini" id="nf-fat" inputmode="decimal" value="${esc(f.fat)}"></div>
        <div class="field"><label class="label">Saturated fat</label><input class="mini" id="nf-sat" inputmode="decimal" value="${esc(f.sat)}" placeholder="blank if unknown"></div>
        <div class="field"><label class="label">Total carbohydrate</label><input class="mini" id="nf-carb" inputmode="decimal" value="${esc(f.carb)}"></div>
        <div class="field"><label class="label">Sugar</label><input class="mini" id="nf-sugar" inputmode="decimal" value="${esc(f.sugar)}"></div>
        <div class="field"><label class="label">Fiber</label><input class="mini" id="nf-fiber" inputmode="decimal" value="${esc(f.fiber)}"></div>
      </div>
      <p class="hint">${esc(f.source || "")} Other carbs and unsaturated fat are what's left after sugar, fiber, and saturated fat.</p>
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
      <button type="button" class="dayrow" data-edit="${esc(f.id)}"><b>${esc(f.name)}</b><br><span>${esc(f.category)} · ${esc(f.servingLabel)} · ${kcal(f.kcal)} kcal${f.approx ? " · approximate" : ""}</span></button>
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
    <div class="field"><label class="label">${label} minimum (${unit})</label>
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
    <p class="hint">A vitamin or mineral counts when today's foods clear the minimum. Empty cells on a food do not count.</p>
    <details><summary>Vitamin minimums (${VITAMINS.length})</summary>${nutrient(VITAMINS, "vitamins")}</details>
    <details><summary>Mineral minimums (${MINERALS.length})</summary>${nutrient(MINERALS, "minerals")}</details>
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
    };
  }
  return { unit, servingCount: null, servingGrams: size, servingLabel };
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

async function addEntry() {
  const editing = entryBeingEdited();
  const food = selectedFood();
  const amount = Number(draft.amount);
  const unit = selectedUnit();
  if (!(amount > 0) || (!food && !editing)) {
    notice = "Choose a food and an amount.";
    render();
    return;
  }
  const scaled = editing && (!food || (food.id === editing.foodId && unit === editing.unit))
    ? scaleSnapshot(editing, amount)
    : scaleFood(food, amount, unit);
  const entry = {
    id: editing ? editing.id : crypto.randomUUID(),
    person, date, meal: draft.meal,
    foodId: food ? food.id : editing.foodId,
    name: food ? food.name : editing.name,
    amount, unit, ...scaled,
  };
  if (editing) {
    const index = state.entries.findIndex((e) => e.id === editing.id);
    state.entries[index] = entry;
  } else state.entries.push(entry);
  persist();
  await cloud(() => pushEntry(entry));
  draft.amount = "";
  editingEntryId = "";
  notice = "";
  view = "today";
  render();
}

async function deleteEntry(id) {
  state.entries = state.entries.filter((e) => e.id !== id);
  persist();
  await cloud(() => removeEntryRemote(id));
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

function saveDayFromInputs() {
  const exercise = document.getElementById("exercise")?.value ?? "";
  const burned = Number(document.getElementById("burned")?.value) || 0;
  const day = { person, date, exercise, burned };
  const index = state.days.findIndex((d) => d.person === person && d.date === date);
  if (index >= 0) state.days[index] = day;
  else state.days.push(day);
  persist();
  cloud(() => pushDay(day));
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
  const header = ["Date", "Exercise", "Cal_burned", "Calories", "Protein", "Fat_unsat", "Fat_sat", "Fat_unsplit", "Carb_other", "Sugar", "Fibre", "Fat", "Carbohydrate", "Vitamins", "Minerals", "Foods"];
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
      when, meta.exercise || "", meta.burned || 0, round1(totals.kcal), totals.protein,
      totals.fatUnsat, totals.fatSat, totals.fatUnsplit, totals.carbOther, totals.sugar, totals.fiber,
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
    if (!(next === "add" && editingEntryId && view === "add")) editingEntryId = "";
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
  const del = e.target.closest("[data-del]");
  if (del) { deleteEntry(del.dataset.del); return; }
  const entryBtn = e.target.closest("[data-entry]");
  if (entryBtn) { beginEditEntry(entryBtn.dataset.entry); return; }
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
      kcal: "", protein: "", fat: "", sat: "", carb: "", sugar: "", fiber: "",
      source: "Typed from a label", serving: "100", servingUnit: "g",
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
    editingEntryId = "";
    draft.amount = "";
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
    render();
    return;
  }
  if (e.target.id === "date") { date = e.target.value || todayISO(); render(); return; }
  if (e.target.id === "log-from" || e.target.id === "log-to") {
    logFrom = document.getElementById("log-from")?.value || "";
    logTo = document.getElementById("log-to")?.value || "";
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
  if (e.target.id === "amount") {
    draft.amount = e.target.value;
    const box = document.getElementById("portion");
    if (box) box.innerHTML = portionHTML(portionForDraft());
    return;
  }
  if (e.target.id === "exercise" || e.target.id === "burned") { saveDayFromInputs(); return; }
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
      state = remote.state;
      mode = "shared";
      syncError = "";
      saveLocal(state);
      await repairEntryUnits();
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

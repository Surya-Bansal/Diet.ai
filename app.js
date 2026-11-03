import {
  PEOPLE, MEALS, VITAMINS, MINERALS, defaultGoals, listForPerson, normalizeFood,
  scaleFood, sumEntries, hitCount, foodsText, mealGroups,
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
let person = localStorage.getItem("diet-log-person") || "surya";
let date = todayISO();
let notice = "";
let draft = { meal: "Lunch", category: "", foodId: "", amount: "", unit: "" };
let lookup = { q: "", saved: [], found: [], status: "", form: null };
let editingId = "";

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
  return state.goals[person] || defaultGoals()[person];
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

function selectedUnit() {
  const food = selectedFood();
  if (!food) return "g";
  return draft.unit || food.unit;
}

function icon(name) {
  const paths = {
    today: '<rect x="3" y="4" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M3 8h14M7 2.5v3M13 2.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    add: '<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M10 6.5v7M6.5 10h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    foods: '<path d="M4 5h12M4 10h12M4 15h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    goals: '<path d="M3 16h14M6 16V9M10 16V5M14 16V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  };
  return `<svg width="18" height="18" viewBox="0 0 20 20" fill="none">${paths[name]}</svg>`;
}

function nav(active) {
  const item = (id, label) => `<button type="button" data-nav="${id}" class="${active === id ? "on" : ""}">${icon(id)}${label}</button>`;
  return `<nav class="nav">${item("today", "Today")}${item("add", "Add")}${item("foods", "Foods")}${item("goals", "Goals")}</nav>`;
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
      <div><b>${esc(e.meal)}</b> · ${esc(e.unit === "count" ? `${fmt(e.amount)}x` : `${fmt(e.amount)} g`)} ${esc(e.name)}
        <div class="hint">${kcal(e.kcal)} kcal · ${fmt(e.protein)} g protein</div>
      </div>
      <button type="button" class="x" data-del="${esc(e.id)}" aria-label="Remove">×</button>
    </div>`).join("");
  const recent = recentDays();
  return `
    <div class="top">
      <div>
        <h1>Today</h1>
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
    ${lines ? `<div class="card">${lines}</div>` : `<button class="btn" type="button" data-nav="add">Add a food</button>`}
    ${recent}
    <button class="textbtn centerlink" type="button" id="download">Download ${esc(personName())}'s log</button>`;
}

function fatNote(t) {
  const known = `${fmt(t.fatUnsat)} g unsaturated · ${fmt(t.fatSat)} g saturated`;
  if (t.fatUnsplit > 0) return `${known} · ${fmt(t.fatUnsplit)} g without a split`;
  return known;
}

function recentDays() {
  const byDate = new Map();
  for (const e of state.entries) {
    if (e.person !== person) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const dates = [...byDate.keys()].sort().reverse().slice(0, 12);
  if (!dates.length) return "";
  const rows = dates.map((d) => {
    const t = sumEntries(byDate.get(d));
    return `<button type="button" class="dayrow" data-date="${d}"><b>${esc(formatDate(d))}</b><br><span>${kcal(t.kcal)} kcal · ${fmt(t.protein)} g protein · ${fmt(t.fat)} g fat · ${fmt(t.carb)} g carbs</span></button>`;
  }).join("");
  return `<h2>Log</h2><div class="card">${rows}</div>`;
}

function addView() {
  const food = selectedFood();
  const unit = selectedUnit();
  const cats = categories();
  const list = foodsInCategory();
  const canGrams = food && food.servingGrams;
  const portion = food && Number(draft.amount) > 0 ? scaleFood(food, draft.amount, unit) : null;
  return `
    <div class="top"><div><h1>Add</h1><p class="sub">${esc(formatDate(date))} · ${esc(personName())}</p></div></div>
    <div class="field"><div class="label">Meal</div><div class="segs">${MEALS.map((m) => `<button type="button" class="seg ${draft.meal === m ? "on" : ""}" data-meal="${esc(m)}">${esc(m)}</button>`).join("")}</div></div>
    <div class="field"><label class="label" for="category">Category</label>
      <select class="select" id="category"><option value="">Choose</option>${cats.map((c) => `<option ${c === draft.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="field"><label class="label" for="food">Food</label>
      <select class="select" id="food" ${draft.category ? "" : "disabled"}><option value="">Choose</option>${list.map((f) => `<option value="${esc(f.id)}" ${f.id === draft.foodId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>
    </div>
    <div class="field"><label class="label" for="amount">Amount</label>
      <div class="amount"><input id="amount" inputmode="decimal" value="${esc(draft.amount)}" placeholder="0"><span class="unit">${unit === "count" ? "servings" : "grams"}</span></div>
      <p class="hint">${food ? `List serving is ${esc(food.servingLabel)}.` : "Choose a food."} ${food?.unit === "count" && canGrams ? "You can switch to grams." : ""}</p>
      ${food?.unit === "count" && canGrams ? `<button type="button" class="textbtn" id="unit-toggle">Use ${unit === "count" ? "grams" : "servings"} instead</button>` : ""}
    </div>
    <div class="card" id="portion">${portionHTML(portion)}</div>
    <button class="centerlink textbtn" type="button" data-nav="search">Food not in the list</button>`;
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
    <button class="btn" type="button" id="save-entry">Add to today</button>`;
}

function searchView() {
  const results = [
    ...lookup.saved.map((f) => ({ kind: "saved", food: f })),
    ...lookup.found.map((f) => ({ kind: "new", food: f })),
  ];
  const form = lookup.form ? confirmForm() : "";
  return `
    <button class="back" type="button" data-nav="add">Back</button>
    <h1>New food</h1>
    <p class="sub">Search uses published averages per 100 g. You weigh only what you eat.</p>
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

function confirmForm(heading = "Confirm per 100 g", buttonId = "save-food", buttonLabel = "Save to the shared list") {
  const f = lookup.form;
  return `
    <div class="card">
      <div class="label">${esc(heading)}</div>
      <div class="field"><label class="label">Name</label><input class="textin" id="nf-name" value="${esc(f.name)}"></div>
      <div class="field"><label class="label">Category</label><input class="textin" id="nf-cat" value="${esc(f.category)}"></div>
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
    <h1>Foods</h1>
    <p class="sub">${esc(note)}</p>
    <div class="field"><input class="textin" id="food-filter" placeholder="Search" value="${esc(draft.foodFilter || "")}"></div>
    <div class="card">${rows || `<p class="hint">No foods yet. On Add, choose Food not in the list.</p>`}${list.length > 40 ? `<p class="hint">Showing 40. Search to narrow.</p>` : ""}</div>
    ${editingId ? editFoodCard() : ""}`;
}

function editFoodCard() {
  const f = state.foods.find((food) => food.id === editingId);
  if (!f) return "";
  lookup.form = {
    name: f.name, category: f.category, kcal: f.kcal, protein: f.protein,
    fat: fatTotal(f), sat: f.fatSplit === false ? "" : f.fatSat,
    carb: carbTotal(f), sugar: f.sugar, fiber: f.fiber, source: f.source,
  };
  return confirmForm("Per list serving", "update-food", "Save changes");
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
      ${syncError ? `<p class="warn">${esc(syncError)}</p>` : ""}
    </div>`;
}

function goalInput(key, label, value) {
  return `<div class="field"><label class="label">${label}</label><input class="mini" data-goal="${key}" inputmode="decimal" value="${esc(value)}"></div>`;
}

function render() {
  const focus = document.activeElement;
  const focusId = focus?.id;
  const start = focus?.selectionStart;
  const html = {
    today: todayView, add: addView, search: searchView, foods: foodsView, goals: goalsView,
  }[view] || todayView;
  const active = view === "search" ? "add" : (view === "today" || view === "foods" || view === "goals" ? view : "add");
  app.innerHTML = `<div class="screen">${html()}${notice ? `<p class="warn">${esc(notice)}</p>` : ""}</div>${nav(active)}`;
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (start != null && el.setSelectionRange) {
        try { el.setSelectionRange(start, start); } catch { /* number inputs */ }
      }
    }
  }
}

function readForm() {
  const val = (id) => document.getElementById(id)?.value ?? "";
  const satRaw = val("nf-sat");
  return {
    name: val("nf-name").trim(),
    category: val("nf-cat").trim() || "Added foods",
    kcal: val("nf-kcal"),
    protein: val("nf-protein"),
    fat: val("nf-fat"),
    sat: satRaw === "" ? null : satRaw,
    carb: val("nf-carb"),
    sugar: val("nf-sugar"),
    fiber: val("nf-fiber"),
    source: lookup.form?.source || "Typed from a label",
  };
}

function foodFromForm(id, keepServing) {
  const form = readForm();
  const parts = fromLabelTotals(form);
  const existing = state.foods.find((f) => f.id === id);
  if (keepServing && existing) {
    return {
      ...existing,
      name: form.name || existing.name,
      category: form.category,
      ...parts,
      source: form.source || existing.source,
    };
  }
  return {
    id,
    category: form.category,
    name: form.name || "New food",
    servingLabel: "100 g",
    servingGrams: 100,
    unit: "g",
    ...parts,
    micros: {},
    source: form.source,
    approx: true,
    listId: listForPerson(person),
  };
}

async function saveNewFood() {
  const food = foodFromForm(`custom-${crypto.randomUUID()}`);
  state.foods.push(food);
  persist();
  await cloud(() => pushFood(food));
  draft.category = food.category;
  draft.foodId = food.id;
  draft.unit = "g";
  view = "add";
  notice = `${food.name} is in the list.`;
  render();
}

async function updateFood() {
  const food = foodFromForm(editingId, true);
  const index = state.foods.findIndex((f) => f.id === editingId);
  if (index >= 0) state.foods[index] = { ...state.foods[index], ...food, approx: state.foods[index].approx };
  persist();
  await cloud(() => pushFood(state.foods[index]));
  editingId = "";
  notice = "Saved.";
  render();
}

async function addEntry() {
  const food = selectedFood();
  const amount = Number(draft.amount);
  if (!food || !(amount > 0)) {
    notice = "Choose a food and an amount.";
    render();
    return;
  }
  const unit = selectedUnit();
  const scaled = scaleFood(food, amount, unit);
  const entry = {
    id: crypto.randomUUID(),
    person, date, meal: draft.meal, foodId: food.id, name: food.name,
    amount, unit, ...scaled,
  };
  state.entries.push(entry);
  persist();
  await cloud(() => pushEntry(entry));
  draft.amount = "";
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

function downloadLog() {
  const header = ["Date", "Exercise", "Cal_burned", "Calories", "Protein", "Fat_unsat", "Fat_sat", "Fat_unsplit", "Carb_other", "Sugar", "Fibre", "Fat", "Carbohydrate", "Vitamins", "Minerals", "Foods"];
  const lines = [header.join(",")];
  const keys = new Set(state.entries.filter((e) => e.person === person).map((e) => e.date));
  for (const day of state.days) if (day.person === person) keys.add(day.date);
  const rows = [...keys].sort();
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
  download(`diet-log-${person}.csv`, lines.join("\n"), "text/csv");
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
    view = navBtn.dataset.nav;
    notice = "";
    if (view !== "search") lookup.form = null;
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
  const jump = e.target.closest("[data-date]");
  if (jump) { date = jump.dataset.date; view = "today"; render(); return; }
  const edit = e.target.closest("[data-edit]");
  if (edit) { editingId = edit.dataset.edit; render(); return; }
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
    lookup.form = {
      name: food.name, category: food.category, kcal: food.kcal, protein: food.protein,
      fat: fatTotal(food), sat: food.fatSplit === false ? "" : food.fatSat,
      carb: carbTotal(food), sugar: food.sugar, fiber: food.fiber, source: food.source,
    };
    render();
    return;
  }
  if (e.target.id === "blank-food") {
    lookup.form = { name: lookup.q, category: "Added foods", kcal: "", protein: "", fat: "", sat: "", carb: "", sugar: "", fiber: "", source: "Typed from a label" };
    render();
    return;
  }
  if (e.target.id === "save-food") { saveNewFood(); return; }
  if (e.target.id === "update-food") { updateFood(); return; }
  if (e.target.id === "download") { downloadLog(); return; }
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
    if (editingId && !currentFoods().some((f) => f.id === editingId)) editingId = "";
    render();
    return;
  }
  if (e.target.id === "date") { date = e.target.value || todayISO(); render(); return; }
  if (e.target.id === "category") {
    draft.category = e.target.value;
    draft.foodId = "";
    draft.unit = "";
    render();
    return;
  }
  if (e.target.id === "food") {
    draft.foodId = e.target.value;
    draft.unit = "";
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
    const food = selectedFood();
    const portion = food && Number(draft.amount) > 0 ? scaleFood(food, draft.amount, selectedUnit()) : null;
    const box = document.getElementById("portion");
    if (box) box.innerHTML = portionHTML(portion);
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

async function boot() {
  state = loadLocal(foodsSeed);
  if (preview) {
    state.entries = [];
    state.days = [];
    applyPreview();
  }
  if (!PEOPLE.some((p) => p.id === person)) person = "surya";
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

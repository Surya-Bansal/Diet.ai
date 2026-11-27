import { defaultGoals, normalizeFood } from "./calc.js";

const LOCAL_KEY = "diet-log-v1";
const CONFIG_KEY = "diet-log-config";

export function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
  } catch {
    return {};
  }
}

export function cleanSupabaseUrl(raw) {
  let url = String(raw || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().replace(/\/+$/, "");
  const dash = url.match(/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) url = `https://${dash[1]}.supabase.co`;
  url = url.replace(/\/rest\/v1$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/^http:\/\//i, "https://");
  return url;
}

export function cleanSupabaseKey(raw) {
  return String(raw || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^bearer\s+/i, "")
    .replace(/\s+/g, "");
}

export function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({
    supabaseUrl: cleanSupabaseUrl(config.supabaseUrl),
    supabaseKey: cleanSupabaseKey(config.supabaseKey),
    usdaKey: (config.usdaKey || "").trim(),
  }));
}

function prepareFoods(foods) {
  return (foods || []).map(normalizeFood);
}

function emptyState(seedFoods) {
  return {
    foods: prepareFoods(seedFoods),
    entries: [],
    days: [],
    goals: defaultGoals(),
  };
}

export function loadLocal(seedFoods) {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return emptyState(seedFoods);
    const data = JSON.parse(raw);
    return {
      foods: data.foods?.length ? prepareFoods(data.foods) : prepareFoods(seedFoods),
      entries: data.entries || [],
      days: data.days || [],
      goals: { ...defaultGoals(), ...(data.goals || {}) },
    };
  } catch {
    return emptyState(seedFoods);
  }
}

export function saveLocal(state) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify({
    foods: state.foods,
    entries: state.entries,
    days: state.days,
    goals: state.goals,
  }));
}

function explainRemoteError(error) {
  const message = error?.message || String(error || "Could not reach the database.");
  if (/permission denied|schema cache|PGRST205|42501/i.test(message)) {
    return `${message} In the Supabase SQL editor, run the grant lines at the bottom of supabase/schema.sql, then tap Connect again.`;
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    const url = loadConfig().supabaseUrl || "the URL you pasted";
    return `The browser could not reach ${url}. It must look like https://abcdefghijklmnopqrst.supabase.co. Open the project in Supabase and wait until it says the project is running, then tap Connect again.`;
  }
  return message;
}

async function rest(path, { method = "GET", body, prefer } = {}) {
  const config = loadConfig();
  const url = config.supabaseUrl;
  const key = config.supabaseKey;
  if (!url || !key) {
    return { error: { message: "Paste the project URL and the anon key, then tap Connect." } };
  }
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(url)) {
    return { error: { message: `The Supabase URL is "${url}". It needs to look like https://abcdefghijklmnopqrst.supabase.co with nothing after it.` } };
  }
  let response;
  try {
    response = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { error: { message: err.message || "Failed to fetch" } };
  }
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch { /* not json */ }
    return { error: { message: payload.message || `Supabase returned ${response.status}` } };
  }
  const text = await response.text();
  return { data: text ? JSON.parse(text) : [] };
}

async function upsert(table, rows) {
  return rest(table, { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
}

// PostgREST stops at 1,000 rows. Pages need a stable order or offset skips rows.
async function restAll(path) {
  const pageSize = 1000;
  const rows = [];
  const seen = new Set();
  const join = path.includes("?") ? "&" : "?";
  for (let offset = 0; offset <= 20000; offset += pageSize) {
    const { data, error } = await rest(`${path}${join}limit=${pageSize}&offset=${offset}`);
    if (error) return { error };
    const batch = data || [];
    if (!batch.length) break;
    const first = batch[0];
    const marker = first.id != null ? String(first.id) : `${first.person}|${first.date}`;
    if (seen.has(marker)) {
      return { error: { message: "The log pages repeated, so the full log was not loaded." } };
    }
    seen.add(marker);
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return { data: rows };
}

export async function pullRemote(seedFoods) {
  const [foods, entries, goals, days] = await Promise.all([
    restAll("foods?select=id,data&order=id.asc"),
    restAll("entries?select=id,data&order=id.asc"),
    restAll("goals?select=person,data&order=person.asc"),
    restAll("days?select=person,date,exercise,burned,steps,minutes&order=person.asc,date.asc"),
  ]);
  let dayRows = days;
  if (dayRows.error && /steps|minutes|column|schema cache/i.test(dayRows.error.message || "")) {
    dayRows = await restAll("days?select=person,date,exercise,burned&order=person.asc,date.asc");
  }
  const error = foods.error || entries.error || dayRows.error || goals.error;
  if (error) return { mode: "local", state: null, error: explainRemoteError(error) };
  let foodRows = prepareFoods((foods.data || []).map((r) => r.data));
  if (!foodRows.length) {
    foodRows = prepareFoods(seedFoods);
    const seeded = await upsert("foods", foodRows.map((f) => ({ id: f.id, data: f })));
    if (seeded.error) return { mode: "local", state: null, error: explainRemoteError(seeded.error) };
  }
  const goalMap = defaultGoals();
  for (const row of goals.data || []) goalMap[row.person] = { ...goalMap[row.person], ...row.data };
  return {
    mode: "shared",
    error: "",
    state: {
      foods: foodRows,
      entries: (entries.data || []).map((r) => r.data),
      days: (dayRows.data || []).map((r) => ({
        person: r.person,
        date: r.date,
        exercise: r.exercise || "",
        burned: Number(r.burned) || 0,
        steps: r.steps == null ? undefined : Number(r.steps) || 0,
        minutes: r.minutes == null ? undefined : Number(r.minutes) || 0,
      })),
      goals: goalMap,
    },
  };
}

export async function pushFood(food) {
  const { error } = await upsert("foods", [{ id: food.id, data: food }]);
  if (error) throw new Error(explainRemoteError(error));
}

export async function pushEntry(entry) {
  const { error } = await upsert("entries", [{ id: entry.id, data: entry }]);
  if (error) throw new Error(explainRemoteError(error));
}

export async function removeEntryRemote(id) {
  const { error } = await rest(`entries?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", prefer: "return=minimal" });
  if (error) throw new Error(explainRemoteError(error));
}

export async function removeFoodRemote(id) {
  const { error } = await rest(`foods?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", prefer: "return=minimal" });
  if (error) throw new Error(explainRemoteError(error));
}

export async function pushDay(day) {
  const row = {
    person: day.person,
    date: day.date,
    exercise: day.exercise || "",
    burned: Number(day.burned) || 0,
    steps: Number(day.steps) || 0,
    minutes: Number(day.minutes) || 0,
  };
  let { error } = await upsert("days", [row]);
  if (error && /steps|minutes|column|schema cache/i.test(error.message || "")) {
    const retry = await upsert("days", [{
      person: row.person,
      date: row.date,
      exercise: row.exercise,
      burned: row.burned,
    }]);
    error = retry.error;
  }
  if (error) throw new Error(explainRemoteError(error));
}

export async function pushGoals(person, goals) {
  const { error } = await upsert("goals", [{ person, data: goals }]);
  if (error) throw new Error(explainRemoteError(error));
}

export function resetClient() {}

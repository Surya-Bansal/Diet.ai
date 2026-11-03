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

export function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({
    supabaseUrl: (config.supabaseUrl || "").trim(),
    supabaseKey: (config.supabaseKey || "").trim(),
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

let client = null;

async function remote() {
  const config = loadConfig();
  if (!config.supabaseUrl || !config.supabaseKey) return null;
  if (!client) {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
    client = createClient(config.supabaseUrl, config.supabaseKey);
  }
  return client;
}

export async function pullRemote(seedFoods) {
  const sb = await remote();
  if (!sb) return { mode: "local", state: null, error: "" };
  const [foods, entries, days, goals] = await Promise.all([
    sb.from("foods").select("id,data"),
    sb.from("entries").select("id,data"),
    sb.from("days").select("person,date,exercise,burned"),
    sb.from("goals").select("person,data"),
  ]);
  const error = foods.error || entries.error || days.error || goals.error;
  if (error) return { mode: "local", state: null, error: error.message };
  let foodRows = prepareFoods((foods.data || []).map((r) => r.data));
  if (!foodRows.length) {
    foodRows = prepareFoods(seedFoods);
    const { error: seedError } = await sb.from("foods").upsert(seedFoods.map((f) => ({ id: f.id, data: f })));
    if (seedError) return { mode: "local", state: null, error: seedError.message };
  }
  const goalMap = defaultGoals();
  for (const row of goals.data || []) goalMap[row.person] = { ...goalMap[row.person], ...row.data };
  return {
    mode: "shared",
    error: "",
    state: {
      foods: foodRows,
      entries: (entries.data || []).map((r) => r.data),
      days: (days.data || []).map((r) => ({
        person: r.person,
        date: r.date,
        exercise: r.exercise || "",
        burned: Number(r.burned) || 0,
      })),
      goals: goalMap,
    },
  };
}

export async function pushFood(food) {
  const sb = await remote();
  if (!sb) return;
  const { error } = await sb.from("foods").upsert({ id: food.id, data: food });
  if (error) throw new Error(error.message);
}

export async function pushEntry(entry) {
  const sb = await remote();
  if (!sb) return;
  const { error } = await sb.from("entries").upsert({ id: entry.id, data: entry });
  if (error) throw new Error(error.message);
}

export async function removeEntryRemote(id) {
  const sb = await remote();
  if (!sb) return;
  const { error } = await sb.from("entries").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function pushDay(day) {
  const sb = await remote();
  if (!sb) return;
  const { error } = await sb.from("days").upsert({
    person: day.person,
    date: day.date,
    exercise: day.exercise || "",
    burned: Number(day.burned) || 0,
  });
  if (error) throw new Error(error.message);
}

export async function pushGoals(person, goals) {
  const sb = await remote();
  if (!sb) return;
  const { error } = await sb.from("goals").upsert({ person, data: goals });
  if (error) throw new Error(error.message);
}

export function resetClient() {
  client = null;
}

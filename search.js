import { fromLabelTotals, round1 } from "./calc.js";

export function dishToFood(dish) {
  const parts = fromLabelTotals(dish);
  return {
    id: `dish-${dish.id}`,
    category: "Indian dishes",
    name: dish.name,
    servingLabel: "100 g",
    servingGrams: 100,
    unit: "g",
    ...parts,
    micros: {},
    source: dish.source,
    approx: true,
  };
}

export function searchDishes(dishes, query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return dishes
    .map((dish) => {
      const hay = [dish.name, ...(dish.aliases || [])].join(" ").toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hit = words.every((w) => hay.includes(w));
      return hit ? dish : null;
    })
    .filter(Boolean)
    .slice(0, 8)
    .map(dishToFood);
}

export function searchSaved(foods, query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return foods.filter((f) => f.name.toLowerCase().includes(q) || f.category.toLowerCase().includes(q)).slice(0, 6);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function fromOpenFoodFacts(product) {
  const n = product.nutriments || {};
  const kcal = n["energy-kcal_100g"] ?? (n["energy_100g"] ? n["energy_100g"] / 4.184 : null);
  if (kcal == null) return null;
  const parts = fromLabelTotals({
    kcal,
    protein: n.proteins_100g,
    fat: n.fat_100g,
    sat: n["saturated-fat_100g"],
    carb: n.carbohydrates_100g,
    sugar: n.sugars_100g,
    fiber: n.fiber_100g,
  });
  const name = [product.product_name, product.brands].filter(Boolean).join(" · ") || "Packaged food";
  return {
    id: `off-${product.code || name.toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`,
    category: "Added foods",
    name,
    servingLabel: "100 g",
    servingGrams: 100,
    unit: "g",
    ...parts,
    micros: {},
    source: "Open Food Facts, per 100 g. Confirm before saving.",
    approx: true,
  };
}

export async function searchOpenFoodFacts(query) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=8&fields=code,product_name,brands,nutriments`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open Food Facts ${res.status}`);
  const data = await res.json();
  return (data.products || []).map(fromOpenFoodFacts).filter(Boolean);
}

const USDA = {
  kcal: new Set([1008, 2047, 2048]),
  protein: 1003,
  fat: 1004,
  sat: 1258,
  carb: 1005,
  sugar: new Set([2000, 1063]),
  fiber: 1079,
};

function usdaValue(nutrients, id) {
  const ids = id instanceof Set ? id : new Set([id]);
  const hit = nutrients.find((n) => ids.has(n.nutrientId) || ids.has(n.nutrient?.id));
  return hit ? num(hit.value) : null;
}

export function fromUsdaFood(food) {
  const nutrients = food.foodNutrients || [];
  const kcal = usdaValue(nutrients, USDA.kcal);
  if (kcal == null) return null;
  const parts = fromLabelTotals({
    kcal,
    protein: usdaValue(nutrients, USDA.protein) || 0,
    fat: usdaValue(nutrients, USDA.fat) || 0,
    sat: usdaValue(nutrients, USDA.sat),
    carb: usdaValue(nutrients, USDA.carb) || 0,
    sugar: usdaValue(nutrients, USDA.sugar),
    fiber: usdaValue(nutrients, USDA.fiber) || 0,
  });
  const grams = num(food.servingSize) || 100;
  const per100 = grams && Math.abs(grams - 100) > 1;
  const scale = per100 ? 100 / grams : 1;
  const scaled = {
    kcal: round1(parts.kcal * scale),
    protein: round1(parts.protein * scale),
    fatUnsat: round1(parts.fatUnsat * scale),
    fatSat: round1(parts.fatSat * scale),
    fatSplit: parts.fatSplit,
    carbOther: round1(parts.carbOther * scale),
    sugar: round1(parts.sugar * scale),
    fiber: round1(parts.fiber * scale),
    sugarKnown: parts.sugarKnown,
  };
  return {
    id: `usda-${food.fdcId}`,
    category: "Added foods",
    name: food.description,
    servingLabel: "100 g",
    servingGrams: 100,
    unit: "g",
    ...scaled,
    micros: {},
    source: `USDA ${food.dataType || ""}, saved per 100 g.`.trim(),
    approx: food.dataType !== "Foundation",
  };
}

export async function searchUsda(query, apiKey) {
  if (!apiKey) return [];
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}&pageSize=8`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USDA ${res.status}`);
  const data = await res.json();
  return (data.foods || []).map(fromUsdaFood).filter(Boolean);
}

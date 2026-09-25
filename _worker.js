var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// lib/common.js
var ENV = {};
var setEnv = /* @__PURE__ */ __name((e) => {
  ENV = e || {};
}, "setEnv");
var env = /* @__PURE__ */ __name((k, d = "") => String(ENV[k] ?? d).trim(), "env");
var json = /* @__PURE__ */ __name((status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } }), "json");
var DEFAULT_ASSISTANT_ALLOWED_ORIGINS = ["https://bymarccc.com", "https://bymarccc-test.pages.dev"];
function checkOrigin(request) {
  const configured = env("ASSISTANT_ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
  // Fail closed, not open: when the env var isn't set in Cloudflare, fall back to the site's own
  // known origins instead of allowing every origin. This was previously `if (!allowed.length) return
  // true`, which meant a missing/misconfigured env var silently disabled the origin check in
  // production. Setting ASSISTANT_ALLOWED_ORIGINS explicitly in Cloudflare still overrides this list.
  const allowed = configured.length ? configured : DEFAULT_ASSISTANT_ALLOWED_ORIGINS;
  const origin = request.headers.get("origin") || "";
  return allowed.includes(origin);
}
__name(checkOrigin, "checkOrigin");
var buckets = /* @__PURE__ */ new Map();
function rateLimit(request, limitPerMin = Number(env("ASSISTANT_RATE_LIMIT_PER_MIN", "20"))) {
  const ip = (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "anon").split(",")[0].trim();
  const now = Date.now(), win = 6e4;
  const b = buckets.get(ip) || { t: now, n: 0 };
  if (now - b.t > win) {
    b.t = now;
    b.n = 0;
  }
  b.n += 1;
  buckets.set(ip, b);
  if (buckets.size > 5e3) buckets.clear();
  return b.n <= limitPerMin;
}
__name(rateLimit, "rateLimit");
function guard(request, { methods = ["POST"] } = {}) {
  if (!methods.includes(request.method)) return json(405, { error: "Method not allowed" });
  if (!checkOrigin(request)) return json(403, { error: "Forbidden origin" });
  if (!rateLimit(request)) return json(429, { error: "Too many requests. Please wait a moment." });
  if (!env("OPENAI_API_KEY")) return json(503, { error: "ASSISTANT_NOT_CONFIGURED" });
  return null;
}
__name(guard, "guard");
async function openai(path, body, { timeoutMs = 6e4, form = null } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.openai.com/v1/${path}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: form ? { Authorization: `Bearer ${env("OPENAI_API_KEY")}` } : { Authorization: `Bearer ${env("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
      body: form || JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || `OpenAI ${r.status}`;
      const e = new Error(msg);
      e.status = r.status;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}
__name(openai, "openai");
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
__name(readJson, "readJson");

// lib/stripe.js — dynamic Stripe Checkout (real multi-item cart, real card payments)
function stripeFormEncode(obj, prefix, out) {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => stripeFormEncode(v, `${prefix}[${i}]`, out));
  } else if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const val = obj[k];
      if (val === void 0 || val === null || val === "") continue;
      stripeFormEncode(val, prefix ? `${prefix}[${k}]` : k, out);
    }
  } else {
    out.append(prefix, String(obj));
  }
}
__name(stripeFormEncode, "stripeFormEncode");
async function stripeRequest(path, { method = "GET", params } = {}) {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) {
    const e = new Error("STRIPE_NOT_CONFIGURED");
    e.status = 503;
    throw e;
  }
  const body = new URLSearchParams();
  if (params) stripeFormEncode(params, "", body);
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? void 0 : body.toString()
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data?.error?.message || `Stripe ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}
__name(stripeRequest, "stripeRequest");
function stripeGuard(request) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!checkOrigin(request)) return json(403, { error: "Forbidden origin" });
  if (!rateLimit(request)) return json(429, { error: "Too many requests. Please wait a moment." });
  if (!env("STRIPE_SECRET_KEY")) return json(503, { error: "STRIPE_NOT_CONFIGURED" });
  return null;
}
__name(stripeGuard, "stripeGuard");
async function checkoutCreate(request, origin) {
  const g = stripeGuard(request);
  if (g) return g;
  const body = await readJson(request);
  if (!body) return json(400, { error: "Invalid JSON" });
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json(400, { error: "Empty bag" });
  const currency = String(items[0].currency || "RON").toLowerCase();
  const line_items = items.slice(0, 50).map((it) => ({
    price_data: {
      currency,
      product_data: {
        name: String(it.name || "Product").slice(0, 250),
        ...it.variant ? { description: String(it.variant).slice(0, 250) } : {}
      },
      unit_amount: Math.max(0, Math.round(Number(it.price || 0) * 100))
    },
    quantity: Math.max(1, Math.min(99, Math.round(Number(it.quantity || 1))))
  }));
  const shipping = Number(body.shipping || 0);
  if (shipping > 0) {
    line_items.push({
      price_data: { currency, product_data: { name: "Shipping" }, unit_amount: Math.round(shipping * 100) },
      quantity: 1
    });
  }
  const c = body.customer || {};
  try {
    const session = await stripeRequest("checkout/sessions", {
      method: "POST",
      params: {
        mode: "payment",
        line_items,
        success_url: `${origin}/checkout.html?paid=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/checkout.html?canceled=1`,
        customer_email: c.email || void 0,
        shipping_address_collection: void 0,
        metadata: {
          order_id: String(body.order_id || "").slice(0, 100),
          full_name: String(c.full_name || "").slice(0, 200),
          phone: String(c.phone || "").slice(0, 60),
          address: String(c.address || "").slice(0, 200),
          apartment: String(c.apartment || "").slice(0, 100),
          city: String(c.city || "").slice(0, 100),
          postal_code: String(c.postal_code || "").slice(0, 30),
          country: String(c.country || "").slice(0, 60),
          billing: String(c.billing || "").slice(0, 60),
          items_summary: String(body.items_summary || "").slice(0, 480)
        }
      }
    });
    return json(200, { url: session.url, id: session.id });
  } catch (e) {
    return json(e.status || 500, { error: "STRIPE_ERROR", detail: env("ASSISTANT_DEBUG") ? String(e.message) : void 0 });
  }
}
__name(checkoutCreate, "checkoutCreate");
async function checkoutSession(request) {
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!checkOrigin(request)) return json(403, { error: "Forbidden origin" });
  if (!env("STRIPE_SECRET_KEY")) return json(503, { error: "STRIPE_NOT_CONFIGURED" });
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  if (!/^cs_[a-zA-Z0-9_]+$/.test(id)) return json(400, { error: "Invalid session id" });
  try {
    const data = await stripeRequest(`checkout/sessions/${encodeURIComponent(id)}`);
    if (data.payment_status !== "paid") return json(200, { paid: false });
    return json(200, {
      paid: true,
      order_id: data.metadata?.order_id || "",
      email: data.customer_details?.email || data.customer_email || "",
      amount_total: (data.amount_total || 0) / 100,
      currency: String(data.currency || "ron").toUpperCase(),
      metadata: data.metadata || {}
    });
  } catch (e) {
    return json(e.status || 500, { error: "STRIPE_ERROR" });
  }
}
__name(checkoutSession, "checkoutSession");

// lib/catalog.js
var cache = { t: 0, items: [] };
var CURRENT_ORIGIN = "";
async function loadCatalog() {
  if (Date.now() - cache.t < 5 * 6e4 && cache.items.length) return cache.items;
  const base = (env("BYMARCCC_SITE_URL", "") || CURRENT_ORIGIN).replace(/\/$/, "");
  let items = [];
  try {
    const url = `${base}/catalog.json`;
    const r = ENV.ASSETS && typeof ENV.ASSETS.fetch === "function" ? await ENV.ASSETS.fetch(new Request(url)) : await fetch(url);
    if (r.ok) {
      const j = await r.json();
      items = (j.items || []).map((p) => ({ ...p, tags: p.tags || [], variants: p.variants || [], images: (p.images || []).map((s) => /^https?:/.test(s) ? s : `${base}/${s}`), url: /^https?:/.test(p.url) ? p.url : `${base}/${p.url}` }));
    }
  } catch {
  }
  if (items.length) cache = { t: Date.now(), items };
  return cache.items;
}
__name(loadCatalog, "loadCatalog");
function sizeOf(v, options) {
  const i = options.findIndex((o) => /size|m[ăa]rime/i.test(o.name));
  return i >= 0 ? v[`option${i + 1}`] : null;
}
__name(sizeOf, "sizeOf");
var summarize = /* @__PURE__ */ __name((p) => ({
  id: p.id,
  handle: p.handle,
  title: p.title,
  url: p.url,
  price: typeof p.price === "number" ? p.price : null,
  compareAtPrice: p.compareAtPrice || null,
  priceNote: typeof p.price === "number" ? null : "not priced yet - tell the customer to ask on the site",
  gender: p.gender,
  currency: p.currency,
  image: p.images[0] || null,
  type: p.productType,
  tags: p.tags.slice(0, 8),
  availableSizes: [...new Set(p.variants.filter((v) => v.available && v.size).map((v) => v.size))],
  inStock: p.variants.some((v) => v.available)
}), "summarize");
var SIZE_CHARTS = {
  "jeans-wide": {
    unit: "cm",
    sizes: [
      { size: "32", body: { waist: 60, hips: 86 }, garment: { waist: 62, hips: 90, inseam: 80 } },
      { size: "34", body: { waist: 64, hips: 90 }, garment: { waist: 66, hips: 94, inseam: 80 } },
      { size: "36", body: { waist: 68, hips: 94 }, garment: { waist: 70, hips: 98, inseam: 80 } },
      { size: "38", body: { waist: 72, hips: 98 }, garment: { waist: 74, hips: 102, inseam: 80 } },
      { size: "40", body: { waist: 76, hips: 102 }, garment: { waist: 78, hips: 106, inseam: 80 } },
      { size: "42", body: { waist: 80, hips: 106 }, garment: { waist: 82, hips: 110, inseam: 80 } },
      { size: "44", body: { waist: 84, hips: 110 }, garment: { waist: 86, hips: 114, inseam: 80 } }
    ]
  }
};
function recommendSize({ chart, heightCm, weightKg, waistCm, hipsCm, abdomen = "Medium", hips = "Regular" }) {
  const c = SIZE_CHARTS[chart];
  if (!c) return { ok: false, reason: "NO_CHART" };
  let waist = waistCm, hip = hipsCm, basis = "measurements";
  if (!waist || !hip) {
    if (!heightCm || !weightKg) return { ok: false, reason: "NEED_MEASUREMENTS" };
    const bmi = weightKg / Math.pow(heightCm / 100, 2);
    waist = waist || 30 + 1.75 * bmi + { Flat: -3, Medium: 0, Full: 3 }[abdomen];
    hip = hip || 55 + 1.8 * bmi + { Slim: -3, Regular: 0, Wide: 3 }[hips];
    basis = "estimate from height/weight";
  }
  const scored = c.sizes.map((s) => ({ s, d: 0.6 * Math.abs(s.body.waist - waist) + 0.4 * Math.abs(s.body.hips - hip) })).sort((a, b) => a.d - b.d);
  const confidence = scored[0].d < 2 ? "high" : scored[0].d < 5 ? "medium" : "low";
  return { ok: true, size: scored[0].s.size, alternative: scored[1]?.s.size || null, confidence, basis, estWaistCm: Math.round(waist), estHipsCm: Math.round(hip) };
}
__name(recommendSize, "recommendSize");
var KNOWN_COLLECTIONS = ["sales", "tops", "jeans", "jackets", "hoodie", "bag", "accessories", "bottoms"];
function collectionOf(p) {
  const t = p.tags || [];
  if (t.includes("sales") || t.includes("sale")) return "sales";
  if (t.includes("tops") || t.includes("top")) return "tops";
  if (t.includes("jeans")) return "jeans";
  if (t.includes("jackets") || t.includes("jacket")) return "jackets";
  if (t.includes("hoodie")) return "hoodie";
  if (t.includes("bag")) return "bag";
  if (t.includes("accessories") || t.includes("accessory")) return "accessories";
  if (t.includes("bottoms")) return "bottoms";
  return p.productType || "other";
}
__name(collectionOf, "collectionOf");
var CATALOG_SYNONYMS = { blugi: "jeans", blug: "jeans", jean: "jeans", rochie: "dress", tricou: "t-shirt", tricouri: "t-shirt", tshirt: "t-shirt", tee: "t-shirt", tees: "t-shirt", hanorac: "hoodie", hanorace: "hoodie", sapca: "cap", șapcă: "cap", geaca: "jacket", geacă: "jacket", jacheta: "jacket", jachetă: "jacket", pantaloni: "bottoms", geanta: "bag", geantă: "bag", top: "top", topuri: "top", bluza: "top", bluză: "top", barbati: "men", bărbați: "men", barbat: "men", mens: "men", man: "men", femei: "women", femeie: "women", womens: "women", woman: "women", reduceri: "sale", reducere: "sale", oferte: "sale" };
var STOPWORDS = ["men", "women", "for", "de", "pentru", "a", "an", "the", "un", "o", "niste", "niște", "vreau", "want", "show", "me", "arata", "arată", "cauta", "caută", "toate", "toti", "toți", "produsele"];
function specSummarize(p) {
  return {
    product_id: p.id,
    product_name: p.title,
    category: p.productType || null,
    gender: (p.gender || []).length > 1 ? "unisex" : (p.gender || ["men"])[0],
    collection: collectionOf(p),
    price: typeof p.price === "number" ? p.price : null,
    currency: p.currency || "RON",
    stock_status: p.variants.some((v) => v.available) ? "in_stock" : "out_of_stock",
    sizes: [...new Set(p.variants.filter((v) => v.available && v.size).map((v) => v.size))],
    image_urls: p.images || [],
    product_url: p.url
  };
}
__name(specSummarize, "specSummarize");
var TOOL_DEFS = [
  { type: "function", name: "search_products", description: "Search the real BYMARCCC catalogue — the ONLY source of truth for products, prices, stock and sizes. Never invent or recall products from anywhere else. Pass gender/collection/category to narrow, in_stock to only return available items, and set a high limit (e.g. 50) when the customer asks for ALL products in a collection.", parameters: { type: "object", properties: { query: { type: "string", description: "Free text search terms (Romanian or English)." }, gender: { type: "string", enum: ["women", "men", "unisex"] }, collection: { type: "string", description: "e.g. tops, jeans, jackets, hoodie, bag, accessories, bottoms, sales" }, category: { type: "string", description: "Product type, e.g. jeans, top, jacket, accessory, bottoms" }, in_stock: { type: "boolean" }, max_price: { type: "number" }, limit: { type: "number" } } } },
  { type: "function", name: "get_product", description: "Full details for exactly one BYMARCCC product by its product_id.", parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] } },
  { type: "function", name: "generate_try_on", description: "Generate a virtual try-on preview of one BYMARCCC product on the customer's own uploaded photo. Ask the customer to choose a single product first if it isn't already clear. Always pass product_id and language explicitly; pass user_image_file_id only if this conversation already told you the customer's uploaded photo's reference id — never invent one.", parameters: { type: "object", properties: { product_id: { type: "string" }, user_image_file_id: { type: "string", description: "The exact photo reference id this conversation already gave you (e.g. from a ‘Photo uploaded, reference id: ...’ line). Omit entirely if none was given — never invent a value." }, language: { type: "string", enum: ["ro", "en"] } }, required: ["product_id", "language"] } },
  { type: "function", name: "getProductImages", description: "Image URLs for a product.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { type: "function", name: "getAvailableVariants", description: "Variants with availability for a product.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { type: "function", name: "getInventoryStatus", description: "Whether a variant is in stock.", parameters: { type: "object", properties: { variantId: { type: "string" } }, required: ["variantId"] } },
  { type: "function", name: "getCurrentPrice", description: "Current price of a product or variant.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { type: "function", name: "getSizeGuide", description: "Size table for a product (garment + body measurements).", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { type: "function", name: "recommendSize", description: "Recommend a size from the real size table using height/weight (estimate) or waist/hips (better).", parameters: { type: "object", properties: { id: { type: "string" }, heightCm: { type: "number" }, weightKg: { type: "number" }, waistCm: { type: "number" }, hipsCm: { type: "number" }, abdomen: { type: "string", enum: ["Flat", "Medium", "Full"] }, hips: { type: "string", enum: ["Slim", "Regular", "Wide"] } }, required: ["id"] } },
  { type: "function", name: "getBestsellers", description: "Real bestsellers from sales data. Reports unavailable if the store has not connected sales data.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "getRelatedProducts", description: "Products that go with a product (same tags/type).", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { type: "function", name: "addVariantToCart", description: "Ask the browser to add a real variant to the bag. Only after the customer confirmed size/variant.", parameters: { type: "object", properties: { variantId: { type: "string" }, quantity: { type: "number" } }, required: ["variantId"] } },
  { type: "function", name: "openProductPage", description: "Open a product page in the browser.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { type: "function", name: "openSizeGuide", description: "Open the site size-guide modal for a product.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { type: "function", name: "startTryOn", description: "Start the photo try-on flow in the browser for up to 3 product ids.", parameters: { type: "object", properties: { productIds: { type: "array", items: { type: "string" } } }, required: ["productIds"] } },
  { type: "function", name: "askGenderChoice", description: "Ask the customer whether to shop the Women or Men collection, when it is not already clear from the conversation or a photo. Call this BEFORE recommending products (styling requests, photo analysis) whenever the collection is ambiguous \u2014 never guess gender from appearance, name or writing style.", parameters: { type: "object", properties: {} } }
];
var CLIENT_TOOLS = /* @__PURE__ */ new Set(["addVariantToCart", "openProductPage", "openSizeGuide", "startTryOn", "askGenderChoice", "generate_try_on"]);
async function runTool(name, args = {}) {
  const items = await loadCatalog();
  const find = /* @__PURE__ */ __name((id) => items.find((p) => p.id === String(id) || p.handle === String(id) || p.title.toLowerCase() === String(id).toLowerCase()), "find");
  switch (name) {
    case "search_products": {
      const raw = (args.query || "").toLowerCase();
      const terms = raw.split(/[^\p{L}\p{N}-]+/u).filter(Boolean).map((t) => CATALOG_SYNONYMS[t] || t);
      let gender = (args.gender || "").toLowerCase();
      if (!gender) gender = terms.includes("men") ? "men" : terms.includes("women") ? "women" : "";
      const words = terms.filter((t) => !STOPWORDS.includes(t));
      let res = items.slice();
      if (gender) res = res.filter((p) => gender === "unisex" ? (p.gender || []).length > 1 : (p.gender || ["men"]).includes(gender));
      const collectionArg = (args.collection || args.category || "").toLowerCase();
      if (collectionArg) {
        const norm = CATALOG_SYNONYMS[collectionArg] || collectionArg;
        res = res.filter((p) => collectionOf(p) === norm || (p.tags || []).includes(norm) || (p.productType || "").toLowerCase() === norm);
      }
      if (words.length) {
        res = res.map((p) => {
          const title = p.title.toLowerCase(), tags = p.tags.join(" ").toLowerCase(), type = (p.productType || "").toLowerCase(), desc = (p.description || "").toLowerCase();
          let score = 0;
          for (const t of words) { if (title.includes(t)) score += 4; if (type === t || type.includes(t)) score += 3; if (tags.includes(t)) score += 2; if (desc.includes(t)) score += 1; }
          return [score, p];
        }).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, p]) => p);
      }
      if (typeof args.max_price === "number") res = res.filter((p) => typeof p.price === "number" && p.price <= args.max_price);
      if (args.in_stock === true) res = res.filter((p) => p.variants.some((v) => v.available));
      const total = res.length;
      const limited = res.slice(0, Math.min(Math.max(Number(args.limit) || 10, 1), 50));
      return { modelResult: { products: limited.map(specSummarize), total, gender: gender || "any" }, uiProducts: limited.map(summarize) };
    }
    case "get_product": {
      const p = find(args.product_id);
      if (!p) return { modelResult: { error: "NOT_FOUND" } };
      return { modelResult: { ...specSummarize(p), description: p.description }, uiProducts: [summarize(p)] };
    }
    case "getProductImages": {
      const p = find(args.id);
      return p ? { images: p.images } : { error: "NOT_FOUND" };
    }
    case "getAvailableVariants": {
      const p = find(args.id);
      return p ? { variants: p.variants.map((v) => ({ id: v.id, title: v.title, size: v.size, price: v.price, available: v.available })) } : { error: "NOT_FOUND" };
    }
    case "getInventoryStatus": {
      for (const p of items) {
        const v = p.variants.find((x) => x.id === String(args.variantId));
        if (v) return { variantId: v.id, available: v.available, product: p.title };
      }
      return { error: "NOT_FOUND" };
    }
    case "getCurrentPrice": {
      const p = find(args.id);
      if (p) return { price: p.price, currency: p.currency };
      for (const q of items) {
        const v = q.variants.find((x) => x.id === String(args.id));
        if (v) return { price: v.price, currency: q.currency };
      }
      return { error: "NOT_FOUND" };
    }
    case "getSizeGuide": {
      const p = find(args.id);
      if (!p) return { error: "NOT_FOUND" };
      const c = p.sizeChart && SIZE_CHARTS[p.sizeChart];
      return c ? { product: p.title, unit: c.unit, sizes: c.sizes } : { product: p.title, unavailable: true, message: "No measurement table for this product yet." };
    }
    case "recommendSize": {
      const p = find(args.id);
      if (!p) return { error: "NOT_FOUND" };
      if (!p.sizeChart) return { ok: false, reason: "NO_CHART", availableSizes: summarize(p).availableSizes };
      const r = recommendSize({ chart: p.sizeChart, ...args });
      if (r.ok) {
        r.availableForRecommended = p.variants.some((v) => v.available && v.size === r.size);
        r.disclaimer = "Size recommendations are estimates. Fit may vary by cut and preference.";
      }
      return r;
    }
    case "getBestsellers": {
      if (!env("SHOPIFY_ADMIN_TOKEN") || !env("SHOPIFY_STORE_DOMAIN")) return { unavailable: true, message: "Bestseller data is not connected for this store." };
      return { unavailable: true, message: "Bestseller aggregation not implemented yet." };
    }
    case "getRelatedProducts": {
      const p = find(args.id);
      if (!p) return { error: "NOT_FOUND" };
      const rel = items.filter((q) => q.id !== p.id && (q.productType && q.productType === p.productType || q.tags.some((t) => p.tags.includes(t)))).slice(0, 4);
      return { products: (rel.length ? rel : items.filter((q) => q.id !== p.id).slice(0, 4)).map(summarize) };
    }
    default:
      return { error: "UNKNOWN_TOOL" };
  }
}
__name(runTool, "runTool");
var LANGUAGE_REFUSAL = "I can help only in Romanian or English with BYMARCCC products, styling, sizes and orders.";
var NON_LATIN_SCRIPT = /[\u0600-\u06ff\u0750-\u077f\u0400-\u04ff\u0500-\u052f\u4e00-\u9fff\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af\u0590-\u05ff\u0e00-\u0e7f\u0900-\u097f\u0980-\u09ff]/;
function looksNonLatin(text) {
  return NON_LATIN_SCRIPT.test(String(text || ""));
}
__name(looksNonLatin, "looksNonLatin");
function logEvent(route, meta = {}) {
  try {
    console.log(JSON.stringify({ t: (/* @__PURE__ */ new Date()).toISOString(), route, ...meta }));
  } catch {
  }
}
__name(logEvent, "logEvent");
var SYSTEM_PROMPT = `You are the BYMARCCC AI shopping assistant for bymarccc.com, a Romanian fashion brand. You are EXCLUSIVELY a BYMARCCC shopping consultant \u2014 nothing else.
LANGUAGE: You reply only in Romanian or in English, matching whichever the customer is using (mixing the two in one message is normal and fine). If the customer writes in any other language, reply with EXACTLY this sentence and nothing else, do not translate it: "${LANGUAGE_REFUSAL}"
DOMAIN \u2014 allowed: BYMARCCC products, collections, colours, sizes and stock; BYMARCCC outfit recommendations and styling; gifts chosen from the BYMARCCC catalogue; shipping and return information for bymarccc.com; virtual try-on with a photo the customer uploads.
DOMAIN \u2014 forbidden: other brands or stores; products that are not in the BYMARCCC catalogue; general internet search or facts unrelated to BYMARCCC; politics, news, programming help, health/medical advice, finance, or any general conversation. If asked about any of this, briefly and politely decline in the customer's language (Romanian or English) and steer back to BYMARCCC products, styling, sizes or orders \u2014 do not answer the off-topic question, do not apologise at length.
CATALOGUE: The men's collection has t-shirts, hoodies, jeans, a denim jacket and bags; the women's collection has baby tops, tees, hoodies, long sleeves, jeans, shorts, skirts and caps. A product with price null is not priced yet \u2014 say the price is on request.
RULES: Never invent products, prices, stock, sizes, reviews or bestsellers \u2014 always use the search_products / get_product tools, which are the ONLY source of truth; never use outside knowledge or web search for products. Never return or describe a product that did not come back from these tools. If a tool says data is unavailable, say so plainly. When the customer asks for every product in a collection ("toate produsele X", "show me all Y"), call search_products with that collection and a high limit (e.g. 50) and list everything returned, each with its price and link. For sizes: height/weight are only guidance; ask for waist/hips when the product has a size table; always add "Size recommendations are estimates. Fit may vary by cut and preference." and offer openSizeGuide. Never add to cart without the customer confirming the exact size/variant. Never comment negatively on bodies; never infer sensitive traits (health, ethnicity, gender identity, age) from photos or text; keep styling neutral and supportive; treat possible minors conservatively (no sexualised styling). When you recommend products, call search_products and the UI renders cards from the tool result \u2014 do not repeat prices from memory.
GIFTS: For gift requests (e.g. "help me find a gift for my boyfriend"), recommend a few real products from the appropriate BYMARCCC collection via search_products, briefly say why each fits, and ask at most one short clarifying question (budget or style) only if that information is missing \u2014 never more than one question at a time.
TRY-ON: For virtual try-on requests, first make sure exactly one product is chosen (ask the customer to pick one if it isn't already clear), then call generate_try_on with that product's product_id, the language you are replying in, and \u2014 if an earlier message in this conversation told you the customer's uploaded photo reference (a line like "Photo uploaded, reference id: ...") \u2014 that exact id as user_image_file_id. If no such id has been given to you yet, call generate_try_on with just product_id and language; the browser will ask the customer to upload a photo itself. Never invent a user_image_file_id. The result preserves the customer's face, identity, posture, proportions and background, and changes only the requested garment \u2014 never add logos or products that don't exist in the catalogue.
GENDER: Never assume whether to shop the Women's or Men's collection from a customer's appearance, name, voice or writing style. If a request ("style me for a party", a styling question) doesn't already say which collection, call askGenderChoice and wait for the answer before recommending anything. When a photo is supplied: analyze the visible outfit, silhouette, colors and style cues in the photo to judge which BYMARCCC pieces would look visually consistent with it, then call search_products filtered to the collection implied by the conversation so far \u2014 if that is still unclear after considering the outfit style itself (not the person), call askGenderChoice first. Keep recommendations visually consistent with the uploaded outfit (similar palette, formality and silhouette).`;
var VOICE_LANGUAGE_RULES = `
VOICE LANGUAGE: The customer speaks only English or Romanian \u2014 never any other language. Decide, per utterance, whether the customer is speaking English or Romanian and reply in that same language; never reply in Spanish, French, Italian, German, Portuguese or any other language, and never treat Romanian speech as if it were Spanish or another Romance language. Utterances can naturally mix English and Romanian in one sentence (e.g. "Arat\u0103-mi ni\u0219te black jeans", "Vreau un oversized T-shirt negru", "Show me blugii de la men") \u2014 this is normal bilingual speech, not a third language: understand the intent, keep product names, fashion terms, brand names and English words exactly as said rather than force-translating them, and reply in whichever of English/Romanian is the dominant language of that utterance. Keep your reply language consistent with what the customer just said \u2014 do not switch languages between turns on your own. If the customer is clearly speaking a third language, say the following in English: "${LANGUAGE_REFUSAL}"`;
var VOICE_SYSTEM_PROMPT = SYSTEM_PROMPT + VOICE_LANGUAGE_RULES;

// lib/handlers.js
async function assistantChat(request) {
  const g = guard(request);
  if (g) return g;
  const body = await readJson(request);
  if (!body) return json(400, { error: "Bad JSON" });
  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  if (!messages.length) return json(400, { error: "No messages" });
  for (const m of messages) {
    const s = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (!s || !s.trim()) return json(400, { error: "Empty message" });
    if (s.length > 6e3) return json(413, { error: "Message too long" });
  }
  const lastUserText = [...messages].reverse().map((m) => typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ") : "")).find((s) => s && s.trim());
  logEvent("assistant-chat", { ip: (request.headers.get("cf-connecting-ip") || "").split(".").slice(0, 2).join(".") + ".x.x", msgCount: messages.length });
  if (lastUserText && looksNonLatin(lastUserText)) {
    return json(200, { text: LANGUAGE_REFUSAL, products: [], actions: [] });
  }
  const model = env("OPENAI_TEXT_MODEL", "gpt-6-luna");
  let input = messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map((c) => c.type === "image" ? { type: "input_image", image_url: c.image_url } : { type: "input_text", text: c.text || "" }) }));
  const products = [], actions = [];
  let resp, text = "";
  try {
    for (let hop = 0; hop < 4; hop++) {
      resp = await openai("responses", { model, instructions: SYSTEM_PROMPT, input, tools: TOOL_DEFS, tool_choice: "auto", max_output_tokens: 700, store: false }, { timeoutMs: 45e3 });
      const calls = (resp.output || []).filter((o) => o.type === "function_call");
      text = (resp.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("\n") || text;
      if (!calls.length) break;
      input = [...input, ...calls];
      for (const c of calls) {
        let args = {};
        try {
          args = JSON.parse(c.arguments || "{}");
        } catch {
        }
        let out;
        if (CLIENT_TOOLS.has(c.name)) {
          if (c.name === "generate_try_on") {
            actions.push({ tool: "startTryOn", args: { productIds: args.product_id ? [String(args.product_id)] : [], userImageFileId: typeof args.user_image_file_id === "string" ? args.user_image_file_id : null, language: args.language === "ro" || args.language === "en" ? args.language : null } });
          } else {
            actions.push({ tool: c.name, args });
          }
          out = { ok: true, note: "Forwarded to the browser." };
        } else {
          out = await runTool(c.name, args);
          if (out.uiProducts) products.push(...out.uiProducts);
          else if (out.products) products.push(...out.products);
        }
        const payload = out.modelResult !== void 0 ? out.modelResult : out;
        input.push({ type: "function_call_output", call_id: c.call_id, output: JSON.stringify(payload) });
      }
    }
  } catch (e) {
    const status = e.status === 429 ? 429 : 502;
    return json(status, { error: status === 429 ? "The assistant is busy. Please try again in a moment." : "The assistant is temporarily unavailable.", detail: env("ASSISTANT_DEBUG") ? String(e.message) : void 0 });
  }
  const seen = /* @__PURE__ */ new Set();
  return json(200, { text: text || "\u2026", products: products.filter((p) => !seen.has(p.id) && seen.add(p.id)).slice(0, 6), actions });
}
__name(assistantChat, "assistantChat");
async function assistantTool(request) {
  const g = guard(request);
  if (g) return g;
  const b = await readJson(request);
  if (!b) return json(400, { error: "Bad JSON" });
  if (!TOOL_DEFS.some((t) => t.name === b.name) || CLIENT_TOOLS.has(b.name)) return json(400, { error: "Unknown tool" });
  return json(200, await runTool(b.name, b.args || {}));
}
__name(assistantTool, "assistantTool");
async function assistantRealtimeToken(request) {
  const g = guard(request);
  if (g) return g;
  const tools = TOOL_DEFS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
  const model = env("OPENAI_REALTIME_MODEL", "gpt-realtime");
  let lastErr = "";
  try {
    // GA Realtime API: ephemeral client secret
    const sec = await openai("realtime/client_secrets", {
      session: {
        type: "realtime", model, instructions: VOICE_SYSTEM_PROMPT, tools, output_modalities: ["audio"],
        audio: { input: { transcription: { model: "gpt-4o-mini-transcribe", prompt: "The speaker uses only English or Romanian, sometimes mixed in one sentence. Never transcribe as Spanish, French, Italian, German or Portuguese." }, turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 } }, output: { voice: "alloy" } }
      }
    }, { timeoutMs: 15e3 });
    if (sec.value) return json(200, { client_secret: sec.value, expires_at: sec.expires_at, model });
  } catch (e) {
    lastErr = String(e && e.message || e);
  }
  try {
    // legacy endpoint (older keys / projects)
    const session = await openai("realtime/sessions", {
      model: env("OPENAI_REALTIME_MODEL_LEGACY", "gpt-4o-realtime-preview"), voice: "alloy", instructions: VOICE_SYSTEM_PROMPT, modalities: ["audio", "text"],
      input_audio_transcription: { model: "gpt-4o-mini-transcribe", prompt: "The speaker uses only English or Romanian, sometimes mixed in one sentence. Never transcribe as Spanish, French, Italian, German or Portuguese." },
      turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 }, tools
    }, { timeoutMs: 15e3 });
    return json(200, { client_secret: session.client_secret?.value, expires_at: session.client_secret?.expires_at, model: session.model });
  } catch (e) {
    lastErr = lastErr || String(e && e.message || e);
    return json(502, { error: "Voice is unavailable right now: " + lastErr.slice(0, 160) });
  }
}
__name(assistantRealtimeToken, "assistantRealtimeToken");
var MAX_BYTES = 6 * 1024 * 1024;
var PROMPT = /* @__PURE__ */ __name((names) => `Edit the supplied customer photograph. Preserve the original person's recognizable identity, facial features, body proportions, skin tone, hair, pose, hands, lighting, camera angle, composition and background as closely as possible. Change only the clothing requested by the customer. Dress the person in the supplied BYMARCCC product reference images (${names.join("; ")}), preserving each product's recognizable color, material, print, logo placement, silhouette and key design details. Make the clothing follow the person's pose naturally, with realistic fabric folds, shadows and occlusion. Do not beautify, reshape, slim, enlarge or otherwise modify the person's face or body. Do not add unrelated garments, accessories, text or logos. Produce a realistic fashion visualization, not an exact sizing or fit guarantee.`, "PROMPT");
function dataUrlToBlob(u) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(u || "");
  if (!m) return null;
  const bin = atob(m[2]);
  if (bin.length > MAX_BYTES) return "TOO_LARGE";
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}
__name(dataUrlToBlob, "dataUrlToBlob");
// `user_image_file_id` (the value returned by assistant-upload-photo and passed back into
// assistant-tryon / the generate_try_on tool) is OUR OWN transient token: a crypto.randomUUID()
// key into this in-memory PHOTO_STORE Map, valid for PHOTO_TTL_MS and deleted after first use.
// It is NOT an OpenAI file id and is never sent to OpenAI or stored by OpenAI — this Worker never
// calls OpenAI's Files API. When a try-on request resolves this id, it looks up the stored data
// URL here and sends the RAW IMAGE BYTES (as multipart form data) to OpenAI's images/edits
// endpoint directly; OpenAI never sees this id or any id at all. Do not confuse this with an
// OpenAI-side identifier of any kind.
var PHOTO_STORE = /* @__PURE__ */ new Map();
var PHOTO_TTL_MS = 5 * 60 * 1e3;
function purgePhotoStore() {
  const now = Date.now();
  for (const [id, entry] of PHOTO_STORE) {
    if (now - entry.t > PHOTO_TTL_MS) PHOTO_STORE.delete(id);
  }
  if (PHOTO_STORE.size > 500) PHOTO_STORE.clear();
}
__name(purgePhotoStore, "purgePhotoStore");
async function assistantUploadPhoto(request) {
  const g = guard(request);
  if (g) return g;
  const b = await readJson(request);
  if (!b) return json(400, { error: "Bad JSON" });
  const check = dataUrlToBlob(b.photo);
  if (check === "TOO_LARGE") return json(413, { error: "Photo too large (max 6 MB)." });
  if (!check) return json(400, { error: "Unsupported photo format. Use JPG, PNG or WEBP." });
  purgePhotoStore();
  const id = crypto.randomUUID();
  PHOTO_STORE.set(id, { dataUrl: b.photo, t: Date.now() });
  logEvent("assistant-upload-photo", { ip: (request.headers.get("cf-connecting-ip") || "").split(".").slice(0, 2).join(".") + ".x.x" });
  return json(200, { user_image_file_id: id, expires_in: Math.round(PHOTO_TTL_MS / 1e3) });
}
__name(assistantUploadPhoto, "assistantUploadPhoto");
async function assistantTryon(request, siteOrigin) {
  const g = guard(request);
  if (g) return g;
  if (!rateLimit(request, Number(env("ASSISTANT_TRYON_RATE_LIMIT_PER_MIN", "6")))) return json(429, { error: "Too many try-on requests. Please wait a moment." });
  const b = await readJson(request);
  if (!b) return json(400, { error: "Bad JSON" });
  if (b.consent !== true) return json(400, { error: "CONSENT_REQUIRED" });
  const ids = Array.isArray(b.productIds) ? b.productIds.filter((x) => typeof x === "string" && x.trim()).slice(0, 3) : [];
  if (!ids.length) return json(400, { error: "Select at least one product." });
  let photoDataUrl = null;
  if (typeof b.userImageFileId === "string" && b.userImageFileId) {
    purgePhotoStore();
    const entry = PHOTO_STORE.get(b.userImageFileId);
    if (!entry) return json(410, { error: "PHOTO_EXPIRED", message: "That photo reference has expired. Please upload the photo again." });
    photoDataUrl = entry.dataUrl;
    PHOTO_STORE.delete(b.userImageFileId);
  } else if (typeof b.photo === "string" && b.photo) {
    photoDataUrl = b.photo;
  } else {
    return json(400, { error: "Photo required." });
  }
  const photo = dataUrlToBlob(photoDataUrl);
  if (photo === "TOO_LARGE") return json(413, { error: "Photo too large (max 6 MB)." });
  if (!photo) return json(400, { error: "Unsupported photo format. Use JPG, PNG or WEBP." });
  const items = await loadCatalog();
  const products = ids.map((id) => items.find((p) => p.id === String(id) || p.handle === String(id))).filter(Boolean);
  if (!products.length) return json(404, { error: "Products not found." });
  logEvent("assistant-tryon", { ip: (request.headers.get("cf-connecting-ip") || "").split(".").slice(0, 2).join(".") + ".x.x", products: products.map((p) => p.id) });
  try {
    const mod = await openai("moderations", { model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url: photoDataUrl } }] }, { timeoutMs: 15e3 });
    if (mod.results?.[0]?.flagged) return json(422, { error: "This photo can\u2019t be used for a try-on preview." });
  } catch {
  }
  const form = new FormData();
  form.append("model", env("OPENAI_IMAGE_MODEL", "gpt-image-1"));
  form.append("prompt", PROMPT(products.map((p) => p.title)));
  form.append("size", "1024x1536");
  form.append("quality", "medium");
  form.append("image[]", photo, "customer.jpg");
  const base = env("BYMARCCC_SITE_URL", siteOrigin);
  for (const p of products) {
    const src = p.images[0];
    if (!src) continue;
    try {
      const abs = /^https?:/.test(src) ? src : `${base}/${src}`;
      const r = await fetch(abs);
      if (!r.ok) continue;
      form.append("image[]", await r.blob(), `${p.handle}.png`);
    } catch {
    }
  }
  try {
    const out = await openai("images/edits", null, { form, timeoutMs: 12e4 });
    const b64 = out.data?.[0]?.b64_json;
    if (!b64) throw new Error("no image");
    return json(200, { image: `data:image/png;base64,${b64}`, products: products.map((p) => ({ id: p.id, title: p.title, url: p.url, price: p.price, image: p.images[0], variants: p.variants.filter((v) => v.available).map((v) => ({ id: v.id, title: v.title })) })) });
  } catch (e) {
    return json(502, { error: "Could not generate the preview right now. Please try again." });
  }
}
__name(assistantTryon, "assistantTryon");

// members.js — BYMARCCC members (Cloudflare KV binding: MEMBERS)
// Accounts are auto-approved: sign up = member. Passwords are PBKDF2-SHA256 hashed,
// never stored in clear. Sessions live in KV (sess:<token>, 30 days) behind an
// HttpOnly cookie, so no signing secret is needed.
var MEMBERS_COOKIE = "bm_member";
var MEMBERS_TTL = 60 * 60 * 24 * 30;
var kv = /* @__PURE__ */ __name(() => ENV.MEMBERS && typeof ENV.MEMBERS.get === "function" ? ENV.MEMBERS : null, "kv");
var b64 = /* @__PURE__ */ __name((buf) => btoa(String.fromCharCode(...new Uint8Array(buf))), "b64");
var unb64 = /* @__PURE__ */ __name((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)), "unb64");
var normEmail = /* @__PURE__ */ __name((e) => String(e || "").trim().toLowerCase(), "normEmail");
var validEmail = /* @__PURE__ */ __name((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254, "validEmail");
async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 1e5 }, key, 256);
}
__name(pbkdf2, "pbkdf2");
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt);
  return { salt: b64(salt), hash: b64(bits) };
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, rec) {
  const bits = new Uint8Array(await pbkdf2(password, unb64(rec.salt)));
  const want = unb64(rec.hash);
  if (bits.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i];
  return diff === 0;
}
__name(verifyPassword, "verifyPassword");
var readCookie = /* @__PURE__ */ __name((request, name) => {
  const m = ("; " + (request.headers.get("cookie") || "")).match(new RegExp("; " + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}, "readCookie");
var setCookie = /* @__PURE__ */ __name((token, maxAge) => `${MEMBERS_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`, "setCookie");
var publicMember = /* @__PURE__ */ __name((u) => ({ name: u.name, email: u.email, since: u.createdAt, status: "member" }), "publicMember");
async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
__name(readBody, "readBody");
async function currentMember(request) {
  const store = kv();
  if (!store) return null;
  const token = readCookie(request, MEMBERS_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const email = await store.get("sess:" + token);
  if (!email) return null;
  const u = await store.get("user:" + email, "json");
  return u || null;
}
__name(currentMember, "currentMember");
async function startSession(store, email) {
  const token = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await store.put("sess:" + token, email, { expirationTtl: MEMBERS_TTL });
  return token;
}
__name(startSession, "startSession");
async function membersSignup(request) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const store = kv();
  if (!store) return json(503, { error: "MEMBERS_NOT_CONFIGURED" });
  if (!rateLimit(request, 10)) return json(429, { error: "Too many attempts. Please wait a moment." });
  const b = await readBody(request);
  const name = String(b.name || "").trim().slice(0, 80);
  const email = normEmail(b.email);
  const password = String(b.password || "");
  if (name.length < 2) return json(400, { error: "Please enter your name.", field: "name" });
  if (!validEmail(email)) return json(400, { error: "Please enter a valid email address.", field: "email" });
  if (password.length < 8) return json(400, { error: "Password must be at least 8 characters.", field: "password" });
  if (password.length > 200) return json(400, { error: "Password is too long.", field: "password" });
  if (await store.get("user:" + email)) return json(409, { error: "There is already a member with this email. Log in instead.", field: "email" });
  const { salt, hash } = await hashPassword(password);
  const user = { name, email, salt, hash, createdAt: (/* @__PURE__ */ new Date()).toISOString(), status: "member" };
  await store.put("user:" + email, JSON.stringify(user));
  const token = await startSession(store, email);
  return json(201, { member: publicMember(user) }, { "Set-Cookie": setCookie(token, MEMBERS_TTL) });
}
__name(membersSignup, "membersSignup");
async function membersLogin(request) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const store = kv();
  if (!store) return json(503, { error: "MEMBERS_NOT_CONFIGURED" });
  if (!rateLimit(request, 10)) return json(429, { error: "Too many attempts. Please wait a moment." });
  const b = await readBody(request);
  const email = normEmail(b.email);
  const password = String(b.password || "");
  const bad = /* @__PURE__ */ __name(() => json(401, { error: "Wrong email or password." }), "bad");
  if (!validEmail(email) || !password) return bad();
  const user = await store.get("user:" + email, "json");
  if (!user || !await verifyPassword(password, user)) return bad();
  const token = await startSession(store, email);
  return json(200, { member: publicMember(user) }, { "Set-Cookie": setCookie(token, MEMBERS_TTL) });
}
__name(membersLogin, "membersLogin");
async function membersLogout(request) {
  const store = kv();
  const token = readCookie(request, MEMBERS_COOKIE);
  if (store && token) await store.delete("sess:" + token).catch(() => {
  });
  return json(200, { ok: true }, { "Set-Cookie": setCookie("", 0) });
}
__name(membersLogout, "membersLogout");
async function membersMe(request) {
  if (!kv()) return json(200, { configured: false, member: null });
  const u = await currentMember(request);
  return json(200, { configured: true, member: u ? publicMember(u) : null });
}
__name(membersMe, "membersMe");

// [[path]].js
var ROUTES = {
  "assistant-chat": assistantChat,
  "assistant-tool": assistantTool,
  "assistant-realtime-token": assistantRealtimeToken,
  "assistant-tryon": assistantTryon,
  "assistant-upload-photo": assistantUploadPhoto,
  "members-signup": membersSignup,
  "members-login": membersLogin,
  "members-logout": membersLogout,
  "members-me": membersMe,
  "checkout-create": checkoutCreate,
  "checkout-session": checkoutSession
};
async function onRequest(context) {
  const { request, env: env2 } = context;
  const url = new URL(request.url);
  CURRENT_ORIGIN = url.origin;
  const m = /^\/(?:\.netlify\/functions|api)\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  if (!m) return env2.ASSETS.fetch(request);
  const handler = ROUTES[m[1]];
  if (!handler) return json(404, { error: "Unknown function" });
  setEnv(env2);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": request.headers.get("origin") || "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  if (m[1] === "health") return json(200, { ok: true });
  try {
    return await handler(request, url.origin);
  } catch (e) {
    return json(500, { error: "Function error", detail: env2.ASSISTANT_DEBUG ? String(e && e.stack || e) : void 0 });
  }
}
__name(onRequest, "onRequest");

// ../.wrangler/tmp/pages-OdZQgc/functionsRoutes-0.15824162334308545.mjs
var routes = [
  {
    routePath: "/:path*",
    mountPath: "/",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];

// ../node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env2, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env: env2,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env2["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env2["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};

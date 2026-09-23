var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// lib/common.js
var ENV = {};
var setEnv = /* @__PURE__ */ __name((e) => {
  ENV = e || {};
}, "setEnv");
var env = /* @__PURE__ */ __name((k, d = "") => String(ENV[k] ?? d).trim(), "env");
var json = /* @__PURE__ */ __name((status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } }), "json");
function checkOrigin(request) {
  const allowed = env("ASSISTANT_ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get("origin") || "";
  if (!allowed.length) return true;
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

// lib/catalog.js
var SHOP = /* @__PURE__ */ __name(() => env("SHOP_PUBLIC_URL", "https://bymarccc.com").replace(/\/$/, ""), "SHOP");
var cache = { t: 0, items: [] };
var LOCAL_PRODUCTS = [{
  id: "zebra-patch-jeans",
  handle: "zebra-patch-jeans",
  title: "Zebra Patch Jeans",
  productType: "jeans",
  tags: ["jeans", "denim", "wide leg", "statement", "blugi"],
  url: `${env("BYMARCCC_SITE_URL", "")}/product.html`,
  price: 450,
  currency: "RON",
  description: "Hand-finished statement denim, wide leg, high rise. Hand-applied zebra patches and paint splatter.",
  images: ["assets/01-grey-jeans.png", "assets/02-red-jeans.png", "assets/03-blue-jeans.png"],
  options: ["Colour", "Size"],
  variants: (() => {
    const colours = ["Grey", "Red", "Blue", "Brown", "Purple", "Pink", "Green", "Orange", "White"];
    const sizes = ["32", "34", "36", "38", "40", "42", "44"];
    const unavailable = ["White:32", "White:44", "Pink:44"];
    return colours.flatMap((c) => sizes.map((s) => ({ id: `zebra-patch-jeans:${c.toLowerCase()}:${s}`, title: `${c} / ${s}`, colour: c, size: s, price: 450, available: !unavailable.includes(`${c}:${s}`) })));
  })(),
  sizeChart: "jeans-wide"
}];
async function loadCatalog() {
  if (Date.now() - cache.t < 5 * 6e4 && cache.items.length) return cache.items;
  let remote = [];
  try {
    const r = await fetch(`${SHOP()}/products.json?limit=250`, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const j = await r.json();
      remote = (j.products || []).map((p) => ({
        id: String(p.id),
        handle: p.handle,
        title: p.title,
        productType: p.product_type || "",
        tags: p.tags || [],
        url: `${SHOP()}/products/${p.handle}`,
        price: Number(p.variants[0]?.price || 0),
        currency: "RON",
        description: (p.body_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600),
        images: p.images.map((i) => i.src),
        options: p.options.map((o) => o.name),
        variants: p.variants.map((v) => ({ id: String(v.id), title: v.title, size: sizeOf(v, p.options), price: Number(v.price), available: !!v.available })),
        sizeChart: null
      }));
    }
  } catch {
  }
  cache = { t: Date.now(), items: [...LOCAL_PRODUCTS, ...remote] };
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
  price: p.price,
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
var TOOL_DEFS = [
  { type: "function", name: "searchProducts", description: "Search the real BYMARCCC catalogue by text, category, size or max price. Returns products with real prices, sizes and stock.", parameters: { type: "object", properties: { query: { type: "string" }, maxPrice: { type: "number" }, size: { type: "string" }, limit: { type: "number" } } } },
  { type: "function", name: "getProductDetails", description: "Full details for one product (by id or handle).", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
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
var CLIENT_TOOLS = /* @__PURE__ */ new Set(["addVariantToCart", "openProductPage", "openSizeGuide", "startTryOn", "askGenderChoice"]);
async function runTool(name, args = {}) {
  const items = await loadCatalog();
  const find = /* @__PURE__ */ __name((id) => items.find((p) => p.id === String(id) || p.handle === String(id) || p.title.toLowerCase() === String(id).toLowerCase()), "find");
  switch (name) {
    case "searchProducts": {
      const q = (args.query || "").toLowerCase().split(/\s+/).filter(Boolean);
      const syn = { blugi: "jeans", rochie: "dress", tricou: "top", sapca: "cap", \u0219apc\u0103: "cap", geaca: "jacket", geac\u0103: "jacket", pantaloni: "shorts" };
      const terms = q.map((t) => syn[t] || t);
      let res = items.filter((p) => {
        const hay = `${p.title} ${p.productType} ${p.tags.join(" ")} ${p.description}`.toLowerCase();
        return !terms.length || terms.some((t) => hay.includes(t));
      });
      if (args.maxPrice) res = res.filter((p) => p.price <= args.maxPrice);
      if (args.size) res = res.filter((p) => p.variants.some((v) => v.available && v.size && v.size.toLowerCase().includes(String(args.size).toLowerCase())));
      return { products: res.slice(0, args.limit || 8).map(summarize), total: res.length };
    }
    case "getProductDetails": {
      const p = find(args.id);
      return p ? { ...summarize(p), description: p.description, options: p.options, sizeChart: p.sizeChart } : { error: "NOT_FOUND" };
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
var SYSTEM_PROMPT = `You are the BYMARCCC AI stylist for bymarccc.com, a Romanian fashion brand. Reply in the customer's language (Romanian or English), short and warm, luxury-fashion tone.
RULES: Never invent products, prices, stock, sizes, reviews or bestsellers \u2014 always use tools. If a tool says data is unavailable, say so plainly. For sizes: height/weight are only guidance; ask for waist/hips when the product has a size table; always add "Size recommendations are estimates. Fit may vary by cut and preference." and offer openSizeGuide. Never add to cart without the customer confirming the exact size/variant. Never comment negatively on bodies; never infer sensitive traits (health, ethnicity, gender identity, age) from photos or text; keep styling neutral and supportive; treat possible minors conservatively (no sexualised styling). When you recommend products, call searchProducts and the UI renders cards from the tool result \u2014 do not repeat prices from memory. For try-on requests call startTryOn with the chosen product ids.
GENDER: Never assume whether to shop the Women's or Men's collection from a customer's appearance, name, voice or writing style. If a request ("style me for a party", a styling question) doesn't already say which collection, call askGenderChoice and wait for the answer before recommending anything. When a photo is supplied: analyze the visible outfit, silhouette, colors and style cues in the photo to judge which BYMARCCC pieces would look visually consistent with it, then call searchProducts filtered to the collection implied by the conversation so far \u2014 if that is still unclear after considering the outfit style itself (not the person), call askGenderChoice first. Keep recommendations visually consistent with the uploaded outfit (similar palette, formality and silhouette).`;

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
    if (s.length > 6e3) return json(413, { error: "Message too long" });
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
          actions.push({ tool: c.name, args });
          out = { ok: true, note: "Forwarded to the browser." };
        } else {
          out = await runTool(c.name, args);
          if (out.products) products.push(...out.products);
        }
        input.push({ type: "function_call_output", call_id: c.call_id, output: JSON.stringify(out) });
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
  try {
    const session = await openai("realtime/sessions", {
      model: env("OPENAI_REALTIME_MODEL", "gpt-4o-realtime-preview"),
      voice: "alloy",
      instructions: SYSTEM_PROMPT,
      modalities: ["audio", "text"],
      input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
      tools: TOOL_DEFS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }))
    }, { timeoutMs: 15e3 });
    return json(200, { client_secret: session.client_secret?.value, expires_at: session.client_secret?.expires_at, model: session.model });
  } catch (e) {
    return json(502, { error: "Voice is temporarily unavailable." });
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
async function assistantTryon(request, siteOrigin) {
  const g = guard(request);
  if (g) return g;
  const b = await readJson(request);
  if (!b) return json(400, { error: "Bad JSON" });
  if (b.consent !== true) return json(400, { error: "CONSENT_REQUIRED" });
  const ids = Array.isArray(b.productIds) ? b.productIds.slice(0, 3) : [];
  if (!ids.length) return json(400, { error: "Select at least one product." });
  const photo = dataUrlToBlob(b.photo);
  if (photo === "TOO_LARGE") return json(413, { error: "Photo too large (max 6 MB)." });
  if (!photo) return json(400, { error: "Unsupported photo format. Use JPG, PNG or WEBP." });
  const items = await loadCatalog();
  const products = ids.map((id) => items.find((p) => p.id === String(id) || p.handle === String(id))).filter(Boolean);
  if (!products.length) return json(404, { error: "Products not found." });
  try {
    const mod = await openai("moderations", { model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url: b.photo } }] }, { timeoutMs: 15e3 });
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
  "members-signup": membersSignup,
  "members-login": membersLogin,
  "members-logout": membersLogout,
  "members-me": membersMe
};
async function onRequest(context) {
  const { request, env: env2 } = context;
  const url = new URL(request.url);
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

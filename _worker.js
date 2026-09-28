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
async function stripeRequest(path, { method = "GET", params, idempotencyKey } = {}) {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) {
    const e = new Error("STRIPE_NOT_CONFIGURED");
    e.status = 503;
    throw e;
  }
  const body = new URLSearchParams();
  if (params) stripeFormEncode(params, "", body);
  const headers = { Authorization: `Bearer ${key}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let url = `https://api.stripe.com/v1/${path}`;
  if (method === "GET") {
    if (params) url += `?${body.toString()}`;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const r = await fetch(url, {
    method,
    headers,
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
  const c = body.customer || {};
  const order_id = String(body.order_id || "").slice(0, 100);
  const metaBase = {
    order_id,
    full_name: String(c.full_name || "").slice(0, 200),
    phone: String(c.phone || "").slice(0, 60),
    address: String(c.address || "").slice(0, 200),
    apartment: String(c.apartment || "").slice(0, 100),
    city: String(c.city || "").slice(0, 100),
    postal_code: String(c.postal_code || "").slice(0, 30),
    country: String(c.country || "").slice(0, 60),
    billing: String(c.billing || "").slice(0, 60),
    items_summary: String(body.items_summary || "").slice(0, 480)
  };
  const addTo = await verifyAddTo(body.addto).catch(() => null);
  const shipping = addTo ? 0 : Number(env("SHIPPING_RON", "20")) || 0;
  if (addTo) metaBase.add_to = addTo;
  const shippingMinor = shipping > 0 ? Math.round(shipping * 100) : 0;
  // Server-side total, in minor units (bani) — never trust a client-sent total for what gets charged.
  const itemsTotalMinor = items.slice(0, 50).reduce((sum, it) => {
    const unit = Math.max(0, Math.round(Number(it.price || 0) * 100));
    const qty = Math.max(1, Math.min(99, Math.round(Number(it.quantity || 1))));
    return sum + unit * qty;
  }, 0);
  const totalMinor = itemsTotalMinor + shippingMinor;

  // "Pay in 2 installments" — card only (the frontend only ever sends this for the card
  // payment method). Charges 50% now via a normal Checkout Session, saves the card for an
  // off-session charge (setup_future_usage: 'off_session' + customer_creation: 'always'),
  // and records the remaining 50% + due date so a separate scheduled job (see
  // cronChargeInstallments below) can charge it automatically in 30 days. Cloudflare Pages
  // has no cron trigger of its own — that job runs in a small separate Worker that calls the
  // cron-charge-installments route below on a schedule.
  if (Number(body.installments) === 2) {
    const firstMinor = Math.ceil(totalMinor / 2);
    const secondMinor = totalMinor - firstMinor;
    const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1e3).toISOString();
    try {
      const session = await stripeRequest("checkout/sessions", {
        method: "POST",
        params: {
          mode: "payment",
          customer_creation: "always",
          payment_intent_data: {
            setup_future_usage: "off_session",
            metadata: { order_id, installment_plan: "2", leg: "1" }
          },
          line_items: [{
            price_data: {
              currency,
              product_data: {
                name: `Order ${order_id} — deposit (1 of 2 payments)`,
                description: metaBase.items_summary.slice(0, 250)
              },
              unit_amount: firstMinor
            },
            quantity: 1
          }],
          success_url: `${origin}/checkout.html?paid=1&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/checkout.html?canceled=1`,
          customer_email: c.email || void 0,
          metadata: {
            ...metaBase,
            installment_plan: "2",
            currency,
            total_minor: String(totalMinor),
            first_minor: String(firstMinor),
            second_minor: String(secondMinor),
            due_date: dueDate
          }
        }
      });
      return json(200, { url: session.url, id: session.id });
    } catch (e) {
      return json(e.status || 500, { error: "STRIPE_ERROR", detail: env("ASSISTANT_DEBUG") ? String(e.message) : void 0 });
    }
  }

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
  if (shippingMinor > 0) {
    line_items.push({
      price_data: { currency, product_data: { name: "Shipping" }, unit_amount: shippingMinor },
      quantity: 1
    });
  }
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
        metadata: metaBase
      }
    });
    return json(200, { url: session.url, id: session.id });
  } catch (e) {
    return json(e.status || 500, { error: "STRIPE_ERROR", detail: env("ASSISTANT_DEBUG") ? String(e.message) : void 0 });
  }
}
__name(checkoutCreate, "checkoutCreate");
async function recordPendingInstallment(session) {
  // Called once, right after the FIRST (deposit) payment is confirmed paid. Saves what the
  // scheduled cron-charge-installments job needs to charge the remaining 50% automatically in
  // 30 days: the Stripe customer + payment method the first charge attached the card to, the
  // amount still owed, and the due date. Stored in the same KV namespace the members system
  // already uses (binding MEMBERS), under an "inst:" prefix so the two never collide.
  const store = kv();
  if (!store) return;
  const md = session.metadata || {};
  const order_id = md.order_id || session.id;
  const existing = await store.get(`inst:${order_id}`);
  if (existing) return;
  const pi = session.payment_intent;
  const customerId = typeof pi === "object" ? pi.customer : session.customer;
  const paymentMethodId = typeof pi === "object" ? pi.payment_method : void 0;
  if (!customerId || !paymentMethodId) return;
  const record = {
    order_id,
    customerId,
    paymentMethodId,
    currency: md.currency || String(session.currency || "ron").toLowerCase(),
    remainingMinor: Number(md.second_minor || 0),
    dueDate: md.due_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1e3).toISOString(),
    email: session.customer_details?.email || session.customer_email || "",
    full_name: md.full_name || "",
    phone: md.phone || "",
    status: "pending",
    attempts: 0,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (!record.remainingMinor) return;
  await store.put(`inst:${order_id}`, JSON.stringify(record));
}
__name(recordPendingInstallment, "recordPendingInstallment");
async function checkoutSession(request) {
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!checkOrigin(request)) return json(403, { error: "Forbidden origin" });
  if (!env("STRIPE_SECRET_KEY")) return json(503, { error: "STRIPE_NOT_CONFIGURED" });
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  if (!/^cs_[a-zA-Z0-9_]+$/.test(id)) return json(400, { error: "Invalid session id" });
  try {
    const data = await stripeRequest(`checkout/sessions/${encodeURIComponent(id)}`, {
      params: { "expand[]": "payment_intent" }
    });
    if (data.payment_status !== "paid") return json(200, { paid: false });
    let installment;
    if (data.metadata?.installment_plan === "2") {
      await recordPendingInstallment(data);
      installment = {
        remainingMinor: Number(data.metadata.second_minor || 0),
        currency: String(data.metadata.currency || data.currency || "ron").toUpperCase(),
        dueDate: data.metadata.due_date || ""
      };
    }
    return json(200, {
      paid: true,
      order_id: data.metadata?.order_id || "",
      email: data.customer_details?.email || data.customer_email || "",
      amount_total: (data.amount_total || 0) / 100,
      currency: String(data.currency || "ron").toUpperCase(),
      metadata: data.metadata || {},
      ...installment ? { installment } : {}
    });
  } catch (e) {
    return json(e.status || 500, { error: "STRIPE_ERROR" });
  }
}
__name(checkoutSession, "checkoutSession");
async function notifyOwnerInstallmentFailure(rec, kind) {
  // Alerts the store owner by email when an automatic "2nd installment" charge fails —
  // once on the FIRST decline (so it can be looked into quickly) and once when it's given
  // up for good after MAX_ATTEMPTS. Uses EmailJS's server-side REST API (no browser
  // involved, so this needs a PRIVATE key, not the public key checkout.html uses) — set
  // EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID_INSTALLMENT_ALERT and EMAILJS_PRIVATE_KEY in
  // this project's environment variables to enable it. Silently does nothing (just logs)
  // if those aren't configured yet, or if the send itself fails — a notification problem
  // must never break the actual charge/retry logic above.
  const serviceId = env("EMAILJS_SERVICE_ID");
  const templateId = env("EMAILJS_TEMPLATE_ID_INSTALLMENT_ALERT");
  const privateKey = env("EMAILJS_PRIVATE_KEY");
  if (!serviceId || !templateId || !privateKey) return;
  try {
    const r = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: serviceId,
        template_id: templateId,
        user_id: env("EMAILJS_PUBLIC_KEY", ""),
        accessToken: privateKey,
        template_params: {
          kind,
          order_id: rec.order_id,
          amount: `${(rec.remainingMinor / 100).toFixed(2)} ${String(rec.currency || "ron").toUpperCase()}`,
          error: rec.lastError || "",
          attempt: String(rec.attempts || 0),
          full_name: rec.full_name || "",
          phone: rec.phone || "",
          email: rec.email || ""
        }
      })
    });
    if (!r.ok) console.error("notifyOwnerInstallmentFailure: EmailJS responded", r.status, await r.text().catch(() => ""));
  } catch (e) {
    console.error("notifyOwnerInstallmentFailure: send failed", e && e.message || e);
  }
}
__name(notifyOwnerInstallmentFailure, "notifyOwnerInstallmentFailure");
async function cronChargeInstallments(request) {
  // Charges the remaining 50% for every due "pay in 2 installments" order. Not reachable from
  // the browser: guarded by a shared secret header instead of the usual origin/rate-limit
  // checks, since it's meant to be called server-to-server by a scheduled job (Cloudflare Pages
  // itself has no Cron Triggers — see the separate cron worker this is designed to be called
  // from). Set CRON_SECRET in this project's environment variables to enable it.
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const secret = env("CRON_SECRET");
  if (!secret) return json(503, { error: "CRON_NOT_CONFIGURED" });
  if (request.headers.get("x-cron-secret") !== secret) return json(403, { error: "Forbidden" });
  if (!env("STRIPE_SECRET_KEY")) return json(503, { error: "STRIPE_NOT_CONFIGURED" });
  const store = kv();
  if (!store) return json(503, { error: "KV_NOT_CONFIGURED" });
  const now = Date.now();
  const MAX_ATTEMPTS = 5;
  const results = { charged: [], failed: [], skipped: 0 };
  let cursor = void 0;
  let done = false;
  while (!done) {
    const page = await store.list({ prefix: "inst:", cursor, limit: 200 });
    for (const key of page.keys) {
      const raw = await store.get(key.name);
      if (!raw) continue;
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch {
        continue;
      }
      if (rec.status !== "pending") {
        results.skipped++;
        continue;
      }
      if (new Date(rec.dueDate).getTime() > now) {
        results.skipped++;
        continue;
      }
      const attempt = rec.attempts || 0;
      try {
        const pi = await stripeRequest("payment_intents", {
          method: "POST",
          params: {
            amount: rec.remainingMinor,
            currency: rec.currency,
            customer: rec.customerId,
            payment_method: rec.paymentMethodId,
            off_session: true,
            confirm: true,
            metadata: { order_id: rec.order_id, leg: "2" }
          },
          idempotencyKey: `installment2-${rec.order_id}-try${attempt}`
        });
        rec.status = "paid";
        rec.paidAt = (/* @__PURE__ */ new Date()).toISOString();
        rec.paymentIntentId = pi.id;
        await store.put(key.name, JSON.stringify(rec));
        results.charged.push(rec.order_id);
      } catch (e) {
        rec.attempts = attempt + 1;
        rec.lastError = String(e && e.message || e);
        rec.status = rec.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
        await store.put(key.name, JSON.stringify(rec));
        results.failed.push({ order_id: rec.order_id, error: rec.lastError, attempts: rec.attempts });
        if (rec.attempts === 1) await notifyOwnerInstallmentFailure(rec, "first_decline");
        else if (rec.status === "failed") await notifyOwnerInstallmentFailure(rec, "gave_up");
      }
    }
    done = page.list_complete;
    cursor = page.cursor;
  }
  return json(200, results);
}
__name(cronChargeInstallments, "cronChargeInstallments");

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
  { type: "function", name: "generate_try_on", description: "Generate a virtual try-on preview of one BYMARCCC product on the customer's own uploaded photo. Ask the customer to choose a single product first if it isn't already clear. Always pass product_id and language explicitly; pass user_image_file_id only if this conversation already told you the customer's uploaded photo's reference id — never invent one. If the customer named a specific print/embroidery design of that product (from get_product's data) and it is available, pass its exact design slug (lowercase, hyphenated, e.g. 'boys-lie') as design — this lets the app use that design's own reference artwork instead of the product's default photo; never invent a slug that wasn't given to you by the product data.", parameters: { type: "object", properties: { product_id: { type: "string" }, design: { type: "string", description: "Optional design/print slug (lowercase, hyphenated) taken only from this product's own known designs — omit if the customer didn't name one or it isn't in the data." }, user_image_file_id: { type: "string", description: "The exact photo reference id this conversation already gave you (e.g. from a ‘Photo uploaded, reference id: ...’ line). Omit entirely if none was given — never invent a value." }, language: { type: "string", enum: ["ro", "en"] } }, required: ["product_id", "language"] } },
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
            const __design = typeof args.design === "string" && args.design.trim() ? args.design.trim().toLowerCase() : null;
            const __pid = args.product_id ? String(args.product_id) : null;
            actions.push({ tool: "startTryOn", args: { productIds: __pid ? [__design ? `${__pid}::${__design}` : __pid] : [], userImageFileId: typeof args.user_image_file_id === "string" ? args.user_image_file_id : null, language: args.language === "ro" || args.language === "en" ? args.language : null } });
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
var PROMPT = /* @__PURE__ */ __name((products) => {
  const list = products.map((p) => p.design ? `${p.title} (${p.design} design)` : p.title).join("; ");
  const authoritativeNote = products.some((p) => p.isDesignAuthoritative) ? " Where a product reference image is a plain product photo (no person in it), it is the single, authoritative source for that garment's exact color, silhouette, neckline, sleeves, proportions, seams and any printed or embroidered graphic together with its exact placement on the garment \u2014 reproduce that graphic exactly as shown, and never invent, rewrite, resize, reposition or reinterpret it." : "";
  return `You are editing a real photograph, not generating a new image from scratch. The FIRST supplied image is the customer's own photograph \u2014 this is the base image and the sole source of identity: keep the customer's exact face, facial features, skin tone, hair, body shape and proportions, pose, hands, background, camera angle, framing and lighting unchanged. Do not beautify, reshape, slim, enlarge or otherwise modify the person's face or body, and do not alter the background or add unrelated garments, accessories, text or logos. Change ONLY the clothing being tried on. The remaining supplied image(s) are product reference image(s) for: ${list}.${authoritativeNote} If any product reference image instead shows the garment worn by another model, use it only to understand fit, cropped length, sleeve length, neckline and how the garment drapes on a body \u2014 never copy that model's face, body, skin tone or identity into the result. Fit the garment naturally to the customer's pose, with realistic fabric drape, folds, perspective, occlusion, lighting and shadows. Produce a realistic fashion visualization, not an exact sizing or fit guarantee.`;
}, "PROMPT");
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
  const requested = ids.map((raw) => {
    const str = String(raw);
    const sep = str.indexOf("::");
    return sep === -1 ? { pid: str, design: null } : { pid: str.slice(0, sep), design: str.slice(sep + 2) || null };
  });
  const products = requested.map(({ pid, design }) => {
    const p = items.find((it) => it.id === pid || it.handle === pid);
    if (!p) return null;
    const refImage = (design && p.tryOnAssets && p.tryOnAssets[design]) || p.images[0];
    return { ...p, __design: design, __refImage: refImage };
  }).filter(Boolean);
  if (!products.length) return json(404, { error: "Products not found." });
  logEvent("assistant-tryon", { ip: (request.headers.get("cf-connecting-ip") || "").split(".").slice(0, 2).join(".") + ".x.x", products: products.map((p) => p.id) });
  try {
    const mod = await openai("moderations", { model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url: photoDataUrl } }] }, { timeoutMs: 15e3 });
    if (mod.results?.[0]?.flagged) return json(422, { error: "This photo can\u2019t be used for a try-on preview." });
  } catch {
  }
  const form = new FormData();
  form.append("model", env("OPENAI_IMAGE_MODEL", "gpt-image-1"));
  form.append("prompt", PROMPT(products.map((p) => ({ title: p.title, design: p.__design, isDesignAuthoritative: !!(p.__design && p.tryOnAssets && p.tryOnAssets[p.__design]) }))));
  form.append("size", "1024x1536");
  form.append("quality", "medium");
  form.append("image[]", photo, "customer.jpg");
  const base = env("BYMARCCC_SITE_URL", siteOrigin);
  for (const p of products) {
    const src = p.__refImage;
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

// lib/geocode.js — shipping address → map position for the order-confirmation page.
// Server-side only, so the customer's browser never talks to a third-party geocoder and no key is
// ever exposed (OpenStreetMap Nominatim needs no key; it asks for an identifying User-Agent and a
// light request rate — one lookup per completed order is well within that). Tries the most precise
// query first and falls back step by step: street → postal code → city → country. A structured
// query with `country` set can only return a place inside that country, so a failed lookup never
// lands the pin somewhere wrong — it just returns { ok:false } and the page shows no map.
var GEO_ZOOM = { address: 15, postal: 13, city: 11, country: 5 };
async function geocodeAddress(request) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!checkOrigin(request)) return json(403, { error: "Forbidden origin" });
  if (!rateLimit(request)) return json(429, { error: "Too many requests. Please wait a moment." });
  const b = await readJson(request) || {};
  const clean = (v, n) => String(v || "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  const street = clean(b.address, 200), city = clean(b.city, 100), postal = clean(b.postal_code, 30), country = clean(b.country, 60);
  if (!city && !postal && !country) return json(400, { ok: false, error: "No address" });
  const tries = [];
  if (street && (city || postal)) tries.push(["address", { street, city, postalcode: postal, country }]);
  if (postal) tries.push(["postal", { postalcode: postal, city, country }]);
  if (city) tries.push(["city", { city, country }]);
  if (country) tries.push(["country", { country }]);
  for (const [level, q] of tries) {
    const p = new URLSearchParams({ format: "jsonv2", limit: "1", addressdetails: "1", "accept-language": "en" });
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/search?" + p.toString(), {
        headers: { "User-Agent": "bymarccc.com order-confirmation map (https://bymarccc.com)", "Accept": "application/json" },
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      if (!r.ok) continue;
      const list = await r.json();
      const hit = Array.isArray(list) && list[0];
      const lat = hit && Number(hit.lat), lon = hit && Number(hit.lon);
      if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const a = hit.address || {};
      return json(200, {
        ok: true, level, zoom: GEO_ZOOM[level], lat, lon,
        city: city || a.city || a.town || a.village || a.municipality || a.county || "",
        country: country || a.country || ""
      });
    } catch {}
  }
  return json(200, { ok: false });
}
__name(geocodeAddress, "geocodeAddress");

// lib/orders.js — order e-mails sent by the server (Resend), replacing the unconfigured browser EmailJS send.
//   POST /api/order-submit
//     cash on delivery: { order_id, items, customer, language }                → the order is only accepted once the owner e-mail went out
//     card (after Stripe): { session_id, order_id, items, customer, language }  → verified paid with Stripe first; sent once per order
//   Two e-mails: the order for the shop owner (ORDER_NOTIFY_TO) and a confirmation for the customer.
//   Env (Cloudflare Pages → Settings → Variables and Secrets): RESEND_API_KEY (secret), ORDER_NOTIFY_TO, ORDER_EMAIL_FROM.
var ORDER_T = {
  en: { subj: (id) => `Order confirmed — ${id}`, hi: (n) => `Thank you${n ? ", " + n : ""}!`, intro: "Your order is confirmed. We'll e-mail you again when it ships.",
    order: "Order", items: "Items", subtotal: "Subtotal", shipping: "Shipping", total: "Total", pay: "Payment", cod: "Cash on delivery", card: "Card (paid)",
    ship: "Shipping address", help: "Questions? Just reply to this e-mail.",
    kindTitle: "After you try them on, smile! 🙂", kindText: "You've just helped feed people in need: 30% of the profit from your order goes to the homeless. 💙",
    qty: "Qty", shop: "Continue shopping",
    recTitle: "You might also like", recText: (id) => `Add it to order ${id} — we'll ship everything together, no extra shipping.`, addTo: "Add to order",
    together: (id) => `This ships together with your order ${id} — no extra shipping.` },
  ro: { subj: (id) => `Comandă confirmată — ${id}`, hi: (n) => `Mulțumim${n ? ", " + n : ""}!`, intro: "Comanda ta este confirmată. Îți scriem din nou când o expediem.",
    order: "Comanda", items: "Produse", subtotal: "Subtotal", shipping: "Livrare", total: "Total", pay: "Plată", cod: "Ramburs (cash la livrare)", card: "Card (plătit)",
    ship: "Adresă de livrare", help: "Întrebări? Răspunde la acest e-mail.",
    kindTitle: "După ce le probezi, zâmbește! 🙂", kindText: "Tocmai ai ajutat la hrănirea unor oameni fără adăpost: 30% din profitul comenzii tale merge către ei. 💙",
    qty: "Cant.", shop: "Continuă cumpărăturile" }
};
var oesc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var ofmt = (n) => (Math.round(n * 100) / 100).toFixed(2) + " RON";
var sentOrders = /* @__PURE__ */ new Set();
async function resendSend(msg) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify(msg)
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); const e = new Error(`Resend ${r.status}: ${t.slice(0, 200)}`); e.status = r.status; throw e; }
  return r.json().catch(() => ({}));
}
__name(resendSend, "resendSend");
function cleanOrder(b) {
  const str = (v, n) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
  const c = b.customer || {};
  const customer = { full_name: str(c.full_name, 120), email: str(c.email, 200), phone: str(c.phone, 40), address: str(c.address, 200), apartment: str(c.apartment, 100),
    city: str(c.city, 80), postal_code: str(c.postal_code, 20), country: str(c.country, 60), billing: str(c.billing, 80) };
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50).map((it) => ({
    name: str(it.name, 160), variant: str(it.variant, 120),
    qty: Math.max(1, Math.min(99, Math.round(Number(it.quantity || it.qty || 1)))),
    price: Math.max(0, Math.round(Number(it.price || 0) * 100) / 100)
  })).filter((it) => it.name);
  return { order_id: str(b.order_id, 60).replace(/[^A-Za-z0-9-]/g, ""), customer, items, lang: b.language === "ro" ? "ro" : "en", session_id: str(b.session_id, 200) };
}
__name(cleanOrder, "cleanOrder");
function orderEmails(o, pay, totals, images = [], base = "https://bymarccc.com") {
  const t = ORDER_T[o.lang], c = o.customer;
  const lines = o.items.map((it) => `${it.qty} × ${it.name}${it.variant ? " (" + it.variant + ")" : ""} — ${ofmt(it.price * it.qty)}`);
  const addr = [c.full_name, c.address + (c.apartment ? ", " + c.apartment : ""), `${c.postal_code} ${c.city}`.trim(), c.country].filter(Boolean);
  const payLabel = pay === "card" ? t.card : t.cod;
  const rows = o.items.map((it) => `<tr><td style="padding:6px 0">${it.qty} × ${oesc(it.name)}${it.variant ? ` <span style="color:#888">(${oesc(it.variant)})</span>` : ""}</td><td align="right" style="padding:6px 0;white-space:nowrap">${ofmt(it.price * it.qty)}</td></tr>`).join("");
  const sums = `<tr><td style="padding:10px 0 2px;border-top:1px solid #e5e5e5">${t.subtotal}</td><td align="right" style="padding:10px 0 2px;border-top:1px solid #e5e5e5">${ofmt(totals.sub)}</td></tr><tr><td style="padding:2px 0">${t.shipping}</td><td align="right">${ofmt(totals.ship)}</td></tr><tr><td style="padding:8px 0;font-weight:700;font-size:17px">${t.total}</td><td align="right" style="font-weight:700;font-size:17px">${ofmt(totals.total)}</td></tr>`;
  const wrap = (inner) => `<!doctype html><html><body style="margin:0;background:#fff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#333;font-size:15px;line-height:1.5"><tr><td style="font-size:26px;color:#555;padding-bottom:22px">BYMARCCC</td></tr><tr><td>${inner}</td></tr></table></td></tr></table></body></html>`;
  const customerHtml = orderCustomerHtml(o, t, payLabel, totals, addr, images, base);
  const customerText = [t.hi((c.full_name || "").split(/\s+/)[0]), "", `${t.order} ${o.order_id}`, t.intro, "", t.kindTitle, t.kindText, "", ...lines, "", `${t.subtotal}: ${ofmt(totals.sub)}`, `${t.shipping}: ${ofmt(totals.ship)}`, `${t.total}: ${ofmt(totals.total)}`, "", `${t.pay}: ${payLabel}`, `${t.ship}: ${addr.join(", ")}`, "", t.help].join("\n");
  const ownerText = [`NEW ORDER ${o.order_id}`, ...(o.addToParent ? [`ADD-ON to ${o.addToParent} — SHIP TOGETHER (no shipping charged)`] : []), `Payment: ${pay === "card" ? "Card (Stripe, paid)" : "Cash on delivery"}`, "", ...lines, "", `Subtotal: ${ofmt(totals.sub)}`, `Shipping: ${ofmt(totals.ship)}`, `TOTAL: ${ofmt(totals.total)}`, "",
    `Name: ${c.full_name}`, `Phone: ${c.phone}`, `E-mail: ${c.email}`, `Address: ${addr.slice(1).join(", ")}`, `Billing: ${c.billing}`, `Language: ${o.lang}`].join("\n");
  const ownerHtml = wrap(`<h1 style="margin:0 0 4px;font-size:22px">New order ${oesc(o.order_id)}</h1>${o.addToParent ? `<p style="margin:0 0 6px;color:#1268F3;font-weight:700">ADD-ON to ${oesc(o.addToParent)} — ship together (no shipping charged)</p>` : ""}<p style="margin:0 0 18px;color:#777">${pay === "card" ? "Card (Stripe) — paid" : "Cash on delivery — collect on delivery"}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}${sums}</table><p style="margin:18px 0 0"><b>${oesc(c.full_name)}</b><br>${oesc(c.phone)}<br><a href="mailto:${oesc(c.email)}">${oesc(c.email)}</a><br>${addr.slice(1).map(oesc).join("<br>")}<br>Billing: ${oesc(c.billing)} · Language: ${o.lang}</p>`);
  return { customer: { subject: t.subj(o.order_id), html: customerHtml, text: customerText }, owner: { subject: `${o.addToParent ? `ADD-ON to ${o.addToParent} · ` : ""}New order ${o.order_id} — ${ofmt(totals.total)} — ${pay === "card" ? "CARD" : "COD"}`, html: ownerHtml, text: ownerText } };
}
__name(orderEmails, "orderEmails");
// Customer confirmation e-mail — table layout + inline styles (Gmail, Apple Mail, Outlook). Product photos come from
// catalog.json on the server (never from the browser).
function orderCustomerHtml(o, t, payLabel, totals, addr, images, base) {
  const F = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif", BLUE = "#1268F3", INK = "#111111", SUB = "#6b6b68", LINE = "#ecebe6";
  const img = (u) => typeof u === "string" && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : "";
  const first = (o.customer.full_name || "").split(/\s+/)[0];
  const items = o.items.map((it, i) => {
    const src = img(images[i]);
    const pic = src ? `<img src="${oesc(src)}" width="72" height="72" alt="" style="display:block;width:72px;height:72px;object-fit:cover;border-radius:12px;background:#f4f3ef;border:0">` : `<div style="width:72px;height:72px;border-radius:12px;background:#f4f3ef"></div>`;
    return `<tr><td width="88" valign="middle" style="padding:0 16px 16px 0">${pic}</td><td valign="middle" style="padding:0 0 16px;font-family:${F}"><div style="font-size:15px;font-weight:600;color:${INK};line-height:1.35">${oesc(it.name)}</div>${it.variant ? `<div style="font-size:13px;color:${SUB};margin-top:2px">${oesc(it.variant)}</div>` : ""}<div style="font-size:13px;color:${SUB};margin-top:2px">${t.qty}: ${it.qty}</div></td><td valign="middle" align="right" style="padding:0 0 16px 12px;font-family:${F};font-size:15px;color:${INK};white-space:nowrap">${ofmt(it.price * it.qty)}</td></tr>`;
  }).join("");
  const sum = (k, v, strong) => `<tr><td style="padding:${strong ? "12px 0 0" : "4px 0"};font-family:${F};font-size:${strong ? 17 : 14}px;color:${strong ? INK : SUB};font-weight:${strong ? 700 : 400}">${k}</td><td align="right" style="padding:${strong ? "12px 0 0" : "4px 0"};font-family:${F};font-size:${strong ? 19 : 14}px;color:${INK};font-weight:${strong ? 700 : 400};white-space:nowrap">${v}</td></tr>`;
  const recs = (o.recs || []).map((r) => `<tr><td width="88" valign="middle" style="padding:0 14px 14px 0"><a href="${oesc(r.url)}"><img src="${oesc(img(r.image))}" width="76" height="76" alt="" style="display:block;width:76px;height:76px;object-fit:cover;border-radius:12px;background:#f4f3ef;border:0"></a></td><td valign="middle" style="padding:0 0 14px;font-family:${F}"><div style="font-size:15px;font-weight:600;color:${INK};line-height:1.35">${oesc(r.title)}</div><div style="font-size:14px;color:${SUB};margin-top:2px">${ofmt(r.price)}</div></td><td valign="middle" align="right" style="padding:0 0 14px 10px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${INK}" style="border-radius:999px"><a href="${oesc(r.url)}" style="display:inline-block;padding:10px 16px;font-family:${F};font-size:12px;font-weight:700;letter-spacing:.5px;color:#ffffff;text-decoration:none;white-space:nowrap">${oesc(t.addTo)}</a></td></tr></table></td></tr>`).join("");
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>BYMARCCC</title></head>
<body style="margin:0;padding:0;background:#f4f3ef">
<div style="display:none;max-height:0;overflow:hidden">${oesc(t.hi(first))} ${oesc(t.kindText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f3ef"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:20px">
<tr><td style="padding:26px 28px 18px;font-family:${F};font-size:15px;font-weight:700;letter-spacing:5px;color:${INK}">bymarccc</td></tr>
<tr><td style="padding:26px 28px 0;font-family:${F}">
  <div style="font-size:12px;letter-spacing:1.5px;color:${SUB};text-transform:uppercase">${oesc(t.order)} ${oesc(o.order_id)}</div>
  <h1 style="margin:8px 0 0;font-family:${F};font-size:30px;line-height:1.15;font-weight:800;color:${INK}">${oesc(t.hi(first))}</h1>
  <p style="margin:10px 0 0;font-size:15px;line-height:1.55;color:${SUB}">${t.intro}</p>${o.addToParent ? `
  <p style="margin:10px 0 0;font-size:15px;line-height:1.55;color:${BLUE};font-weight:600">${oesc(t.together(o.addToParent))}</p>` : ""}
</td></tr>
<tr><td style="padding:22px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef4fe;border-radius:16px"><tr><td style="padding:18px 20px;font-family:${F}">
  <div style="font-size:18px;font-weight:800;color:${BLUE};line-height:1.3">${oesc(t.kindTitle)}</div>
  <div style="margin-top:6px;font-size:15px;line-height:1.5;color:#1f2a3d">${oesc(t.kindText)}</div>
</td></tr></table></td></tr>
<tr><td style="padding:26px 28px 0"><div style="font-family:${F};font-size:12px;letter-spacing:1.5px;color:${SUB};text-transform:uppercase;padding-bottom:14px;border-bottom:1px solid ${LINE};margin-bottom:16px">${oesc(t.items)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${LINE};margin-top:2px;padding-top:10px">${sum(t.subtotal, ofmt(totals.sub))}${sum(t.shipping, ofmt(totals.ship))}${sum(t.total, ofmt(totals.total), true)}</table>
</td></tr>
${recs ? `<tr><td style="padding:30px 28px 0"><div style="font-family:${F};font-size:20px;font-weight:800;color:${INK}">${oesc(t.recTitle)}</div><div style="font-family:${F};font-size:14px;line-height:1.5;color:${SUB};margin:4px 0 16px">${oesc(t.recText(o.addToParent || o.order_id))}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${recs}</table></td></tr>` : ""}
<tr><td style="padding:22px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f7f5;border-radius:16px"><tr><td style="padding:16px 20px;font-family:${F};font-size:14px;line-height:1.55;color:${INK}">
  <div style="font-size:12px;letter-spacing:1.5px;color:${SUB};text-transform:uppercase">${oesc(t.pay)}</div><div style="margin:2px 0 12px">${oesc(payLabel)}</div>
  <div style="font-size:12px;letter-spacing:1.5px;color:${SUB};text-transform:uppercase">${oesc(t.ship)}</div><div style="margin-top:2px">${addr.map(oesc).join("<br>")}</div>
</td></tr></table></td></tr>
<tr><td align="center" style="padding:26px 28px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${INK}" style="border-radius:999px"><a href="${oesc(base)}" style="display:inline-block;padding:14px 30px;font-family:${F};font-size:14px;font-weight:700;letter-spacing:1px;color:#ffffff;text-decoration:none;text-transform:uppercase">${oesc(t.shop)}</a></td></tr></table></td></tr>
<tr><td style="padding:26px 28px 28px;font-family:${F};font-size:13px;line-height:1.55;color:${SUB};text-align:center">${oesc(t.help)}<br><a href="${oesc(base)}" style="color:${SUB}">bymarccc.com</a></td></tr>
</table></td></tr></table></body></html>`;
}
__name(orderCustomerHtml, "orderCustomerHtml");
async function orderSubmit(request) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!checkOrigin(request)) return json(403, { error: "Forbidden origin" });
  if (!rateLimit(request, 10)) return json(429, { error: "Too many requests. Please wait a moment." });
  if (!env("RESEND_API_KEY") || !env("ORDER_NOTIFY_TO") || !env("ORDER_EMAIL_FROM")) return json(503, { error: "ORDERS_EMAIL_NOT_CONFIGURED" });
  const b = await readJson(request);
  if (!b) return json(400, { error: "Invalid JSON" });
  const o = cleanOrder(b), c = o.customer;
  o.lang = "en";   // customer e-mails are always in English
  const addTo = await verifyAddTo(b.addto).catch(() => null);
  if (addTo && addTo !== o.order_id) o.addToParent = addTo;
  if (!o.order_id || !o.items.length) return json(400, { error: "Invalid order" });
  let pay = "cod", totalOverride = null;
  if (o.session_id) {
    if (!/^cs_[a-zA-Z0-9_]+$/.test(o.session_id) || !env("STRIPE_SECRET_KEY")) return json(400, { error: "Invalid session" });
    const data = await stripeRequest(`checkout/sessions/${encodeURIComponent(o.session_id)}`);
    if (data.payment_status !== "paid" || (data.metadata?.order_id && data.metadata.order_id !== o.order_id)) return json(400, { error: "Not paid" });
    pay = "card"; totalOverride = (data.amount_total || 0) / 100;
    if (!c.email) c.email = data.customer_details?.email || data.customer_email || "";
  } else {
    const okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email);
    if (!c.full_name || !c.phone || !c.address || !c.city || !okEmail) return json(400, { error: "Missing customer details" });
  }
  // once per order: KV when bound (survives restarts), memory otherwise
  const store = kv(), key = `ordermail:${o.order_id}`;
  if (sentOrders.has(key) || (store && await store.get(key))) return json(200, { ok: true, duplicate: true });
  const sub = o.items.reduce((a, it) => a + it.price * it.qty, 0);
  const ship = o.addToParent ? 0 : Number(env("SHIPPING_RON", "20")) || 0;
  const totals = { sub, ship, total: totalOverride != null && pay === "card" && !b.installments ? totalOverride : sub + ship };
  const chk = await goatifyItemCheck(b.items).catch(() => ({ extras: [], notes: "" }));
  o.recs = await orderRecommendations(b.items, o.addToParent || o.order_id).catch(() => []);
  const m = orderEmails(o, pay, totals, chk.extras.map((e) => e && e.image), CURRENT_ORIGIN || "https://bymarccc.com");
  const from = env("ORDER_EMAIL_FROM");
  try {
    await resendSend({ from, to: env("ORDER_NOTIFY_TO").split(",").map((x) => x.trim()).filter(Boolean), reply_to: c.email || void 0, subject: m.owner.subject, html: m.owner.html, text: m.owner.text });
  } catch (e) {
    return json(502, { error: "ORDER_EMAIL_FAILED", detail: env("ASSISTANT_DEBUG") ? String(e.message) : void 0 });
  }
  sentOrders.add(key);
  if (store) await store.put(key, "1", { expirationTtl: 60 * 60 * 24 * 60 }).catch(() => {});
  // GOATIFY: forward the accepted order (no-op unless GOATIFY_FORWARDING=on). Never changes the answer to the customer.
  try {
    const fo = { ...o, items: o.items.map((it, i) => ({ ...it, ...(chk.extras[i] || {}) })) };
    const notes = [o.addToParent ? `ADD-ON to ${o.addToParent} — ship together in the same parcel.` : "", chk.notes, b.installments && pay === "card" ? "Pay in 2: first instalment paid by card, second charged automatically later." : ""].filter(Boolean).join("\n");
    const g = await forwardToGoatify(fo, { pay, totals: { sub: totals.sub, ship: totals.ship }, placedAt: new Date().toISOString(), notes, sourceUrl: CURRENT_ORIGIN ? CURRENT_ORIGIN + "/checkout.html" : void 0 }, (k) => env(k));
    if (!g.forwarded && g.reason !== "off") console.error("GOATIFY forward failed", JSON.stringify(g));
  } catch (e) { console.error("GOATIFY forward error", String(e && e.message || e)); }
  let customerMail = "skipped";
  if (c.email) { try { await resendSend({ from, to: [c.email], reply_to: env("ORDER_NOTIFY_TO").split(",")[0].trim() || void 0, subject: m.customer.subject, html: m.customer.html, text: m.customer.text }); customerMail = "sent"; } catch { customerMail = "failed"; } }
  return json(200, { ok: true, customerMail });
}
__name(orderSubmit, "orderSubmit");

// lib/goatify.js — forwards each accepted order to GOATIFY (orders, fulfilment, invoicing). Generated from
// goatify-backend/integrations/bymarccc/cloudflare/goatify-forward.js (tested there: test/bymarccc-cloudflare.test.js).
// Sends NOTHING unless GOATIFY_FORWARDING=on. Env (Cloudflare Pages → Settings → Variables and Secrets):
//   GOATIFY_API_URL (e.g. https://goatify.goatagency.us/api/v1) · GOATIFY_SITE_KEY=bymarccc · GOATIFY_SITE_SECRET (secret) · GOATIFY_FORWARDING
// Signed server-side (HMAC-SHA256) — the secret never reaches the browser. Never blocks or fails the customer's order.
const G_COUNTRIES = { romania: 'RO', 'românia': 'RO', moldova: 'MD', 'republica moldova': 'MD', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB',
  italy: 'IT', italia: 'IT', spain: 'ES', 'españa': 'ES', germany: 'DE', deutschland: 'DE', france: 'FR', austria: 'AT', hungary: 'HU', 'ungaria': 'HU', bulgaria: 'BG',
  netherlands: 'NL', belgium: 'BE', ireland: 'IE', poland: 'PL', portugal: 'PT', greece: 'GR', czechia: 'CZ', 'czech republic': 'CZ', slovakia: 'SK', denmark: 'DK', sweden: 'SE' };
function gCountryCode(v) {
  const s = String(v || '').trim(); if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return G_COUNTRIES[s.toLowerCase()] || null;
}
const gCents = (n) => Math.round(Number(n || 0) * 100);
const gHttps = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : undefined);

/** Builds the GOATIFY site-order payload (pure; throws on data GOATIFY would reject). */
function toGoatifyOrder(o, { pay, totals = null, siteKey = 'bymarccc', placedAt = new Date().toISOString(), sourceUrl, notes } = {}) {
  const c = o.customer || {};
  const country = gCountryCode(c.country); if (!country) throw Object.assign(new Error('Unsupported country: ' + c.country), { code: 'COUNTRY_UNSUPPORTED' });
  if (!o.order_id) throw Object.assign(new Error('Missing order_id'), { code: 'NO_ORDER_ID' });
  const items = (o.items || []).map(it => ({ ...(it.sku ? { sku: String(it.sku).slice(0, 64) } : {}), name: it.name, ...(it.variant ? { variant: it.variant } : {}), qty: Number(it.qty) || 1, price: gCents(it.price) / 100, ...(gHttps(it.image) ? { image: gHttps(it.image) } : {}) }));
  const sub = items.reduce((a, it) => a + gCents(it.price) * it.qty, 0);
  if (totals && gCents(totals.sub) !== sub) throw Object.assign(new Error('Subtotal does not match the items'), { code: 'TOTALS_MISMATCH' });
  const ship = gCents(totals ? totals.ship : 0);
  return {
    site: siteKey, idempotencyKey: 'bym_' + String(o.order_id).replace(/[^A-Za-z0-9._:-]/g, ''),
    customer: { name: c.full_name, email: String(c.email || '').toLowerCase(), phone: c.phone, lang: o.lang === 'ro' ? 'ro' : 'en' },
    shippingAddress: { line1: c.address, ...(c.apartment ? { line2: c.apartment } : {}), city: c.city, postcode: c.postal_code, country },
    items, subtotal: sub / 100, shipping: ship / 100, discount: 0, total: (sub + ship) / 100, currency: 'RON',
    payment: pay === 'card' ? { method: 'card', status: 'paid', ...(o.session_id ? { reference: String(o.session_id).slice(0, 120) } : {}) } : { method: 'cod' },
    ...(gHttps(sourceUrl) ? { sourceUrl: gHttps(sourceUrl) } : {}), ...(notes ? { notes: String(notes).slice(0, 1000) } : {}), placedAt,
  };
}

async function gHmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param env  (name) => value  — the worker's env getter
 * @returns {Promise<{forwarded:true, duplicate:boolean, number:number} | {forwarded:false, reason:string, status?:number, error?:string}>}  never throws
 */
async function forwardToGoatify(o, { pay, totals, sourceUrl, placedAt, notes } = {}, env, { fetchImpl = fetch } = {}) {
  if (String(env('GOATIFY_FORWARDING') || '').toLowerCase() !== 'on') return { forwarded: false, reason: 'off' };
  const api = String(env('GOATIFY_API_URL') || '').replace(/\/+$/, ''), siteKey = env('GOATIFY_SITE_KEY') || 'bymarccc', secret = env('GOATIFY_SITE_SECRET');
  if (!/^https?:\/\//.test(api) || !secret) return { forwarded: false, reason: 'not_configured' };
  let raw;
  try { raw = JSON.stringify(toGoatifyOrder(o, { pay, totals, siteKey, sourceUrl, notes, ...(placedAt ? { placedAt } : {}) })); } catch (e) { return { forwarded: false, reason: 'invalid', error: e.code || e.message }; }
  const ts = String(Math.floor(Date.now() / 1000)); const signature = await gHmacHex(secret, `${ts}.${raw}`);
  for (let attempt = 1; attempt <= 3; attempt++) {   // same body + key each time → GOATIFY dedupes
    try {
      const r = await fetchImpl(api + '/site-orders', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-goatify-site': siteKey, 'x-goatify-timestamp': ts, 'x-goatify-signature': signature } });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return { forwarded: true, duplicate: !!j.duplicate, number: j.order?.number };
      if (r.status < 500 && r.status !== 429) return { forwarded: false, reason: 'rejected', status: r.status, error: j.error?.code || '' };
    } catch (e) { if (attempt === 3) return { forwarded: false, reason: 'network', error: String(e.message || e).slice(0, 200) }; }
    await new Promise(res => setTimeout(res, 400 * attempt));
  }
  return { forwarded: false, reason: 'unavailable' };
}

// Server-side check of the bag lines against catalog.json (the browser sends its own prices). Prices are not changed;
// a line that is not in the catalogue or has another price is flagged in the GOATIFY order note, so it is seen before
// the parcel leaves / cash is collected. Adds the catalogue id (sku) and main photo to each line.
async function goatifyItemCheck(rawItems) {
  const cat = await loadCatalog().catch(() => []);
  const byId = new Map(cat.map((p) => [String(p.id), p]));
  const extras = [], warn = [];
  for (const it of (Array.isArray(rawItems) ? rawItems : []).slice(0, 50)) {
    const name = String(it?.name ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 160);
    if (!name) continue;   // same filter as cleanOrder(), so indexes line up
    const p = byId.get(String(it.id || "").split(":")[0]);
    const price = Math.max(0, Math.round(Number(it.price || 0) * 100) / 100);
    const ok = p && (p.price === price || (p.variants || []).some((v) => v.price === price));
    if (!ok) warn.push(name + (p ? ` (catalogue ${p.price} RON, bag ${price} RON)` : " (not in catalogue)"));
    extras.push({ ...(p ? { sku: String(p.id).slice(0, 64) } : {}), ...(p && p.images && p.images[0] ? { image: p.images[0] } : {}) });
  }
  return { extras, notes: warn.length ? "⚠ Price not verified against catalog.json: " + warn.join("; ") : "" };
}
__name(goatifyItemCheck, "goatifyItemCheck");

// "Add to order": signed link from the confirmation e-mail → product page → checkout, same parcel, no extra shipping.
// The signature ties the link to ONE order id (HMAC, server secret) and it is valid for ADDON_DAYS after that order.
var ADDON_DAYS = 7;
async function addToSig(orderId) {
  const secret = env("ORDER_LINK_SECRET") || env("RESEND_API_KEY");
  if (!secret) return "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("addto:" + orderId));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
__name(addToSig, "addToSig");
async function verifyAddTo(a) {
  if (!a || typeof a !== "object") return null;
  const id = String(a.order_id || ""), sig = String(a.sig || "");
  const m = /^BYM-(\d{4})(\d{2})(\d{2})-[A-Z0-9]{2,10}$/.exec(id);
  if (!m || !/^[0-9a-f]{24}$/.test(sig)) return null;
  const placed = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (!(Date.now() - placed <= (ADDON_DAYS + 1) * 864e5)) return null;
  return sig === await addToSig(id) ? id : null;
}
__name(verifyAddTo, "verifyAddTo");
// Up to 3 suggestions from catalog.json, based on what was bought: a women's top → the Delulu blazer first; then
// accessories (caps, bags) for the same gender; then another jeans/top. Never something already in the order.
// Photos for catalogue items that have none in catalog.json yet (the product page has them in its own gallery).
var REC_IMAGES = { "w-hg-delulu-blazer": "assets/img/gallery/delulu-blazer-1-73460abe.webp" };
async function orderRecommendations(rawItems, parentOrderId, max = 3) {
  const base = (env("BYMARCCC_SITE_URL", "") || CURRENT_ORIGIN || "https://bymarccc.com").replace(/\/$/, "");
  const cat = (await loadCatalog().catch(() => [])).map((p) => ({ ...p,
    images: (p.images || []).length ? p.images : REC_IMAGES[p.id] ? [`${base}/${REC_IMAGES[p.id]}`] : [],
    url: /[?&]p=/.test(p.url || "") ? p.url : `${base}/bymarccc-product.html?p=${encodeURIComponent(p.id)}` }));
  const byId = new Map(cat.map((p) => [String(p.id), p]));
  const bought = (Array.isArray(rawItems) ? rawItems : []).map((it) => byId.get(String(it && it.id || "").split(":")[0])).filter(Boolean);
  const boughtIds = new Set(bought.map((p) => p.id));
  const ok = (p) => p && !boughtIds.has(p.id) && typeof p.price === "number" && (p.images || []).length && (p.variants || []).some((v) => v.available !== false);
  const genders = new Set(bought.flatMap((p) => p.gender || []));
  const gender = genders.has("women") && !genders.has("men") ? "women" : genders.has("men") && !genders.has("women") ? "men" : (bought[0] && (bought[0].gender || [])[0]) || "women";
  const forG = (p) => (p.gender || []).includes(gender);
  const picks = [], add = (p) => { if (ok(p) && !picks.includes(p) && picks.length < max) picks.push(p); };
  if (bought.some((p) => p.productType === "top" && (p.gender || []).includes("women"))) add(byId.get("w-hg-delulu-blazer"));
  cat.filter((p) => p.productType === "accessory" && forG(p)).sort((a, b) => a.price - b.price).slice(0, 2).forEach(add);
  const boughtTypes = new Set(bought.map((p) => p.productType));
  const nextType = boughtTypes.has("jeans") || boughtTypes.has("bottoms") ? "top" : "jeans";
  cat.filter((p) => forG(p) && (p.productType === nextType || (nextType === "jeans" && p.productType === "bottoms"))).forEach(add);
  cat.filter((p) => forG(p) && p.productType === "accessory").forEach(add);
  const sig = await addToSig(parentOrderId);
  return picks.map((p) => ({ id: p.id, title: p.title, price: p.price, image: p.images[0], url: sig ? `${p.url}${p.url.includes("?") ? "&" : "?"}addto=${encodeURIComponent(parentOrderId)}&sig=${sig}` : p.url }));
}
__name(orderRecommendations, "orderRecommendations");

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
  "checkout-session": checkoutSession,
  "geocode": geocodeAddress,
  "order-submit": orderSubmit,
  "cron-charge-installments": cronChargeInstallments
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

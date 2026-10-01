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
      e.code = data?.error?.code || null;
      e.param = data?.error?.param || null;
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
  const c = body.customer || {};
  // geo pricing: the shipping country decides currency, markup and shipping (Romania = RON exactly as before)
  const geoCC = geoCountryCode(c.country) || "RO";
  const rule = geoRule(geoCC, await geoRates());
  const currency = rule.cur.toLowerCase();
  // customer account: tier / referral discount, free shipping, store credit (all decided here, never in the browser)
  const actx = await acctCheckoutContext(request).catch(() => null);
  const pct = actx ? actx.pct : 0;
  try { items.splice(0, items.length, ...(await acctTrustedRon(items))); } catch {}
  let order_id;
  try { order_id = await assignOrderNumber(body.order_id, "card"); }
  catch (e) { console.error("order number failed", String(e && e.message || e)); return json(503, { error: "ORDER_NUMBER_FAILED" }); }
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
  const shipping = addTo || (actx && actx.freeShip) ? 0 : rule.ship;
  if (addTo) metaBase.add_to = addTo.id;
  metaBase.geo_cc = rule.cc; metaBase.geo_cur = rule.cur; metaBase.geo_fx = String(rule.fx); metaBase.geo_ship = String(shipping);
  const shippingMinor = shipping > 0 ? Math.round(shipping * 100) : 0;
  // Server-side total, in minor units (bani) — never trust a client-sent total for what gets charged.
  const itemsTotalMinor = items.slice(0, 50).reduce((sum, it) => {
    const unit = Math.max(0, Math.round(acctApplyPct(geoPrice(it.price, rule), pct, rule.cur) * 100));
    const qty = Math.max(1, Math.min(99, Math.round(Number(it.quantity || 1))));
    return sum + unit * qty;
  }, 0);
  // store credit (RON) → this order's currency, never more than the items
  const creditMinor = actx && actx.creditRon > 0 ? Math.min(itemsTotalMinor, Math.round(geoPrice(actx.creditRon, rule) * 100)) : 0;
  const totalMinor = itemsTotalMinor + shippingMinor - creditMinor;
  if (actx) { metaBase.acct_email = actx.email; metaBase.acct_pct = String(pct); metaBase.acct_why = actx.why || ""; metaBase.acct_voucher = actx.voucher ? String(actx.voucher) : ""; metaBase.acct_credit_minor = String(creditMinor); metaBase.acct_credit_ron = String(creditMinor ? Math.min(actx.creditRon, Math.round(creditMinor / 100 / (rule.fx || 1) * 100) / 100) : 0); }

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
      return json(200, { url: session.url, id: session.id, order_id });
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
      unit_amount: Math.max(0, Math.round(acctApplyPct(geoPrice(it.price, rule), pct, rule.cur) * 100))
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
        ...(creditMinor > 0 ? { discounts: [{ coupon: (await stripeRequest("coupons", { method: "POST", params: { amount_off: creditMinor, currency, duration: "once", name: "bymarccc credit", max_redemptions: 1 } })).id }] } : {}),
        metadata: metaBase
      }
    });
    return json(200, { url: session.url, id: session.id, order_id });
  } catch (e) {
    return json(e.status || 500, { error: "STRIPE_ERROR", detail: env("ASSISTANT_DEBUG") ? String(e.message) : void 0 });
  }
}
__name(checkoutCreate, "checkoutCreate");
// Order numbers — bymarccc-3120, bymarccc-3121, … assigned ONLY here, never in the browser. D1 binding ORDERS_DB.
// The browser sends a temporary id (client_ref); the same client_ref always gets the same number (retries are safe).
// n is an INTEGER PRIMARY KEY: SQLite gives each new row max(n)+1 inside the write, so two orders can never share a
// number. A seed row (n = 3119) makes the first real order bymarccc-3120. Without the binding the temporary id is kept.
var ORDER_NO_START = 3120;
var ORDER_NO_RE = /^bymarccc-\d{4,9}$/;
var orderTableReady = null;
var ordersDb = /* @__PURE__ */ __name(() => ENV.ORDERS_DB && typeof ENV.ORDERS_DB.prepare === "function" ? ENV.ORDERS_DB : null, "ordersDb");
async function assignOrderNumber(clientRef, kind) {
  const ref = String(clientRef || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 60);
  const db = ordersDb();
  if (!db) { if (!ref) throw new Error("missing order ref"); console.error("ORDERS_DB not bound - keeping the temporary order id"); return ref; }
  if (ref.length < 6 || ORDER_NO_RE.test(ref)) throw new Error("invalid order ref");
  if (!orderTableReady) orderTableReady = db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS order_numbers (n INTEGER PRIMARY KEY, client_ref TEXT NOT NULL UNIQUE, kind TEXT, created_at TEXT NOT NULL)"),
    db.prepare("INSERT OR IGNORE INTO order_numbers (n, client_ref, kind, created_at) VALUES (?1, '__seed__', 'seed', ?2)").bind(ORDER_NO_START - 1, (/* @__PURE__ */ new Date()).toISOString())
  ]).catch((e) => { orderTableReady = null; throw e; });
  await orderTableReady;
  const res = await db.batch([
    db.prepare("INSERT INTO order_numbers (client_ref, kind, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(client_ref) DO NOTHING").bind(ref, kind, (/* @__PURE__ */ new Date()).toISOString()),
    db.prepare("SELECT n FROM order_numbers WHERE client_ref = ?1").bind(ref)
  ]);
  const n = res && res[1] && res[1].results && res[1].results[0] && res[1].results[0].n;
  if (!Number.isInteger(n) || n < ORDER_NO_START) throw new Error("no order number");
  return "bymarccc-" + n;
}
__name(assignOrderNumber, "assignOrderNumber");
// "Pay in 2" records live in KV (binding MEMBERS) when it is bound, otherwise in the ORDERS_DB D1 database
// (table kv_store) — same get/put/list shape, so the cron job works with either.
var instTableReady = null;
function instStore() {
  const k = kv();
  if (k) return k;
  const db = ordersDb();
  if (!db) return null;
  const init = () => instTableReady || (instTableReady = db.prepare("CREATE TABLE IF NOT EXISTS kv_store (k TEXT PRIMARY KEY, v TEXT NOT NULL)").run().catch((e) => { instTableReady = null; throw e; }));
  return {
    async get(key) { await init(); const r = await db.prepare("SELECT v FROM kv_store WHERE k = ?1").bind(key).first(); return r ? r.v : null; },
    async put(key, value) { await init(); await db.prepare("INSERT INTO kv_store (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(key, String(value)).run(); },
    async list({ prefix = "", cursor, limit = 200 } = {}) {
      await init();
      const off = Number(cursor || 0) || 0;
      const rs = await db.prepare("SELECT k FROM kv_store WHERE k >= ?1 AND k < ?2 ORDER BY k LIMIT ?3 OFFSET ?4").bind(prefix, prefix + "\uffff", limit, off).all();
      const keys = (rs.results || []).map((r) => ({ name: r.k }));
      return { keys, list_complete: keys.length < limit, cursor: String(off + keys.length) };
    }
  };
}
__name(instStore, "instStore");
async function recordPendingInstallment(session) {
  // Called once, right after the FIRST (deposit) payment is confirmed paid. Saves what the
  // scheduled cron-charge-installments job needs to charge the remaining 50% automatically in
  // 30 days: the Stripe customer + payment method the first charge attached the card to, the
  // amount still owed, and the due date. Stored in the same KV namespace the members system
  // already uses (binding MEMBERS), under an "inst:" prefix so the two never collide.
  const store = instStore();
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
  // Browsers send no Origin header on a same-origin GET, so this one also accepts the Referer's origin
  // (the thank-you page calls it right after Stripe sends the customer back).
  let refOrigin = "";
  try { refOrigin = new URL(request.headers.get("referer") || "").origin; } catch {}
  const viaReferer = !request.headers.get("origin") && refOrigin && checkOrigin(new Request(request.url, { headers: { origin: refOrigin } }));
  if (!checkOrigin(request) && !viaReferer) return json(403, { error: "Forbidden origin" });
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
  // CRON_SECRET if set, otherwise the GOATIFY connector secret the site already has (the cron worker holds the same value).
  const secret = env("CRON_SECRET") || env("GOATIFY_SITE_SECRET");
  if (!secret) return json(503, { error: "CRON_NOT_CONFIGURED" });
  if (request.headers.get("x-cron-secret") !== secret) return json(403, { error: "Forbidden" });
  if (!env("STRIPE_SECRET_KEY")) return json(503, { error: "STRIPE_NOT_CONFIGURED" });
  const store = instStore();
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
// ---- Catalogue: ONE source of truth = /assets/catalog.js (the same file the website renders from).
// The block between /*BEGIN-JSON*/ and /*END-JSON*/ in that file is strict JSON; we parse it here and
// derive the flat item shape used by the stylist, recommendations and the order price check.
function catalogProductType(p) {
  const t = String(p.title || "").toLowerCase(), c = p.collections || [];
  if (c.includes("accessories") || c.includes("bags") || /\b(bag|cap|hat)\b/.test(t)) return "accessory";
  if (c.includes("jackets") || /\bjacket\b/.test(t)) return "jacket";
  if (c.includes("denim") || /\bjeans?\b/.test(t)) return "jeans";
  if (c.includes("bottoms") || /sweatpants|pants|trousers|shorts|skirt/.test(t)) return "bottoms";
  if (c.includes("tops") || /hoodie|\btee\b|top|blazer|shirt|sleeve|turtleneck|pardesiu|coat/.test(t)) return "top";
  return "other";
}
__name(catalogProductType, "catalogProductType");
// Try-On config → one entry per try-on-able design: { design, garment, garmentViews[], print, reference, ok }
//   product.tryOn = { garment: "<id in tryOnGarments>", print: "<png>" }            single design
//   product.tryOn = { garment: "<id>", designs: { "<design name>": "<png>", ... } }  several designs
//   product.tryOnAssets = { "<design-slug>": "<png of the garment WITH its print>" }  legacy single-image reference
var slugify = /* @__PURE__ */ __name((x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), "slugify");
function resolveTryOn(p, garments, abs) {
  const out = [];
  const t = p.tryOn;
  if (t && t.garment) {
    const g = typeof t.garment === "string" ? garments[t.garment] : t.garment;
    const gid = typeof t.garment === "string" ? t.garment : "inline";
    const order = ["front", "three-quarter", "side", "back"];
    const views = g && g.views ? [...order.filter((v) => g.views[v]), ...Object.keys(g.views).filter((v) => !order.includes(v))].map((v) => abs(g.views[v])) : [];
    const garment = g ? { id: gid, type: g.type || null, label: g.label || null, category: g.category || null, colour: g.colour || null, fabric: g.fabric || null, fitReference: g.fitReference ? abs(g.fitReference) : null, printPlacement: g.print && g.print.placement || "centred on the chest, a little below the neckline", printWidth: Number(g.print && g.print.width) || 0.5 } : null;
    const designs = t.designs && typeof t.designs === "object" ? Object.entries(t.designs) : [[null, t.print]];
    for (const [design, val] of designs) {
      // a design is either just its PNG path, or { print, box: [x0,y0,x1,y1] artwork extent in the PNG, width: fraction of the
      // torso width, top: fraction neckline→hem, x: horizontal offset (fraction of torso width), technique: print|embroidery }
      const d = val && typeof val === "object" ? val : { print: val };
      const placement = Number(d.width) > 0 ? { width: Number(d.width), top: Number(d.top) || 0, x: Number(d.x) || 0 } : null;
      out.push({ design, slug: design ? slugify(design) : null, garment, garmentViews: views, print: d.print ? abs(d.print) : null, box: Array.isArray(d.box) && d.box.length === 4 ? d.box.map(Number) : null, placement, technique: d.technique === "embroidery" ? "embroidery" : "print", reference: null, mode: "print", ok: !!(garment && views.length && d.print) });
    }
    const dOrder = (p.designs || []).map(slugify);   // same order as the product page's design buttons
    out.sort((a, b) => (dOrder.indexOf(a.slug) + 1 || 999) - (dOrder.indexOf(b.slug) + 1 || 999));
  } else if (p.tryOnAssets && typeof p.tryOnAssets === "object") {
    for (const [slug, img] of Object.entries(p.tryOnAssets)) {
      const design = (p.designs || []).find((d) => slugify(d) === slug) || slug;
      out.push({ design, slug, garment: null, garmentViews: [], print: null, reference: abs(img), mode: "reference", ok: true });
    }
  }
  return out;
}
__name(resolveTryOn, "resolveTryOn");
function siteCatalogToItems(D, base) {
  const abs = (s) => (/^https?:/.test(s) ? s : `${base}/${String(s).replace(/^\//, "")}`);
  const jeans = (D.palettes && D.palettes.jeans) || [];
  const palette = (v) => (typeof v === "string" ? ((D.palettes || {})[v] || []).map((c) => (typeof c === "string" ? jeans.find((j) => j.id === c) : c)).filter(Boolean) : Array.isArray(v) ? v : []);
  const sizesOf = (ch) => (ch === "one-size" ? ["One size"] : typeof ch === "string" && ch.startsWith("jeans-") ? ["32", "34", "36", "38", "40", "42", "44"] : Array.isArray(ch) ? ch.map(String) : []);
  return Object.entries(D.products || {}).map(([key, p]) => {
    const productType = catalogProductType(p);
    const gender = Array.isArray(p.genders) ? p.genders : [p.gender || "men"];
    const colours = palette(p.colours);
    const sizes = p.noSize ? ["Made to measure"] : sizesOf(p.chart);
    const onSale = typeof p.salePrice === "number";
    const price = onSale ? p.salePrice : typeof p.price === "number" ? p.price : null;
    const unavailable = new Set(p.unavailable || []);
    const variants = [];
    for (const c of colours.length ? colours : [{ id: "as shown", name: "As shown" }])
      for (const s of sizes.length ? sizes : ["One size"])
        variants.push({ id: `${key}:${c.id}:${s}`, title: `${c.name} / ${s}`, colour: c.name, size: s, price, available: !p.soldOut && !unavailable.has(`${c.id}:${s}`) });
    const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 2);
    const tags = [...new Set([...(p.collections || []), ...gender, productType, ...words(p.cut), ...colours.map((c) => c.id), ...(p.designs || []).map((d) => String(d).toLowerCase()), ...(onSale || (p.collections || []).includes("sales") ? ["sale"] : []), ...(/pardesiu|coat/i.test(p.title) ? ["coat"] : [])])];
    return {
      id: key, handle: key, title: p.title, productType, gender, tags,
      url: `${base}/bymarccc-product.html?p=${encodeURIComponent(key)}`,
      price, compareAtPrice: onSale && typeof p.price === "number" ? p.price : null, currency: p.currency || "RON",
      description: [p.cut, p.description].filter(Boolean).join(" "),
      details: p.details || [],
      images: (p.gallery || []).map((g) => abs(g.src)),
      options: ["Colour", "Size"], variants,
      sizeChart: typeof p.chart === "string" && p.chart.startsWith("jeans-") ? p.chart : null,
      needsBody: !!p.needsBody,
      designs: p.designs || [], designImages: p.designImages || {},
      tryOnResolved: resolveTryOn(p, D.tryOnGarments || {}, abs)
    };
  });
}
__name(siteCatalogToItems, "siteCatalogToItems");
var CATALOG_DATA = { t: 0, data: null };
async function loadCatalogData() {
  if (Date.now() - CATALOG_DATA.t < 5 * 6e4 && CATALOG_DATA.data) return CATALOG_DATA.data;
  const base = (env("BYMARCCC_SITE_URL", "") || CURRENT_ORIGIN).replace(/\/$/, "");
  try {
    const url = `${base}/assets/catalog.js`;
    const r = ENV.ASSETS && typeof ENV.ASSETS.fetch === "function" ? await ENV.ASSETS.fetch(new Request(url)) : await fetch(url);
    if (r.ok) {
      const src = await r.text();
      const a = src.indexOf("/*BEGIN-JSON*/"), b = src.indexOf("/*END-JSON*/");
      if (a !== -1 && b > a) CATALOG_DATA = { t: Date.now(), data: JSON.parse(src.slice(a + 14, b)) };
    }
  } catch (e) {
    stylistLog && stylistLog("catalog-parse-failed", { error: String(e && e.message || e).slice(0, 200) });
  }
  return CATALOG_DATA.data;
}
__name(loadCatalogData, "loadCatalogData");
async function loadCatalog() {
  if (Date.now() - cache.t < 5 * 6e4 && cache.items.length) return cache.items;
  const base = (env("BYMARCCC_SITE_URL", "") || CURRENT_ORIGIN).replace(/\/$/, "");
  const D = await loadCatalogData();
  const items = D ? siteCatalogToItems(D, base) : [];
  // a TRY ON button must never appear for a garment/print file that isn't actually deployed
  const urls = [...new Set(items.flatMap((p) => p.tryOnResolved.filter((d) => d.ok).flatMap((d) => [...d.garmentViews, d.print, d.reference, d.garment && d.garment.fitReference].filter(Boolean))))];
  const exists = new Map(await Promise.all(urls.map(async (u) => {
    try { const r = ENV.ASSETS && typeof ENV.ASSETS.fetch === "function" && u.startsWith(base) ? await ENV.ASSETS.fetch(new Request(u, { method: "HEAD" })) : await fetch(u, { method: "HEAD" }); return [u, r.ok]; } catch { return [u, false]; }
  })));
  for (const p of items) for (const d of p.tryOnResolved) {
    if (!d.ok) { stylistLog("tryon-config-incomplete", { product: p.id, design: d.design, garment: !!d.garment, garmentViews: d.garmentViews.length, print: !!d.print }); continue; }
    const missing = [d.garmentViews[0], d.print, d.reference].filter((u) => u && !exists.get(u));
    d.garmentViews = d.garmentViews.filter((u, i) => i === 0 || exists.get(u));   // optional extra views (side/back…) are simply skipped when absent
    if (d.garment && d.garment.fitReference && !exists.get(d.garment.fitReference)) d.garment = { ...d.garment, fitReference: null };
    if (missing.length) { d.ok = false; d.missing = missing; stylistLog("tryon-asset-missing", { product: p.id, design: d.design, missing }); }
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
// ---------------------------------------------------------------------------------------------------------------
// Stylist catalogue layer — normalises the catalogue (assets/catalog.js) into one product shape, parses a request into filters, and
// searches in stages: strict first, then OPTIONAL filters are relaxed one by one (never the gender the customer
// asked for). assets/catalog.js stays the only source of truth: nothing here invents a product, price, size or URL.
// ---------------------------------------------------------------------------------------------------------------
var SC_WORDS = {
  gender: { women: "women", woman: "women", womens: "women", female: "women", ladies: "women", lady: "women", girl: "women", girls: "women", her: "women", femei: "women", femeie: "women", dama: "women", damă: "women", fete: "women",
    men: "men", man: "men", mens: "men", male: "men", guy: "men", guys: "men", boy: "men", boys: "men", him: "men", barbati: "men", bărbați: "men", barbat: "men", bărbat: "men", baieti: "men", băieți: "men", unisex: "unisex" },
  // word → [category, subcategory]
  kind: { top: ["tops"], tops: ["tops"], topuri: ["tops"], tee: ["tops", "t-shirt"], tees: ["tops", "t-shirt"], tshirt: ["tops", "t-shirt"], "t-shirt": ["tops", "t-shirt"], "t-shirts": ["tops", "t-shirt"], tricou: ["tops", "t-shirt"], tricouri: ["tops", "t-shirt"],
    shirt: ["tops"], shirts: ["tops"], camasa: ["tops"], cămașă: ["tops"], bluza: ["tops"], bluză: ["tops"], blouse: ["tops"], tank: ["tops", "tank"], tanks: ["tops", "tank"], crop: ["tops", "baby-top"], cropped: ["tops", "baby-top"], "crop-top": ["tops", "baby-top"], croptop: ["tops", "baby-top"], baby: ["tops", "baby-top"], "long-sleeve": ["tops", "long-sleeve"], longsleeve: ["tops", "long-sleeve"],
    hoodie: ["tops", "hoodie"], hoodies: ["tops", "hoodie"], hanorac: ["tops", "hoodie"], hanorace: ["tops", "hoodie"], sweatshirt: ["tops", "hoodie"], sweatshirts: ["tops", "hoodie"], sweater: ["tops"], jumper: ["tops"],
    bottom: ["bottoms"], bottoms: ["bottoms"], pants: ["bottoms"], trousers: ["bottoms"], pantaloni: ["bottoms"], sweatpants: ["bottoms", "sweatpants"], joggers: ["bottoms", "sweatpants"], shorts: ["bottoms", "shorts"], short: ["bottoms", "shorts"], skirt: ["bottoms", "skirt"], skirts: ["bottoms", "skirt"], fusta: ["bottoms", "skirt"], fustă: ["bottoms", "skirt"],
    jeans: ["jeans"], jean: ["jeans"], denim: ["jeans"], blugi: ["jeans"], blug: ["jeans"],
    jacket: ["outerwear", "jacket"], jackets: ["outerwear", "jacket"], geaca: ["outerwear", "jacket"], geacă: ["outerwear", "jacket"], jacheta: ["outerwear", "jacket"], jachetă: ["outerwear", "jacket"], coat: ["outerwear", "coat"], coats: ["outerwear", "coat"], palton: ["outerwear", "coat"], blazer: ["outerwear", "blazer"], blazers: ["outerwear", "blazer"], outerwear: ["outerwear"],
    bag: ["accessories", "bag"], bags: ["accessories", "bag"], geanta: ["accessories", "bag"], geantă: ["accessories", "bag"], duffle: ["accessories", "bag"], cap: ["accessories", "cap"], caps: ["accessories", "cap"], hat: ["accessories", "cap"], sapca: ["accessories", "cap"], șapcă: ["accessories", "cap"], accessory: ["accessories"], accessories: ["accessories"], accesorii: ["accessories"], jewelry: ["accessories"], jewellery: ["accessories"] },
  fit: { skinny: "skinny", slim: "skinny", relaxed: "relaxed", loose: "relaxed", straight: "straight", oversized: "oversized", baggy: "oversized", wide: "wide", "wide-leg": "wide" },
  color: { black: "black", negru: "black", neagra: "black", white: "white", alb: "white", alba: "white", grey: "grey", gray: "grey", gri: "grey", blue: "blue", albastru: "blue", red: "red", rosu: "red", roșu: "red", pink: "pink", roz: "pink", purple: "purple", mov: "purple", green: "green", verde: "green",
    orange: "orange", brown: "brown", maro: "brown", burgundy: "burgundy", fuchsia: "fuchsia", silver: "silver", argintiu: "silver", yellow: "yellow", galben: "yellow", beige: "beige", bej: "beige" },
  occasion: { party: "party", parties: "party", petrecere: "party", club: "party", clubbing: "party", night: "party", nightout: "party", date: "party", birthday: "party", casual: "casual", everyday: "casual", daily: "casual", weekend: "casual", work: "smart", office: "smart", smart: "smart", dinner: "smart", event: "smart" },
  style: { streetwear: "streetwear", street: "streetwear", urban: "streetwear", hiphop: "streetwear", skate: "streetwear", elegant: "elegant", classy: "elegant", chic: "elegant", tailored: "elegant", formal: "elegant", eleganta: "elegant", elegantă: "elegant", statement: "statement", bold: "statement", edgy: "statement", artistic: "statement", minimal: "minimal", minimalist: "minimal", basic: "minimal", basics: "minimal", simple: "minimal", clean: "minimal", essentials: "minimal" },
  collection: { sale: "sale", sales: "sale", reduceri: "sale", reducere: "sale", discount: "sale" }
};
var SC_CAT_BROADER = { jeans: "bottoms" };   // relaxing "jeans" widens to all bottoms
function scNorm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, ""); }
function scWords(s) { return scNorm(s).replace(/night out/g, "nightout").replace(/long sleeve/g, "long-sleeve").replace(/wide leg/g, "wide-leg").replace(/t shirt/g, "t-shirt").split(/[^a-z0-9-]+/).filter(Boolean).map((w) => w.replace(/s$/, (m) => ["tops", "jeans", "shorts", "pants", "trousers", "sweatpants", "joggers", "accessories", "bottoms", "mens", "womens", "boys", "girls", "guys", "ladies", "tees", "tanks", "sales"].includes(w) ? m : "")); }
function scLook(dict, w) { return dict[w] ?? dict[scNorm(w)] ?? dict[w + "s"]; }
// catalogue item → the stylist's normalised product shape
function normalizeProduct(p) {
  const tags = (p.tags || []).map((t) => scNorm(t));
  const title = scNorm(p.title), desc = scNorm(p.description), type = scNorm(p.productType);
  const text = ` ${title} ${tags.join(" ")} ${type} `;
  const has = (...ws) => ws.some((w) => text.includes(` ${w} `) || text.includes(` ${w}s `));
  let category, subcategory = null;
  if (type === "jeans" || tags.includes("jeans")) category = "jeans";
  else if (type === "jacket" || has("jacket", "blazer", "coat")) { category = "outerwear"; subcategory = has("blazer") ? "blazer" : has("coat") ? "coat" : "jacket"; }
  else if (type === "accessory" || has("bag", "cap", "accessory", "accessories")) { category = "accessories"; subcategory = has("bag", "duffle") ? "bag" : has("cap") ? "cap" : null; }
  else if (type === "top" || has("top", "tops", "t-shirt", "tee", "hoodie", "shirt", "tank")) category = "tops";
  else if (type === "bottoms" || has("bottoms", "skirt", "shorts", "sweatpants", "pants")) category = "bottoms";
  else if (/skirt|shorts|sweatpants|pants|trousers/.test(title)) category = "bottoms";
  else category = "other";
  if (!subcategory) {
    if (category === "tops") subcategory = has("hoodie", "sweatshirt") ? "hoodie" : /tank/.test(title) ? "tank" : /long sleeve/.test(title) ? "long-sleeve" : /blazer/.test(title) ? "blazer" : has("t-shirt", "tee") || /tee|t-shirt/.test(title) ? "t-shirt" : /baby top/.test(title) ? "baby-top" : null;
    else if (category === "bottoms") subcategory = /skirt/.test(title) ? "skirt" : /short/.test(title) ? "shorts" : /sweatpants|jogger/.test(title) ? "sweatpants" : null;
  }
  const colors = [...new Set([...(p.variants || []).map((v) => scNorm(v.colour)).filter((c) => c && c !== "as shown"), ...tags.filter((t) => Object.values(SC_WORDS.color).includes(t)), ...Object.values(SC_WORDS.color).filter((c) => title.includes(c))])];
  const sizes = [...new Set((p.variants || []).filter((v) => v.available !== false && v.size).map((v) => v.size))];
  const fit = ["skinny", "relaxed", "straight", "oversized", "wide"].find((f) => tags.includes(f) || title.includes(f) || desc.startsWith(f)) || null;
  // occasions: derived from what the piece is (sequins/blazers/statement pieces → party), never invented per product
  const occasions = [];
  if (/sequin|diamond|rocks|silver|blazer|delulu|muse|mini skirt|baby top|coat/.test(title) || tags.includes("holographic")) occasions.push("party");
  if (/blazer|coat|long sleeve/.test(title)) occasions.push("smart");
  if (["tops", "jeans", "bottoms", "accessories"].includes(category) && !/sequin|diamond/.test(title)) occasions.push("casual");
  if (category === "jeans") occasions.push("party");   // statement hand-painted denim is BYMARCCC's night-out signature
  const available = (p.variants || []).some((v) => v.available !== false);
  // style: derived from what the piece is, never invented per product
  const style = new Set(tags.filter((t) => ["oversized", "printed", "logo", "denim", "holographic"].includes(t)));
  if (/hoodie|t-shirt|tank|long-sleeve|sweatpants|cap/.test(subcategory || "") || category === "jeans" || fit === "oversized" || /zebra|cross|alien|logo|patch/.test(title)) style.add("streetwear");
  if (/blazer|coat|pardesiu|elegant|lace|skirt/.test(title)) style.add("elegant");
  if (/sequin|diamond|rocks|hand-painted|painted|embroider|patch|zebra|art|van gogh|delulu|muse|glitter|flame|butterfly|high heels/.test(`${title} ${desc}`)) style.add("statement");
  if (!(p.designs || []).length && /^(black|white|grey|burgundy) (tee|hoodie|long sleeve)/.test(title)) style.add("minimal");
  const tryOnDesigns = (p.tryOnResolved || []).filter((d) => d.ok);
  const images = p.images || [];
  return { id: p.id, title: p.title, handle: p.handle || p.id, url: p.url, description: p.description || "", gender: p.gender || [], category, subcategory, product_type: p.productType || null,
    tags: p.tags || [], colors, sizes, fit, style: [...style], occasions: [...new Set(occasions)], designs: p.designs || [],
    price: typeof p.price === "number" ? p.price : null, compare_at_price: p.compareAtPrice || null, currency: p.currency || "RON", available, inventory_status: available ? "in_stock" : "out_of_stock",
    featured_image: images[0] || null, images,
    // Virtual Try-On: only products/designs whose garment (+ print) assets are configured in assets/catalog.js AND exist
    try_on_image: tryOnDesigns.length ? tryOnDesigns[0].garmentViews[0] || tryOnDesigns[0].reference : null,
    try_on_designs: tryOnDesigns.map((d) => d.design).filter(Boolean),
    print_overlay_image: tryOnDesigns.length ? tryOnDesigns[0].print || null : null, _raw: p };
}
// free text + tool args → structured filters
function parseStylistIntent(args = {}) {
  const f = { gender: null, category: null, subcategory: null, colors: [], sizes: [], fit: null, occasion: null, style: null, collection: null, min_price: null, max_price: null, text: [] };
  const take = (w) => {
    const g = scLook(SC_WORDS.gender, w); if (g) { f.gender = f.gender || g; return; }
    const k = scLook(SC_WORDS.kind, w); if (k) { if (!f.category || f.category === SC_CAT_BROADER[k[0]] || (k[0] === "jeans")) f.category = k[0]; if (k[1]) f.subcategory = k[1]; return; }
    const fi = scLook(SC_WORDS.fit, w); if (fi) { f.fit = fi; return; }
    const c = scLook(SC_WORDS.color, w); if (c) { if (!f.colors.includes(c)) f.colors.push(c); return; }
    const o = scLook(SC_WORDS.occasion, w); if (o) { f.occasion = f.occasion || o; return; }
    const st = scLook(SC_WORDS.style, w); if (st) { f.style = f.style || st; return; }
    const col = scLook(SC_WORDS.collection, w); if (col) { f.collection = col; return; }
    if (/^(xxs|xs|s|m|l|xl|xxl|\d{2})$/i.test(w) && w.length <= 3) return;   // sizes are read from args.size only
    if (!STOPWORDS.includes(w) && w.length > 2 && !["clothing", "clothes", "haine", "outfit", "outfits", "give", "get", "got", "have", "like", "love", "please", "tonight", "today", "wearing", "suggest", "recommend", "vreau", "arata", "cauta", "ceva", "pentru", "find", "show", "want", "need", "looking", "something", "some", "any", "all", "style", "outfit", "look", "wear", "what", "should", "with", "and", "or", "the", "for", "item", "items", "piece", "pieces", "product", "products", "bymarccc", "collection", "catalogue", "catalog"].includes(w)) f.text.push(w);
  };
  for (const key of ["gender", "category", "collection", "subcategory", "fit", "color", "colour", "occasion", "style", "query"]) if (args[key]) scWords(Array.isArray(args[key]) ? args[key].join(" ") : args[key]).forEach(take);
  if (args.size) f.sizes = String(args.size).split(/[,\s/]+/).filter(Boolean);
  // prices: ignore 0 / negative / non-numbers (models often send 0 for "no limit")
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  f.max_price = num(args.max_price); f.min_price = num(args.min_price);
  return f;
}
function scMatch(p, f, skip) {
  if (f.gender && !skip.has("gender")) { if (f.gender === "unisex" ? p.gender.length < 2 : !p.gender.includes(f.gender)) return false; }
  if (f.category && !skip.has("category")) { const cat = skip.has("category_narrow") ? (SC_CAT_BROADER[f.category] || f.category) : f.category; if (!(p.category === cat || (cat === "bottoms" && p.category === "jeans"))) return false; }
  if (f.subcategory && !skip.has("subcategory") && p.subcategory !== f.subcategory) return false;
  if (f.fit && !skip.has("fit") && p.fit !== f.fit) return false;
  if (f.colors.length && !skip.has("color") && !f.colors.some((c) => p.colors.includes(c))) return false;
  if (f.sizes.length && !skip.has("size") && !f.sizes.some((s) => p.sizes.map(String).map((x) => x.toLowerCase()).includes(s.toLowerCase()))) return false;
  if (f.occasion && !skip.has("occasion") && !p.occasions.includes(f.occasion)) return false;
  if (f.style && !skip.has("style") && !p.style.includes(f.style)) return false;
  if (f.collection === "sale" && !skip.has("collection") && !(p.compare_at_price || p.tags.map(scNorm).some((t) => t === "sale" || t === "sales"))) return false;
  if (f.text.length && !skip.has("keywords") && !f.category && !f.subcategory && !f.occasion && !f.style && !f.collection) { const hay = scNorm(`${p.title} ${p.tags.join(" ")} ${p.description}`); if (!f.text.some((w) => hay.includes(w))) return false; }
  if (f.max_price && !skip.has("price") && !(p.price != null && p.price <= f.max_price)) return false;
  if (f.min_price && !skip.has("price") && !(p.price != null && p.price >= f.min_price)) return false;
  return true;
}
function scScore(p, f) {
  let s = p.available ? 5 : 0;
  const hay = scNorm(`${p.title} ${p.tags.join(" ")} ${p.description}`);
  for (const w of f.text) if (hay.includes(w)) s += scNorm(p.title).includes(w) ? 4 : 1;
  if (f.fit && p.fit === f.fit) s += 2; if (f.colors.some((c) => p.colors.includes(c))) s += 2;
  if (f.style && p.style.includes(f.style)) s += 2; if (f.occasion && p.occasions.includes(f.occasion)) s += 1;
  return s;
}
// staged search → { products, applied_filters, relaxed_filters, stages }
function stylistSearch(items, args = {}) {
  const f = parseStylistIntent(args);
  const catalog = items.map(normalizeProduct);
  // relax order: least important first; gender is never relaxed when the customer gave it
  const steps = [["keywords"], ["color"], ["size"], ["style"], ["occasion"], ["fit"], ["subcategory"], ["category_narrow"], ["price"], ["collection"], ["category"]];
  const skip = new Set(), relaxed = [], stages = [];
  const applicable = { keywords: f.text.length, color: f.colors.length, size: f.sizes.length, style: f.style, occasion: f.occasion, fit: f.fit, subcategory: f.subcategory, category_narrow: f.category && SC_CAT_BROADER[f.category], price: f.max_price || f.min_price, collection: f.collection, category: f.category };
  let res = catalog.filter((p) => scMatch(p, f, skip));
  stages.push({ stage: "strict", matches: res.length });
  for (const [k] of steps) {
    if (res.length) break;
    if (!applicable[k]) continue;
    skip.add(k); relaxed.push(k === "category_narrow" ? `${f.category} → ${SC_CAT_BROADER[f.category]}` : k === "keywords" ? `"${f.text.join(" ")}"` : k);
    res = catalog.filter((p) => scMatch(p, f, skip));
    stages.push({ stage: `without ${k}`, matches: res.length });
  }
  // genuine zero: the only descriptive filter was free text that matches nothing — showing "everything for men" isn't a match
  if (skip.has("keywords") && !f.category && !f.subcategory && !f.occasion && !f.style && !f.fit && !f.colors.length && !f.collection) { stages.push({ stage: "keywords were the only filter", matches: 0 }); res = []; }
  if (args.in_stock === true && res.some((p) => p.available)) res = res.filter((p) => p.available);
  res.sort((a, b) => scScore(b, f) - scScore(a, f));
  const { text, ...shown } = f;
  const applied = Object.fromEntries(Object.entries(shown).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
  return { products: res, catalog_count: catalog.length, applied_filters: applied, relaxed_filters: relaxed, stages };
}
// outfit: one real piece per slot, same gender, suited to the occasion when possible
function stylistOutfit(items, args = {}) {
  const f = parseStylistIntent(args);
  const all = items.map(normalizeProduct);
  const slotOf = (p) => p.category === "tops" ? "top" : p.category === "jeans" || p.category === "bottoms" ? "bottom" : p.category === "outerwear" ? "outerwear" : p.category === "accessories" ? "accessory" : null;
  // "what goes with this?" — build around a real anchor piece
  const anchor = args.with_product_id ? all.find((p) => p.id === String(args.with_product_id) || p.handle === String(args.with_product_id)) : null;
  if (anchor && !f.gender && anchor.gender.length === 1) f.gender = anchor.gender[0];
  if (anchor && !f.style && anchor.style.includes("elegant")) f.style = "elegant";
  const catalog = all.filter((p) => p.available && (!f.gender || p.gender.includes(f.gender)));
  const slots = ["top", "bottom", "outerwear", "accessory"];
  const exclude = new Set([].concat(args.exclude_ids || []).map(String));
  const look = [], missing = [];
  for (const slot of slots) {
    if (anchor && slotOf(anchor) === slot) { look.push({ slot, product: anchor, anchor: true }); continue; }
    let pool = catalog.filter((p) => slotOf(p) === slot && !exclude.has(p.id) && (!anchor || p.id !== anchor.id));
    const byOcc = f.occasion ? pool.filter((p) => p.occasions.includes(f.occasion)) : pool;
    const bySty = f.style ? byOcc.filter((p) => p.style.includes(f.style)) : byOcc;
    const byColor = f.colors.length ? bySty.filter((p) => f.colors.some((c) => p.colors.includes(c))) : bySty;
    pool = byColor.length ? byColor : bySty.length ? bySty : byOcc.length ? byOcc : pool;
    if (!pool.length) { if (slot !== "outerwear") missing.push(slot); continue; }
    pool.sort((a, b) => scScore(b, f) - scScore(a, f));
    look.push({ slot, product: pool[Math.floor((Number(args.variation) || 0) % Math.min(pool.length, 3))] || pool[0] });
  }
  return { look, missing, gender: f.gender, occasion: f.occasion, style: f.style, anchor: anchor ? anchor.id : null, catalog_count: catalog.length };
}
function stylistCard(p) {   // what the chat renders
  return { id: p.id, handle: p.handle, title: p.title, url: p.url, image: p.featured_image, price: p.price, compareAtPrice: p.compare_at_price, currency: p.currency, available: p.available, inStock: p.available,
    availableSizes: p.sizes, gender: p.gender, type: p.category, tags: p.tags.slice(0, 8), tryOnImage: p.try_on_image || null, tryOnDesigns: p.try_on_designs || [], designs: p.designs || [], priceNote: p.price == null ? "not priced yet - tell the customer to ask on the site" : null };
}
function stylistModelView(p) {   // what the LLM sees — every field comes from the catalogue
  return { product_id: p.id, product_name: p.title, category: p.category, subcategory: p.subcategory, gender: p.gender.length > 1 ? "unisex" : p.gender[0] || null, fit: p.fit, colors: p.colors, occasions: p.occasions,
    price: p.price, currency: p.currency, stock_status: p.inventory_status, sizes: p.sizes, product_url: p.url, style: p.style, designs: p.designs && p.designs.length ? p.designs : void 0, try_on_available: !!p.try_on_image, try_on_designs: p.try_on_designs && p.try_on_designs.length ? p.try_on_designs : void 0 };
}
function stylistLog(event, data) { if (env("ASSISTANT_DEBUG")) console.log(JSON.stringify({ at: "stylist", event, ...data })); }   // dev only, never sent to customers
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
  { type: "function", name: "search_products", description: "Search the real BYMARCCC catalogue — the ONLY source of truth for products, prices, stock, sizes and URLs. Understands natural language (e.g. 'women tops', 'men skinny jeans', 'party', colours, Romanian). If there is no exact match it relaxes optional filters (colour, fit, subcategory…) but never the gender, and says so in `note` and `relaxed_filters`.", parameters: { type: "object", properties: { query: { type: "string", description: "The customer's request in their own words (Romanian or English)." }, gender: { type: "string", description: "women, men or unisex — only when the customer said it." }, category: { type: "string", description: "tops, bottoms, jeans, outerwear, accessories (synonyms OK: tees, hoodies, skirts, bags…)" }, subcategory: { type: "string", description: "e.g. t-shirt, hoodie, tank, skirt, shorts, blazer, bag, cap" }, fit: { type: "string", description: "skinny, relaxed, straight, oversized, wide" }, color: { type: "string" }, size: { type: "string" }, occasion: { type: "string", description: "party, casual, smart" }, style: { type: "string", description: "streetwear, elegant, statement, minimal" }, collection: { type: "string", description: "sale" }, min_price: { type: "number" }, max_price: { type: "number", description: "Only when the customer gave a budget." }, in_stock: { type: "boolean" }, limit: { type: "number" } } } },
  { type: "function", name: "build_outfit", description: "Build a complete look from REAL catalogue pieces (top + bottom, plus outerwear and an accessory when they exist) for styling requests like 'style me for a party', 'build me an outfit', 'what should I wear'. Returns the pieces and which slots the catalogue can't fill.", parameters: { type: "object", properties: { gender: { type: "string", description: "women or men (ask with askGenderChoice first if unknown)" }, occasion: { type: "string" }, style: { type: "string", description: "streetwear, elegant, statement, minimal" }, color: { type: "string" }, query: { type: "string" }, with_product_id: { type: "string", description: "Build the look AROUND this real product (e.g. 'what goes with this top?'). Use the product_id from a previous tool result." }, exclude_ids: { type: "array", items: { type: "string" }, description: "product ids already shown, for a different look" }, variation: { type: "number" } } } },
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
      const r = stylistSearch(items, args);
      const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 50);
      const shown = r.products.slice(0, limit);
      stylistLog("search", { query: args, parsed: r.applied_filters, catalog: r.catalog_count, stages: r.stages, relaxed: r.relaxed_filters, returned: shown.map((p) => p.id) });
      const note = !r.catalog_count ? "CATALOGUE_UNAVAILABLE: the catalogue could not be loaded — tell the customer to try again in a moment; do not claim products don't exist."
        : !shown.length ? "NO_MATCH: nothing in the catalogue matches, even after relaxing optional filters. Only now may you say BYMARCCC doesn't carry it; suggest a related category."
        : r.relaxed_filters.length ? `CLOSEST_MATCHES: no exact match for [${r.relaxed_filters.join(", ")}]; these are the closest real products. Say plainly which constraint you relaxed, then present them.`
        : "EXACT_MATCHES";
      return { modelResult: { note, total: r.products.length, applied_filters: r.applied_filters, relaxed_filters: r.relaxed_filters, products: shown.map(stylistModelView) }, uiProducts: shown.map(stylistCard) };
    }
    case "build_outfit": {
      const o = stylistOutfit(items, args);
      stylistLog("outfit", { query: args, gender: o.gender, occasion: o.occasion, style: o.style, anchor: o.anchor, catalog: o.catalog_count, pieces: o.look.map((x) => `${x.slot}:${x.product.id}`), missing: o.missing });
      return { modelResult: { note: o.look.length ? (o.missing.length ? `PARTIAL_LOOK: the catalogue has no ${o.missing.join(" / ")} for this — say so, don't invent it.` : "FULL_LOOK") : "NO_PIECES", gender: o.gender || "any", occasion: o.occasion, style: o.style || void 0, built_around: o.anchor || void 0, look: o.look.map((x) => ({ slot: x.slot, ...(x.anchor ? { anchor: true } : {}), ...stylistModelView(x.product) })), missing: o.missing },
        uiProducts: o.look.map((x) => stylistCard(x.product)) };
    }
    case "get_product": {
      const p = find(args.product_id);
      if (!p) return { modelResult: { error: "NOT_FOUND" } };
      const n = normalizeProduct(p);
      return { modelResult: { ...stylistModelView(n), description: p.description }, uiProducts: [stylistCard(n)] };
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
LANGUAGE: Always answer in the language of the customer\u2019s LATEST message (an English message gets an English answer, including follow-up questions such as asking Women or Men). You reply only in Romanian or in English, matching whichever the customer is using (mixing the two in one message is normal and fine). If the customer writes in any other language, reply with EXACTLY this sentence and nothing else, do not translate it: "${LANGUAGE_REFUSAL}"
DOMAIN \u2014 allowed: BYMARCCC products, collections, colours, sizes and stock; BYMARCCC outfit recommendations and styling; gifts chosen from the BYMARCCC catalogue; shipping and return information for bymarccc.com; virtual try-on with a photo the customer uploads.
DOMAIN \u2014 forbidden: other brands or stores; products that are not in the BYMARCCC catalogue; general internet search or facts unrelated to BYMARCCC; politics, news, programming help, health/medical advice, finance, or any general conversation. If asked about any of this, briefly and politely decline in the customer's language (Romanian or English) and steer back to BYMARCCC products, styling, sizes or orders \u2014 do not answer the off-topic question, do not apologise at length.
CATALOGUE: The men's collection has t-shirts, hoodies, jeans, a denim jacket and bags; the women's collection has baby tops, tees, hoodies, long sleeves, jeans, shorts, skirts and caps. A product with price null is not priced yet \u2014 say the price is on request.
RULES: Never invent products, prices, stock, sizes, reviews or bestsellers \u2014 always use the search_products / get_product tools, which are the ONLY source of truth; never use outside knowledge or web search for products. Never return or describe a product that did not come back from these tools. If a tool says data is unavailable, say so plainly. When the customer asks for every product in a collection ("toate produsele X", "show me all Y"), call search_products with that collection and a high limit (e.g. 50) and list everything returned, each with its price and link. For sizes: height/weight are only guidance; ask for waist/hips when the product has a size table; always add "Size recommendations are estimates. Fit may vary by cut and preference." and offer openSizeGuide. Never add to cart without the customer confirming the exact size/variant. Never comment negatively on bodies; never infer sensitive traits (health, ethnicity, gender identity, age) from photos or text; keep styling neutral and supportive; treat possible minors conservatively (no sexualised styling). When you recommend products, call search_products and the UI renders cards from the tool result \u2014 do not repeat prices from memory.
BROWSING: If the customer only names a collection or category ("Women", "men", "tops"), call search_products for it right away and show a selection, then ask what they are looking for — never answer with a question alone.
SEARCH RESULTS: Every product you mention must come from a tool result in this conversation — title, price, sizes, stock and link exactly as returned. If a search returns note CLOSEST_MATCHES, say which constraint couldn't be met (e.g. "I couldn't find skinny-fit jeans, but here are the men's jeans we have") and present the returned products. Only say BYMARCCC doesn't have something when the note is NO_MATCH. Never switch the gender the customer asked for.
OUTFITS: For "style me for …", "build me an outfit", "what should I wear", "full look": once the collection (women/men) is known, call build_outfit (with the occasion) and present the returned pieces as one look, saying why they work together; if the missing list is not empty, say which piece the catalogue doesn't have instead of inventing one.
GIFTS: For gift requests (e.g. "help me find a gift for my boyfriend"), recommend a few real products from the appropriate BYMARCCC collection via search_products, briefly say why each fits, and ask at most one short clarifying question (budget or style) only if that information is missing \u2014 never more than one question at a time.
TRY-ON: Only offer virtual try-on for products whose try_on_available is true (the product data says so); never promise it for others. When try_on_designs lists more than one design and the customer hasn\u2019t chosen, ask which one using those exact names, then pass it as design. For virtual try-on requests, first make sure exactly one product is chosen (ask the customer to pick one if it isn't already clear), then call generate_try_on with that product's product_id, the language you are replying in, and \u2014 if an earlier message in this conversation told you the customer's uploaded photo reference (a line like "Photo uploaded, reference id: ...") \u2014 that exact id as user_image_file_id. If no such id has been given to you yet, call generate_try_on with just product_id and language; the browser will ask the customer to upload a photo itself. Never invent a user_image_file_id. The result preserves the customer's face, identity, posture, proportions and background, and changes only the requested garment \u2014 never add logos or products that don't exist in the catalogue.
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
  const out = await runTool(b.name, b.args || {});
  // voice mode: the browser renders `products` as cards and passes the rest to the model
  return json(200, out.modelResult !== void 0 ? { ...out.modelResult, products: out.uiProducts || [] } : out);
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
var TRYON_MIN_SIDE = 256;
// ---- Virtual Try-On (separate from catalogue search: one selected product -> one edited photo) ----
// Nothing here is persisted: the customer photo lives only in PHOTO_STORE (in-memory, single use,
// 5 min TTL) or in the request body, and the generated image is returned to the browser and never stored.
var tryErr = /* @__PURE__ */ __name((status, code, message) => json(status, { error: code, code, message }), "tryErr");
function tryOnRegion(category) {
  if (category === "bottoms" || category === "jeans") return "the lower-body garment (trousers / jeans / shorts / skirt)";
  if (category === "outerwear") return "the outer layer (jacket / blazer / coat), worn over the customer's existing top";
  return "the upper-body garment (top / t-shirt / shirt / hoodie / sweatshirt)";
}
__name(tryOnRegion, "tryOnRegion");
var TRYON_IDENTITY = "IMAGE 1 is the customer's own photo: it is the base image and the only source of identity. The ONLY change allowed is replacing the customer's upper-body garment; every other pixel must stay as in IMAGE 1. Keep exactly: identity, face and facial features (eyes, nose, mouth), skin tone, hairstyle, hair length and hair colour, body shape and proportions, pose, arms, hands, visible tattoos, lower-body clothing, the accessories that are already in IMAGE 1 (and only those), camera angle, framing, lighting and background (change the background only where the new garment physically covers or reveals it). Do not beautify, slim, reshape or retouch the person, and do not regenerate anything that doesn't have to change.\n\nNO REMOVALS: everything already in IMAGE 1 that is not the upper-body garment stays exactly where it is \u2014 a bag held in the hand or on the arm, a phone, sunglasses, jewellery, a watch. Never remove or crop out an object the person is holding.\n\nNO ADDITIONS: do not add anything that is not in IMAGE 1 \u2014 no bag, handbag, shoulder strap, bra or tank strap, necklace, chain, jewellery, watch, belt, scarf, jacket, extra layer or undershirt, logo, object, prop, text, or new background element, and do not change the hair. If IMAGE 1 shows no bag or strap, the result shows no bag or strap. The reference images may show other things (another model, other clothes, a background): take NOTHING from them except the garment itself.";
var TRYON_PHYSICS = "Do NOT paste the reference flat over the photo. Re-render the garment as actually worn by this customer: conforming in 3D to their shoulders, chest/bust, waist and torso rotation, with gravity, realistic drape, folds, stretch and compression, correct perspective, and the photo's own lighting direction, shadows and highlights. Handle occlusion: anything in front of the garment in the photo (hair, arms, hands, bag straps) stays in front of it. Nothing may look like it floats above the photograph.";
function tryOnMeta(n, g, design) {
  return [`Title: ${n.title}`, `Garment: ${g && g.label || [n.category, n.subcategory].filter(Boolean).join(" / ")}${g && g.type ? ` (${g.type})` : ""}`, n.colors.length ? `Colour: ${n.colors.join(", ")}` : "", n.fit ? `Fit: ${n.fit}` : "", design ? `Design: ${design}` : "", n.description ? `Description: ${n.description.replace(/\s+/g, " ").slice(0, 300)}` : ""].filter(Boolean).join("\n");
}
__name(tryOnMeta, "tryOnMeta");
// STAGE 1 (print products): customer + REAL BLANK garment -> customer wearing it, with a chroma-key panel where the
// print goes. The exact print PNG is NEVER shown to the image model; the browser warps the original artwork onto that
// panel (stages 2-4), so logos, typography and spelling stay pixel-exact.
var PROMPT_GARMENT_STAGE = /* @__PURE__ */ __name((n, g, o) => `You are editing a real photograph, not generating a new image from scratch.

${TRYON_IDENTITY}

IMAGE 2${o.views > 1 ? ` to IMAGE ${o.views + 1} show` : " shows"} the REAL physical BYMARCCC garment (${g.label || n.title}), blank, without its ${o.technique}${o.views > 1 ? " (several reference photos of the same garment)" : ""}. Dress the customer in exactly this garment, replacing ONLY ${tryOnRegion(g.category || n.category)}. Keep every other clothing item and accessory unchanged.${o.fitIndex ? `

IMAGE ${o.fitIndex} shows this same garment worn by a model. Use it ONLY to match how the garment fits and where its hem sits on the body (length, snugness, sleeve length, neckline height). Never copy that model's face, hair, body, skin, pose, background or anything else from IMAGE ${o.fitIndex}.` : ""}

GARMENT FIDELITY: the result must clearly be this exact garment. Match its garment type, its exact length on the body, neckline, sleeve shape and length, silhouette, proportions and fit, fabric and material appearance (including any rib texture), seams, edges, hems and every construction detail, and its exact colour${g.colour ? ` (${g.colour})` : ""}. Do not turn it into a different garment (e.g. a regular-length or oversized T-shirt, a differently cropped top, a tank top, a hoodie, or another neckline or sleeve).

PRODUCT
${tryOnMeta(n, g, o.design)}

${o.technique.toUpperCase()} PLACEHOLDER: the real garment carries ${o.technique === "embroidery" ? "an embroidered design" : "a printed graphic"} that is added in a later step. Exactly where it sits — ${o.placementText}, with a width:height ratio of ${o.aspect} — print a matte, mid-tone chroma-key ${o.keyName} (${o.keyHex}) rectangle instead. Size and position matter: make the rectangle exactly that size relative to the torso, even when it is very small. Treat it exactly like ink on the fabric: it bends with the fabric's folds, curvature, stretch and perspective, and is hidden behind anything in front of the garment (hair, arms, hands). The fabric's wrinkles, folds, shadows and highlights must stay clearly visible across the rectangle as darker and lighter shades of that same ${o.keyName}. Use no other colour in it: no text, pattern, logo, glow, outline or border, crisp edges, and no ${o.keyName} anywhere else in the image. Apart from this rectangle the garment is blank.

${TRYON_PHYSICS}

Output one photorealistic image: the same person in the same photo, now wearing this garment.`, "PROMPT_GARMENT_STAGE");
// Legacy single-image reference (garment photo WITH its print baked in) — one generative pass.
var PROMPT_REFERENCE = /* @__PURE__ */ __name((n, o) => `You are editing a real photograph, not generating a new image from scratch.

${TRYON_IDENTITY}

Replace ONLY ${tryOnRegion(n.category)} with the BYMARCCC product below. Keep every other clothing item and accessory unchanged.

PRODUCT
${tryOnMeta(n, null, o.design)}

IMAGE 2 shows the garment. It is the authoritative source for garment type, silhouette, cut, length, colour, material, neckline, sleeves, seams, trims and construction, and for its printed/embroidered graphic: reproduce the same artwork, typography, spelling, logo geometry, placement, relative scale and colours; never redesign, re-letter or replace it. If a person appears in IMAGE 2, ignore that person completely.

${TRYON_PHYSICS} The graphic follows the same folds, curvature and perspective as the fabric.

Output one photorealistic image: the same person in the same photo, now wearing this garment.`, "PROMPT_REFERENCE");
// Sniff the real format + pixel size from the bytes (never trust the data-URL mime).
function readImageInfo(b) {
  const u16 = (i) => b[i] << 8 | b[i + 1];
  if (b.length > 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 255) { i++; continue; }
      const m = b[i + 1];
      if (m >= 192 && m <= 207 && m !== 196 && m !== 200 && m !== 204) return { type: "image/jpeg", h: u16(i + 5), w: u16(i + 7) };
      if (m === 216 || m === 1 || m >= 208 && m <= 215) { i += 2; continue; }
      i += 2 + u16(i + 2);
    }
    return { type: "image/jpeg", w: 0, h: 0 };
  }
  if (b.length > 24 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return { type: "image/png", w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  const str = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (b.length > 30 && str(0, 4) === "RIFF" && str(8, 4) === "WEBP") {
    const c = str(12, 4);
    if (c === "VP8 ") return { type: "image/webp", w: (b[26] | b[27] << 8) & 16383, h: (b[28] | b[29] << 8) & 16383 };
    if (c === "VP8L") return { type: "image/webp", w: 1 + ((b[22] & 63) << 8 | b[21]), h: 1 + ((b[24] & 15) << 10 | b[23] << 2 | (b[22] & 192) >> 6) };
    if (c === "VP8X") return { type: "image/webp", w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
    return { type: "image/webp", w: 0, h: 0 };
  }
  if (b.length > 12 && str(4, 4) === "ftyp") return { type: "image/heic", unsupported: true };
  if (b.length > 6 && str(0, 3) === "GIF") return { type: "image/gif", unsupported: true };
  return null;
}
__name(readImageInfo, "readImageInfo");
function decodePhoto(u) {
  const m = /^data:([\w./+-]+);base64,(.+)$/.exec(typeof u === "string" ? u : "");
  if (!m) return { status: 400, code: "INVALID_IMAGE", message: "That file isn’t a readable image." };
  let bin;
  try { bin = atob(m[2]); } catch { return { status: 400, code: "INVALID_IMAGE", message: "That file isn’t a readable image." }; }
  if (bin.length > MAX_BYTES) return { status: 413, code: "IMAGE_TOO_LARGE", message: "Photo too large (max 6 MB)." };
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const info = readImageInfo(bytes);
  if (!info) return { status: 400, code: "INVALID_IMAGE", message: "That file isn’t a readable image." };
  if (info.unsupported) return { status: 415, code: "UNSUPPORTED_IMAGE", message: "Unsupported photo format. Use JPG, PNG or WEBP." };
  if (info.w && info.h && Math.min(info.w, info.h) < TRYON_MIN_SIDE) return { status: 400, code: "IMAGE_TOO_SMALL", message: `Photo resolution too low (min ${TRYON_MIN_SIDE}px).` };
  return { blob: new Blob([bytes], { type: info.type }), info };
}
__name(decodePhoto, "decodePhoto");
// `user_image_file_id` (the value returned by assistant-upload-photo and passed back into
// assistant-tryon / the generate_try_on tool) is OUR OWN transient token: a crypto.randomUUID()
// key into this in-memory PHOTO_STORE Map, valid for PHOTO_TTL_MS and deleted after first use.
// It is NOT an OpenAI file id and is never sent to OpenAI or stored by OpenAI — this Worker never
// calls OpenAI's Files API. The raw image bytes go to OpenAI's images/edits endpoint directly.
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
  if (!b) return tryErr(400, "BAD_REQUEST", "Bad JSON");
  const ph = decodePhoto(b.photo);
  if (ph.code) return tryErr(ph.status, ph.code, ph.message);
  purgePhotoStore();
  const id = crypto.randomUUID();
  PHOTO_STORE.set(id, { dataUrl: b.photo, t: Date.now() });
  logEvent("assistant-upload-photo", { ip: (request.headers.get("cf-connecting-ip") || "").split(".").slice(0, 2).join(".") + ".x.x" });
  return json(200, { user_image_file_id: id, expires_in: Math.round(PHOTO_TTL_MS / 1e3) });
}
__name(assistantUploadPhoto, "assistantUploadPhoto");
async function fetchTryOnAsset(url) {
  const base = (env("BYMARCCC_SITE_URL", "") || CURRENT_ORIGIN).replace(/\/$/, "");
  const abs = /^https?:/.test(url) ? url : `${base}/${String(url).replace(/^\//, "")}`;
  let r = null;
  try {
    if (ENV.ASSETS && typeof ENV.ASSETS.fetch === "function" && abs.startsWith(base)) r = await ENV.ASSETS.fetch(new Request(abs));
    if (!r || !r.ok) r = await fetch(abs);
  } catch { return null; }
  if (!r || !r.ok) return null;
  // re-type from the real bytes so OpenAI gets a correct mime (jpeg/png/webp only)
  const bytes = new Uint8Array(await r.arrayBuffer());
  const info = bytes.length ? readImageInfo(bytes) : null;
  if (!info || info.unsupported) return null;
  return new File([bytes], `ref.${info.type.split("/")[1]}`, { type: info.type });
}
__name(fetchTryOnAsset, "fetchTryOnAsset");
// Image model: env OPENAI_IMAGE_MODEL, else the newest GPT Image model the account accepts, falling back to gpt-image-1.
function tryOnModels() {
  const m = env("OPENAI_IMAGE_MODEL", "");
  return [...new Set([m, "gpt-image-1.5", "gpt-image-1"].filter(Boolean))];
}
__name(tryOnModels, "tryOnModels");
async function tryOnEdit(buildForm, deadline, models) {
  let lastErr = null;
  for (const model of models || tryOnModels()) {
    for (const fidelity of [true, false]) {
      const left = deadline - Date.now();
      if (left < 15e3) { const e = new Error("timeout"); e.name = "AbortError"; throw lastErr && lastErr.name === "AbortError" ? lastErr : e; }
      try {
        const out = await openai("images/edits", null, { form: buildForm(model, fidelity), timeoutMs: left });
        return { out, model, fidelity };
      } catch (e) {
        lastErr = e;
        const m = String(e && e.message || "");
        if (e && e.status === 400 && fidelity && /input_fidelity/i.test(m)) continue;          // model without input_fidelity: retry without it
        if (e && (e.status === 404 || e.status === 400 || e.status === 403) && (e.param === "model" || /model/i.test(m)) && !/moderation|safety|input_fidelity/i.test(m)) break;   // model not available on this account: next model
        throw e;
      }
    }
  }
  throw lastErr || new Error("no image model available");
}
__name(tryOnEdit, "tryOnEdit");
function tryOnSize(info) {
  const r = info && info.w && info.h ? info.h / info.w : 1.5;
  return r > 1.2 ? "1024x1536" : r < 0.83 ? "1536x1024" : "1024x1024";
}
__name(tryOnSize, "tryOnSize");
async function assistantTryon(request) {
  const g0 = guard(request);
  if (g0) return g0;
  if (!rateLimit(request, Number(env("ASSISTANT_TRYON_RATE_LIMIT_PER_MIN", "6")))) return tryErr(429, "RATE_LIMITED", "Too many try-on requests. Please wait a moment.");
  const b = await readJson(request);
  if (!b) return tryErr(400, "BAD_REQUEST", "Bad JSON");
  if (b.consent !== true) return tryErr(400, "CONSENT_REQUIRED", "Consent is required to process the photo.");
  // Try-On transforms ONE selected product/design (catalogue search/recommendation lives elsewhere).
  const raw = typeof b.productId === "string" && b.productId.trim() ? b.productId.trim() : Array.isArray(b.productIds) ? b.productIds.find((x) => typeof x === "string" && x.trim()) : null;
  if (!raw) return tryErr(400, "PRODUCT_REQUIRED", "Select a product to try on.");
  let photoDataUrl = null;
  if (typeof b.userImageFileId === "string" && b.userImageFileId) {
    purgePhotoStore();
    const entry = PHOTO_STORE.get(b.userImageFileId);
    if (entry) { photoDataUrl = entry.dataUrl; PHOTO_STORE.delete(b.userImageFileId); }
    else if (!(typeof b.photo === "string" && b.photo)) return tryErr(410, "PHOTO_EXPIRED", "That photo reference has expired. Please upload the photo again.");
  }
  if (!photoDataUrl && typeof b.photo === "string" && b.photo) photoDataUrl = b.photo;
  if (!photoDataUrl) return tryErr(400, "PHOTO_REQUIRED", "Add a photo first.");
  const ph = decodePhoto(photoDataUrl);
  if (ph.code) return tryErr(ph.status, ph.code, ph.message);
  const sep = String(raw).indexOf("::");
  const pid = sep === -1 ? String(raw) : String(raw).slice(0, sep);
  const wanted = sep === -1 ? null : slugify(String(raw).slice(sep + 2)) || null;
  const items = await loadCatalog();
  const p = items.find((it) => it.id === pid || it.handle === pid);
  if (!p) return tryErr(404, "PRODUCT_NOT_FOUND", "That product couldn’t be found.");
  const n = normalizeProduct(p);
  const all = p.tryOnResolved || [];
  const entry = wanted ? all.find((d) => d.slug === wanted) : all.find((d) => d.ok) || all[0];
  const diag = { product: p.id, design: entry && entry.design || null, mode: entry && entry.mode || null, garment: !!(entry && (entry.garmentViews.length || entry.reference)), print: !!(entry && entry.print) };
  if (!entry) { stylistLog("tryon", { ...diag, stage: "config", fail: "NO_TRY_ON_CONFIG" }); return tryErr(422, "NO_TRY_ON_IMAGE", wanted ? "Virtual try-on isn’t available for this design yet." : "Virtual try-on isn’t available for this product yet."); }
  if (!entry.ok) {
    const code = entry.mode === "print" && entry.garmentViews.length && !entry.print || entry.missing && entry.print && entry.missing.includes(entry.print) ? "PRINT_MISSING" : "GARMENT_MISSING";
    stylistLog("tryon", { ...diag, stage: "config", fail: code, missing: entry.missing });
    return tryErr(422, code, code === "PRINT_MISSING" ? "The print for this design isn’t available for try-on yet." : "The garment reference for this product isn’t available for try-on yet.");
  }
  const t0 = Date.now();
  const refs = [];
  for (const u of entry.mode === "print" ? entry.garmentViews.slice(0, 3) : [entry.reference]) {
    const blob = await fetchTryOnAsset(u);
    if (blob) refs.push(blob); else if (!refs.length) { stylistLog("tryon", { ...diag, stage: "assets", fail: "GARMENT_ASSET_UNAVAILABLE" }); return tryErr(502, "GARMENT_ASSET_UNAVAILABLE", "The product image for try-on couldn’t be loaded. Please try again."); }
  }
  const garmentRefCount = refs.length;
  const fitRef = entry.mode === "print" && entry.garment && entry.garment.fitReference ? await fetchTryOnAsset(entry.garment.fitReference) : null;
  if (fitRef) refs.push(fitRef);
  let printInfo = null;
  if (entry.mode === "print") {
    const pb = await fetchTryOnAsset(entry.print);
    if (!pb) { stylistLog("tryon", { ...diag, stage: "assets", fail: "PRINT_MISSING" }); return tryErr(502, "PRINT_MISSING", "The print for this design couldn’t be loaded. Please try again."); }
    const info = readImageInfo(new Uint8Array(await pb.arrayBuffer()));
    if (!info || !info.w || !info.h) return tryErr(502, "PRINT_MISSING", "The print file for this design is not a readable PNG.");
    printInfo = { w: info.w, h: info.h };
  }
  const ip = (request.headers.get("cf-connecting-ip") || "").split(".").slice(0, 2).join(".") + ".x.x";
  logEvent("assistant-tryon", { ip, product: p.id, design: entry.design, mode: entry.mode });
  try {
    const mod = await openai("moderations", { model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url: photoDataUrl } }] }, { timeoutMs: 15e3 });
    if (mod.results?.[0]?.flagged) { stylistLog("tryon", { ...diag, stage: "moderation", fail: "PHOTO_REJECTED" }); return tryErr(422, "PHOTO_REJECTED", "This photo can’t be used for a try-on preview. Please use a different photo."); }
  } catch {
    // moderation outage: fail open — the image model applies its own safety system below
  }
  const g = entry.garment || {};
  const keyGreen = !/green|verde/i.test(`${g.colour || ""} ${n.colors.join(" ")}`);
  const key = keyGreen ? { name: "green", hex: "#00B140" } : { name: "magenta", hex: "#C000C0" };   // mid-tone keys so folds/shadows AND highlights stay visible on the panel
  const box = entry.box && entry.box[2] > entry.box[0] && entry.box[3] > entry.box[1] ? entry.box : printInfo ? [0, 0, printInfo.w, printInfo.h] : null;
  const aspect = box ? `${Math.round(box[2] - box[0])}:${Math.round(box[3] - box[1])}` : null;
  const pl = entry.placement;
  const pct = (v) => `${Math.round(v * 100)}%`;
  const placementText = pl
    ? `${Math.abs(pl.x) < 0.03 ? "horizontally centred on the chest" : `${pct(Math.abs(pl.x))} of the torso width ${pl.x > 0 ? "right" : "left"} of the chest centre (as seen in the photo)`}, its width about ${pct(pl.width)} of the torso width measured below the sleeves, its top edge ${pct(pl.top)} of the way down from the neckline to the hem`
    : `${g.printPlacement}, about ${pct(g.printWidth)} of the width of the garment's front`;
  const prompt = entry.mode === "print"
    ? PROMPT_GARMENT_STAGE(n, g, { design: entry.design, views: garmentRefCount, fitIndex: fitRef ? garmentRefCount + 2 : 0, aspect, placementText, technique: entry.technique || "print", keyName: key.name, keyHex: key.hex })
    : PROMPT_REFERENCE(n, { design: entry.design });
  const size = tryOnSize(ph.info);
  const buildForm = (model, fidelity) => {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", b.testQuality === "medium" || b.testQuality === "low" ? b.testQuality : env("OPENAI_IMAGE_QUALITY", "high"));   // testQuality: internal validation runs only (cheaper); customers never send it   // quality over speed
    if (fidelity) form.append("input_fidelity", "high");          // keeps the customer's face/body/background
    form.append("image[]", ph.blob, `customer.${ph.info.type.split("/")[1]}`);
    refs.forEach((r, i) => form.append("image[]", r, `garment-${i + 1}.${r.type.split("/")[1]}`));
    return form;
  };
  let res;
  try {
    res = await tryOnEdit(buildForm, t0 + 17e4, b.testModel === "gpt-image-1-mini" ? ["gpt-image-1-mini"] : null);   // testModel: internal validation runs only (cheaper)
  } catch (e) {
    const m = String(e && e.message || "");
    const code = e && e.name === "AbortError" ? "TIMEOUT" : e && (e.code === "moderation_blocked" || /safety|moderation|content policy/i.test(m)) ? "SAFETY_REJECTED" : e && (e.code === "insufficient_quota" || e.code === "billing_hard_limit_reached" || /quota|billing/i.test(m)) ? "TRYON_UNAVAILABLE" : e && (e.status === 429 || e.status >= 500) ? "GENERATION_BUSY" : "GENERATION_FAILED";
    stylistLog("tryon", { ...diag, stage: "generate", fail: code, status: e && e.status, ms: Date.now() - t0, msg: m.slice(0, 160) });
    logEvent("assistant-tryon-failed", { product: p.id, code, status: e && e.status, ms: Date.now() - t0 });
    if (code === "TIMEOUT") return tryErr(504, code, "The preview took too long. Please try again.");
    if (code === "SAFETY_REJECTED") return tryErr(422, code, "The image service declined this photo. Please try a different photo.");
    if (code === "TRYON_UNAVAILABLE") return tryErr(503, code, "Try-on is temporarily unavailable.");
    if (code === "GENERATION_BUSY") return tryErr(503, code, "The image service is busy right now. Please try again in a moment.");
    return tryErr(502, code, "Could not generate the preview right now. Please try again.");
  }
  const b64 = res.out && res.out.data && res.out.data[0] && res.out.data[0].b64_json;
  if (!b64 || b64.length < 1e3) { stylistLog("tryon", { ...diag, stage: "generate", fail: "MALFORMED_RESPONSE", model: res.model }); return tryErr(502, "GENERATION_FAILED", "Could not generate the preview right now. Please try again."); }
  stylistLog("tryon", { ...diag, stage: entry.mode === "print" ? "garment-generated" : "done", model: res.model, input_fidelity: res.fidelity, size, ms: Date.now() - t0 });
  const card = { id: n.id, title: n.title, url: n.url, price: n.price, currency: n.currency, image: n.featured_image, category: n.category, design: entry.design || null, variants: p.variants.filter((v) => v.available !== false).map((v) => ({ id: v.id, title: v.title })) };
  const base = { image: `data:image/png;base64,${b64}`, product: card, products: [card], pipeline: { model: res.model, ms: Date.now() - t0 } };
  if (entry.mode !== "print") return json(200, { ...base, stage: "final" });
  // stages 2-4 run in the browser on this image: find the key panel, warp the ORIGINAL print onto it, shade + occlude
  const origin = (env("BYMARCCC_SITE_URL", "") || CURRENT_ORIGIN).replace(/\/$/, "");
  return json(200, { ...base, stage: "garment", key: key.hex, placement: pl || null, technique: entry.technique || "print", print: { box, src: entry.print.startsWith(origin) ? entry.print.slice(origin.length) : entry.print, width: printInfo.w, height: printInfo.h }, fabric: g.fabric || null });
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
var OCUR = "RON";   // set per order (geo pricing); e-mails show the currency the customer paid in
var ofmt = (n, cur = OCUR) => (Math.round(n * 100) / 100).toFixed(2) + " " + cur;
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
// POST /api/goatify-mail — GOATIFY (goatify.goatagency.us) sends its customer e-mails (shipped, order updates, order link)
// through this site's Resend account. Signed like site orders: HMAC-SHA256(GOATIFY_SITE_SECRET, `${ts}.${rawBody}`),
// ±5 min; each signature is accepted once. Body: { to, subject, text, html? }.
var relaySeen = /* @__PURE__ */ new Map();
async function goatifyMail(request) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const secret = env("GOATIFY_SITE_SECRET");
  if (!secret || !env("RESEND_API_KEY") || !env("ORDER_EMAIL_FROM")) return json(503, { error: "NOT_CONFIGURED" });
  const raw = await request.text();
  if (raw.length > 300000) return json(413, { error: "Too large" });
  const ts = request.headers.get("x-goatify-timestamp") || "", sig = String(request.headers.get("x-goatify-signature") || "").toLowerCase();
  if (!/^\d{9,12}$/.test(ts) || Math.abs(Date.now() / 1e3 - Number(ts)) > 300) return json(401, { error: "STALE" });
  const want = await gHmacHex(secret, `${ts}.${raw}`);
  let diff = want.length ^ sig.length; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (sig.charCodeAt(i) || 0);
  if (diff) return json(401, { error: "BAD_SIGNATURE" });
  const now = Date.now(); for (const [k, t] of relaySeen) if (now - t > 6e5) relaySeen.delete(k);
  if (relaySeen.has(sig)) return json(200, { ok: true, duplicate: true });
  relaySeen.set(sig, now);
  let b; try { b = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }); }
  const to = String(b.to || "").trim();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to) || to.length > 200) return json(400, { error: "Bad recipient" });
  const subject = String(b.subject || "").replace(/[\r\n]+/g, " ").slice(0, 200);
  const r = await resendSend({ from: env("ORDER_EMAIL_FROM"), to: [to], subject, text: String(b.text || "").slice(0, 100000), ...(b.html ? { html: String(b.html).slice(0, 250000) } : {}) });
  return json(200, { ok: true, id: r && r.id || null });
}
__name(goatifyMail, "goatifyMail");
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
// the catalogue on the server (never from the browser).
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
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" type="image/png" sizes="96x96" href="/assets/icons/favicon-96.png"><link rel="icon" type="image/png" sizes="192x192" href="/assets/icons/favicon-192.png"><link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png"><meta name="color-scheme" content="light only"><title>BYMARCCC</title></head>
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
  if (!o.order_id || !o.items.length) return json(400, { error: "Invalid order" });
  let pay = "cod", totalOverride = null, acctInfo = { pct: 0, creditRon: 0, voucher: null, email: c.email };
  o.items = await acctTrustedRon(o.items.map((it, i) => ({ ...it, id: (b.items[i] && b.items[i].id) || "" }))).catch(() => o.items);
  o.items = o.items.map(({ id, ...it }) => it);
  if (o.session_id) {
    if (!/^cs_[a-zA-Z0-9_]+$/.test(o.session_id) || !env("STRIPE_SECRET_KEY")) return json(400, { error: "Invalid session" });
    const data = await stripeRequest(`checkout/sessions/${encodeURIComponent(o.session_id)}`);
    if (data.payment_status !== "paid" || (data.metadata?.order_id && data.metadata.order_id !== o.order_id)) return json(400, { error: "Not paid" });
    pay = "card"; totalOverride = (data.amount_total || 0) / 100;
    const md = data.metadata || {};
    acctInfo = { pct: Number(md.acct_pct) || 0, creditRon: Number(md.acct_credit_ron) || 0, voucher: md.acct_voucher ? Number(md.acct_voucher) : null, email: md.acct_email || c.email, creditLocal: (Number(md.acct_credit_minor) || 0) / 100, shipRon: md.geo_ship != null && md.geo_ship !== "" ? Number(md.geo_ship) : null };
    o.ronItems = o.items.map((it) => ({ ...it, price: acctApplyPct(it.price, acctInfo.pct, "RON") }));
    if (data.metadata && data.metadata.geo_cur && data.metadata.geo_cur !== "RON") {   // foreign card order: same conversion as at checkout
      const rule = { cur: data.metadata.geo_cur, fx: Number(data.metadata.geo_fx) || 1 };
      o.items = o.items.map((it) => ({ ...it, price: acctApplyPct(geoPrice(it.price, rule), acctInfo.pct, rule.cur) }));
      o.currency = rule.cur; o.geoShip = Number(data.metadata.geo_ship) || 0;
    }
    if (!o.currency) o.items = o.items.map((it) => ({ ...it, price: acctApplyPct(it.price, acctInfo.pct, "RON") }));
    if (!c.email) c.email = data.customer_details?.email || data.customer_email || "";
  } else {
    const okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email);
    if ((geoCountryCode(c.country) || "RO") !== "RO") return json(400, { error: "COD_ROMANIA_ONLY" });   // cash on delivery: Romania only
    if (!c.full_name || !c.phone || !c.address || !c.city || !okEmail) return json(400, { error: "Missing customer details" });
    // COD: the order number is assigned here, from the browser's temporary id (a retry gets the same number)
    try { o.order_id = await assignOrderNumber(o.order_id, "cod"); }
    catch (e) { console.error("order number failed", String(e && e.message || e)); return json(503, { error: "ORDER_NUMBER_FAILED" }); }
    const actx = await acctCheckoutContext(request).catch(() => null);
    if (actx) {
      acctInfo = { pct: actx.pct, creditRon: 0, voucher: actx.voucher, email: actx.email, freeShip: actx.freeShip, creditAvail: actx.creditRon };
      o.items = o.items.map((it) => ({ ...it, price: acctApplyPct(it.price, actx.pct, "RON") }));
    }
  }
  const addTo = await verifyAddTo(b.addto).catch(() => null);
  if (addTo && addTo.id !== o.order_id) o.addToParent = addTo.id;
  // "You might also like" (e-mail + thank-you page): add-on links point at the parent order when this is itself an add-on
  o.recs = await orderRecommendations(b.items, o.addToParent || o.order_id, 3, o.addToParent ? addTo.t : Math.floor(Date.now() / 1e3)).catch(() => []);
  // once per order: KV when bound (survives restarts), memory otherwise
  const store = kv(), key = `ordermail:${o.order_id}`;
  if (sentOrders.has(key) || (store && await store.get(key))) return json(200, { ok: true, duplicate: true, order_id: o.order_id, recs: o.recs });
  const sub = o.items.reduce((a, it) => a + it.price * it.qty, 0);
  const ship = o.addToParent || acctInfo.freeShip ? 0 : (o.currency ? o.geoShip : acctInfo.shipRon != null ? acctInfo.shipRon : Number(env("SHIPPING_RON", "20")) || 0);
  OCUR = o.currency || "RON";
  if (pay === "cod" && acctInfo.creditAvail > 0) acctInfo.creditRon = Math.min(acctInfo.creditAvail, sub);
  const creditShown = pay === "card" ? (acctInfo.creditLocal || 0) : acctInfo.creditRon;
  const totals = { sub, ship, total: totalOverride != null && pay === "card" && !b.installments ? totalOverride : Math.max(0, sub + ship - creditShown) };
  const chk = await goatifyItemCheck(b.items).catch(() => ({ extras: [], notes: "" }));
  const m = orderEmails(o, pay, totals, chk.extras.map((e) => e && e.image), CURRENT_ORIGIN || "https://bymarccc.com");
  const from = env("ORDER_EMAIL_FROM");
  try {
    await resendSend({ from, to: env("ORDER_NOTIFY_TO").split(",").map((x) => x.trim()).filter(Boolean), reply_to: c.email || void 0, subject: m.owner.subject, html: m.owner.html, text: m.owner.text });
  } catch (e) {
    return json(502, { error: "ORDER_EMAIL_FAILED", detail: env("ASSISTANT_DEBUG") ? String(e.message) : void 0 });
  }
  sentOrders.add(key);
  if (store) await store.put(key, "1", { expirationTtl: 60 * 60 * 24 * 60 }).catch(() => {});
  try {
    const ronItems = o.currency ? (o.ronItems || []) : o.items;
    const ronSub = (ronItems.length ? ronItems : o.items).reduce((a, it) => a + it.price * it.qty, 0);
    await acctRecordOrder(o, { email: acctInfo.email || c.email, pay, currency: o.currency || "RON", totalLocal: totals.total, shipLocal: ship, totalRon: Math.max(0, ronSub - (acctInfo.creditRon || 0)), pct: acctInfo.pct, creditRon: acctInfo.creditRon || 0, voucher: acctInfo.voucher, items: o.items.map((it, i) => ({ name: it.name, variant: it.variant, qty: it.qty, price: it.price, image: (chk.extras[i] && chk.extras[i].image) || (b.items[i] && b.items[i].image) || "" })) });
  } catch (e) { console.error("account order record failed", String(e && e.message || e)); }
  // GOATIFY: forward the accepted order (no-op unless GOATIFY_FORWARDING=on). Never changes the answer to the customer.
  try {
    const fo = { ...o, items: o.items.map((it, i) => ({ ...it, ...(chk.extras[i] || {}) })) };
    const notes = [o.addToParent ? `ADD-ON to ${o.addToParent} — ship together in the same parcel.` : "", chk.notes, b.installments && pay === "card" ? "Pay in 2: first instalment paid by card, second charged automatically later." : ""].filter(Boolean).join("\n");
    const g = await forwardToGoatify(fo, { pay, totals: { sub: totals.sub, ship: totals.ship }, placedAt: new Date().toISOString(), notes, sourceUrl: CURRENT_ORIGIN ? CURRENT_ORIGIN + "/checkout.html" : void 0 }, (k) => env(k));
    if (!g.forwarded && g.reason !== "off") console.error("GOATIFY forward failed", JSON.stringify(g));
  } catch (e) { console.error("GOATIFY forward error", String(e && e.message || e)); }
  let customerMail = "skipped";
  if (c.email) { try { await resendSend({ from, to: [c.email], reply_to: env("ORDER_NOTIFY_TO").split(",")[0].trim() || void 0, subject: m.customer.subject, html: m.customer.html, text: m.customer.text }); customerMail = "sent"; } catch { customerMail = "failed"; } }
  return json(200, { ok: true, order_id: o.order_id, customerMail, recs: o.recs });
}
__name(orderSubmit, "orderSubmit");

// lib/goatify.js — forwards each accepted order to GOATIFY (orders, fulfilment, invoicing). Generated from
// goatify-backend/integrations/bymarccc/cloudflare/goatify-forward.js (tested there: test/bymarccc-cloudflare.test.js).
// Sends NOTHING unless GOATIFY_SITE_SECRET is set (GOATIFY_FORWARDING=off turns it off). Env (Cloudflare Pages → Settings → Variables and Secrets):
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
  const country = geoCountryCode(c.country); if (!country) throw Object.assign(new Error('Unsupported country: ' + c.country), { code: 'COUNTRY_UNSUPPORTED' });
  if (!o.order_id) throw Object.assign(new Error('Missing order_id'), { code: 'NO_ORDER_ID' });
  const items = (o.items || []).map(it => ({ ...(it.sku ? { sku: String(it.sku).slice(0, 64) } : {}), name: it.name, ...(it.variant ? { variant: it.variant } : {}), qty: Number(it.qty) || 1, price: gCents(it.price) / 100, ...(gHttps(it.image) ? { image: gHttps(it.image) } : {}), ...(gHttps(it.url) ? { url: gHttps(it.url) } : {}) }));
  const sub = items.reduce((a, it) => a + gCents(it.price) * it.qty, 0);
  if (totals && gCents(totals.sub) !== sub) throw Object.assign(new Error('Subtotal does not match the items'), { code: 'TOTALS_MISMATCH' });
  const ship = gCents(totals ? totals.ship : 0);
  return {
    site: siteKey, idempotencyKey: 'bym_' + String(o.order_id).replace(/[^A-Za-z0-9._:-]/g, ''),
    customer: { name: c.full_name, email: String(c.email || '').toLowerCase(), phone: c.phone, lang: o.lang === 'ro' ? 'ro' : 'en' },
    shippingAddress: { line1: c.address, ...(c.apartment ? { line2: c.apartment } : {}), city: c.city, postcode: c.postal_code, country },
    items, subtotal: sub / 100, shipping: ship / 100, discount: 0, total: (sub + ship) / 100, currency: o.currency || 'RON',
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
  // Only GOATIFY_SITE_SECRET is required: forwarding is on as soon as the secret exists (GOATIFY_FORWARDING=off disables it),
  // and the API defaults to the live GOATIFY (Cloudflare) at goatify.goatagency.us.
  const secret = env('GOATIFY_SITE_SECRET'), fwd = String(env('GOATIFY_FORWARDING') || (secret ? 'on' : '')).toLowerCase();
  if (fwd !== 'on') return { forwarded: false, reason: 'off' };
  const api = String(env('GOATIFY_API_URL') || 'https://goatify.goatagency.us/api/v1').replace(/\/+$/, ''), siteKey = env('GOATIFY_SITE_KEY') || 'bymarccc';
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

// Server-side check of the bag lines against the catalogue (assets/catalog.js) (the browser sends its own prices). Prices are not changed;
// a line that is not in the catalogue or has another price is flagged in the GOATIFY order note, so it is seen before
// the parcel leaves / cash is collected. Adds the catalogue id (sku) and main photo to each line.
async function goatifyItemCheck(rawItems) {
  const cat = await loadCatalog().catch(() => []);
  const D = await loadCatalogData().catch(() => null);
  const base = (env("BYMARCCC_SITE_URL", "") || CURRENT_ORIGIN || "https://bymarccc.com").replace(/\/$/, "");
  // The bag sends the catalogue's own id ("shopify:white-baby-top:black:S-M:PARIS"); the server items are keyed by the
  // catalogue key ("w-white-baby-top") — accept both, then fall back to the product title.
  const byId = new Map(cat.map((p) => [String(p.id), p]));
  if (D && D.products) for (const [key, raw] of Object.entries(D.products)) if (raw && raw.id && byId.has(key)) byId.set(String(raw.id), byId.get(key));
  const byTitle = new Map(cat.map((p) => [String(p.title || "").trim().toLowerCase(), p]));
  const slug = (v) => String(v || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const find = (it, name) => { const parts = String(it.id || "").split(":"); return byId.get(parts[0]) || byId.get(parts.slice(0, 2).join(":")) || byTitle.get(name.toLowerCase()); };
  // Photo of the chosen print/design (designImages: design → gallery index), else the main photo.
  const photo = (p, it) => {
    const imgs = p.images || [], di = p.designImages || {};
    const cands = [...String(it.id || "").split(":").slice(1), ...String(it.variant || "").split("·")].reverse();
    for (const c of cands) { const k = slug(c); if (k && Object.prototype.hasOwnProperty.call(di, k) && imgs[di[k]]) return imgs[di[k]]; }
    return imgs[0];
  };
  const abs = (u) => typeof u === "string" && u ? (/^https:\/\//i.test(u) ? u : /^\/?assets\//.test(u) ? `${base}/${u.replace(/^\//, "")}` : "") : "";
  const extras = [], warn = [];
  for (const it of (Array.isArray(rawItems) ? rawItems : []).slice(0, 50)) {
    const name = String(it?.name ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 160);
    if (!name) continue;   // same filter as cleanOrder(), so indexes line up
    const p = find(it, name);
    const price = Math.max(0, Math.round(Number(it.price || 0) * 100) / 100);
    const ok = p && (p.price === price || (p.variants || []).some((v) => v.price === price));
    if (!ok) warn.push(name + (p ? ` (catalogue ${p.price} RON, bag ${price} RON)` : " (not in catalogue)"));
    const image = (p && photo(p, it)) || abs(it.image);
    extras.push({ ...(p ? { sku: String(p.id).slice(0, 64) } : {}), ...(image ? { image } : {}), ...(p && p.url ? { url: p.url } : {}) });
  }
  return { extras, notes: warn.length ? "⚠ Price not verified against the catalogue: " + warn.join("; ") : "" };
}
__name(goatifyItemCheck, "goatifyItemCheck");

// "Add to order": signed link from the confirmation e-mail → product page → checkout, same parcel, no extra shipping.
// The signature ties the link to ONE order id AND the time the order was placed (t, unix seconds) — HMAC with a server
// secret, so neither can be changed — and the link is valid for ADDON_DAYS after t. Links: ?addto=<id>&t=<t>&sig=<sig>.
var ADDON_DAYS = 7;
async function addToSig(orderId, t) {
  const secret = env("ORDER_LINK_SECRET") || env("RESEND_API_KEY");
  if (!secret) return "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t === void 0 ? "addto:" + orderId : `addto:${orderId}:${t}`));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
__name(addToSig, "addToSig");
// → { id, t } or null
async function verifyAddTo(a) {
  if (!a || typeof a !== "object") return null;
  const id = String(a.order_id || ""), sig = String(a.sig || "");
  if (!/^[0-9a-f]{24}$/.test(sig)) return null;
  if (ORDER_NO_RE.test(id)) {
    const t = Number(a.t), age = Date.now() / 1e3 - t;
    if (!Number.isInteger(t) || t <= 0 || age < -300 || age > ADDON_DAYS * 86400) return null;
    return sig === await addToSig(id, t) ? { id, t } : null;
  }
  // links in e-mails sent before the new order numbers (BYM-YYYYMMDD-XXXX, date inside the id)
  const m = /^BYM-(\d{4})(\d{2})(\d{2})-[A-Z0-9]{2,10}$/.exec(id);
  if (!m) return null;
  const placed = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (!(Date.now() - placed <= (ADDON_DAYS + 1) * 864e5)) return null;
  return sig === await addToSig(id) ? { id, t: Math.floor(placed / 1e3) } : null;
}
__name(verifyAddTo, "verifyAddTo");
// Up to 3 suggestions from the catalogue, based on what was bought: a women's top → the Delulu blazer first; then
// accessories (caps, bags) for the same gender; then another jeans/top. Never something already in the order.
// Photos for catalogue items that have no gallery yet (the product page has them in its own gallery).
var REC_IMAGES = { "w-hg-delulu-blazer": "assets/img/gallery/delulu-blazer-1-73460abe.webp" };
async function orderRecommendations(rawItems, parentOrderId, max = 3, parentT = Math.floor(Date.now() / 1e3)) {
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
  const legacy = !ORDER_NO_RE.test(parentOrderId);   // no ORDERS_DB yet → old-style id, old-style link
  const sig = await addToSig(parentOrderId, legacy ? void 0 : parentT);
  const q = `addto=${encodeURIComponent(parentOrderId)}${legacy ? "" : `&t=${parentT}`}&sig=${sig}`;
  return picks.map((p) => ({ id: p.id, title: p.title, price: p.price, image: p.images[0], url: sig ? `${p.url}${p.url.includes("?") ? "&" : "?"}${q}` : p.url }));
}
__name(orderRecommendations, "orderRecommendations");

// ---------------------------------------------------------------------------------------------
// GEO PRICING — one place for country → currency / markup / shipping. Used for (1) the prices the
// visitor sees (injected into every HTML page as window.BYM_GEO) and (2) what Stripe charges.
// Base prices in the catalogue are RON. Romania stays exactly as before (RON, no markup, SHIPPING_RON).
//   US + rest of world: USD, +40%, $30 shipping · UK: GBP, +40%, £25 shipping
//   Europe: local currency (EUR / CHF / PLN / CZK / HUF / SEK / DKK / NOK), +30%, €15 shipping (converted)
//   Bulgaria (euro since 2026): EUR, +20%, €15 shipping
// Exchange rates: ECB via frankfurter.dev, cached 6h; fallback below if the fetch fails.
// ---------------------------------------------------------------------------------------------
var GEO_FALLBACK_RATES = { RON: 1, EUR: 0.18944, USD: 0.21511, GBP: 0.1619, CHF: 0.17955, PLN: 0.82765, CZK: 4.6298, HUF: 69.372, SEK: 2.1465, DKK: 1.4161, NOK: 2.0651, CAD: 0.2989, AUD: 0.3268 };   // ECB 30 Sep 2026
var GEO_COUNTRIES = {
  RO: ["Romania", "RON"], BG: ["Bulgaria", "EUR"],
  AT: ["Austria", "EUR"], BE: ["Belgium", "EUR"], HR: ["Croatia", "EUR"], CY: ["Cyprus", "EUR"], EE: ["Estonia", "EUR"], FI: ["Finland", "EUR"],
  FR: ["France", "EUR"], DE: ["Germany", "EUR"], GR: ["Greece", "EUR"], IE: ["Ireland", "EUR"], IT: ["Italy", "EUR"], LV: ["Latvia", "EUR"],
  LT: ["Lithuania", "EUR"], LU: ["Luxembourg", "EUR"], MT: ["Malta", "EUR"], NL: ["Netherlands", "EUR"], PT: ["Portugal", "EUR"], SK: ["Slovakia", "EUR"],
  SI: ["Slovenia", "EUR"], ES: ["Spain", "EUR"], MC: ["Monaco", "EUR"], AD: ["Andorra", "EUR"], SM: ["San Marino", "EUR"], ME: ["Montenegro", "EUR"],
  XK: ["Kosovo", "EUR"], AL: ["Albania", "EUR"], BA: ["Bosnia and Herzegovina", "EUR"], MK: ["North Macedonia", "EUR"], RS: ["Serbia", "EUR"],
  MD: ["Moldova", "EUR"], IS: ["Iceland", "EUR"],
  CH: ["Switzerland", "CHF"], LI: ["Liechtenstein", "CHF"], PL: ["Poland", "PLN"], CZ: ["Czechia", "CZK"], HU: ["Hungary", "HUF"],
  SE: ["Sweden", "SEK"], DK: ["Denmark", "DKK"], NO: ["Norway", "NOK"],
  GB: ["United Kingdom", "GBP"], US: ["United States", "USD"], CA: ["Canada", "CAD"], AU: ["Australia", "AUD"]
};
var GEO_RATES_MEM = null;
async function geoRates() {
  const now = Date.now();
  if (GEO_RATES_MEM && now - GEO_RATES_MEM.t < 6 * 3600e3) return GEO_RATES_MEM.r;
  let r = null;
  const ck = "https://bymarccc.com/__fx/RON";
  try {
    const cache = typeof caches !== "undefined" && caches.default;
    let hit = cache ? await cache.match(ck) : null;
    if (!hit) {
      const res = await fetch("https://api.frankfurter.dev/v1/latest?base=RON&symbols=EUR,USD,GBP,CHF,PLN,CZK,HUF,SEK,DKK,NOK,CAD,AUD", { cf: { cacheTtl: 21600 } });
      if (res.ok) {
        const d = await res.json();
        if (d && d.rates && d.rates.EUR) {
          hit = new Response(JSON.stringify(d.rates), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=21600" } });
          if (cache) await cache.put(ck, hit.clone()).catch(() => {});
        }
      }
    }
    if (hit) r = await hit.json();
  } catch {}
  r = Object.assign({}, GEO_FALLBACK_RATES, r || {}, { RON: 1 });
  GEO_RATES_MEM = { t: now, r };
  return r;
}
__name(geoRates, "geoRates");
function geoRule(cc, rates) {
  cc = String(cc || "").toUpperCase();
  const r = rates || GEO_FALLBACK_RATES;
  const row = GEO_COUNTRIES[cc];
  if (cc === "RO" || (!row && cc === "")) return { cc: "RO", cur: "RON", fx: 1, ship: Number(env("SHIPPING_RON", "20")) || 0 };
  let cur, mk, ship;
  if (cc === "US" || !row) { cur = "USD"; mk = 1.4; ship = 30; }
  else if (cc === "GB") { cur = "GBP"; mk = 1.4; ship = 25; }
  else if (cc === "CA" || cc === "AU") { cur = row[1]; mk = 1.4; ship = Math.ceil(30 * (r[cur] || 1) / (r.USD || 1)); }
  else if (cc === "BG") { cur = "EUR"; mk = 1.2; ship = 15; }
  else { cur = row[1]; mk = 1.3; ship = cur === "EUR" ? 15 : Math.ceil(15 * r[cur] / r.EUR); }
  return { cc: row ? cc : "US", cur, fx: (r[cur] || 1) * mk, ship };
}
__name(geoRule, "geoRule");
// RON price → local whole-unit price (rounded up; HUF/CZK/SEK… to whole units as well)
function geoPrice(ron, rule) { if (rule.cur === "RON") return Math.round(Number(ron || 0) * 100) / 100; return Math.ceil(Number(ron || 0) * rule.fx - 1e-9); }
__name(geoPrice, "geoPrice");
function geoCountryCode(v) {
  const s = String(v || "").trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const low = s.toLowerCase();
  for (const k in GEO_COUNTRIES) if (GEO_COUNTRIES[k][0].toLowerCase() === low) return k;
  return gCountryCode(s);
}
__name(geoCountryCode, "geoCountryCode");
// what the browser gets: visitor's country + every supported country's rule, and a tiny formatter
async function geoClientScript(request, ccOverride) {
  const rates = await geoRates();
  const visitor = String(ccOverride || (request.cf && request.cf.country) || request.headers.get("cf-ipcountry") || "RO").toUpperCase();
  const rules = {};
  for (const k in GEO_COUNTRIES) { const g = geoRule(k, rates); rules[k] = [GEO_COUNTRIES[k][0], g.cur, +g.fx.toFixed(6), g.ship]; }
  const w = geoRule("ZZ", rates); rules._ = ["", w.cur, +w.fx.toFixed(6), w.ship];
  const data = { cc: visitor, rules };
  return `window.BYM_GEO=${JSON.stringify(data)};(function(G){var L={RON:'ro-RO',EUR:'de-DE',USD:'en-US',GBP:'en-GB',CHF:'de-CH',PLN:'pl-PL',CZK:'cs-CZ',HUF:'hu-HU',SEK:'sv-SE',DKK:'da-DK',NOK:'nb-NO',CAD:'en-US',AUD:'en-US'};` +
    `G.rule=function(cc){cc=String(cc||G.cc).toUpperCase();var r=G.rules[cc]||G.rules._;return {cc:G.rules[cc]?cc:'_',name:r[0],cur:r[1],fx:r[2],ship:r[3]};};` +
    `G.local=function(ron,cc){var r=G.rule(cc);return r.cur==='RON'?Math.round(Number(ron||0)*100)/100:Math.ceil(Number(ron||0)*r.fx-1e-9);};` +
    `G.money=function(n,cur){if(cur==='RON')return (Number.isInteger(n)?String(n):Number(n).toFixed(2).replace('.',','))+' RON';try{return new Intl.NumberFormat(L[cur]||'en-GB',{style:'currency',currency:cur,maximumFractionDigits:0,minimumFractionDigits:0}).format(n);}catch(e){return n+' '+cur;}};` +
    `G.fmt=function(ron,cc){var r=G.rule(cc);return G.money(G.local(ron,cc),r.cur);};` +
    `window.BYM_FMT=function(ron){return G.fmt(ron);};})(window.BYM_GEO);`;
}
__name(geoClientScript, "geoClientScript");
async function geoInjectHtml(request, res, L) {
  const ct = res.headers.get("content-type") || "";
  if (res.status !== 200 || !/text\/html/i.test(ct) || typeof HTMLRewriter === "undefined") return res;
  L = L || { lang: "en", prefixed: false, path: new URL(request.url).pathname };
  const url = new URL(request.url);
  let js;
  try { js = await geoClientScript(request, L.cc || null); } catch { return res; }
  let seo = "";
  try { seo = await seoHeadFor(url, L.lang, L.path, L.prefixed, L.cc); } catch {}
  const titleM = /<script>window\.BYM_SEO_TITLE=(".*?");<\/script>/.exec(seo);
  let seoTitle = titleM ? JSON.parse(titleM[1]) : "";
  const page = L.path.replace(/\.html$/, "");
  const isHome = page === "/" || page === "/index";
  const D = L.lang !== "en" ? await i18nData(L.lang) : null;
  const v = I18N_VERSION;
  let head = `<script>${js}</script><script>window.BYM_LANG=${JSON.stringify(D ? L.lang : "en")};${page === "/checkout" ? "window.BYM_I18N_CATALOG_ONLY=true;" : ""}</script>`;
  if (D) head += `<script src="/assets/i18n-${L.lang}.js?v=${v}"></script>`;
  head += `<script src="/assets/i18n.js?v=${v}"></script>`;
  let rw = new HTMLRewriter()
    .on("html", { element(el) { if (D) el.setAttribute("lang", L.lang); } })
    .on("head", { element(el) { el.prepend(head, { html: true }); if (seo) el.append(seo, { html: true }); } });
  if (isHome) {
    const canon = i18nUrl(L.prefixed ? L.lang : "en", "/");
    if (D && L.prefixed) {
      seoTitle = (D.seo && D.seo.homeTitle) || seoTitle;
      const desc = (D.seo && (D.seo.homeDesc || D.seo.ogDesc)) || "";
      rw = rw.on('meta[name="description"]', { element(el) { if (desc) el.setAttribute("content", desc); } })
        .on('meta[property="og:title"]', { element(el) { if (seoTitle) el.setAttribute("content", seoTitle); } })
        .on('meta[property="og:description"]', { element(el) { if (desc) el.setAttribute("content", (D.seo && D.seo.ogDesc) || desc); } })
        .on('meta[property="og:url"]', { element(el) { el.setAttribute("content", canon); } });
    }
    rw = rw.on('link[rel="canonical"]', { element(el) { el.setAttribute("href", canon); } });
  }
  if (seoTitle) rw = rw.on("title", { element(el) { el.setInnerContent(seoTitle); } });
  const out = rw.transform(res);
  const h = new Headers(out.headers);
  h.delete("etag"); h.set("Cache-Control", "private, no-cache");
  if (L.prefixed) h.append("Set-Cookie", `bym_lang=${L.lang}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  h.set("Content-Language", L.lang);
  h.append("Vary", "Cookie");
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers: h });
}
__name(geoInjectHtml, "geoInjectHtml");
async function geoApi(request) {
  const js = await geoClientScript(request);
  return new Response(js, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "private, no-cache" } });
}
__name(geoApi, "geoApi");

// ---------------------------------------------------------------------------------------------
// SEO — robots.txt, sitemap.xml (home + every product, with images) and per-product <title>,
// meta description, canonical, Open Graph and schema.org Product JSON-LD injected server-side,
// so Google sees real content for bymarccc-product.html?p=… without running the page's JS.
// ---------------------------------------------------------------------------------------------
var SEO_BASE = "https://bymarccc.com";
var SEO_NOINDEX = ["/checkout", "/members", "/order", "/pay-in-2-terms"];
var seoEsc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function seoProductKeys(D) {
  return Object.keys((D && D.products) || {}).filter((k) => { const p = D.products[k]; return p && p.title && Array.isArray(p.gallery) && p.gallery.length && !p.hidden; });
}
__name(seoProductKeys, "seoProductKeys");
async function seoRobots() {
  const body = ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /checkout", "Disallow: /members", "Disallow: /order", "Disallow: /*/api/", "Disallow: /*/checkout", "Disallow: /*/members", "Disallow: /*/order", "", `Sitemap: ${SEO_BASE}/sitemap.xml`, ""].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
__name(seoRobots, "seoRobots");
// /sitemap.xml = index of one sitemap per language (small, fast); /sitemap-<lang>.xml = that language's pages
async function seoSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const items = ["en", ...I18N_LANGS].map((l) => `<sitemap><loc>${SEO_BASE}/sitemap-${l}.xml</loc><lastmod>${today}</lastmod></sitemap>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
async function seoSitemapLang(l, request) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const ckey = new Request(`${SEO_BASE}/__sitemap-cache/${l}-${I18N_VERSION}`);
  if (cache) { try { const hit = await cache.match(ckey); if (hit) return hit; } catch {} }
  const D = await loadCatalogData();
  const today = new Date().toISOString().slice(0, 10);
  const langs = ["en", ...I18N_LANGS];
  const alt = (pq) => langs.map((x) => `<xhtml:link rel="alternate" hreflang="${x}" href="${seoEsc(i18nUrl(x, pq))}"/>`).join("") + `<xhtml:link rel="alternate" hreflang="x-default" href="${seoEsc(i18nUrl("en", pq))}"/>`;
  const urls = [`<url><loc>${seoEsc(i18nUrl(l, "/"))}</loc>${alt("/")}<lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`];
  for (const cp of await contentSitemapEntries()) urls.push(`<url><loc>${seoEsc(i18nUrl(l, cp))}</loc>${alt(cp)}<lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
  for (const k of seoProductKeys(D)) {
    const p = D.products[k];
    const pq = `/bymarccc-product?p=${encodeURIComponent(k)}`;
    const imgs = l === "en" ? p.gallery.slice(0, 5).map((g) => `<image:image><image:loc>${seoEsc(SEO_BASE + "/" + String(g.src).replace(/^\//, ""))}</image:loc></image:image>`).join("") : "";
    urls.push(`<url><loc>${seoEsc(i18nUrl(l, pq))}</loc>${alt(pq)}<lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>${imgs}</url>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
  const res = new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  if (cache) { try { await cache.put(ckey, res.clone()); } catch {} }
  return res;
}
__name(seoSitemapLang, "seoSitemapLang");
__name(seoSitemap, "seoSitemap");
function seoTitleCase(t) { return String(t || "").toLowerCase().replace(/(^|\s|-)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()); }
__name(seoTitleCase, "seoTitleCase");
// extra <head> HTML for one page (empty string = nothing to add)
async function seoHeadFor(url, lang = "en", rawPath = null, prefixed = false, cc = null) {
  const path = String(rawPath || url.pathname).replace(/\.html$/, "");   // Pages serves /x.html as /x
  if (SEO_NOINDEX.includes(path)) return `<meta name="robots" content="noindex, follow">`;
  const L = prefixed ? lang : "en";
  if (path === "/" || path === "/index") return i18nAlternates("/") + `<meta property="og:locale" content="${I18N_LOCALE[L] || "en_GB"}">`;
  if (path !== "/bymarccc-product") return "";
  const key = (url.searchParams.get("p") || "").toLowerCase();
  const D = await loadCatalogData();
  const p = D && D.products && D.products[key];
  if (!p || !p.title) return `<meta name="robots" content="noindex, follow">`;
  const T = L !== "en" ? await i18nData(L) : null;
  const tr = (x) => i18nTr(T, x) || x;
  const name = seoTitleCase(tr(p.title));
  const gW = (T && T.seo && T.seo.womens) || "Women's", gM = (T && T.seo && T.seo.mens) || "Men's";
  const gender = p.gender === "women" ? gW : p.gender === "men" ? gM : "";
  const title = `${name}${gender ? " — " + gender : ""} | bymarccc`;
  const rawDesc = p.description ? tr(p.description) : [p.cut, ...(p.details || []).slice(0, 2)].filter(Boolean).map(tr).join(". ");
  const desc = String(rawDesc).replace(/\s+/g, " ").slice(0, 155);
  const pq = `/bymarccc-product?p=${encodeURIComponent(key)}`;
  const canon = i18nUrl(L, pq);
  const imgs = (p.gallery || []).slice(0, 6).map((g) => SEO_BASE + "/" + String(g.src).replace(/^\//, ""));
  const ron = typeof p.salePrice === "number" ? p.salePrice : p.price;
  let price = ron, cur = p.currency || "RON";
  if (cc && typeof ron === "number") { const rule = geoRule(cc, await geoRates()); price = geoPrice(ron, rule); cur = rule.cur; }
  const ld = {
    "@context": "https://schema.org", "@type": "Product", name, description: desc, image: imgs, sku: p.id || key,
    brand: { "@type": "Brand", name: "bymarccc" },
    ...(typeof price === "number" ? { offers: { "@type": "Offer", url: canon, priceCurrency: cur, price: String(price), availability: p.soldOut ? "https://schema.org/OutOfStock" : "https://schema.org/InStock", itemCondition: "https://schema.org/NewCondition", seller: { "@type": "Organization", name: "bymarccc" } } } : {})
  };
  return [
    `<meta name="description" content="${seoEsc(desc)}">`,
    `<link rel="canonical" href="${seoEsc(canon)}">`,
    i18nAlternates(pq),
    `<meta property="og:type" content="product">`, `<meta property="og:site_name" content="bymarccc">`,
    `<meta property="og:locale" content="${I18N_LOCALE[L] || "en_GB"}">`,
    `<meta property="og:title" content="${seoEsc(title)}">`, `<meta property="og:description" content="${seoEsc(desc)}">`,
    `<meta property="og:url" content="${seoEsc(canon)}">`, imgs[0] ? `<meta property="og:image" content="${seoEsc(imgs[0])}">` : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`,
    `<script>window.BYM_SEO_TITLE=${JSON.stringify(title).replace(/</g, "\\u003c")};</script>`
  ].filter(Boolean).join("");
}
__name(seoHeadFor, "seoHeadFor");

// ---------------------------------------------------------------------------------------------
// Languages — /hu/, /it/, /bg/ serve the same pages translated (assets/i18n-<lang>.js holds the
// strings; assets/i18n.js swaps them in the browser). Unprefixed pages stay English, except for
// visitors who picked a language (cookie bym_lang) or browse from Hungary / Italy / Bulgaria.
// Prefixed pages price in that country's currency, so Google and Merchant Center see one price.
// ---------------------------------------------------------------------------------------------
var I18N_VERSION = "5";
var I18N_LANGS = ["fr", "de", "it", "es", "nl", "pt", "pl", "ro", "hu", "cs", "bg", "el", "sv"];
var I18N_AUTO = ["fr", "de", "it", "es", "nl", "pt", "pl", "hu", "cs", "bg", "el", "sv"];   // picked automatically from the browser language (Romanian visitors keep English unless they choose RO)
var I18N_RE = new RegExp("^/(" + I18N_LANGS.join("|") + ")(/.*)?$");
var I18N_PRICE_CC = { fr: "FR", de: "DE", it: "IT", es: "ES", nl: "NL", pt: "PT", pl: "PL", ro: "RO", hu: "HU", cs: "CZ", bg: "BG", el: "GR", sv: "SE" };
var I18N_LOCALE = { en: "en_GB", fr: "fr_FR", de: "de_DE", it: "it_IT", es: "es_ES", nl: "nl_NL", pt: "pt_PT", pl: "pl_PL", ro: "ro_RO", hu: "hu_HU", cs: "cs_CZ", bg: "bg_BG", el: "el_GR", sv: "sv_SE" };
// country → feed / landing-page language (others get English)
var I18N_COUNTRY_LANG = { FR: "fr", MC: "fr", BE: "fr", LU: "fr", DE: "de", AT: "de", CH: "de", LI: "de", IT: "it", SM: "it", ES: "es", AD: "es", NL: "nl", PT: "pt", PL: "pl", RO: "ro", MD: "ro", HU: "hu", CZ: "cs", BG: "bg", GR: "el", CY: "el", SE: "sv" };
function i18nAcceptLang(request) {
  const first = String(request.headers.get("accept-language") || "").split(",")[0].trim().slice(0, 2).toLowerCase();
  return I18N_AUTO.includes(first) ? first : null;
}
__name(i18nAcceptLang, "i18nAcceptLang");
var I18N_MEM = {};
async function i18nData(lang) {
  if (!I18N_LANGS.includes(lang)) return null;
  const c = I18N_MEM[lang];
  if (c && Date.now() - c.t < 5 * 6e4) return c.d;
  try {
    const r = await ENV.ASSETS.fetch(new Request(`${CURRENT_ORIGIN}/assets/i18n-${lang}.js`));
    if (r.ok) {
      const src = await r.text();
      const a = src.indexOf("/*BEGIN-JSON*/"), b = src.indexOf("/*END-JSON*/");
      const d = JSON.parse(src.slice(a + 14, b));
      const map = Object.create(null), up = Object.create(null);
      for (const k in d.map || {}) { const n = String(k).replace(/\s+/g, " ").trim(); map[n] = d.map[k]; up[n.toUpperCase()] = String(d.map[k]).toUpperCase(); }
      d._map = map; d._up = up;
      I18N_MEM[lang] = { t: Date.now(), d };
      return d;
    }
  } catch {}
  return c ? c.d : null;
}
__name(i18nData, "i18nData");
function i18nTr(D, s) {
  if (!D || s == null) return null;
  const n = String(s).replace(/\s+/g, " ").trim();
  return D._map[n] || D._up[n] || null;
}
__name(i18nTr, "i18nTr");
function i18nUrl(lang, pq) { return SEO_BASE + (lang && lang !== "en" ? "/" + lang : "") + (pq === "/" && lang && lang !== "en" ? "/" : pq); }
__name(i18nUrl, "i18nUrl");
function i18nAlternates(pq) {
  return ["en", ...I18N_LANGS].map((l) => `<link rel="alternate" hreflang="${l}" href="${seoEsc(i18nUrl(l, pq))}">`).join("") + `<link rel="alternate" hreflang="x-default" href="${seoEsc(i18nUrl("en", pq))}">`;
}
__name(i18nAlternates, "i18nAlternates");
function i18nCookie(request) {
  const m = /(?:^|;\s*)bym_lang=([a-z]{2})\b/.exec(request.headers.get("cookie") || "");
  return m && (m[1] === "en" || I18N_LANGS.includes(m[1])) ? m[1] : null;
}
__name(i18nCookie, "i18nCookie");

// Google Merchant Center product feeds — /merchant/<country>.xml for every country we ship to (de, fr, gb,
// us, ca, au…): description and link in the country's language (English where we have none), price +
// shipping in its currency (same rules as the site); the landing page link carries ?cc= so it shows that price.
async function merchantFeed(cc) {
  const lang = I18N_COUNTRY_LANG[cc] || "en";
  const D = await loadCatalogData();
  const T = lang !== "en" ? await i18nData(lang) : null;
  const tr = (x) => i18nTr(T, x) || x;
  const rule = geoRule(cc, await geoRates());
  const money = (n) => `${Number(n).toFixed(2)} ${rule.cur}`;
  const items = [];
  for (const k of seoProductKeys(D)) {
    const p = D.products[k];
    if (typeof p.price !== "number") continue;
    const imgs = p.gallery.map((g) => SEO_BASE + "/" + String(g.src).replace(/^\//, ""));
    const desc = String(p.description ? tr(p.description) : [p.cut, ...(p.details || [])].filter(Boolean).map(tr).join(". ")).replace(/\s+/g, " ").slice(0, 4900);
    const gender = p.gender === "women" ? "female" : p.gender === "men" ? "male" : "unisex";
    const colour = Array.isArray(p.colours) && p.colours[0] && p.colours[0].name ? tr(p.colours[0].name) : "";
    const sizes = Array.isArray(p.chart) && !p.noSize ? p.chart.join("/") : "One Size";
    const sale = typeof p.salePrice === "number" && p.salePrice < p.price;
    const f = [
      ["g:id", k], ["g:title", seoTitleCase(p.title).slice(0, 150)], ["g:description", desc],
      ["g:link", i18nUrl(lang, `/bymarccc-product?p=${encodeURIComponent(k)}&cc=${cc}`)],
      ["g:image_link", imgs[0]], ...imgs.slice(1, 11).map((u) => ["g:additional_image_link", u]),
      ["g:availability", p.soldOut ? "out_of_stock" : "in_stock"],
      ["g:price", money(geoPrice(p.price, rule))], ...(sale ? [["g:sale_price", money(geoPrice(p.salePrice, rule))]] : []),
      ["g:brand", "bymarccc"], ["g:condition", "new"], ["g:identifier_exists", "no"],
      ["g:google_product_category", "166"], ["g:gender", gender], ["g:age_group", "adult"],
      ...(colour ? [["g:color", colour]] : []), ["g:size", sizes]
    ];
    items.push(`<item>${f.map(([t, v]) => `<${t}>${seoEsc(v)}</${t}>`).join("")}<g:shipping><g:country>${cc}</g:country><g:price>${money(rule.ship)}</g:price></g:shipping></item>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>bymarccc ${cc}</title><link>${i18nUrl(lang, "/")}</link><description>bymarccc products for ${cc}</description>\n${items.join("\n")}\n</channel></rss>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
__name(merchantFeed, "merchantFeed");


// ---------------------------------------------------------------------------------------------
// Content pages, rendered on the server in every language (assets/content/<lang>.json):
//   /about-us  /delivery-returns  /contact-us  /faq  /journal  /journal/<slug>  /shop/<category>
// Same black / white / Jost look as the shop; prices in the visitor's (or the page country's) currency.
// ---------------------------------------------------------------------------------------------
var CONTENT_PAGES = ["about-us", "delivery-returns", "contact-us", "faq"];
var CONTENT_MEM = {};
async function contentData(lang) {
  const c = CONTENT_MEM[lang];
  if (c && Date.now() - c.t < 5 * 6e4) return c.d;
  try {
    const r = await ENV.ASSETS.fetch(new Request(`${CURRENT_ORIGIN}/assets/content/${lang}.json`));
    if (r.ok) { const d = await r.json(); CONTENT_MEM[lang] = { t: Date.now(), d }; return d; }
  } catch {}
  if (c) return c.d;
  return lang === "en" ? null : contentData("en");
}
__name(contentData, "contentData");
function contentRoute(path) {
  const p = String(path).replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  if (CONTENT_PAGES.includes(p.slice(1))) return { kind: "page", id: p.slice(1), path: p };
  if (p === "/journal") return { kind: "journal", path: p };
  let m = /^\/journal\/([a-z0-9-]+)$/.exec(p);
  if (m) return { kind: "post", id: m[1], path: p };
  m = /^\/shop\/([a-z0-9-]+)$/.exec(p);
  if (m) return { kind: "cat", id: m[1], path: p };
  return null;
}
__name(contentRoute, "contentRoute");
function contentProducts(D, filter) {
  const keys = seoProductKeys(D);
  if (filter.keys) return filter.keys.filter((k) => keys.includes(k));
  return keys.filter((k) => {
    const p = D.products[k];
    const g = p.gender || (Array.isArray(p.genders) ? p.genders.slice().sort().join("+") : "") || "?";
    const gOk = (filter.g || ["*"]).some((x) => x === "*" || x === g || (g === "men+women" && (x === "men" || x === "women")));
    const cOk = !filter.c || (p.collections || []).some((c) => filter.c.includes(c));
    return gOk && cOk;
  });
}
__name(contentProducts, "contentProducts");
var CONTENT_MONEY_LOCALE = { RON: "ro-RO", EUR: "de-DE", USD: "en-US", GBP: "en-GB", CHF: "de-CH", PLN: "pl-PL", CZK: "cs-CZ", HUF: "hu-HU", SEK: "sv-SE", DKK: "da-DK", NOK: "nb-NO", CAD: "en-US", AUD: "en-US" };
function contentMoney(n, cur) {
  if (cur === "RON") return `${Number.isInteger(n) ? n : Number(n).toFixed(2).replace(".", ",")} RON`;
  try { return new Intl.NumberFormat(CONTENT_MONEY_LOCALE[cur] || "en-GB", { style: "currency", currency: cur, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(n); } catch { return `${n} ${cur}`; }
}
__name(contentMoney, "contentMoney");
var CONTENT_CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:#fff;color:#111;font-family:"Jost","Helvetica Neue",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65}
a{color:inherit}img{max-width:100%;display:block}
.bh{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px}
.bh .logo{font-weight:600;letter-spacing:.08em;text-decoration:none;font-size:18px}
.bh nav{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;letter-spacing:.14em;text-transform:uppercase}.bh nav a{text-decoration:none;opacity:.75}.bh nav a:hover{opacity:1}
.wrap{max-width:1100px;margin:0 auto;padding:28px 24px 64px}.narrow{max-width:760px}
.crumbs{font-size:12px;letter-spacing:.06em;color:#777;margin-bottom:18px}.crumbs a{text-decoration:none}
h1{font-weight:500;font-size:clamp(28px,4vw,42px);line-height:1.15;letter-spacing:-.01em;margin:0 0 18px}
h2{font-weight:500;font-size:22px;margin:36px 0 10px}h3{font-weight:500;font-size:18px;margin:24px 0 6px}
.lead{font-size:19px;color:#333}.muted{color:#777;font-size:13px}
.tbl{width:100%;border-collapse:collapse;margin:12px 0 4px;font-size:15px}.tbl th,.tbl td{border-bottom:1px solid #eee;padding:10px 8px;text-align:left}.tbl th{font-weight:500;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#777}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:22px 16px;margin-top:26px}
@media(max-width:900px){.grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:600px){.grid{grid-template-columns:repeat(2,1fr);gap:18px 10px}.bh{padding:12px 16px;flex-wrap:wrap;gap:8px}.bh nav{width:100%;flex-wrap:nowrap;overflow-x:auto;gap:16px;white-space:nowrap;scrollbar-width:none}.wrap{padding:22px 16px 48px}}
.card{text-decoration:none}.card .im{aspect-ratio:2/3;background:#f5f4f1;overflow:hidden}.card img{width:100%;height:100%;object-fit:cover}
.card .t{font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin-top:8px}.card .p{font-size:14px;color:#555}.card s{color:#aaa;margin-right:6px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:30px 0 0}.chips a{border:1px solid #ddd;border-radius:999px;padding:7px 14px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;text-decoration:none}
.posts{display:grid;gap:28px;margin-top:20px}.post{display:grid;grid-template-columns:200px 1fr;gap:20px;text-decoration:none}.post .im{aspect-ratio:4/5;background:#f5f4f1;overflow:hidden}.post img{width:100%;height:100%;object-fit:cover}
.post h2{margin:4px 0 8px;font-size:22px}@media(max-width:600px){.post{grid-template-columns:110px 1fr;gap:14px}.post h2{font-size:18px}}
.hero{aspect-ratio:4/3;overflow:hidden;background:#f5f4f1;margin:8px 0 24px}.hero img{width:100%;height:100%;object-fit:cover;object-position:center 20%}
details{border-bottom:1px solid #eee;padding:14px 0}summary{cursor:pointer;font-weight:500;font-size:17px;list-style:none}summary::-webkit-details-marker{display:none}summary:after{content:"+";float:right;font-weight:400}details[open] summary:after{content:"–"}details p{margin:10px 0 0;color:#333}
.btn{display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin-top:12px}
.site-footer{background:#f5f4f1;padding:40px 24px 26px;font-size:14px}.site-footer .cols{max-width:1100px;margin:0 auto;display:flex;flex-wrap:wrap;gap:12px 22px}.site-footer .cols a{text-decoration:none;opacity:.8}
.site-footer__bottom{max-width:1100px;margin:22px auto 0;padding-top:16px;border-top:1px solid #e2e0da;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;color:#777;font-size:12px}`;
async function contentRender(request, url, L, route) {
  const lang = L.lang || "en";
  const C = await contentData(lang), E = await contentData("en");
  if (!C) return null;
  const U = Object.assign({}, E && E.ui, C.ui);
  const base = L.prefixed ? `/${lang}` : "";
  const canonLang = L.prefixed ? lang : "en";
  const D = await loadCatalogData();
  const rates = await geoRates();
  const cc = L.cc || String((request.cf && request.cf.country) || request.headers.get("cf-ipcountry") || "RO").toUpperCase();
  const rule = geoRule(cc, rates);
  const T = lang !== "en" ? await i18nData(lang) : null;
  const tr = (x) => i18nTr(T, x) || x;
  const esc = seoEsc;
  const fix = (html) => String(html || "").replace(/href="\/(?!\/)/g, `href="${base}/`);
  const img = (p) => p && p.gallery && p.gallery[0] ? "/" + String(p.gallery[0].src).replace(/^\//, "") : "";
  const card = (k) => {
    const p = D.products[k]; if (!p) return "";
    const sale = typeof p.salePrice === "number" && p.salePrice < p.price;
    const price = (sale ? `<s>${esc(contentMoney(geoPrice(p.price, rule), rule.cur))}</s>` : "") + esc(contentMoney(geoPrice(sale ? p.salePrice : p.price, rule), rule.cur));
    return `<a class="card" href="${base}/bymarccc-product?p=${encodeURIComponent(k)}"><div class="im"><img loading="lazy" src="${esc(img(p))}" alt="${esc(p.title)}"></div><div class="t">${esc(p.title)}</div><div class="p">${price}</div></a>`;
  };
  const dateFmt = (d) => { try { return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : lang, { day: "numeric", month: "long", year: "numeric" }).format(new Date(d + "T12:00:00Z")); } catch { return d; } };
  const crumb = (items) => `<nav class="crumbs" aria-label="Breadcrumb">${items.map(([n, h]) => h ? `<a href="${h}">${esc(n)}</a>` : esc(n)).join(" / ")}</nav>`;
  const crumbLd = (items) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([n, h], i) => ({ "@type": "ListItem", position: i + 1, name: n, ...(h ? { item: SEO_BASE + h } : {}) })) });
  let title, desc, body, ld = [], ogImage = SEO_BASE + "/assets/img/lockscreen-alien.jpg", ogType = "website", narrow = true;
  const home = [U.home || "Home", `${base}/`];
  if (route.kind === "page") {
    const pg = C.pages[route.id] || (E && E.pages[route.id]); if (!pg) return null;
    title = pg.title; desc = pg.description;
    const items = [home, [pg.h1, null]];
    let faq = "";
    if (Array.isArray(pg.faqs) && pg.faqs.length) {
      faq = pg.faqs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("");
      ld.push({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: pg.faqs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });
    }
    if (route.id === "about-us") ld.push({ "@context": "https://schema.org", "@type": "Organization", name: "bymarccc", url: SEO_BASE + "/", logo: SEO_BASE + "/assets/icons/favicon-192.png", email: "contact@bymarccc.com", telephone: "+40750257490", address: { "@type": "PostalAddress", addressLocality: "Bucharest", addressCountry: "RO" }, sameAs: ["https://www.instagram.com/bymarccc", "https://www.tiktok.com/@bymarccc", "https://x.com/bymarccc_"] });
    ld.push(crumbLd(items.map(([n, h]) => [n, h])));
    body = `${crumb(items)}<h1>${esc(pg.h1)}</h1>${fix(pg.html)}${faq}`;
  } else if (route.kind === "journal") {
    const posts = (C.posts || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    title = `${U.journal || "Journal"} — bymarccc`; desc = (U.footerTag || "") + " " + posts.slice(0, 3).map((p) => p.title).join(" · ");
    desc = desc.slice(0, 158);
    const items = [home, [U.journal || "Journal", null]];
    ld.push(crumbLd(items), { "@context": "https://schema.org", "@type": "Blog", name: "bymarccc " + (U.journal || "Journal"), url: i18nUrl(canonLang, "/journal"), blogPost: posts.map((p) => ({ "@type": "BlogPosting", headline: p.title, url: i18nUrl(canonLang, "/journal/" + p.slug), datePublished: p.date })) });
    body = `${crumb(items)}<h1>${esc(U.journal || "Journal")}</h1><div class="posts">${posts.map((p) => `<a class="post" href="${base}/journal/${p.slug}"><div class="im"><img loading="lazy" src="${esc(img(D.products[(p.products || [])[0]]))}" alt=""></div><div><span class="muted">${esc(dateFmt(p.date))}</span><h2>${esc(p.title)}</h2><p>${esc(p.description)}</p><span class="btn">${esc(U.readMore || "Read the article")}</span></div></a>`).join("")}</div>`;
  } else if (route.kind === "post") {
    const p = (C.posts || []).find((x) => x.slug === route.id) || (E && (E.posts || []).find((x) => x.slug === route.id)); if (!p) return null;
    title = `${p.title} | bymarccc`; desc = p.description; ogType = "article";
    const hero = img(D.products[(p.products || [])[0]]);
    if (hero) ogImage = SEO_BASE + hero;
    const items = [home, [U.journal || "Journal", `${base}/journal`], [p.title, null]];
    ld.push(crumbLd(items), { "@context": "https://schema.org", "@type": "BlogPosting", headline: p.title, description: p.description, datePublished: p.date, dateModified: p.date, inLanguage: lang, image: hero ? [SEO_BASE + hero] : undefined, author: { "@type": "Organization", name: "bymarccc" }, publisher: { "@type": "Organization", name: "bymarccc", logo: { "@type": "ImageObject", url: SEO_BASE + "/assets/img/lockscreen-alien.jpg" } }, mainEntityOfPage: i18nUrl(canonLang, "/journal/" + p.slug) });
    const more = (C.posts || []).filter((x) => x.slug !== p.slug).slice(0, 3);
    body = `${crumb(items)}<span class="muted">${esc(dateFmt(p.date))}</span><h1>${esc(p.title)}</h1>${hero ? `<div class="hero"><img src="${esc(hero)}" alt="${esc(p.title)}"></div>` : ""}${fix(p.html)}` +
      ((p.products || []).length ? `<h2>${esc(U.shopThePieces || "Shop the pieces")}</h2><div class="grid">${p.products.map(card).join("")}</div>` : "") +
      (more.length ? `<h2>${esc(U.latestArticles || "From the journal")}</h2><ul>${more.map((x) => `<li><a href="${base}/journal/${x.slug}">${esc(x.title)}</a></li>`).join("")}</ul>` : "");
  } else if (route.kind === "cat") {
    const c = C.categories[route.id] || (E && E.categories[route.id]); if (!c) return null;
    const keys = contentProducts(D, (E && E.categories[route.id] && E.categories[route.id].filter) || c.filter || {});
    title = `${c.title} | bymarccc`; desc = c.description; narrow = false;
    if (keys[0]) ogImage = SEO_BASE + img(D.products[keys[0]]);
    const items = [home, [U.shop || "Shop", null], [c.h1, null]];
    ld.push(crumbLd(items), { "@context": "https://schema.org", "@type": "CollectionPage", name: c.title, description: c.description, url: i18nUrl(canonLang, route.path), mainEntity: { "@type": "ItemList", numberOfItems: keys.length, itemListElement: keys.map((k, i) => ({ "@type": "ListItem", position: i + 1, url: i18nUrl(canonLang, `/bymarccc-product?p=${encodeURIComponent(k)}`), name: D.products[k].title })) } });
    const others = Object.keys(C.categories).filter((k) => k !== route.id);
    body = `${crumb(items)}<h1>${esc(c.h1)}</h1><p class="lead">${esc(c.intro)}</p><div class="grid">${keys.map(card).join("")}</div>` +
      `<div class="chips">${others.map((k) => `<a href="${base}/shop/${k}">${esc(C.categories[k].h1)}</a>`).join("")}</div>`;
  }
  const canon = i18nUrl(canonLang, route.path);
  const nav = [["women-tops", U.women || "Women"], ["men-jeans", U.men || "Men"], ["custom-bags", U.customize || "Customize"], ["sale", U.sale || "Sale"]];
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" type="image/png" sizes="96x96" href="/assets/icons/favicon-96.png"><link rel="icon" type="image/png" sizes="192x192" href="/assets/icons/favicon-192.png"><link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(canon)}">${i18nAlternates(route.path)}
<meta property="og:type" content="${ogType}"><meta property="og:site_name" content="bymarccc"><meta property="og:locale" content="${I18N_LOCALE[canonLang] || "en_GB"}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(canon)}"><meta property="og:image" content="${esc(ogImage)}"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/img/lockscreen-alien.jpg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CONTENT_CSS}</style>${ld.map((x) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, "\\u003c")}</script>`).join("")}
<script>window.BYM_LANG=${JSON.stringify(lang)};</script><script src="/assets/i18n.js?v=${I18N_VERSION}" defer></script></head>
<body><!--email_off--><header class="bh"><a class="logo" href="${base}/">bymarccc</a><nav>${nav.map(([k, n]) => `<a href="${base}/shop/${k}">${esc(n)}</a>`).join("")}<a href="${base}/journal">${esc(U.journal || "Journal")}</a></nav></header>
<main class="wrap${narrow ? " narrow" : ""}">${body}</main>
<footer class="site-footer"><div class="cols"><a href="${base}/about-us">${esc(U.about || "About us")}</a><a href="${base}/faq">${esc(U.faq || "FAQ")}</a><a href="${base}/delivery-returns">${esc(U.delivery || "Delivery & Returns")}</a><a href="${base}/contact-us">${esc(U.contact || "Contact")}</a><a href="${base}/journal">${esc(U.journal || "Journal")}</a>${Object.keys(C.categories).map((k) => `<a href="${base}/shop/${k}">${esc(C.categories[k].h1)}</a>`).join("")}</div>
<div class="site-footer__bottom"><p>© ${new Date().getUTCFullYear()} bymarccc. ${esc(U.rights || "All rights reserved.")}</p></div></footer><!--/email_off--></body></html>`;
  const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache", "Content-Language": lang, "Vary": "Cookie, Accept-Language" });
  if (L.prefixed) h.append("Set-Cookie", `bym_lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  return new Response(html, { status: 200, headers: h });
}
__name(contentRender, "contentRender");
async function contentSitemapEntries() {
  const E = await contentData("en");
  if (!E) return [];
  return [...CONTENT_PAGES.map((p) => "/" + p), "/journal", ...(E.posts || []).map((p) => "/journal/" + p.slug), ...Object.keys(E.categories || {}).map((k) => "/shop/" + k)];
}
__name(contentSitemapEntries, "contentSitemapEntries");

// ---------------------------------------------------------------------------------------------
// Customer accounts — bymarccc CIRCLE (D1 binding ORDERS_DB). Sign in with an e-mailed 6-digit code (no passwords).
// Tiers on LIFETIME spend (RON, before shipping, after discounts; cancelled/returned orders excluded):
//   Bronze 0 · Silver 1 500 (−10 %, free shipping) · Gold 4 000 (−20 %, free shipping, early access to drops)
//   Platinum 10 000 (−30 %, free shipping, early access). Everyone gets their own playlist.
// Also: orders & returns, credits, address book, wishlist, communication preferences, refer a friend
// (friend −10 % on the first order, you −10 % on your next order). Discounts are applied on the server at checkout.
// GOATIFY reads/updates customers through /api/account-admin (signed with GOATIFY_SITE_SECRET).
// ---------------------------------------------------------------------------------------------
var ACCT_COOKIE = "bym_acct";
var ACCT_TTL = 60 * 60 * 24 * 180;
var ACCT_TIERS = [
  { id: "bronze", name: "Bronze", min: 0, pct: 0, freeShip: false, drops: false },
  { id: "silver", name: "Silver", min: 1500, pct: 10, freeShip: true, drops: false },
  { id: "gold", name: "Gold", min: 4000, pct: 20, freeShip: true, drops: true },
  { id: "platinum", name: "Platinum", min: 10000, pct: 30, freeShip: true, drops: true }
];
var ACCT_REF_PCT = 10;
var acctReady = null;
function acctDb() { return ordersDb(); }
__name(acctDb, "acctDb");
async function acctInit() {
  const db = acctDb();
  if (!db) throw Object.assign(new Error("ACCOUNTS_NOT_CONFIGURED"), { status: 503 });
  if (!acctReady) acctReady = db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS acct_customers (email TEXT PRIMARY KEY, name TEXT, phone TEXT, created_at TEXT NOT NULL, ref_code TEXT UNIQUE, referred_by TEXT, prefs TEXT, spend_import REAL DEFAULT 0, tier_override TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS acct_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS acct_sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS acct_addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, data TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS acct_wishlist (email TEXT NOT NULL, pkey TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (email, pkey))"),
    db.prepare("CREATE TABLE IF NOT EXISTS acct_playlist (email TEXT NOT NULL, track TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (email, track))"),
    db.prepare("CREATE TABLE IF NOT EXISTS acct_orders (order_id TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'placed', pay TEXT, currency TEXT, total_local REAL, ship_local REAL, total_ron REAL NOT NULL DEFAULT 0, discount_pct REAL DEFAULT 0, credit_ron REAL DEFAULT 0, items TEXT, ship_to TEXT)"),
    db.prepare("CREATE INDEX IF NOT EXISTS acct_orders_email ON acct_orders (email, created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS acct_credits (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, kind TEXT NOT NULL, amount_ron REAL NOT NULL DEFAULT 0, pct REAL NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL, expires_at TEXT, used_order TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS acct_referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer TEXT NOT NULL, referee TEXT NOT NULL UNIQUE, order_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL)")
  ]).catch((e) => { acctReady = null; throw e; });
  await acctReady;
  return db;
}
__name(acctInit, "acctInit");
var acctNow = () => new Date().toISOString();
var acctRand = (n) => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const r = crypto.getRandomValues(new Uint8Array(n)); return [...r].map((x) => a[x % a.length]).join(""); };
async function acctSha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
__name(acctSha, "acctSha");
var acctCookie = (token, maxAge) => `${ACCT_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
async function acctSessionEmail(request) {
  const db = acctDb(); if (!db) return null;
  const token = readCookie(request, ACCT_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{24,}$/.test(token)) return null;
  try { await acctInit(); } catch { return null; }
  const r = await db.prepare("SELECT email, expires FROM acct_sessions WHERE token = ?1").bind(await acctSha(token)).first();
  if (!r || r.expires < Date.now() / 1e3) return null;
  return r.email;
}
__name(acctSessionEmail, "acctSessionEmail");
async function acctSpend(db, email) {
  const since = "1970-01-01T00:00:00.000Z";   // lifetime spend — tiers never expire
  const r = await db.prepare("SELECT COALESCE(SUM(total_ron),0) AS s, COUNT(*) AS n FROM acct_orders WHERE email = ?1 AND created_at >= ?2 AND status NOT IN ('cancelled','returned','refunded')").bind(email, since).first();
  const c = await db.prepare("SELECT spend_import, tier_override FROM acct_customers WHERE email = ?1").bind(email).first();
  return { spend: Math.round(((r && r.s) || 0) + ((c && c.spend_import) || 0)), orders: (r && r.n) || 0, override: c && c.tier_override };
}
__name(acctSpend, "acctSpend");
function acctTierFor(spend, override) {
  let t = ACCT_TIERS[0];
  for (const x of ACCT_TIERS) if (spend >= x.min) t = x;
  if (override) { const o = ACCT_TIERS.find((x) => x.id === override); if (o && o.min > t.min) t = o; }
  const i = ACCT_TIERS.indexOf(t), next = ACCT_TIERS[i + 1] || null;
  return { tier: t, next, toNext: next ? Math.max(0, next.min - spend) : 0 };
}
__name(acctTierFor, "acctTierFor");
// discount context for a checkout: best single percentage (tier / first-order referral / referral reward) + free shipping + credit
async function acctCheckoutContext(request) {
  const email = await acctSessionEmail(request);
  if (!email) return null;
  const db = acctDb();
  const sp = await acctSpend(db, email), tf = acctTierFor(sp.spend, sp.override);
  let pct = tf.tier.pct, why = tf.tier.pct ? tf.tier.name : "", voucher = null;
  const cust = await db.prepare("SELECT referred_by FROM acct_customers WHERE email = ?1").bind(email).first();
  const anyOrder = await db.prepare("SELECT 1 FROM acct_orders WHERE email = ?1 LIMIT 1").bind(email).first();
  if (cust && cust.referred_by && !anyOrder && ACCT_REF_PCT > pct) { pct = ACCT_REF_PCT; why = "Welcome (referral)"; }
  const now = acctNow();
  const v = await db.prepare("SELECT id, pct FROM acct_credits WHERE email = ?1 AND kind = 'pct' AND used_order IS NULL AND (expires_at IS NULL OR expires_at > ?2) ORDER BY pct DESC LIMIT 1").bind(email, now).first();
  if (v && v.pct > pct) { pct = v.pct; why = "Referral reward"; voucher = v.id; }
  const cr = await db.prepare("SELECT COALESCE(SUM(amount_ron),0) AS s FROM acct_credits WHERE email = ?1 AND kind IN ('credit','refund') AND used_order IS NULL AND (expires_at IS NULL OR expires_at > ?2)").bind(email, now).first();
  return { email, tier: tf.tier.id, tierName: tf.tier.name, pct, why, voucher, freeShip: tf.tier.freeShip, creditRon: Math.max(0, Math.round(((cr && cr.s) || 0) * 100) / 100) };
}
__name(acctCheckoutContext, "acctCheckoutContext");
// never charge less than the catalogue price for a known product (the bag's price comes from the browser)
async function acctTrustedRon(items) {
  const D = await loadCatalogData().catch(() => null);
  const byId = new Map();
  if (D && D.products) for (const k in D.products) { const p = D.products[k]; if (p && p.id) byId.set(String(p.id), p); byId.set(k, p); }
  return items.map((it) => {
    const id = String(it.id || "").split(":").slice(0, 2).join(":"), p = byId.get(id) || byId.get(String(it.id || "").split(":")[0]);
    const floor = p ? (typeof p.salePrice === "number" ? p.salePrice : p.price) : 0;
    const price = Number(it.price || 0);
    const out = { ...it, price: typeof floor === "number" && floor > price ? floor : price };
    // SALES pieces are one-offs: never more than 1 of the same line
    if (p && Array.isArray(p.collections) && p.collections.includes("sales")) { if ("quantity" in out || !("qty" in out)) out.quantity = 1; if ("qty" in out) out.qty = 1; }
    return out;
  });
}
__name(acctTrustedRon, "acctTrustedRon");
function acctApplyPct(localUnit, pct, cur) {
  if (!pct) return localUnit;
  const v = localUnit * (1 - pct / 100);
  return cur === "RON" ? Math.round(v * 100) / 100 : Math.round(v);
}
__name(acctApplyPct, "acctApplyPct");
// record an accepted order on the customer's account (also: referral rewards, used vouchers/credits)
async function acctRecordOrder(o, info) {
  const db = acctDb(); if (!db) return;
  await acctInit();
  const email = normEmail(info.email || (o.customer && o.customer.email));
  if (!validEmail(email)) return;
  const exists = await db.prepare("SELECT 1 FROM acct_orders WHERE order_id = ?1").bind(o.order_id).first();
  if (exists) return;
  const c = o.customer || {};
  await db.prepare("INSERT INTO acct_orders (order_id, email, created_at, status, pay, currency, total_local, ship_local, total_ron, discount_pct, credit_ron, items, ship_to) VALUES (?1,?2,?3,'placed',?4,?5,?6,?7,?8,?9,?10,?11,?12)")
    .bind(o.order_id, email, acctNow(), info.pay || "", info.currency || "RON", Number(info.totalLocal) || 0, Number(info.shipLocal) || 0, Math.max(0, Number(info.totalRon) || 0), Number(info.pct) || 0, Number(info.creditRon) || 0,
      JSON.stringify((info.items || []).slice(0, 50)), JSON.stringify({ full_name: c.full_name, address: c.address, apartment: c.apartment, city: c.city, postal_code: c.postal_code, country: c.country, phone: c.phone })).run();
  if (info.voucher) await db.prepare("UPDATE acct_credits SET used_order = ?2 WHERE id = ?1 AND used_order IS NULL").bind(info.voucher, o.order_id).run();
  if (info.creditRon > 0) {
    let left = info.creditRon;
    const rows = (await db.prepare("SELECT id, amount_ron FROM acct_credits WHERE email = ?1 AND kind IN ('credit','refund') AND used_order IS NULL ORDER BY created_at").bind(email).all()).results || [];
    for (const r of rows) {
      if (left <= 0) break;
      if (r.amount_ron <= left + 0.001) { await db.prepare("UPDATE acct_credits SET used_order = ?2 WHERE id = ?1").bind(r.id, o.order_id).run(); left -= r.amount_ron; }
      else { await db.prepare("UPDATE acct_credits SET amount_ron = ?2 WHERE id = ?1").bind(r.id, Math.round((r.amount_ron - left) * 100) / 100).run(); await db.prepare("INSERT INTO acct_credits (email, kind, amount_ron, note, created_at, used_order) VALUES (?1,'credit',?2,'Used at checkout',?3,?4)").bind(email, left, acctNow(), o.order_id).run(); left = 0; }
    }
  }
  // first order of a referred customer → the friend who invited them gets −10 % on their next order (valid 60 days)
  const cust = await db.prepare("SELECT referred_by FROM acct_customers WHERE email = ?1").bind(email).first();
  if (cust && cust.referred_by) {
    const ref = await db.prepare("SELECT id, status FROM acct_referrals WHERE referee = ?1").bind(email).first();
    if (ref && ref.status === "signed_up") {
      await db.prepare("UPDATE acct_referrals SET status = 'ordered', order_id = ?2 WHERE id = ?1").bind(ref.id, o.order_id).run();
      await db.prepare("INSERT INTO acct_credits (email, kind, pct, note, created_at, expires_at) VALUES (?1,'pct',?2,?3,?4,?5)").bind(cust.referred_by, ACCT_REF_PCT, `Referral reward — ${email.replace(/(.).+(@.+)/, "$1…$2")} placed their first order`, acctNow(), new Date(Date.now() + 60 * 864e5).toISOString()).run();
    }
  }
}
__name(acctRecordOrder, "acctRecordOrder");
async function acctProfile(db, email) {
  const c = await db.prepare("SELECT * FROM acct_customers WHERE email = ?1").bind(email).first();
  if (!c) return null;
  const sp = await acctSpend(db, email), tf = acctTierFor(sp.spend, sp.override);
  let prefs = {}; try { prefs = JSON.parse(c.prefs || "{}"); } catch {}
  return {
    email, name: c.name || "", phone: c.phone || "", since: c.created_at, prefs,
    refCode: c.ref_code, refLink: `${SEO_BASE}/r/${c.ref_code}`,
    spend: sp.spend, orders: sp.orders,
    tier: { id: tf.tier.id, name: tf.tier.name, pct: tf.tier.pct, freeShip: tf.tier.freeShip, drops: tf.tier.drops },
    next: tf.next ? { id: tf.next.id, name: tf.next.name, min: tf.next.min, pct: tf.next.pct } : null, toNext: tf.toNext,
    tiers: ACCT_TIERS
  };
}
__name(acctProfile, "acctProfile");
async function accountApi(request) {
  let db;
  try { db = await acctInit(); } catch (e) { return json(e.status || 500, { error: "ACCOUNTS_NOT_CONFIGURED" }); }
  const url = new URL(request.url);
  const b = request.method === "POST" ? (await readJson(request)) || {} : {};
  const action = String(b.action || url.searchParams.get("action") || "me");
  if (request.method === "POST" && !checkOrigin(request)) return json(403, { error: "Forbidden origin" });
  // ---- sign in: e-mail → 6-digit code → session ----
  if (action === "start") {
    if (!rateLimit(request, 6)) return json(429, { error: "Too many attempts. Please wait a minute." });
    const email = normEmail(b.email);
    if (!validEmail(email)) return json(400, { error: "Please enter a valid e-mail address." });
    if (!env("RESEND_API_KEY") || !env("ORDER_EMAIL_FROM")) return json(503, { error: "EMAIL_NOT_CONFIGURED" });
    const prev = await db.prepare("SELECT sent_at FROM acct_codes WHERE email = ?1").bind(email).first();
    if (prev && Date.now() / 1e3 - prev.sent_at < 30) return json(429, { error: "We just sent you a code. Please check your inbox." });
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
    await db.prepare("INSERT INTO acct_codes (email, code_hash, expires, tries, sent_at) VALUES (?1,?2,?3,0,?4) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, tries = 0, sent_at = excluded.sent_at")
      .bind(email, await acctSha(`${email}:${code}`), Math.floor(Date.now() / 1e3) + 900, Math.floor(Date.now() / 1e3)).run();
    const F = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    // digits drop into their boxes one by one (Apple Mail / iOS Mail / Outlook.com play the animation; Gmail & others show the code static)
    const digits = code.split("").map((d, k) => `<td class="bd" style="width:44px;height:58px;text-align:center;vertical-align:middle;background:#f4f3ef;border:1px solid #e4e4e1;border-radius:12px;font-family:${F};font-size:30px;font-weight:800;color:#111"><span class="bdn" style="display:inline-block;animation-delay:${0.35 + k * 0.22}s">${d}</span></td>${k < 5 ? '<td style="width:8px"></td>' : ""}`).join("");
    const html = `<!doctype html><html><head><meta name="color-scheme" content="light only"><style>@keyframes bymIn{0%{opacity:0;transform:translateY(-14px) scale(.6)}60%{opacity:1;transform:translateY(3px) scale(1.08)}100%{opacity:1;transform:none}}@keyframes bymBox{0%{border-color:#e4e4e1}50%{border-color:#111}100%{border-color:#e4e4e1}}.bdn{animation-name:bymIn;animation-duration:.5s;animation-timing-function:cubic-bezier(.2,.8,.2,1);animation-fill-mode:both}.bd{animation:bymBox 1.6s ease .2s 1}</style></head><body style="margin:0;background:#f4f3ef"><div style="display:none;max-height:0;overflow:hidden">Your bymarccc verification code is ${code}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" style="max-width:480px;background:#fff;border-radius:20px"><tr><td style="padding:28px;font-family:${F}"><div style="font-size:15px;font-weight:700;letter-spacing:5px">bymarccc</div><h1 style="margin:22px 0 8px;font-size:22px">Your verification code</h1><p style="margin:0 0 20px;color:#6b6b68;font-size:15px">Enter this code on bymarccc.com to open your account. It expires in 15 minutes.</p><table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>${digits}</tr></table><p style="margin:20px 0 0;color:#6b6b68;font-size:14px;text-align:center">Your code: <b style="color:#111;letter-spacing:2px">${code}</b></p><p style="margin:18px 0 0;color:#9a9a96;font-size:12px">If you didn't ask for this, you can ignore this e-mail.</p></td></tr></table></td></tr></table></body></html>`;
    try { await resendSend({ from: env("ORDER_EMAIL_FROM"), to: [email], subject: `${code} is your bymarccc verification code`, html, text: `Your bymarccc verification code is ${code}. It expires in 15 minutes.` }); }
    catch (e) { return json(502, { error: "We couldn't send the e-mail. Please try again." }); }
    return json(200, { ok: true });
  }
  if (action === "verify") {
    if (!rateLimit(request, 12)) return json(429, { error: "Too many attempts. Please wait a minute." });
    const email = normEmail(b.email), code = String(b.code || "").replace(/\D/g, "");
    const row = await db.prepare("SELECT * FROM acct_codes WHERE email = ?1").bind(email).first();
    if (!row || row.expires < Date.now() / 1e3 || row.tries >= 5) return json(400, { error: "This code has expired. Ask for a new one." });
    if (row.code_hash !== await acctSha(`${email}:${code}`)) { await db.prepare("UPDATE acct_codes SET tries = tries + 1 WHERE email = ?1").bind(email).run(); return json(400, { error: "Wrong code. Please check and try again." }); }
    await db.prepare("DELETE FROM acct_codes WHERE email = ?1").bind(email).run();
    let cust = await db.prepare("SELECT email FROM acct_customers WHERE email = ?1").bind(email).first();
    if (!cust) {
      let refBy = null;
      const refCode = String(readCookie(request, "bym_ref") || b.ref || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (refCode) { const r = await db.prepare("SELECT email FROM acct_customers WHERE ref_code = ?1").bind(refCode).first(); if (r && r.email !== email) refBy = r.email; }
      const prev = await db.prepare("SELECT 1 FROM acct_orders WHERE email = ?1 LIMIT 1").bind(email).first();
      if (prev) refBy = null;   // referral is for new customers only
      let code7 = acctRand(7);
      for (let i = 0; i < 3; i++) { const x = await db.prepare("SELECT 1 FROM acct_customers WHERE ref_code = ?1").bind(code7).first(); if (!x) break; code7 = acctRand(7); }
      await db.prepare("INSERT INTO acct_customers (email, name, created_at, ref_code, referred_by, prefs) VALUES (?1,?2,?3,?4,?5,?6)").bind(email, String(b.name || "").slice(0, 80), acctNow(), code7, refBy, JSON.stringify({ news: true, drops: true })).run();
      if (refBy) await db.prepare("INSERT OR IGNORE INTO acct_referrals (referrer, referee, status, created_at) VALUES (?1,?2,'signed_up',?3)").bind(refBy, email, acctNow()).run();
    }
    const token = b64(crypto.getRandomValues(new Uint8Array(30))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await db.prepare("INSERT INTO acct_sessions (token, email, expires) VALUES (?1,?2,?3)").bind(await acctSha(token), email, Math.floor(Date.now() / 1e3) + ACCT_TTL).run();
    await db.prepare("DELETE FROM acct_sessions WHERE expires < ?1").bind(Math.floor(Date.now() / 1e3)).run().catch(() => {});
    return json(200, { ok: true, profile: await acctProfile(db, email) }, { "Set-Cookie": acctCookie(token, ACCT_TTL) });
  }
  if (action === "logout") {
    const token = readCookie(request, ACCT_COOKIE);
    if (token) await db.prepare("DELETE FROM acct_sessions WHERE token = ?1").bind(await acctSha(token)).run().catch(() => {});
    return json(200, { ok: true }, { "Set-Cookie": acctCookie("", 0) });
  }
  // ---- everything below needs a session ----
  const email = await acctSessionEmail(request);
  if (action === "me" && !email) return json(200, { profile: null });
  if (!email) return json(401, { error: "Please sign in." });
  if (action === "me") return json(200, { profile: await acctProfile(db, email) });
  if (action === "checkout") {
    const ctx = await acctCheckoutContext(request);
    const p = await acctProfile(db, email);
    const addr = await db.prepare("SELECT data FROM acct_addresses WHERE email = ?1 ORDER BY is_default DESC, id DESC LIMIT 1").bind(email).first();
    let a = null; try { a = addr ? JSON.parse(addr.data) : null; } catch {}
    return json(200, { ctx, profile: p && { email: p.email, name: p.name, phone: p.phone, tier: p.tier }, address: a });
  }
  if (action === "update") {
    const name = String(b.name ?? "").trim().slice(0, 80), phone = String(b.phone ?? "").replace(/[^\d+ ()-]/g, "").slice(0, 30);
    await db.prepare("UPDATE acct_customers SET name = ?2, phone = ?3 WHERE email = ?1").bind(email, name, phone).run();
    return json(200, { profile: await acctProfile(db, email) });
  }
  if (action === "prefs") {
    const prefs = { news: !!b.news, drops: !!b.drops, sms: !!b.sms };
    await db.prepare("UPDATE acct_customers SET prefs = ?2 WHERE email = ?1").bind(email, JSON.stringify(prefs)).run();
    return json(200, { prefs });
  }
  if (action === "delete") {
    if (String(b.confirm || "") !== "DELETE") return json(400, { error: "Type DELETE to confirm." });
    for (const t of ["acct_sessions", "acct_addresses", "acct_wishlist", "acct_playlist", "acct_codes"]) await db.prepare(`DELETE FROM ${t} WHERE email = ?1`).bind(email).run();
    await db.prepare("DELETE FROM acct_customers WHERE email = ?1").bind(email).run();
    return json(200, { ok: true }, { "Set-Cookie": acctCookie("", 0) });
  }
  if (action === "orders") {
    const rows = (await db.prepare("SELECT order_id, created_at, status, pay, currency, total_local, ship_local, total_ron, discount_pct, items, ship_to FROM acct_orders WHERE email = ?1 ORDER BY created_at DESC LIMIT 100").bind(email).all()).results || [];
    return json(200, { orders: rows.map((r) => ({ ...r, items: (() => { try { return JSON.parse(r.items || "[]"); } catch { return []; } })(), ship_to: (() => { try { return JSON.parse(r.ship_to || "{}"); } catch { return {}; } })() })) });
  }
  if (action === "return") {
    const id = String(b.order_id || "");
    const o = await db.prepare("SELECT order_id, status, created_at FROM acct_orders WHERE email = ?1 AND order_id = ?2").bind(email, id).first();
    if (!o) return json(404, { error: "Order not found." });
    if (o.status === "return_requested") return json(200, { ok: true });
    await db.prepare("UPDATE acct_orders SET status = 'return_requested' WHERE order_id = ?1").bind(id).run();
    try { await resendSend({ from: env("ORDER_EMAIL_FROM"), to: env("ORDER_NOTIFY_TO").split(",").map((x) => x.trim()).filter(Boolean), reply_to: email, subject: `Return request — ${id}`, text: `Return requested from the customer account.\n\nOrder: ${id}\nCustomer: ${email}\nReason: ${String(b.reason || "").slice(0, 500)}` }); } catch {}
    return json(200, { ok: true });
  }
  if (action === "credits") {
    const rows = (await db.prepare("SELECT id, kind, amount_ron, pct, note, created_at, expires_at, used_order FROM acct_credits WHERE email = ?1 ORDER BY created_at DESC LIMIT 100").bind(email).all()).results || [];
    const now = acctNow();
    const avail = rows.filter((r) => !r.used_order && (!r.expires_at || r.expires_at > now));
    return json(200, { credits: rows, available: Math.round(avail.filter((r) => r.kind === "credit").reduce((a, r) => a + r.amount_ron, 0) * 100) / 100, refunds: Math.round(avail.filter((r) => r.kind === "refund").reduce((a, r) => a + r.amount_ron, 0) * 100) / 100, vouchers: avail.filter((r) => r.kind === "pct") });
  }
  if (action === "referrals") {
    const rows = (await db.prepare("SELECT referee, status, created_at FROM acct_referrals WHERE referrer = ?1 ORDER BY created_at DESC LIMIT 100").bind(email).all()).results || [];
    return json(200, { referrals: rows.map((r) => ({ ...r, referee: r.referee.replace(/(.).+(@.+)/, "$1…$2") })) });
  }
  if (action === "addresses") {
    const rows = (await db.prepare("SELECT id, data, is_default FROM acct_addresses WHERE email = ?1 ORDER BY is_default DESC, id DESC").bind(email).all()).results || [];
    return json(200, { addresses: rows.map((r) => { let d = {}; try { d = JSON.parse(r.data); } catch {} return { id: r.id, isDefault: !!r.is_default, ...d }; }) });
  }
  if (action === "address-save") {
    const s = (v, n) => String(v ?? "").trim().slice(0, n);
    const d = { full_name: s(b.full_name, 120), phone: s(b.phone, 40), address: s(b.address, 200), apartment: s(b.apartment, 100), city: s(b.city, 80), postal_code: s(b.postal_code, 20), country: s(b.country, 60) };
    if (!d.full_name || !d.address || !d.city || !d.country) return json(400, { error: "Please fill in name, address, city and country." });
    const cnt = await db.prepare("SELECT COUNT(*) AS n FROM acct_addresses WHERE email = ?1").bind(email).first();
    const makeDefault = !!b.isDefault || !cnt || !cnt.n;
    if (makeDefault) await db.prepare("UPDATE acct_addresses SET is_default = 0 WHERE email = ?1").bind(email).run();
    if (b.id) await db.prepare("UPDATE acct_addresses SET data = ?3, is_default = CASE WHEN ?4 THEN 1 ELSE is_default END WHERE id = ?1 AND email = ?2").bind(Number(b.id), email, JSON.stringify(d), makeDefault ? 1 : 0).run();
    else { if (cnt && cnt.n >= 10) return json(400, { error: "You can save up to 10 addresses." }); await db.prepare("INSERT INTO acct_addresses (email, data, is_default, created_at) VALUES (?1,?2,?3,?4)").bind(email, JSON.stringify(d), makeDefault ? 1 : 0, acctNow()).run(); }
    return json(200, { ok: true });
  }
  if (action === "address-delete") { await db.prepare("DELETE FROM acct_addresses WHERE id = ?1 AND email = ?2").bind(Number(b.id), email).run(); return json(200, { ok: true }); }
  if (action === "wishlist") {
    if (Array.isArray(b.merge)) for (const k of b.merge.slice(0, 100)) { const key = String(k).replace(/[^a-z0-9:-]/gi, "").slice(0, 80); if (key) await db.prepare("INSERT OR IGNORE INTO acct_wishlist (email, pkey, added_at) VALUES (?1,?2,?3)").bind(email, key, acctNow()).run(); }
    if (b.add) await db.prepare("INSERT OR IGNORE INTO acct_wishlist (email, pkey, added_at) VALUES (?1,?2,?3)").bind(email, String(b.add).replace(/[^a-z0-9:-]/gi, "").slice(0, 80), acctNow()).run();
    if (b.remove) await db.prepare("DELETE FROM acct_wishlist WHERE email = ?1 AND pkey = ?2").bind(email, String(b.remove)).run();
    const rows = (await db.prepare("SELECT pkey FROM acct_wishlist WHERE email = ?1 ORDER BY added_at DESC").bind(email).all()).results || [];
    return json(200, { wishlist: rows.map((r) => r.pkey) });
  }
  if (action === "playlist") {
    const clean = (t) => String(t || "").replace(/[^a-z0-9-]/gi, "").slice(0, 60);
    if (b.add) await db.prepare("INSERT OR IGNORE INTO acct_playlist (email, track, added_at) VALUES (?1,?2,?3)").bind(email, clean(b.add), acctNow()).run();
    if (b.remove) await db.prepare("DELETE FROM acct_playlist WHERE email = ?1 AND track = ?2").bind(email, clean(b.remove)).run();
    const rows = (await db.prepare("SELECT track FROM acct_playlist WHERE email = ?1 ORDER BY added_at").bind(email).all()).results || [];
    return json(200, { playlist: rows.map((r) => r.track) });
  }
  return json(400, { error: "Unknown action" });
}
__name(accountApi, "accountApi");
// /r/<code> — referral link: remembers the code for 30 days and opens the shop
function accountRefRedirect(url, code) {
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const h = new Headers({ Location: `${url.origin}/members.html?ref=${c}#join` });
  if (c) h.append("Set-Cookie", `bym_ref=${c}; Path=/; Max-Age=${30 * 86400}; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers: h });
}
__name(accountRefRedirect, "accountRefRedirect");
// POST /api/account-admin — GOATIFY ↔ customer accounts (HMAC-SHA256(GOATIFY_SITE_SECRET, `${ts}.${raw}`), ±5 min)
//   { action: "customers" }                         → every customer with tier, 12-month spend, orders, referral info
//   { action: "order-status", order_id, status }    → placed | shipped | delivered | returned | cancelled | refunded
//   { action: "import-spend", email, spend_ron }    → spend from before accounts existed (counts toward the tier)
//   { action: "credit", email, amount_ron, note, kind } → store credit / refund credit
//   { action: "tier-override", email, tier }        → hold a customer at a minimum tier ("" clears)
async function accountAdmin(request) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const secret = env("GOATIFY_SITE_SECRET");
  if (!secret) return json(503, { error: "NOT_CONFIGURED" });
  const raw = await request.text();
  if (raw.length > 200000) return json(413, { error: "Too large" });
  const ts = request.headers.get("x-goatify-timestamp") || "", sig = String(request.headers.get("x-goatify-signature") || "").toLowerCase();
  if (!/^\d{9,12}$/.test(ts) || Math.abs(Date.now() / 1e3 - Number(ts)) > 300) return json(401, { error: "STALE" });
  const want = await gHmacHex(secret, `${ts}.${raw}`);
  let diff = want.length ^ sig.length; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (sig.charCodeAt(i) || 0);
  if (diff) return json(401, { error: "BAD_SIGNATURE" });
  let b; try { b = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }); }
  const db = await acctInit();
  const email = normEmail(b.email);
  if (b.action === "customers") {
    const cs = (await db.prepare("SELECT email, name, phone, created_at, ref_code, referred_by, spend_import, tier_override FROM acct_customers ORDER BY created_at DESC LIMIT 5000").all()).results || [];
    const out = [];
    for (const c of cs) {
      const sp = await acctSpend(db, c.email), tf = acctTierFor(sp.spend, sp.override);
      const last = await db.prepare("SELECT MAX(created_at) AS t, COUNT(*) AS n FROM acct_orders WHERE email = ?1").bind(c.email).first();
      out.push({ email: c.email, name: c.name, phone: c.phone, since: c.created_at, tier: tf.tier.id, tierName: tf.tier.name, discountPct: tf.tier.pct, spend12mRon: sp.spend, ordersTotal: (last && last.n) || 0, lastOrderAt: last && last.t, toNextTier: tf.toNext, nextTier: tf.next && tf.next.name, referredBy: c.referred_by, refCode: c.ref_code, tierOverride: c.tier_override });
    }
    return json(200, { customers: out, tiers: ACCT_TIERS });
  }
  if (b.action === "order-status") {
    const st = String(b.status || "");
    if (!["placed", "shipped", "delivered", "return_requested", "returned", "cancelled", "refunded"].includes(st)) return json(400, { error: "Bad status" });
    await db.prepare("UPDATE acct_orders SET status = ?2 WHERE order_id = ?1").bind(String(b.order_id || ""), st).run();
    return json(200, { ok: true });
  }
  if (!validEmail(email)) return json(400, { error: "Bad email" });
  const ensure = async () => { const c = await db.prepare("SELECT 1 FROM acct_customers WHERE email = ?1").bind(email).first(); if (!c) await db.prepare("INSERT INTO acct_customers (email, name, created_at, ref_code, prefs) VALUES (?1,?2,?3,?4,?5)").bind(email, String(b.name || "").slice(0, 80), acctNow(), acctRand(7), JSON.stringify({ news: true, drops: true })).run(); };
  if (b.action === "import-spend-bulk") {
    let n = 0;
    for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 500)) {
      const em = normEmail(it.email); if (!validEmail(em)) continue;
      const c = await db.prepare("SELECT 1 FROM acct_customers WHERE email = ?1").bind(em).first();
      if (!c) await db.prepare("INSERT INTO acct_customers (email, name, created_at, ref_code, prefs, spend_import) VALUES (?1,?2,?3,?4,?5,?6)").bind(em, String(it.name || "").slice(0, 80), acctNow(), acctRand(7), JSON.stringify({ news: true, drops: true }), Math.max(0, Number(it.spend_ron) || 0)).run();
      else await db.prepare("UPDATE acct_customers SET spend_import = ?2, name = CASE WHEN name IS NULL OR name = '' THEN ?3 ELSE name END WHERE email = ?1").bind(em, Math.max(0, Number(it.spend_ron) || 0), String(it.name || "").slice(0, 80)).run();
      n++;
    }
    return json(200, { ok: true, imported: n });
  }
  if (b.action === "import-spend") { await ensure(); await db.prepare("UPDATE acct_customers SET spend_import = ?2 WHERE email = ?1").bind(email, Math.max(0, Number(b.spend_ron) || 0)).run(); return json(200, { ok: true }); }
  if (b.action === "credit") { await ensure(); await db.prepare("INSERT INTO acct_credits (email, kind, amount_ron, note, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(email, b.kind === "refund" ? "refund" : "credit", Math.max(0, Number(b.amount_ron) || 0), String(b.note || "").slice(0, 200), acctNow(), b.expires_at || null).run(); return json(200, { ok: true }); }
  if (b.action === "tier-override") { await ensure(); const t = ACCT_TIERS.find((x) => x.id === b.tier); await db.prepare("UPDATE acct_customers SET tier_override = ?2 WHERE email = ?1").bind(email, t ? t.id : null).run(); return json(200, { ok: true }); }
  return json(400, { error: "Unknown action" });
}
__name(accountAdmin, "accountAdmin");

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
  "goatify-mail": goatifyMail,
  "cron-charge-installments": cronChargeInstallments,
  "geo": geoApi,
  "account": accountApi,
  "account-admin": accountAdmin
};
async function onRequest(context) {
  const { request, env: env2 } = context;
  const url = new URL(request.url);
  CURRENT_ORIGIN = url.origin;
  // /fr/…, /de/…, /hu/… → same files, translated
  const lm = I18N_RE.exec(url.pathname);
  if (lm && !lm[2]) return Response.redirect(`${url.origin}/${lm[1]}/${url.search}`, 301);
  const path = lm ? lm[2] : url.pathname;
  const m = /^\/(?:\.netlify\/functions|api)\/([a-z0-9-]+)\/?$/.exec(path);
  if (!m) {
    setEnv(env2);
    const rm = /^\/r\/([A-Za-z0-9]{4,12})\/?$/.exec(path);
    if (rm) return accountRefRedirect(url, rm[1]);
    if (path === "/robots.txt") return seoRobots();
    if (path === "/sitemap.xml") return seoSitemap();
    const sml = /^\/sitemap-([a-z]{2})\.xml$/.exec(path);
    if (sml && (sml[1] === "en" || I18N_LANGS.includes(sml[1]))) return seoSitemapLang(sml[1], request);
    const fm = /^\/merchant\/([a-z]{2})\.xml$/.exec(path);
    if (fm && GEO_COUNTRIES[fm[1].toUpperCase()]) return merchantFeed(fm[1].toUpperCase());
    const qcc = String(url.searchParams.get("cc") || "").toUpperCase();
    let L = { lang: "en", prefixed: false, path, cc: GEO_COUNTRIES[qcc] ? qcc : null };
    if (lm) { L.lang = lm[1]; L.prefixed = true; L.cc = L.cc || I18N_PRICE_CC[lm[1]]; }
    else L.lang = i18nCookie(request) || i18nAcceptLang(request) || "en";
    const route = request.method === "GET" || request.method === "HEAD" ? contentRoute(path) : null;
    if (route) { try { const r = await contentRender(request, url, L, route); if (r) return r; } catch (e) { stylistLog && stylistLog("content-render-failed", { path, error: String(e && e.message || e).slice(0, 300) }); } }
    const areq = lm ? new Request(new URL(path + url.search, url.origin).toString(), request) : request;
    let res = await env2.ASSETS.fetch(areq);
    if (lm && res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const loc = new URL(res.headers.get("location"), url.origin);
      if (loc.origin === url.origin && !I18N_RE.test(loc.pathname)) {
        const h = new Headers(res.headers); h.set("location", `/${lm[1]}${loc.pathname}${loc.search}${loc.hash}`);
        return new Response(res.body, { status: res.status, headers: h });
      }
    }
    try { return await geoInjectHtml(request, res, L); } catch { return res; }
  }
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

// Audit harness: exercises the REAL _worker.js code paths locally (no deploy, no network to
// OpenAI) by importing its default export and driving it with real Request objects and a
// mocked `env` (fake OPENAI_API_KEY just to pass the presence check in guard(); ASSETS.fetch
// reads catalog.json straight off disk). Any code path that needs a genuine OpenAI response
// (chat replies, image generation) is out of scope here and reported as such.
// Run from anywhere: node tests/audit_harness.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // tests/.. = site root
const worker = (await import(pathToFileURL(path.join(SITE, '_worker.js')).href)).default;

const catalogJson = fs.readFileSync(path.join(SITE, 'catalog.json'));

function makeEnv(overrides = {}) {
  return {
    OPENAI_API_KEY: 'sk-fake-for-offline-audit-only',
    ASSETS: {
      fetch: async (req) => {
        const url = new URL(typeof req === 'string' ? req : req.url);
        if (url.pathname.endsWith('/catalog.json')) {
          return new Response(catalogJson, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      },
    },
    ...overrides,
  };
}

let fails = 0;
const ok = (name, cond, info = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name, cond ? '' : info); if (!cond) fails++; };

async function call(path_, body, { origin = 'https://bymarccc.com', env = makeEnv(), headers = {} } = {}) {
  const req = new Request(`https://bymarccc.com/.netlify/functions/${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin, ...headers },
    body: JSON.stringify(body),
  });
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const res = await worker.fetch(req, env, ctx);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// ---- 1. Non-Latin-script language gate (deterministic, no OpenAI call needed) ----
{
  const r = await call('assistant-chat', { messages: [{ role: 'user', content: 'مرحبا، هل لديك بنطلونات جينز؟' }] });
  ok('Arabic input: 200 OK', r.status === 200, JSON.stringify(r));
  ok('Arabic input: exact refusal string, no OpenAI call made', r.json?.text === 'I can help only in Romanian or English with BYMARCCC products, styling, sizes and orders.', JSON.stringify(r.json));
  ok('Arabic input: no products', !(r.json?.products || []).length);
}
{
  const r = await call('assistant-chat', { messages: [{ role: 'user', content: '你好，有牛仔裤吗？' }] });
  ok('Chinese input: exact refusal string', r.json?.text === 'I can help only in Romanian or English with BYMARCCC products, styling, sizes and orders.');
}

// ---- 2. Empty-message validation ----
{
  const r = await call('assistant-chat', { messages: [{ role: 'user', content: '   ' }] });
  ok('Empty/whitespace message: 400', r.status === 400, JSON.stringify(r));
}
{
  const r = await call('assistant-chat', { messages: [] });
  ok('No messages: 400', r.status === 400);
}

// ---- 3. ASSISTANT_ALLOWED_ORIGINS is actually enforced ----
{
  const env = makeEnv({ ASSISTANT_ALLOWED_ORIGINS: 'https://bymarccc.com' });
  const good = await call('assistant-chat', { messages: [{ role: 'user', content: 'Salut' }] }, { env, origin: 'https://bymarccc.com' });
  ok('Allowed origin passes the origin check (not a 403)', good.status !== 403, JSON.stringify(good));
  const bad = await call('assistant-chat', { messages: [{ role: 'user', content: 'Salut' }] }, { env, origin: 'https://evil.example.com' });
  ok('Disallowed origin is rejected with 403', bad.status === 403, JSON.stringify(bad));
  // Fail-closed default: with ASSISTANT_ALLOWED_ORIGINS unset/missing in the environment (the state
  // production is in until it's explicitly configured in Cloudflare Pages), the Worker falls back
  // to its own known origins (bymarccc.com, bymarccc-test.pages.dev) rather than allowing every
  // origin. This replaced an earlier `if (!allowed.length) return true` that allowed everything.
  const unsetKnownOrigin = await call('assistant-chat', { messages: [{ role: 'user', content: 'Salut' }] }, { origin: 'https://bymarccc.com' });
  ok('ASSISTANT_ALLOWED_ORIGINS unset: the site\'s own origin (bymarccc.com) still passes (not a 403)', unsetKnownOrigin.status !== 403, JSON.stringify(unsetKnownOrigin));
  const unsetUnknownOrigin = await call('assistant-chat', { messages: [{ role: 'user', content: 'Salut' }] }, { origin: 'https://anything.example.com' });
  ok('ASSISTANT_ALLOWED_ORIGINS unset: an unrelated origin is now rejected with 403 (fail-closed default, not fail-open)', unsetUnknownOrigin.status === 403, JSON.stringify(unsetUnknownOrigin));
}

// ---- 4. assistant-upload-photo (no OpenAI call at all) ----
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
{
  const r = await call('assistant-upload-photo', { photo: TINY_JPEG });
  ok('Valid photo upload: 200 with a user_image_file_id', r.status === 200 && typeof r.json?.user_image_file_id === 'string' && r.json.user_image_file_id.length > 10, JSON.stringify(r));
}
{
  const r = await call('assistant-upload-photo', { photo: 'data:text/plain;base64,aGVsbG8=' });
  ok('Non-image upload: 400 rejected', r.status === 400, JSON.stringify(r));
}
{
  const r = await call('assistant-upload-photo', {});
  ok('Missing photo field: 400 rejected', r.status === 400, JSON.stringify(r));
}

// ---- 5. assistant-tryon validation layer (all before any OpenAI call) ----
// Each case uses its own fake IP so the (correctly working) per-IP rate limiter doesn't make
// later assertions in this section fail as a side effect of earlier ones.
let ipN = 0;
const nextIp = () => ({ headers: { 'cf-connecting-ip': `10.0.0.${++ipN}` } });
{
  const r = await call('assistant-tryon', { consent: false, photo: TINY_JPEG, productIds: ['skinny'] }, nextIp());
  ok('Try-on without consent: 400 CONSENT_REQUIRED', r.status === 400 && r.json?.error === 'CONSENT_REQUIRED', JSON.stringify(r));
}
{
  const r = await call('assistant-tryon', { consent: true, photo: TINY_JPEG, productIds: [] }, nextIp());
  ok('Try-on with no product selected: 400', r.status === 400, JSON.stringify(r));
}
{
  const r = await call('assistant-tryon', { consent: true, productIds: ['skinny'] }, nextIp());
  ok('Try-on with neither photo nor userImageFileId: 400 "Photo required."', r.status === 400 && /photo required/i.test(r.json?.error || ''), JSON.stringify(r));
}
{
  const r = await call('assistant-tryon', { consent: true, userImageFileId: 'not-a-real-id-00000000', productIds: ['skinny'] }, nextIp());
  ok('Try-on with an unknown/expired userImageFileId: 410 PHOTO_EXPIRED', r.status === 410 && r.json?.error === 'PHOTO_EXPIRED', JSON.stringify(r));
}
{
  // Full round-trip: upload -> get a real id -> use it -> product lookup succeeds (fails later
  // only because there's no real OpenAI key to call the moderation/image-edit endpoints).
  const ip = nextIp();
  const up = await call('assistant-upload-photo', { photo: TINY_JPEG }, ip);
  const id = up.json?.user_image_file_id;
  const r = await call('assistant-tryon', { consent: true, userImageFileId: id, productIds: ['skinny'] }, ip);
  ok('Try-on with a real userImageFileId: passes validation (reaches the OpenAI call, which then fails offline as expected)', r.status === 502 || r.status === 200, JSON.stringify(r));
  const reuse = await call('assistant-tryon', { consent: true, userImageFileId: id, productIds: ['skinny'] }, ip);
  ok('Reusing the same userImageFileId a second time: 410 (single-use, deleted after first use)', reuse.status === 410, JSON.stringify(reuse));
}
{
  const r = await call('assistant-tryon', { consent: true, photo: TINY_JPEG, productIds: ['this-product-does-not-exist'] }, nextIp());
  ok('Try-on with a nonexistent product id: 404', r.status === 404, JSON.stringify(r));
}
{
  // The tryon-specific rate limit is real and tighter than the general one.
  const ip = nextIp();
  let last;
  for (let i = 0; i < 7; i++) last = await call('assistant-tryon', { consent: true, photo: TINY_JPEG, productIds: ['skinny'] }, ip);
  ok('7th try-on request from the same IP within a minute is throttled (429)', last.status === 429, JSON.stringify(last));
}

// ---- 6. catalog.json sanity: the 8 manually-added sale items resolve through the same
//         loadCatalog() path get_product/search_products actually use ----
{
  const items = JSON.parse(catalogJson.toString()).items;
  const wanted = ['sale-pink-striped-jeans', 'sale-art-dept-jeans', 'sale-camo-cross-jeans', 'sale-cross-sweatpants', 'sale-glitter-flame-jeans', 'sale-beige-elegant-pants', 'sale-printed-jeans', 'sale-star-jeans'];
  for (const id of wanted) {
    const it = items.find((i) => i.id === id);
    ok(`catalog.json has ${id}`, !!it);
    if (it) {
      ok(`${id}: url points at index.html#shop (matches the sale-rail pattern, no dedicated product page)`, it.url === 'index.html#shop', it.url);
      ok(`${id}: has exactly one image path`, Array.isArray(it.images) && it.images.length === 1, JSON.stringify(it.images));
      ok(`${id}: price 200 / compareAtPrice 500 RON`, it.price === 200 && it.compareAtPrice === 500 && it.currency === 'RON');
    }
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nAll passed');
process.exit(fails ? 1 : 0);

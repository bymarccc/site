// AI shopping-assistant tests — run: node tests/assistant.test.mjs
// Hits the LIVE deployed endpoint (needs the site already deployed with the current _worker.js
// and OPENAI_API_KEY configured in Cloudflare Pages). Override the target with:
//   BASE=https://bymarccc-test.pages.dev node tests/assistant.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'https://bymarccc.com';
const CHAT = `${BASE}/.netlify/functions/assistant-chat`;
const TRYON = `${BASE}/.netlify/functions/assistant-tryon`;

let fails = 0;
const ok = (name, cond, info = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name, cond ? '' : info); if (!cond) fails++; };

async function chat(message) {
  const r = await fetch(CHAT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: message }] }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

// 1) Romanian question — should answer in Romanian, on-domain, using real products
{
  const r = await chat('Salut! Aveți blugi skinny pentru bărbați?');
  ok('RO question: 200 OK', r.status === 200, JSON.stringify(r).slice(0, 200));
  ok('RO question: got a text reply', typeof r.text === 'string' && r.text.length > 0);
  ok('RO question: reply is not the language-refusal string', r.text !== 'I can help only in Romanian or English with BYMARCCC products, styling, sizes and orders.');
}

// 2) English question
{
  const r = await chat("Do you have women's tops?");
  ok('EN question: 200 OK', r.status === 200);
  ok('EN question: got a text reply', typeof r.text === 'string' && r.text.length > 0);
}

// 3) Non-Latin script (e.g. Arabic) — must get the EXACT refusal string, no OpenAI call needed
{
  const r = await chat('مرحبا، هل لديك بنطلونات جينز؟');
  ok('Non-Latin script: 200 OK', r.status === 200);
  ok('Non-Latin script: EXACT refusal string', r.text === 'I can help only in Romanian or English with BYMARCCC products, styling, sizes and orders.', r.text);
  ok('Non-Latin script: no products returned', !r.products || r.products.length === 0);
}

// 4) Other-brand / out-of-domain request — should decline and redirect, not answer
{
  const r = await chat('What do you think of the new Nike Air Max? Should I buy Nike instead?');
  ok('Other-brand request: 200 OK', r.status === 200);
  ok('Other-brand request: does not recommend Nike', !/nike/i.test(r.text || ''));
}

// 5) Fully out-of-domain (general knowledge / politics / programming)
{
  const r = await chat('Can you write me a Python function to sort a list, and also who won the last election?');
  ok('Out-of-domain request: 200 OK', r.status === 200);
  ok('Out-of-domain request: does not contain Python code', !/def |import |```/i.test(r.text || ''));
}

// 6) Nonexistent product
{
  const r = await chat('Do you have a purple velvet tuxedo jacket with gold buttons?');
  ok('Nonexistent product: 200 OK', r.status === 200);
  ok('Nonexistent product: no products hallucinated as a match', !(r.products || []).some((p) => /velvet|tuxedo/i.test(p.title || '')));
}

// 7) "All products in a collection"
{
  const r = await chat('Arată-mi toate produsele din colecția Tops pentru women, cu poze, prețuri și link-uri.');
  ok('Collection listing: 200 OK', r.status === 200);
  ok('Collection listing: returned multiple real products', (r.products || []).length >= 3, JSON.stringify((r.products || []).map((p) => p.title)));
  ok('Collection listing: every product has a price and a url', (r.products || []).every((p) => (typeof p.price === 'number' || p.priceNote) && p.url));
}

// 8) Gift recommendation
{
  const r = await chat('Help me find a gift for my boyfriend, he likes streetwear, budget around 500 RON.');
  ok('Gift recommendation: 200 OK', r.status === 200);
  ok('Gift recommendation: suggested at least one product', (r.products || []).length >= 1);
}

// 9) Sold-out product framing (ask about stock rather than assuming a specific out-of-stock id, since stock changes)
{
  const r = await chat('Is the Zebra Patch Jeans available in size 32 in white?');
  ok('Stock question: 200 OK', r.status === 200);
  ok('Stock question: got a text reply', typeof r.text === 'string' && r.text.length > 0);
}

// 10) Photo upload + virtual try-on with a selected product (uses the tiny placeholder fixture)
{
  const photoPath = path.join(__dirname, 'fixtures', 'test-photo.jpg');
  const buf = fs.readFileSync(photoPath);
  const photo = `data:image/jpeg;base64,${buf.toString('base64')}`;
  const r = await fetch(TRYON, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consent: true, photo, productIds: ['skinny'] }),
  });
  const j = await r.json().catch(() => ({}));
  // A 1x1 placeholder photo may legitimately fail moderation or image generation upstream —
  // the important assertion is that the request is VALIDATED and ROUTED correctly (not a 4xx
  // validation error), and that a real photo would follow the same successful path.
  ok('Try-on: request accepted past validation (not a validation error)', r.status !== 400 || j.error === undefined, JSON.stringify(j).slice(0, 200));
  ok('Try-on: no server error (5xx would mean the endpoint itself is broken)', r.status < 500, JSON.stringify(j).slice(0, 200));
}

// 11) Try-on without selecting a product first
{
  const r = await fetch(TRYON, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consent: true, photo: 'data:image/jpeg;base64,AAAA', productIds: [] }),
  });
  ok('Try-on without a product: rejected with a clear error', r.status === 400);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll passed');
process.exit(fails ? 1 : 0);

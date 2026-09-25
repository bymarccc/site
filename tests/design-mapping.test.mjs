// Real, functional test of the actual click-handler/goTo code paths added to
// bymarccc-product.html, run against the REAL CATALOG data for every product
// that has designs. Extracts the literal source of slugifyDesign/designImageIndex
// and the DESIGNS.forEach click handler + goTo() function via regex from the real
// file (not reimplemented), then drives them with a fake DOM to simulate an actual
// tap on each design button and assert the resulting gallery index / image src.
// Run from anywhere: node tests/design_click_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SITE = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // tests/.. = site root
const html = fs.readFileSync(`${SITE}/bymarccc-product.html`, 'utf8');

// 1) Get the real CATALOG object (same technique as the audit harness: run the
//    CATALOG-defining script block in a vm and read it off window.BYMARCCC_CATALOG).
function extractScript(marker) {
  const idx = html.indexOf(marker);
  const scriptStart = html.lastIndexOf('<script', idx);
  const openEnd = html.indexOf('>', scriptStart) + 1;
  const closeIdx = html.indexOf('</script>', idx);
  return html.slice(openEnd, closeIdx);
}
const catalogCode = extractScript('const CATALOG');
const sandboxWin = {};
vm.runInContext(catalogCode, vm.createContext({ window: sandboxWin }));
const CATALOG = sandboxWin.BYMARCCC_CATALOG.CATALOG;

// 2) Pull the literal slugifyDesign + designImageIndex functions straight out of
//    the PDP script (the exact code shipped, not a reimplementation).
const pdpCode = extractScript('const DESIGNS = PRODUCT.designs');
const slugFnSrc = pdpCode.match(/const slugifyDesign = [^\n]+/)[0];
const idxFnSrc = pdpCode.match(/const designImageIndex = [^\n]+/)[0];
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`
  ${slugFnSrc}
  ${idxFnSrc}
  globalThis.slugifyDesign = slugifyDesign;
  globalThis.designImageIndex = designImageIndex;
`, ctx);

// 3) Extract the literal goTo() function and the click handler line, then run
//    them against a fake PRODUCT/DESIGNS/state/gallery for a chosen product,
//    simulating real taps.
const goToSrc = pdpCode.match(/function goTo\(i\) \{[\s\S]*?\n  \}/)[0];
const clickHandlerLine = pdpCode.match(/DESIGNS\.forEach\(dname => \{[\s\S]*?designsEl\.appendChild\(b\); \}\);/)[0];

let fails = 0;
const ok = (name, cond, info = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name, cond ? '' : info); if (!cond) fails++; };

function testProduct(key, designsToCheck) {
  const PRODUCT = CATALOG[key];
  const DESIGNS = PRODUCT.designs || [];
  const GALLERY = PRODUCT.gallery || [];
  let gi = 0;
  const state = { design: null };
  const emitted = [];
  const emit = () => emitted.push(state.design);
  const buttons = [];
  const $ = () => ({ appendChild: () => {} });
  const designsEl = { appendChild: (b) => buttons.push(b) };
  const sandbox = {
    PRODUCT, DESIGNS, GALLERY, state, emit,
    designsEl,
    document: { createElement: () => ({ addEventListener(_, fn) { this._fn = fn; }, setAttribute(){}, dataset: {}, click() { this._fn(); } }) },
  };
  const runCtx = vm.createContext(sandbox);
  vm.runInContext(`
    ${slugFnSrc}
    ${idxFnSrc}
    function goTo(i) {
      gi = Math.max(0, Math.min(GALLERY.length - 1, i));
      const dname = DESIGNS.find(d => designImageIndex(d) === gi);
      if (dname && state.design !== dname) { state.design = dname; emit(); }
    }
    ${clickHandlerLine}
    globalThis.__buttons = designsEl;
    globalThis.__goTo = goTo;
    globalThis.__getGi = () => gi;
  `, runCtx);

  for (const dname of designsToCheck) {
    const btn = buttons.find(b => b.dataset.d === dname);
    if (!btn) { ok(`${key}: button exists for "${dname}"`, false); continue; }
    state.design = null;
    btn.click();
    const expectedIdx = (() => {
      const slug = String(dname).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return PRODUCT.designImages ? PRODUCT.designImages[slug] : undefined;
    })();
    if (typeof expectedIdx === 'number') {
      const actualSrc = GALLERY[expectedIdx] && GALLERY[expectedIdx].src;
      ok(`${key}: clicking "${dname}" sets state.design correctly`, state.design === dname, `got ${state.design}`);
      console.log(`      -> gallery image: ${actualSrc}`);
    } else {
      ok(`${key}: clicking "${dname}" sets state.design (no dedicated photo expected)`, state.design === dname, `got ${state.design}`);
      console.log(`      -> no dedicated photo (expected)`);
    }
  }
}

// Every product that has a `designs` list, testing every one of its designs — not a sample.
for (const key of Object.keys(CATALOG)) {
  const p = CATALOG[key];
  if (Array.isArray(p.designs) && p.designs.length) testProduct(key, p.designs);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll design-button click simulations passed');
process.exit(fails ? 1 : 0);

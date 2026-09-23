// PiP drag tests — run: node tests/pip-drag.test.mjs  (needs `python3 -m http.server 8765` in the site folder)
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:8765/index.html', { waitUntil: 'load' }); await p.waitForTimeout(600);
let fails = 0; const ok = (name, cond, info = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name, cond ? '' : info); if (!cond) fails++; };
const snap = () => p.evaluate(() => ({ sx: window.scrollX, sy: window.scrollY, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, play: document.getElementById('play').getBoundingClientRect().toJSON(), vp: document.getElementById('vp').getBoundingClientRect().toJSON(), cls: document.getElementById('vp').className, tab: document.getElementById('vpTab').hidden, tabRect: document.getElementById('vpTab').getBoundingClientRect().toJSON() }));
const drag = async (x0, y0, dx, dy, steps = 16) => { await p.mouse.move(x0, y0); await p.mouse.down(); for (let i = 1; i <= steps; i++) { await p.mouse.move(x0 + dx * i / steps, y0 + dy * i / steps); await p.waitForTimeout(16); } };
const same = (a, c) => Math.abs(a.x - c.x) < 0.5 && Math.abs(a.y - c.y) < 0.5 && Math.abs(a.width - c.width) < 0.5;

// open the audio card
await p.evaluate(() => document.querySelector('.obj[data-track="cd"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))); await p.waitForTimeout(400);
const s0 = await snap(); ok('card open', s0.cls.includes('vp') && !(await p.evaluate(() => document.getElementById('vp').hidden)));

// 1) free drag: follows the pointer 1:1, page untouched
let g = s0.vp.x + 20, gy = s0.vp.y + 12;
await drag(g, gy, 60, -80); const mid = await snap();
ok('follows finger (dx)', Math.abs((mid.vp.x - s0.vp.x) - 60) < 2, `moved ${mid.vp.x - s0.vp.x}`);
ok('follows finger (dy)', Math.abs((mid.vp.y - s0.vp.y) - (-80)) < 2, `moved ${mid.vp.y - s0.vp.y}`);
ok('page did not scroll during drag', mid.sx === 0 && mid.sy === s0.sy, JSON.stringify([mid.sx, mid.sy]));
ok('background section did not move', same(mid.play, s0.play));
await p.mouse.up(); await p.waitForTimeout(100);

// 2) push past the right edge while holding: still only the player moves, no horizontal overflow
const s1 = await snap(); g = s1.vp.x + 20; gy = s1.vp.y + 12;
await drag(g, gy, 400, 0); const edge = await snap();
ok('no horizontal overflow while off the edge', edge.sw <= edge.cw, `scrollWidth ${edge.sw} > ${edge.cw}`);
ok('no scroll while off the edge', edge.sx === 0 && edge.sy === s1.sy);
ok('background fixed while off the edge', same(edge.play, s1.play));
await p.mouse.up(); await p.waitForTimeout(600);
const docked = await snap();
ok('docked right after release', docked.cls.includes('is-docked') && !docked.tab && docked.vp.x >= docked.cw - 1, JSON.stringify({ x: docked.vp.x, cls: docked.cls }));
ok('background fixed after dock', same(docked.play, s1.play));
ok('no overflow after dock', docked.sw <= docked.cw && docked.sx === 0);

// 3) drag back in from the tab: gradual, no jump
const t = docked.tabRect; await p.mouse.move(t.x + 10, t.y + 20); await p.mouse.down(); await p.waitForTimeout(30);
const start = await snap();
ok('no jump when grabbing the tab (player still at the edge)', start.vp.x >= start.cw - 2, `x ${start.vp.x} vs ${start.cw}`);
for (let i = 1; i <= 12; i++) { await p.mouse.move(t.x + 10 - 15 * i, t.y + 20); await p.waitForTimeout(16); }
const mid2 = await snap();
ok('follows finger back in', Math.abs((mid2.vp.x - start.vp.x) - (-180)) < 2, `moved ${mid2.vp.x - start.vp.x}`);
ok('background fixed while returning', same(mid2.play, docked.play) && mid2.sx === 0);
await p.mouse.up(); await p.waitForTimeout(600);
const back = await snap();
ok('settled fully inside after release', !back.cls.includes('is-docked') && back.vp.x >= 0 && back.vp.x + back.vp.width <= back.cw + 0.5, JSON.stringify({ x: back.vp.x, w: back.vp.width }));
ok('tab hidden when undocked', back.tab);

// 4) small nudge past the edge (>40% still visible) glides back instead of docking
const s3 = await snap(); await drag(s3.vp.x + 20, s3.vp.y + 12, (s3.cw - s3.vp.x) - s3.vp.width * 0.7, 0); await p.mouse.up(); await p.waitForTimeout(600);
const s4 = await snap(); ok('mostly-visible release returns inside (no dock)', !s4.cls.includes('is-docked') && s4.vp.x + s4.vp.width <= s4.cw + 0.5);
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close(); console.log(fails ? `\n${fails} failing` : '\nall passed'); process.exit(fails ? 1 : 0);

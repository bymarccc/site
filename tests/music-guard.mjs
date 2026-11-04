// Guard for the music engine: run `node tests/music-guard.mjs` from the repo root BEFORE every push.
// It fails (exit 1) if anything that makes the DJ mix / lock-screen artwork work has been removed or changed.
import fs from 'node:fs';
const read = f => fs.readFileSync(f, 'utf8');
const fails = [];
const need = (file, text, why) => { if (!read(file).includes(text)) fails.push(`${file}: missing  ${text}   (${why})`); };

// 1) homepage = the full engine (10 s DJ mix, Web Audio decks, lock-screen artwork)
for (const t of ['const MIX_S = 10, PREP_S = 25;', 'function mixEnsure()', 'function mixPrepare()', 'function mixGo()', 'function mixStop()', 'function mixSleep()',
  'window.__bymMix', 'window.__bymNowPlaying', 'lockscreen-alien-sky-v2-512.jpg', "set('nexttrack'", 'setValueCurveAtTime'])
  need('index.html', t, 'DJ mix / lock screen engine');

// 2) every page: songs picked from the bottom dock must go through the homepage engine
for (const f of ['index.html', 'bymarccc-product.html', 'checkout.html', 'members.html']) {
  need(f, 'window.BYMARCCC.audioTrack.play(t)', 'dock song pick must use the engine, otherwise no mix');
  need(f, '<audio id="miniAudio"', 'the ONE persistent audio element');
}

// 3) pages opened directly use the lite engine (same 10 s mix + auto-next + lock-screen artwork)
for (const f of ['bymarccc-product.html', 'checkout.html', 'members.html']) need(f, 'src="assets/mix-lite.js"', 'mix on directly opened pages');
for (const t of ['const MIX_S = 10, PREP_S = 25;', 'window.top !== window', 'function mixGo()', 'function mixPrepare()', 'lockscreen-alien-sky-v2-512.jpg', "addEventListener('ended'"])
  need('assets/mix-lite.js', t, 'lite engine');

// 4) the music engine must exist only ONCE per page (no duplicated copies)
const count = (s, re) => (s.match(re) || []).length;
if (count(read('index.html'), /function mixGo\(\)/g) !== 1) fails.push('index.html: function mixGo() must appear exactly once');


// 5) the playlist is duplicated in the 4 pages: every page must list exactly the same songs, and every local song file must exist
import { execFileSync } from 'node:child_process';
const pages = ['index.html', 'bymarccc-product.html', 'checkout.html', 'members.html'];
const songBlock = f => { const m = read(f).match(/(?:const|var) SEED = \[([\s\S]*?)\n\s*\];/); return m ? m[1] : ''; };
const idsOf = f => [...songBlock(f).matchAll(/\{\s*id:\s*'([^']+)'/g)].map(x => x[1]);
const base = idsOf('index.html');
if (!base.length) fails.push('index.html: could not read the song list (const SEED = [ ... ])');
for (const f of pages.slice(1)) {
  const ids = idsOf(f), miss = base.filter(x => !ids.includes(x)), extra = ids.filter(x => !base.includes(x));
  if (miss.length || extra.length) fails.push(`${f}: song list differs from index.html — missing: ${miss.join(', ') || '-'} | extra: ${extra.join(', ') || '-'} (a new song must be added to ALL 4 pages)`);
}
const srcMap = f => Object.fromEntries([...songBlock(f).matchAll(/id:\s*'([^']+)'[\s\S]*?src:\s*((?:M|CLD)\s*\+\s*'[^']+')/g)].map(x => [x[1], x[2].replace(/\s+/g, '')]));
const baseSrc = srcMap('index.html');
for (const f of pages.slice(1)) { const m = srcMap(f); for (const id of Object.keys(baseSrc)) if (m[id] && m[id] !== baseSrc[id]) fails.push(`${f}: song "${id}" has a different src than index.html (${m[id]} vs ${baseSrc[id]})`); }
if (new Set(base).size !== base.length) fails.push('index.html: duplicate song id in SEED');
const probe = file => { try { return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })); } catch { return NaN; } };
for (const m of songBlock('index.html').matchAll(/id:\s*'([^']+)'[\s\S]*?src:\s*(M|CLD)\s*\+\s*'([^']+)'/g)) {
  const [, id, kind, name] = m;
  if (kind === 'M') {
    const file = 'assets/media/' + name;
    if (!fs.existsSync(file)) { fails.push(`song "${id}": file ${file} does not exist`); continue; }
    if (!/\.a\.mp4$|\.mp3$/.test(name)) fails.push(`song "${id}": ${name} should be an audio-only .a.mp4 (or .mp3): .m4a does not support seeking on Cloudflare, so the mix cannot jump to the end of the song`);
    const d = probe(file);
    if (!Number.isNaN(d) && d <= 45) console.warn(`note: "${id}" is only ${Math.round(d)} s: songs of 45 s or less are never mixed (by design)`);
  } else if (!/^v\d+\/|^[^/]+\/v\d+\//.test(name)) fails.push(`song "${id}": Cloudinary path "${name}" looks wrong (expected v123456789/File_name.mp3)`);
}

if (fails.length) { console.error('MUSIC GUARD FAILED:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log(`music guard OK — DJ mix (10 s), dock → engine, lite engine, lock-screen artwork in place; ${base.length} songs identical on all 4 pages`);

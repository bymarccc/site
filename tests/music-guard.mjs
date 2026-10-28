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

if (fails.length) { console.error('MUSIC GUARD FAILED:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('music guard OK — DJ mix (10 s), dock → engine, lite engine and lock-screen artwork are all in place');

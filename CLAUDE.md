# bymarccc.com — rules for any AI assistant (Claude, Codex, ChatGPT)

Deploy: whatever lands on `main` is live on Cloudflare Pages within 1–2 minutes. Never `--force`. One change at a time, only what was asked.

## The music engine is PROTECTED — do not remove, rewrite or "clean up" any of it
It is the most fragile part of the site. It was rebuilt several times and every part below is needed:
- `index.html`: the DJ mix engine — last **10 seconds** (`MIX_S = 10`, `PREP_S = 25`) of a song fade out while the first 10 seconds of the next song fade in. Functions: `mixEnsure`, `mixPrepare`, `mixGo`, `mixStop`, `mixSleep`, Web Audio decks, `setValueCurveAtTime`, `window.__bymMix`, `window.__bymNowPlaying`.
- `index.html`: lock-screen "Now playing" block (mediaSession) with the Alien artwork `assets/img/lockscreen-alien-sky-v2-512.jpg` (+ `-v2.jpg`).
- `assets/mix-lite.js`: the same mix, auto-next and lock-screen artwork for product / checkout / members when they are opened directly (loaded at the end of those 3 pages).
- The bottom dock in all 4 pages (`index.html`, `bymarccc-product.html`, `checkout.html`, `members.html`): `playTrack()` must call `window.BYMARCCC.audioTrack.play(t)` first. Without it a song picked from search is not in the queue and never mixes.
- Playlist, player script and the page router `BYM_NAV` are duplicated in the 4 pages: keep the copies identical.
- Adding songs = only add objects to `const SEED = [ ... ]` in `index.html` (same format as the others). Never guess media URLs.

## Before EVERY push (mandatory)
1. `node tests/music-guard.mjs` → must print `music guard OK`. If it fails, you broke the music: restore what you removed.
2. `node --check` on every inline `<script>` you touched.
3. `git diff` must show only the requested change.
4. `git fetch origin && git rebase origin/main`, then `git push origin HEAD:main`.
If a request would require changing the music engine, stop and ask first.

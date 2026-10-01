/* bymarccc i18n runtime — translates the page into window.BYM_LANG (hu / it / bg) using window.BYM_I18N
   (assets/i18n-<lang>.js). The worker injects both into <head> for /hu/, /it/, /bg/ pages (and for
   visitors who picked a language). English pages only get the language switcher. Text nodes and the
   placeholder / aria-label / title / alt attributes are swapped by exact match; strings with numbers
   go through `patterns`. A MutationObserver catches everything the page renders later. */
(function () {
  var LANGS = [['en', 'English'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'], ['es', 'Español'], ['nl', 'Nederlands'], ['pt', 'Português'], ['pl', 'Polski'], ['ro', 'Română'], ['hu', 'Magyar'], ['cs', 'Čeština'], ['bg', 'Български'], ['el', 'Ελληνικά'], ['sv', 'Svenska']];
  var PREFIX = new RegExp('^/(' + LANGS.slice(1).map(function (l) { return l[0]; }).join('|') + ')(?=/|$)');
  var lang = String(window.BYM_LANG || 'en');
  var D = window.BYM_I18N && window.BYM_I18N.lang === lang ? window.BYM_I18N : null;
  var catalogOnly = !!window.BYM_I18N_CATALOG_ONLY;
  var T = { lang: lang };
  window.BYM_T = T;

  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  var map = Object.create(null), upper = Object.create(null), pats = [];
  if (D) {
    var src = D.map || {};
    for (var k in src) { map[norm(k)] = src[k]; var u = norm(k).toUpperCase(); if (!(u in src)) upper[u] = String(src[k]).toUpperCase(); }
    var P = D.patterns || {};
    for (var p in P) {
      var names = [];
      var re = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\w+)\\\}/g, function (m, n) { names.push(n); return '(.+?)'; });
      pats.push({ re: new RegExp('^' + re + '$'), names: names, out: P[p] });
    }
  }
  function tr(s) {
    if (!D || s == null) return null;
    var n = norm(s);
    if (!n) return null;
    if (n in map) return map[n];
    if (n in upper) return upper[n];
    if (catalogOnly) return null;
    if (/\n/.test(s)) {   // multi-line text (e.g. Delivery & Returns): translate line by line
      var changed = false, lines = String(s).split('\n').map(function (l) { var x = l.trim() ? tr(l) : null; if (x != null) { changed = true; return x; } return l; });
      if (changed) return lines.join('\n');
    }
    for (var i = 0; i < pats.length; i++) {
      var m = pats[i].re.exec(n);
      if (m) { var o = pats[i].out, nm = pats[i].names; for (var j = 0; j < nm.length; j++) o = o.split('{' + nm[j] + '}').join(m[j + 1]); return o; }
    }
    return null;
  }
  T.tr = tr;
  T.seo = function (k) { return (D && D.seo && D.seo[k]) || null; };
  T.titleCase = function (t) { return String(t || '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, function (m, a, b) { return a + b.toUpperCase(); }); };
  // "Name — Women's | bymarccc" in the page language (same format the worker sends)
  T.productTitle = function (title, gender) {
    var name = T.titleCase(tr(title) || title);
    var g = gender === 'women' ? (T.seo('womens') || "Women's") : gender === 'men' ? (T.seo('mens') || "Men's") : '';
    return name + (g ? ' — ' + g : '') + ' | bymarccc';
  };

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, INPUT: 1, CODE: 1 };
  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  function doText(node) {
    var p = node.parentNode;
    if (!p || SKIP[p.nodeName] || (p.closest && p.closest('[data-no-i18n]'))) return;
    var v = node.nodeValue, t = tr(v);
    if (t != null && t !== norm(v) && t !== v) { if (/\n/.test(t)) node.nodeValue = t; else { var lead = /^\s*/.exec(v)[0], tail = /\s*$/.exec(v)[0]; node.nodeValue = lead + t + tail; } }
  }
  function doEl(el) {
    if (catalogOnly) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], v = el.getAttribute && el.getAttribute(a);
      if (v) { var t = tr(v); if (t != null && t !== v) el.setAttribute(a, t); }
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) doEl(root);
    var w = document.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */, null), n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doEl(n); }
  }
  T.walk = walk;

  if (D) {
    try { document.documentElement.lang = lang; } catch (e) {}
    var mo = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.type === 'characterData') doText(r.target);
        else if (r.type === 'attributes') doEl(r.target);
        else for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]);
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: !catalogOnly, attributeFilter: catalogOnly ? undefined : ATTRS });
    var first = function () { walk(document.body); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', first); else first();
  }

  // ---- language switcher (homepage footer) ----
  function langUrl(to) {
    var path = location.pathname.replace(PREFIX, '') || '/';
    return (to === 'en' ? '' : '/' + to) + path + location.search;
  }
  T.go = function (to) {
    try { document.cookie = 'bym_lang=' + to + '; Path=/; Max-Age=31536000; SameSite=Lax'; } catch (e) {}
    location.href = langUrl(to);
  };
  function mountSwitcher() {
    var host = document.querySelector('.site-footer__bottom');
    if (!host || host.querySelector('.bym-lang')) return;
    var sel = document.createElement('select');
    sel.className = 'bym-lang'; sel.setAttribute('data-no-i18n', ''); sel.setAttribute('aria-label', 'Language');
    sel.setAttribute('style', 'font:inherit;font-size:12px;letter-spacing:.06em;color:inherit;background:transparent;border:1px solid currentColor;border-radius:999px;padding:6px 12px;opacity:.8;cursor:pointer');
    LANGS.forEach(function (L) { var o = document.createElement('option'); o.value = L[0]; o.textContent = L[1]; if (L[0] === lang) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () { T.go(sel.value); });
    host.appendChild(sel);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSwitcher); else mountSwitcher();
})();

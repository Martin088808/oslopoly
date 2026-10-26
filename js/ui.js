// Brukergrensesnittet og `io`-laget mellom motoren og 3D-scenen.
(function () {
  'use strict';
  const MP = window.MP;
  const { SQUARES: SQ, GROUPS, TOKENS, PLAYER_COLORS, RULES, STATION_RENT } = MP;
  const kr = MP.kr;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SAVE_KEY = 'monopol-oslo-v1';
  const SETTINGS_KEY = 'monopol-settings-v1';
  const SOUND_KEY = 'monopol-sound';
  const REPLAY_KEY = 'monopol-replay';
  // UI-pauser ved Normal tempo er 50 % lengre enn i første versjon, så man rekker å følge med.
  // Datamaskinens turer går mye raskere (mål: maks ca. 4–5 s per tur på Normal).
  const SLOW = 1.5;
  const AI_PACE = 0.35;
  const AI_BOOST = 1.5;
  // Datamaskinens brett-animasjoner (kjøp, leie) får et tak, så de ikke drar ut turen.
  const capAnim = (promise, ms) => (aiTurn() && promise && typeof promise.then === 'function'
    ? Promise.race([promise, new Promise((r) => setTimeout(r, ms / speed))]) : promise);
  const TEMPO = [[0.7, 'Rolig'], [1, 'Normal'], [1.7, 'Rask']];
  const normSpeed = (x) => {
    x = Number(x) || 1;
    let best = 1;
    for (const [v] of TEMPO) if (Math.abs(v - x) < Math.abs(best - x)) best = v;
    return best;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privat modus */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* */ } },
  };

  // ---------- Innstillinger ----------
  // Husreglene motoren forstår (Monopoly Plus sine seks; «Leie og auksjon» setter to nøkler).
  const RULE_KEYS = ['freeParking', 'goDouble', 'snakeEyes', 'auctionOnly', 'noJailRent', 'wealthWin', 'freeBuild'];
  const RULE_KEYS_ALL = [...RULE_KEYS, 'speedDie'];
  const GFX = [['high', 'Høy'], ['low', 'Lav'], ['off', 'Av']];
  const settings = { speed: 1, autoSkip: false, follow: true, gfx: 'high', rules: {} };
  try { Object.assign(settings, JSON.parse(store.get(SETTINGS_KEY) || '{}')); } catch (e) { /* ugyldig */ }
  settings.speed = normSpeed(settings.speed);
  if (!GFX.some(([v]) => v === settings.gfx)) settings.gfx = 'high';
  settings.rules = Object.fromEntries(RULE_KEYS_ALL.map((k) => [k, !!(settings.rules && settings.rules[k])]));
  const saveSettings = () => store.set(SETTINGS_KEY, JSON.stringify(settings));
  let speed = settings.speed;

  // Online: kallenavn og brikke huskes lokalt (bare på denne enheten).
  const PROFILE_KEY = 'oslopoly-profil';
  const profile = { name: '', token: 'car', color: PLAYER_COLORS[0] };
  try { Object.assign(profile, JSON.parse(store.get(PROFILE_KEY) || '{}')); } catch (e) { /* ugyldig */ }
  const saveProfile = () => store.set(PROFILE_KEY, JSON.stringify({ name: profile.name, token: profile.token, color: profile.color }));

  // ---------- Hopp over ----------
  let skipFlag = false;
  let pendingHuman = 0;
  // Online: spol (som Hopp over) når fanen er skjult eller klienten ligger langt etter verten.
  let netFast = false;
  const skipping = () => skipFlag || netFast || !!(MP.Board3D && MP.Board3D.skipping);
  // Datamaskinens tur (og ingen menneskelig beslutning venter): korte pauser.
  // (En spiller som nettopp gikk konkurs, får heller ingen lange pauser – f.eks. auksjonene over eiendommene.)
  const aiTurn = () => { const g = UI.game; return !!(g && g.current && (g.current.ai || g.current.bankrupt) && pendingHuman === 0); };
  const waiters = new Set();
  // Venter (justert for tempo). Returnerer straks mens det hoppes over, men gir alltid nettleseren et pusterom.
  function wait(ms) {
    return new Promise((resolve) => {
      if (skipping() || UI.over) { setTimeout(resolve, 0); return; }
      const w = { resolve, t: 0 };
      w.t = setTimeout(() => { waiters.delete(w); resolve(); }, (ms * (aiTurn() ? AI_PACE : SLOW)) / speed);
      waiters.add(w);
    });
  }
  function flushWaits() { for (const w of waiters) { clearTimeout(w.t); w.resolve(); } waiters.clear(); }
  function setSkip(on) {
    skipFlag = !!on;
    try { MP.Board3D && MP.Board3D.setSkip && MP.Board3D.setSkip(skipFlag || netFast); } catch (e) { console.warn(e); }
    if (skipFlag) {
      if (aiTurn()) digest.skipped = true;
      flushWaits();
      $('#toasts').innerHTML = '';
      $('#floats').innerHTML = '';
      hideBanner();
      clearSplash();
    }
    UI.updateSkip();
  }

  // ---------- «Mens du ventet»: høydepunkter fra datamaskinens turer ----------
  // Samles under datamaskinens turer og vises når et menneske får turen, men bare hvis noe ble hoppet over.
  const digest = { items: [], builds: {}, skipped: false };
  function note(html, prio = 50, force = false) {
    if (!force && !aiTurn()) return;
    if (skipping()) digest.skipped = true;
    digest.items.push({ html, prio, n: digest.items.length });
  }
  function resetDigest() { digest.items = []; digest.builds = {}; digest.skipped = false; }
  // Et menneske må ta en beslutning: stopp hopping og skjul Hopp over-knappen mens vi venter.
  function human(promise) {
    pendingHuman++;
    setSkip(false);
    return promise.finally(() => { pendingHuman = Math.max(0, pendingHuman - 1); UI.updateSkip(); });
  }

  // ---------- Ikoner i UI-kit-stil ----------
  // Felles gradienter for de fargerike 3D-ikonene ligger i én skjult (men rendret) SVG.
  const lg = (id, stops, x2 = 0, y2 = 1) => `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map((c, n) => `<stop offset="${n / (stops.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient>`;
  const DEFS = `<svg id="ui-defs" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false"><defs>
    ${lg('ig-gf', ['#7cf29a', '#1aa449'])}${lg('ig-gs', ['#14943f', '#0a6328'], 1, 1)}${lg('ig-gr', ['#b9ffc8', '#41c96a'], 1, 1)}
    ${lg('ig-rf', ['#ff8a7c', '#d81d22'])}${lg('ig-rs', ['#b5161c', '#7a0a0f'], 1, 1)}${lg('ig-rr', ['#ffc0b6', '#f2483f'], 1, 1)}
    ${lg('ig-au', ['#fff3a6', '#ffc928', '#d98c00'])}${lg('ig-sk', ['#f4cf98', '#c88440', '#8a4c1a'])}${lg('ig-nt', ['#c6f5b4', '#56c062', '#2f8e3e'])}
    ${lg('ig-np', ['#ffd0e4', '#f27fb0'])}${lg('ig-wd', ['#eaa767', '#b45f22', '#7a3a10'])}${lg('ig-co', ['#ffbd6e', '#f26a14'])}
    ${lg('ig-cb', ['#8fd0ff', '#2468d6'])}${lg('ig-st', ['#ffffff', '#b8c6d4'])}${lg('ig-di', ['#ffffff', '#dde5ee'])}
    ${lg('ig-ar', ['#ffd56a', '#ff8a00'])}${lg('ig-gy', ['#a9b8c8', '#556578'])}${lg('ig-bu', ['#fff7b0', '#ffd21f', '#f0a800'])}
    ${lg('ig-wa', ['#a9e4ff', '#2d8de6'])}
  </defs></svg>`;
  const svg = (inner, vb = '0 0 64 64', cls = '') => `<svg class="ico ${cls}" viewBox="${vb}" aria-hidden="true" focusable="false">${inner}</svg>`;
  // Et lite 3D-hus (front, side og tak) i farge c = g (grønn) eller r (rød).
  const house3d = (c, tf = '') => `<g transform="${tf}" stroke="rgba(0,0,0,.3)" stroke-width="1.3" stroke-linejoin="round">
    <path d="M35 30 L49 24 L49 42 L35 48Z" fill="url(#ig-${c}s)"/>
    <path d="M22 17 L36 11 L49 24 L35 30Z" fill="url(#ig-${c}r)"/>
    <path d="M10 30 L22 17 L35 30 L35 48 L10 48Z" fill="url(#ig-${c}f)"/>
    <path d="M14.5 30 L22 22.5" stroke="#fff" stroke-opacity=".7" stroke-width="2.6" stroke-linecap="round"/>
    <rect x="18.5" y="34" width="8" height="8" rx="1.6" fill="#fff" fill-opacity=".6" stroke="none"/>
    <path d="M38 33.5 L45.5 30.3 L45.5 37 L38 40.2Z" fill="#fff" fill-opacity=".35" stroke="none"/></g>`;
  const padlock = (open) => `<g stroke-linecap="round">
    <path d="${open ? 'M52 36 v-9 a7 7 0 0 0 -14 0 v-2' : 'M39 41 v-7 a7 7 0 0 1 14 0 v7'}" fill="none" stroke="#7a8796" stroke-width="6.5"/>
    <path d="${open ? 'M52 36 v-9 a7 7 0 0 0 -14 0 v-2' : 'M39 41 v-7 a7 7 0 0 1 14 0 v7'}" fill="none" stroke="url(#ig-st)" stroke-width="3.6"/>
    <rect x="34.5" y="39" width="23" height="19" rx="4.5" fill="url(#ig-au)" stroke="#9a5f00" stroke-width="1.6"/>
    <rect x="37" y="41" width="18" height="4" rx="2" fill="#fff" opacity=".55"/>
    <circle cx="46" cy="48" r="2.6" fill="#6b3d00"/><path d="M46 49v4.5" stroke="#6b3d00" stroke-width="2.4"/></g>`;
  const ICO = {
    props: svg(`${house3d('r', 'translate(13 -1) scale(.88)')}${house3d('g', 'translate(-4 12) scale(.92)')}`),
    build: svg(`${house3d('g', 'translate(-3 5)')}<circle cx="47" cy="46" r="12" fill="url(#ig-au)" stroke="#fff" stroke-width="3.2"/><path d="M47 39.5v13M40.5 46h13" stroke="#8a5200" stroke-width="6.5" stroke-linecap="round"/><path d="M47 39.5v13M40.5 46h13" stroke="#fff" stroke-width="3.8" stroke-linecap="round"/>`),
    lock: svg(`${house3d('r', 'translate(-4 4)')}${padlock(false)}`),
    unlock: svg(`${house3d('r', 'translate(-4 4)')}${padlock(true)}`),
    trade: svg(`<rect x="4" y="16" width="27" height="15" rx="2.5" fill="url(#ig-np)" stroke="#b03a6e" stroke-width="1.4" transform="rotate(-28 17 24)"/>
      <rect x="6" y="22" width="27" height="15" rx="2.5" fill="url(#ig-nt)" stroke="#2c7a37" stroke-width="1.4" transform="rotate(-12 19 30)"/>
      <circle cx="19" cy="30" r="3.4" fill="none" stroke="#2c7a37" stroke-width="1.3" transform="rotate(-12 19 30)"/>
      <path d="M27 25 C15 33 14 53 24 57 C32 60 46 60 52 56 C61 50 56 33 44 25 Z" fill="url(#ig-sk)" stroke="#6e3a12" stroke-width="1.6"/>
      <path d="M29 25 L24 12 C30 15.5 38 15.5 46 11 L42 25 Z" fill="url(#ig-sk)" stroke="#6e3a12" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M27 24 Q35.5 28.5 44 24" stroke="#d2362c" stroke-width="4.2" fill="none" stroke-linecap="round"/>
      <path d="M31 35 C27 40 27 46 29 50" stroke="#fff" stroke-opacity=".45" stroke-width="3" fill="none" stroke-linecap="round"/>
      <text x="40" y="49" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="15" fill="#6e3a12" fill-opacity=".8">kr</text>
      <circle cx="53" cy="53" r="7.5" fill="url(#ig-au)" stroke="#9a5f00" stroke-width="1.5"/><circle cx="53" cy="53" r="4" fill="none" stroke="#c98a00" stroke-width="1.2"/>`),
    gavel: svg(`<ellipse cx="22" cy="54" rx="15" ry="5.5" fill="#6b3412"/><ellipse cx="22" cy="51" rx="15" ry="5.5" fill="url(#ig-wd)" stroke="#5a2a0c" stroke-width="1.4"/>
      <g transform="rotate(-38 32 32) translate(2 -4)" stroke="#5a2a0c" stroke-width="1.4">
        <rect x="28.5" y="27" width="7" height="32" rx="3.5" fill="url(#ig-wd)"/>
        <rect x="14" y="10" width="36" height="18" rx="7" fill="url(#ig-wd)"/>
        <rect x="19" y="10" width="5" height="18" fill="url(#ig-au)"/><rect x="40" y="10" width="5" height="18" fill="url(#ig-au)"/>
        <rect x="17" y="12.5" width="30" height="4" rx="2" fill="#fff" opacity=".4" stroke="none"/></g>`),
    cards: svg(`<g transform="rotate(14 40 34)"><rect x="27" y="11" width="26" height="38" rx="5" fill="url(#ig-cb)" stroke="#fff" stroke-width="3.2"/><rect x="31" y="15" width="18" height="10" rx="2" fill="#fff" opacity=".35"/></g>
      <g transform="rotate(-10 26 34)"><rect x="11" y="14" width="29" height="41" rx="5" fill="url(#ig-co)" stroke="#fff" stroke-width="3.2"/>
      <text x="25.5" y="46" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="29" fill="#fff" stroke="#a83a00" stroke-width="1.4" paint-order="stroke">?</text></g>`),
    dice: svg(`<rect x="7" y="9" width="48" height="48" rx="12" fill="#b9c6d3"/><rect x="7" y="6" width="48" height="48" rx="12" fill="url(#ig-di)" stroke="#9aa9b8" stroke-width="2"/>
      <g fill="#e3242b"><circle cx="19" cy="18" r="4.6"/><circle cx="31" cy="30" r="4.6"/><circle cx="43" cy="42" r="4.6"/><circle cx="43" cy="18" r="4.6"/><circle cx="19" cy="42" r="4.6"/></g>
      <path d="M14 12 h20" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`),
    notes: svg(`<rect x="6" y="24" width="46" height="24" rx="4" fill="#2f8e3e" transform="rotate(-10 29 36)"/>
      <rect x="9" y="18" width="46" height="24" rx="4" fill="url(#ig-nt)" stroke="#256e31" stroke-width="1.6" transform="rotate(-10 32 30)"/>
      <circle cx="32" cy="30" r="6" fill="none" stroke="#256e31" stroke-width="2" transform="rotate(-10 32 30)"/>
      <rect x="12" y="34" width="46" height="22" rx="4" fill="url(#ig-nt)" stroke="#256e31" stroke-width="1.6"/>
      <circle cx="35" cy="45" r="6" fill="none" stroke="#256e31" stroke-width="2"/><path d="M17 38 h10" stroke="#fff" stroke-opacity=".6" stroke-width="2.4" stroke-linecap="round"/>`),
    sack: null,
    arrow: svg(`<path d="M10 44 C10 24 24 14 40 16 L40 7 L58 24 L40 41 L40 31 C30 30 22 35 10 44Z" fill="url(#ig-ar)" stroke="#a84f00" stroke-width="2" stroke-linejoin="round"/><path d="M16 36 C20 28 28 23 38 22" stroke="#fff" stroke-opacity=".6" stroke-width="3" fill="none" stroke-linecap="round"/>`),
    jail: svg(`<rect x="8" y="8" width="48" height="48" rx="8" fill="url(#ig-gy)" stroke="#2d3a4a" stroke-width="2"/><rect x="13" y="13" width="38" height="38" rx="4" fill="#2a3442"/>
      <g fill="url(#ig-st)" stroke="#5c6b7c" stroke-width="1"><rect x="16" y="11" width="5" height="42" rx="2.5"/><rect x="25" y="11" width="5" height="42" rx="2.5"/><rect x="34" y="11" width="5" height="42" rx="2.5"/><rect x="43" y="11" width="5" height="42" rx="2.5"/></g>`),
    key: svg(`<circle cx="21" cy="22" r="13" fill="url(#ig-au)" stroke="#9a5f00" stroke-width="2"/><circle cx="21" cy="22" r="5" fill="#fff" stroke="#9a5f00" stroke-width="2"/>
      <path d="M29 31 L52 54" stroke="#9a5f00" stroke-width="9" stroke-linecap="round"/><path d="M29 31 L52 54" stroke="url(#ig-au)" stroke-width="5.5" stroke-linecap="round"/>
      <path d="M44 46 l-6 6 M50 52 l-5 5" stroke="#9a5f00" stroke-width="5" stroke-linecap="round"/>`),
    star: svg(`<path d="M32 5 L40 23 L59 24.5 L44.5 37 L49 56 L32 46 L15 56 L19.5 37 L5 24.5 L24 23Z" fill="url(#ig-au)" stroke="#a86400" stroke-width="2.4" stroke-linejoin="round"/><path d="M22 27 L30 26" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-opacity=".8"/>`),
    train: svg(`<rect x="14" y="8" width="36" height="38" rx="9" fill="url(#ig-cb)" stroke="#123c7a" stroke-width="2"/><rect x="19" y="14" width="26" height="13" rx="3" fill="#dff3ff"/>
      <circle cx="23" cy="36" r="3.5" fill="#ffe680"/><circle cx="41" cy="36" r="3.5" fill="#ffe680"/><path d="M20 46 L13 56 M44 46 L51 56" stroke="#2d3a4a" stroke-width="4" stroke-linecap="round"/>`),
    bulb: svg(`<path d="M32 6 C19 6 12 16 13 26 C14 34 21 37 23 45 L41 45 C43 37 50 34 51 26 C52 16 45 6 32 6Z" fill="url(#ig-bu)" stroke="#a86a00" stroke-width="2"/>
      <rect x="23" y="45" width="18" height="10" rx="3" fill="url(#ig-st)" stroke="#6b7a8a" stroke-width="1.6"/><path d="M26 59 h12" stroke="#6b7a8a" stroke-width="3.5" stroke-linecap="round"/><path d="M22 18 C24 14 27 12 31 11" stroke="#fff" stroke-width="3.4" stroke-linecap="round" fill="none"/>`),
    tap: svg(`<path d="M8 22 h26 a10 10 0 0 1 10 10 v4 h-10 v-4 h-26z" fill="url(#ig-st)" stroke="#5c6b7c" stroke-width="2" stroke-linejoin="round"/><rect x="18" y="10" width="6" height="12" fill="#8a99a9"/><rect x="10" y="7" width="22" height="6" rx="3" fill="#e3242b"/>
      <path d="M39 42 C35 49 35 53 39 56 C43 53 43 49 39 42Z" fill="url(#ig-wa)" stroke="#1d5fa8" stroke-width="1.6"/>`),
    houseW: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" fill="#fff"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true" class="ico"><path d="M4.5 12.5l5 5 10-11" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  ICO.sack = ICO.trade;
  ICO.parking = svg(`<rect x="9" y="9" width="46" height="48" rx="12" fill="#123c7a" opacity=".35"/><rect x="9" y="6" width="46" height="48" rx="12" fill="url(#ig-cb)" stroke="#123c7a" stroke-width="2"/>
    <path d="M15 12 h22" stroke="#fff" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>
    <text x="32" y="44" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="36" fill="#fff" stroke="#123c7a" stroke-width="1.6" paint-order="stroke">P</text>`);
  ICO.snake = svg(`<g transform="rotate(-12 20 36)"><rect x="5" y="22" width="30" height="30" rx="8" fill="#b9c6d3"/><rect x="5" y="19" width="30" height="30" rx="8" fill="url(#ig-di)" stroke="#9aa9b8" stroke-width="2"/><circle cx="20" cy="34" r="5.2" fill="#e3242b"/></g>
    <g transform="rotate(12 44 30)"><rect x="29" y="16" width="30" height="30" rx="8" fill="#b9c6d3"/><rect x="29" y="13" width="30" height="30" rx="8" fill="url(#ig-di)" stroke="#9aa9b8" stroke-width="2"/><circle cx="44" cy="28" r="5.2" fill="#e3242b"/></g>`);
  ICO.go = svg(`<rect x="6" y="14" width="52" height="36" rx="9" fill="url(#ig-rf)" stroke="#7a0a0f" stroke-width="2"/>
    <text x="27" y="41" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="22" fill="#fff" stroke="#7a0a0f" stroke-width="1.3" paint-order="stroke">GO</text>
    <path d="M44 22 L54 32 L44 42Z" fill="url(#ig-au)" stroke="#9a5f00" stroke-width="1.6" stroke-linejoin="round"/>`);
  ICO.trophy = svg(`<path d="M18 10 H46 V24 C46 34 40 40 32 40 C24 40 18 34 18 24Z" fill="url(#ig-au)" stroke="#9a5f00" stroke-width="2"/>
    <path d="M18 15 H9 C9 25 14 29 20 30 M46 15 H55 C55 25 50 29 44 30" fill="none" stroke="#c98a00" stroke-width="3.5"/>
    <rect x="28" y="39" width="8" height="9" fill="url(#ig-au)" stroke="#9a5f00" stroke-width="1.5"/><rect x="18" y="47" width="28" height="9" rx="3" fill="url(#ig-wd)" stroke="#5a2a0c" stroke-width="1.5"/>
    <path d="M24 16 V25" stroke="#fff" stroke-opacity=".7" stroke-width="3" stroke-linecap="round"/>`);
  ICO.classic = svg(`<rect x="8" y="8" width="48" height="48" rx="6" fill="#d7f3e2" stroke="#1d2a3a" stroke-width="2.4"/>
    <rect x="18" y="18" width="28" height="28" rx="2" fill="#f3fff8" stroke="#1d2a3a" stroke-width="1.6"/>
    <g stroke="#1d2a3a" stroke-width="1.6"><rect x="8" y="8" width="10" height="10" fill="#E3242B"/><rect x="46" y="8" width="10" height="10" fill="#FFE21F"/><rect x="8" y="46" width="10" height="10" fill="#1D4FB8"/><rect x="46" y="46" width="10" height="10" fill="#1FAF55"/></g>`);
  ICO.crown = svg(`<path d="M8 22 L20 34 L32 12 L44 34 L56 22 L51 50 H13Z" fill="url(#ig-au)" stroke="#9a5f00" stroke-width="2.4" stroke-linejoin="round"/>
    <rect x="12" y="48" width="40" height="8" rx="3" fill="url(#ig-au)" stroke="#9a5f00" stroke-width="2"/>
    <circle cx="32" cy="12" r="4.5" fill="url(#ig-rf)" stroke="#7a0a0f" stroke-width="1.5"/><circle cx="8" cy="22" r="4" fill="url(#ig-cb)" stroke="#123c7a" stroke-width="1.5"/><circle cx="56" cy="22" r="4" fill="url(#ig-gf)" stroke="#0a6328" stroke-width="1.5"/>
    <path d="M17 42 H30" stroke="#fff" stroke-opacity=".75" stroke-width="3" stroke-linecap="round"/>`);
  ICO.person = svg(`<circle cx="32" cy="22" r="12" fill="url(#ig-bu)" stroke="#a86a00" stroke-width="2"/><path d="M12 56 C12 42 22 37 32 37 C42 37 52 42 52 56Z" fill="url(#ig-cb)" stroke="#123c7a" stroke-width="2"/>
    <circle cx="27.5" cy="21" r="1.8" fill="#5a3a00"/><circle cx="36.5" cy="21" r="1.8" fill="#5a3a00"/><path d="M27 27 Q32 31 37 27" stroke="#5a3a00" stroke-width="2" fill="none" stroke-linecap="round"/>`);
  ICO.robot = svg(`<path d="M32 6 V14" stroke="#556578" stroke-width="3"/><circle cx="32" cy="6" r="3.5" fill="url(#ig-rf)"/>
    <rect x="12" y="14" width="40" height="30" rx="9" fill="url(#ig-st)" stroke="#5c6b7c" stroke-width="2"/><rect x="17" y="20" width="30" height="15" rx="6" fill="#20324a"/>
    <circle cx="25" cy="27.5" r="3.6" fill="#5ff2c8"/><circle cx="39" cy="27.5" r="3.6" fill="#5ff2c8"/><rect x="18" y="46" width="28" height="12" rx="4" fill="url(#ig-gy)" stroke="#2d3a4a" stroke-width="1.6"/>`);
  ICO.speed = svg(`<rect x="9" y="8" width="46" height="46" rx="12" fill="#5a2a8a" opacity=".4"/><rect x="9" y="6" width="46" height="46" rx="12" fill="url(#ig-rf)" stroke="#7a0a0f" stroke-width="2"/>
    <path d="M36 12 L22 33 H31 L27 48 L43 25 H33Z" fill="url(#ig-bu)" stroke="#9a5f00" stroke-width="1.8" stroke-linejoin="round"/>`);
  ICO.bus = svg(`<rect x="8" y="12" width="48" height="34" rx="8" fill="url(#ig-bu)" stroke="#9a5f00" stroke-width="2"/><rect x="13" y="17" width="38" height="12" rx="3" fill="#dff3ff" stroke="#9a5f00" stroke-width="1.2"/>
    <path d="M25 17 V29 M38 17 V29" stroke="#9a5f00" stroke-width="1.4"/><circle cx="19" cy="47" r="5.5" fill="#2d3a4a"/><circle cx="45" cy="47" r="5.5" fill="#2d3a4a"/><rect x="12" y="34" width="8" height="5" rx="2" fill="#fff"/><rect x="44" y="34" width="8" height="5" rx="2" fill="#fff"/>`);
  ICO.broke = svg(`${house3d('r', 'translate(4 6)')}<path d="M27 22 L22 32 L30 36 L24 50" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M27 22 L22 32 L30 36 L24 50" stroke="#2d0508" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
  ICO.clock = svg(`<circle cx="32" cy="34" r="24" fill="url(#ig-st)" stroke="#5c6b7c" stroke-width="2.4"/><circle cx="32" cy="34" r="19" fill="#fff"/>
    <path d="M32 34 V20 M32 34 L42 40" stroke="#1d2a3a" stroke-width="3.6" stroke-linecap="round"/><circle cx="32" cy="34" r="3" fill="#e3242b"/><rect x="27" y="4" width="10" height="7" rx="2" fill="url(#ig-rf)"/>`);
  ICO.target = svg(`<circle cx="32" cy="32" r="25" fill="url(#ig-rf)" stroke="#7a0a0f" stroke-width="2"/><circle cx="32" cy="32" r="17" fill="#fff"/><circle cx="32" cy="32" r="10" fill="url(#ig-rf)"/><circle cx="32" cy="32" r="4" fill="#fff"/>`);
  ICO.warn = svg(`<path d="M32 6 L59 54 H5Z" fill="url(#ig-bu)" stroke="#9a5f00" stroke-width="2.6" stroke-linejoin="round"/><path d="M32 22 V38" stroke="#5a3a00" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="46" r="3.6" fill="#5a3a00"/>`);
  ICO.hotel = svg(`${house3d('r', 'translate(-6 -6) scale(1.25)')}<path d="M20 9 l2 -5 l2 5 l5 0 l-4 3 l2 5 l-5 -3 l-5 3 l2 -5 l-4 -3z" fill="url(#ig-au)" stroke="#9a5f00" stroke-width="1.2"/>`);
  ICO.thumbDown = svg(`<circle cx="32" cy="32" r="26" fill="url(#ig-rf)" stroke="#7a0a0f" stroke-width="2"/><path d="M20 20 L44 44 M44 20 L20 44" stroke="#fff" stroke-width="7" stroke-linecap="round"/>`);

  // ---------- Monopoly Plus-stil: flate ikoner, tastehint og tegnede illustrasjoner ----------
  const HOUSE_PATH = 'M3 20 L22 4 L41 20 V40 H3Z';
  // Hus med hengelås (pantsett) / åpen lås (innløs) og grønt «+»-hus (bygg), som knappene under skjøtet i Plus.
  const PI = {
    lockHouse: (open) => `<svg class="pi" viewBox="0 0 56 44" aria-hidden="true"><path d="${HOUSE_PATH}" fill="#fff" stroke="rgba(60,0,0,.35)" stroke-width="2" stroke-linejoin="round"/>
      <rect x="9" y="25" width="9" height="15" rx="1.5" fill="#d7dde4"/>
      <g transform="translate(30 17)"><path d="${open ? 'M18 11 V6 a6 6 0 0 0 -12 0' : 'M5 11 V6 a6 6 0 0 1 12 0 v5'}" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/>
      <rect x="1" y="10" width="20" height="16" rx="3" fill="#e3242b" stroke="#fff" stroke-width="2.4"/><circle cx="11" cy="17" r="2.4" fill="#fff"/><path d="M11 18v4" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g></svg>`,
    plusHouse: `<svg class="pi" viewBox="0 0 44 44" aria-hidden="true"><path d="${HOUSE_PATH}" fill="#45d04f" stroke="#0d6a20" stroke-width="2.4" stroke-linejoin="round"/><path d="M22 16v18M13 25h18" stroke="#fff" stroke-width="5.4" stroke-linecap="round"/></svg>`,
    house: (c) => `<svg class="pi" viewBox="0 0 44 44" aria-hidden="true"><path d="${HOUSE_PATH}" fill="${c}" stroke="rgba(0,0,0,.45)" stroke-width="2.4" stroke-linejoin="round"/><rect x="17" y="27" width="10" height="13" rx="1.5" fill="rgba(0,0,0,.25)"/></svg>`,
    houseW: '<svg class="pi" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" fill="#fff"/></svg>',
    space: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 9.5v5h15v-5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dpad: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 3h5.6v6.2H21v5.6h-6.2V21H9.2v-6.2H3V9.2h6.2z" fill="currentColor"/><path d="M12 5.2l1.6 2H10.4zM12 18.8l1.6-2h-3.2zM5.2 12l2-1.6v3.2zM18.8 12l-2-1.6v3.2z" fill="#2a3a46"/></svg>',
    map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 8.4h17M3.5 15.6h17M8.4 3.5v17M15.6 3.5v17"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/></svg>',
  };
  // Tegnet håndtrykk (godtatt handel) og to hender som ikke møtes (avslått).
  const SLEEVE = (flip) => `<g ${flip ? 'transform="translate(240 0) scale(-1 1)"' : ''}>
      <path d="M2 30 L50 4 L104 70 L64 104 Z" fill="url(#hs-suit)" stroke="#06090f" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M22 26 L48 12 L60 26" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="5" stroke-linecap="round"/>
      <path d="M60 100 L100 66 L114 80 L74 114 Z" fill="#fff" stroke="#9aa7b4" stroke-width="2.4" stroke-linejoin="round"/></g>`;
  const HANDSHAKE = `<svg class="hands" viewBox="0 0 240 170" aria-hidden="true"><defs>
      <linearGradient id="hs-suit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#48526a"/><stop offset="1" stop-color="#121722"/></linearGradient>
      <linearGradient id="hs-skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe7cf"/><stop offset="1" stop-color="#f3b98f"/></linearGradient>
      <linearGradient id="hs-skin2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbd8b6"/><stop offset="1" stop-color="#e4a173"/></linearGradient></defs>
    ${SLEEVE(false)}${SLEEVE(true)}<g transform="translate(122 106) scale(1.16) translate(-122 -106)">
    <path d="M168 84 C150 70 128 66 112 72 L88 88 C80 94 84 104 94 102 L110 96 C112 112 122 126 140 128 C156 130 170 120 176 104 Z" fill="url(#hs-skin2)" stroke="#9c5a33" stroke-width="3" stroke-linejoin="round"/>
    <path d="M72 82 C92 70 118 70 136 80 L170 100 C178 106 174 116 164 114 L150 110 C156 118 152 128 142 126 C146 134 138 142 128 138 C128 146 118 150 110 144 L86 130 C72 122 64 106 72 82 Z" fill="url(#hs-skin)" stroke="#9c5a33" stroke-width="3" stroke-linejoin="round"/>
    <path d="M150 110 L130 100 M142 126 L122 114 M128 138 L110 128" stroke="#b8714a" stroke-width="2.6" stroke-linecap="round" fill="none"/>
    <path d="M84 88 C96 80 112 78 124 82" stroke="#fff" stroke-opacity=".7" stroke-width="4" stroke-linecap="round" fill="none"/></g></svg>`;
  const HANDS_APART = `<svg class="hands" viewBox="0 0 240 170" aria-hidden="true"><defs>
      <linearGradient id="hs-suit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#48526a"/><stop offset="1" stop-color="#121722"/></linearGradient>
      <linearGradient id="hs-skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe7cf"/><stop offset="1" stop-color="#f3b98f"/></linearGradient></defs>
    <g transform="translate(-26 0)">${SLEEVE(false)}<path d="M66 84 C80 70 100 68 112 80 L120 96 C124 106 114 112 106 104 C108 116 98 122 90 114 C88 124 76 124 72 114 L64 104 Z" fill="url(#hs-skin)" stroke="#9c5a33" stroke-width="3" stroke-linejoin="round"/></g>
    <g transform="translate(26 0)">${SLEEVE(true)}<path d="M174 84 C160 70 140 68 128 80 L120 96 C116 106 126 112 134 104 C132 116 142 122 150 114 C152 124 164 124 168 114 L176 104 Z" fill="url(#hs-skin)" stroke="#9c5a33" stroke-width="3" stroke-linejoin="round"/></g>
    <g transform="translate(120 112)"><circle r="22" fill="#e3242b" stroke="#fff" stroke-width="5"/><path d="M-9 -9 L9 9 M9 -9 L-9 9" stroke="#fff" stroke-width="6" stroke-linecap="round"/></g></svg>`;
  // Stor 3D-aktig tekst (som «Exchange accepted!» i Plus): fyll, hvit kontur og mørk kant med skygge.
  const text3d = (t, tone = 'orange', cls = '') => `<span class="t3d t3-${tone} ${cls}" data-t="${esc(t)}">${esc(t)}</span>`;
  // Tastehint: liten rund tast (som kontrollerknappene i Plus) og tekst.
  const keyCap = (cap, tone = '') => `<span class="kc ${tone ? 'kc-' + tone : ''}" aria-hidden="true">${cap}</span>`;
  // Lyse farger (gul, lyseblå) får mørk tekst.
  const isLight = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return false; const n = parseInt(m[1], 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255; return 0.299 * r + 0.587 * g + 0.114 * b > 170; };

  // Husregelkortene i oppsettet. `keys` = motorens regler kortet slår av/på.
  const HOUSE_RULES = [
    { id: 'freeParking', keys: ['freeParking'], name: 'Gratis parkering-potten', ico: ICO.parking, text: 'Skatter, bøter og fengselsbot samles i en pott. Den som lander på Gratis parkering, får alt.' },
    { id: 'speedDie', keys: ['speedDie'], name: 'Fartsterning', ico: ICO.speed, text: 'En tredje terning som tas i bruk når du har passert Start én gang: buss, tre like og «Ekspress» (★) gjør spillet raskere.' },
    { id: 'goDouble', keys: ['goDouble'], name: 'Start og flytting', ico: ICO.go, text: `Lander du nøyaktig på Start, velger du ${kr(8000)} eller å flytte til et valgfritt felt. Sjanse-kort er valgfrie.` },
    { id: 'snakeEyes', keys: ['snakeEyes'], name: 'Slangeøyne', ico: ICO.snake, text: `To enere gir ${kr(20000)} fra banken.` },
    { id: 'rentAuction', keys: ['auctionOnly', 'noJailRent'], name: 'Leie og auksjon', ico: ICO.gavel, text: 'Ledige eiendommer selges bare på auksjon, og du får ikke leie mens du sitter i fengsel.' },
    { id: 'wealthWin', keys: ['wealthWin'], name: 'Rikdomsregelen', ico: ICO.trophy, text: `Første spiller med ${kr(60000)} i kontanter vinner.` },
    { id: 'freeBuild', keys: ['freeBuild'], name: 'Fri bygging', ico: ICO.build, text: 'Bygg hus og hotell uten hel fargegruppe og uten å bygge jevnt.' },
  ];
  const ruleOn = (rules, r) => !!rules && r.keys.every((k) => rules[k]);
  const activeRules = (rules) => HOUSE_RULES.filter((r) => ruleOn(rules, r));
  // Hvite ikoner til de runde blå knappene.
  const RI = {
    soundOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.5h3.5L12 5.2v13.6l-5-4.3H3.5z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.2 6.4a7.8 7.8 0 0 1 0 11.2"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.5h3.5L12 5.2v13.6l-5-4.3H3.5z" fill="currentColor"/><path d="M15.8 9.4l5 5M20.8 9.4l-5 5"/></svg>',
    ff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.6 6.3 11.4 12l-7.8 5.7zM12.4 6.3 20.2 12l-7.8 5.7z" fill="currentColor" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="4.4" stroke-linecap="round"/></svg>',
  };
  const DICE_SMALL = ICO.dice;

  // Byggeklosser: pille-tekst, bånd og tabber.
  const pill = (a, b = null, ico = '') => (b != null
    ? `<span class="pl2"><span class="pa">${a}</span><span class="pb">${ico}${b}</span></span>`
    : `${ico}<span class="pa">${a}</span>`);
  const band = (text, color = 'teal', extra = '') => `<div class="band-wrap"><div class="band c-${color} ${extra}">${extra.includes('stars') ? '<span class="bstars" aria-hidden="true">★<b>★</b>★</span>' : ''}<i class="bs"></i><span class="bt">${text}</span></div></div>`;
  const TITLE_COLORS = { gold: 'gold', red: 'red', blue: 'blue', purple: 'purple', green: 'green', pink: 'pink', orange: 'orange', slate: 'slate', teal: 'teal' };
  const title = (text, cls = 'teal', extra = '') => band(text, TITLE_COLORS[cls] || 'teal', extra);
  const jellyBtn = (icon, label, attrs = '') => `<button type="button" class="jbtn" ${attrs}><span class="jelly">${icon}</span><span class="jl">${label}</span></button>`;

  // ---------- Brikker ----------
  const TOKEN_SVG = {
    car: '<path d="M5 31 L7 23 L15 21.5 L20.5 13 L32 13 L36.5 21 L43 22.5 L43.5 31 Z"/><circle cx="14" cy="32" r="5.2" stroke="rgba(0,0,0,.3)" stroke-width="2"/><circle cx="35" cy="32" r="5.2" stroke="rgba(0,0,0,.3)" stroke-width="2"/><path d="M22 15.5 H31 L33.5 21 H19.5 Z" fill="rgba(0,0,0,.25)"/>',
    hat: '<rect x="14.5" y="8" width="19" height="24" rx="2.5"/><rect x="6" y="30" width="36" height="6" rx="3"/><rect x="14.5" y="24" width="19" height="4.5" fill="rgba(0,0,0,.3)"/>',
    ship: '<path d="M4 27 H44 L38.5 38 H10 Z"/><rect x="11" y="19" width="26" height="8" rx="1"/><rect x="15" y="9" width="5.5" height="10"/><rect x="25" y="9" width="5.5" height="10"/><rect x="15" y="9" width="5.5" height="3" fill="rgba(0,0,0,.3)"/><rect x="25" y="9" width="5.5" height="3" fill="rgba(0,0,0,.3)"/>',
    boot: '<path d="M13 5 H27 V25 L38 27.5 Q44 29 44 35 V39 H9 V31 Q13 29 13 24 Z"/><rect x="11" y="5" width="18" height="4" rx="2" fill="rgba(0,0,0,.25)"/>',
    dog: '<path d="M6 21 Q8 15 15 17 H30 L32 10 L35.5 9 L38 13 L43 14.5 L42 19 L36.5 20.5 L35.5 28 L37 39 H32.5 L31 30 H18.5 L17 39 H12.5 L12.5 27.5 Q7 25.5 6 21 Z"/><circle cx="37" cy="14" r="1.3" fill="rgba(0,0,0,.5)"/>',
    thimble: '<path d="M13.5 37 L16.5 14 Q24 5 31.5 14 L34.5 37 Z"/><rect x="11" y="34" width="26" height="6" rx="3"/><g fill="rgba(0,0,0,.28)"><circle cx="20" cy="20" r="1.6"/><circle cx="24" cy="20" r="1.6"/><circle cx="28" cy="20" r="1.6"/><circle cx="19" cy="25" r="1.6"/><circle cx="23" cy="25" r="1.6"/><circle cx="27" cy="25" r="1.6"/><circle cx="31" cy="25" r="1.6"/><circle cx="18.5" cy="30" r="1.6"/><circle cx="22.5" cy="30" r="1.6"/><circle cx="26.5" cy="30" r="1.6"/><circle cx="30.5" cy="30" r="1.6"/></g>',
  };
  const tokenSvg = (id) => `<svg viewBox="0 0 48 48" fill="#fff" aria-hidden="true">${TOKEN_SVG[id] || TOKEN_SVG.car}</svg>`;
  const tokenName = (id) => (TOKENS.find((t) => t.id === id) || { name: '' }).name;
  // Entall/flertall: «1 gang», «2 ganger».
  const nn = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // Portretter fra MP.Tokens (3D) hvis tilgjengelig, ellers SVG-ikon.
  const portraitCache = new Map();
  const portraitFails = new Map();
  function portraitURL(token, color) {
    const key = token + '|' + color;
    if (portraitCache.has(key)) return portraitCache.get(key);
    if ((portraitFails.get(key) || 0) >= 3) return null;
    let url = null;
    try { url = MP.Tokens && typeof MP.Tokens.portrait === 'function' ? MP.Tokens.portrait(token, color, 128) : null; } catch (e) { url = null; }
    if (url && typeof url.then === 'function') {
      portraitFails.set(key, 99);
      url.then((u) => { if (u) { portraitCache.set(key, u); refreshPortraits(); } }).catch(() => {});
      return null;
    }
    if (typeof url === 'string' && url) { portraitCache.set(key, url); return url; }
    if (MP.Tokens) portraitFails.set(key, (portraitFails.get(key) || 0) + 1);
    return null;
  }
  function portrait(token, color, cls = '') {
    const url = portraitURL(token, color);
    return `<span class="portrait ${cls}" style="--pc:${color}" data-portrait="${token}|${color}">${url ? `<img src="${url}" alt="" draggable="false">` : tokenSvg(token)}</span>`;
  }
  const pPortrait = (p, cls) => portrait(p.token, p.color, cls);
  function refreshPortraits() {
    for (const el of $$('[data-portrait]')) {
      const url = portraitCache.get(el.dataset.portrait);
      if (url && !el.querySelector('img')) el.innerHTML = `<img src="${url}" alt="" draggable="false">`;
    }
  }

  const sqColor = (i) => (SQ[i].group ? GROUPS[SQ[i].group].color : SQ[i].type === 'station' ? '#2f3640' : '#8f9cab');
  // Segmentknapper: valgt = mettet grønn gelé med hake, ikke valgt = nøytral.
  const SEG_CHECK = '<svg class="seg-ck" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const segVal = (v) => (/^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : String(v));
  const segHTML = (name, opts, val, cls = '') => `<div class="seg ${cls}" data-seg="${name}" role="group">${opts.map(([v, l]) => { const on = String(segVal(v)) === String(segVal(val)); return `<button type="button" data-v="${v}" class="${on ? 'on' : ''}" aria-pressed="${on}">${SEG_CHECK}<span>${l}</span></button>`; }).join('')}</div>`;
  const switchHTML = (name, on) => `<span class="switch"><input type="checkbox" data-sw="${name}" ${on ? 'checked' : ''}><i></i></span>`;
  function wireControls(el, onSeg, onSw) {
    $$('[data-seg]', el).forEach((seg) => $$('button', seg).forEach((b) => b.addEventListener('click', () => {
      $$('button', seg).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      MP.Sound.click();
      onSeg(seg.dataset.seg, segVal(b.dataset.v));
    })));
    $$('[data-sw]', el).forEach((inp) => inp.addEventListener('change', () => { MP.Sound.click(); onSw(inp.dataset.sw, inp.checked); }));
  }
  function applySetting(name, v) {
    const B = MP.Board3D;
    if (name === 'speed') {
      speed = normSpeed(v); settings.speed = speed;
      if (B) B.speed = speed;
      if (UI.game) UI.game.s.speed = speed;
    } else if (name === 'autoSkip') {
      settings.autoSkip = !!v;
      const g = UI.game;
      if (v && g && g.current && g.current.ai && pendingHuman === 0 && !UI.over) setSkip(true);
    } else if (name === 'follow') {
      settings.follow = !!v;
      if (B) B.followMode = settings.follow;
    } else if (name === 'sound') {
      MP.Sound.on = !!v;
      store.set(SOUND_KEY, v ? '1' : '0');
    } else if (name === 'gfx') {
      settings.gfx = GFX.some(([q]) => q === v) ? v : 'high';
      try { B?.setGfx?.(settings.gfx); } catch (e) { console.warn(e); }
      document.body.classList.toggle('fx-noblur', settings.gfx !== 'high');
      blurOn = null; syncBlur();
    }
    saveSettings();
    UI.syncTopButtons();
  }
  function settingsHTML() {
    return `<div class="set-list">
      <div class="set-row col"><div><b>Tempo</b><small>Rolig gir mer tid til å følge med på hva som skjer</small></div>${segHTML('speed', TEMPO, speed, 'full')}</div>
      <div class="set-row col"><div><b>Grafikk</b><small>Lav eller Av hvis spillet hakker</small></div>${segHTML('gfx', GFX, settings.gfx, 'full')}</div>
      <label class="set-row"><div><b>Hopp automatisk over datamaskinens turer</b><small>Du ser bare resultatet – alt står i loggen</small></div>${switchHTML('autoSkip', settings.autoSkip)}</label>
      <label class="set-row"><div><b>Følg brikken</b><small>Kameraet følger brikken som flytter</small></div>${switchHTML('follow', settings.follow)}</label>
      <label class="set-row"><div><b>Lyd</b><small>Lydeffekter i spillet</small></div>${switchHTML('sound', MP.Sound.on)}</label>
    </div>`;
  }

  // ---------- Modaler, varsler og svevende tekst ----------
  function focusPrimary(el) {
    requestAnimationFrame(() => {
      if (!el.isConnected || el.closest('.modal-wrap.clear')) return;
      const box = el.closest('.modal') || el;
      if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
      const b = el.querySelector('[data-primary]:not(:disabled)');
      if (b) b.focus({ preventScroll: true });
    });
  }
  // Modalen har en ramme (med rød lukkeknapp i hjørnet) og et rullbart innhold (`el`).
  // Lukkeknappen vises når innholdet har en [data-x]-knapp, og trykker på den.
  // Bare ett panel vises om gangen: et nytt panel lukker forbigående visninger (skjøtet) og
  // gjemmer andre til det selv lukkes. `side` legger panelet til høyre (uten uskarphet), så brettet synes.
  const wraps = () => $$('#modals > .modal-wrap');
  function restoreTop() {
    const ws = wraps();
    ws.forEach((w, n) => w.classList.toggle('stashed', n < ws.length - 1));
    syncBlur();
  }
  // 3D-bildet gjøres uskarpt bak dialogpaneler (ikke bak sidepanelet med skjøte/kjøp, der brettet skal synes).
  let blurOn = null;
  function syncBlur() {
    // Sidepanelet til høyre: spillerkortene skyves mot venstre (CSS), så panelet ikke dekker dem.
    document.body.classList.toggle('side-open', wraps().some((w) => !w.classList.contains('stashed') && !w.hidden && w.classList.contains('side')));
    // Hovedmenyen og oppsettet har også uskarp 3D-by bak (som Plus).
    const scr = ['#menu', '#setup', '#online'].some((s) => !!($(s) && !$(s).hidden));
    const on = scr || wraps().some((w) => !w.classList.contains('stashed') && !w.hidden && !w.classList.contains('side') && !w.classList.contains('clear'));
    if (on === blurOn) return;
    blurOn = on;
    try { MP.Board3D?.setBackdropBlur?.(on); } catch (e) { console.warn(e); }
  }
  function openModal(html, { clear = false, wide = false, onBackdrop = null, cls = '', noX = false, side = false, transient = false } = {}) {
    for (const w of wraps()) { if (w._transient) w._close(); else w.classList.add('stashed'); }
    const wrap = h(`<div class="modal-wrap ${clear ? 'clear' : ''} ${side ? 'side' : ''}"><div class="modal ${wide ? 'wide' : ''} ${cls}" role="dialog" aria-modal="${clear || side ? 'false' : 'true'}">
      <button type="button" class="rbtn red mclose" aria-label="Lukk" title="Lukk (Esc)" hidden>${RI.close}</button><div class="modal-body"></div><div class="modal-foot" hidden></div></div></div>`);
    if (onBackdrop) wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) onBackdrop(); });
    $('#modals').appendChild(wrap);
    $('#tooltip').hidden = true;
    const frame = wrap.firstElementChild;
    const el = $('.modal-body', frame);
    const foot = $('.modal-foot', frame);
    // Den faste knappelinja (.sticky-acts) flyttes ut av rullefeltet til en egen fot nederst i panelet,
    // så den aldri dekker innhold. Oppslag i `el` finner fortsatt knappene i foten.
    const qs = Element.prototype.querySelector, qsa = Element.prototype.querySelectorAll;
    el.querySelector = (s) => qs.call(el, s) || qs.call(foot, s);
    el.querySelectorAll = (s) => [...qsa.call(el, s), ...qsa.call(foot, s)];
    const fill = (html2) => {
      el.innerHTML = html2;
      foot.innerHTML = '';
      const st = qs.call(el, ':scope > .sticky-acts');
      if (st) foot.appendChild(st);
      foot.hidden = !st;
      frame.classList.toggle('has-foot', !!st);
    };
    fill(html);
    const xb = $('.mclose', frame);
    xb.addEventListener('click', () => { MP.Sound.click(); const x = el.querySelector('[data-x]'); if (x) x.click(); });
    const syncX = () => { xb.hidden = noX || !el.querySelector('[data-x]'); };
    syncX();
    focusPrimary(el);
    syncBlur();
    const close = () => { if (!wrap.isConnected) return; wrap.remove(); restoreTop(); };
    wrap._transient = transient;
    wrap._close = close;
    return { wrap, el, frame, foot, close, set(html2) { fill(html2); syncX(); focusPrimary(el); } };
  }
  // Forbigående visninger (skjøtet til høyre) teller ikke som åpent panel.
  const modalOpen = () => wraps().some((w) => !w._transient);
  // Panelhode i spillerens farge med brikke og navn (som dialogpanelene i Plus).
  const who = (p) => `<b class="who-n" style="--pc:${p.color}">${esc(p.name)}</b>`;
  const sqTag = (i) => `<span class="sq-tag" style="--c:${sqColor(i)}">${esc(SQ[i].name)}</span>`;
  function tradeSummary(g, t) {
    const side = (s) => [...(s.props || []).map((i) => esc(SQ[i].name)), s.cash ? kr(s.cash) : '', s.jailCards ? `${s.jailCards} fengselskort` : ''].filter(Boolean).join(', ') || 'ingenting';
    return `${side(t.give)} mot ${side(t.get)}`;
  }
  const whoHead = (p, sub = '') => `<div class="who-head" style="--pc:${p.color}">${pPortrait(p, 'sm')}<b>${esc(p.name)}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  // Maks ett kort varsel om gangen, øverst – aldri over brettets midte.
  function toast(text, color, life = 1.7, force = false) {
    if ((skipping() || UI.over) && !force) return;
    const dur = (life * SLOW) / speed;
    const box = $('#toasts');
    box.innerHTML = '';
    const t = h(`<div class="toast" role="status" style="--tc:${color || 'var(--teal)'};--life:${dur}s">${text}</div>`);
    box.appendChild(t);
    setTimeout(() => t.remove(), (dur + 0.5) * 1000);
  }

  // ---------- Store hendelsestekster (bånd midt på skjermen, 1–2 s, blokkerer ikke) ----------
  const splashQ = [];
  let splashTimer = 0, splashBusy = false;
  function splash(text, color = 'gold', opts = {}) {
    if (skipping() || UI.over) return;
    splashQ.push({ text, color, ai: aiTurn(), ...opts });
    while (splashQ.length > 2) splashQ.shift();
    if (!splashBusy) nextSplash();
  }
  function nextSplash() {
    const el = $('#splash');
    const s = splashQ.shift();
    if (!el) return;
    if (!s || skipping()) { clearSplash(); return; }
    splashBusy = true;
    // Mennesker: minst 1,5 s. Datamaskinen: kort.
    const d = s.ai
      ? Math.min(1.3, Math.max(0.8, ((s.life || 1.15) * 0.8) / speed))
      : Math.min(2.6, Math.max(1.5, ((s.life || 1.15) * SLOW) / speed));
    el.style.setProperty('--d', d + 's');
    el.style.setProperty('--pc', s.pc || '#ffc928');
    const sub = s.sub ? `<div class="sp-sub">${s.sub}</div>` : '';
    // Handel: stor oransje 3D-tekst med håndtrykk som spretter inn (som «Exchange accepted!» i Plus); avslått i rødt.
    if (s.kind === 'deal') {
      el.innerHTML = s.ok
        ? `<div class="sp-in deal ok"><span class="sp-burst" aria-hidden="true"></span>${text3d('Byttet', 'orange', 'l1')}<span class="deal-hands">${HANDSHAKE}</span>${text3d('godtatt!', 'orange', 'l2')}${sub}</div>`
        : `<div class="sp-in deal no"><span class="sp-burst" aria-hidden="true"></span><span class="deal-hands">${HANDS_APART}</span>${text3d('Avslått', 'red', 'l2')}${sub}</div>`;
    } else {
      el.innerHTML = `<div class="sp-in"><span class="sp-burst" aria-hidden="true"></span>${s.icon ? `<span class="sp-ico">${s.icon}</span>` : ''}${text3d(s.text, s.color || 'gold', 'sp-t')}${sub}</div>`;
    }
    el.className = '';
    void el.offsetWidth;
    el.className = 'show';
    clearTimeout(splashTimer);
    splashTimer = setTimeout(nextSplash, d * 1000 + 40);
  }
  function clearSplash() {
    splashQ.length = 0; splashBusy = false; clearTimeout(splashTimer);
    const el = $('#splash'); if (el) { el.className = ''; el.innerHTML = ''; }
  }
  function floatAt(x, y, text, cls) {
    if (skipping()) return;
    const f = h(`<div class="float ${cls}" style="left:${x}px;top:${y}px">${text}</div>`);
    $('#floats').appendChild(f);
    setTimeout(() => f.remove(), 2000);
  }
  let bannerTimer = 0;
  function playBanner(html, pc, life, cls) {
    const el = $('#banner');
    el.style.setProperty('--pc', pc);
    el.style.setProperty('--d', life + 's');
    el.innerHTML = html;
    el.className = '';
    void el.offsetWidth;
    el.className = 'show ' + cls;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, life * 1000 + 100);
  }
  // Turstart: «Din tur, NAVN!» midt på skjermen for mennesker (viktig når flere deler skjerm),
  // et lite og kort bånd øverst for datamaskinen.
  function showBanner(p) {
    if (skipping()) return;
    // Datamaskinen, eller (online) en spiller på en annen skjerm: et lite bånd øverst.
    if (p.ai || !UI.mine(p)) {
      playBanner(`<div class="bn-band">${pPortrait(p, 'md')}<div class="bn-text"><span class="bn-tag">NESTE TUR</span>${text3d(p.name, 'player', 'bn-t')}</div></div>`, p.color, Math.max(p.ai ? 0.7 : 1.4, (p.ai ? 1.0 : 1.6) / speed), 'ai');
      return;
    }
    // Fullt synlig i minst ca. 1,5 s (animasjonen bruker 16 % inn og 20 % ut), uansett tempo.
    const life = Math.max(2.4, (1.6 * SLOW) / speed);
    playBanner(`<div class="bn-big bn-you">${pPortrait(p, 'xl')}${text3d(`Din tur, ${p.name}!`, 'player', 'bn-t')}</div>`, p.color, life, 'big');
    turnJingle(p);
  }
  // En egen liten melodi per spiller, så man hører hvem som skal spille.
  function turnJingle(p) {
    const S = MP.Sound;
    if (!S || !S.on) return;
    if (typeof S.tone !== 'function') { S.turn?.(); return; }
    const base = [523, 587, 659, 698, 784, 880][(p.id || 0) % 6];
    [1, 1.26, 1.5, 2].forEach((m, k) => S.tone(base * m, 0.16, 'triangle', 0.09, k * 0.09));
  }
  function hideBanner() { const el = $('#banner'); if (el) { el.className = ''; el.innerHTML = ''; } clearTimeout(bannerTimer); }

  // ---------- Animerte pengebeløp ----------
  const cashAnim = {};
  let cashLoop = false;
  function tweenCash(id, target) {
    const a = cashAnim[id];
    if (!a) { cashAnim[id] = { cur: target, to: target }; return; }
    if (a.to === target) return;
    a.from = a.cur; a.to = target; a.t0 = performance.now();
    a.dur = skipping() ? 160 : Math.min(1500, 550 + Math.abs(target - a.from) / 18);
    if (!cashLoop) { cashLoop = true; requestAnimationFrame(stepCash); }
  }
  function stepCash(now) {
    let busy = false;
    for (const [id, a] of Object.entries(cashAnim)) {
      if (a.cur === a.to) continue;
      const k = Math.min(1, (now - a.t0) / a.dur);
      const e = 1 - Math.pow(1 - k, 3);
      a.cur = k >= 1 ? a.to : Math.round(a.from + (a.to - a.from) * e);
      const el = document.querySelector(`[data-cash="${id}"]`);
      if (el) el.textContent = kr(a.cur);
      if (a.cur !== a.to) busy = true;
    }
    if (busy) requestAnimationFrame(stepCash); else cashLoop = false;
  }

  // ---------- Skjøter ----------
  // Raden for gjeldende leienivå: 0 ubebygd, 1 hel fargegruppe, 2–5 = 1–4 hus, 6 hotell.
  // Stasjoner/verk: antall eide minus én. Pantsatt gir ingen markering.
  function deedLevel(game, i) {
    const sq = SQ[i], pr = game ? game.s.props[i] : null;
    if (!pr || pr.owner == null) return 0;
    if (pr.mortgaged) return -1;
    const o = game.player(pr.owner);
    if (sq.type === 'street') return pr.houses > 0 ? pr.houses + 1 : (game.ownsGroup(o, sq.group) ? 1 : 0);
    if (sq.type === 'station') return Math.max(0, game.countOwned(o, MP.STATIONS) - 1);
    if (sq.type === 'utility') return Math.max(0, game.countOwned(o, MP.UTILITIES) - 1);
    return -1;
  }
  const hn = (n) => `<i class="hn" aria-label="${n} hus">${n}</i>`;
  function deedHTML(game, i, compact) {
    const sq = SQ[i], pr = game ? game.s.props[i] : null;
    const owner = game && pr && pr.owner != null ? game.player(pr.owner) : null;
    const lvl = deedLevel(game, i);
    const gc = sq.group ? GROUPS[sq.group].color : sq.type === 'station' ? '#3a4a5e' : sq.icon === 'bulb' ? '#f5b400' : '#2d8de6';
    const icon = sq.type === 'station' ? ICO.train : sq.type === 'utility' ? (sq.icon === 'bulb' ? ICO.bulb : ICO.tap) : '';
    const head = `<div class="dhead ${icon ? 'has-ico' : ''} ${isLight(gc) ? 'lt' : ''}" style="--gc:${gc}">${icon ? `<span class="dh-ico">${icon}</span>` : ''}<small>SKJØTE</small><b>${esc(sq.name)}</b></div>`;
    const row = (n, label, val) => `<div class="dr ${n === lvl ? 'cur' : ''}">${n === lvl ? `<span class="dr-ico">${ICO.houseW}</span>` : ''}<span class="dl">${label}</span><b>${val}</b></div>`;
    const kv = (label, val, cls = '') => `<div class="dr kv ${cls}"><span class="dl">${label}</span><b>${val}</b></div>`;
    if (compact) {
      return `<div class="deed mini">${head}${kv('Kjøpspris', kr(sq.price))}${sq.type === 'street' ? kv('Leie', kr(sq.rent[0])) + kv('Med hotell', kr(sq.rent[5])) : ''}</div>`;
    }
    const ownerRow = owner ? `<div class="downer" style="--pc:${owner.color}">${pPortrait(owner, 'xs')}<span>Eies av ${esc(owner.name)}${pr.houses ? ` · ${pr.houses === 5 ? 'hotell' : pr.houses + ' hus'}` : ''}</span></div>` : '';
    const mort = pr && pr.mortgaged ? 'mort' : '';
    let rows = '';
    if (sq.type === 'street') {
      const g = GROUPS[sq.group], r = sq.rent;
      // Kompakt skjøte (lave skjermer): leie med 1–4 hus på én rad, og hus/hotell-pris på én linje.
      const h4 = `<div class="dr h4 ${lvl >= 2 && lvl <= 5 ? 'cur' : ''}">${lvl >= 2 && lvl <= 5 ? `<span class="dr-ico">${ICO.houseW}</span>` : ''}<span class="dl">${hn('1–4')}</span>
        <span class="h4v">${[1, 2, 3, 4].map((n) => `<b class="${lvl === n + 1 ? 'on' : ''}">${MP.kr(r[n]).replace('kr ', '')}</b>`).join('')}</span></div>`;
      rows = `${row(0, 'Leie', kr(r[0]))}${row(1, 'Med hel fargegruppe', kr(r[0] * 2))}
        ${[1, 2, 3, 4].map((n) => row(n + 1, `Leie med ${hn(n)}`, kr(r[n])).replace('class="dr ', 'class="dr hrow ')).join('')}${h4}
        ${row(6, 'Leie med <i class="hh" aria-label="hotell"></i>', kr(r[5]))}
        <div class="dsep"></div>${kv('Hus koster', `${kr(g.house)} hver`, 'hc2')}${kv('Hotell koster', `${kr(g.house)} + 4 hus`, 'hc2')}${kv('Hus / hotell', `${kr(g.house)} hver`, 'hc1')}${kv('Pantelån', kr(sq.price / 2))}
        ${owner ? '' : kv('Kjøpspris', kr(sq.price), 'price')}`;
    } else if (sq.type === 'station') {
      rows = `${[1, 2, 3, 4].map((n) => row(n - 1, n === 1 ? 'Leie' : `Eier ${n} stasjoner`, kr(STATION_RENT[n]))).join('')}
        <div class="dsep"></div>${kv('Pantelån', kr(sq.price / 2))}${owner ? '' : kv('Kjøpspris', kr(sq.price), 'price')}`;
    } else if (sq.type === 'utility') {
      rows = `${row(0, 'Eier ett verk', 'kr 80 per øye')}${row(1, 'Eier begge verk', 'kr 200 per øye')}
        <p class="dnote">Leien er antall øyne på terningene ganger kr 80 – eller kr 200 hvis eieren har begge verkene.</p>
        <div class="dsep"></div>${kv('Pantelån', kr(sq.price / 2))}${owner ? '' : kv('Kjøpspris', kr(sq.price), 'price')}`;
    }
    return `<div class="deed ${mort}">${head}<div class="drows">${rows}</div>${ownerRow}</div>`;
  }
  // De store handlingsknappene under skjøtet: pantsett/innløs (rød) og bygg (grønn), pluss Selg hus.
  // Fri bygging: hotell direkte (motoren: canBuildHotel/buildHotel). Gir { ok, cost } eller null.
  function hotelDirect(g, p, i) {
    const pr = g.s.props[i];
    if (!g.rules?.freeBuild || SQ[i].type !== 'street' || pr.houses >= 4 || typeof g.canBuildHotel !== 'function' || typeof g.buildHotel !== 'function') return null;
    let c = null;
    try { c = g.canBuildHotel(p, i); } catch (e) { c = null; }
    if (!c) return null;
    if (c === true) c = { ok: true };
    const cost = Number(c.cost) || GROUPS[SQ[i].group].house * (5 - pr.houses);
    return { ok: !!c.ok, cost, why: c.why || '' };
  }
  // I gjeldsdialogen kan man bare selge, pantsette og handle (som i Plus): Bygg og Innløs er av.
  const DEBT_WHY = 'Ikke mens du skylder penger';
  function deedActsHTML(g, p, i, debt = false) {
    const sq = SQ[i], pr = g.s.props[i];
    const why = [];
    let left;
    // Som i Plus: rød knapp «+kr X» med hus-med-lås til venstre, «+»-hus «−kr Y» til høyre (grå når det ikke går).
    if (pr.mortgaged) {
      const cu = debt ? { ok: false, why: DEBT_WHY } : g.canUnmortgage(p, i);
      left = `<div class="da-col"><span class="kc kc-sm">P</span><button type="button" class="dact red" data-d="unmort" data-key="KeyP" ${cu.ok ? '' : 'disabled'} title="${esc(cu.ok ? 'Innløs pantelånet (P)' : cu.why)}"><span class="dv">−${kr(g.unmortgageCost(i))}</span>${PI.lockHouse(true)}<small>INNLØS</small></button></div>`;
      if (!cu.ok && !debt) why.push(`Innløs: ${cu.why}`);
    } else {
      const cm = g.canMortgage(p, i);
      left = `<div class="da-col"><span class="kc kc-sm">P</span><button type="button" class="dact red" data-d="mort" data-key="KeyP" ${cm.ok ? '' : 'disabled'} title="${esc(cm.ok ? 'Pantsett eiendommen (P)' : cm.why)}"><span class="dv">+${kr(sq.price / 2)}</span>${PI.lockHouse(false)}<small>PANTSETT</small></button></div>`;
      if (!cm.ok) why.push(`Pantsett: ${cm.why}`);
    }
    let right = '', sell = '', hotel = '';
    if (sq.type === 'street') {
      const cb = debt ? { ok: false, why: DEBT_WHY } : g.canBuild(p, i), cs = g.canSellHouse(p, i);
      const what = pr.houses >= 5 ? 'HAR HOTELL' : pr.houses === 4 ? 'BYGG HOTELL' : 'BYGG HUS';
      right = `<div class="da-col"><span class="kc kc-sm">B</span><button type="button" class="dact build" data-d="build" data-key="KeyB" ${cb.ok ? '' : 'disabled'} title="${esc(cb.ok ? what.toLowerCase() + ' (B)' : cb.why)}">${PI.plusHouse}<span class="dv">−${kr(GROUPS[sq.group].house)}</span><small>${what}</small></button></div>`;
      if (!cb.ok && !debt) why.push(`Bygg: ${cb.why}`);
      sell = `<button type="button" class="btn small sky" data-d="sell" ${cs.ok ? '' : 'disabled'} title="${esc(cs.ok ? '' : cs.why)}">${pill(`Selg ${pr.houses === 5 ? 'hotell' : 'hus'}${cs.ok ? ' +' + kr(cs.value) : ''}`)}</button>`;
      if (!cs.ok && pr.houses > 0) why.push(`Selg: ${cs.why}`);
      const hd = debt ? null : hotelDirect(g, p, i);
      if (hd && hd.ok) hotel = `<button type="button" class="btn small red" data-d="hotel" title="Fri bygging: hotell uten å bygge fire hus først">${pill('Bygg hotell direkte', `−${kr(hd.cost)}`, ICO.hotel)}</button>`;
    }
    return `<div class="deed-acts ${right ? '' : 'one'}">${left}${right}</div>${sell || hotel ? `<div class="deed-sell">${hotel}${sell}</div>` : ''}
      ${debt ? `<p class="deed-debt">${ICO.warn}<span>Mens du skylder penger kan du bare selge, pantsette eller handle.</span></p>` : ''}
      ${why.length ? `<ul class="deed-why">${why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
  }
  // Handlingen kan være et løfte (online: verten utfører den og svarer); knappene er av imens.
  function act(el, fn, after) {
    const r = fn();
    if (r && typeof r.then === 'function') {
      $$('button', el).forEach((b) => { b.disabled = true; });
      r.then(after, after);
    } else after();
  }
  function wireDeedActs(el, g, p, i, redraw) {
    $$('[data-d]', el).forEach((b) => b.addEventListener('click', () => {
      MP.Sound.click();
      if (b.dataset.d === 'sell') { sellChecked(g, p, i, redraw, el); return; }
      act(el, ({ build: () => g.build(p, i), mort: () => g.mortgage(p, i), unmort: () => g.unmortgage(p, i), hotel: () => g.buildHotel?.(p, i) })[b.dataset.d], redraw);
    }));
  }
  // F7: selger man et hotell når banken mangler hus, kan byggene i gruppen rives ned. Spør først.
  function sellChecked(g, p, i, after, el = null) {
    let plan = null;
    try { plan = g.sellHousePlan?.(p, i) || null; } catch (e) { plan = null; }
    if (plan && plan.demolish) {
      const lv = Object.entries(plan.levels || {}).map(([j, n]) => `${esc(SQ[j].name)}: ${Number(n) === 5 ? 'hotell' : `${n} hus`}`).join(', ');
      UI.confirm('SELGE HOTELLET?', `Banken har for få hus, så byggene må rives ned${lv ? ` til ${lv}` : ''}. Du får ${kr(plan.value || 0)}.`, `SELG +${kr(plan.value || 0)}`, () => { Promise.resolve(g.sellHouse(p, i)).then(after, after); });
      return;
    }
    if (el) act(el, () => g.sellHouse(p, i), after);
    else Promise.resolve(g.sellHouse(p, i)).then(after, after);
  }
  // To handelstilbud er like (online kommer de som nye objekter, så === holder ikke).
  const sameTrade = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const s = (x) => [[...(x.props || [])].map(Number).sort((m, n) => m - n), Number(x.cash) || 0, Number(x.jailCards) || 0];
    return !!(a.give && b.give && a.get && b.get) && JSON.stringify([+a.from, +a.to, s(a.give), s(a.get)]) === JSON.stringify([+b.from, +b.to, s(b.give), s(b.get)]);
  };

  // Eiendomsrutenett: 28 ruter i brettrekkefølge, én kolonne per fargegruppe + stasjoner (2 kolonner) og verk.
  // Maks tre rader holder spillerkortene lave.
  const GRID = [...Object.keys(GROUPS).map((k) => MP.groupOf(k)), MP.STATIONS.slice(0, 2), MP.STATIONS.slice(2), MP.UTILITIES];
  // Mobil: antall eide per gruppe som små fargebrikker (rutenettet blir for smått).
  const SUMS = [...Object.keys(GROUPS).map((k) => ({ list: MP.groupOf(k), c: GROUPS[k].color })), { list: MP.STATIONS, c: '#2f3640' }, { list: MP.UTILITIES, c: '#8f9cab' }];
  function sumHTML(g, p) {
    const out = SUMS.map(({ list, c }) => {
      const n = list.filter((i) => g.s.props[i].owner === p.id).length;
      return n ? `<i class="gs ${n === list.length ? 'full' : ''}" style="--c:${c}">${n}</i>` : '';
    }).join('');
    return out || '<i class="gs none">–</i>';
  }
  function gridHTML(g, p) {
    return GRID.map((col) => `<span class="gcol">${col.map((i) => {
      const pr = g.s.props[i], own = pr.owner === p.id;
      const dots = own && pr.houses ? (pr.houses === 5 ? '<b class="h"></b>' : '<b></b>'.repeat(pr.houses)) : '';
      const tip = esc(SQ[i].name) + (own ? (pr.mortgaged ? ' (pantsatt)' : pr.houses === 5 ? ' (hotell)' : pr.houses ? ` (${pr.houses} hus)` : '') : '');
      return `<i class="gc ${own ? 'own' : ''} ${own && pr.mortgaged ? 'mort' : ''}" style="--c:${sqColor(i)}" title="${tip}">${dots}</i>`;
    }).join('')}</span>`).join('');
  }
  // Spillerkortet i Plus-stil (fargetopp med brikke og navn, mørk teal kropp med saldo og rutenett).
  // `live` = kortet i HUD-en (oppdateres av render); ellers en statisk kopi (handel, brettkart).
  const pcTop = (p) => `<div class="pc-top"><span class="pc-tok">${tokenSvg(p.token)}</span><span class="pc-name">${esc(p.name)}</span><span class="pc-tags"></span></div>`;
  function pcardStatic(g, p, active = false) {
    return `<div class="pcard static ${active ? 'active' : ''} ${p.bankrupt ? 'broke' : ''} ${p.inJail && !p.bankrupt ? 'jail' : ''}" style="--pc:${p.color}">${pcTop(p)}
      <div class="pc-body"><div class="pc-money"><div class="pc-cash">${kr(p.cash)}</div></div><div class="pc-grid">${gridHTML(g, p)}</div><div class="pc-sum">${sumHTML(g, p)}</div></div></div>`;
  }
  // Hodet på sidepanelet (skjøte, kjøp, brettkart): stripe i eierens/spillerens farge med ikon og navn.
  const dpHead = (pc, icon, name, sub = '') => `<div class="dp-head ${isLight(pc) ? 'lt' : ''}" style="--pc:${pc}"><span class="dp-ico">${icon}</span><b>${esc(name)}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const NEUTRAL = '#2f9c8a';
  // Skjøtekort i vifte (handel) + penger og fengselskort.
  function fanHTML(g, s) {
    const props = s.props || [];
    const n = props.length;
    const cards = n ? `<div class="fan" style="--n:${n}">${props.map((i, k) => `<div class="fan-c" style="--k:${(k - (n - 1) / 2).toFixed(2)};--z:${k}">${miniDeed(g, i)}</div>`).join('')}</div>` : '';
    const extra = `${s.cash ? `<div class="tx-cash">${ICO.notes}<b>${kr(s.cash)}</b></div>` : ''}${s.jailCards ? `<div class="tx-cash">${ICO.key}<b>${s.jailCards} fengselskort</b></div>` : ''}`;
    return cards + (extra ? `<div class="tx-extra">${extra}</div>` : '') + (!n && !s.cash && !s.jailCards ? '<div class="tx-none">Ingenting</div>' : '');
  }
  // Kolonne med fane (grønn «VIL HA» eller blå «TILBYR») som i handelsskjermen i Plus.
  const txCol = (kind, label, pl, body, sub = '') => `<section class="tx-col ${kind}" style="--pc:${pl.color}">
    <div class="tx-tab"><span class="tx-tok">${tokenSvg(pl.token)}</span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</div><div class="tx-body">${body}</div></section>`;
  const txParties = (g, a, b) => `<div class="tx-parties">${pcardStatic(g, a)}<span class="tx-swap">${PI.swap}</span>${pcardStatic(g, b)}</div>`;

  // ---------- Brettkart: flatt 2D-brett (11 × 11 ruter) ----------
  // Felt 0 nede til høyre, så mot venstre, opp venstre side, bortover toppen og ned høyre side.
  const mapRC = (i) => (i <= 10 ? [10, 10 - i] : i <= 20 ? [20 - i, 0] : i <= 30 ? [0, i - 20] : [i - 30, 10]);
  const mapSide = (i) => (i % 10 === 0 ? 'c' : i < 10 ? 'b' : i < 20 ? 'l' : i < 30 ? 't' : 'r');
  const MAP_RC = SQ.map((_, i) => mapRC(i));
  // Piltast: nærmeste felt i den retningen (over brettet hvis nødvendig).
  function mapStep(i, dr, dc) {
    let [r, c] = MAP_RC[i];
    for (let k = 0; k < 11; k++) {
      r += dr; c += dc;
      if (r < 0 || r > 10 || c < 0 || c > 10) break;
      const j = MAP_RC.findIndex(([a, b]) => a === r && b === c);
      if (j >= 0) return j;
    }
    return i;
  }
  const glyphTxt = (t, size = 30, fill = '#2f7f6b') => `<svg viewBox="0 0 48 48" aria-hidden="true"><text x="24" y="${24 + size * 0.36}" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="${size}" fill="${fill}">${t}</text></svg>`;
  function mapGlyph(i) {
    const sq = SQ[i];
    switch (sq.type) {
      case 'go': return '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M40 24H12M22 13 11 24l11 11" fill="none" stroke="#d0161d" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      case 'chance': return glyphTxt('?', 36, '#f08a00');
      case 'chest': return glyphTxt('★', 30, '#2b8ae8');
      case 'tax': return glyphTxt('kr', 22, '#5a6e86');
      case 'parking': return glyphTxt('P', 32, '#1f62bd');
      case 'jail': case 'gotojail': return ICO.jail;
      case 'station': return ICO.train;
      case 'utility': return sq.icon === 'bulb' ? ICO.bulb : ICO.tap;
      default: return '';
    }
  }
  const SPECIAL_TEXT = {
    go: () => `Motta ${kr(RULES.salary)} hver gang du passerer eller lander på Start.`,
    chance: () => 'Trekk et Sjanse-kort og gjør det som står på det.',
    chest: () => 'Trekk et Prøv lykken-kort og gjør det som står på det.',
    tax: (g, sq) => `Betal ${kr(sq.amount)} til banken${g.rules?.freeParking ? ' (pengene går i potten på Gratis parkering)' : ''}.`,
    jail: () => `På besøk skjer ingenting. Sitter du inne: betal ${kr(RULES.jailFine)}, bruk et kort eller kast dobbel.`,
    parking: (g) => (g.rules?.freeParking ? `Potten er nå ${kr(g.s.pot || 0)}. Lander du her, får du alt.` : 'Hvil deg – her skjer ingenting.'),
    gotojail: () => 'Gå direkte i fengsel uten å passere Start.',
  };

  // Liten terning med øyne (turrekkefølge).
  const PIPS = { 1: [[16, 16]], 2: [[9, 9], [23, 23]], 3: [[9, 9], [16, 16], [23, 23]], 4: [[9, 9], [23, 9], [9, 23], [23, 23]], 5: [[9, 9], [23, 9], [16, 16], [9, 23], [23, 23]], 6: [[9, 8], [23, 8], [9, 16], [23, 16], [9, 24], [23, 24]] };
  const dieFace = (n) => `<svg class="die" viewBox="0 0 32 32" aria-label="${n}"><rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="#fff" stroke="#9aa9b8" stroke-width="2"/>${(PIPS[n] || []).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.1" fill="${n === 1 ? '#e3242b' : '#1d2a3a'}"/>`).join('')}</svg>`;

  // ---------- Handel: byggeklosser ----------
  // Mini-skjøte: fargebånd, navn, pris, hake når valgt, PANTSATT-stempel.
  function miniDeed(g, i, { sel = false, dis = false, side = '' } = {}) {
    const sq = SQ[i], pr = g.s.props[i];
    const ico = sq.type === 'station' ? ICO.train : sq.type === 'utility' ? (sq.icon === 'bulb' ? ICO.bulb : ICO.tap) : '';
    const houses = pr.houses ? (pr.houses === 5 ? '<i class="hh"></i>' : '<i class="hn"></i>'.repeat(pr.houses)) : '';
    const tag = side ? `button type="button" data-side="${side}" data-i="${i}" aria-pressed="${sel}" ${dis ? 'aria-disabled="true" title="Selg byggene i gruppen først"' : ''}` : 'div';
    return `<${tag} class="tcard ${sel ? 'sel' : ''} ${dis ? 'dis' : ''} ${pr.mortgaged ? 'mort' : ''}" style="--c:${sqColor(i)}">
      <span class="tc-band">${ico ? `<span class="tc-ico">${ico}</span>` : ''}</span><span class="tc-name">${esc(sq.name)}</span>
      ${pr.mortgaged ? '<span class="tc-mort">PANTSATT</span>' : ''}
      <span class="tc-price">${kr(sq.price)}${houses ? `<span class="houses">${houses}</span>` : ''}</span>
      <span class="tc-check" aria-hidden="true">${ICO.check}</span></${side ? 'button' : 'div'}>`;
  }
  // −/+ for penger (steg kr 500 / 1 000) eller fengselskort (steg 1).
  function stepper(key, val, max, unit = 0) {
    const steps = unit ? [-1, 1] : [-1000, -500, 500, 1000];
    const lab = (v) => (v < 0 ? '−' : '+') + (unit ? Math.abs(v) : MP.kr(Math.abs(v)).replace('kr ', ''));
    const btn = (v) => `<button type="button" class="stp ${v < 0 ? 'minus' : 'plus'}" data-step="${v}" ${(v < 0 ? val <= 0 : val >= max) ? 'disabled' : ''} aria-label="${v < 0 ? 'Mindre' : 'Mer'} ${unit ? '' : kr(Math.abs(v))}">${lab(v)}</button>`;
    const half = steps.length / 2;
    return `<div class="stepper" data-stepper="${key}">${steps.slice(0, half).map(btn).join('')}<output>${unit ? val : kr(val)}</output>${steps.slice(half).map(btn).join('')}</div>`;
  }
  const tradeSideValue = (g, s) => (s.props || []).reduce((v, i) => v + (g.s.props[i].mortgaged ? SQ[i].price / 2 : SQ[i].price), 0) + (s.cash || 0) + (s.jailCards || 0) * 500;
  // «Total verdi» per side som en søyle i spillernes farger.
  function tradeValueBar(g, t, a, b, la, lb) {
    const va = tradeSideValue(g, t.give), vb = tradeSideValue(g, t.get);
    const fa = va + vb ? va : 1, fb = va + vb ? vb : 1;
    return `<div class="tvalue"><div class="tv-side" style="--pc:${a.color}"><small>${la}</small><b>${kr(va)}</b></div>
      <div class="tv-mid"><small>TOTAL VERDI</small><div class="tv-bar"><i style="--pc:${a.color};flex-grow:${fa}"></i><i style="--pc:${b.color};flex-grow:${fb}"></i></div></div>
      <div class="tv-side r" style="--pc:${b.color}"><small>${lb}</small><b>${kr(vb)}</b></div></div>`;
  }
  // Grupper som `pl` ville eid helt etter å ha fått `inc` og gitt bort `out`.
  function groupsCompleted(g, pl, inc, out) {
    const grs = [...new Set(inc.map((i) => SQ[i].group).filter(Boolean))];
    return grs.filter((gr) => !g.ownsGroup(pl, gr) && MP.groupOf(gr).every((j) => (g.s.props[j].owner === pl.id && !out.includes(j)) || inc.includes(j)));
  }
  // Advarsler sett fra den som gir t.give (a) til b: gir handelen b en hel fargegruppe? Pantsatt-rente?
  function tradeWarnings(g, t, a, b) {
    const out = [];
    for (const gr of groupsCompleted(g, b, t.give.props || [], t.get.props || [])) out.push(`<li class="bad">${ICO.warn}<span>Gir ${esc(b.name)} hele <span class="sq-tag" style="--c:${GROUPS[gr].color}">${esc(GROUPS[gr].name.toLowerCase())}</span> gruppe!</span></li>`);
    for (const gr of groupsCompleted(g, a, t.get.props || [], t.give.props || [])) out.push(`<li class="good">${ICO.star}<span>Du får hele <span class="sq-tag" style="--c:${GROUPS[gr].color}">${esc(GROUPS[gr].name.toLowerCase())}</span> gruppe!</span></li>`);
    const rate = RULES.mortgageInterest || 0.1;
    const um = new Set(t.get.unmortgage || []);
    const mort = (t.get.props || []).filter((i) => g.s.props[i].mortgaged);
    const rent = mort.filter((i) => !um.has(i)).reduce((s, i) => s + Math.round((SQ[i].price / 2) * rate), 0);
    const umCost = mort.filter((i) => um.has(i)).reduce((s, i) => s + g.unmortgageCost(i), 0);
    if (rent) out.push(`<li class="info">${ICO.lock}<span>Du betaler ${kr(rent)} i rente (10 %) for pantsatte eiendommer du får.</span></li>`);
    if (umCost) out.push(`<li class="info">${ICO.unlock}<span>Du innløser straks for ${kr(umCost)} (lån + 10 %).</span></li>`);
    return out.length ? `<ul class="tr-warn">${out.join('')}</ul>` : '';
  }
  // «Innløs straks» for pantsatte eiendommer man mottar (klassisk regel). Motoren leser side.unmortgage = [felt].
  const tradeUnmortgageOK = (g) => !!g && (g.supportsTradeUnmortgage === true || /unmortgage/.test(String(g.executeTrade)));
  function unmortHTML(g, props, chosen) {
    const mort = (props || []).filter((i) => g.s.props[i]?.mortgaged);
    if (!mort.length || !tradeUnmortgageOK(g)) return '';
    return `<div class="tr-um"><b>${ICO.unlock}Pantsatte eiendommer du får</b>${mort.map((i) => `<label class="um-row"><input type="checkbox" data-um="${i}" ${chosen.has(i) ? 'checked' : ''}>
      <span>${sqTag(i)} <em>Innløs straks</em></span><small>${chosen.has(i) ? `−${kr(g.unmortgageCost(i))}` : `rente ${kr(Math.round((SQ[i].price / 2) * (RULES.mortgageInterest || 0.1)))}`}</small></label>`).join('')}</div>`;
  }
  // Et ferdig tilbud (a gir t.give, b gir t.get) vist som to spillerpaneler med mini-skjøter.
  // Plus-oppsett: «VIL HA» (grønn fane, det a vil ha fra b) og «TILBYR» (blå fane, det a gir), kortene i vifte.
  function offerHTML(g, t, a, b) {
    return `<div class="tx-cols">${txCol('wants', 'VIL HA', a, fanHTML(g, t.get), `fra ${esc(b.name)}`)}${txCol('offers', 'TILBYR', a, fanHTML(g, t.give), `${esc(a.name)} gir`)}</div>
      ${tradeValueBar(g, t, a, b, `${esc(a.name)} gir`, `${esc(b.name)} gir`)}${txParties(g, a, b)}`;
  }
  const txTop = (p, text) => `<div class="tx-top" style="--pc:${p.color}"><span class="tx-tok">${tokenSvg(p.token)}</span><span>${text}</span></div>`;

  // ---------- Sjanse / Prøv lykken ----------
  function cardIcon(card) {
    switch (card.act) {
      case 'move': case 'nearestStation': case 'nearestUtility': case 'back': return ICO.arrow;
      case 'jail': return ICO.jail;
      case 'jailCard': return ICO.key;
      case 'repairs': return ICO.build;
      case 'payEach': return ICO.notes;
      case 'collectEach': return ICO.trade;
      case 'money': return card.amount > 0 ? ICO.trade : ICO.notes;
      default: return ICO.star;
    }
  }
  function cardHTML(p, type, card) {
    const c = type === 'chance';
    return `<div class="cardx ${type}"><div class="cx-flip">
      <div class="cx-face cx-back"><span>${c ? '?' : '★'}</span></div>
      <div class="cx-face cx-front"><span class="cx-mark" aria-hidden="true">${c ? '?' : '★'}</span>
        ${band(c ? 'SJANSE' : 'PRØV LYKKEN', c ? 'orange' : 'blue', 'band-lg')}
        <div class="cx-icon">${cardIcon(card)}</div>
        <div class="cx-text">${esc(card.text)}</div>
        <div class="cx-who">${pPortrait(p, 'xs')}<span>${esc(p.name)} trakk kortet</span></div>
      </div></div></div>`;
  }

  // ---------- Oppsett ----------
  const setupPlayers = [
    { name: 'Spiller 1', ai: false, token: 'car', color: PLAYER_COLORS[0], level: 'normal' },
    { name: 'Astrid', ai: true, token: 'hat', color: PLAYER_COLORS[1], level: 'normal' },
    { name: 'Bjørn', ai: true, token: 'ship', color: PLAYER_COLORS[2], level: 'normal' },
    { name: 'Sigrid', ai: true, token: 'dog', color: PLAYER_COLORS[3], level: 'normal' },
  ];
  const setupOpts = { money: 30000, auction: true, maxRounds: 0 };
  const AI_NAMES = ['Astrid', 'Bjørn', 'Sigrid', 'Olav', 'Ingrid', 'Henrik'];
  const LEVELS = [['easy', 'Lett'], ['normal', 'Normal'], ['hard', 'Vanskelig']];
  const ROUNDS = [[0, 'Uten slutt'], [30, '30 runder'], [60, '60 runder']];
  // Kompakte spillerrader: portrett (trykk for farge og brikke), navn, type og AI-nivå.
  function renderSetup() {
    const box = $('#setup-players');
    box.innerHTML = '';
    setupPlayers.forEach((p, n) => {
      const row = h(`<div class="prow" style="--pc:${p.color}">
        <button type="button" class="prow-look" title="Velg farge og brikke" aria-label="Velg farge og brikke for spiller ${n + 1}">${portrait(p.token, p.color, 'md')}<span class="prow-edit" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z" fill="#fff" stroke="#12386b" stroke-width="1.8" stroke-linejoin="round"/></svg></span></button>
        <div class="prow-main">
          <div class="prow-line"><span class="prow-num">${n + 1}</span><input class="text-in" type="text" maxlength="14" value="${esc(p.name)}" aria-label="Navn på spiller ${n + 1}" placeholder="Navn">
          ${setupPlayers.length > 2 ? `<button class="rbtn red sm rm" type="button" title="Fjern spiller" aria-label="Fjern spiller ${n + 1}">${RI.close}</button>` : ''}</div>
          ${segHTML('type', [[0, `${ICO.person}Menneske`], [1, `${ICO.robot}Data`]], p.ai ? 1 : 0, 'full ptype')}
          ${p.ai ? segHTML('level', LEVELS, p.level || 'normal', 'full plevel') : ''}
        </div></div>`);
      $('input', row).addEventListener('input', (e) => { p.name = e.target.value; renderStartSum(); });
      wireControls(row, (name, v) => {
        if (name === 'type') {
          p.ai = v === 1;
          if (p.ai && /^Spiller \d$/.test(p.name)) p.name = AI_NAMES.find((nm) => !setupPlayers.some((q) => q.name === nm)) || p.name;
          if (!p.ai && AI_NAMES.includes(p.name)) p.name = `Spiller ${n + 1}`;
          renderSetup();
        } else if (name === 'level') p.level = v;
      }, () => {});
      const rm = $('.rm', row);
      if (rm) rm.addEventListener('click', () => { setupPlayers.splice(n, 1); MP.Sound.click(); renderSetup(); });
      $('.prow-look', row).addEventListener('click', () => { MP.Sound.click(); openLookPicker(p, n); });
      box.appendChild(row);
    });
    if (setupPlayers.length < 6) {
      const add = h(`<button type="button" class="prow add"><span class="plus">+</span>Legg til spiller</button>`);
      add.addEventListener('click', () => {
        const token = TOKENS.find((t) => !setupPlayers.some((q) => q.token === t.id)).id;
        const color = PLAYER_COLORS.find((c) => !setupPlayers.some((q) => q.color === c));
        const name = AI_NAMES.find((nm) => !setupPlayers.some((q) => q.name === nm)) || `Spiller ${setupPlayers.length + 1}`;
        setupPlayers.push({ name, ai: true, token, color, level: 'normal' });
        MP.Sound.click(); renderSetup();
      });
      box.appendChild(add);
    }
    renderStartSum();
  }
  // Farge og brikke velges i et lite vindu, så oppsettet blir kort.
  // `others` = de andre spillerne (brikke og farge de har, kan ikke velges); `onDone` kalles når vinduet lukkes.
  function openLookPicker(p, n, others = null, onDone = null, head = null) {
    const m = openModal('', { onBackdrop: () => done(), cls: 't-blue look-pick' });
    const done = () => { m.close(); if (onDone) onDone(); else renderSetup(); };
    const draw = () => {
      const rest = others || setupPlayers.filter((q) => q !== p);
      const used = rest.map((q) => q.token);
      const usedC = rest.map((q) => q.color);
      m.set(`${title(head || `SPILLER ${n + 1}`, 'blue')}
        <div class="look-prev" style="--pc:${p.color}">${portrait(p.token, p.color, 'xl')}<b>${esc(p.name || 'Spiller')}</b><small>${esc(tokenName(p.token))}</small></div>
        <div class="pick-label">Farge</div>
        <div class="swatches">${PLAYER_COLORS.map((c) => `<button type="button" class="sw ${c === p.color ? 'sel' : ''}" data-c="${c}" style="--c:${c}" ${usedC.includes(c) ? 'disabled' : ''} aria-label="Velg farge" title="${usedC.includes(c) ? 'Brukt av en annen spiller' : 'Velg farge'}"></button>`).join('')}</div>
        <div class="pick-label">Brikke</div>
        <div class="tokens">${TOKENS.map((t) => `<button type="button" class="tok ${p.token === t.id ? 'sel' : ''}" data-t="${t.id}" title="${t.name}" aria-label="${t.name}" ${used.includes(t.id) ? 'disabled' : ''} style="--pc:${p.color}">${tokenSvg(t.id)}</button>`).join('')}</div>
        <div class="actions"><button type="button" class="btn go" data-primary data-x>${pill('FERDIG', null, ICO.check)}</button></div>`);
      $$('.sw', m.el).forEach((b) => b.addEventListener('click', () => { p.color = b.dataset.c; MP.Sound.click(); draw(); }));
      $$('.tok', m.el).forEach((b) => b.addEventListener('click', () => { p.token = b.dataset.t; MP.Sound.click(); draw(); }));
      $('[data-x]', m.el).addEventListener('click', () => { MP.Sound.click(); done(); });
    };
    draw();
  }
  function renderStartSum() {
    const el = $('#start-sum'); if (!el) return;
    const ppl = setupPlayers.length, hum = setupPlayers.filter((p) => !p.ai).length;
    const act = activeRules(settings.rules);
    el.innerHTML = `<b>${ppl} spillere</b><span>${hum} menneske${hum === 1 ? '' : 'r'} · ${ppl - hum} data · ${act.length ? `${act.length} husregl${act.length > 1 ? 'er' : 'el'}` : 'klassisk'} · ${setupOpts.maxRounds ? setupOpts.maxRounds + ' runder' : 'ubegrenset'}</span>`;
  }
  function renderSetupOpts(box = $('#setup-opts')) {
    if (!box) return;
    box.innerHTML = `<div class="set-list">
      <div class="set-row col"><div><b>Startkapital</b><small>Mindre penger, tøffere spill</small></div>${segHTML('money', [[30000, 'kr 30 000'], [20000, 'kr 20 000'], [15000, 'kr 15 000']], setupOpts.money, 'full')}</div>
      <div class="set-row col"><div><b>Spillengde</b><small>Etter siste runde vinner den med mest verdier</small></div>${segHTML('maxRounds', ROUNDS, setupOpts.maxRounds, 'full')}</div>
      <div class="set-row col"><div><b>Tempo</b><small>Rolig gir mer tid til å følge med</small></div>${segHTML('speed', TEMPO, speed, 'full')}</div>
      <div class="set-row col"><div><b>Grafikk</b><small>Lav eller Av hvis spillet hakker</small></div>${segHTML('gfx', GFX, settings.gfx, 'full')}</div>
      <button type="button" class="set-row hr-jump" data-jump><div><b>Husregler</b><small data-rules-side>Klassiske regler</small></div><span class="hr-go">Velg ›</span></button>
      <div data-longwarn hidden></div>
      <label class="set-row"><div><b>Auksjon</b><small>Ledige gater som ikke kjøpes, går på auksjon (original)</small></div>${switchHTML('auction', setupOpts.auction)}</label>
      <label class="set-row"><div><b>Hopp automatisk over datamaskinens turer</b><small>Du får et kort sammendrag når det er din tur</small></div>${switchHTML('autoSkip', settings.autoSkip)}</label>
    </div>`;
    $('[data-jump]', box).addEventListener('click', () => { MP.Sound.click(); openRulesSheet(); });
    wireControls(box, (name, v) => {
      if (name === 'money') { setupOpts.money = v; UI.onlineOptsChanged(); } else if (name === 'maxRounds') { setupOpts.maxRounds = v; renderLongWarn(); renderStartSum(); UI.onlineOptsChanged(); } else applySetting(name, v);
    }, (name, on) => { if (name === 'auction') { setupOpts[name] = on; UI.onlineOptsChanged(); } else applySetting(name, on); });
    renderRulesSide();
  }
  function renderRulesSide() {
    const act = activeRules(settings.rules);
    for (const side of $$('[data-rules-side]')) side.textContent = act.length ? act.map((r) => r.name).join(' · ') : 'Klassiske regler – ingen husregler';
    renderLongWarn();
    renderStartSum();
    UI.onlineOptsChanged();
  }
  // Slangeøyne + potten gir ofte svært lange spill (spilldesigneren målte 8 % over 150 runder): foreslå 60 runder.
  function longGameRisk() { const R = settings.rules; return !!(R.snakeEyes && R.freeParking); }
  function renderLongWarn() {
    for (const box of $$('[data-longwarn]')) {
      const show = longGameRisk();
      box.innerHTML = show ? `<div class="long-warn">${ICO.clock}<span><b>Slangeøyne og potten sammen gir ofte lange spill.</b>${setupOpts.maxRounds ? ` Spillet stopper etter ${setupOpts.maxRounds} runder.` : ' Vurder 60 runder.'}</span>
        ${setupOpts.maxRounds ? '' : `<button type="button" class="btn small go" data-sixty>${pill('Bruk 60 runder')}</button>`}</div>` : '';
      box.hidden = !show;
      const b = $('[data-sixty]', box);
      if (b) b.addEventListener('click', () => { MP.Sound.click(); setupOpts.maxRounds = 60; for (const ob of $$('[data-opts-box]')) renderSetupOpts(ob); UI.onlineOptsChanged(); });
    }
  }
  // Husreglene vises bare bak «Velg ›» som et eget ark.
  function openRulesSheet() {
    const m = openModal(`${title('HUSREGLER', 'green')}<p class="hr-intro">Ekstra husregler og fartsterningen. Slå på de du vil spille med – de kan kombineres.</p>
      <div id="setup-rules" class="hrules"></div>
      <div data-longwarn hidden></div>
      <div class="actions sticky-acts"><button type="button" class="btn go big" data-primary data-x>${pill('FERDIG', null, ICO.check)}</button></div>`, { wide: true, onBackdrop: () => close(), cls: 't-green' });
    const close = () => { m.close(); renderRulesSide(); };
    $('[data-x]', m.el).addEventListener('click', () => { MP.Sound.click(); close(); });
    renderSetupRules();
  }
  // Husregler: ett kort per regel (av/på) og «Klassisk» som slår alle av. Valgene huskes i innstillingene.
  function renderSetupRules() {
    const box = $('#setup-rules');
    if (!box) return;
    const R = settings.rules;
    const none = !RULE_KEYS_ALL.some((k) => R[k]);
    const card = (id, ico, name, text, on, cls = '') => `<button type="button" class="hrule ${cls} ${on ? 'on' : ''}" data-rule="${id}" role="switch" aria-checked="${on}">
      <span class="hr-ico">${ico}</span><span class="hr-txt"><b>${name}</b><small>${text}</small></span><span class="switch" aria-hidden="true"><i></i></span></button>`;
    box.innerHTML = card('classic', ICO.classic, 'Klassisk', 'Originalreglene uten husregler.', none, 'classic')
      + HOUSE_RULES.map((r) => card(r.id, r.ico, r.name, r.text, ruleOn(R, r))).join('');
    renderRulesSide();
    $$('[data-rule]', box).forEach((b) => b.addEventListener('click', () => {
      MP.Sound.click();
      if (b.dataset.rule === 'classic') RULE_KEYS_ALL.forEach((k) => { R[k] = false; });
      else {
        const r = HOUSE_RULES.find((x) => x.id === b.dataset.rule);
        const on = !ruleOn(R, r);
        r.keys.forEach((k) => { R[k] = on; });
      }
      saveSettings();
      renderSetupRules();
      const again = $(`[data-rule="${b.dataset.rule}"]`, box);
      if (again) again.focus({ preventScroll: true });
    }));
  }
  function loadSaved() {
    try {
      const s = JSON.parse(store.get(SAVE_KEY) || 'null');
      return s && Array.isArray(s.players) && s.props ? s : null;
    } catch (e) { return null; }
  }

  // ---------- UI-objektet (også motorens io) ----------
  const UI = {
    game: null,
    over: false,
    renderQueued: false,
    cards: {},

    async boot() {
      const B = MP.Board3D;
      this.booted = true;
      if (store.get(SOUND_KEY) === '0') MP.Sound.on = false;
      if (!document.getElementById('ui-defs')) document.body.insertAdjacentHTML('afterbegin', DEFS);
      this.wire();
      this.showMenu();
      try {
        await B.init($('#scene'));
        B.resize();
        B.speed = speed;
        B.followMode = settings.follow;
        try { B.setGfx?.(settings.gfx); } catch (e) { console.warn(e); }
        B.onDiceBounce = () => { if (!skipping()) MP.Sound.bounce(); };
        B.hoverCb = (i, e) => this.tooltip(i, e);
        B.clickCb = (i) => {
          if (this.pickCb) { this.pickCb(i); return; }
          if (this.game && !modalOpen() && MP.isOwnable(i)) this.showDeed(i);
        };
        this.ready = true;
        this.netFail(false);
        if (!$('#menu').hidden || !$('#setup').hidden) this.boardMenu(true);
        // Uskarp 3D-by bak menyen: etterbehandlingen finnes først nå.
        blurOn = null; syncBlur();
        document.body.classList.toggle('fx-noblur', settings.gfx !== 'high');
        // «Spill igjen» fra vinnerskjermen: start et nytt spill med samme spillere og regler.
        let replay = null;
        try { replay = JSON.parse(sessionStorage.getItem(REPLAY_KEY) || 'null'); sessionStorage.removeItem(REPLAY_KEY); } catch (e) { replay = null; }
        if (replay && Array.isArray(replay.players) && replay.players.length >= 2) this.newGame(replay);
        else this.onlineBoot();
      } catch (err) {
        console.error(err);
        this.netFail(true, err && err.message);
      }
      refreshPortraits();
    },
    // F14: 3D-biblioteket hentes fra nettet. Kommer det ikke, sier vi tydelig hva som mangler.
    netFail(show = true, detail = '') {
      let el = $('#netfail');
      if (!show) { if (el) el.hidden = true; return; }
      if (!el) { el = h('<div id="netfail" role="alert"></div>'); document.body.appendChild(el); }
      el.innerHTML = `<div class="nf-box">${title('BRETTET LASTES IKKE', 'red')}
        <p><b>Spillet trenger internett for å laste 3D-grafikken</b> og skriftene. Sjekk at du er koblet til nettet, og prøv igjen.</p>
        ${detail ? `<p class="nf-detail">${esc(detail)}</p>` : ''}
        <div class="actions"><button type="button" class="btn go big" data-retry>${pill('PRØV IGJEN')}</button><button type="button" class="btn sky" data-wait>${pill('Vent litt til')}</button></div></div>`;
      el.hidden = false;
      el.querySelector('[data-retry]').addEventListener('click', () => location.reload());
      el.querySelector('[data-wait]').addEventListener('click', () => { el.hidden = true; setTimeout(() => { if (!this.ready) this.netFail(true, detail); }, 12000); });
    },

    wire() {
      $('#tile-new').addEventListener('click', () => { MP.Sound.ensure(); MP.Sound.click(); this.showSetup(); });
      $('#tile-continue').addEventListener('click', () => {
        MP.Sound.ensure(); MP.Sound.click();
        const saved = loadSaved();
        if (!saved) { toast('Fant ikke noe lagret spill', '#E3242B', 3, true); return; }
        try { this.begin(new MP.Game(null, this, saved)); } catch (e) { console.error(e); toast('Kunne ikke laste lagret spill', '#E3242B', 3, true); }
      });
      $('#tile-online').addEventListener('click', () => { MP.Sound.ensure(); MP.Sound.click(); this.showOnline(); });
      $('#online-back').addEventListener('click', () => { MP.Sound.click(); this.onlineBack(); });
      $('#tile-rules').addEventListener('click', () => { MP.Sound.click(); this.openRules(); });
      $('#tile-settings').addEventListener('click', () => { MP.Sound.ensure(); MP.Sound.click(); this.openSettings(); });
      $('#setup-back').addEventListener('click', () => { MP.Sound.click(); this.showMenu(); });
      $('#start-game').addEventListener('click', () => {
        if (!this.ready) { toast('Vent litt – brettet lastes …', '#F7941D', 2, true); return; }
        MP.Sound.ensure();
        const players = setupPlayers.map((p, n) => ({ ...p, level: p.ai ? (p.level || 'normal') : undefined, name: p.name.trim() || `Spiller ${n + 1}` }));
        const rules = { ...settings.rules };
        this.newGame({ players, startMoney: setupOpts.money, auctions: setupOpts.auction, rules, maxRounds: setupOpts.maxRounds || 0 });
      });
      // Toppknappene er samlet: meny til venstre, oversikt og logg til høyre. Lyd og kamera ligger i menyen.
      const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
      on('#btn-view', () => { MP.Sound.click(); MP.Board3D.resetView(); });
      on('#btn-follow', () => applySetting('follow', !settings.follow));
      on('#btn-sound', () => { applySetting('sound', !MP.Sound.on); MP.Sound.click(); });
      on('#btn-log', () => { MP.Sound.click(); this.toggleLog(); });
      on('#btn-map', () => { MP.Sound.click(); if (!modalOpen()) this.openMap(); });
      on('#btn-menu', () => { MP.Sound.click(); this.openMenu(); });
      on('#btn-help', () => { MP.Sound.click(); if (!modalOpen()) this.openRules(); });
      on('#log-close', () => { MP.Sound.click(); this.toggleLog(false); });
      $('#skip').addEventListener('click', () => this.toggleSkip());
      this.syncTopButtons();
      window.addEventListener('resize', () => this.measureRow());
      document.addEventListener('keydown', (e) => {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (!$('#skip').hidden) { e.preventDefault(); this.toggleSkip(); }
          return;
        }
        if (e.code === 'Escape') {
          const top = $('#modals').lastElementChild;
          const x = top && top.querySelector('.modal-body [data-x], .modal-foot [data-x]');
          if (x) { e.preventDefault(); x.click(); } else if (!top && !$('#setup').hidden) { e.preventDefault(); $('#setup-back').click(); } else if (!top && !$('#online').hidden) { e.preventDefault(); $('#online-back').click(); }
          return;
        }
        // Piltaster i hovedmenyen flytter mellom flisene (som med håndkontroll i Plus).
        if (/^Arrow/.test(e.code) && !$('#menu').hidden && !modalOpen()) {
          const tiles = $$('#menu .ptile').filter((t) => !t.hidden);
          const k = tiles.indexOf(document.activeElement);
          const back = e.code === 'ArrowUp' || e.code === 'ArrowLeft';
          const next = tiles[k < 0 ? 0 : (k + (back ? -1 : 1) + tiles.length) % tiles.length];
          if (next) { e.preventDefault(); next.focus(); }
          return;
        }
        // Bokstavtaster for knappehintene (E, M, H, K, P, B …). Øverste panel først, ellers bunnlinja.
        if (/^Key[A-Z]$/.test(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
          const top = wraps().filter((w) => !w.classList.contains('stashed') && !w.hidden).pop();
          // Har panelet tasten (også om knappen er av), går den aldri videre til bunnlinja.
          let btn = top ? top.querySelector(`[data-key="${e.code}"]`) : null;
          if (!btn && !modalOpen() && !$('#hud').hidden) btn = $(`#actions [data-key="${e.code}"]`);
          if (btn) { e.preventDefault(); if (!btn.disabled) btn.click(); }
          return;
        }
        if (e.code !== 'Space' && e.code !== 'Enter') return;
        if (tag === 'BUTTON' || tag === 'A' || (e.target.getAttribute && e.target.getAttribute('role') === 'button')) return; // fokusert knapp: vanlig klikk
        const scope = modalOpen() ? $('#modals').lastElementChild : !$('#setup').hidden ? $('#setup') : !$('#online').hidden ? $('#online') : $('#actions');
        const btn = scope && scope.querySelector('[data-primary]:not(:disabled)');
        if (btn) { e.preventDefault(); btn.click(); }
      });
    },

    syncTopButtons() {
      const f = $('#btn-follow');
      if (f) {
        f.classList.toggle('on', settings.follow); f.setAttribute('aria-pressed', String(settings.follow));
        f.title = settings.follow ? 'Følg brikken: på' : 'Følg brikken: av';
      }
      const s = $('#btn-sound');
      if (s) {
        s.innerHTML = MP.Sound.on ? RI.soundOn : RI.soundOff;
        s.classList.toggle('off', !MP.Sound.on); s.title = MP.Sound.on ? 'Lyd: på' : 'Lyd: av';
      }
      const l = $('#btn-log');
      if (l) { const open = $('#log').classList.contains('open'); l.classList.toggle('on', open); l.setAttribute('aria-pressed', String(open)); }
    },
    // Hendelsesloggen er skjult som standard (Plus har ingen logg på skjermen).
    toggleLog(force) {
      const open = force != null ? !!force : !$('#log').classList.contains('open');
      $('#log').classList.toggle('open', open);
      this.syncTopButtons();
    },

    boardMenu(on) {
      const B = MP.Board3D;
      if (!this.ready || !B || !B.controls) return;
      try {
        if (B.menuMode) B.menuMode(on);
        else { B.controls.autoRotate = on; B.controls.autoRotateSpeed = 0.5; }
      } catch (e) { console.warn(e); }
      if (!on) B.controls.autoRotate = false;
    },

    showMenu() {
      $('#hud').hidden = true; $('#setup').hidden = true; $('#online').hidden = true; $('#menu').hidden = false;
      $('#skip').hidden = true;
      document.body.classList.remove('in-game');
      const saved = loadSaved();
      $('#tile-continue').hidden = !saved;
      $('.ptiles').classList.toggle('no-continue', !saved);
      if (saved) {
        $('#continue-art').innerHTML = saved.players.filter((p) => !p.bankrupt).map((p) => pPortrait(p, 'md')).join('');
        const cur = saved.players[saved.current];
        const mine = saved.turnPlayer == null || saved.turnPlayer === saved.current;
        const midTurn = !mine ? '' : saved.turnPhase === 'post' ? ' – har kastet' : saved.turnPhase === 'roll' && saved.turnDoubles ? ' – kaster igjen' : '';
        $('#continue-sub').textContent = `Runde ${saved.turn || 1} · ${saved.players.map((p) => p.name).join(', ')}${cur && !cur.bankrupt ? ` · ${cur.name} sin tur${midTurn}` : ''}`;
      }
      $('#art-tokens').innerHTML = TOKENS.map((t, n) => portrait(t.id, PLAYER_COLORS[n], 'md')).join('');
      this.boardMenu(true);
      syncBlur();
      requestAnimationFrame(() => $('#tile-new').focus({ preventScroll: true }));
    },
    showSetup() {
      $('#menu').hidden = true; $('#online').hidden = true; $('#setup').hidden = false;
      renderSetup(); renderSetupOpts(); renderSetupRules();
      $('#setup').scrollTop = 0;
    },

    newGame(opts) {
      this.lastOpts = JSON.parse(JSON.stringify(opts));
      const game = new MP.Game(opts, this);
      game.s.speed = speed;
      this.begin(game);
    },
    // o.mirror: online-klient (speil-instans uten motorløkke). o.quick: ingen innflyging (gjenoppretting).
    async begin(game, o = {}) {
      const B = MP.Board3D;
      if (this.game && this.game !== game) this.game.stopped = true;
      this.game = game;
      this.over = false;
      this.auc = null;
      this.pickCb = null;
      this.phaseDone = null;
      this.proposing = null;
      this.orderUnknown = false;
      this.prevTurn = null;
      // Penger ved slutten av hver spillers forrige tur (for +/− på spillerkortet).
      this.turnCash = Object.fromEntries(game.players.map((p) => [p.id, p.cash]));
      pendingHuman = 0;
      $$('.peek-back').forEach((e) => e.remove());
      resetDigest();
      this.startedAt = Date.now();
      this.outOrder = [];
      $('#toasts').innerHTML = '';
      // Online-klienten beholder sitt eget tempo (det gjelder bare animasjonene på denne skjermen).
      if (!o.mirror) { speed = normSpeed(game.s.speed || speed); game.s.speed = speed; }
      B.speed = speed;
      B.followMode = settings.follow;
      this.waitShown = false;
      setSkip(false);
      $('#menu').hidden = true; $('#setup').hidden = true; $('#online').hidden = true; $('#hud').hidden = false;
      document.body.classList.toggle('net-on', !!this.net);
      document.body.classList.add('in-game');
      document.body.classList.remove('map-open');
      this.mapDraw = null;
      this.boardMenu(false);
      B.setPlayers(game.players);
      B.placeAll(game.s);
      B.syncProps(game.s, false);
      this.cards = {};
      this.tab = null;
      this.dying = new Set();
      this.lastPot = game.s.pot || 0;
      for (const k of Object.keys(cashAnim)) delete cashAnim[k];
      $('#players').innerHTML = '';
      $('#log-list').innerHTML = '';
      $('#modals').innerHTML = ''; syncBlur();
      clearSplash();
      this.toggleLog(false);
      this.setActions([]);
      // Lagret midt i turen (etter kastet): vis terningsummen på fanen igjen.
      if (game.s.turnPhase === 'post' && game.s.turnPlayer === game.s.current && Array.isArray(game.s.lastDice)) this.tab = { id: game.s.current, kind: 'sum', d: game.s.lastDice.slice(0, 2), speed: null };
      this.render();
      const midPost = game.s.turnPhase === 'post' && game.s.turnPlayer === game.s.current;
      const resumed = game.s.turn > 1 || (game.s.orderDone && game.s.turnPlayer != null);
      this.log(resumed ? `Spillet fortsetter i runde ${game.s.turn}${midPost && game.current ? ` – ${game.current.name} har allerede kastet` : ''}.` : `Spillet starter! Hver spiller har ${kr(game.s.opts.startMoney)}.`, 'good');
      let intro = null;
      try { intro = B.introFly && !o.quick ? B.introFly() : B.resetView(); } catch (e) { console.warn(e); }
      if (intro && typeof intro.then === 'function') await Promise.race([intro, new Promise((r) => setTimeout(r, 6000))]).catch(() => {});
      if (o.mirror || this.game !== game) return;
      game.run().catch((err) => { console.error(err); toast('Noe gikk galt: ' + esc(err.message), '#E3242B', 6, true); });
    },

    // ---------- Visning ----------
    render() {
      this.renderQueued = false;
      const g = this.game; if (!g) return;
      const box = $('#players');
      for (const p of g.players) {
        let card = this.cards[p.id];
        if (!card) {
          card = h(`<div class="pcard" role="button" tabindex="0" data-pid="${p.id}" style="--pc:${p.color}">
            <div class="pc-tab" aria-hidden="true"></div>
            ${pcTop(p)}
            <div class="pc-body"><div class="pc-money"><div class="pc-cash" data-cash="${p.id}"></div><span class="pc-trend" title="Endring siden forrige tur"></span></div><div class="pc-grid"></div><div class="pc-sum"></div></div></div>`);
          const open = () => { if (!modalOpen()) { MP.Sound.click(); this.openManage(p, null); } };
          card.addEventListener('click', open);
          card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
          box.appendChild(card);
          this.cards[p.id] = card;
          cashAnim[p.id] = { cur: p.cash, to: p.cash };
        }
        const active = g.s.current === p.id && !this.over && !p.bankrupt;
        card.classList.toggle('active', active);
        card.classList.toggle('broke', p.bankrupt);
        card.classList.toggle('jail', p.inJail && !p.bankrupt);
        const off = !!(this.net && !p.bankrupt && this.net.isOffline(p));
        card.classList.toggle('offline', off);
        card.classList.toggle('me', !!(this.net && this.mine(p)));
        card.title = `${p.name}${p.ai ? ' (datamaskin)' : ''}${off ? ' (frakoblet)' : ''} – klikk for eiendommer`;
        tweenCash(p.id, p.cash);
        $('.pc-cash', card).textContent = kr(cashAnim[p.id].cur);
        // Liten +/− for endringen siden spillerens forrige tur.
        const base = this.turnCash ? this.turnCash[p.id] : null;
        const dlt = base == null || p.bankrupt ? 0 : p.cash - base;
        const tr = $('.pc-trend', card);
        const trTxt = dlt ? `${dlt > 0 ? '+' : '−'}${MP.kr(Math.abs(dlt)).replace('kr ', '')}` : '';
        if (tr.textContent !== trTxt) { tr.textContent = trTxt; tr.className = 'pc-trend' + (dlt > 0 ? ' plus' : dlt < 0 ? ' minus' : ''); }
        $('.pc-grid', card).innerHTML = gridHTML(g, p);
        $('.pc-sum', card).innerHTML = sumHTML(g, p);
        $('.pc-tags', card).innerHTML = (off ? '<span class="tag off" title="Frakoblet">AV</span>' : '')
          + (p.inJail && !p.bankrupt ? `<span class="tag jail" title="I fengsel">${ICO.jail}</span>` : '')
          + (p.jailCards.length ? `<span class="tag key" title="Kom ut av fengselet-kort: ${p.jailCards.length}">${ICO.key}${p.jailCards.length > 1 ? `<i>${p.jailCards.length}</i>` : ''}</span>` : '');
      }
      this.renderTab();
      this.renderChips();
      this.measureRow();
      // Brettkartet følger med mens det er åpent.
      if (this.mapDraw) this.mapDraw();
      MP.Board3D.syncProps(g.s, !skipping());
      // Brikker som er midt i konkursanimasjonen skjules av board3d selv.
      for (const p of g.players) if (MP.Board3D.tokens[p.id] && !(this.dying && this.dying.has(p.id))) MP.Board3D.tokens[p.id].obj.visible = !p.bankrupt;
    },
    // Fanen over aktivt kort: terningikon før kast, terningsummen (grønn) etter kast.
    renderTab() {
      const g = this.game; if (!g) return;
      for (const p of g.players) {
        const card = this.cards[p.id]; if (!card) continue;
        const el = $('.pc-tab', card);
        const t = this.tab && this.tab.id === p.id && g.s.current === p.id && !this.over ? this.tab : null;
        el.className = 'pc-tab' + (t ? ' show ' + t.kind : '');
        const sp = t && t.speed != null ? t.speed : null;
        const spTxt = sp == null ? '' : typeof sp === 'number' ? `+${sp}` : sp === 'bus' ? 'BUSS' : 'EKSPRESS';
        el.innerHTML = !t ? '' : t.kind === 'sum' ? `<b>${t.d[0] + t.d[1] + (typeof sp === 'number' ? sp : 0)}</b>${sp != null ? `<i class="pc-speed">${spTxt}</i>` : ''}` : ICO.dice;
        if (t && t.kind === 'sum') el.title = `${t.d[0]} + ${t.d[1]}${sp != null ? ' · fartsterning: ' + spTxt : ''}`;
      }
    },
    // Små HUD-merker øverst: potten (Gratis parkering) og rikdomsmålet.
    renderChips() {
      const g = this.game, box = $('#hud-chips');
      if (!g || !box) return;
      const R = g.rules || {};
      let html = '';
      if (this.net) {
        const st = this.net.status === 'on' ? (this.hostLost ? 'lost' : 'on') : 'off';
        html += `<span class="chip net ${st}" title="${st === 'on' ? 'Online – tilkoblet' : st === 'lost' ? 'Verten er borte' : 'Kobler til …'}"><i class="net-dot"></i><span><small>${this.net.role === 'host' ? 'VERT · ROM' : 'ONLINE · ROM'}</small><b>${esc(this.net.room || '')}</b></span></span>`;
      }
      if (R.freeParking) html += `<span class="chip pot" title="Gratis parkering-potten">${ICO.parking}<span><small>POTT</small><b>${kr(g.s.pot || 0)}</b></span></span>`;
      if (R.wealthWin) {
        const goal = MP.WEALTH_GOAL || 60000;
        const best = g.active.slice().sort((a, b) => b.cash - a.cash)[0];
        html += `<span class="chip goal" title="Rikdomsregelen: første til ${kr(goal)} i kontanter vinner">${ICO.trophy}<span><small>MÅL</small><b>${kr(goal)}</b></span>${best ? `<i class="goal-bar" style="--k:${Math.min(1, best.cash / goal)};--pc:${best.color}"></i>` : ''}</span>`;
      }
      if (box.innerHTML !== html) {
        const old = box.querySelector('.pot b');
        const oldPot = old ? old.textContent : null;
        box.innerHTML = html;
        const nb = box.querySelector('.pot');
        if (nb && oldPot != null && oldPot !== kr(g.s.pot || 0)) { nb.classList.remove('bump'); void nb.offsetWidth; nb.classList.add('bump'); }
      }
    },
    measureRow() {
      const box = $('#players');
      if (!box || $('#hud').hidden) return;
      document.documentElement.style.setProperty('--row-h', box.offsetHeight + 'px');
      const dock = $('#dock');
      const top = Math.min(box.getBoundingClientRect().top, dock ? dock.getBoundingClientRect().top : Infinity);
      if (Number.isFinite(top)) document.documentElement.style.setProperty('--hud-b', Math.max(0, Math.round(window.innerHeight - top)) + 'px');
    },
    scheduleRender() { if (!this.renderQueued) { this.renderQueued = true; requestAnimationFrame(() => this.render()); } },
    cardDelta(id, delta) {
      const card = this.cards[id]; if (!card) return;
      const cash = $('.pc-cash', card);
      cash.classList.remove('up', 'down'); void cash.offsetWidth; cash.classList.add(delta > 0 ? 'up' : 'down');
      clearTimeout(cash._t); cash._t = setTimeout(() => cash.classList.remove('up', 'down'), 1400);
      const d = h(`<div class="pdelta ${delta > 0 ? 'plus' : 'minus'}">${delta > 0 ? '+' : '−'}${kr(Math.abs(delta))}</div>`);
      card.appendChild(d);
      setTimeout(() => d.remove(), 1900);
    },
    // Bunnlinjen har aktiv spillers farge; teksten til venstre sier kort hva som skjer.
    setTurnInfo(p, sub) {
      const el = $('#turn-info');
      $('#dock').style.setProperty('--pc', p.color);
      el.style.setProperty('--pc', p.color);
      el.innerHTML = `<b>${esc(p.name)}</b><span class="sub">${esc(sub || (p.ai ? 'tenker …' : 'din tur'))}</span>`;
    },
    // Bunnlinja som i Plus: knappehint (rund tast + tekst) for det som gjelder nå. Alle er klikkbare.
    // a = { label, short?, key?, cap?, tone?, icon?, primary?, disabled?, title?, cls?, onClick }.
    // Hovedvalget (Mellomrom) er en tydelig, pulserende kapsel.
    setActions(list, head = '') {
      const box = $('#actions');
      box.innerHTML = '';
      this.waitShown = false;
      $('#dock').classList.toggle('has-acts', list.length > 0);
      if (head && this.game && this.game.current) this.setTurnInfo(this.game.current, head);
      for (const a of list) {
        const cap = a.primary ? PI.space : (a.cap || '');
        const tip = a.title || (a.primary ? `${a.label} (Mellomrom)` : a.cap ? `${a.label} (${a.cap})` : a.label);
        const b = h(`<button type="button" class="hint ${a.primary ? 'primary' : ''} ${a.cls || ''}" ${a.primary ? 'data-primary' : ''} ${a.key ? `data-key="${a.key}"` : ''} ${a.disabled ? 'disabled' : ''} title="${esc(tip)}" aria-label="${esc(a.label)}">
          ${cap ? keyCap(cap, a.tone || (a.primary ? 'a' : '')) : ''}${a.icon ? `<span class="h-ico">${a.icon}</span>` : ''}<span class="hl"><span class="hl-l">${esc(a.label)}</span>${a.short ? `<span class="hl-s">${esc(a.short)}</span>` : ''}</span></button>`);
        b.addEventListener('click', () => { MP.Sound.click(); a.onClick(); });
        box.appendChild(b);
      }
      this.updateSkip();
    },
    updateSkip() {
      const btn = $('#skip'); if (!btn) return;
      const show = !!this.game && !this.over && pendingHuman === 0 && !$('#hud').hidden;
      btn.hidden = !show;
      const on = skipping();
      btn.classList.toggle('on', on);
      btn.innerHTML = `<span class="kc ${on ? 'kc-y' : ''}" aria-hidden="true">${on ? RI.ff : 'S'}</span><span class="sk-l">${on ? 'Hopper over' : 'Hopp over'}<small>${on ? 'trykk for å se' : 'animasjonene'}</small></span>`;
      btn.title = on ? 'Slå av hopping og se animasjonene igjen' : 'Hopp over animasjoner til noen må ta et valg (S)';
      btn.setAttribute('aria-label', on ? 'Hopper over – trykk for å se animasjonene igjen' : 'Hopp over animasjoner');
    },
    toggleSkip() { MP.Sound.click(); setSkip(!skipping()); },
    tooltip(i, e) {
      const tip = $('#tooltip');
      if (i < 0 || modalOpen() || !this.game) { tip.hidden = true; return; }
      const sq = SQ[i];
      let extra = '';
      if (MP.isOwnable(i)) {
        const o = this.game.ownerOf(i), pr = this.game.s.props[i];
        extra = o ? ` <span class="own">· ${esc(o.name)}${pr.mortgaged ? ' (pantsatt)' : ''}</span>` : ` <span class="own">· ${kr(sq.price)}</span>`;
      }
      tip.innerHTML = `${sq.group ? `<span class="tc" style="background:${GROUPS[sq.group].color}"></span>` : ''}${esc(sq.name)}${extra}`;
      tip.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px'; tip.style.top = e.clientY + 'px';
      tip.hidden = false;
    },
    // Skjøtet for et felt vises til høyre (brettet synes fortsatt). Eier spilleren feltet og det er
    // hans tur, vises bygg/pantsett-knappene under kortet. Klikk på et annet felt bytter skjøte.
    showDeed(i) {
      const g = this.game;
      const p = g && g.current;
      const m = openModal('', { cls: 'deed-panel deed-modal', side: true, transient: true });
      const draw = () => {
        const canManage = !!(g && p && !p.ai && this.mine(p) && !p.bankrupt && g.s.props[i].owner === p.id && pendingHuman > 0);
        // Plus: toppen i eierens farge (husikon + navn), ellers nøytral «Ledig».
        const o = g.ownerOf(i);
        m.frame.style.setProperty('--pc', o ? o.color : NEUTRAL);
        m.set(`${o ? dpHead(o.color, PI.houseW, o.name, canManage ? 'din eiendom' : 'eier') : dpHead(NEUTRAL, PI.houseW, 'Ledig', `kan kjøpes · ${kr(SQ[i].price)}`)}
          ${deedHTML(g, i)}<div class="sticky-acts">${canManage ? deedActsHTML(g, p, i) : ''}
          <div class="actions dp-acts">${canManage ? `<button type="button" class="hint" data-m data-key="KeyE">${keyCap('E', 'w')}<span class="hl"><span class="hl-l">Alle eiendommer</span></span></button>` : ''}<button type="button" class="hint" data-primary data-x>${keyCap('Esc', 'b')}<span class="hl"><span class="hl-l">Lukk</span></span></button></div></div>`);
        $('[data-x]', m.el).addEventListener('click', () => m.close());
        if (canManage) {
          wireDeedActs(m.el, g, p, i, draw);
          $('[data-m]', m.el).addEventListener('click', () => { m.close(); this.openManage(p, null); });
        }
      };
      draw();
    },

    // ---------- io: logg og endringer ----------
    log(msg, kind = '') {
      const list = $('#log-list');
      // Nyeste øverst (prepend), så den aldri klippes bort.
      list.prepend(h(`<div class="${kind}">${esc(msg)}</div>`));
      while (list.children.length > 150) list.lastElementChild.remove();
      list.scrollTop = 0;
    },
    changed(ev) {
      const g = this.game;
      this.scheduleRender();
      if (ev.bankrupt != null && this.dying) this.dying.add(ev.bankrupt);
      if (ev.money != null && ev.delta) {
        const pl = g.player(ev.money);
        if (!skipping() && !pl.bankrupt) {
          const pos = MP.Board3D.tokenScreen(ev.money);
          if (pos) floatAt(pos.x, pos.y, (ev.delta > 0 ? '+' : '−') + kr(Math.abs(ev.delta)), ev.delta > 0 ? 'plus' : 'minus');
          requestAnimationFrame(() => this.cardDelta(ev.money, ev.delta));
          if (ev.delta > 0) MP.Sound.cash();
        }
        // Potten på Gratis parkering ble tømt til denne spilleren.
        const pot = g.s.pot || 0;
        if (g.rules && g.rules.freeParking && this.lastPot > 0 && pot === 0 && ev.delta === this.lastPot && pl.pos === 20) this.potWon(pl, ev.delta);
      }
      if (g && g.s) this.lastPot = g.s.pot || 0;
      if (ev.build && !skipping()) MP.Sound.build();
      if (ev.build && ev.prop != null && aiTurn()) {
        const o = g.ownerOf(ev.prop);
        if (o) { digest.builds[o.id] = (digest.builds[o.id] || 0) + 1; if (skipping()) digest.skipped = true; }
      }
      // Hotell er et stort øyeblikk: full splash også for datamaskinen (med mindre man hopper over).
      if (ev.build && ev.prop != null && g && g.s.props[ev.prop] && g.s.props[ev.prop].houses === 5) {
        const o = g.ownerOf(ev.prop);
        if (o) {
          splash('HOTELL!', 'red', { icon: ICO.hotel, sub: `${esc(o.name)} · ${esc(SQ[ev.prop].name)}`, life: 1.6, ai: false });
          note(`${who(o)} bygde <b>hotell</b> på ${sqTag(ev.prop)}!`, 85);
        }
      }
      if (ev.landed != null) MP.Board3D.flash?.(ev.landed);
    },
    // F3: et avsluttet eller stoppet spill lagres aldri.
    save(s) {
      const g = this.game;
      if (this.over || !g || g.stopped || g.s !== s) return;
      // Online: verten lagrer rommet for seg (så det kan gjenopptas); klienten lagrer aldri.
      if (this.net) { if (this.net.role === 'host') this.net.save(s); return; }
      store.set(SAVE_KEY, JSON.stringify(s));
    },
    potWon(p, amount) {
      if (this.potShown === this.game.s.turn + ':' + p.id) return;
      this.potShown = this.game.s.turn + ':' + p.id;
      splash('GRATIS PARKERING!', 'blue', { icon: ICO.parking, sub: '+' + kr(amount) });
      this.celebrate(p);
    },
    celebrate(p) {
      if (!p) return;
      try { const r = MP.Board3D.celebrate?.(p.id); if (r && r.catch) r.catch((e) => console.warn(e)); } catch (e) { console.warn(e); }
    },

    // ---------- io: store hendelser fra motoren ----------
    event(type, d = {}) {
      const p = d.player;
      if (this.over) return;
      switch (type) {
        case 'salary':
          splash('LØNN', 'green', { icon: ICO.notes, sub: '+' + kr(d.amount || RULES.salary) });
          break;
        case 'goDouble':
          splash('DOBBEL LØNN!', 'gold', { icon: ICO.notes, sub: '+' + kr(d.amount || RULES.salary * 2) });
          this.celebrate(p);
          break;
        case 'snakeEyes':
          splash('SLANGEØYNE!', 'purple', { icon: ICO.snake, sub: '+' + kr(d.amount || MP.SNAKE_EYES || 20000) });
          if (p) note(`${who(p)} fikk slangeøyne: <b>+${kr(d.amount || MP.SNAKE_EYES || 20000)}</b>`, 60);
          this.celebrate(p);
          break;
        case 'setComplete': {
          const gr = GROUPS[d.group];
          // Full splash også i datamaskinens tempo (stort øyeblikk), med mindre man hopper over.
          splash('FARGEGRUPPE KOMPLETT!', 'player', { pc: gr ? gr.color : '#ffc928', icon: ICO.props, sub: `${esc(p ? p.name : '')}${gr ? ' · ' + esc(gr.name.toLowerCase()) + ' gruppe' : ''}`, life: 1.6, ai: false });
          if (p && gr) note(`${who(p)} fikk hele <span class="sq-tag" style="--c:${gr.color}">${esc(gr.name.toLowerCase())}</span> gruppe!`, 90);
          try { MP.Board3D.setCompleteAnim?.(d.group, p ? p.id : null); } catch (e) { console.warn(e); }
          this.celebrate(p);
          break;
        }
        case 'freeParking': case 'pot':
          if (p) this.potWon(p, d.amount || 0);
          break;
        case 'tradeDone': case 'tradeDeclined': {
          const t = d.trade; if (!t || !this.game) break;
          // Mennesket foreslo handelen selv: avslaget vises med grunn når svaret kommer (openTrade).
          if (type === 'tradeDeclined' && sameTrade(t, this.proposing)) { this.tradeEv = { type, t, at: performance.now(), own: true }; break; }
          this.tradeEv = { type, t, at: performance.now() };
          const a = this.game.player(t.from), b = this.game.player(t.to);
          const humanIn = !a.ai || !b.ai;
          if (type === 'tradeDone') {
            note(`${who(a)} og ${who(b)} handlet: ${tradeSummary(this.game, t)}`, 80);
            if (humanIn) this.tradeSplash(true, a, b);
            else toast(`${ICO.trade}<span><b>${esc(a.name)}</b> og <b>${esc(b.name)}</b> ble enige om en handel</span>`, '#22b864', 2);
          } else if (humanIn && !d.counter) this.tradeSplash(false, a, b);
          break;
        }
        case 'bankrupt':
          // Selve konkursen vises i io.bankrupt; her bare sammendraget.
          break;
        case 'speedMono':
          splash('EKSPRESS!', 'purple', { icon: ICO.speed, sub: p && d.to != null ? `${esc(p.name)} → ${esc(SQ[d.to].name)}` : 'neste ledige eiendom' });
          break;
        case 'turnOrder': {
          // Vises i io.turnOrder. Sendte motoren ikke `first` dit, kommer startspilleren her.
          const f = d.first != null ? (typeof d.first === 'object' ? d.first : this.game?.player(d.first)) : null;
          if (this.orderUnknown && f) {
            this.orderUnknown = false;
            this.log(`${f.name} begynner!`, 'good');
            splash(`${f.name.toUpperCase()} BEGYNNER!`, 'player', { pc: f.color, icon: pPortrait(f, 'lg'), ai: false });
          }
          break;
        }
        case 'winner': {
          // N2: seier kan komme mens et menneske har en dialog åpen (kjøp, auksjon, gjeld, fengsel, skjøte,
          // handel, valg). Da lukkes alt, motoren stoppes, og vinnerskjermen vises straks.
          // Uten ventende menneskevalg avslutter motoren selv og kaller io.gameOver.
          const g = this.game;
          const w = p || null;
          // Online-verten venter kanskje på en beslutning fra en annen skjerm: avslutt også da.
          // (Online-klienten avslutter aldri selv – vinnerskjermen kommer fra verten.)
          if (this.net && this.net.role === 'client') break;
          if ((pendingHuman > 0 || this.phaseDone || (this.net && this.net.waitingRemote())) && !this.quitting) {
            setTimeout(() => {
              if (this.game !== g || this.over) return;
              g.stopped = true;
              this.gameOver(w);
            }, 0);
          }
          break;
        }
        default: break;
      }
      this.scheduleRender();
    },
    // HANDEL GODTATT / AVSLÅTT som splash (bare når et menneske er med).
    tradeSplash(ok, a, b, sub = null) {
      // «Byttet godtatt!» med håndtrykk (Plus) / «Avslått» i rødt.
      if (ok) { if (!skipping()) MP.Sound.buy(); splash('Byttet godtatt!', 'orange', { kind: 'deal', ok: true, pc: '#7cc8ff', sub: `${esc(a.name)} og ${esc(b.name)}`, ai: false, life: 1.8 }); } else { if (!skipping()) MP.Sound.bad(); splash('Avslått', 'red', { kind: 'deal', ok: false, pc: '#ff9a94', sub: sub || `${esc(b.name)} sa nei`, ai: false, life: 1.6 }); }
    },

    // ---------- io: turer ----------
    // `resume`: null ved vanlig turstart, 'roll' | 'post' når en lagret tur fortsetter (motoren).
    async turnStart(p, resume = null) {
      const B = MP.Board3D;
      $('#toasts').innerHTML = '';
      try { B.setPace?.(p.ai ? 'ai' : 'human'); } catch (e) { console.warn(e); }
      // Litt ekstra fart på datamaskinens animasjoner (sammen med setPace), så turen holder seg under ca. 5 s.
      B.speed = p.ai ? speed * AI_BOOST : speed;
      if (!p.ai) setSkip(false);
      else if (settings.autoSkip) setSkip(true);
      B.placeAll(this.game.s);
      B.setActive(p.id);
      // +/− på kortet: forrige spillers tur er ferdig, så den får nytt utgangspunkt.
      if (this.turnCash && this.prevTurn != null && this.prevTurn !== p.id) { const q = this.game.player(this.prevTurn); if (q) this.turnCash[q.id] = q.cash; }
      this.prevTurn = p.id;
      const resumePost = resume === 'post' && this.tab && this.tab.id === p.id && this.tab.kind === 'sum';
      if (!resumePost) this.tab = { id: p.id, kind: 'dice' };
      this.render();
      this.setTurnInfo(p);
      this.setActions([]);
      if (!p.ai && this.mine(p)) await this.showDigest();
      if (!skipping()) showBanner(p);
      // Lagret spill midt i turen: si fra at turen fortsetter (ikke et nytt kast).
      if (resume) toast(`${pPortrait(p, 'xs')}<span>Fortsetter turen til <b>${esc(p.name)}</b>${resume === 'post' ? ' – terningene er kastet' : ' – kast igjen'}</span>`, p.color, 3, true);
      let cam = null;
      try { cam = B.turnCam ? B.turnCam(p.id, !p.ai) : (settings.follow ? B.recenter() : null); } catch (e) { console.warn(e); }
      // Datamaskinen venter ikke på kameraet; mennesket får en kort glid (maks 1,2 s).
      if (!p.ai && cam && typeof cam.then === 'function') await Promise.race([cam, new Promise((r) => setTimeout(r, 1200))]).catch(() => {});
      await wait(p.ai ? 120 : 250);
    },
    // «Mens du ventet»: kort sammendrag av datamaskinens turer etter Hopp over / auto-hopp.
    showDigest() {
      const g = this.game;
      const builds = Object.entries(digest.builds).filter(([, n]) => n > 0);
      if (!g || !digest.skipped || (!digest.items.length && !builds.length)) { resetDigest(); return Promise.resolve(); }
      const items = digest.items.slice();
      for (const [id, n] of builds) { const q = g.player(Number(id)); if (q) items.push({ html: `${who(q)} bygde <b>${n} ${n === 1 ? 'hus' : 'bygg'}</b>`, prio: 70, n: 999 }); }
      const top = items.sort((a, b) => b.prio - a.prio).slice(0, 7).sort((a, b) => a.n - b.n);
      const more = items.length - top.length;
      resetDigest();
      return human(new Promise((resolve) => {
        const m = openModal(`${title('MENS DU VENTET', 'blue')}
          <ul class="digest">${top.map((it) => `<li>${it.html}</li>`).join('')}</ul>
          ${more > 0 ? `<p class="note">… og ${more} til. Alt står i hendelsesloggen.</p>` : ''}
          <div class="actions"><button type="button" class="btn go big" data-primary data-x>${pill('OK', null, ICO.check)}</button></div>`, { cls: 't-blue digest-modal' });
        $('[data-x]', m.el).addEventListener('click', () => { MP.Sound.click(); m.close(); resolve(); });
      }));
    },
    // Knappehintene rundt hovedvalget (rekkefølge som i Plus: Mine eiendommer · hovedvalg · Brettkart · Handel · Konkurs).
    propsAction(p) {
      return { label: 'Mine eiendommer', short: 'Eiendom', key: 'KeyE', cap: 'E', tone: 'w', title: 'Dine eiendommer: bygg, selg og pantsett (E)', onClick: () => this.openManage(p, null) };
    },
    commonActions(p) {
      const list = [
        { label: 'Brettkart', short: 'Kart', key: 'KeyM', cap: 'M', tone: 'x', title: 'Brettkart med bankinfo (M)', onClick: () => this.openMap() },
        { label: 'Handel', short: 'Handel', key: 'KeyH', cap: 'H', tone: 'y', title: 'Foreslå en handel (H)', onClick: () => this.openTrade(p) },
      ];
      if (this.canQuit()) list.push({ label: 'Konkurs', short: 'Konkurs', key: 'KeyK', cap: 'K', tone: 'r', cls: 'quit', title: 'Gi opp spillet (K)', onClick: () => this.askBankrupt() });
      return list;
    },
    // Frivillig konkurs: bare på egen tur, når spilleren selv har valget.
    canQuit() {
      const g = this.game, ph = this.phaseDone;
      return !!(g && !this.over && ph && ph.p === g.current && !ph.p.ai && typeof g.declareBankrupt === 'function');
    },
    askBankrupt(before) {
      if (!this.canQuit()) return;
      const g = this.game, ph = this.phaseDone, p = ph.p;
      this.confirm('GÅ KONKURS?', `${esc(p.name)} gir opp. Eiendommene går til banken og selges på auksjon. Det kan ikke angres.`, 'JA, GÅ KONKURS', async () => {
        if (before) before();
        if (this.phaseDone !== ph) return;
        this.setActions([]);
        // Konkursen vises ferdig (motoren avslutter selv hvis det gir en vinner).
        this.quitting = true;
        try { await g.declareBankrupt(p); } catch (e) { console.error(e); }
        this.quitting = false;
        ph.done();
      });
    },
    hideReach() { try { MP.Board3D.hideReach?.(); } catch (e) { console.warn(e); } },
    humanPhase(p, phase) {
      const pre = phase === 'pre';
      this.setTurnInfo(p, pre ? 'kast terningene' : 'bygg, handle eller avslutt turen');
      if (pre) {
        this.tab = { id: p.id, kind: 'dice' }; this.renderTab();
        // Tallskilt 2–12 på feltene man kan lande på (board3d).
        try { MP.Board3D.showReach?.(p.pos); } catch (e) { console.warn(e); }
      } else if (!(this.tab && this.tab.id === p.id && this.tab.kind === 'sum') && Array.isArray(this.game.s.lastDice)) {
        // Gjenopptatt etter kastet (lagret midt i turen): vis summen fra kastet.
        this.tab = { id: p.id, kind: 'sum', d: this.game.s.lastDice.slice(0, 2), speed: null }; this.renderTab();
      }
      return human(new Promise((resolve) => {
        const done = () => { this.phaseDone = null; if (pre) this.hideReach(); this.setActions([]); resolve(); };
        // Frivillig konkurs (menyen) avslutter fasen.
        this.phaseDone = { p, done };
        this.setActions([this.propsAction(p), pre
          ? { label: 'Kast terningene', short: 'Kast', icon: DICE_SMALL, cls: 'roll', primary: true, onClick: done }
          : { label: 'Avslutt tur', short: 'Avslutt', icon: ICO.check, cls: 'end', primary: true, onClick: done }, ...this.commonActions(p)]);
      }));
    },
    async rollDice(p, d, utility, speedDie) {
      this.hideReach();
      this.setActions([]);
      if (!skipping()) MP.Sound.dice();
      const sp = speedDie == null || utility ? null : speedDie;
      await (sp != null ? MP.Board3D.rollDice(d, sp) : MP.Board3D.rollDice(d));
      if (!utility) { this.tab = { id: p.id, kind: 'sum', d: d.slice(), speed: sp }; this.renderTab(); }
      const g = this.game;
      const snake = d[0] === 1 && d[1] === 1 && g && g.rules && g.rules.snakeEyes && !p.inJail;
      const triple = sp != null && sp === d[0] && d[0] === d[1];
      if (triple) splash('TRE LIKE!', 'purple', { icon: ICO.speed, sub: 'velg et felt', life: 1.4 });
      else if (d[0] === d[1] && !utility && !snake) splash('DOBBEL!', 'orange', { icon: ICO.dice, sub: `${d[0]} + ${d[1]}`, life: 1.4 });
      else if (sp === 'bus') splash('BUSS!', 'gold', { icon: ICO.bus, sub: 'velg hvor langt' });
      if (utility) toast(`Leien blir ${d[0] + d[1]} × kr 200`, '#FFC93C');
      await wait(300);
    },
    async animateMove(p, path) {
      this.setTurnInfo(p, 'flytter');
      await MP.Board3D.moveToken(p, path, this.game.s, () => { if (!skipping()) MP.Sound.step(); });
    },
    async toJail(p) {
      if (!skipping()) MP.Sound.bad();
      splash('I FENGSEL!', 'slate', { icon: ICO.jail, sub: esc(p.name) });
      note(`${who(p)} havnet i fengsel`, 40);
      await MP.Board3D.jumpToken(p, 10, true, this.game.s);
    },
    async rentPaid(p, owner, rent) {
      if (!skipping()) MP.Sound.pay();
      toast(`${pPortrait(p, 'xs')}<span>${esc(p.name)} betaler <b>${kr(rent)}</b> i leie til ${esc(owner.name)}</span>`, owner.color);
      note(`${who(p)} betalte <b>${kr(rent)}</b> i leie til ${who(owner)}`, rent >= 2000 ? 65 : 30);
      try { await capAnim(MP.Board3D.payAnim?.(p.id, owner.id, rent), 550); } catch (e) { console.warn(e); }
      await wait(650);
    },
    async taxPaid(p, amount, name) {
      if (!skipping()) MP.Sound.pay();
      toast(`${pPortrait(p, 'xs')}<span>${esc(p.name)} betaler ${esc(name.toLowerCase())}: <b>${kr(amount)}</b></span>`, '#F7941D');
      try { await capAnim(MP.Board3D.payAnim?.(p.id, null, amount), 700); } catch (e) { console.warn(e); }
      await wait(600);
    },
    async bought(p, i) {
      if (!skipping()) MP.Sound.buy();
      toast(`${pPortrait(p, 'xs')}<span>${esc(p.name)} kjøpte <b>${esc(SQ[i].name)}</b></span>`, sqColor(i));
      note(`${who(p)} kjøpte ${sqTag(i)} for ${kr(SQ[i].price)}`, 50);
      try { await capAnim(MP.Board3D.buyAnim?.(i, p.id), 700); } catch (e) { console.warn(e); }
      await wait(p.ai ? 650 : 300);
    },

    offerBuy(p, i) {
      const g = this.game, sq = SQ[i];
      this.setTurnInfo(p, 'kjøpe?');
      const kind = sq.type === 'street' ? 'GATE' : sq.type === 'station' ? 'STASJON' : 'VERK';
      // Skjøtet og valget ligger til høyre, så brettet og brikken synes (som i Plus).
      return human(new Promise((resolve) => {
        const m = openModal('', { cls: 'deed-panel buy-panel', side: true });
        m.frame.style.setProperty('--pc', p.color);
        const draw = () => {
          const enough = p.cash >= sq.price;
          m.set(`${dpHead(p.color, tokenSvg(p.token), p.name, `${kind.toLowerCase()} til salgs`)}
            ${deedHTML(g, i)}
            <div class="sticky-acts">
            <p class="buy-q">Ledig! Vil du kjøpe for <b>${kr(sq.price)}</b>?<small>Du har ${kr(p.cash)}${enough ? '' : ' – for lite. Pantsett eller selg for å skaffe penger.'}</small></p>
            <div class="deed-acts buy-acts">
              <div class="da-col"><span class="kc kc-sm kc-a">${PI.space}</span><button type="button" class="dact buy" data-buy ${enough ? 'data-primary' : 'disabled'} title="Kjøp (Mellomrom)">${PI.plusHouse}<span class="dv">−${kr(sq.price)}</span><small>KJØP</small></button></div>
              ${g.s.opts.auctions
                ? `<div class="da-col"><span class="kc kc-sm">A</span><button type="button" class="dact auction" data-no data-key="KeyA" title="Ikke kjøp – send eiendommen på auksjon (A)">${ICO.gavel}<span class="dv">AUKSJON</span><small>LA ANDRE BY</small></button></div>`
                : `<div class="da-col"><span class="kc kc-sm">N</span><button type="button" class="dact grey" data-no data-key="KeyN" title="Ikke kjøp (N)"><span class="dv">IKKE KJØP</span><small>LA DEN STÅ</small></button></div>`}
            </div>
            ${enough ? '' : `<div class="buy-raise"><button type="button" class="hint" data-raise data-key="KeyE">${keyCap('E', 'w')}<span class="hl"><span class="hl-l">Skaff penger</span></span></button></div>`}
            </div>`);
          $('[data-buy]', m.el).addEventListener('click', () => { m.close(); resolve(true); });
          $('[data-no]', m.el).addEventListener('click', () => { MP.Sound.click(); m.close(); resolve(false); });
          const r = $('[data-raise]', m.el);
          if (r) r.addEventListener('click', () => { m.wrap.hidden = true; syncBlur(); this.openManage(p, null, () => { m.wrap.hidden = false; syncBlur(); draw(); }); });
        };
        draw();
      }));
    },

    // ---------- io: auksjon ----------
    async auctionStart(i, bidders) {
      if (this.over) return;
      this.auc = { i, bidders, out: new Set(), high: 0, leader: null, bids: [] };
      this.auc.m = openModal('', { cls: 't-orange auc-modal' });
      this.drawAuction();
      await wait(500);
    },
    drawAuction(bidder, result, info) {
      const a = this.auc;
      if (!a) return;
      const sq = SQ[a.i];
      const people = a.bidders.map((b) => `<span class="${a.out.has(b.id) ? 'out' : ''} ${a.leader === b ? 'lead' : ''}" style="--pc:${b.color}">${pPortrait(b, 'xs')}${esc(b.name)}</span>`).join('');
      // Budhistorikk i spillerfarger, nyeste øverst.
      const hist = a.bids.slice(-5).reverse().map((b, n) => `<li class="${n === 0 ? 'new' : ''}" style="--pc:${b.p.color}">${pPortrait(b.p, 'xs')}<span class="nm">${esc(b.p.name)}</span><b>${kr(b.v)}</b></li>`).join('');
      let controls = '';
      if (bidder) {
        const opts = [a.high + 100, a.high + 500, a.high + 1000];
        // F5: ingen budknapp er hovedknapp – Mellomrom betyr PASS, bud krever et eget klikk.
        controls = `<div class="sticky-acts">${whoHead(bidder, 'ditt bud?')}<p class="auc-ask"><span class="note">Du har ${kr(bidder.cash)}</span></p>
          <div class="auc-controls">${opts.map((v) => `<button type="button" class="btn go" data-bid="${v}" ${v > bidder.cash ? 'disabled' : ''}>${pill('BY', kr(v), ICO.notes)}</button>`).join('')}</div>
          <div class="auc-controls"><span class="auc-own"><input type="number" min="${a.high + 10}" step="100" placeholder="Eget bud" data-custom aria-label="Eget bud"><button type="button" class="btn small blue" data-own>${pill('BY')}</button></span>
          <button type="button" class="btn sky" data-pass data-primary>${pill('PASS')}</button></div></div>`;
      }
      a.m.set(`${title('AUKSJON!', 'orange')}
        <div class="auc-top">${deedHTML(this.game, a.i, true)}<div class="auc-info">
          <span class="auc-gavel">${ICO.gavel}</span>
          <div class="auc-label">Høyeste bud</div>
          <div class="auc-bid" ${a.leader ? `style="--pc:${a.leader.color}"` : ''}>${a.high ? kr(a.high) : '—'}</div>
          <div class="auc-lead">${a.leader ? `${pPortrait(a.leader, 'xs')} ${esc(a.leader.name)} leder` : `Ingen bud ennå · verdi ${kr(sq.price)}`}</div>
          <div class="auc-people">${people}</div></div></div>
        ${hist ? `<ol class="auc-hist" aria-label="Bud">${hist}</ol>` : ''}${info ? `<p class="auc-skip">${info}</p>` : ''}${controls}${result ? `<p class="auc-result">${result}</p>` : ''}`);
    },
    auctionBid(p, i, high) {
      if (this.over || !this.auc) return Promise.resolve(0);
      this.auc.high = high;
      // Har man ikke råd til laveste bud (+kr 100), står man over automatisk – uten å stoppe Hopp over.
      if (p.cash < high + 100) {
        toast(`${pPortrait(p, 'xs')}<span>Du har ikke råd – <b>${esc(p.name)}</b> står over</span>`, p.color, 1.8);
        this.drawAuction(null, null, `${esc(p.name)} har ${kr(p.cash)} – for lite til å by`);
        return wait(500).then(() => 0);
      }
      this.setTurnInfo(p, 'by på auksjonen');
      return human(new Promise((resolve) => {
        this.drawAuction(p);
        const el = this.auc.m.el;
        el.querySelectorAll('[data-bid]').forEach((b) => b.addEventListener('click', () => resolve(Number(b.dataset.bid))));
        $('[data-pass]', el).addEventListener('click', () => resolve(0));
        const own = () => {
          const v = Math.floor(Number($('[data-custom]', el).value));
          if (v > high && v <= p.cash) resolve(v); else toast(`Budet må være over ${kr(high)} og innenfor det du har`, '#E3242B', 2.4, true);
        };
        $('[data-own]', el).addEventListener('click', own);
        $('[data-custom]', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); own(); } });
      }));
    },
    async auctionUpdate(i, leader, high, dropped) {
      const a = this.auc;
      if (!a || this.over) return;
      if (leader && high > a.high) a.bids.push({ p: leader, v: high });
      a.high = high; a.leader = leader;
      if (dropped) a.out.add(dropped.id);
      this.drawAuction();
      if (!skipping()) MP.Sound.click();
      const humanIn = a.bidders.some((b) => !b.ai && !a.out.has(b.id));
      await wait(humanIn ? (dropped ? 250 : 450) : (dropped ? 120 : 220));
    },
    async auctionEnd(i, leader, high) {
      const a = this.auc;
      if (!a || this.over) { this.auc = null; return; }
      a.high = high; a.leader = leader;
      this.drawAuction(null, leader ? `${ICO.gavel}${esc(leader.name)} vant for ${kr(high)}!` : 'Ingen bød – gaten forblir ledig.');
      if (leader) note(`${who(leader)} vant auksjonen over ${sqTag(i)} for ${kr(high)}`, 50);
      if (leader && !skipping()) MP.Sound.buy();
      await wait(leader ? 700 : 1100);
      a.m.close();
      this.auc = null;
      if (leader) splash('AUKSJON VUNNET!', 'orange', { icon: ICO.gavel, sub: `${esc(leader.name)} · ${kr(high)}` });
      if (leader) { try { await capAnim(MP.Board3D.buyAnim?.(i, leader.id), 850); } catch (e) { console.warn(e); } }
    },

    // ---------- io: kort ----------
    async showCard(p, type, card) {
      // Datamaskinen, eller (online) en spiller på en annen skjerm: bare et varsel her.
      const watch = p.ai || !this.mine(p);
      if (!watch) setSkip(false);
      if (!skipping()) MP.Sound.card();
      await capAnim(MP.Board3D.drawCard(type), 900);
      if (watch && skipping()) return;
      const chance = type === 'chance';
      // Datamaskinens kort vises som et kort varsel (ikke et panel), så turen går raskt.
      if (watch) {
        toast(`<span class="tc-card ${chance ? 'chance' : 'chest'}">${cardIcon(card)}</span><span><b>${esc(p.name)} · ${chance ? 'Sjanse' : 'Prøv lykken'}:</b> ${esc(card.text)}</span>`, chance ? '#F7941D' : '#2b8ae8', 2.4);
        await wait(2300);
        return;
      }
      const run = new Promise((resolve) => {
        const m = openModal(`${cardHTML(p, type, card)}
          <div class="actions"><button type="button" class="btn ${p.ai ? 'sky' : chance ? 'orange big' : 'blue big'}" data-primary data-ok data-x>${pill('OK', null, ICO.check)}</button></div>`, { clear: p.ai, cls: 'bare', noX: true });
        let closed = false;
        // Modalen fjernes straks, så brettet er fritt når brikken begynner å gå.
        const close = () => { if (closed) return; closed = true; m.close(); resolve(); };
        $('[data-ok]', m.el).addEventListener('click', close);
        if (p.ai) wait(2600).then(close);
      });
      return p.ai ? run : human(run);
    },
    // Husregelen «Start og flytting»: Sjanse-kort er valgfrie for mennesker.
    chanceChoice(p) {
      this.setTurnInfo(p, 'trekke Sjanse?');
      return human(new Promise((resolve) => {
        const m = openModal(`${whoHead(p, 'Sjanse')}
          <div class="cc-card" aria-hidden="true"><span>?</span></div>
          <p class="cc-q">Trekke Sjanse-kort?</p>
          <p class="note">Husregelen «Start og flytting» lar deg hoppe over kortet.</p>
          <div class="actions"><button type="button" class="btn orange big" data-primary data-draw>${pill('TREKK', null, ICO.cards)}</button>
          <button type="button" class="btn sky" data-skip>${pill('HOPP OVER')}</button></div>`, { cls: 't-orange chance-choice' });
        const pick = (v) => { MP.Sound.click(); m.close(); resolve(v); };
        $('[data-draw]', m.el).addEventListener('click', () => pick(true));
        $('[data-skip]', m.el).addEventListener('click', () => pick(false));
      }));
    },

    // ---------- io: fengsel ----------
    jailChoice(p) {
      const g = this.game;
      this.setTurnInfo(p, `i fengsel · forsøk ${p.jailTurns + 1} av 3`);
      return human(new Promise((resolve) => {
        const pick = (c) => { this.setActions([]); resolve(c); };
        const left = 3 - p.jailTurns;
        // Lang etikett på store skjermer, kort på mobil (så teksten ikke klippes).
        this.setActions([
          this.propsAction(p),
          { label: `Kast for dobbel (${left} igjen)`, short: `Kast (${left})`, icon: DICE_SMALL, cls: 'roll', primary: true, title: 'Kast for dobbel (Mellomrom)', onClick: () => pick('roll') },
          { label: `Betal ${kr(RULES.jailFine)}`, short: 'Betal', key: 'KeyB', cap: 'B', tone: 'b', disabled: !g.canPayFine(p), title: g.canPayFine(p) ? 'Betal boten og kom ut (B)' : 'Du har ikke nok verdier', onClick: () => pick('pay') },
          ...(p.jailCards.length ? [{ label: 'Bruk kort', short: 'Kort', key: 'KeyF', cap: 'F', tone: 'y', icon: ICO.key, title: 'Bruk «Kom ut av fengselet»-kortet (F)', onClick: () => pick('card') }] : []),
          ...this.commonActions(p),
        ], `i fengsel · forsøk ${p.jailTurns + 1} av 3`);
      }));
    },

    // ---------- io: penger ----------
    raiseFunds(p, amount, creditor) {
      // F12: bunnlinjen viser gjeldsstatus mens dialogen er åpen.
      this.setTurnInfo(p, `skaff ${kr(amount)}`);
      $('#dock').classList.add('has-acts');
      return human(new Promise((resolve) => this.openManage(p, { amount, creditor, resolve })))
        .finally(() => { if (!$('#actions').children.length) $('#dock').classList.remove('has-acts'); });
    },
    async bankrupt(p, creditor) {
      MP.Sound.bad();
      (this.outOrder = this.outOrder || []).push(p.id);
      splash('KONKURS!', 'red', { icon: pPortrait(p, 'lg'), sub: esc(p.name), life: 1.6, ai: false });
      note(`${who(p)} gikk konkurs${creditor ? ` – ${who(creditor)} overtar alt` : ''}!`, 100, true);
      if (skipping()) toast(`${ICO.broke}${pPortrait(p, 'xs')}<span>${esc(p.name)} er konkurs!</span>`, '#E3242B', 2.4, true);
      this.render();
      // Brikken velter og forsvinner (board3d) før den skjules for godt.
      try { await MP.Board3D.bankruptAnim?.(p.id); } catch (e) { console.warn(e); }
      if (this.dying) this.dying.delete(p.id);
      this.render();
      await wait(500);
    },

    // ---------- Forvaltning (bygg, selg, pantsett) ----------
    openManage(p, debt, onClose) {
      const g = this.game;
      const isTurn = g.current === p && !p.ai && this.mine(p) && pendingHuman > 0;
      const canAct = (isTurn || !!debt) && !p.bankrupt;
      const m = openModal('', { wide: true, onBackdrop: debt ? null : () => close(), cls: debt ? 't-red' : 't-pink' });
      const close = () => { m.close(); if (onClose) onClose(); };
      let view = null; // null = oversikt, ellers feltindeks for skjøtevisning
      const need = () => (debt ? debt.amount - p.cash : 0);
      const debtBar = () => (debt ? `<div class="mg-debt">Du må betale ${kr(debt.amount)}${debt.creditor ? ` til ${esc(debt.creditor.name)}` : ' til banken'}. ${need() > 0 ? `Du mangler <b>${kr(need())}</b> – selg hus, pantsett eller handle deg ut av det.` : 'Du har nok penger nå!'}
        <div class="mg-short"><button type="button" class="btn small purple" data-short="props">${pill('Mine eiendommer', null, ICO.props)}</button><button type="button" class="btn small teal" data-short="trade">${pill('Handel', null, ICO.trade)}</button><button type="button" class="btn small sky" data-short="board">${pill('Se brettet')}</button></div></div>` : '');
      const mine = !p.ai && this.mine(p) && (g.current === p || !!debt);
      const gen = p.name.toUpperCase() + (/[SXZ]$/.test(p.name.toUpperCase()) ? '’' : 'S');
      const head = () => `${title(debt ? 'SKAFF PENGER' : mine ? 'DINE EIENDOMMER' : `${esc(gen)} EIENDOMMER`, debt ? 'red' : 'pink')}
        <div class="mg-head"><div class="who" style="--pc:${p.color}">${pPortrait(p, 'md')}<span>${esc(p.name)}</span></div>
          <span class="money-pill"><small>KONTANTER</small>${kr(p.cash)}</span></div>${debtBar()}`;
      const drawDeed = () => {
        const i = view;
        m.set(`${head()}<div class="deed-view"><div class="dv-card">${deedHTML(g, i)}</div><div class="dv-side">
          ${canAct ? deedActsHTML(g, p, i, !!debt) : `<p class="note">${p.ai ? 'Datamaskinens eiendom.' : 'Du kan bygge og pantsette når det er din tur.'}</p>`}
          <div class="actions"><button type="button" class="btn sky" data-back ${debt ? '' : 'data-primary'}>${pill('‹ Alle eiendommer')}</button>
          ${debt ? '' : '<button type="button" class="btn sky" data-x>' + pill('Lukk') + '</button>'}</div></div></div>`);
        if (canAct) wireDeedActs(m.el, g, p, i, drawDeed);
        $('[data-back]', m.el).addEventListener('click', () => { MP.Sound.click(); view = null; draw(); });
        const x = $('[data-x]', m.el); if (x) x.addEventListener('click', close);
        wireShort();
      };
      // Snarveier i gjeldsdialogen: Mine eiendommer, Handel og Se brettet.
      const wireShort = () => {
        $$('[data-short]', m.el).forEach((b) => b.addEventListener('click', async () => {
          MP.Sound.click();
          const k = b.dataset.short;
          if (k === 'props') { view = null; draw(); const grid = $('.mg-grid', m.el); if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
          if (k === 'trade') { await this.openTrade(p); draw(); return; }
          if (k === 'board') {
            m.wrap.hidden = true; syncBlur();
            const back = h(`<div class="peek-back"><button type="button" class="btn go big" data-primary>${pill('TILBAKE TIL GJELDEN')}</button></div>`);
            document.body.appendChild(back);
            $('button', back).addEventListener('click', () => { MP.Sound.click(); back.remove(); m.wrap.hidden = false; syncBlur(); draw(); });
            $('button', back).focus({ preventScroll: true });
          }
        }));
      };
      const draw = () => {
        if (view != null) { drawDeed(); return; }
        const props = g.propsOf(p).sort((a, b) => a - b);
        const items = props.map((i) => {
          const sq = SQ[i], pr = g.s.props[i];
          // Gjeldsdialogen: bare salg, pantsetting og handel (QA N7).
          const off = { ok: false, why: DEBT_WHY };
          const cb = debt ? off : g.canBuild(p, i), cs = g.canSellHouse(p, i), cm = g.canMortgage(p, i), cu = debt ? off : g.canUnmortgage(p, i);
          const hd = debt ? null : hotelDirect(g, p, i);
          const houses = pr.houses === 5 ? '<span class="houses" title="Hotell"><i class="hh"></i></span>' : `<span class="houses" title="${pr.houses} hus">${'<i class="hn"></i>'.repeat(pr.houses)}</span>`;
          const btns = !canAct ? '' : `<div class="btns">
            ${sq.type === 'street' ? `<button type="button" class="btn go small" data-a="build" data-i="${i}" ${cb.ok ? '' : 'disabled'} title="${esc(cb.ok ? '' : cb.why)}">${pill(`+${pr.houses === 4 ? 'Hotell' : 'Hus'}`, kr(GROUPS[sq.group].house))}</button>
            ${hd && hd.ok ? `<button type="button" class="btn red small" data-a="hotel" data-i="${i}" title="Fri bygging: hotell direkte">${pill('+Hotell', kr(hd.cost))}</button>` : ''}
            <button type="button" class="btn sky small" data-a="sell" data-i="${i}" ${cs.ok ? '' : 'disabled'} title="${esc(cs.ok ? '' : cs.why)}">${pill('Selg', cs.ok ? '+' + kr(cs.value) : '–')}</button>` : ''}
            ${pr.mortgaged
              ? `<button type="button" class="btn blue small" data-a="unmort" data-i="${i}" ${cu.ok ? '' : 'disabled'} title="${esc(cu.ok ? '' : cu.why)}">${pill('Innløs', '−' + kr(g.unmortgageCost(i)))}</button>`
              : `<button type="button" class="btn mort small" data-a="mort" data-i="${i}" ${cm.ok ? '' : 'disabled'} title="${esc(cm.ok ? '' : cm.why)}">${pill('Pantsett', '+' + kr(sq.price / 2))}</button>`}
          </div>`;
          const rentNow = g.rentFor(i, 7);
          return `<div class="mg-item ${pr.mortgaged ? 'mort' : ''}" style="--c:${sqColor(i)}"><button type="button" class="mg-open" data-deed="${i}" title="Vis skjøtet">
              <span class="bar"></span><span class="t"><span>${esc(sq.name)}</span>${houses}</span>
              <span class="sub">${pr.mortgaged ? 'Pantsatt – gir ingen leie' : sq.type === 'utility' ? `Leie: kr ${g.countOwned(p, MP.UTILITIES) === 2 ? 200 : 80} per øye` : `Leie nå: ${kr(rentNow)}`}<em>Skjøte ›</em></span></button>
            <div class="body">${btns}</div></div>`;
        }).join('');
        m.set(`${head()}
          ${props.length ? `<div class="mg-grid">${items}</div>` : '<div class="empty">Ingen eiendommer ennå.</div>'}
          ${!canAct && !debt && !p.bankrupt ? `<p class="note">${p.ai ? 'Datamaskinens eiendommer.' : 'Du kan bygge og pantsette når det er din tur.'}</p>` : ''}
          <p class="note">${debt ? 'Mens du skylder penger kan du bare selge hus, pantsette eller handle. ' : ''}Trykk på en eiendom for å se skjøtet. ${g.rules?.freeBuild ? 'Fri bygging: du kan bygge uten hel fargegruppe.' : 'Hus bygges jevnt i en hel fargegruppe.'} Pantsatte eiendommer gir ingen leie; innløsning koster pantelånet + 10 %.</p>
          <div class="actions sticky-acts">${debt
            ? `<button type="button" class="btn go big" data-pay ${need() > 0 ? 'disabled' : 'data-primary'}>${pill('BETAL', kr(debt.amount), ICO.notes)}</button><button type="button" class="btn danger-ghost" data-broke>${pill('Gå konkurs')}</button>`
            : `<button type="button" class="btn sky" data-primary data-x>${pill('Lukk')}</button>`}</div>`);
        wireShort();
        m.el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
          const i = Number(b.dataset.i);
          MP.Sound.click();
          if (b.dataset.a === 'sell') { sellChecked(g, p, i, draw, m.el); return; }
          act(m.el, ({ build: () => g.build(p, i), mort: () => g.mortgage(p, i), unmort: () => g.unmortgage(p, i), hotel: () => g.buildHotel?.(p, i) })[b.dataset.a], draw);
        }));
        m.el.querySelectorAll('[data-deed]').forEach((b) => b.addEventListener('click', () => { MP.Sound.click(); view = Number(b.dataset.deed); draw(); m.el.scrollTop = 0; }));
        const x = $('[data-x]', m.el); if (x) x.addEventListener('click', close);
        const pay = $('[data-pay]', m.el); if (pay) pay.addEventListener('click', () => { m.close(); debt.resolve(); });
        const broke = $('[data-broke]', m.el);
        if (broke) broke.addEventListener('click', () => {
          if (broke.dataset.sure) { m.close(); debt.resolve(); return; }
          broke.dataset.sure = '1'; broke.innerHTML = pill('SIKKER?', 'trykk igjen');
        });
      };
      draw();
    },

    // ---------- Handel (Plus-skjerm: mini-skjøter, −/+ for penger, total verdi, advarsler) ----------
    // Returnerer et løfte som løses når handelen er avgjort eller avbrutt.
    openTrade(p, pre = null) {
      const g = this.game;
      const others = g.active.filter((o) => o !== p);
      if (!others.length) return Promise.resolve(null);
      return new Promise((done) => {
        let other = (pre && pre.other && others.includes(pre.other)) ? pre.other : others[0];
        const sel = { give: new Set(pre?.give?.props || []), get: new Set(pre?.get?.props || []) };
        const cash = { give: pre?.give?.cash || 0, get: pre?.get?.cash || 0 };
        const jail = { give: pre?.give?.jailCards || 0, get: pre?.get?.jailCards || 0 };
        // «Innløs straks» for pantsatte eiendommer p får (t.get.unmortgage).
        const um = new Set(pre?.get?.unmortgage || []);
        const umList = () => (tradeUnmortgageOK(g) ? [...um].filter((i) => sel.get.has(i) && g.s.props[i]?.mortgaged) : []);
        let finished = false;
        const m = openModal('', { wide: true, onBackdrop: () => finish(null), cls: 't-green trade-modal' });
        const finish = (r) => { if (finished) return; finished = true; m.close(); done(r); };
        const tradable = (i) => !(SQ[i].type === 'street' && g.groupHasBuildings(SQ[i].group));
        const buildT = () => ({
          from: p.id, to: other.id,
          give: { props: [...sel.give], cash: cash.give, jailCards: jail.give },
          get: { props: [...sel.get], cash: cash.get, jailCards: jail.get, ...(umList().length ? { unmortgage: umList() } : {}) },
        });
        // Plus: «VIL HA» (grønn fane, den andres eiendommer) og «TILBYR» (blå fane, dine). Trykk kortene for å velge.
        const col = (owner, side) => {
          const props = g.propsOf(owner).sort((a, b) => a - b);
          const cards = props.map((i) => miniDeed(g, i, { sel: sel[side].has(i), dis: !tradable(i), side })).join('') || '<div class="tx-none">Ingen eiendommer</div>';
          const body = `<div class="tr-cards">${cards}</div>
            <div class="tr-money"><span class="tm-l">${ICO.notes}Penger <small>(har ${kr(owner.cash)})</small></span>${stepper(side, cash[side], owner.cash)}</div>
            ${owner.jailCards.length ? `<div class="tr-money"><span class="tm-l">${ICO.key}Fengselskort</span>${stepper('j' + side, jail[side], owner.jailCards.length, 1)}</div>` : ''}`;
          return side === 'get' ? txCol('wants', 'VIL HA', p, body, `fra ${esc(owner.name)}`) : txCol('offers', 'TILBYR', p, body, 'du gir');
        };
        const draw = () => {
          if (finished) return;
          const keepScroll = m.el.scrollTop;
          for (const s of ['give', 'get']) { const o = s === 'give' ? p : other; cash[s] = Math.min(cash[s], o.cash); jail[s] = Math.min(jail[s], o.jailCards.length); }
          const t = buildT();
          const issue = g.tradeIssues(t);
          m.set(`${txTop(p, pre && pre.returnOnly ? `${esc(p.name)}, lag motbudet til ${esc(other.name)}` : `${esc(p.name)}, hva vil du bytte?`)}
            <div class="tr-pick seg tabs" role="group" aria-label="Handle med"><span class="tr-pick-l">Handle med</span>${(pre && pre.returnOnly ? [other] : others).map((o) => `<button type="button" class="${o === other ? 'on' : ''}" aria-pressed="${o === other}" data-o="${o.id}" style="--pc:${o.color}">${SEG_CHECK}<span class="tx-tok">${tokenSvg(o.token)}</span><span>${esc(o.name)}${o.ai ? ' (data)' : ''}</span></button>`).join('')}</div>
            <div class="tx-cols">${col(other, 'get')}${col(p, 'give')}</div>
            ${unmortHTML(g, [...sel.get], um)}
            ${tradeValueBar(g, t, p, other, 'Du gir', 'Du får')}
            ${txParties(g, p, other)}
            <p class="note">${other.ai ? 'Datamaskinen godtar handler som lønner seg for den – ellers kan den komme med et motbud.' : `${esc(other.name)} får se tilbudet på skjermen.`}</p>
            <div class="sticky-acts">${tradeWarnings(g, t, p, other)}${issue && (t.give.props.length || t.get.props.length || t.give.cash || t.get.cash) ? `<p class="tr-issue">${esc(issue)}</p>` : ''}
            <div class="actions"><button type="button" class="btn go big" data-send ${issue ? 'disabled' : ''} title="${esc(issue || 'Send tilbudet')}">${pill(pre && pre.returnOnly ? 'SEND MOTBUD' : 'SEND TILBUD', null, ICO.trade)}</button><button type="button" class="btn sky" data-x>${pill('Avbryt')}</button></div></div>`);
          m.el.scrollTop = keepScroll;
          m.el.querySelectorAll('[data-um]').forEach((c) => c.addEventListener('change', () => { const i = Number(c.dataset.um); if (c.checked) um.add(i); else um.delete(i); MP.Sound.click(); draw(); }));
          m.el.querySelectorAll('[data-o]').forEach((b) => b.addEventListener('click', () => { MP.Sound.click(); other = g.player(Number(b.dataset.o)); sel.get.clear(); cash.get = 0; jail.get = 0; draw(); }));
          m.el.querySelectorAll('.tcard[data-i]').forEach((d) => d.addEventListener('click', () => {
            const i = Number(d.dataset.i); if (!tradable(i)) { toast('Selg byggene i fargegruppen først', '#E3242B', 2, true); return; }
            const s = sel[d.dataset.side]; s.has(i) ? s.delete(i) : s.add(i);
            MP.Sound.click(); draw();
          }));
          m.el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
            const k = b.closest('[data-stepper]').dataset.stepper, v = Number(b.dataset.step);
            if (k === 'jgive' || k === 'jget') { const s = k.slice(1); const o = s === 'give' ? p : other; jail[s] = Math.max(0, Math.min(o.jailCards.length, jail[s] + v)); } else { const o = k === 'give' ? p : other; cash[k] = Math.max(0, Math.min(o.cash, cash[k] + v)); }
            MP.Sound.click(); draw();
          }));
          $('[data-x]', m.el).addEventListener('click', () => { MP.Sound.click(); finish(null); });
          $('[data-send]', m.el).addEventListener('click', async () => {
            const tt = buildT();
            const why = g.tradeIssues(tt);
            if (why) { toast(esc(why), '#E3242B', 2.4, true); return; }
            finished = true; m.close();
            if (pre && pre.returnOnly) { done(tt); return; }
            const t0 = performance.now();
            let r = null;
            this.proposing = tt;
            try { r = await g.proposeTrade(tt); } catch (e) { console.error(e); r = { ok: false, why: 'Noe gikk galt' }; } finally { this.proposing = null; }
            if (this.over) { done(r); return; }
            const evSeen = this.tradeEv && this.tradeEv.at >= t0 && !this.tradeEv.own;
            if (r && r.ok) { if (!evSeen) this.tradeSplash(true, p, other); done(r); return; }
            if (r && r.counter) { const acc = await this.showCounter(r.counter); done({ ok: acc, counter: r.counter }); return; }
            // Nei uten motbud: vis grunnen og hva datamaskinen vil ha. Motoren gir r.why (kort grunn på norsk)
            // og r.minCash (kr i tillegg til pengene i tilbudet).
            const min = Math.round(Number(r && r.minCash) || 0);
            const plain = `${other.name} sa nei`;
            let reason = String((r && r.why && r.why !== plain ? r.why : '') || '').replace(/\.$/, '');
            const want = min > 0 ? `${other.name} vil ha minst ${kr(min)}${tt.give.cash ? ' mer' : ''}` : '';
            this.tradeSplash(false, p, other, want ? esc(want) : null);
            // Grunnen som varsel (den lærer barna å forhandle); er grunnen bare beløpet, kommer et tips i stedet.
            const tip = min > 0 ? `Legg til minst <b>${kr(min)}</b> i tilbudet, så sier ${esc(other.name)} ja.` : '';
            if (reason && reason !== want) toast(`${ICO.thumbDown}<span><b>${esc(other.name)} sa nei:</b> ${esc(reason)}.${tip && !/minst/.test(reason) ? ` ${tip}` : ''}</span>`, '#E3242B', 3.8, true);
            else if (tip) toast(`${ICO.notes}<span>${tip}</span>`, '#E3242B', 3.8, true);
            done(r);
          });
        };
        draw();
      });
    },
    // Motbud fra datamaskinen (motoren lager det): vis som et tilbud man kan godta eller avslå.
    showCounter(c) {
      const g = this.game, a = g.player(c.from), b = g.player(c.to);
      MP.Sound.turn();
      return human(new Promise((resolve) => {
        // Valget fra eget tilbud følger med i motbudet (motoren beholder c.give.unmortgage).
        const um = new Set((c.give.unmortgage || []).map(Number));
        const m = openModal('', { wide: true, cls: 't-orange trade-modal' });
        const withUm = () => { const l = tradeUnmortgageOK(g) ? [...um].filter((i) => (c.give.props || []).includes(i)) : []; if (l.length) c.give.unmortgage = l; else delete c.give.unmortgage; };
        const draw = () => {
          withUm();
          const keep = m.el.scrollTop;
          m.set(`${txTop(a, `<em class="tx-tag">MOTBUD</em> ${esc(a.name)} sa nei, men foreslår dette. ${esc(b.name)}, godtar du?`)}
          ${offerHTML(g, c, a, b)}
          ${unmortHTML(g, c.give.props, um)}
          <div class="sticky-acts">${tradeWarnings(g, { from: b.id, to: a.id, give: c.get, get: c.give }, b, a)}
          <div class="actions"><button type="button" class="btn go big" data-y>${pill('GODTA', null, ICO.check)}</button><button type="button" class="btn sky" data-n data-x>${pill('AVSLÅ')}</button></div></div>`);
          m.el.scrollTop = keep;
          m.el.querySelectorAll('[data-um]').forEach((x) => x.addEventListener('change', () => { const i = Number(x.dataset.um); if (x.checked) um.add(i); else um.delete(i); MP.Sound.click(); draw(); }));
          $('[data-y]', m.el).addEventListener('click', () => { MP.Sound.click(); finish(true); });
          $('[data-n]', m.el).addEventListener('click', () => { MP.Sound.click(); finish(false); });
        };
        const finish = (yes) => {
          m.close();
          if (yes) {
            withUm();
            const issue = g.tradeIssues(c);
            if (issue) { toast(esc(issue), '#E3242B', 2.6, true); resolve(false); return; }
            const t0 = performance.now();
            // Online-klienten: verten utfører handelen og svarer (hendelsen «tradeDone» kommer først).
            Promise.resolve(g.executeTrade(c)).then((ok) => {
              if (ok && !(this.tradeEv && this.tradeEv.at >= t0)) this.tradeSplash(true, a, b);
              this.scheduleRender();
              resolve(!!ok);
            });
            return;
          }
          resolve(yes);
        };
        draw();
      }));
    },
    // Et tilbud til et menneske: Godta, Motbud eller Avslå (som i Plus).
    tradeOffer(t) {
      const g = this.game, a = g.player(t.from), b = g.player(t.to);
      MP.Sound.turn();
      return human(new Promise((resolve) => {
        // Mottakeren (b) kan velge «Innløs straks» for pantsatte eiendommer i t.give.
        const um = new Set((t.give.unmortgage || []).map(Number));
        const withUm = () => { const l = tradeUnmortgageOK(g) ? [...um].filter((i) => (t.give.props || []).includes(i)) : []; if (l.length) t.give.unmortgage = l; else delete t.give.unmortgage; };
        const m = openModal('', { wide: true, cls: 't-green trade-modal' });
        const draw = () => {
          withUm();
          const keep = m.el.scrollTop;
          const issue = um.size ? g.tradeIssues(t) : null;
          m.set(`${txTop(b, `${esc(b.name)}, godtar du tilbudet fra ${esc(a.name)}?`)}
          ${offerHTML(g, t, a, b)}
          ${unmortHTML(g, t.give.props, um)}
          <div class="sticky-acts">${tradeWarnings(g, { from: b.id, to: a.id, give: t.get, get: t.give }, b, a)}${issue ? `<p class="tr-issue">${esc(issue)}</p>` : ''}
          <div class="actions"><button type="button" class="btn go big" data-y ${issue ? 'disabled' : ''}>${pill('GODTA', null, ICO.check)}</button><button type="button" class="btn orange" data-c>${pill('MOTBUD')}</button><button type="button" class="btn sky" data-n data-x>${pill('AVSLÅ')}</button></div></div>`);
          m.el.scrollTop = keep;
          m.el.querySelectorAll('[data-um]').forEach((x) => x.addEventListener('change', () => { const i = Number(x.dataset.um); if (x.checked) um.add(i); else um.delete(i); MP.Sound.click(); draw(); }));
          wire();
        };
        const wire = () => {
          $('[data-y]', m.el).addEventListener('click', () => { MP.Sound.click(); withUm(); m.close(); resolve(true); });
          $('[data-n]', m.el).addEventListener('click', () => { MP.Sound.click(); delete t.give.unmortgage; m.close(); resolve(false); });
          $('[data-c]', m.el).addEventListener('click', async () => {
            delete t.give.unmortgage;
            MP.Sound.click();
            m.close();
            // Motbud: mottakeren fyller ut handelen ferdig; motoren får den som svar (counter-objekt).
            const ct = await this.openTrade(b, { other: a, give: t.get, get: t.give, returnOnly: true });
            if (!ct) { resolve(false); return; }
            const t0 = performance.now();
            resolve(ct);
            // Datamaskinen vurderer motbudet straks; sa den nei, vises det tydelig.
            if (a.ai) setTimeout(() => { if (!this.over && !(this.tradeEv && this.tradeEv.type === 'tradeDone' && this.tradeEv.at >= t0)) this.tradeSplash(false, b, a); }, 80);
          });
        };
        draw();
      }));
    },
    // ---------- Brettkart (Plus «Board Map») ----------
    // Venstre: BANKINFO (ledige eiendommer, hus og hoteller igjen). Midten: flatt brett med markør
    // (piltaster/klikk). Høyre: skjøtet for feltet markøren står på – med bygg/pantsett på egen tur.
    openMap(start) {
      const g = this.game;
      if (!g || this.mapDraw) return;
      let cur = Number.isInteger(start) ? start : (g.current ? g.current.pos : 0);
      const m = openModal('', { cls: 'map-modal', wide: true });
      m.wrap.classList.add('map-wrap');
      const close = () => {
        document.removeEventListener('keydown', onKey, true);
        if (this.mapDraw === draw) this.mapDraw = null;
        document.body.classList.remove('map-open');
        m.close();
      };
      // Kartet har egne spillerkort og egen bunnlinje: HUD-en skjules imens.
      document.body.classList.add('map-open');
      const draw = () => {
        if (!m.wrap.isConnected) { close(); return; }
        const p = g.current;
        const scroll = m.el.scrollTop;
        // Venstre panel: BANKINFO.
        const ownable = SQ.map((_, i) => i).filter((i) => MP.isOwnable(i));
        const free = ownable.filter((i) => g.s.props[i].owner == null).length;
        const hl = g.s.hotelsLeft ?? RULES.hotels, hsl = g.s.housesLeft ?? RULES.houses;
        const bank = `<aside class="mb">
          <div class="mb-head">BANKINFO</div>
          <div class="mb-row mb-free"><b>${free}</b><span>${free === 1 ? 'LEDIG EIENDOM' : 'LEDIGE EIENDOMMER'}</span></div>
          <div class="mb-grid">${GRID.map((col) => `<span class="gcol">${col.map((i) => {
            const o = g.ownerOf(i);
            return `<i class="mbc ${o ? 'own' : 'free'} ${i === cur ? 'cur' : ''}" data-sq="${i}" style="--c:${sqColor(i)};--pc:${o ? o.color : 'transparent'}" title="${esc(SQ[i].name)} – ${o ? esc(o.name) : 'ledig'}"></i>`;
          }).join('')}</span>`).join('')}</div>
          <div class="mb-row">${PI.house('#3fcf4f')}<b>${hsl}</b><span>HUS IGJEN</span></div>
          <div class="mb-row">${PI.house('#e3242b')}<b>${hl}</b><span>${hl === 1 ? 'HOTELL' : 'HOTELLER'} IGJEN</span></div></aside>`;
        // Midten: flatt brett.
        const tiles = SQ.map((sq, i) => {
          const [r, c] = MAP_RC[i], pr = g.s.props[i];
          const o = pr && pr.owner != null ? g.player(pr.owner) : null;
          const houses = pr && pr.houses ? `<span class="mt-h">${pr.houses === 5 ? '<b class="hot"></b>' : '<b></b>'.repeat(pr.houses)}</span>` : '';
          return `<button type="button" class="mt s-${mapSide(i)} ${sq.group ? 'st' : ''} ${i === cur ? 'cur' : ''} ${pr && pr.mortgaged ? 'mort' : ''}" data-sq="${i}" style="grid-row:${r + 1};grid-column:${c + 1};--c:${sq.group ? GROUPS[sq.group].color : 'transparent'}" title="${esc(sq.name)}${o ? ' – ' + esc(o.name) : ''}" aria-label="${esc(sq.name)}">
            ${o ? `<i class="mt-own" style="--pc:${o.color}"></i>` : ''}<span class="mt-g">${mapGlyph(i)}</span>${houses}</button>`;
        }).join('');
        const here = {};
        for (const q of g.players) if (!q.bankrupt) (here[q.pos] = here[q.pos] || []).push(q);
        const pins = Object.entries(here).map(([pos, qs]) => qs.map((q, k) => {
          const [r, c] = MAP_RC[pos];
          return `<span class="mpin ${q === p ? 'act' : ''}" style="--pc:${q.color};left:${((c + 0.5) / 11) * 100}%;top:${((r + 0.5) / 11) * 100}%;--dx:${(k - (qs.length - 1) / 2) * 22}px" title="${esc(q.name)}"><i>${tokenSvg(q.token)}</i></span>`;
        }).join('')).join('');
        const board = `<div class="map-board"><div class="mbd">${tiles}<div class="mbd-center"><span class="mbd-logo">OSLOPOLY</span></div>
          <div class="mbd-pins" aria-hidden="true">${pins}</div></div></div>`;
        // Høyre: skjøtet for markøren.
        const sq = SQ[cur];
        let right;
        if (MP.isOwnable(cur)) {
          const o = g.ownerOf(cur);
          const canManage = !!(p && !p.ai && this.mine(p) && !p.bankrupt && o === p && pendingHuman > 0 && !this.over);
          right = `<aside class="map-deed deed-panel" style="--pc:${o ? o.color : NEUTRAL}">
            ${o ? dpHead(o.color, tokenSvg(o.token), o.name, canManage ? 'din eiendom' : 'eier') : dpHead(NEUTRAL, PI.houseW, 'Ledig', `kan kjøpes · ${kr(sq.price)}`)}
            ${deedHTML(g, cur)}${canManage ? deedActsHTML(g, p, cur) : ''}</aside>`;
        } else {
          const txt = (SPECIAL_TEXT[sq.type] || (() => ''))(g, sq);
          const who = g.players.filter((q) => !q.bankrupt && q.pos === cur);
          right = `<aside class="map-deed deed-panel" style="--pc:${NEUTRAL}">${dpHead(NEUTRAL, PI.houseW, sq.name, 'felt')}
            <div class="deed sq-info"><div class="sqi-ico">${mapGlyph(cur)}</div><b>${esc(sq.name)}</b><p>${esc(txt)}</p>
            ${who.length ? `<div class="sqi-who">${who.map((q) => `<span style="--pc:${q.color}">${pPortrait(q, 'xs')}${esc(q.name)}${q.inJail && cur === 10 ? ' (inne)' : ''}</span>`).join('')}</div>` : ''}</div></aside>`;
        }
        const cards = `<div class="map-cards">${g.players.map((q) => pcardStatic(g, q, q === p && !this.over)).join('')}</div>`;
        const tradeOk = !!$('#actions [data-key="KeyH"]:not(:disabled)') && p && !p.ai && this.mine(p);
        m.frame.style.setProperty('--pc', p ? p.color : NEUTRAL);
        m.set(`<div class="map">${bank}${board}${right}</div>${cards}
          <div class="sticky-acts map-bar">
            <span class="hint static">${keyCap(PI.dpad, 'w')}<span class="hl"><span class="hl-l">Flytt markør</span><span class="hl-s">Markør</span></span></span>
            ${tradeOk ? `<button type="button" class="hint" data-trade data-key="KeyH">${keyCap('H', 'y')}<span class="hl"><span class="hl-l">Handel</span></span></button>` : ''}
            <button type="button" class="hint" data-primary data-x data-key="KeyM" title="Tilbake (M eller Esc)">${keyCap('M', 'x')}<span class="hl"><span class="hl-l">Tilbake</span></span></button>
            ${this.canQuit() ? `<button type="button" class="hint quit" data-quit data-key="KeyK">${keyCap('K', 'r')}<span class="hl"><span class="hl-l">Konkurs</span></span></button>` : ''}
          </div>`);
        m.el.scrollTop = scroll;
        $$('[data-sq]', m.el).forEach((b) => b.addEventListener('click', () => { cur = Number(b.dataset.sq); MP.Sound.click(); draw(); }));
        $('[data-x]', m.el).addEventListener('click', () => { MP.Sound.click(); close(); });
        const tb = $('[data-trade]', m.el); if (tb) tb.addEventListener('click', () => { MP.Sound.click(); this.openTrade(p); });
        const qb = $('[data-quit]', m.el); if (qb) qb.addEventListener('click', () => { MP.Sound.click(); this.askBankrupt(() => close()); });
        if (MP.isOwnable(cur) && p && g.ownerOf(cur) === p && this.mine(p)) wireDeedActs(m.el, g, p, cur, draw);
      };
      const onKey = (e) => {
        if (!m.wrap.isConnected) { close(); return; }
        if (m.wrap.classList.contains('stashed') || m.wrap.hidden) return;
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.code];
        if (!d) return;
        e.preventDefault(); e.stopPropagation();
        const nx = mapStep(cur, d[0], d[1]);
        if (nx !== cur) { cur = nx; MP.Sound.click(); draw(); }
      };
      document.addEventListener('keydown', onKey, true);
      this.mapDraw = draw;
      draw();
    },

    // ---------- Meny, innstillinger, regler og slutt ----------
    openSettings() {
      const m = openModal(`${title('INNSTILLINGER', 'purple')}${settingsHTML()}
        <div class="actions"><button type="button" class="btn sky" data-primary data-x>${pill('Lukk')}</button></div>`, { onBackdrop: () => m.close(), cls: 't-purple' });
      wireControls(m.el, applySetting, applySetting);
      $('[data-x]', m.el).addEventListener('click', () => m.close());
    },
    openMenu() {
      const g = this.game;
      const act = g ? activeRules(g.rules) : [];
      const badges = g ? `<div class="rule-badges" aria-label="Aktive husregler">${act.length
        ? act.map((r) => `<span class="rbadge" title="${esc(r.text)}">${r.ico}${esc(r.name)}</span>`).join('')
        : `<span class="rbadge classic">${ICO.classic}Klassiske regler</span>`}${g.s.opts.maxRounds ? `<span class="rbadge">${ICO.clock}Runde ${g.s.turn} av ${g.s.opts.maxRounds}</span>` : ''}</div>` : '';
      const canQuit = this.canQuit();
      const net = this.net, host = !!(net && net.role === 'host');
      // Online-verten: frakoblede spillere kan overlates til datamaskinen, så spillet ikke står fast.
      const gone = host && g && !this.over ? g.players.filter((p) => !p.ai && !p.bankrupt && net.isOffline(p)) : [];
      const netBox = net ? `<div class="menu-net"><span class="chip net on"><i class="net-dot"></i><span><small>${host ? 'DU ER VERT · ROM' : 'ONLINE · ROM'}</small><b>${esc(net.room || '')}</b></span></span>
        <span class="menu-net-t">${host ? 'Hold denne siden åpen mens dere spiller.' : 'Verten styrer spillet. Tempo og Hopp over gjelder bare din skjerm.'}</span>
        ${gone.map((p) => `<button type="button" class="btn small orange" data-takeover="${p.id}">${pill(`La datamaskinen spille for ${esc(p.name)}`, 'frakoblet')}</button>`).join('')}</div>` : '';
      const m = openModal(`${title('MENY', 'blue')}${badges}${netBox}
        <div class="menu-btns"><button type="button" class="btn go big wide" data-primary data-x>${pill('FORTSETT SPILLET', null, ICO.arrow)}</button></div>
        ${settingsHTML()}
        <div class="menu-btns">
          <div class="menu-row"><button type="button" class="btn orange" data-rules>${pill('REGLER')}</button>
          <button type="button" class="btn teal" data-log>${pill($('#log').classList.contains('open') ? 'SKJUL LOGG' : 'HENDELSESLOGG')}</button></div>
          <button type="button" class="btn sky wide" data-home>${pill(net ? (host ? 'FORLAT ROMMET' : 'FORLAT SPILLET') : 'TIL HOVEDMENYEN')}</button>
          <div class="menu-danger">
            ${g && !this.over && (!net || host) ? `<button type="button" class="btn danger-ghost" data-end>${pill('Avslutt og kår vinner', 'mest verdier vinner')}</button>` : ''}
            ${canQuit ? `<button type="button" class="btn danger-ghost" data-quit>${pill('Gå konkurs', 'gi opp spillet')}</button>` : ''}
          </div>
        </div>`, { onBackdrop: () => m.close(), cls: 't-blue' });
      wireControls(m.el, applySetting, applySetting);
      $('[data-x]', m.el).addEventListener('click', () => m.close());
      $('[data-rules]', m.el).addEventListener('click', () => { m.close(); this.openRules(); });
      $('[data-log]', m.el).addEventListener('click', () => { m.close(); this.toggleLog(); });
      const home = $('[data-home]', m.el);
      home.addEventListener('click', () => {
        // Motoren lagrer også midt i turen (s.turnPhase) i nyere versjoner.
        const sub = !net ? 'spillet er lagret – du kan fortsette senere'
          : host ? 'spillet pauses – du kan gjenoppta rommet fra «Spill online»' : 'plassen din holdes – bli med igjen med koden';
        if (!home.dataset.sure && g && !this.over) { home.dataset.sure = '1'; home.innerHTML = pill('SIKKER?', sub); return; }
        if (net) { this.leaveOnline(true); return; }
        location.reload();
      });
      $$('[data-takeover]', m.el).forEach((b) => b.addEventListener('click', () => {
        MP.Sound.click();
        if (this.net && this.net.aiTakeover(Number(b.dataset.takeover))) { m.close(); toast('Datamaskinen spiller videre for den frakoblede spilleren', '#F7941D', 3, true); }
      }));
      const end = $('[data-end]', m.el);
      if (end) end.addEventListener('click', () => {
        MP.Sound.click();
        this.confirm('AVSLUTTE SPILLET?', 'Spillet avsluttes nå, og den med mest verdier vinner. Det kan ikke angres.', 'AVSLUTT OG KÅR VINNER', () => {
          m.close();
          g.stopped = true;
          flushWaits();
          const best = g.active.slice().sort((x, y) => g.netWorth(y) - g.netWorth(x))[0];
          this.gameOver(best, true);
        });
      });
      const quit = $('[data-quit]', m.el);
      if (quit) quit.addEventListener('click', () => { MP.Sound.click(); this.askBankrupt(() => m.close()); });
    },
    // Bekreftelse for farlige valg: rød hovedknapp er ikke hovedknapp (Mellomrom = Avbryt).
    confirm(head, text, yes, onYes) {
      const m = openModal(`${title(head, 'red')}<p style="text-align:center">${text}</p>
        <div class="actions"><button type="button" class="btn sky" data-primary data-x>${pill('AVBRYT')}</button><button type="button" class="btn primary" data-yes>${pill(yes)}</button></div>`, { onBackdrop: () => m.close(), cls: 't-red confirm' });
      $('[data-x]', m.el).addEventListener('click', () => { MP.Sound.click(); m.close(); });
      $('[data-yes]', m.el).addEventListener('click', () => { MP.Sound.click(); m.close(); onYes(); });
    },
    openRules() {
      const R = this.game ? this.game.rules : settings.rules;
      const h3 = (ico, t) => `<h3><span class="rh-ico">${ico}</span>${t}</h3>`;
      const house = `<section class="wide">${h3(ICO.star, `Husregler${this.game ? ' i dette spillet' : ''}`)}<ul class="hr-list">${HOUSE_RULES.map((r) => `<li class="${ruleOn(R, r) ? 'on' : ''}"><span class="hr-ico">${r.ico}</span><span><b>${esc(r.name)}</b> ${ruleOn(R, r) ? '<em>PÅ</em>' : '<i>av</i>'}<br>${esc(r.text)}</span></li>`).join('')}</ul>
        <p class="hr-note">Velges under «Nytt spill». Husreglene kan kombineres.</p></section>`;
      const m = openModal(`${title('SLIK SPILLER DU', 'orange')}<div class="rules">
        <section>${h3(ICO.target, 'Målet')}Bli den eneste som ikke er konkurs. Kjøp gater, bygg hus og hoteller, og krev leie.</section>
        <section>${h3(ICO.dice, 'Turen')}<ul><li>Kast terningene og flytt. Kaster du <b>dobbel</b>, kaster du igjen. Tre dobler på rad sender deg i fengsel.</li>
        <li>Passerer eller lander du på <b>Start</b>, får du ${kr(RULES.salary)}.</li>
        <li>Lander du på en ledig eiendom, kan du kjøpe den. Ellers går den på <b>auksjon</b>.</li>
        <li>Lander du på andres eiendom, betaler du leie (dobbel leie på ubebygde gater i en hel fargegruppe).</li></ul></section>
        <section>${h3(ICO.build, 'Bygging')}<ul><li>Eier du hele fargegruppen, kan du bygge hus – jevnt fordelt. Fire hus kan byttes mot et hotell.</li>
        <li>Banken har bare 32 hus og 12 hoteller.</li><li>Klikk på din egen gate for å se skjøtet med knapper for å bygge og pantsette.</li></ul></section>
        <section>${h3(ICO.jail, 'Fengsel')}<ul><li>Betal ${kr(RULES.jailFine)}, bruk et «Kom ut av fengselet»-kort, eller prøv å kaste dobbel (tre forsøk).</li>
        <li>På besøk i fengselet skjer ingenting.</li></ul></section>
        <section>${h3(ICO.notes, 'Penger')}<ul><li>Pantsett eiendommer for halve prisen. Innløsning koster pantelånet + 10 %.</li>
        <li>Klarer du ikke å betale, kan du selge, pantsette eller handle – ellers går du konkurs.</li><li>Handle med de andre spillerne med «Handel». Datamaskinen kan svare med et motbud.</li></ul></section>
        <section>${h3(ICO.arrow, 'Kontroller')}<ul><li>Dra for å rotere, høyreklikk eller to fingre for å flytte, scroll for å zoome.</li><li>Klikk på en gate for å se skjøtet, og på et spillerkort for eiendommene.</li>
        <li>Mellomrom = hovedknappen. <b>S</b> = hopp over animasjoner. <b>Esc</b> lukker vinduer.</li></ul></section>
        ${house}</div><div class="actions"><button type="button" class="btn sky" data-primary data-x>${pill('Lukk')}</button></div>`, { wide: true, onBackdrop: () => m.close(), cls: 't-orange' });
      $('[data-x]', m.el).addEventListener('click', () => m.close());
    },

    // ---------- Nye io-valg (turrekkefølge, Start-valg, fartsterning) ----------
    // Alle kaster; høyest sum begynner. Kort og morsomt, og kan hoppes over.
    // QA N1: startspilleren kommer fra motoren (`first`), aldri regnet ut her. Omkast vises som egne runder.
    turnOrder(rolls, first) {
      const g = this.game;
      if (!rolls || !rolls.length) return Promise.resolve();
      let winner = first != null ? (typeof first === 'object' ? first : g?.player(first)) : null;
      if (winner && g) winner = g.player(winner.id) || winner;
      this.orderUnknown = !winner;
      // Del kastene i runder: en ny runde begynner når en spiller kaster for andre gang.
      const rounds = [];
      let cur = null;
      // Motoren merker hvert kast med `round` (0 = første kast); eldre motor: utled rundene.
      let lastR = null;
      for (const r of rolls) {
        const fresh = r.round != null ? r.round !== lastR : (!cur || cur.some((x) => x.player.id === r.player.id));
        if (!cur || fresh) { cur = []; rounds.push(cur); }
        lastR = r.round;
        cur.push(r);
      }
      const sum = (r) => r.dice[0] + r.dice[1];
      const lastRound = rounds.length - 1;
      this.log(`Turrekkefølge: ${rounds.map((rd, n) => (n ? 'omkast: ' : '') + rd.map((r) => `${r.player.name} ${sum(r)}`).join(', ')).join(' · ')}.${winner ? ` ${winner.name} begynner!` : ''}`, 'good');
      if (skipping()) return Promise.resolve();
      MP.Sound.dice();
      return new Promise((resolve) => {
        let k = 0;
        const rows = rounds.map((rd, n) => `${n ? `<li class="to-sep" style="--k:${k}"><span>OMKAST</span></li>` : ''}${rd.map((r) => {
          const again = n < lastRound && rounds[n + 1].some((x) => x.player.id === r.player.id);
          const win = winner && n === lastRound && r.player.id === winner.id;
          return `<li class="${win ? 'win' : ''} ${n < lastRound && !again ? 'dim' : ''}" style="--pc:${r.player.color};--k:${k++}">${pPortrait(r.player, 'sm')}<span class="nm">${esc(r.player.name)}${again ? ' <small>likt – kaster om</small>' : ''}</span>
          <span class="to-dice">${dieFace(r.dice[0])}${dieFace(r.dice[1])}</span><b>${sum(r)}</b></li>`;
        }).join('')}`).join('');
        const m = openModal(`${title('HVEM BEGYNNER?', 'purple')}<ol class="to-list">${rows}</ol>
          ${winner ? `<div class="to-win" style="--pc:${winner.color};--k:${k}">${band(`${esc(winner.name.toUpperCase())} BEGYNNER!`, 'player')}</div>` : ''}
          <div class="actions"><button type="button" class="btn go big" data-primary data-x>${pill('START!', null, ICO.dice)}</button></div>`, { cls: 't-purple turn-order' });
        let done = false;
        const close = () => { if (done) return; done = true; m.close(); resolve(); };
        $('[data-x]', m.el).addEventListener('click', () => { MP.Sound.click(); close(); });
        setTimeout(() => { if (!done) MP.Sound.buy(); }, 900);
        setTimeout(close, Math.max(2600, 3600 / speed) + lastRound * 900);
        if (g) this.scheduleRender();
      });
    },
    // Husregelen «Start og flytting»: kr 8 000 eller flytt til et valgfritt felt.
    goChoice(p) {
      this.setTurnInfo(p, 'rett på Start!');
      return human(new Promise((resolve) => {
        const m = openModal(`${whoHead(p, 'rett på Start')}${title('START!', 'red')}
          <p class="cc-q">Hva vil du gjøre?</p>
          <div class="go-choice">
            <button type="button" class="gc-opt cash" data-cash data-primary>${ICO.notes}<b>TA ${kr(8000)}</b><small>dobbel lønn</small></button>
            <button type="button" class="gc-opt move" data-move>${ICO.arrow}<b>FLYTT</b><small>${kr(RULES.salary)} + flytt til valgfritt felt</small></button>
          </div>`, { cls: 't-red go-modal' });
        $('[data-cash]', m.el).addEventListener('click', () => { MP.Sound.click(); m.close(); resolve({ type: 'cash' }); });
        $('[data-move]', m.el).addEventListener('click', async () => {
          MP.Sound.click(); m.close();
          const to = await this.pickSquare(p, 'Flytt til et felt', 'Velg et felt i listen eller klikk på brettet. Du får det som skjer der.', true);
          if (to == null) resolve({ type: 'cash' }); else resolve({ type: 'move', to });
        });
      }));
    },
    // Fartsterningen: buss – flytt terning 1, terning 2 eller summen.
    busChoice(p, options) {
      const opts = (options || []).filter((n) => Number.isFinite(n));
      if (!opts.length) return Promise.resolve(0);
      this.setTurnInfo(p, 'buss – velg');
      return human(new Promise((resolve) => {
        const labels = ['Terning 1', 'Terning 2', 'Summen'];
        const m = openModal(`${whoHead(p, 'fartsterning')}${title('BUSS!', 'gold')}
          <p class="cc-q">Hvor langt vil du flytte?</p>
          <div class="bus-opts">${opts.map((n, k) => `<button type="button" class="gc-opt bus" data-n="${n}" ${k === opts.length - 1 ? 'data-primary' : ''}><b>${n} steg</b><small>${labels[k] || ''}</small><span class="bus-to">${sqTag((p.pos + n) % 40)}</span></button>`).join('')}</div>`, { cls: 't-gold bus-modal' });
        $$('[data-n]', m.el).forEach((b) => b.addEventListener('click', () => { MP.Sound.click(); m.close(); resolve(Number(b.dataset.n)); }));
      }));
    },
    // Fartsterningen: tre like – flytt til et valgfritt felt.
    speedChoice(p, kind) {
      this.setTurnInfo(p, 'tre like – velg felt');
      return human(this.pickSquare(p, 'Tre like!', 'Velg et hvilket som helst felt – i listen eller på brettet.', false)
        .then((to) => (to == null ? p.pos : to)));
    },
    // Feltvelger: liste over alle 40 felt + klikk på brettet (via MP.Board3D.clickCb).
    pickSquare(p, head, text, cancelable) {
      return new Promise((resolve) => {
        const m = openModal('', { cls: 't-blue pick-modal', side: true });
        let chosen = null;
        const finish = (i) => { this.pickCb = null; m.close(); resolve(i); };
        const draw = () => {
          m.set(`${whoHead(p, head)}<p class="note">${text}</p>
            <div class="sq-pick">${SQ.map((sq, i) => `<button type="button" class="sqp ${i === chosen ? 'sel' : ''} ${i === p.pos ? 'here' : ''}" data-sq="${i}" style="--c:${sqColor(i)}"><i></i><span>${esc(sq.name)}</span>${MP.isOwnable(i) ? `<small>${this.game.ownerOf(i) ? esc(this.game.ownerOf(i).name) : 'ledig'}</small>` : ''}</button>`).join('')}</div>
            <div class="sticky-acts"><div class="actions">
              <button type="button" class="btn go big" data-ok ${chosen == null ? 'disabled' : 'data-primary'}>${pill(chosen == null ? 'VELG ET FELT' : `FLYTT TIL ${esc(SQ[chosen].name.toUpperCase())}`)}</button>
              ${cancelable ? `<button type="button" class="btn sky" data-x>${pill(`Ta ${kr(8000)} i stedet`)}</button>` : ''}</div></div>`);
          $$('[data-sq]', m.el).forEach((b) => b.addEventListener('click', () => { MP.Sound.click(); chosen = Number(b.dataset.sq); draw(); }));
          $('[data-ok]', m.el).addEventListener('click', () => { if (chosen != null) { MP.Sound.click(); finish(chosen); } });
          const x = $('[data-x]', m.el); if (x) x.addEventListener('click', () => { MP.Sound.click(); finish(null); });
          if (chosen != null) { const el = $(`[data-sq="${chosen}"]`, m.el); if (el) el.scrollIntoView({ block: 'nearest' }); }
        };
        this.pickCb = (i) => { chosen = i; MP.Sound.click(); draw(); };
        draw();
      });
    },

    // ---------- Vinnerskjerm: podium, spilletid, statistikk, Spill igjen ----------
    async gameOver(w, early) {
      const g = this.game;
      // Kan bli kalt både av UI (seier midt i en dialog) og av motoren: vis vinnerskjermen bare én gang.
      if (this.over && this.wonGame === g) return;
      this.wonGame = g;
      this.over = true;
      this.phaseDone = null;
      this.pickCb = null;
      this.auc = null;
      // Alle ventende menneskevalg er avsluttet: dialogene lukkes, og ingen knapper venter lenger.
      pendingHuman = 0;
      flushWaits();
      setSkip(false);
      // Online: verten sier fra til alle (klientene viser samme vinnerskjerm). Den lokale lagringen røres ikke.
      const net = this.net;
      if (net) { if (net.role === 'host') net.onOver(w, early); } else store.del(SAVE_KEY);
      this.hideReach();
      clearSplash();
      hideBanner();
      $('#toasts').innerHTML = '';
      $$('.peek-back').forEach((e) => e.remove());
      $('#modals').innerHTML = ''; syncBlur();
      this.setActions([]);
      $('#dock').classList.remove('has-acts');
      this.updateSkip();
      if (!w) w = g.active.slice().sort((x, y) => g.netWorth(y) - g.netWorth(x))[0] || g.players[0];
      this.setTurnInfo(w, 'vant!');
      this.render();
      MP.Sound.win();
      confetti();
      try { MP.Board3D.fireworks?.(); } catch (e) { console.warn(e); }
      const reason = early ? 'early' : (typeof g.winReason === 'function' ? g.winReason() : 'bankrupt');
      const why = reason === 'early' ? 'Spillet ble avsluttet – flest verdier vinner.'
        : reason === 'wealth' ? `Rikdomsregelen: ${esc(w.name)} nådde ${kr(MP.WEALTH_GOAL || 60000)} i kontanter først!`
          : reason === 'rounds' ? `Alle ${g.s.opts.maxRounds || ''} rundene er spilt – flest verdier vinner.`
            : 'Alle de andre gikk konkurs.';
      // F10: vinneren står alltid som nr. 1; de andre etter verdier (konkurs sist).
      // Blant de konkurse rangeres den som holdt ut lengst høyest.
      const outIdx = (p) => (this.outOrder || []).indexOf(p.id);
      const rest = g.players.filter((p) => p !== w).sort((a, b) => (a.bankrupt - b.bankrupt) || (a.bankrupt ? outIdx(b) - outIdx(a) : g.netWorth(b) - g.netWorth(a)));
      const order = [w, ...rest];
      const stats = (g.s && g.s.stats) || {};
      const st = (p, k) => (stats[p.id] && Number(stats[p.id][k])) || 0;
      const ms = (g.s.endedAt || Date.now()) - (g.s.startedAt || this.startedAt || Date.now());
      const mins = Math.max(0, Math.round(ms / 60000));
      const timeTxt = g.s.startedAt || this.startedAt ? (mins >= 60 ? `${Math.floor(mins / 60)} t ${mins % 60} min` : `${mins} min`) : '';
      const props = (p) => g.propsOf(p).length;
      // N6: hus og hoteller telles hver for seg (houses 5 = ett hotell, ikke fem hus).
      const bld = (p) => {
        let hs = 0, ht = 0;
        for (const i of g.propsOf(p)) { const n = g.s.props[i].houses || 0; if (n === 5) ht++; else hs += n; }
        return `${hs} hus · ${nn(ht, 'hotell', 'hoteller')}`;
      };
      const podium = [order[1], order[0], order[2]].map((p, k) => (p ? `<div class="pod pod-${[2, 1, 3][k]}" style="--pc:${p.color}">
          ${k === 1 ? `<span class="pod-crown">${ICO.crown}</span>` : ''}${pPortrait(p, k === 1 ? 'xl' : 'lg')}
          <span class="pod-name">${esc(p.name)}</span><span class="pod-val">${p.bankrupt ? 'konkurs' : kr(g.netWorth(p))}</span>
          <span class="pod-block"><b>${[2, 1, 3][k]}</b></span></div>` : '<div class="pod pod-empty"></div>')).join('');
      const more = order.slice(3).map((p, n) => `<li style="--pc:${p.color}"><span class="rank">${n + 4}</span>${pPortrait(p, 'xs')}<span class="nm">${esc(p.name)}</span><span>${p.bankrupt ? 'konkurs' : kr(g.netWorth(p))}</span></li>`).join('');
      // Utmerkelser fra statistikken (bare de som har en verdi).
      const award = (ico, name, key, fmt) => {
        const top = g.players.slice().sort((a, b) => st(b, key) - st(a, key))[0];
        return top && st(top, key) > 0 ? `<div class="award" style="--pc:${top.color}">${ico}<small>${name}</small><b>${esc(top.name)}</b><span>${fmt(st(top, key))}</span></div>` : '';
      };
      // Motoren teller hus og hoteller hver for seg (housesBuilt/hotelsBuilt); eldre spill har bare `built`.
      const split = Object.values(stats).some((s) => s && typeof s.housesBuilt === 'number');
      const awards = [
        award(ICO.notes, 'Mest leie fått', 'rentGot', (v) => kr(v)),
        split ? award(ICO.build, 'Flest hus bygd', 'housesBuilt', (v) => `${v} hus`) : award(ICO.build, 'Flest hus bygd', 'built', (v) => `${v} bygg`),
        split ? award(ICO.hotel, 'Hotellkonge', 'hotelsBuilt', (v) => nn(v, 'hotell', 'hoteller')) : '',
        award(ICO.props, 'Flest kjøp', 'bought', (v) => nn(v, 'eiendom', 'eiendommer')),
        award(ICO.dice, 'Flest dobler', 'doubles', (v) => nn(v, 'dobbel', 'dobler')),
        award(ICO.jail, 'Fengselsfugl', 'jailed', (v) => nn(v, 'gang', 'ganger')),
        award(ICO.gavel, 'Auksjonarius', 'auctionsWon', (v) => `${nn(v, 'auksjon', 'auksjoner')} vunnet`),
        award(ICO.star, 'Største leie', 'maxRent', (v) => kr(v)),
        award(ICO.trade, 'Betalte mest leie', 'rentPaid', (v) => kr(v)),
      ].join('');
      const wstats = `<div class="wstats">
        ${timeTxt ? `<span>${ICO.clock}<small>Spilletid</small><b>${timeTxt}</b></span>` : ''}
        <span>${ICO.clock}<small>Runder</small><b>${reason === 'rounds' && g.s.opts.maxRounds ? g.s.opts.maxRounds : g.s.turn || 1}</b></span>
        <span>${ICO.notes}<small>Kontanter</small><b>${kr(w.cash)}</b></span>
        <span>${ICO.props}<small>Eiendommer</small><b>${props(w)}</b></span>
        <span>${ICO.build}<small>Hus og hoteller</small><b>${bld(w)}</b></span></div>`;
      const m = openModal(`<div class="winner"><div class="win-t3">${text3d('Vinner!', 'gold')}</div>
        <div class="win-name" style="--pc:${w.color}">${esc(w.name)}</div>
        ${reason === 'wealth' ? `<div class="win-reason">${ICO.trophy}<span>RIKDOMSSEIER</span></div>` : ''}
        <p>${why}</p>
        <div class="podium">${podium}</div>
        ${more ? `<ol class="standings">${more}</ol>` : ''}
        ${wstats}
        ${awards ? `<h3 class="aw-h">Utmerkelser</h3><div class="awards">${awards}</div>` : ''}</div>
        <div class="actions sticky-acts">${!net ? `<button type="button" class="btn go big" data-primary data-again>${pill('SPILL IGJEN', 'samme spillere og regler')}</button>`
          : net.role === 'host' ? `<button type="button" class="btn go big" data-primary data-lobby>${pill('NYTT SPILL', 'alle tilbake til rommet')}</button>`
            : '<span class="win-wait">Verten kan starte et nytt spill i rommet.</span>'}<button type="button" class="btn blue" data-new>${pill(net ? 'FORLAT ROMMET' : 'NY MENY')}</button><button type="button" class="btn sky" data-x>${pill('Se brettet')}</button></div>`, { cls: 't-gold win-modal', wide: true });
      $('[data-new]', m.el).addEventListener('click', () => { if (this.net) this.leaveOnline(true); else location.reload(); });
      $('[data-x]', m.el).addEventListener('click', () => m.close());
      const lobby = $('[data-lobby]', m.el);
      if (lobby) lobby.addEventListener('click', () => { MP.Sound.click(); if (this.net) this.net.toLobby(); });
      const again = $('[data-again]', m.el);
      if (again) again.addEventListener('click', () => {
        // Samme spillere og regler: lagres for denne fanen og startes etter en ren omlasting.
        const o = g.s.opts || {};
        const opts = this.lastOpts || {
          players: g.players.map((p) => ({ name: p.name, ai: p.ai, token: p.token, color: p.color, level: p.level })),
          startMoney: o.startMoney, auctions: o.auctions, rules: o.rules, maxRounds: o.maxRounds || 0,
        };
        try { sessionStorage.setItem(REPLAY_KEY, JSON.stringify(opts)); } catch (e) { /* */ }
        location.reload();
      });
    },

    // ---------- Online: hver på sin skjerm (net.js) ----------
    net: null,
    onl: { code: '', err: '', busy: '', seats: null, joined: false },
    // Styres denne spilleren fra denne skjermen? Lokalt: alle mennesker. Online: bare egen spiller.
    mine(p) { if (!p) return false; return this.net ? this.net.isMine(p) : !p.ai; },
    whenReady() {
      if (this.ready) return Promise.resolve();
      return new Promise((resolve) => { const t = setInterval(() => { if (this.ready) { clearInterval(t); resolve(); } }, 100); });
    },
    onlineBoot() {
      const N = MP.Net;
      if (!N) return;
      const ses = N.session();
      if (ses) { this.resumeSession(ses); return; }
      const code = N.codeFromURL();
      if (code) this.showOnline({ code });
    },
    showOnline(o = {}) {
      $('#menu').hidden = true; $('#setup').hidden = true; $('#hud').hidden = true; $('#online').hidden = false;
      $('#skip').hidden = true;
      document.body.classList.remove('in-game');
      if (o.code) this.onl.code = o.code;
      if (o.err !== undefined) this.onl.err = o.err;
      this.onlKind = null;
      this.renderOnline();
      this.boardMenu(true);
      syncBlur();
      requestAnimationFrame(() => {
        if (this.net) return;
        const f = !profile.name ? $('#online [data-name]') : this.onl.code ? $('#online [data-join]') : null;
        if (f && !f.disabled) f.focus({ preventScroll: true });
      });
    },
    onlineBack() {
      const net = this.net;
      if (!net) { MP.Net && MP.Net.clearURL(); this.onl.err = ''; this.onl.seats = null; this.showMenu(); return; }
      if (!this.onl.joined) { net.shutdown(true); this.net = null; this.onl.busy = ''; this.renderOnline(); return; }
      const host = net.role === 'host';
      this.confirm(host ? 'AVSLUTTE ROMMET?' : 'FORLATE ROMMET?', host ? 'Rommet stenges, og alle som er med, blir sendt ut.' : 'Du kan bli med igjen med koden.', host ? 'AVSLUTT ROMMET' : 'FORLAT', () => {
        if (host) net.close(); else net.leave();
        this.net = null; this.onl.joined = false; this.onl.err = '';
        MP.Net.clearURL();
        document.body.classList.remove('net-on');
        this.renderOnline();
      });
    },
    // Forlater online-spillet (verten kan gjenoppta rommet senere fra «Spill online»).
    leaveOnline(reload) {
      const net = this.net;
      if (net) { try { net.leave(); } catch (e) { console.warn(e); } }
      this.net = null; this.onl.joined = false;
      MP.Net && MP.Net.clearURL();
      if (reload) setTimeout(() => location.reload(), 400);
    },
    syncProfileInput() {
      const inp = $('#online [data-name]');
      if (inp) profile.name = inp.value.replace(/\s+/g, ' ').trim().slice(0, 14);
      saveProfile();
    },
    needName() {
      this.syncProfileInput();
      if (profile.name) return false;
      this.onl.err = 'Skriv et kallenavn først.';
      this.renderOnline();
      const inp = $('#online [data-name]'); if (inp) inp.focus();
      return true;
    },
    async onlineCreate(resume = false) {
      const N = MP.Net;
      if (this.onl.busy || this.net) return;
      if (!resume && this.needName()) return;
      const saved = resume ? N.savedRoom() : null;
      if (resume && !saved) { this.onl.err = 'Fant ikke rommet som skulle gjenopptas.'; this.renderOnline(); return; }
      this.onl.busy = resume ? `Gjenopptar rom ${saved.room} …` : 'Lager rom …'; this.onl.err = ''; this.onl.seats = null;
      this.renderOnline();
      const host = new N.Host(this);
      this.net = host;
      if (saved && saved.opts) this.netRestoreOpts(saved.opts);
      try {
        await host.open({ ...profile }, saved);
        this.onl.joined = true; this.onl.busy = '';
        N.clearURL();
        this.renderOnline();
      } catch (e) {
        console.warn(e);
        try { host.shutdown(); } catch (x) { /* */ }
        this.net = null; this.onl.busy = '';
        this.onl.err = `Fikk ikke kontakt med nettjenesten (${(e && e.message) || 'ukjent feil'}). Sjekk internett og prøv igjen.`;
        this.renderOnline();
      }
    },
    async onlineJoin(codeIn, claim = null) {
      const N = MP.Net;
      if (this.onl.busy || this.net) return;
      const code = N.normCode(codeIn != null ? codeIn : ($('#online [data-code]') || {}).value || this.onl.code);
      this.onl.code = code;
      if (!N.validCode(code)) { this.onl.err = 'Koden har 6 tegn (bokstaver og tall).'; this.renderOnline(); const c = $('#online [data-code]'); if (c) c.focus(); return; }
      if (this.needName()) return;
      this.onl.busy = `Kobler til rom ${code} …`; this.onl.err = '';
      this.renderOnline();
      const c = new N.Client(this);
      this.net = c;
      if (claim != null) c.claim = claim;
      try {
        await c.open(code, { ...profile }, null, false);
        this.onl.joined = true; this.onl.busy = ''; this.onl.seats = null;
        try { history.replaceState(null, '', N.link(code)); } catch (e) { /* */ }
        this.renderOnline();
      } catch (e) {
        try { c.shutdown(true); } catch (x) { /* */ }
        this.net = null; this.onl.busy = '';
        this.onl.err = (e && e.message) || 'Fikk ikke bli med.';
        this.onl.seats = e && e.seats && e.seats.length ? { code, list: e.seats } : null;
        this.renderOnline();
      }
    },
    // Etter omlasting: koble til samme rom igjen (verten gjenopptar, klienten ber om full synk).
    async resumeSession(ses) {
      const N = MP.Net;
      if (ses.role === 'host') {
        const saved = N.savedRoom();
        if (!saved || saved.room !== ses.room) { N.clearSession(); this.showOnline(); return; }
        this.showOnline();
        await this.onlineCreate(true);
        return;
      }
      if (ses.me && ses.me.name) Object.assign(profile, { name: ses.me.name, token: ses.me.token || profile.token, color: ses.me.color || profile.color });
      this.showOnline({ code: ses.room });
      this.onl.busy = `Kobler til rom ${ses.room} igjen … venter på verten`;
      this.renderOnline();
      const c = new N.Client(this);
      this.net = c;
      try {
        await c.open(ses.room, { ...profile }, { pub: ses.pub, key: ses.key }, true);
        this.onl.joined = true; this.onl.busy = '';
        this.renderOnline();
      } catch (e) {
        try { c.shutdown(true); } catch (x) { /* */ }
        this.net = null; this.onl.busy = '';
        this.onl.err = (e && e.message) || 'Fikk ikke koble til igjen.';
        this.onl.seats = e && e.seats && e.seats.length ? { code: ses.room, list: e.seats } : null;
        this.renderOnline();
      }
    },
    // Vertens valg i lobbyen (samme som oppsettet for lokalt spill).
    netOpts() { return { money: setupOpts.money, maxRounds: setupOpts.maxRounds || 0, auction: !!setupOpts.auction, rules: { ...settings.rules } }; },
    netRestoreOpts(o) {
      if (!o || typeof o !== 'object') return;
      if ([30000, 20000, 15000].includes(o.money)) setupOpts.money = o.money;
      if ([0, 30, 60].includes(o.maxRounds)) setupOpts.maxRounds = o.maxRounds;
      if (typeof o.auction === 'boolean') setupOpts.auction = o.auction;
      if (o.rules) { for (const k of RULE_KEYS_ALL) settings.rules[k] = !!o.rules[k]; saveSettings(); }
    },
    onlineOptsChanged() {
      const net = this.net;
      if (!net || net.role !== 'host' || net.phase !== 'lobby') return;
      const j = JSON.stringify(this.netOpts());
      if (j === this.optSent) return;
      this.optSent = j;
      clearTimeout(this.optTimer);
      this.optTimer = setTimeout(() => { if (this.net === net && net.phase === 'lobby') net.lobbyChanged(); }, 150);
    },
    renderOnline() {
      const body = $('#online-body');
      if (!body || $('#online').hidden) return;
      const net = this.net;
      const kind = net && this.onl.joined ? 'lobby' : 'choice';
      $('#online-back-l').textContent = kind === 'lobby' ? (net.role === 'host' ? 'Avslutt rommet' : 'Forlat rommet') : 'Tilbake';
      if (kind === 'choice') {
        this.onlKind = kind;
        body.innerHTML = this.choiceHTML();
        this.wireChoice(body);
        $('#online-bar').hidden = true;
        $('#online-go').innerHTML = '';
        return;
      }
      if (this.onlKind !== kind || this.onlRole !== net.role) {
        this.onlKind = kind; this.onlRole = net.role;
        body.innerHTML = this.lobbyHTML();
        this.wireLobby(body);
      }
      this.updateLobby();
    },
    choiceHTML() {
      const N = MP.Net, o = this.onl;
      const saved = N && N.savedRoom();
      const busy = !!o.busy;
      const savedSub = saved ? `${saved.phase === 'game' && saved.s ? `spill i gang · runde ${saved.s.turn || 1}` : 'lobby'} · ${(saved.members || []).map((m) => m.name).filter(Boolean).slice(0, 4).join(', ')}` : '';
      return `<div class="on-wrap ${busy ? 'busy' : ''}">
        <div class="glass on-me"><h2 class="glass-head">DITT KALLENAVN OG BRIKKE</h2>
          <div class="on-me-row" style="--pc:${profile.color}">
            <button type="button" class="prow-look" data-look title="Velg farge og brikke" aria-label="Velg farge og brikke">${portrait(profile.token, profile.color, 'md')}<span class="prow-edit" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z" fill="#fff" stroke="#12386b" stroke-width="1.8" stroke-linejoin="round"/></svg></span></button>
            <input class="text-in" type="text" data-name maxlength="14" value="${esc(profile.name)}" placeholder="Kallenavn" aria-label="Kallenavn" autocomplete="off" ${busy ? 'disabled' : ''}>
          </div>
          <p class="on-note">Bare kallenavnet og brikken vises for de andre. Bruk gjerne et kallenavn, ikke fullt navn.</p></div>
        <div class="on-choice ${o.code ? 'join-first' : ''}">
          <div class="glass on-card on-create"><h2 class="glass-head">LAG ROM</h2>
            <p>Du blir vert og får en kode og en lenke du sender til vennene dine. Hold siden åpen mens dere spiller.</p>
            <button type="button" class="btn go big" data-create ${busy ? 'disabled' : ''}>${pill('LAG ROM', null, ICO.star)}</button>
            ${saved ? `<button type="button" class="btn sky" data-resume ${busy ? 'disabled' : ''}>${pill(`GJENOPPTA ROM ${esc(saved.room)}`, esc(savedSub))}</button>` : ''}</div>
          <div class="glass on-card"><h2 class="glass-head">BLI MED</h2>
            <p>Skriv inn koden du har fått, eller åpne lenken fra verten.</p>
            <input class="text-in code-in" type="text" data-code maxlength="6" value="${esc(o.code)}" placeholder="KODE" aria-label="Romkode" autocomplete="off" autocapitalize="characters" spellcheck="false" ${busy ? 'disabled' : ''}>
            <button type="button" class="btn blue big" data-join ${busy ? 'disabled' : ''} ${o.code ? 'data-primary' : ''}>${pill('BLI MED', null, ICO.arrow)}</button></div>
        </div>
        ${busy ? `<p class="on-busy"><span class="spin" aria-hidden="true"></span><span>${esc(o.busy)}</span><button type="button" class="btn small sky" data-cancel>${pill('Avbryt')}</button></p>` : ''}
        ${o.err ? `<p class="on-err" role="alert">${ICO.warn}<span>${esc(o.err)}</span></p>` : ''}
        ${o.seats && !busy ? `<div class="on-seats">${o.seats.list.map((s) => `<button type="button" class="btn small orange" data-seat="${Number(s.pid)}">${pill(`Ta over plassen til ${esc(s.name)}`, 'frakoblet spiller')}</button>`).join('')}</div>` : ''}
        <p class="on-foot">Alle spiller på hver sin mobil eller PC. Spillet går via en åpen nettjeneste (MQTT), så ikke del personlige opplysninger i navnet.</p>
      </div>`;
    },
    wireChoice(el) {
      const name = $('[data-name]', el), code = $('[data-code]', el);
      if (name) name.addEventListener('input', () => { profile.name = name.value.replace(/\s+/g, ' ').trimStart().slice(0, 14); saveProfile(); });
      if (code) {
        code.addEventListener('input', () => { const v = MP.Net.normCode(code.value); if (v !== code.value) code.value = v; this.onl.code = v; });
        code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.onlineJoin(); } });
      }
      if (name) name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (this.onl.code) this.onlineJoin(); else this.onlineCreate(); } });
      const on = (sel, fn) => { const b = $(sel, el); if (b) b.addEventListener('click', () => { MP.Sound.ensure(); MP.Sound.click(); fn(b); }); };
      on('[data-look]', () => openLookPicker(profile, 0, [], () => { saveProfile(); this.renderOnline(); }, 'DIN BRIKKE'));
      on('[data-create]', () => this.onlineCreate(false));
      on('[data-resume]', () => this.onlineCreate(true));
      on('[data-join]', () => this.onlineJoin());
      on('[data-cancel]', () => { if (this.net) { try { this.net.shutdown(true); } catch (e) { /* */ } } this.net = null; this.onl.busy = ''; this.renderOnline(); });
      $$('[data-seat]', el).forEach((b) => b.addEventListener('click', () => { MP.Sound.click(); const s = this.onl.seats; if (s) this.onlineJoin(s.code, Number(b.dataset.seat)); }));
    },
    lobbyHTML() {
      const net = this.net, host = net.role === 'host';
      const share = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
      return `<div class="setup-wrap on-lobby">
        <div class="setup-col">
          <div class="glass on-me"><h2 class="glass-head">DEG</h2>
            <div class="on-me-row" data-me-row>
              <button type="button" class="prow-look" data-look title="Velg farge og brikke" aria-label="Velg farge og brikke"><span data-me-portrait></span><span class="prow-edit" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z" fill="#fff" stroke="#12386b" stroke-width="1.8" stroke-linejoin="round"/></svg></span></button>
              <input class="text-in" type="text" data-name maxlength="14" value="${esc(profile.name)}" placeholder="Kallenavn" aria-label="Kallenavn" autocomplete="off">
            </div></div>
          <div class="glass"><h2 class="glass-head">SPILLERE <span class="on-count" data-count></span></h2><div class="prows on-players" data-players></div></div>
        </div>
        <aside class="setup-side on-side">
          <div class="glass on-room"><h2 class="glass-head">${host ? 'DEL ROMMET' : 'ROMMET'}</h2>
            <div class="room-code" data-code-big aria-label="Romkode"></div>
            <div class="on-link"><input class="text-in" type="text" readonly data-link aria-label="Lenke til rommet"></div>
            <div class="on-share"><button type="button" class="btn small teal" data-copy>${pill('Kopier lenke')}</button>${share ? `<button type="button" class="btn small blue" data-share>${pill('Del')}</button>` : ''}<button type="button" class="btn small sky" data-copy-code>${pill('Kopier kode')}</button></div>
            <div class="on-status" data-status></div></div>
          ${host ? '<div class="glass"><h2 class="glass-head">REGLER OG TEMPO</h2><div id="online-opts" data-opts-box></div></div>'
            : '<div class="glass"><h2 class="glass-head">REGLER</h2><div class="on-rules" data-rules></div><p class="on-note">Verten velger reglene. Tempo og grafikk velger du selv i menyen.</p></div>'}
        </aside></div>`;
    },
    wireLobby(el) {
      const net = this.net;
      const name = $('[data-name]', el);
      name.addEventListener('input', () => {
        profile.name = name.value.replace(/\s+/g, ' ').trimStart().slice(0, 14); saveProfile();
        clearTimeout(this.nameTimer);
        this.nameTimer = setTimeout(() => { if (this.net === net && profile.name.trim()) net.setMe({ ...profile, name: profile.name.trim() }); }, 450);
      });
      name.addEventListener('change', () => { if (this.net === net && profile.name.trim()) net.setMe({ ...profile, name: profile.name.trim() }); });
      $('[data-look]', el).addEventListener('click', () => {
        MP.Sound.click();
        const v = net.view();
        const others = [...v.members.filter((x) => x.pub !== v.me), ...v.ais];
        openLookPicker(profile, 0, others, () => { saveProfile(); if (this.net === net) net.setMe({ ...profile, name: profile.name.trim() || 'Spiller' }); this.updateLobby(); }, 'DIN BRIKKE');
      });
      const link = $('[data-link]', el);
      const copy = (text, what) => {
        const ok = () => toast(`${ICO.check}<span>${what} er kopiert</span>`, '#22b864', 1.8, true);
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, () => { link.select(); try { document.execCommand('copy'); ok(); } catch (e) { /* */ } });
        else { link.select(); try { document.execCommand('copy'); ok(); } catch (e) { /* */ } }
      };
      $('[data-copy]', el).addEventListener('click', () => { MP.Sound.click(); copy(net.view().link, 'Lenken'); });
      $('[data-copy-code]', el).addEventListener('click', () => { MP.Sound.click(); copy(net.room, 'Koden'); });
      link.addEventListener('focus', () => link.select());
      const sh = $('[data-share]', el);
      if (sh) sh.addEventListener('click', () => {
        MP.Sound.click();
        navigator.share({ title: 'Oslopoly', text: `Bli med i Oslopoly! Romkode: ${net.room}`, url: net.view().link }).catch(() => {});
      });
      const opts = $('#online-opts', el);
      if (opts) { renderSetupOpts(opts); this.optSent = JSON.stringify(this.netOpts()); }
      const list = $('[data-players]', el);
      list.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || !this.net || this.net.role !== 'host') return;
        if (b.dataset.rm) { MP.Sound.click(); const r = b.dataset.rm; if (r[0] === 'a') this.net.removeAI(Number(r.slice(1))); else this.net.kick(r.slice(1)); return; }
        if (b.hasAttribute('data-add-ai')) {
          MP.Sound.click();
          const v = this.net.view();
          const used = new Set([...v.members, ...v.ais].map((x) => x.name));
          this.net.addAI({ name: AI_NAMES.find((nm) => !used.has(nm)) || 'Data', level: 'normal' });
        }
      });
    },
    updateLobby() {
      const net = this.net, el = $('#online-body');
      if (!net || !el || this.onlKind !== 'lobby') return;
      const v = net.view(), host = v.role === 'host';
      const me = v.members.find((x) => x.pub === v.me);
      if (me) {
        profile.token = me.token || profile.token; profile.color = me.color || profile.color;
        const inp = $('[data-name]', el);
        if (inp && document.activeElement !== inp && me.name && inp.value.trim() !== me.name) { inp.value = me.name; profile.name = me.name; }
        saveProfile();
      }
      const pr = $('[data-me-portrait]', el);
      if (pr) pr.innerHTML = portrait(profile.token, profile.color, 'md');
      const row = $('[data-me-row]', el); if (row) row.style.setProperty('--pc', profile.color);
      $('[data-code-big]', el).innerHTML = [...(v.room || '')].map((ch) => `<span>${esc(ch)}</span>`).join('');
      const link = $('[data-link]', el); if (link && link.value !== v.link) link.value = v.link;
      const lost = !!this.hostLost && !host;
      const st = v.status === 'on' ? (lost ? 'lost' : 'on') : 'off';
      $('[data-status]', el).innerHTML = `<i class="on-dot ${st === 'on' ? 'on' : 'off'}"></i><span>${st === 'on' ? `Tilkoblet via ${esc(v.broker)}` : st === 'lost' ? 'Verten svarer ikke – venter …' : 'Kobler til igjen …'}</span>`;
      const total = v.members.length + v.ais.length;
      $('[data-count]', el).textContent = `${total}/6`;
      const lvlName = (l) => (LEVELS.find((x) => x[0] === l) || LEVELS[1])[1];
      const rowHTML = (x, kind, k) => {
        const isMe = kind === 'm' && x.pub === v.me;
        const badges = `${x.host ? '<span class="on-badge host">VERT</span>' : ''}${isMe ? '<span class="on-badge me">DEG</span>' : ''}${kind === 'a' ? '<span class="on-badge ai">DATA</span>' : ''}`;
        const stTxt = kind === 'a' ? '' : `<span class="on-st ${x.online ? 'on' : 'off'}"><i class="on-dot ${x.online ? 'on' : 'off'}"></i>${x.online ? 'tilkoblet' : 'frakoblet'}</span>`;
        const lvl = kind === 'a' ? (host ? segHTML('lvl' + k, LEVELS, x.level || 'normal', 'full plevel') : `<span class="on-st">${lvlName(x.level)}</span>`) : '';
        const rm = host && !isMe && !x.host ? `<button type="button" class="rbtn red sm rm" data-rm="${kind === 'a' ? 'a' + k : 'm' + esc(x.pub)}" title="${kind === 'a' ? 'Fjern datamaskinen' : 'Fjern fra rommet'}" aria-label="Fjern ${esc(x.name)}">${RI.close}</button>` : '';
        return `<div class="prow on-row ${isMe ? 'me' : ''} ${kind === 'm' && !x.online ? 'off' : ''}" style="--pc:${x.color}">${portrait(x.token, x.color, 'md')}
          <div class="prow-main"><div class="prow-line"><b class="on-name">${esc(x.name)}</b>${badges}${rm}</div><div class="on-line2">${stTxt}${lvl}</div></div></div>`;
      };
      const list = $('[data-players]', el);
      list.innerHTML = v.members.map((x) => rowHTML(x, 'm')).join('') + v.ais.map((x, k) => rowHTML(x, 'a', k)).join('')
        + (host && total < 6 ? '<button type="button" class="prow add" data-add-ai><span class="plus">+</span>Legg til datamaskin</button>' : '')
        + (total < 2 ? `<p class="on-note on-wait">${host ? 'Send koden eller lenken til vennene dine, eller legg til en datamaskin.' : 'Venter på flere spillere …'}</p>` : '');
      if (host) wireControls(list, (name, val) => { if (name.startsWith('lvl')) this.net.setAILevel(Number(name.slice(3)), val); }, () => {});
      const rules = $('[data-rules]', el);
      if (rules) {
        const o = v.opts || {};
        const act = activeRules(o.rules || {});
        rules.innerHTML = `<ul class="on-rlist"><li><b>Startkapital</b><span>${kr(o.money || 30000)}</span></li><li><b>Spillengde</b><span>${o.maxRounds ? o.maxRounds + ' runder' : 'Uten slutt'}</span></li>
          <li><b>Auksjon</b><span>${o.auction === false ? 'Av' : 'På'}</span></li><li><b>Husregler</b><span>${act.length ? act.map((r) => esc(r.name)).join(' · ') : 'Klassiske regler'}</span></li></ul>`;
      }
      // Startlinja.
      const bar = $('#online-bar');
      bar.hidden = false;
      const hum = v.members.filter((x) => x.online || x.host).length;
      const ra = activeRules((v.opts && v.opts.rules) || {});
      $('#online-sum').innerHTML = `<b>${hum + v.ais.length} spillere</b><span>${hum} menneske${hum === 1 ? '' : 'r'} · ${v.ais.length} data · ${ra.length ? `${ra.length} husregl${ra.length > 1 ? 'er' : 'el'}` : 'klassisk'}${host ? '' : ' · venter på at verten starter'}</span>`;
      const go = $('#online-go');
      if (host) {
        const can = net.canStart();
        if (!$('[data-start]', go)) {
          go.innerHTML = `<button type="button" class="btn go big" data-primary data-start>${pill('START SPILLET', 'alle på hver sin skjerm')}</button>`;
          $('[data-start]', go).addEventListener('click', () => {
            if (!this.ready) { toast('Vent litt – brettet lastes …', '#F7941D', 2, true); return; }
            MP.Sound.ensure();
            if (!this.net || !this.net.startGame()) toast('Dere må være minst to spillere', '#E3242B', 2.4, true);
          });
        }
        const b = $('[data-start]', go);
        b.disabled = !can;
        b.title = can ? 'Start spillet for alle' : 'Dere må være minst to spillere';
      } else go.innerHTML = '<span class="on-waitstart"><span class="spin" aria-hidden="true"></span>Venter på verten …</span>';
    },
    // ---------- Online: kroker som net.js kaller ----------
    netLobby() { if (!$('#online').hidden) this.renderOnline(); },
    netPresence() { if (this.game && !$('#hud').hidden) { this.scheduleRender(); } else this.netLobby(); },
    async netStartHost(game, resumed, opts) {
      await this.whenReady();
      if (opts) this.lastOpts = JSON.parse(JSON.stringify(opts));
      if (!resumed) game.s.speed = speed;
      this.onl.joined = true;
      this.begin(game, { quick: resumed });
    },
    async netStartMirror(game, resumed) {
      await this.whenReady();
      this.onl.joined = true;
      await this.begin(game, { mirror: true, quick: resumed });
    },
    netResynced() {
      const g = this.game;
      if (!g) return;
      try { MP.Board3D.placeAll(g.s); } catch (e) { console.warn(e); }
      this.render();
    },
    // «Venter på NAVN …» i bunnlinja (eller i auksjonen) mens en spiller på en annen skjerm bestemmer seg.
    netShowWaiting(p, m, a = []) {
      if (!p || this.over || !this.game) return;
      if (m === 'auctionBid') { if (this.auc) this.drawAuction(null, null, `Venter på bud fra ${esc(p.name)} …`); return; }
      if (pendingHuman > 0 || this.phaseDone) return; // en egen beslutning er åpen: ikke rør bunnlinja
      const what = {
        humanPhase: a[1] === 'pre' ? 'skal kaste' : 'avslutter turen', offerBuy: 'vurderer å kjøpe', jailChoice: 'sitter i fengsel', raiseFunds: 'skaffer penger',
        tradeOffer: 'svarer på et tilbud', chanceChoice: 'velger Sjanse', goChoice: 'velger på Start', busChoice: 'velger buss', speedChoice: 'velger felt',
      }[m] || 'tenker';
      this.setTurnInfo(p, what);
      this.setActions([{ label: `Venter på ${p.name} …`, short: 'Venter …', cls: 'wait', disabled: true, icon: ICO.clock, onClick() {} }]);
      this.waitShown = true;
    },
    netClearWaiting() {
      if (!this.waitShown) return;
      this.waitShown = false;
      if (pendingHuman === 0 && !this.phaseDone) this.setActions([]);
    },
    netRestoreAuction(auc) {
      const g = this.game;
      if (!g || !auc || this.auc || this.over) return;
      const bidders = (auc.bidders || []).map((id) => g.player(id)).filter(Boolean);
      this.auc = {
        i: auc.i, bidders, out: new Set(auc.out || []), high: auc.high || 0, leader: auc.leader != null ? g.player(auc.leader) : null,
        bids: (auc.bids || []).map((b) => ({ p: g.player(b.p), v: b.v })).filter((b) => b.p),
      };
      this.auc.m = openModal('', { cls: 't-orange auc-modal' });
      this.drawAuction();
    },
    // Rydder spillet bort (tilbake til lobbyen eller etter at rommet er stengt).
    teardownGame() {
      const g = this.game;
      if (g) g.stopped = true;
      this.game = null; this.over = false; this.auc = null; this.phaseDone = null; this.pickCb = null; this.mapDraw = null;
      pendingHuman = 0;
      flushWaits(); clearSplash(); hideBanner();
      $('#toasts').innerHTML = ''; $('#floats').innerHTML = ''; $('#modals').innerHTML = '';
      $('#hud').hidden = true; $('#skip').hidden = true;
      $$('.peek-back').forEach((e) => e.remove());
      document.body.classList.remove('in-game', 'map-open', 'side-open');
      this.netHostLost(false);
      const B = MP.Board3D;
      try {
        B.hideReach?.();
        B.setPlayers([]);
        const props = {};
        SQ.forEach((s, i) => { if (MP.isOwnable(i)) props[i] = { owner: null, houses: 0, mortgaged: false }; });
        B.syncProps({ players: [], props }, false);
      } catch (e) { console.warn(e); }
      syncBlur();
    },
    netToLobby() {
      this.teardownGame();
      this.showOnline();
    },
    netEnded(why) {
      if (this.game) this.teardownGame();
      if (this.net) { try { this.net.shutdown(true); } catch (e) { /* */ } }
      this.net = null; this.onl.joined = false; this.onl.busy = '';
      document.body.classList.remove('net-on');
      MP.Net && MP.Net.clearURL();
      this.showOnline({ err: why || 'Rommet er stengt.' });
    },
    netSeats(err) {
      if (this.game) this.teardownGame();
      if (this.net) { try { this.net.shutdown(true); } catch (e) { /* */ } }
      this.net = null; this.onl.joined = false; this.onl.busy = '';
      this.onl.seats = { code: this.onl.code, list: err.seats || [] };
      this.showOnline({ err: err.message });
    },
    netHostLost(on) {
      on = !!on;
      this.hostLost = on;
      const el = $('#net-pause');
      if (el) {
        const show = on && !!this.game && !$('#hud').hidden;
        el.hidden = !show;
        if (show && !el.firstElementChild) el.innerHTML = `<div class="np-box">${title('SPILLET ER PAUSET', 'slate')}<p><b>Verten har mistet forbindelsen.</b> Spillet fortsetter av seg selv når verten er tilbake.</p><p class="note">Du trenger ikke gjøre noe. Verten kan laste siden på nytt eller gjenoppta rommet fra «Spill online».</p></div>`;
      }
      this.renderChips();
      this.netLobby();
    },
    netFast(on) {
      on = !!on;
      if (on === netFast) return;
      netFast = on;
      try { MP.Board3D && MP.Board3D.setSkip && MP.Board3D.setSkip(skipFlag || netFast); } catch (e) { console.warn(e); }
      if (on) { flushWaits(); clearSplash(); }
    },
    netToast(text) { toast(`${ICO.warn}<span>${esc(text)}</span>`, '#E3242B', 2.6, true); },
  };

  function confetti() {
    const c = $('#confetti'), ctx = c.getContext('2d');
    c.width = innerWidth; c.height = innerHeight;
    const cols = ['#E3242B', '#FFE21F', '#1FAF55', '#1E88E5', '#F7941D', '#E0368F', '#14c4b0'];
    const parts = Array.from({ length: 240 }, () => ({ x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.6, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4, r: Math.random() * 6, s: 6 + Math.random() * 7, c: cols[Math.floor(Math.random() * cols.length)] }));
    const t0 = performance.now();
    const step = (now) => {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.r += 0.1;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
      }
      if (now - t0 < 6500) requestAnimationFrame(step); else ctx.clearRect(0, 0, c.width, c.height);
    };
    requestAnimationFrame(step);
  }

  MP.UI = UI;
  // F14: hvis 3D-biblioteket (fra nettet) ikke er lastet innen 12 s, si tydelig hva som mangler.
  setTimeout(() => { if (!UI.ready) UI.netFail(true); }, 12000);
})();

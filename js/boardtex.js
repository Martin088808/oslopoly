// Brettflaten: tegner hele brettet (felt, farger, ikoner, hjørner og midtfelt) på et canvas.
// board3d.js bruker MP.BoardTex.draw() som tekstur og MP.BoardTex.frameColor til rammen.
// Stil: sommerlig og fargerik (sterke, mettede farger med mørke konturer), men lettlest.
(function () {
  'use strict';
  const MP = window.MP;
  const SQ = MP.SQUARES;
  const TEX_HALF = 6.5, TEX = 4096, P = TEX / (TEX_HALF * 2);
  const BAND = 0.34;
  const sideOf = (i) => Math.floor(i / 10);
  const kOf = (i) => i % 10;
  function localRect(i) {
    const k = kOf(i);
    return k === 0 ? { x0: 4.5, x1: 6.1, z0: 4.5, z1: 6.1 } : { x0: 4.5 - k, x1: 5.5 - k, z0: 4.5, z1: 6.1 };
  }

  // ---------- Farger ----------
  const INK = '#13171c';
  // Brettets egen feltfarge (lys mintgrå som i Monopoly Plus). Lyset i scenen gjør teksturen ca. 1,2× lysere,
  // så fargen er valgt litt mørk her for å ende som en tydelig, men lys, brettfarge og ikke hvit.
  const SQUARE_TOP = '#BBD3C3', SQUARE_BOT = '#A9C5B3';
  const FRAME = '#1C56C9';            // kongeblå kant (samme som 3D-rammen)
  const FRAME_LINE = '#FFD23F';       // gul tynn stripe i kanten
  const GREEN_IN = '#C8F59A', GREEN_MID = '#6FD36A', GREEN_OUT = '#28B04F';
  // NB: Lyssettingen i 3D gjør brettflaten ca. 1,2× lysere (sRGB). Kanaler over ~210 klippes
  // derfor mot hvitt – fargene under holdes mettede og litt «mørke» i teksturen med vilje.
  const LIGHT_GAIN = 1.2;
  const SPECIAL = {
    chance: ['#FFBE45', '#EE8410'],
    chest: ['#6A9BF5', '#3563D2'],
    station: ['#45C99C', '#14936E'],
    bulb: ['#A08CF2', '#6B52D6'],
    tap: ['#5CC8EE', '#1F95D0'],
    tax: ['#FF8C68', '#E2503A'],
    ring: ['#F57FC4', '#CF3F92'],
  };
  function hexRgb(h) {
    if (Array.isArray(h)) return h;
    if (h[0] === 'r') return h.match(/\d+/g).slice(0, 3).map(Number);
    const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const css = (a) => 'rgb(' + a.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',') + ')';
  function mixA(a, b, t) { const A = hexRgb(a), B = hexRgb(b); return A.map((v, i) => v + (B[i] - v) * t); }
  function mix(a, b, t) { return css(mixA(a, b, t)); }
  function lum(h) { const [r, g, b] = hexRgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
  // WCAG relativ luminans av fargen slik den faktisk vises på brettet (etter lysforsterkning).
  function relLumShown(h) {
    const f = (v) => { v = Math.min(255, v * LIGHT_GAIN) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const [r, g, b] = hexRgb(h); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const INK_L = 0.0085;
  // true → mørk tekst; false → hvit tekst med mørk kontur. Hvit tekst har alltid en tykk
  // mørk kontur, så den er trygg på mellomtoner; mørk tekst brukes bare på tydelig lyse
  // bakgrunner (lyseblå, gul, oransje, Sjanse, stasjon, Vannverket).
  function darkTextOn(bg) {
    const L = relLumShown(bg);
    return contrast(L, INK_L) >= 6 * contrast(L, 1);
  }
  // Feltfarge: samme fargetone, men med høy metning og begrenset lyshet, slik at lyse
  // gruppefarger (lyseblå, gul) ikke blekes ut til hvitt av lyset.
  function fieldColor(h, maxL, minS) {
    let [r, g, b] = hexRgb(h).map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hue = 0, l = (mx + mn) / 2, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d) hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360; l = Math.min(l, maxL); s = Math.max(s, minS);
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
    const seg = Math.floor(hue / 60);
    [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
    return [r + m, g + m, b + m].map((v) => v * 255);
  }

  // ---------- Tekst ----------
  const kr = (n) => 'kr ' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  // ---------- Feltnavn: størst mulig, lesbar tekst ----------
  // Prøver alle linjedelinger (maks 3 linjer, også bindestrek før vanlige etterledd som
  // -VEIEN/-GATE/-PLASSEN) og lett kondensering (horisontal skalering ned til 80 %),
  // og velger varianten som gir størst skrift.
  const SUFFIXES = ['PLASSEN', 'VEIEN', 'STREDET', 'TORVET', 'GATE', 'GATA', 'HAGEBY', 'STASJON', 'VERKET', 'VERKER', 'SKATT'];
  const SQ_MIN = 0.74;
  function nameTokens(text) {
    const toks = [];
    text.split(' ').forEach((w, wi, arr) => {
      let parts = [w];
      if (w.length >= 9) {
        for (const s of SUFFIXES) {
          if (w.length - s.length >= 4 && w.endsWith(s)) { parts = [w.slice(0, w.length - s.length), s]; break; }
        }
      }
      parts.forEach((p, pi) => toks.push({ t: p, join: pi < parts.length - 1 ? '-' : (wi < arr.length - 1 ? ' ' : '') }));
    });
    return toks;
  }
  function fitName(ctx, text, maxW, maxH, maxSize, weight, maxLines) {
    const toks = nameTokens(text), n = toks.length, LH = 1.04;
    ctx.font = `${weight} 100px Montserrat`;
    let best = null;
    for (let mask = 0; mask < (1 << Math.max(0, n - 1)); mask++) {
      const lines = []; let cur = '', hyph = 0;
      for (let i = 0; i < n; i++) {
        cur += toks[i].t;
        const brk = i === n - 1 || (mask >> i) & 1;
        if (brk) {
          if (i < n - 1 && toks[i].join === '-') { cur += '-'; hyph++; }
          lines.push(cur); cur = '';
        } else cur += toks[i].join === '-' ? '' : ' ';
      }
      if (lines.length > (maxLines || 3)) continue;
      // en bindestrek på linjeslutt får «henge» litt ut i margen (optisk sentrering)
      const w100 = Math.max(...lines.map((l) => ctx.measureText(l).width - (l.endsWith('-') ? ctx.measureText('-').width * 0.6 : 0))) / 100;
      const size = Math.min(maxSize, maxW / (w100 * SQ_MIN), maxH / (lines.length * LH));
      const sq = Math.min(1, maxW / (w100 * size));
      const score = size * (1 - 0.06 * (lines.length - 1) - 0.1 * hyph - 0.25 * (1 - sq));
      if (!best || score > best.score) best = { lines, size, sq, lh: size * LH, score };
    }
    return best;
  }
  // Tegner navnet sentrert fra toppen (y = topp av første linje).
  // dark=true → mørk tekst; ellers hvit tekst med mørk kontur.
  function drawName(ctx, fit, cx, y, dark, weight) {
    ctx.save();
    ctx.font = `${weight} ${fit.size}px Montserrat`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
    fit.lines.forEach((l, i) => {
      ctx.save(); ctx.translate(cx, y + i * fit.lh); ctx.scale(fit.sq, 1);
      if (dark) {
        ctx.lineWidth = fit.size * 0.14; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.strokeText(l, 0, 0);
        ctx.fillStyle = INK; ctx.fillText(l, 0, 0);
      } else {
        ctx.lineWidth = fit.size * 0.2; ctx.strokeStyle = INK; ctx.strokeText(l, 0, 0);
        ctx.fillStyle = '#ffffff'; ctx.fillText(l, 0, 0);
      }
      ctx.restore();
    });
    ctx.restore();
  }
  // Mørk tekst med hvit «glorie» (hjørnefeltene) – lesbar på alle fargede bakgrunner.
  function haloText(ctx, text, x, y, size, weight, family) {
    ctx.save();
    ctx.font = `${weight} ${size}px ${family || 'Montserrat'}`; ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.2; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = INK; ctx.fillText(text, x, y);
    ctx.restore();
  }

  // Hvit «pille» med pris – gir skarp, lesbar tekst på alle bakgrunner.
  function pricePill(ctx, text, cx, cy, px, fill, ink) {
    ctx.save();
    let fs = px(0.13);
    ctx.font = `800 ${fs}px Montserrat`;
    const maxTw = px(0.8);
    if (ctx.measureText(text).width > maxTw) { fs *= maxTw / ctx.measureText(text).width; ctx.font = `800 ${fs}px Montserrat`; }
    const w = ctx.measureText(text).width + px(0.15), h = px(0.21);
    ctx.fillStyle = 'rgba(10,15,30,0.28)';
    ctx.beginPath(); ctx.roundRect(cx - w / 2, cy - h / 2 + px(0.022), w, h, h / 2); ctx.fill();
    ctx.beginPath(); ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.fillStyle = fill || '#ffffff'; ctx.fill();
    ctx.lineWidth = px(0.012); ctx.strokeStyle = INK; ctx.stroke();
    ctx.fillStyle = ink || INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + px(0.006));
    ctx.restore();
  }
  // Solstråler (vekselvise kiler) rundt et punkt.
  function rays(ctx, cx, cy, r, n, col, rot) {
    ctx.save(); ctx.fillStyle = col; ctx.beginPath();
    for (let i = 0; i < n; i += 2) {
      const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2;
      ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r); ctx.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r); ctx.closePath();
    }
    ctx.fill(); ctx.restore();
  }

  // ---------- Ikoner ----------
  function icon(ctx, kind, cx, cy, sz, color) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const s = sz;
    if (kind === 'chance') {
      ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.beginPath(); ctx.arc(0, 0, s * 0.62, 0, 7); ctx.fill();
      ctx.font = `400 ${s * 1.25}px "Lilita One"`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = s * 0.12; ctx.strokeStyle = INK; ctx.strokeText('?', 0, s * 0.05);
      ctx.fillStyle = color; ctx.fillText('?', 0, s * 0.05);
    } else if (kind === 'chest') {
      ctx.fillStyle = '#2E7FD9'; ctx.strokeStyle = INK; ctx.lineWidth = s * 0.06;
      ctx.beginPath(); ctx.roundRect(-s * 0.55, -s * 0.05, s * 1.1, s * 0.55, s * 0.06); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.55, -s * 0.05); ctx.quadraticCurveTo(0, -s * 0.6, s * 0.55, -s * 0.05); ctx.closePath();
      ctx.fillStyle = '#5BA3F0'; ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#FFC93C'; ctx.fillRect(-s * 0.55, -s * 0.08, s * 1.1, s * 0.1); ctx.strokeRect(-s * 0.55, -s * 0.08, s * 1.1, s * 0.1);
      ctx.beginPath(); ctx.roundRect(-s * 0.1, -s * 0.12, s * 0.2, s * 0.26, s * 0.03); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#FFE680';
      for (const [x, y] of [[-0.3, -0.32], [0.05, -0.38], [0.3, -0.3]]) { ctx.beginPath(); ctx.arc(s * x, s * y, s * 0.09, 0, 7); ctx.fill(); ctx.stroke(); }
    } else if (kind === 'train') {
      ctx.fillStyle = INK; ctx.strokeStyle = INK; ctx.lineWidth = s * 0.05;
      ctx.beginPath(); ctx.roundRect(-s * 0.6, -s * 0.1, s * 0.85, s * 0.42, s * 0.06); ctx.fill();
      ctx.fillRect(s * 0.1, -s * 0.45, s * 0.42, s * 0.77);
      ctx.fillStyle = '#E3242B'; ctx.fillRect(s * 0.02, -s * 0.52, s * 0.58, s * 0.1);
      ctx.fillStyle = '#1C56C9'; ctx.fillRect(-s * 0.6, s * 0.02, s * 0.85, s * 0.08);
      ctx.fillStyle = INK; ctx.fillRect(-s * 0.48, -s * 0.38, s * 0.14, s * 0.3);
      ctx.fillStyle = '#FFE680'; ctx.fillRect(s * 0.18, -s * 0.36, s * 0.26, s * 0.2);
      ctx.beginPath(); ctx.moveTo(-s * 0.6, s * 0.3); ctx.lineTo(-s * 0.78, s * 0.42); ctx.lineTo(-s * 0.6, s * 0.42); ctx.fillStyle = INK; ctx.fill();
      for (const x of [-0.42, -0.12, 0.3]) { ctx.beginPath(); ctx.arc(s * x, s * 0.4, s * 0.13, 0, 7); ctx.fillStyle = '#E3242B'; ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.9; ctx.strokeStyle = INK; ctx.lineWidth = s * 0.03;
      for (const [x, y, r] of [[-0.42, -0.55, 0.1], [-0.28, -0.72, 0.13], [-0.05, -0.85, 0.16]]) { ctx.beginPath(); ctx.arc(s * x, s * y, s * r, 0, 7); ctx.fill(); ctx.stroke(); }
    } else if (kind === 'bulb') {
      ctx.fillStyle = '#FFE21F'; ctx.strokeStyle = INK; ctx.lineWidth = s * 0.06;
      ctx.beginPath(); ctx.arc(0, -s * 0.15, s * 0.38, Math.PI * 0.8, Math.PI * 2.2); ctx.lineTo(s * 0.16, s * 0.3); ctx.lineTo(-s * 0.16, s * 0.3); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#9aa3ad'; ctx.fillRect(-s * 0.17, s * 0.3, s * 0.34, s * 0.22); ctx.strokeRect(-s * 0.17, s * 0.3, s * 0.34, s * 0.22);
      ctx.beginPath(); ctx.moveTo(-s * 0.1, -s * 0.05); ctx.lineTo(-s * 0.05, s * 0.28); ctx.moveTo(s * 0.1, -s * 0.05); ctx.lineTo(s * 0.05, s * 0.28); ctx.stroke();
      ctx.strokeStyle = '#F7941D'; ctx.lineWidth = s * 0.08;
      for (let a = -2.6; a <= -0.5; a += 0.52) { ctx.beginPath(); ctx.moveTo(Math.cos(a) * s * 0.5, -s * 0.15 + Math.sin(a) * s * 0.5); ctx.lineTo(Math.cos(a) * s * 0.68, -s * 0.15 + Math.sin(a) * s * 0.68); ctx.stroke(); }
    } else if (kind === 'tap') {
      ctx.fillStyle = '#B7C2CE'; ctx.strokeStyle = INK; ctx.lineWidth = s * 0.06;
      ctx.beginPath(); ctx.roundRect(-s * 0.55, -s * 0.2, s * 0.8, s * 0.24, s * 0.05); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.roundRect(s * 0.05, -s * 0.2, s * 0.24, s * 0.45, s * 0.05); ctx.fill(); ctx.stroke();
      ctx.fillRect(-s * 0.2, -s * 0.42, s * 0.1, s * 0.22); ctx.strokeRect(-s * 0.2, -s * 0.42, s * 0.1, s * 0.22);
      ctx.fillStyle = '#E3242B'; ctx.beginPath(); ctx.ellipse(-s * 0.15, -s * 0.46, s * 0.26, s * 0.08, 0, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1F8FE5'; ctx.lineWidth = s * 0.035;
      for (const y of [0.42, 0.66]) { ctx.beginPath(); ctx.arc(s * 0.17, s * y, s * 0.085, 0, 7); ctx.fill(); ctx.stroke(); }
    } else if (kind === 'ring') {
      ctx.strokeStyle = '#E8B923'; ctx.lineWidth = s * 0.14;
      ctx.beginPath(); ctx.arc(0, s * 0.15, s * 0.36, 0, 7); ctx.stroke();
      ctx.strokeStyle = INK; ctx.lineWidth = s * 0.04;
      ctx.beginPath(); ctx.arc(0, s * 0.15, s * 0.44, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, s * 0.15, s * 0.28, 0, 7); ctx.stroke();
      ctx.fillStyle = '#9FE6FF';
      ctx.beginPath(); ctx.moveTo(0, -s * 0.18); ctx.lineTo(s * 0.22, -s * 0.4); ctx.lineTo(s * 0.12, -s * 0.55); ctx.lineTo(-s * 0.12, -s * 0.55); ctx.lineTo(-s * 0.22, -s * 0.4); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.moveTo(-s * 0.08, -s * 0.5); ctx.lineTo(0, -s * 0.5); ctx.lineTo(-s * 0.1, -s * 0.38); ctx.closePath(); ctx.fill();
    } else if (kind === 'tax') {
      ctx.fillStyle = '#FFE21F'; ctx.strokeStyle = INK; ctx.lineWidth = s * 0.06;
      ctx.beginPath(); ctx.arc(0, 0, s * 0.45, 0, 7); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, s * 0.34, 0, 7); ctx.stroke();
      ctx.fillStyle = INK; ctx.font = `400 ${s * 0.5}px "Lilita One"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('%', 0, s * 0.03);
    } else if (kind === 'car') {
      ctx.fillStyle = '#E3242B'; ctx.strokeStyle = INK; ctx.lineWidth = s * 0.05;
      ctx.beginPath(); ctx.moveTo(-s * 0.7, s * 0.15); ctx.lineTo(-s * 0.65, -s * 0.1); ctx.lineTo(-s * 0.3, -s * 0.15); ctx.lineTo(-s * 0.15, -s * 0.42);
      ctx.lineTo(s * 0.3, -s * 0.42); ctx.lineTo(s * 0.45, -s * 0.15); ctx.lineTo(s * 0.7, -s * 0.08); ctx.lineTo(s * 0.72, s * 0.15); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#9FE6FF'; ctx.beginPath(); ctx.moveTo(-s * 0.1, -s * 0.36); ctx.lineTo(s * 0.26, -s * 0.36); ctx.lineTo(s * 0.36, -s * 0.16); ctx.lineTo(-s * 0.22, -s * 0.16); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#FFE21F'; ctx.beginPath(); ctx.arc(s * 0.62, -s * 0.02, s * 0.05, 0, 7); ctx.fill();
      for (const x of [-0.4, 0.42]) { ctx.beginPath(); ctx.arc(s * x, s * 0.17, s * 0.15, 0, 7); ctx.fillStyle = INK; ctx.fill(); ctx.beginPath(); ctx.arc(s * x, s * 0.17, s * 0.06, 0, 7); ctx.fillStyle = '#ddd'; ctx.fill(); }
    } else if (kind === 'police') {
      ctx.strokeStyle = INK; ctx.lineWidth = s * 0.05;
      ctx.fillStyle = '#F2C9A0'; ctx.beginPath(); ctx.arc(0, s * 0.12, s * 0.32, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1D3F8F'; ctx.beginPath(); ctx.ellipse(0, -s * 0.18, s * 0.42, s * 0.16, 0, 0, 7); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.roundRect(-s * 0.32, -s * 0.5, s * 0.64, s * 0.3, s * 0.08); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#FFC93C'; ctx.beginPath(); ctx.arc(0, -s * 0.36, s * 0.08, 0, 7); ctx.fill();
      ctx.fillStyle = INK; for (const x of [-0.12, 0.12]) { ctx.beginPath(); ctx.arc(s * x, s * 0.08, s * 0.04, 0, 7); ctx.fill(); }
      ctx.beginPath(); ctx.moveTo(-s * 0.12, s * 0.27); ctx.lineTo(s * 0.12, s * 0.27); ctx.stroke();
      ctx.fillStyle = '#FF8FA0'; ctx.globalAlpha = 0.7;
      for (const x of [-0.22, 0.22]) { ctx.beginPath(); ctx.arc(s * x, s * 0.2, s * 0.06, 0, 7); ctx.fill(); }
    }
    ctx.restore();
  }

  // ---------- Oslo-illustrasjon i midtfeltet (tegnes i enheter) ----------
  // Hver side tegnes i sin egen ramme: grunnlinjen ligger mot brettets innerkant (y = +4.5),
  // og byggene «står opp» mot midten, slik at spilleren på den siden ser dem rett vei.
  const BASE = 4.12;
  function shp(ctx, pts, fill, lw) {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = lw || 0.022; ctx.strokeStyle = INK; ctx.stroke();
  }
  function bx(ctx, x, y, w, h, fill, lw) { shp(ctx, [[x, y], [x + w, y], [x + w, y - h], [x, y - h]], fill, lw); }
  function circ(ctx, x, y, r, fill, lw) { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = lw || 0.02; ctx.strokeStyle = INK; ctx.stroke(); }
  function grid(ctx, x, y, w, h, cols, rows, col) {
    ctx.fillStyle = col;
    const cw = w / cols, rh = h / rows;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) ctx.fillRect(x + i * cw + cw * 0.22, y - h + j * rh + rh * 0.22, cw * 0.56, rh * 0.5);
  }
  function tree(ctx, x, y, r, col) {
    bx(ctx, x - r * 0.15, y, r * 0.3, r * 0.9, '#8A5A34', 0.016);
    circ(ctx, x, y - r * 1.25, r, col || '#2FB24C', 0.02);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 1.55, r * 0.28, 0, 7); ctx.fill();
  }
  function pine(ctx, x, y, h, col) {
    shp(ctx, [[x - h * 0.32, y - h * 0.15], [x + h * 0.32, y - h * 0.15], [x, y - h]], col || '#1F8F4A', 0.018);
    bx(ctx, x - h * 0.05, y, h * 0.1, h * 0.15, '#8A5A34', 0.014);
  }
  function sailboat(ctx, x, y, s, sail, hull) {
    shp(ctx, [[x - 0.2 * s, y - 0.06 * s], [x + 0.22 * s, y - 0.06 * s], [x + 0.14 * s, y + 0.04 * s], [x - 0.13 * s, y + 0.04 * s]], hull || '#ffffff', 0.016);
    shp(ctx, [[x, y - 0.08 * s], [x, y - 0.55 * s], [x + 0.2 * s, y - 0.08 * s]], sail, 0.016);
    shp(ctx, [[x - 0.02 * s, y - 0.08 * s], [x - 0.02 * s, y - 0.45 * s], [x - 0.16 * s, y - 0.08 * s]], '#ffffff', 0.016);
  }
  function norFlag(ctx, x, y, w) {
    const h = w * 0.72;
    ctx.fillStyle = '#BA0C2F'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x + w * 0.27, y, w * 0.18, h); ctx.fillRect(x, y + h * 0.37, w, h * 0.26);
    ctx.fillStyle = '#00205B'; ctx.fillRect(x + w * 0.315, y, w * 0.09, h); ctx.fillRect(x, y + h * 0.435, w, h * 0.13);
    ctx.lineWidth = 0.012; ctx.strokeStyle = INK; ctx.strokeRect(x, y, w, h);
  }
  function waterStrip(ctx) {
    // Fjordkant langs hele innerkanten
    const g = ctx.createLinearGradient(0, BASE, 0, 4.5);
    g.addColorStop(0, '#45C3F5'); g.addColorStop(1, '#1E8FE0');
    ctx.fillStyle = g; ctx.fillRect(-4.5, BASE + 0.07, 9, 4.5 - BASE - 0.07);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 0.022; ctx.lineCap = 'round';
    for (let row = 0; row < 2; row++) {
      const y = BASE + 0.17 + row * 0.12;
      for (let x = -4.4 + row * 0.15; x < 4.4; x += 0.42) { ctx.beginPath(); ctx.arc(x + 0.08, y + 0.03, 0.08, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
    }
    // Kai
    ctx.fillStyle = '#FFD98A'; ctx.fillRect(-4.5, BASE, 9, 0.07);
    ctx.strokeStyle = INK; ctx.lineWidth = 0.018;
    ctx.beginPath(); ctx.moveTo(-4.5, BASE); ctx.lineTo(4.5, BASE); ctx.moveTo(-4.5, BASE + 0.07); ctx.lineTo(4.5, BASE + 0.07); ctx.stroke();
  }
  // Side 0 (Start-siden): Rådhuset, Barcode og Operaen
  function sceneSouth(ctx) {
    const B = BASE;
    // Rådhuset (logo-enden: maks høyde 1.0)
    const brick = '#D2603F', cap = '#F6E3BD', cop = '#3DBE97';
    bx(ctx, -2.62, B, 0.66, 0.5, brick);
    shp(ctx, [[-2.66, B - 0.5], [-1.92, B - 0.5], [-2.29, B - 0.66]], cop);
    for (const [x, h] of [[-3.1, 0.92], [-1.98, 0.98]]) {
      bx(ctx, x, B, 0.48, h, brick);
      bx(ctx, x - 0.03, B - h, 0.54, 0.06, cap);
      circ(ctx, x + 0.24, B - h + 0.24, 0.12, '#FFC93C');
      circ(ctx, x + 0.24, B - h + 0.24, 0.08, '#ffffff', 0.012);
      ctx.strokeStyle = INK; ctx.lineWidth = 0.014; ctx.beginPath();
      ctx.moveTo(x + 0.24, B - h + 0.24); ctx.lineTo(x + 0.24, B - h + 0.18); ctx.moveTo(x + 0.24, B - h + 0.24); ctx.lineTo(x + 0.29, B - h + 0.24); ctx.stroke();
      grid(ctx, x + 0.06, B - 0.06, 0.36, h - 0.48, 3, 5, '#7A2E1E');
    }
    grid(ctx, -2.56, B - 0.06, 0.54, 0.36, 4, 3, '#7A2E1E');
    // Barcode (midten: kan være høyest)
    const BC = [['#ffffff', 1.05], ['#2F6FD6', 1.4], ['#8FD9F5', 1.15], ['#F47C5C', 1.32], ['#1E3F7A', 0.98], ['#FFC93C', 1.2]];
    BC.forEach(([c, h], i) => {
      const x = -1.2 + i * 0.36;
      bx(ctx, x, B, 0.3, h, c);
      ctx.fillStyle = lum(c) > 0.6 ? 'rgba(19,23,28,0.35)' : 'rgba(255,255,255,0.45)';
      for (let k = 0; k < 6; k++) ctx.fillRect(x + 0.03 + k * 0.045, B - h + 0.06, 0.018 + (k % 3) * 0.006, h - 0.1);
    });
    // Operaen (kortbunke-enden: lav)
    shp(ctx, [[0.98, B], [3.15, B], [3.15, B - 0.16], [2.35, B - 0.46], [1.55, B - 0.46], [0.98, B - 0.12]], '#F7FAFC');
    bx(ctx, 1.65, B - 0.04, 0.62, 0.36, '#7FCBF2');
    ctx.strokeStyle = INK; ctx.lineWidth = 0.012; ctx.beginPath();
    for (let x = 1.75; x < 2.25; x += 0.1) { ctx.moveTo(x, B - 0.04); ctx.lineTo(x, B - 0.4); }
    ctx.stroke();
    shp(ctx, [[1.55, B - 0.46], [2.35, B - 0.46], [3.15, B - 0.16], [3.15, B - 0.12], [2.35, B - 0.4], [1.55, B - 0.4], [0.98, B - 0.12]], '#E4EDF2', 0.016);
    bx(ctx, 1.85, B - 0.46, 0.4, 0.22, '#E9EFF3');
    // Båter i fjorden
    sailboat(ctx, -3.75, B + 0.25, 0.9, '#E3242B');
    sailboat(ctx, 3.6, B + 0.25, 0.8, '#FFC93C');
  }
  // Side 1: Holmenkollen
  function sceneWest(ctx) {
    const B = BASE;
    // Åsen: avrundet kolle midt på siden (mørkere grønn, så den skiller seg fra midtfeltet)
    const HILL = [[2.3, 0], [1.9, 0.4], [1.4, 0.82], [0.8, 1.1], [0.2, 1.18], [-0.4, 1.0], [-0.9, 0.66], [-1.35, 0.3], [-1.75, 0]];
    const hillH = (x) => {
      for (let i = 0; i + 1 < HILL.length; i++) {
        const a = HILL[i], b = HILL[i + 1];
        if (x <= a[0] && x >= b[0]) return a[1] + (b[1] - a[1]) * (a[0] - x) / (a[0] - b[0]);
      }
      return 0;
    };
    // gress langs kaia
    shp(ctx, [[-3.45, B], [3.45, B], [3.3, B - 0.1], [-3.3, B - 0.1]], '#5CCB5A', 0.016);
    // granskog bak kollen
    for (const [x, h] of [[1.75, 0.6], [1.4, 0.56], [-0.85, 0.62], [-1.25, 0.5]]) pine(ctx, x, B - hillH(x) + 0.1, h, '#1F8F4A');
    shp(ctx, HILL.map(([x, h]) => [x, B - h]), '#1C9A49');
    shp(ctx, [[-1.75, B], [2.3, B], [1.8, B - 0.22], [0.7, B - 0.42], [-0.5, B - 0.36], [-1.4, B - 0.14]], '#57CF5C', 0.016);
    // Hoppbakken: tårn på toppen, unnarenn, hoppkant og bakke ned mot venstre
    const tx = 0.45, top = B - 1.66, hTop = B - hillH(tx);
    shp(ctx, [[tx - 0.13, hTop + 0.04], [tx + 0.15, hTop + 0.04], [tx + 0.1, top + 0.16], [tx - 0.08, top + 0.16]], '#DDE6EE');
    bx(ctx, tx - 0.17, top + 0.16, 0.36, 0.18, '#F6F8FA');
    bx(ctx, tx - 0.2, top - 0.02, 0.4, 0.07, '#E3242B', 0.018);
    const inX = -0.45, slope = 0.55, inY = (x) => top + 0.12 + (tx - x) * slope;
    ctx.strokeStyle = INK; ctx.lineWidth = 0.035; ctx.beginPath();
    for (const x of [0.1, -0.25]) { ctx.moveTo(x, inY(x) + 0.06); ctx.lineTo(x, B - hillH(x) + 0.03); }
    ctx.stroke();
    shp(ctx, [[tx - 0.08, inY(tx - 0.08) - 0.05], [inX, inY(inX) - 0.05], [inX - 0.05, inY(inX) + 0.08], [tx - 0.08, inY(tx - 0.08) + 0.08]], '#ffffff', 0.022);
    {
      const xs = [-0.6, -0.85, -1.1, -1.35, -1.6, -1.95];
      const up = xs.map((x, i) => [x, B - hillH(x) - 0.03 - 0.03 * (1 - i / 5)]), lo = xs.map((x) => [x, B - hillH(x) + 0.09]).reverse();
      shp(ctx, up.concat(lo), '#ffffff', 0.022);
    }
    norFlag(ctx, tx + 0.02, top - 0.27, 0.18);
    ctx.strokeStyle = INK; ctx.lineWidth = 0.018; ctx.beginPath(); ctx.moveTo(tx + 0.02, top - 0.02); ctx.lineTo(tx + 0.02, top - 0.28); ctx.stroke();
    // furu på kollens høyre side og ved kaia (logo-enden: maks 1.0 høy)
    for (const [x, h] of [[1.15, 0.36], [1.55, 0.4], [1.95, 0.34], [2.5, 0.42], [2.85, 0.36], [3.2, 0.44], [-2.2, 0.36], [-2.5, 0.3]]) pine(ctx, x, B - hillH(x) + 0.08, h, '#2FB24C');
    // Rød hytte (kortbunke-enden: lav)
    const hx = -3.15;
    bx(ctx, hx, B - 0.06, 0.42, 0.24, '#D7263D');
    shp(ctx, [[hx - 0.05, B - 0.3], [hx + 0.47, B - 0.3], [hx + 0.21, B - 0.46]], '#3B3F46');
    bx(ctx, hx + 0.06, B - 0.1, 0.1, 0.1, '#ffffff', 0.014);
    bx(ctx, hx + 0.26, B - 0.06, 0.09, 0.15, '#FFE680', 0.014);
  }
  // Side 2: Slottet
  function sceneNorth(ctx) {
    const B = BASE;
    // Slottsbakken (gress)
    shp(ctx, [[-3.4, B], [3.4, B], [3.1, B - 0.1], [-3.1, B - 0.1]], '#5CCB5A', 0.016);
    const cream = '#F7D774', roofC = '#6E8FA6';
    bx(ctx, -1.5, B - 0.1, 3.0, 0.5, cream);
    bx(ctx, -1.7, B - 0.1, 0.5, 0.42, cream); bx(ctx, 1.2, B - 0.1, 0.5, 0.42, cream);
    shp(ctx, [[-1.55, B - 0.6], [1.55, B - 0.6], [1.45, B - 0.72], [-1.45, B - 0.72]], roofC);
    shp(ctx, [[-1.75, B - 0.52], [-1.15, B - 0.52], [-1.2, B - 0.6], [-1.7, B - 0.6]], roofC, 0.016);
    shp(ctx, [[1.15, B - 0.52], [1.75, B - 0.52], [1.7, B - 0.6], [1.2, B - 0.6]], roofC, 0.016);
    grid(ctx, -1.45, B - 0.14, 2.9, 0.4, 16, 2, '#3A6FB0');
    // Portiko med søyler
    bx(ctx, -0.4, B - 0.1, 0.8, 0.5, '#FFF6DE');
    shp(ctx, [[-0.48, B - 0.6], [0.48, B - 0.6], [0, B - 0.8]], '#FFF6DE');
    ctx.fillStyle = INK; for (let i = 0; i < 5; i++) ctx.fillRect(-0.33 + i * 0.16, B - 0.52, 0.025, 0.38);
    // Flaggstang
    ctx.strokeStyle = INK; ctx.lineWidth = 0.016; ctx.beginPath(); ctx.moveTo(0, B - 0.8); ctx.lineTo(0, B - 1.32); ctx.stroke();
    norFlag(ctx, 0, B - 1.32, 0.24);
    // Trær i Slottsparken
    for (const [x, r, c] of [[-2.1, 0.2, '#2FB24C'], [-2.55, 0.24, '#49C05A'], [-3.05, 0.2, '#2FB24C'], [2.1, 0.18, '#49C05A'], [2.5, 0.16, '#2FB24C'], [2.9, 0.18, '#F49CBB']]) tree(ctx, x, B - 0.06, r, c);
    // Vaktbu
    bx(ctx, 1.95 - 0.55, B - 0.08, 0.14, 0.2, '#ffffff', 0.014);
    sailboat(ctx, -3.8, B + 0.26, 0.75, '#1F8FE5');
  }
  // Side 3: Akershus festning
  function sceneEast(ctx) {
    const B = BASE;
    shp(ctx, [[-2.0, B], [3.3, B], [3.1, B - 0.18], [-1.8, B - 0.18]], '#5CCB5A', 0.016);
    const stone = '#F1DDB0', wall = '#E2C68E', cop = '#2FAE8C';
    shp(ctx, [[-1.6, B - 0.18], [3.0, B - 0.18], [3.0, B - 0.36], [-1.6, B - 0.36]], wall);
    ctx.fillStyle = wall; ctx.strokeStyle = INK; ctx.lineWidth = 0.016;
    for (let x = -1.6; x < 2.95; x += 0.2) { ctx.fillRect(x, B - 0.44, 0.11, 0.08); ctx.strokeRect(x, B - 0.44, 0.11, 0.08); }
    bx(ctx, -0.3, B - 0.36, 1.9, 0.36, stone);
    grid(ctx, -0.25, B - 0.4, 1.8, 0.26, 10, 2, '#5C7FA8');
    shp(ctx, [[-0.36, B - 0.72], [1.66, B - 0.72], [1.4, B - 0.9], [-0.1, B - 0.9]], cop);
    for (const [x, h, w] of [[-0.75, 0.66, 0.36], [1.85, 0.74, 0.36]]) {
      bx(ctx, x, B - 0.36, w, h, stone);
      shp(ctx, [[x - 0.04, B - 0.36 - h], [x + w + 0.04, B - 0.36 - h], [x + w / 2, B - 0.36 - h - 0.42]], cop);
      bx(ctx, x + w / 2 - 0.05, B - 0.5, 0.1, 0.16, '#5C7FA8', 0.012);
    }
    ctx.strokeStyle = INK; ctx.lineWidth = 0.014; ctx.beginPath(); ctx.moveTo(2.03, B - 1.52); ctx.lineTo(2.03, B - 1.75); ctx.stroke();
    norFlag(ctx, 2.03, B - 1.75, 0.15);
    // Fyrtårn og seilbåter i fjorden (kortbunke-enden: lavt)
    const lx = -2.6;
    for (let i = 0; i < 4; i++) bx(ctx, lx - 0.1 + i * 0.012, B - i * 0.13, 0.2 - i * 0.024, 0.13, i % 2 ? '#ffffff' : '#E3242B', 0.016);
    bx(ctx, lx - 0.07, B - 0.52, 0.14, 0.1, '#FFE680', 0.014);
    shp(ctx, [[lx - 0.1, B - 0.62], [lx + 0.1, B - 0.62], [lx, B - 0.74]], '#E3242B', 0.016);
    sailboat(ctx, -3.5, B + 0.26, 0.9, '#E0368F');
    sailboat(ctx, -1.6, B + 0.26, 0.75, '#1FAF55');
    sailboat(ctx, 3.65, B + 0.26, 0.75, '#F7941D');
  }

  // ---------- Hele brettflaten ----------
  function drawBoardTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = TEX;
    const ctx = c.getContext('2d');
    const center = TEX / 2;
    const px = (v) => v * P;
    // Kant (utenfor feltene): kongeblå med gul stripe
    ctx.fillStyle = FRAME; ctx.fillRect(0, 0, TEX, TEX);
    ctx.strokeStyle = FRAME_LINE; ctx.lineWidth = px(0.035);
    ctx.strokeRect(center - px(6.27), center - px(6.27), px(12.54), px(12.54));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    // Midtfeltet: frisk grønn solstråle-bakgrunn
    ctx.save();
    ctx.translate(center, center);
    ctx.beginPath(); ctx.rect(px(-4.5), px(-4.5), px(9), px(9)); ctx.clip();
    const grd = ctx.createRadialGradient(0, 0, px(0.3), 0, 0, px(6.3));
    grd.addColorStop(0, GREEN_IN); grd.addColorStop(0.45, GREEN_MID); grd.addColorStop(1, GREEN_OUT);
    ctx.fillStyle = grd; ctx.fillRect(px(-4.5), px(-4.5), px(9), px(9));
    rays(ctx, 0, 0, px(6.5), 36, 'rgba(255,255,255,0.13)', -Math.PI / 4);
    // små prikker/konfetti for litt «papir»-liv
    {
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (let i = 0; i < 260; i++) { const x = (rnd() - 0.5) * 9, y = (rnd() - 0.5) * 9; ctx.beginPath(); ctx.arc(px(x), px(y), px(0.012 + rnd() * 0.02), 0, 7); ctx.fill(); }
    }
    // Oslo rundt kanten
    const scenes = [sceneSouth, sceneWest, sceneNorth, sceneEast];
    for (let s = 0; s < 4; s++) {
      ctx.save(); ctx.rotate((s * Math.PI) / 2); ctx.scale(P, P);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      waterStrip(ctx);
      ctx.restore();
    }
    for (let s = 0; s < 4; s++) {
      ctx.save(); ctx.rotate((s * Math.PI) / 2); ctx.scale(P, P);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      scenes[s](ctx);
      ctx.restore();
    }
    // Kortplasser
    const cardSpot = (x, z, label, col, ink) => {
      ctx.save(); ctx.translate(px(x), px(z)); ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.beginPath(); ctx.roundRect(px(-0.85), px(-0.55), px(1.7), px(1.1), px(0.08)); ctx.fill();
      ctx.setLineDash([px(0.08), px(0.05)]); ctx.lineWidth = px(0.03); ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `800 ${px(0.15)}px Montserrat`; ctx.textBaseline = 'middle';
      const w = ctx.measureText(label).width + px(0.24), h = px(0.26);
      ctx.beginPath(); ctx.roundRect(-w / 2, px(0.72) - h / 2, w, h, h / 2);
      ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = px(0.016); ctx.strokeStyle = INK; ctx.stroke();
      ctx.fillStyle = ink; ctx.fillText(label, 0, px(0.73));
      ctx.restore();
    };
    cardSpot(-2.35, -2.35, 'PRØV LYKKEN', '#1F63B5', '#ffffff');
    cardSpot(2.35, 2.35, 'SJANSE', '#F7941D', INK);
    // Logo: Oslopoly – eget blått skilt med gullkant (ikke det klassiske røde båndet).
    ctx.save(); ctx.rotate(-Math.PI / 4);
    const lw = 7.0, lh = 1.5;
    ctx.fillStyle = 'rgba(10,40,20,0.28)';
    ctx.beginPath(); ctx.roundRect(px(-lw / 2 + 0.06), px(-lh / 2 + 0.1), px(lw), px(lh), px(0.55)); ctx.fill();
    ctx.beginPath(); ctx.roundRect(px(-lw / 2), px(-lh / 2), px(lw), px(lh), px(0.55));
    const lg = ctx.createLinearGradient(0, px(-lh / 2), 0, px(lh / 2));
    lg.addColorStop(0, '#3E8BF0'); lg.addColorStop(1, '#1440A0');
    ctx.fillStyle = lg; ctx.fill();
    ctx.lineWidth = px(0.12); ctx.strokeStyle = '#FFD23F'; ctx.stroke();
    ctx.lineWidth = px(0.035); ctx.strokeStyle = INK;
    ctx.beginPath(); ctx.roundRect(px(-lw / 2 - 0.07), px(-lh / 2 - 0.07), px(lw + 0.14), px(lh + 0.14), px(0.6)); ctx.stroke();
    ctx.font = `400 ${px(1.0)}px "Lilita One"`; ctx.textBaseline = 'middle';
    ctx.lineWidth = px(0.11); ctx.strokeStyle = INK; ctx.lineJoin = 'round';
    ctx.strokeText('OSLOPOLY', 0, px(0.0));
    ctx.fillStyle = '#FFE680'; ctx.fillText('OSLOPOLY', 0, px(0.0));
    // «OSLO»-bånd
    ctx.font = `800 ${px(0.3)}px Montserrat`;
    const sw = ctx.measureText('— O S L O —').width + px(0.5);
    ctx.beginPath(); ctx.roundRect(-sw / 2, px(0.84), sw, px(0.38), px(0.19));
    ctx.fillStyle = '#FFD23F'; ctx.fill(); ctx.lineWidth = px(0.03); ctx.strokeStyle = INK; ctx.stroke();
    ctx.fillStyle = INK; ctx.fillText('— O S L O —', 0, px(1.04));
    ctx.restore();
    ctx.restore();

    // Feltene
    let chanceN = 0;
    const chanceCols = ['#1F8FE5', '#E3242B', '#8E3BD8'];
    for (let i = 0; i < 40; i++) {
      const sq = SQ[i], s = sideOf(i), k = kOf(i), r = localRect(i);
      ctx.save();
      ctx.translate(center, center);
      ctx.rotate((s * Math.PI) / 2);
      const x0 = px(r.x0), x1 = px(r.x1), z0 = px(r.z0), z1 = px(r.z1), w = x1 - x0, cx = (x0 + x1) / 2;
      if (k !== 0) {
        // Som i Monopoly Plus: alle felt har brettets egen farge; gatene har gruppefargen bare i båndet øverst.
        const h = z1 - z0;
        const g = ctx.createLinearGradient(0, z0, 0, z1);
        g.addColorStop(0, SQUARE_TOP); g.addColorStop(1, SQUARE_BOT);
        ctx.fillStyle = g; ctx.fillRect(x0, z0, w, h);
        // myk glans og tynn lys innerkant
        const gl = ctx.createRadialGradient(cx, z0 + px(0.55), 0, cx, z0 + px(0.55), px(0.9));
        gl.addColorStop(0, 'rgba(255,255,255,0.16)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gl; ctx.fillRect(x0, z0, w, h);
        if (sq.type === 'street') {
          const gc = MP.GROUPS[sq.group].color;
          ctx.lineWidth = px(0.012); ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.strokeRect(x0 + px(0.035), z0 + px(BAND + 0.035), w - px(0.07), h - px(BAND + 0.07));
          ctx.fillStyle = gc; ctx.fillRect(x0, z0, w, px(BAND));
          ctx.lineWidth = px(0.014); ctx.strokeStyle = INK; ctx.beginPath(); ctx.moveTo(x0, z0 + px(BAND)); ctx.lineTo(x1, z0 + px(BAND)); ctx.stroke();
          const t = fitName(ctx, sq.name.toUpperCase(), w * 0.88, px(0.52), px(0.17), 900, 3);
          drawName(ctx, t, cx, z0 + px(BAND + 0.1), true, 900);
          pricePill(ctx, kr(sq.price), cx, z1 - px(0.18), px);
        } else {
          ctx.lineWidth = px(0.012); ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.strokeRect(x0 + px(0.035), z0 + px(0.035), w - px(0.07), h - px(0.07));
          const label = sq.type === 'chance' ? 'SJANSE' : sq.name.toUpperCase();
          const t = fitName(ctx, label, w * 0.86, px(0.3), px(0.145), 900, 2);
          drawName(ctx, t, cx, z0 + px(0.09), true, 900);
          const iconY = z0 + px(0.86);
          if (sq.type === 'chance') icon(ctx, 'chance', cx, iconY + px(0.08), px(0.62), chanceCols[chanceN++ % 3]);
          if (sq.type === 'chest') icon(ctx, 'chest', cx, iconY + px(0.04), px(0.55));
          if (sq.type === 'station') icon(ctx, 'train', cx, iconY + px(0.02), px(0.44));
          if (sq.type === 'utility') icon(ctx, sq.icon, cx, iconY, px(0.48));
          if (sq.type === 'tax') icon(ctx, sq.amount === 2000 ? 'ring' : 'tax', cx, iconY, px(0.42));
          if (sq.price) pricePill(ctx, kr(sq.price), cx, z1 - px(0.17), px);
          if (sq.type === 'tax') pricePill(ctx, 'BETAL ' + kr(sq.amount), cx, z1 - px(0.17), px);
        }
      } else {
        drawCorner(ctx, sq, px, x0, z0, w);
      }
      ctx.lineWidth = px(0.014); ctx.strokeStyle = INK; ctx.strokeRect(x0, z0, w, z1 - z0);
      ctx.restore();
    }
    // Ytterkant og innerkant
    ctx.lineWidth = px(0.03); ctx.strokeStyle = INK;
    ctx.strokeRect(center - px(6.1), center - px(6.1), px(12.2), px(12.2));
    ctx.strokeRect(center - px(4.5), center - px(4.5), px(9), px(9));
    return c;
  }

  function cornerBg(ctx, x0, z0, w, c0, c1, ox, oz) {
    const g = ctx.createRadialGradient(ox, oz, 0, ox, oz, w * 1.2);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    ctx.fillStyle = g; ctx.fillRect(x0, z0, w, w);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, z0, w, w); ctx.clip();
    rays(ctx, ox, oz, w * 1.5, 28, 'rgba(255,255,255,0.22)', 0.1);
    ctx.restore();
  }

  function drawCorner(ctx, sq, px, x0, z0, w) {
    const cx = x0 + w / 2, cz = z0 + w / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (sq.type === 'jail') {
      const cell = px(1.15);
      // «På besøk»-delen
      { const gj = ctx.createLinearGradient(x0, z0, x0 + w, z0 + w); gj.addColorStop(0, '#5CC4F2'); gj.addColorStop(1, '#2E95DC'); ctx.fillStyle = gj; }
      ctx.fillRect(x0, z0, w, w);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      for (let i = 0; i < 6; i++) ctx.fillRect(x0 + cell + px(0.02), z0 + i * px(0.27), w - cell - px(0.04), px(0.12));
      // Fengselscellen
      const g = ctx.createLinearGradient(x0, z0, x0 + cell, z0 + cell);
      g.addColorStop(0, '#FFB23F'); g.addColorStop(1, '#F7741D');
      ctx.fillStyle = g; ctx.fillRect(x0, z0, cell, cell);
      ctx.save(); ctx.beginPath(); ctx.rect(x0, z0, cell, cell); ctx.clip();
      ctx.save(); ctx.translate(x0 + cell / 2, z0 + cell / 2); ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (let i = -6; i <= 6; i += 2) ctx.fillRect(px(i * 0.1), -px(1), px(0.1), px(2));
      ctx.fillStyle = '#FFF6DA'; ctx.strokeStyle = INK; ctx.lineWidth = px(0.03);
      ctx.beginPath(); ctx.roundRect(-px(0.38), -px(0.32), px(0.76), px(0.56), px(0.04)); ctx.fill();
      // fange bak gitteret
      ctx.fillStyle = '#F2C9A0'; ctx.beginPath(); ctx.arc(0, -px(0.02), px(0.15), 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = INK; ctx.fillRect(-px(0.15), -px(0.1), px(0.3), px(0.05));
      ctx.fillStyle = '#ffffff'; ctx.fillRect(-px(0.12), -px(0.12), px(0.08), px(0.04)); ctx.fillRect(px(0.04), -px(0.12), px(0.08), px(0.04));
      ctx.fillStyle = '#ffffff'; ctx.fillRect(-px(0.2), px(0.12), px(0.4), px(0.12));
      ctx.fillStyle = INK; ctx.fillRect(-px(0.2), px(0.16), px(0.4), px(0.04));
      ctx.lineWidth = px(0.04);
      for (let b = -0.3; b <= 0.31; b += 0.15) { ctx.beginPath(); ctx.moveTo(px(b), -px(0.32)); ctx.lineTo(px(b), px(0.24)); ctx.stroke(); }
      ctx.lineWidth = px(0.03); ctx.beginPath(); ctx.roundRect(-px(0.38), -px(0.32), px(0.76), px(0.56), px(0.04)); ctx.stroke();
      ctx.font = `900 ${px(0.15)}px Montserrat`;
      ctx.lineWidth = px(0.05); ctx.strokeStyle = '#ffffff'; ctx.strokeText('FENGSEL', 0, px(0.4));
      ctx.fillStyle = INK; ctx.fillText('FENGSEL', 0, px(0.4));
      ctx.restore(); ctx.restore();
      ctx.lineWidth = px(0.014); ctx.strokeStyle = INK; ctx.strokeRect(x0, z0, cell, cell);
      ctx.save(); ctx.translate(x0 + cell + (w - cell) / 2, z0 + cell / 2); ctx.rotate(-Math.PI / 2); haloText(ctx, 'PÅ', 0, 0, px(0.15), 900); ctx.restore();
      haloText(ctx, 'BESØK', x0 + cell / 2, z0 + cell + (w - cell) / 2, px(0.15), 900);
      return;
    }
    if (sq.type === 'go') {
      cornerBg(ctx, x0, z0, w, '#FFE45A', '#F2A800', x0 + w * 0.5, z0 + w * 0.5);
      ctx.save(); ctx.translate(cx, cz); ctx.rotate(-Math.PI / 4);
      haloText(ctx, 'MOTTA KR 4 000 I LØNN', 0, -px(0.42), px(0.12), 800);
      haloText(ctx, 'NÅR DE PASSERER', 0, -px(0.27), px(0.12), 800);
      ctx.font = `400 ${px(0.56)}px "Lilita One"`;
      ctx.lineJoin = 'round';
      ctx.lineWidth = px(0.11); ctx.strokeStyle = '#ffffff'; ctx.strokeText('START', 0, px(0.12));
      ctx.lineWidth = px(0.05); ctx.strokeStyle = INK; ctx.strokeText('START', 0, px(0.12));
      ctx.fillStyle = '#E3242B'; ctx.fillText('START', 0, px(0.12));
      ctx.restore();
      // Pil mot venstre (spilleretningen)
      ctx.save(); ctx.fillStyle = '#E3242B'; ctx.strokeStyle = INK; ctx.lineWidth = px(0.018); ctx.lineJoin = 'round';
      const y = z0 + w - px(0.22);
      ctx.beginPath(); ctx.moveTo(x0 + px(0.12), y); ctx.lineTo(x0 + px(0.42), y - px(0.15)); ctx.lineTo(x0 + px(0.42), y - px(0.06));
      ctx.lineTo(x0 + w - px(0.12), y - px(0.06)); ctx.lineTo(x0 + w - px(0.12), y + px(0.06)); ctx.lineTo(x0 + px(0.42), y + px(0.06)); ctx.lineTo(x0 + px(0.42), y + px(0.15)); ctx.closePath();
      ctx.fill(); ctx.stroke(); ctx.restore();
      return;
    }
    if (sq.type === 'parking') cornerBg(ctx, x0, z0, w, '#B794FF', '#7A45E0', cx, cz);
    else if (sq.type === 'gotojail') cornerBg(ctx, x0, z0, w, '#FF9C7E', '#E2482E', cx, cz);
    ctx.save(); ctx.translate(cx, cz); ctx.rotate(-Math.PI / 4);
    if (sq.type === 'parking') {
      haloText(ctx, 'GRATIS', 0, -px(0.52), px(0.17), 900);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.ellipse(0, px(0.02), px(0.48), px(0.32), 0, 0, 7); ctx.fill();
      icon(ctx, 'car', 0, 0, px(0.5));
      haloText(ctx, 'PARKERING', 0, px(0.5), px(0.17), 900);
    } else if (sq.type === 'gotojail') {
      haloText(ctx, 'DE SETTES', 0, -px(0.55), px(0.15), 900);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.arc(0, -px(0.02), px(0.38), 0, 7); ctx.fill();
      icon(ctx, 'police', 0, -px(0.02), px(0.62));
      haloText(ctx, 'I FENGSEL', 0, px(0.52), px(0.15), 900);
    }
    ctx.restore();
  }


  MP.BoardTex = {
    draw: drawBoardTexture,
    // Farge på brettets kant/ramme (sidene av brettet) i 3D.
    frameColor: FRAME,
  };
})();

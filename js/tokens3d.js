// Detaljerte 3D-spillebrikker i polert sølv: bil, flosshatt, skip, støvel, hund og fingerbøl.
//
// KONTRAKT (board3d.js er avhengig av denne – ikke endre):
//   MP.Tokens.build(THREE, id, colorHex) -> THREE.Group g
//     g.children[0] = sokkel (mesh i spillerens farge, med sølvkant som barn), radius ~0.26
//     g.children[1] = modellgruppe, position.y = 0.04, origo nederst i midten, fremover = +X,
//                     høyde ~0.3-0.4. g skaleres aldri. Alle meshes kaster og mottar skygge.
//     g.userData.tokenId = id
//   MP.Tokens.portrait(id, colorHex, sizePx = 128) -> dataURL (PNG med gjennomsiktig bakgrunn)
//   MP.Tokens.stats(id) -> { id, triangles, drawCalls, parts:[{key, tris}] }  (testsiden)
//
// ANIMERBARE DELER: g.userData.parts
//   Hver del er en THREE.Group inne i modellgruppen (g.children[1]) med origo (pivot) i delens
//   naturlige ledd. Hvilestilling = rotation (0,0,0) og den position delen har fra start.
//   Koordinater i modellen: +X fremover, +Y opp, +Z = brikkens høyre side, −Z = venstre side.
//
//   car     parts.wheels  Array(4) [foran +Z, foran −Z, bak +Z, bak −Z], pivot i hjulnavet.
//           g.userData.wheelAxis = 'z', g.userData.wheelRadius = 0.062.
//           Rulling fremover: wheel.rotation.z -= strekning / wheelRadius.
//           (Reservehjulet bak er fast og er ikke med.)
//   hat     parts.brim    Bremmen (med kantbånd og søm), pivot midt i hatten i bremhøyde (y 0.012).
//           rotation.x / rotation.z = vipp/vagg, position.y = løft.
//   ship    parts.flag    Flagget på stormasten, pivot der flagget sitter på masta; flagget peker
//                         akterover (−X). rotation.y = blafring (ca. ±0.4 rad).
//           parts.smoke   Tomt ankerpunkt (Group) midt på toppen av forreste skorstein.
//           parts.smoke2  Tomt ankerpunkt på toppen av akterste skorstein.
//                         Bruk getWorldPosition() for å sende ut røykpartikler.
//   boot    parts.laces   Sløyfen (knute, løkker og hengende lisseender), pivot i knuten foran
//                         på skaftet. rotation.x = sving sideveis, rotation.z = sving frem/tilbake.
//   dog     parts.head    Hode med snute, skjegg, øyne og nese, pivot i nakken (ved halsbåndet).
//                         rotation.y = snu hodet (+ = mot −Z/venstre), rotation.z = nikk (+ = nesen opp).
//           parts.ears    Array(2) [øre +Z, øre −Z], barn av head, pivot i ørets rot.
//                         rotation.z = legg øret bakover (+), rotation.x = vipp utover/innover.
//           parts.tail    Halen, pivot i halerota. rotation.x = logring (±0.5), rotation.z = løft/senk.
//           parts.legs    Array(4) [front venstre (−Z), front høyre (+Z), bak venstre (−Z), bak høyre (+Z)].
//                         Pivot: skulder (0.072, 0.125, ∓0.032) foran, hofte (−0.087, 0.15, ∓0.033) bak.
//                         rotation.z = sving: + = poten fremover (+X), − = bakover. Tåler ±0.6 rad.
//                         g.userData.legAxis = 'z', g.userData.legSign = 1.
//                         Gruppene har ingen egne meshes: kroppens pelsmesh er en SkinnedMesh der hver
//                         beingruppe bærer et THREE.Bone, med myke vekter fra leddet ned til skjørtekanten
//                         (sømløst, ingen ekstra draw calls). Diagonale par: [0,3] og [1,2] i motfase.
//   thimble parts = {}    (ingen bevegelige deler)
//
// All geometri og alle teksturer lages i kode (ingen nedlastede filer). Geometri slås sammen per
// materiale og del; mørk «oksidert» metall og sort emalje er vertex-farger på samme sølvmateriale.
// Modellene caches per id; nye instanser deler geometri og materialer.
(function () {
  'use strict';
  const MP = (window.MP = window.MP || {});
  const IDS = ['car', 'hat', 'ship', 'boot', 'dog', 'thimble'];
  const BASE_TOP = 0.04;
  let T = null;
  const S = { mats: null, models: {}, baseMats: {}, baseGeo: null, rimGeo: null, portraits: {}, rig: null };

  // ---------- Små hjelpere ----------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const V3 = (a) => new T.Vector3(a[0], a[1], a[2]);
  const sq = Math.sqrt;
  function rng(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function xf(geo, p, r, s) {
    const m = new T.Matrix4().compose(
      new T.Vector3(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0),
      new T.Quaternion().setFromEuler(new T.Euler(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0, (r && r[3]) || 'XYZ')),
      new T.Vector3(s ? s[0] : 1, s ? s[1] : 1, s ? s[2] : 1));
    geo.applyMatrix4(m);
    return geo;
  }
  // Orienter geometri med lokal akse `axis` langs retning dir, plasser i p.
  function orient(geo, p, dir, axis) {
    const q = new T.Quaternion().setFromUnitVectors(axis || new T.Vector3(0, 1, 0), dir.clone().normalize());
    geo.applyMatrix4(new T.Matrix4().compose(V3(p), q, new T.Vector3(1, 1, 1)));
    return geo;
  }
  // Sylinder mellom to punkter.
  function rod(a, b, r1, r2, seg, open) {
    const A = V3(a), B = V3(b), d = B.clone().sub(A), len = d.length();
    const g = new T.CylinderGeometry(r2 == null ? r1 : r2, r1, len, seg || 6, 1, !!open);
    return orient(g, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], d);
  }
  function tube(pts, r, segs, radial, closed) {
    const c = new T.CatmullRomCurve3(pts.map(V3), !!closed, 'centripetal');
    return new T.TubeGeometry(c, segs, r, radial || 5, !!closed);
  }
  function lathe(pts, seg) { return new T.LatheGeometry(pts.map((p) => new T.Vector2(p[0], p[1])), seg); }
  function shapeOf(pts) { return new T.Shape(pts.map((p) => new T.Vector2(p[0], p[1]))); }
  function extrude(pts, depth, bev, extra) {
    const o = Object.assign({ depth, bevelEnabled: !!bev, curveSegments: 6, steps: 1 }, extra || {});
    if (bev) Object.assign(o, { bevelThickness: bev[0], bevelSize: bev[1], bevelOffset: -bev[1], bevelSegments: bev[2] || 3 });
    return new T.ExtrudeGeometry(shapeOf(pts), o);
  }
  // Avrundede hjørner på en polylinje (pkt: [x, y, radius]).
  function roundPath(pts, segs, closed) {
    segs = segs || 4;
    const n = pts.length, out = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], rad = p[2] || 0;
      if (!rad || (!closed && (i === 0 || i === n - 1))) { out.push([p[0], p[1]]); continue; }
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      const d1x = p[0] - a[0], d1y = p[1] - a[1], l1 = Math.hypot(d1x, d1y);
      const d2x = b[0] - p[0], d2y = b[1] - p[1], l2 = Math.hypot(d2x, d2y);
      const r1 = Math.min(rad, l1 * 0.5), r2 = Math.min(rad, l2 * 0.5);
      const s0 = [p[0] - (d1x / l1) * r1, p[1] - (d1y / l1) * r1], e0 = [p[0] + (d2x / l2) * r2, p[1] + (d2y / l2) * r2];
      for (let k = 0; k <= segs; k++) {
        const t = k / segs, u = 1 - t;
        out.push([u * u * s0[0] + 2 * u * t * p[0] + t * t * e0[0], u * u * s0[1] + 2 * u * t * p[1] + t * t * e0[1]]);
      }
    }
    return out;
  }
  function spline2(pts, n) {
    return new T.SplineCurve(pts.map((p) => new T.Vector2(p[0], p[1]))).getPoints(n).map((v) => [v.x, v.y]);
  }
  // Bånd med tykkelse t rundt en senterlinje -> lukket form.
  function strip(pts, t) {
    const L = [], R = [], n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], p = pts[i];
      const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
      const nx = -ty / l, ny = tx / l;
      L.push([p[0] + (nx * t) / 2, p[1] + (ny * t) / 2]);
      R.push([p[0] - (nx * t) / 2, p[1] - (ny * t) / 2]);
    }
    return L.concat(R.reverse());
  }
  // Flatt bånd (lisser, sløyfer, halsbånd) langs en kurve; tverrsnitt = avrundet rektangel w x th.
  // opts: closed, segs, up ([x,y,z] – breddeaksen), upFn(t,p), taper(t)
  function ribbon(pts, w, th, opts) {
    opts = opts || {};
    const closed = !!opts.closed, N = opts.segs || pts.length * 5, R = 10;
    const c = new T.CatmullRomCurve3(pts.map(V3), closed, 'centripetal');
    const rows = closed ? N : N + 1, P = [], I = [];
    const ring = [];
    for (let k = 0; k < R; k++) {
      const a = (k / R) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      ring.push([Math.sign(ca) * Math.pow(Math.abs(ca), 0.4) * 0.5, Math.sign(sa) * Math.pow(Math.abs(sa), 0.4) * 0.5]);
    }
    const centers = [];
    for (let i = 0; i < rows; i++) {
      const t = i / N, p = c.getPointAt(t), tg = c.getTangentAt(t);
      let up = opts.upFn ? V3(opts.upFn(t, p)) : opts.up ? V3(opts.up) : new T.Vector3(0, 1, 0);
      const side = new T.Vector3().crossVectors(tg, up).normalize();
      up = new T.Vector3().crossVectors(side, tg).normalize();
      const ws = (opts.taper ? opts.taper(t) : 1) * w;
      for (const [u, v] of ring) P.push(p.x + up.x * u * ws + side.x * v * th, p.y + up.y * u * ws + side.y * v * th, p.z + up.z * u * ws + side.z * v * th);
      centers.push(p);
    }
    for (let i = 0; i < N; i++) {
      const i2 = closed ? (i + 1) % rows : i + 1;
      for (let k = 0; k < R; k++) {
        const a = i * R + k, b = i * R + ((k + 1) % R), cc = i2 * R + ((k + 1) % R), d = i2 * R + k;
        I.push(a, b, d, b, cc, d);
      }
    }
    if (!closed) {
      for (const [row, flip] of [[0, true], [rows - 1, false]]) {
        const base = P.length / 3, cp = centers[row];
        for (let k = 0; k < R; k++) P.push(P[(row * R + k) * 3], P[(row * R + k) * 3 + 1], P[(row * R + k) * 3 + 2]);
        P.push(cp.x, cp.y, cp.z);
        const C = base + R;
        for (let k = 0; k < R; k++) { const a = base + k, b = base + ((k + 1) % R); if (flip) I.push(C, b, a); else I.push(C, a, b); }
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  }
  // Rutenettflate: fn(i/nu, j/nv) -> [x,y,z,u,v]; fremside når (u: +X, v: +Z) gir normal +Y.
  function gridSurf(nu, nv, fn) {
    const P = [], UV = [], I = [];
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { const q = fn(i / nu, j / nv); P.push(q[0], q[1], q[2]); UV.push(q[3] || 0, q[4] || 0); }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j, b = (i + 1) * (nv + 1) + j, c = b + 1, d = a + 1;
      I.push(a, d, b, b, d, c);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2));
    g.setIndex(I); g.computeVertexNormals();
    return g;
  }
  // Glatte normaler med knekkvinkel (sveiser også sømmer i lathe/torus).
  function creaseNormals(geo, angleDeg) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const pos = g.attributes.position, n = pos.count;
    const fn = new Float32Array(n * 3), un = new Float32Array(n * 3);
    const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3();
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      c.sub(b); b.sub(a); b.cross(c);
      const l = b.length() || 1;
      for (let k = 0; k < 3; k++) {
        fn[(i + k) * 3] = b.x; fn[(i + k) * 3 + 1] = b.y; fn[(i + k) * 3 + 2] = b.z;
        un[(i + k) * 3] = b.x / l; un[(i + k) * 3 + 1] = b.y / l; un[(i + k) * 3 + 2] = b.z / l;
      }
    }
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const key = (Math.round(pos.getX(i) * 2e5) + 1e5) * 4e10 + (Math.round(pos.getY(i) * 2e5) + 1e5) * 2e5 + (Math.round(pos.getZ(i) * 2e5) + 1e5);
      let l = map.get(key); if (!l) map.set(key, (l = [])); l.push(i);
    }
    const cs = Math.cos((angleDeg * Math.PI) / 180), out = new Float32Array(n * 3);
    for (const list of map.values()) {
      for (const i of list) {
        let x = 0, y = 0, z = 0;
        for (const j of list) {
          if (un[i * 3] * un[j * 3] + un[i * 3 + 1] * un[j * 3 + 1] + un[i * 3 + 2] * un[j * 3 + 2] >= cs) { x += fn[j * 3]; y += fn[j * 3 + 1]; z += fn[j * 3 + 2]; }
        }
        const l = sq(x * x + y * y + z * z) || 1;
        out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
      }
    }
    g.setAttribute('normal', new T.BufferAttribute(out, 3));
    return g;
  }
  function withUV(g) { g.userData.uv = true; return g; }
  // Skrå planprojeksjon til UV (for pels/lær-teksturer på SDF-flater).
  function obliqueUV(geo, k, ax, ay) {
    const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = (p.getX(i) + ax * p.getZ(i)) * k; uv[i * 2 + 1] = (p.getY(i) + ay * p.getZ(i)) * k; }
    geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
    return withUV(geo);
  }

  // ---------- Toner (vertex-farger på sølvmaterialet) ----------
  // s = blankpolert sølv, w = satinert, t = dekk-grå, d = mørkt oksidert metall, k = sort emalje/blank sort.
  const TONE = { s: [1, 1, 1], w: [0.66, 0.67, 0.7], t: [0.42, 0.425, 0.44], d: [0.3, 0.305, 0.32], k: [0.022, 0.024, 0.028] };
  function paint(geo, t) {
    const p = geo.attributes.position, nr = geo.attributes.normal, n = p.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let v = t;
      if (typeof t === 'function') v = t(p.getX(i), p.getY(i), p.getZ(i), nr ? nr.getX(i) : 0, nr ? nr.getY(i) : 0, nr ? nr.getZ(i) : 0);
      if (typeof v === 'number') { c[i * 3] = v; c[i * 3 + 1] = v; c[i * 3 + 2] = v; } else { c[i * 3] = v[0]; c[i * 3 + 1] = v[1]; c[i * 3 + 2] = v[2]; }
    }
    geo.setAttribute('color', new T.BufferAttribute(c, 3));
    return geo;
  }
  const mixTone = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  // Okklusjon fra en avstandsfunksjon: fordypninger blir mørkere (oksidert sølv).
  function aoPaint(geo, f, k, minT) {
    const p = geo.attributes.position, nr = geo.attributes.normal, n = p.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), nx = nr.getX(i), ny = nr.getY(i), nz = nr.getZ(i);
      let occ = 0, w = 1;
      for (let j = 1; j <= 3; j++) { const d = 0.006 * j; occ += w * Math.max(0, d - f(x + nx * d, y + ny * d, z + nz * d)); w *= 0.62; }
      const a = clamp(1 - k * occ, minT || 0.32, 1);
      const tone = mixTone(TONE.d, TONE.s, (a - 0.3) / 0.7);
      c[i * 3] = tone[0]; c[i * 3 + 1] = tone[1]; c[i * 3 + 2] = tone[2];
    }
    geo.setAttribute('color', new T.BufferAttribute(c, 3));
    return geo;
  }

  // ---------- Signed distance fields (myke organiske former: hund og støvel) ----------
  function sdCap(x, y, z, ax, ay, az, bx, by, bz, r1, r2) {
    const px = x - ax, py = y - ay, pz = z - az, bx_ = bx - ax, by_ = by - ay, bz_ = bz - az;
    const h = clamp((px * bx_ + py * by_ + pz * bz_) / (bx_ * bx_ + by_ * by_ + bz_ * bz_), 0, 1);
    const dx = px - bx_ * h, dy = py - by_ * h, dz = pz - bz_ * h;
    return sq(dx * dx + dy * dy + dz * dz) - lerp(r1, r2, h);
  }
  function sdEll(x, y, z, rx, ry, rz) {
    const k0 = sq((x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2);
    const k1 = sq((x / (rx * rx)) ** 2 + (y / (ry * ry)) ** 2 + (z / (rz * rz)) ** 2);
    return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
  }
  function sdRBox(x, y, z, hx, hy, hz, r) {
    const qx = Math.abs(x) - hx + r, qy = Math.abs(y) - hy + r, qz = Math.abs(z) - hz + r;
    const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
    return sq(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - r;
  }
  function smin(a, b, k) { const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1); return lerp(b, a, h) - k * h * (1 - h); }
  function smax(a, b, k) { return -smin(-a, -b, k); }
  // smale «riller» der sin = 0 (heltallseksponent, uten Math.pow i varme løkker)
  const groove = (s, p) => { const t = 1 - Math.abs(Math.sin(s)), t2 = t * t; return p === 2 ? t2 : p === 3 ? t2 * t : t2 * t2 * (p === 5 ? t : 1); };
  function grad(f, x, y, z, e) {
    e = e || 0.0008;
    // tetraeder-differanser: 4 evalueringer i stedet for 6
    const a = f(x + e, y - e, z - e), b = f(x - e, y - e, z + e), c = f(x - e, y + e, z - e), d = f(x + e, y + e, z + e);
    const gx = a - b - c + d, gy = -a - b + c + d, gz = -a + b - c + d;
    const l = sq(gx * gx + gy * gy + gz * gz) || 1;
    return [gx / l, gy / l, gz / l];
  }
  function project(f, p) {
    let x = p[0], y = p[1], z = p[2];
    for (let i = 0; i < 30; i++) {
      const d = f(x, y, z); const g = grad(f, x, y, z);
      x -= g[0] * d; y -= g[1] * d; z -= g[2] * d;
      if (Math.abs(d) < 1e-6) break;
    }
    return { p: [x, y, z], n: grad(f, x, y, z) };
  }
  const offP = (e, o) => [e.p[0] + e.n[0] * o, e.p[1] + e.n[1] * o, e.p[2] + e.n[2] * o];
  // Surface nets: SDF -> glatt trekantnett med normaler fra gradienten.
  function surfaceNets(f, b0, b1, h) {
    const nx = Math.ceil((b1[0] - b0[0]) / h) + 1, ny = Math.ceil((b1[1] - b0[1]) / h) + 1, nz = Math.ceil((b1[2] - b0[2]) / h) + 1;
    const N = nx * ny * nz, vals = new Float32Array(N);
    // Grov forhåndsgrid (hvert 4. punkt): punkter langt fra flaten får bare fortegnet fra nærmeste grove punkt.
    const C = 4, cx = Math.ceil((nx - 1) / C) + 1, cy = Math.ceil((ny - 1) / C) + 1, cz = Math.ceil((nz - 1) / C) + 1;
    const cv = new Float32Array(cx * cy * cz);
    for (let k = 0, m = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) cv[m++] = f(b0[0] + i * C * h, b0[1] + j * C * h, b0[2] + k * C * h);
    const far = 7 * h;
    let n = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c0 = cv[Math.min(cx - 1, Math.round(i / C)) + cx * (Math.min(cy - 1, Math.round(j / C)) + cy * Math.min(cz - 1, Math.round(k / C)))];
      vals[n++] = Math.abs(c0) > far ? c0 : f(b0[0] + i * h, b0[1] + j * h, b0[2] + k * h);
    }
    const id = (i, j, k) => i + nx * (j + ny * k);
    const cell = new Int32Array(N).fill(-1);
    const P = [];
    const co = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const ed = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const v = new Float32Array(8);
    for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      let neg = 0;
      for (let c = 0; c < 8; c++) { v[c] = vals[id(i + co[c][0], j + co[c][1], k + co[c][2])]; if (v[c] < 0) neg++; }
      if (neg === 0 || neg === 8) continue;
      let sx = 0, sy = 0, sz = 0, cnt = 0;
      for (const e of ed) {
        const A = e[0], B = e[1];
        if ((v[A] < 0) !== (v[B] < 0)) {
          const t = v[A] / (v[A] - v[B]);
          sx += co[A][0] + (co[B][0] - co[A][0]) * t; sy += co[A][1] + (co[B][1] - co[A][1]) * t; sz += co[A][2] + (co[B][2] - co[A][2]) * t;
          cnt++;
        }
      }
      cell[id(i, j, k)] = P.length / 3;
      P.push(b0[0] + (i + sx / cnt) * h, b0[1] + (j + sy / cnt) * h, b0[2] + (k + sz / cnt) * h);
    }
    const I = [];
    const quad = (a, b, c, d, flip) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) I.push(a, c, b, a, d, c); else I.push(a, b, c, a, c, d);
    };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const in0 = vals[id(i, j, k)] < 0;
      if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1 && in0 !== (vals[id(i + 1, j, k)] < 0))
        quad(cell[id(i, j - 1, k - 1)], cell[id(i, j, k - 1)], cell[id(i, j, k)], cell[id(i, j - 1, k)], !in0);
      if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1 && in0 !== (vals[id(i, j + 1, k)] < 0))
        quad(cell[id(i - 1, j, k - 1)], cell[id(i - 1, j, k)], cell[id(i, j, k)], cell[id(i, j, k - 1)], !in0);
      if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && in0 !== (vals[id(i, j, k + 1)] < 0))
        quad(cell[id(i - 1, j - 1, k)], cell[id(i, j - 1, k)], cell[id(i, j, k)], cell[id(i - 1, j, k)], !in0);
    }
    const nrm = new Float32Array(P.length);
    for (let q = 0; q < P.length; q += 3) {
      const g = grad(f, P[q], P[q + 1], P[q + 2], h * 0.3);
      nrm[q] = g[0]; nrm[q + 1] = g[1]; nrm[q + 2] = g[2];
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    geo.setIndex(I);
    return geo;
  }

  // ---------- Teksturer (canvas, laget i kode) ----------
  function canvas2(W, H) { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }
  // Høydefelt -> tangentrom-normalkart. k = helning per høydeenhet/piksel.
  function normalTex(hf, W, H, k, wrapY) {
    const c = canvas2(W, H), ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
    for (let py = 0; py < H; py++) {
      const pu = wrapY ? (py - 1 + H) % H : Math.max(0, py - 1), pd = wrapY ? (py + 1) % H : Math.min(H - 1, py + 1);
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        const sx = (hf[py * W + ((px + 1) % W)] - hf[py * W + ((px - 1 + W) % W)]) * 0.5 * k;
        const sy = (hf[pu * W + px] - hf[pd * W + px]) * 0.5 * k;
        const l = sq(sx * sx + sy * sy + 1);
        d[i * 4] = (-sx / l * 0.5 + 0.5) * 255; d[i * 4 + 1] = (-sy / l * 0.5 + 0.5) * 255; d[i * 4 + 2] = (1 / l * 0.5 + 0.5) * 255; d[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = new T.CanvasTexture(c);
    t.wrapS = T.RepeatWrapping; t.wrapT = wrapY ? T.RepeatWrapping : T.ClampToEdgeWrapping; t.anisotropy = 8;
    return t;
  }
  // Pels: tusenvis av korte, avsmalnende hårlokker langs v (nedover på sidene).
  function furTex() {
    const W = 512, hf = new Float32Array(W * W), r = rng(7);
    for (let n = 0; n < 4200; n++) {
      const cx = r() * W, cy = r() * W, a = Math.PI / 2 + (r() - 0.5) * 0.55, len = 18 + r() * 26, wid = 1.6 + r() * 1.7, amp = 0.55 + r() * 0.5;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ex = Math.abs(ca) * len * 0.5 + wid * 2.5, ey = Math.abs(sa) * len * 0.5 + wid * 2.5;
      for (let py = Math.floor(cy - ey); py <= cy + ey; py++) for (let px = Math.floor(cx - ex); px <= cx + ex; px++) {
        const dx = px - cx, dy = py - cy, s = dx * ca + dy * sa, t = -dx * sa + dy * ca;
        const u = s / (len * 0.5), q = 1 - (t * t) / (4.4 * wid * wid); if (u <= -1 || u >= 1 || q <= 0) continue;
        const h = amp * (1 - u * u) * (u < 0 ? 1 : 1 - 0.55 * u) * q * q;
        const idx = (((py % W) + W) % W) * W + (((px % W) + W) % W);
        if (h > hf[idx]) hf[idx] = h;
      }
    }
    return normalTex(hf, W, W, 0.9, true);
  }
  // Lærnarv: små tette «knopper» og fin støy.
  function grainTex() {
    const W = 256, hf = new Float32Array(W * W), r = rng(11);
    for (let n = 0; n < 2600; n++) {
      const cx = r() * W, cy = r() * W, rad = 1.6 + r() * 3.2, amp = 0.4 + r() * 0.6;
      for (let py = Math.floor(cy - rad); py <= cy + rad; py++) for (let px = Math.floor(cx - rad); px <= cx + rad; px++) {
        const d2 = ((px - cx) ** 2 + (py - cy) ** 2) / (rad * rad); if (d2 >= 1) continue;
        const h = amp * sq(1 - d2), idx = (((py % W) + W) % W) * W + (((px % W) + W) % W);
        if (h > hf[idx]) hf[idx] = h;
      }
    }
    for (let i = 0; i < hf.length; i++) hf[i] += r() * 0.12;
    return normalTex(hf, W, W, 0.55, true);
  }
  // Dekksplanker: u = 0.25 modell-enheter langs skipet, v = 0.0625 på tvers (16 planker).
  function deckTex() {
    const W = 1024, H = 256, hf = new Float32Array(W * H), col = new Float32Array(W * H), r = rng(23);
    const PW = H / 16;
    for (let row = 0; row < 16; row++) {
      const off = r() * W, plankLen = 230 + r() * 40, rowTone = new Float32Array(W), rowGrain = new Float32Array(W), rowX = new Float32Array(W);
      for (let px = 0; px < W; px++) {
        const pi = Math.floor((px + off) / plankLen);
        rowX[px] = (px + off) % plankLen; rowTone[px] = 0.8 + 0.2 * ((((Math.sin(pi * 12.9898 + row * 78.233) * 43758.5453) % 1) + 1) % 1);
        rowGrain[px] = 0.04 * Math.sin(px * 0.21 + row * 3 + Math.sin(px * 0.031 + row) * 4);
      }
      for (let py = row * PW; py < (row + 1) * PW; py++) {
        const yIn = py - row * PW, seam = yIn < 1.5 || yIn > PW - 1;
        for (let px = 0; px < W; px++) {
          const xx = rowX[px], tone = rowTone[px], grainV = rowGrain[px];
          const butt = xx < 1.6, nail = (xx > 4 && xx < 7 && (Math.abs(yIn - 4) < 1.4 || Math.abs(yIn - PW + 5) < 1.4));
          const i = py * W + px;
          hf[i] = seam ? -1 : butt ? -0.7 : nail ? -0.25 : grainV;
          col[i] = seam ? 0.36 : butt ? 0.5 : nail ? 0.55 : tone + grainV;
        }
      }
    }
    const nt = normalTex(hf, W, H, 0.9, true);
    const c = canvas2(W, H), ctx = c.getContext('2d'), img = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) { const g = clamp(col[i], 0, 1) * 255; img.data[i * 4] = g; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = g; img.data[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    const ct = new T.CanvasTexture(c); ct.colorSpace = T.SRGBColorSpace; ct.wrapS = ct.wrapT = T.RepeatWrapping; ct.anisotropy = 8;
    return { nt, ct };
  }
  // Silkeglans for flosshatten: fine loddrette striper i ruhet (lathe-UV: u rundt, v langs profilen).
  function silkTex() {
    const W = 1024, H = 64, r = rng(5), colv = new Float32Array(W), tmp = new Float32Array(W);
    for (let i = 0; i < W; i++) tmp[i] = r();
    for (const [w, a] of [[2, 0.45], [9, 0.35], [45, 0.6]]) for (let i = 0; i < W; i++) { let s = 0; for (let k = -w; k <= w; k++) s += tmp[(i + k + W) % W]; colv[i] += a * (s / (2 * w + 1) - 0.5); }
    const c = canvas2(W, H), ctx = c.getContext('2d'), img = ctx.createImageData(W, H);
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
      const g = clamp(0.6 + colv[px] * 1.6 + 0.04 * Math.sin(py * 0.4), 0.25, 1) * 255, i = (py * W + px) * 4;
      img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 8;
    return t;
  }
  // Fingerbøl: dekorbånd (perlerader, gravert ranke med spiraler) + groper i hexmønster.
  // prof: [[r,y]...] jevnt fordelt i buelengde; v = s/L. sBand = buelengde for båndet.
  function thimbleTex(prof, sBand) {
    const n = prof.length, s = [0];
    for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
    const L = s[n - 1];
    const rAt = (sv) => { if (sv <= 0) return prof[0][0]; for (let i = 1; i < n; i++) if (s[i] >= sv) { const t = (sv - s[i - 1]) / (s[i] - s[i - 1] || 1); return lerp(prof[i - 1][0], prof[i][0], t); } return prof[n - 1][0]; };
    const W = 1536, H = 832, hf = new Float32Array(W * H), ink = new Float32Array(W * H), dv = L / H;
    const duAt = (sv) => (2 * Math.PI * Math.max(0.0035, rAt(sv))) / W;
    const pxOfU = (um, sv) => um / duAt(sv); // meter rundt -> piksler
    function stamp(cx, sv, R, depth, shape, inkAmt) {
      const cy = (1 - sv / L) * H, ru = R / duAt(sv), rv = R / dv;
      const y0 = Math.max(0, Math.floor(cy - rv) - 1), y1 = Math.min(H - 1, Math.ceil(cy + rv) + 1);
      const x0 = Math.floor(cx - ru) - 1, x1 = Math.ceil(cx + ru) + 1;
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const dx = (px + 0.5 - cx) / ru, dy = (py + 0.5 - cy) / rv, d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const p = shape === 1 ? 1 - d2 : (1 - d2) * (1 - d2);
        const idx = py * W + (((px % W) + W) % W), h = depth * p;
        if (depth < 0 ? h < hf[idx] : h > hf[idx]) hf[idx] = h;
        if (inkAmt) { const v = inkAmt * p; if (v > ink[idx]) ink[idx] = v; }
      }
    }
    const ringGroove = (sv, R, depth, inkAmt) => { const step = Math.max(0.5, pxOfU(R, sv) * 0.6); for (let px = 0; px < W; px += step) stamp(px, sv, R, depth, 0, inkAmt); };
    // Bånd: perlerader og graverte linjer
    for (const sv of [0.0042, sBand - 0.0042]) {
      const cnt = Math.floor((2 * Math.PI * rAt(sv)) / 0.0042);
      for (let k = 0; k < cnt; k++) stamp((k / cnt) * W, sv, 0.0016, 0.0008, 0, 0);
    }
    ringGroove(0.0082, 0.0006, -0.0003, 0.8); ringGroove(sBand - 0.0082, 0.0006, -0.0003, 0.8);
    // Ranke: bølgelinje med spiraler i lommene
    const mid = sBand / 2, A = sBand * 0.17, LOB = 7;
    for (let i = 0; i < 3072; i++) { const th = (i / 3072) * Math.PI * 2; stamp((i / 3072) * W, mid + A * Math.sin(LOB * th), 0.00075, -0.00038, 0, 1); }
    for (let k = 0; k < LOB * 2; k++) {
      const th = ((k + 0.5) / (LOB * 2)) * Math.PI * 2, vineSv = mid + A * Math.sin(LOB * th), up = vineSv < mid ? 1 : -1;
      const cSv = vineSv + up * 0.0085, cx = (th / (Math.PI * 2)) * W;
      for (let j = 0; j <= 260; j++) {
        const t = j / 260, rr = 0.0078 * (1 - 0.82 * t), ph = -up * Math.PI / 2 + t * Math.PI * 2 * 1.35 * (k % 2 ? 1 : -1);
        const sv = cSv + Math.sin(ph) * rr; stamp(cx + pxOfU(Math.cos(ph) * rr, sv), sv, 0.00062, -0.00032, 0, 1);
      }
      stamp(cx, cSv, 0.0013, -0.0004, 0, 0.7);
      // små blader langs ranken
      for (const o of [-0.35, 0.35]) {
        const th2 = th + o * (Math.PI / LOB), sv2 = mid + A * Math.sin(LOB * th2) - up * 0.0035;
        stamp((th2 / (Math.PI * 2)) * W, sv2, 0.0019, -0.00035, 1, 0.55);
      }
    }
    // Groper: rader langs profilen, forskjøvet annenhver rad
    const pitch = 0.0096, R = 0.0039, depth = 0.0012;
    let row = 0, lastSv = 0;
    for (let sv = sBand + 0.0068; sv < L; sv += pitch * 0.87, row++) {
      const r = rAt(sv);
      if (r < 0.0125) break;
      lastSv = sv;
      const cnt = Math.max(6, Math.floor((2 * Math.PI * r) / pitch));
      for (let k = 0; k < cnt; k++) stamp(((k + (row % 2) * 0.5) / cnt) * W, sv, R, -depth, 1, 0);
    }
    // Liten rosett på toppen
    const svTop = lastSv + pitch * 0.75;
    ringGroove(svTop, 0.00065, -0.00035, 0.9);
    for (let k = 0; k < 6; k++) stamp(((k + 0.5) / 6) * W, svTop + (L - svTop) * 0.5, 0.0022, -0.0007, 1, 0.5);
    // Kart
    const c1 = canvas2(W, H), x1 = c1.getContext('2d'), nd = x1.createImageData(W, H);
    const c2 = canvas2(W, H), x2 = c2.getContext('2d'), cd = x2.createImageData(W, H);
    for (let py = 0; py < H; py++) {
      const du = duAt((1 - (py + 0.5) / H) * L);
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        const sx = (hf[py * W + ((px + 1) % W)] - hf[py * W + ((px - 1 + W) % W)]) / (2 * du);
        const sy = (hf[Math.max(0, py - 1) * W + px] - hf[Math.min(H - 1, py + 1) * W + px]) / (2 * dv);
        const l = sq(sx * sx + sy * sy + 1);
        nd.data[i * 4] = (-sx / l * 0.5 + 0.5) * 255; nd.data[i * 4 + 1] = (-sy / l * 0.5 + 0.5) * 255; nd.data[i * 4 + 2] = (1 / l * 0.5 + 0.5) * 255; nd.data[i * 4 + 3] = 255;
        const g = 255 * clamp((1 - 0.36 * clamp(-hf[i] / depth, 0, 1)) * (1 - 0.5 * ink[i]), 0.3, 1);
        cd.data[i * 4] = g; cd.data[i * 4 + 1] = g; cd.data[i * 4 + 2] = g * 1.01; cd.data[i * 4 + 3] = 255;
      }
    }
    x1.putImageData(nd, 0, 0); x2.putImageData(cd, 0, 0);
    const nt = new T.CanvasTexture(c1); nt.anisotropy = 8; nt.wrapS = T.RepeatWrapping;
    const ct = new T.CanvasTexture(c2); ct.colorSpace = T.SRGBColorSpace; ct.anisotropy = 8; ct.wrapS = T.RepeatWrapping;
    return { nt, ct };
  }

  // ---------- Materialer ----------
  const UV_MATS = new Set(['fur', 'grain', 'deck', 'dimple', 'silk']);
  function mats() {
    if (S.mats) return S.mats;
    const m = new T.MeshPhysicalMaterial({ color: 0xf3f5f8, metalness: 0.93, roughness: 0.21, clearcoat: 1, clearcoatRoughness: 0.07, envMapIntensity: 2.35, vertexColors: true });
    m.name = 'token-silver';
    const glass = new T.MeshPhysicalMaterial({ color: 0xf4f8ff, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.3, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 2.6, vertexColors: true, depthWrite: false });
    glass.name = 'token-glass';
    S.mats = { m, glass };
    return S.mats;
  }
  function matFor(key) {
    const M = mats();
    if (M[key]) return M[key];
    let m = M.m.clone();
    if (key === 'fur') { m.normalMap = furTex(); m.normalScale = new T.Vector2(1.6, 1.6); m.roughness = 0.24; m.clearcoat = 0.75; }
    else if (key === 'grain') { m.normalMap = grainTex(); m.normalScale = new T.Vector2(0.4, 0.4); m.roughness = 0.24; m.clearcoat = 0.8; }
    else if (key === 'deck') { const t = deckTex(); m.map = t.ct; m.normalMap = t.nt; m.normalScale = new T.Vector2(0.7, 0.7); m.roughness = 0.27; }
    else if (key === 'silk') { m.roughnessMap = silkTex(); m.roughness = 0.36; m.clearcoat = 0.45; m.clearcoatRoughness = 0.12; }
    else if (key === 'dimple') { if (!S.thimbleTex) throw new Error('thimble-tekstur mangler'); m.map = S.thimbleTex.ct; m.normalMap = S.thimbleTex.nt; }
    else m = M.m;
    m.name = 'token-' + key;
    M[key] = m;
    return m;
  }
  function colorKey(c) { return new T.Color(c).getHexString(); }
  function baseMat(c) {
    const key = colorKey(c);
    if (!S.baseMats[key]) {
      const col = new T.Color(c);
      S.baseMats[key] = new T.MeshPhysicalMaterial({
        color: col, metalness: 0.15, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.06,
        emissive: col, emissiveIntensity: 0.18, envMapIntensity: 0.9,
      });
    }
    return S.baseMats[key];
  }

  // ---------- Sokkel ----------
  function baseGeos() {
    if (S.baseGeo) return;
    const top = roundPath([[0.226, 0.004], [0.226, 0.034, 0.004], [0.17, 0.0372], [0.09, 0.0392], [0, 0.04]], 2);
    S.baseGeo = lathe(top, 56);
    const ring = paint(lathe(roundPath([[0.223, 0], [0.256, 0, 0.004], [0.262, 0.024, 0.012], [0.249, 0.0395, 0.006], [0.233, 0.0395, 0.004], [0.225, 0.033]], 2), 64), TONE.s);
    const inlay = paint(xf(new T.TorusGeometry(0.203, 0.0022, 4, 64), [0, 0.0364, 0], [Math.PI / 2, 0, 0]), TONE.s);
    S.rimGeo = window.BufferGeometryUtils.mergeGeometries([prep(creaseNormals(ring, 40)), prep(inlay)], false);
  }

  // ---------- Modellbygger (med navngitte, animerbare deler) ----------
  function Model(name, pivot) { this.name = name || ''; this.pivot = pivot || [0, 0, 0]; this.L = {}; this.kids = []; this.extra = {}; }
  // key: 's' | 'w' | 'd' | 'k' (sølvmaterialet med tone), 'glass', 'fur', 'grain', 'deck', 'dimple', 'silk',
  //      eller 'mat.tone' (f.eks. 'fur.k'). Geometri gis i modellkoordinater.
  Model.prototype.add = function (key, geo, p, r, s) {
    let mk = key, tk = 's';
    if (key.indexOf('.') > 0) { const a = key.split('.'); mk = a[0]; tk = a[1]; } else if (TONE[key]) { mk = 'm'; tk = key; }
    if (p || r || s) xf(geo, p, r, s);
    if (!geo.attributes.color) paint(geo, TONE[tk]);
    (this.L[mk] = this.L[mk] || []).push(geo);
    return geo;
  };
  // Ny animerbar del. Navn som slutter på '[]' samles i en array.
  Model.prototype.part = function (name, pivot) { const m = new Model(name, pivot); this.kids.push(m); return m; };
  // Skinning: meshen `key` i denne noden deformeres av delene `parts` (barn laget med part()).
  // fn(x, y, z) -> vekter [w0..wn-1] per del (modellkoordinater); resten går til noden selv.
  // Gir myke overganger uten skjøter og ingen ekstra draw calls.
  Model.prototype.skin = function (key, parts, fn) { this.skinDef = { key, parts, fn }; };
  function prep(geo, needUv) {
    const keepUv = needUv && geo.userData && geo.userData.uv;
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color' && !(keepUv && k === 'uv')) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.color) paint(g, TONE.s);
    // Konstant UV => null avledning => normalkartet påvirker ikke flaten (glatte detaljer i teksturerte materialer).
    if (needUv && !keepUv) g.setAttribute('uv', new T.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    return g;
  }
  // Skin-vekter fra posisjon: bein 0 = noden selv, bein 1..n = delene. Maks 4 påvirkninger.
  function skinWeights(geo, def) {
    const p = geo.attributes.position, n = p.count;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), seen = new Map();
    for (let i = 0; i < n; i++) {
      // ikke-indeksert geometri: samme hjørne går igjen i flere trekanter – gjenbruk vektene
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const key = (Math.round(x * 2e5) + 1e5) * 4e10 + (Math.round(y * 2e5) + 1e5) * 2e5 + (Math.round(z * 2e5) + 1e5);
      const j0 = seen.get(key);
      if (j0 !== undefined) { for (let c = 0; c < 4; c++) { si[i * 4 + c] = si[j0 * 4 + c]; sw[i * 4 + c] = sw[j0 * 4 + c]; } continue; }
      seen.set(key, i);
      const w = def.fn(x, y, z);
      if (!w.some((v) => v > 1e-4)) { sw[i * 4] = 1; continue; }
      const ord = w.map((v, k) => [v, k + 1]).filter((e) => e[0] > 1e-4).sort((a, b) => b[0] - a[0]).slice(0, 3);
      let sum = 0; for (const e of ord) sum += e[0];
      const k = sum > 1 ? 1 / sum : 1;
      si[i * 4] = 0; sw[i * 4] = 1 - Math.min(1, sum);
      ord.forEach((e, j) => { si[i * 4 + 1 + j] = e[1]; sw[i * 4 + 1 + j] = e[0] * k; });
    }
    geo.setAttribute('skinIndex', new T.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new T.Float32BufferAttribute(sw, 4));  }
  function finalize(M) {
    const meshes = [], def = M.skinDef;
    for (const key of Object.keys(M.L)) {
      const list = M.L[key].map((g) => prep(g, UV_MATS.has(key)));
      const geo = list.length === 1 ? list[0] : window.BufferGeometryUtils.mergeGeometries(list, false);
      const skinned = !!def && def.key === key;
      if (skinned) skinWeights(geo, def);
      geo.translate(-M.pivot[0], -M.pivot[1], -M.pivot[2]);
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      meshes.push({ key, geo, tris: geo.attributes.position.count / 3, skinned });
    }
    const skin = def ? { parts: def.parts.map((k) => M.kids.indexOf(k)) } : null;
    return { name: M.name, pivot: M.pivot, meshes, kids: M.kids.map(finalize), extra: M.extra, skin };
  }

  // =====================================================================
  // BIL – 1930-talls roadster med eikehjul
  // =====================================================================
  const CAR_R = 0.062;
  // Bygges lokalt med akselen langs +Z (utsiden = +Z) og legges inn i M med senter c.
  // face: 'z+' | 'z-' | 'x-' (reservehjul med utsiden bakover).
  function wheelInto(M, c, face) {
    const out = [];
    const put = (key, g, p, r) => { if (p || r) xf(g, p, r); out.push([key, g]); };
    // Dekk med mønster og hvit sidevegg-ring
    const tire = new T.TorusGeometry(0.0478, 0.0142, 8, 40);
    const tp = tire.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i), y = tp.getY(i), rr = Math.hypot(x, y), cphi = (rr - 0.0478) / 0.0142, th = Math.atan2(y, x);
      const tread = ss(0.45, 0.85, cphi) * (Math.cos(th * 20) > 0 ? 0.0011 : -0.0005);
      const f = (rr + tread) / rr; tp.setXY(i, x * f, y * f);
    }
    tire.computeVertexNormals(); put('t', tire);
    put('s', new T.TorusGeometry(0.0404, 0.0022, 4, 36), [0, 0, 0.0106]);
    // Felg (lukket profil)
    const rim = lathe(roundPath([[0.0336, -0.0104], [0.0372, -0.0104, 0.001], [0.0377, -0.0079, 0.001], [0.0347, -0.0056, 0.001], [0.0347, 0.0056, 0.001], [0.0377, 0.0079, 0.001], [0.0372, 0.0104, 0.001], [0.0336, 0.0104], [0.0336, -0.0104]], 1), 24);
    rim.rotateX(Math.PI / 2); put('s', rim);
    // Krysslagte trådeiker (to lag à 12)
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, l = i % 2 ? 1 : -1, b = a + l * 0.34;
      put('s', rod([Math.cos(a) * 0.0105, Math.sin(a) * 0.0105, l * 0.0074], [Math.cos(b) * 0.0338, Math.sin(b) * 0.0338, l * 0.0014], 0.00082, 0.00082, 4, true));
    }
    // Nav med flenser og kuppel, vingemutter
    const hub = lathe(roundPath([[0.0085, -0.011], [0.0126, -0.0096, 0.001], [0.0126, -0.0064, 0.001], [0.0082, -0.0054], [0.0082, 0.0054], [0.0126, 0.0064, 0.001], [0.0126, 0.0096, 0.001], [0.0092, 0.0114, 0.002], [0.0066, 0.0146, 0.002], [0.0, 0.0158]], 1), 12);
    hub.rotateX(Math.PI / 2); put('s', hub);
    const nut = new T.CylinderGeometry(0.0072, 0.0078, 0.004, 8); nut.rotateX(Math.PI / 2); put('s', creaseNormals(nut, 30), [0, 0, 0.0146]);
    const bar = new T.CapsuleGeometry(0.0019, 0.025, 2, 6); put('s', bar, [0, 0, 0.0168], [0, 0, 0.45]);
    const drum = new T.CylinderGeometry(0.027, 0.027, 0.006, 20, 1, true); drum.rotateX(Math.PI / 2); put('d', drum, [0, 0, -0.0108]);
    const rotY = face === 'z-' ? Math.PI : face === 'x-' ? -Math.PI / 2 : 0;
    for (const [k, g] of out) { xf(g, c, [0, rotY, 0]); M.add(k, g); }
  }
  function buildCar(M) {
    const R = CAR_R, FX = 0.125, RX = -0.112, WZ = 0.099;
    M.extra = { wheelAxis: 'z', wheelRadius: R };
    for (const [x, z, f] of [[FX, WZ, 'z+'], [FX, -WZ, 'z-'], [RX, WZ, 'z+'], [RX, -WZ, 'z-']]) wheelInto(M.part('wheels[]', [x, R, z]), [x, R, z], f);

    // Karosseri (sideprofil, ekstrudert med avrundede kanter)
    const tub = roundPath([
      [-0.16, 0.062], [0.03, 0.062, 0.006], [0.03, 0.14, 0.006], [-0.022, 0.153, 0.012], [-0.045, 0.143, 0.01],
      [-0.135, 0.143, 0.012], [-0.168, 0.152, 0.02], [-0.212, 0.12, 0.03], [-0.207, 0.076, 0.022], [-0.18, 0.062, 0.01],
    ], 4);
    const body = extrude(tub, 0.12, [0.014, 0.0095, 3]);
    body.translate(0, 0, -0.06);
    M.add('s', creaseNormals(body, 40));
    // Panser (tverrsnitt med midtrygg) og hengsel
    const hood = extrude(roundPath([[-0.047, 0.07], [0.047, 0.07], [0.051, 0.123, 0.022], [0, 0.139], [-0.051, 0.123, 0.022]], 8, false), 0.15, [0.003, 0.002, 2]);
    hood.rotateY(Math.PI / 2); hood.translate(0.026, 0, 0);
    M.add('s', creaseNormals(hood, 35));
    M.add('w', rod([0.03, 0.1405, 0], [0.172, 0.1405, 0], 0.0013, 0.0013, 6));
    for (const s of [1, -1]) M.add('d', tube([[0.03, 0.123, s * 0.0505], [0.1, 0.1235, s * 0.0505], [0.172, 0.123, s * 0.0505]], 0.0008, 14, 4));
    // Kjølerkappe, grill, emblem
    const shell = extrude(roundPath([[-0.051, 0.066], [0.051, 0.066], [0.051, 0.152, 0.02], [-0.051, 0.152, 0.02]], 6, true), 0.016, [0.004, 0.003, 3]);
    shell.rotateY(Math.PI / 2); shell.translate(0.176, 0, 0);
    M.add('s', creaseNormals(shell, 40));
    const grill = extrude(roundPath([[-0.041, 0.076], [0.041, 0.076], [0.041, 0.143, 0.012], [-0.041, 0.143, 0.012]], 4, true), 0.002);
    grill.rotateY(Math.PI / 2); grill.translate(0.1935, 0, 0);
    M.add('k', grill);
    for (let i = -6; i <= 6; i++) M.add('s', rod([0.1962, 0.078, i * 0.0062], [0.1962, 0.1415 - Math.abs(i) * 0.0003, i * 0.0062], 0.0012, 0.0012, 5));
    M.add('s', rod([0.1968, 0.11, -0.041], [0.1968, 0.11, 0.041], 0.0017, 0.0017, 6));
    M.add('s', rod([0.1968, 0.077, 0], [0.1968, 0.143, 0], 0.0019, 0.0019, 6));
    const badge = new T.CylinderGeometry(0.0072, 0.0072, 0.0025, 20); badge.rotateZ(Math.PI / 2); M.add('d', badge, [0.198, 0.128, 0]);
    M.add('s', new T.TorusGeometry(0.0072, 0.0012, 4, 20), [0.1992, 0.128, 0], [0, Math.PI / 2, 0]);
    M.add('s', new T.SphereGeometry(0.003, 10, 6), [0.1995, 0.128, 0], null, [0.6, 1, 1]);
    // Kjølerlokk med vinget pyntefigur
    M.add('s', new T.CylinderGeometry(0.0055, 0.0068, 0.008, 14), [0.184, 0.159, 0]);
    M.add('s', new T.TorusGeometry(0.006, 0.0012, 4, 14), [0.184, 0.163, 0], [Math.PI / 2, 0, 0]);
    M.add('s', new T.SphereGeometry(0.0055, 12, 8), [0.186, 0.168, 0], null, [1.5, 0.75, 0.7]);
    for (const s of [1, -1]) {
      const wing = extrude(roundPath([[0, 0], [-0.017, 0.005, 0.003], [-0.024, 0.014], [-0.012, 0.009], [-0.004, 0.004]], 3), 0.0016, [0.0007, 0.0006, 1]);
      M.add('s', wing, [0.19, 0.167, s * 0.002], [s * 0.35, 0, 0]);
    }
    // Panserventiler (gjeller) og nagler
    for (let i = 0; i < 7; i++) for (const s of [1, -1]) {
      M.add('d', new T.CapsuleGeometry(0.0021, 0.022, 1, 5), [0.064 + i * 0.0145, 0.1, s * 0.0508], [0, 0, 0.18], [1, 1, 0.45]);
    }
    for (let i = 0; i < 9; i++) for (const s of [1, -1]) M.add('s', new T.SphereGeometry(0.0013, 5, 3), [0.04 + i * 0.016, 0.0745, s * 0.0515]);
    // Skjermer over hjulene
    const fender = (pts) => {
      const g = extrude(strip(spline2(pts, 18), 0.009), 0.04, [0.0065, 0.0035, 2]);
      g.translate(0, 0, -0.02);
      return creaseNormals(g, 45);
    };
    const arc = (cx, cy, r, a0, a1, n) => { const o = []; for (let i = 0; i <= n; i++) { const a = lerp(a0, a1, i / n); o.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return o; };
    const ff = arc(FX, R, 0.0745, 0.22, 2.45, 10).concat([[0.035, 0.074], [0.004, 0.0585]]);
    const rf = [[-0.032, 0.0585], [-0.052, 0.07]].concat(arc(RX, R, 0.0745, 0.62, 2.95, 10));
    for (const s of [1, -1]) {
      M.add('s', fender(ff), [0, 0, s * WZ]);
      M.add('s', fender(rf), [0, 0, s * WZ]);
      // Stigbrett med gummiribber
      M.add('s', new window.RoundedBoxGeometry(0.06, 0.006, 0.05, 2, 0.002), [-0.014, 0.054, s * WZ]);
      for (const o of [-0.016, 0, 0.016]) M.add('d', new window.RoundedBoxGeometry(0.052, 0.0018, 0.0034, 1, 0.0008), [-0.014, 0.0575, s * WZ + o]);
      // Dørsøm, hengsler, håndtak og pyntelist
      M.add('d', tube(roundPath([[-0.058, 0.07], [-0.058, 0.128, 0.006], [-0.128, 0.128, 0.006], [-0.128, 0.07]], 3).map((p) => [p[0], p[1], s * 0.0743]), 0.0011, 30, 4));
      for (const y of [0.08, 0.118]) M.add('s', new T.CylinderGeometry(0.0016, 0.0016, 0.007, 6), [-0.0585, y, s * 0.0752]);
      M.add('s', rod([-0.064, 0.118, s * 0.0756], [-0.078, 0.118, s * 0.0756], 0.0018, 0.0015, 6));
      M.add('s', new T.SphereGeometry(0.0024, 8, 6), [-0.0635, 0.118, s * 0.0756]);
      M.add('s', tube([[-0.198, 0.104, s * 0.0716], [-0.12, 0.106, s * 0.0752], [0.0, 0.106, s * 0.0752], [0.028, 0.106, s * 0.0705]], 0.0019, 28, 6));
      // Frontlykter: kopp, krom-ring, reflektor, pære og glass
      const lampParts = [
        ['s', lathe(roundPath([[0, -0.021], [0.011, -0.019, 0.006], [0.0195, -0.008, 0.005], [0.0205, 0.0]], 2), 16)],
        ['s', lathe([[0.0178, -0.0008], [0.014, -0.006], [0.008, -0.0105], [0.0, -0.0122]], 12)],
        ['s', new T.TorusGeometry(0.0196, 0.0027, 4, 18).rotateX(Math.PI / 2)],
        ['s', new T.SphereGeometry(0.0034, 8, 5).translate(0, -0.0065, 0)],
        ['glass', new T.SphereGeometry(0.03, 16, 3, 0, Math.PI * 2, 0, 0.62).translate(0, -0.0244, 0)],
      ];
      for (const [k, g] of lampParts) { g.rotateZ(-Math.PI / 2); M.add(k, g, [0.191, 0.128, s * 0.072]); }
      M.add('s', rod([0.178, 0.112, s * 0.072], [0.176, 0.1, s * 0.08], 0.003, 0.0035, 8));
      // Parkeringslys på skjermene
      M.add('s', new T.CylinderGeometry(0.0035, 0.005, 0.006, 12), [0.11, 0.142, s * 0.099]);
      M.add('glass', new T.SphereGeometry(0.0038, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), [0.11, 0.145, s * 0.099]);
      // Baklykter
      const tl = new T.CylinderGeometry(0.0075, 0.0068, 0.006, 16); tl.rotateZ(Math.PI / 2); M.add('s', tl, [-0.2, 0.08, s * 0.066]);
      const tlens = new T.SphereGeometry(0.0062, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2); tlens.rotateZ(Math.PI / 2); M.add('k', tlens, [-0.203, 0.08, s * 0.066]);
    }
    M.add('s', rod([0.188, 0.122, -0.068], [0.188, 0.122, 0.068], 0.0022, 0.0022, 8));
    // Ramme, aksler, bladfjær foran
    M.add('d', new window.RoundedBoxGeometry(0.36, 0.012, 0.1, 1, 0.003), [-0.005, 0.056, 0]);
    for (const x of [FX, RX]) M.add('d', rod([x, R, -0.088], [x, R, 0.088], 0.005, 0.005, 8));
    for (let i = 0; i < 3; i++) M.add('d', tube([[FX - 0.03, R + 0.004 - i * 0.003, 0], [FX, R - 0.004 - i * 0.003, 0], [FX + 0.03, R + 0.004 - i * 0.003, 0]], 0.0018, 10, 4));
    // Støtfangere: to krumme blader med horn
    const bumper = (x, dir) => {
      for (const [yy, hh] of [[0.06, 0.0052], [0.0755, 0.0044]]) {
        const g = new T.CapsuleGeometry(hh, 0.165, 2, 8); g.rotateX(Math.PI / 2); g.scale(0.62, 1.55, 1);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) - dir * 1.6 * p.getZ(i) * p.getZ(i));
        g.computeVertexNormals();
        M.add('s', g, [x, yy, 0]);
      }
      for (const z of [-0.045, 0.045]) {
        M.add('s', new T.CapsuleGeometry(0.0042, 0.022, 3, 8), [x + dir * 0.002 - dir * 1.6 * z * z, 0.068, z]);
        M.add('s', new T.SphereGeometry(0.0028, 8, 6), [x + dir * 0.0055 - dir * 1.6 * z * z, 0.081, z]);
      }
      for (const z of [-0.05, 0.05]) M.add('d', rod([x - dir * 0.045, 0.057, z], [x - dir * 0.002, 0.061, z], 0.003, 0.003, 6));
    };
    bumper(0.218, 1); bumper(-0.246, -1);
    // Eksosrør på høyre side
    for (let i = 0; i < 3; i++) {
      const x0 = 0.075 + i * 0.022;
      M.add('s', tube([[x0, 0.098, 0.05], [x0 - 0.004, 0.096, 0.057], [x0 - 0.016, 0.082, 0.064], [x0 - 0.04 - i * 0.012, 0.072, 0.066]], 0.0032, 14, 6));
      
    }
    M.add('s', tube([[0.04, 0.072, 0.066], [-0.02, 0.071, 0.067], [-0.06, 0.069, 0.067]], 0.0038, 14, 8));
    for (let i = 0; i < 6; i++) M.add('d', new T.TorusGeometry(0.0041, 0.0007, 3, 8), [0.03 - i * 0.008, 0.0715, 0.0668], [0, Math.PI / 2, 0]);
    // Cockpit: mørk innside, polstret kant, kapitonert sete, ratt og instrumenter
    M.add('k', new window.RoundedBoxGeometry(0.098, 0.004, 0.112, 2, 0.0018), [-0.09, 0.1425, 0]);
    M.add('s', tube(roundPath([[-0.04, -0.058], [-0.04, 0.058, 0.012], [-0.14, 0.058, 0.012], [-0.14, -0.058, 0.012]], 4, true).map((p) => [p[0], 0.1445, p[1]]), 0.0029, 44, 5, true));
    M.add('s', new window.RoundedBoxGeometry(0.042, 0.016, 0.104, 2, 0.006), [-0.09, 0.149, 0]);
    M.add('s', new window.RoundedBoxGeometry(0.016, 0.056, 0.108, 2, 0.007), [-0.118, 0.168, 0], [0, 0, 0.26]);
    for (const z of [-0.036, -0.012, 0.012, 0.036]) M.add('d', new T.BoxGeometry(0.0016, 0.044, 0.0022), [-0.1088, 0.17, z], [0, 0, 0.26]);
    for (const z of [-0.024, 0, 0.024]) for (const yy of [0.158, 0.178]) M.add('d', new T.SphereGeometry(0.0021, 6, 4), [-0.11 - (yy - 0.168) * Math.tan(0.26), yy, z]);
    for (const z of [-0.026, 0, 0.026]) M.add('d', new T.BoxGeometry(0.036, 0.0016, 0.0022), [-0.088, 0.1572, z]);
    const colA = [-0.026, 0.147, -0.028], colB = [-0.054, 0.176, -0.028];
    M.add('d', rod(colA, colB, 0.0025, 0.0025, 6));
    const swDir = new T.Vector3(colB[0] - colA[0], colB[1] - colA[1], 0).normalize();
    M.add('s', orient(new T.TorusGeometry(0.019, 0.0027, 6, 28), colB, swDir, new T.Vector3(0, 0, 1)));
    M.add('s', orient(new T.CylinderGeometry(0.0045, 0.0045, 0.004, 10), colB, swDir));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      const u = new T.Vector3(0, 0, 1).cross(swDir).normalize(), w = swDir.clone().cross(u).normalize();
      const e = u.clone().multiplyScalar(Math.cos(a) * 0.018).add(w.clone().multiplyScalar(Math.sin(a) * 0.018));
      M.add('s', rod(colB, [colB[0] + e.x, colB[1] + e.y, colB[2] + e.z], 0.0013, 0.0013, 4));
    }
    for (const z of [0.004, 0.026]) {
      const gz = new T.CylinderGeometry(0.0055, 0.0055, 0.002, 14); gz.rotateZ(Math.PI / 2); M.add('k', gz, [-0.0405, 0.138, z]);
      M.add('s', new T.TorusGeometry(0.0057, 0.001, 4, 14), [-0.0415, 0.138, z], [0, Math.PI / 2, 0]);
    }
    // Frontrute med ramme og glass
    const wsB = 0.15, wsT = 0.212, wsX0 = -0.016, wsX1 = -0.028;
    for (const z of [-0.06, 0.06]) M.add('s', rod([wsX0, wsB, z], [wsX1, wsT, z], 0.0028, 0.0026, 8));
    M.add('s', rod([wsX1, wsT, -0.062], [wsX1, wsT, 0.062], 0.0026, 0.0026, 8));
    M.add('s', rod([wsX0, wsB + 0.002, -0.062], [wsX0, wsB + 0.002, 0.062], 0.0024, 0.0024, 8));
    M.add('glass', new T.BoxGeometry(0.0016, wsT - wsB - 0.004, 0.116), [(wsX0 + wsX1) / 2, (wsB + wsT) / 2, 0], [0, 0, Math.atan2(wsX0 - wsX1, wsT - wsB)]);
    // Reservehjul bak med brakett
    wheelInto(M, [-0.224, 0.114, 0], 'x-');
    for (const z of [-0.02, 0.02]) M.add('d', rod([-0.205, 0.1, z], [-0.222, 0.112, z * 0.3], 0.0025, 0.0025, 6));
  }

  // =====================================================================
  // FLOSSHATT
  // =====================================================================
  function buildHat(M) {
    const rc = (y) => { const t = clamp((y - 0.024) / 0.266, 0, 1); return 0.107 - 0.0065 * Math.sin(Math.PI * t) + 0.0135 * t * t * t; };
    const lift = (r, sinT) => 0.028 * Math.pow(ss(0.118, 0.18, r), 2.2) * sinT * sinT;
    const curl = (g) => { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z); if (r > 0.112) p.setY(i, p.getY(i) + lift(r, z / r)); } return g; };
    // Pull i silke (ruhetsstriper) med avrundet topp
    const prof = [];
    for (let y = 0.014; y < 0.279; y += 0.012) prof.push([rc(y), y]);
    const top = roundPath([[rc(0.279), 0.279], [rc(0.29) + 0.0005, 0.2935, 0.011], [0.07, 0.2985], [0.0, 0.3]], 7);
    for (let i = 1; i < top.length; i++) prof.push(top[i]);
    M.add('silk', withUV(paint(lathe(prof, 80), (x, y) => (y > 0.27 ? 1 : 0.94 + 0.06 * ss(0.07, 0.2, y)))));
    // Søm rundt toppflaten
    const dashRing = (B, r, y, n, len, rad, key, liftFn) => {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = a0 + len / r;
        const p0 = [Math.cos(a0) * r, y, Math.sin(a0) * r], p1 = [Math.cos(a1) * r, y, Math.sin(a1) * r];
        if (liftFn) { p0[1] += liftFn(r, Math.sin(a0)); p1[1] += liftFn(r, Math.sin(a1)); }
        B.add(key || 'd', rod(p0, p1, rad, rad, 3, true));
      }
    };
    dashRing(M, 0.088, 0.2988, 64, 0.0045, 0.0007, 'd');
    // Hattebånd i ripsbånd (fine ribber) med sløyfe
    const band = [[rc(0.019) - 0.002, 0.019]];
    for (let y = 0.0215; y <= 0.0705; y += 0.0012) band.push([rc(y) + 0.0033 + 0.00045 * Math.cos(((y - 0.0215) / 0.0036) * Math.PI * 2), y]);
    band.push([rc(0.0716) + 0.0012, 0.0719]);
    band.push([rc(0.0725) - 0.001, 0.0722]);
    M.add('d', lathe(band, 72));
    M.add('w', lathe([[rc(0.0222) + 0.0035, 0.0212], [rc(0.0222) + 0.0047, 0.0222], [rc(0.0222) + 0.0035, 0.0232]], 72));
    M.add('w', lathe([[rc(0.0695) + 0.0035, 0.0685], [rc(0.0695) + 0.0047, 0.0695], [rc(0.0695) + 0.0035, 0.0705]], 72));
    // Sløyfe (bygd lokalt: u = langs båndet, v = opp, n = utover), plassert på venstre side (−Z)
    const bow = [];
    bow.push(['d', new window.RoundedBoxGeometry(0.012, 0.019, 0.008, 2, 0.0032).translate(0, 0, 0.004)]);
    bow.push(['w', new T.BoxGeometry(0.0125, 0.0012, 0.0084).translate(0, 0.004, 0.004)]);
    bow.push(['w', new T.BoxGeometry(0.0125, 0.0012, 0.0084).translate(0, -0.004, 0.004)]);
    for (const s of [1, -1]) {
      bow.push(['d', ribbon([[0.004 * s, 0.002, 0.0062], [0.017 * s, 0.0085, 0.0105], [0.031 * s, 0.009, 0.0085], [0.0375 * s, 0.002, 0.0045], [0.031 * s, -0.004, 0.0022], [0.017 * s, -0.003, 0.0022], [0.005 * s, -0.001, 0.0028]], 0.0155, 0.0017, { closed: true, segs: 40 })]);
      bow.push(['d', ribbon([[0.003 * s, -0.004, 0.0062], [0.009 * s, -0.017, 0.0072], [0.016 * s, -0.031, 0.0058]], 0.011, 0.0016, { segs: 16, up: [1, 0, 0], taper: (t) => 1 - 0.15 * t })]);
    }
    const bz = rc(0.046) + 0.0036;
    for (const [k, g] of bow) M.add(k, g, [0, 0.046, -bz], [0, Math.PI, 0]);
    // Bremmen: egen del (animerbar), pivot midt i hatten i bremhøyde
    const B = M.part('brim', [0, 0.012, 0]);
    const bp = roundPath([[0, 0.0042], [0.15, 0.0034], [0.1712, 0.0058, 0.006], [0.1788, 0.0125, 0.004], [0.1686, 0.0188, 0.005], [0.13, 0.0206], [0.104, 0.0222]], 5);
    const brim = curl(lathe(bp, 96)); brim.computeVertexNormals();
    B.add('silk', withUV(brim));
    const edge = [];
    for (let i = 0; i < 96; i++) { const a = (i / 96) * Math.PI * 2, r = 0.1772; edge.push([Math.cos(a) * r, 0.0124 + lift(r, Math.sin(a)), Math.sin(a) * r]); }
    B.add('w', tube(edge, 0.0035, 96, 6, true));
    dashRing(B, 0.159, 0.0196, 110, 0.0048, 0.00075, 'd', lift);
  }

  // =====================================================================
  // SKIP – slagskip
  // =====================================================================
  function buildShip(M) {
    const L0 = -0.228, L1 = 0.248, B = 0.06, H = 0.072, BT = 0.006, HT = H + 2 * BT;
    const hw = (x) => {
      if (x >= 0.02) { const t = clamp((x - 0.02) / (L1 - 0.02), 0, 1); return B * (1 - Math.pow(t, 1.9)); }
      if (x <= -0.14) { const t = clamp((-0.14 - x) / (-0.14 - L0), 0, 1); return B * sq(Math.max(0, 1 - t * t)); }
      return B;
    };
    const sheer = (x) => 0.017 * ss(0.03, L1, x) + 0.005 * ss(-0.12, L0, x);
    const deckY = (x) => HT + sheer(x);
    const taper = (yn) => 0.52 + 0.48 * Math.pow(clamp(yn, 0, 1), 0.55);
    const flare = (x, yn) => 1 + 0.1 * ss(0.55, 1, yn) * ss(0.08, L1, x);
    const sideZ = (x, y) => hw(x) * taper(y / HT) * flare(x, y / HT);
    const plan = (inset, x0, x1, N) => {
      const pts = [], xs = [];
      for (let i = 0; i <= N; i++) xs.push(lerp(x0, x1, (1 - Math.cos((Math.PI * i) / N)) / 2));
      for (const x of xs) pts.push([x, Math.max(0.0005, hw(x) - inset)]);
      for (let i = xs.length - 2; i >= 1; i--) pts.push([xs[i], -Math.max(0.0005, hw(xs[i]) - inset)]);
      return pts;
    };
    const WL = 0.024, wl = (x) => WL + (WL / HT) * sheer(x); // faller på en rad i skrognettet
    // Skrog
    const hull = new T.ExtrudeGeometry(shapeOf(plan(0, L0, L1, 64)), { depth: H, steps: 16, bevelEnabled: true, bevelThickness: BT, bevelSize: 0.005, bevelOffset: -0.005, bevelSegments: 3, curveSegments: 1 });
    hull.rotateX(-Math.PI / 2); hull.translate(0, BT, 0);
    const p = hull.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i); const y = p.getY(i), yn = y / HT;
      const z = p.getZ(i) * taper(yn) * flare(x, yn);
      x -= (1 - clamp(yn, 0, 1)) * 0.04 * ss(0.06, L1, x);
      p.setXYZ(i, x, y + clamp(yn, 0, 1) * sheer(p.getX(i)), z);
    }
    const hullG = creaseNormals(hull, 38);
    paint(hullG, (x, y) => (y < wl(x) - 0.0002 ? TONE.d : TONE.s));
    M.add('s', hullG);
    // Vannlinje og panserbelte
    const outline = (y, off, x0, x1, n) => { const o = []; for (let i = 0; i <= n; i++) { const x = lerp(x0, x1, i / n); o.push([x, y, sideZ(x, y) + off]); } return o; };
    for (const s of [1, -1]) {
      const mir = (pts) => pts.map((q) => [q[0], q[1], q[2] * s]);
      M.add('s', tube(mir(outline(WL, 0.0003, L0 + 0.02, L1 - 0.035, 40)), 0.0011, 60, 4));
      M.add('w', ribbon(mir(outline(0.04, 0.0009, -0.14, 0.15, 24)), 0.013, 0.0018, { segs: 40, up: [0, 1, 0] }));
      // Kasemattkanoner langs siden
      for (const x of [-0.075, -0.045, -0.015, 0.015, 0.045]) {
        const z = sideZ(x, 0.06) + 0.0004;
        const cm = new T.CylinderGeometry(0.0052, 0.0052, 0.002, 12); cm.rotateX(Math.PI / 2); M.add('k', cm, [x, 0.06, s * z]);
        M.add('s', rod([x, 0.06, s * (z - 0.001)], [x + 0.014, 0.0605, s * (z + 0.006)], 0.0015, 0.0012, 6));
      }
      // Koøyer
      for (let x = -0.18; x <= 0.19; x += 0.019) {
        if (x > -0.09 && x < 0.06) continue;
        const y = 0.054, z = s * (sideZ(x, y) + 0.0002);
        const g = new T.CylinderGeometry(0.0034, 0.0034, 0.0024, 8, 1, true); g.rotateX(Math.PI / 2);
        M.add('k', g, [x, y, z], [0, -s * Math.atan2(hw(x + 0.005) - hw(x - 0.005), 0.01), 0]);
        M.add('s', new T.TorusGeometry(0.0036, 0.0008, 3, 8), [x, y, z + s * 0.0006], [0, -s * Math.atan2(hw(x + 0.005) - hw(x - 0.005), 0.01), 0]);
      }
      // Anker ved baugen
      const ax = 0.205, ay = 0.066, az = s * (sideZ(ax, ay) + 0.0025), rot = [0, -s * 0.45, 0];
      const anchor = [
        rod([0, 0.004, 0], [0, -0.022, 0], 0.0016, 0.0016, 6),
        new T.TorusGeometry(0.01, 0.0016, 4, 12, Math.PI).rotateZ(Math.PI),
        new T.ConeGeometry(0.003, 0.007, 6).rotateZ(-0.6).translate(-0.0105, -0.0175, 0),
        new T.ConeGeometry(0.003, 0.007, 6).rotateZ(0.6).translate(0.0105, -0.0175, 0),
        rod([-0.007, 0.0, 0], [0.007, 0.0, 0], 0.0012, 0.0012, 5),
        new T.TorusGeometry(0.0028, 0.0009, 4, 10).translate(0, 0.0065, 0),
      ];
      anchor[1].translate(0, -0.012, 0);
      const hp = new T.CylinderGeometry(0.0055, 0.0055, 0.003, 12); hp.rotateX(Math.PI / 2); M.add('k', hp, [ax + 0.002, ay + 0.009, s * (sideZ(ax, ay + 0.009) + 0.0006)], rot);
      for (const g of anchor) { g.rotateY(-s * 0.45); M.add('d', g, [ax, ay, az]); }
      // Ankerkjetting på dekk
      const c0 = [ax + 0.002, deckY(ax) + 0.0012, s * (hw(ax) - 0.012)], c1 = [0.17, deckY(0.17) + 0.0012, s * 0.016];
      for (let i = 0; i < 9; i++) {
        const t = i / 8, q = [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
        const l = new T.TorusGeometry(0.0022, 0.0007, 3, 6); l.scale(1.4, 1, 1);
        M.add('d', l, q, [i % 2 ? Math.PI / 2 : 0, Math.atan2(c0[2] - c1[2], c1[0] - c0[0]), 0]);
      }
      M.add('s', new T.CylinderGeometry(0.0048, 0.0058, 0.006, 14), [0.165, deckY(0.165) + 0.003, s * 0.016]);
      M.add('s', new T.CylinderGeometry(0.0062, 0.0062, 0.0012, 14), [0.165, deckY(0.165) + 0.0062, s * 0.016]);
    }
    // Dekk med planker (rutenett med UV), litt over skrogtoppen
    const deck = gridSurf(72, 6, (u, v) => {
      const x = lerp(L0 + 0.008, L1 - 0.03, (1 - Math.cos(Math.PI * u)) / 2), w = Math.max(0.0005, hw(x) - 0.0065), z = lerp(-w, w, v);
      return [x, deckY(x) + 0.0006, z, x / 0.25, z / 0.0625 + 0.5];
    });
    M.add('deck', withUV(deck));
    // Rekkverk (to lister + stolper)
    const rx = [];
    for (let i = 0; i <= 46; i++) rx.push(lerp(L0 + 0.012, L1 - 0.035, i / 46));
    for (const hgt of [0.0085, 0.0045]) {
      const rail = [];
      for (const x of rx) rail.push([x, deckY(x) + hgt, hw(x) - 0.0035]);
      for (let i = rx.length - 2; i >= 1; i--) rail.push([rx[i], deckY(rx[i]) + hgt, -(hw(rx[i]) - 0.0035)]);
      M.add('s', tube(rail, hgt > 0.006 ? 0.0009 : 0.0006, 140, 3, true));
      if (hgt > 0.006) for (let i = 0; i < rail.length; i += 2) { const q = rail[i]; M.add('s', rod([q[0], q[1] - 0.0085, q[2]], q, 0.0006, 0.0006, 3, true)); }
    }
    // Kanontårn
    const turret = (x, yb, barbH, aft) => {
      M.add('d', new T.CylinderGeometry(0.024, 0.026, barbH + 0.004, 28), [x, yb + barbH / 2 - 0.002, 0]);
      M.add('s', new T.TorusGeometry(0.0245, 0.0012, 4, 28), [x, yb + barbH, 0], [Math.PI / 2, 0, 0]);
      const g = extrude(roundPath([[0.03, -0.017, 0.004], [0.03, 0.017, 0.004], [0.002, 0.027, 0.012], [-0.026, 0.022, 0.014], [-0.026, -0.022, 0.014], [0.002, -0.027, 0.012]], 5, true), 0.017, [0.004, 0.003, 3]);
      g.rotateX(-Math.PI / 2); g.translate(0, 0.004, 0);
      const tp = g.attributes.position;
      for (let i = 0; i < tp.count; i++) if (tp.getX(i) > 0.005) tp.setX(i, tp.getX(i) - (tp.getY(i) / 0.025) * 0.01 * ss(0.005, 0.03, tp.getX(i)));
      const rot = aft ? Math.PI : 0, dir = aft ? -1 : 1, top = yb + barbH + 0.0245;
      M.add('s', creaseNormals(g, 40), [x, yb + barbH, 0], [0, rot, 0]);
      for (const z of [-0.0115, 0, 0.0115]) {
        const a = [x + dir * 0.022, yb + barbH + 0.012, z], b = [x + dir * 0.084, yb + barbH + 0.0155, z];
        M.add('s', rod(a, b, 0.0036, 0.0027, 10));
        M.add('s', rod([b[0] - dir * 0.005, b[1], b[2]], [b[0] + dir * 0.0006, b[1], b[2]], 0.0036, 0.0037, 10));
        M.add('k', new T.CircleGeometry(0.0018, 8).rotateY(dir * Math.PI / 2), [b[0] + dir * 0.0008, b[1], b[2]]);
        M.add('d', rod([x + dir * 0.019, a[1], z], [x + dir * 0.029, a[1] + 0.0003, z], 0.0053, 0.0047, 10));
      }
      M.add('d', rod([x - dir * 0.014, yb + barbH + 0.026, -0.035], [x - dir * 0.014, yb + barbH + 0.026, 0.035], 0.004, 0.004, 10));
      for (const z of [-0.035, 0.035]) M.add('k', new T.CircleGeometry(0.0032, 10).rotateY(z > 0 ? 0 : Math.PI), [x - dir * 0.014, yb + barbH + 0.026, z + Math.sign(z) * 0.0001]);
      M.add('s', new T.CylinderGeometry(0.0055, 0.006, 0.004, 14), [x - dir * 0.004, top, 0.01]);
      M.add('s', new T.CylinderGeometry(0.0035, 0.004, 0.003, 12), [x - dir * 0.012, top - 0.0005, -0.012]);
      for (const z of [-0.016, 0.016]) M.add('w', new window.RoundedBoxGeometry(0.008, 0.004, 0.006, 1, 0.0015), [x + dir * 0.012, top - 0.001, z]);
    };
    turret(0.14, deckY(0.14) - 0.002, 0.006, false);
    turret(0.077, deckY(0.077) - 0.002, 0.03, false);
    turret(-0.148, deckY(-0.148) - 0.002, 0.006, true);
    // Overbygg med vinduer, broving, lyskastere
    const D = HT;
    M.add('s', new window.RoundedBoxGeometry(0.17, 0.034, 0.078, 3, 0.006), [-0.038, D + 0.017, 0]);
    for (const s of [1, -1]) for (let i = 0; i < 11; i++) M.add('k', new T.BoxGeometry(0.0055, 0.0045, 0.0015), [-0.112 + i * 0.0145, D + 0.022, s * 0.0392]);
    M.add('s', new window.RoundedBoxGeometry(0.046, 0.042, 0.062, 3, 0.007), [0.028, D + 0.034 + 0.021, 0]);
    M.add('k', new T.BoxGeometry(0.003, 0.008, 0.052), [0.0512, D + 0.064, 0]);
    for (let i = -3; i <= 3; i++) M.add('s', new T.BoxGeometry(0.0034, 0.009, 0.0012), [0.0515, D + 0.064, i * 0.0072]);
    for (const s of [1, -1]) M.add('k', new T.BoxGeometry(0.03, 0.007, 0.002), [0.03, D + 0.064, s * 0.0312]);
    M.add('s', new window.RoundedBoxGeometry(0.024, 0.004, 0.1, 1, 0.0015), [0.034, D + 0.0745, 0]);
    M.add('s', new window.RoundedBoxGeometry(0.032, 0.022, 0.042, 3, 0.006), [0.022, D + 0.0765 + 0.011, 0]);
    M.add('k', new T.BoxGeometry(0.003, 0.006, 0.034), [0.0385, D + 0.091, 0]);
    M.add('s', new T.CylinderGeometry(0.0085, 0.0095, 0.008, 18), [0.02, D + 0.1025, 0]);
    M.add('s', rod([0.02, D + 0.104, -0.018], [0.02, D + 0.104, 0.018], 0.0035, 0.0035, 10));
    for (const s of [1, -1]) {
      M.add('s', new T.CylinderGeometry(0.0048, 0.0048, 0.007, 14).rotateZ(Math.PI / 2), [-0.045, D + 0.04, s * 0.03]);
      M.add('k', new T.CircleGeometry(0.0042, 12).rotateY(Math.PI / 2), [-0.041, D + 0.04, s * 0.03]);
    }
    // Livbåter med davitter, sekundærkanoner
    for (const s of [1, -1]) {
      for (const x of [-0.07, -0.105]) {
        const g = new T.CapsuleGeometry(0.0064, 0.026, 3, 8); g.rotateZ(Math.PI / 2); M.add('s', g, [x, D + 0.0395, s * 0.031], null, [1, 0.8, 1]);
        const cover = new T.CapsuleGeometry(0.0054, 0.024, 2, 6); cover.rotateZ(Math.PI / 2); M.add('d', cover, [x, D + 0.0425, s * 0.031], null, [1, 0.35, 0.9]);
        for (const dx of [-0.016, 0.016]) M.add('s', tube([[x + dx, D + 0.034, s * 0.022], [x + dx, D + 0.05, s * 0.024], [x + dx, D + 0.052, s * 0.031], [x + dx, D + 0.047, s * 0.033]], 0.0007, 8, 3));
      }
      for (const x of [-0.07, 0.0]) {
        M.add('s', new T.CylinderGeometry(0.009, 0.0105, 0.009, 16), [x, D + 0.004, s * 0.047]);
        M.add('s', rod([x, D + 0.006, s * 0.05], [x + 0.025, D + 0.0075, s * 0.062], 0.0018, 0.0016, 6));
      }
    }
    // Ventilatorer
    for (const [vx, vz] of [[-0.005, 0.03], [-0.005, -0.03], [-0.095, 0.022], [-0.095, -0.022]]) {
      M.add('s', tube([[vx, D + 0.03, vz], [vx, D + 0.046, vz], [vx + 0.003, D + 0.052, vz]], 0.0024, 8, 8));
      const bell = new T.CylinderGeometry(0.0042, 0.003, 0.005, 12, 1, true); bell.rotateZ(-Math.PI / 2); M.add('s', bell, [vx + 0.005, D + 0.053, vz]);
      M.add('k', new T.CircleGeometry(0.0038, 10).rotateY(Math.PI / 2), [vx + 0.0068, D + 0.053, vz]);
    }
    // Skorsteiner (elliptiske, lett bakoverlent) med bånd, damprør og rist
    const funnel = (fx, name) => {
      const pieces = [];
      const body = new T.CylinderGeometry(0.0175, 0.0195, 0.074, 32); body.translate(0, 0.037, 0); pieces.push(['s', body]);
      for (const yb of [0.052, 0.062]) { const band = new T.CylinderGeometry(0.0182, 0.0182, 0.0035, 32); band.translate(0, yb, 0); pieces.push(['d', band]); }
      const cap = new T.CylinderGeometry(0.0188, 0.0178, 0.007, 32); cap.translate(0, 0.0745, 0); pieces.push(['s', cap]);
      const hole = new T.CylinderGeometry(0.0145, 0.0145, 0.002, 24); hole.translate(0, 0.0784, 0); pieces.push(['k', hole]);
      for (const z of [-0.008, 0, 0.008]) pieces.push(['s', new T.BoxGeometry(0.03, 0.0012, 0.0012).translate(0, 0.0792, z / 0.64)]);
      for (const z of [-0.007, 0.007]) pieces.push(['s', rod([-0.0188, 0.005, z / 0.64], [-0.0188, 0.083, z / 0.64], 0.0013, 0.0013, 5)]);
      for (const [k, g] of pieces) { g.scale(1, 1, 0.64); M.add(k, g, [fx, D + 0.032, 0], [0, 0, 0.13]); }
      M.part(name, [fx - Math.sin(0.13) * 0.08, D + 0.032 + Math.cos(0.13) * 0.08, 0]);
    };
    funnel(-0.025, 'smoke'); funnel(-0.072, 'smoke2');
    // Tripodmast med utkikk, rå og rigging
    const mx = 0.002, mb = D + 0.032, top = [mx - 0.004, 0.318, 0];
    M.add('s', rod([mx, mb, 0], top, 0.0036, 0.0022, 8));
    for (const s of [1, -1]) M.add('s', rod([mx - 0.03, mb, s * 0.022], [mx - 0.003, 0.236, 0], 0.0024, 0.0018, 6));
    M.add('s', new T.CylinderGeometry(0.013, 0.011, 0.016, 20), [mx - 0.003, 0.244, 0]);
    M.add('k', new T.BoxGeometry(0.004, 0.005, 0.02), [mx + 0.0095, 0.246, 0]);
    M.add('s', new T.ConeGeometry(0.0135, 0.008, 20), [mx - 0.003, 0.256, 0]);
    M.add('s', rod([mx - 0.004, 0.288, -0.034], [mx - 0.004, 0.288, 0.034], 0.0018, 0.0018, 6));
    M.add('s', rod([mx - 0.004, 0.302, -0.02], [mx - 0.004, 0.302, 0.02], 0.0013, 0.0013, 5));
    const mm = [-0.12, 0.236, 0];
    M.add('s', rod([-0.118, D, 0], mm, 0.003, 0.0018, 6));
    M.add('s', rod([-0.12, 0.212, -0.024], [-0.12, 0.212, 0.024], 0.0016, 0.0016, 5));
    M.add('s', new T.SphereGeometry(0.0022, 8, 6), mm);
    // Baugspyd og flaggstang akter
    const jack = [L1 - 0.014, deckY(L1) + 0.036, 0], stern = [L0 + 0.006, deckY(L0) + 0.042, 0];
    M.add('s', rod([L1 - 0.012, deckY(L1 - 0.012), 0], jack, 0.0018, 0.0013, 5));
    M.add('s', rod([L0 + 0.012, deckY(L0 + 0.01), 0], stern, 0.0018, 0.0013, 5));
    const wire = (a, b) => M.add('w', rod(a, b, 0.00048, 0.00048, 3, true));
    wire(top, jack); wire(top, mm); wire(mm, stern);
    for (const s of [1, -1]) {
      wire([mx - 0.004, 0.288, s * 0.034], [mx - 0.035, deckY(-0.03) + 0.002, s * (hw(-0.03) - 0.006)]);
      wire([mx - 0.004, 0.288, s * 0.034], [mx + 0.03, deckY(0.03) + 0.002, s * (hw(0.03) - 0.008)]);
      wire([-0.12, 0.212, s * 0.024], [-0.15, deckY(-0.15) + 0.002, s * (hw(-0.15) - 0.006)]);
    }
    // Flagg på stormasten (animerbart), peker akterover
    const fp = [-0.1205, 0.232, 0];
    const F = M.part('flag', fp);
    const FL = 0.044, FH = 0.028;
    const wave = (g) => {
      const q = g.attributes.position;
      for (let i = 0; i < q.count; i++) { const t = clamp(-q.getX(i) / FL, 0, 1); q.setZ(i, q.getZ(i) + 0.0035 * Math.sin(t * Math.PI * 2.2) * (0.25 + t)); q.setY(i, q.getY(i) - 0.002 * t * t); }
      g.computeVertexNormals(); return g;
    };
    F.add('s', wave(new T.BoxGeometry(FL, FH, 0.0011, 16, 2, 1).translate(-FL / 2 - 0.0012, -FH / 2, 0)), fp);
    F.add('d', wave(new T.BoxGeometry(0.0055, FH, 0.0017, 1, 4, 1).translate(-0.0165, -FH / 2, 0)), fp);
    F.add('d', wave(new T.BoxGeometry(FL - 0.001, 0.0055, 0.0017, 16, 1, 1).translate(-FL / 2 - 0.0012, -FH / 2, 0)), fp);
    F.add('s', new T.SphereGeometry(0.0016, 6, 4), [fp[0], fp[1] + 0.003, 0]);
  }

  // =====================================================================
  // STØVEL – snørestøvel med hobnails
  // =====================================================================
  function buildBoot(M) {
    const cxs = -0.09;
    const rx = (y) => 0.057 + 0.009 * ss(0.17, 0.32, y), rz = (y) => 0.046 + 0.007 * ss(0.17, 0.32, y);
    const ytop = (x) => lerp(0.031, 0.013, ss(-0.06, 0.0, x)) + 0.009 * ss(0.115, 0.2, x);
    const ybot = (x) => 0.008 * ss(-0.05, -0.03, x) * (1 - ss(0.0, 0.03, x)) + 0.009 * ss(0.115, 0.2, x);
    const shaftTop = 0.322;
    const shaft = (x, y, z) => {
      const ax = rx(y), az = rz(y);
      const q = sq(((x - cxs) / ax) ** 2 + (z / az) ** 2);
      const d2 = (q - 1) * Math.min(ax, az);
      const dy = Math.max(0.04 - y, y - shaftTop);
      const r = 0.008, a = d2 + r, b = dy + r;
      const ma = Math.max(a, 0), mb = Math.max(b, 0);
      return Math.min(Math.max(a, b), 0) + sq(ma * ma + mb * mb) - r;
    };
    const upper = (x, y, z) => {
      const az = Math.abs(z);
      let f = sdRBox(x + 0.094, y - 0.078, z, 0.054, 0.048, 0.0455, 0.03);
      f = smin(f, sdCap(x, y, z * 1.02, -0.05, 0.1, 0, 0.075, 0.058, 0, 0.049, 0.043), 0.03);
      f = smin(f, sdEll(x - 0.118, y - 0.048, z, 0.07, 0.037, 0.0485), 0.03);
      f = smin(f, shaft(x, y, z), 0.04);
      // tunge som stikker opp foran
      f = Math.min(f, sdRBox(x - (cxs + rx(shaftTop) - 0.008), y - (shaftTop + 0.004), z, 0.0045, 0.014, 0.017, 0.004));
      // lærfolder: tverrgående rynker over vristen og rynker rundt ankelen
      f += 0.0026 * groove((x + (y - 0.09) * 0.7) * 115 + 0.4 + 6 * z * z, 2) * ss(-0.005, 0.02, x) * (1 - ss(0.06, 0.085, x)) * ss(0.06, 0.085, y);
      const ang = Math.atan2(z, x - cxs);
      f += 0.0024 * groove(y * 125 + 1.1 * Math.sin(ang * 2 + 1), 2) * ss(0.12, 0.14, y) * (1 - ss(0.2, 0.235, y)) * (0.45 + 0.55 * Math.cos(ang));
      f += 0.0006 * Math.sin(x * 70 + z * 45) * Math.sin(y * 55 + 1.3) * ss(0.03, 0.06, y);
      // åpning mellom snøreklaffene (tungen synes i bunnen)
      if (x > cxs && y > 0.118) f = smax(f, -Math.max(az - 0.0042, 0.122 - y, -(f + 0.0042)), 0.0015);
      return smax(f, ytop(x) - 0.001 - y, 0.004);
    };
    const up = surfaceNets(upper, [-0.165, 0.003, -0.066], [0.2, 0.345, 0.066], 0.0061);
    aoPaint(up, upper, 55, 0.4);
    M.add('grain', obliqueUV(up, 18, 0.6, 0.45));
    // Såle og hæl: fotavtrykk ekstrudert, formet etter sålekurven
    const w = (x) => {
      const heel = 0.0505 * sq(Math.max(0, 1 - ((x + 0.098) / 0.06) ** 2));
      const fore = 0.0535 * sq(Math.max(0, 1 - ((x - 0.088) / 0.104) ** 2));
      const waist = x > -0.1 && x < 0.09 ? 0.044 + 0.004 * ss(0.0, 0.09, x) : 0;
      return Math.max(heel, fore, waist);
    };
    const xs = [];
    for (let i = 0; i <= 60; i++) xs.push(lerp(-0.1585, 0.1925, (1 - Math.cos((Math.PI * i) / 60)) / 2));
    const outline = xs.map((x) => [x, Math.max(0.0008, w(x))]);
    for (let i = xs.length - 2; i >= 1; i--) outline.push([xs[i], -Math.max(0.0008, w(xs[i]))]);
    const sole = new T.ExtrudeGeometry(shapeOf(outline), { depth: 1, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.0025, bevelOffset: -0.0025, bevelSegments: 2, steps: 1, curveSegments: 1 });
    sole.rotateX(-Math.PI / 2);
    const sp = sole.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i), t = (sp.getY(i) + 0.08) / 1.16;
      sp.setY(i, lerp(ybot(x), ytop(x) + 0.0005, t));
    }
    M.add('d', creaseNormals(sole, 45));
    // Omkrets rundt sålen (for hæl-lag, spiker og søm)
    const rim = (x0, x1, n, y, off) => {
      const a = [], b = [];
      for (let i = 0; i <= n; i++) { const x = lerp(x0, x1, (1 - Math.cos((Math.PI * i) / n)) / 2); a.push([x, typeof y === 'function' ? y(x) : y, w(x) + off]); }
      for (let i = a.length - 1; i >= 0; i--) b.push([a[i][0], a[i][1], -a[i][2]]);
      return a.concat(b.slice(1));
    };
    // Hæl: lagdelte lærskiver (mørke fuger) og to rader spikerhoder
    for (const y of [0.0105, 0.0205]) M.add('k', tube(rim(-0.052, -0.1585, 24, y, 0.0004).filter((q, i, arr) => i > 0 && i < arr.length - 1), 0.0007, 60, 3));
    const nailRow = (pts, r) => {
      const c = new T.CatmullRomCurve3(pts.map(V3)), Lc = c.getLength(), n = Math.floor(Lc / 0.0082);
      for (let i = 1; i < n; i++) { const q = c.getPointAt(i / n); M.add('s', new T.SphereGeometry(r, 6, 3), [q.x, q.y, q.z]); }
    };
    nailRow(rim(-0.052, -0.1585, 24, 0.0048, -0.0003), 0.0018);
    nailRow(rim(-0.04, -0.1585, 24, 0.0155, 0.0001), 0.0012);
    nailRow(rim(-0.02, 0.1925, 30, (x) => ybot(x) + 0.0042, -0.0002).filter((q) => q[0] > -0.02 || true), 0.0015);
    // Søm langs sålekanten (stiplet)
    const dashes = (pts, len, gap, r, key, closed) => {
      const c = new T.CatmullRomCurve3(pts.map(V3), !!closed);
      const L = c.getLength(); let s = 0;
      while (s + len < L) {
        const a = c.getPointAt(s / L), b = c.getPointAt((s + len) / L);
        M.add(key || 'd', rod([a.x, a.y, a.z], [b.x, b.y, b.z], r, r, 3, true));
        s += len + gap;
      }
    };
    const welt = [];
    for (const x of xs.slice(2, -2)) welt.push([x, ytop(x) + 0.0012, w(x) - 0.0016]);
    dashes(welt.concat(welt.slice().reverse().map((q) => [q[0], q[1], -q[2]])), 0.0042, 0.003, 0.001, 'w');
    // Tåkappe-søm, hælkappe-søm og klaffesømmer projisert på overflaten
    const onSurf = (pts, off) => pts.map((q) => offP(project(upper, q), off));
    const toe = [];
    for (let i = 0; i <= 26; i++) { const a = lerp(-1.35, 1.35, i / 26); toe.push([0.07 + 0.012 * Math.cos(a), 0.022 + 0.055 * Math.cos(a), 0.06 * Math.sin(a)]); }
    M.add('d', tube(onSurf(toe, 0.0003), 0.0013, 40, 4));
    dashes(onSurf(toe.map((q) => [q[0] - 0.007, q[1], q[2]]), 0.0005), 0.0038, 0.0028, 0.0008, 'd');
    // Snøring: maljer, snørekroker og lisser
    const rows = [];
    for (let i = 0; i < 8; i++) {
      const y = 0.13 + i * 0.0245;
      rows.push([project(upper, [0.03, y, -0.0175]), project(upper, [0.03, y, 0.0175])]);
    }
    for (const s of [1, -1]) {
      const hc = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16; hc.push([lerp(-0.155, -0.035, t), 0.04 + 0.07 * Math.sin(Math.PI * t), s * 0.06]); }
      M.add('d', tube(onSurf(hc, 0.0003), 0.0012, 30, 4));
      dashes(onSurf(hc.map((q) => [q[0], q[1] - 0.006, q[2]]), 0.0005), 0.0038, 0.0028, 0.0008, 'd');
      // klaffesøm langs snøringen
      const fl = rows.map((r) => r[s > 0 ? 1 : 0].p).map((q) => [q[0] - 0.004, q[1], q[2] + s * 0.007]);
      dashes(onSurf(fl, 0.0004), 0.0036, 0.0026, 0.0008, 'd');
    }
    rows.forEach((pair, i) => {
      for (const e of pair) {
        const n = new T.Vector3(e.n[0], e.n[1], e.n[2]);
        if (i < 6) {
          M.add('s', orient(new T.TorusGeometry(0.0038, 0.0013, 4, 10), offP(e, 0.0005), n, new T.Vector3(0, 0, 1)));
          M.add('k', orient(new T.CircleGeometry(0.0027, 10), offP(e, 0.0003), n, new T.Vector3(0, 0, 1)));
        } else {
          // snørekrok: liten bøyle som peker utover
          const side = Math.sign(e.p[2]);
          M.add('s', orient(new T.CylinderGeometry(0.0022, 0.0026, 0.002, 10), offP(e, 0.0008), n));
          M.add('s', tube([offP(e, 0.001), [e.p[0] + e.n[0] * 0.004, e.p[1] + 0.002, e.p[2] + side * 0.002], [e.p[0] + e.n[0] * 0.006, e.p[1] - 0.0015, e.p[2] + side * 0.0035]], 0.0011, 8, 4));
        }
      }
    });
    for (let i = 0; i < rows.length - 1; i++) {
      for (const [a, b, lift] of [[rows[i][0], rows[i + 1][1], 0.0042], [rows[i][1], rows[i + 1][0], 0.0028]]) {
        const pa = offP(a, 0.0018), pb = offP(b, 0.0018);
        const mn = [(a.n[0] + b.n[0]) / 2, (a.n[1] + b.n[1]) / 2, (a.n[2] + b.n[2]) / 2];
        const mid = [(pa[0] + pb[0]) / 2 + mn[0] * lift, (pa[1] + pb[1]) / 2 + mn[1] * lift, (pa[2] + pb[2]) / 2 + mn[2] * lift];
        M.add('w', tube([pa, mid, pb], 0.0017, 9, 5));
      }
    }
    M.add('w', tube([offP(rows[0][0], 0.0018), offP(project(upper, [0.03, 0.13, 0]), 0.0035), offP(rows[0][1], 0.0018)], 0.0017, 10, 6));
    // Hempe bak og polstret topp-kant
    const bx = cxs - rx(shaftTop) + 0.004;
    M.add('d', ribbon([[bx + 0.003, shaftTop - 0.014, 0], [bx - 0.004, shaftTop + 0.004, 0], [bx - 0.0025, shaftTop + 0.017, 0], [bx + 0.003, shaftTop + 0.004, 0]], 0.012, 0.0022, { closed: true, segs: 30, up: [0, 0, 1] }));
    const topRing = [];
    for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2; topRing.push([cxs + Math.cos(a) * (rx(shaftTop) - 0.0045), shaftTop - 0.002, Math.sin(a) * (rz(shaftTop) - 0.0045)]); }
    M.add('s', tube(topRing, 0.0042, 64, 6, true));
    const hole = new T.CircleGeometry(1, 40); hole.rotateX(-Math.PI / 2);
    M.add('k', hole, [cxs, shaftTop - 0.0005, 0], null, [rx(shaftTop) - 0.008, 1, rz(shaftTop) - 0.008]);
    const ring2 = [];
    for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; if (Math.cos(a) > 0.86) continue; ring2.push([cxs + Math.cos(a) * 0.08, 0.296, Math.sin(a) * 0.07]); }
    dashes(onSurf(ring2, 0.0003), 0.0042, 0.003, 0.0009, 'd');
    // Sløyfe på toppen (animerbar del «laces», pivot i knuten)
    const top = rows[rows.length - 1];
    const kc = project(upper, [0.03, top[0].p[1] + 0.006, 0]);
    const knot = offP(kc, 0.0045);
    const L = M.part('laces', knot);
    const fwd = new T.Vector3(kc.n[0], 0, kc.n[2]).normalize(), upv = new T.Vector3(0, 1, 0), side = new T.Vector3(0, 0, 1);
    const P = (a, b, c) => [knot[0] + fwd.x * a + upv.x * b + side.x * c, knot[1] + fwd.y * a + upv.y * b + side.y * c, knot[2] + fwd.z * a + upv.z * b + side.z * c];
    L.add('w', new T.SphereGeometry(0.0052, 12, 8), knot, null, [0.8, 1, 1.2]);
    for (const s of [1, -1]) {
      L.add('w', tube([P(0, 0, 0), P(0.005, 0.006, s * 0.011), P(0.006, 0.017, s * 0.026), P(0.002, 0.024, s * 0.019), P(0.002, 0.012, s * 0.005), P(0, 0, 0)], 0.002, 32, 6, true));
      const end = [P(0.001, 0, s * 0.003), P(0.005, -0.01, s * 0.012), P(0.007, -0.026, s * 0.017), P(0.0075, -0.04, s * 0.015)];
      L.add('w', tube(end, 0.0019, 18, 6));
      L.add('s', rod(end[3], [end[3][0], end[3][1] - 0.008, end[3][2] - s * 0.001], 0.0022, 0.002, 8));
    }
  }

  // =====================================================================
  // HUND – skotsk terrier (stående)
  // =====================================================================
  function buildDog(M) {
    const body = (x, y, z) => {
      const az = Math.abs(z);
      let d = sdCap(x, y, z, -0.09, 0.155, 0, 0.052, 0.16, 0, 0.055, 0.057);
      d = smin(d, sdEll(x - 0.068, y - 0.146, z, 0.058, 0.066, 0.053), 0.03);
      // hengende pels («skjørt») med frynsete underkant og lokker
      const hem = 0.074 + 0.006 * Math.sin(x * 210 + az * 70) + 0.004 * Math.sin(x * 97 - 1);
      let skirt = smax(sdRBox(x + 0.012, y - 0.13, z, 0.088, 0.065, 0.049, 0.024), hem - y, 0.01);
      skirt += 0.0026 * groove(x * 230 + az * 140, 3) * (1 - ss(0.12, 0.16, y));
      d = smin(d, skirt, 0.026);
      // bein og poter
      d = smin(d, sdCap(x, y, az, 0.072, 0.125, 0.032, 0.081, 0.022, 0.034, 0.023, 0.019), 0.018);
      d = smin(d, sdCap(x, y, az, -0.087, 0.15, 0.033, -0.104, 0.07, 0.037, 0.033, 0.022), 0.02);
      d = smin(d, sdCap(x, y, az, -0.104, 0.07, 0.037, -0.089, 0.022, 0.036, 0.021, 0.018), 0.012);
      d = smin(d, sdEll(x - 0.091, y - 0.012, az - 0.035, 0.028, 0.0135, 0.021), 0.012);
      d = smin(d, sdEll(x + 0.08, y - 0.012, az - 0.036, 0.028, 0.0135, 0.021), 0.012);
      // tær (små riller foran på potene)
      d += 0.0018 * groove((az - 0.035) * 330, 3) * ss(0.024, 0.012, y) * (ss(0.09, 0.11, x) + ss(-0.072, -0.058, x) * (1 - ss(-0.05, -0.04, x)));
      // hals
      d = smin(d, sdCap(x, y, z, 0.055, 0.165, 0, 0.098, 0.222, 0, 0.047, 0.04), 0.025);
      // lagvise pelsfryndser på sidene og ryggen
      d += 0.0019 * groove(y * 125 + 0.9 * Math.sin(x * 75 + az * 40), 3) * ss(0.095, 0.12, y) * ss(0.02, 0.04, az + 0.012 * ss(0.18, 0.21, y)) * (1 - ss(0.07, 0.1, x));
      return d;
    };
    const head = (x, y, z) => {
      const az = Math.abs(z);
      let d = sdCap(x, y, z, 0.108, 0.258, 0, 0.162, 0.255, 0, 0.038, 0.035);
      d = smin(d, sdCap(x, y, z, 0.072, 0.188, 0, 0.11, 0.244, 0, 0.041, 0.037), 0.02);
      d = smin(d, sdRBox(x - 0.197, y - 0.243, z, 0.037, 0.021, 0.025, 0.016), 0.016);
      // firkantet, hengende skjegg med lokker
      let beard = sdRBox(x - 0.199, y - 0.212, z, 0.034, 0.03, 0.027, 0.02);
      beard += 0.0028 * groove(z * 260 + x * 40, 2) * ss(0.236, 0.215, y);
      beard = smax(beard, 0.177 + 0.006 * Math.sin(z * 230 + 1) + 0.008 * ss(0.2, 0.17, x) - y, 0.008);
      d = smin(d, beard, 0.014);
      // kinn/barter
      d = smin(d, sdEll(x - 0.205, y - 0.232, az - 0.017, 0.029, 0.017, 0.015) + 0.0015 * groove(y * 300, 3), 0.012);
      // buskete øyebryn
      d = smin(d, sdEll(x - 0.172, y - 0.2805, az - 0.02, 0.026, 0.0105, 0.0145) + 0.0012 * groove(az * 380 + y * 120, 3), 0.007);
      // øyehuler
      d = smax(d, -(sq((x - 0.176) ** 2 + (y - 0.266) ** 2 + (az - 0.029) ** 2) - 0.0085), 0.004);
      // pels på pannen og nakken
      d += 0.001 * groove(x * 150 + az * 110, 3) * ss(0.272, 0.29, y) * (1 - ss(0.16, 0.19, x));
      return d;
    };
    const earF = (s) => (x, y, z) => {
      const bx = 0.127, by = 0.284, bz = s * 0.022;
      const X = bx + (x - bx) * 1.65;
      const d = sdCap(X, y, z, bx, by, bz, 0.12, 0.337, s * 0.037, 0.021, 0.0035);
      return smax(d, -sdCap(X - 0.0105, y, z, bx, by + 0.009, bz, 0.12, 0.329, s * 0.035, 0.0135, 0.0018), 0.003);
    };
    const tail = (x, y, z) => {
      let d = smin(sdCap(x, y, z, -0.118, 0.168, 0, -0.137, 0.232, 0, 0.022, 0.014), sdCap(x, y, z, -0.137, 0.232, 0, -0.151, 0.285, 0, 0.014, 0.0045), 0.012);
      d += 0.0013 * groove(Math.atan2(z, x + 0.135) * 6 + y * 70, 3);
      return d;
    };
    const ears = [earF(1), earF(-1)];
    const all = (x, y, z) => Math.min(body(x, y, z), head(x, y, z), tail(x, y, z), ears[0](x, y, z), ears[1](x, y, z));
    const bodyHead = (x, y, z) => Math.min(body(x, y, z), head(x, y, z));
    const furMesh = (f, b0, b1, h, fao) => { const g = surfaceNets(f, b0, b1, h); aoPaint(g, fao || f, 50, 0.38); return obliqueUV(g, 13, 0.7, 0.5); };

    // Kropp (rot) med halsbånd
    M.add('fur', furMesh(body, [-0.19, 0.0, -0.08], [0.135, 0.255, 0.08], 0.0067, bodyHead));
    // Halsbånd: strålesøk rundt halsen + glatting, så båndet ligger jevnt over pelsen
    const ax = new T.Vector3(0.043, 0.06, 0).normalize(), c0 = new T.Vector3(0.088, 0.202, 0);
    const u = new T.Vector3(0, 0, 1), wv = ax.clone().cross(u).normalize();
    const NR = 56, rr = [], dirs = [];
    for (let i = 0; i < NR; i++) {
      const a = (i / NR) * Math.PI * 2, dv = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(wv, Math.sin(a));
      let lo0 = 0.005, hi0 = 0.1;
      for (let k = 0; k < 22; k++) { const m = (lo0 + hi0) / 2, q = c0.clone().addScaledVector(dv, m); if (all(q.x, q.y, q.z) < 0) lo0 = m; else hi0 = m; }
      rr.push(lo0); dirs.push(dv);
    }
    for (let pass = 0; pass < 4; pass++) { const c = rr.slice(); for (let i = 0; i < NR; i++) rr[i] = Math.max(c[i], (c[(i + NR - 1) % NR] + c[i] * 2 + c[(i + 1) % NR]) / 4); }
    const ring = dirs.map((dv, i) => { const q = c0.clone().addScaledVector(dv, rr[i]); return { p: [q.x, q.y, q.z], n: [dv.x, dv.y, dv.z] }; });
    M.add('fur.d', ribbon(ring.map((r) => offP(r, 0.0018)), 0.012, 0.0034, { closed: true, segs: 80, up: [ax.x, ax.y, ax.z] }));
    for (let i = 0; i < 56; i += 4) M.add('fur.s', new T.SphereGeometry(0.0023, 6, 4), offP(ring[i], 0.0042));
    let lo = ring[0]; for (const r of ring) if (r.p[0] - r.p[1] > lo.p[0] - lo.p[1]) lo = r;
    const tagC = [lo.p[0] + 0.01, lo.p[1] - 0.012, 0];
    M.add('fur.s', new T.TorusGeometry(0.0036, 0.0011, 5, 12), [lo.p[0] + 0.007, lo.p[1] - 0.003, 0], [0, Math.PI / 2, 0]);
    const tag = new T.CylinderGeometry(0.0088, 0.0088, 0.0022, 22); tag.rotateZ(Math.PI / 2 - 0.55); M.add('fur.s', tag, tagC);
    M.add('fur.s', new T.TorusGeometry(0.0082, 0.0011, 5, 22).rotateY(Math.PI / 2).rotateZ(-0.55), tagC);
    const star = new T.CylinderGeometry(0.0045, 0.0045, 0.0026, 5); star.rotateZ(Math.PI / 2 - 0.55); M.add('fur.d', star, tagC);
    // Hode (pivot i nakken ved halsbåndet)
    const Hd = M.part('head', [0.096, 0.21, 0]);
    Hd.add('fur', furMesh(head, [0.04, 0.155, -0.068], [0.272, 0.31, 0.068], 0.0051, bodyHead));
    const nose = project(head, [0.27, 0.247, 0]);
    Hd.add('fur.k', new T.SphereGeometry(0.0135, 18, 12), [nose.p[0] - 0.005, nose.p[1] + 0.001, 0], null, [0.95, 0.82, 1.12]);
    for (const s of [1, -1]) {
      Hd.add('fur.k', new T.SphereGeometry(0.0021, 8, 6), [nose.p[0] + 0.0075, nose.p[1] - 0.001, s * 0.0055]);
      Hd.add('fur.k', new T.SphereGeometry(0.0068, 14, 10), [0.1745, 0.266, s * 0.0285]);
      Hd.add('fur.s', new T.SphereGeometry(0.0016, 6, 4), [0.1785, 0.269, s * 0.0335]);
    }
    // Ører (barn av hodet, pivot i roten)
    [1, -1].forEach((s, i) => {
      const E = Hd.part('ears[]', [0.127, 0.288, s * 0.022]);
      const b0 = [0.1, 0.262, s > 0 ? 0.0 : -0.06], b1 = [0.152, 0.35, s > 0 ? 0.06 : 0.0];
      E.add('fur', furMesh(ears[i], b0, b1, 0.0036));
    });
    // Hale (pivot i roten)
    const Tl = M.part('tail', [-0.121, 0.176, 0]);
    Tl.add('fur', furMesh(tail, [-0.18, 0.135, -0.032], [-0.09, 0.3, 0.032], 0.0044));
    // Bein: tomme delgrupper (pivot i skulder/hofte) som skinner kroppens pelsmesh. Beina er
    // fortsatt en del av kroppens SDF, så pels, skjørt og poter henger sammen uten skjøt; vektene
    // går fra 0 ved leddet til 1 et stykke ned på beinet (under skjørtekanten er beinet stivt).
    // Rekkefølge: [front venstre (−Z), front høyre (+Z), bak venstre (−Z), bak høyre (+Z)].
    const legF = (x, y, z) => smin(sdCap(x, y, z, 0.072, 0.125, 0.032, 0.081, 0.022, 0.034, 0.023, 0.019), sdEll(x - 0.091, y - 0.012, z - 0.035, 0.028, 0.0135, 0.021), 0.012);
    const legB = (x, y, z) => smin(smin(sdCap(x, y, z, -0.087, 0.15, 0.033, -0.104, 0.07, 0.037, 0.033, 0.022), sdCap(x, y, z, -0.104, 0.07, 0.037, -0.089, 0.022, 0.036, 0.021, 0.018), 0.012), sdEll(x + 0.08, y - 0.012, z - 0.036, 0.028, 0.0135, 0.021), 0.012);
    const LEGS = [[legF, -1, 0.072, 0.125, 0.032, 0.05, 0.42], [legF, 1, 0.072, 0.125, 0.032, 0.05, 0.42], [legB, -1, -0.087, 0.15, 0.033, 0.08, 0.5], [legB, 1, -0.087, 0.15, 0.033, 0.08, 0.5]];
    const legParts = LEGS.map((L) => M.part('legs[]', [L[2], L[3], L[1] * L[4]]));
    M.skin('fur', legParts, (x, y, z) => LEGS.map(([f, s, px, py, , t0, t1]) => {
      const t = (py - y) / (py - 0.012);
      if (t <= t0 || s * z <= -0.006 || Math.abs(x - px) > 0.075) return 0;
      return ss(0.016, 0.003, f(x, y, s * z)) * ss(t0, t1, t) * ss(-0.006, 0.012, s * z);
    }));
    M.extra.legAxis = 'z'; M.extra.legSign = 1;
  }

  // =====================================================================
  // FINGERBØL
  // =====================================================================
  function buildThimble(M) {
    // Rullet kant med riflet vulst
    const lip = lathe(roundPath([[0.093, 0.0], [0.111, 0.0, 0.004], [0.1175, 0.008, 0.006], [0.1175, 0.021, 0.006], [0.1095, 0.029, 0.004], [0.1055, 0.0305]], 3), 112);
    const lp = lip.attributes.position;
    for (let i = 0; i < lp.count; i++) {
      const x = lp.getX(i), z = lp.getZ(i), r = Math.hypot(x, z), y = lp.getY(i);
      if (r < 0.112) continue;
      const k = (r + 0.00085 * Math.cos(56 * Math.atan2(x, z)) * ss(0.006, 0.011, y) * (1 - ss(0.019, 0.024, y))) / r;
      lp.setX(i, x * k); lp.setZ(i, z * k);
    }
    M.add('s', creaseNormals(lip, 32));
    // Dekorbånd + gropete kuppel i ett stykke (normal- og fargekart)
    const rb = (y) => 0.1052 - (0.0037 * (y - 0.03)) / 0.06;
    const raw = [];
    for (let y = 0.03; y < 0.09; y += 0.004) raw.push([rb(y), y]);
    const dome = spline2([[rb(0.09), 0.09], [0.0995, 0.15], [0.0945, 0.21], [0.0875, 0.25], [0.0745, 0.276], [0.05, 0.2915], [0.022, 0.2975], [0, 0.2985]], 120);
    for (const q of dome) raw.push(q);
    const curve = new T.SplineCurve(raw.map((p) => new T.Vector2(p[0], p[1])));
    const pts = curve.getSpacedPoints(72).map((v) => [v.x, v.y]);
    pts[0] = [rb(0.03), 0.03]; pts[pts.length - 1][0] = 0;
    let sBand = 0;
    for (let i = 1; i < pts.length; i++) { if (pts[i][1] > 0.09) break; sBand += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); }
    if (!S.thimbleTex) S.thimbleTex = thimbleTex(pts, sBand);
    M.add('dimple', withUV(lathe(pts, 96)));
    // Pyntelister mellom kant, bånd og kuppel
    M.add('w', new T.TorusGeometry(rb(0.0315) + 0.0002, 0.0019, 5, 96), [0, 0.0315, 0], [Math.PI / 2, 0, 0]);
    M.add('s', new T.TorusGeometry(rb(0.09) + 0.0003, 0.0029, 6, 96), [0, 0.0905, 0], [Math.PI / 2, 0, 0]);
    M.add('d', new T.TorusGeometry(rb(0.094) - 0.0004, 0.0012, 4, 96), [0, 0.0952, 0], [Math.PI / 2, 0, 0]);
  }

  const BUILDERS = { car: buildCar, hat: buildHat, ship: buildShip, boot: buildBoot, dog: buildDog, thimble: buildThimble };

  function getModel(id) {
    if (!S.models[id]) {
      const t0 = performance.now();
      const M = new Model('', [0, 0, 0]);
      (BUILDERS[id] || BUILDERS.car)(M);
      S.models[id] = finalize(M);
      S.models[id].ms = performance.now() - t0;
    }
    return S.models[id];
  }

  function instantiate(node, parentPivot, parts) {
    const grp = new T.Group();
    if (parentPivot) {
      grp.position.set(node.pivot[0] - parentPivot[0], node.pivot[1] - parentPivot[1], node.pivot[2] - parentPivot[2]);
      grp.name = 'part-' + node.name.replace('[]', '');
    }
    const skinned = [];
    for (const m of node.meshes) {
      const mesh = m.skinned ? new T.SkinnedMesh(m.geo, matFor(m.key)) : new T.Mesh(m.geo, matFor(m.key));
      mesh.castShadow = true; mesh.receiveShadow = true;
      if (m.skinned) skinned.push(mesh);
      grp.add(mesh);
    }
    const kidGrps = node.kids.map((k) => instantiate(k, node.pivot, parts));
    for (const kg of kidGrps) grp.add(kg);
    if (node.skin && skinned.length) {
      // Ett Bone i noden (hvile) + ett Bone i origo av hver styrende del-gruppe. bindMatrix = I,
      // boneInverse = −(delens pivot relativt til noden) → delens rotasjon virker rundt pivoten.
      const bones = [new T.Bone()], inv = [new T.Matrix4()];
      grp.add(bones[0]);
      for (const ki of node.skin.parts) {
        const b = new T.Bone(); b.name = 'bone-' + node.kids[ki].name.replace('[]', '');
        kidGrps[ki].add(b); bones.push(b);
        const pv = node.kids[ki].pivot;
        inv.push(new T.Matrix4().makeTranslation(node.pivot[0] - pv[0], node.pivot[1] - pv[1], node.pivot[2] - pv[2]));
      }
      for (const sm of skinned) sm.bind(new T.Skeleton(bones, inv), new T.Matrix4());
    }
    if (parentPivot && node.name) {
      if (node.name.endsWith('[]')) { const n = node.name.slice(0, -2); (parts[n] = parts[n] || []).push(grp); } else parts[node.name] = grp;
    }
    return grp;
  }

  function build(THREE, id, colorHex) {
    T = THREE || window.THREE;
    mats(); baseGeos();
    if (!BUILDERS[id]) id = 'car';
    const g = new T.Group(); g.name = 'token-' + id;
    const base = new T.Mesh(S.baseGeo, baseMat(colorHex == null ? 0xd33 : colorHex));
    base.castShadow = true; base.receiveShadow = true;
    const rim = new T.Mesh(S.rimGeo, S.mats.m); rim.castShadow = true; rim.receiveShadow = true;
    base.add(rim);
    g.add(base);
    const model = getModel(id);
    const parts = {};
    const body = instantiate(model, null, parts);
    body.name = 'token-model'; body.position.y = BASE_TOP;
    g.add(body);
    g.userData.tokenId = id;
    g.userData.parts = parts;
    Object.assign(g.userData, model.extra);
    return g;
  }

  // ---------- Portretter ----------
  function rig() {
    if (S.rig) return S.rig;
    const r = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.toneMapping = T.NoToneMapping; r.outputColorSpace = T.SRGBColorSpace;
    r.setClearColor(0x000000, 0);
    const scene = new T.Scene();
    const pm = new T.PMREMGenerator(r);
    scene.environment = pm.fromScene(new window.RoomEnvironment(), 0.04).texture;
    pm.dispose();
    scene.add(new T.HemisphereLight(0xfff4e0, 0x3a2a20, 0.6));
    const sun = new T.DirectionalLight(0xfff1dd, 1.15); sun.position.set(-2, 6, 4); scene.add(sun);
    const fill = new T.DirectionalLight(0xbfd8ff, 0.35); fill.position.set(5, 3, -3); scene.add(fill);
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.01, 50);
    const out = document.createElement('canvas');
    S.rig = { r, scene, cam, out };
    return S.rig;
  }
  function portrait(id, colorHex, sizePx) {
    T = window.THREE;
    if (!T || !window.RoomEnvironment) return '';
    sizePx = Math.max(16, Math.round(sizePx || 128));
    mats();
    const key = id + '|' + colorKey(colorHex == null ? 0xd33 : colorHex) + '|' + sizePx;
    if (S.portraits[key]) return S.portraits[key];
    const P = rig();
    const g = build(T, id, colorHex);
    P.scene.add(g);
    g.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(g), c = box.getCenter(new T.Vector3());
    const dir = new T.Vector3(0.95, 0.5, 1.1).normalize();
    P.cam.position.copy(c).addScaledVector(dir, 3); P.cam.lookAt(c); P.cam.updateMatrixWorld(true);
    const inv = P.cam.matrixWorldInverse, v = new T.Vector3();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const half = Math.max(x1 - x0, y1 - y0) / 2 * 0.94, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    Object.assign(P.cam, { left: mx - half, right: mx + half, top: my + half, bottom: my - half });
    P.cam.updateProjectionMatrix();
    const big = sizePx * 2;
    P.r.setSize(big, big, false);
    P.r.render(P.scene, P.cam);
    P.out.width = sizePx; P.out.height = sizePx;
    const ctx = P.out.getContext('2d');
    ctx.clearRect(0, 0, sizePx, sizePx);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(P.r.domElement, 0, 0, big, big, 0, 0, sizePx, sizePx);
    const url = P.out.toDataURL('image/png');
    P.scene.remove(g);
    S.portraits[key] = url;
    return url;
  }

  // Statistikk (til testsiden): trekanter og draw calls per brikke (inkl. sokkel og kant).
  function stats(id) {
    T = window.THREE; mats(); baseGeos();
    const model = getModel(id), list = [];
    let tris = 0;
    (function walk(n, path) {
      for (const m of n.meshes) { tris += m.tris; list.push({ key: (path ? path + '/' : '') + m.key, tris: m.tris }); }
      n.kids.forEach((k) => walk(k, k.name.replace('[]', '')));
    })(model, '');
    const baseTris = S.baseGeo.index.count / 3 + S.rimGeo.attributes.position.count / 3;
    return { id, drawCalls: list.length + 2, triangles: Math.round(tris + baseTris), baseTris, parts: list, buildMs: Math.round(model.ms || 0) };
  }

  MP.Tokens = { ids: IDS.slice(), build, portrait, stats };
})();

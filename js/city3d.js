/* Monopol Oslo 3D – levende Oslo rundt brettet.
 * MP.City.build(THREE, scene, { renderer, quality: 'high'|'low' }) -> { update(dt, elapsed) }
 * Alt lages i kode (ingen nedlastede modeller/teksturer). Statisk geometri slås sammen per
 * materiale, og alt som gjentas (trær, biler, folk, båter …) er InstancedMesh.
 */
(function () {
  'use strict';
  const MP = (window.MP = window.MP || {});

  const GY = -0.36;   // bakkenivå (brettets underside)
  const WY = -0.62;   // vannflaten i fjorden
  const RL = 7.5;     // halve lengden av de rette strekkene i den avrundede ringen
  const FH = 0.34;    // etasjehøyde
  const TW = 0.3;     // vindusbredde
  const SQ = 13.2;    // ytterkant av plass + ringvei + fortau

  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function sstep(a, b, x) { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

  // Avrundet kvadrat rundt brettet: rette strekk på 2*RL og hjørnebuer med radius a-RL.
  function ringLen(a) { return 8 * RL + 2 * Math.PI * Math.max(0, a - RL); }
  function ringPoint(a, s, out) {
    const R = Math.max(0, a - RL), seg = 2 * RL, side = seg + (Math.PI * R) / 2, P = 4 * side;
    s %= P; if (s < 0) s += P;
    const k = Math.floor(s / side), u = s - k * side;
    let x, z, dx, dz;
    if (u < seg || R === 0) { x = a; z = -RL + Math.min(u, seg); dx = 0; dz = 1; }
    else { const th = (u - seg) / R; x = RL + R * Math.cos(th); z = RL + R * Math.sin(th); dx = -Math.sin(th); dz = Math.cos(th); }
    for (let i = 0; i < k; i++) { let q = x; x = -z; z = q; q = dx; dx = -dz; dz = q; }
    out.x = x; out.z = z; out.dx = dx; out.dz = dz;
    return out;
  }

  // Terreng utenfor byen: Oslomarka-åser, Holmenkollåsen og fjorden mot sør.
  function terrainH(x, z) {
    const R = Math.max(Math.abs(x), Math.abs(z));
    let h = -0.4 + sstep(64, 125, R) * (9 + 5 * Math.sin(x * 0.045 + 1.3) * Math.cos(z * 0.05) + 3 * Math.sin(x * 0.13 + z * 0.07));
    const hx = x + 40, hz = z - 78;
    h += sstep(62, 74, R) * 15 * Math.exp(-(hx * hx + hz * hz) / 338);
    if (z < -24) {
      const W = 64 + 0.45 * Math.max(0, -30 - z);
      const f = sstep(-26, -34, z) * (1 - sstep(W - 6, W + 10, Math.abs(x)));
      h = h * (1 - f) - 3 * f;
    }
    return h;
  }

  function pip(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------- Geometribunt: flate normaler + vertex-farger (+ valgfri UV) ----------
  function Batch(uv) { this.p = []; this.n = []; this.c = []; this.u = uv ? [] : null; }
  Batch.prototype.tri = function (a, b, c, col, ua, ub, uc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz); if (l < 1e-10) return;
    nx /= l; ny /= l; nz /= l;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.c.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    if (this.u) {
      if (ua) this.u.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
      else this.u.push(0.03, 0.03, 0.03, 0.03, 0.03, 0.03);
    }
  };
  Batch.prototype.quad = function (a, b, c, d, col, ua, ub, uc, ud) { this.tri(a, b, c, col, ua, ub, uc); this.tri(a, c, d, col, ua, uc, ud); };
  // Firkant som vender mot (nx,ny,nz) uansett punktrekkefølge.
  Batch.prototype.quadFacing = function (a, b, c, d, col, nx, ny, nz) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz >= 0) this.quad(a, b, c, d, col); else this.quad(a, d, c, b, col);
  };
  // Én trekant (ni flyttall fra indeks i) fra en mal-geometri, transformert med m/nm.
  Batch.prototype.stampTri = function (P, N, Cc, i0, e, f, over) {
    for (let i = i0; i < i0 + 9; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      this.p.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      const nx = N[i], ny = N[i + 1], nz = N[i + 2];
      const ax = f[0] * nx + f[3] * ny + f[6] * nz, ay = f[1] * nx + f[4] * ny + f[7] * nz, az = f[2] * nx + f[5] * ny + f[8] * nz;
      const l = Math.hypot(ax, ay, az) || 1;
      this.n.push(ax / l, ay / l, az / l);
      if (over) this.c.push(over.r, over.g, over.b); else this.c.push(Cc[i], Cc[i + 1], Cc[i + 2]);
      if (this.u) this.u.push(0.03, 0.03);
    }
  };
  Batch.prototype.stamp = function (geo, m, nm, over) {
    const P = geo.attributes.position.array, N = geo.attributes.normal.array, Cc = geo.attributes.color.array;
    for (let i = 0; i < P.length; i += 9) this.stampTri(P, N, Cc, i, m.elements, nm.elements, over);
  };
  Batch.prototype.count = function () { return this.p.length / 9; };
  Batch.prototype.geometry = function (THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.u) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.computeBoundingSphere();
    return g;
  };

  // Bunt som fordeler hver trekant på en nær og en fjern bunt (Chebyshev-avstand fra brettets midte),
  // så bare den nære delen trenger å kaste skygge.
  function SplitBatch(uv, R) { this.near = new Batch(uv); this.far = new Batch(uv); this.R = R; }
  // Flate trekanter på bakkenivå (veier, striper, belegg) kaster ingen synlig skygge og legges alltid i den fjerne bunten.
  SplitBatch.prototype.pick = function (x, z, y0, y1, y2) {
    if (y0 === y1 && y1 === y2 && y0 < GY + 0.07) return this.far;
    return Math.max(Math.abs(x), Math.abs(z)) < this.R ? this.near : this.far;
  };
  SplitBatch.prototype.tri = function (a, b, c, col, ua, ub, uc) { this.pick((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3, a[1], b[1], c[1]).tri(a, b, c, col, ua, ub, uc); };
  SplitBatch.prototype.quad = Batch.prototype.quad;
  SplitBatch.prototype.quadFacing = Batch.prototype.quadFacing;
  SplitBatch.prototype.stamp = function (geo, m, nm, over) {
    const P = geo.attributes.position.array, N = geo.attributes.normal.array, Cc = geo.attributes.color.array, e = m.elements;
    const ty = (k) => Math.round((e[1] * P[k] + e[5] * P[k + 1] + e[9] * P[k + 2] + e[13]) * 1e5);
    for (let i = 0; i < P.length; i += 9) {
      const sx = P[i] + P[i + 3] + P[i + 6], sy = P[i + 1] + P[i + 4] + P[i + 7], sz = P[i + 2] + P[i + 5] + P[i + 8];
      this.pick((e[0] * sx + e[4] * sy + e[8] * sz) / 3 + e[12], (e[2] * sx + e[6] * sy + e[10] * sz) / 3 + e[14], ty(i) / 1e5, ty(i + 3) / 1e5, ty(i + 6) / 1e5)
        .stampTri(P, N, Cc, i, e, nm.elements, over);
    }
  };
  SplitBatch.prototype.count = function () { return this.near.count() + this.far.count(); };

  // ---------- Kontaktskygger (bakt «AO» på bakken) ----------
  // Flate trekanter med RGBA-vertexfarge: r = styrke, a = 0–1 fra ytterkant til kjerne (formes med smoothstep i shaderen).
  function AOBatch() { this.p = []; this.c = []; }
  AOBatch.prototype.v = function (x, y, z, s, t) { this.p.push(x, y, z); this.c.push(s, 0, 0, t); };
  AOBatch.prototype.count = function () { return this.p.length / 9; };
  // Myk ramme rundt et rektangulært fotavtrykk (w × d, rotert rot), spread = hvor langt skyggen når ut.
  AOBatch.prototype.rect = function (cx, y, cz, w, d, rot, s, spread, core) {
    const cs = Math.cos(rot), sn = Math.sin(rot), hw = w / 2, hd = d / 2, o = spread;
    const v = (lx, lz, t) => this.v(cx + lx * cs + lz * sn, y, cz - lx * sn + lz * cs, s, t);
    const tri = (a, b, c) => { v(a[0], a[1], a[2]); v(b[0], b[1], b[2]); v(c[0], c[1], c[2]); };
    const I = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    for (let k = 0; k < 4; k++) {
      const a = I[k], b = I[(k + 1) % 4];
      // utoverretning for siden a→b
      const nx = k === 1 ? 1 : k === 3 ? -1 : 0, nz = k === 0 ? -1 : k === 2 ? 1 : 0;
      const A = [a[0], a[1], 1], B = [b[0], b[1], 1], Ao = [a[0] + nx * o, a[1] + nz * o, 0], Bo = [b[0] + nx * o, b[1] + nz * o, 0];
      tri(A, B, Bo); tri(A, Bo, Ao);
      // avrundet hjørne ved b (mellom denne siden og den neste)
      const n2x = k === 0 ? 1 : k === 2 ? -1 : 0, n2z = k === 1 ? 1 : k === 3 ? -1 : 0;
      tri(B, [b[0] + n2x * o, b[1] + n2z * o, 0], Bo);
    }
    if (core) { tri([-hw, -hd, 1], [hw, -hd, 1], [hw, hd, 1]); tri([-hw, -hd, 1], [hw, hd, 1], [-hw, hd, 1]); }
  };
  // Rund, myk flekk (trær, folk, lykter …).
  AOBatch.prototype.disc = function (cx, y, cz, r, s, seg) {
    seg = seg || 8;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      this.v(cx, y, cz, s, 1); this.v(cx + r * Math.cos(a1), y, cz + r * Math.sin(a1), s, 0); this.v(cx + r * Math.cos(a0), y, cz + r * Math.sin(a0), s, 0);
    }
  };
  AOBatch.prototype.geometry = function (THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 4));
    g.computeBoundingSphere();
    return g;
  };
  function aoMaterial(THREE) {
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', [
        '#include <color_fragment>',
        '#ifdef USE_COLOR_ALPHA',
        '  float aoT = clamp( vColor.a, 0.0, 1.0 );',
        '  diffuseColor = vec4( 0.07, 0.08, 0.13, vColor.r * aoT * aoT * ( 3.0 - 2.0 * aoT ) );',
        '#endif',
      ].join('\n'));
    };
    return m;
  }
  // Bakt kontakt-AO på loddrette flater: mørkere nær bakkenivå (verdens-y), så bygg og kanter «står» på bakken.
  function groundAO(m, strength) {
    const prev = m.onBeforeCompile, key = m.customProgramCacheKey();
    m.onBeforeCompile = function (sh, r) {
      if (prev) prev.call(this, sh, r);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGao;')
        .replace('#include <project_vertex>', [
          '#include <project_vertex>',
          'vec4 gaoW = vec4( transformed, 1.0 ); vec3 gaoN = objectNormal;',
          '#ifdef USE_INSTANCING',
          '  gaoW = instanceMatrix * gaoW; gaoN = mat3( instanceMatrix ) * gaoN;',
          '#endif',
          'gaoW = modelMatrix * gaoW; gaoN = normalize( mat3( modelMatrix ) * gaoN );',
          'vGao = vec3( gaoW.y, gaoN.y, gaoW.z );',
        ].join('\n'));
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGao;')
        .replace('#include <emissivemap_fragment>', [
          'float gaoH = vGao.x - ( ' + GY.toFixed(3) + ' );',
          'float gaoK = ( 1.0 - smoothstep( 0.0, 0.42, gaoH ) ) * step( -0.03, gaoH ) * ( 1.0 - smoothstep( 0.5, 0.8, abs( vGao.y ) ) ) * step( -40.0, vGao.z );',
          'diffuseColor.rgb *= 1.0 - ' + strength.toFixed(3) + ' * gaoK;',
          '#include <emissivemap_fragment>',
        ].join('\n'))
        // Solskyggen demper også himmellyset litt (ellers blir skyggene nesten borte i det sterke miljølyset).
        .replace('#include <lights_fragment_end>', [
          '#include <lights_fragment_end>',
          '#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0',
          '  if ( receiveShadow ) {',
          '    DirectionalLightShadow gaoS = directionalLightShadows[ 0 ];',
          '    float gaoSh = getShadow( directionalShadowMap[ 0 ], gaoS.shadowMapSize, gaoS.shadowBias, gaoS.shadowRadius, vDirectionalShadowCoord[ 0 ] );',
          '    reflectedLight.indirectDiffuse *= mix( ' + SHADE_AMB.toFixed(2) + ', 1.0, gaoSh );',
          '  }',
          '#endif',
        ].join('\n'));
    };
    m.customProgramCacheKey = () => key + '|gao' + strength;
    return m;
  }
  const SHADE_AMB = 0.55;   // andel himmellys som er igjen i solskygge
  // Myk, rund røykdott (lyse klumper på en radial gradient) til billboard-røyken.
  function puffTexture(THREE) {
    const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d'), r = makeRng(31);
    const blob = (x, y, rad, a) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(255,255,255,' + a + ')'); gr.addColorStop(0.45, 'rgba(255,255,255,' + a * 0.72 + ')');
      gr.addColorStop(0.75, 'rgba(255,255,255,' + a * 0.25 + ')'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    };
    blob(64, 64, 60, 0.75);
    for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2 + r() * 0.5, d = 16 + r() * 10; blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 26 + r() * 10, 0.45); }
    blob(60, 58, 30, 0.5);
    const t = new THREE.CanvasTexture(c); t.premultiplyAlpha = false;
    return t;
  }
  // Billboard-materiale for instansierte røykdotter: vender alltid mot kameraet, roterer (aRot) og tones ut (aAlpha).
  function puffMaterial(THREE, tex) {
    const m = new THREE.ShaderMaterial({
      fog: true, transparent: true, depthWrite: false,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]),
      vertexShader: [
        'attribute float aAlpha; attribute float aRot;',
        'varying vec2 vUv; varying float vA; varying vec3 vCol; varying float vShade;',
        '#include <fog_pars_vertex>',
        'void main() {',
        '  vec3 ic = vec3( 1.0 );',
        '  #ifdef USE_INSTANCING_COLOR',
        '  ic = instanceColor;',
        '  #endif',
        '  vCol = ic; vA = aAlpha; vUv = position.xy + 0.5; vShade = position.y + 0.5;',
        '  float s = 1.0; vec3 ctr = vec3( 0.0 );',
        '  #ifdef USE_INSTANCING',
        '  s = length( instanceMatrix[0].xyz ); ctr = instanceMatrix[3].xyz;',
        '  #endif',
        '  vec4 mvPosition = modelViewMatrix * vec4( ctr, 1.0 );',
        '  float c = cos( aRot ), sn = sin( aRot );',
        '  mvPosition.xy += vec2( position.x * c - position.y * sn, position.x * sn + position.y * c ) * s;',
        '  gl_Position = projectionMatrix * mvPosition;',
        '  #include <fog_vertex>',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map;',
        'varying vec2 vUv; varying float vA; varying vec3 vCol; varying float vShade;',
        '#include <common>',
        '#include <fog_pars_fragment>',
        'void main() {',
        '  float a = texture2D( map, vUv ).a * vA;',
        '  if ( a < 0.004 ) discard;',
        '  gl_FragColor = vec4( vCol * ( 0.8 + 0.32 * vShade ), a );',
        '  #include <tonemapping_fragment>',
        '  #include <colorspace_fragment>',
        '  #include <fog_fragment>',
        '}',
      ].join('\n'),
    });
    m.uniforms.map.value = tex;
    return m;
  }

  // Boks (bunnflate utelates). opt.fac = fasade-UV (vinduer), opt.noTop, opt.bottom.
  // opt.sty = vindusvariant 0–3 (kodes som v-forskyvning på 100 per variant), opt.fh/opt.tw = etasjehøyde/vindusbredde.
  function pushBox(b, cx, y0, cz, w, h, d, rot, col, opt) {
    const hw = w / 2, hd = d / 2, y1 = y0 + h, cs = Math.cos(rot || 0), sn = Math.sin(rot || 0);
    const P = (lx, y, lz) => [cx + lx * cs + lz * sn, y, cz - lx * sn + lz * cs];
    const fac = opt && opt.fac, nv = h / ((opt && opt.fh) || FH), vo = 100 * ((opt && opt.sty) || 0), tw = (opt && opt.tw) || TW;
    const side = (a, bb, c, dd, fw) => {
      if (fac) { const nu = Math.max(1, Math.round(fw / tw)); b.quad(a, bb, c, dd, col, [0, vo], [nu, vo], [nu, nv + vo], [0, nv + vo]); }
      else b.quad(a, bb, c, dd, col);
    };
    side(P(-hw, y0, hd), P(hw, y0, hd), P(hw, y1, hd), P(-hw, y1, hd), w);
    side(P(hw, y0, -hd), P(-hw, y0, -hd), P(-hw, y1, -hd), P(hw, y1, -hd), w);
    side(P(hw, y0, hd), P(hw, y0, -hd), P(hw, y1, -hd), P(hw, y1, hd), d);
    side(P(-hw, y0, -hd), P(-hw, y0, hd), P(-hw, y1, hd), P(-hw, y1, -hd), d);
    if (!(opt && opt.noTop)) b.quad(P(-hw, y1, -hd), P(-hw, y1, hd), P(hw, y1, hd), P(hw, y1, -hd), col);
    if (opt && opt.bottom) b.quad(P(hw, y0, -hd), P(hw, y0, hd), P(-hw, y0, hd), P(-hw, y0, -hd), col);
  }
  const pushBoxRaw = pushBox;   // build() legger kontaktskygger rundt bokser via sin egen pushBox
  // Valmtak / mansardtak / pyramide.
  function pushFrustum(b, cx, y0, cz, w, d, h, inset, col, rot) {
    const hw = w / 2, hd = d / 2, tw = Math.max(0, hw - inset), td = Math.max(0, hd - inset), y1 = y0 + h;
    const cs = Math.cos(rot || 0), sn = Math.sin(rot || 0);
    const P = (lx, y, lz) => [cx + lx * cs + lz * sn, y, cz - lx * sn + lz * cs];
    const A = P(-hw, y0, hd), B = P(hw, y0, hd), Cc = P(hw, y0, -hd), D = P(-hw, y0, -hd);
    const a = P(-tw, y1, td), bb = P(tw, y1, td), c = P(tw, y1, -td), d2 = P(-tw, y1, -td);
    b.quad(A, B, bb, a, col); b.quad(B, Cc, c, bb, col); b.quad(Cc, D, d2, c, col); b.quad(D, A, a, d2, col);
    if (tw > 1e-4 && td > 1e-4) b.quad(d2, a, bb, c, col);
  }
  // Saltak med møne langs lengste side.
  function pushGable(b, cx, y0, cz, w, d, h, rc, wc, over) {
    over = over == null ? 0.06 : over;
    const alongX = w >= d, L = (alongX ? w : d) / 2, S = (alongX ? d : w) / 2, rot = alongX ? 0 : Math.PI / 2;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const P = (lx, y, lz) => [cx + lx * cs + lz * sn, y, cz - lx * sn + lz * cs];
    const Lo = L + over, So = S + over, y1 = y0 + h, yE = y0 - (over * h) / S;
    b.quad(P(-Lo, yE, So), P(Lo, yE, So), P(Lo, y1, 0), P(-Lo, y1, 0), rc);
    b.quad(P(Lo, yE, -So), P(-Lo, yE, -So), P(-Lo, y1, 0), P(Lo, y1, 0), rc);
    b.tri(P(L, y0, S), P(L, y0, -S), P(L, y1, 0), wc);
    b.tri(P(-L, y0, -S), P(-L, y0, S), P(-L, y1, 0), wc);
  }
  function flatRect(b, x0, z0, x1, z1, y, col) { b.quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], col); }
  function disc(b, cx, y, cz, r, seg, col) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      b.tri([cx, y, cz], [cx + r * Math.cos(a1), y, cz + r * Math.sin(a1)], [cx + r * Math.cos(a0), y, cz + r * Math.sin(a0)], col);
    }
  }
  // Bånd langs ringen (senterlinje a, bredde w). dash/gap gir stiplet linje.
  const _p0 = { x: 0, z: 0, dx: 0, dz: 1 }, _p1 = { x: 0, z: 0, dx: 0, dz: 1 };
  function ribbon(b, a, w, y, col, dash, gap) {
    const L0 = ringLen(a), step = 0.25, hw = w / 2;
    for (let s = 0; s < L0 - 1e-6; s += step) {
      if (dash && s % (dash + gap) > dash) continue;
      ringPoint(a, s, _p0); ringPoint(a, Math.min(L0, s + step), _p1);
      const i0 = [_p0.x - _p0.dz * hw, y, _p0.z + _p0.dx * hw], o0 = [_p0.x + _p0.dz * hw, y, _p0.z - _p0.dx * hw];
      const i1 = [_p1.x - _p1.dz * hw, y, _p1.z + _p1.dx * hw], o1 = [_p1.x + _p1.dz * hw, y, _p1.z - _p1.dx * hw];
      b.quad(i0, i1, o1, o0, col);
    }
  }
  // Rektangel i "side k"-koordinater (lokal x = utover, lokal z = langs siden), rotert k*90°.
  function rotK(x, z, k) { for (let i = 0; i < k; i++) { const q = x; x = -z; z = q; } return [x, z]; }
  function rectK(lx0, lz0, lx1, lz1, k) {
    const a = rotK(lx0, lz0, k), b = rotK(lx1, lz1, k);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }
  function capH(x0, z0, x1, z1) {
    const nx = Math.max(x0, Math.min(0, x1)), nz = Math.max(z0, Math.min(0, z1)), r = Math.hypot(nx, nz);
    return r < 34 ? Math.max(1.0, 0.3 * (r - 7)) : 99;
  }

  // ---------- Teksturer ----------
  // Fasadeatlas med fire vindusvarianter side om side (64 px hver):
  // 0 klassisk sprossevindu, 1 fransk balkong, 2 moderne glassbånd, 3 småruter med omramming og gesims.
  function facadeTexture(THREE, renderer) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 64);
    const F = (x, y, w, h) => { g.fillStyle = 'rgb(0,255,0)'; g.fillRect(x, y, w, h); };
    const glass = (x, y0, w, y1) => {
      for (let y = y0; y < y1; y++) { const t = 1 - (y - y0) / (y1 - y0); g.fillStyle = 'rgb(255,0,' + Math.round(30 + 225 * t * t) + ')'; g.fillRect(x, y, w, 1); }
    };
    F(14, 8, 36, 47); F(11, 54, 42, 5); glass(17, 11, 30, 52); F(31, 11, 2, 41); F(17, 24, 30, 2);
    let o = 64;
    F(o + 16, 5, 32, 50); glass(o + 19, 8, 26, 55); F(o + 31, 8, 2, 47); F(o + 19, 20, 26, 2);
    F(o + 9, 36, 46, 3); F(o + 9, 54, 46, 4); for (let x = o + 11; x < o + 55; x += 5) F(x, 39, 2, 15);
    o = 128;
    F(o, 5, 64, 4); glass(o, 9, 64, 49); for (let x = o + 15; x < o + 64; x += 16) F(x, 9, 2, 40); F(o, 49, 64, 4);
    o = 192;
    F(o, 0, 64, 4); F(o + 17, 11, 30, 42); glass(o + 20, 14, 24, 50); F(o + 31, 14, 2, 36); F(o + 20, 28, 24, 2); F(o + 13, 50, 38, 4);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (renderer) t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  }
  function tileTexture(THREE, renderer) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    // Varme, solfargede fliser (sand/aprikos/terrakotta) med spredte fargeaksenter.
    const g = c.getContext('2d'), r = makeRng(7);
    const BASEC = ['#f6c88f', '#f3bb80', '#f8d5a4', '#f0b077', '#f5c287'];
    const ACC = ['#e8634a', '#2fb5a6', '#f2c14e', '#4f9de0', '#e8634a'];
    g.fillStyle = '#c98a5a'; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
      const X = x * 64 + (y % 2) * 32, acc = r() < 0.06;
      g.fillStyle = acc ? ACC[Math.floor(r() * ACC.length)] : BASEC[Math.floor(r() * BASEC.length)];
      g.fillRect(X + 2, y * 32 + 2, 60, 28); g.fillRect(X - 256 + 2, y * 32 + 2, 60, 28);
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(X + 2, y * 32 + 2, 60, 4); g.fillRect(X - 256 + 2, y * 32 + 2, 60, 4);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    if (renderer) t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  }
  function flagTexture(THREE) {
    const c = document.createElement('canvas'); c.width = 132; c.height = 96;
    const g = c.getContext('2d'), u = 6;
    g.fillStyle = '#BA0C2F'; g.fillRect(0, 0, 132, 96);
    g.fillStyle = '#ffffff'; g.fillRect(6 * u, 0, 4 * u, 96); g.fillRect(0, 6 * u, 132, 4 * u);
    g.fillStyle = '#00205B'; g.fillRect(7 * u, 0, 2 * u, 96); g.fillRect(0, 7 * u, 132, 2 * u);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- Materialer ----------
  // Vinduer: tekstur-kanalene er masker (r = glass, g = karm, b = refleksgradient).
  function facadeMaterial(THREE, tex) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, map: tex });
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_fragment>', '')
        .replace('#include <color_fragment>', [
          'diffuseColor.rgb *= vColor;',
          'vec2 fu = vMapUv; float sty = floor( fu.y / 100.0 ); fu.y -= sty * 100.0;',
          'vec2 tuv = vec2( ( sty + 0.006 + 0.988 * fract( fu.x ) ) * 0.25, fract( fu.y ) );',
          'vec4 fw = textureGrad( map, tuv, dFdx( fu ) * vec2( 0.25, 1.0 ), dFdy( fu ) * vec2( 0.25, 1.0 ) );',
          'diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.92, 0.9, 0.85 ), fw.g );',
          'vec3 glass = mix( vec3( 0.06, 0.12, 0.22 ), vec3( 0.42, 0.62, 0.85 ), fw.b );',
          'diffuseColor.rgb = mix( diffuseColor.rgb, glass, fw.r );',
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( roughness, 0.25, fw.r );');
    };
    return m;
  }
  // Instansfarge brukes bare der vertex-fargen er helt hvit (karosseri, trekrone, skjorte …).
  function markerMaterial(THREE, extra) {
    const m = new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.55, metalness: 0 }, extra || {}));
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', [
        'vColor = vec3( 1.0 );',
        '#ifdef USE_COLOR',
        '  vColor = color.rgb;',
        '#endif',
        '#ifdef USE_INSTANCING_COLOR',
        '  if ( color.r > 0.995 && color.g > 0.995 && color.b > 0.995 ) vColor = instanceColor.rgb;',
        '#endif',
      ].join('\n'));
    };
    return m;
  }
  // Tilskuere: som markerMaterial, men armene (aArm = ±1) løftes og vinker etter instansverdien aCheer (0–1).
  function crowdMaterial(THREE, uTime) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aArm;\nattribute float aCheer;')
        .replace('#include <color_vertex>', [
          'vColor = vec3( 1.0 );',
          '#ifdef USE_COLOR',
          '  vColor = color.rgb;',
          '#endif',
          '#ifdef USE_INSTANCING_COLOR',
          '  if ( color.r > 0.995 && color.g > 0.995 && color.b > 0.995 ) vColor = instanceColor.rgb;',
          '#endif',
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          'vec3 transformed = vec3( position );',
          'if ( aArm != 0.0 && aCheer > 0.0 ) {',
          '  float cph = 0.0;',
          '  #ifdef USE_INSTANCING',
          '  cph = float( gl_InstanceID ) * 1.7;',
          '  #endif',
          '  float cang = aCheer * ( 2.45 + 0.45 * sin( uTime * 13.0 + cph + aArm * 1.3 ) );',
          '  vec2 cpv = transformed.xy - vec2( aArm * 0.047, 0.175 );',
          '  float ca = cos( aArm * cang ), sa = sin( aArm * cang );',
          '  transformed.xy = vec2( cpv.x * ca - cpv.y * sa, cpv.x * sa + cpv.y * ca ) + vec2( aArm * 0.047, 0.175 );',
          '}',
        ].join('\n'));
    };
    return m;
  }
  function flagMaterial(THREE, tex, uTime) {
    const m = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.75 });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <beginnormal_vertex>', [
          'float fph = 0.0;',
          '#ifdef USE_INSTANCING',
          '  fph = float( gl_InstanceID ) * 1.37;',
          '#endif',
          'float fk = position.x;',
          'float fwv = uTime * 6.5 - position.x * 6.0 + fph;',
          'float fdz = 0.1 * fk * sin( fwv );',
          'float fsl = 0.1 * ( sin( fwv ) - fk * 6.0 * cos( fwv ) );',
          'vec3 objectNormal = normalize( vec3( -fsl, 0.0, 1.0 ) );',
        ].join('\n'))
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3( position );\ntransformed.z += fdz;\ntransformed.y -= 0.04 * fk * fk;');
    };
    return m;
  }

  function waterMaterial(THREE, uTime) {
    const m = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uDeep: { value: new THREE.Color('#1673c4') }, uShallow: { value: new THREE.Color('#2fb3e3') },
        uSky: { value: new THREE.Color('#bfe2fb') }, uFoam: { value: new THREE.Color('#f2fcff') },
        uSunDir: { value: new THREE.Vector3(-7, 16, 9).normalize() },
      }]),
      vertexShader: [
        'varying vec3 vW;',
        '#include <fog_pars_vertex>',
        'void main() {',
        '  vec4 wp = modelMatrix * vec4( position, 1.0 ); vW = wp.xyz;',
        '  vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;',
        '  #include <fog_vertex>',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform float uTime; uniform vec3 uDeep, uShallow, uSky, uFoam, uSunDir;',
        'varying vec3 vW;',
        '#include <common>',
        '#include <fog_pars_fragment>',
        'float hsh( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }',
        'void main() {',
        '  vec2 p = vW.xz; float t = uTime;',
        '  float a1 = p.x * 0.55 + p.y * 0.35 + t * 1.3, a2 = -p.x * 0.3 + p.y * 0.8 + t * 1.1, a3 = p.x * 1.4 - p.y * 1.1 + t * 2.0;',
        '  float gx = 0.055 * cos( a1 ) - 0.024 * cos( a2 ) + 0.056 * cos( a3 );',
        '  float gz = 0.035 * cos( a1 ) + 0.064 * cos( a2 ) - 0.044 * cos( a3 );',
        '  vec3 n = normalize( vec3( -gx, 1.0, -gz ) );',
        '  vec3 toCam = cameraPosition - vW; float dist = length( toCam ); vec3 V = toCam / dist;',
        '  float fres = pow( 1.0 - clamp( dot( n, V ), 0.0, 1.0 ), 4.0 );',
        '  float m = 0.5 + 0.5 * sin( p.x * 0.07 + p.y * 0.05 + sin( p.y * 0.11 ) * 2.0 );',
        '  vec3 col = mix( uDeep, uShallow, 0.3 + 0.35 * m );',
        '  col = mix( col, uSky, fres * 0.75 );',
        '  float w = sin( p.x * 0.9 + sin( p.y * 0.6 + t * 0.7 ) * 1.6 + t * 0.9 ) * sin( p.y * 1.3 - t * 0.5 + sin( p.x * 0.4 ) * 1.2 );',
        '  col = mix( col, uFoam, smoothstep( 0.86, 0.97, w ) * 0.2 );',
        '  vec3 Rv = reflect( -V, n ); float sp = pow( max( dot( Rv, uSunDir ), 0.0 ), 180.0 );',
        '  vec2 q = p * 2.2; vec2 cell = floor( q ); float h = hsh( cell ); vec2 f = fract( q ) - 0.5;',
        '  float tw = pow( max( 0.0, sin( t * ( 2.0 + h * 3.0 ) + h * 40.0 ) ), 12.0 );',
        '  float spark = step( 0.82, h ) * tw * smoothstep( 0.2, 0.0, length( f ) ) * ( 1.0 - smoothstep( 25.0, 60.0, dist ) );',
        '  col += uFoam * ( sp * 1.4 + spark * 0.9 );',
        '  gl_FragColor = vec4( col, 1.0 );',
        '  #include <tonemapping_fragment>',
        '  #include <colorspace_fragment>',
        '  #include <fog_fragment>',
        '}',
      ].join('\n'),
    });
    m.uniforms.uTime = uTime;
    return m;
  }
  function skyMaterial(THREE, top, mid, hor) {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(top) }, uMid: { value: new THREE.Color(mid) }, uHor: { value: new THREE.Color(hor) },
        uSun: { value: new THREE.Color('#fff4d6') }, uSunDir: { value: new THREE.Vector3(-7, 16, 9).normalize() },
      },
      vertexShader: 'varying vec3 vDir;\nvoid main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
      fragmentShader: [
        'uniform vec3 uTop, uMid, uHor, uSun, uSunDir; varying vec3 vDir;',
        'void main() {',
        '  vec3 d = normalize( vDir ); float h = d.y;',
        '  vec3 col = mix( uHor, uMid, smoothstep( 0.0, 0.2, h ) );',
        '  col = mix( col, uTop, smoothstep( 0.2, 0.8, h ) );',
        '  float sd = max( dot( d, uSunDir ), 0.0 );',
        '  col += uSun * ( pow( sd, 700.0 ) * 1.6 + pow( sd, 16.0 ) * 0.16 );',
        '  gl_FragColor = vec4( col, 1.0 );',
        '  #include <tonemapping_fragment>',
        '  #include <colorspace_fragment>',
        '}',
      ].join('\n'),
    });
  }
  // Fontenedråper beregnes helt i vertex-shaderen (ingen CPU-arbeid per frame).
  function sprayMaterial(THREE, uTime, uHalfH) {
    const m = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color('#e8f8ff') } }]),
      vertexShader: [
        'attribute vec4 aSeed; attribute float aScale;',
        'uniform float uTime, uHalfH;',
        'varying float vA;',
        '#include <fog_pars_vertex>',
        'void main() {',
        '  float life = 1.25; float t = fract( uTime / life + aSeed.x ) * life;',
        '  float jet = step( 0.7, aSeed.w );',
        '  float vr = mix( 0.22 + aSeed.z * 0.3, 0.04, jet ), vy = mix( 2.3 + aSeed.z * 0.4, 3.0, jet );',
        '  vec3 pos = position + aScale * vec3( cos( aSeed.y ) * vr * t, vy * t - 2.25 * t * t, sin( aSeed.y ) * vr * t );',
        '  vA = step( position.y - 0.3 * aScale, pos.y );',
        '  vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );',
        '  gl_Position = projectionMatrix * mvPosition;',
        '  gl_PointSize = vA * 0.055 * aScale * projectionMatrix[1][1] * uHalfH / -mvPosition.z;',
        '  #include <fog_vertex>',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; varying float vA;',
        '#include <common>',
        '#include <fog_pars_fragment>',
        'void main() {',
        '  vec2 c = gl_PointCoord - 0.5; float r = length( c );',
        '  if ( r > 0.5 || vA < 0.5 ) discard;',
        '  gl_FragColor = vec4( uColor * ( 1.05 - r * 0.6 ), 1.0 );',
        '  #include <tonemapping_fragment>',
        '  #include <colorspace_fragment>',
        '  #include <fog_fragment>',
        '}',
      ].join('\n'),
    });
    m.uniforms.uTime = uTime; m.uniforms.uHalfH = uHalfH;
    return m;
  }

  // Fargepaletter (sterke, glade, men ikke babyaktige)
  const BYG = ['#ffb627', '#ff7a45', '#ff8fa3', '#3cc88e', '#4fb0f0', '#ffd166', '#e0503a', '#f29e3d', '#8dd35f', '#a979e8', '#ff6f61', '#ffe066', '#ef476f', '#2ec4b6', '#ffa987',
    '#e8a33d', '#c8553d', '#7fd1b9', '#f4a6b7', '#5aa9e6'];
  const SHOPC = ['#2f3e46', '#7a2e3a', '#22577a', '#3d405b', '#6b4226', '#1f6f50', '#8c2f39'];
  const ROOF = ['#c4452f', '#2f8f7a', '#3b5ba8', '#8a3b64', '#d9682b', '#2e6b4f', '#b83a3a'];
  const TRE = ['#d7263d', '#ffc93c', '#ffe08a', '#3a86ff', '#3cb371', '#ff8c42', '#e5598a', '#b5342a'];
  const TROOF = ['#2f3542', '#9b2d20', '#1f5f45', '#5a3a2a', '#2b4c7e'];
  const TALL = ['#5ec8f2', '#3a9be0', '#ffc97a', '#57d3b8', '#ff9b91', '#b79cf2', '#ffd166', '#7fb8f0'];
  const TOPC = ['#ff6b6b', '#ffd23f', '#3cc88e', '#4fb0f0', '#ff9f43', '#a979e8'];
  const AWN = ['#e63946', '#2a9d8f', '#f4a261', '#457b9d', '#e9c46a', '#8ac926', '#ff6b9a'];
  const LEAF = ['#3fae49', '#5cc24a', '#2f9a4f', '#7ccf4f', '#49b86a', '#8fd14f', '#36a35a'];
  const PINE = ['#2f7d46', '#276b3d', '#3a8a4c', '#22603a', '#2c7550'];
  const CARS = ['#e63946', '#1d6fd8', '#f4c430', '#f5f5f5', '#2a9d8f', '#ff7f2a', '#7b2cbf', '#1b1f2a', '#9fd8ee', '#c0c6cf', '#2fbf71'];
  const SHIRT = ['#e63946', '#1d6fd8', '#f4c430', '#2a9d8f', '#ff7f2a', '#7b2cbf', '#f15bb5', '#00bbf9', '#fafafa', '#9b5de5', '#43aa8b'];
  const RAINBOW = ['#e63946', '#ff8c1a', '#ffd23f', '#3bb273', '#1d8fe1', '#7b4fd8', '#f15bb5'];

  function build(THREE, scene, opts) {
    opts = opts || {};
    const renderer = opts.renderer || null;
    const low = opts.quality === 'low';
    const Q = low ? 0.5 : 1;
    const rnd = makeRng(20261022);
    const BGU = window.BufferGeometryUtils;
    const root = new THREE.Group(); root.name = 'OsloCity'; scene.add(root);
    const cc = {};
    const C = (h) => cc[h] || (cc[h] = new THREE.Color(h));
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const keep = () => !low || rnd() < 0.5;   // lav kvalitet: halv tetthet
    const uTime = { value: 0 }, uHalfH = { value: 400 };
    const _dv2 = new THREE.Vector2();

    // Himmel, tåke
    const HOR = '#cfe8fb';
    scene.background = new THREE.Color(HOR);
    scene.fog = new THREE.Fog(HOR, 45, 150);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), skyMaterial(THREE, '#2b7fe0', '#6cb2f0', HOR));
    sky.frustumCulled = false; sky.renderOrder = -1000; sky.matrixAutoUpdate = false;
    sky.onBeforeRender = function (r, s, cam) { this.position.copy(cam.position); this.updateMatrix(); this.updateMatrixWorld(true); };
    root.add(sky);

    // Materialer
    const facTex = facadeTexture(THREE, renderer);
    const MAT = {
      plain: groundAO(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }), 0.36),
      fac: groundAO(facadeMaterial(THREE, facTex), 0.42),
      ao: aoMaterial(THREE),
      marker: markerMaterial(THREE),
      markerDS: markerMaterial(THREE, { side: THREE.DoubleSide }),
      water: waterMaterial(THREE, uTime),
      terrain: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true }),
      tile: groundAO(new THREE.MeshStandardMaterial({ map: tileTexture(THREE, renderer), roughness: 0.9, metalness: 0 }), 0),
      cloud: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.32, roughness: 1, metalness: 0 }),
      flag: flagMaterial(THREE, flagTexture(THREE), uTime),
    };

    // Bunter for sammenslått statisk geometri
    // city og fac deles i en nær del (kaster skygge) og en fjern del (Chebyshev-radius NEAR_R fra brettets midte).
    const NEAR_R = 17, AO_FAR = 42;
    const city = new SplitBatch(false, NEAR_R), plaza = new Batch(false), fac = new SplitBatch(true, NEAR_R), water = new Batch(false);
    const aoB = new AOBatch();   // statiske kontaktskygger for hele byen
    const FAC = { fac: true, noTop: true };
    // Hvilken AO-bunt hører en geometribunt til? { ao, ground (null = aoBase), floor = laveste høyde flekken legges på }
    // (bygg i byen står ofte på grønne plater med topp GY + 0.05, så flekkene legges over dem)
    const aoOf = new Map([[city, { ao: aoB, ground: null, floor: GY + 0.05 }], [fac, { ao: aoB, ground: null, floor: GY + 0.05 }], [plaza, { ao: aoB, ground: null, floor: GY + 0.004 }]]);
    const aoY = (s, y, g) => Math.max(y, g, s.floor) + 0.008;
    let aoBase = GY;   // bakkenivå der bygg står på en hevet grønn plate
    // Skyggen faller mot +x/−z (sola står i (−7, 16, 9)); flekker under trær og folk forskyves litt dit.
    const SHX = 0.614, SHZ = -0.789;
    function pushBox(b, cx, y0, cz, w, h, d, rot, col, opt) {
      pushBoxRaw(b, cx, y0, cz, w, h, d, rot, col, opt);
      const s = aoOf.get(b);
      if (!s || h < 0.2 || w * d < 0.03 || Math.max(Math.abs(cx), Math.abs(cz)) > AO_FAR) return;
      const g = s.ground != null ? s.ground : aoBase;
      if (y0 < g - 0.06 || y0 > g + 0.07) return;
      s.ao.rect(cx, aoY(s, y0, g), cz, w, d, rot || 0, 0.5, Math.min(0.42, 0.1 + h * 0.1));
    }
    // Maler som skal ha en myk flekk under seg når de stemples: { r } (rund) eller { w, d } (avlang).
    const blobOf = new Map();
    function blobAt(b, geo, x, y, z, ry, sc) {
      const bs = blobOf.get(geo), s = bs && aoOf.get(b);
      if (!s || Math.max(Math.abs(x), Math.abs(z)) > AO_FAR) return;
      const g = s.ground != null ? s.ground : aoBase;
      if (y < g - 0.06 || y > g + 0.2) return;
      if (bs.r) s.ao.disc(x + SHX * bs.r * 0.2 * sc, aoY(s, y, g), z + SHZ * bs.r * 0.2 * sc, bs.r * sc, bs.s || 0.5);
      else s.ao.rect(x, aoY(s, y, g), z, bs.w * sc, bs.d * sc, ry || 0, bs.s || 0.5, bs.o || 0.08, true);
    }
    const treesCity = [], treesPlaza = [], conifers = [], flags = [], fountains = [];
    const SPEC = [];   // stående tilskuere { x, y, z, ry, s }

    // ---------- Maler (ikke-indekserte, med vertex-farger) ----------
    function part(geo, hex, fn) {
      if (fn) fn(geo);
      const g = geo.index ? geo.toNonIndexed() : geo;
      if (g.attributes.uv) g.deleteAttribute('uv');
      if (g.attributes.uv1) g.deleteAttribute('uv1');
      const n = g.attributes.position.count, c = C(hex), arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    }
    function striped(geo, n, a, b, fn) {
      const g = part(geo, a, fn), P = g.attributes.position.array, col = g.attributes.color.array, cb = C(b);
      for (let i = 0; i < P.length; i += 9) {
        const x = (P[i] + P[i + 3] + P[i + 6]) / 3, z = (P[i + 2] + P[i + 5] + P[i + 8]) / 3;
        if (Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * n) % 2) for (let k = 0; k < 9; k += 3) { col[i + k] = cb.r; col[i + k + 1] = cb.g; col[i + k + 2] = cb.b; }
      }
      return g;
    }
    function triGeo(tris, hex, double) {
      const b = new Batch(false), c = C(hex);
      for (const t of tris) { b.tri(t[0], t[1], t[2], c); if (double) b.tri(t[0], t[2], t[1], c); }
      return b.geometry(THREE);
    }
    const merge = (parts) => BGU.mergeGeometries(parts, false);
    const BoxG = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const CylG = (rt, rb, h, s) => new THREE.CylinderGeometry(rt, rb, h, s || 8);
    const at = (x, y, z) => (g) => g.translate(x, y, z);

    const _m = new THREE.Matrix4(), _nm = new THREE.Matrix3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
    const _v = new THREE.Vector3(), _s = new THREE.Vector3(), _o = new THREE.Object3D();
    function stamp(b, geo, x, y, z, ry, sx, sy, sz, over) {
      _e.set(0, ry || 0, 0); _q.setFromEuler(_e);
      sx = sx == null ? 1 : sx; sy = sy == null ? sx : sy; sz = sz == null ? sx : sz;
      _m.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz)); _nm.getNormalMatrix(_m);
      b.stamp(geo, _m, _nm, over || null);
      if (blobOf.has(geo)) blobAt(b, geo, x, y, z, ry, sx);
    }
    const unitBox = part(BoxG(1, 1, 1), '#ffffff');
    const unitCyl = part(CylG(1, 1, 1, 12), '#ffffff', at(0, 0.5, 0));
    // Boks fra punkt til punkt (bjelker, ovarenn, bein).
    function beam(b, x0, y0, z0, x1, y1, z1, w, t, col) {
      const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      _o.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); _o.up.set(0, 1, 0);
      _o.lookAt(x1, y1, z1); _o.scale.set(w, t, len); _o.updateMatrix();
      _nm.getNormalMatrix(_o.matrix); b.stamp(unitBox, _o.matrix, _nm, col);
    }

    const lampGeo = merge([
      part(CylG(0.06, 0.07, 0.06, 8), '#2c4a3b', at(0, 0.03, 0)),
      part(CylG(0.022, 0.03, 1.0, 6), '#2c4a3b', at(0, 0.5, 0)),
      part(CylG(0.07, 0.05, 0.16, 6), '#fff1b8', at(0, 1.06, 0)),
      part(new THREE.ConeGeometry(0.1, 0.09, 6), '#2c4a3b', at(0, 1.185, 0)),
    ]);
    const benchGeo = merge([
      part(BoxG(0.42, 0.03, 0.13), '#c07a3c', at(0, 0.11, 0)),
      part(BoxG(0.42, 0.1, 0.025), '#c07a3c', at(0, 0.19, -0.06)),
      part(BoxG(0.03, 0.11, 0.13), '#2c3a36', at(-0.17, 0.055, 0)),
      part(BoxG(0.03, 0.11, 0.13), '#2c3a36', at(0.17, 0.055, 0)),
    ]);
    blobOf.set(lampGeo, { r: 0.11, s: 0.55 }); blobOf.set(benchGeo, { w: 0.42, d: 0.14, s: 0.42 });
    const flowerGeo = part(new THREE.OctahedronGeometry(0.055, 0), '#ffffff');
    const treeGeo = merge([
      part(CylG(0.045, 0.06, 0.42, 6), '#7a5232', at(0, 0.21, 0)),
      part(new THREE.IcosahedronGeometry(0.36, 1), '#ffffff', (g) => { g.scale(1, 1.08, 1); g.translate(0, 0.68, 0); }),
    ]);
    const pineGeo = merge([
      part(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 5, 1, true), '#6b4a2e', at(0, 0.15, 0)),
      part(new THREE.ConeGeometry(0.44, 0.62, 6, 1, true), '#ffffff', at(0, 0.55, 0)),
      part(new THREE.ConeGeometry(0.34, 0.52, 6, 1, true), '#ffffff', at(0, 0.86, 0)),
      part(new THREE.ConeGeometry(0.22, 0.44, 6, 1, true), '#ffffff', at(0, 1.14, 0)),
    ]);
    const ballGeo = part(new THREE.SphereGeometry(0.045, 8, 6), '#f2c14e');
    function flagpole(b, x, z, y0, h, flagScale) {
      stamp(b, unitCyl, x, y0, z, 0, 0.025, h, 0.025, C('#e9edf0'));
      stamp(b, ballGeo, x, y0 + h + 0.02, z);
      flags.push({ x: x + 0.03, y: y0 + h - 0.02, z, s: flagScale });
    }

    // ---------- Land, kai og terreng ----------
    const LAND = [[-64, 64], [64, 64], [64, -30], [33, -30], [33, -33.5], [24, -33.5], [24, -30], [19, -30], [19, -36], [16.5, -39],
      [7.5, -39], [5, -36], [5, -30], [-26, -30], [-26, -37], [-33, -37], [-33, -30], [-64, -30]];
    {
      const g = new THREE.ShapeGeometry(new THREE.Shape(LAND.map((p) => new THREE.Vector2(p[0], -p[1]))));
      g.rotateX(-Math.PI / 2); g.translate(0, GY, 0);
      stamp(city, part(g, '#efcf9f'), 0, 0, 0);
      const stone = C('#9c9a92'), edge = C('#f7e6c4');
      for (let i = 2; i < LAND.length - 1; i++) {
        const a = LAND[i], b = LAND[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        let nx = dz / len, nz = -dx / len;
        if (pip((a[0] + b[0]) / 2 + nx * 0.5, (a[1] + b[1]) / 2 + nz * 0.5, LAND)) { nx = -nx; nz = -nz; }
        city.quadFacing([a[0], GY, a[1]], [b[0], GY, b[1]], [b[0], WY - 0.5, b[1]], [a[0], WY - 0.5, a[1]], stone, nx, 0, nz);
        const ix = -nx * 0.28, iz = -nz * 0.28;
        city.quadFacing([a[0], GY + 0.012, a[1]], [b[0], GY + 0.012, b[1]], [b[0] + ix, GY + 0.012, b[1] + iz], [a[0] + ix, GY + 0.012, a[1] + iz], edge, 0, 1, 0);
      }
    }
    // Vann: stor flate (fjorden) – fontenebassenger legges i samme bunt.
    water.quad([-210, WY, -210], [-210, WY, -20], [210, WY, -20], [210, WY, -210], C('#ffffff'));
    {
      const seg = low ? 70 : 105;
      const tg = new THREE.PlaneGeometry(420, 420, seg, seg); tg.rotateX(-Math.PI / 2);
      const P = tg.attributes.position, col = new Float32Array(P.count * 3);
      const sand = C('#d9c78f'), grass = C('#86c95a'), forest = C('#3f8c45'), rock = C('#8e9a86'), tmp = new THREE.Color();
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), z = P.getZ(i), h = terrainH(x, z); P.setY(i, h);
        if (h < WY + 0.15) tmp.copy(sand);
        else { tmp.copy(grass).lerp(forest, sstep(0.5, 5, h)); if (h > 15) tmp.lerp(rock, sstep(15, 20, h) * 0.6); }
        col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
      }
      tg.setAttribute('color', new THREE.BufferAttribute(col, 3)); tg.computeVertexNormals();
      const tm = new THREE.Mesh(tg, MAT.terrain); tm.name = 'terreng'; root.add(tm);
      // Granskog i åsene
      const want = Math.round(1100 * Q);
      for (let tries = 0; conifers.length < want && tries < want * 12; tries++) {
        const x = (rnd() - 0.5) * 330, z = (rnd() - 0.5) * 330, Rr = Math.max(Math.abs(x), Math.abs(z));
        if (Rr < 66) continue;
        const h = terrainH(x, z); if (h < 0.3) continue;
        if (Math.sin(x * 0.08) + Math.sin(z * 0.07 + 1) + Math.sin((x + z) * 0.05) < -0.7) continue;
        // hold hoppbakken fri
        const px = x + 40, pz = z - 78, along = px * 0.456 - pz * 0.889, across = px * 0.889 + pz * 0.456;
        if (along > -6 && along < 34 && Math.abs(across) < 4) continue;
        conifers.push({ x, y: h - 0.1, z, s: 1.6 + rnd() * 1.3, sy: 1, c: pick(PINE) });
      }
    }

    // ---------- Plassen rundt brettet ----------
    {
      const pts = [];
      for (let s = 0, L0 = ringLen(10); s < L0; s += 0.25) { ringPoint(10, s, _p0); pts.push(new THREE.Vector2(_p0.x, -_p0.z)); }
      const g = new THREE.ShapeGeometry(new THREE.Shape(pts)); g.rotateX(-Math.PI / 2);
      const P = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < P.count; i++) uv.setXY(i, P.getX(i) / 2, P.getZ(i) / 2);
      const pm = new THREE.Mesh(g, MAT.tile); pm.position.y = GY + 0.004; pm.receiveShadow = true; pm.name = 'plassbelegning'; root.add(pm);
    }
    const kerb = C('#e2583e'), grassC = C('#5fd04a'), hedge = C('#2f9a45');
    // Ramme rundt brettet + mønsterbånd (rutete «flisbord») rundt den
    for (let k = 0; k < 4; k++) { const r = rectK(6.65, -6.95, 6.95, 6.95, k); pushBox(plaza, (r[0] + r[2]) / 2, GY, (r[1] + r[3]) / 2, r[2] - r[0], 0.03, r[3] - r[1], 0, C('#ffc93c')); }
    // Kvadratisk flisbånd rundt brettet (senterlinje a, bredde w), vekselvise farger.
    function squareBand(b, a, w, y, cols, tile) {
      const L = a + w / 2, n = Math.max(1, Math.round((2 * L - w) / tile)), t = (2 * L - w) / n;
      for (let k = 0; k < 4; k++) for (let i = 0; i < n; i++) {
        const r = rectK(a - w / 2, -L + i * t, a + w / 2, -L + (i + 1) * t, k);
        flatRect(b, r[0], r[1], r[2], r[3], y, C(cols[i % cols.length]));
      }
    }
    squareBand(plaza, 7.12, 0.24, GY + 0.009, ['#e8574a', '#fff1d6'], 0.24);
    squareBand(plaza, 7.7, 0.08, GY + 0.009, ['#2fb5a6'], 16);
    // Benker i ulike farger
    const benchGeos = ['#e8574a', '#2f8fe0', '#ffb627', '#2fb5a6', '#a979e8'].map((c) => merge([
      part(BoxG(0.42, 0.03, 0.13), c, at(0, 0.11, 0)),
      part(BoxG(0.42, 0.1, 0.025), c, at(0, 0.19, -0.06)),
      part(BoxG(0.03, 0.11, 0.13), '#2c3a36', at(-0.17, 0.055, 0)),
      part(BoxG(0.03, 0.11, 0.13), '#2c3a36', at(0.17, 0.055, 0)),
    ]));
    // Kafé-parasoll med bord og stoler (stripete i to farger)
    const PARA = [['#e63946', '#fff4e0'], ['#1d8fe1', '#fff4e0'], ['#ffb000', '#e63946'], ['#2fb5a6', '#fff4e0'], ['#7b4fd8', '#ffd23f'], ['#ff6b9a', '#fff4e0']];
    const parasolGeos = PARA.map(([a, b]) => merge([
      part(CylG(0.014, 0.014, 0.56, 5), '#f4f4f4', at(0, 0.28, 0)),
      striped(new THREE.ConeGeometry(0.34, 0.13, 10, 1, true), 10, a, b, at(0, 0.6, 0)),
      part(CylG(0.11, 0.11, 0.02, 10), '#ffffff', at(0, 0.2, 0)),
      part(CylG(0.02, 0.03, 0.19, 5), '#3b3f46', at(0, 0.095, 0)),
      part(BoxG(0.08, 0.12, 0.08), a, at(0.19, 0.06, 0)),
      part(BoxG(0.08, 0.12, 0.08), a, at(-0.19, 0.06, 0)),
      part(BoxG(0.08, 0.12, 0.08), a, at(0, 0.06, 0.19)),
    ]));
    benchGeos.forEach((g) => blobOf.set(g, { w: 0.42, d: 0.14, s: 0.42 }));
    parasolGeos.forEach((g) => blobOf.set(g, { r: 0.38, s: 0.42 }));
    // Brettet står på plassen: myk kontaktskygge rundt brettets fot.
    aoB.rect(0, GY + 0.034, 0, 13.3, 13.3, 0, 0.55, 0.42);
    let paraI = 0;
    for (let k = 0; k < 4; k++) {
      // Lokal x = utover fra brettet. Tomtene ligger på 6.95–8.2, gangveien på 8.2–8.72,
      // blomsterbedene på 8.76–9.56 og lyktene på 9.78.
      const inward = rotK(-1, 0, k), faceIn = Math.atan2(inward[0], inward[1]);
      for (const sg of [-1, 1]) {
        // blomsterbed med hekk
        const r = rectK(8.76, sg > 0 ? 0.9 : -6.1, 9.56, sg > 0 ? 6.1 : -0.9, k);
        const cx = (r[0] + r[2]) / 2, cz = (r[1] + r[3]) / 2, w = r[2] - r[0], d = r[3] - r[1];
        pushBox(plaza, cx, GY, cz, w, 0.12, d, 0, kerb);
        pushBox(plaza, cx, GY, cz, w - 0.12, 0.15, d - 0.12, 0, grassC);
        const hr = rectK(9.34, sg > 0 ? 1.0 : -6.0, 9.5, sg > 0 ? 6.0 : -1.0, k);
        pushBox(plaza, (hr[0] + hr[2]) / 2, GY + 0.15, (hr[1] + hr[3]) / 2, hr[2] - hr[0], 0.18, hr[3] - hr[1], 0, hedge);
        // blomster i grupper (to rader foran trærne)
        for (let row = 0; row < 2; row++) for (let i = 0; i < 38; i++) {
          if (low && i % 2) continue;
          const lz = sg * (1.05 + i * 0.13), lx = 8.88 + row * 0.13 + ((i % 2) * 0.04);
          const p = rotK(lx, lz, k), fc = C(RAINBOW[(Math.floor(i / 6) + row + k * 2 + (sg > 0 ? 3 : 0)) % RAINBOW.length]);
          stamp(plaza, flowerGeo, p[0], GY + 0.2, p[1], i, 1.15, 1.3, 1.15, fc);
        }
        // små trær i bedet
        for (const lz of [2.3, 4.7]) { const p = rotK(9.2, sg * lz, k); treesPlaza.push({ x: p[0], y: GY + 0.15, z: p[1], s: 1.0 + rnd() * 0.15, sy: 1, c: pick(LEAF) }); }
        // benker i ytterkant av gangveien, vendt mot brettet
        const benchZ = [1.8, 3.5, 5.2];
        for (const [bi, lz] of benchZ.entries()) { const p = rotK(8.6, sg * lz, k); stamp(plaza, benchGeos[(bi + k + (sg > 0 ? 2 : 0)) % benchGeos.length], p[0], GY, p[1], faceIn); }
        // tilskuere langs gangveien (foran bedene)
        for (let lz = 0.55; lz < 7.0; lz += 0.2) {
          if (benchZ.some((b) => Math.abs(b - lz) < 0.3) || rnd() > 0.62) continue;
          const p = rotK(8.64 + (rnd() - 0.5) * 0.06, sg * (lz + (rnd() - 0.5) * 0.06), k);
          SPEC.push({ x: p[0], z: p[1], y: GY, ry: faceIn + (rnd() - 0.5) * 0.7, s: 0.95 + rnd() * 0.2 });
        }
        // gatelykter og flagg langs ytterkanten
        for (const lz of [2.3, 4.7, 7.0]) { const p = rotK(9.78, sg * lz, k); stamp(plaza, lampGeo, p[0], GY, p[1]); }
        { const p = rotK(9.78, sg * 1.2, k); flagpole(plaza, p[0], p[1], GY, 1.42, 0.42); }
        // uteservering i hjørnesonen ved brettkanten (utenfor tomtene)
        for (const lz of [5.3, 6.35]) {
          const p = rotK(7.6, sg * lz, k); stamp(plaza, parasolGeos[paraI++ % parasolGeos.length], p[0], GY, p[1], rnd() * 6.28);
          const q = rotK(7.6 + 0.3, sg * (lz + 0.28), k);
          SPEC.push({ x: q[0], z: q[1], y: GY, ry: rnd() * 6.28, s: 1 });
        }
        // folk på fortauet langs ringveien
        for (let lz = -7.2; lz < 7.2; lz += 0.5) {
          if (rnd() > 0.28) continue;
          const p = rotK(12.85 + rnd() * 0.22, sg * Math.abs(lz), k);
          SPEC.push({ x: p[0], z: p[1], y: GY, ry: faceIn + (rnd() - 0.5) * 1.2, s: 0.95 + rnd() * 0.2 });
        }
      }
      // parasoll helt i hjørnet
      { const p = rotK(7.66, 7.66, k); stamp(plaza, parasolGeos[paraI++ % parasolGeos.length], p[0], GY, p[1], rnd() * 6.28); }
    }
    // Fontener i hjørnene
    function fountain(b, x, z, r, sc) {
      stamp(b, part(CylG(r, r + 0.05, 0.22, 28), '#2fb5c6'), x, GY + 0.11, z);
      stamp(b, part(CylG(r + 0.02, r + 0.02, 0.03, 28), '#fff4dc'), x, GY + 0.215, z);
      disc(water, x, GY + 0.236, z, r - 0.08, 24, C('#ffffff'));
      stamp(b, unitCyl, x, GY, z, 0, 0.09 * sc, 0.5 * sc, 0.09 * sc, C('#ffd23f'));
      stamp(b, part(CylG(0.3, 0.12, 0.08, 16), '#ff8a3d'), x, GY + 0.5 * sc, z, 0, sc);
      fountains.push({ x, y: GY + 0.55 * sc, z, s: sc });
    }
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) fountain(plaza, sx * 8.72, sz * 8.72, 0.6, 0.85);
    // Trær i hjørnene mellom ringen og kvartalene
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) treesCity.push({ x: sx * 12.45, y: GY, z: sz * 12.45, s: 1.3, sy: 1, c: pick(LEAF) });

    // ---------- Tomter for «levende brett» (én per eiendom) ----------
    // Feltets senter på brettet: lokal (5 − k, 5.4) rotert med side s; tomten ligger på samme linje, radius LOT_R.
    const SQS = (MP.SQUARES && MP.SQUARES.length === 40) ? MP.SQUARES : null;
    const FALLBACK_GROUP = { 1: 0, 3: 0, 6: 1, 8: 1, 9: 1, 11: 2, 13: 2, 14: 2, 16: 3, 18: 3, 19: 3, 21: 4, 23: 4, 24: 4, 26: 5, 27: 5, 29: 5, 31: 6, 32: 6, 34: 6, 37: 7, 39: 7 };
    const FALLBACK_GCOL = ['#7B2F8E', '#8FD3F5', '#E0368F', '#F7941D', '#E3242B', '#FFE21F', '#1FAF55', '#1D4FB8'];
    function sqType(i) {
      if (SQS) return SQS[i].type;
      if ([5, 15, 25, 35].includes(i)) return 'station';
      if (i === 12 || i === 28) return 'utility';
      if (FALLBACK_GROUP[i] != null) return 'street';
      return [2, 17, 33].includes(i) ? 'chest' : [7, 22, 36].includes(i) ? 'chance' : [4, 38].includes(i) ? 'tax' : 'corner';
    }
    function groupColor(i) {
      if (SQS && SQS[i].group && MP.GROUPS && MP.GROUPS[SQS[i].group]) return MP.GROUPS[SQS[i].group].color;
      return FALLBACK_GROUP[i] != null ? FALLBACK_GCOL[FALLBACK_GROUP[i]] : '#5a6270';
    }
    const LOT_R = 7.58, PADH = 0.05;
    const BRONZE = '#9c7a3c';
    const specStatueGeo = merge([
      part(BoxG(0.056, 0.09, 0.045), BRONZE, at(0, 0.045, 0)),
      part(CylG(0.036, 0.044, 0.095, 6), BRONZE, at(0, 0.137, 0)),
      part(new THREE.SphereGeometry(0.031, 6, 5), BRONZE, at(0, 0.21, 0)),
      part(BoxG(0.02, 0.09, 0.02), BRONZE, (g) => { g.translate(0, 0.045, 0); g.rotateZ(0.5); g.translate(-0.047, 0.175, 0); }),
      part(BoxG(0.02, 0.09, 0.02), BRONZE, (g) => { g.translate(0, 0.045, 0); g.rotateZ(-0.5); g.translate(0.047, 0.175, 0); }),
    ]);
    const lots = [];   // lots[i] for eiendommer, ellers undefined
    let lotCount = 0;
    for (let i = 0; i < 40; i++) {
      const s = Math.floor(i / 10), kk = i % 10;
      if (kk === 0) continue;
      const [x, z] = rotK(5 - kk, LOT_R, s), rot = -s * Math.PI / 2, type = sqType(i);
      const fr = { cx: x, cz: z, rot, cs: Math.cos(rot), sn: Math.sin(rot), y: GY + PADH };
      if (type === 'street' || type === 'station' || type === 'utility') {
        lots[i] = { i, x, z, y: GY + PADH, rot, type, gcol: groupColor(i), cell: lotCount++, fr,
          util: type === 'utility' ? (SQS ? SQS[i].icon : (i === 12 ? 'bulb' : 'tap')) : null,
          name: SQS ? SQS[i].name : '', price: SQS ? SQS[i].price : 0,
          st: { color: null, level: 0, mortgaged: false }, anim: null };
        continue;
      }
      // Felt som ikke kan eies: små lommeparker/kiosker med folk, så rekka av tomter ikke får hull.
      const P2 = (lx, lz) => [x + lx * fr.cs + lz * fr.sn, z - lx * fr.sn + lz * fr.cs];
      const box = (lx, y0, lz, w, h, d, col) => { const p = P2(lx, lz); pushBox(plaza, p[0], y0, p[1], w, h, d, rot, C(col)); };
      box(0, GY, 0, 0.92, 0.04, 1.2, '#d9cdb8');
      if (type === 'chance' || type === 'chest') {
        const acc = type === 'chance' ? '#F7941D' : '#2E7FD9';
        box(0, GY, 0, 0.86, 0.05, 1.14, '#efe4d0');
        // kiosk med markise
        box(0, GY + 0.05, 0.3, 0.5, 0.3, 0.36, '#fff4dc');
        box(0, GY + 0.35, 0.3, 0.56, 0.04, 0.42, acc);
        box(0, GY + 0.24, 0.07, 0.5, 0.025, 0.14, acc);
        box(0, GY + 0.1, 0.115, 0.4, 0.1, 0.02, '#3d405b');
        const tp = P2(-0.3, -0.3); treesPlaza.push({ x: tp[0], y: GY + 0.05, z: tp[1], s: 0.5, sy: 1, c: pick(LEAF) });
      } else {
        // liten park med statue
        box(0, GY, 0, 0.86, 0.06, 1.14, '#79d158');
        // sokkel med en liten bronsefigur (Vigeland-aktig)
        box(0, GY + 0.06, 0.1, 0.22, 0.14, 0.22, '#cfc8b8');
        box(0, GY + 0.2, 0.1, 0.26, 0.025, 0.26, '#e4dccb');
        const sp = P2(0, 0.1); stamp(plaza, specStatueGeo, sp[0], GY + 0.225, sp[1], rot + Math.PI, 1.25, 1.25, 1.25);
        for (const lz of [-0.32, 0.42]) { const tp = P2(0.3, lz); treesPlaza.push({ x: tp[0], y: GY + 0.06, z: tp[1], s: 0.46, sy: 1, c: pick(LEAF) }); }
      }
      for (let n = 0; n < 4; n++) {
        const p = P2(-0.32 + n * 0.2 + (rnd() - 0.5) * 0.06, -0.38 + (rnd() - 0.5) * 0.1);
        SPEC.push({ x: p[0], z: p[1], y: GY + 0.05, ry: rot + Math.PI + (rnd() - 0.5) * 0.8, s: 1 });
      }
    }

    // ---------- Ringveien med trikkespor ----------
    {
      const outer = [], hole = [];
      for (let s = 0, L0 = ringLen(12.4); s < L0; s += 0.25) { ringPoint(12.4, s, _p0); outer.push(new THREE.Vector2(_p0.x, -_p0.z)); }
      for (let s = 0, L0 = ringLen(10); s < L0; s += 0.25) { ringPoint(10, s, _p0); hole.push(new THREE.Vector2(_p0.x, -_p0.z)); }
      const sh = new THREE.Shape(outer); sh.holes.push(new THREE.Path(hole));
      const g = new THREE.ShapeGeometry(sh); g.rotateX(-Math.PI / 2); g.translate(0, GY + 0.006, 0);
      stamp(city, part(g, '#4d5463'), 0, 0, 0);
      ribbon(city, 10.0, 0.12, GY + 0.03, C('#e3dccd'));
      ribbon(city, 12.4, 0.12, GY + 0.03, C('#e3dccd'));
      ribbon(city, 11.2, 0.72, GY + 0.012, C('#8f8a84'));
      ribbon(city, 10.98, 0.05, GY + 0.02, C('#d9dde3'));
      ribbon(city, 11.42, 0.05, GY + 0.02, C('#d9dde3'));
      ribbon(city, 10.8, 0.05, GY + 0.014, C('#f3f3f3'), 0.6, 0.6);
      ribbon(city, 11.6, 0.05, GY + 0.014, C('#f3f3f3'), 0.6, 0.6);
      for (let k = 0; k < 4; k++) for (let i = -3; i <= 3; i++) {
        const r = rectK(10.1, i * 0.36 - 0.09, 12.3, i * 0.36 + 0.09, k);
        flatRect(city, r[0], r[1], r[2], r[3], GY + 0.024, C('#f7f7f2'));
      }
    }

    // ---------- Bygninger ----------
    function greenSlab(x0, z0, x1, z1, hex) { pushBox(city, (x0 + x1) / 2, GY, (z0 + z1) / 2, x1 - x0, 0.05, z1 - z0, 0, C(hex || '#78c653')); }
    function awning(cx, cz, w, d, front, prob) {
      if (!front || rnd() > prob) return;
      const [nx, nz] = front, col = C(pick(AWN));
      if (nx) pushBox(city, cx + nx * (w / 2 + 0.08), GY + 0.3, cz, 0.16, 0.05, d - 0.3, 0, col);
      else pushBox(city, cx, GY + 0.3, cz + nz * (d / 2 + 0.08), w - 0.3, 0.05, 0.16, 0, col);
    }
    function house(q, style, front) {
      const x0 = q[0], z0 = q[1], x1 = q[2], z1 = q[3], w = x1 - x0, d = z1 - z0;
      if (w < 0.45 || d < 0.45) return;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, dist = Math.hypot(cx, cz), cap = capH(x0, z0, x1, z1);
      aoBase = style === 'trehus' || style === 'tall' ? GY + 0.05 : GY;   // de står på en grønn plate
      if (style === 'bygard') {
        let floors = 4 + Math.floor(rnd() * 3) + (dist > 32 ? Math.floor(rnd() * 3) : 0);
        const rt = rnd(), roofH = rt < 0.45 ? 0.36 : rt < 0.65 ? 0.28 : rt < 0.88 ? 0.07 : 0.4;
        floors = Math.max(2, Math.min(floors, Math.floor((cap - roofH - 0.08) / FH)));
        const h = floors * FH, top = GY + h, wall = C(pick(BYG)), rc = C(pick(ROOF));
        const sty = [0, 0, 1, 1, 3][Math.floor(rnd() * 5)];
        if (rnd() < (dist < 30 ? 0.75 : 0.35)) {
          // butikketasje med egen farge og glassfront, gesims over
          pushBox(fac, cx, GY, cz, w, FH, d, 0, C(pick(SHOPC)), { fac: true, noTop: true, sty: 2 });
          pushBox(fac, cx, GY + FH, cz, w, h - FH, d, 0, wall, { fac: true, noTop: true, sty });
          pushBox(city, cx, GY + FH - 0.03, cz, w + 0.04, 0.04, d + 0.04, 0, C('#f4eee2'));
        } else pushBox(fac, cx, GY, cz, w, h, d, 0, wall, { fac: true, noTop: true, sty });
        pushBox(city, cx, top - 0.06, cz, w + 0.05, 0.08, d + 0.05, 0, C('#f4eee2'));
        // hjørnetårn med spir (typisk Oslo-bygård fra 1890-tallet)
        if (rt < 0.45 && w > 1.1 && d > 1.1 && rnd() < 0.35 && h + 0.95 < cap) {
          const tx = cx + (rnd() < 0.5 ? -1 : 1) * (w / 2 - 0.2), tz = cz + (rnd() < 0.5 ? -1 : 1) * (d / 2 - 0.2);
          pushBox(fac, tx, top, tz, 0.42, 0.34, 0.42, 0, wall, { fac: true, noTop: true, sty: 3 });
          pushFrustum(city, tx, top + 0.34, tz, 0.5, 0.5, 0.55, 0.25, C('#3f8a73'));
        }
        if (rt < 0.45) pushFrustum(city, cx, top + 0.02, cz, w + 0.08, d + 0.08, roofH, Math.min(w, d) / 2 + 0.04, rc);
        else if (rt < 0.65) pushFrustum(city, cx, top + 0.02, cz, w + 0.06, d + 0.06, roofH, 0.2, rc);
        else if (rt < 0.88) {
          pushBox(city, cx, top + 0.02, cz, w - 0.02, 0.04, d - 0.02, 0, C(rnd() < 0.6 ? '#74c95a' : '#e9875a'));
          if (rnd() < 0.5) pushBox(city, cx + (rnd() - 0.5) * w * 0.4, top + 0.06, cz + (rnd() - 0.5) * d * 0.4, 0.34, 0.18, 0.3, 0, C(pick(TOPC)));
        } else pushGable(city, cx, top + 0.02, cz, w, d, roofH, rc, wall);
        if (rt < 0.65 && rnd() < 0.6) pushBox(city, cx + (rnd() - 0.5) * w * 0.4, top, cz + (rnd() - 0.5) * d * 0.3, 0.12, roofH + 0.12, 0.12, 0, C('#9c5b46'));
        awning(cx, cz, w, d, front, dist < 22 ? 0.85 : 0.4);
      } else if (style === 'trehus') {
        const floors = 1 + (rnd() < 0.55 ? 1 : 0), h = floors * FH, wall = C(pick(TRE));
        pushBox(fac, cx, GY, cz, w, h, d, 0, wall, { fac: true, noTop: true, sty: rnd() < 0.7 ? 3 : 0 });
        pushGable(city, cx, GY + h, cz, w, d, 0.3 + rnd() * 0.14, C(pick(TROOF)), wall, 0.07);
        if (rnd() < 0.5) pushBox(city, cx + (rnd() - 0.5) * w * 0.3, GY + h, cz, 0.1, 0.42, 0.1, 0, C('#8a4b3a'));
      } else if (style === 'tall' || style === 'modern') {
        let floors = style === 'tall' ? 10 + Math.floor(rnd() * 13) : 5 + Math.floor(rnd() * 3);
        floors = Math.max(3, Math.min(floors, Math.floor((cap - 0.25) / FH)));
        const h = floors * FH;
        pushBox(fac, cx, GY, cz, w, h, d, 0, C(style === 'tall' ? pick(TALL) : pick(BYG)), { fac: true, noTop: true, sty: rnd() < 0.6 ? 2 : 0 });
        pushBox(city, cx, GY + h, cz, w + 0.04, 0.08, d + 0.04, 0, C('#e9edf0'));
        pushBox(city, cx, GY + h + 0.08, cz, w * 0.4, 0.26, d * 0.4, 0, C(pick(TOPC)));
      }
      aoBase = GY;
    }
    function addTree(list, x, z, y, s, hex) { if (keep()) list.push({ x, y: y == null ? GY : y, z, s: s || 1, sy: 1, c: hex || pick(LEAF) }); }
    function courtyard(q) {
      const x0 = q[0], z0 = q[1], x1 = q[2], z1 = q[3]; if (x1 - x0 < 0.4 || z1 - z0 < 0.4) return;
      greenSlab(x0, z0, x1, z1);
      const n = Math.max(1, Math.round(((x1 - x0) * (z1 - z0)) / 5));
      for (let i = 0; i < n; i++) addTree(treesCity, x0 + 0.4 + rnd() * Math.max(0, x1 - x0 - 0.8), z0 + 0.4 + rnd() * Math.max(0, z1 - z0 - 0.8), GY + 0.05, 0.9 + rnd() * 0.4);
    }
    function bygardBlock(pc) {
      const x0 = pc.x0 + 0.35, x1 = pc.x1 - 0.35, z0 = pc.z0 + 0.35, z1 = pc.z1 - 0.35, w = x1 - x0, d = z1 - z0;
      if (w < 0.8 || d < 0.8) return;
      const alongX = w >= d, Lg = alongX ? w : d, Sh = alongX ? d : w;
      const rect = (l0, l1, s0, s1) => (alongX ? [x0 + l0, z0 + s0, x0 + l1, z0 + s1] : [x0 + s0, z0 + l0, x0 + s1, z0 + l1]);
      const dirS = (sg) => (alongX ? [0, sg] : [sg, 0]);
      const dirL = (sg) => (alongX ? [sg, 0] : [0, sg]);
      const two = Sh >= 4.0, dep = two ? Math.min(2.0, Sh / 2 - 0.25) : Sh;
      const centerS = alongX ? (z0 + z1) / 2 : (x0 + x1) / 2;
      const rows = two ? [[0, dep, -1], [Sh - dep, Sh, 1]] : [[0, Sh, centerS > 0 ? -1 : 1]];
      for (const row of rows) {
        let t = 0;
        while (t < Lg - 0.05) {
          let lw = 1.4 + rnd() * 1.2; if (Lg - (t + lw) < 1.1) lw = Lg - t;
          house(rect(t, t + lw, row[0], row[1]), 'bygard', dirS(row[2])); t += lw;
        }
      }
      if (two) {
        if (Lg >= 5) {
          const e = Math.min(1.9, Lg / 4);
          house(rect(0, e, dep, Sh - dep), 'bygard', dirL(-1)); house(rect(Lg - e, Lg, dep, Sh - dep), 'bygard', dirL(1));
          courtyard(rect(e, Lg - e, dep, Sh - dep));
        } else courtyard(rect(0, Lg, dep, Sh - dep));
      }
    }
    function trehusBlock(pc) {
      const x0 = pc.x0 + 0.35, x1 = pc.x1 - 0.35, z0 = pc.z0 + 0.35, z1 = pc.z1 - 0.35, w = x1 - x0, d = z1 - z0;
      if (w < 0.8 || d < 0.8) return;
      greenSlab(x0, z0, x1, z1, '#82cc5a');
      const alongX = w >= d, Lg = alongX ? w : d, Sh = alongX ? d : w;
      const rect = (l0, l1, s0, s1) => (alongX ? [x0 + l0, z0 + s0, x0 + l1, z0 + s1] : [x0 + s0, z0 + l0, x0 + s1, z0 + l1]);
      const dep = Math.min(1.2, Sh / 2 - 0.2), rows = Sh >= 2.8 ? [[0.12, 0.12 + dep], [Sh - 0.12 - dep, Sh - 0.12]] : [[0.1, Sh - 0.1]];
      for (const row of rows) {
        let t = 0.2 + rnd() * 0.3;
        while (t < Lg - 1.0) { const lw = Math.min(0.9 + rnd() * 0.45, Lg - t - 0.1); house(rect(t, t + lw, row[0], row[1]), 'trehus'); t += lw + 0.35 + rnd() * 0.4; }
      }
      if (Sh >= 2.8) for (let t = 0.6; t < Lg - 0.5; t += 1.4 + rnd()) { const q = rect(t, t, Sh / 2, Sh / 2); addTree(treesCity, q[0], q[1], GY + 0.05, 0.8 + rnd() * 0.5); }
    }
    function tallBlock(pc) {
      const x0 = pc.x0 + 0.35, x1 = pc.x1 - 0.35, z0 = pc.z0 + 0.35, z1 = pc.z1 - 0.35, w = x1 - x0, d = z1 - z0;
      greenSlab(x0, z0, x1, z1, '#8fd16a');
      const alongX = w >= d, Lg = alongX ? w : d, Sh = alongX ? d : w;
      const n = Math.max(1, Math.round(Lg / 3.2)), seg = Lg / n;
      for (let i = 0; i < n; i++) {
        const l0 = i * seg + 0.35, l1 = (i + 1) * seg - 0.35, s0 = 0.3 + rnd() * 0.4, s1 = Sh - 0.3 - rnd() * 0.4;
        house(alongX ? [x0 + l0, z0 + s0, x0 + l1, z0 + s1] : [x0 + s0, z0 + l0, x0 + s1, z0 + l1], 'tall');
      }
    }
    let barcodeI = 0;
    const BAR_H = [5.4, 7.8, 6.2, 9.2, 6.8, 8.4, 5.2, 8.0, 6.4], BAR_C = ['#ffd27a', '#3f7fd0', '#5ccbef', '#f7a65c', '#2f5d8c', '#8fe0d0', '#ff8a75', '#5f86d6', '#b8e3f5'];
    function barcodeBlock(pc) {
      for (let k = 0; k < 3; k++) {
        const cx = pc.x0 + 1.05 + k * 2.05, i = barcodeI++ % BAR_H.length, h = Math.round(BAR_H[i] / FH) * FH;
        pushBox(fac, cx, GY, -23, 1.5, h, 5.2, 0, C(BAR_C[i]), { fac: true, noTop: true, sty: k === 1 ? 0 : 2 });
        pushBox(city, cx, GY + h, -23, 1.54, 0.08, 5.24, 0, C('#e3e7ea'));
      }
    }
    function parkBlock(pc, kind) {
      const x0 = pc.x0 + 0.2, x1 = pc.x1 - 0.2, z0 = pc.z0 + 0.2, z1 = pc.z1 - 0.2, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      greenSlab(x0, z0, x1, z1);
      const path = C('#f4c98e');
      flatRect(city, x0, cz - 0.22, x1, cz + 0.22, GY + 0.056, path);
      flatRect(city, cx - 0.22, z0, cx + 0.22, z1, GY + 0.056, path);
      if (kind === 'pond') { stamp(city, part(CylG(1.35, 1.4, 0.06, 24), '#cfc6b4'), cx, GY + 0.05, cz); disc(water, cx, GY + 0.085, cz, 1.25, 24, C('#ffffff')); }
      else stamp(city, part(CylG(0.7, 0.75, 0.08, 20), '#f4c98e'), cx, GY + 0.06, cz);
      for (const [dx, dz, r] of [[0.95, 0.5, 0], [-0.95, -0.5, Math.PI]]) stamp(city, benchGeo, cx + dx, GY + 0.05, cz + dz, r);
      const n = Math.round(((x1 - x0) * (z1 - z0)) / 2.6);
      for (let i = 0; i < n; i++) {
        const x = x0 + 0.4 + rnd() * (x1 - x0 - 0.8), z = z0 + 0.4 + rnd() * (z1 - z0 - 0.8);
        if (Math.abs(x - cx) < 0.55 || Math.abs(z - cz) < 0.55 || Math.hypot(x - cx, z - cz) < 1.6) continue;
        addTree(treesCity, x, z, GY + 0.05, 0.9 + rnd() * 0.6, rnd() < 0.08 ? '#f49cbb' : null);
      }
    }

    // ---------- Gatenett og kvartaler ----------
    const GX = [-63, -56, -48.5, -41, -33.5, -26.5, -19.5, -9.8, 0, 9.8, 19.5, 26.5, 33.5, 41, 48.5, 56, 63];
    const GZ = [-26.5, -19.5, -9.8, 0, 9.8, 19.5, 26.5, 33.5, 41, 48.5, 56, 63];
    const hwOf = (c) => (c === 0 ? 1.3 : 0.7);
    const ZONES = [[-41, -9.8, -26.5, 9.8], [26.5, -9.8, 41, 9.8], [-19.5, -26.5, 0, -19.5], [9.8, -26.5, 19.5, -19.5]];
    const inZone = (x, z) => ZONES.some((r) => x > r[0] + 0.01 && x < r[2] - 0.01 && z > r[1] + 0.01 && z < r[3] - 0.01);
    const PARKS = [[-19.5, 26.5, -9.8, 33.5, 'pond'], [33.5, 19.5, 41, 26.5], [-48.5, 33.5, -41, 41], [9.8, 41, 19.5, 48.5, 'pond'], [-56, -19.5, -48.5, -9.8], [41, 33.5, 48.5, 41]];
    const CAR_X = [-48.5, -19.5, 19.5, 48.5], CAR_Z = [-19.5, 19.5, 41];
    const asphalt = C('#525866'), paving = C('#f2bf8a'), dash = C('#f3f3f3');
    function streetSeg(c, a0, a1, vertical) {
      if (Math.abs(c) < SQ) {
        if (a0 >= -SQ && a1 <= SQ) return;
        if (a0 < SQ && a1 > SQ) a0 = SQ;
        if (a0 < -SQ && a1 > -SQ) a1 = -SQ;
      }
      const hw = hwOf(c), y = c === 0 ? GY + 0.008 : GY + 0.012, col = c === 0 ? paving : asphalt;
      if (vertical) flatRect(city, c - hw, a0, c + hw, a1, y, col); else flatRect(city, a0, c - hw, a1, c + hw, y, col);
      if ((vertical ? CAR_X : CAR_Z).includes(c)) {
        for (let t = a0 + 0.3; t < a1 - 0.6; t += 1.3) {
          if (vertical) flatRect(city, c - 0.03, t, c + 0.03, t + 0.6, GY + 0.016, dash); else flatRect(city, t, c - 0.03, t + 0.6, c + 0.03, GY + 0.016, dash);
        }
        for (let t = a0 + 2; t < a1 - 1; t += 6) { if (vertical) stamp(city, lampGeo, c + hw + 0.12, GY, t); else stamp(city, lampGeo, t, GY, c - hw - 0.12); }
      }
    }
    for (const c of GX) for (let j = 0; j + 1 < GZ.length; j++) if (!inZone(c, (GZ[j] + GZ[j + 1]) / 2)) streetSeg(c, GZ[j], GZ[j + 1], true);
    for (const c of GZ) for (let i = 0; i + 1 < GX.length; i++) if (!inZone((GX[i] + GX[i + 1]) / 2, c)) streetSeg(c, GX[i], GX[i + 1], false);
    function minusSquare(r) {
      if (r.x1 <= -SQ || r.x0 >= SQ || r.z1 <= -SQ || r.z0 >= SQ) return [r];
      const out = [];
      if (r.x1 > SQ) out.push({ x0: Math.max(r.x0, SQ), x1: r.x1, z0: r.z0, z1: r.z1 });
      if (r.x0 < -SQ) out.push({ x0: r.x0, x1: Math.min(r.x1, -SQ), z0: r.z0, z1: r.z1 });
      const mx0 = Math.max(r.x0, -SQ), mx1 = Math.min(r.x1, SQ);
      if (r.z1 > SQ) out.push({ x0: mx0, x1: mx1, z0: Math.max(r.z0, SQ), z1: r.z1 });
      if (r.z0 < -SQ) out.push({ x0: mx0, x1: mx1, z0: r.z0, z1: Math.min(r.z1, -SQ) });
      return out.filter((q) => q.x1 - q.x0 > 1.2 && q.z1 - q.z0 > 1.2);
    }
    for (let i = 0; i + 1 < GX.length; i++) for (let j = 0; j + 1 < GZ.length; j++) {
      const r = { x0: GX[i] + hwOf(GX[i]), x1: GX[i + 1] - hwOf(GX[i + 1]), z0: GZ[j] + hwOf(GZ[j]), z1: GZ[j + 1] - hwOf(GZ[j + 1]) };
      for (const pc of minusSquare(r)) {
        const cx = (pc.x0 + pc.x1) / 2, cz = (pc.z0 + pc.z1) / 2;
        if (inZone(cx, cz)) continue;
        if (cx > 10 && cx < 19 && cz > -19 && cz < -10) continue;   // operatomten
        const park = PARKS.find((p) => cx > p[0] && cx < p[2] && cz > p[1] && cz < p[3]);
        if (park) { parkBlock(pc, park[4]); continue; }
        if (cz < -19.4 && cx > 33.4) barcodeBlock(pc);
        else if (cx > 48.5 && cz < 9.8) tallBlock(pc);
        else if ((cx < -19.5 && cz > 9.8) || cz > 48.5) trehusBlock(pc);
        else if (low && Math.hypot(cx, cz) > 45 && rnd() < 0.5) courtyard([pc.x0 + 0.35, pc.z0 + 0.35, pc.x1 - 0.35, pc.z1 - 0.35]);
        else bygardBlock(pc);
      }
    }
    // Alleer (Karl Johan m.fl.) med trær og lykter
    for (const [vert, a0, a1] of [[true, 13.6, 62.5], [true, -26.0, -13.6], [false, 13.6, 26.0], [false, -26.0, -13.6], [false, -62.5, -41.8], [false, 41.8, 62.5]]) {
      for (let t = a0 + 0.8; t < a1 - 0.3; t += 2.4) {
        if (GZ.concat(GX).some((g) => g !== 0 && Math.abs(g - t) < 1.1)) continue;
        for (const sd of [-0.95, 0.95]) {
          if (vert) addTree(treesCity, sd, t, GY, 0.95); else addTree(treesCity, t, sd, GY, 0.95);
        }
        if (vert) stamp(city, lampGeo, 0, GY, t + 1.2); else stamp(city, lampGeo, t + 1.2, GY, 0);
      }
    }

    // ---------- Landemerker ----------
    // Slottet i Slottsparken (vest, ved enden av allé z=0)
    {
      greenSlab(-40.3, -9.1, -27.2, 9.1);
      flatRect(city, -33.4, -4.4, -27.2, 4.4, GY + 0.056, C('#eadcb8'));
      const cream = C('#f0d999'), roofG = C('#6f7d86');
      pushBox(fac, -35.5, GY, 0, 2.2, 5 * FH, 8.4, 0, cream, FAC);
      pushBox(city, -35.5, GY + 5 * FH - 0.06, 0, 2.28, 0.08, 8.48, 0, C('#f7efd8'));
      pushFrustum(city, -35.5, GY + 5 * FH + 0.02, 0, 2.36, 8.56, 0.3, 0.55, roofG);
      for (const sz of [-1, 1]) {
        pushBox(fac, -37.7, GY, sz * 3.6, 2.2, 4 * FH, 1.2, 0, cream, FAC);
        pushFrustum(city, -37.7, GY + 4 * FH, sz * 3.6, 2.3, 1.3, 0.25, 0.5, roofG);
      }
      for (let i = 0; i < 6; i++) stamp(city, unitCyl, -34.15, GY, -1.0 + i * 0.4, 0, 0.07, 1.12, 0.07, C('#fbf6ea'));
      pushBox(city, -34.2, GY + 1.12, 0, 0.5, 0.12, 2.4, 0, C('#fbf6ea'));
      pushGable(city, -34.2, GY + 1.24, 0, 0.5, 2.4, 0.3, C('#f7efd8'), C('#f7efd8'), 0.02);
      flagpole(city, -35.5, 0, GY + 5 * FH + 0.3, 1.0, 0.7);
      pushBox(city, -30, GY, 0, 0.42, 0.5, 0.42, 0, C('#cfc8b8'));
      pushBox(city, -30, GY + 0.62, 0, 0.42, 0.2, 0.14, 0, C('#4a5a52'));
      pushBox(city, -30, GY + 0.5, 0, 0.3, 0.14, 0.12, 0, C('#4a5a52'));
      pushBox(city, -30, GY + 0.82, 0, 0.08, 0.2, 0.08, 0, C('#4a5a52'));
      stamp(city, part(CylG(1.25, 1.3, 0.06, 24), '#cfc6b4'), -38.5, GY + 0.05, 6.8);
      disc(water, -38.5, GY + 0.085, 6.8, 1.15, 24, C('#ffffff'));
      for (let i = 0; i < 90; i++) {
        const x = -39.9 + rnd() * 12.3, z = -8.7 + rnd() * 17.4;
        if (x > -39.4 && z > -5.2 && z < 5.2) continue;
        if (Math.hypot(x + 38.5, z - 6.8) < 1.8) continue;
        addTree(treesCity, x, z, GY + 0.05, 1.0 + rnd() * 0.7, rnd() < 0.1 ? '#f49cbb' : null);
      }
    }
    // Rådhuset med to brune murtårn og klokker, Rådhusplassen ved vannet
    {
      flatRect(city, -19.0, -26.0, -0.8, -20.0, GY + 0.02, C('#f2c590'));
      flatRect(city, -20.0, -29.75, 0.0, -27.25, GY + 0.016, C('#f7d8a8'));
      const brick = C('#b4553b'), capC = C('#e2d4bb'), copper = C('#5f9c86');
      for (const [x, fl] of [[-12.6, 15], [-7.0, 16]]) {
        const h = fl * FH;
        pushBox(fac, x, GY, -23, 2.4, h, 1.9, 0, brick, FAC);
        pushBox(city, x, GY + h, -23, 2.52, 0.12, 2.02, 0, capC);
        for (const sz of [-1, 1]) {
          stamp(city, part(CylG(0.42, 0.42, 0.04, 24), '#f2c14e', (g) => g.rotateX(Math.PI / 2)), x, GY + h - 0.75, -23 + sz * 0.97);
          stamp(city, part(CylG(0.33, 0.33, 0.02, 24), '#fbf7ec', (g) => g.rotateX(Math.PI / 2)), x, GY + h - 0.75, -23 + sz * 0.995);
          pushBox(city, x, GY + h - 0.75, -23 + sz * 1.01, 0.04, 0.26, 0.02, 0, C('#2b2b2b'));
          pushBox(city, x + 0.09, GY + h - 0.75, -23 + sz * 1.012, 0.18, 0.035, 0.02, 0, C('#2b2b2b'));
        }
      }
      flagpole(city, -7.0, -23, GY + 16 * FH + 0.12, 0.9, 0.7);
      pushBox(fac, -9.8, GY, -23, 3.2, 5 * FH, 3.4, 0, brick, FAC);
      pushFrustum(city, -9.8, GY + 5 * FH, -23, 3.3, 3.5, 0.35, 0.8, copper);
      for (const [x, w] of [[-16.0, 4.2], [-3.6, 4.4]]) {
        pushBox(fac, x, GY, -23.3, w, 4 * FH, 4.6, 0, brick, FAC);
        pushFrustum(city, x, GY + 4 * FH, -23.3, w + 0.1, 4.7, 0.3, 0.6, copper);
      }
      fountain(city, -9.8, -28.5, 1.0, 1.5);
    }
    // Akershus festning på odden
    {
      greenSlab(10.5, -25.8, 18.8, -20.2, '#6fbf4f');
      for (let i = 0; i < 10; i++) addTree(treesCity, 11 + rnd() * 7.3, -25.3 + rnd() * 4.6, GY + 0.05, 1.0 + rnd() * 0.5);
      const fort = [[5.5, -30.5], [18.5, -30.5], [18.5, -35.8], [16.3, -38.5], [7.7, -38.5], [5.5, -35.8]];
      const g = new THREE.ShapeGeometry(new THREE.Shape(fort.map((p) => new THREE.Vector2(p[0], -p[1]))));
      g.rotateX(-Math.PI / 2); g.translate(0, GY + 0.03, 0); stamp(city, part(g, '#74c454'), 0, 0, 0);
      const wallC = C('#cbbfa6');
      for (let i = 0; i < fort.length; i++) {
        const a = fort[i], b = fort[(i + 1) % fort.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]), rot = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
        if (i === 0) {
          for (const [f0, f1] of [[0, 0.42], [0.58, 1]]) {
            const mx = a[0] + (b[0] - a[0]) * (f0 + f1) / 2, mz = a[1] + (b[1] - a[1]) * (f0 + f1) / 2;
            pushBox(city, mx, GY, mz, len * (f1 - f0), 0.7, 0.34, rot, wallC);
          }
        } else pushBox(city, (a[0] + b[0]) / 2, GY, (a[1] + b[1]) / 2, len + 0.3, 0.7, 0.34, rot, wallC);
        for (let t = 0.3; t < len - 0.2; t += 0.6) {
          const f = t / len; if (i === 0 && f > 0.4 && f < 0.6) continue;
          pushBox(city, a[0] + (b[0] - a[0]) * f, GY + 0.7, a[1] + (b[1] - a[1]) * f, 0.24, 0.14, 0.34, rot, wallC);
        }
      }
      const stone = C('#e4dccb'), cop = C('#3f8a73');
      pushBox(fac, 12, GY, -35, 5.0, 5 * FH, 2.4, 0, stone, FAC);
      pushFrustum(city, 12, GY + 5 * FH, -35, 5.1, 2.5, 0.6, 1.25, cop);
      pushBox(fac, 9.2, GY, -35.4, 1.0, 8 * FH, 1.0, 0, stone, FAC);
      pushFrustum(city, 9.2, GY + 8 * FH, -35.4, 1.1, 1.1, 1.0, 0.55, cop);
      pushBox(fac, 14.9, GY, -34.4, 1.0, 9 * FH, 1.0, 0, stone, FAC);
      pushFrustum(city, 14.9, GY + 9 * FH, -34.4, 1.1, 1.1, 1.1, 0.55, cop);
      flagpole(city, 14.9, -34.4, GY + 9 * FH + 1.1, 0.6, 0.6);
      for (let i = 0; i < 6; i++) addTree(treesCity, 6.5 + rnd() * 2, -32 - rnd() * 5, GY + 0.03, 0.9);
    }
    // Operahuset (miniatyr nær ringen, ca. 21 fra midten): hvitt skrått tak som går ned i et havnebasseng.
    {
      const white = C('#f4f5f2'), sideC = C('#e3e6e2'), yw = GY + 0.05, y1 = GY + 1.25;
      // belegg rundt operaen og bassenget
      flatRect(city, 13.4, -18.6, 18.6, -10.7, GY + 0.01, C('#ece6da'));
      flatRect(city, 10.7, -18.6, 13.4, -13.4, GY + 0.01, C('#ece6da'));
      // basseng med steinkant (vannflaten ligger i vann-bunten)
      const bx0 = 10.9, bx1 = 18.4, bz0 = -18.45, bz1 = -15.55;
      for (const [x0, z0, x1, z1] of [[bx0, bz0, bx1, bz0 + 0.14], [bx0, bz1 - 0.14, 13.6, bz1], [bx0, bz0, bx0 + 0.14, bz1], [bx1 - 0.14, bz0, bx1, bz1]]) pushBox(city, (x0 + x1) / 2, GY, (z0 + z1) / 2, x1 - x0, 0.09, z1 - z0, 0, C('#cfc6b4'));
      water.quad([bx0 + 0.1, yw, bz0 + 0.1], [bx0 + 0.1, yw, bz1 - 0.1], [bx1 - 0.1, yw, bz1 - 0.1], [bx1 - 0.1, yw, bz0 + 0.1], C('#ffffff'));
      // hovedvolum med glassfasade
      pushBox(fac, 16.0, GY, -13.85, 4.8, 1.2, 2.5, 0, C('#e9ece8'), { fac: true, noTop: true, sty: 2 });
      pushBox(city, 16.1, GY, -15.08, 3.4, 1.12, 0.06, 0, C('#2e6170'));
      // skrått tak fra vannet og opp, flatt tak, og skrå bakside
      city.quadFacing([13.5, yw + 0.01, -17.7], [18.5, yw + 0.01, -17.7], [18.5, y1, -15.2], [13.5, y1, -15.2], white, 0, 1, -1);
      city.tri([13.5, yw, -17.7], [13.5, y1, -15.2], [13.5, yw, -15.2], sideC);
      city.tri([18.5, yw, -17.7], [18.5, yw, -15.2], [18.5, y1, -15.2], sideC);
      flatRect(city, 13.5, -15.2, 18.5, -12.6, y1, white);
      city.quadFacing([13.5, y1, -12.6], [18.5, y1, -12.6], [18.5, GY + 0.02, -11.1], [13.5, GY + 0.02, -11.1], white, 0, 1, 1);
      city.tri([13.5, y1, -12.6], [13.5, GY, -11.1], [13.5, GY, -12.6], sideC);
      city.tri([18.5, y1, -12.6], [18.5, GY, -12.6], [18.5, GY, -11.1], sideC);
      // scenetårn med aluminiumsstriper
      pushBox(city, 16.7, y1, -13.6, 2.0, 1.15, 1.5, 0, C('#d3d7da'));
      for (let i = 0; i < 9; i++) pushBox(city, 15.86 + i * 0.21, y1 + 0.05, -14.36, 0.05, 1.05, 0.02, 0, C('#aeb5bb'));
      // folk som går på taket
      for (let i = 0; i < 9; i++) { const x = 13.9 + rnd() * 4.2, z = -15.1 + rnd() * 2.3; SPEC.push({ x, y: y1, z, ry: rnd() * 6.28, s: 1 }); }
      for (let i = 0; i < 6; i++) { const f = 0.15 + rnd() * 0.7, x = 13.9 + rnd() * 4.2; SPEC.push({ x, y: yw + f * (y1 - yw), z: -17.7 + f * 2.5, ry: Math.PI + (rnd() - 0.5), s: 1 }); }
      for (const [x, z] of [[11.4, -14.2], [12.6, -13.9], [18.2, -10.95]]) addTree(treesCity, x, z, GY + 0.01, 1.0);
    }
    // Den gamle operakaia: promenade med moderne bygg
    {
      flatRect(city, 19.6, -30.0, 33.4, -26.6, GY + 0.01, C('#ece6da'));
      house([24.4, -33.2, 27.8, -30.4], 'modern');
      house([28.8, -33.2, 32.6, -30.4], 'modern');
      for (let x = 20.5; x < 33; x += 1.6) addTree(treesCity, x, -27.4, GY + 0.01, 0.95);
    }
    // Aker Brygge-piren med moderne bygg
    {
      house([-32.6, -36.2, -30.0, -31.0], 'modern');
      house([-29.4, -35.2, -26.6, -31.6], 'modern');
    }
    // Cruiseskip ved Akershuskaia
    {
      const cz = -41.3, hullC = C('#f7f7f5');
      pushBox(city, 9, WY - 0.3, cz, 11, 1.0, 1.7, 0, hullC);
      pushBox(city, 9, WY - 0.28, cz, 11.04, 0.26, 1.74, 0, C('#173a6b'));
      city.tri([14.5, WY + 0.7, cz + 0.85], [14.5, WY + 0.7, cz - 0.85], [16.0, WY + 0.7, cz], hullC);
      city.quadFacing([14.5, WY - 0.3, cz + 0.85], [16.0, WY - 0.3, cz], [16.0, WY + 0.7, cz], [14.5, WY + 0.7, cz + 0.85], hullC, 0.5, 0, 1);
      city.quadFacing([14.5, WY - 0.3, cz - 0.85], [16.0, WY - 0.3, cz], [16.0, WY + 0.7, cz], [14.5, WY + 0.7, cz - 0.85], hullC, 0.5, 0, -1);
      pushBox(fac, 8.6, WY + 0.7, cz, 9.6, FH, 1.5, 0, hullC, { fac: true });
      pushBox(fac, 8.2, WY + 0.7 + FH, cz, 8.2, FH, 1.4, 0, hullC, { fac: true });
      pushBox(fac, 8.0, WY + 0.7 + 2 * FH, cz, 6.0, FH, 1.2, 0, hullC, { fac: true });
      pushBox(city, 7.4, WY + 0.7 + 3 * FH, cz, 0.8, 0.7, 0.6, 0, hullC);
      pushBox(city, 7.4, WY + 1.25 + 3 * FH, cz, 0.82, 0.18, 0.62, 0, C('#1f5fbf'));
      for (let i = 0; i < 6; i++) for (const sz of [-1, 1]) pushBox(city, 5 + i * 1.3, WY + 0.75, cz + sz * 0.8, 0.5, 0.16, 0.14, 0, C('#ff8a1f'));
    }
    // Øyer i fjorden (Hovedøya m.fl.) og fyr
    {
      const ISL = [[-36, -58, 4.5], [20, -72, 5], [48, -80, 7], [-48, -85, 6], [4, -52, 2]];
      const dome = new THREE.SphereGeometry(1, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      const domeG = part(dome, '#6fc04f'), beachG = part(CylG(1.1, 1.18, 0.3, 16), '#e6d39a');
      for (const [x, z, r] of ISL) {
        stamp(city, beachG, x, WY - 0.12, z, 0, r, 1, r);
        stamp(city, domeG, x, WY - 0.05, z, 0, r, 0.22 * r, r);
        const n = Math.round(r * 2.2);
        for (let i = 0; i < n; i++) {
          const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * r * 0.6, tx = x + Math.cos(a) * rr, tz = z + Math.sin(a) * rr;
          const hy = WY - 0.05 + 0.22 * r * Math.sqrt(Math.max(0, 1 - (rr / r) ** 2));
          addTree(treesCity, tx, tz, hy - 0.05, 1.2 + rnd() * 0.6);
        }
      }
      const lx = 4, lz = -52, ly = WY + 0.35;
      for (let i = 0; i < 4; i++) stamp(city, unitCyl, lx, ly + i * 0.35, lz, 0, 0.26 - i * 0.02, 0.35, 0.26 - i * 0.02, C(i % 2 ? '#f7f7f5' : '#d7263d'));
      stamp(city, unitCyl, lx, ly + 1.4, lz, 0, 0.2, 0.22, 0.2, C('#fff3b0'));
      stamp(city, part(new THREE.ConeGeometry(0.26, 0.25, 10), '#d7263d'), lx, ly + 1.74, lz);
    }
    // Holmenkollbakken på åsen i nordvest
    {
      const H = [-40, 78], d = [0.456, -0.889], pp = [-d[1], d[0]];
      const T = [H[0] - d[0] * 2.5, H[1] - d[1] * 2.5], gT = terrainH(T[0], T[1]), yT = gT + 8.5;
      const run = 13, ang = 0.62, E = [T[0] + d[0] * run * Math.cos(ang), T[1] + d[1] * run * Math.cos(ang)], yE = yT - run * Math.sin(ang);
      const rot = Math.atan2(-d[1], d[0]), steel = C('#eef2f5');
      pushBox(city, T[0], gT - 0.5, T[1], 1.3, yT - gT + 1.7, 1.3, rot, steel);
      pushBox(city, T[0], yT + 1.2, T[1], 1.9, 0.5, 1.9, rot, C('#cfd8df'));
      flagpole(city, T[0], T[1], yT + 1.7, 1.2, 0.9);
      beam(city, T[0], yT + 0.3, T[1], E[0], yE, E[1], 1.0, 0.3, steel);
      for (const s of [-1, 1]) beam(city, T[0] + pp[0] * s * 0.48, yT + 0.5, T[1] + pp[1] * s * 0.48, E[0] + pp[0] * s * 0.48, yE + 0.2, E[1] + pp[1] * s * 0.48, 0.08, 0.3, C('#8fa1b0'));
      for (let i = 1; i <= 3; i++) {
        const f = i / 4, px = T[0] + (E[0] - T[0]) * f, pz = T[1] + (E[1] - T[1]) * f, py = yT + (yE - yT) * f, gg = terrainH(px, pz);
        pushBox(city, px, gg - 0.5, pz, 0.4, py - gg + 0.4, 0.4, rot, C('#dfe5ea'));
      }
      const land = C('#eaf2f4');
      let prev = null;
      for (let s = 0; s <= 24; s += 1) {
        const cx = E[0] + d[0] * (s + 0.8), cz = E[1] + d[1] * (s + 0.8), y = terrainH(cx, cz) + 0.6;
        const w = 1.4 + Math.min(s, 10) * 0.12;
        const L = [cx + pp[0] * w, y, cz + pp[1] * w], Rr = [cx - pp[0] * w, y, cz - pp[1] * w];
        if (prev) city.quadFacing(prev[0], prev[1], Rr, L, land, 0, 1, 0);
        prev = [L, Rr];
      }
      const bx = E[0] + d[0] * 26, bz = E[1] + d[1] * 26, by = terrainH(bx, bz);
      for (const s of [-1, 1]) pushBox(city, bx + pp[0] * s * 4.2, by - 0.3, bz + pp[1] * s * 4.2, 6, 1.4, 1.6, rot, C('#b8c2cc'));
    }

    // ---------- Tivoli (øst, ved enden av allé z=0) ----------
    const FW = { x: 37.6, z: 3.6, y: GY + 3.75, r: 3.1, n: 16 };
    let wheel, gondolas, carousel, dropCar;
    {
      greenSlab(27.2, -9.1, 40.3, 9.1, '#f6e4c2');
      for (const [x, z, r, c] of [[31, -5.2, 2.3, '#ffd6e0'], [37.6, 3.6, 2.6, '#cdeefd'], [38.2, -6, 1.4, '#fff1b3']]) stamp(city, part(CylG(r, r, 0.02, 28), c), x, GY + 0.05, z);
      flatRect(city, 27.2, -2.2, 40.3, -0.8, GY + 0.056, C('#f1d2a2'));
      // inngangsportal
      for (const sz of [-1, 1]) pushBox(city, 27.5, GY, sz * 1.5, 0.3, 1.5, 0.3, 0, C('#e84a5f'));
      pushBox(city, 27.5, GY + 1.5, 0, 0.34, 0.32, 3.4, 0, C('#ffd23f'));
      for (let i = 0; i < 7; i++) pushBox(city, 27.3, GY + 1.66, -1.2 + i * 0.4, 0.06, 0.12, 0.12, 0, C(RAINBOW[i]));
      flagpole(city, 27.5, -1.5, GY + 1.82, 0.5, 0.35); flagpole(city, 27.5, 1.5, GY + 1.82, 0.5, 0.35);
      // pariserhjul – stativ (statisk)
      const white = C('#f4f4f6');
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) beam(city, FW.x + sx * 0.8, GY, FW.z + sz * 2.0, FW.x + sx * 0.34, FW.y, FW.z, 0.14, 0.14, white);
      pushBox(city, FW.x, GY, FW.z, 2.2, 0.15, 4.6, 0, C('#e84a5f'));
      // hjulet (roterer om x-aksen)
      const wp = [];
      for (const sx of [-0.22, 0.22]) {
        wp.push(part(new THREE.TorusGeometry(FW.r, 0.05, 5, 56), '#f4f4f6', (g) => { g.rotateY(Math.PI / 2); g.translate(sx, 0, 0); }));
        wp.push(part(new THREE.TorusGeometry(FW.r * 0.45, 0.035, 4, 32), '#e84a5f', (g) => { g.rotateY(Math.PI / 2); g.translate(sx, 0, 0); }));
        for (let i = 0; i < FW.n; i++) {
          const a = (i / FW.n) * Math.PI * 2;
          wp.push(part(BoxG(0.035, 0.035, FW.r), '#e84a5f', (g) => { g.translate(0, 0, FW.r / 2); g.rotateX(-a); g.translate(sx, 0, 0); }));
          for (let j = 0; j < 2; j++) {
            const b2 = a + (j * Math.PI) / FW.n;
            wp.push(part(BoxG(0.09, 0.09, 0.09), RAINBOW[(i + j) % RAINBOW.length], at(sx * 1.25, Math.sin(b2) * FW.r, Math.cos(b2) * FW.r)));
          }
        }
      }
      for (let i = 0; i < FW.n; i++) { const a = (i / FW.n) * Math.PI * 2; wp.push(part(BoxG(0.5, 0.04, 0.04), '#f4f4f6', at(0, Math.sin(a) * FW.r, Math.cos(a) * FW.r))); }
      wp.push(part(CylG(0.26, 0.26, 0.62, 12), '#3b4b5b', (g) => g.rotateZ(Math.PI / 2)));
      wheel = new THREE.Mesh(merge(wp), MAT.plain); wheel.position.set(FW.x, FW.y, FW.z); wheel.name = 'pariserhjul'; root.add(wheel);
      // karusell (roterer)
      const cp = [
        part(CylG(1.6, 1.7, 0.18, 24), '#f6efe0', at(0, 0.09, 0)),
        part(CylG(0.2, 0.2, 1.5, 10), '#f3c54a', at(0, 0.9, 0)),
        striped(new THREE.ConeGeometry(1.9, 0.75, 16), 16, '#e63946', '#fafafa', at(0, 1.98, 0)),
        striped(CylG(1.9, 1.9, 0.2, 16, true), 16, '#fafafa', '#e63946', at(0, 1.52, 0)),
        part(new THREE.SphereGeometry(0.13, 8, 6), '#f2c14e', at(0, 2.42, 0)),
      ];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2, x = Math.cos(a) * 1.25, z = Math.sin(a) * 1.25;
        cp.push(part(CylG(0.02, 0.02, 1.3, 5), '#f2c14e', at(x, 0.85, z)));
        cp.push(part(BoxG(0.1, 0.17, 0.34), RAINBOW[i % RAINBOW.length], (g) => { g.rotateY(-a); g.translate(x, 0.62 + (i % 2) * 0.12, z); }));
      }
      carousel = new THREE.Mesh(merge(cp), MAT.plain); carousel.position.set(31, GY, -5.2); carousel.name = 'karusell'; root.add(carousel);
      // fritt fall-tårn
      pushBox(city, 38.2, GY, -6, 0.45, 8.2, 0.45, 0, C('#e8eef2'));
      for (let i = 0; i < 8; i++) pushBox(city, 38.2, GY + 0.5 + i, -6, 0.47, 0.25, 0.47, 0, C('#e63946'));
      pushBox(city, 38.2, GY + 8.2, -6, 0.8, 0.3, 0.8, 0, C('#ffd23f'));
      dropCar = new THREE.Mesh(merge([
        part(CylG(0.62, 0.62, 0.3, 16, true), '#ffd23f'),
        part(CylG(0.62, 0.62, 0.05, 16), '#3b4b5b', at(0, -0.16, 0)),
        part(CylG(0.66, 0.66, 0.06, 16), '#1d8fe1', at(0, 0.17, 0)),
      ]), MAT.plain);
      dropCar.material = MAT.plain; dropCar.position.set(38.2, GY + 0.6, -6); root.add(dropCar);
      // telt og boder
      for (const [x, z, c] of [[29.6, 5.4, '#1d8fe1'], [31.8, 7.6, '#e63946'], [29.2, 8.0, '#7b4fd8'], [33.0, 5.2, '#2a9d8f']]) {
        stamp(city, striped(CylG(0.62, 0.62, 0.55, 12), 12, c, '#fafafa', at(0, 0.275, 0)), x, GY, z);
        stamp(city, striped(new THREE.ConeGeometry(0.75, 0.6, 12), 12, '#fafafa', c, at(0, 0.85, 0)), x, GY, z);
      }
      for (let i = 0; i < 4; i++) {
        const x = 29 + i * 2.3, z = -8.2;
        pushBox(city, x, GY, z, 1.2, 0.55, 0.7, 0, C('#fff3dc'));
        pushBox(city, x, GY + 0.55, z + 0.1, 1.35, 0.06, 0.9, 0, C(AWN[i]));
      }
      for (const [x, z] of [[27.8, -8.6], [27.8, 8.6], [40, 8.6], [40, -8.6], [34.6, 8.5], [27.9, 4.5], [27.9, -4.5]]) addTree(treesCity, x, z, GY + 0.05, 1.1);
      for (let i = 0; i < 6; i++) stamp(city, lampGeo, 28.6 + i * 2.2, GY + 0.05, -2.45);
    }

    // ---------- Statiske, sammenslåtte mesher ----------
    function addMesh(batch, mat, name, cast, recv) {
      if (!batch.count()) return null;
      const m = new THREE.Mesh(batch.geometry(THREE), mat); m.name = name; m.castShadow = !!cast; m.receiveShadow = !!recv;
      m.matrixAutoUpdate = false; m.updateMatrix(); root.add(m); return m;
    }
    // Nær del kaster og mottar skygge (solas skyggeområde følger kameraet nær brettet); bakken langt ute mottar også.
    addMesh(city.near, MAT.plain, 'by-nær', true, true);
    addMesh(city.far, MAT.plain, 'by', false, true);
    addMesh(fac.near, MAT.fac, 'fasader-nær', true, true);
    addMesh(fac.far, MAT.fac, 'fasader', false, false);
    addMesh(plaza, MAT.plain, 'plass-detaljer', true, true);
    addMesh(water, MAT.water, 'vann');

    // ---------- Instanser ----------
    const _M = new THREE.Matrix4(), _dummy = new THREE.Object3D(); _dummy.rotation.order = 'YXZ';
    function setM(mesh, i, x, y, z, ry, s, sy) {
      const c = Math.cos(ry), n = Math.sin(ry), e = _M.elements;
      e[0] = c * s; e[1] = 0; e[2] = -n * s; e[3] = 0;
      e[4] = 0; e[5] = sy; e[6] = 0; e[7] = 0;
      e[8] = n * s; e[9] = 0; e[10] = c * s; e[11] = 0;
      e[12] = x; e[13] = y; e[14] = z; e[15] = 1;
      mesh.setMatrixAt(i, _M);
    }
    function instanced(geo, mat, n, name, dynamic) {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n)); m.count = n; m.name = name;
      if (dynamic) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; }
      root.add(m); return m;
    }
    function staticInst(list, geo, mat, name, cast) {
      if (!list.length) return null;
      const m = instanced(geo, mat, list.length, name, false);
      list.forEach((t, i) => { setM(m, i, t.x, t.y, t.z, rnd() * 6.28, t.s, t.s * (t.sy || 1)); m.setColorAt(i, C(t.c)); });
      m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); m.castShadow = !!cast; return m;
    }
    // Bytrær: full detalj nær brettet, enklere krone (20 trekanter) lenger ute.
    const treeGeoLow = merge([
      part(new THREE.CylinderGeometry(0.045, 0.06, 0.42, 5, 1, true), '#7a5232', at(0, 0.21, 0)),
      part(new THREE.IcosahedronGeometry(0.37, 0), '#ffffff', (g) => { g.scale(1, 1.08, 1); g.translate(0, 0.68, 0); }),
    ]);
    const cheb = (t) => Math.max(Math.abs(t.x), Math.abs(t.z));
    // Trærne på plassen og bytrærne nær brettet deler én mesh som kaster skygge.
    staticInst(treesPlaza.concat(treesCity.filter((t) => cheb(t) < NEAR_R)), treeGeo, MAT.marker, 'trær-nær', true);
    staticInst(treesCity.filter((t) => cheb(t) >= NEAR_R && cheb(t) < 27), treeGeo, MAT.marker, 'trær-by', false);
    staticInst(treesCity.filter((t) => cheb(t) >= 27), treeGeoLow, MAT.marker, 'trær-by-fjern', false);
    staticInst(conifers, pineGeo, MAT.marker, 'granskog', false);
    // Kontaktskygger under trær (litt forskjøvet bort fra sola). Trær på øyene (under bakkenivå) hoppes over.
    for (const t of treesPlaza) aoB.disc(t.x + SHX * 0.08 * t.s, t.y + 0.012, t.z + SHZ * 0.08 * t.s, 0.42 * t.s, 0.5);
    for (const t of treesCity) {
      if (t.y < GY - 0.02 || cheb(t) > AO_FAR) continue;
      aoB.disc(t.x + SHX * 0.08 * t.s, Math.max(t.y, GY + 0.05) + 0.008, t.z + SHZ * 0.08 * t.s, 0.42 * t.s, 0.45, 7);
    }

    // Flagg
    let flagMesh = null;
    if (flags.length) {
      const fg = new THREE.PlaneGeometry(1, 0.727, 12, 4); fg.translate(0.5, -0.3635, 0);
      flagMesh = instanced(fg, MAT.flag, flags.length, 'flagg', false);
      flags.forEach((f, i) => setM(flagMesh, i, f.x, f.y, f.z, 0, f.s, f.s));
      flagMesh.instanceMatrix.needsUpdate = true; flagMesh.frustumCulled = false;
    }

    // Fontenesprut (partikler i shader)
    {
      const per = Math.round(110 * Q), n = fountains.length * per;
      const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4), scl = new Float32Array(n);
      let k = 0;
      for (const f of fountains) for (let i = 0; i < per; i++, k++) {
        pos[k * 3] = f.x; pos[k * 3 + 1] = f.y; pos[k * 3 + 2] = f.z;
        seed[k * 4] = rnd(); seed[k * 4 + 1] = rnd() * Math.PI * 2; seed[k * 4 + 2] = rnd(); seed[k * 4 + 3] = rnd();
        scl[k] = f.s;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
      g.setAttribute('aScale', new THREE.BufferAttribute(scl, 1));
      const pts = new THREE.Points(g, sprayMaterial(THREE, uTime, uHalfH)); pts.frustumCulled = false; pts.name = 'fontener'; root.add(pts);
    }

    // ---------- Kjøretøy ----------
    const wheelsAt = (xs, z, r, w) => xs.flatMap((x) => [z, -z].map((zz) => part(CylG(r, r, w, 8), '#1d1f24', (g) => { g.rotateX(Math.PI / 2); g.translate(x, r, zz); })));
    const carGeo = merge([
      part(BoxG(0.54, 0.1, 0.24), '#ffffff', at(0, 0.085, 0)),
      part(BoxG(0.3, 0.085, 0.21), '#2b3a4f', at(-0.03, 0.175, 0)),
      part(BoxG(0.27, 0.02, 0.215), '#ffffff', at(-0.03, 0.225, 0)),
      part(BoxG(0.02, 0.03, 0.18), '#fff6c8', at(0.27, 0.1, 0)),
      part(BoxG(0.02, 0.03, 0.18), '#d6283a', at(-0.27, 0.1, 0)),
    ].concat(wheelsAt([0.17, -0.17], 0.105, 0.05, 0.045)));
    const busGeo = merge([
      part(BoxG(1.0, 0.27, 0.28), '#e2231a', at(0, 0.19, 0)),
      part(BoxG(0.96, 0.1, 0.285), '#25354a', at(0, 0.26, 0)),
      part(BoxG(0.02, 0.1, 0.24), '#25354a', at(0.505, 0.24, 0)),
      part(BoxG(0.9, 0.03, 0.24), '#f2f2f2', at(0, 0.34, 0)),
    ].concat(wheelsAt([0.32, -0.3], 0.13, 0.06, 0.05)));
    const tramGeo = merge([
      part(BoxG(0.9, 0.07, 0.26), '#2a2f38', at(0, 0.05, 0)),
      part(BoxG(1.15, 0.27, 0.32), '#1565c0', at(0, 0.22, 0)),
      part(BoxG(1.1, 0.11, 0.326), '#22344a', at(0, 0.28, 0)),
      part(BoxG(1.155, 0.025, 0.324), '#f4f6f8', at(0, 0.19, 0)),
      part(BoxG(1.08, 0.04, 0.28), '#dfe5ec', at(0, 0.375, 0)),
      part(BoxG(0.02, 0.1, 0.02), '#3b3f46', at(0, 0.44, 0)),
      part(BoxG(0.03, 0.02, 0.22), '#3b3f46', at(0, 0.49, 0)),
    ]);
    const lanes = [{ ring: true, a: 10.45, dir: 1, v: 1.7, n: 7 }, { ring: true, a: 11.95, dir: -1, v: 1.55, n: 7 }];
    for (const c of CAR_X) for (const dir of [1, -1]) lanes.push({ ax: 'z', c: c - dir * 0.33, from: -26.5, to: 63, dir, v: 2.2 + rnd() * 0.7, n: 4 });
    for (const c of CAR_Z) for (const dir of [1, -1]) lanes.push({ ax: 'x', c: c + dir * 0.33, from: -63, to: 63, dir, v: 2.2 + rnd() * 0.7, n: 5, bus: true });
    const vehicles = [];
    let nCar = 0, nBus = 0;
    for (const L of lanes) {
      const n = Math.max(1, Math.round(L.n * Q)), len = L.ring ? ringLen(L.a) : L.to - L.from;
      for (let i = 0; i < n; i++) {
        const isBus = L.bus && i === 0;
        vehicles.push({ L, off: (i + rnd() * 0.3) * (len / n), bus: isBus, idx: isBus ? nBus++ : nCar++ });
      }
    }
    const carMesh = instanced(carGeo, MAT.marker, nCar, 'biler', true);
    const busMesh = instanced(busGeo, MAT.plain, nBus, 'busser', true);
    for (let i = 0; i < nCar; i++) carMesh.setColorAt(i, C(CARS[i % CARS.length]));
    const TRAMS = 2, TSEG = 3, tramA = 11.2;
    const tramMesh = instanced(tramGeo, MAT.plain, TRAMS * TSEG, 'trikk', true);

    // ---------- Folk ----------
    const personGeo = merge([
      part(BoxG(0.05, 0.09, 0.07), '#2f3542', at(0, 0.045, 0)),
      part(CylG(0.035, 0.042, 0.09, 6), '#ffffff', at(0, 0.135, 0)),
      part(new THREE.SphereGeometry(0.03, 6, 5), '#f2c9a0', at(0, 0.205, 0)),
    ]);
    const walkers = [];
    const addW = (n, mk) => { for (let i = 0; i < Math.round(n * Q); i++) walkers.push(mk(i)); };
    addW(40, (i) => ({ ring: true, a: 8.35 + rnd() * 0.15, dir: i % 2 ? 1 : -1, s0: rnd() * 70, v: 0.25 + rnd() * 0.15, y: GY }));
    addW(28, (i) => ({ ring: true, a: 12.6 + rnd() * 0.2, dir: i % 2 ? 1 : -1, s0: rnd() * 90, v: 0.25 + rnd() * 0.15, y: GY }));
    const line = (x0, z0, x1, z1, y) => () => ({ x0, z0, x1, z1, s0: rnd() * 100, v: 0.25 + rnd() * 0.15, y, off: (rnd() - 0.5) * 0.6 });
    addW(16, line(0, 13.6, 0, 62, GY + 0.008));
    addW(6, line(0, -13.6, 0, -26, GY + 0.008));
    addW(12, line(-25, -28.6, 4, -28.6, GY + 0.016));
    addW(6, line(-26, 0, -14, 0, GY + 0.008));
    addW(8, line(28, -1.5, 40, -1.5, GY + 0.056));
    addW(4, line(-33, 0, -40, 0, GY + 0.056));
    const peopleMesh = instanced(personGeo, MAT.marker, walkers.length, 'folk', true);
    walkers.forEach((w, i) => peopleMesh.setColorAt(i, C(pick(SHIRT))));

    // Kontaktskygger under kjøretøy og gående: én instansiert mesh (enhetsfotavtrykk 1 × 1 med myk kant),
    // rekkefølge [biler][busser][trikkeledd][gående]. Oppdateres i update() uten allokering.
    const unitBlob = new AOBatch(); unitBlob.rect(0, 0, 0, 0.62, 0.62, 0, 0.6, 0.19, true);
    const NB0 = nCar, NB1 = NB0 + nBus, NB2 = NB1 + TRAMS * TSEG, NBLOB = NB2 + walkers.length;
    const blobMesh = instanced(unitBlob.geometry(THREE), MAT.ao, NBLOB, 'kontaktskygger-trafikk', true);
    function setBlob(i, x, y, z, ry, sx, sz) {
      const c = Math.cos(ry), n = Math.sin(ry), e = _M.elements;
      e[0] = c * sx; e[1] = 0; e[2] = -n * sx; e[3] = 0;
      e[4] = 0; e[5] = 1; e[6] = 0; e[7] = 0;
      e[8] = n * sz; e[9] = 0; e[10] = c * sz; e[11] = 0;
      e[12] = x + SHX * 0.025; e[13] = y; e[14] = z + SHZ * 0.025; e[15] = 1;
      blobMesh.setMatrixAt(i, _M);
    }

    // ---------- Båter ----------
    const wakeTris = (x0, x1, w0, w1) => [[[x0, 0.03, w0], [x1, 0.03, w1], [x1, 0.03, w1 - 0.16]], [[x0, 0.03, w0], [x1, 0.03, w1 - 0.16], [x0, 0.03, w0 - 0.1]],
      [[x0, 0.03, -w0], [x1, 0.03, -w1 + 0.16], [x1, 0.03, -w1]], [[x0, 0.03, -w0], [x0, 0.03, -w0 + 0.1], [x1, 0.03, -w1 + 0.16]]];
    const ferryGeo = merge([
      part(BoxG(3.0, 0.34, 0.8), '#f3f4f6', at(0, 0.1, 0)),
      part(BoxG(3.02, 0.09, 0.82), '#1f4e9e', at(0, 0.0, 0)),
      part(BoxG(2.2, 0.26, 0.7), '#fafafa', at(-0.1, 0.4, 0)),
      part(BoxG(2.21, 0.1, 0.71), '#253447', at(-0.1, 0.42, 0)),
      part(BoxG(1.1, 0.22, 0.6), '#fafafa', at(0.2, 0.64, 0)),
      part(BoxG(1.11, 0.08, 0.61), '#253447', at(0.2, 0.66, 0)),
      part(BoxG(0.16, 0.34, 0.16), '#1f4e9e', at(-0.4, 0.9, 0)),
      triGeo(wakeTris(-1.5, -4.6, 0.32, 1.25), '#eaf8ff', true),
    ]);
    const sailGeo = merge([
      part(BoxG(1.0, 0.14, 0.3), '#ffffff', at(0, 0.05, 0)),
      part(BoxG(0.9, 0.02, 0.26), '#d9b38c', at(0, 0.13, 0)),
      part(CylG(0.015, 0.015, 1.3, 5), '#e8e8e8', at(0.05, 0.78, 0)),
      triGeo([[[0.05, 0.2, 0], [0.05, 1.38, 0], [-0.45, 0.2, 0]]], '#fafafa', true),
      triGeo([[[0.07, 1.18, 0], [0.5, 0.18, 0], [0.07, 0.2, 0]]], '#f7d046', true),
    ]);
    const speedGeo = merge([
      part(BoxG(0.7, 0.12, 0.26), '#ffffff', at(0, 0.05, 0)),
      part(BoxG(0.25, 0.08, 0.22), '#253447', at(0.05, 0.15, 0)),
      triGeo(wakeTris(-0.35, -2.2, 0.12, 0.6), '#eaf8ff', true),
    ]);
    const routes = {
      ferry: [[-14, -50, 10, 12, 0.09, 0], [24, -52, 8, 10, -0.1, 2]],
      sail: [[-38, -45, 4, 4, 0.12, 0], [42, -44, 4, 4, -0.1, 1], [6, -64, 5, 5, 0.09, 2], [-30, -72, 5, 5, -0.08, 3], [40, -64, 5, 5, 0.1, 4], [-8, -80, 5, 5, -0.09, 5]],
      speed: [[12, -92, 7, 7, 0.45, 0], [-22, -92, 6, 6, -0.5, 1]],
    };
    if (low) { routes.ferry.length = 1; routes.sail.length = 3; routes.speed.length = 1; }
    const boats = [];
    const ferryMesh = instanced(ferryGeo, MAT.markerDS, routes.ferry.length, 'ferjer', true);
    const sailMesh = instanced(sailGeo, MAT.markerDS, routes.sail.length, 'seilbåter', true);
    const speedMesh = instanced(speedGeo, MAT.markerDS, routes.speed.length, 'speedbåter', true);
    routes.ferry.forEach((r, i) => boats.push({ m: ferryMesh, i, r, heel: 0 }));
    routes.sail.forEach((r, i) => { boats.push({ m: sailMesh, i, r, heel: 0.12 }); sailMesh.setColorAt(i, C(['#e63946', '#1d6fd8', '#f4f4f4', '#2a9d8f', '#ff7f2a', '#264653'][i % 6])); });
    routes.speed.forEach((r, i) => { boats.push({ m: speedMesh, i, r, heel: 0.04 }); speedMesh.setColorAt(i, C(['#e63946', '#f4c430'][i % 2])); });

    // ---------- Måker ----------
    const birdGeo = merge([
      part(BoxG(0.12, 0.03, 0.035), '#f5f5f5'),
      triGeo([[[0.04, 0, 0.01], [-0.04, 0, 0.01], [-0.02, 0.06, 0.22]], [[0.04, 0, -0.01], [-0.02, 0.06, -0.22], [-0.04, 0, -0.01]]], '#f2f4f6', true),
      triGeo([[[-0.005, 0.045, 0.17], [-0.035, 0.045, 0.17], [-0.02, 0.06, 0.22]], [[-0.005, 0.045, -0.17], [-0.02, 0.06, -0.22], [-0.035, 0.045, -0.17]]], '#3a3f47', true),
    ]);
    const flocks = [[-5, 6.5, -40, 9, 0.35], [0, 6.0, 0, 18, -0.22], [34, 8, 1, 6, 0.4], [-30, 7, -60, 7, -0.3]];
    const birds = [];
    for (const [fx, fy, fz, fr, fw] of flocks) for (let i = 0; i < Math.round(6 * Q); i++) birds.push({ fx, fy: fy + rnd() * 1.5, fz, r: fr + (rnd() - 0.5) * 2, w: fw * (0.9 + rnd() * 0.2), ph: rnd() * 6.28, fl: 7 + rnd() * 3 });
    const birdMesh = instanced(birdGeo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 }), birds.length, 'måker', true);

    // ---------- Skyer ----------
    const puffs = [[0, 0, 0, 1], [1.1, -0.15, 0.2, 0.75], [-1.1, -0.2, -0.1, 0.8], [0.4, 0.45, 0.1, 0.7], [-0.4, 0.35, -0.2, 0.65], [0.2, -0.3, 0.7, 0.6]];
    const cloudGeo = merge(puffs.map(([x, y, z, s]) => part(new THREE.IcosahedronGeometry(s, 1), '#ffffff', (g) => { g.scale(1, 0.72, 1); g.translate(x, y, z); })));
    const clouds = [];
    for (let i = 0; i < (low ? 8 : 14); i++) clouds.push({ x: (rnd() - 0.5) * 320, y: 24 + rnd() * 14, z: (rnd() < 0.5 ? -1 : 1) * (62 + rnd() * 85), s: 4 + rnd() * 5, v: 0.6 + rnd() * 0.6, ry: rnd() * 6 });
    const cloudMesh = instanced(cloudGeo, MAT.cloud, clouds.length, 'skyer', true);

    // ---------- Tilskuere (instansiert; hopper og vifter ved cheer) ----------
    const withArm = (g, a) => { g.setAttribute('aArm', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(a), 1)); return g; };
    const specGeo = merge([
      withArm(part(BoxG(0.056, 0.09, 0.045), '#2f3542', at(0, 0.045, 0)), 0),
      withArm(part(CylG(0.036, 0.044, 0.095, 5), '#ffffff', at(0, 0.137, 0)), 0),
      withArm(part(new THREE.SphereGeometry(0.031, 5, 4), '#f2c9a0', at(0, 0.21, 0)), 0),
      withArm(part(new THREE.SphereGeometry(0.034, 5, 2, 0, Math.PI * 2, 0, Math.PI / 2), '#4a3020', at(0, 0.214, 0)), 0),
      withArm(part(BoxG(0.02, 0.085, 0.02), '#ffffff', at(-0.047, 0.1325, 0)), -1),
      withArm(part(BoxG(0.02, 0.085, 0.02), '#ffffff', at(0.047, 0.1325, 0)), 1),
    ]);
    const specs = low ? SPEC.filter((_, i) => i % 2 === 0) : SPEC;
    const NS = specs.length;
    const specCheer = new Float32Array(Math.max(1, NS)), specUntil = new Float32Array(Math.max(1, NS)), specStart = new Float32Array(Math.max(1, NS)), specFace = new Float32Array(Math.max(1, NS));
    specGeo.setAttribute('aCheer', new THREE.InstancedBufferAttribute(specCheer, 1));
    specGeo.attributes.aCheer.setUsage(THREE.DynamicDrawUsage);
    const specMesh = instanced(specGeo, crowdMaterial(THREE, uTime), NS, 'tilskuere', false);
    specs.forEach((p, i) => { setM(specMesh, i, p.x, p.y, p.z, p.ry, p.s, p.s); specMesh.setColorAt(i, C(pick(SHIRT))); specFace[i] = p.ry; });
    specMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); specMesh.instanceMatrix.needsUpdate = true; specMesh.computeBoundingSphere();
    // Kontaktskygger under tilskuerne. Alle statiske flekker (aoB) legges sammen med tomtenes i én mesh i rebuildStatic().
    for (const p of specs) aoB.disc(p.x + SHX * 0.012, p.y + 0.012, p.z + SHZ * 0.012, 0.08 * p.s, 0.5, 6);

    let tNow = 0, cheerEnd = -10, dirty = true, lastWall = 0;
    const skipping = () => !!(MP.Board3D && MP.Board3D.skipping);
    const groundY = (x, z) => (Math.abs(x) < 6.66 && Math.abs(z) < 6.66 ? 0.01 : GY + 0.01);
    const ZERO = new THREE.Matrix4().makeScale(0, 0, 0), _col = new THREE.Color(), _col2 = new THREE.Color();

    // ---------- Konfetti (instansiert pool) ----------
    const CN = low ? 160 : 320;
    const confMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.075, 0.045),
      new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.5, metalness: 0.05, emissive: 0x333333 }), CN);
    confMesh.name = 'konfetti'; confMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); confMesh.frustumCulled = false; confMesh.visible = false;
    for (let i = 0; i < CN; i++) { confMesh.setMatrixAt(i, ZERO); confMesh.setColorAt(i, C('#ffffff')); }
    root.add(confMesh);
    const cP = new Float32Array(CN * 3), cV = new Float32Array(CN * 3), cR = new Float32Array(CN * 3), cW = new Float32Array(CN * 3);
    const cAge = new Float32Array(CN).fill(1), cLife = new Float32Array(CN).fill(0), cG = new Float32Array(CN);
    let cNext = 0, cAlive = 0;
    function confetti(x, y, z, n, dirx, dirz, cols, power) {
      for (let k = 0; k < n; k++) {
        const i = cNext; cNext = (cNext + 1) % CN; const j = i * 3;
        const a = Math.random() * Math.PI * 2, sp = Math.random() * 0.9, up = (power || 4) * (0.75 + Math.random() * 0.35);
        cP[j] = x; cP[j + 1] = y; cP[j + 2] = z;
        cV[j] = Math.cos(a) * sp + (dirx || 0); cV[j + 1] = up; cV[j + 2] = Math.sin(a) * sp + (dirz || 0);
        cR[j] = Math.random() * 6.3; cR[j + 1] = Math.random() * 6.3; cR[j + 2] = Math.random() * 6.3;
        cW[j] = (Math.random() - 0.5) * 16; cW[j + 1] = (Math.random() - 0.5) * 10; cW[j + 2] = (Math.random() - 0.5) * 16;
        cAge[i] = 0; cLife[i] = 2.6 + Math.random() * 1.2; cG[i] = groundY(x, z) + 0.004;
        confMesh.setColorAt(i, C(cols[(Math.random() * cols.length) | 0]));
      }
      confMesh.instanceColor.needsUpdate = true; confMesh.visible = true; cAlive = 1;
    }
    function updateConfetti(dt) {
      if (!cAlive) return;
      cAlive = 0;
      const drag = Math.exp(-2.4 * dt);
      for (let i = 0; i < CN; i++) {
        if (cAge[i] >= cLife[i]) continue;
        cAge[i] += dt;
        if (cAge[i] >= cLife[i]) { confMesh.setMatrixAt(i, ZERO); continue; }
        cAlive++;
        const j = i * 3;
        if (cP[j + 1] > cG[i]) {
          cV[j + 1] -= 7.0 * dt; cV[j] *= drag; cV[j + 2] *= drag;
          if (cV[j + 1] < -0.75) cV[j + 1] = -0.75;
          cP[j] += cV[j] * dt; cP[j + 1] += cV[j + 1] * dt; cP[j + 2] += cV[j + 2] * dt;
          cR[j] += cW[j] * dt; cR[j + 1] += cW[j + 1] * dt; cR[j + 2] += cW[j + 2] * dt;
          if (cP[j + 1] <= cG[i]) { cP[j + 1] = cG[i]; cR[j] = -Math.PI / 2; cR[j + 2] = 0; }
        }
        const left = cLife[i] - cAge[i], s = left < 0.4 ? left / 0.4 : 1;
        _dummy.position.set(cP[j], cP[j + 1], cP[j + 2]); _dummy.rotation.set(cR[j], cR[j + 1], cR[j + 2]); _dummy.scale.set(s, s, s);
        _dummy.updateMatrix(); confMesh.setMatrixAt(i, _dummy.matrix);
      }
      confMesh.instanceMatrix.needsUpdate = true;
      if (!cAlive) confMesh.visible = false;
    }

    // ---------- Røyk og støv (instansierte, myke billboard-dotter) ----------
    // Hver dott er et kvadrat som vender mot kameraet (shader), med myk rund tekstur, rotasjon og alfa-fade.
    const PN = low ? 70 : 130;
    const puffGeo = new THREE.PlaneGeometry(1, 1);
    const pAlpha = new Float32Array(PN), pRotA = new Float32Array(PN);
    puffGeo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    puffGeo.setAttribute('aRot', new THREE.InstancedBufferAttribute(pRotA, 1).setUsage(THREE.DynamicDrawUsage));
    const puffMesh = new THREE.InstancedMesh(puffGeo, puffMaterial(THREE, puffTexture(THREE)), PN);
    puffMesh.name = 'røyk'; puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); puffMesh.frustumCulled = false; puffMesh.visible = false;
    puffMesh.renderOrder = 2;
    for (let i = 0; i < PN; i++) { puffMesh.setMatrixAt(i, ZERO); puffMesh.setColorAt(i, C('#ffffff')); }
    root.add(puffMesh);
    const pP = new Float32Array(PN * 3), pV = new Float32Array(PN * 3), pC = new Float32Array(PN * 6);
    const pAge = new Float32Array(PN).fill(1), pLife = new Float32Array(PN).fill(0), pS0 = new Float32Array(PN), pS1 = new Float32Array(PN);
    const pSpin = new Float32Array(PN), pGround = new Float32Array(PN), pOp = new Float32Array(PN);
    let pNext = 0, pAlive = 0;
    function puff(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, op) {
      const i = pNext; pNext = (pNext + 1) % PN; const j = i * 3, q = i * 6;
      pP[j] = x; pP[j + 1] = y; pP[j + 2] = z; pV[j] = vx; pV[j + 1] = vy; pV[j + 2] = vz;
      pAge[i] = 0; pLife[i] = life; pS0[i] = s0; pS1[i] = s1;
      pC[q] = c0.r; pC[q + 1] = c0.g; pC[q + 2] = c0.b; pC[q + 3] = c1.r; pC[q + 4] = c1.g; pC[q + 5] = c1.b;
      pRotA[i] = Math.random() * 6.283; pSpin[i] = (Math.random() - 0.5) * 1.4; pGround[i] = y; pOp[i] = op || 0.85;
      puffMesh.visible = true; pAlive = 1;
    }
    const DUST0 = C('#c9b08a'), DUST1 = C('#eee4d2'), SMOKE0 = C('#45464d'), SMOKE1 = C('#d3d6db');
    function dust(x, y, z, n, rad) {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + Math.random() * 0.6, r = rad * (0.6 + Math.random() * 0.5);
        puff(x + Math.cos(a) * r, y + 0.03, z + Math.sin(a) * r, Math.cos(a) * 0.35, 0.18 + Math.random() * 0.2, Math.sin(a) * 0.35, 0.8 + Math.random() * 0.35, 0.035, 0.1 + Math.random() * 0.05, DUST0, DUST1, 0.75);
      }
    }
    const emitters = [0, 1, 2, 3].map(() => ({ on: false, x: 0, y: 0, z: 0, until: 0, acc: 0 }));
    function smoke(x, z, seconds) {
      if (skipping()) return;
      let e = emitters[0];
      for (let k = 0; k < emitters.length; k++) if (!emitters[k].on) { e = emitters[k]; break; }
      e.on = true; e.x = x; e.z = z; e.y = groundY(x, z); e.until = tNow + Math.max(0.5, seconds || 4); e.acc = 0;
    }
    function updatePuffs(dt) {
      for (let k = 0; k < emitters.length; k++) {
        const e = emitters[k];
        if (!e.on) continue;
        if (tNow > e.until) { e.on = false; continue; }
        e.acc += dt * 16;
        while (e.acc >= 1) {
          e.acc -= 1;
          puff(e.x + (Math.random() - 0.5) * 0.2, e.y + 0.08, e.z + (Math.random() - 0.5) * 0.2, 0.13 + (Math.random() - 0.5) * 0.34, 1.0 + Math.random() * 0.5, 0.06 + (Math.random() - 0.5) * 0.34,
            2.4 + Math.random() * 0.8, 0.08, 0.3 + Math.random() * 0.16, SMOKE0, SMOKE1, 0.88);
        }
      }
      if (!pAlive) return;
      pAlive = 0;
      for (let i = 0; i < PN; i++) {
        if (pAge[i] >= pLife[i]) continue;
        pAge[i] += dt;
        if (pAge[i] >= pLife[i]) { puffMesh.setMatrixAt(i, ZERO); pAlpha[i] = 0; continue; }
        pAlive++;
        const j = i * 3, q = i * 6, f = pAge[i] / pLife[i];
        pV[j] *= Math.exp(-0.6 * dt); pV[j + 2] *= Math.exp(-0.6 * dt); pV[j + 1] *= Math.exp(-0.5 * dt);
        pP[j] += (pV[j] + Math.sin(pAge[i] * 2.3 + i) * 0.08) * dt; pP[j + 1] += pV[j + 1] * dt; pP[j + 2] += (pV[j + 2] + Math.cos(pAge[i] * 1.9 + i) * 0.08) * dt;
        // vokser mykt hele livet; tones inn raskt og ut mot slutten (ingen krymping)
        const s = pS0[i] + (pS1[i] - pS0[i]) * (1 - (1 - f) * (1 - f)), Q2 = 2.5 * s;
        pRotA[i] += pSpin[i] * dt * (1 - 0.6 * f);
        pAlpha[i] = pOp[i] * sstep(0, 0.1, f) * (1 - sstep(0.4, 1, f));
        // billboardet holdes over bakken så det ikke kuttes av flisene
        setM(puffMesh, i, pP[j], Math.max(pP[j + 1], pGround[i] + Q2 * 0.32), pP[j + 2], 0, Q2, Q2);
        const g = Math.min(1, f * 1.6);
        _col.setRGB(pC[q] + (pC[q + 3] - pC[q]) * g, pC[q + 1] + (pC[q + 4] - pC[q + 1]) * g, pC[q + 2] + (pC[q + 5] - pC[q + 2]) * g);
        puffMesh.setColorAt(i, _col);
      }
      puffMesh.instanceMatrix.needsUpdate = true; puffMesh.instanceColor.needsUpdate = true;
      puffGeo.attributes.aAlpha.needsUpdate = true; puffGeo.attributes.aRot.needsUpdate = true;
      if (!pAlive) puffMesh.visible = false;
    }

    // ---------- Jubel ----------
    const CHEER_COLS = ['#e63946', '#ffd23f', '#1d8fe1', '#3bb273', '#ff8c1a', '#f15bb5', '#ffffff'];
    // Velger tilskuere nær (x, z) som også er i kameraets bilde (MP.Board3D.camera eller opts.camera),
    // så jubelen faktisk synes. Faller tilbake til de nærmeste uansett bilde hvis ingen er synlige.
    const specVis = new Uint8Array(Math.max(1, NS)), _cv = new THREE.Vector3();
    function inShot(cam, x, y, z) {
      _cv.set(x, y, z).project(cam);   // bruker projectionMatrix (inkl. setViewOffset) og matrixWorldInverse
      return _cv.z > -1 && _cv.z < 1 && Math.abs(_cv.x) < 0.94 && _cv.y > -0.8 && _cv.y < 0.92;
    }
    function cheer(x, z, opts) {
      if (skipping()) return;
      const B = MP.Board3D, cam = (opts && opts.camera) || (B && B.camera && B.camera.isCamera ? B.camera : null);
      if (cam) cam.updateMatrixWorld();
      let nVis = 0;
      for (let i = 0; i < NS; i++) { specVis[i] = !cam || inShot(cam, specs[i].x, specs[i].y + 0.12, specs[i].z) ? 1 : 0; nVis += specVis[i]; }
      // minste radius med nok synlige tilskuere
      let R = 0;
      for (const r of [3.2, 5.5, 8, 11, 15]) {
        let n = 0;
        for (let i = 0; i < NS; i++) { if (!specVis[i]) continue; const dx = specs[i].x - x, dz = specs[i].z - z; if (dx * dx + dz * dz < r * r) n++; }
        if (n >= 12 || (r === 15 && n > 0)) { R = r; break; }
      }
      const useVis = R > 0;
      if (!useVis) R = 9;   // ingen synlige i nærheten: som før, de nærmeste
      let sx = 0, sz = 0, sn = 0;
      for (let i = 0; i < NS; i++) {
        const p = specs[i], dx = x - p.x, dz = z - p.z, d2 = dx * dx + dz * dz;
        // synlige innen R, pluss alle helt nær punktet
        if (!(d2 < 3.2 * 3.2 || (d2 < R * R && (!useVis || specVis[i])))) continue;
        if (useVis && sn >= 48 && d2 > 3.2 * 3.2) continue;
        specStart[i] = tNow + Math.random() * 0.25; specUntil[i] = specStart[i] + 2.2 + Math.random() * 0.8;
        specFace[i] = Math.atan2(dx, dz);
        cheerEnd = Math.max(cheerEnd, specUntil[i]);
        if (specVis[i]) { sx += p.x; sz += p.z; sn++; }
      }
      // Konfettien skytes fra punktet hvis det er i bildet, ellers midt i de synlige tilskuerne.
      let cx = x, cz = z;
      if (cam && sn && !inShot(cam, x, groundY(x, z) + 0.4, z)) { cx = sx / sn; cz = sz / sn; }
      const cols = opts && opts.color ? CHEER_COLS.concat([opts.color, opts.color]) : CHEER_COLS;
      const r = Math.hypot(cx, cz) || 1, px = -cz / r, pz = cx / r, y = groundY(cx, cz) + 0.05, n = low ? 45 : 80;
      confetti(cx + px * 0.5, y, cz + pz * 0.5, n, -cx / r * 0.5, -cz / r * 0.5, cols, 4.2);
      confetti(cx - px * 0.5, y, cz - pz * 0.5, n, -cx / r * 0.5, -cz / r * 0.5, cols, 4.2);
      return sn;
    }
    function updateCrowd() {
      if (tNow > cheerEnd + 0.5) return;
      for (let i = 0; i < NS; i++) {
        const p = specs[i];
        let k = 0;
        if (tNow < specUntil[i] && tNow > specStart[i]) k = Math.min(1, (tNow - specStart[i]) * 5, (specUntil[i] - tNow) * 3);
        if (k <= 0 && specCheer[i] === 0) continue;
        specCheer[i] = k > 0 ? k : 0;
        const jump = specCheer[i] * Math.abs(Math.sin(tNow * 9 + i * 1.3)) * 0.085;
        setM(specMesh, i, p.x, p.y + jump, p.z, k > 0 ? specFace[i] : p.ry, p.s, p.s);
      }
      specMesh.instanceMatrix.needsUpdate = true; specGeo.attributes.aCheer.needsUpdate = true;
    }

    // ---------- Levende brett: bygg på tomtene ----------
    const signTex = (function () {
      const W = 1024, H = 1152, c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      const font = (px) => '900 ' + px + 'px "Lilita One", Montserrat, "Arial Black", sans-serif';
      const fit = (txt, px, maxW) => { let s = px; g.font = font(s); while (g.measureText(txt).width > maxW && s > 10) { s -= 2; g.font = font(s); } };
      const cell = (n) => [(n % 4) * 256, Math.floor(n / 4) * 128];
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const lot of lots) {
        if (!lot) continue;
        const [x, y] = cell(lot.cell);
        g.fillStyle = '#1b2a4a'; g.fillRect(x, y, 256, 128);
        g.fillStyle = '#ffffff'; g.fillRect(x + 6, y + 6, 244, 116);
        g.fillStyle = '#d62839'; g.fillRect(x + 6, y + 6, 244, 58);
        g.fillStyle = '#ffffff'; fit('TIL SALGS', 48, 226); g.fillText('TIL SALGS', x + 128, y + 37);
        g.fillStyle = lot.gcol; g.fillRect(x + 6, y + 108, 244, 14);
        const pr = lot.price ? 'kr ' + lot.price.toLocaleString('nb-NO') : 'Oslo';
        g.fillStyle = '#1b2a4a'; fit(pr, 40, 226); g.fillText(pr, x + 128, y + 87);
      }
      let [x, y] = cell(28);
      g.fillStyle = '#1b2a4a'; g.fillRect(x, y, 256, 128); g.strokeStyle = '#ffd23f'; g.lineWidth = 6; g.strokeRect(x + 6, y + 6, 244, 116);
      g.fillStyle = '#ffd23f'; fit('HOTELL', 70, 220); g.fillText('HOTELL', x + 128, y + 58);
      g.font = font(22); g.fillText('★ ★ ★', x + 128, y + 104);
      [x, y] = cell(29);
      g.fillStyle = '#ffd23f'; g.fillRect(x, y, 256, 128);
      g.fillStyle = '#1b1b1b'; for (let k = -2; k < 12; k++) { g.beginPath(); g.moveTo(x + k * 26, y); g.lineTo(x + k * 26 + 13, y); g.lineTo(x + k * 26 - 13 + 13, y + 14); g.lineTo(x + k * 26 - 13, y + 14); g.fill(); }
      g.fillRect(x, y + 114, 256, 14);
      g.fillStyle = '#1b1b1b'; fit('PANTSATT', 64, 230); g.fillText('PANTSATT', x + 128, y + 66);
      let n = 30;
      for (const lot of lots) {
        if (!lot || lot.type !== 'station') continue;
        lot.stationCell = n;
        [x, y] = cell(n++);
        g.fillStyle = '#1d4fb8'; g.fillRect(x, y, 256, 128);
        g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x + 40, y + 64, 26, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#1d4fb8'; g.font = font(34); g.fillText('T', x + 40, y + 66);
        const nm = (lot.name || 'Stasjon').replace(/ stasjon$/i, '').toUpperCase();
        g.fillStyle = '#ffffff'; fit(nm, 52, 170); g.fillText(nm, x + 150, y + 66);
      }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      if (renderer) t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return t;
    })();
    const HOTEL_CELL = 28, MORT_CELL = 29;
    const LOTMAT = {
      fac: MAT.fac, plain: MAT.plain, ao: MAT.ao,
      sign: new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.25, roughness: 0.6, metalness: 0 }),
    };
    function cellUV(n) {
      const col = n % 4, row = Math.floor(n / 4);
      return [(col * 256 + 3) / 1024, 1 - (row * 128 + 125) / 1152, (col * 256 + 253) / 1024, 1 - (row * 128 + 3) / 1152];
    }

    // Lokale hjelpere: lokal x = langs brettsiden, lokal z = utover (front mot brettet er −z), y over tomtens dekke.
    const FP = (F, lx, lz) => [F.cx + lx * F.cs + lz * F.sn, F.cz - lx * F.sn + lz * F.cs];
    const lpt = (F, lx, y, lz) => { const p = FP(F, lx, lz); return [p[0], F.y + y, p[1]]; };
    function lbox(b, F, lx, y, lz, w, h, d, col, opt) { const p = FP(F, lx, lz); pushBox(b, p[0], F.y + y, p[1], w, h, d, F.rot, col, opt); }
    function lfrust(b, F, lx, y, lz, w, d, h, inset, col) { const p = FP(F, lx, lz); pushFrustum(b, p[0], F.y + y, p[1], w, d, h, inset, col, F.rot); }
    function lstamp(b, F, geo, lx, y, lz, sx, sy, sz, col) { const p = FP(F, lx, lz); stamp(b, geo, p[0], F.y + y, p[1], F.rot, sx, sy, sz, col); }
    function lgable(b, F, lx, y0, lz, w, d, h, rc, wc, over) {
      over = over == null ? 0.04 : over;
      const L = w / 2, S = d / 2, Lo = L + over, So = S + over, y1 = y0 + h, yE = y0 - (over * h) / S;
      const P = (x, y, z) => lpt(F, lx + x, y, lz + z);
      b.quad(P(-Lo, yE, So), P(Lo, yE, So), P(Lo, y1, 0), P(-Lo, y1, 0), rc);
      b.quad(P(Lo, yE, -So), P(-Lo, yE, -So), P(-Lo, y1, 0), P(Lo, y1, 0), rc);
      b.tri(P(L, y0, S), P(L, y0, -S), P(L, y1, 0), wc);
      b.tri(P(-L, y0, -S), P(-L, y0, S), P(-L, y1, 0), wc);
    }
    // Skiltflate (dir = −1 vender mot brettet, +1 utover). Kan vippes: lzTop ≠ lzBase.
    function lface(b, F, uv, lx, y0, lzBase, lzTop, w, h, dir) {
      const s = dir < 0 ? 1 : -1;
      const A = lpt(F, lx + s * w / 2, y0, lzBase), B = lpt(F, lx - s * w / 2, y0, lzBase), Cc = lpt(F, lx - s * w / 2, y0 + h, lzTop), D = lpt(F, lx + s * w / 2, y0 + h, lzTop);
      const nx = dir * F.sn, nz = dir * F.cs, wc = C('#ffffff');
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
      const qx = uy * vz - uz * vy, qz = ux * vy - uy * vx;
      const a = [uv[0], uv[1]], bb = [uv[2], uv[1]], c = [uv[2], uv[3]], d = [uv[0], uv[3]];
      if (qx * nx + qz * nz >= 0) b.quad(A, B, Cc, D, wc, a, bb, c, d); else b.quad(A, D, Cc, B, wc, a, d, c, bb);
    }
    // Tosidig, loddrett skilt med bakplate.
    function lsign(T, F, cell, lx, y0, lz, w, h, back) {
      const uv = cellUV(cell);
      lbox(T.plain, F, lx, y0 - 0.005, lz, w + 0.02, h + 0.01, 0.014, C(back || '#1b2a4a'));
      lface(T.sign, F, uv, lx, y0, lz - 0.0075, lz - 0.0075, w, h, -1);
      lface(T.sign, F, uv, lx, y0, lz + 0.0075, lz + 0.0075, w, h, 1);
    }

    const WHITE = C('#ffffff'), GRAYM = C('#8b9097');
    function tint(hex, lighten, mort) {
      const c = new THREE.Color(hex);
      if (lighten) c.lerp(WHITE, lighten);
      if (mort) c.lerp(GRAYM, 0.62);
      return c;
    }
    const lotTreeGeo = merge([part(CylG(0.045, 0.06, 0.42, 6), '#7a5232', at(0, 0.21, 0)), part(new THREE.IcosahedronGeometry(0.36, 1), '#4cb84a', (g) => { g.scale(1, 1.08, 1); g.translate(0, 0.68, 0); })]);
    const bushGeo = part(new THREE.IcosahedronGeometry(0.1, 0), '#3fae49', at(0, 0.07, 0));
    blobOf.set(lotTreeGeo, { r: 0.4, s: 0.5 }); blobOf.set(bushGeo, { r: 0.13, s: 0.45 });
    const coneGeo = part(new THREE.ConeGeometry(1, 1, 16), '#ffffff', at(0, 0.5, 0));
    const clockGeo = part(CylG(1, 1, 1, 16), '#fbf7ec', (g) => g.rotateX(Math.PI / 2));

    // Nivåer for gater: 0 = kjøpt tomt, 1–4 hus, 5 hotell. Høyden (inkl. dekke) holdes under 1.5.
    const LV = [
      { w: 0.6, d: 0.5, h: 0.3, fl: 0.3, roof: 'gable', rh: 0.22 },
      { w: 0.66, d: 0.58, h: 0.48, fl: 0.24, roof: 'gable', rh: 0.24 },
      { w: 0.7, d: 0.66, h: 0.72, fl: 0.24, roof: 'hip', rh: 0.22 },
      { w: 0.78, d: 0.8, h: 0.72, fl: 0.24, roof: 'mansard', rh: 0.3 },
      { w: 0.82, d: 0.9, h: 0.96, fl: 0.24, roof: 'flat', rh: 0.1 },
      { w: 0.86, d: 1.0, h: 1.2, fl: 0.24, roof: 'hotel', rh: 0.23 },
    ];
    function footprint(lot, st) {
      if (lot.type === 'station') return { fx: -0.1, w: 0.62, d: 0.46, zc: 0.3, h: 0.42, rh: 0.2 };
      if (lot.type === 'utility') return lot.util === 'tap' ? { fx: 0, w: 0.64, d: 0.64, zc: 0.15, h: 1.06, rh: 0.22 } : { fx: -0.12, w: 0.6, d: 0.5, zc: 0.28, h: 0.46, rh: 0.14 };
      const L = LV[st.level]; return { fx: 0, w: L.w, d: L.d, zc: 0.55 - L.d / 2, h: L.h, rh: L.rh };
    }
    function mainHeight(lot, st) {
      if (!st.color) return 0.5;
      if (lot.type === 'station') return 1.2;
      if (lot.type === 'utility') return 1.3;
      return LV[st.level].h + LV[st.level].rh;
    }

    function buildPad(b, F, lot, st) {
      lbox(b, F, 0, -PADH, 0, 0.92, 0.04, 1.2, C('#d9cdb8'));
      lbox(b, F, 0, -PADH, 0, 0.86, st.color ? 0.05 : 0.054, 1.14, C(st.color ? '#efe4d0' : '#79d158'));
      lbox(b, F, 0, -PADH, -0.555, 0.86, 0.058, 0.07, C(lot.gcol));
    }
    function buildMain(T, F, lot, st) {
      if (!st.color) {
        // «TIL SALGS»: A-skilt i meglerstil + to busker
        const uv = cellUV(lot.cell), a = 0.1, h = 0.34, w = 0.58, y0 = 0.1, lz = -0.12, post = C('#1b2a4a');
        lface(T.sign, F, uv, 0, y0, lz - a * 0.75, lz - 0.012, w, h, -1);
        lface(T.sign, F, uv, 0, y0, lz + a * 0.75, lz + 0.012, w, h, 1);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          const p0 = lpt(F, sx * (w / 2 + 0.012), 0, lz + sz * a), p1 = lpt(F, sx * (w / 2 + 0.012), y0 + h + 0.03, lz);
          beam(T.plain, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 0.022, 0.022, post);
        }
        lbox(T.plain, F, 0, y0 + h, lz, w + 0.05, 0.03, 0.03, post);
        for (const sx of [-1, 1]) lstamp(T.plain, F, bushGeo, sx * 0.3, 0, 0.38, 1 + sx * 0.15);
        return;
      }
      const m = st.mortgaged, wall = tint(st.color, 0.12, m), trim = tint('#f6f1e6', 0, m), dark = C('#3b2a20');
      const slate = tint('#3d4450', 0, m), acc = tint(lot.gcol, 0, m);
      if (lot.type === 'station') {
        lbox(T.fac, F, -0.1, 0, 0.3, 0.62, 0.42, 0.46, wall, { fac: true, noTop: true, sty: 1, fh: 0.42, tw: 0.17 });
        lbox(T.plain, F, -0.1, 0.4, 0.3, 0.65, 0.04, 0.49, trim);
        lgable(T.plain, F, -0.1, 0.43, 0.3, 0.62, 0.46, 0.2, slate, wall, 0.04);
        lbox(T.fac, F, 0.3, 0, 0.32, 0.2, 0.92, 0.2, wall, { fac: true, noTop: true, sty: 3, fh: 0.23, tw: 0.2 });
        lbox(T.plain, F, 0.3, 0.9, 0.32, 0.23, 0.04, 0.23, trim);
        lfrust(T.plain, F, 0.3, 0.94, 0.32, 0.24, 0.24, 0.24, 0.12, slate);
        for (const sz of [-1, 1]) {
          lstamp(T.plain, F, clockGeo, 0.3, 0.8, 0.32 + sz * 0.102, 0.065, 0.065, 0.012);
          lbox(T.plain, F, 0.3, 0.8, 0.32 + sz * 0.11, 0.01, 0.05, 0.006, dark);
          lbox(T.plain, F, 0.32, 0.8, 0.32 + sz * 0.11, 0.04, 0.01, 0.006, dark);
        }
        lbox(T.plain, F, 0, 0, -0.3, 0.88, 0.04, 0.24, tint('#cfc8b8', 0, m));
        for (const x of [-0.38, 0, 0.38]) lbox(T.plain, F, x, 0.04, -0.4, 0.022, 0.26, 0.022, slate);
        lbox(T.plain, F, 0, 0.3, -0.33, 0.92, 0.025, 0.3, slate);
        lbox(T.plain, F, 0, 0.27, -0.481, 0.92, 0.035, 0.012, wall);
        lsign(T, F, lot.stationCell, 0, 0.335, -0.3, 0.46, 0.11, '#1d4fb8');
        for (const z of [-0.5, -0.565]) lbox(T.plain, F, 0, 0, z, 0.9, 0.014, 0.012, C('#b8bec6'));
        for (let x = -0.4; x < 0.42; x += 0.1) lbox(T.plain, F, x, 0, -0.533, 0.026, 0.007, 0.1, C('#6b4a2e'));
        return;
      }
      if (lot.type === 'utility') {
        if (lot.util === 'tap') {
          // vanntårn
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) lbox(T.plain, F, sx * 0.2, 0, 0.15 + sz * 0.2, 0.035, 0.74, 0.035, slate);
          for (const sz of [-1, 1]) { const a0 = lpt(F, -0.2, 0.05, 0.15 + sz * 0.2), a1 = lpt(F, 0.2, 0.6, 0.15 + sz * 0.2); beam(T.plain, a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], 0.018, 0.018, slate); }
          lstamp(T.plain, F, unitCyl, 0, 0.7, 0.15, 0.31, 0.36, 0.31, wall);
          lstamp(T.plain, F, unitCyl, 0, 0.82, 0.15, 0.316, 0.06, 0.316, trim);
          lstamp(T.plain, F, coneGeo, 0, 1.06, 0.15, 0.34, 0.2, 0.34, slate);
          lbox(T.fac, F, -0.24, 0, -0.33, 0.3, 0.22, 0.22, wall, { fac: true, noTop: true, sty: 3, fh: 0.22, tw: 0.2 });
          lgable(T.plain, F, -0.24, 0.22, -0.33, 0.3, 0.22, 0.1, slate, wall, 0.03);
          lbox(T.plain, F, 0.22, 0, -0.33, 0.1, 0.12, 0.1, C('#2fb5c6'));
        } else {
          // kraftverk med stripete pipe og trafoer
          lbox(T.fac, F, -0.12, 0, 0.28, 0.6, 0.46, 0.5, wall, { fac: true, noTop: true, sty: 3, fh: 0.23, tw: 0.2 });
          lbox(T.plain, F, -0.12, 0.44, 0.28, 0.63, 0.04, 0.53, trim);
          lgable(T.plain, F, -0.12, 0.47, 0.28, 0.6, 0.5, 0.14, slate, wall, 0.03);
          for (let j = 0; j < 5; j++) lstamp(T.plain, F, unitCyl, 0.3, j * 0.26, 0.36, 0.068 - j * 0.006, 0.26, 0.068 - j * 0.006, tint(j % 2 ? '#f4f4f4' : '#d62839', 0, m));
          for (const sx of [-1, 1]) {
            lbox(T.plain, F, sx * 0.22, 0, -0.32, 0.16, 0.16, 0.14, C('#9aa5b1'));
            for (const ix of [-0.04, 0.04]) lstamp(T.plain, F, unitCyl, sx * 0.22 + ix, 0.16, -0.32, 0.012, 0.08, 0.012, C('#e8eef2'));
          }
          lbox(T.plain, F, -0.12, 0.2, 0.025, 0.09, 0.12, 0.01, C('#ffd23f'));
        }
        return;
      }
      // Gate: bygg i eierens farge med tak/aksent i gruppefargen
      const lv = st.level, L = LV[lv], zc = 0.55 - L.d / 2, zf = zc - L.d / 2;
      if (lv === 5) {
        lbox(T.fac, F, 0, 0, zc, L.w, 0.28, L.d, tint('#2f3e46', 0, m), { fac: true, noTop: true, sty: 2, fh: 0.28, tw: 0.2 });
        lbox(T.fac, F, 0, 0.28, zc, L.w, L.h - 0.28, L.d, wall, { fac: true, noTop: true, sty: 1, fh: 0.23, tw: 0.19 });
        lbox(T.plain, F, 0, 0.27, zc, L.w + 0.02, 0.035, L.d + 0.02, acc);
      } else if (lv === 4) {
        lbox(T.fac, F, 0, 0, zc, L.w, 0.24, L.d, tint('#3d405b', 0, m), { fac: true, noTop: true, sty: 2, fh: 0.24, tw: 0.2 });
        lbox(T.fac, F, 0, 0.24, zc, L.w, L.h - 0.24, L.d, wall, { fac: true, noTop: true, sty: 1, fh: 0.24, tw: 0.2 });
        lbox(T.plain, F, 0, 0.23, zc, L.w + 0.02, 0.03, L.d + 0.02, trim);
      } else lbox(T.fac, F, 0, 0, zc, L.w, L.h, L.d, wall, { fac: true, noTop: true, sty: lv >= 2 ? 0 : 3, fh: L.fl, tw: 0.2 });
      lbox(T.plain, F, 0, L.h - 0.03, zc, L.w + 0.03, 0.04, L.d + 0.03, trim);
      if (L.roof === 'gable') lgable(T.plain, F, 0, L.h + 0.01, zc, L.w, L.d, L.rh, acc, wall, 0.04);
      else if (L.roof === 'hip') lfrust(T.plain, F, 0, L.h + 0.01, zc, L.w + 0.04, L.d + 0.04, L.rh, Math.min(L.w, L.d) / 2 - 0.04, acc);
      else if (L.roof === 'mansard') {
        lfrust(T.plain, F, 0, L.h + 0.01, zc, L.w + 0.04, L.d + 0.04, L.rh, 0.17, acc);
        for (const sx of [-1, 1]) { lbox(T.plain, F, sx * 0.19, L.h + 0.05, zf + 0.1, 0.13, 0.12, 0.1, trim); lbox(T.plain, F, sx * 0.19, L.h + 0.07, zf + 0.045, 0.08, 0.08, 0.01, C('#27405e')); }
      } else {
        lbox(T.plain, F, 0, L.h, zc, L.w - 0.03, 0.02, L.d - 0.03, lv === 4 ? tint('#74c95a', 0, m) : trim);
        if (lv === 4) {
          for (const sz of [-1, 1]) lbox(T.plain, F, 0, L.h + 0.02, zc + sz * (L.d / 2 - 0.01), L.w, 0.05, 0.01, acc);
          for (const sx of [-1, 1]) lbox(T.plain, F, sx * (L.w / 2 - 0.01), L.h + 0.02, zc, 0.01, 0.05, L.d, acc);
          if (!m) {
            lbox(T.plain, F, 0.2, L.h + 0.02, zc + 0.2, 0.16, 0.1, 0.16, acc);
            lstamp(T.plain, F, bushGeo, -0.22, L.h + 0.02, zc + 0.15, 0.9);
            lstamp(T.plain, F, bushGeo, -0.08, L.h + 0.02, zc + 0.3, 0.8);
          }
        } else {
          // hotell: skilt på taket, baldakin og rød løper
          lbox(T.plain, F, 0, L.h + 0.02, zc + 0.28, 0.24, 0.06, 0.2, acc);
          for (const sx of [-1, 1]) lbox(T.plain, F, sx * 0.22, L.h + 0.02, zc - 0.05, 0.025, 0.05, 0.025, dark);
          lsign(T, F, HOTEL_CELL, 0, L.h + 0.07, zc - 0.05, 0.58, 0.16);
          lbox(T.plain, F, 0, 0.27, zf - 0.09, 0.42, 0.025, 0.18, acc);
          for (const sx of [-1, 1]) lbox(T.plain, F, sx * 0.19, 0, zf - 0.165, 0.02, 0.27, 0.02, C('#e9c46a'));
          lbox(T.plain, F, 0, 0, zf - 0.065, 0.14, 0.004, 0.13, C('#c8102e'));
        }
      }
      // dør, markise, balkonger, pipe, hage
      lbox(T.plain, F, 0, 0, zf - 0.006, 0.11, 0.17, 0.012, dark);
      if (lv <= 1 || lv === 4) lbox(T.plain, F, 0, 0.2, zf - 0.05, L.w * 0.7, 0.025, 0.1, acc);
      if (lv === 2 || lv === 3) {
        const floors = Math.round(L.h / L.fl);
        for (let f = 1; f < floors; f++) for (const sx of [-1, 1]) {
          lbox(T.plain, F, sx * L.w * 0.26, f * L.fl, zf - 0.035, 0.2, 0.02, 0.07, trim);
          lbox(T.plain, F, sx * L.w * 0.26, f * L.fl + 0.02, zf - 0.068, 0.2, 0.05, 0.008, acc);
        }
      }
      if (lv >= 1 && lv <= 3) lbox(T.plain, F, L.w * 0.26, L.h, zc + L.d * 0.2, 0.07, L.rh + 0.06, 0.07, C('#9c5b46'));
      if (lv <= 1) { lstamp(T.plain, F, lotTreeGeo, -0.33, 0, -0.42, 0.42); lstamp(T.plain, F, bushGeo, 0.32, 0, -0.45, 1); }
      else if (lv <= 3) for (const sx of [-1, 1]) lstamp(T.plain, F, bushGeo, sx * 0.36, 0, -0.5, 0.8);
    }
    function buildExtras(T, F, lot, st) {
      if (!st.color || !st.mortgaged) return;
      const f = footprint(lot, st), tarp = C('#5f93c9'), rope = C('#f1e2b3'), red = C('#d62839');
      const yb = f.h * 0.35, w = f.w + 0.05, d = f.d + 0.05;
      lbox(T.plain, F, f.fx, yb, f.zc, w, f.h - yb + 0.01, d, tarp, { noTop: true });
      lfrust(T.plain, F, f.fx, f.h + 0.01, f.zc, w, d, f.rh + 0.04, Math.min(w, d) / 2 - 0.08, C('#5488bf'));      for (const sx of [-1, 1]) lbox(T.plain, F, f.fx + sx * f.w * 0.25, yb - 0.005, f.zc, 0.016, f.h - yb + 0.03, d + 0.012, rope);
      // sperrebånd rundt tomten
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { lbox(T.plain, F, sx * 0.42, 0, sz * 0.54, 0.03, 0.28, 0.03, C('#f4f4f4')); lbox(T.plain, F, sx * 0.42, 0.28, sz * 0.54, 0.036, 0.03, 0.036, red); }
      for (let k = 0; k < 8; k++) for (const sz of [-1, 1]) lbox(T.plain, F, -0.42 + (k + 0.5) * 0.105, 0.22, sz * 0.54, 0.105, 0.03, 0.008, k % 2 ? WHITE : red);
      for (let k = 0; k < 10; k++) for (const sx of [-1, 1]) lbox(T.plain, F, sx * 0.42, 0.22, -0.54 + (k + 0.5) * 0.108, 0.008, 0.03, 0.108, k % 2 ? WHITE : red);
      lsign(T, F, MORT_CELL, 0, 0.08, -0.55, 0.3, 0.13, '#1b1b1b');
    }

    // Statiske lot-mesher (alle tomter som ikke animeres akkurat nå), bygd på nytt ved endring.
    function makeStatic(mat, name) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), mat); m.name = name; m.castShadow = true; m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix(); root.add(m); return m;
    }
    const lotStatic = { fac: makeStatic(LOTMAT.fac, 'tomter-fasader'), plain: makeStatic(LOTMAT.plain, 'tomter'), sign: makeStatic(LOTMAT.sign, 'tomter-skilt'), ao: makeStatic(LOTMAT.ao, 'kontaktskygger') };
    lotStatic.sign.castShadow = false; lotStatic.ao.castShadow = false; lotStatic.ao.receiveShadow = false;
    const LOTKEYS = ['fac', 'plain', 'sign', 'ao'];
    // Byggesett for tomter; bygg som står på tomtedekket (bakke = ground) får myk kontaktskygge i T.ao.
    function lotBatches(ground) {
      const T = { fac: new Batch(true), plain: new Batch(false), sign: new Batch(true), ao: new AOBatch() };
      const sink = { ao: T.ao, ground, floor: ground - 0.002 };
      aoOf.set(T.fac, sink); aoOf.set(T.plain, sink);
      return T;
    }
    function lotBatchesDone(T) { aoOf.delete(T.fac); aoOf.delete(T.plain); }
    function rebuildStatic() {
      const T = lotBatches(GY + PADH);
      T.ao.p = aoB.p.slice(); T.ao.c = aoB.c.slice();   // byens statiske kontaktskygger + tomtenes i samme mesh (ett kall)
      for (let i = 0; i < lots.length; i++) {
        const lot = lots[i]; if (!lot) continue;
        buildPad(T.plain, lot.fr, lot, lot.st);
        if (!lot.anim) { buildMain(T, lot.fr, lot, lot.st); buildExtras(T, lot.fr, lot, lot.st); }
      }
      lotBatchesDone(T);
      for (const key of LOTKEYS) {
        const m = lotStatic[key], has = T[key].count() > 0;
        m.geometry.dispose(); m.geometry = has ? T[key].geometry(THREE) : new THREE.BufferGeometry(); m.visible = has;
      }
    }
    const ZF = { cx: 0, cz: 0, rot: 0, cs: 1, sn: 0, y: 0 };
    function lotGroup(lot, st, extras) {
      const T = lotBatches(0);
      if (extras) buildExtras(T, ZF, lot, st); else buildMain(T, ZF, lot, st);
      lotBatchesDone(T);
      if (!T.fac.count() && !T.plain.count() && !T.sign.count()) return null;
      const g = new THREE.Group(); g.position.set(lot.x, lot.y, lot.z); g.rotation.y = lot.rot;
      for (const key of LOTKEYS) {
        if (!T[key].count()) continue;
        const m = new THREE.Mesh(T[key].geometry(THREE), LOTMAT[key]); m.castShadow = key !== 'sign' && key !== 'ao'; m.userData.own = true; g.add(m);
      }
      root.add(g); return g;
    }
    function dropGroup(g) {
      if (!g) return;
      root.remove(g);
      g.traverse((o) => { if (o.isMesh && o.userData.own) o.geometry.dispose(); });
    }
    // Byggeplass-rekvisitter (delt geometri): plankegjerde, stillas (enhetskube) og kran.
    const siteGeo = (() => {
      const fence = new Batch(false), plankA = C('#f2c14e'), plankB = C('#e39b2d'), rail = C('#2f6b4f');
      for (const sz of [-1, 1]) for (let k = 0; k < 7; k++) pushBox(fence, -0.455 + (k + 0.5) * 0.13, 0, sz * 0.59, 0.13, 0.22, 0.02, 0, k % 2 ? plankA : plankB);
      for (const sx of [-1, 1]) for (let k = 0; k < 9; k++) pushBox(fence, sx * 0.455, 0, -0.59 + (k + 0.5) * 0.131, 0.02, 0.22, 0.131, 0, k % 2 ? plankA : plankB);
      for (const sz of [-1, 1]) pushBox(fence, 0, 0.22, sz * 0.59, 0.93, 0.02, 0.03, 0, rail);
      for (const sx of [-1, 1]) pushBox(fence, sx * 0.455, 0.22, 0, 0.03, 0.02, 1.2, 0, rail);
      const sc = new Batch(false), pole = C('#c8ccd2'), plank = C('#c58b4a');
      for (const x of [-0.5, 0, 0.5]) for (const z of [-0.5, 0.5]) pushBox(sc, x, 0, z, 0.02, 1, 0.02, 0, pole);
      for (const x of [-0.5, 0.5]) pushBox(sc, x, 0, 0, 0.02, 1, 0.02, 0, pole);
      for (const y of [0.33, 0.66, 0.98]) {
        for (const z of [-0.5, 0.5]) { pushBox(sc, 0, y, z, 1.0, 0.016, 0.016, 0, pole); pushBox(sc, 0, y - 0.012, z * 1.08, 1.0, 0.01, 0.07, 0, plank); }
        for (const x of [-0.5, 0.5]) pushBox(sc, x, y, 0, 0.016, 0.016, 1.0, 0, pole);
      }
      const cr = new Batch(false), yel = C('#ffc21a'), grey = C('#59606b');
      pushBox(cr, 0, 0, 0, 0.055, 1.22, 0.055, 0, yel);
      for (let y = 0.1; y < 1.2; y += 0.15) pushBox(cr, 0, y, 0, 0.062, 0.02, 0.062, 0, grey);
      pushBox(cr, 0.3, 1.22, 0, 0.84, 0.04, 0.045, 0, yel);
      pushBox(cr, -0.21, 1.17, 0, 0.12, 0.09, 0.08, 0, grey);
      pushBox(cr, 0.06, 1.12, 0, 0.08, 0.08, 0.08, 0, C('#f4f4f4'));
      pushBox(cr, 0, 1.26, 0, 0.02, 0.1, 0.02, 0, yel);
      pushBox(cr, 0.58, 0.78, 0, 0.006, 0.44, 0.006, 0, C('#2b2b2b'));
      pushBox(cr, 0.58, 0.72, 0, 0.045, 0.06, 0.045, 0, C('#d62839'));
      pushBox(cr, 0.58, 0.62, 0, 0.2, 0.05, 0.05, 0, C('#c58b4a'));
      return { fence: fence.geometry(THREE), scaff: sc.geometry(THREE), crane: cr.geometry(THREE) };
    })();

    const anims = [], DUST_AT = [0.08, 0.3, 0.5, 0.7, 0.9];
    const ss01 = (a, b, x) => sstep(a, b, x);
    const outBack = (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
    const sameSt = (a, b) => a.color === b.color && a.level === b.level && a.mortgaged === b.mortgaged;
    function normColor(c) {
      if (c == null || c === false || c === '') return null;
      try { return '#' + new THREE.Color(c).getHexString(); } catch (e) { return null; }
    }
    function startAnim(lot, from, to, resolve) {
      let type;
      if (from.color && !to.color) type = 'clear';
      else if (!from.color) type = 'build';
      else if (to.level > from.level) type = 'build';
      else if (to.level < from.level) type = 'sell';
      else if (from.color !== to.color) type = 'recolor';
      else type = 'mort';
      const a = { lot, from, to, type, t: 0, resolve, fired: 0,
        dur: { build: from.color ? 1.25 : 1.45, sell: 0.75, clear: 0.95, recolor: 0.65, mort: 0.85 }[type],
        s0: from.color ? Math.min(1, mainHeight(lot, from) / mainHeight(lot, to)) : 0.02,
        oldMain: lotGroup(lot, from, false), newMain: lotGroup(lot, to, false),
        oldX: lotGroup(lot, from, true), newX: lotGroup(lot, to, true), props: null };
      if (type === 'sell') a.s0 = mainHeight(lot, from) / mainHeight(lot, to);
      if (type === 'build') {
        const g = new THREE.Group(); g.position.set(lot.x, lot.y, lot.z); g.rotation.y = lot.rot;
        const fence = new THREE.Mesh(siteGeo.fence, MAT.plain), scaff = new THREE.Mesh(siteGeo.scaff, MAT.plain), crane = new THREE.Mesh(siteGeo.crane, MAT.plain);
        const f = footprint(lot, to); scaff.position.set(f.fx, 0, f.zc); crane.position.set(0.37, 0, 0.47);
        g.add(fence, scaff, crane); root.add(g);
        a.props = { g, fence, scaff, crane, f, H: f.h + 0.04 };
      }
      lot.anim = a; anims.push(a);
      stepAnim(a, 0);
      return a;
    }
    function finishAnim(a) {
      const k = anims.indexOf(a); if (k >= 0) anims.splice(k, 1);
      dropGroup(a.oldMain); dropGroup(a.newMain); dropGroup(a.oldX); dropGroup(a.newX);
      if (a.props) root.remove(a.props.g);
      if (a.lot.anim === a) a.lot.anim = null;
      dirty = true;
      if (a.resolve) a.resolve();
    }
    const setS = (g, x, y, z) => { if (g) g.scale.set(Math.max(1e-3, x), Math.max(1e-3, y), Math.max(1e-3, z)); };
    function fire(a, mark) { if (a.fired >= mark) return false; a.fired = mark; return true; }
    function stepAnim(a, dt) {
      a.t += dt;
      const u = Math.min(1, a.t / a.dur), lot = a.lot;
      if (a.type === 'build') {
        const P = a.props, sw = 0.28;
        if (a.oldMain) { if (!a.from.color) { const s = 1 - ss01(0, 0.12, u); setS(a.oldMain, s, s, s); } else a.oldMain.visible = u < sw; }
        const g = u < sw ? a.s0 : a.s0 + (1 - a.s0) * outBack(ss01(sw, 0.86, u));
        if (a.newMain) { a.newMain.visible = u >= sw; setS(a.newMain, 1, g, 1); }
        const fs = ss01(0, 0.12, u) * (1 - ss01(0.86, 1, u));
        P.fence.visible = fs > 0.01; setS(P.fence, 1, fs, 1);
        const sk = (1 - ss01(0.84, 0.95, u)) * ss01(0.08, 0.2, u);
        P.scaff.visible = sk > 0.01; setS(P.scaff, P.f.w + 0.1, P.H * Math.max(0.15, Math.min(1, g)) * sk, P.f.d + 0.1);
        const cs = ss01(0.03, 0.17, u) * (1 - ss01(0.82, 0.95, u));
        P.crane.visible = cs > 0.01; setS(P.crane, cs, cs, cs); P.crane.rotation.y = 1.4 * Math.sin(u * 5.0) - 0.4;
        for (let mk = 1; mk <= 5; mk++) if (u >= DUST_AT[mk - 1] && fire(a, mk)) dust(lot.x, lot.y, lot.z, mk === 1 || mk === 5 ? 12 : 7, 0.55);
        if (u >= 0.9 && a.fired < 6) { a.fired = 6; confetti(lot.x, lot.y + mainHeight(lot, a.to) * 0.9, lot.z, low ? 16 : 28, 0, 0, [a.to.color, lot.gcol, '#ffffff', '#ffd23f'], 2.4); }
      } else if (a.type === 'sell') {
        if (a.oldMain) a.oldMain.visible = false;
        setS(a.newMain, 1, a.s0 + (1 - a.s0) * outBack(ss01(0, 1, u)), 1);
        if (fire(a, 1)) dust(lot.x, lot.y, lot.z, 8, 0.5);
      } else if (a.type === 'clear') {
        const s = 1 - ss01(0, 0.55, u);
        if (a.oldMain) { a.oldMain.visible = s > 0.01; setS(a.oldMain, 1, s, 1); }
        const n = outBack(ss01(0.55, 0.92, u));
        if (a.newMain) { a.newMain.visible = u >= 0.55; setS(a.newMain, n, n, n); }
        if (fire(a, 1)) dust(lot.x, lot.y, lot.z, 10, 0.55);
        if (u > 0.35 && fire(a, 2)) dust(lot.x, lot.y, lot.z, 6, 0.4);
      } else if (a.type === 'recolor') {
        if (a.oldMain) a.oldMain.visible = u < 0.15;
        const n = 0.85 + 0.15 * outBack(ss01(0.15, 0.7, u));
        if (a.newMain) { a.newMain.visible = u >= 0.15; setS(a.newMain, n, n, n); }
        if (u >= 0.15 && fire(a, 1)) dust(lot.x, lot.y, lot.z, 8, 0.55);
      } else {
        if (a.oldMain) a.oldMain.visible = u < 0.45;
        if (a.newMain) a.newMain.visible = u >= 0.45;
      }
      // presenning og sperrebånd
      const mortOn = a.to.mortgaged && !a.from.mortgaged, mortOff = a.from.mortgaged && !a.to.mortgaged;
      if (a.oldX) {
        if (mortOff) { const k = ss01(0, 0.6, u); a.oldX.position.y = lot.y + k * 0.9; setS(a.oldX, 1 - k, 1 - k, 1 - k); }
        else a.oldX.visible = false;
      }
      if (a.newX) {
        if (mortOn) { const k = ss01(0.3, 0.8, u); a.newX.visible = u >= 0.3; a.newX.position.y = lot.y + (1 - outBack(k)) * 0.9; }
        else if (a.newMain) { a.newX.visible = a.newMain.visible; a.newX.scale.copy(a.newMain.scale); }
      }
      if (u >= 1) finishAnim(a);
    }

    function setLot(i, s, animate) {
      const lot = lots[i];
      if (!lot) return Promise.resolve();
      const color = normColor(s && s.color);
      const to = { color, level: color && lot.type === 'street' ? Math.max(0, Math.min(5, (s && s.level) | 0)) : 0, mortgaged: !!(color && s && s.mortgaged) };
      if (lot.anim) finishAnim(lot.anim);
      const from = lot.st;
      lot.st = to; dirty = true;
      if (!animate || skipping() || sameSt(from, to)) return Promise.resolve();
      return new Promise((res) => startAnim(lot, from, to, res));
    }
    function updateLots(dt) {
      if (anims.length) {
        if (skipping()) { while (anims.length) finishAnim(anims[anims.length - 1]); }
        else for (let k = anims.length - 1; k >= 0; k--) if (anims[k]) stepAnim(anims[k], dt);
      }
      if (dirty) { dirty = false; rebuildStatic(); }
    }
    function lotPos(i) { const l = lots[i]; return l ? { x: l.x, y: l.y, z: l.z, rot: l.rot, type: l.type } : null; }

    // ---------- Animasjon ----------
    const P = { x: 0, z: 0, dx: 0, dz: 1 };
    const tramLen = ringLen(tramA);
    function update(dt, t) {
      uTime.value = t;
      // Tomte-animasjonene følger veggklokka (maks ~1,5 s også når bildefrekvensen er lav).
      const wall = performance.now(), rdt = lastWall ? Math.min(0.25, Math.max(0, (wall - lastWall) / 1000)) : dt;
      lastWall = wall;
      tNow += rdt;
      if (skipping()) {
        for (let k = 0; k < emitters.length; k++) emitters[k].on = false;
        if (cAlive) { for (let i = 0; i < CN; i++) { cAge[i] = cLife[i] = 0; confMesh.setMatrixAt(i, ZERO); } cAlive = 0; confMesh.visible = false; }
        if (pAlive) { for (let i = 0; i < PN; i++) { pAge[i] = pLife[i] = 0; puffMesh.setMatrixAt(i, ZERO); } pAlive = 0; puffMesh.visible = false; }
        if (tNow < cheerEnd) { specUntil.fill(0); cheerEnd = tNow; }
      }
      updateLots(rdt);
      updateCrowd();
      updateConfetti(dt);
      updatePuffs(dt);
      if (renderer) { renderer.getDrawingBufferSize(_dv2); uHalfH.value = _dv2.y / 2; }
      // biler og busser
      for (let i = 0; i < vehicles.length; i++) {
        const o = vehicles[i], L = o.L;
        let x, z, dx, dz, sc = 1;
        if (L.ring) { ringPoint(L.a, (o.off + L.v * t) * L.dir, P); x = P.x; z = P.z; dx = P.dx * L.dir; dz = P.dz * L.dir; }
        else {
          const len = L.to - L.from, u = (o.off + L.v * t) % len, al = L.dir > 0 ? L.from + u : L.to - u;
          sc = Math.min(1, u / 1.5, (len - u) / 1.5);
          if (L.ax === 'z') { x = L.c; z = al; dx = 0; dz = L.dir; } else { x = al; z = L.c; dx = L.dir; dz = 0; }
        }
        const ry = Math.atan2(-dz, dx);
        setM(o.bus ? busMesh : carMesh, o.idx, x, GY + 0.012, z, ry, sc, sc);
        if (o.bus) setBlob(NB0 + o.idx, x, GY + 0.018, z, ry, 1.18 * sc, 0.44 * sc); else setBlob(o.idx, x, GY + 0.018, z, ry, 0.68 * sc, 0.38 * sc);
      }
      carMesh.instanceMatrix.needsUpdate = true; busMesh.instanceMatrix.needsUpdate = true;
      // trikk (tre ledd per vogn)
      for (let k = 0; k < TRAMS; k++) for (let j = 0; j < TSEG; j++) {
        ringPoint(tramA, t * 1.25 + (k * tramLen) / TRAMS - j * 1.21, P);
        setM(tramMesh, k * TSEG + j, P.x, GY + 0.02, P.z, Math.atan2(-P.dz, P.dx), 1, 1);
        setBlob(NB1 + k * TSEG + j, P.x, GY + 0.026, P.z, Math.atan2(-P.dz, P.dx), 1.3, 0.46);
      }
      tramMesh.instanceMatrix.needsUpdate = true;
      // folk
      for (let i = 0; i < walkers.length; i++) {
        const w = walkers[i];
        let x, z, dx, dz;
        if (w.ring) { ringPoint(w.a, (w.s0 + w.v * t) * w.dir, P); x = P.x; z = P.z; dx = P.dx * w.dir; dz = P.dz * w.dir; }
        else {
          const ex = w.x1 - w.x0, ez = w.z1 - w.z0, len = Math.hypot(ex, ez), u = (w.s0 + w.v * t) % (2 * len);
          const f = u < len ? u / len : 2 - u / len, sg = u < len ? 1 : -1;
          dx = (ex / len) * sg; dz = (ez / len) * sg;
          x = w.x0 + ex * f - (ez / len) * w.off; z = w.z0 + ez * f + (ex / len) * w.off;
        }
        setM(peopleMesh, i, x, w.y + Math.abs(Math.sin(t * 9 + i)) * 0.015, z, Math.atan2(-dz, dx), 1, 1);
        setBlob(NB2 + i, x, w.y + 0.012, z, 0, 0.17, 0.17);
      }
      peopleMesh.instanceMatrix.needsUpdate = true; blobMesh.instanceMatrix.needsUpdate = true;
      // båter
      for (let i = 0; i < boats.length; i++) {
        const b = boats[i], r = b.r, a = r[4] * t + r[5] * 1.7;
        const x = r[0] + Math.cos(a) * r[2], z = r[1] + Math.sin(a) * r[3];
        const sg = r[4] > 0 ? 1 : -1, vx = -Math.sin(a) * r[2] * sg, vz = Math.cos(a) * r[3] * sg;
        _dummy.position.set(x, WY + Math.sin(t * 1.6 + i) * 0.03, z);
        _dummy.rotation.set(b.heel * sg + Math.sin(t * 1.3 + i) * 0.03, Math.atan2(-vz, vx), Math.sin(t * 1.1 + i * 2) * 0.025);
        _dummy.scale.set(1, 1, 1); _dummy.updateMatrix(); b.m.setMatrixAt(b.i, _dummy.matrix);
      }
      ferryMesh.instanceMatrix.needsUpdate = true; sailMesh.instanceMatrix.needsUpdate = true; speedMesh.instanceMatrix.needsUpdate = true;
      // måker
      for (let i = 0; i < birds.length; i++) {
        const b = birds[i], a = b.ph + b.w * t, sg = b.w > 0 ? 1 : -1;
        _dummy.position.set(b.fx + Math.cos(a) * b.r, b.fy + Math.sin(t * 0.7 + b.ph) * 0.6, b.fz + Math.sin(a) * b.r);
        _dummy.rotation.set(-0.35 * sg, Math.atan2(-Math.cos(a) * sg, -Math.sin(a) * sg), 0);
        const fl = Math.sin(t * b.fl + b.ph);
        _dummy.scale.set(1.6, 1.6 * (0.25 + 0.75 * fl), 1.6); _dummy.updateMatrix(); birdMesh.setMatrixAt(i, _dummy.matrix);
      }
      birdMesh.instanceMatrix.needsUpdate = true;
      // skyer
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i], x = ((((c.x + c.v * t + 170) % 340) + 340) % 340) - 170;
        _dummy.position.set(x, c.y, c.z); _dummy.rotation.set(0, c.ry, 0); _dummy.scale.set(c.s * 1.3, c.s * 0.8, c.s); _dummy.updateMatrix();
        cloudMesh.setMatrixAt(i, _dummy.matrix);
      }
      cloudMesh.instanceMatrix.needsUpdate = true;
      // tivoli
      const th = t * 0.22;
      wheel.rotation.x = th; wheel.updateMatrix();
      if (!gondolas) {
        const gg = merge([
          part(BoxG(0.36, 0.3, 0.3), '#ffffff'),
          part(BoxG(0.37, 0.1, 0.31), '#25354a', at(0, 0.04, 0)),
          part(BoxG(0.42, 0.05, 0.36), '#f4f4f6', at(0, 0.17, 0)),
          part(BoxG(0.03, 0.2, 0.03), '#9aa3ab', at(0, 0.29, 0)),
        ]);
        gondolas = instanced(gg, MAT.marker, FW.n, 'gondoler', true);
        for (let i = 0; i < FW.n; i++) gondolas.setColorAt(i, C(RAINBOW[i % RAINBOW.length]));
      }
      for (let i = 0; i < FW.n; i++) {
        const a = (i / FW.n) * Math.PI * 2 - th;
        setM(gondolas, i, FW.x, FW.y + Math.sin(a) * FW.r - 0.38, FW.z + Math.cos(a) * FW.r, 0, 1, 1);
      }
      gondolas.instanceMatrix.needsUpdate = true;
      carousel.rotation.y = t * 0.6;
      const ct = t % 10;
      let dy;
      if (ct < 4) dy = 0.6 + 6.6 * sstep(0, 4, ct);
      else if (ct < 5.5) dy = 7.2;
      else if (ct < 6.2) { const u = (ct - 5.5) / 0.7; dy = 7.2 - 6.6 * u * u; }
      else dy = 0.6 + Math.abs(Math.sin((ct - 6.2) * 6)) * 0.25 * Math.exp(-(ct - 6.2) * 2.5);
      dropCar.position.y = GY + dy;
    }
    update(0, 0);
    return { update, root, setLot, cheer, smoke, lots, lotPos };
  }

  MP.City = { build };
})();

// 3D-scenen: brett, fargefelt, hus/hoteller, brikker, terninger og kortbunker.
// Bruker window.THREE (lastes av modul-skriptet i index.html).
(function () {
  'use strict';
  const MP = window.MP;
  const SQ = MP.SQUARES;
  const TEX_HALF = 6.5, TEX = 4096, P = TEX / (TEX_HALF * 2);
  const BAND = 0.34;

  // ---------- Geometri-hjelpere (lokal ramme = nederste rad, roteres per side) ----------
  const rot = (s, x, z) => { for (let k = 0; k < s; k++) { const nx = -z; z = x; x = nx; } return [x, z]; };
  const sideOf = (i) => Math.floor(i / 10);
  const kOf = (i) => i % 10;
  function localRect(i) {
    const k = kOf(i);
    return k === 0 ? { x0: 4.5, x1: 6.1, z0: 4.5, z1: 6.1 } : { x0: 4.5 - k, x1: 5.5 - k, z0: 4.5, z1: 6.1 };
  }
  function worldRect(i) {
    const r = localRect(i), s = sideOf(i);
    const a = rot(s, r.x0, r.z0), b = rot(s, r.x1, r.z1);
    return { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), z0: Math.min(a[1], b[1]), z1: Math.max(a[1], b[1]) };
  }
  const RECTS = SQ.map((_, i) => worldRect(i));
  function squareAt(x, z) { return RECTS.findIndex((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1); }

  const SLOT_REG = [[-0.24, -0.3], [0.24, -0.3], [-0.24, 0.15], [0.24, 0.15], [-0.24, 0.5], [0.24, 0.5]];
  const SLOT_CORNER = [[-0.45, -0.32], [0.05, -0.32], [0.5, -0.32], [-0.45, 0.25], [0.05, 0.25], [0.5, 0.25]];
  const SLOT_VISIT = [[5.86, 4.72], [5.86, 5.22], [5.86, 5.82], [5.26, 5.86], [4.72, 5.86], [5.5, 5.86]];
  const SLOT_CELL = [[4.82, 4.82], [5.27, 4.82], [4.82, 5.27], [5.27, 5.27], [5.05, 5.05], [5.05, 4.8]];
  function slotWorld(i, slot, inJail) {
    const k = kOf(i), s = sideOf(i);
    let lx, lz;
    if (i === 10) { [lx, lz] = (inJail ? SLOT_CELL : SLOT_VISIT)[slot % 6]; }
    else if (k === 0) { lx = 5.3 + SLOT_CORNER[slot % 6][0]; lz = 5.3 + SLOT_CORNER[slot % 6][1]; }
    else { lx = 5 - k + SLOT_REG[slot % 6][0]; lz = 5.47 + SLOT_REG[slot % 6][1]; }
    const [x, z] = rot(s, lx, lz);
    return { x, z };
  }
  function centerWorld(i) {
    const k = kOf(i), s = sideOf(i);
    const [x, z] = rot(s, k === 0 ? 5.3 : 5 - k, k === 0 ? 5.3 : 5.4);
    return { x, z };
  }
  function travelYaw(i) {
    const [dx, dz] = rot(sideOf(i), -1, 0);
    return Math.atan2(-dz, dx);
  }

  // Brettflaten tegnes i boardtex.js (MP.BoardTex.draw).

  function woodTexture(THREE) {
    const c = document.createElement('canvas'); c.width = c.height = 1024;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#5a3420'; ctx.fillRect(0, 0, 1024, 1024);
    for (let n = 0; n < 260; n++) {
      const y = Math.random() * 1024, a = 0.04 + Math.random() * 0.08;
      ctx.strokeStyle = Math.random() < 0.5 ? `rgba(30,14,6,${a})` : `rgba(140,86,50,${a})`;
      ctx.lineWidth = 1 + Math.random() * 5;
      ctx.beginPath(); ctx.moveTo(0, y);
      for (let x = 0; x <= 1024; x += 64) ctx.lineTo(x, y + Math.sin(x / 140 + n) * 6);
      ctx.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function diceFace(THREE, n) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fbfaf6'; ctx.fillRect(0, 0, 256, 256);
    const pip = { 1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]], 4: [[0, 0], [2, 0], [0, 2], [2, 2]], 5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]], 6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]] }[n];
    for (const [x, y] of pip) {
      ctx.fillStyle = n === 1 ? '#D7262E' : '#15181d';
      ctx.beginPath(); ctx.arc(58 + x * 70, 58 + y * 70, n === 1 ? 30 : 22, 0, 7); ctx.fill();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function cardTopTexture(THREE, type) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 340;
    const ctx = c.getContext('2d');
    ctx.fillStyle = type === 'chance' ? '#F7941D' : '#2E7FD9'; ctx.fillRect(0, 0, 512, 340);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 10; ctx.strokeRect(18, 18, 476, 304);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '400 64px "Lilita One"';
    ctx.fillText(type === 'chance' ? 'SJANSE' : 'PRØV LYKKEN', 256, 120);
    ctx.font = '400 110px "Lilita One"';
    ctx.fillText(type === 'chance' ? '?' : '★', 256, 230);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- Brikker ----------
  function buildToken(THREE, id, color, env) {
    const metal = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, metalness: 0.85, roughness: 0.26, envMapIntensity: 1.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0xa4a9b0, metalness: 0.9, roughness: 0.35, envMapIntensity: 1.4 });
    const g = new THREE.Group();
    const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat || metal); m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
    };
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.04, 40),
      new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.35, emissive: color, emissiveIntensity: 0.25 }));
    base.position.y = 0.02; base.castShadow = true; base.receiveShadow = true; g.add(base);
    const body = new THREE.Group(); body.position.y = 0.04; g.add(body);
    const B = (geo, mat, ...a) => { const m = add(geo, mat, ...a); g.remove(m); body.add(m); return m; };
    if (id === 'car') {
      B(new THREE.BoxGeometry(0.36, 0.07, 0.17), metal, 0, 0.07, 0);
      B(new THREE.BoxGeometry(0.17, 0.07, 0.15), metal, -0.02, 0.135, 0);
      B(new THREE.BoxGeometry(0.06, 0.05, 0.16), dark, 0.16, 0.1, 0, 0, 0, -0.5);
      for (const [x, z] of [[0.11, 0.09], [-0.11, 0.09], [0.11, -0.09], [-0.11, -0.09]]) B(new THREE.CylinderGeometry(0.045, 0.045, 0.035, 20), dark, x, 0.045, z, Math.PI / 2);
      B(new THREE.TorusGeometry(0.04, 0.008, 8, 20), metal, -0.02, 0.2, 0.0, Math.PI / 2);
    } else if (id === 'hat') {
      B(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 40), metal, 0, 0.015, 0);
      B(new THREE.CylinderGeometry(0.105, 0.095, 0.24, 40), metal, 0, 0.14, 0);
      B(new THREE.CylinderGeometry(0.098, 0.098, 0.04, 40), dark, 0, 0.05, 0);
      B(new THREE.CylinderGeometry(0.106, 0.106, 0.01, 40), metal, 0, 0.26, 0);
    } else if (id === 'ship') {
      const shape = new THREE.Shape();
      shape.moveTo(-0.17, 0.06); shape.lineTo(0.12, 0.06); shape.quadraticCurveTo(0.22, 0.06, 0.24, 0.0);
      shape.quadraticCurveTo(0.2, -0.06, 0.12, -0.06); shape.lineTo(-0.17, -0.06); shape.closePath();
      const hull = new THREE.ExtrudeGeometry(shape, { depth: 0.09, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 3 });
      hull.rotateX(-Math.PI / 2); hull.translate(0, 0, 0);
      const h = B(hull, metal, 0, 0.02, 0); h.scale.set(1, 1, 1);
      B(new THREE.BoxGeometry(0.28, 0.05, 0.1), metal, -0.01, 0.13, 0);
      B(new THREE.BoxGeometry(0.16, 0.05, 0.08), metal, -0.03, 0.18, 0);
      for (const x of [-0.07, 0.03]) B(new THREE.CylinderGeometry(0.025, 0.028, 0.1, 20), dark, x, 0.24, 0);
      B(new THREE.CylinderGeometry(0.006, 0.006, 0.18, 8), dark, 0.13, 0.2, 0);
    } else if (id === 'boot') {
      B(new THREE.BoxGeometry(0.1, 0.22, 0.12), metal, -0.06, 0.15, 0);
      B(new THREE.BoxGeometry(0.26, 0.07, 0.12), metal, 0.02, 0.05, 0);
      B(new THREE.SphereGeometry(0.06, 20, 14), metal, 0.14, 0.055, 0).scale.set(1, 0.85, 1);
      B(new THREE.BoxGeometry(0.06, 0.03, 0.12), dark, -0.07, 0.015, 0);
      B(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 24), dark, -0.06, 0.26, 0);
    } else if (id === 'dog') {
      const bodyG = new THREE.CapsuleGeometry(0.06, 0.14, 6, 16); bodyG.rotateZ(Math.PI / 2);
      B(bodyG, metal, 0, 0.13, 0);
      B(new THREE.SphereGeometry(0.06, 20, 16), metal, 0.13, 0.21, 0);
      B(new THREE.CapsuleGeometry(0.025, 0.04, 4, 10), metal, 0.19, 0.2, 0, 0, 0, Math.PI / 2);
      B(new THREE.SphereGeometry(0.014, 10, 8), dark, 0.225, 0.205, 0);
      for (const z of [-0.04, 0.04]) B(new THREE.CapsuleGeometry(0.018, 0.04, 4, 8), dark, 0.11, 0.25, z, z * 8, 0, 0.6);
      for (const [x, z] of [[0.08, 0.035], [0.08, -0.035], [-0.08, 0.035], [-0.08, -0.035]]) B(new THREE.CylinderGeometry(0.018, 0.016, 0.1, 10), metal, x, 0.05, z);
      B(new THREE.CapsuleGeometry(0.012, 0.07, 4, 8), metal, -0.15, 0.18, 0, 0, 0, 0.8);
    } else if (id === 'thimble') {
      B(new THREE.CylinderGeometry(0.085, 0.105, 0.2, 40, 1, true), metal, 0, 0.1, 0);
      B(new THREE.SphereGeometry(0.085, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), metal, 0, 0.2, 0);
      B(new THREE.TorusGeometry(0.104, 0.012, 10, 40), dark, 0, 0.01, 0, Math.PI / 2);
      for (let r = 0; r < 4; r++) B(new THREE.TorusGeometry(0.09 + 0.004 * (3 - r), 0.004, 6, 40), dark, 0, 0.05 + r * 0.04, 0, Math.PI / 2);
    }
    body.scale.setScalar(1.25);
    g.scale.setScalar(1.3);
    return g;
  }

  // Baksiden av Sjanse-/Prøv lykken-kortene: mønster med «?» eller stjerner.
  function cardBackTexture(THREE, type) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 340;
    const ctx = c.getContext('2d');
    const base = type === 'chance' ? '#F7941D' : '#2E7FD9', dark = type === 'chance' ? '#D9661F' : '#1F63B5';
    ctx.fillStyle = base; ctx.fillRect(0, 0, 512, 340);
    ctx.fillStyle = dark;
    for (let y = 0; y < 340; y += 40) for (let x = (y / 40) % 2 ? 20 : 0; x < 512; x += 40) ctx.fillRect(x, y, 20, 20);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 12; ctx.strokeRect(16, 16, 480, 308);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.beginPath(); ctx.arc(256, 170, 70, 0, 7); ctx.fill();
    ctx.fillStyle = base; ctx.font = '400 96px "Lilita One"';
    ctx.fillText(type === 'chance' ? '?' : '★', 256, 178);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  // Pantsatt felt: mørk hinne med rødt «PANTSATT»-stempel på skrå.
  function mortgageTexture(THREE) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(20,20,28,0.42)'; ctx.fillRect(0, 0, 256, 256);
    ctx.translate(128, 128); ctx.rotate(-Math.PI / 5);
    ctx.strokeStyle = 'rgba(227,36,43,0.95)'; ctx.lineWidth = 10;
    ctx.strokeRect(-112, -30, 224, 60);
    ctx.fillStyle = 'rgba(227,36,43,0.95)'; ctx.font = '900 40px Montserrat'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PANTSATT', 0, 3);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- Hus og hoteller ----------
  function houseGeo(THREE, w, h, d, chimney) {
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(w / 2, h); shape.lineTo(0, h + w * 0.45); shape.lineTo(-w / 2, h); shape.closePath();
    let geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2 });
    geo.translate(0, 0, -d / 2);
    if (chimney && window.BufferGeometryUtils) {
      const c = new THREE.BoxGeometry(w * 0.16, w * 0.32, d * 0.22).toNonIndexed();
      c.translate(w * 0.22, h + w * 0.3, -d * 0.12);
      geo.clearGroups();
      const merged = window.BufferGeometryUtils.mergeGeometries([geo, c], false);
      if (merged) geo = merged;
    }
    return geo;
  }
  // Små lysende vinduer på fram- og baksiden av hus/hotell.
  function windowsGeo(THREE, w, h, d, cols) {
    const parts = [];
    const ww = Math.min(0.045, (w * 0.7) / (cols * 1.6)), wh = Math.min(0.05, h * 0.35);
    for (const side of [-1, 1]) {
      for (let c = 0; c < cols; c++) {
        const g = new THREE.BoxGeometry(ww, wh, 0.008);
        const x = cols === 1 ? 0 : -w * 0.32 + (c * (w * 0.64)) / (cols - 1);
        g.translate(x, h * 0.55, side * (d / 2 + 0.006));
        parts.push(g);
      }
    }
    return window.BufferGeometryUtils ? window.BufferGeometryUtils.mergeGeometries(parts, false) : parts[0];
  }
  // Fartsterningens sider: 1, 2, 3, «M» (to sider) og buss.
  function speedFace(THREE, v) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#E3242B'; ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#ffffff';
    if (typeof v === 'number') {
      const pts = { 1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]] }[v];
      for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(58 + x * 70, 58 + y * 70, 24, 0, 7); ctx.fill(); }
    } else if (v === 'mono') {
      ctx.font = '400 150px "Lilita One"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('★', 128, 140);
    } else {
      // Buss
      ctx.beginPath(); ctx.roundRect(40, 70, 176, 100, 18); ctx.fill();
      ctx.fillStyle = '#E3242B';
      for (let k = 0; k < 4; k++) ctx.fillRect(56 + k * 38, 86, 28, 30);
      ctx.fillStyle = '#ffffff';
      for (const x of [80, 176]) { ctx.beginPath(); ctx.arc(x, 178, 20, 0, 7); ctx.fill(); }
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- Tweening ----------
  const ease = {
    inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    out: (t) => 1 - Math.pow(1 - t, 3),
    outBack: (t) => { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  };
  // Neste animasjonssteg: requestAnimationFrame, men med en tidtaker som reserve. Nettleseren stopper
  // rAF i skjulte faner/vinduer, og uten reserven ville spillmotoren (og online-verten) stå fast.
  function nextTick(cb) {
    let done = false;
    const id = requestAnimationFrame((t) => { if (!done) { done = true; cb(t); } });
    setTimeout(() => { if (!done) { done = true; cancelAnimationFrame(id); cb(performance.now()); } }, 100);
  }
  // Alle animasjoner går gjennom tween; når «Hopp over» er på, hopper de rett til slutten.
  function tween(dur, fn) {
    return new Promise((res) => {
      if (Board3D.skipping || dur <= 0) { fn(1); res(); return; }
      const t0 = performance.now();
      const step = (now) => {
        const t = Board3D.skipping ? 1 : Math.min(1, (performance.now() - t0) / dur);
        fn(t);
        if (t < 1) nextTick(step); else res();
      };
      nextTick(step);
    });
  }
  function delay(ms) {
    return new Promise((res) => {
      if (Board3D.skipping || ms <= 0) { res(); return; }
      const t0 = performance.now();
      const step = () => { if (Board3D.skipping || performance.now() - t0 >= ms) res(); else nextTick(step); };
      nextTick(step);
    });
  }
  function softDot(THREE) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.45, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- Selve scenen ----------
  const Board3D = {
    speed: 1,
    pace: 1,
    // Effektivt tempo: spillets tempo × raskere animasjon på datamaskinens turer.
    get v() { return (this.speed || 1) * (this.pace || 1); },
    setPace(mode) { this.pace = mode === 'ai' ? 1.8 : 1; },
    tokens: {},
    houses: {},
    async init(container) {
      const THREE = window.THREE;
      await Promise.all([
        document.fonts.load('400 40px "Lilita One"'), document.fonts.load('800 40px Montserrat'),
        document.fonts.load('900 40px Montserrat'), document.fonts.load('700 40px Montserrat'),
      ]).catch(() => {});
      this.THREE = THREE;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
      renderer.setSize(container.clientWidth, container.clientHeight);
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      container.appendChild(renderer.domElement);
      this.renderer = renderer; this.container = container;

      const scene = new THREE.Scene();
      this.scene = scene;
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new window.RoomEnvironment(), 0.04).texture;

      const camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.1, 200);
      this.camera = camera;
      this.homeCam = new THREE.Vector3(0, 14.5, 13.2);
      camera.position.copy(this.homeCam);
      const controls = new window.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = 0.08;
      controls.minDistance = 5; controls.maxDistance = 30; controls.maxPolarAngle = 1.32;
      controls.target.set(0, 0, 0.4);
      controls.enablePan = true; controls.screenSpacePanning = false;
      this.controls = controls;

      // Lys
      // Mer sol og mindre himmellys enn før gir tydeligere skygger uten at det lyse blir lysere.
      this.hemi = new THREE.HemisphereLight(0xfff4e0, 0x3a2a20, 0.46);
      scene.add(this.hemi);
      const sun = new THREE.DirectionalLight(0xfff1dd, 1.27);
      this.sun = sun; this.sunOffset = new THREE.Vector3(-7, 16, 9);
      scene.add(sun.target);
      sun.position.set(-7, 16, 9); sun.castShadow = true;
      sun.shadow.mapSize.set(4096, 4096);
      Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 50 });
      sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 4;
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0xbfd8ff, 0.35); fill.position.set(10, 8, -8); scene.add(fill);
      scene.environmentIntensity = 0.8;

      // Omgivelser: levende Oslo hvis city3d.js finnes, ellers et trebord.
      this.city = null;
      if (MP.City && MP.City.build) {
        try {
          const low = Math.min(window.innerWidth, window.innerHeight) < 600 || (navigator.hardwareConcurrency || 8) <= 4;
          this.city = MP.City.build(THREE, scene, { renderer, quality: low ? 'low' : 'high' });
        } catch (err) { console.error('City.build feilet', err); this.city = null; }
      }
      if (!this.city) {
        const table = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ map: woodTexture(THREE), roughness: 0.55, metalness: 0.0 }));
        table.rotation.x = -Math.PI / 2; table.position.y = -0.36; table.receiveShadow = true; scene.add(table);
      }

      // Brett
      const boardTex = new THREE.CanvasTexture(MP.BoardTex.draw());
      boardTex.colorSpace = THREE.SRGBColorSpace; boardTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const side = new THREE.MeshStandardMaterial({ color: MP.BoardTex.frameColor || 0xf2efe6, roughness: 0.5 });
      const base = new THREE.Mesh(new window.RoundedBoxGeometry(13.3, 0.36, 13.3, 4, 0.08), side);
      base.position.y = -0.18; base.castShadow = true; base.receiveShadow = true; scene.add(base);
      const top = new THREE.Mesh(new THREE.PlaneGeometry(13, 13), new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.5, metalness: 0 }));
      top.rotation.x = -Math.PI / 2; top.position.y = 0.002; top.receiveShadow = true; scene.add(top);
      this.boardTop = top;
      // Gullkant rundt brettflaten
      const trimMat = new THREE.MeshStandardMaterial({ color: 0xf2c94c, metalness: 0.85, roughness: 0.3 });
      for (const [w, d, x, z] of [[13.22, 0.07, 0, 6.58], [13.22, 0.07, 0, -6.58], [0.07, 13.22, 6.58, 0], [0.07, 13.22, -6.58, 0]]) {
        const bar = new THREE.Mesh(new window.RoundedBoxGeometry(w, 0.05, d, 2, 0.02), trimMat);
        bar.position.set(x, 0.012, z); bar.castShadow = true; scene.add(bar);
      }

      // Hevede fargefelt
      this.bandTop = {};
      for (const sq of SQ) {
        if (sq.type !== 'street') continue;
        const r = localRect(sq.index), s = sideOf(sq.index);
        const mat = new THREE.MeshStandardMaterial({ color: MP.GROUPS[sq.group].color, roughness: 0.35, metalness: 0.05 });
        const band = new THREE.Mesh(new window.RoundedBoxGeometry(0.97, 0.06, BAND - 0.03, 2, 0.015), mat);
        const [x, z] = rot(s, (r.x0 + r.x1) / 2, r.z0 + BAND / 2);
        band.position.set(x, 0.03, z); band.rotation.y = -s * Math.PI / 2;
        band.castShadow = true; band.receiveShadow = true; scene.add(band);
        this.bandTop[sq.index] = band;
      }

      // Kortbunker
      this.decks = {};
      for (const [type, x, z] of [['chest', -2.35, -2.35], ['chance', 2.35, 2.35]]) {
        const grp = new THREE.Group();
        const col = type === 'chance' ? 0xF7941D : 0x2E7FD9;
        const edge = new THREE.MeshStandardMaterial({ color: 0xf6f3ea, roughness: 0.8 });
        const topMat = new THREE.MeshStandardMaterial({ map: cardTopTexture(THREE, type), roughness: 0.5 });
        const mats = [edge, edge, topMat, new THREE.MeshStandardMaterial({ map: cardBackTexture(THREE, type), roughness: 0.5 }), edge, edge];
        const stack = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.14, 1.0), mats);
        stack.position.y = 0.07; stack.castShadow = true; stack.receiveShadow = true; grp.add(stack);
        grp.position.set(x, 0, z); grp.rotation.y = Math.PI / 4;
        scene.add(grp);
        this.decks[type] = { grp, mats, topMat };
      }

      // Terninger
      const faceMats = [1, 6, 2, 5, 3, 4].map((n) => new THREE.MeshPhysicalMaterial({ map: diceFace(THREE, n), roughness: 0.18, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.15 }));
      const DIE = 0.62;
      this.dieHalf = DIE / 2;
      this.dice = [0, 1].map((n) => {
        const d = new THREE.Mesh(new window.RoundedBoxGeometry(DIE, DIE, DIE, 5, 0.1), faceMats);
        d.castShadow = true; d.position.set(-0.5 + n * 1.0, DIE / 2, 1.6); scene.add(d); return d;
      });
      // Fartsterning: rød med 1, 2, 3, M, M og buss (bare synlig når husregelen brukes).
      const speedFaces = [1, 'mono', 2, 'mono', 3, 'bus'].map((v) => new THREE.MeshPhysicalMaterial({ map: speedFace(THREE, v), roughness: 0.2, clearcoat: 0.8 }));
      this.speedDie = new THREE.Mesh(new window.RoundedBoxGeometry(DIE, DIE, DIE, 5, 0.1), speedFaces);
      this.speedDie.castShadow = true; this.speedDie.visible = false; scene.add(this.speedDie);

      // Hus-geometri og materialer (med pipe), vinduer som egen mesh
      this.houseGeo = houseGeo(THREE, 0.15, 0.11, 0.17, true);
      this.hotelGeo = houseGeo(THREE, 0.42, 0.19, 0.22, false);
      this.houseMat = new THREE.MeshStandardMaterial({ color: 0x17A24A, roughness: 0.3 });
      this.hotelMat = new THREE.MeshStandardMaterial({ color: 0xD0161D, roughness: 0.3 });
      this.winMat = new THREE.MeshStandardMaterial({ color: 0xfff6c8, emissive: 0xffd76a, emissiveIntensity: 0.35, roughness: 0.4 });
      this.houseWinGeo = windowsGeo(THREE, 0.15, 0.11, 0.17, 1);
      this.hotelWinGeo = windowsGeo(THREE, 0.42, 0.19, 0.22, 3);

      // Etterbehandling (tilt-shift, bloom, fargegradering) hvis postfx.js finnes.
      this.gfx = 'high';
      this.fx = null;
      if (MP.PostFX && MP.PostFX.create && window.PostFXDeps) {
        try { this.fx = MP.PostFX.create(THREE, renderer, scene, camera, { quality: 'high' }); }
        catch (err) { console.error('PostFX feilet', err); this.fx = null; }
      }

      // Markering av felt (hover/landing)
      const hl = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthWrite: false }));
      hl.rotation.x = -Math.PI / 2; hl.position.y = 0.075; scene.add(hl);
      this.hl = hl;
      const pulse = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xFFE21F, transparent: true, opacity: 0, depthWrite: false }));
      pulse.rotation.x = -Math.PI / 2; pulse.position.y = 0.08; scene.add(pulse);
      this.pulse = pulse;

      // Effekter: partikler, mynter, ring under aktiv brikke, politilys ved fengselet.
      this.parts = [];
      this.dotTex = softDot(THREE);
      this.coinGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 28);
      this.coinMat = new THREE.MeshStandardMaterial({ color: 0xffd84a, metalness: 0.75, roughness: 0.2, emissive: 0x8a6200, emissiveIntensity: 0.55 });
      this.billGeo = new THREE.PlaneGeometry(0.34, 0.17);
      this.billMat = new THREE.MeshStandardMaterial({ color: 0x5fd17a, roughness: 0.6, side: THREE.DoubleSide, emissive: 0x1d5a2a, emissiveIntensity: 0.3 });
      this.activeRing = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.38, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      this.activeRing.rotation.x = -Math.PI / 2; scene.add(this.activeRing);
      this.activeId = null;
      this.followMode = true;
      this.skipping = false;
      this.chase = null; this.camSaved = null; this.chaseTimer = null;
      this.tmpV = new THREE.Vector3(); this.tmpV2 = new THREE.Vector3();

      this.ownerPlates = {}; this.mortOverlays = {};
      this.raycaster = new THREE.Raycaster();
      this.pointer = new THREE.Vector2();
      this.hoverCb = null; this.clickCb = null;
      let downAt = null;
      renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
      renderer.domElement.addEventListener('pointerup', (e) => {
        if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
        const i = this.pick(e);
        if (i >= 0 && this.clickCb) this.clickCb(i);
      });
      renderer.domElement.addEventListener('pointermove', (e) => {
        const i = this.pick(e);
        this.setHover(i);
        renderer.domElement.style.cursor = i >= 0 && MP.isOwnable(i) ? 'pointer' : '';
        if (this.hoverCb) this.hoverCb(i, e);
      });
      window.addEventListener('resize', () => this.resize());
      this.follow = null;
      this.clock = new THREE.Clock();
      renderer.setAnimationLoop(() => this.frame());
    },

    resize() {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.renderer.setSize(w, h); this.camera.aspect = w / h;
      if (this.fx && this.fx.setSize) this.fx.setSize(w, h);
      this.camera.fov = w / h < 0.8 ? 50 : 38;
      this.viewShift = null;
      this.updateViewOffset();
      this.camera.updateProjectionMatrix();
      // Bytter skjermen mellom stående og liggende, tilpass kameraet så hele brettet synes.
      const portrait = w / h < 0.8;
      if (this.wasPortrait !== undefined && portrait !== this.wasPortrait && !this.chase && !this.menu) this.resetView();
      this.wasPortrait = portrait;
    },
    // HUD-en (knapper og spillerkort nederst, toppknapper) dekker deler av bildet.
    // Projeksjonen flyttes så brettets midtpunkt havner midt i det frie området.
    hudInsets() {
      const H = this.container.clientHeight;
      const hud = document.getElementById('hud');
      if (!hud || hud.hidden) return { top: 0, bottom: 0 };
      const tops = ['#players', '#actions'].map((s) => document.querySelector(s)).filter(Boolean)
        .map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top);
      const bottom = tops.length ? Math.max(0, H - Math.min(...tops)) : 0;
      return { top: 56, bottom };
    },
    updateViewOffset() {
      const W = this.container.clientWidth, H = this.container.clientHeight;
      const { top, bottom } = this.hudInsets();
      const shift = Math.round((bottom - top) / 2);
      if (shift === this.viewShift) return;
      this.viewShift = shift;
      if (shift) this.camera.setViewOffset(W, H, 0, shift, W, H); else this.camera.clearViewOffset();
    },
    // Uskarp bakgrunn bak dialoger (som Monopoly Plus). UI kaller setBackdropBlur(true/false).
    setBackdropBlur(on) {
      if (this.fx && this.fx.setBackdropBlur && this.gfx === 'high') { try { this.fx.setBackdropBlur(on ? 1 : 0); } catch (e) { /* valgfritt */ } }
    },
    // Grafikknivå fra innstillingene: 'high' | 'low' | 'off' (etterbehandling og skyggekvalitet).
    setGfx(q) {
      this.gfx = q || 'high';
      if (this.fx && this.fx.setQuality && this.gfx !== 'off') this.fx.setQuality(this.gfx);
      this.renderer.setPixelRatio(Math.min(this.gfx === 'low' ? 1 : 2, window.devicePixelRatio));
      this.resize();
    },
    // Kameraavstand som får hele brettet inn i bildet (også på smale skjermer).
    homePosition() {
      const vf = (this.camera.fov * Math.PI) / 180;
      const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
      const H = this.container.clientHeight, ins = this.hudInsets();
      const free = Math.max(0.45, (H - ins.top - ins.bottom) / H);
      // Hjørnene nærmest kameraet ser bredere ut, så smale skjermer trenger ekstra margin.
      const a = this.camera.aspect;
      const halfW = a < 0.6 ? 11.8 : a < 1 ? 10.6 : 7.4;
      const dist = Math.max(16, halfW / Math.tan(hf / 2), 6.0 / Math.tan(vf / 2) / free);
      return new this.THREE.Vector3(0, 14.5, 13.2).normalize().multiplyScalar(dist);
    },

    frame() {
      const dt = Math.min(0.05, this.clock.getDelta());
      const now = performance.now();
      if (this.chase) {
        // Kameraet ligger lavt bak brikken (som i Monopoly Plus): litt utenfor brettkanten,
        // bak i kjøreretningen, og ser fremover langs raden.
        const p = this.chase.position;
        const yaw = this.chase.rotation.y;
        const fx = Math.cos(yaw), fz = -Math.sin(yaw);                 // fremover for brikken
        const out = this.tmpV.set(p.x, 0, p.z); const len = out.length() || 1; out.multiplyScalar(1 / len);
        const k = 1 - Math.exp(-dt * 2.2);
        const want = this.tmpV2.set(p.x - fx * 3.0 + out.x * 2.6, 3.0, p.z - fz * 3.0 + out.z * 2.6);
        this.camera.position.lerp(want, k);
        want.set(p.x + fx * 2.2 - out.x * 0.6, 0, p.z + fz * 2.2 - out.z * 0.6);
        this.controls.target.lerp(want, k);
      }
      if (this.pulse.material.opacity > 0) this.pulse.material.opacity = Math.max(0, this.pulse.material.opacity - dt * 0.35);
      for (const t of Object.values(this.tokens)) {
        if (t.idle && !t.moving) t.body.position.y = t.baseY + 0.04 + Math.sin(now / 300) * 0.025;
        else this.fidget(t, now);
        this.animateParts(t, now, dt);
      }
      // Pulserende ring under den aktive brikken
      const at = this.activeId != null && this.tokens[this.activeId];
      if (at && at.obj.visible) {
        this.activeRing.position.set(at.obj.position.x, 0.012, at.obj.position.z);
        const boost = this.ringPulseUntil && now < this.ringPulseUntil ? (this.ringPulseUntil - now) / 1300 : 0;
        const s = 1 + 0.12 * Math.sin(now / 260) + boost * (0.6 + 0.4 * Math.sin(now / 90));
        this.activeRing.scale.set(s, s, s);
        this.activeRing.material.opacity = Math.min(1, 0.55 + 0.25 * Math.sin(now / 260) + boost * 0.45);
      } else this.activeRing.material.opacity = 0;
      this.updateParticles(dt);
      // Skyggeområdet (±9) følger det kameraet ser på, låst til et rutenett så skyggene ikke flimrer.
      if (this.sun) {
        const tg = this.chase ? this.chase.position : this.controls.target;
        const sx = Math.round(tg.x * 0.6 / 0.5) * 0.5, sz = Math.round(tg.z * 0.6 / 0.5) * 0.5;
        if (sx !== this.sunX || sz !== this.sunZ) {
          this.sunX = sx; this.sunZ = sz;
          this.sun.target.position.set(sx, 0, sz);
          this.sun.position.set(sx + this.sunOffset.x, this.sunOffset.y, sz + this.sunOffset.z);
          this.sun.target.updateMatrixWorld();
        }
      }
      if ((this.frameN = (this.frameN || 0) + 1) % 20 === 0) this.updateViewOffset();
      if (this.city) { try { this.city.update(dt, now / 1000); } catch (e) { console.error(e); this.city = null; } }
      // Kamerarystelse (terningsprett o.l.): legges på etter OrbitControls og trekkes fra igjen neste bilde.
      if (this.shakeOff) this.camera.position.sub(this.shakeOff);
      this.controls.update();
      if (this.shakeAmt > 0.001) {
        this.shakeOff = this.shakeOff || new this.THREE.Vector3();
        this.shakeOff.set((Math.random() - 0.5) * this.shakeAmt, (Math.random() - 0.5) * this.shakeAmt, (Math.random() - 0.5) * this.shakeAmt);
        this.camera.position.add(this.shakeOff);
        this.shakeAmt *= Math.exp(-dt * 9);
      } else if (this.shakeOff) this.shakeOff.set(0, 0, 0);
      if (this.fx && this.gfx !== 'off') {
        try { if (this.fx.setFocus) this.fx.setFocus(this.chase ? this.chase.position : this.controls.target); this.fx.render(dt); }
        catch (e) { console.error('PostFX', e); this.fx = null; this.renderer.render(this.scene, this.camera); }
      } else this.renderer.render(this.scene, this.camera);
    },

    // ---------- Hopp over ----------
    setSkip(on) {
      this.skipping = !!on;
      if (on) {
        this.chase = null; clearTimeout(this.chaseTimer);
        if (this.camSaved) { this.camera.position.copy(this.camSaved.pos); this.controls.target.copy(this.camSaved.target); this.camSaved = null; }
        for (const q of this.parts) q.life = 0;
      }
    },

    // ---------- Kamera ----------
    // Kameraregi: hver glid får et skuddnummer. En nyere glid avbryter den gamle, og «returer»
    // (tilbake etter kjøp/bygg/fargegruppe) kjøres bare hvis ingen nyere glid har startet i mellomtiden.
    glideCam(pos, target, ms) {
      const shot = (this.shot = (this.shot || 0) + 1);
      const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
      return tween(ms / Math.sqrt(this.v), (k) => {
        if (this.chase || shot !== this.shot) return;
        const e = ease.inOut(k);
        this.camera.position.lerpVectors(p0, pos, e);
        this.controls.target.lerpVectors(t0, target, e);
      });
    },
    // Retur til et lagret bilde – men bare hvis ingen andre har tatt over kameraet etter skudd `since`.
    returnCam(back, since, ms = 800) {
      if (!back || this.shot !== since || this.chase) return Promise.resolve();
      return this.glideCam(back.pos, back.target, ms);
    },
    startChase(obj) {
      clearTimeout(this.chaseTimer);
      if (!this.followMode || this.skipping || this.menu) return;
      if (!this.camSaved) this.camSaved = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
      this.chase = obj;
    },
    // Etter et trekk: rolig «landingsbilde» av brikken og feltet (ikke tilbake til oversikt).
    endChase(wait = 350) {
      if (!this.chase) return;
      const obj = this.chase;
      this.chase = null;
      this.camSaved = null;
      clearTimeout(this.chaseTimer);
      this.chaseTimer = setTimeout(() => {
        if (this.chase) return;
        this.glideCam(...this.settleShot(obj.position), 900);
      }, this.skipping ? 0 : wait / this.v);
    },
    settleShot(p) {
      const THREE = this.THREE;
      const out = new THREE.Vector3(p.x, 0, p.z); const len = out.length() || 1; out.multiplyScalar(1 / len);
      // Sikter på selve brikken (litt innover), så den havner midt i det frie bildet over HUD-en.
      return [new THREE.Vector3(p.x + out.x * 4.6, 5.4, p.z + out.z * 4.6), new THREE.Vector3(p.x - out.x * 0.9, 0, p.z - out.z * 0.9)];
    },
    posOf(id) {
      const g = MP.UI && MP.UI.game; const p = g && g.player(id);
      return p ? (p.pos === 10 ? 11 : p.pos % 10 === 0 ? p.pos + 1 : p.pos) : 1;
    },
    // Ved turstart: mennesker får oversikt over brettet (tallskiltene!), datamaskinen et nærbilde av brikken.
    turnCam(id, human) {
      const t = this.tokens[id];
      clearTimeout(this.chaseTimer);
      this.chase = null; this.camSaved = null;
      if (!t || !this.followMode || this.skipping) return Promise.resolve();
      if (human === undefined) human = !(MP.UI && MP.UI.game && MP.UI.game.player(id) && MP.UI.game.player(id).ai);
      if (human && this.camera.aspect < 0.8) {
        // Smal/stående skjerm: nærbildet ville kuttet brettet – vis hele brettet i stedet.
        return this.glideCam(this.homePosition(), new this.THREE.Vector3(0, 0, 0.4), 900);
      }
      if (human) {
        // Bak og over brikken, sett fremover langs ruten der tallskiltene (2–12) står.
        const THREE = this.THREE, p = t.obj.position;
        const yaw = travelYaw(this.posOf(id));
        const fx = Math.cos(yaw), fz = -Math.sin(yaw);
        const out = new THREE.Vector3(p.x, 0, p.z); const len = out.length() || 1; out.multiplyScalar(1 / len);
        const pos = new THREE.Vector3(p.x - fx * 4.4 + out.x * 3.4, 6.6, p.z - fz * 4.4 + out.z * 3.4);
        const tgt = new THREE.Vector3(p.x + fx * 1.9 - out.x * 1.5, 0, p.z + fz * 1.9 - out.z * 1.5);
        this.ringPulseUntil = performance.now() + 1300;   // «se her»-puls under egen brikke
        return this.glideCam(pos, tgt, 900);
      }
      return this.glideCam(...this.settleShot(t.obj.position), 800);
    },
    introFly() {
      const THREE = this.THREE, home = this.homePosition();
      const r1 = Math.hypot(home.x, home.z), h1 = home.y;
      this.controls.autoRotate = false;
      return tween(2600, (k) => {
        const e = ease.inOut(k);
        const a = (1 - e) * Math.PI * 1.15, r = 34 + (r1 - 34) * e, h = 16 + (h1 - 16) * e;
        this.camera.position.set(Math.sin(a) * r, h, Math.cos(a) * r);
        this.controls.target.set(0, 0, 0.4 * e);
      });
    },
    menuMode(on) {
      this.menu = !!on;
      this.controls.autoRotate = !!on;
      this.controls.autoRotateSpeed = 0.35;
      if (on) return this.glideCam(new this.THREE.Vector3(0, 11, 24), new this.THREE.Vector3(0, 0, 0), 1200);
      return Promise.resolve();
    },

    // ---------- Partikler og effekter ----------
    spawn(mesh, o) {
      mesh.position.copy(o.pos);
      this.scene.add(mesh);
      this.parts.push({ mesh, vel: o.vel, life: o.life, max: o.life, grav: o.grav ?? 0, spin: o.spin || null, s0: o.s0 ?? 1, s1: o.s1 ?? 1, fade: o.fade !== false, own: o.own });
    },
    updateParticles(dt) {
      for (let n = this.parts.length - 1; n >= 0; n--) {
        const q = this.parts[n];
        q.life -= dt;
        if (q.life <= 0) {
          this.scene.remove(q.mesh);
          if (q.own) q.mesh.material.dispose();
          this.parts.splice(n, 1);
          continue;
        }
        const k = 1 - q.life / q.max;
        q.vel.y -= q.grav * dt;
        q.mesh.position.addScaledVector(q.vel, dt);
        if (q.spin) { q.mesh.rotation.x += q.spin.x * dt; q.mesh.rotation.y += q.spin.y * dt; q.mesh.rotation.z += q.spin.z * dt; }
        const s = q.s0 + (q.s1 - q.s0) * k;
        q.mesh.scale.set(s, s, s);
        if (q.fade && q.mesh.material.opacity !== undefined) q.mesh.material.opacity = Math.min(1, (1 - k) * 1.6) * (q.mesh.material.userData.alpha ?? 1);
      }
    },
    dust(pos, n, color = 0xf3ead8) {
      if (this.skipping) return;
      const THREE = this.THREE;
      for (let k = 0; k < n; k++) {
        const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, color, transparent: true, depthWrite: false }));
        m.material.userData.alpha = 0.75;
        const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
        const sp = 0.5 + Math.random() * 0.5;
        this.spawn(m, { pos: new THREE.Vector3(pos.x + Math.cos(a) * 0.12, 0.06, pos.z + Math.sin(a) * 0.12), vel: new THREE.Vector3(Math.cos(a) * sp, 0.25 + Math.random() * 0.2, Math.sin(a) * sp), life: 0.55 + Math.random() * 0.25, s0: 0.12, s1: 0.42, own: true });
      }
    },
    sparkle(pos, color, n = 18) {
      if (this.skipping) return;
      const THREE = this.THREE;
      for (let k = 0; k < n; k++) {
        const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        m.material.color.multiplyScalar(2.6); // HDR-farge så etterbehandlingens bloom gir glød
        const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.2;
        this.spawn(m, { pos: new THREE.Vector3(pos.x, 0.15, pos.z), vel: new THREE.Vector3(Math.cos(a) * sp, 1.6 + Math.random() * 1.6, Math.sin(a) * sp), life: 0.8 + Math.random() * 0.5, grav: 3.2, s0: 0.22, s1: 0.04, own: true });
      }
    },
    moneyBurst(pos) {
      if (this.skipping) return;
      const THREE = this.THREE;
      for (let k = 0; k < 14; k++) {
        const bill = k % 3 === 0;
        const m = new THREE.Mesh(bill ? this.billGeo : this.coinGeo, bill ? this.billMat : this.coinMat);
        m.castShadow = true;
        const a = Math.random() * Math.PI * 2, sp = 0.4 + Math.random() * 0.9;
        this.spawn(m, { pos: new THREE.Vector3(pos.x, 0.3, pos.z), vel: new THREE.Vector3(Math.cos(a) * sp, 2.2 + Math.random() * 1.4, Math.sin(a) * sp), life: 1.1 + Math.random() * 0.3, grav: 5.5, spin: new THREE.Vector3(Math.random() * 9, Math.random() * 9, Math.random() * 9), fade: false });
      }
      this.sparkle(pos, 0xffe680, 10);
    },
    anchor(id) {
      if (id == null) return new this.THREE.Vector3(0, 0.6, 0.3);
      const t = this.tokens[id];
      return t ? t.obj.position.clone().setY(0.5) : new this.THREE.Vector3(0, 0.6, 0.3);
    },
    // Mynter flyr fra betaler til mottaker (null = banken midt på brettet).
    async payAnim(fromId, toId, amount) {
      if (this.skipping) return;
      if (fromId != null) this.sad(fromId);
      const THREE = this.THREE;
      const a = this.anchor(fromId), b = this.anchor(toId);
      const n = Math.min(14, 4 + Math.round(amount / 1500));
      const flights = [];
      for (let k = 0; k < n; k++) {
        const bill = k % 3 === 1;
        const m = new THREE.Mesh(bill ? this.billGeo : this.coinGeo, bill ? this.billMat : this.coinMat);
        m.castShadow = true;
        const jitter = new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3);
        const h = 1.6 + Math.random() * 0.9;
        flights.push(delay(k * 55).then(() => {
          this.scene.add(m);
          return tween(780 / Math.sqrt(this.v), (t) => {
            const e = ease.inOut(t);
            m.position.lerpVectors(a, b, e).add(jitter);
            m.position.y += Math.sin(Math.PI * t) * h;
            m.rotation.set(t * 14, t * 6, 0);
            const s = t < 0.1 ? t / 0.1 : t > 0.9 ? (1 - t) / 0.1 : 1;
            m.scale.setScalar(Math.max(0.01, s));
          }).then(() => {
            this.scene.remove(m);
            if (k % 2 === 0 && !this.skipping && MP.Sound) MP.Sound.coin();
            if (k % 3 === 0) this.sparkle(b, 0xffe680, 3);
          });
        }));
      }
      await Promise.all(flights);
    },
    // ---------- Tallskilt før kastet (som i Monopoly Plus) ----------
    // Viser 2–12 på feltene brikken kan lande på; de mest sannsynlige summene står størst.
    numberTex(n) {
      this.numTex = this.numTex || {};
      if (this.numTex[n]) return this.numTex[n];
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const ctx = c.getContext('2d');
      ctx.beginPath(); ctx.arc(64, 64, 56, 0, 7);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 10; ctx.strokeStyle = '#1C56C9'; ctx.stroke();
      ctx.fillStyle = '#13171c'; ctx.font = '400 72px "Lilita One"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), 64, 70);
      const t = new this.THREE.CanvasTexture(c); t.colorSpace = this.THREE.SRGBColorSpace;
      return (this.numTex[n] = t);
    },
    showReach(pos) {
      this.hideReach();
      if (this.skipping) return;
      const THREE = this.THREE;
      this.reach = [];
      const g = MP.UI && MP.UI.game, me = g && g.current;
      for (let n = 2; n <= 12; n++) {
        const i = (pos + n) % 40, c = centerWorld(i);
        const prob = (6 - Math.abs(7 - n)) / 6;
        // Risiko før kastet: eiers farge og leien man må betale, grønt med pris på ledige eiendommer.
        let info = null;
        if (g && MP.isOwnable(i)) {
          const o = g.ownerOf(i), pr = g.s.props[i];
          if (!o) info = { col: '#2BB673', text: 'kr ' + String(SQ[i].price).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') };
          else if (o !== me && !pr.mortgaged && !(o.inJail && g.rules && g.rules.noJailRent)) {
            info = { col: o.color, text: '−kr ' + String(g.rentFor(i, n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') };
          } else if (o === me) info = { col: o.color, text: 'din' };
        }
        const tex = info ? this.riskTex(n, info.col, info.text) : this.numberTex(n);
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
        s.userData.ownTex = !!info;
        const size = (0.34 + 0.22 * prob) * (info ? 1.25 : 1);
        s.position.set(c.x, 0.55 + 0.1 * prob, c.z); s.scale.setScalar(0.01);
        s.userData.size = size;
        this.scene.add(s);
        this.reach.push(s);
        const aspect = info ? 1.25 : 1;
        if (info) s.position.y += 0.1;
        tween(300, (k) => { const v = Math.max(0.01, size * ease.outBack(k)); s.scale.set(v, v * aspect, 1); s.material.opacity = Math.min(1, k * 2) * (0.6 + 0.4 * prob); });
      }
    },
    hideReach() {
      if (!this.reach) return;
      for (const s of this.reach) { this.scene.remove(s); if (s.userData.ownTex && s.material.map) s.material.map.dispose(); s.material.dispose(); }
      this.reach = null;
    },
    // Tallskilt med farge og beløp under (leie eller pris).
    riskTex(n, col, text) {
      const c = document.createElement('canvas'); c.width = 160; c.height = 200;
      const ctx = c.getContext('2d');
      ctx.beginPath(); ctx.arc(80, 70, 58, 0, 7);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 12; ctx.strokeStyle = col; ctx.stroke();
      ctx.fillStyle = '#13171c'; ctx.font = '400 74px "Lilita One"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), 80, 76);
      ctx.font = '900 30px Montserrat';
      const w = Math.min(156, ctx.measureText(text).width + 22);
      ctx.beginPath(); ctx.roundRect(80 - w / 2, 140, w, 44, 22);
      ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeText(text, 80, 163, 146); ctx.fillText(text, 80, 163, 146);
      const t = new this.THREE.CanvasTexture(c); t.colorSpace = this.THREE.SRGBColorSpace;
      return t;
    },
    // «SOLGT!»-skilt i eierens farge som spretter opp over feltet.
    soldSign(i, color) {
      const THREE = this.THREE;
      const c = document.createElement('canvas'); c.width = 256; c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 10;
      ctx.beginPath(); ctx.roundRect(8, 8, 240, 112, 24); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.font = '400 64px "Lilita One"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.strokeText('SOLGT!', 128, 68); ctx.fillText('SOLGT!', 128, 68);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      // 3D-skilt på stolpe som skyter opp fra ytterkanten av feltet, vipper og synker ned igjen.
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 10), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
      pole.position.y = 0.35; pole.castShadow = true; g.add(pole);
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.36, 0.03), [
        new THREE.MeshStandardMaterial({ color }), new THREE.MeshStandardMaterial({ color }),
        new THREE.MeshStandardMaterial({ color }), new THREE.MeshStandardMaterial({ color }),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4 }),
      ]);
      board.position.y = 0.78; board.castShadow = true; g.add(board);
      const k0 = kOf(i), s = sideOf(i);
      const [lx, lz] = [k0 === 0 ? 5.6 : 5 - k0, k0 === 0 ? 5.6 : 5.75];
      const [x, z] = rot(s, lx, lz);
      g.position.set(x, -0.9, z);
      // Skiltet vender mot kameraet.
      g.lookAt(this.camera.position.x, -0.9, this.camera.position.z);
      this.scene.add(g);
      return tween(1500 / this.v, (k) => {
        const up = k < 0.25 ? ease.outBack(k / 0.25) : k > 0.8 ? 1 - ease.inOut((k - 0.8) / 0.2) : 1;
        g.position.y = -0.9 + up * 0.92;
        board.rotation.z = Math.sin(k * Math.PI * 6) * 0.08 * (1 - k);
      }).then(() => {
        this.scene.remove(g);
        g.traverse((o) => { if (o.geometry) o.geometry.dispose(); const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; ms.forEach((m) => m.dispose()); });
        tex.dispose();
      });
    },
    // Fargegruppe komplett: kameraet glir til gruppen, feltene lyser og byen jubler.
    async setCompleteAnim(group, id) {
      if (this.skipping || !group) return;
      // Store øyeblikk får full lengde også i datamaskinens raskere tempo.
      const pace0 = this.pace; this.pace = 1;
      try { await this.setCompleteInner(group, id); } finally { this.pace = pace0; }
    },
    async setCompleteInner(group, id) {
      const THREE = this.THREE;
      const idx = SQ.filter((sq) => sq.group === group).map((sq) => sq.index);
      const col = new THREE.Color(MP.GROUPS[group].color);
      const mid = idx.reduce((a, i) => { const c = centerWorld(i); return a.add(new THREE.Vector3(c.x, 0, c.z)); }, new THREE.Vector3()).multiplyScalar(1 / idx.length);
      const back = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
      clearTimeout(this.chaseTimer); this.chase = null;
      if (this.followMode) {
        // Se utover mot gruppens tomter i byen (husene står på rad der), fra litt lenger unna enn ved ett kjøp.
        const [cp, ct] = this.lotShot(idx[Math.floor(idx.length / 2)]);
        const out = mid.clone().setY(0).normalize();
        cp.add(out.clone().multiplyScalar(-1.2)).setY(3.4);
        await this.glideCam(cp, ct, 700);
        this.setShot = this.shot;
      }
      idx.forEach((i, n) => setTimeout(() => {
        const c = centerWorld(i);
        this.flash(i);
        this.sparkle(new THREE.Vector3(c.x, 0, c.z), col, 18);
        this.ringBurst(new THREE.Vector3(c.x, 0, c.z), col.getHex());
        this.cheerAt(i);
      }, this.skipping ? 0 : n * 160));
      if (id != null) this.celebrate(id);
      await delay(1300 / this.v);
      if (this.followMode) await this.returnCam(back, this.setShot, 800);
    },
    // Jubel i byen ved tomten til felt i (hvis byen støtter det).
    cheerAt(i) {
      if (!this.city || !this.city.cheer || this.skipping) return;
      const c = centerWorld(i), out = Math.hypot(c.x, c.z) || 1;
      try { this.city.cheer(c.x + (c.x / out) * 2.2, c.z + (c.z / out) * 2.2); } catch (e) { /* byen kan mangle støtten */ }
    },
    cheer(i) { this.cheerAt(i); },

    // ---------- Brikkereaksjoner ----------
    // Glad: hopp med en hel piruett og gnister.
    async celebrate(id) {
      const t = this.tokens[id];
      if (!t || this.skipping || t.moving) return;
      t.moving = true;
      const obj = t.obj, y0 = obj.rotation.y, body = t.body, P = t.parts || {};
      this.sparkle(obj.position, new this.THREE.Color(t.color), 10);
      // Hver brikke jubler på sin måte.
      if (t.kind === 'car') {
        // Bilen «turer motoren»: fjærer, hjulene spinner og den steiler litt.
        const roll0 = t.roll;
        await tween(1000 / this.v, (k) => {
          const s = Math.sin(Math.PI * k);
          body.rotation.z = 0.32 * s * (k < 0.5 ? 1 : 1 - (k - 0.5) * 2);
          body.position.y = t.baseY + 0.04 + Math.abs(Math.sin(k * Math.PI * 6)) * 0.02 * (1 - k);
          if (P.wheels) { t.roll = roll0 + k * 40; for (const w of P.wheels) w.rotation[t.axis] = -t.roll; }
        });
        body.rotation.z = 0; body.position.y = t.baseY + 0.04;
        if (!this.skipping) this.dust(obj.position, 6, 0xd8d0c0);
      } else if (t.kind === 'hat') {
        // Hatten letter og tar en salto i lufta.
        await tween(260 / this.v, (k) => this.squash(t, 1 - 0.18 * ease.out(k), 1 + 0.1 * ease.out(k)));
        await tween(820 / this.v, (k) => {
          const air = Math.sin(Math.PI * k);
          obj.position.y = air * 0.85;
          body.rotation.x = ease.inOut(k) * Math.PI * 2;
          this.squash(t, 1 + 0.08 * air, 1 - 0.04 * air);
        });
        body.rotation.x = 0;
      } else if (t.kind === 'boot') {
        // Støvelen tramper tre ganger.
        await tween(1000 / this.v, (k) => {
          const st = Math.abs(Math.sin(k * Math.PI * 3));
          obj.position.y = st * 0.22;
          body.rotation.z = -st * 0.25;
          if (st < 0.05 && !this.skipping && Math.random() < 0.3) this.dust(obj.position, 3);
        });
        body.rotation.z = 0;
      } else if (t.kind === 'thimble') {
        // Fingerbølet snurrer som en snurrebass.
        await tween(1000 / this.v, (k) => {
          obj.rotation.y = y0 + ease.inOut(k) * Math.PI * 6;
          obj.position.y = Math.sin(Math.PI * k) * 0.3;
          body.rotation.z = Math.sin(k * Math.PI * 4) * 0.12 * (1 - k);
        });
        body.rotation.z = 0;
      } else if (t.kind === 'ship') {
        // Skipet gynger på en bølge og flagget blafrer.
        await tween(1100 / this.v, (k) => {
          body.rotation.x = Math.sin(k * Math.PI * 3) * 0.25 * (1 - k);
          obj.position.y = Math.sin(Math.PI * k) * 0.3;
        });
        body.rotation.x = 0;
      } else {
        // Hunden (og andre): hopp med en hel piruett.
        await tween(260 / this.v, (k) => this.squash(t, 1 - 0.22 * ease.out(k), 1 + 0.14 * ease.out(k)));
        await tween(720 / this.v, (k) => {
          const air = Math.sin(Math.PI * k);
          obj.position.y = air * 0.7;
          obj.rotation.y = y0 + ease.inOut(k) * Math.PI * 2;
          this.squash(t, 1 + 0.12 * air, 1 - 0.06 * air);
        });
      }
      obj.position.y = 0; obj.rotation.y = y0;
      this.dust(obj.position, 6);
      await tween(260 / this.v, (k) => { const s = Math.sin(Math.PI * k) * 0.2; this.squash(t, 1 - s, 1 + s * 0.6); });
      this.squash(t, 1, 1);
      t.moving = false;
    },
    // Trist: rister på seg og «synker» litt sammen.
    async sad(id) {
      const t = this.tokens[id];
      if (!t || this.skipping || t.moving) return;
      t.moving = true;
      const body = t.body;
      await tween(820 / this.v, (k) => {
        body.rotation.x = Math.sin(k * Math.PI * 7) * 0.22 * (1 - k);
        this.squash(t, 1 - 0.14 * Math.sin(Math.PI * k), 1 + 0.06 * Math.sin(Math.PI * k));
      });
      body.rotation.x = 0; this.squash(t, 1, 1);
      t.moving = false;
    },
    // Konkurs: brikken velter, synker ned i brettet og forsvinner.
    async bankruptAnim(id) {
      const t = this.tokens[id];
      if (!t) return;
      const obj = t.obj;
      if (!this.skipping) {
        this.dust(obj.position, 12, 0x9a8f80);
        if (this.city && this.city.smoke) { try { const o = obj.position, l = Math.hypot(o.x, o.z) || 1; this.city.smoke(o.x + (o.x / l) * 2.2, o.z + (o.z / l) * 2.2, 4); } catch (e) { /* valgfritt */ } }
        await tween(1400 / this.v, (k) => {
          const e = ease.inOut(k);
          obj.rotation.z = e * 1.4;
          obj.position.y = -e * 0.45;
          obj.scale.setScalar(1 - e * 0.6);
        });
      }
      obj.visible = false;
      obj.rotation.z = 0; obj.position.y = 0; obj.scale.setScalar(1);
    },
    // Fyrverkeri over byen (seier).
    fireworks(seconds = 6) {
      if (this.skipping) return;
      const THREE = this.THREE;
      const cols = [0xff3b3b, 0xffd23f, 0x3ec7ff, 0x5dff8a, 0xff6fd8, 0xffffff];
      const end = performance.now() + seconds * 1000;
      // Skumring mens fyrverkeriet går, så lysene synes – så tilbake til dagslys.
      if (this.sun && this.hemi && !this.dusk) {
        this.dusk = true;
        const s0 = this.sun.intensity, h0 = this.hemi.intensity;
        const dusk = new THREE.Color(0xffb27a), sc0 = this.sun.color.clone();
        tween(900, (k) => {
          this.sun.intensity = s0 * (1 - 0.72 * k); this.hemi.intensity = h0 * (1 - 0.6 * k);
          this.sun.color.copy(sc0).lerp(dusk, k);
        });
        setTimeout(() => tween(1400, (k) => {
          this.sun.intensity = s0 * (0.28 + 0.72 * k); this.hemi.intensity = h0 * (0.4 + 0.6 * k);
          this.sun.color.copy(dusk).lerp(sc0, k);
        }).then(() => { this.dusk = false; }), seconds * 1000 + 1500);
      }
      // Vinnerbilde: kameraet glir til vinnerens brikke med brettet og himmelen bak.
      const wt = this.activeId != null && this.tokens[this.activeId];
      if (wt && this.followMode) {
        const p = wt.obj.position, out = new THREE.Vector3(p.x, 0, p.z); const len = out.length() || 1; out.multiplyScalar(1 / len);
        this.glideCam(new THREE.Vector3(p.x + out.x * 4.5, 3.2, p.z + out.z * 4.5), new THREE.Vector3(p.x * 0.4, 2.2, p.z * 0.4), 1400);
        this.celebrate(this.activeId);
      }
      const spark = (pos, col, vel, life, s0, s1, grav) => {
        const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        m.material.color.multiplyScalar(3.2);
        this.spawn(m, { pos, vel, life, grav, s0, s1, own: true });
      };
      const burst = () => {
        if (performance.now() > end || this.skipping) return;
        // Over og rett rundt brettet, så utbruddene er i bildet.
        const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 6;
        const c = new THREE.Vector3(Math.cos(a) * r, 5 + Math.random() * 4, Math.sin(a) * r);
        const col = cols[Math.floor(Math.random() * cols.length)];
        // Rakett med hale opp til eksplosjonspunktet.
        const start = new THREE.Vector3(c.x * 0.85, 0, c.z * 0.85);
        const rise = 650;
        const t0 = performance.now();
        const trail = () => {
          const k = (performance.now() - t0) / rise;
          if (k >= 1 || this.skipping) return;
          const p = start.clone().lerp(c, ease.out(k));
          spark(p, 0xfff1c0, new THREE.Vector3(0, -0.4, 0), 0.5, 0.25, 0.02, 0);
          setTimeout(trail, 30);
        };
        trail();
        setTimeout(() => {
          for (let k = 0; k < 48; k++) {
            const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(3.5 + Math.random() * 2.5);
            spark(c.clone(), col, v, 1.3 + Math.random() * 0.7, 0.7, 0.12, 2.2);
          }
          spark(c.clone(), 0xffffff, new THREE.Vector3(), 0.35, 3.2, 0.2, 0);
          if (MP.Sound && MP.Sound.on) MP.Sound.noise(0.3, 0.3, 500);
        }, rise);
        setTimeout(burst, 300 + Math.random() * 450);
      };
      burst();
    },

    // ---------- Fengselsgitter ----------
    buildCage() {
      const THREE = this.THREE;
      const g = new THREE.Group();
      const bar = new THREE.CylinderGeometry(0.022, 0.022, 0.62, 10);
      const mat = new THREE.MeshStandardMaterial({ color: 0xc4ccd6, metalness: 0.5, roughness: 0.32 });
      // Cellen ligger i fengselshjørnets indre del: lokal x,z ∈ [4.5, 5.65] (side 1).
      const add = (lx, lz) => {
        const [x, z] = rot(1, lx, lz);
        const m = new THREE.Mesh(bar, mat); m.position.set(x, 0.31, z); m.castShadow = true; g.add(m);
      };
      for (let n = 0; n <= 6; n++) { const v = 4.52 + n * (1.11 / 6); add(v, 5.63); add(5.63, v); add(v, 4.52); add(4.52, v); }
      const topGeo = new THREE.BoxGeometry(1.16, 0.05, 0.05);
      for (const [lx, lz, ry] of [[5.075, 4.52, 0], [5.075, 5.63, 0], [4.52, 5.075, Math.PI / 2], [5.63, 5.075, Math.PI / 2]]) {
        const [x, z] = rot(1, lx, lz);
        const m = new THREE.Mesh(topGeo, mat); m.position.set(x, 0.62, z); m.rotation.y = ry + Math.PI / 2; m.castShadow = true; g.add(m);
      }
      // Tak og hengelås
      const [rx, rz] = rot(1, 5.075, 5.075);
      // Sprossetak (gitter) så brikken inni fortsatt synes.
      const rodGeo = new THREE.BoxGeometry(1.16, 0.03, 0.03);
      for (let n = 0; n <= 4; n++) {
        const off = -0.555 + n * (1.11 / 4);
        const a = new THREE.Mesh(rodGeo, mat); a.position.set(rx, 0.64, rz + off); g.add(a);
        const b = new THREE.Mesh(rodGeo, mat); b.position.set(rx + off, 0.64, rz); b.rotation.y = Math.PI / 2; g.add(b);
      }
      const gold = new THREE.MeshStandardMaterial({ color: 0xf2c94c, metalness: 0.9, roughness: 0.3 });
      const [lx, lz] = rot(1, 5.075, 5.66);
      const lock = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.05), gold);
      lock.position.set(lx, 0.34, lz); lock.rotation.y = Math.PI / 2; g.add(lock);
      const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.012, 8, 16, Math.PI), gold);
      shackle.position.set(lx, 0.4, lz); shackle.rotation.y = Math.PI / 2; g.add(shackle);
      g.position.y = 2.5; g.visible = false;
      this.scene.add(g);
      this.cage = g; this.cageDown = false;
    },
    syncJail(state) {
      if (!this.cage) this.buildCage();
      const want = state.players.some((q) => q.inJail && !q.bankrupt);
      if (want === this.cageDown) return;
      this.cageDown = want;
      const g = this.cage, y0 = g.position.y, y1 = want ? 0 : 2.5;
      g.visible = true;
      tween(want ? 700 : 600, (k) => { g.position.y = y0 + (y1 - y0) * (want ? ease.outBack(k) : ease.inOut(k)); })
        .then(() => { if (!want) g.visible = false; else if (!this.skipping) this.dust(new this.THREE.Vector3(-5.05, 0, 5.05), 8, 0xb8b0a0); });
    },

    // Kjøp: fargering som sprer seg over feltet + gnister.
    async buyAnim(i, id) {
      if (this.skipping) return;
      // Kort nærbilde av feltet (som Monopoly Plus klipper ned til gatenivå), så tilbake.
      let back = null;
      if (this.followMode && !this.chase && !this.menu) {
        // Overta returen fra chase-kameraet, så de ikke drar i hver sin retning.
        clearTimeout(this.chaseTimer);
        back = this.camSaved || { pos: this.camera.position.clone(), target: this.controls.target.clone() };
        this.camSaved = null;
        // Kameraet står over brettkanten og ser UT mot tomten i byen, der bygget reiser seg (levende brett).
        const [cp, ct] = this.lotShot(i);
        this.glideCam(cp, ct, 650);
        var buyShot = this.shot;
      }
      this.soldSign(i, this.tokens[id]?.color || '#E3242B');
      this.celebrate(id);
      this.cheerAt(i);
      const THREE = this.THREE;
      const col = new THREE.Color(this.tokens[id]?.color || '#ffffff');
      const c = centerWorld(i);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.46, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(c.x, 0.1, c.z);
      this.scene.add(ring);
      this.flash(i);
      this.sparkle(new THREE.Vector3(c.x, 0, c.z), col, 22);
      await tween(900 / Math.sqrt(this.v), (k) => {
        const e = ease.out(k);
        ring.scale.setScalar(1 + e * 2.4);
        ring.material.opacity = 1 - k;
      });
      this.scene.remove(ring); ring.geometry.dispose(); ring.material.dispose();
      // Hold bildet mens byggeplassen blir til et hus (setLot-kjøpet tar ca. 1,45 s).
      if (back) { await delay(900 / this.v); await this.returnCam(back, buyShot, 800); }
    },
    // Kort kamerabesøk når det bygges: zoom inn på gata (og tomten i byen), så tilbake. Flere bygg
    // like etter hverandre forlenger samme besøk i stedet for å starte nye.
    buildMoment(i, hotel) {
      const THREE = this.THREE;
      if (this.building) { clearTimeout(this.building.timer); }
      else this.building = { back: { pos: this.camera.position.clone(), target: this.controls.target.clone() } };
      // Sikt midt mellom huset på fargebåndet og bygget på tomten i byen, sett fra siden,
      // så både huset som faller ned og bygget som vokser er i bildet.
      const s = sideOf(i), r = localRect(i);
      const [hx, hz] = rot(s, (r.x0 + r.x1) / 2, r.z0 + BAND / 2);
      const house = new THREE.Vector3(hx, 0.15, hz);
      const out = new THREE.Vector3(hx, 0, hz).normalize();
      let lot = null;
      if (this.city && this.city.lotPos) { try { const l = this.city.lotPos(i); if (l) lot = new THREE.Vector3(l.x, 0.4, l.z); } catch (e) { /* valgfritt */ } }
      if (!lot) lot = house.clone().add(out.clone().multiplyScalar(3));
      const mid = house.clone().lerp(lot, 0.45);
      const side = new THREE.Vector3(-out.z, 0, out.x);
      const pos = mid.clone().add(side.multiplyScalar(2.8)).add(out.clone().multiplyScalar(-0.6)).setY(hotel ? 2.7 : 2.4);
      this.glideCam(pos, mid, 450);
      const shot = this.shot;
      if (hotel) { this.cheerAt(i); this.ringBurst(house, 0xff3b3b); }
      this.building.timer = setTimeout(() => {
        const b = this.building; this.building = null;
        if (b) this.returnCam(b.back, shot, 700);
      }, (hotel ? 1700 : 1250) / this.v);
    },
    // Kamera for tomten til felt i: over brettkanten, lavt, sett utover mot tomten og byen bak.
    lotShot(i) {
      const THREE = this.THREE;
      const c = centerWorld(i), out = new THREE.Vector3(c.x, 0, c.z); const len = out.length() || 1; out.multiplyScalar(1 / len);
      let lot = null;
      if (this.city && this.city.lotPos) { try { const l = this.city.lotPos(i); if (l) lot = new THREE.Vector3(l.x, 0.35, l.z); } catch (e) { /* valgfritt */ } }
      if (!lot) lot = new THREE.Vector3(c.x + out.x * 2.2, 0.35, c.z + out.z * 2.2);
      // Litt fra siden, så både brikken på feltet og bygget synes.
      const side = new THREE.Vector3(-out.z, 0, out.x);
      const pos = new THREE.Vector3(c.x - out.x * 1.6 + side.x * 1.4, 2.5, c.z - out.z * 1.6 + side.z * 1.4);
      return [pos, lot];
    },

    pick(e) {
      const r = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObject(this.boardTop)[0];
      return hit ? squareAt(hit.point.x, hit.point.z) : -1;
    },
    setHover(i) {
      if (i < 0 || !MP.isOwnable(i)) { this.hl.material.opacity = 0; return; }
      const r = RECTS[i];
      this.hl.position.x = (r.x0 + r.x1) / 2; this.hl.position.z = (r.z0 + r.z1) / 2;
      this.hl.scale.set(r.x1 - r.x0, r.z1 - r.z0, 1);
      this.hl.material.opacity = 0.28;
    },
    flash(i) {
      const r = RECTS[i];
      this.pulse.position.x = (r.x0 + r.x1) / 2; this.pulse.position.z = (r.z0 + r.z1) / 2;
      this.pulse.scale.set(r.x1 - r.x0, r.z1 - r.z0, 1);
      this.pulse.material.opacity = 0.5;
    },

    // ---------- Brikker ----------
    setPlayers(players) {
      for (const t of Object.values(this.tokens)) this.scene.remove(t.obj);
      this.tokens = {};
      for (const p of players) {
        let obj = null;
        if (MP.Tokens && MP.Tokens.build) {
          try { obj = MP.Tokens.build(this.THREE, p.token, p.color); } catch (err) { console.error('Tokens.build feilet', err); }
        }
        if (!obj) obj = buildToken(this.THREE, p.token, new this.THREE.Color(p.color));
        this.scene.add(obj);
        const body = obj.children[1];
        this.tokens[p.id] = { obj, body, kind: p.token, idle: false, moving: false, color: p.color, baseY: body.position.y - 0.04, baseScale: body.scale.clone(), baseRotY: body.rotation.y, parts: obj.userData.parts || null, axis: obj.userData.wheelAxis || 'z', roll: 0 };
      }
    },
    // Squash/stretch relativt til modellens egen skala.
    squash(t, sy, sxz) { t.body.scale.set(t.baseScale.x * sxz, t.baseScale.y * sy, t.baseScale.z * sxz); },
    slotFor(state, p, sqIndex) {
      const same = state.players.filter((q) => !q.bankrupt && q.pos === sqIndex && (sqIndex !== 10 || q.inJail === p.inJail));
      const n = Math.max(0, same.findIndex((q) => q.id === p.id));
      return slotWorld(sqIndex, n, sqIndex === 10 && p.inJail);
    },
    placeAll(state) {
      for (const p of state.players) {
        const t = this.tokens[p.id]; if (!t) continue;
        t.obj.visible = !p.bankrupt;
        const w = this.slotFor(state, p, p.pos);
        t.obj.position.set(w.x, 0.0, w.z);
        t.obj.rotation.y = travelYaw(p.pos === 10 ? 11 : p.pos);
      }
      this.syncJail(state);
    },
    // Animerte deler fra tokens3d.js (g.userData.parts). Fylles ut når delene er kjent.
    animateParts(t, now, dt) {
      const P = t.parts; if (!P || !t.obj.visible) return;
      const pos = t.obj.position;
      if (!t.lastPos) t.lastPos = pos.clone();
      const moved = Math.hypot(pos.x - t.lastPos.x, pos.z - t.lastPos.z);
      t.lastPos.copy(pos);
      const speed = moved / Math.max(dt, 0.001);               // verdensenheter per sekund
      t.energy = (t.energy || 0) + (Math.min(1, speed / 2) - (t.energy || 0)) * Math.min(1, dt * 4);
      const e = t.energy, ph = t.phase || (t.phase = Math.random() * 10);
      if (P.wheels) {
        t.roll += moved / (t.obj.userData.wheelRadius || 0.062) / (t.obj.scale.x || 1);
        for (const w of P.wheels) w.rotation[t.axis] = -t.roll;
      }
      // Gangsyklus for hunden: beina svinger i diagonale par etter tilbakelagt strekning.
      if (P.legs && P.legs.length === 4) {
        t.gait = (t.gait || 0) + moved * 26;
        const amp = Math.min(1, e * 1.5) * 0.55;
        const axis = t.obj.userData.legAxis || 'z';
        const sign = t.obj.userData.legSign || 1;
        P.legs.forEach((leg, n) => { leg.rotation[axis] = sign * Math.sin(t.gait + (n === 0 || n === 3 ? 0 : Math.PI)) * amp; });
      }
      if (P.tail) P.tail.rotation.x = Math.sin(now / (t.idle ? 70 : 140) + ph) * (0.35 + 0.35 * e + (t.idle ? 0.15 : 0));
      if (P.head) {
        P.head.rotation.y = Math.sin(now / 1900 + ph) * 0.45 * (1 - e);
        P.head.rotation.z = Math.sin(now / 1300 + ph * 2) * 0.12 + 0.15 * e;
      }
      if (P.ears) P.ears.forEach((ear, n) => { ear.rotation.z = 0.25 * e + Math.max(0, Math.sin(now / 900 + ph + n * 1.7)) ** 8 * 0.35; });
      if (P.flag) P.flag.rotation.y = Math.sin(now / 160 + ph) * (0.25 + 0.35 * e);
      if (P.brim) P.brim.rotation.z = Math.sin(now / 240 + ph) * 0.07 * e;
      if (P.laces) { P.laces.rotation.x = Math.sin(now / 260 + ph) * (0.12 + 0.3 * e); P.laces.rotation.z = Math.cos(now / 330 + ph) * 0.08 * e; }
      // Røyk fra skorsteinene: små grå dotter som stiger og vokser.
      if ((P.smoke || P.smoke2) && !this.skipping) {
        t.smokeT = (t.smokeT || 0) - dt;
        if (t.smokeT <= 0) {
          t.smokeT = e > 0.2 ? 0.12 : 0.45;
          const anchor = (t.smokeFlip = !t.smokeFlip) && P.smoke2 ? P.smoke2 : P.smoke || P.smoke2;
          const wp = anchor.getWorldPosition(this.tmpV.clone());
          const m = new this.THREE.Sprite(new this.THREE.SpriteMaterial({ map: this.dotTex, color: 0xd8dde3, transparent: true, depthWrite: false }));
          m.material.userData.alpha = 0.7;
          this.spawn(m, { pos: wp, vel: new this.THREE.Vector3((Math.random() - 0.5) * 0.08, 0.35 + Math.random() * 0.15, (Math.random() - 0.5) * 0.08), life: 1.1, s0: 0.05, s1: 0.22, own: true });
        }
      }
    },
    // Små tegn på liv når brikkene står stille: snur seg, ser rundt, hopper litt.
    fidget(t, now) {
      if (t.moving || t.fidgeting || this.skipping || !t.obj.visible) return;
      if (!t.nextFidget) t.nextFidget = now + 2500 + Math.random() * 5000;
      if (now < t.nextFidget) return;
      t.nextFidget = now + 4000 + Math.random() * 7000;
      t.fidgeting = true;
      const body = t.body, y0 = t.baseRotY, kind = Math.floor(Math.random() * 3);
      const dir = Math.random() < 0.5 ? -1 : 1;
      tween(kind === 2 ? 700 : 1100, (k) => {
        if (t.moving) return;
        const s = Math.sin(Math.PI * k);
        if (kind === 0) body.rotation.y = y0 + dir * 0.55 * s;                       // ser seg rundt
        else if (kind === 1) { body.rotation.y = y0 + dir * 0.3 * Math.sin(k * Math.PI * 2); this.squash(t, 1 - 0.05 * s, 1 + 0.03 * s); }
        else { this.squash(t, 1 + 0.1 * s, 1 - 0.05 * s); t.obj.position.y = 0.12 * Math.max(0, Math.sin(Math.PI * Math.min(1, k * 1.4))); } // lite hopp
      }).then(() => { if (!t.moving) { body.rotation.y = y0; this.squash(t, 1, 1); t.obj.position.y = 0; } t.fidgeting = false; });
    },
    setActive(id) {
      this.activeId = id;
      for (const [k, t] of Object.entries(this.tokens)) {
        t.idle = Number(k) === id;
        if (!t.idle) t.body.position.y = t.baseY + 0.04;
      }
      const t = this.tokens[id];
      if (t) this.activeRing.material.color.set(t.color);
    },
    // Ruten lyser opp felt for felt i spillerens farge før brikken går; hvert felt slukkes når brikken passerer.
    async showPath(path, color) {
      if (this.skipping || !path.length || this.pace > 1) return [];   // datamaskinens turer: rett på
      const THREE = this.THREE;
      const marks = path.map((i, n) => {
        const r = RECTS[i], last = n === path.length - 1;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
        m.rotation.x = -Math.PI / 2;
        m.position.set((r.x0 + r.x1) / 2, 0.072, (r.z0 + r.z1) / 2);
        m.scale.set(r.x1 - r.x0 - 0.1, r.z1 - r.z0 - 0.1, 1);
        m.userData.target = last ? 0.55 : 0.3;
        this.scene.add(m);
        return m;
      });
      const step = Math.min(70, 700 / path.length);
      await tween((step * path.length + 200) / Math.sqrt(this.v), (k) => {
        const tt = k * (path.length + 3);
        marks.forEach((m, n) => { m.material.opacity = m.userData.target * Math.max(0, Math.min(1, tt - n)); });
      });
      return marks;
    },
    clearMark(m) {
      if (!m) return;
      const o = m.material.opacity;
      tween(250, (k) => { m.material.opacity = o * (1 - k); }).then(() => { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
    },
    async moveToken(p, path, state, onStep) {
      const t = this.tokens[p.id]; if (!t) return;
      const obj = t.obj, body = t.body;
      t.moving = true;
      body.rotation.y = t.baseRotY; obj.position.y = 0;
      this.syncJail(state);
      this.startChase(obj);
      const marks = await this.showPath(path, t.color);
      // Lange flytt (kort, tre like, buss …) får et tak på total gangtid, så de ikke drar ut.
      const per = Math.min(470 / this.v, path.length > 10 ? 3000 / path.length : Infinity);
      const rest = t.baseY + 0.04;
      // Bilen kjører og skipet seiler jevnt; de andre brikkene hopper felt for felt.
      const drive = t.kind === 'car' || t.kind === 'ship';
      const finalState = { players: state.players.map((q) => (q.id === p.id ? { ...q, pos: path[path.length - 1], inJail: false } : q)) };
      for (let n = 0; n < path.length; n++) {
        const i = path[n], last = n === path.length - 1;
        const from = obj.position.clone();
        const c = last ? this.slotFor(finalState, { ...p, inJail: false }, i) : centerWorld(i);
        const yaw0 = obj.rotation.y;
        const yaw1 = travelYaw(i === 10 ? 11 : i % 10 === 0 ? i + 1 : i);
        let dy = yaw1 - yaw0; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
        if (drive) {
          // Kjøring: ease bare i start og slutt av hele ruten, lett fjæring/gynging underveis.
          const first = n === 0;
          await tween(per * (first || last ? 0.85 : 0.62), (k) => {
            const e = first && last ? ease.inOut(k) : first ? k * k : last ? 1 - (1 - k) * (1 - k) : k;
            obj.position.x = from.x + (c.x - from.x) * e;
            obj.position.z = from.z + (c.z - from.z) * e;
            obj.rotation.y = yaw0 + dy * Math.min(1, e * 1.6);
            if (t.kind === 'car') {
              body.position.y = rest + Math.abs(Math.sin(k * Math.PI * 2)) * 0.012;
              body.rotation.z = (first ? 0.06 * (1 - k) : 0) + (last ? -0.05 * Math.sin(Math.PI * k) : 0);
            } else {
              body.position.y = rest + Math.sin(k * Math.PI * 2) * 0.018;
              body.rotation.x = Math.sin((n + k) * Math.PI) * 0.09;
            }
          });
          if (!last) this.clearMark(marks[n]);
          if (onStep) onStep(i);
          if (i === 0) { this.moneyBurst(obj.position); this.cheerAt(0); }
          if (t.kind === 'car' && !this.skipping && Math.random() < 0.5) this.dust(obj.position, 2, 0xd8d0c0);
          if (last) {
            this.dust(obj.position, 8);
            await tween(per * 0.45, (k) => { body.rotation.z = -0.06 * Math.sin(Math.PI * k) * (1 - k); body.rotation.x *= 0.85; });
            body.rotation.z = 0; body.rotation.x = 0; body.position.y = rest;
          }
          continue;
        }
        // Sats: brikken trykkes sammen før hoppet (bare første steg; resten flyter videre).
        if (n === 0) await tween(per * 0.3, (k) => this.squash(t, 1 - 0.2 * ease.out(k), 1 + 0.12 * ease.out(k)));
        await tween(per * 0.78, (k) => {
          const e = ease.inOut(k), air = Math.sin(Math.PI * k);
          obj.position.x = from.x + (c.x - from.x) * e;
          obj.position.z = from.z + (c.z - from.z) * e;
          obj.position.y = air * (last ? 0.55 : 0.42);
          obj.rotation.y = yaw0 + dy * Math.min(1, e * 1.4);
          const sq = n === 0 ? Math.max(0, 1 - k / 0.18) : 0;
          this.squash(t, 1 - 0.2 * sq + 0.14 * air, 1 + 0.12 * sq - 0.07 * air);
          body.rotation.z = 0.28 * (0.5 - k) * air;
          body.position.y = rest;
        });
        obj.position.y = 0; body.rotation.z = 0;
        if (!last) this.clearMark(marks[n]);
        if (onStep) onStep(i);
        if (i === 0) { this.moneyBurst(obj.position); this.cheerAt(0); }
        // Landing: kort dump; det siste steget lander tyngre med støvsky.
        this.dust(obj.position, last ? 10 : 3);
        const hard = last ? 0.24 : 0.1;
        await tween(per * (last ? 0.55 : 0.22), (k) => {
          const s = Math.sin(Math.PI * k) * hard * (1 - k * 0.3);
          this.squash(t, 1 - s, 1 + s * 0.6);
        });
        this.squash(t, 1, 1);
      }
      this.clearMark(marks[marks.length - 1]);
      t.moving = false;
      this.reslot(finalState, p.id);
      this.endChase();
    },
    // Rydder brikkene som står på samme felt til hver sin plass (glir dit).
    reslot(state, skipId) {
      for (const q of state.players) {
        if (q.bankrupt || q.id === skipId) continue;
        const t = this.tokens[q.id]; if (!t || t.moving) continue;
        const w = this.slotFor(state, q, q.pos);
        const from = t.obj.position.clone();
        if (Math.hypot(w.x - from.x, w.z - from.z) < 0.02) continue;
        tween(320, (k) => { const e = ease.inOut(k); t.obj.position.x = from.x + (w.x - from.x) * e; t.obj.position.z = from.z + (w.z - from.z) * e; });
      }
    },
    async jumpToken(p, toIndex, inJail, state) {
      const t = this.tokens[p.id]; if (!t) return;
      const obj = t.obj, from = obj.position.clone();
      const c = this.slotFor({ players: state.players.map((q) => (q.id === p.id ? { ...q, pos: toIndex, inJail } : q)) }, { ...p, inJail }, toIndex);
      t.moving = true;
      this.startChase(obj);
      // Politilys som blinker over fengselet mens brikken flyr dit.
      const THREE = this.THREE;
      const jail = centerWorld(10);
      const sirens = [0xff2a2a, 0x2a6bff].map((col, n) => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        s.position.set(jail.x + (n ? 0.35 : -0.35), 0.9, jail.z); s.scale.setScalar(0.9); this.scene.add(s); return s;
      });
      await tween(1500 / this.v, (k) => {
        const e = ease.inOut(k);
        obj.position.set(from.x + (c.x - from.x) * e, Math.sin(Math.PI * k) * 2.6, from.z + (c.z - from.z) * e);
        obj.rotation.y += 0.22;
        const blink = Math.floor(k * 14) % 2;
        sirens[0].material.opacity = blink ? 1 : 0.15;
        sirens[1].material.opacity = blink ? 0.15 : 1;
      });
      obj.position.y = 0; obj.rotation.y = travelYaw(11);
      this.dust(obj.position, 10, 0xd9d2c4);
      for (const s of sirens) { this.scene.remove(s); s.material.dispose(); }
      const jailState = { players: state.players.map((q) => (q.id === p.id ? { ...q, pos: toIndex, inJail } : q)) };
      this.syncJail(jailState);
      t.moving = false;
      this.reslot(jailState, p.id);
      this.endChase(900);
      await delay(500 / this.v);
    },
    // Flytt fokus tilbake mot midten uten å endre vinkelen spilleren har valgt.
    recenter() {
      const t = this.controls.target;
      const dx = -t.x, dz = 0.4 - t.z;
      if (Math.hypot(dx, dz) < 0.05) return Promise.resolve();
      const c0 = this.camera.position.clone(), t0 = t.clone();
      return tween(600, (k) => {
        const e = ease.inOut(k);
        t.set(t0.x + dx * e, t0.y, t0.z + dz * e);
        this.camera.position.set(c0.x + dx * e, c0.y, c0.z + dz * e);
      });
    },
    resetView() {
      this.chase = null; this.camSaved = null; clearTimeout(this.chaseTimer);
      const from = this.camera.position.clone(), tf = this.controls.target.clone();
      const to = this.homePosition();
      return tween(700, (k) => {
        const e = ease.inOut(k);
        this.camera.position.lerpVectors(from, to, e);
        this.controls.target.set(tf.x * (1 - e), 0, tf.z + (0.4 - tf.z) * e);
      });
    },

    // ---------- Terninger ----------
    async rollDice(d, speed) {
      const THREE = this.THREE;
      const H = this.dieHalf || 0.31;
      const Q = (x, y, z) => new THREE.Euler(x, y, z);
      const baseQ = { 1: Q(0, 0, Math.PI / 2), 6: Q(0, 0, -Math.PI / 2), 2: Q(0, 0, 0), 5: Q(Math.PI, 0, 0), 3: Q(-Math.PI / 2, 0, 0), 4: Q(Math.PI / 2, 0, 0) };
      // Fartsterningens sider: +x=1, -x=M, +y=2, -y=M, +z=3, -z=buss
      const speedQ = { 1: Q(0, 0, Math.PI / 2), 2: Q(0, 0, 0), 3: Q(-Math.PI / 2, 0, 0), bus: Q(Math.PI / 2, 0, 0), mono: Math.random() < 0.5 ? Q(0, 0, -Math.PI / 2) : Q(Math.PI, 0, 0) };
      const useSpeed = speed != null && speed !== false;
      this.speedDie.visible = useSpeed;
      const dice = useSpeed ? [...this.dice, this.speedDie] : this.dice;
      const values = useSpeed ? [d[0], d[1], speed] : d;
      // Kast fra den aktive brikken (eller kameraets side) inn mot midten av brettet.
      const dur = 1500 / Math.pow(this.v, this.pace > 1 ? 0.8 : 0.5);
      const at = this.activeId != null && this.tokens[this.activeId];
      const from = at ? at.obj.position.clone().setY(0) : new THREE.Vector3().subVectors(this.camera.position, this.controls.target).setY(0).normalize().multiplyScalar(6);
      const dir = from.clone().multiplyScalar(-1).normalize();
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      // Landingspunkter: et stykke inn på midtfeltet, spredt sideveis og aldri oppå hverandre.
      const landBase = from.clone().add(dir.clone().multiplyScalar(Math.min(4.2, from.length() - 1.4)));
      const ends = [];
      for (let n = 0; n < dice.length; n++) {
        let p, tries = 0;
        do {
          p = landBase.clone().add(side.clone().multiplyScalar((n - (dice.length - 1) / 2) * 1.0 + (Math.random() - 0.5) * 0.35))
            .add(dir.clone().multiplyScalar((Math.random() - 0.5) * 0.6));
          p.x = Math.max(-3.9, Math.min(3.9, p.x)); p.z = Math.max(-3.9, Math.min(3.9, p.z));
        } while ((ends.some((q) => q.distanceTo(p) < H * 2.6) || this.onDeck(p, H)) && ++tries < 40);
        // Reserve: kortbunkene ligger langs diagonalen x = z, så diagonalen x = −z er alltid fri.
        if (this.onDeck(p, H)) { const d = (n - (dice.length - 1) / 2) * 1.0 + 0.6; p.set(d, 0, -d); }
        ends.push(p.setY(H));
      }
      const jobs = dice.map((die, n) => {
        const target = (useSpeed && n === 2 ? speedQ[values[2]] : baseQ[values[n]]) || baseQ[2];
        const final = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2)
          .multiply(new THREE.Quaternion().setFromEuler(target));
        const start = from.clone().add(side.clone().multiplyScalar((n - 1) * 0.35)).add(dir.clone().multiplyScalar(0.4)).setY(1.6 + n * 0.15);
        const end = ends[n];
        const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        const spins = 3 + Math.random() * 2.5;
        const delayK = n * 0.04;
        return tween(dur, (kRaw) => {
          const k = Math.max(0, Math.min(1, (kRaw - delayK) / (1 - delayK)));
          const e = ease.out(k);
          die.position.lerpVectors(start, end, e);
          // Sprett: tre buer med avtagende høyde, og en liten glidning til slutt.
          const b = k < 0.42 ? Math.sin((k / 0.42) * Math.PI) * 1.1 : k < 0.7 ? Math.sin(((k - 0.42) / 0.28) * Math.PI) * 0.32 : k < 0.88 ? Math.sin(((k - 0.7) / 0.18) * Math.PI) * 0.08 : 0;
          die.position.y = H + Math.max(0, b) + (k < 0.08 ? (1 - k / 0.08) * 0.8 : 0);
          const spin = new THREE.Quaternion().setFromAxisAngle(axis, spins * Math.PI * 2 * Math.pow(1 - e, 1.6));
          die.quaternion.copy(final).multiply(spin);
        });
      });
      if (!this.skipping) [0.42, 0.7, 0.88].forEach((f, n) => setTimeout(() => {
        if (this.skipping) return;
        if (this.onDiceBounce) this.onDiceBounce();
        this.shakeAmt = Math.max(this.shakeAmt || 0, [0.09, 0.05, 0.025][n]);
      }, f * dur));
      await Promise.all(jobs);
      for (const die of dice) this.dust(die.position.clone().setY(0), 4, 0xffffff);
      if (d[0] === d[1]) {
        for (const die of this.dice) this.sparkle(die.position, 0xffe680, 20);
        this.ringBurst(this.dice[0].position.clone().lerp(this.dice[1].position, 0.5), 0xffd23f);
      }
    },
    // Ligger punktet (med terningens halve bredde) oppå en av kortbunkene (1,55 × 1,0, rotert 45°)?
    onDeck(p, H) {
      for (const k of ['chance', 'chest']) {
        const g = this.decks[k].grp;
        g.updateMatrixWorld();
        const l = g.worldToLocal(p.clone().setY(0));
        if (Math.abs(l.x) < 0.78 + H + 0.05 && Math.abs(l.z) < 0.5 + H + 0.05) return true;
      }
      return false;
    },
    // Lysende ring som sprer seg utover fra et punkt (dobbel, fargegruppe osv.).
    ringBurst(pos, color) {
      if (this.skipping) return;
      const THREE = this.THREE;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.55, 48), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(pos.x, 0.09, pos.z);
      this.scene.add(ring);
      tween(800, (k) => { ring.scale.setScalar(1 + ease.out(k) * 3); ring.material.opacity = 1 - k; })
        .then(() => { this.scene.remove(ring); ring.geometry.dispose(); ring.material.dispose(); });
    },

    // ---------- Kort ----------
    async drawCard(type) {
      const THREE = this.THREE;
      const deck = this.decks[type];
      const card = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.015, 1.0), [deck.mats[0], deck.mats[0], deck.topMat, deck.mats[3], deck.mats[0], deck.mats[0]]);
      card.castShadow = true;
      // Kortet løftes av bunken, snur seg og flyr mot kameraet før det vises på skjermen.
      const start = deck.grp.position.clone().setY(0.16);
      const toCam = this.camera.position.clone().sub(start);
      const end = start.clone().add(toCam.multiplyScalar(0.42));
      const q0 = deck.grp.quaternion.clone();
      const look = new THREE.Object3D(); look.position.copy(end); look.lookAt(this.camera.position);
      const q1 = look.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
      card.position.copy(start); card.quaternion.copy(q0);
      this.scene.add(card);
      await tween(900 / this.v, (k) => {
        const lift = Math.min(1, k / 0.35), fly = Math.max(0, (k - 0.25) / 0.75);
        card.position.copy(start).setY(0.16 + ease.out(lift) * 0.8).lerp(end, ease.inOut(fly));
        card.quaternion.copy(q0).slerp(q1, ease.inOut(fly));
        card.rotateZ(Math.sin(Math.PI * Math.min(1, k * 1.4)) * Math.PI * (1 - fly));
      });
      this.sparkle(deck.grp.position, type === 'chance' ? 0xffb347 : 0x7fb8ff, 10);
      setTimeout(() => { this.scene.remove(card); card.geometry.dispose(); }, 250);
    },

    // ---------- Eierskap, pant og bygg ----------
    syncProps(state, animate = true) {
      const THREE = this.THREE;
      for (const [key, pr] of Object.entries(state.props)) {
        const i = Number(key), s = sideOf(i), r = localRect(i);
        // Eiermerke ytterst på feltet
        let plate = this.ownerPlates[i];
        if (pr.owner != null) {
          const col = new THREE.Color(state.players[pr.owner].color);
          if (!plate) {
            plate = new THREE.Mesh(new window.RoundedBoxGeometry(0.86, 0.05, 0.13, 2, 0.02), new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.1 }));
            const [x, z] = rot(s, (r.x0 + r.x1) / 2, r.z1 - 0.1);
            plate.position.set(x, 0.025, z); plate.rotation.y = -s * Math.PI / 2; plate.castShadow = true;
            this.scene.add(plate); this.ownerPlates[i] = plate;
            if (animate) { plate.scale.set(0.01, 1, 0.01); tween(350, (k) => plate.scale.set(ease.out(k), 1, ease.out(k))); }
          }
          plate.material.color.copy(col);
          plate.material.emissive = col.clone(); plate.material.emissiveIntensity = pr.mortgaged ? 0 : 0.25;
          if (pr.mortgaged) plate.material.color.lerp(new THREE.Color(0x555555), 0.65);
        } else if (plate) { this.scene.remove(plate); delete this.ownerPlates[i]; }
        // Pantsatt: mørk hinne over feltet
        let ov = this.mortOverlays[i];
        if (pr.mortgaged && !ov) {
          this.mortTex = this.mortTex || mortgageTexture(THREE);
          ov = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.mortTex, transparent: true, depthWrite: false }));
          const R = RECTS[i];
          ov.rotation.x = -Math.PI / 2; ov.position.set((R.x0 + R.x1) / 2, 0.07, (R.z0 + R.z1) / 2); ov.scale.set(R.x1 - R.x0, R.z1 - R.z0, 1);
          this.scene.add(ov); this.mortOverlays[i] = ov;
        } else if (!pr.mortgaged && ov) { this.scene.remove(ov); delete this.mortOverlays[i]; }
        // Hus/hotell
        if (SQ[i].type === 'street') this.syncHouses(i, pr.houses, animate);
        // Levende brett: tomten i byen utenfor feltet følger eierskap, bygg og pant.
        if (this.city && this.city.setLot) {
          const col = pr.owner != null ? state.players[pr.owner].color : null;
          const key = `${col}|${pr.houses}|${pr.mortgaged}`;
          this.lotState = this.lotState || {};
          if (this.lotState[i] !== key) {
            const first = this.lotState[i] === undefined;
            this.lotState[i] = key;
            try { this.city.setLot(i, { color: col, level: pr.houses, mortgaged: pr.mortgaged }, animate && !first && !this.skipping); } catch (e) { console.warn(e); }
          }
        }
      }
    },
    syncHouses(i, n, animate) {
      const THREE = this.THREE;
      const cur = this.houses[i] || { n: 0, meshes: [] };
      if (cur.n === n) return;
      for (const m of cur.meshes) this.scene.remove(m);
      const s = sideOf(i), r = localRect(i), cx = (r.x0 + r.x1) / 2, cz = r.z0 + BAND / 2;
      const meshes = [];
      const place = (geo, mat, lx, drop, delay) => {
        const m = new THREE.Group();
        const body = new THREE.Mesh(geo, mat); body.castShadow = true; body.receiveShadow = true; m.add(body);
        m.add(new THREE.Mesh(geo === this.hotelGeo ? this.hotelWinGeo : this.houseWinGeo, this.winMat));
        const [x, z] = rot(s, lx, cz);
        m.position.set(x, 0.06, z); m.rotation.y = -s * Math.PI / 2;
        this.scene.add(m); meshes.push(m);
        if (drop) {
          m.visible = false;
          setTimeout(() => {
            m.visible = true;
            tween(420, (k) => {
              m.position.y = 0.06 + (1 - ease.out(k)) * 1.3;
              const sq = k > 0.6 ? Math.sin(((k - 0.6) / 0.4) * Math.PI) * 0.25 : 0;
              m.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
            }).then(() => {
              m.scale.set(1, 1, 1);
              this.dust(m.position, 6, 0xe8dcc4);
              this.sparkle(m.position, n === 5 ? 0xff6b6b : 0x7dff9a, n === 5 ? 26 : 10);
              if (MP.Sound && !this.skipping) MP.Sound.build();
            });
          }, delay);
        }
      };
      // Byggeøyeblikk: kort nærbilde av gata (hotell alltid; hus når kameraet ikke er opptatt).
      if (animate && n > cur.n && !this.skipping && this.followMode && !this.chase && !this.menu) this.buildMoment(i, n === 5);
      if (n === 5) place(this.hotelGeo, this.hotelMat, cx, animate && cur.n < 5, 0);
      else for (let h = 0; h < n; h++) place(this.houseGeo, this.houseMat, cx - 0.33 + h * 0.22, animate && h >= cur.n && cur.n !== 5, (h - cur.n) * 120);
      this.houses[i] = { n, meshes };
    },

    worldToScreen(v) {
      const p = v.clone().project(this.camera);
      const r = this.renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    },
    tokenScreen(id) {
      const t = this.tokens[id]; if (!t) return null;
      return this.worldToScreen(t.obj.position.clone().setY(0.6));
    },
  };

  MP.Board3D = Board3D;
})();

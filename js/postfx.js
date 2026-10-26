/*
 * Etterbehandling (postfx.js) – «leketøys-miniatyr»-looken fra Monopoly Plus.
 *
 *   MP.PostFX.create(THREE, renderer, scene, camera, { quality: 'high' | 'low' })
 *     → { render(dt), setSize(w, h), setQuality(q), setFocus(vec3), dispose(), params, setBackdropBlur(t),
 *         ao (status), setAOLevel(0|1|2) }
 *
 * Kjede (high):
 *   scene → HDR-mål (HalfFloat, MSAA) → nedskalering (½ eller ¼) → [bloom: lys-filter → 2 nivåer uskarphet]
 *                                                               → [tilt-shift: 2 nivåer uskarphet]
 *                  dybde (DepthTexture) → [AO: SAO i ½/¼ oppløsning → bilateral uskarphet]   (bare high)
 *   → sluttpass til skjermen: tilt-shift-miks, AO, bloom, fargebevarende høylysskulder, lineær → sRGB,
 *     mild S-kurve, metning, varme, vignett, dithering.
 * Kjede (low): scene → HDR-mål (MSAA ved lav oppløsning) → sluttpass med høylysskulder, gradering og vignett.
 *
 * Brettet er tegnet for NoToneMapping. Derfor endres ikke renderer.toneMapping: sluttpasset gjør den samme
 * sRGB-konverteringen som rendereren ellers ville gjort, og legger en mild gradering oppå (ingen bleke farger).
 * Høylysskulderen rører ikke piksler der sterkeste kanal er ≤ shoulder[0] (brett, papir og lyse flater klippes
 * som før); sterkere høylys (gnister, fyrverkeri, glans) beholder fargetonen og går mykt mot hvitt.
 * AO måles med GPU-tidsspørring (eller bildetid) de første bildene; er den dyrere enn aoBudgetMs, går den ned
 * ett trinn (½ → ¼ oppløsning, færre prøver) og til slutt av.
 * Alt allokeres ved oppstart/resize; render() allokerer ingenting.
 * Bruker bare THREE (window.PostFXDeps trengs ikke, men skader ikke).
 */
(function () {
  'use strict';
  const MP = (window.MP = window.MP || {});

  const VERT = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  ].join('\n');

  // Nedskalering med 4 bilineære oppslag (glatt «tent»-filter). BRIGHT = bloom-terskel med myk kne.
  const DOWN_FRAG = `
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    uniform float uThreshold;
    uniform float uKnee;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0));
      c += texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0));
      c += texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0));
      c += texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0));
      c *= 0.25;
      #ifdef BRIGHT
        c.rgb = min(c.rgb, vec3(6.0));                 // demper enkeltpiksler som ellers blinker
        float br = max(c.r, max(c.g, c.b));
        float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
        soft = soft * soft / (4.0 * uKnee + 1e-4);
        c.rgb *= max(soft, br - uThreshold) / max(br, 1e-4);
        c.a = 1.0;
      #endif
      gl_FragColor = c;
    }`;

  // Separerbar 9-tap gauss med 5 bilineære oppslag.
  const BLUR_FRAG = `
    uniform sampler2D tSrc;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tSrc, vUv) * 0.2270270270;
      c += texture2D(tSrc, vUv + uDir * 1.3846153846) * 0.3162162162;
      c += texture2D(tSrc, vUv - uDir * 1.3846153846) * 0.3162162162;
      c += texture2D(tSrc, vUv + uDir * 3.2307692308) * 0.0702702703;
      c += texture2D(tSrc, vUv - uDir * 3.2307692308) * 0.0702702703;
      gl_FragColor = c;
    }`;

  // Billig SAO (McGuire m.fl.) fra scenens dybdebuffer. Utdata: r = synlighet (1 = ingen AO), g = avstand (for bilateral).
  const AO_FRAG = `
    uniform sampler2D tDepth;
    uniform vec2 uDepthTexel;   // fullskjermteksel i dybdebufferen
    uniform vec2 uSize;         // AO-målets størrelse i piksler
    uniform vec4 uProj;         // P00, P11, P20, P21 (P20/P21 ≠ 0 ved view offset)
    uniform vec2 uNearFar;
    uniform float uRadius;      // verdensenheter
    uniform float uIntensity;
    uniform float uBias;        // andel av avstanden
    uniform float uMaxPx;       // maks prøveradius i AO-piksler
    varying vec2 vUv;

    float viewZ(float d) { return (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y); }
    vec3 viewPos(vec2 uv, float d) {
      float z = viewZ(d);
      return vec3(-z * (uv * 2.0 - 1.0 + uProj.zw) / uProj.xy, z);
    }
    // textureLod (bare WebGL2): ingen deriverte i løkken (unngår X3595-advarsel og udefinert mip-valg i D3D).
    vec3 viewAt(vec2 uv) { return viewPos(uv, textureLod(tDepth, uv, 0.0).x); }

    void main() {
      float d = textureLod(tDepth, vUv, 0.0).x;
      if (d >= 1.0) { gl_FragColor = vec4(1.0, 1e4, 0.0, 1.0); return; }
      vec3 P = viewPos(vUv, d);
      // Normal fra dybden: velg naboen med minst sprang i hver retning (ingen glorie langs silhuetter).
      vec3 pr = viewAt(vUv + vec2(uDepthTexel.x, 0.0)), pl = viewAt(vUv - vec2(uDepthTexel.x, 0.0));
      vec3 pu = viewAt(vUv + vec2(0.0, uDepthTexel.y)), pd = viewAt(vUv - vec2(0.0, uDepthTexel.y));
      vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
      vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
      vec3 n = normalize(cross(dx, dy));

      float rPx = min(uRadius * uProj.y * 0.5 * uSize.y / -P.z, uMaxPx);
      if (rPx < 1.0) { gl_FragColor = vec4(1.0, -P.z, 0.0, 1.0); return; }
      // Interleaved gradient noise: rotasjon per piksel, fjernes av den bilaterale uskarpheten.
      float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float r2 = uRadius * uRadius;
      float bias = uBias * -P.z;
      float sum = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        float a = (float(i) + 0.5) / float(SAMPLES);
        float ang = a * (TURNS * 6.2831853) + rot;
        vec2 suv = vUv + vec2(cos(ang), sin(ang)) * (a * rPx) / uSize;
        vec3 v = viewAt(suv) - P;
        float vv = dot(v, v);
        float f = max(r2 - vv, 0.0);
        sum += f * f * f * max((dot(v, n) - bias) / (0.02 * r2 + vv), 0.0);
      }
      float A = max(0.0, 1.0 - sum * uIntensity / (r2 * r2 * r2) * (5.0 / float(SAMPLES)));
      gl_FragColor = vec4(A, -P.z, 0.0, 1.0);
    }`;

  // Separerbar bilateral 7-tap uskarphet av AO (vekter etter avstand, så kontaktskyggen ikke lekker over kanter).
  const AO_BLUR_FRAG = `
    uniform sampler2D tSrc;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec2 c0 = texture2D(tSrc, vUv).rg;
      float tol = 1.0 / (0.03 * c0.y + 0.02);
      float sum = c0.x * 0.24, wsum = 0.24;
      vec2 c; float w;
      c = texture2D(tSrc, vUv + uDir).rg;       w = 0.2  * max(0.0, 1.0 - abs(c.y - c0.y) * tol); sum += c.x * w; wsum += w;
      c = texture2D(tSrc, vUv - uDir).rg;       w = 0.2  * max(0.0, 1.0 - abs(c.y - c0.y) * tol); sum += c.x * w; wsum += w;
      c = texture2D(tSrc, vUv + uDir * 2.0).rg; w = 0.12 * max(0.0, 1.0 - abs(c.y - c0.y) * tol); sum += c.x * w; wsum += w;
      c = texture2D(tSrc, vUv - uDir * 2.0).rg; w = 0.12 * max(0.0, 1.0 - abs(c.y - c0.y) * tol); sum += c.x * w; wsum += w;
      c = texture2D(tSrc, vUv + uDir * 3.0).rg; w = 0.06 * max(0.0, 1.0 - abs(c.y - c0.y) * tol); sum += c.x * w; wsum += w;
      c = texture2D(tSrc, vUv - uDir * 3.0).rg; w = 0.06 * max(0.0, 1.0 - abs(c.y - c0.y) * tol); sum += c.x * w; wsum += w;
      gl_FragColor = vec4(sum / wsum, c0.y, 0.0, 1.0);
    }`;

  const FINAL_FRAG = `
    uniform sampler2D tSharp;
    uniform sampler2D tAO;
    uniform vec4 uShoulder;
    uniform sampler2D tBlur1;
    uniform sampler2D tBlur2;
    uniform sampler2D tBloom1;
    uniform sampler2D tBloom2;
    uniform float uFocusY;
    uniform float uBand;
    uniform float uFeather;
    uniform float uAmount;
    uniform float uNearScale;
    uniform float uBlurAll;
    uniform float uBloom;
    uniform vec2 uBloomMix;
    uniform float uExposure;
    uniform float uContrast;
    uniform float uSat;
    uniform vec3 uGain;
    uniform float uVignette;
    uniform vec2 uAspect;
    uniform vec2 uTexel;
    varying vec2 vUv;

    vec3 toSRGB(vec3 c) {
      c = max(c, vec3(0.0));
      return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
    }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    // Fargebevarende høylysskulder (lineært, før sRGB). Under uShoulder.x i sterkeste kanal: nøyaktig som før
    // (klipp per kanal, så papir og lyse brettfarger er uendret). Over: gli mot tonen (c / maks) i stedet for å
    // klippe hver kanal til hvitgult, og la svært sterke kjerner (> uShoulder.z) gå mykt mot hvitt.
    vec3 shoulder(vec3 c) {
      c = max(c, vec3(0.0));
      float m = max(c.r, max(c.g, c.b));
      vec3 clipped = min(c, vec3(1.0));
      if (m <= uShoulder.x) return clipped;
      vec3 hue = c / m;
      float hot = max(m - uShoulder.z, 0.0) * uShoulder.w;
      hue = mix(hue, vec3(1.0), hot / (1.0 + hot));
      return mix(clipped, hue, smoothstep(uShoulder.x, uShoulder.y, m));
    }

    #ifdef FXAA
      // Enkel FXAA (brukes bare når scenen rendres uten MSAA). Luma beregnes på tilnærmet sRGB.
      float lumaOf(vec3 c) { return sqrt(clamp(dot(c, vec3(0.299, 0.587, 0.114)), 0.0, 1.0)); }
      vec4 fxaa(vec2 uv) {
        vec4 m = texture2D(tSharp, uv);
        float lNW = lumaOf(texture2D(tSharp, uv + vec2(-1.0, -1.0) * uTexel).rgb);
        float lNE = lumaOf(texture2D(tSharp, uv + vec2( 1.0, -1.0) * uTexel).rgb);
        float lSW = lumaOf(texture2D(tSharp, uv + vec2(-1.0,  1.0) * uTexel).rgb);
        float lSE = lumaOf(texture2D(tSharp, uv + vec2( 1.0,  1.0) * uTexel).rgb);
        float lM = lumaOf(m.rgb);
        float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
        float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
        if (lMax - lMin < max(0.0625, lMax * 0.166)) return m;   // lav kontrast: urørt (skarp brett-tekst)
        vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
        float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
        float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
        dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
        vec4 a = 0.5 * (texture2D(tSharp, uv - dir * (1.0 / 6.0)) + texture2D(tSharp, uv + dir * (1.0 / 6.0)));
        vec4 b = a * 0.5 + 0.25 * (texture2D(tSharp, uv - dir * 0.5) + texture2D(tSharp, uv + dir * 0.5));
        float lB = lumaOf(b.rgb);
        return (lB < lMin || lB > lMax) ? a : b;
      }
    #endif

    void main() {
      #ifdef FXAA
        vec4 s = fxaa(vUv);
      #else
        vec4 s = texture2D(tSharp, vUv);
      #endif
      float aoFade = 1.0;
      #ifdef TILT
        float dy = vUv.y - uFocusY;
        dy = dy > 0.0 ? dy : -dy * uNearScale;           // nederst (nært kameraet) litt mindre uskarpt
        float m = max(smoothstep(uBand, uBand + uFeather, dy) * uAmount, uBlurAll) * 2.0;
        vec4 b = mix(texture2D(tBlur1, vUv), texture2D(tBlur2, vUv), clamp(m - 1.0, 0.0, 1.0));
        s = mix(s, b, clamp(m, 0.0, 1.0));
        aoFade = 1.0 - 0.75 * clamp(m, 0.0, 1.0);        // uskarpe soner: AO (lav oppløsning) tones ned
      #endif
      vec3 col = s.rgb;
      #ifdef AO
        // Selvlysende ting og gnister (HDR > ~1,5) mørknes ikke.
        float hiC = max(col.r, max(col.g, col.b));
        col *= mix(1.0, texture2D(tAO, vUv).r, aoFade * (1.0 - smoothstep(1.2, 2.5, hiC)));
      #endif
      #ifdef BLOOM
        col += (texture2D(tBloom1, vUv).rgb * uBloomMix.x + texture2D(tBloom2, vUv).rgb * uBloomMix.y) * uBloom;
      #endif
      #ifdef SHOULDER
        col = clamp(toSRGB(shoulder(col * uExposure)), 0.0, 1.0);
      #else
        col = clamp(toSRGB(col * uExposure), 0.0, 1.0);
      #endif
      // Mild S-kurve (beholder svart og hvitt), metning og varm tone.
      col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = clamp(mix(vec3(l), col, uSat) * uGain, 0.0, 1.0);
      // Vignett
      vec2 v = (vUv - 0.5) * uAspect;
      col *= 1.0 - uVignette * smoothstep(0.25, 1.0, dot(v, v) / dot(0.5 * uAspect, 0.5 * uAspect));
      // Dithering mot bånd i himmel/gradienter
      col += (hash(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0) * s.a;
      gl_FragColor = vec4(col, s.a);
    }`;

  const DEFAULTS = {
    // Tilt-shift. Styrken følger kameraavstanden til fokuspunktet: nær (følgekamera) = sterk, oversikt = mild.
    nearDist: 6, farDist: 20,
    bandNear: 0.13, bandFar: 0.30,          // halv bredde på det skarpe båndet (andel av skjermhøyden)
    featherNear: 0.32, featherFar: 0.32,    // overgang fra skarpt til fullt uskarpt
    amountNear: 0.85, amountFar: 0.55,      // maks uskarphet (1 = nivå 2)
    nearScale: 0.8,                         // nedre halvdel (nærmest kameraet) får litt mindre uskarphet
    focusSpeed: 6,                          // hvor raskt fokus glir (1/s)
    // Bloom (lineær HDR, maks av RGB). Hvitt papir/tekst i sollys ligger på 1.0–1.6, så terskelen er 2.0:
    // bare speilglans, emissive ting og additive gnister over 2 gløder.
    bloomThreshold: 2.0, bloomKnee: 0.5, bloomStrength: 0.6, bloomMix: [0.55, 0.9],
    // Kantutjevning: null = automatisk etter antall piksler i tegnebufferen
    // (high: ≤1,2 MP → MSAA 4×, ≤2,4 MP → 2×, ellers ingen; low: ≤1,2 MP → 2×, ellers ingen).
    samples: null,
    fxaa: false,                            // true = FXAA når MSAA er av (gjør brett-teksten litt uskarp)
    // Gradering
    exposure: 1.0, contrast: 0.14, saturation: 1.12, gain: [1.02, 1.0, 0.98], vignette: 0.24,
    // Høylysskulder: [start, full fargebevaring, start hvitning, hvitningsrate] i lineær HDR (sterkeste kanal).
    // Start 1.7 > papir/brett i sollys (≤ ~1.6), så vanlige farger klippes som før. null/false = av (gammel klipping).
    shoulder: [1.7, 4.0, 6.0, 0.06],
    // Ambient occlusion (bare high). Radius i verdensenheter (brikker ~0,4 høye), svak styrke.
    ao: true, aoRadius: 0.32, aoIntensity: 0.85, aoBias: 0.002, aoMaxPx: 36,
    aoBudgetMs: 2.0,                        // målt GPU-tid for AO-passene; over dette → billigere trinn → av
  };
  // AO-trinn: 2 = ½ oppløsning (¼ ved pixelRatio ≥ 1,5) og 10 prøver; 1 = halvparten igjen og 8 prøver; 0 = av.
  const AO_LEVELS = [null, { div: 2, samples: 8 }, { div: 1, samples: 10 }];

  function create(THREE, renderer, scene, camera, opts) {
    opts = opts || {};
    const P = Object.assign({}, DEFAULTS, opts.params || {});
    const isGL2 = !!renderer.capabilities.isWebGL2;
    const ext = renderer.extensions;
    const canHalf = isGL2 ? (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')) : ext.has('OES_texture_half_float');
    const texType = canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType;

    let quality = norm(opts.quality);
    let dbW = 0, dbH = 0, divisor = 2, samples = -1;
    let focusSet = false, curFy = 0.5, curT = 0, backdrop = 0, backdropCur = 0, lastNow = 0, disposed = false;

    const focus = new THREE.Vector3(0, 0, 0);
    const tmpV = new THREE.Vector3();
    const dbSize = new THREE.Vector2();

    // Fullskjermstrekant
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const quad = new THREE.Mesh(tri);
    quad.frustumCulled = false;

    function mat(frag, uniforms, defines) {
      return new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: frag, uniforms, defines: defines || {},
        depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
      });
    }
    const downMat = mat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.3 } });
    const brightMat = mat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.3 } }, { BRIGHT: '' });
    const blurMat = mat(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    const aoMat = mat(AO_FRAG, {
      tDepth: { value: null }, uDepthTexel: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2(1, 1) },
      uProj: { value: new THREE.Vector4() }, uNearFar: { value: new THREE.Vector2(0.1, 200) },
      uRadius: { value: 0.3 }, uIntensity: { value: 0.5 }, uBias: { value: 0.002 }, uMaxPx: { value: 36 },
    }, { SAMPLES: 10, TURNS: '3.0' });
    const aoBlurMat = mat(AO_BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    const finalMat = mat(FINAL_FRAG, {
      tSharp: { value: null }, tAO: { value: null }, uShoulder: { value: new THREE.Vector4(1.7, 4, 6, 0.06) },
      tBlur1: { value: null }, tBlur2: { value: null }, tBloom1: { value: null }, tBloom2: { value: null },
      uFocusY: { value: 0.5 }, uBand: { value: 0.2 }, uFeather: { value: 0.3 }, uAmount: { value: 0 }, uNearScale: { value: 0.8 }, uBlurAll: { value: 0 },
      uBloom: { value: 0 }, uBloomMix: { value: new THREE.Vector2() },
      uExposure: { value: 1 }, uContrast: { value: 0 }, uSat: { value: 1 }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uVignette: { value: 0 }, uAspect: { value: new THREE.Vector2(1, 1) }, uTexel: { value: new THREE.Vector2(1, 1) },
    });

    function rt(depth) {
      const r = new THREE.WebGLRenderTarget(1, 1, { type: texType, depthBuffer: !!depth, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      r.texture.generateMipmaps = false;
      return r;
    }
    const sceneRT = rt(true);
    const L1 = rt(), T1 = rt(), L2 = rt(), T2 = rt(), B2 = rt(), B3 = rt(), T3 = rt();
    const AO1 = rt(), AO2 = rt();
    const small = [L1, T1, L2, T2, B2, B3, T3, AO1, AO2];
    // Dybden fra scene-målet (med MSAA løses den opp sammen med fargen). Kobles bare til når AO er på.
    const depthTex = new THREE.DepthTexture(1, 1);
    depthTex.type = THREE.UnsignedIntType;
    let depthOn = false;

    // AO-trinn og kostnadsmåling (GPU-tidsspørring hvis tilgjengelig, ellers bildetid).
    let aoLevel = 2, aoMs = -1, aoMeasuring = true, aoFrames = 0, aoN = 0, qBusy = false, dtAvg = 0;
    const aoSamplesMs = new Float32Array(15);
    const gl = renderer.getContext();
    const tq = isGL2 ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    const query = tq ? gl.createQuery() : null;

    // MSAA på et HalfFloat-mål koster ca. 2 ms ekstra på integrert GPU ved 1280×800; ved høy pixelRatio
    // er det for dyrt (og trengs mindre), så da brukes FXAA i sluttpasset i stedet.
    // Uten MSAA ved høy pixelRatio: kantene er da små nok, og FXAA ville gjort brett-teksten uskarp.
    function wantSamples() {
      if (!isGL2) return 0;
      if (typeof P.samples === 'number') return P.samples;
      const px = dbW * dbH;
      if (quality === 'high') return px <= 1.2e6 ? 4 : px <= 2.4e6 ? 2 : 0;
      return px <= 1.2e6 ? 2 : 0;
    }
    function wantFxaa() { return P.fxaa === true && samples === 0; }
    function wantAO() { return isGL2 && canHalf && quality === 'high' && !!P.ao && aoLevel > 0; }
    function wantShoulder() { return Array.isArray(P.shoulder) && P.shoulder.length >= 4; }
    let definesKey = '', aoKey = '';
    function sizeAO() {
      const lv = AO_LEVELS[aoLevel];
      if (!lv || !dbW) return;
      const k = divisor * lv.div;
      const w = Math.max(1, Math.round(dbW / k)), h = Math.max(1, Math.round(dbH / k));
      AO1.setSize(w, h); AO2.setSize(w, h);
      if (aoMat.defines.SAMPLES !== lv.samples) { aoMat.defines.SAMPLES = lv.samples; aoMat.needsUpdate = true; }
    }
    function applyQuality() {
      const s = wantSamples();
      const ao = wantAO();
      if (s !== samples || ao !== depthOn) {
        sceneRT.dispose();                          // frigjør også en tilkoblet dybdetekstur
        samples = s; sceneRT.samples = s;
        depthOn = ao; sceneRT.depthTexture = ao ? depthTex : null;
      }
      const d = {};
      if (quality === 'high') { d.TILT = ''; d.BLOOM = ''; }
      if (ao) d.AO = '';
      if (wantShoulder()) d.SHOULDER = '';
      if (wantFxaa()) d.FXAA = '';
      const key = Object.keys(d).join(',');
      if (key !== definesKey) { definesKey = key; finalMat.defines = d; finalMat.needsUpdate = true; }
      const ak = aoLevel + ':' + dbW + 'x' + dbH;
      if (ao && ak !== aoKey) { aoKey = ak; sizeAO(); }
    }
    // Start en ny kostnadsmåling (etter oppstart, resize eller nytt AO-trinn).
    function remeasure() { aoMeasuring = true; aoFrames = 0; aoN = 0; dtAvg = 0; }
    function resizeTargets(w, h) {
      w = Math.max(1, w | 0); h = Math.max(1, h | 0);
      if (w === dbW && h === dbH) return;
      const grew = w * h > dbW * dbH;
      dbW = w; dbH = h;
      const pr = renderer.getPixelRatio();
      divisor = pr >= 1.5 ? 4 : 2;                  // blur defineres i CSS-piksler, ikke fysiske
      sceneRT.setSize(w, h);
      const s1 = (n) => Math.max(1, Math.round(n / divisor));
      const s2 = (n) => Math.max(1, Math.round(n / (divisor * 2)));
      const s3 = (n) => Math.max(1, Math.round(n / (divisor * 4)));
      L1.setSize(s1(w), s1(h)); T1.setSize(s1(w), s1(h));
      L2.setSize(s2(w), s2(h)); T2.setSize(s2(w), s2(h)); B2.setSize(s2(w), s2(h));
      B3.setSize(s3(w), s3(h)); T3.setSize(s3(w), s3(h));
      finalMat.uniforms.uAspect.value.set(w / h, 1);
      finalMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      // Større bilde kan gjøre AO for dyr igjen; mindre bilde gir ikke trinnet tilbake (unngår vipping).
      if (grew && aoLevel > 0) remeasure();
      applyQuality();
    }

    // Leser ferdige GPU-tidsmålinger og senker AO-trinnet hvis kostnaden er over budsjettet.
    function aoBudgetCheck(dt) {
      if (!aoMeasuring || !wantAO()) return;
      aoFrames++;
      if (tq) {
        if (!qBusy) return;
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
        qBusy = false;
        if (gl.getParameter(tq.GPU_DISJOINT_EXT)) return;
        if (aoFrames < 8) return;                   // første bilder: kompilering og opplasting
        aoSamplesMs[aoN++] = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        if (aoN < aoSamplesMs.length) return;
        aoSamplesMs.sort();
        aoMs = aoSamplesMs[aoSamplesMs.length >> 1];   // median
      } else {
        // Uten tidsspørring: hvis hele bildet bruker over ~28 ms med AO på, er AO for dyrt for maskinen.
        if (aoFrames < 30) return;
        dtAvg = dtAvg ? dtAvg + (dt - dtAvg) * 0.05 : dt;
        if (aoFrames < 150) return;
        aoMs = -1;
        if (dtAvg <= 0.028) { aoMeasuring = false; return; }
      }
      if (tq && aoMs <= P.aoBudgetMs) { aoMeasuring = false; return; }
      aoLevel--;
      if (aoLevel > 0) remeasure(); else aoMeasuring = false;
      applyQuality();
    }

    function renderAO() {
      const timing = tq && aoMeasuring && !qBusy && aoFrames >= 7;
      if (timing) gl.beginQuery(tq.TIME_ELAPSED_EXT, query);
      const u = aoMat.uniforms, e = camera.projectionMatrix.elements;
      u.tDepth.value = depthTex;
      u.uDepthTexel.value.set(1 / dbW, 1 / dbH);
      u.uSize.value.set(AO1.width, AO1.height);
      u.uProj.value.set(e[0], e[5], e[8], e[9]);
      u.uNearFar.value.set(camera.near, camera.far);
      u.uRadius.value = P.aoRadius; u.uIntensity.value = P.aoIntensity; u.uBias.value = P.aoBias;
      u.uMaxPx.value = P.aoMaxPx * AO1.height / Math.max(1, dbH / divisor);   // samme skjermstørrelse på begge trinn
      draw(aoMat, AO1);
      aoBlurMat.uniforms.tSrc.value = AO1.texture;
      aoBlurMat.uniforms.uDir.value.set(1 / AO1.width, 0);
      draw(aoBlurMat, AO2);
      aoBlurMat.uniforms.tSrc.value = AO2.texture;
      aoBlurMat.uniforms.uDir.value.set(0, 1 / AO1.height);
      draw(aoBlurMat, AO1);
      if (timing) { gl.endQuery(tq.TIME_ELAPSED_EXT); qBusy = true; }
      finalMat.uniforms.tAO.value = AO1.texture;
    }

    function draw(material, target) {
      quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(quad, quadCam);
    }
    function down(material, src, dst) {
      material.uniforms.tSrc.value = src.texture;
      material.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      draw(material, dst);
    }
    function blur(rtA, rtTmp, spread) {
      blurMat.uniforms.tSrc.value = rtA.texture;
      blurMat.uniforms.uDir.value.set(spread / rtA.width, 0);
      draw(blurMat, rtTmp);
      blurMat.uniforms.tSrc.value = rtTmp.texture;
      blurMat.uniforms.uDir.value.set(0, spread / rtA.height);
      draw(blurMat, rtA);
    }

    function updateFocus(dt) {
      camera.updateMatrixWorld();
      const k = 1 - Math.exp(-dt * P.focusSpeed);
      // Avstand kamera → fokus styrer hvor «miniatyr» bildet blir.
      const dist = camera.position.distanceTo(focus);
      const tWant = Math.min(1, Math.max(0, (P.farDist - dist) / (P.farDist - P.nearDist)));
      tmpV.copy(focus).project(camera);
      let fy = tmpV.y * 0.5 + 0.5;
      if (!(tmpV.z < 1) || !isFinite(fy)) fy = 0.5;
      fy = Math.min(0.9, Math.max(0.1, fy));
      if (!focusSet) { curFy = fy; curT = tWant; focusSet = true; }
      curFy += (fy - curFy) * k; curT += (tWant - curT) * k;
      backdropCur += (backdrop - backdropCur) * Math.min(1, dt * 8);
      const t = curT * curT * (3 - 2 * curT), u = finalMat.uniforms;
      u.uFocusY.value = curFy;
      u.uBand.value = P.bandFar + (P.bandNear - P.bandFar) * t;
      u.uFeather.value = P.featherFar + (P.featherNear - P.featherFar) * t;
      u.uAmount.value = P.amountFar + (P.amountNear - P.amountFar) * t;
      u.uNearScale.value = P.nearScale;
      u.uBlurAll.value = backdropCur;
    }

    function render(dt) {
      if (disposed) return;
      const now = performance.now();
      if (!(dt >= 0)) dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.016;
      lastNow = now;
      if (quality === 'off') { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      renderer.getDrawingBufferSize(dbSize);
      if (dbSize.x !== dbW || dbSize.y !== dbH) resizeTargets(dbSize.x, dbSize.y);
      else if (wantSamples() !== samples || wantFxaa() !== (definesKey.indexOf('FXAA') >= 0) ||
               wantAO() !== depthOn || wantShoulder() !== (definesKey.indexOf('SHOULDER') >= 0)) applyQuality();
      aoBudgetCheck(dt);

      const prevTarget = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      renderer.setRenderTarget(sceneRT);
      renderer.autoClear = true;
      renderer.render(scene, camera);
      renderer.autoClear = false;                  // fullskjermpassene overskriver alle piksler

      const u = finalMat.uniforms;
      u.tSharp.value = sceneRT.texture;
      u.uExposure.value = P.exposure; u.uContrast.value = P.contrast; u.uSat.value = P.saturation;
      u.uGain.value.set(P.gain[0], P.gain[1], P.gain[2]); u.uVignette.value = P.vignette;
      if (wantShoulder()) u.uShoulder.value.set(P.shoulder[0], P.shoulder[1], P.shoulder[2], P.shoulder[3]);

      if (quality === 'high') {
        if (depthOn) renderAO();
        updateFocus(dt);
        down(downMat, sceneRT, L1);                // ½ (pr < 1.5) eller ¼ (pr ≥ 1.5)
        // Bloom: lys-filter fra L1, to nivåer
        brightMat.uniforms.uThreshold.value = P.bloomThreshold;
        brightMat.uniforms.uKnee.value = P.bloomKnee;
        down(brightMat, L1, B2);
        blur(B2, T2, 1.0);
        down(downMat, B2, B3);
        blur(B3, T3, 1.25);
        // Tilt-shift: to nivåer uskarphet
        blur(L1, T1, 1.0);
        down(downMat, L1, L2);
        blur(L2, T2, 1.4);
        u.tBlur1.value = L1.texture; u.tBlur2.value = L2.texture;
        u.tBloom1.value = B2.texture; u.tBloom2.value = B3.texture;
        u.uBloom.value = P.bloomStrength; u.uBloomMix.value.set(P.bloomMix[0], P.bloomMix[1]);
      }
      draw(finalMat, null);
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prevTarget);
    }

    function setSize(w, h) {
      const pr = renderer.getPixelRatio();
      resizeTargets(Math.floor(w * pr), Math.floor(h * pr));
    }
    function setQuality(q) { quality = norm(q); applyQuality(); }
    function setFocus(v) { if (v) focus.set(v.x, v.y, v.z); }
    function setBackdropBlur(t) { backdrop = Math.min(1, Math.max(0, +t || 0)); }
    function dispose() {
      disposed = true;
      sceneRT.dispose(); small.forEach((r) => r.dispose()); depthTex.dispose();
      [downMat, brightMat, blurMat, aoMat, aoBlurMat, finalMat].forEach((m) => m.dispose());
      tri.dispose();
      if (query) gl.deleteQuery(query);
    }

    renderer.getDrawingBufferSize(dbSize);
    resizeTargets(dbSize.x, dbSize.y);
    applyQuality();

    return {
      render, setSize, setQuality, setFocus, dispose, setBackdropBlur,
      params: P,
      get quality() { return quality; },
      // AO-status: trinn (2/1/0), målt median GPU-tid i ms (-1 = ikke målt), om målingen pågår.
      get ao() { return { on: depthOn, level: aoLevel, ms: aoMs, measuring: aoMeasuring, timer: !!tq, size: [AO1.width, AO1.height] }; },
      // Tving AO-trinn (2/1/0) og mål på nytt; brukes til feilsøking og innstillinger.
      setAOLevel(l) { aoLevel = Math.max(0, Math.min(2, l | 0)); aoMs = -1; if (aoLevel > 0) remeasure(); else aoMeasuring = false; applyQuality(); },
      targets: { scene: sceneRT, L1, L2, B2, B3, ao: AO1, depth: depthTex },   // for feilsøking/måling
    };
  }

  function norm(q) { return q === 'low' || q === 'off' ? q : 'high'; }

  MP.PostFX = { create, DEFAULTS };
})();

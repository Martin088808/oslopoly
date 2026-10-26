// Online-spill: alle spiller samme spill på hver sin skjerm, via en offentlig MQTT-megler over WebSocket.
// Ingen egen server. Verten (den som lager rommet) kjører den eneste ekte MP.Game (også datamaskinene);
// de andre klientene har en speil-instans som bare viser og spiller av hendelsene i samme rekkefølge.
//
// Lagdeling:
//   Transport  – kobler til megleren og sender/mottar JSON på emnene oslopoly/v1/<ROMKODE>/<navn>.
//                Kan byttes ut (f.eks. WebRTC eller egen server) uten å røre protokollen under.
//   Host       – vertens side: lobby, io-proxy rundt UI-et (hendelser + beslutninger), kommandoer fra klientene.
//   Client     – klientens side: lobby, ordnet avspilling, beslutninger, kommandoer som RPC.
//
// Protokoll (alle meldinger er små JSON-objekter):
//   …/h  vert → alle:  { e: økt-id, n: løpenummer (spillmeldinger), t: type, d: tilstandsdiff, … }
//        Flere meldinger i samme tikk sendes samlet som { b: [ … ] }.
//        t = lobby | hb | sync | ev | ask | wait | rep | over | owners | reject | gone | closed
//   …/c  klient → vert: { pub, key, t, … }   t = hello | hb | pick | ans | cmd | leave | bye
//   `pub` er klientens offentlige id (vises i lobbyen), `key` en tilfeldig nøkkel som bare klienten og verten kjenner.
//   Spillerobjekter sendes som { $p: id } og gjenopprettes mot speil-instansen.
(function () {
  'use strict';
  const MP = window.MP;

  // Megleren velges av romkodens første tegn, så vert og gjester alltid havner på samme megler.
  const BROKERS = [
    { url: 'wss://broker.hivemq.com:8884/mqtt', name: 'HiveMQ' },
    { url: 'wss://broker.emqx.io:8084/mqtt', name: 'EMQX' },
    { url: 'wss://test.mosquitto.org:8081', name: 'Mosquitto' },
  ];
  const LIBS = ['https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js', 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js'];
  const PREFIX = 'oslopoly/v1/';
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // uten I, L, O, 0 og 1
  const ROOM_KEY = 'oslopoly-online-v1';   // vertens rom (localStorage), så verten kan gjenoppta det
  const SESSION_KEY = 'oslopoly-net';      // aktiv økt i denne fanen (sessionStorage) – overlever omlasting
  const HB_MS = 4000;
  const LOST_MS = 13000;
  const MAX_PLAYERS = 6;
  const PRESENT = ['log', 'changed', 'event', 'turnStart', 'rollDice', 'animateMove', 'toJail', 'rentPaid', 'taxPaid', 'bought',
    'auctionStart', 'auctionUpdate', 'auctionEnd', 'bankrupt', 'turnOrder'];
  const DECIDE = ['humanPhase', 'offerBuy', 'auctionBid', 'jailChoice', 'raiseFunds', 'tradeOffer', 'chanceChoice', 'goChoice', 'busChoice', 'speedChoice'];
  const EV_OK = new Set([...PRESENT, 'showCard', 'auctionBid']);
  const DEC_OK = new Set([...DECIDE, 'showCard']);
  const MANAGE = ['build', 'sellHouse', 'mortgage', 'unmortgage', 'buildHotel'];

  const mkStore = (get) => ({
    get(k) { try { return get().getItem(k); } catch (e) { return null; } },
    set(k, v) { try { get().setItem(k, v); } catch (e) { /* privat modus */ } },
    del(k) { try { get().removeItem(k); } catch (e) { /* */ } },
    json(k) { try { return JSON.parse(this.get(k) || 'null'); } catch (e) { return null; } },
  });
  const ls = mkStore(() => window.localStorage);
  const ss = mkStore(() => window.sessionStorage);

  function rid(n, alpha = 'abcdefghjkmnpqrstuvwxyz23456789') {
    const a = new Uint32Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (x) => alpha[x % alpha.length]).join('');
  }
  const brokerOf = (code) => Math.max(0, ALPHA.indexOf(String(code || '')[0])) % BROKERS.length;
  function makeCode(k) { for (;;) { const c = rid(6, ALPHA); if (brokerOf(c) === k) return c; } }
  const normCode = (s) => String(s || '').toUpperCase().split('').filter((ch) => ALPHA.includes(ch)).join('').slice(0, 6);
  const validCode = (c) => typeof c === 'string' && c.length === 6 && [...c].every((ch) => ALPHA.includes(ch));
  const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  // ---------- Serialisering ----------
  function ser(v, g, depth = 0) {
    if (typeof v === 'function') return undefined;
    if (v == null || typeof v !== 'object' || depth > 12) return v;
    if (g && g.s && g.s.players.includes(v)) return { $p: v.id };
    if (Array.isArray(v)) return v.map((x) => ser(x, g, depth + 1));
    const o = {};
    for (const k of Object.keys(v)) { const x = v[k]; if (x !== undefined && typeof x !== 'function') o[k] = ser(x, g, depth + 1); }
    return o;
  }
  function des(v, g, depth = 0) {
    if (v == null || typeof v !== 'object' || depth > 12) return v;
    if (Array.isArray(v)) return v.map((x) => des(x, g, depth + 1));
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$p') return (g && g.player(Number(v.$p))) || null;
    const o = {};
    for (const k of keys) if (!BAD_KEYS.has(k)) o[k] = des(v[k], g, depth + 1);
    return o;
  }
  const isPlayer = (g, p) => !!(g && p && g.s.players.includes(p));
  // Et handelstilbud fra nettet: bare tall og lister med tall (motoren sjekker resten i tradeIssues).
  function plainTrade(t) {
    if (!t || typeof t !== 'object') return null;
    const side = (s) => {
      s = s && typeof s === 'object' ? s : {};
      const o = {
        props: Array.isArray(s.props) ? s.props.map(Number).filter(Number.isInteger).slice(0, 28) : [],
        cash: Math.max(0, Math.floor(Number(s.cash) || 0)),
        jailCards: Math.max(0, Math.floor(Number(s.jailCards) || 0)),
      };
      if (Array.isArray(s.unmortgage)) o.unmortgage = s.unmortgage.map(Number).filter(Number.isInteger).slice(0, 28);
      return o;
    };
    const from = Number(t.from), to = Number(t.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    return { from, to, give: side(t.give), get: side(t.get) };
  }
  // Samme handel (uten «Innløs straks», som mottakeren selv velger).
  const tradeKey = (t) => {
    const s = (x) => [[...(x.props || [])].map(Number).sort((a, b) => a - b), Number(x.cash) || 0, Number(x.jailCards) || 0];
    return t && t.give && t.get ? JSON.stringify([Number(t.from), Number(t.to), s(t.give), s(t.get)]) : '';
  };

  // ---------- Tilstand som biter (diff) ----------
  // Spillere, eiendommer og statistikk per element; resten per toppnøkkel.
  function pieces(s) {
    const out = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (k === 'players' && Array.isArray(v)) v.forEach((p, i) => { out['P' + i] = p; });
      else if (k === 'props' && v && typeof v === 'object') for (const i of Object.keys(v)) out['R' + i] = v[i];
      else if (k === 'stats' && v && typeof v === 'object') for (const i of Object.keys(v)) out['S' + i] = v[i];
      else out['.' + k] = v;
    }
    return out;
  }
  function replaceObj(o, v) {
    for (const k of Object.keys(o)) if (!(k in v)) delete o[k];
    for (const k of Object.keys(v)) if (!BAD_KEYS.has(k)) o[k] = v[k];
  }
  // Oppdaterer tilstanden på stedet, så spillerobjektene beholder identiteten (UI-et sammenligner med ===).
  function applyPieces(s, d) {
    if (!d || typeof d !== 'object') return;
    for (const key of Object.keys(d)) {
      const v = d[key], c = key[0], k = key.slice(1);
      if (BAD_KEYS.has(k)) continue;
      if (c === 'P') {
        const i = Number(k);
        if (!Number.isInteger(i) || i < 0 || i >= MAX_PLAYERS || !v || typeof v !== 'object') continue;
        if (s.players[i]) replaceObj(s.players[i], v); else s.players[i] = v;
      } else if (c === 'R' || c === 'S') {
        if (!/^\d+$/.test(k)) continue;
        const box = c === 'R' ? (s.props = s.props || {}) : (s.stats = s.stats || {});
        if (c === 'R' && box[k] && v && typeof v === 'object') replaceObj(box[k], v); else box[k] = v;
      } else if (c === '.') {
        if (k === 'players' || k === 'props' || k === 'stats') continue;
        s[k] = v;
      }
    }
  }

  // ---------- mqtt.js (lastes fra CDN; <head> har allerede et async-skript) ----------
  let libP = null;
  function loadLib() {
    if (window.mqtt && window.mqtt.connect) return Promise.resolve(window.mqtt);
    if (libP) return libP;
    libP = new Promise((resolve, reject) => {
      const t0 = Date.now();
      const inject = (k) => {
        if (window.mqtt && window.mqtt.connect) { resolve(window.mqtt); return; }
        if (k >= LIBS.length) { libP = null; reject(new Error('Fant ikke nettbiblioteket (mqtt.js). Sjekk internett.')); return; }
        const s = document.createElement('script');
        s.src = LIBS[k]; s.async = true; s.crossOrigin = 'anonymous';
        s.onload = () => (window.mqtt && window.mqtt.connect ? resolve(window.mqtt) : inject(k + 1));
        s.onerror = () => inject(k + 1);
        document.head.appendChild(s);
      };
      const poll = () => {
        if (window.mqtt && window.mqtt.connect) { resolve(window.mqtt); return; }
        if (Date.now() - t0 > 3500) { inject(0); return; }
        setTimeout(poll, 100);
      };
      poll();
    });
    return libP;
  }

  // ---------- Transport ----------
  class Transport {
    constructor(room, k) {
      this.room = room;
      this.broker = BROKERS[k] || BROKERS[0];
      this.client = null;
      this.status = 'off';
      this.onMessage = null; this.onStatus = null; this.onReconnect = null;
    }
    topic(n) { return PREFIX + this.room + '/' + n; }
    emit(st) { if (this.status === st) return; this.status = st; if (this.onStatus) this.onStatus(st); }
    async connect({ subs = [], will = null } = {}) {
      const mqtt = await loadLib();
      return new Promise((resolve, reject) => {
        const opts = { clientId: 'osp_' + rid(14), keepalive: 30, reconnectPeriod: 2500, connectTimeout: 9000, clean: true, resubscribe: true };
        if (will) opts.will = { topic: this.topic(will.name), payload: JSON.stringify(will.obj), qos: 1, retain: false };
        let settled = false;
        let c = null;
        const done = (err) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (err) { try { c && c.end(true); } catch (e) { /* */ } this.client = null; reject(err); } else resolve(this);
        };
        const timer = setTimeout(() => done(new Error('Fikk ikke svar fra ' + this.broker.name)), 10000);
        try { c = mqtt.connect(this.broker.url, opts); } catch (e) { done(e); return; }
        this.client = c;
        c.on('connect', () => {
          this.emit('on');
          c.subscribe(subs.map((n) => this.topic(n)), { qos: 1 }, (err) => {
            if (!settled) done(err || null);
            else if (!err && this.onReconnect) this.onReconnect();
          });
        });
        c.on('reconnect', () => this.emit('reconnecting'));
        c.on('offline', () => this.emit('off'));
        c.on('close', () => { if (!settled) done(new Error(this.broker.name + ' lukket forbindelsen')); else if (this.status === 'on') this.emit('reconnecting'); });
        c.on('error', (e) => { if (!settled) done(e); else console.warn('MQTT:', e && e.message); });
        c.on('message', (topic, payload) => {
          const pre = PREFIX + this.room + '/';
          if (!this.onMessage || !topic.startsWith(pre)) return;
          let txt;
          try { txt = typeof payload === 'string' ? payload : new TextDecoder().decode(payload); } catch (e) { return; }
          if (!txt || txt.length > 400000) return;
          let obj;
          try { obj = JSON.parse(txt); } catch (e) { return; }
          try { this.onMessage(topic.slice(pre.length), obj); } catch (e) { console.error(e); }
        });
      });
    }
    pub(name, obj, qos = 1) {
      if (!this.client) return;
      try { this.client.publish(this.topic(name), JSON.stringify(obj), { qos }); } catch (e) { console.warn(e); }
    }
    end() { const c = this.client; this.client = null; if (c) { try { c.end(false); } catch (e) { /* */ } } this.emit('off'); }
  }

  // ---------- Vert ----------
  class Host {
    constructor(ui) {
      this.ui = ui; this.role = 'host';
      this.epoch = rid(8); this.seq = 0; this.ring = [];
      this.members = []; this.ais = [];
      this.phase = 'lobby'; this.owners = {}; this.game = null; this.over = null;
      this.pending = new Map(); this.askN = 0; this.ctx = { auc: null }; this.sent = {}; this.waits = [];
      this.counters = new Map(); this.busy = new Set();
      this.outbox = []; this.flushing = false; this.status = 'off';
    }
    get me() { return this.members.find((m) => m.host) || null; }
    get pub() { const m = this.me; return m ? m.pub : null; }
    get broker() { return this.t ? this.t.broker.name : ''; }
    member(pub) { return this.members.find((m) => m.pub === pub) || null; }

    // Lager et nytt rom (prøver meglerne i rekkefølge), eller gjenopptar et lagret rom.
    async open(me, saved) {
      const will = () => ({ name: 'h', obj: { t: 'gone', e: this.epoch } });
      if (saved) {
        this.room = saved.room;
        this.members = (saved.members || []).map((m) => ({ ...m, online: !!m.host, seen: 0 }));
        this.ais = Array.isArray(saved.ais) ? saved.ais : [];
        this.owners = saved.owners || {};
        const t = new Transport(this.room, brokerOf(this.room));
        await t.connect({ subs: ['c'], will: will() });
        this.t = t;
      } else {
        let err = null;
        for (let k = 0; k < BROKERS.length && !this.t; k++) {
          const code = makeCode(k), t = new Transport(code, k);
          try { await t.connect({ subs: ['c'], will: will() }); this.t = t; this.room = code; } catch (e) { err = e; console.warn('Megleren svarte ikke:', BROKERS[k].url, e && e.message); }
        }
        if (!this.t) throw err || new Error('Ingen megler svarte');
        const m = { pub: rid(8), key: rid(18), host: true, online: true, seen: Date.now() };
        this.members = [m];
        this.applyPick(m, me || {});
      }
      this.status = 'on';
      this.t.onMessage = (name, msg) => { if (name === 'c') this.onMsg(msg); };
      this.t.onStatus = (st) => { this.status = st; this.ui.netLobby(); this.ui.netPresence(); };
      this.t.onReconnect = () => { if (this.phase === 'lobby') this.lobbyChanged(); else this.beat(); };
      this.hb = setInterval(() => this.beat(), HB_MS);
      this.onVis = () => this.ui.netFast(document.hidden && this.phase === 'game');
      document.addEventListener('visibilitychange', this.onVis);
      ss.set(SESSION_KEY, JSON.stringify({ role: 'host', room: this.room }));
      if (saved && saved.phase === 'game' && saved.s) {
        this.phase = 'game';
        this.resumeGame(saved.s);
      } else {
        this.phase = 'lobby';
        this.lobbyChanged();
      }
      return this;
    }

    // ---------- Utsending ----------
    // Spillmeldinger får løpenummer og en diff av tilstanden slik den er akkurat nå.
    send(msg, seq = true) {
      msg.e = this.epoch;
      if (seq) {
        msg.n = ++this.seq;
        if (this.game && msg.t !== 'sync') { const d = this.diff(); if (d) msg.d = d; }
        this.ring.push(msg);
        if (this.ring.length > 400) this.ring.shift();
      }
      this.outbox.push(msg);
      if (!this.flushing) { this.flushing = true; Promise.resolve().then(() => this.flush()); }
    }
    flush() {
      this.flushing = false;
      const list = this.outbox.splice(0);
      this.raw(list);
    }
    raw(list) {
      if (!this.t || !list.length) return;
      for (let k = 0; k < list.length; k += 40) {
        const part = list.slice(k, k + 40);
        this.t.pub('h', part.length === 1 ? part[0] : { b: part }, 1);
      }
    }
    diff() {
      const ps = pieces(this.game.s);
      let out = null;
      for (const k of Object.keys(ps)) {
        const j = JSON.stringify(ps[k]);
        if (this.sent[k] !== j) { this.sent[k] = j; (out = out || {})[k] = JSON.parse(j); }
      }
      return out;
    }
    syncMsg(to, extra = {}) {
      const s = JSON.parse(JSON.stringify(this.game.s));
      if (!to) { this.sent = {}; const ps = pieces(s); for (const k of Object.keys(ps)) this.sent[k] = JSON.stringify(ps[k]); }
      return { t: 'sync', to: to || null, s, owners: { ...this.owners }, ctx: JSON.parse(JSON.stringify(this.ctx)), ...extra };
    }
    beat() {
      const now = Date.now();
      let ch = false;
      for (const m of this.members) if (!m.host && m.online && now - m.seen > LOST_MS) { m.online = false; ch = true; }
      if (ch) this.presenceChanged(); else this.send({ t: 'hb', ph: this.phase, off: this.offPids() }, false);
    }
    offPids() {
      return Object.keys(this.owners).filter((pid) => { const m = this.member(this.owners[pid]); return !m || (!m.host && !m.online); }).map(Number);
    }
    presenceChanged() {
      if (this.phase === 'lobby') this.lobbyChanged();
      else { this.send({ t: 'hb', ph: this.phase, off: this.offPids() }, false); this.ui.netPresence(); }
    }

    // ---------- Lobby ----------
    applyPick(m, p) {
      const others = [...this.members, ...this.ais].filter((x) => x !== m);
      let name = String((p && p.name) || '').replace(/\s+/g, ' ').trim().slice(0, 14) || (m.ai ? 'Data' : 'Spiller');
      const names = new Set(others.map((x) => x.name));
      if (names.has(name)) { let k = 2; while (names.has(`${name.slice(0, 11)} ${k}`)) k++; name = `${name.slice(0, 11)} ${k}`; }
      m.name = name;
      const toks = MP.TOKENS.map((t) => t.id), cols = MP.PLAYER_COLORS;
      const ut = new Set(others.map((x) => x.token)), uc = new Set(others.map((x) => x.color));
      const pickFrom = (list, used, want, cur) => (list.includes(want) && !used.has(want) ? want : list.includes(cur) && !used.has(cur) ? cur : list.find((x) => !used.has(x)) || list[0]);
      m.token = pickFrom(toks, ut, p && p.token, m.token);
      m.color = pickFrom(cols, uc, p && p.color, m.color);
    }
    lobbyMsg() {
      return {
        t: 'lobby', ph: this.phase, room: this.room,
        members: this.members.map((m) => ({ pub: m.pub, name: m.name, token: m.token, color: m.color, host: !!m.host, online: !!(m.host || m.online) })),
        ais: this.ais.map((a) => ({ name: a.name, token: a.token, color: a.color, level: a.level })),
        opts: this.ui.netOpts(),
      };
    }
    lobbyChanged() {
      this.saveRoom();
      this.send(this.lobbyMsg(), false);
      this.ui.netLobby();
    }
    view() {
      const l = this.lobbyMsg();
      return { role: 'host', room: this.room, link: MP.Net.link(this.room), broker: this.broker, status: this.status, phase: this.phase, me: this.pub, members: l.members, ais: l.ais, opts: l.opts };
    }
    setMe(p) { const m = this.me; if (!m) return; this.applyPick(m, p); this.lobbyChanged(); }
    addAI(p) {
      if (this.phase !== 'lobby' || this.members.length + this.ais.length >= MAX_PLAYERS) return;
      const a = { ai: true, level: ['easy', 'normal', 'hard'].includes(p && p.level) ? p.level : 'normal' };
      this.ais.push(a);
      this.applyPick(a, p || {});
      this.lobbyChanged();
    }
    removeAI(k) { if (this.phase === 'lobby' && this.ais[k]) { this.ais.splice(k, 1); this.lobbyChanged(); } }
    setAILevel(k, lvl) { if (this.ais[k] && ['easy', 'normal', 'hard'].includes(lvl)) { this.ais[k].level = lvl; this.lobbyChanged(); } }
    kick(pub) {
      const m = this.member(pub);
      if (!m || m.host || this.phase !== 'lobby') return;
      this.members = this.members.filter((x) => x !== m);
      this.send({ t: 'reject', to: pub, why: 'Verten fjernet deg fra rommet.' }, false);
      this.lobbyChanged();
    }
    count() { return this.members.filter((m) => m.host || m.online).length + this.ais.length; }
    canStart() { return this.phase === 'lobby' && this.count() >= 2; }

    // ---------- Meldinger fra klientene ----------
    onMsg(m) {
      if (!m || typeof m !== 'object' || typeof m.pub !== 'string') return;
      const mem = this.members.find((x) => x.pub === m.pub && !x.host) || null;
      if (m.t === 'bye') { if (mem && mem.online) { mem.online = false; this.presenceChanged(); } return; }
      if (m.t === 'hello') { this.onHello(m, mem); return; }
      if (!mem || typeof m.key !== 'string' || mem.key !== m.key) return; // ukjent avsender
      mem.seen = Date.now();
      if (!mem.online) { mem.online = true; this.presenceChanged(); }
      switch (m.t) {
        case 'hb': return;
        case 'pick': if (this.phase === 'lobby') { this.applyPick(mem, m); this.lobbyChanged(); } return;
        case 'ans': this.onAnswer(mem, m); return;
        case 'cmd': this.onCmd(mem, m); return;
        case 'leave':
          if (this.phase === 'lobby') this.members = this.members.filter((x) => x !== mem); else mem.online = false;
          this.presenceChanged();
          return;
        default:
      }
    }
    onHello(m, mem) {
      if (typeof m.key !== 'string' || m.key.length < 8 || m.pub.length > 24) return;
      const reject = (why, extra = {}) => this.send({ t: 'reject', to: m.pub, why, ...extra }, false);
      if (mem && mem.key !== m.key) { reject('Denne plassen er allerede i bruk.'); return; }
      if (!mem) {
        if (this.phase !== 'lobby') {
          // Spillet er i gang: en frakoblet menneskespiller kan tas over (f.eks. etter at fanen ble lukket).
          const seats = this.seats();
          const pid = Number(m.claim);
          const seat = seats.find((x) => x.pid === pid);
          if (!seat) { reject(seats.length ? 'Spillet er i gang. Ta over en ledig plass:' : 'Spillet er allerede i gang.', { seats }); return; }
          const old = this.member(this.owners[pid]);
          if (old) this.members = this.members.filter((x) => x !== old);
          mem = { pub: m.pub, key: m.key, host: false, online: true, seen: Date.now() };
          const p = this.game && this.game.player(pid);
          Object.assign(mem, { name: p ? p.name : 'Spiller', token: p ? p.token : null, color: p ? p.color : null });
          this.members.push(mem);
          this.owners[pid] = m.pub;
          for (const k of this.pending.values()) if (k.pid === pid) k.pub = m.pub;
          this.send({ t: 'owners', owners: { ...this.owners } }, true);
          this.saveRoom();
        } else {
          if (this.members.length + this.ais.length >= MAX_PLAYERS) { reject('Rommet er fullt (maks 6 spillere).'); return; }
          mem = { pub: m.pub, key: m.key, host: false, online: true, seen: Date.now() };
          this.members.push(mem);
          this.applyPick(mem, m);
        }
      }
      mem.online = true; mem.seen = Date.now();
      if (this.phase === 'lobby') this.lobbyChanged();
      else { this.presenceChanged(); this.syncTo(mem, m.have, m.e); }
    }
    // Ledige plasser: menneskespillere som er frakoblet og ikke konkurs.
    seats() {
      if (!this.game) return [];
      return this.game.players.filter((p) => !p.ai && !p.bankrupt && this.owners[p.id] && this.owners[p.id] !== this.pub && !(this.member(this.owners[p.id]) || {}).online)
        .map((p) => ({ pid: p.id, name: p.name, token: p.token, color: p.color }));
    }
    syncTo(mem, have, e) {
      if (!this.game) return;
      if (e === this.epoch && Number.isInteger(have) && have >= 0) {
        if (have >= this.seq) return; // klienten er à jour
        const first = this.ring.length ? this.ring[0].n : Infinity;
        if (have + 1 >= first && this.seq - have <= 150) { this.raw(this.ring.filter((x) => x.n > have)); return; }
      }
      const asks = [...this.pending.values()].filter((k) => k.pub === mem.pub).map((k) => ({ id: k.id, m: k.m, pid: k.pid, a: k.a }));
      this.send(this.syncMsg(mem.pub, { asks, over: this.over }), true);
    }

    // ---------- Spillet ----------
    startGame() {
      if (!this.canStart()) return false;
      this.members = this.members.filter((m) => m.host || m.online);
      const players = [], owners = {};
      for (const m of this.members) { owners[players.length] = m.pub; players.push({ name: m.name, ai: false, token: m.token, color: m.color }); }
      for (const a of this.ais) players.push({ name: a.name, ai: true, token: a.token, color: a.color, level: a.level });
      const o = this.ui.netOpts();
      const opts = { players, startMoney: o.money, auctions: o.auction, rules: { ...o.rules }, maxRounds: o.maxRounds || 0 };
      this.owners = owners; this.phase = 'game'; this.over = null;
      const g = this.makeGame(opts, null);
      this.send(this.syncMsg(null, { start: true }), true);
      this.saveRoom();
      this.ui.netStartHost(g, false, opts);
      return true;
    }
    makeGame(opts, saved) {
      const g = new MP.Game(opts, null, saved);
      g.io = this.io();
      this.game = g; this.pending.clear(); this.waits = []; this.ctx = { auc: null }; this.counters.clear(); this.sent = {};
      return g;
    }
    resumeGame(s) {
      const g = this.makeGame(null, JSON.parse(JSON.stringify(s)));
      this.send(this.syncMsg(null, { start: false }), true);
      this.ui.netStartHost(g, true);
    }
    // io-objektet motoren får: hendelser sendes til alle, beslutninger til skjermen som eier spilleren.
    io() {
      const ui = this.ui;
      const P = new Set(PRESENT), D = new Set(DECIDE);
      return new Proxy(ui, {
        get: (target, prop) => {
          if (P.has(prop)) return (...a) => this.present(prop, a);
          if (D.has(prop)) return (...a) => this.decide(prop, a);
          if (prop === 'showCard') return (...a) => this.card(a);
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    }
    present(m, a) {
      this.track(m, a);
      this.send({ t: 'ev', m, a: ser(a, this.game) }, true);
      return this.ui[m](...a);
    }
    track(m, a) {
      const id = (p) => (p && p.id != null ? p.id : null);
      if (m === 'auctionStart') this.ctx.auc = { i: a[0], bidders: (a[1] || []).map(id), high: 0, leader: null, out: [], bids: [] };
      else if (m === 'auctionUpdate' && this.ctx.auc) {
        const c = this.ctx.auc, [, leader, high, dropped] = a;
        if (leader && high > c.high) c.bids.push({ p: id(leader), v: high });
        c.high = high; c.leader = id(leader);
        if (dropped) c.out.push(id(dropped));
      } else if (m === 'auctionEnd') this.ctx.auc = null;
    }
    decide(m, a) {
      const g = this.game;
      const p = m === 'tradeOffer' ? g.player(a[0] && a[0].to) : a[0];
      // Har ikke råd til laveste bud: UI-et står over automatisk, så det vises som en vanlig hendelse.
      if (m === 'auctionBid' && p && p.cash < (Number(a[2]) || 0) + 100) return this.present(m, a);
      const owner = p ? this.owners[p.id] : null;
      if (!owner || owner === this.pub) {
        const w = { pid: p ? p.id : null, m, a: ser(a, g), raw: a };
        this.waits.push(w);
        this.send({ t: 'wait', pid: w.pid, m, a: w.a }, true);
        return Promise.resolve(this.ui[m](...a)).then((v) => { this.endWait(w); return v; });
      }
      return this.ask(owner, p, m, a);
    }
    ask(owner, p, m, a) {
      const id = this.epoch + '.' + (++this.askN);
      const sa = ser(a, this.game);
      return new Promise((resolve) => {
        const w = { pid: p.id, m, a: sa, raw: a };
        this.waits.push(w);
        this.pending.set(id, { id, pub: owner, pid: p.id, m, a: sa, raw: a, resolve, w });
        this.send({ t: 'ask', id, to: owner, pid: p.id, m, a: sa }, true);
        this.ui.netShowWaiting(p, m, a);
      });
    }
    // Beslutninger kan ligge inni hverandre (handel midt i en tur): etter et svar vises den som fortsatt venter.
    endWait(w) {
      this.waits = this.waits.filter((x) => x !== w);
      const top = this.waits[this.waits.length - 1];
      const g = this.game;
      if (!top || !g) { this.send({ t: 'wait', pid: null }, true); this.ui.netClearWaiting(); return; }
      this.send({ t: 'wait', pid: top.pid, m: top.m, a: top.a }, true);
      const p = g.player(top.pid);
      if (p && this.owners[p.id] && this.owners[p.id] !== this.pub) this.ui.netShowWaiting(p, top.m, top.raw);
      else this.ui.netClearWaiting();
    }
    // Sjanse/Prøv lykken for en spiller på en annen skjerm: den skjermen viser kortet og kvitterer (OK).
    card(a) {
      const p = a[0], owner = p ? this.owners[p.id] : null;
      if (!owner || owner === this.pub) return this.present('showCard', a);
      const id = this.epoch + '.' + (++this.askN);
      const sa = ser(a, this.game);
      const ack = new Promise((resolve) => this.pending.set(id, { id, pub: owner, pid: p.id, m: 'showCard', a: sa, raw: a, resolve }));
      this.send({ t: 'ev', m: 'showCard', a: sa, ask: id, to: owner }, true);
      return Promise.all([this.ui.showCard(...a), ack]);
    }
    waitingRemote() { return this.pending.size > 0; }
    onAnswer(mem, m) {
      const k = this.pending.get(m.id);
      if (!k || k.pub !== mem.pub) return;
      this.pending.delete(m.id);
      const v = this.clean(k, m.v);
      if (k.w) this.endWait(k.w);
      k.resolve(v);
    }
    // Svar fra nettet vaskes før motoren får dem (motoren sjekker også selv: bud ≤ kontanter, gyldig handel osv.).
    clean(k, v) {
      switch (k.m) {
        case 'offerBuy': case 'chanceChoice': return v === true;
        case 'auctionBid': { const b = Math.floor(Number(v) || 0); return b > 0 ? b : 0; }
        case 'jailChoice': return ['roll', 'pay', 'card'].includes(v) ? v : 'roll';
        case 'goChoice': return v && v.type === 'move' && Number.isInteger(Number(v.to)) ? { type: 'move', to: Number(v.to) } : { type: 'cash' };
        case 'busChoice': case 'speedChoice': return Math.floor(Number(v));
        case 'tradeOffer': {
          if (v && typeof v === 'object' && v.give && v.get) return plainTrade(v) || false;
          if (v && typeof v === 'object' && v.accept) {
            const t = k.raw[0];
            const um = Array.isArray(v.um) ? v.um.map(Number).filter(Number.isInteger) : [];
            if (um.length) t.give.unmortgage = um; else delete t.give.unmortgage;
            return true;
          }
          return false;
        }
        default: return undefined;
      }
    }
    // Handlinger klienten gjør i sin egen fase. Kommer fra eieren av spilleren og er lovlige akkurat nå?
    async onCmd(mem, m) {
      const g = this.game;
      let ok = false, v = null, why = '';
      const id = typeof m.id === 'string' ? m.id.slice(0, 24) : null;
      if (!id) return;
      try {
        if (!g || this.phase !== 'game' || g.over) throw new Error('Spillet er ikke i gang');
        const a = des(Array.isArray(m.a) ? m.a : [], g);
        const own = (p) => { if (!isPlayer(g, p) || this.owners[p.id] !== mem.pub || p.bankrupt) throw new Error('Ikke din spiller'); return p; };
        const asks = (p) => [...this.pending.values()].filter((k) => k.pub === mem.pub && k.pid === p.id);
        if (MANAGE.includes(m.op)) {
          const p = own(a[0]), i = Number(a[1]);
          if (!MP.isOwnable(i)) throw new Error('Ugyldig felt');
          const mine = asks(p), debt = mine.some((k) => k.m === 'raiseFunds'), turn = g.current === p && mine.length > 0;
          if (m.op === 'sellHouse' || m.op === 'mortgage') { if (!debt && !turn) throw new Error('Bare på din egen tur'); } else if (debt) throw new Error('Ikke mens du skylder penger');
          else if (!turn) throw new Error('Bare på din egen tur');
          v = !!g[m.op](p, i); ok = true;
        } else if (m.op === 'proposeTrade') {
          const t = plainTrade(a[0]);
          if (!t) throw new Error('Ugyldig tilbud');
          const p = own(g.player(t.from));
          if (!asks(p).some((k) => ['humanPhase', 'jailChoice', 'raiseFunds'].includes(k.m))) throw new Error('Bare på din egen tur');
          if (this.busy.has(mem.pub)) throw new Error('Vent på svaret på forrige tilbud');
          this.busy.add(mem.pub);
          let r;
          try { r = await g.proposeTrade(t); } finally { this.busy.delete(mem.pub); }
          if (r && r.counter) this.counters.set(mem.pub, plainTrade(r.counter)); else this.counters.delete(mem.pub);
          v = ser(r, g); ok = true;
        } else if (m.op === 'executeTrade') {
          const t = plainTrade(a[0]), c = this.counters.get(mem.pub);
          if (!t || !c || tradeKey(t) !== tradeKey(c)) throw new Error('Motbudet gjelder ikke lenger');
          own(g.player(t.to));
          this.counters.delete(mem.pub);
          v = !!g.executeTrade(t); ok = true;
        } else if (m.op === 'declareBankrupt') {
          const p = own(a[0]);
          if (g.current !== p || !asks(p).some((k) => k.m === 'humanPhase' || k.m === 'jailChoice')) throw new Error('Bare på din egen tur');
          v = !!(await g.declareBankrupt(p)); ok = true;
        } else throw new Error('Ukjent kommando');
      } catch (e) {
        why = (e && e.message) || 'Noe gikk galt';
        if (!/^(Ikke|Bare|Ugyldig|Ukjent|Vent|Motbudet|Spillet)/.test(why)) console.error(e);
      }
      this.send({ t: 'rep', id, to: mem.pub, ok, v, why }, true);
    }
    // En frakoblet spiller overlates til datamaskinen (verten velger det i menyen).
    aiTakeover(pid) {
      const g = this.game, p = g && g.player(pid);
      if (!p || p.ai || this.owners[pid] === this.pub) return false;
      const AI = MP.AI;
      p.ai = true; p.level = p.level || 'normal';
      delete this.owners[pid];
      for (const k of [...this.pending.values()]) {
        if (k.pid !== pid) continue;
        this.pending.delete(k.id);
        if (k.w) this.waits = this.waits.filter((x) => x !== k.w);
        const a = k.raw || [];
        let v;
        try {
          switch (k.m) {
            case 'offerBuy': v = !!AI.wantsToBuy(g, p, a[1]); break;
            case 'auctionBid': v = AI.auctionBid(g, p, a[1], a[2]); break;
            case 'jailChoice': v = AI.jailChoice(g, p); break;
            case 'raiseFunds': AI.raiseFunds(g, p, a[1]); break;
            case 'tradeOffer': v = !!AI.evaluateTrade(g, p, a[0]); break;
            case 'chanceChoice': v = !!AI.drawChance(g, p); break;
            case 'goChoice': v = { type: 'cash' }; break;
            case 'busChoice': v = AI.busChoice(g, p, a[1]); break;
            case 'speedChoice': v = AI.speedChoice(g, p); break;
            default: v = undefined;
          }
        } catch (e) { console.warn(e); }
        k.resolve(v);
      }
      g.log(`Datamaskinen tar over for ${p.name}.`, 'good');
      this.send({ t: 'owners', owners: { ...this.owners } }, true);
      this.endWait(null);
      g.changed({ player: p.id });
      this.saveRoom();
      return true;
    }
    onOver(w, early) {
      if (this.phase !== 'game') return;
      this.phase = 'over';
      this.over = { w: w ? w.id : null, early: !!early };
      this.pending.clear(); this.waits = [];
      this.send({ t: 'over', ...this.over }, true);
      this.saveRoom();
    }
    // Etter vinnerskjermen: alle tilbake til lobbyen, klare for et nytt spill.
    toLobby() {
      if (this.game) this.game.stopped = true;
      this.game = null; this.phase = 'lobby'; this.owners = {}; this.over = null;
      this.pending.clear(); this.waits = []; this.ctx = { auc: null };
      this.members = this.members.filter((m) => m.host || m.online);
      this.ui.netToLobby();
      this.lobbyChanged();
    }
    isMine(p) { return !!p && this.owners[p.id] === this.pub; }
    isOffline(p) { if (!p || p.ai) return false; const m = this.member(this.owners[p.id]); return !!m && !m.host && !m.online; }
    save(s) { if (this.game && this.game.s === s) this.saveRoom(); }
    saveRoom() {
      ls.set(ROOM_KEY, JSON.stringify({
        v: 1, room: this.room, at: Date.now(),
        members: this.members.map(({ pub, key, name, token, color, host }) => ({ pub, key, name, token, color, host: !!host })),
        ais: this.ais, owners: this.owners, opts: this.ui.netOpts(),
        phase: this.phase === 'game' ? 'game' : 'lobby',
        s: this.phase === 'game' && this.game ? this.game.s : null,
      }));
    }
    shutdown() {
      clearInterval(this.hb);
      document.removeEventListener('visibilitychange', this.onVis);
      if (this.game) this.game.stopped = true;
      this.ui.netFast(false);
      if (this.t) this.t.end();
      this.t = null;
    }
    // Forlater rommet, men det kan gjenopptas senere fra «Spill online».
    leave() {
      if (this.phase === 'game' && this.game) this.saveRoom();
      this.send({ t: 'gone' }, false);
      this.flush();
      ss.del(SESSION_KEY);
      setTimeout(() => this.shutdown(), 150);
    }
    // Avslutter rommet for alle.
    close() {
      this.send({ t: 'closed' }, false);
      this.flush();
      ls.del(ROOM_KEY); ss.del(SESSION_KEY);
      setTimeout(() => this.shutdown(), 150);
    }
  }

  // ---------- Klient ----------
  class Client {
    constructor(ui) {
      this.ui = ui; this.role = 'client';
      this.epoch = null; this.expect = null; this.buf = new Map(); this.queue = []; this.pumping = false;
      this.asks = new Set(); this.answered = new Set(); this.rpcs = new Map();
      this.lobby = null; this.owners = {}; this.game = null; this.status = 'off'; this.off = [];
      this.hostSeen = 0; this.lost = false; this.phase = 'lobby'; this.lastHello = 0; this.claim = null;
    }
    get broker() { return this.t ? this.t.broker.name : ''; }
    // Kobler til rommet og venter på svar fra verten. `patient`: vent uten tidsavbrudd (gjenoppretting etter omlasting).
    async open(code, me, ident, patient = false) {
      this.room = code;
      this.pub = (ident && ident.pub) || rid(8);
      this.key = (ident && ident.key) || rid(18);
      this.me = { name: me && me.name, token: me && me.token, color: me && me.color };
      const t = new Transport(code, brokerOf(code));
      t.onMessage = (name, msg) => { if (name === 'h') this.onWire(msg); };
      t.onStatus = (st) => { this.status = st; this.ui.netLobby(); this.ui.netPresence(); };
      t.onReconnect = () => this.hello(true);
      await t.connect({ subs: ['h'], will: { name: 'c', obj: { t: 'bye', pub: this.pub } } });
      this.t = t; this.status = 'on';
      this.saveSession();
      this.hb = setInterval(() => this.beat(), HB_MS);
      this.onVis = () => { if (!this.pumping) this.ui.netFast(document.hidden && !!this.game); };
      document.addEventListener('visibilitychange', this.onVis);
      const joined = new Promise((resolve, reject) => {
        this.joinWait = { resolve, reject };
        if (!patient) this.joinTimer = setTimeout(() => { if (this.joinWait) { this.joinWait = null; reject(new Error('Fant ikke rommet. Sjekk koden, og at verten har spillet åpent.')); } }, 9000);
      });
      this.hello(true);
      return joined;
    }
    saveSession() { ss.set(SESSION_KEY, JSON.stringify({ role: 'client', room: this.room, pub: this.pub, key: this.key, me: this.me })); }
    joined() { if (this.joinWait) { clearTimeout(this.joinTimer); const w = this.joinWait; this.joinWait = null; w.resolve(this); } }
    post(obj) {
      if (!this.t) return;
      obj.pub = this.pub; obj.key = this.key;
      this.t.pub('c', obj, obj.t === 'hb' ? 0 : 1);
    }
    hello(force) {
      const now = Date.now();
      if (!force && now - this.lastHello < 2500) return;
      this.lastHello = now;
      const msg = { t: 'hello', name: this.me.name, token: this.me.token, color: this.me.color, e: this.epoch, have: this.expect != null ? this.expect - 1 : null };
      if (this.claim != null) msg.claim = this.claim;
      this.post(msg);
    }
    claimSeat(pid) { this.claim = Number(pid); this.hello(true); }
    beat() {
      this.post({ t: 'hb' });
      if (this.hostSeen && Date.now() - this.hostSeen > LOST_MS && !this.lost) this.setLost(true);
      if (this.gapAt && Date.now() - this.gapAt > 1500) { this.gapAt = Date.now(); this.hello(true); }
    }
    setLost(on) { this.lost = !!on; this.ui.netHostLost(this.lost); }
    setMe(p) { this.me = { name: p.name, token: p.token, color: p.color }; this.saveSession(); this.post({ t: 'pick', ...this.me }); }
    view() {
      const l = this.lobby || { members: [], ais: [], opts: null };
      return { role: 'client', room: this.room, link: MP.Net.link(this.room), broker: this.broker, status: this.status, phase: this.phase, me: this.pub, members: l.members || [], ais: l.ais || [], opts: l.opts };
    }
    isMine(p) { return !!p && this.owners[p.id] === this.pub; }
    isOffline(p) { return !!p && !p.ai && this.off.includes(p.id); }

    onWire(msg) {
      if (msg && Array.isArray(msg.b)) { for (const m of msg.b) this.handle(m); } else this.handle(msg);
    }
    handle(m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'gone' || m.t === 'closed') {
        if (m.e && this.epoch && m.e !== this.epoch) return;
        if (m.t === 'closed') { this.ui.netEnded('Verten har avsluttet rommet.'); this.shutdown(true); } else this.setLost(true);
        return;
      }
      this.hostSeen = Date.now();
      if (this.lost) this.setLost(false);
      if (m.t === 'reject') { if (m.to === this.pub) this.onReject(m); return; }
      const mineSync = m.t === 'sync' && (!m.to || m.to === this.pub);
      if (m.e && m.e !== this.epoch) {
        // Ny økt hos verten (startet på nytt): begynn på nytt med neste synk eller lobby.
        if (m.t === 'lobby' || mineSync) this.adopt(m.e);
        else { this.hello(); return; }
      }
      if (m.t === 'hb') {
        this.off = Array.isArray(m.off) ? m.off.map(Number) : [];
        this.ui.netPresence();
        if ((m.ph === 'game' || m.ph === 'over') && this.expect == null) this.hello();
        if (m.ph === 'lobby' && !this.lobby) this.hello();
        return;
      }
      if (m.t === 'lobby') { this.onLobby(m); return; }
      if (!Number.isInteger(m.n)) return;
      if (mineSync && (this.expect == null || m.n >= this.expect)) {
        for (const k of [...this.buf.keys()]) if (k <= m.n) this.buf.delete(k);
        this.queue.length = 0;
        this.expect = m.n;
      }
      if (this.expect == null || m.n < this.expect) return;
      if (m.n > this.expect) { this.buf.set(m.n, m); if (!this.gapAt) this.gapAt = Date.now(); return; }
      this.enqueue(m); this.expect++;
      while (this.buf.has(this.expect)) { const x = this.buf.get(this.expect); this.buf.delete(this.expect); this.enqueue(x); this.expect++; }
      if (!this.buf.size) this.gapAt = 0;
    }
    adopt(e) {
      this.epoch = e; this.expect = null; this.buf.clear(); this.queue.length = 0; this.gapAt = 0;
      this.asks.clear(); this.answered.clear(); this.reset = true;
      for (const r of this.rpcs.values()) { clearTimeout(r.timer); r.resolve(r.fail('Verten startet spillet på nytt')); }
      this.rpcs.clear();
    }
    onLobby(m) {
      this.lobby = { members: Array.isArray(m.members) ? m.members : [], ais: Array.isArray(m.ais) ? m.ais : [], opts: m.opts || null };
      this.phase = m.ph === 'game' || m.ph === 'over' ? m.ph : 'lobby';
      const meIn = this.lobby.members.find((x) => x.pub === this.pub);
      if (meIn) { this.me = { name: meIn.name, token: meIn.token, color: meIn.color }; this.saveSession(); this.joined(); }
      else if (this.phase === 'lobby') this.hello();
      if (this.phase === 'lobby' && this.game) {
        this.game.stopped = true; this.game = null; this.expect = null; this.queue.length = 0; this.owners = {};
        this.ui.netToLobby();
      }
      this.ui.netLobby();
    }
    onReject(m) {
      const err = new Error(String(m.why || 'Fikk ikke bli med.').slice(0, 200));
      err.seats = Array.isArray(m.seats) ? m.seats.slice(0, MAX_PLAYERS) : [];
      if (this.joinWait) { clearTimeout(this.joinTimer); const w = this.joinWait; this.joinWait = null; w.reject(err); return; }
      if (err.seats.length) { this.ui.netSeats(err); return; }
      this.ui.netEnded(err.message);
      this.shutdown(true);
    }
    enqueue(m) {
      this.queue.push(m);
      if (!this.pumping) this.pump();
    }
    // Spiller av vertens meldinger i rekkefølge. Ligger klienten langt etter (eller fanen er skjult), spoles det.
    async pump() {
      if (this.pumping) return;
      this.pumping = true;
      try {
        while (this.queue.length) {
          const m = this.queue.shift();
          this.ui.netFast(document.hidden || this.queue.length > 30);
          try { await this.exec(m); } catch (e) { console.error(e); }
        }
      } finally {
        this.pumping = false;
        this.ui.netFast(document.hidden && !!this.game);
      }
    }
    async exec(m) {
      if (m.t === 'sync') { if (!m.to || m.to === this.pub) await this.onSync(m); return; }
      const g = this.game;
      if (!g) return;
      if (m.d) { applyPieces(g.s, m.d); this.ui.scheduleRender(); }
      switch (m.t) {
        case 'ev': {
          if (!EV_OK.has(m.m)) return;
          const a = des(m.a, g);
          if (m.ask && m.to === this.pub) {
            // Eget Sjanse/Prøv lykken-kort: vis det og kvitter når spilleren har lest det.
            if (this.answered.has(m.ask)) return;
            this.asks.add(m.ask);
            await this.ui.showCard(...a);
            this.asks.delete(m.ask); this.answered.add(m.ask);
            this.post({ t: 'ans', id: m.ask });
            return;
          }
          const r = this.ui[m.m](...a);
          if (r && typeof r.then === 'function') await r;
          return;
        }
        case 'ask':
          if (m.to === this.pub) this.runAsk(m);
          else if (DEC_OK.has(m.m) && m.m !== 'showCard') this.ui.netShowWaiting(g.player(m.pid), m.m, des(m.a, g));
          return;
        case 'wait':
          if (m.pid == null) this.ui.netClearWaiting();
          else if (DEC_OK.has(m.m)) { const p = g.player(m.pid); if (p && !this.isMine(p)) this.ui.netShowWaiting(p, m.m, des(m.a, g)); else this.ui.netClearWaiting(); }
          return;
        case 'rep': {
          if (m.to !== this.pub) return;
          const r = this.rpcs.get(m.id);
          if (!r) return;
          this.rpcs.delete(m.id); clearTimeout(r.timer);
          r.resolve(m.ok ? des(m.v, g) : r.fail(m.why || 'Verten sa nei'));
          return;
        }
        case 'owners': if (m.owners && typeof m.owners === 'object') { this.owners = { ...m.owners }; this.ui.netPresence(); } return;
        case 'over': this.ui.gameOver(m.w != null ? g.player(m.w) : null, !!m.early); return;
        default:
      }
    }
    async onSync(m) {
      if (!m.s || !Array.isArray(m.s.players) || !m.s.props) return;
      this.owners = m.owners && typeof m.owners === 'object' ? { ...m.owners } : {};
      this.phase = 'game';
      this.joined();
      const fresh = !this.game || this.reset || this.game.s.players.length !== m.s.players.length;
      this.reset = false;
      if (fresh) {
        const g = new MP.Game(null, this.ui, JSON.parse(JSON.stringify(m.s)));
        applyPieces(g.s, pieces(JSON.parse(JSON.stringify(m.s)))); // nøyaktig vertens verdier (normalize kan runde av)
        this.wrap(g);
        this.game = g; this.asks.clear();
        await this.ui.netStartMirror(g, !m.start);
      } else {
        applyPieces(this.game.s, pieces(m.s));
        this.ui.netResynced();
      }
      if (m.ctx && m.ctx.auc) this.ui.netRestoreAuction(m.ctx.auc);
      for (const k of Array.isArray(m.asks) ? m.asks : []) this.runAsk(k);
      if (m.over && this.game) this.ui.gameOver(m.over.w != null ? this.game.player(m.over.w) : null, !!m.over.early);
    }
    // En beslutning for vår spiller: vis vanlig UI og send svaret tilbake.
    runAsk(k) {
      if (!k || !DEC_OK.has(k.m) || this.asks.has(k.id) || this.answered.has(k.id) || !this.game) return;
      const g = this.game, a = des(k.a, g), ep = this.epoch;
      if (k.m === 'tradeOffer' ? !(a[0] && a[0].give) : !a[0]) return;
      this.asks.add(k.id);
      Promise.resolve().then(() => this.ui[k.m](...a)).then((v) => {
        if (ep !== this.epoch || !this.asks.has(k.id)) return;
        this.asks.delete(k.id); this.answered.add(k.id);
        if (k.m === 'tradeOffer') {
          v = v === true ? { accept: true, um: ((a[0].give && a[0].give.unmortgage) || []).map(Number) } : (v && typeof v === 'object' ? v : false);
        }
        this.post({ t: 'ans', id: k.id, v: ser(v, g) });
      }).catch((e) => console.error(e));
    }
    rpc(op, args, ms = 15000) {
      const id = rid(10);
      return new Promise((resolve) => {
        const fail = (why) => {
          this.ui.netToast(why);
          return op === 'proposeTrade' ? { ok: false, why, counter: null, minCash: null } : false;
        };
        const timer = setTimeout(() => { if (this.rpcs.delete(id)) resolve(fail('Fikk ikke svar fra verten')); }, ms);
        this.rpcs.set(id, { resolve, timer, fail });
        this.post({ t: 'cmd', id, op, a: ser(args, this.game) });
      });
    }
    // Speil-instansen gjør aldri endringer selv: handlinger går til verten, som svarer med ny tilstand.
    wrap(g) {
      for (const op of MANAGE) g[op] = (p, i) => this.rpc(op, [p, i]);
      g.proposeTrade = (t) => this.rpc('proposeTrade', [t], 15 * 60000);
      g.executeTrade = (t) => this.rpc('executeTrade', [t]);
      g.declareBankrupt = (p) => this.rpc('declareBankrupt', [p], 15 * 60000);
      g.run = async () => {};
      g.save = () => {};
    }
    shutdown(clearSession) {
      clearInterval(this.hb); clearTimeout(this.joinTimer);
      document.removeEventListener('visibilitychange', this.onVis);
      for (const r of this.rpcs.values()) clearTimeout(r.timer);
      this.rpcs.clear();
      if (this.game) this.game.stopped = true;
      this.ui.netFast(false);
      if (this.t) this.t.end();
      this.t = null;
      if (clearSession) ss.del(SESSION_KEY);
    }
    leave() {
      this.post({ t: 'leave' });
      ss.del(SESSION_KEY);
      setTimeout(() => this.shutdown(true), 150);
    }
  }

  MP.Net = {
    BROKERS, Host, Client, Transport, loadLib, validCode, normCode, brokerOf,
    _test: { pieces, applyPieces, ser, des, tradeKey, plainTrade },
    link(code) {
      const u = new URL(location.href);
      u.search = ''; u.hash = '';
      u.searchParams.set('rom', code);
      return u.toString();
    },
    codeFromURL() {
      try { const c = normCode(new URLSearchParams(location.search).get('rom')); return validCode(c) ? c : null; } catch (e) { return null; }
    },
    clearURL() { try { if (location.search) history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* */ } },
    session() { const s = ss.json(SESSION_KEY); return s && validCode(s.room) && (s.role === 'host' || s.role === 'client') ? s : null; },
    clearSession() { ss.del(SESSION_KEY); },
    savedRoom() { const r = ls.json(ROOM_KEY); return r && validCode(r.room) && Array.isArray(r.members) && r.members.some((m) => m.host) ? r : null; },
    clearSavedRoom() { ls.del(ROOM_KEY); },
  };
})();

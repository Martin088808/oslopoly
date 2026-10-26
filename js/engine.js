// Spillmotoren: alle regler, uten grafikk. All tilstand ligger i `this.s` (ren JSON, lagres direkte).
// Motoren kaller `io` for alt som skal vises eller besluttes; datamotstandere besvares av MP.AI.
// Grensesnittet mot UI er beskrevet i docs/KONTRAKT_V5.md. Nyere io-metoder kalles med `?.`,
// så motoren virker også når UI-et ikke har dem ennå.
(function (root) {
  'use strict';
  const MP = root.MP;
  const { SQUARES, GROUPS, STATION_RENT, UTILITY_MULT, RULES, CHANCE, CHEST } = MP;

  const kr = (n) => 'kr ' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const SNAKE_EYES = 20000;   // M1000 × 20
  const WEALTH_GOAL = 60000;  // M3000 × 20
  const STATIONS = [5, 15, 25, 35];
  const UTILITIES = [12, 28];
  const isOwnable = (i) => ['street', 'station', 'utility'].includes(SQUARES[i].type);
  const GROUP_IDX = {};
  SQUARES.forEach((s) => { if (s.group) (GROUP_IDX[s.group] = GROUP_IDX[s.group] || []).push(s.index); });
  const groupOf = (g) => GROUP_IDX[g] || [];
  // Fartsterningen (Hasbros regel): 1, 2, 3, Mr. Monopoly ×2 og buss.
  const SPEED_FACES = [1, 2, 3, 'mono', 'mono', 'bus'];
  const RULE_KEYS = ['freeParking', 'goDouble', 'snakeEyes', 'auctionOnly', 'noJailRent', 'wealthWin', 'freeBuild', 'speedDie'];
  // `built` = antall byggehandlinger (hus eller hotell); `housesBuilt`/`hotelsBuilt` teller hver for seg.
  const STAT_KEYS = ['rentPaid', 'rentGot', 'bought', 'built', 'housesBuilt', 'hotelsBuilt', 'passedGo', 'jailed', 'doubles', 'maxCash', 'taxes', 'cardsDrawn', 'auctionsWon', 'maxRent'];
  // Sjekkpunkt i turen (lagres): 'start' = turen er ikke begynt, 'roll' = spilleren skal kaste
  // (evt. etter dobbel; `turnDoubles` dobler så langt), 'post' = kastene er ferdige, bare etterfasen gjenstår.
  const TURN_PHASES = ['start', 'roll', 'post'];
  const LEVELS = ['easy', 'normal', 'hard'];
  // Kastes internt for å avbryte turen når spillet er avgjort eller stoppet. Fanges i run().
  const HALT = Object.freeze({ halt: true });
  const interestOf = (i) => Math.round(SQUARES[i].price / 2 * RULES.mortgageInterest);

  function blankStats(p) {
    const o = {};
    for (const k of STAT_KEYS) o[k] = 0;
    o.maxCash = p.cash || 0;
    return o;
  }

  class Game {
    constructor(opts, io, saved) {
      this.io = io || {};
      this.stopped = false;
      if (saved) { this.s = Game.normalize(saved); return; }
      opts = opts || {};
      const startMoney = opts.startMoney || RULES.startMoney;
      const props = {};
      SQUARES.forEach((s, i) => { if (isOwnable(i)) props[i] = { owner: null, houses: 0, mortgaged: false }; });
      // Husregler (fra Monopoly Plus). I motsetning til Plus kan de kombineres.
      const r = opts.rules || {};
      const rules = {
        freeParking: !!(r.freeParking || opts.parkingPot), // skatter/bøter i potten på Gratis parkering
        goDouble: !!r.goDouble,                            // nøyaktig landing på Start: kr 8 000 eller fri flytting; Sjanse er valgfri
        snakeEyes: !!r.snakeEyes,                          // to enere gir bonus
        auctionOnly: !!r.auctionOnly,                      // ledige eiendommer selges bare på auksjon
        noJailRent: !!r.noJailRent,                        // ingen leie mens eieren sitter i fengsel
        wealthWin: !!r.wealthWin,                          // første til kr 60 000 i kontanter vinner
        freeBuild: !!r.freeBuild,                          // bygg uten hel fargegruppe og uten jevn bygging
        speedDie: !!r.speedDie,                            // fartsterning (Hasbros regel)
      };
      this.s = {
        version: 3,
        opts: {
          startMoney, parkingPot: rules.freeParking, auctions: opts.auctions !== false || rules.auctionOnly, rules,
          maxRounds: Math.max(0, Math.floor(Number(opts.maxRounds) || 0)),
        },
        players: opts.players.map((p, id) => ({
          id, name: p.name, ai: !!p.ai, token: p.token, color: p.color,
          level: LEVELS.includes(p.level) ? p.level : 'normal',
          cash: startMoney, pos: 0, inJail: false, jailTurns: 0, jailCards: [], bankrupt: false,
        })),
        props,
        housesLeft: RULES.houses,
        hotelsLeft: RULES.hotels,
        decks: { chance: shuffle(range(CHANCE.length)), chest: shuffle(range(CHEST.length)) },
        current: 0,
        first: 0,          // spilleren som begynner runden (fra turrekkefølge-kastet)
        turn: 1,           // runde
        orderDone: false,  // turrekkefølgen er kastet
        pot: 0,
        lastDice: [1, 1],
        lastSetTurn: 1,    // runden da en fargegruppe sist ble komplett (brukes av AI mot «stillstand»)
        turnPhase: 'start', // sjekkpunkt i turen (se TURN_PHASES), så lagring midt i turen fortsetter riktig
        turnDoubles: 0,     // dobler kastet så langt i turen
        turnPlayer: null,   // spilleren sjekkpunktet gjelder
        stats: {},
        startedAt: Date.now(),
        endedAt: null,
        winnerId: null,
        winReason: null,
      };
      for (const p of this.s.players) this.s.stats[p.id] = blankStats(p);
    }

    // Fyller inn felt som mangler i eldre lagrede spill (versjon 1–2).
    static normalize(s) {
      s.opts = s.opts || {};
      const r = s.opts.rules || {};
      const rules = {};
      for (const k of RULE_KEYS) rules[k] = !!r[k];
      if (s.opts.parkingPot) rules.freeParking = true;
      s.opts.rules = rules;
      s.opts.parkingPot = rules.freeParking;
      if (s.opts.auctions == null) s.opts.auctions = true;
      if (rules.auctionOnly) s.opts.auctions = true;
      s.opts.startMoney = s.opts.startMoney || RULES.startMoney;
      s.opts.maxRounds = Math.max(0, Math.floor(Number(s.opts.maxRounds) || 0));
      s.players = s.players || [];
      s.players.forEach((p, id) => {
        if (p.id == null) p.id = id;
        if (!LEVELS.includes(p.level)) p.level = 'normal';
        if (!Array.isArray(p.jailCards)) p.jailCards = [];
        p.jailTurns = p.jailTurns || 0;
        p.inJail = !!p.inJail; p.bankrupt = !!p.bankrupt; p.ai = !!p.ai;
        p.cash = Number(p.cash) || 0;
        p.pos = p.pos || 0;
      });
      if (!s.props) s.props = {};
      SQUARES.forEach((sq, i) => {
        if (!isOwnable(i)) return;
        const pr = s.props[i] = s.props[i] || { owner: null, houses: 0, mortgaged: false };
        if (pr.owner === undefined) pr.owner = null;
        pr.houses = pr.houses || 0; pr.mortgaged = !!pr.mortgaged;
      });
      if (s.housesLeft == null) s.housesLeft = RULES.houses;
      if (s.hotelsLeft == null) s.hotelsLeft = RULES.hotels;
      if (!s.decks) s.decks = { chance: shuffle(range(CHANCE.length)), chest: shuffle(range(CHEST.length)) };
      if (s.current == null) s.current = 0;
      if (s.first == null) s.first = 0;
      if (!s.turn) s.turn = 1;
      if (s.orderDone == null) s.orderDone = true; // eldre spill var allerede i gang
      if (s.pot == null) s.pot = 0;
      if (!Array.isArray(s.lastDice)) s.lastDice = [1, 1];
      if (s.lastSetTurn == null) s.lastSetTurn = s.turn;
      // Eldre lagringer ble alltid tatt ved turskifte.
      if (!TURN_PHASES.includes(s.turnPhase)) s.turnPhase = 'start';
      s.turnDoubles = Math.max(0, Math.min(2, Math.floor(Number(s.turnDoubles) || 0)));
      if (s.turnPlayer === undefined) s.turnPlayer = null;
      s.stats = s.stats || {};
      for (const p of s.players) {
        const fresh = !s.stats[p.id];
        const st = s.stats[p.id] = s.stats[p.id] || blankStats(p);
        for (const k of STAT_KEYS) if (typeof st[k] !== 'number') st[k] = k === 'maxCash' ? p.cash : 0;
        // Eldre spill uten statistikk: anta at spilleren har passert Start hvis spillet er godt i gang.
        if (fresh && s.turn > 3) st.passedGo = 1;
      }
      if (!s.startedAt) s.startedAt = Date.now();
      if (s.endedAt === undefined) s.endedAt = null;
      if (s.winnerId === undefined) s.winnerId = null;
      if (s.winReason === undefined) s.winReason = null;
      s.version = 3;
      return s;
    }

    // ---------- Oppslag ----------
    get rules() { return this.s.opts.rules || { freeParking: !!this.s.opts.parkingPot }; }
    log(msg, kind) { if (this.io.log) this.io.log(msg, kind); }
    event(type, data) { if (this.io.event) this.io.event(type, data); }
    // Alle tilstandsendringer går hit: statistikk, seierssjekk, så UI.
    changed(ev) {
      for (const p of this.s.players) {
        const st = this.s.stats[p.id];
        if (st && p.cash > st.maxCash) st.maxCash = p.cash;
      }
      this.checkEnd();
      if (this.io.changed) this.io.changed(ev);
      // Mens et menneske tar valg i en rolig fase (før/etter kast, fengselsvalg), lagres hver endring
      // (bygg, pantsetting, handel), så den ikke går tapt ved omlasting.
      if (this.safe) this.save();
    }
    // Lagrer tilstanden (aldri etter at spillet er avgjort eller stoppet).
    save() { if (!this.over && this.io.save) this.io.save(this.s); }
    // Sjekkpunkt i turen + lagring.
    checkpoint(phase, doubles = 0) {
      this.s.turnPhase = phase; this.s.turnDoubles = doubles; this.s.turnPlayer = this.s.current;
      this.save();
    }
    // Venter på et menneskes valg i en fase der tilstanden er konsistent (trygt å lagre ved hver endring).
    async safely(fn) {
      this.safe = true;
      try { return await fn(); } finally { this.safe = false; }
    }
    stat(p, key, add = 1) { const st = p && this.s.stats[p.id]; if (st) st[key] = (st[key] || 0) + add; }
    // Melder «fargegruppe komplett» når en spiller nettopp har fått hele gruppen.
    checkSet(p, i) {
      const g = SQUARES[i].group;
      if (g && this.ownsGroup(p, g)) {
        this.s.lastSetTurn = this.s.turn;
        this.log(`${p.name} eier nå hele ${GROUPS[g].name.toLowerCase()} gruppe!`, 'good');
        this.event('setComplete', { player: p, group: g });
      }
    }
    get players() { return this.s.players; }
    get current() { return this.s.players[this.s.current]; }
    get active() { return this.s.players.filter((p) => !p.bankrupt); }
    player(id) { return this.s.players[id]; }
    prop(i) { return this.s.props[i]; }
    ownerOf(i) { const pr = this.s.props[i]; return pr && pr.owner != null ? this.s.players[pr.owner] : null; }
    propsOf(p) { return Object.keys(this.s.props).map(Number).filter((i) => this.s.props[i].owner === p.id); }
    ownsGroup(p, g) { return groupOf(g).every((i) => this.s.props[i].owner === p.id); }
    countOwned(p, list) { return list.filter((i) => this.s.props[i].owner === p.id).length; }
    groupHasBuildings(g) { return groupOf(g).some((i) => this.s.props[i].houses > 0); }

    rentFor(i, diceTotal, special = {}) {
      const sq = SQUARES[i], pr = this.s.props[i], owner = this.ownerOf(i);
      if (!owner || pr.mortgaged) return 0;
      if (sq.type === 'street') {
        if (pr.houses > 0) return sq.rent[pr.houses];
        return sq.rent[0] * (this.ownsGroup(owner, sq.group) ? 2 : 1);
      }
      if (sq.type === 'station') return STATION_RENT[this.countOwned(owner, STATIONS)] * (special.doubleRent ? 2 : 1);
      if (sq.type === 'utility') return diceTotal * (special.utilityTen ? UTILITY_MULT[2] : UTILITY_MULT[this.countOwned(owner, UTILITIES)]);
      return 0;
    }

    buildingValue(p) {
      return this.propsOf(p).reduce((sum, i) => sum + this.s.props[i].houses * (GROUPS[SQUARES[i].group]?.house || 0), 0);
    }
    // Det spilleren kan skaffe ved å selge alle bygg og pantsette alt.
    liquidationValue(p) {
      let v = p.cash + this.buildingValue(p) / 2;
      for (const i of this.propsOf(p)) if (!this.s.props[i].mortgaged) v += SQUARES[i].price / 2;
      return v;
    }
    netWorth(p) {
      let v = p.cash + this.buildingValue(p);
      for (const i of this.propsOf(p)) v += this.s.props[i].mortgaged ? SQUARES[i].price / 2 : SQUARES[i].price;
      return v;
    }
    unmortgageCost(i) { return Math.ceil((SQUARES[i].price / 2) * (1 + RULES.mortgageInterest) / 10) * 10; }

    // ---------- Bygging og pantsetting ----------
    canBuild(p, i) {
      const sq = SQUARES[i], pr = this.s.props[i];
      if (!sq || sq.type !== 'street' || pr.owner !== p.id) return { ok: false, why: 'Ikke din gate' };
      const free = this.rules.freeBuild;
      if (!free && !this.ownsGroup(p, sq.group)) return { ok: false, why: 'Du må eie hele fargegruppen' };
      const g = free ? [i] : groupOf(sq.group);
      if (g.some((j) => this.s.props[j].mortgaged)) return { ok: false, why: free ? 'Gaten er pantsatt' : 'En gate i gruppen er pantsatt' };
      if (pr.houses >= 5) return { ok: false, why: 'Har allerede hotell' };
      if (!free && pr.houses > Math.min(...g.map((j) => this.s.props[j].houses))) return { ok: false, why: 'Bygg jevnt i gruppen' };
      if (pr.houses === 4 ? this.s.hotelsLeft < 1 : this.s.housesLeft < 1) return { ok: false, why: pr.houses === 4 ? 'Banken er tom for hoteller' : 'Banken er tom for hus' };
      const cost = GROUPS[sq.group].house;
      if (p.cash < cost) return { ok: false, why: 'Ikke nok penger' };
      return { ok: true, cost };
    }
    build(p, i) {
      const c = this.canBuild(p, i);
      if (!c.ok) return false;
      const pr = this.s.props[i];
      p.cash -= c.cost;
      if (pr.houses === 4) { this.s.hotelsLeft--; this.s.housesLeft += 4; } else this.s.housesLeft--;
      pr.houses++;
      this.stat(p, 'built');
      this.stat(p, pr.houses === 5 ? 'hotelsBuilt' : 'housesBuilt');
      this.log(`${p.name} bygde ${pr.houses === 5 ? 'hotell' : 'hus'} på ${SQUARES[i].name} (${kr(c.cost)}).`, 'build');
      this.changed({ prop: i, build: true, money: p.id, delta: -c.cost });
      return true;
    }
    // Fri bygging (Plus): hotell rett på gaten uten fire hus først. Koster husprisen × (5 − hus),
    // altså det samme som å bygge opp. Husene som står, går tilbake til banken; krever ledig hotell.
    canBuildHotel(p, i) {
      const sq = SQUARES[i], pr = this.s.props[i];
      if (!this.rules.freeBuild) return { ok: false, why: 'Bare med fri bygging' };
      if (!sq || sq.type !== 'street' || !pr || pr.owner !== p.id) return { ok: false, why: 'Ikke din gate' };
      if (pr.mortgaged) return { ok: false, why: 'Gaten er pantsatt' };
      if (pr.houses >= 5) return { ok: false, why: 'Har allerede hotell' };
      if (this.s.hotelsLeft < 1) return { ok: false, why: 'Banken er tom for hoteller' };
      const cost = GROUPS[sq.group].house * (5 - pr.houses);
      if (p.cash < cost) return { ok: false, why: 'Ikke nok penger' };
      return { ok: true, cost, houses: pr.houses };
    }
    buildHotel(p, i) {
      const c = this.canBuildHotel(p, i);
      if (!c.ok) return false;
      const pr = this.s.props[i];
      p.cash -= c.cost;
      this.s.housesLeft += pr.houses;
      this.s.hotelsLeft--;
      pr.houses = 5;
      this.stat(p, 'built');
      this.stat(p, 'hotelsBuilt');
      this.log(`${p.name} bygde hotell rett på ${SQUARES[i].name} (${kr(c.cost)}).`, 'build');
      this.changed({ prop: i, build: true, hotel: true, money: p.id, delta: -c.cost });
      return true;
    }
    canSellHouse(p, i) {
      const sq = SQUARES[i], pr = this.s.props[i];
      if (!sq || sq.type !== 'street' || pr.owner !== p.id || pr.houses === 0) return { ok: false, why: 'Ingen bygg å selge' };
      const g = groupOf(sq.group);
      if (!this.rules.freeBuild && pr.houses < Math.max(...g.map((j) => this.s.props[j].houses))) return { ok: false, why: 'Selg jevnt i gruppen' };
      return { ok: true, value: GROUPS[sq.group].house / 2 };
    }
    // Hva skjer om spilleren selger ett nivå på gate i? Returnerer
    // { levels: { felt: nyttNivå, … }, value, demolish } eller null.
    // Ved husmangel kan et hotell ikke byttes i 4 hus. Da velges høyeste lovlige nivå per gate
    // (jevn bygging, maks 1 i forskjell) som banken har hus til, uten å rive mer enn nødvendig.
    // Med fri bygging påvirkes bare den ene gaten. `demolish` = mer enn ett nivå rives (UI bør bekrefte).
    sellHousePlan(p, i) {
      const c = this.canSellHouse(p, i);
      if (!c.ok) return null;
      const pr = this.s.props[i], half = c.value;
      if (pr.houses < 5) return { levels: { [i]: pr.houses - 1 }, value: half, demolish: false };
      if (this.s.housesLeft >= 4) return { levels: { [i]: 4 }, value: half, demolish: false };
      if (this.rules.freeBuild) {
        const L = Math.min(4, this.s.housesLeft);
        return { levels: { [i]: L }, value: half * (5 - L), demolish: L < 4 };
      }
      const g = groupOf(SQUARES[i].group);
      const cur = g.map((j) => this.s.props[j].houses);
      const housesIn = (lv) => lv.reduce((s, h) => s + (h < 5 ? h : 0), 0);
      const oldHouses = housesIn(cur);
      let best = null;
      const levels = [];
      const rec = (k) => {
        if (k === g.length) {
          if (Math.max(...levels) - Math.min(...levels) > 1) return;
          if (housesIn(levels) - oldHouses > this.s.housesLeft) return;
          const total = levels.reduce((s, h) => s + h, 0);
          const rent = levels.reduce((s, h, n) => s + SQUARES[g[n]].rent[h], 0);
          if (!best || total > best.total || (total === best.total && rent > best.rent)) best = { total, rent, levels: levels.slice() };
          return;
        }
        const max = g[k] === i ? Math.min(4, cur[k]) : cur[k];
        for (let L = max; L >= 0; L--) { levels.push(L); rec(k + 1); levels.pop(); }
      };
      rec(0);
      const out = {}; let value = 0, steps = 0;
      g.forEach((j, n) => {
        if (best.levels[n] !== cur[n]) { out[j] = best.levels[n]; value += half * (cur[n] - best.levels[n]); steps += cur[n] - best.levels[n]; }
      });
      return { levels: out, value, demolish: steps > 1 };
    }
    sellHouse(p, i) {
      const plan = this.sellHousePlan(p, i);
      if (!plan) return false;
      for (const key of Object.keys(plan.levels)) {
        const j = Number(key), q = this.s.props[j], L = plan.levels[key];
        if (q.houses === 5) this.s.hotelsLeft++; else this.s.housesLeft += q.houses;
        if (L === 5) this.s.hotelsLeft--; else this.s.housesLeft -= L;
        q.houses = L;
      }
      p.cash += plan.value;
      this.log(plan.demolish
        ? `${p.name} solgte bygg på ${Object.keys(plan.levels).map((j) => SQUARES[j].name).join(', ')} (husmangel i banken, +${kr(plan.value)}).`
        : `${p.name} solgte bygg på ${SQUARES[i].name} (+${kr(plan.value)}).`, 'build');
      for (const key of Object.keys(plan.levels)) if (Number(key) !== i) this.changed({ prop: Number(key) });
      this.changed({ prop: i, money: p.id, delta: plan.value });
      return true;
    }
    canMortgage(p, i) {
      const pr = this.s.props[i];
      if (!pr || pr.owner !== p.id || pr.mortgaged) return { ok: false, why: 'Kan ikke pantsettes' };
      const sq = SQUARES[i];
      const built = this.rules.freeBuild ? this.s.props[i].houses > 0 : sq.type === 'street' && this.groupHasBuildings(sq.group);
      if (built) return { ok: false, why: this.rules.freeBuild ? 'Selg byggene på gaten først' : 'Selg byggene i gruppen først' };
      return { ok: true, value: sq.price / 2 };
    }
    mortgage(p, i) {
      const c = this.canMortgage(p, i);
      if (!c.ok) return false;
      this.s.props[i].mortgaged = true; p.cash += c.value;
      this.log(`${p.name} pantsatte ${SQUARES[i].name} (+${kr(c.value)}).`, 'money');
      this.changed({ prop: i, money: p.id, delta: c.value });
      return true;
    }
    canUnmortgage(p, i) {
      const pr = this.s.props[i];
      if (!pr || pr.owner !== p.id || !pr.mortgaged) return { ok: false, why: 'Ikke pantsatt' };
      const cost = this.unmortgageCost(i);
      if (p.cash < cost) return { ok: false, why: 'Ikke nok penger' };
      return { ok: true, cost };
    }
    unmortgage(p, i) {
      const c = this.canUnmortgage(p, i);
      if (!c.ok) return false;
      this.s.props[i].mortgaged = false; p.cash -= c.cost;
      this.log(`${p.name} innløste ${SQUARES[i].name} (${kr(c.cost)}).`, 'money');
      this.changed({ prop: i, money: p.id, delta: -c.cost });
      return true;
    }

    // ---------- Penger ----------
    receive(p, amount, why) {
      p.cash += amount;
      if (why) this.log(`${p.name} fikk ${kr(amount)} – ${why}.`, 'money');
      this.changed({ money: p.id, delta: amount });
    }
    // Betal til spiller (creditor) eller banken (null). Skaffer penger eller går konkurs ved behov.
    async pay(p, amount, creditor, why) {
      if (p.bankrupt || amount <= 0) return true;
      if (creditor && creditor.bankrupt) creditor = null;
      if (p.cash < amount) {
        const ok = await this.raiseFunds(p, amount, creditor);
        if (this.over) return false;   // spillet ble avgjort (f.eks. rikdomsseier) mens spilleren skaffet penger
        if (!ok) { await this.bankrupt(p, creditor); return false; }
      }
      p.cash -= amount;
      if (creditor) creditor.cash += amount;
      else if (this.s.opts.parkingPot && why !== 'kjøp') this.s.pot += amount;
      this.changed({ money: p.id, delta: -amount });
      if (creditor) this.changed({ money: creditor.id, delta: amount });
      return true;
    }
    // Mennesker får alltid gjeldsdialogen (de kan handle seg ut av gjelden), også når verdiene ikke dekker.
    async raiseFunds(p, amount, creditor) {
      const short = this.liquidationValue(p) < amount;
      if (p.ai) {
        if (short) { this.log(`${p.name} kan ikke betale ${kr(amount)}.`, 'bad'); return false; }
        MP.AI.raiseFunds(this, p, amount);
        return p.cash >= amount;
      }
      if (short) this.log(`${p.name} har ikke verdier nok til å betale ${kr(amount)} – handle eller gå konkurs.`, 'bad');
      if (this.io.raiseFunds) await this.io.raiseFunds(p, amount, creditor);
      return p.cash >= amount;
    }
    // Konkurs. Til en spiller: kreditor overtar alt og betaler 10 % rente på pantsatte eiendommer
    // (så langt pengene rekker). Til banken: eiendommene selges én og én på auksjon.
    async bankrupt(p, creditor) {
      if (p.bankrupt) return;
      this.safe = false; // konkurs og auksjoner er midt i en handling: ingen lagring underveis
      if (creditor && (creditor.bankrupt || creditor === p)) creditor = null;
      for (const i of this.propsOf(p)) {
        const pr = this.s.props[i];
        if (pr.houses > 0) {
          const per = GROUPS[SQUARES[i].group].house / 2;
          p.cash += per * pr.houses;
          if (pr.houses === 5) this.s.hotelsLeft++; else this.s.housesLeft += pr.houses;
          pr.houses = 0;
        }
      }
      const props = this.propsOf(p);
      p.bankrupt = true; p.inJail = false; p.jailTurns = 0;
      if (creditor) {
        creditor.cash += Math.max(0, p.cash);
        let interest = 0;
        for (const i of props) {
          this.s.props[i].owner = creditor.id;
          if (this.s.props[i].mortgaged) interest += interestOf(i);
        }
        const paid = Math.min(interest, Math.max(0, creditor.cash));
        creditor.cash -= paid;
        creditor.jailCards.push(...p.jailCards);
        this.log(`${p.name} gikk konkurs! ${creditor.name} overtar alt${paid ? ` og betaler ${kr(paid)} i rente på pantsatte eiendommer` : ''}.`, 'bad');
      } else {
        for (const i of props) Object.assign(this.s.props[i], { owner: null, mortgaged: false, houses: 0 });
        for (const c of p.jailCards) this.s.decks[c.deck].push(c.ci);
        this.log(`${p.name} gikk konkurs! Eiendommene går tilbake til banken${props.length && this.active.length > 1 ? ' og selges på auksjon' : ''}.`, 'bad');
      }
      p.jailCards = []; p.cash = 0;
      this.changed({ bankrupt: p.id, all: true });
      this.event('bankrupt', { player: p, creditor: creditor || null });
      if (this.io.bankrupt) await this.io.bankrupt(p, creditor);
      if (!creditor) {
        for (const i of props) {
          if (this.over || this.active.length < 2) break;
          if (this.s.props[i].owner == null) await this.auction(i, p);
        }
      }
    }
    // Frivillig konkurs (bare på egen tur): eiendommene går til banken og selges på auksjon.
    // UI må deretter avslutte ventende menneskevalg (humanPhase), så turen går videre.
    async declareBankrupt(p) {
      if (!p || p.bankrupt || this.over || p !== this.current) return false;
      this.log(`${p.name} gir opp og går konkurs.`, 'bad');
      await this.bankrupt(p, null);
      return true;
    }

    // ---------- Bevegelse ----------
    rollDice() { const d = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)]; this.s.lastDice = d; return d; }
    rollSpeed() { return SPEED_FACES[Math.floor(Math.random() * SPEED_FACES.length)]; }
    // Fartsterningen brukes først når spilleren har passert Start én gang.
    speedActive(p) { return !!this.rules.speedDie && (this.s.stats[p.id]?.passedGo || 0) > 0; }

    // how.byDice: bevegelsen kommer fra terningene (gjelder «Start og flytting»).
    async moveSteps(p, steps, how = {}) {
      const path = [];
      for (let k = 1; k <= steps; k++) path.push((p.pos + k) % 40);
      if (this.io.animateMove) await this.io.animateMove(p, path);
      const passed = p.pos + steps >= 40;
      p.pos = path[path.length - 1];
      if (passed) await this.salary(p, !!how.byDice);
    }
    async salary(p, byDice) {
      this.stat(p, 'passedGo');
      const exact = p.pos === 0;
      if (exact && byDice && this.rules.goDouble) {
        // Husregelen «Start og flytting»: kr 8 000, eller vanlig lønn og flytt til valgfritt felt.
        let c = p.ai ? MP.AI.goChoice(this, p) : (this.io.goChoice ? await this.io.goChoice(p) : null);
        if (!c || typeof c !== 'object') c = { type: 'cash' };
        const to = Number(c.to);
        if (c.type === 'move' && Number.isInteger(to) && to > 0 && to < 40) {
          this.receive(p, RULES.salary, 'landet på Start');
          this.event('salary', { player: p, amount: RULES.salary });
          this.log(`${p.name} flytter fritt til ${SQUARES[to].name}.`, 'good');
          if (this.io.animateMove) await this.io.animateMove(p, range(to).map((k) => k + 1));
          p.pos = to;
          return;
        }
        const amount = RULES.salary * 2;
        this.receive(p, amount, 'dobbel lønn for å lande rett på Start');
        this.event('goDouble', { player: p, amount });
        return;
      }
      this.receive(p, RULES.salary, exact ? 'landet på Start' : 'passerte Start');
      this.event('salary', { player: p, amount: RULES.salary });
    }
    async moveTo(p, target, how) {
      await this.moveSteps(p, (target - p.pos + 40) % 40 || 40, how);
    }
    async moveBack(p, steps) {
      const path = [];
      for (let k = 1; k <= steps; k++) path.push((p.pos - k + 40) % 40);
      if (this.io.animateMove) await this.io.animateMove(p, path);
      p.pos = path[path.length - 1];
    }
    async goToJail(p) {
      p.inJail = true; p.jailTurns = 0;
      this.stat(p, 'jailed');
      this.log(`${p.name} må i fengsel!`, 'bad');
      if (this.io.toJail) await this.io.toJail(p);
      p.pos = 10;
      this.changed({ player: p.id });
    }

    // ---------- Landing ----------
    async land(p, dice, special = {}) {
      const i = p.pos, sq = SQUARES[i];
      this.changed({ landed: i, player: p.id });
      if (isOwnable(i)) {
        const owner = this.ownerOf(i);
        if (!owner) return this.offerBuy(p, i);
        if (owner === p) return;
        if (this.s.props[i].mortgaged) { this.log(`${sq.name} er pantsatt – ingen leie.`); return; }
        if (owner.inJail && this.rules.noJailRent) { this.log(`${owner.name} sitter i fengsel og får ingen leie for ${sq.name}.`, 'good'); return; }
        let total = dice[0] + dice[1];
        if (special.utilityTen) {
          const d = this.rollDice();
          if (this.io.rollDice) await this.io.rollDice(p, d, true, null);
          total = d[0] + d[1];
        }
        const rent = this.rentFor(i, total, special);
        this.log(`${p.name} betaler ${kr(rent)} i leie til ${owner.name} for ${sq.name}.`, 'rent');
        if (this.io.rentPaid) await this.io.rentPaid(p, owner, rent, i);
        if (await this.pay(p, rent, owner, 'leie')) {
          this.stat(p, 'rentPaid', rent); this.stat(owner, 'rentGot', rent);
          const so = this.s.stats[owner.id];
          if (so && rent > so.maxRent) so.maxRent = rent;
        }
        return;
      }
      switch (sq.type) {
        case 'tax':
          this.log(`${p.name} betaler ${sq.name}: ${kr(sq.amount)}.`, 'money');
          if (this.io.taxPaid) await this.io.taxPaid(p, sq.amount, sq.name);
          if (await this.pay(p, sq.amount, null, 'skatt')) this.stat(p, 'taxes', sq.amount);
          return;
        case 'chance':
          // Husregelen «Start og flytting»: Sjanse-kort er valgfrie.
          if (this.rules.goDouble) {
            const draw = p.ai ? MP.AI.drawChance(this, p) : (this.io.chanceChoice ? await this.io.chanceChoice(p) : true);
            if (!draw) { this.log(`${p.name} lar være å trekke Sjanse.`); return; }
          }
          return this.drawCard(p, 'chance', dice);
        case 'chest': return this.drawCard(p, 'chest', dice);
        case 'gotojail': return this.goToJail(p);
        case 'parking':
          if (this.s.opts.parkingPot && this.s.pot > 0) {
            const pot = this.s.pot; this.s.pot = 0;
            this.receive(p, pot, 'potten på Gratis parkering');
          }
          return;
        default: return;
      }
    }

    async offerBuy(p, i) {
      const sq = SQUARES[i];
      if (this.rules.auctionOnly) { this.log(`${sq.name} kan bare kjøpes på auksjon.`, 'auction'); return this.auction(i, p); }
      const want = p.ai ? MP.AI.wantsToBuy(this, p, i) : await this.io.offerBuy(p, i);
      if (this.over) return;
      if (want && p.cash >= sq.price && this.s.props[i].owner == null) {
        p.cash -= sq.price;
        this.s.props[i].owner = p.id;
        this.stat(p, 'bought');
        this.log(`${p.name} kjøpte ${sq.name} for ${kr(sq.price)}.`, 'buy');
        this.changed({ prop: i, bought: true, money: p.id, delta: -sq.price });
        if (this.io.bought) await this.io.bought(p, i);
        this.checkSet(p, i);
        return;
      }
      if (this.s.opts.auctions) await this.auction(i, p);
    }

    async auction(i, starter) {
      const sq = SQUARES[i];
      const n = this.players.length;
      const order = [];
      for (let k = 1; k <= n; k++) { const q = this.players[(starter.id + k) % n]; if (!q.bankrupt) order.push(q); }
      let high = 0, leader = null, pos = 0;
      const bidders = order.slice();
      if (!bidders.length) return;
      this.log(`Auksjon over ${sq.name}!`, 'auction');
      if (this.io.auctionStart) await this.io.auctionStart(i, bidders);
      let guard = 0;
      while (bidders.length && guard++ < 2000) {
        if (leader && bidders.length === 1 && bidders[0] === leader) break;
        pos %= bidders.length;
        const b = bidders[pos];
        if (b === leader) { pos++; continue; }
        const raw = b.ai ? MP.AI.auctionBid(this, b, i, high) : await this.io.auctionBid(b, i, high, leader);
        const bid = Math.floor(Number(raw) || 0);
        if (bid && bid > high && bid <= b.cash) {
          high = bid; leader = b; pos++;
          if (this.io.auctionUpdate) await this.io.auctionUpdate(i, leader, high);
        } else {
          bidders.splice(pos, 1);
          if (this.io.auctionUpdate) await this.io.auctionUpdate(i, leader, high, b);
        }
      }
      if (leader && leader.cash >= high && this.s.props[i].owner == null) {
        leader.cash -= high;
        this.s.props[i].owner = leader.id;
        this.stat(leader, 'bought'); this.stat(leader, 'auctionsWon');
        this.log(`${leader.name} vant auksjonen over ${sq.name} for ${kr(high)}.`, 'buy');
        this.changed({ prop: i, bought: true, money: leader.id, delta: -high });
      } else {
        leader = null;
        this.log(`Ingen bød på ${sq.name}.`);
      }
      if (this.io.auctionEnd) await this.io.auctionEnd(i, leader, high);
      if (leader) this.checkSet(leader, i);
    }

    // ---------- Kort ----------
    async drawCard(p, type, dice) {
      const deck = this.s.decks[type];
      const ci = deck.shift();
      const card = (type === 'chance' ? CHANCE : CHEST)[ci];
      if (card.act === 'jailCard') p.jailCards.push({ deck: type, ci }); else deck.push(ci);
      this.stat(p, 'cardsDrawn');
      this.log(`${p.name} trakk ${type === 'chance' ? 'Sjanse' : 'Prøv lykken'}: «${card.text}»`, 'card');
      if (this.io.showCard) await this.io.showCard(p, type, card);
      if (this.over) return;
      switch (card.act) {
        // «Gå til Start» gir vanlig lønn (ikke dobbel), siden bevegelsen ikke kommer fra terningene.
        case 'move': await this.moveTo(p, card.to); return this.land(p, dice);
        case 'nearestStation': {
          const t = STATIONS.find((s) => s > p.pos) ?? STATIONS[0];
          await this.moveTo(p, t); return this.land(p, dice, { doubleRent: true });
        }
        case 'nearestUtility': {
          const t = UTILITIES.find((s) => s > p.pos) ?? UTILITIES[0];
          await this.moveTo(p, t); return this.land(p, dice, { utilityTen: true });
        }
        case 'back': await this.moveBack(p, card.steps); return this.land(p, dice);
        case 'jail': return this.goToJail(p);
        case 'money':
          if (card.amount > 0) this.receive(p, card.amount);
          else await this.pay(p, -card.amount, null, 'kort');
          return;
        case 'repairs': {
          let houses = 0, hotels = 0;
          for (const i of this.propsOf(p)) { const h = this.s.props[i].houses; if (h === 5) hotels++; else houses += h; }
          const cost = houses * card.house + hotels * card.hotel;
          if (cost > 0) { this.log(`${p.name} betaler ${kr(cost)} for ${houses} hus og ${hotels} hotell.`, 'money'); await this.pay(p, cost, null, 'kort'); }
          return;
        }
        case 'payEach':
          for (const o of this.active) { if (this.over || p.bankrupt) return; if (o !== p && !o.bankrupt) await this.pay(p, card.amount, o, 'kort'); }
          return;
        case 'collectEach':
          for (const o of this.active) { if (this.over) return; if (o !== p && !o.bankrupt) await this.pay(o, card.amount, p, 'kort'); }
          return;
        default: return;
      }
    }

    // ---------- Fengsel ----------
    canPayFine(p) { return this.liquidationValue(p) >= RULES.jailFine; }
    useJailCard(p) {
      const c = p.jailCards.shift();
      this.s.decks[c.deck].push(c.ci);
      p.inJail = false; p.jailTurns = 0;
      this.log(`${p.name} brukte «Kom ut av fengselet»-kortet.`, 'card');
      this.changed({ player: p.id });
    }
    // Returnerer true hvis spilleren skal kaste vanlig etterpå, false hvis turen er brukt.
    // Fartsterningen brukes ikke ved fengselskast.
    async jailPhase(p) {
      const choice = p.ai ? MP.AI.jailChoice(this, p) : await this.safely(() => this.io.jailChoice(p));
      this.halt();
      if (choice === 'card' && p.jailCards.length) { this.useJailCard(p); return true; }
      if (choice === 'pay') {
        this.log(`${p.name} betaler ${kr(RULES.jailFine)} og kommer ut av fengselet.`, 'money');
        if (!(await this.pay(p, RULES.jailFine, null, 'bot'))) return false;
        p.inJail = false; p.jailTurns = 0; this.changed({ player: p.id });
        return true;
      }
      const d = this.rollDice();
      if (this.io.rollDice) await this.io.rollDice(p, d, false, null);
      this.halt();
      p.jailTurns++;
      if (d[0] === d[1]) {
        p.inJail = false; p.jailTurns = 0;
        this.stat(p, 'doubles');
        this.log(`${p.name} kastet dobbel og er fri!`, 'good');
      } else if (p.jailTurns >= 3) {
        this.log(`${p.name} må betale ${kr(RULES.jailFine)} etter tre forsøk.`, 'money');
        if (!(await this.pay(p, RULES.jailFine, null, 'bot'))) return false;
        p.inJail = false; p.jailTurns = 0;
      } else {
        this.log(`${p.name} kastet ikke dobbel og blir i fengselet (forsøk ${p.jailTurns} av 3).`);
        return false;
      }
      this.changed({ player: p.id });
      this.halt();
      await this.moveSteps(p, d[0] + d[1], { byDice: true });
      this.halt();
      await this.land(p, d);
      return false;
    }

    // ---------- Handel ----------
    // Renten (10 %) mottakeren må betale for pantsatte eiendommer på én side av handelen.
    tradeInterest(side) { return (side && side.props || []).reduce((s, i) => s + (this.s.props[i]?.mortgaged ? interestOf(i) : 0), 0); }
    // Det mottakeren av én side må betale banken straks: 10 % rente per pantsatt eiendom, eller
    // pantelån + 10 % (unmortgageCost) for eiendommer i `side.unmortgage` («Innløs straks»).
    tradeCost(side) {
      const um = (side && Array.isArray(side.unmortgage)) ? side.unmortgage.map(Number) : [];
      return (side && side.props || []).reduce((s, i) => {
        if (!this.s.props[i]?.mortgaged) return s;
        return s + (um.includes(Number(i)) ? this.unmortgageCost(i) : interestOf(i));
      }, 0);
    }
    tradeIssues(t) {
      if (!t || !t.give || !t.get) return 'Ugyldig tilbud';
      const a = this.player(t.from), b = this.player(t.to);
      if (!a || !b || a.bankrupt || b.bankrupt || a === b) return 'Ugyldige spillere';
      for (const side of [t.give, t.get]) {
        side.props = Array.isArray(side.props) ? side.props.map(Number) : [];
        side.cash = Math.floor(Number(side.cash) || 0);
        side.jailCards = Math.floor(Number(side.jailCards) || 0);
        if (side.cash < 0 || side.jailCards < 0) return 'Ugyldig beløp';
        // «Innløs straks»: bare pantsatte eiendommer på samme side teller (resten ignoreres).
        side.unmortgage = Array.isArray(side.unmortgage)
          ? [...new Set(side.unmortgage.map(Number))].filter((i) => side.props.includes(i) && !!this.s.props[i]?.mortgaged)
          : [];
      }
      const all = [...t.give.props, ...t.get.props];
      if (new Set(all).size !== all.length) return 'Samme eiendom er med to ganger';
      for (const i of t.give.props) if (!this.s.props[i] || this.s.props[i].owner !== a.id) return 'Eiendommen tilhører ikke giveren';
      for (const i of t.get.props) if (!this.s.props[i] || this.s.props[i].owner !== b.id) return 'Eiendommen tilhører ikke mottakeren';
      for (const i of all) {
        const sq = SQUARES[i];
        if (sq.type === 'street' && (this.rules.freeBuild ? this.s.props[i].houses > 0 : this.groupHasBuildings(sq.group))) {
          return this.rules.freeBuild ? `Selg byggene på ${sq.name} først` : `Selg byggene i ${GROUPS[sq.group].name.toLowerCase()} gruppe først`;
        }
      }
      if (t.give.cash > a.cash) return `${a.name} har ikke nok penger`;
      if (t.get.cash > b.cash) return `${b.name} har ikke nok penger`;
      if (t.give.jailCards > a.jailCards.length || t.get.jailCards > b.jailCards.length) return 'Ikke nok fengselskort';
      const empty = (x) => !x.props.length && !x.cash && !x.jailCards;
      if (empty(t.give) && empty(t.get)) return 'Tilbudet er tomt';
      // Renten (og evt. innløsningen) på mottatte pantsatte eiendommer må kunne betales, så ingen går i minus.
      const ia = this.tradeCost(t.get), ib = this.tradeCost(t.give);
      const what = (side) => (side.unmortgage.length ? 'innløsning og rente' : 'renten');
      if (a.cash - t.give.cash + t.get.cash - ia < 0) return `${a.name} har ikke råd til ${what(t.get)} på pantsatte eiendommer (${kr(ia)})`;
      if (b.cash - t.get.cash + t.give.cash - ib < 0) return `${b.name} har ikke råd til ${what(t.give)} på pantsatte eiendommer (${kr(ib)})`;
      return null;
    }
    executeTrade(t) {
      const issue = this.tradeIssues(t);
      if (issue) { this.log(`Handelen ble ikke gjennomført: ${issue}.`, 'bad'); return false; }
      const a = this.player(t.from), b = this.player(t.to);
      const move = (from, to, side) => {
        for (const i of side.props) {
          const pr = this.s.props[i];
          pr.owner = to.id;
          if (!pr.mortgaged) continue;
          // Mottar man pantsatt eiendom, betales 10 % rente til banken – eller pantelån + 10 % ved
          // «Innløs straks» (dekning er sjekket i tradeIssues).
          if (side.unmortgage.includes(i)) {
            const cost = this.unmortgageCost(i);
            to.cash -= cost; pr.mortgaged = false;
            this.log(`${to.name} innløste ${SQUARES[i].name} straks (${kr(cost)}).`, 'money');
          } else to.cash -= interestOf(i);
        }
        from.cash -= side.cash || 0; to.cash += side.cash || 0;
        for (let k = 0; k < (side.jailCards || 0); k++) to.jailCards.push(from.jailCards.shift());
      };
      move(a, b, t.give); move(b, a, t.get);
      this.log(`Handel: ${a.name} og ${b.name} ble enige.`, 'trade');
      this.changed({ trade: true, all: true });
      this.event('tradeDone', { trade: t });
      for (const i of t.give.props) this.checkSet(b, i);
      for (const i of t.get.props) this.checkSet(a, i);
      return true;
    }
    // → { ok: true } eller { ok: false, why, counter, minCash }.
    //   counter: motbud (samme format, from/to byttet) eller null.
    //   minCash: når en datamaskin sa nei: hvor mye mer (kr, i tillegg til t.give.cash) den minst ville tatt
    //            imot for å godta akkurat denne handelen, eller null (ingen beløp holder / ikke råd).
    //   why: kort grunn på norsk («Bjørn gir ikke bort den siste oransje», «Bjørn vil ha minst kr 1 200 mer»).
    async proposeTrade(t) {
      const issue = this.tradeIssues(t);
      if (issue) return { ok: false, why: issue, counter: null, minCash: null };
      const a = this.player(t.from), b = this.player(t.to);
      let yes = false, counter = null, minCash = null, reason = null;
      if (b.ai) {
        yes = !!MP.AI.evaluateTrade(this, b, t);
        if (!yes) {
          if (MP.AI.counterOffer) counter = MP.AI.counterOffer(this, b, t) || null;
          if (MP.AI.minAccept) { const m = MP.AI.minAccept(this, b, t); minCash = Number.isFinite(m) && m > 0 ? m : null; }
          if (MP.AI.declineReason) reason = MP.AI.declineReason(this, b, t, minCash) || null;
        }
      } else {
        const r = this.io.tradeOffer ? await this.io.tradeOffer(t) : false;
        // Valgfritt: UI kan svare med et motbud-objekt i stedet for true/false.
        if (r && typeof r === 'object' && r.give && r.get) counter = r; else yes = !!r;
      }
      if (counter && (counter.from !== b.id || counter.to !== a.id || this.tradeIssues(counter))) counter = null;
      if (yes) { this.executeTrade(t); return { ok: true }; }
      this.log(`${b.name} takket nei til handelen${counter ? ', men kom med et motbud' : ''}.`, 'trade');
      this.event('tradeDeclined', { trade: t, counter });
      // En datamaskin som foreslo handelen, vurderer motbudet selv.
      if (counter && a.ai && MP.AI.evaluateTrade(this, a, counter)) {
        this.log(`${a.name} godtar motbudet fra ${b.name}.`, 'trade');
        if (this.executeTrade(counter)) return { ok: true, countered: true };
      }
      return { ok: false, why: reason || `${b.name} sa nei`, counter, minCash };
    }

    // ---------- Seier ----------
    get over() { return !!this.stopped || this.s.winnerId != null; }
    halt() { if (this.over) throw HALT; }
    setWinner(p, reason) {
      this.s.winnerId = p.id; this.s.winReason = reason;
      if (!this.s.endedAt) this.s.endedAt = Date.now();
      this.event('winner', { player: p, reason });
      return p;
    }
    // Avgjør og husker vinneren (siste gjenværende, eller rikdomsregelen i det kontantene når målet).
    checkEnd() {
      if (this.s.winnerId != null) return this.players[this.s.winnerId];
      const a = this.active;
      if (a.length === 1) return this.setWinner(a[0], 'bankrupt');
      if (this.rules.wealthWin) { const w = a.find((p) => p.cash >= WEALTH_GOAL); if (w) return this.setWinner(w, 'wealth'); }
      return null;
    }
    winner() { return this.checkEnd(); }
    winReason() {
      return this.s.winReason || (this.active.length === 1 ? 'bankrupt' : 'wealth');
    }

    // ---------- Turrekkefølge ----------
    async decideOrder() {
      const rolls = [];
      let cands = this.active.slice();
      for (let guard = 0; guard < 50 && cands.length > 1; guard++) {
        // round: 0 = første kast, 1+ = omkast blant dem som sto likt.
        const res = cands.map((p) => { const d = this.rollDice(); rolls.push({ player: p, dice: d, round: guard }); return { p, sum: d[0] + d[1] }; });
        const max = Math.max(...res.map((r) => r.sum));
        cands = res.filter((r) => r.sum === max).map((r) => r.p);
      }
      const first = cands[0] || this.active[0];
      // N1: vinneren sendes med, så UI ikke regner den ut selv (omkast kan gi lavere sum enn første kast).
      if (this.io.turnOrder) await this.io.turnOrder(rolls, first);
      this.halt();
      const n = this.players.length;
      this.s.first = first.id; this.s.current = first.id; this.s.orderDone = true;
      const order = range(n).map((k) => this.players[(first.id + k) % n]).filter((q) => !q.bankrupt);
      this.log(`${first.name} kastet høyest og begynner.`, 'good');
      this.event('turnOrder', { order, first, rolls });
    }

    // ---------- Fartsterning ----------
    async speedTarget(p) {
      let to = p.ai || !this.io.speedChoice ? MP.AI.speedChoice(this, p) : await this.io.speedChoice(p, 'triple');
      to = Number(to);
      if (!Number.isInteger(to) || to < 0 || to > 39) to = MP.AI.speedChoice(this, p);
      return to;
    }
    async busSteps(p, d) {
      const opts = [d[0], d[1], d[0] + d[1]];
      // Uten io.busChoice flytter et menneske summen.
      let n = p.ai ? MP.AI.busChoice(this, p, opts) : this.io.busChoice ? await this.io.busChoice(p, opts) : opts[2];
      n = Number(n);
      return opts.includes(n) ? n : opts[2];
    }
    // Neste ledige eiendom, ellers neste upantsatte eiendom eid av en motspiller.
    monoTarget(p) {
      for (let k = 1; k < 40; k++) { const i = (p.pos + k) % 40; if (isOwnable(i) && this.s.props[i].owner == null) return i; }
      for (let k = 1; k < 40; k++) {
        const i = (p.pos + k) % 40, pr = this.s.props[i];
        if (isOwnable(i) && pr.owner != null && pr.owner !== p.id && !pr.mortgaged) return i;
      }
      return null;
    }
    async speedMono(p, d) {
      const to = this.monoTarget(p);
      if (to == null) return;
      this.log(`Ekspress! ${p.name} går videre til ${SQUARES[to].name}.`, 'good');
      this.event('speedMono', { player: p, to });
      await this.moveTo(p, to);
      this.halt();
      await this.land(p, d);
    }

    // ---------- Turer ----------
    // N4: turen har sjekkpunkter (s.turnPhase / s.turnDoubles) og lagres etter hver fullført handling,
    // så «Fortsett» midt i turen går videre i riktig fase i stedet for å gi et nytt kast.
    async playTurn() {
      const p = this.current, s = this.s;
      this.halt();
      let phase = s.turnPlayer === p.id ? s.turnPhase : 'start';
      if (!TURN_PHASES.includes(phase) || (phase === 'roll' && p.inJail)) phase = 'start';
      s.turnPlayer = p.id;
      // Andre argument: null ved vanlig turstart, ellers 'roll' | 'post' når en lagret tur fortsetter.
      if (this.io.turnStart) await this.io.turnStart(p, phase === 'start' ? null : phase);
      this.halt();
      let rollNormally = phase !== 'post';
      let doubles = phase === 'roll' ? (s.turnDoubles || 0) : 0;
      if (phase === 'start') {
        s.turnPhase = 'start'; s.turnDoubles = 0;
        if (p.inJail) { rollNormally = await this.jailPhase(p); this.halt(); }
        if (!p.bankrupt) this.checkpoint(rollNormally ? 'roll' : 'post', 0);
      }
      while (rollNormally && !p.bankrupt) {
        if (p.ai) await MP.AI.beforeRoll(this, p); else await this.safely(() => this.io.humanPhase(p, 'pre'));
        this.halt();
        if (p.bankrupt) break;
        const d = this.rollDice();
        const speed = this.speedActive(p) ? this.rollSpeed() : null;
        if (this.io.rollDice) await this.io.rollDice(p, d, false, speed);
        this.halt();
        const isDouble = d[0] === d[1];
        if (isDouble) this.stat(p, 'doubles');
        if (d[0] === 1 && d[1] === 1 && this.rules.snakeEyes) {
          this.log(`Slangeøyne! ${p.name} får ${kr(SNAKE_EYES)}.`, 'good');
          this.receive(p, SNAKE_EYES);
          this.event('snakeEyes', { player: p, amount: SNAKE_EYES });
          this.halt();
        }
        // Fartsterning: tre like → flytt til valgfritt felt, og turen slutter.
        if (isDouble && speed === d[0]) {
          this.log(`Tre like! ${p.name} kan flytte til hvilket felt som helst.`, 'good');
          const to = await this.speedTarget(p);
          this.halt();
          if (to !== p.pos) await this.moveTo(p, to);
          this.halt();
          await this.land(p, d);
          break;
        }
        if (isDouble && ++doubles === 3) {
          this.log(`${p.name} kastet tre dobler på rad!`, 'bad');
          await this.goToJail(p);
          break;
        }
        let steps = d[0] + d[1];
        if (typeof speed === 'number') steps += speed;
        else if (speed === 'bus') { steps = await this.busSteps(p, d); this.halt(); }
        await this.moveSteps(p, steps, { byDice: true });
        this.halt();
        await this.land(p, d);
        this.halt();
        if (speed === 'mono' && !p.bankrupt && !p.inJail) { await this.speedMono(p, d); this.halt(); }
        if (p.bankrupt || p.inJail || !isDouble) break;
        this.checkpoint('roll', doubles); // dobbel: spilleren har et kast til gode
        this.log(`${p.name} kastet dobbel og kaster igjen.`, 'good');
      }
      this.halt();
      if (!p.bankrupt) {
        this.checkpoint('post', doubles);
        if (p.ai) await MP.AI.afterRoll(this, p); else await this.safely(() => this.io.humanPhase(p, 'post'));
      }
      this.halt();
      this.nextPlayer();
    }
    // Neste spiller som ikke er konkurs. Runden øker når vi passerer den som begynte.
    // Kan aldri løkke uendelig (maks én runde rundt bordet).
    nextPlayer() {
      if (this.over) return;
      this.s.turnPhase = 'start'; this.s.turnDoubles = 0; this.s.turnPlayer = null;
      const n = this.players.length;
      let k = this.s.current;
      for (let step = 0; step < n; step++) {
        k = (k + 1) % n;
        if (k === this.s.first) this.s.turn++;
        if (!this.players[k].bankrupt) { this.s.current = k; break; }
      }
      const max = this.s.opts.maxRounds || 0;
      if (max > 0 && this.s.turn > max && !this.over) {
        const best = this.active.slice().sort((x, y) => this.netWorth(y) - this.netWorth(x))[0];
        if (best) {
          this.log(`Runde ${max} er spilt – ${best.name} har mest verdier og vinner.`, 'good');
          this.setWinner(best, 'rounds');
        }
      }
    }
    async run() {
      try {
        if (!this.s.orderDone) { await this.decideOrder(); this.save(); }
        while (!this.over) {
          await this.playTurn();
          if (this.over) break;
          this.save();
        }
      } catch (e) {
        if (e !== HALT) throw e;
      }
      if (this.stopped) return;
      const w = this.winner();
      if (!this.s.endedAt) this.s.endedAt = Date.now();
      if (this.io.gameOver) await this.io.gameOver(w);
    }
  }

  MP.Game = Game;
  MP.kr = kr;
  MP.groupOf = (g) => groupOf(g).slice();
  MP.isOwnable = isOwnable;
  MP.STATIONS = STATIONS;
  MP.SNAKE_EYES = SNAKE_EYES;
  MP.WEALTH_GOAL = WEALTH_GOAL;
  MP.UTILITIES = UTILITIES;
  MP.SPEED_FACES = SPEED_FACES;
  MP.AI_LEVELS = LEVELS;
})(typeof window !== 'undefined' ? window : globalThis);

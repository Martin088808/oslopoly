// Datamotstandere. Forklarbare regler: hold en buffer, fullfør fargegrupper, bygg jevnt, handle når brettet står stille.
// Nivåer (spillerfelt `level`): 'easy' | 'normal' | 'hard'. Litt tilfeldighet i grensene gjør dem mindre mekaniske.
(function (root) {
  'use strict';
  const MP = root.MP;
  const { SQUARES, GROUPS, RULES } = MP;

  const round100 = (n) => Math.max(100, Math.round(n / 100) * 100);
  const ceil100 = (n) => Math.max(100, Math.ceil(n / 100) * 100);
  const GROUP_KEYS = Object.keys(GROUPS);
  const GIDX = {};
  for (const gr of GROUP_KEYS) GIDX[gr] = SQUARES.filter((s) => s.group === gr).map((s) => s.index);
  const groupTotal = (gr) => GIDX[gr].reduce((s, j) => s + SQUARES[j].price, 0);
  const isOwnable = (i) => ['street', 'station', 'utility'].includes(SQUARES[i].type);
  const jitter = (amp) => 1 + (Math.random() * 2 - 1) * amp;
  const interestOf = (g, i) => (g.s.props[i].mortgaged ? Math.round(SQUARES[i].price / 2 * RULES.mortgageInterest) : 0);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  // Nivåparametre.
  //  auction*: øvre grense i auksjon som andel av prisen (vanlig / gir gruppe / blokkerer gruppe / rik).
  //  theyGet/threat: hvor dyrt det er å gi motparten en gruppe, eller bringe den nærmere en gruppe.
  const LV = {
    easy: {
      tradeChance: 0.12, auctionBase: 0.72, auctionGroup: 0.95, auctionBlock: 0.8, auctionRich: 0.85,
      theyGet: 0.5, threat: 0.12, margin: 0.03, minMargin: 0, noise: 0.15, counter: 0.5,
    },
    normal: {
      tradeChance: 0.35, auctionBase: 0.97, auctionGroup: 1.25, auctionBlock: 1.12, auctionRich: 1.06,
      theyGet: 0.8, threat: 0.35, margin: 0.08, minMargin: 200, noise: 0.1, counter: 1,
    },
    hard: {
      tradeChance: 0.5, auctionBase: 1.0, auctionGroup: 1.3, auctionBlock: 1.22, auctionRich: 1.15,
      theyGet: 1.0, threat: 0.6, margin: 0.1, minMargin: 300, noise: 0.07, counter: 1,
    },
  };
  const lv = (p) => LV[p && LV[p.level] ? p.level : 'normal'];
  const isHard = (p) => p && p.level === 'hard';
  // Vanskelig: grupper vektes etter hvor ofte de treffes (fengselet gjør oransje/rød/gul mest besøkt),
  // ikke bare etter pris. Brukes per krone i propValue og tradeScore.
  const FREQ_W = { lilla: 0.85, lyseblaa: 1.0, rosa: 1.05, oransje: 1.25, rod: 1.15, gul: 1.08, gronn: 0.95, morkeblaa: 0.9 };
  const gw = (p, gr) => (isHard(p) && gr && FREQ_W[gr]) || 1;
  // Det mottakeren betaler banken straks for pantsatte eiendommer (rente, eller innløsning ved «Innløs straks»).
  const bankCost = (g, props, um) => props.reduce((s, i) => {
    if (!g.s.props[i].mortgaged) return s;
    return s + ((um || []).includes(i) ? g.unmortgageCost(i) : interestOf(g, i));
  }, 0);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function others(g, p) { return g.active.filter((o) => o !== p); }

  // Samme tilfeldige faktor gjennom én beslutning (f.eks. hele auksjonen), ikke ny for hvert bud.
  function memoNoise(g, key, amp) {
    const m = g.aiNoise = g.aiNoise || new Map();
    if (!m.has(key)) {
      if (m.size > 400) m.clear();
      m.set(key, jitter(amp));
    }
    return m.get(key);
  }

  // Runder siden en fargegruppe sist ble komplett → 0..1. Brukes for å løse opp et brett som står stille.
  function stall(g) {
    const since = g.s.turn - (g.s.lastSetTurn || 1);
    if (g.s.turn < 10) return 0;
    return Math.max(0, Math.min(1, (since - 6) / 14));
  }

  // Hvor mye en motspiller kan kreve av oss i verste fall (brukes for å holde en buffer).
  function reserve(g, p) {
    let worst = 0;
    for (const i of Object.keys(g.s.props).map(Number)) {
      const o = g.ownerOf(i);
      if (!o || o === p) continue;
      worst = Math.max(worst, g.rentFor(i, 7));
    }
    const early = g.s.turn < 4 ? 600 : 1500;
    return Math.min(9000, Math.max(early, worst * 0.6));
  }

  // Ville spilleren eid hele gruppen hvis den også fikk `extra` (og mistet `minus`)?
  function wouldComplete(g, p, group, extra = [], minus = []) {
    return GIDX[group].every((j) => (g.s.props[j].owner === p.id && !minus.includes(j)) || extra.includes(j));
  }

  function propValue(g, p, i) {
    const sq = SQUARES[i];
    let v = sq.price;
    if (sq.type === 'street') {
      v *= gw(p, sq.group);
      if (wouldComplete(g, p, sq.group, [i])) v *= 2.1;
      else if (others(g, p).some((o) => wouldComplete(g, o, sq.group, [i]))) v *= 1.5;
      else if (GIDX[sq.group].some((j) => g.s.props[j].owner === p.id)) v *= 1.3;
    } else if (sq.type === 'station') {
      v *= 1 + 0.3 * g.countOwned(p, MP.STATIONS);
    } else v *= g.countOwned(p, MP.UTILITIES) ? 1.1 : 0.85;
    return v;
  }

  // Hvor godt er det å havne på felt i (brukes ved fartsterningens buss og tre like)?
  function squareScore(g, p, i, passGo) {
    const sq = SQUARES[i];
    let s = passGo ? RULES.salary : 0;
    if (isOwnable(i)) {
      const pr = g.s.props[i], o = g.ownerOf(i);
      if (!o) s += p.cash - sq.price >= reserve(g, p) * 0.3 ? propValue(g, p, i) - sq.price * 0.7 : 0;
      else if (o !== p && !pr.mortgaged && !(o.inJail && g.rules.noJailRent)) s -= g.rentFor(i, 7);
    } else if (sq.type === 'tax') s -= sq.amount;
    else if (sq.type === 'gotojail') s -= 3000;
    else if (sq.type === 'parking') s += g.s.opts.parkingPot ? g.s.pot || 0 : 0;
    else if (sq.type === 'go') s += 200;
    return s;
  }

  // Verdien av en handel sett fra p (som får `inc` og gir `out`), med motparten `other`.
  // umIn: mottatte pantsatte eiendommer p innløser straks (betaler pantelån + 10 % nå, eier dem fullt).
  function tradeScore(g, p, other, inc, out, cashIn, cashOut, jailIn, jailOut, umIn = []) {
    const L = lv(p), st = stall(g);
    const w = (i) => (SQUARES[i].type === 'street' ? gw(p, SQUARES[i].group) : 1);
    // Egenkapital: pantsatt ≈ pris minus lån og renter; innløst straks = pris minus innløsningen.
    const worthIn = (i) => w(i) * (g.s.props[i].mortgaged
      ? (umIn.includes(i) ? SQUARES[i].price - g.unmortgageCost(i) : SQUARES[i].price * 0.4)
      : SQUARES[i].price);
    const worthOut = (i) => w(i) * (g.s.props[i].mortgaged ? SQUARES[i].price * 0.45 : SQUARES[i].price);
    let gain = cashIn + jailIn * 500 + inc.reduce((s, i) => s + worthIn(i), 0);
    let loss = cashOut + jailOut * 500 + out.reduce((s, i) => s + worthOut(i), 0);
    const groups = [...new Set([...inc, ...out].map((i) => SQUARES[i].group).filter(Boolean))];
    const iGetAny = groups.some((gr) => !g.ownsGroup(p, gr) && wouldComplete(g, p, gr, inc, out));
    for (const gr of groups) {
      const tot = groupTotal(gr) * gw(p, gr), idx = GIDX[gr];
      const iHad = g.ownsGroup(p, gr), iGet = wouldComplete(g, p, gr, inc, out);
      const theyHad = g.ownsGroup(other, gr), theyGet = wouldComplete(g, other, gr, out, inc);
      if (iGet && !iHad) gain += tot * 1.2;
      if (iHad && !iGet) loss += tot * 2;
      if (theyGet && !theyHad) {
        // Bytte der begge får en gruppe er greit; å gi bort en gruppe alene er dyrt.
        let pen = tot * L.theyGet * (iGetAny ? 0.7 : 1);
        if (isHard(p)) pen *= 1 + Math.min(1, other.cash / 30000) * 0.4; // har de penger til å bygge?
        loss += pen * (1 - 0.5 * st);
      } else if (!theyGet) {
        // Trussel: motparten kommer nærmere gruppen (f.eks. kjøp i to steg).
        const theirs = (j) => (g.s.props[j].owner === other.id && !inc.includes(j)) || out.includes(j);
        const before = idx.filter((j) => g.s.props[j].owner === other.id).length;
        const after = idx.filter(theirs).length;
        if (after > before) {
          if (after === idx.length - 1) {
            const rest = idx.find((j) => !theirs(j));
            const restMine = inc.includes(rest) || (g.s.props[rest].owner === p.id && !out.includes(rest));
            loss += tot * L.threat * (restMine ? 0.5 : 1) * (1 - 0.5 * st);
          } else loss += tot * L.threat * 0.2;
        }
      }
    }
    return { gain, loss };
  }

  const AI = {
    reserve,
    stall,

    wantsToBuy(g, p, i) {
      const sq = SQUARES[i];
      const left = p.cash - sq.price;
      if (left < 0) return false;
      const res = reserve(g, p);
      if (p.level === 'easy') return Math.random() < 0.6 && left >= res * 0.7;
      const v = propValue(g, p, i);
      if (v > sq.price * 1.4) return left >= res * 0.3;
      if (isHard(p) && v > sq.price * 1.2) return left >= res * 0.6;
      return left >= res * jitter(0.1);
    },

    // Byr opp mot reell verdi, så «alltid auksjon» ikke lønner seg.
    auctionBid(g, p, i, high) {
      const sq = SQUARES[i], L = lv(p);
      const res = reserve(g, p);
      const street = sq.type === 'street';
      const completes = street && wouldComplete(g, p, sq.group, [i]);
      const blocks = street && !completes && others(g, p).some((o) => wouldComplete(g, o, sq.group, [i]));
      let mult = L.auctionBase, resK = 0.5;
      if (completes) { mult = L.auctionGroup; resK = 0.15; }
      else if (blocks) { mult = L.auctionBlock; resK = 0.25; }
      else if (street && GIDX[sq.group].some((j) => g.s.props[j].owner === p.id)) mult = (L.auctionBase + L.auctionBlock) / 2;
      else if (sq.type === 'station') mult *= 1 + 0.12 * g.countOwned(p, MP.STATIONS);
      else if (sq.type === 'utility') mult *= g.countOwned(p, MP.UTILITIES) ? 1.05 : 0.85;
      // Har man god råd, byr man over pris også ellers.
      if (!completes && !blocks && p.cash - res > sq.price * 2.5) mult = Math.max(mult, L.auctionRich);
      const nz = memoNoise(g, `a:${g.s.turn}:${i}:${p.id}`, L.noise);
      const limit = Math.min(sq.price * mult * nz, p.cash - res * resK);
      const step = Math.max(100, round100(sq.price * 0.05));
      let bid = high === 0 ? round100(sq.price * 0.5) : high + step;
      if (bid > limit && high + 100 <= limit) bid = high + 100;
      return bid <= limit && bid <= p.cash ? bid : 0;
    },

    jailChoice(g, p) {
      const unowned = Object.values(g.s.props).filter((pr) => pr.owner == null).length;
      const dangerous = reserve(g, p) > 4000;
      // Tidlig i spillet vil man ut og kjøpe; sent i spillet er fengselet trygt.
      if (unowned > 6 && !dangerous) {
        if (p.jailCards.length) return 'card';
        if (p.cash > 1000 + reserve(g, p) * 0.5) return 'pay';
      }
      if (p.level === 'easy' && p.cash > 4000 && Math.random() < 0.5) return 'pay';
      return 'roll';
    },

    // Husregel «Start og flytting»: Sjanse er valgfri. Kortene er i snitt omtrent nøytrale,
    // men kan koste mye med mange hus – trekk bare når man har god buffer.
    drawChance(g, p) {
      let houses = 0;
      for (const i of g.propsOf(p)) houses += g.s.props[i].houses;
      return p.cash > reserve(g, p) * 0.8 && houses < 6;
    },

    // Husregel «Start og flytting»: datamaskinen tar alltid pengene.
    goChoice() { return { type: 'cash' }; },

    // Fartsterning, tre like: velg det beste feltet å flytte til.
    speedChoice(g, p) {
      let best = p.pos, bestScore = -Infinity;
      for (let i = 0; i < 40; i++) {
        if (SQUARES[i].type === 'gotojail') continue;
        const sc = squareScore(g, p, i, i < p.pos) + Math.random();
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      return best;
    },
    // Fartsterning, buss: velg terning 1, terning 2 eller summen.
    busChoice(g, p, opts) {
      let best = opts[opts.length - 1], bestScore = -Infinity;
      for (const n of opts) {
        const sc = squareScore(g, p, (p.pos + n) % 40, p.pos + n >= 40);
        if (sc > bestScore) { bestScore = sc; best = n; }
      }
      return best;
    },

    async beforeRoll(g, p) { this.manage(g, p); await this.maybeTrade(g, p); },
    async afterRoll(g, p) { this.manage(g, p); },

    manage(g, p) {
      const easy = p.level === 'easy', hard = isHard(p);
      const res = reserve(g, p) * (easy ? 1.5 : 1);
      const mine = g.propsOf(p);
      // Innløs gater i komplette grupper først, så de kan bebygges.
      for (const i of mine) {
        const sq = SQUARES[i];
        if (g.s.props[i].mortgaged && sq.type === 'street' && (g.rules.freeBuild || g.ownsGroup(p, sq.group)) && p.cash - g.unmortgageCost(i) >= res) g.unmortgage(p, i);
      }
      // Vanskelig: pantsett løse eiendommer for å komme raskt opp i 3 hus på en hel gruppe.
      if (hard && !g.rules.freeBuild) this.fundBuilding(g, p, res);
      const cap = easy && Math.random() < 0.6 ? 2 : 5;
      // Bygg jevnt, beste gruppe først (høyest leieøkning per krone).
      for (let guard = 0; guard < 60; guard++) {
        let best = null, bestScore = 0, bestHotel = false;
        for (const i of mine) {
          const pr = g.s.props[i], rent = SQUARES[i].rent;
          if (SQUARES[i].type !== 'street') continue;
          const need = hard && pr.houses < 3 ? res * 0.6 : res;
          const whole = g.ownsGroup(p, SQUARES[i].group);
          const base = pr.houses ? rent[pr.houses] : rent[0] * (whole ? 2 : 1);
          const c = g.canBuild(p, i);
          // Fri bygging: bygg helst der man eier hele gruppen, ellers bare med god margin.
          const freeOk = (cost) => !g.rules.freeBuild || whole || p.cash - cost >= res * 2;
          if (c.ok && p.cash - c.cost >= need && pr.houses < cap && freeOk(c.cost)) {
            const score = (rent[pr.houses + 1] - base) / c.cost + (pr.houses < 3 ? 1 : 0);
            if (score > bestScore) { bestScore = score; best = i; bestHotel = false; }
          }
          // Fri bygging (Plus): hotell rett på gaten når det lønner seg – særlig når banken mangler hus.
          if (g.rules.freeBuild && cap >= 5 && pr.houses < 4) {
            const h = g.canBuildHotel(p, i);
            if (h.ok && p.cash - h.cost >= res && freeOk(h.cost)) {
              const short = g.s.housesLeft < 5 - pr.houses;
              const score = (rent[5] - base) / h.cost + (short ? 1.5 : 0.9);
              if (score > bestScore) { bestScore = score; best = i; bestHotel = true; }
            }
          }
        }
        if (best == null) break;
        if (bestHotel) g.buildHotel(p, best); else g.build(p, best);
      }
      // Overskudd: innløs resten.
      for (const i of mine) {
        if (g.s.props[i].mortgaged && p.cash - g.unmortgageCost(i) >= res * 2) g.unmortgage(p, i);
      }
    },

    fundBuilding(g, p, res) {
      const groups = GROUP_KEYS.filter((gr) => g.ownsGroup(p, gr) && GIDX[gr].every((j) => !g.s.props[j].mortgaged)
        && Math.min(...GIDX[gr].map((j) => g.s.props[j].houses)) < 3);
      if (!groups.length || g.s.housesLeft < 2) return;
      // Det som trengs for å nå 3 hus i den billigste gruppen.
      const cost = Math.min(...groups.map((gr) => GIDX[gr].reduce((s, j) => s + Math.max(0, 3 - g.s.props[j].houses) * GROUPS[gr].house, 0)));
      const loose = g.propsOf(p).filter((i) => {
        const sq = SQUARES[i];
        return !g.s.props[i].mortgaged && g.canMortgage(p, i).ok && !(sq.type === 'street' && g.ownsGroup(p, sq.group));
      }).sort((a, b) => SQUARES[a].price - SQUARES[b].price);
      for (const i of loose) {
        if (p.cash >= res * 0.6 + Math.min(cost, GROUPS[groups[0]].house * 2)) break;
        g.mortgage(p, i);
      }
    },

    raiseFunds(g, p, amount) {
      const mine = () => g.propsOf(p);
      const notInSet = (i) => SQUARES[i].type !== 'street' || !g.ownsGroup(p, SQUARES[i].group);
      const order = (list) => list.sort((a, b) => SQUARES[a].price - SQUARES[b].price);
      // 1) Pantsett løse eiendommer, billigst først.
      for (const i of order(mine().filter(notInSet))) { if (p.cash >= amount) return; g.mortgage(p, i); }
      // 2) Selg hus jevnt, billigste gruppe først.
      for (let guard = 0; guard < 200 && p.cash < amount; guard++) {
        const sellable = order(mine().filter((i) => g.canSellHouse(p, i).ok));
        if (!sellable.length) break;
        g.sellHouse(p, sellable[0]);
      }
      // 3) Pantsett resten.
      for (const i of order(mine())) { if (p.cash >= amount) return; g.mortgage(p, i); }
    },

    // Vurderer en handel der `p` er mottakeren (t.to). Tar med renten på pantsatte eiendommer.
    // Grunnlaget for vurderingen av t sett fra mottakeren p (t.to).
    tradeView(g, p, t) {
      const other = g.player(t.from);
      const inc = (t.give.props || []).map(Number), out = (t.get.props || []).map(Number);
      const umIn = (t.give.unmortgage || []).map(Number);
      const cashIn = t.give.cash || 0, cashOut = t.get.cash || 0;
      const after = p.cash + cashIn - cashOut - bankCost(g, inc, umIn);
      const L = lv(p);
      const { gain, loss } = tradeScore(g, p, other, inc, out, cashIn, cashOut, t.give.jailCards || 0, t.get.jailCards || 0, umIn);
      return { other, inc, out, umIn, cashIn, cashOut, after, gain, loss, need: Math.max(L.minMargin, loss * L.margin) };
    },

    evaluateTrade(g, p, t, exact) {
      const v = this.tradeView(g, p, t);
      if (v.after < 0) return false;
      if (v.cashOut > 0 && v.after < reserve(g, p) * 0.3) return false;
      return v.gain - v.loss >= v.need * (exact ? 1 : jitter(lv(p).noise));
    },

    // Minste ekstra beløp (kr, i tillegg til t.give.cash) som gjør at p (mottakeren) godtar t – også med
    // tilfeldigheten i evaluateTrade (regnet mot øvre grense). null hvis forslagsstilleren ikke har råd.
    minAccept(g, p, t) {
      const other = g.player(t.from);
      if (!p || !other || other.bankrupt || p.bankrupt) return null;
      const v = this.tradeView(g, p, t);
      let x = v.need * (1 + lv(p).noise) - (v.gain - v.loss);
      x = Math.max(x, -v.after);
      if (v.cashOut > 0) x = Math.max(x, reserve(g, p) * 0.3 - v.after);
      x = ceil100(Math.max(x, 1));
      for (let k = 0; k < 30; k++, x += 100) {
        const t2 = clone(t);
        t2.give.cash = (t2.give.cash || 0) + x;
        if (g.tradeIssues(t2)) return null; // forslagsstilleren har ikke så mye (eller ikke råd til renten)
        if (this.evaluateTrade(g, p, t2, true)) return x;
      }
      return null;
    },

    // Kort grunn på norsk når p sier nei til t (vises i UI ved avslag uten motbud).
    declineReason(g, p, t, minCash) {
      const other = g.player(t.from);
      if (!other) return null;
      const inc = (t.give.props || []).map(Number), out = (t.get.props || []).map(Number);
      const gname = (gr) => GROUPS[gr].name.toLowerCase();
      const DEF = { gul: 'gule', rod: 'røde', gronn: 'grønne' }; // bestemt form: «den siste røde gaten»
      const gdef = (gr) => DEF[gr] || gname(gr);
      const iGetAny = [...new Set(inc.map((i) => SQUARES[i].group).filter(Boolean))]
        .some((gr) => !g.ownsGroup(p, gr) && wouldComplete(g, p, gr, inc, out));
      let why = null;
      for (const gr of [...new Set(out.map((i) => SQUARES[i].group).filter(Boolean))]) {
        if (g.ownsGroup(p, gr) && !wouldComplete(g, p, gr, inc, out)) { why = `${p.name} vil ikke bryte opp ${gname(gr)} gruppe`; break; }
        if (!iGetAny && !g.ownsGroup(other, gr) && wouldComplete(g, other, gr, out, inc)) {
          why = `${p.name} gir ikke bort den siste ${gdef(gr)} gaten`; break;
        }
      }
      const more = minCash ? `minst ${MP.kr(minCash)} mer` : null;
      if (why) return more ? `${why} – vil ha ${more}` : why;
      if (more) return `${p.name} vil ha ${more}`;
      const v = this.tradeView(g, p, t);
      if (v.after < 0 || (v.cashOut > 0 && v.after < reserve(g, p) * 0.3)) return `${p.name} har ikke råd til dette`;
      return `${p.name} vil ha mer enn du har råd til`;
    },

    // Motbud når `p` (datamaskinen) sier nei til t: samme handel med penger som dekker det som mangler,
    // eller – når pengene ikke rekker – med en billig, løs eiendom fra forslagsstilleren i tillegg.
    // Returnerer et tilbud med from/to byttet, eller null.
    counterOffer(g, p, t) {
      const L = lv(p);
      if (Math.random() > L.counter) return null;
      const other = g.player(t.from);
      if (!other || other.bankrupt) return null;
      const inc = (t.give.props || []).map(Number), out = (t.get.props || []).map(Number);
      if (!inc.length && !out.length) return null;
      const base = {
        inc, out, cashIn: t.give.cash || 0, cashOut: t.get.cash || 0, jIn: t.give.jailCards || 0, jOut: t.get.jailCards || 0,
        umIn: (t.give.unmortgage || []).map(Number), umOut: (t.get.unmortgage || []).map(Number),
      };
      const netCost = (c, extra) => c.get.cash - c.give.cash + extra; // hva motbudet koster forslagsstilleren
      let best = this.cashCounter(g, p, other, base, false);
      let bestCost = best ? netCost(best, 0) : Infinity;
      // Naturlig å be om en eiendom når pengene ikke rekker, eller kravet er stort i forhold til kassen.
      if (!best || best.get.cash > other.cash * 0.7) {
        const tradeGroups = new Set([...inc, ...out].map((i) => SQUARES[i].group).filter(Boolean));
        const loose = g.propsOf(other).filter((j) => {
          const sq = SQUARES[j];
          if (inc.includes(j) || out.includes(j)) return false;
          if (sq.type !== 'street') return true;
          if (tradeGroups.has(sq.group)) return false; // samme gruppe som handelen: meningsløst bytte
          if (g.ownsGroup(other, sq.group) || g.groupHasBuildings(sq.group)) return false;
          // Ikke-strategisk for dem: de bygger ikke mot gruppen, og den gir ikke oss gruppen.
          if (GIDX[sq.group].filter((i) => g.s.props[i].owner === other.id).length >= 2) return false;
          if (wouldComplete(g, p, sq.group, [...inc, j], out)) return false;
          return true;
        }).sort((a, b) => SQUARES[a].price - SQUARES[b].price).slice(0, 6);
        for (const j of loose) {
          const c = this.cashCounter(g, p, other, { ...base, inc: [...inc, j] }, true);
          if (!c) continue;
          const cost = netCost(c, SQUARES[j].price * (g.s.props[j].mortgaged ? 0.5 : 1));
          // Bare når det er klart billigere for dem enn å betale alt i kontanter.
          if (!best || cost < bestCost - Math.abs(bestCost) * 0.15) { best = c; bestCost = cost; }
        }
      }
      return best;
    },

    // Hjelper for counterOffer: juster kontantene så handelen (med o.inc/o.out) holder for p.
    // added = en eiendom er lagt til; da kan p gi tilbake noe av overskuddet.
    cashCounter(g, p, other, o, added) {
      const L = lv(p);
      let { cashIn, cashOut } = o;
      const myCost = bankCost(g, o.inc, o.umIn), theirCost = bankCost(g, o.out, o.umOut);
      // Det vi har råd til å betale.
      const canPay = Math.max(0, Math.floor((p.cash - myCost - reserve(g, p) * 0.3) / 100) * 100);
      if (cashOut > canPay) cashOut = canPay;
      const { gain, loss } = tradeScore(g, p, other, o.inc, o.out, cashIn, cashOut, o.jIn, o.jOut, o.umIn);
      const need = Math.max(L.minMargin, loss * L.margin);
      const diff = need - (gain - loss);
      if (diff > 0 || !added) {
        const ask = ceil100(Math.max(100, diff) * 1.04);
        const fromOurs = Math.min(cashOut, ask);
        cashOut -= fromOurs;
        cashIn += ask - fromOurs;
      } else {
        // Overskudd etter at eiendommen er lagt til: del halvparten tilbake (mindre krav, ev. penger fra oss).
        let back = Math.floor(-diff * 0.5 / 100) * 100;
        const less = Math.min(cashIn, back); cashIn -= less; back -= less;
        cashOut = Math.min(canPay, cashOut + back);
      }
      if (cashIn > other.cash || other.cash - cashIn + cashOut - theirCost < 0) return null;
      const counter = {
        from: p.id, to: other.id,
        give: { props: o.out.slice(), cash: cashOut, jailCards: o.jOut, unmortgage: o.umOut.slice() },
        get: { props: o.inc.slice(), cash: cashIn, jailCards: o.jIn, unmortgage: o.umIn.slice() },
      };
      if (g.tradeIssues(counter)) return null;
      // Kontroll: motbudet må være godt nok for oss selv.
      const back = { from: other.id, to: p.id, give: counter.get, get: counter.give };
      return this.evaluateTrade(g, p, back, true) ? counter : null;
    },

    // Idéer til handel: fullfør egen gruppe (kjøp eller bytte der begge får en gruppe), og når brettet
    // står stille, også steg mot en gruppe. Tilbudene varierer og øker for hvert nytt forsøk.
    async maybeTrade(g, p) {
      const L = lv(p), st = stall(g);
      if (Math.random() > L.tradeChance + st * 0.45) return;
      g.aiMemo = g.aiMemo || {};
      const ideas = [];
      for (const gr of GROUP_KEYS) {
        if (g.groupHasBuildings(gr)) continue;
        const idx = GIDX[gr];
        const missing = idx.filter((j) => g.s.props[j].owner !== p.id);
        const mineN = idx.length - missing.length;
        if (!missing.length || !mineN) continue;
        if (missing.some((j) => g.s.props[j].owner == null)) continue; // en ledig gate: vent på å lande der
        const owners = [...new Set(missing.map((j) => g.s.props[j].owner))];
        if (owners.length === 1) ideas.push({ gr, targets: missing, owner: owners[0], kind: 'complete', w: 2 + Math.random() });
        else if (st > 0) {
          // Stillstand: kjøp én motparts andel slik at bare én eier gjenstår.
          for (const o of owners) {
            const theirs = missing.filter((j) => g.s.props[j].owner === o);
            if (missing.length - theirs.length >= 1) ideas.push({ gr, targets: theirs, owner: o, kind: 'step', w: Math.random() });
          }
        }
      }
      ideas.sort((a, b) => b.w - a.w);
      for (const idea of ideas.slice(0, 3)) {
        const owner = g.player(idea.owner);
        if (!owner || owner.bankrupt || owner === p) continue;
        // Felles pause for tilbud til samme menneske (fra alle datamaskiner).
        const hk = `human:${owner.id}`;
        if (!owner.ai && (g.aiMemo[hk] || 0) > g.s.turn) continue;
        const key = `${p.id}:${idea.targets.join(',')}`;
        const memo = g.aiMemo[key] || { next: 0, tries: 0 };
        if (g.s.turn < memo.next) continue;
        memo.tries++;
        // Mennesker skal ikke mases på: lengre pause mellom tilbudene til dem.
        memo.next = g.s.turn + (owner.ai ? 2 + Math.floor(Math.random() * 4) : 4 + Math.floor(Math.random() * 5));
        g.aiMemo[key] = memo;
        const t = this.buildOffer(g, p, owner, idea, memo.tries);
        if (!t || g.tradeIssues(t)) continue;
        this.addUnmortgage(g, p, t);
        if (g.tradeIssues(t)) t.get.unmortgage = [];
        const what = t.give.props.length
          ? `bytte ${t.give.props.map((i) => SQUARES[i].name).join(' og ')} mot ${t.get.props.map((i) => SQUARES[i].name).join(' og ')}`
          : `kjøpe ${t.get.props.map((i) => SQUARES[i].name).join(' og ')} for ${MP.kr(t.give.cash)}`;
        if (!owner.ai) g.aiMemo[hk] = g.s.turn + 3 + Math.floor(Math.random() * 3);
        g.log(`${p.name} vil ${what} med ${owner.name}.`, 'trade');
        await g.proposeTrade(t);
        return;
      }
    },

    // «Innløs straks»: får datamaskinen pantsatte gater som fullfører en gruppe, innløser den dem
    // med en gang når kassen tåler det (sparer den ekstra renten og kan bygge raskere).
    addUnmortgage(g, p, t) {
      const get = t.get.props || [], give = t.give.props || [];
      const m = get.filter((i) => g.s.props[i].mortgaged && SQUARES[i].type === 'street' && wouldComplete(g, p, SQUARES[i].group, get, give));
      if (!m.length) return t;
      const left = p.cash - (t.give.cash || 0) + (t.get.cash || 0) - bankCost(g, get, m);
      if (left >= reserve(g, p) * 0.8) t.get.unmortgage = m;
      return t;
    },

    buildOffer(g, p, owner, idea, tries) {
      const L = lv(p), st = stall(g), res = reserve(g, p);
      const { gr, targets } = idea;
      const base = targets.reduce((s, j) => s + SQUARES[j].price, 0);
      const tot = groupTotal(gr);
      const keep = isHard(p) ? Math.max(res * 0.5, GROUPS[gr].house * GIDX[gr].length) : res * 0.5;
      const maxPay = Math.floor((p.cash - keep) / 100) * 100;
      // 1) Bytte der motparten også fullfører en gruppe (også 2-mot-1), med mellomlegg.
      if (idea.kind === 'complete') {
        for (const gy of shuffle(GROUP_KEYS.slice())) {
          if (gy === gr || g.groupHasBuildings(gy)) continue;
          const need = GIDX[gy].filter((j) => g.s.props[j].owner !== owner.id);
          if (!need.length || need.length > 2 || !need.every((j) => g.s.props[j].owner === p.id)) continue;
          // Mellomlegget varierer og blir rausere for hvert nytt forsøk.
          const more = Math.min(tries - 1, 4) * 0.15;
          const diff = (base - need.reduce((s, j) => s + SQUARES[j].price, 0)) + (tot - groupTotal(gy)) * 0.5;
          const give = { props: need, cash: 0, jailCards: 0 }, get = { props: targets.slice(), cash: 0, jailCards: 0 };
          if (diff > 0) give.cash = Math.max(0, Math.min(round100(diff * (1 + more) * jitter(0.15)), maxPay));
          else if (diff * (1 - more * 1.5) < -400) get.cash = Math.min(round100(-diff * 0.5 * (1 - more * 1.5) * jitter(0.15)), Math.floor(owner.cash / 100) * 100);
          else if (tries > 2 && maxPay >= 100) give.cash = Math.min(round100(base * 0.1 * tries * jitter(0.2)), maxPay);
          return { from: p.id, to: owner.id, give, get };
        }
      }
      // 2) Kontanttilbud som varierer og øker for hvert forsøk.
      const esc = Math.min(tries - 1, 4) * 0.12 + st * 0.3;
      let offer;
      if (idea.kind === 'complete') {
        const lvlK = p.level === 'easy' ? 0.45 : isHard(p) ? 0.7 : 0.6;
        offer = base * 1.1 + tot * (lvlK + esc) * jitter(0.12);
      } else {
        offer = base * (1.25 + esc) * jitter(0.1);
      }
      offer = Math.min(round100(offer), maxPay);
      if (offer < base) return null;
      return { from: p.id, to: owner.id, give: { props: [], cash: offer, jailCards: 0 }, get: { props: targets.slice(), cash: 0, jailCards: 0 } };
    },
  };

  MP.AI = AI;
})(typeof window !== 'undefined' ? window : globalThis);

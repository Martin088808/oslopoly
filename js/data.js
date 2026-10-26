// Brettdata for den norske Oslo-utgaven.
// Gater, rekkefølge og priser følger det norske brettet (kr = originalens dollar × 20).
(function (root) {
  'use strict';

  const GROUPS = {
    lilla:     { name: 'Lilla',     color: '#7B2F8E', house: 1000 },
    lyseblaa:  { name: 'Lyseblå',   color: '#8FD3F5', house: 1000 },
    rosa:      { name: 'Rosa',      color: '#E0368F', house: 2000 },
    oransje:   { name: 'Oransje',   color: '#F7941D', house: 2000 },
    rod:       { name: 'Rød',       color: '#E3242B', house: 3000 },
    gul:       { name: 'Gul',       color: '#FFE21F', house: 3000 },
    gronn:     { name: 'Grønn',     color: '#1FAF55', house: 4000 },
    morkeblaa: { name: 'Mørkeblå',  color: '#1D4FB8', house: 4000 },
  };

  // rent: [ubebygd, 1 hus, 2 hus, 3 hus, 4 hus, hotell]
  const st = (name, group, price, rent) => ({ type: 'street', name, group, price, rent });
  const rail = (name) => ({ type: 'station', name, price: 4000 });
  const util = (name, icon) => ({ type: 'utility', name, price: 3000, icon });

  const SQUARES = [
    { type: 'go', name: 'Start' },
    st('Parkveien', 'lilla', 1200, [40, 200, 600, 1800, 3200, 5000]),
    { type: 'chest', name: 'Prøv lykken' },
    st('Kirkeveien', 'lilla', 1200, [80, 400, 1200, 3600, 6400, 9000]),
    { type: 'tax', name: 'Inntektsskatt', amount: 4000 },
    rail('Oslo S'),
    st('Kongens gate', 'lyseblaa', 2000, [120, 600, 1800, 5400, 8000, 11000]),
    { type: 'chance', name: 'Sjanse' },
    st('Prinsens gate', 'lyseblaa', 2000, [120, 600, 1800, 5400, 8000, 11000]),
    st('Øvre Slottsgate', 'lyseblaa', 2400, [160, 800, 2000, 6000, 9000, 12000]),
    { type: 'jail', name: 'Fengsel' },
    st('Nedre Slottsgate', 'rosa', 2800, [200, 1000, 3000, 9000, 12500, 15000]),
    util('Oslo Lysverker', 'bulb'),
    st('Trondheimsveien', 'rosa', 2800, [200, 1000, 3000, 9000, 12500, 15000]),
    st('Nobels gate', 'rosa', 3200, [240, 1200, 3600, 10000, 14000, 18000]),
    rail('Skøyen stasjon'),
    st('Grensen', 'oransje', 3600, [280, 1400, 4000, 11000, 15000, 19000]),
    { type: 'chest', name: 'Prøv lykken' },
    st('Gabels gate', 'oransje', 3600, [280, 1400, 4000, 11000, 15000, 19000]),
    st('Ringgata', 'oransje', 4000, [320, 1600, 4400, 12000, 16000, 20000]),
    { type: 'parking', name: 'Gratis parkering' },
    st('Bygdøy allé', 'rod', 4400, [360, 1800, 5000, 14000, 17500, 21000]),
    { type: 'chance', name: 'Sjanse' },
    st('Skarpsno', 'rod', 4400, [360, 1800, 5000, 14000, 17500, 21000]),
    st('Slemdal', 'rod', 4800, [400, 2000, 6000, 15000, 18500, 22000]),
    rail('Bryn stasjon'),
    st('Karl Johans gate', 'gul', 5200, [440, 2200, 6600, 16000, 19500, 23000]),
    st('Stortorvet', 'gul', 5200, [440, 2200, 6600, 16000, 19500, 23000]),
    util('Vannverket', 'tap'),
    st('Torggata', 'gul', 5600, [480, 2400, 7200, 17000, 20500, 24000]),
    { type: 'gotojail', name: 'De settes i fengsel' },
    st('Trosterudveien', 'gronn', 6000, [520, 2600, 7800, 18000, 22000, 25500]),
    st('Pilestredet', 'gronn', 6000, [520, 2600, 7800, 18000, 22000, 25500]),
    { type: 'chest', name: 'Prøv lykken' },
    st('Sinsen', 'gronn', 6400, [560, 3000, 9000, 20000, 24000, 28000]),
    rail('Grorud stasjon'),
    { type: 'chance', name: 'Sjanse' },
    st('Ullevål Hageby', 'morkeblaa', 7000, [700, 3500, 10000, 22000, 26000, 30000]),
    { type: 'tax', name: 'Luksusskatt', amount: 2000 },
    st('Rådhusplassen', 'morkeblaa', 8000, [1000, 4000, 12000, 28000, 34000, 40000]),
  ];
  SQUARES.forEach((s, i) => { s.index = i; });

  const STATION_RENT = [0, 500, 1000, 2000, 4000];
  // Verk: øyne × 4 / × 10 i originalen, ganget med 20 som resten av beløpene.
  const UTILITY_MULT = [0, 80, 200];

  const RULES = {
    salary: 4000,
    startMoney: 30000,
    jailFine: 1000,
    houses: 32,
    hotels: 12,
    mortgageInterest: 0.10,
  };

  // Kortene: handling + norsk tekst. Beløp i kr.
  const CHANCE = [
    { text: 'Gå til Rådhusplassen.', act: 'move', to: 39 },
    { text: 'Gå til Start. Motta kr 4 000.', act: 'move', to: 0 },
    { text: 'Ta en tur til Slemdal. Passerer De Start, mottar De kr 4 000.', act: 'move', to: 24 },
    { text: 'Gå til Nedre Slottsgate. Passerer De Start, mottar De kr 4 000.', act: 'move', to: 11 },
    { text: 'Gå til nærmeste stasjon. Er den eid, betaler De eieren dobbel leie. Er den ledig, kan De kjøpe den.', act: 'nearestStation' },
    { text: 'Gå til nærmeste stasjon. Er den eid, betaler De eieren dobbel leie. Er den ledig, kan De kjøpe den.', act: 'nearestStation' },
    { text: 'Gå til nærmeste verk. Er det eid, kast terningene og betal eieren kr 200 per øye.', act: 'nearestUtility' },
    { text: 'Banken betaler Dem utbytte på kr 1 000.', act: 'money', amount: 1000 },
    { text: 'De kommer ut av fengselet. Kortet kan beholdes til det trengs eller selges.', act: 'jailCard' },
    { text: 'Gå tre felt tilbake.', act: 'back', steps: 3 },
    { text: 'De settes i fengsel. Gå direkte i fengsel uten å passere Start.', act: 'jail' },
    { text: 'Vedlikehold av eiendommene Deres: betal kr 500 per hus og kr 2 000 per hotell.', act: 'repairs', house: 500, hotel: 2000 },
    { text: 'Fartsbot: betal kr 300.', act: 'money', amount: -300 },
    { text: 'Ta en tur til Oslo S. Passerer De Start, mottar De kr 4 000.', act: 'move', to: 5 },
    { text: 'De er valgt til styreformann. Betal hver spiller kr 1 000.', act: 'payEach', amount: 1000 },
    { text: 'Byggelånet Deres forfaller. Motta kr 3 000.', act: 'money', amount: 3000 },
  ];

  const CHEST = [
    { text: 'Gå til Start. Motta kr 4 000.', act: 'move', to: 0 },
    { text: 'Feil i banken i Deres favør. Motta kr 4 000.', act: 'money', amount: 4000 },
    { text: 'Legeregning: betal kr 1 000.', act: 'money', amount: -1000 },
    { text: 'De har solgt aksjer og får kr 1 000.', act: 'money', amount: 1000 },
    { text: 'De kommer ut av fengselet. Kortet kan beholdes til det trengs eller selges.', act: 'jailCard' },
    { text: 'De settes i fengsel. Gå direkte i fengsel uten å passere Start.', act: 'jail' },
    { text: 'Feriepengene utbetales. Motta kr 2 000.', act: 'money', amount: 2000 },
    { text: 'Tilbakebetalt skatt. Motta kr 400.', act: 'money', amount: 400 },
    { text: 'Det er Deres bursdag! Motta kr 200 fra hver spiller.', act: 'collectEach', amount: 200 },
    { text: 'Livsforsikringen forfaller. Motta kr 2 000.', act: 'money', amount: 2000 },
    { text: 'Sykehusregning: betal kr 2 000.', act: 'money', amount: -2000 },
    { text: 'Skolepenger: betal kr 1 000.', act: 'money', amount: -1000 },
    { text: 'Konsulenthonorar. Motta kr 500.', act: 'money', amount: 500 },
    { text: 'Gateoppussing: betal kr 800 per hus og kr 2 300 per hotell.', act: 'repairs', house: 800, hotel: 2300 },
    { text: 'De vant andrepremien i en skjønnhetskonkurranse. Motta kr 200.', act: 'money', amount: 200 },
    { text: 'De arver kr 2 000.', act: 'money', amount: 2000 },
  ];

  const TOKENS = [
    { id: 'car', name: 'Bil' },
    { id: 'hat', name: 'Flosshatt' },
    { id: 'ship', name: 'Skip' },
    { id: 'boot', name: 'Støvel' },
    { id: 'dog', name: 'Hund' },
    { id: 'thimble', name: 'Fingerbøl' },
  ];

  const PLAYER_COLORS = ['#E63946', '#1E88E5', '#2BB673', '#FFB000', '#9C4DDB', '#FF6FB5'];

  root.MP = root.MP || {};
  Object.assign(root.MP, { GROUPS, SQUARES, STATION_RENT, UTILITY_MULT, RULES, CHANCE, CHEST, TOKENS, PLAYER_COLORS });
})(typeof window !== 'undefined' ? window : globalThis);

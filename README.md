# Oslopoly

Et 3D-eiendomsspill med Oslo-brett, laget i nettleseren med Three.js. Du kan spille mot datamaskiner, med venner på samme skjerm, eller online der hver spiller sitter på sin egen skjerm.

## Spill

- **Online:** velg «Spill online» → «Lag rom», og send lenken eller koden til vennene dine.
- **På samme skjerm:** velg «Spill Oslopoly», og legg til mennesker og datamaskiner.

## Innhold

- 2–6 spillere. Datamaskinene finnes i nivåene Lett, Normal og Vanskelig.
- 3D-brett midt i et levende miniatyr-Oslo, med trafikk, fjord og landemerker.
  - Hver eiendom har en tomt i byen, der et bygg vokser med husene.
- Detaljerte sølvbrikker: bil, flosshatt, skip, støvel, hund og fingerbøl.
- Animasjoner:
  - brikkene hopper eller kjører, og kameraet følger dem
  - terninger, mynter, «SOLGT!»-skilt, byggeplasser og fyrverkeri
- Husregler som kan kombineres:
  - Gratis parkering-potten
  - Start og flytting
  - Slangeøyne
  - Leie og auksjon
  - Rikdomsregelen
  - Fri bygging
  - Fartsterning
- Handel med motbud, auksjoner, pantsetting, brettkart med bankinfo og automatisk lagring.

## Kontroller

| Tast | Gjør |
|---|---|
| Mellomrom | Kast terningene / avslutt turen |
| E | Mine eiendommer |
| M | Brettkart |
| H | Handel |
| S | Hopp over animasjoner |
| Esc | Lukk vinduet |

Dra for å rotere kameraet og scroll for å zoome.

## Kjøre lokalt

Kjør `python serve.py 8791` og åpne http://127.0.0.1:8791/. Online-spill bruker en offentlig MQTT-megler, så det trengs internett.

## Filer

| Fil | Innhold |
|---|---|
| `js/engine.js` | reglene |
| `js/ai.js` | datamotstanderne |
| `js/net.js` | online-flerspiller |
| `js/board3d.js` | 3D-brettet, animasjoner og kamera |
| `js/boardtex.js` | brettflaten |
| `js/tokens3d.js` | brikkene |
| `js/city3d.js` | byen |
| `js/postfx.js` | etterbehandling |
| `js/ui.js` + `css/style.css` | grensesnittet |
| `js/sound.js` | lyd |

Oslopoly er et uavhengig hobbyprosjekt.

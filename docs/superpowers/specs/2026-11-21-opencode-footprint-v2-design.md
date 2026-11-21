# opencode-footprint (fork scesbron) — migration V2, méthodologie par type de token, facteurs GLM/Kimi

Design du 2026-11-21, révisé après le pivot « fork complet, V2 uniquement ». Trois
phases sur le fork `scesbron/opencode-footprint` (clone : `~/dev/opencode-footprint`).
Taille : projet.

## Intention et pourquoi

L'utilisateur veut dans OpenCode V2 (desktop) un suivi d'empreinte CO₂ de ses sessions
équivalent à ce que claude-carbon apporte à Claude Code : consommation mesurée,
émissions estimées, historique. Le cadrage initial visait la contribution amont ;
confronté au coût de socialisation (la méthodo change tous les chiffres pour les
utilisateurs existants d'un dépôt tiers), l'utilisateur a arbitré : **fork complet,
V2 uniquement**, parce que sa priorité est d'expérimenter librement les calculs pour
vérifier que l'outil lui convient.

Conséquences assumées :

- L' experimentation est le critère d'optimisation : les facteurs vivent dans un
  fichier de données éditable, pas dans le code.
- Le retour amont reste possible plus tard, au cas par cas (la migration V2 en
  premier candidat) ; on garde pour ça l'hygiène d'un dépôt amont : anglais,
  Conventional Commits, CHANGELOG, tests verts.
- Les trois défauts d'origine motivent toujours les trois phases : plugin V1-only,
  modèle CO₂ à tarif unique par palier (cache reads plein tarif, output sous-facturé),
  familles GLM/Kimi absentes de la classification.

## Objectifs

- **Phase 1 — migration V2-only** : le plugin charge dans OpenCode V2 (celui de
  l'utilisateur, 2.3.1) en plugin-paquet local auto-découvert, sans `tui.json`, sans
  entrypoint V1. Aucun chiffre ne change : golden vectors d'avant identiques.
- **Phase 2 — méthodologie par type de token** : formule à trois termes
  ((input+cacheWrite)×f_in + cacheRead×f_in×0,08 + (output+reasoning)×f_out),
  facteurs Wh/Mtok PUE-inclus par famille avec repli sur paliers, le tout dans un
  `factors.json` éditable ; recalibrage des notes éco ; METHODOLOGY.md sourcé ;
  équivalents réparés. Crédit méthodologique explicite à claude-carbon (MIT,
  gwittebolle).
- **Phase 3 — facteurs GLM et Kimi** (empilée sur la phase 2) : `glm-5.3`,
  `glm-5.3-flash`, `kimi-k3.1-pro`, par extrapolation documentée (Jegham v6 ne couvre
  ni GLM ni Moonshot).

Décisions arbitrées avec l'utilisateur :

- Fork complet, V2 uniquement (pas de dual V1+V2).
- Ordre méthodo puis modèles.
- Validation une fois par phase : messages de commit proposés en bloc, « ok », puis
  commit/push.

## Non-objectifs

- PRs amont comme véhicule de livraison (possibles plus tard, au cas par cas).
- Panneau GUI desktop (équivalent `/carbon-panel`) : candidate phase 4.
- Jeux d'équivalences par locale ; intensité réseau temps réel ; `/carbon-pr`,
  cartes PNG, badges ; table de prix API (le coût reste celui que l'hôte rapporte).
- Publication npm (`opencode plugin add`) : plus tard, si le mainteneur ou
  l'utilisateur le veut.

## Contraintes

- Hygiène fork = hygiène amont : anglais, Conventional Commits sans attribution IA,
  CHANGELOG.md tenu, CI verte (typecheck `tsc --noEmit`, tests `node --test` +
  `bun test`).
- Une validation de l'utilisateur avant les commits de chaque phase.
- La phase 1 ne change aucun chiffre ; la phase 2 les change de façon importante et
  le avant/après doit être quantifié (golden vectors), pas subi.
- `green-claude` sera invoquée avant l'écriture du code d'implémentation (règle
  globale), TDD appliqué (phases 2 et 3 surtout).
- Runtime cible : OpenCode 2.3.1 (desktop de l'utilisateur) ; « tested with 2.3.1 »
  daté dans le README, la note vieillira sur un canal auto-update, assumé.

## Approches considérées

**Migration :**
- *Réécriture V2-only en plugin-paquet unique* (retenu) : l'utilisateur n'a pas de V1,
  le conflit `@opentui` 0.4.5 (V1) contre génération V2 disparaît, le layout devient
  le propre état final qu'un paquet publié exigerait de toute façon.
- *Dual V1+V2* (écarté) : n'existait que pour l'amont ; garde le pin V1, le risque
  runtime TUI et la charge de test d'un hôte V1 absent.
- *V2 en fichiers épars à côté des fichiers V1* (écarté) : confusion de fork, la
  sidebar `.tsx` n'est de toute façon pas auto-découverte en V2.

**Disposition :** répertoire-paquet unique `.opencode/plugins/co2-footprint/` avec
`package.json` (`exports`: `.` → serveur, `./tui` → sidebar), auto-découvert par V2
(« immediate plugin package directories »), zéro config. Retenu contre « fichiers
directs top-level » (impossible pour le `.tsx`, et un paquet unique est plus proche
d'une éventuelle publication).

**Méthodologie :**
- *Facteurs par type de token, PUE inclus, par famille avec repli palier, dans un
  `factors.json` éditable* (retenu) : directement au service du critère
  d'expérimentation ; garde la séparation énergie/intensité réseau du plugin
  (meilleure que le CIF intégré de claude-carbon pour un outil multi-fournisseurs).
- *Paliers conservés avec coefficients par type* (écarté) : sans données par famille,
  la famille est l'unité la plus fine publiable.
- *Import direct du factors.json de claude-carbon* (écarté) : facteurs en gCO2e avec
  CIF Anthropic intégré (0,287), incompatible avec l'intensité configurable ; on
  convertit en Wh/Mtok et on cite.

**Modèles :** extrapolation documentée faute de données publiées (Jegham v6 couvre 30
modèles — OpenAI, Anthropic, Meta, DeepSeek — ni GLM ni Moonshot), corroborée par le
prix liste de `kimi-k3.1-pro` ($2/$10 par MTok, identique à Sonnet ; le ratio de prix
liste est aussi le proxy de calcul que claude-carbon utilise pour Fable).

## Design

### Phase 1 — `feat/v2-plugin` : migration V2-only

Restructuration en plugin-paquet unique :

```
.opencode/plugins/co2-footprint/
  package.json     exports "." → ./index.ts, "./tui" → ./tui.tsx
  index.ts         Plugin.define({ id: "opencode-footprint.co2-tracker", setup })
                  → tool co2_report via ctx.tool.transform (JSON Schema, arg export)
                  → lecture de l'historique via le domaine session de ctx
                  → export markdown/json écrit dans le répertoire courant de la session
  tui.tsx          partie TUI V2 (@opencode/plugin/tui) : sidebar_footer, ordre bas
                  pour battre le footer intégré, kv/store pour le lifetime
  lib/             co2-core.ts, co2-report.ts, co2-sidebar-logic.ts — logique pure
                  inchangée (déplacée, pas réécrite)
```

- `/co2` (`.opencode/commands/co2.md`) : découverte inchangée en V2, pas de port
  (confirmé contre la doc plugins). `tui.json` supprimé. Entrypoint V1 supprimé.
- `.opencode/package.json` : pins remplacés — `@opencode/plugin` (SDK V2, version
  compatible 2.x la plus ancienne au moment du pin, vérifiée contre le registry) ;
  `@opencode/plugin/tui` et `@opentui/solid` selon la génération exigée par l'hôte
  V2 (l'exemple de publication déclare `>=0.6.6` : vérifier à l'implémentation).
- README/INSTALL réécrits pour l'installation V2 (copie du répertoire, `bun install`
  automatique au démarrage).
- Signatures V2 exactes (messages, répertoire, équivalents TUI de `api.slots`,
  `api.kv`, `api.state`) : à confirmer dans `/build/plugins/server` et
  `/build/plugins/cli` à l'implémentation — la logique pure étant inchangée, le port
  est du câblage.

### Cycle de vie du total « all-time » (décision arbitrée)

L'utilisateur démarre sur V2 sans historique : pas de transition d'hôte à gérer. Le
seul risque est le mélange de grammes calculés avec des facteurs différents quand il
expérimentera. Décision : **la clé du store lifetime est indexée sur la version des
facteurs** (champ `version` de `factors.json`, introduit en phase 2 ; en phase 1 la clé
actuelle `co2.lifetime.sessions` reste). Retoucher un facteur + monter la version → le
total sidebar repart proprement à zéro, sans jamais mélanger. Reset silencieux
interdit : chaque montée de version est notée dans CHANGELOG.

### Phase 2 — `feat/energy-by-token-kind` (base : `main` de la phase 1)

Remplace `ENERGY_PER_TOKEN_KWH` + `PUE` par des facteurs **Wh/Mtok, PUE inclus**, par
famille et par type, dans `lib/factors.json` éditable :

| Famille/palier | f_in (Wh/Mtok) | f_out (Wh/Mtok) | Source |
|---|---|---|---|
| sonnet (repli « medium ») | 136 | 2878 | Jegham v6, fit 3 points (39 / 826 gCO2e/Mtok à CIF 0,287) |
| haiku (repli « small ») | 35 | 722 | 0,25× sonnet (bornes EcoLogits 0,07×–0,57×, justifiées) |
| opus (repli « large ») | 272 | 5756 | 2× sonnet (bande honnête 2×–5×) |

- Formule par modèle : `(input + cacheWrite)·f_in + cacheRead·f_in·CACHE_READ_FACTOR
  + (output + reasoning)·f_out` en Wh ; CO₂ = Wh × intensité réseau. PUE plus
  multiplié séparément (inclus dans les facteurs, AWS 2025 : 1,14).
- `CACHE_READ_FACTOR` : défaut 0,08 dans `factors.json`, surcharge
  `OPENCODE_CO2_CACHE_READ_FACTOR`, plage publiée 0,05–0,20 (Irminsul,
  arXiv:2605.05696, avec la mise en garde « 4k ≠ 126k de contexte » de claude-carbon).
- Familles Anthropic connues → facteurs dédiés ; modèle inconnu → `classifyModel`
  conservé comme repli de palier. `reasoning` au facteur output (Pasandi & Nadeem,
  HotCarbon 2026 : même énergie dans et hors trace, à 3,4 % près).
- Notes éco recalibrées : une session agentic typique (2,1 % input, 97,5 % cache
  reads, 0,4 % output, classe sonnet) passe de ~1100 Wh/Mtok à ~15 Wh/Mtok (≈ 75×) ;
  recalibrage ≈ ÷10 en première approximation, valeurs exactes verrouillées par
  golden vectors.
- Équivalents réparés : suppression des recherches Google (0,2 g = chiffre 2009 non
  sourcé, retiré aussi par claude-carbon) et du streaming (36 g/h non sourcé) ;
  charge smartphone 8,7 g (EPA 0,019 kWh × Ember 458 g/kWh 2025) ; voiture
  200 gCO₂/km (GFEI 167 homologué × ~1,2 gap réel) ; LED conservé (dénommé en
  énergie, correct pour toute intensité configurée).
- `METHODOLOGY.md` à la racine : formule, facteurs avec provenance, cache read et sa
  plage, limites honnêtes (« ordre de grandre, pas un bilan carbone »), revue datée,
  crédit claude-carbon.
- Tests : golden vectors (mix de tokens fixé → Wh et gCO₂ attendus par famille et par
  palier), seuils recalibrés, surcharge env, résolution famille/repli, lecture de
  `factors.json` + montée de version → nouvelle clé lifetime.

### Phase 3 — `feat/glm-kimi-factors` (base : branche phase 2)

- Entrées dans `factors.json` : `glm-5.3` → facteurs sonnet, `glm-5.3-flash` →
  facteurs haiku (le marqueur `flash` le classait déjà « small »),
  `kimi-k3.1-pro` (et `-highspeed` ? → facteurs sonnet, prix 2× : à trancher à
  l'implémentation, probable classe sonnet ×1 ou proxy prix 2×) → facteurs sonnet.
- Bande d'incertitude et justification dans METHODOLOGY.md (pas de mesure publiée ;
  prix liste $2/$10 = Sonnet comme élément corroborant).
- Tests : golden vectors par modèle ajouté, classification des variantes d'identifiant
  (préfixes fournisseur, suffixes de date — les identifiants réels de la base locale de
  l'utilisateur servent de cas de test).

### Branches et validation

Une branche par phase sur le fork, fusionnée dans le `main` du fork après validation
de l'utilisateur + smoke test dans son desktop. Les commits d'une phase sont proposés
en bloc (Conventional Commits, anglais) et exécutés après le « ok ».

## Ce qui reste au builder

- Signatures V2 exactes : lecture des messages de session, répertoire d'écriture de
  l'export, équivalents TUI (`slots`, kv/store, state) — `/build/plugins/server` et
  `/build/plugins/cli`.
- Pins exacts : version `@opencode/plugin` compatible 2.x la plus ancienne ;
  génération `@opentui/solid` exigée par l'hôte 2.3.1.
- Traitement de `kimi-k3.1-pro-highspeed` (classe sonnet ×1 vs proxy prix 2×).
- Valeurs finales des seuils de notes (verrouillées par golden vectors).
- Format d'entrée CHANGELOG.md à respecter.

## Vérification

- Chaque phase : `tsc --noEmit`, `node --test`, `bun test` verts ; diff relu au point
  de validation.
- Phase 1 : le plugin-paquet charge dans le desktop V2 de l'utilisateur (smoke test),
  `/co2` rend le rapport, la sidebar s'affiche, golden vectors inchangés (aucun
  chiffre ne bouge).
- Phase 2 : golden vectors avant/après quantifiés ; contrôle croisé d'une session
  réelle de l'utilisateur contre la formule claude-carbon ; édition de
  `factors.json` + montée de version → lifetime repart à zéro proprement.
- Phase 3 : chaque facteur est cité ou marqué extrapolé ; classification testée sur
  les identifiants réels de la base locale de l'utilisateur.

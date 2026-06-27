# Perf Analyzer

Petite application web (statique) qui benchmarke un PC depuis le navigateur pour
**mettre en évidence l'impact d'un EDR ou d'un VPN** sur les performances.

> En ligne : https://perf-analyzer.pages.dev

## Ce que fait l'app

- **Sidebar — Spécifications** : récupère ce que le navigateur veut bien exposer
  (threads CPU, RAM approximative, OS/architecture, GPU, support OPFS…).
- **Sidebar — CPU de référence** : l'utilisateur recherche son modèle de CPU dans
  une base **PassMark** embarquée (~4000 CPU Intel/AMD). Le score « CPU Mark »
  sert de référence théorique.
- **4 benchmarks** lancés par un bouton :
  1. **CPU** — calcul intensif (FP + entiers) dans un Web Worker.
  2. **Disque** — vraies écritures/lectures via **OPFS** (Origin Private File System).
  3. **RAM** — allocation d'un gros buffer + débit lecture/écriture séquentiel.
  4. **Réseau** — latence, download et upload via `httpbin.org`.
- **Indice de santé CPU** : compare la perf mesurée à un potentiel de référence.
  - *Local* : la meilleure perf observée sur cette machine pour ce CPU.
  - *Communautaire* : la moyenne (robuste) des runs « sains » partagés par les
    autres utilisateurs pour ce même CPU.
  - Un indice nettement < 100 % = **PC bridé** (EDR, VPN, throttling, plan d'alim…).
- **Partage opt-in** : après un run, l'utilisateur peut cocher « ce PC est sain »
  et **contribuer** son résultat à la base communautaire (anonyme).
- **Historique local** : chaque run est stocké dans `localStorage` avec sa
  **date/heure**, son **intensité** et le **CPU de référence**, et affiché dans un
  tableau de comparaison avec le **delta en %** et l'**indice CPU**.

## Détecter un PC bridé (l'objectif)

L'idée : comparer la **puissance théorique** du CPU (score PassMark) à sa
**performance réellement mesurée**. Si un CPU réputé puissant mesure moins bien
qu'attendu, quelque chose le bride.

1. Sélectionner son CPU dans la sidebar (voir « Comment trouver mon CPU »).
2. Lancer un test. L'app affiche l'**indice de santé** (mesuré / potentiel).
3. Comparer avec/sans EDR-VPN, ou se comparer à la **baseline communautaire**.

## API de partage (Cloudflare Pages Functions + D1)

Les runs « sains » partagés (opt-in) alimentent une base **D1 (SQLite)** via deux
endpoints same-origin :

| Endpoint | Méthode | Rôle |
|---|---|---|
| `/api/runs` | `POST` | Contribue un run (validation + rate-limit basique) |
| `/api/baseline?cpu=<nom>` | `GET` | Renvoie la baseline communautaire pour ce CPU |

La baseline est une **moyenne tronquée** : les runs anormalement bas (< 70 % de la
médiane, probablement bridés) sont écartés pour ne pas polluer la référence.

Migrations DB :

```bash
npm run db:migrate          # applique schema.sql à la prod (D1 --remote)
npm run db:migrate:local    # idem sur la base locale (pour dev:full)
```

Développement avec les Functions actives (sinon `/api/*` est indisponible) :

```bash
npm run dev:full            # wrangler pages dev (Functions + D1 local)
```

## Mode d'emploi pour comparer EDR / VPN

L'app ne mesure pas des valeurs absolues fiables (voir limites ci-dessous). Elle
est conçue pour la **comparaison différentielle** :

1. Lancer un run **baseline** (EDR/VPN désactivés). Le renommer « baseline ».
2. Activer l'EDR (ou le VPN), relancer un run, le renommer (ex. « EDR ON »).
3. Lire les **deltas %** dans le tableau : un disque/réseau qui s'effondre = signature
   typique d'un EDR (interception I/O) ou d'un VPN (latence + débit réseau).

## Limites importantes (sandbox navigateur)

| Donnée | Statut | Pourquoi |
|---|---|---|
| Modèle / fréquence CPU | ❌ impossible | Aucune API |
| Nb de threads CPU | ✅ partiel | `navigator.hardwareConcurrency` |
| RAM exacte | ❌ | `navigator.deviceMemory` arrondi et **plafonné à 8 Go** |
| Swap / pagefile | ❌ impossible | Aucune API, et non observable pendant un test |
| I/O disque réel | ✅ via OPFS | Sandboxé mais réellement écrit sur le disque |
| Débit réseau | ✅ | Mais limité par httpbin + l'Internet public, pas que le PC |

Pour des mesures réseau plus propres (isolées du PC), remplacer httpbin par une
**Cloudflare Function** dédiée — voir `src/config.js` (objet `NETWORK`), tout est
centralisé pour pouvoir changer l'URL facilement.

## Stack

- **Vanilla JS + Vite** (zéro framework), build statique.
- Benchmark CPU dans un **Web Worker** (`src/workers/cpu.worker.js`) pour ne pas
  freezer l'UI.
- Déploiement **Cloudflare Pages** (upload direct via Wrangler).

## Développement

```bash
npm install
npm run dev          # serveur de dev (http://localhost:5173)
npm run build        # build de production -> dist/
npm run preview      # prévisualise le build
```

## Déploiement (Cloudflare Pages)

### Mode recommandé : intégration Git (déploiement automatique)

Le projet Pages est connecté au repo GitHub. Cloudflare clone, build et déploie
**automatiquement** à chaque push sur `main`. Réglages à mettre dans le dashboard
(**Workers & Pages → perf-analyzer → Settings → Builds**) :

| Réglage                  | Valeur          |
| ------------------------ | --------------- |
| Build command            | `npm run build` |
| Build output directory   | `dist`          |
| Deploy command           | **(vide)**      |

> ⚠️ **Ne PAS renseigner de "Deploy command"** (ex. `npx wrangler pages deploy`).
> Avec l'intégration Git, Cloudflare gère le déploiement lui-même. Une deploy
> command custom relance Wrangler avec un token API et échoue en
> `Authentication error [code: 10000]` si le token n'a pas les permissions
> `Cloudflare Pages: Edit` + `Account: Read`.

Le binding D1 (`DB` → `perf-analyzer-db`) se configure côté dashboard
(**Settings → Functions → D1 database bindings**), pas dans `wrangler.toml`.

### Mode alternatif : déploiement manuel depuis ton poste

Authentification (une fois) :

```bash
npm run cf:login
```

Build + déploiement :

```bash
npm run deploy:manual    # = vite build + wrangler pages deploy dist
```

Le projet Pages s'appelle `perf-analyzer`. La config est dans `wrangler.toml`,
les en-têtes HTTP dans `public/_headers`.

## Structure

```
index.html                 # layout (sidebar + zone principale)
src/
  main.js                  # orchestration UI, run, historique, comparaison
  specs.js                 # détection des specs (best effort)
  config.js                # presets d'intensité + cible réseau (httpbin)
  benchmarks.js            # logique des 4 benchmarks
  cpu-db.js                # chargement + recherche dans la base PassMark
  health.js                # indice de santé (baseline locale, ratios)
  api.js                   # client des endpoints /api (partage communautaire)
  data/cpu-passmark.json   # base PassMark embarquée (~4000 CPU, généré)
  workers/cpu.worker.js    # boucle CPU intensive (hors thread principal)
  style.css
functions/api/
  runs.js                  # POST /api/runs   (contribution opt-in)
  baseline.js              # GET  /api/baseline (moyenne robuste)
  _shared.js               # helpers CORS/JSON/validation
scripts/parse-passmark.js  # génère data/cpu-passmark.json depuis le HTML PassMark
schema.sql                 # schéma D1 (table runs)
public/_headers            # en-têtes de sécurité + cache
wrangler.toml              # config Cloudflare Pages + binding D1
```

## Régénérer la base CPU PassMark

```bash
# 1. Télécharger la liste complète (Intel + AMD + autres)
curl -L "https://www.cpubenchmark.net/cpu-list/all" -o all.html
# 2. Parser -> src/data/cpu-passmark.json
node scripts/parse-passmark.js all.html
```

## Note de configuration réseau

Le choix actuel est `httpbin.org`. Ses limites : rate-limiting agressif, débit
dépendant du chemin Internet public, possibles timeouts. Si les tests réseau
échouent (carte « N/A » ou erreurs), c'est généralement httpbin qui throttle —
relancez, ou basculez sur un endpoint Cloudflare dans `src/config.js`.

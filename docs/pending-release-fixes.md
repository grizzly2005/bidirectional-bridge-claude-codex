# Correctifs en attente de release

Ce registre conserve les correctifs locaux à regrouper dans une prochaine release demandée
par l'utilisateur. Chaque correctif possède un identifiant stable et une entrée dans
`CHANGELOG.md`, sous `Unreleased`. Les prochains correctifs s'ajoutent au tableau et reçoivent
leur propre fiche : déclencheur, cause, effet, changement, validation et limites. Lors d'une
release, renseigner la version et son lien pour les seuls correctifs effectivement livrés.

| Identifiant | Date | Correctif | État | Release |
| --- | --- | --- | --- | --- |
| [BRIDGE-FIX-20261014-01](#bridge-fix-20261014-01) | 2026-10-14 | Conserver un compte rendu Claude refusé et permettre sa correction sur le même enfant | Validé localement : compilation et 674/674 tests | En attente |
| [BRIDGE-FIX-20261022-01](#bridge-fix-20261022-01) | 2026-10-22 | Lancer le worker Codex sous WSL depuis un bridge Windows sur workspace UNC | Porté sur 0.4.0 ; tests simulés ; tour modèle non validé, voir fiche | En attente |

## BRIDGE-FIX-20261014-01

### Contexte et déclencheur

Incident rapporté sur bridge v0.4.0 : un compte rendu Claude annonce une vérification réussie
avec un code de sortie d'échec. Le bridge refuse correctement la preuve avec
`INVALID_ARGUMENT: verification passed flag contradicts exit_code`.
Les événements historiques fournis ne révèlent pas la commande ni les valeurs exactes.
La régression locale emploie des valeurs synthétiques, sans les attribuer à l'incident.

Base du correctif : tag `v0.4.0`, commit `2b308edf7deaa34c43a4bf041218805e35775152`.
Branche : `grizzly/bridge-rejected-verification-fix`, dans un worktree dédié.
Le checkout initial, qui contient déjà des changements, est conservé.

### Cause et effet avant correction

Le runner valide les vérifications avant de conserver la sortie finale. Une contradiction
interrompt cette voie, supprime le résultat utile du compte rendu retourné et laisse la tâche
`FAILED` avec `deliverable: null`. La reprise stricte refuse cette catégorie d'échec.
L'ancien test imposant `FAILED` est remplacé par une régression qui protège la conservation
et le blocage de la preuve refusée.

### Correction appliquée

1. Séparer les vérifications acceptées des affirmations rejetées par le validateur commun.
   Le validateur, les soumissions manuelles et les règles de `COMPLETE` restent stricts.
2. Conserver la sortie finale complète, même courte, dans `claude-rejected-result.json`.
   L'enveloppe contient `validation_status: "rejected"`, le candidat original et les
   diagnostics : index de vérification, code, message et détails fournis par le validateur.
   Une contradiction conserve notamment la commande, `passed` et `exit_code` exacts.
3. Fragmenter les grandes enveloppes aux limites de code points UTF-8, selon le budget
   d'octets du registre. Les métadonnées indiquent l'ordre, le nombre de fragments et le
   SHA-256 de l'enveloppe complète. Reconstituer les fragments dans cet ordre avant de lire
   le JSON ; un fragment isolé n'est pas une enveloppe JSON complète.
4. Produire un livrable `PARTIAL` sur une tâche `BLOCKED`, avec le résumé, les chemins de
   changements déclarés, les rapports et le diagnostic. Une autre vérification réussie
   n'annule pas le rejet. Aucune vérification contradictoire n'entre dans les preuves
   canoniques ; les valeurs rejetées restent uniquement dans le candidat/diagnostic.
5. Permettre la reprise explicite existante par le propriétaire ou son gestionnaire direct
   autorisé. Elle garde la tâche, le propriétaire, la filiation, le contrat et la session,
   ouvre une tentative adjacente et respecte les budgets et les contrôles d'arrêt/lease.
6. Fournir les rapports refusés avec les entrées d'origine, sous forme de snapshots de fichiers
   vérifiés par hash. Le prompt demande d'examiner le diagnostic et de corriger le résultat
   avec des preuves réelles. Le candidat complet ne surcharge pas le prompt. Un résultat
   encore contradictoire reste `PARTIAL` / `BLOCKED` ; la reprise est idempotente.

Le rejet devient un blocage documenté dans un résultat utile. `outcome.error` n'est pas un
signal d'échec pour ce chemin `PARTIAL` ; le diagnostic `INVALID_ARGUMENT` reste lisible dans
le rapport et les risques du livrable. Il n'y a ni nouveau code d'erreur, ni nouvel outil MCP,
ni changement de schéma SQLite.

### Validation exécutée

Environnement local Windows, Node `v22.22.0`, npm `10.9.4`. Commandes exécutées à la racine
du worktree dédié ; les codes ci-dessous proviennent des processus, pas du modèle délégué.

| Commande | Code de sortie | Résultat |
| --- | --- | --- |
| `npm ci --ignore-scripts` | 0 | Installation du lockfile dans le worktree |
| `npm test -- claude/claude-side/src/adapters/claude-code-runner.test.ts -t 'preserves rejected verification output'` avant le correctif | 1 | Régression rouge volontaire : le livrable attendu `PARTIAL` est absent |
| `npm test -- claude/claude-side/src/adapters/claude-code-runner.test.ts -t 'bounded structured checkpoints'` | 0 | 10 tests réussis, 85 tests hors sélection |
| `npm run build` | 0 | Compilation TypeScript et bundle du suivi |
| `npm test` | 0 | 42 fichiers, 674/674 tests réussis sur le correctif final |
| `node docs/tools/check-doc-links.mjs` | 0 | 32 fichiers documentaires, aucun lien interne cassé ni chemin absolu |
| `npm run skills:check` | 0 | Sources canoniques et trois miroirs synchronisés |
| `npm run links:check` | 0 | Six liens de workspaces résolus correctement |
| `node scripts/certification-manifest.mjs` | 0 | 272 fichiers dans l'inventaire des sources |
| `git diff --check` | 0 | Aucun défaut d'espacement dans le diff |

Les régressions couvrent les deux sens de contradiction, un code absent sur un contrôle
non manuel, la coexistence avec un contrôle passant, les fragments UTF-8 et une reprise
gestionnaire/enfant après fermeture et réouverture de SQLite. La reprise reçoit un candidat
de plus de 250 000 caractères par snapshots, garde la session et les entrées d'origine,
refuse un appelant non autorisé et ne relance rien lors du replay idempotent.

### Limites et préparation de la release

- Les sous-processus de test simulent le protocole Claude ; aucun appel de modèle réel ni
  reprise de l'enfant historique n'a été exécuté dans cette session. Les outils MCP natifs
  du bridge n'étaient pas disponibles pour une revue indépendante dans l'autre runtime.
- Le correctif vise les vérifications structurées du résultat final Claude. Il n'élargit
  pas le traitement des champs mal formés déjà filtrés par le runner, ni celui des autres
  erreurs de schéma, stockage, autorité, runtime ou arrêt non confirmé.
- Les anciens échecs `FAILED` sans candidat conservé ne sont pas convertis automatiquement.
  Le code ne reconstitue pas les valeurs historiques manquantes et ne modifie pas leurs bases.
- Les changements restent locaux. La version des paquets reste `0.4.0`. Le correctif est
  inscrit dans `Unreleased` ; publication, nouvelle version et requalification de release
  seront réalisées quand l'utilisateur demandera de regrouper les correctifs.

## BRIDGE-FIX-20261022-01

### Déclencheur, cause et correction

Le worker Windows échoue sur un workspace UNC vers WSL (`CreateProcessWithLogonW`, code
267 ; erreurs ACL/ACE du setup sandbox). Corriger le seul cwd d'une commande ne corrige pas
les racines de permissions de la session. Le choix explicite d'un exécutable Codex Linux
dans la distribution visée assure la correspondance entre lancement, workspace et racines
de session. Le client refuse les environnements incompatibles et les reprises depuis un
autre dépôt. Le contrat, les leases, artefacts, preuves, budgets et identités restent ceux
du bridge initial. Voir [la description et l'utilisation](fix-codex-windows-wsl.md).

Branche : `grizzly/fix-codex-windows-wsl`, base
`8315d7088163a6eef254553e22314f0459d53ff7`. Le checkout contenait 38 fichiers modifiés ou
non suivis : 35 sont identiques octet pour octet au relevé initial ; les ajouts de ce
correctif se superposent à trois fichiers Codex, avec sauvegarde initiale et revue du delta.
Aucun commit supplémentaire n'est créé pour mélanger ces travaux.

### Validation locale du 22 octobre

| Contrôle | Résultat observé | Limite |
| --- | --- | --- |
| TypeScript (`npm run typecheck`) | Code 0 | Vérification de types du bridge |
| Compilation (`npm run build`) | Code 0 | Produit le build local, sans déploiement |
| Cinq fichiers de tests ciblés | 80/80, code 0 | Protocoles simulés ; pas une preuve fournisseur |
| Suite bridge complète | 557/557 sur 33 fichiers, code 0, après la dernière modification de code | Aucun test applicatif Tracassin |
| Diff (`git diff --check`) | Code 0 | Revue séparée du delta sur les trois fichiers déjà modifiés |
| Liens/documentation (`node docs/tools/check-doc-links.mjs`) | Code 1 : deux chemins absolus dans les rapports préexistants du 3–4 octobre | Aucun problème signalé dans les nouveaux documents ; rapports antérieurs préservés |
| Smoke App Server Linux `0.147.0` | Code 0 | Vraie variante Linux officielle, choisie explicitement, extraction temporaire |
| `pwd` sandboxé dans le workspace fourni | Code 0, racine Linux attendue | Aucune source applicative lue ou modifiée par la commande |
| Dépôt synthétique avec espaces dans son chemin | Lecture seule : écritures interne/externe refusées ; workspace-write : écriture interne autorisée, externe refusée ; codes 0 | Politique temporaire/réseau du runtime conservée |
| Correspondance artefact Linux/UNC | Contenu produit relu à l'identique via UNC | Contrôle de correspondance des fichiers, pas une délégation complète |
| Lancement réel du MCP natif | Code 0, 35 outils ; caller/delegation attendus ; logs UNC d'origine et workspace Linux du worker | Base SQLite de smoke locale séparée ; aucune délégation modèle |
| Smoke optionnel `--invoke` | Code 1 : tour modèle `TIMEOUT` après 20 s | Le lancement seul ne valide pas une génération complète |
| Reprise du thread persistant après redémarrage | Même thread et même workspace confirmés ; annulation avant le tour suivant | Aucune génération de continuation validée |
| Authentification Linux (`codex login status`) | `Not logged in`, code 1 | Constat séparé, pas une attribution démontrée du timeout |

Preuves locales conservées dans `.bridge/windows-wsl-core-smoke-final-20261022.json`
(smoke répété après la dernière modification de code, code 0),
`.bridge/windows-wsl-core-smoke-20261022.json`,
`.bridge/windows-wsl-invoke-smoke-20261022.json`,
`.bridge/windows-wsl-native-smoke-20261022/` et
`.bridge/windows-wsl-baseline-check-20261022.json`.
La variante Windows fournie par le checkout et la variante Linux de smoke sont toutes deux
`0.147.0` ; les manifestes et le lockfile restent inchangés.

### Limites et release

Un exécutable Linux durable et un profil Linux authentifié doivent être sélectionnés pour
le projet. Aucun identifiant, état de confiance ou paramétrage d'application n'est copié.
La délégation complète et la reprise avec génération restent à vérifier dans ce profil.
Les partages SMB ordinaires, l'interop Windows comme worker Linux et le transport legacy
MCP en mode WSL sont explicitement non pris en charge. Aucun audit ni test applicatif
Tracassin n'a été lancé, et aucune de ses sources n'a été modifiée.

Le correctif reste sous `Unreleased`, version du checkout inchangée `0.3.1`. Aucun push, PR,
release ni consolidation des branches de correctifs précédentes n'est réalisé.

### Portage sur 0.4.0 (2026-11-24)

Le correctif provenait d'un checkout local non commité sur base `0.3.1` (`8315d70`). Seul
son delta WSL a été porté sur `0.4.0` + BRIDGE-FIX-20261014-01 : les corrections du 3–4
octobre de ce checkout étaient déjà livrées par `0.4.0` (fichiers identiques octet pour
octet). Fusion à trois voies (base `0.3.1`, `0.4.0`, checkout local) ; conflits résolus à la
main. La fusion automatique écrasait le bac à sable `read-only` d'une tâche `(no-write)` par
`workspace-write` lors des continuations ; le test existant l'a détecté et la priorité du
mode lecture seule est rétablie, y compris face aux réglages de tour WSL. Les tests WSL
spécifiques à Windows sont ignorés hors Windows ; aucune exécution Windows/WSL réelle n'a été
refaite pendant ce portage.

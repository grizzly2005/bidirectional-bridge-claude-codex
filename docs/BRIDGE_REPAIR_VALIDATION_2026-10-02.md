# Correctifs du bridge : contrat, preuves et limites

Révision de travail du 2 octobre 2026, en réponse à la demande d'appliquer complètement
les correctifs du rapport du 1 octobre. Les contrôles finaux passent : 454 tests, compilation,
skill, liens, manifeste et essais MCP natifs. Les preuves et leurs limites sont détaillées
ci-dessous ; elles ne constituent pas une garantie de fiabilité indéfinie.

Le rapport d'origine a pour SHA-256
`4916159fc7850e14fb2173a0bd94342bbecabb3554ca7dc6e21f1ab2d5ef0162`.
Le [suivi du 1 octobre](SUIVI_PATCHS_BRIDGE_2026-10-01.md) conserve la première série et ses
limites d'alors. Le présent document décrit le contrat désormais implémenté, y compris
les points précédemment différés. Aucun patch du fork n'est importé.

## Matrice de couverture

| Constat | Correctif implémenté | Preuve déterministe et limite |
|---|---|---|
| C01 — Baux et tâches | Conflit entre tâches distinctes du même holder ; subdivision refusée pendant une exécution possible ou une quarantaine. Réservation transactionnelle. | `leases.test.ts`, `report-patches.test.ts`, probe à deux processus. Les globs restent conservateurs ; la coordination ne confine pas le shell. |
| C02 — Pagination | `next_cursor` porte le dernier événement rendu, `has_more` annonce la suite et `head_event_id` conserve la tête globale. | 1 001 événements, tailles 1/100/500, filtres, page vide et ajouts ultérieurs. `last_event_id` conserve son ancien sens et ne doit pas servir de curseur. |
| C03 — Interruption Codex | App Server natif par défaut ; interruption du turn corrélé, confirmation terminale connue, fencing des callbacks tardifs et quarantaine si arrêt inconnu. | `codex-stop.test.ts` : ACK sans stop, réponse de lancement perdue, autre turn actif, statut inconnu, stop tardif. Aucun kill du serveur partagé. |
| C04 — Annulation | `bridge_cancel_task`, demande durable, owner ou manager direct prouvé, prise en charge entre processus. Annulation en file sans tentative ; race avec finalisation arbitrée en transaction. | `execution-contracts.test.ts`, `recovery.test.ts`, `tools.test.ts`. Un arrêt non confirmé conserve scope et capacité ; CANCELLED seul n'est pas une preuve d'arrêt. |
| C05 — Idempotence | Réservation de tout le contrat, budgets/lignée/artefacts figés, clé stable, résultat fini rejoué après restart, cache recovery mis à jour atomiquement avec la finalisation. | Doubles appels locaux et deux vrais processus, mismatch de payload, abandon avant/après autorisation, replay de panne de stop et d'observation stricte. Un lancement autorisé abandonné reste incertain, sans réinvocation automatique. |
| C06 — Préparation et retry | Validation des inputs/dépendances/budgets avant lancement ; conflit prélaunch sans tentative. `bridge_continue_task` poursuit la même tâche, avec clé distincte et budget initial. Recovery ouvre l'essai après admission. | `delegation-budget.test.ts`, `execution-contracts.test.ts`, `recovery-crash.test.ts`. Inputs changés ou manquants et annulation en file ne consomment pas une tentative. |
| C07 — Concurrence | Files FIFO bornées dans les deux adapters et admission SQLite par runtime partagée entre les processus de la même base. Nettoyage des réservations prélaunch dont le processus est mort. | Fixtures CLI/App Server et tests à deux processus. Une quarantaine occupe la capacité ; deux bases distinctes ne partagent pas le plafond. |
| C08 — Usage absent | Mode `operational` par défaut : le travail terminé reste utilisable avec métriques inconnues. Mode `strict` explicite : acceptance des observations requise séparément. | `codex-app-server-client.test.ts`, `execution-contracts.test.ts`. Une notification d'usage absente ne devient ni zéro ni une estimation. |
| C09 — Panne après livraison | Résultat métier séparé du reçu d'observation ; draft validé durable, erreur typed stockage/schéma/privacy, scellement avec rollback partiel, réparation idempotente sans modèle. | Pannes injectées, vérification de l'absence d'invocation supplémentaire, conflit avec un record déjà scellé, rejet privacy sans payload brut. Strict peut signaler TELEMETRY_INCOMPLETE avec une tâche DONE. |
| C10 — Recovery | Catégories provider quota/auth/transient/profile/contract/turn_limit, origine code ou texte, retry time seulement fourni ; même enfant/handle, budget total initial, échecs authored exclus. | `recovery.test.ts`, suites adapters et contrats d'exécution. Quota/auth/profile/contract ne déclenchent pas un retry automatique ; aucune heure de reset ni extension de budget inventée. |
| C11 — Horloges | Version 2 séparant elapsed de délégation, span de tentative, file, startup et travail ; source provider/local distincte. Durée de scellement dans le reçu, version 1. | Horloge contrôlée, spans inconnus/inversés null, retry cumulatif, mesure de scellement et replay identique. Le scellement local ne mesure pas la durabilité du commit englobant. |
| C12 — Skill | Source `skills/using-bridge/`, trois miroirs générés, récupération/annulation/continuation/observation alignées, références accessibles, identité startup distincte du disque. | `skills:check`, validateur skill-creator, test des trois miroirs. Une instruction de skill ne réveille pas un client et n'active aucune automation. |
| L4 — Exploitation et migration | Doctor natif + CLI offline sans modèle, diagnostics agrégés sans contenu privé, captures de démarrage, schéma v4, upgrade v1-v3 transactionnel et refus future/malformed avant écriture originale. | `diagnostics.test.ts`, `migration-contracts.test.ts`, launcher multi-processus. Le rollback restaure une paire code/base compatible ; il ne réduit pas le schéma en place. |

Les chemins de tests cités se trouvent sous `shared/control-plane/src/`,
`shared/mcp-server-core/src/`, `codex/codex-side/src/` et `claude/claude-side/src/adapters/`.
Les scénarios multi-processus lancent des fixtures locales, sans appel de provider.

## Changements découverts pendant la validation

Les essais natifs et la suite complète ont montré quatre problèmes supplémentaires, corrigés
avec leurs régressions :

- Le modèle implicite de Codex Desktop pouvait être absent du catalogue du CLI installé.
  App Server sélectionne alors son unique modèle par défaut annoncé ; un modèle explicite
  incompatible échoue avant le lancement. Les namespaces de providers personnalisés
  conservent leur configuration. Le modèle effectivement retourné reste la source télémétrique.
- Le parseur Claude ignorait un JSON final après un bloc de commande indenté ou un bloc
  d'une autre langue. Il consomme maintenant les fences Markdown complets avant de chercher
  le résultat JSON ; seuls les vrais `verification_results` comptent toujours comme preuve.
- Une copie SQLite pouvait contenir un journal de rollback actif pendant le démarrage
  simultané des MCP. Le contrôle de schéma attend un snapshot lisible sur une durée bornée,
  sans ouvrir l'original en écriture ni checkpoint son WAL. Le fixture indépendant conserve
  les événements historiques après rollback du writer puis migration.
- Après la mort du processus, l'annulation d'une reprise encore en file confirmait l'absence
  de runtime mais gardait son bail HELD. L'annulation libère maintenant ce bail inutilisé
  dans la même transaction, sans attendre un callback du processus mort. Le replay rapporte
  TASK_CANCELLED, sans nouvel essai, sans invocation et sans libérer une quarantaine.

La classification d'erreurs Codex couvre aussi les enveloppes JSON provider présentes dans
un message. L'annulation d'un appel pendant la découverte du catalogue ne casse plus la
découverte partagée d'un autre appel. Ces chemins ne modifient ni configuration ni auth.

## Instructions du skill

| Proposition | Comportement intégré |
|---|---|
| K01 | Source canonique versionnée, trois miroirs générés et références vérifiées ; aucune divergence de contrat entre clients. |
| K02 | Choix observer/déléguer/reprendre ; outils MCP absents : observation offline signalée sans fausse délégation ni worker direct. |
| K03 | Contrat compact avec objectif, scope, preuve réalisable, artefacts nécessaires, délais/tours finis et zéro retry par défaut. |
| K04 | Attente du résultat ; une réconciliation après ambiguïté, sans polling de toute la base. |
| K05 | Reprise selon la classe d'erreur, même enfant/session et checkpoint ; aucun sibling ni extension implicite des budgets figés. |
| K06 | Livrable métier séparé des métriques, observation conditionnelle et null pour les inconnus ; aucune télémétrie manager inventée ou exigée pour un audit ordinaire. |
| K07 | Revue proportionnée par révision, distinction blocker/remarque/proposition, contre-exemples conservés ; après deux cycles sans progrès, examiner le contrat ou blocker. |
| K08 | Séparation skill, discovery MCP et scheduler ; aucune activation ou modification d'automation. |

## Validation finale

La baseline du 2 octobre avait 340 tests dans 23 fichiers. Une première suite élargie a
terminé avec 448 succès et 4 échecs : le démarrage SQLite concurrent et trois assertions de
crash-recovery devenues incompatibles avec l'admission avant ouverture d'essai. Les tests
de crash vérifient désormais également l'absence d'essai, la quarantaine et le replay sans
mutation. Le contrôle ciblé qui suit la correction a passé 29 tests dans 3 fichiers.

Le dernier cas de nettoyage de bail a d'abord échoué (`HELD` au lieu de `RELEASED`), puis
passé après correction. La suite complète a été relancée à cause de cette modification.

| Commande depuis la racine | Résultat final observé, exit 0 |
|---|---|
| `node node_modules/typescript/bin/tsc --build --force` | Compilation/typecheck terminés, dist reconstruit. |
| `node node_modules/vitest/vitest.mjs run --reporter=dot --reporter=json --outputFile.json=tmp/full-repair-2026-10-02/final-vitest.json` | **454 tests / 28 fichiers**, 44,24 s ; aucun échec. |
| `node scripts/sync-bridge-skill.mjs --check` | 6 fichiers canoniques, 3 miroirs, 0 différence. |
| `python -X utf8 <skill-creator>/scripts/quick_validate.py skills/using-bridge` | `Skill is valid!` ; validateur installé de skill-creator. Ce check vérifie la structure, pas toutes les décisions futures du skill. |
| `node scripts/repair-workspace-links.mjs` | Les 5 liens des packages bridge résolvent correctement ; mode contrôle sans réparation. |
| `node docs/tools/check-doc-links.mjs` | 17 documents, aucun lien interne cassé ni chemin absolu. |
| `node scripts/certification-manifest.mjs` | 183 fichiers texte UTF-8/LF ; 14 nouveaux matériaux ajoutés, aucune exclusion élargie ni source/test omis. |
| `git diff --check` | Aucun défaut de whitespace. |

Les sorties machine restent dans `tmp/full-repair-2026-10-02/`. Le manifeste couvre ses
propres matériaux et donne une empreinte déterministe ; cette empreinte et le diff limité
à la série du 2 octobre sont exportés avec les résultats hors des matériaux couverts.
Cela évite une empreinte autoréférente et conserve séparément les changements préexistants.

## Essais natifs

Les essais utilisent le launcher MCP natif et le SDK stdio sur une base de test distincte,
avec scope `(no-write)/**`, vérification réelle d'un fichier marqueur, trois tours Claude,
90 secondes par essai et zéro retry automatique. Ils ne passent pas par un appel direct
du CLI worker. Les anciennes tentatives et leurs délais restent dans l'historique de test.

Le premier essai Codex a exposé le modèle implicite incompatible ; un essai suivant a
terminé COMPLETE avec Codex. Un essai Claude a terminé COMPLETE ; un suivant a exposé
le parseur de fences malgré une vérification réellement exécutée. Ce PARTIAL historique
n'est pas réécrit après correction. Les budgets initiaux expirés sont refusés par recovery.

La validation native a terminé avec exit 0 le 2 octobre vers 17 h 57, heure locale :

| Runtime appelé via MCP | Version / modèle effectivement rapportés | Résultat observé |
|---|---|---|
| Codex App Server | 0.147.0 / `gpt-5.6-sol` | DONE, COMPLETE, 1 vraie vérification, observation COMPLETE, STOPPED avec preuve positive, replay identique, 1 seul essai après réparation. |
| Claude Code | 2.1.233 / `claude-opus-5` | DONE, COMPLETE, 1 vraie vérification, observation COMPLETE, STOPPED avec preuve positive, replay identique, 1 seul essai après réparation. |

Les captures au lancement correspondaient au disque stable. Après la dernière correction
du nettoyage de bail, deux nouveaux processus MCP du build final ont rejoué les mêmes
clés : mêmes observations scellées, télémétrie inchangée, toujours un essai et refus
IDEMPOTENCY_MISMATCH d'un objectif modifié. Ce contrôle après restart, exit 0, n'a pas
réinvoqué les modèles. Le dernier correctif de nettoyage est couvert par la suite à deux
processus ; les essais providers ont validé les adapters natifs qui sont restés inchangés.

Empreintes du build final observées dans les deux nouveaux processus :

- source : `84cb940064ab03a3cf6c600eeb077a3863470896ff6b9aa8db1dabf3d305bad1` ;
- distribution : `8537b71a81ed3384ced6eff32b18bd9f15342c2efcca871bd14718be4bd69a1f`.

Ces empreintes sont des captures disque au démarrage, pas une preuve exhaustive des octets
évalués par chaque chargeur ni des dépendances. Les tests de cancellation adversariale
restent des fixtures ; aucun provider réel n'a été soumis à un stress de charge ou à une
perte réseau forcée. Les journaux de validation antérieurs restent conservés.

## Installation, performances et limites

Le travail reste local sur `main`, sans commit, push ou release. Les modifications
préexistantes sont préservées par les snapshots du 1 et du 2 octobre. Les bases historiques,
sessions utilisateurs, configuration d'authentification et automations ne sont pas réparées
ni activées. Les processus MCP de test sont distincts des clients déjà ouverts.

Les corrections apportent des garanties vérifiables de cohérence et évitent les duplications
observées. Aucun gain chiffré de latence, tokens, prix ou débit n'est démontré : l'admission
et les vérifications ont leur propre coût, et les quarantaines réduisent volontairement la
capacité disponible. Comparer des scénarios appariés avant/après avec les mêmes runtimes,
modèles, corpus et budgets reste nécessaire pour un benchmark de performance.

Pour une installation maintenable, suivre
[BRIDGE_RELEASE_ROLLBACK.md](BRIDGE_RELEASE_ROLLBACK.md) : code/lockfile épinglés, snapshot
compatible de base après arrêt des writers, captures des nouveaux processus et essais natifs
bornés après upgrade. Un build seul ne recharge pas un MCP déjà chargé. Une migration inverse
universelle, la compatibilité de tous les futurs providers ou la fiabilité indéfinie ne sont
pas établies par ces tests.

| Limite restante | Pourquoi | Action soutenable |
|---|---|---|
| Quota, OAuth, panne provider ou ancien handle refusé | L'autorité appartient au runtime externe. | Diagnostiquer la catégorie, résoudre l'accès puis reprendre le même enfant éligible dans son budget ; ne pas inventer de disponibilité. |
| Scope quarantiné après perte du processus sans preuve de stop | Libérer pourrait autoriser des écritures concurrentes. | Conserver la quarantaine jusqu'à une preuve positive ; ne pas contourner par TTL, subdivision ou nouvelle clé. |
| Runtime shell hors scope ou descendant détaché adversarial | Les baux sont une coordination, pas un OS sandbox/Job Object/cgroup. | Employer une isolation OS dédiée si le modèle de menace l'exige ; ne pas promettre une containment absente. |
| Copie offline pendant un writer actif | DB/WAL et signatures de fichiers ne constituent pas un protocole atomique avec le writer. | Stabiliser/arrêter les writers pour les sauvegardes et bascules ; un doctor unknown reste inconnu. |
| Usage absent après un résultat fini | Les métriques provider non émises ne peuvent être reconstruites honnêtement. | Operational avec null, ou critère strict non satisfait ; réparer le stockage seulement si un draft validé existe. |
| Ancien code et base v4 | Le schéma a évolué ; modifier seulement un numéro ne migre pas les données. | Restaurer une paire compatible dans un emplacement distinct, conserver les deux historiques. |

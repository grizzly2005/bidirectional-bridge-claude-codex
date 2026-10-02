# Suivi des patchs de l'analyse du bridge

**Mise à jour du 2 octobre :** la série complète et ses preuves sont décrites dans
[BRIDGE_REPAIR_VALIDATION_2026-10-02.md](BRIDGE_REPAIR_VALIDATION_2026-10-02.md). C03-C05,
C08-C09 et les volets partiels ont depuis été implémentés. Les états « différé » et
« partiel » ci-dessous sont la photographie de la première série du 1 octobre, conservée
pour sa provenance ; ils ne décrivent pas le contrat actuel.

Travail du 1 octobre 2026, demandé par l'utilisateur : appliquer les correctifs confirmés,
consigner les propositions douteuses et poursuivre les autres.

Source : pièce jointe Gmail `Rapport_bridge_historique_decisions_2026-10-01.pdf`, 29 pages,
198 424 octets. SHA-256 :
`4916159fc7850e14fb2173a0bd94342bbecabb3554ca7dc6e21f1ab2d5ef0162`.
La pièce jointe téléchargée est identique au PDF présent dans `output/pdf/`.

## Point de départ préservé

Branche `main`, HEAD `a3d0d2180dbb8ae38837ead288d23bf955771421`.
Sept fichiers suivis étaient déjà modifiés ; le test `delegation-budget.test.ts`, les notes
BELIEF, `.agents/` et le rapport étaient déjà présents sans commit.
Une copie de 160 fichiers, leurs hashes, le diff binaire préexistant et l'état Git initial
sont conservés dans `tmp/patch-series-2026-10-01/baseline/`.
Aucun bail `HELD` non expiré n'était présent dans la base locale au début des modifications.

## Décisions et correctifs

| Constat PDF | État | Traitement et limite |
|---|---|---|
| C01 : baux entre tâches | Appliqué | Un chevauchement exige le même holder **et** le même `task_id`. Les tâches distinctes d'un même agent sont en conflit. Le contrôle en transaction reste actif. `bridge_check_scope` accepte un `task_id` facultatif ; sans identité de tâche, tous les chevauchements sont signalés. |
| C02 : pagination | Appliqué | Ajout de `next_cursor`, `head_event_id` et `has_more`. Pages de 1 001 événements, limites 1/100/500, filtres, page vide et nouveaux ajouts vérifiés. `last_event_id` conserve explicitement son sens historique de tête globale ; les consommateurs doivent migrer vers `next_cursor`. |
| C03 : interruption Codex | Différé, contrat douteux | Un rejet local ne confirme pas l'arrêt distant. Une simple commande `turn/interrupt` sans confirmation ni quarantaine pourrait libérer le scope pendant des écritures actives. Il faut définir et tester l'accusé d'arrêt pour la version du runtime avant de changer la libération des baux. |
| C04 : annulation orchestrée | Différé, dépend de C03 | Une transition `CANCELLED` ne suffit pas à arrêter un runtime. La nouvelle autorité du manager direct, les races fin/annulation et la quarantaine doivent être définies ensemble. Aucun garde d'ownership n'est élargi. |
| C05 : idempotence complète | Différé, migration à concevoir | La création idempotente ne garantit pas une invocation unique. Il faut une réservation durable couvrant artefacts/budgets/lignée et une reprise des opérations abandonnées. Une simple cache Promise locale ne résoudrait pas le redémarrage ou deux processus. |
| C06 : contention et retry | Appliqué, politique conservatrice | Le conflit devient `BLOCKED` avec sa cause `SCOPE_CONFLICT`, zéro tentative ouverte et aucune invocation. Aucun retry immédiat de contention ne traverse `CLAIMED -> FAILED`. Un conflit produit après l'ouverture du runtime reste compté. La mise en file équitable avec backoff n'est pas ajoutée. |
| C07 : concurrence Claude | Partiel confirmé | Un sémaphore FIFO impose `max_concurrency` dans l'adapter. File bornée, défaut 64, limite configurable ; signal ou cancel d'un appel en file n'affecte pas l'actif. Les places sont rendues même après une exception. Deux processus MCP peuvent encore cumuler leurs limites ; aucun plafond SQLite global ni arrêt actif confirmé n'est revendiqué. |
| C08 : usage absent | Différé, contrat douteux | Le client actuel exige une notification d'usage. Assouplir cette condition sans distinguer le mode opérationnel du benchmark pourrait supprimer un critère strict. Prévoir un mode explicite et une attente bornée avant de modifier ce contrat. |
| C09 : panne après livraison | Différé, contrat douteux | Absorber toute erreur de télémétrie masquerait une faute de stockage ou un rejet de secret. Il faut un verdict durable `observation_incomplete`, une réparation idempotente et une distinction du mode strict. Aucun catch général qui ferait disparaître ces erreurs n'est ajouté. |
| C10 : recovery | Partiel confirmé | `recover()` découvre aussi les `FAILED` admis par `TaskService.assertRecoverable`, sur preuve durable d'interruption. Les échecs authored et ceux sans handle restent exclus. La classification fournisseur quota/auth et `retry_after_at` restent différées ; aucune heure de reset n'est inventée. |
| C11 : horloges | Partiel confirmé | Ajout facultatif et rétrocompatible de `attempt_started_at`, `attempt_wall_duration_ms`, `duration_measurement_version=1`. `wall_duration_ms` reste cumulatif. Deux essais de 2 s puis 1 s donnent des spans 2 s/1 s et un elapsed de 3 s. Une mesure inconnue ou une horloge inversée donne `null`. File/startup/scellement et source des durées fournisseur ne sont pas entièrement séparés. |
| C12 : copies du skill | Appliqué | Source versionnée `skills/using-bridge/`, génération des trois miroirs `.codex`, `.claude`, `.agents`, contrôle de hashes dans la suite et commandes `skills:sync` / `skills:check`. Les références recovery et pagination sont alignées. |

Les propositions K01-K08 sont intégrées dans le skill pour observation offline, contrats
réalisables, délais et tours bornés, attente sans polling répété, conservation de la lignée,
métriques inconnues et revue proportionnée. Le texte distingue instruction de skill et
réveil effectif d'un client. Aucune automation n'est créée ou activée.
Le fork n'est pas importé.

## Preuves et validations

Avant correction :

- C01/C02 : 5 nouveaux tests échouaient ; 32 autres passaient (exit 1).
- C06/C10/C11 : les 5 premières régressions échouaient (exit 1), dont la reproduction de
  `ILLEGAL_TRANSITION` lors d'un conflit avec un retry.
- C07 : 2 tests échouaient, avec deux runners actifs malgré le plafond 1 (exit 1).
- Une vérification supplémentaire a trouvé un compteur de tentative incorrect pour
  `SCOPE_CONFLICT` émis après le démarrage runtime ; correction et régression conservées.

Validation finale, tous les checks ci-dessous ont terminé avec exit 0 :

| Commande exécutée depuis la racine | Résultat observé |
|---|---|
| `node node_modules/typescript/bin/tsc --build` | Compilation réussie. |
| `node node_modules/vitest/vitest.mjs run --reporter=dot` | **340 tests / 23 fichiers**, 10,19 s pour la dernière suite complète. |
| `node tmp/patch-series-2026-10-01/lease-contention-probe.mjs` | Deux processus, deux tâches, holder `codex`, même scope : un `HELD`, un `SCOPE_CONFLICT`, un seul bail live. Base jetable, aucun runtime modèle. |
| `node scripts/sync-bridge-skill.mjs --check` | 6 fichiers canoniques, 3 miroirs, 0 différence. |
| `python -X utf8 <skill-creator>/scripts/quick_validate.py skills/using-bridge` | `Skill is valid!` ; exécuté avec le validateur installé de skill-creator. |
| `node docs/tools/check-doc-links.mjs` | 15 documents, aucun lien interne cassé ni chemin absolu détecté. |
| `node scripts/certification-manifest.mjs` | 169 fichiers texte UTF-8/LF couverts ; aucune matière projet non listée. Le PDF privé est exclu explicitement. Cette vérification de manifeste ne certifie pas la sécurité du runtime. |
| `git diff --check` | Aucune erreur de whitespace. |

Le manifeste a été actualisé pour inclure les nouveaux tests, scripts et skills, ainsi que
les notes/test préexistants absents de la liste. La nouvelle exclusion porte uniquement
sur `output/pdf/` pour les rapports PDF privés ; aucune source ou test n'est exclu.
Un diff limité à cette intervention est exporté dans
`tmp/patch-series-2026-10-01/changes-only.patch` pour distinguer les ajouts des patchs
antérieurs. Les deux premiers essais du validateur de skill ont rencontré une dépendance
YAML absente dans le Python embarqué, puis l'encodage Windows du Python système ; la
validation finale a réussi avec le Python système en mode UTF-8, sans modifier ces runtimes.

## Livraison et limites

Les modifications sont locales, sans commit, push, release, redémarrage de client,
réauthentification ou appel de modèle réel. La compilation ne prouve pas qu'un processus
MCP déjà ouvert a chargé le nouveau code. Les bases historiques ne sont pas réparées.
Les points C03-C05 et C08-C09 restent explicitement ouverts ; cette série ne suffit pas
à valider davantage de concurrence ni une certification de production.

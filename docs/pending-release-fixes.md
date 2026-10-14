# Correctifs en attente de release

Ce registre conserve les correctifs locaux à regrouper dans une prochaine release demandée
par l'utilisateur. Chaque correctif possède un identifiant stable et une entrée dans
`CHANGELOG.md`, sous `Unreleased`. Les prochains correctifs s'ajoutent au tableau et reçoivent
leur propre fiche : déclencheur, cause, effet, changement, validation et limites. Lors d'une
release, renseigner la version et son lien pour les seuls correctifs effectivement livrés.

| Identifiant | Date | Correctif | État | Release |
| --- | --- | --- | --- | --- |
| [BRIDGE-FIX-20261014-01](#bridge-fix-20261014-01) | 2026-10-14 | Conserver un compte rendu Claude refusé et permettre sa correction sur le même enfant | Validé localement : compilation et 674/674 tests | En attente |

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

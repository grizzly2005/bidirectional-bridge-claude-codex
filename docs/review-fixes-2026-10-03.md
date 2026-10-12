# Corrections du bridge — 3–4 octobre 2026

Le patch corrige les huit constats retenus de la revue précédente et ajoute des checkpoints Claude explicites. Il est appliqué localement sur `grizzly/bridge-review-fixes-20261003`, à partir de `8315d7088163a6eef254553e22314f0459d53ff7`. Ce rapport décrit le code et les contrôles réalisés ; il ne constitue pas une mesure des performances en production.

## Corrections et décision

| Référence | Constat et effet | Correction appliquée | Preuve et limites |
| --- | --- | --- | --- |
| R1 | Une annulation pendant un échec pouvait laisser partir un retry ou rompre la finalisation de l'opération durable. | L'annulation durable est prioritaire. Le passage à l'échec et le retry sont protégés par une transaction et une nouvelle lecture de l'annulation. Les erreurs de transition conservent une issue structurée. | Régression : une seule invocation, tâche `CANCELLED`, opération `FINISHED`, replay identique sans relance. |
| R2 | Les différentes entrées n'appliquaient pas toutes la même règle entre `passed` et `exit_code`. | Validateur commun au protocole, aux deux runners et à l'enregistrement/soumission des vérifications. Un code non nul ne peut pas être présenté comme réussi. Les contrôles de commande exigent un code ; un contrôle manuel explicite peut utiliser `null`. | Régressions de soumission, d'enregistrement et du vrai sous-processus simulant Claude. Une preuve contradictoire ne permet pas `COMPLETE`. |
| R3 | Une trame App Server JSON valide mais mal formée pouvait provoquer une exception non maîtrisée ou laisser un waiter ouvert. | Validation du routage, erreur contrôlée, rejet des attentes et fermeture de la connexion concernée. Les nouveaux appels sur cette connexion échouent explicitement. | Sous-processus simulé : `null`, tableau et notification incomplète. Absence de crash et de fuite du contenu de la trame dans le diagnostic. La fermeture de la connexion ne prouve pas l'arrêt du travail distant. |
| R4 | Le délai court d'un RPC pouvait tronquer l'attente d'un tour de travail plus long. | L'attente du tour utilise son délai métier ; le délai de réponse RPC reste séparé. | Fin de tour après 180 ms avec cap RPC à 75 ms et délai métier à 1 s : succès. Aucun benchmark fournisseur. |
| R5 | La fermeture de SQLite pouvait devancer une invocation et son timer d'annulation. | Arrêt idempotent de l'orchestrateur : annulation de son travail actif, arrêt des timers, signal d'abandon, attente des opérations, puis fermeture du magasin. Refus des nouveaux lancements pendant l'arrêt. | Régressions de drainage, fermeture répétée et absence de relance. Si l'arrêt réel n'est pas confirmé, la quarantaine et le lease sont conservés. |
| R6 | Une ancienne délégation sans parent ne pouvait pas être annulée par son manager. | Exception ciblée pour l'annulation seulement, fondée sur la première opération durable et son identité de création/délégation. | Le créateur de cette délégation peut annuler. Un tiers ou le créateur d'une tâche manuelle attribuée à un autre agent ne reçoit pas ce droit. La reprise reste soumise à ses règles antérieures. |
| R7 | Un nom de lanceur nu pouvait être résolu depuis le checkout ou le `PATH`. | Résolution d'un chemin système absolu, répertoire de travail système, aucun shell, cible HTTP loopback uniquement. Sous Windows, vérification de `rundll32.exe` et `url.dll`. | Tests de résolution, refus des cibles étrangères et des candidats absents. L'environnement hérité est supposé fiable ; la forme d'un chemin ne prouve pas son propriétaire. Le lancement confirme `spawn`, pas le rendu du navigateur. |
| R8 | Le client ne connaissait pas dès son montage le mode épinglé/suivi courant réellement conservé par le serveur. | `follow_current` fait partie des résultats MCP et snapshots. Le client adopte ce mode avant de fusionner les données et affiche correctement la commande de retour au suivi courant. | Tests DTO/MCP et état client, huit contrôles navigateur existants et une régression navigateur supplémentaire du mode épinglé. |

Les modifications de comptabilisation des exécutions `QUARANTINED` et de gestion des transactions SQLite suggérées dans des brouillons de revue n'ont pas été retenues : les éléments examinés ne démontraient pas un défaut. La quarantaine reste une protection nécessaire tant qu'un arrêt positif manque.

## Checkpoints et skill

Le runner Claude indique maintenant le plafond de tours réellement transmis au CLI et demande de réserver des tours au livrable final. Il peut conserver au plus quatre messages de checkpoint explicitement structurés : schéma strict, message borné à 16 Kio, résumé de 2000 caractères, au plus huit vérifications et huit risques. Les vérifications passent par le validateur commun. Les messages ordinaires, prompts et transcriptions ne sont pas archivés par ce mécanisme.

Un checkpoint utile reste `PARTIAL` après une interruption, un délai ou un plafond de tours. Il ne remplace pas le livrable final et ne transforme pas un échec de runtime en succès. Sa production dépend du worker : un agent qui n'émet pas ce message ne fournit aucun checkpoint à conserver. Les filtres de secrets et de handles sont des garde-fous, sans garantie exhaustive de prévention des fuites.

Le skill canonique `skills/using-bridge/` précise ces règles, la cohérence des preuves, le choix d'un budget borné et l'exception d'annulation des anciennes délégations. Ses copies versionnées `.agents`, `.codex` et `.claude` sont synchronisées. Aucune compétence globale ni configuration utilisateur n'a été remplacée.

## Vérifications exécutées

| Commande | Résultat final | Portée |
| --- | --- | --- |
| `npm run build` | Code 0 | TypeScript et bundle de l'UI. |
| `npm test` | Code 0 — 523 tests, 32 fichiers | Suite complète, incluant les régressions ajoutées. |
| `npm run test:tracking-ui` | Code 0 — huit contrôles | Navigateur local, loopback et harness AppBridge officiel ; adapter de travail simulé. |
| `node --input-type=module -` — harness inline SDK MCP/Playwright | Code 0 — quatre assertions de comportement | Vue épinglée au montage, conservation de sa racine, retour au suivi courant, adoption de la prochaine racine. Zéro erreur de page, zéro appel fournisseur. Le code du harness est conservé en artefact du run. |
| `npm run typecheck` | Code 0 | Vérification TypeScript après les dernières corrections. |
| `node scripts/sync-bridge-skill.mjs --check` | Code 0 — zéro différence | Sept fichiers canoniques et trois copies du skill. |
| `python -X utf8 <skill-creator>/scripts/quick_validate.py skills/using-bridge` | Code 0 — `Skill is valid!` | Structure du skill ; chemin local anonymisé. |
| `git diff --check` | Code 0 | Espaces et marqueurs de conflit du diff. |

Le premier passage complet avait 521 succès et deux échecs d'attentes de test : elles calculaient les octets du prompt avec le budget par défaut. Les tests comparent désormais le prompt effectivement transmis au sous-processus et son plafond réel ; le second passage a 523 succès. Le premier lancement du validateur Python utilisait l'encodage Windows par défaut ; l'exécution explicite UTF-8 ci-dessus a réussi.

Le harness navigateur couvre le rafraîchissement pendant une délégation, la reprise du même enfant, la distinction quarantaine/observation, la suspension d'une vue hors écran, l'affichage mobile, la fermeture sans mutation du travail, le protocole MCP Apps et l'absence de données privées de test dans la console. Il a observé huit lectures, zéro mutation et zéro erreur console. Il ne valide pas le rendu dans un compte ChatGPT réel ni toutes les plateformes de lancement du navigateur.

## Revue indépendante et résultat attendu

La correction UI a été réalisée par Claude dans un enfant durable, repris après son plafond initial. Son livrable final est `COMPLETE`, l'arrêt du runtime est confirmé et son lease est libéré. Le manager a contrôlé son artefact et exécuté les validations globales ci-dessus.

Une deuxième délégation Claude, strictement en lecture seule, a examiné le diff final. Son premier essai a atteint le plafond de 20 tours avec un résultat `PARTIAL`. La reprise du même enfant et du même contrat a rencontré le quota Claude, annoncé par le runtime comme réinitialisé à 03:10, heure de Paris. Le résultat reste `BLOCKED`/`PARTIAL`, sans rapport ni preuve canonique de cette revue. Son runtime est arrêté positivement et le lease de reprise est libéré. Aucun enfant de remplacement ni augmentation du plafond n'a été créé. Cette revue n'est donc pas présentée comme une approbation indépendante.

Le manager a relu les diffs de production relatifs au cycle de vie, aux preuves, aux checkpoints et au décodage App Server après la suite complète. Aucun défaut supplémentaire démontré n'a été retenu dans ce contrôle local. Cela ne remplace pas la revue indépendante restée partielle.

Les gains attendus sont fonctionnels : absence de relance après annulation, finalisation durable, délais métier respectés, arrêt ordonné, preuves cohérentes et suivi UI fidèle. Aucun chiffre de latence, coût, débit ou consommation après patch n'est estimé sans mesure comparable. Le nombre de tests réussi n'est pas une preuve de performance en production.

Les compromis sont explicites : l'arrêt attend le drainage borné du travail actif ; les checkpoints ajoutent au plus quatre publications par essai ; des preuves auparavant acceptées mais contradictoires sont désormais rejetées ; un lanceur installé hors des emplacements prévus donne `BROWSER_UNAVAILABLE`. Le filtre de checkpoints ne garantit pas leur émission par le modèle. Ces choix privilégient une issue durable et observable. La reprise après quota et les benchmarks fournisseurs restent des travaux ultérieurs.

## Limites de livraison

Le code est compilé et prêt pour un essai local. Un client MCP déjà lancé doit recharger son serveur pour utiliser le nouveau build. Notre client MCP de vérification et notre observateur indépendant ont été relancés sur ce build ; le suivi courant a été rouvert sur le run du patch avec `follow_current: true`, sans erreur de lancement déclarée. Le patch ne change ni la version de release ni les dépendances. Aucun commit, push ou nouvelle release n'est inclus dans cette livraison locale. Les appels Claude restent soumis au quota constaté.

# Suivi des délégations : réalisation et validation

Date : 3 octobre 2026. Base : `e1c122450115306e5b0f20f99719d83da399768d`.
Périmètre : V1 approuvée dans le rapport de conception du suivi des délégations.
Le rapport privé et ses pièces de travail ne sont pas publiés dans Git.

## Réalisation du plan

| Engagement du PDF | Réalisation | Vérification |
| --- | --- | --- |
| Activation explicite depuis le chat | `bridge_tracking_open`, réponse courte avant la délégation longue | vrai MCP stdio et SDK |
| Mini UI MCP Apps | ressource HTML autonome, metadata UI, outputSchema, App SDK1.7.5 | initialisation et appels avec AppBridge officiel |
| Repli navigateur local | listener127.0.0.1, capacité temporaire en fragment puis en en-tête | navigateur réel, contrôles Host/Origin/auth |
| Vue graphe et liste | liens pointillés maître/enfant, navigation au clavier, écran390px | essais et captures inspectées |
| Reprises et historique | même enfant, tentatives adjacentes, historique paginé et filtré | fixture de reprise, pagination stable |
| Résultat / exécution / observation distincts | champs séparés, arrêt non confirmé et quarantaine conservés | COMPLETE + observation INCOMPLETE + QUARANTINED |
| Motifs sûrs | catégories quota/auth/transient/profile/contract/turn_limit/unknown | aucune source ni erreur brute exportée |
| Observateur indépendant | processus stdio avec cinq outils, sans ControlPlane.open ni adapter | base absente non créée, aucune opération d'exécution exposée |
| Snapshot et curseur cohérents | transaction de lecture, curseurs signés par contexte, bornes de sortie | filtrage interleavé, rattrapage tronqué, refus des autres contextes |
| Fenêtre indépendante du travail | fermeture et désactivation ne touchent que la vue | tâche active, événements et leases conservés |
| Polling déterministe |2s actif,12–18s inactif, pause masquée, backoff borné | timers, concurrence et navigateur |
| Skill adapté | consignes d'activation et référence dédiée dans les trois miroirs | synchronisation et validation du skill |
| Connexion distante privée | commande de lecteur dédiée derrière un tunnel MCP authentifié | surface du lecteur vérifiée ; connexion du compte externe requise |

Le serveur de coordination garde ses outils habituels. Le serveur destiné au lecteur
distant ne les possède pas. La présence d'une vue ne crée aucune délégation, tâche ou
autorité de manager. Aucune automatisation ni configuration de compte n'a été activée.

## Défauts corrigés pendant la validation

- Les index de suivi sont installés après les migrations existantes : une ancienne base
  v1 peut toujours être migrée transactionnellement par le manager.
- Une association explicite à un run concurrent reste stable grâce à une frontière
  persistante ; les nouveaux roots suivent leur ordre d'insertion même si les dates sont égales.
- Fermer une vue révoque immédiatement sa capacité et libère son emplacement. Les vues
  fermées ne bloquent plus la limite32. La désactivation de plusieurs vues est atomique.
- La version du sidecar est vérifiée avant ses changements de schéma. Une future version
  est refusée sans lui ajouter de tables.
- Le sidecar est créé en0600 sur POSIX, même dans un dossier existant0755 et avec umask022.
  Les liens symboliques sont refusés. Windows utilise les ACL héritées du dossier du projet.
  Les sidecars et leur clé sont exclus de Git, y compris pour un chemin DB personnalisé.
- Aucune capacité de navigateur n'entre dans un résultat MCP. Le bundle de production
  supprime les logs de trames du SDK. L'ouverture inline ne lance pas de listener HTTP.
- La réponse d'ouverture visible au modèle contient un résumé inférieur à1Kio. Le graphe
  initial complet est transmis dans la metadata UI ; les lectures suivantes restent dans le widget.
- Un thème dark/light imposé par l'hôte est respecté indépendamment du système. Une
  notification partielle de contexte conserve le thème précédent.
- Une vue révoquée ou expirée arrête son polling. Une déconnexion temporaire conserve
  le dernier snapshot et utilise le backoff ; un changement de run réinitialise le curseur.
- Les durées de tentative, cumulées et runtime restent distinctes. Les métriques absentes
  restent nulles. Les motifs d'authentification et de quota sont des catégories fermées.
- Vitest est passé à4.1.11 compatible avec Node22 ; les dépendances transitives vulnérables
  ont été mises à jour sans forcer de résolution incompatible. MCP Apps2.x n'est pas
  mélangé avec les dépendances MCP1.x/Zod3 du bridge.

## Contrôles exécutés

| Commande | Résultat observé |
| --- | --- |
| `npm run build` | compilation TypeScript et bundle UI réussis, exit0 |
| `npm test` |499/499 tests,31 fichiers, exit0 au contrôle final |
| Tests de suivi inclus dans `npm test` |45/45, y compris révocation, résumé MCP compact et serveur stdio réel |
| `npm run test:tracking-ui` |8 scénarios navigateur réussis, exit0, zéro erreur console au dernier passage |
| Node22 WSL + `scripts/test-tracking-permissions.mjs` |3 contrôles POSIX réussis, exit0 |
| `npm audit` | aucune vulnérabilité déclarée dans l'arbre verrouillé lors du contrôle |
| `node scripts/repair-workspace-links.mjs` | les cinq packages internes se résolvent |
| `node scripts/sync-bridge-skill.mjs --check` | miroirs synchronisés |

Le dernier contrôle utilise Edge154.0.4258.53 en mode headless, avec Node22.22.0 sous Windows.
Le harness utilise réellement `bridge_delegate` via MCP et un adapter de simulation suspendu,
puis reprend ce même adapter après la fermeture des vues. Il ne lance aucun fournisseur IA.
Il vérifie aussi le protocole MCP Apps, le mode fullscreen, les mises à jour de thème,
la sortie des données privées, le clavier et la pause hors écran.

Les captures desktop, mobile et thème sombre ont été inspectées. Les preuves locales
sont dans `tmp/tracking-browser-evidence/` et restent hors de Git.

## Performance mesurée et portée

`npm run benchmark:tracking`, fixture locale de261 tâches et1300 tentatives :

| Mesure | Valeur observée |
| --- | --- |
| Ouverture du lecteur |18,67ms |
| Lecture p50,30 échantillons |3,18ms |
| Lecture p95 |3,88ms |
| Projection maximale mesurée |250 tâches,1000 tentatives,332466 octets |
| Dépassement des bornes | signal `truncated: true` |
| Cadence active ordinaire prévue et testée | maximum30 lectures/minute par widget |
| Cadence inactive |3,3 à5 lectures/minute |
| Vue masquée |0 lecture/minute |

Ce sont des lectures synthétiques sur cette machine, avec cache local et SQLite. Elles
ne mesurent ni le réseau de ChatGPT, ni le temps d'un modèle, ni un gain de débit des workers.
Le suivi garde le travail existant ; il ajoute l'observation. Le rattrapage exceptionnel
d'événements autorise au plus cinq pages rapides avant de revenir à la cadence normale.

## Limites de validation et usage après publication

Le code V1, son lecteur autonome, ses transports locaux et son widget sont implémentés.
La session actuelle ne charge pas les outils natifs du bridge. Le nouveau launcher et
le protocole ont donc été testés directement avec le SDK et un vrai processus stdio.
Il faut recharger une connexion MCP déjà ouverte pour charger le build publié.

Le compte ChatGPT de l'utilisateur n'a pas été raccordé à un tunnel privé pendant cette
validation. L'intégration nécessite une connexion authentifiée et un hôte qui supporte
MCP Apps. Les tests avec AppBridge officiel attestent le protocole, pas la configuration
de ce compte. La procédure du lecteur est dans [delegation-tracking.md](delegation-tracking.md).

Les boutons de mutation de tâche, une fenêtre Electron native, l'agrégation de plusieurs
projets et les exports avancés restent la V2 différée dans le PDF. Ils ne constituent pas
des fonctionnalités inachevées de la V1 approuvée.

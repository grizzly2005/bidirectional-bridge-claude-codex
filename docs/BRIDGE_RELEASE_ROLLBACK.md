# Installation épinglée, diagnostic et retour arrière

Ce guide rend une révision identifiable et son retour arrière vérifiable. Il ne remplace
pas la [politique de release expérimentale](release-policy.md) : la compatibilité des
versions pré-1.0 et la fiabilité de tous les environnements ne sont pas garanties.

## Identifier le processus réellement utilisé

Dans chaque client natif, appeler `bridge_server_info`, puis `bridge_doctor`. Conserver le
PID, la version Node, la version déclarée du serveur et `identity.capture`. Le serveur
retient cet instantané au démarrage. `identity.current_disk` est une nouvelle lecture de
l'installation ; `identity.changed_since_start` indique ce qui a changé depuis la capture.

Une recompilation ne recharge pas les modules d'un processus déjà démarré. Un changement
connu entraîne `restart_required: true`. Une absence d'empreinte ou de capture entraîne
`unknown` et éventuellement `restart_required: null` ; ne pas interpréter ces valeurs
comme un succès. Après le redémarrage des deux MCP, vérifier un nouveau PID et une capture
qui correspond à l'installation choisie. Une connexion client ou un fichier de configuration
ne suffit pas à prouver qu'une nouvelle révision est utilisée.

La capture prouve les fichiers présents au moment de sa lecture. Elle ne reconstitue pas
les octets déjà évalués par chaque chargeur de modules et ne couvre pas les dépendances
de `node_modules`. Éviter toute modification de l'installation pendant le lancement.
Les empreintes `source` et `distribution` portent sur des contenus différents : leur
égalité ou différence ne démontre pas qu'un build est à jour. Un build propre, sa validation
et une installation immuable apportent cette preuve supplémentaire.

## Exporter un diagnostic sans contenu privé

Si les outils natifs ne sont pas disponibles, le diagnostic hors ligne fonctionne même
lorsque les dossiers `dist` sont absents :

```powershell
node scripts/bridge-doctor.mjs --workspace . --db .bridge/bridge.db > bridge-diagnostic.json
```

`--repository` désigne l'installation du bridge ; `--workspace` désigne le projet géré.
Ces chemins peuvent être différents. Le JSON contient des empreintes et des agrégats
d'états ; il ne contient ni prompts, ni identifiants de tâches, ni handles, ni chemins,
ni arguments de processus, ni variables d'environnement, ni payloads d'événements.
Les informations d'adaptateurs attestent leur enregistrement, pas leur disponibilité.
Aucun modèle, probe d'authentification, annulation, réparation ou accès réseau n'est exécuté.

Le CLI copie temporairement les fichiers `.db` et WAL, vérifie que leur contenu et la
présence du WAL sont inchangés sur deux lectures, puis ouvre uniquement cette copie avec
SQLite en lecture seule et `query_only`. Le SHM historique n'est ni ouvert ni copié. Il
n'appelle jamais le store applicatif et ne crée ni ne migre la base historique. Cette copie
n'est pas un protocole atomique avec un writer concurrent. Une base changeante, un journal
de rollback présent, un schéma incompatible, une corruption ou une taille supérieure à
128 Mio, WAL compris, donnent un état inconnu. Réessayer après stabilisation du writer ;
ne pas déclencher de migration pour améliorer le diagnostic.

Le diagnostic hors ligne ne voit pas les MCP déjà chargés. Il ne peut donc jamais remplacer
la capture du processus natif. Son code de sortie `0` signifie que le JSON a été produit,
pas que la base et les runtimes sont sains. Une syntaxe CLI invalide produit le code `2`.

## Préparer une installation épinglée

1. Choisir un commit complet vérifié, et conserver son SHA ainsi que le lockfile. Ne pas
   utiliser une branche mobile comme identité de release. Un tag publié n'est fiable que
   si son commit résolu a été conservé et que le tag n'a pas changé.
2. Préparer ce checkout dans un répertoire distinct de l'installation utilisée. Ne pas
   reconstruire les fichiers sous un serveur actif. Conserver la version et le chemin du
   binaire Node choisi, ainsi que les versions réelles des CLI Claude et Codex dans un
   journal privé ; les diagnostics ne les invoquent pas pour les découvrir.
3. Installer depuis le lockfile, construire puis exécuter les contrôles :

   ```powershell
   npm ci
   npm run typecheck
   npm test
   npm run skills:check
   npm run links:check
   node docs/tools/check-doc-links.mjs
   node scripts/certification-manifest.mjs
   node scripts/bridge-doctor.mjs --db chemin-vers-une-base-de-test.db
   ```

4. Garder les empreintes des sources, du `dist`, du launcher et du lockfile avec les sorties
   de validation. Le manifeste de certification couvre les matériaux déclarés ; il ne
   couvre pas à lui seul le `dist` généré, les dépendances ou le processus chargé.
5. Faire les essais natifs bornés des deux runtimes sur une base de test distincte. Vérifier
   les captures au démarrage, l'absence de modèle appelé par le doctor, le résultat métier,
   les champs de mesure disponibles et les confirmations d'arrêt. Un test avec fixture
   n'atteste pas le fonctionnement des providers réels.

## Basculer sans mélanger les versions

Avant la bascule, identifier les tâches actives et les annulations en cours. Demander leur
arrêt ciblé par le bridge et attendre la confirmation terminale. Un délai expiré, un ACK
d'annulation ou un bail expiré ne prouve pas l'arrêt d'un worker. Tant qu'un scope est en
quarantaine sans preuve d'arrêt, ne pas le réattribuer et ne pas procéder à une migration
sur la base qu'il utilise.

Arrêter ensuite les deux processus MCP et tout autre writer de cette base. Préserver une
sauvegarde vérifiée de l'ancien code, du lockfile, de la configuration et de la base. Si un
WAL existe encore, conserver le couple base/WAL après l'arrêt de tous les writers. Conserver
un SHM éventuel seulement comme pièce de diagnostic ; ne pas réutiliser ses anciens locks
lors d'un nouveau démarrage. Le doctor est un outil d'observation et pas une sauvegarde
restaurable certifiée.

Modifier les configurations des deux clients pour pointer vers le même launcher épinglé,
le même projet et la même base. Une identité de caller différente est normale ; une
installation ou une base différente doit être intentionnelle. Démarrer les MCP, vérifier
leurs nouveaux PID et leurs captures, puis faire un essai borné. Consigner le commit, les
versions, le schéma effectivement observé et les résultats. Cette bascule n'active aucune
automation.

## Revenir à la révision précédente

Une ancienne révision ne doit pas écrire dans une base de schéma plus récent. Le store
rejette cette situation ; ne pas contourner le contrôle en abaissant `schema_version`, en
supprimant des tables ou en modifiant manuellement l'historique.

1. Suspendre les nouveaux travaux, confirmer l'arrêt des workers, puis arrêter tous les MCP
   et writers concernés.
2. Préserver séparément et vérifier l'installation et la base après upgrade. Elles contiennent
   éventuellement de nouvelles tâches absentes de la sauvegarde précédente.
3. Restaurer l'ancienne installation **avec une copie de sa base compatible** dans un
   emplacement distinct. Utiliser un `--db` explicite ; ne pas écraser la base après upgrade.
   Restaurer le WAL associé si nécessaire, avec tous les processus arrêtés, sans ancien SHM.
4. Reconfigurer les deux clients vers cette paire code/base, puis vérifier les PID, captures,
   versions de schéma et essais bornés des deux runtimes.
5. Conserver les deux historiques jusqu'à une décision explicite de réconciliation. Un retour
   à une sauvegarde antérieure ne transfère pas les tâches créées depuis cette sauvegarde.

Un rollback prouve la reprise de la paire vérifiée ; il ne promet pas une conversion inverse
universelle des schémas ou des sessions providers. Une restauration n'est déclarée réussie
qu'après l'observation du nouveau processus et les vérifications natives prévues.

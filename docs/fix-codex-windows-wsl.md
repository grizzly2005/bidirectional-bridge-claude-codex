# BRIDGE-FIX-20261022-01 — worker Codex Windows et workspace WSL

État : correctif local sous **Unreleased**, branche `grizzly/fix-codex-windows-wsl`.
Base du checkout : `8315d7088163a6eef254553e22314f0459d53ff7`, version `0.3.1`.
Les modifications préexistantes sont conservées. Aucun changement de version, schéma ou
protocole, push, PR ou release n'est inclus.

## Déclencheur et cause

Le diagnostic fourni avec Codex `0.147.0` montre des commandes sandboxées Windows réussies
depuis un dossier local et un échec `CreateProcessWithLogonW failed: 267` depuis un workspace
UNC WSL. Le journal sandbox du 22 octobre confirme aussi les échecs `GetSecurityInfo`,
`GetNamedSecurityInfoW`, ACE/ACL et `setup refresh had errors` sur cette racine.
Les références fournies sont `task_99v4m5adm9` / `art_0hkshbg03p`. Cet artefact n'a pas été
retrouvé dans les bases locales consultées ; le journal fourni a été lu directement.
Ces faits n'attribuent pas le problème à npm, Node ou `seclogon`.

Le lanceur utilisait le workspace UNC comme cwd du processus Windows et le client le
transmettait comme cwd de session. Déplacer seulement un sous-processus shell laisse les
racines de permissions de la session dans l'espace de chemins Windows.

## Comportement corrigé

Le mode WSL est **explicite** : `--codex-wsl-executable` désigne un exécutable Codex Linux
absolu dans la distribution nommée par le workspace. Les alias `wsl.localhost`, `wsl$` et la
notation UNC étendue de Node sont reconnus. Il n'y a ni copie du dépôt, ni choix automatique
d'une autre distribution, ni dossier Windows de remplacement, ni désactivation de sandbox.

Le bootstrap Windows appelle `wsl.exe --distribution … --cd … --exec … app-server`, sans
shell ni concaténation de commandes. Son cwd local est seulement celui du bootstrap. Le
workspace du worker reste le dépôt Linux correspondant au chemin UNC d'origine.

Le client transmet des chemins Linux à `config/read`, `thread/start`, `thread/resume` et
`turn/start`, remplace explicitement `runtimeWorkspaceRoots`, et vérifie les racines et la
politique de sandbox retournées avant tout tour. Les racines UNC des configurations
explicites sont converties seulement si elles appartiennent à cette distribution et à ce
dépôt. Une racine Windows, étrangère ou un serveur App Server Windows via interop est refusé.
Les politiques réseau et d'accès aux dossiers temporaires retournées par le runtime restent
inchangées ; la sandbox continue à appliquer `read-only` ou `workspace-write`.

L'adaptateur évite le PATH Windows automatique pour WSL ; un PATH explicite doit avoir la
forme Linux. Les filtres d'environnement restent actifs. Une entrée MCP `bridge` déjà
configurée dans Linux est désactivée pour le worker. Si elle n'y existe pas, le client
n'en crée pas une entrée incomplète `enabled:false`, refusée par Codex. Les autres entrées
MCP sont conservées.

Le contrôle des tâches, leases, contrats, délais, preuves et artefacts reste dans le bridge
Windows, avec le workspace d'origine. Les globs et les artefacts restent relatifs au dépôt,
avec séparateurs POSIX. Les deux chemins désignent les mêmes octets ; aucune synchronisation
ou réimportation de copie n'est nécessaire.

La reprise lit d'abord le cwd enregistré du thread : elle refuse de le déplacer vers un
autre dépôt. Elle réutilise ensuite le même identifiant, sans enfant de remplacement si la
session est absente du profil Linux. Les règles d'arrêt confirmé et de quarantaine restent
applicables : tuer le bootstrap ou recevoir un ACK d'interruption ne prouve pas l'arrêt du
travail. Une session Windows ne migre pas automatiquement dans le profil Linux.

## Utilisation

Installer Codex dans la distribution concernée, vérifier sa version et s'y authentifier
normalement. Pour reproduire cette validation, utiliser la variante Linux `0.147.0` du
paquet officiel. Le bridge ne télécharge, n'installe et n'authentifie aucun runtime
automatiquement et ne copie ni identifiants ni état de confiance Windows.

Exemple PowerShell, depuis le dépôt bridge :

```powershell
node scripts/native-bridge-mcp.mjs `
  --caller claude --delegation allow `
  --workspace '\\wsl.localhost\Ubuntu\work\project' `
  --codex-wsl-executable /usr/local/bin/codex
```

Le même argument peut être ajouté au tableau `args` de la configuration MCP du projet.
Recharger ensuite le serveur concerné pour charger le nouveau build. La base SQLite reste
par défaut celle du workspace d'origine ; `--db` conserve son sens antérieur.
Le lanceur spécialisé Codex accepte également cet argument, avec le transport `app-server`.

Sans cette sélection, un workspace UNC est refusé avant lancement par le worker Windows.
Les partages SMB ordinaires, le mode WSL depuis un hôte non Windows, un exécutable Windows
via interop et le transport legacy MCP en mode WSL sont hors du périmètre pris en charge.
Une installation Linux manquante, une distribution indisponible ou une sandbox Linux
indisponible restent des erreurs : aucun repli vers `danger-full-access` n'est effectué.

## Vérifications automatisées

Les tests ciblés couvrent les alias UNC, chemins étendus/espaces, racines et distributions
étrangères, chemins Windows dans la configuration, lancement natif local, conversion des
permissions, reprise du même thread, refus de relocalisation, choix explicite au lancement,
PATH, artefacts relatifs et conservation des autres serveurs MCP. Les tests de sous-processus
simulant WSL s'exécutent sur Windows ; les tests purs de correspondance sont portables.

```powershell
npm run typecheck
npm run build
npm test -- codex/codex-side/src/codex-execution-environment.test.ts codex/codex-side/src/codex-app-server-client.test.ts codex/codex-side/src/codex-adapter.test.ts codex/codex-side/src/bridge-server.test.ts shared/mcp-server-core/src/native-launcher.test.ts
npm test
```

Les résultats finaux sont consignés dans la [fiche de suivi](pending-release-fixes.md#bridge-fix-20261022-01).

## Smoke réel et limites

Le harness opt-in utilise le client compilé du bridge et un véritable App Server, sans test
applicatif. Il vérifie le cwd du dépôt sélectionné par une commande `pwd` sandboxée, puis
crée un dépôt synthétique distinct pour tester lecture seule, écriture bornée et lecture
du fichier produit via UNC. Aucune source du projet sélectionné n'est modifiée ou auditée.
Les fixtures synthétiques sont conservées dans un dossier temporaire propre au smoke.

```powershell
node codex/codex-side/scripts/smoke-windows-wsl.mjs `
  --workspace '\\wsl.localhost\Ubuntu\work\project' `
  --codex-wsl-executable /usr/local/bin/codex `
  --output .bridge/windows-wsl-smoke.json
```

`--invoke` ajoute un tour modèle sans outil sur le dépôt synthétique et une reprise du même
thread après redémarrage du serveur. Sans ce flag, ces deux contrôles sont explicitement
`NOT_RUN`. Les commandes réelles passent par `command/exec` avec la politique confirmée de
la session ; `thread/shellCommand`, qui ne respecte pas la sandbox du thread, n'est pas utilisé.

Validation du 22 octobre : variante Linux officielle `0.147.0` utilisée explicitement par
le client corrigé ; lancement natif MCP avec le workspace UNC d'origine et une base de
smoke séparée ; cwd réel correct ; limites lecture/écriture et correspondance du fichier
produit confirmées. Le tour modèle a expiré après 20 secondes (`TIMEOUT`). La reprise du même
thread persistant dans un App Server neuf a réussi jusqu'au
contrôle précédant le tour suivant, volontairement annulé. Il ne s'agit pas d'une reprise
de génération réussie. `codex login status` dans WSL retourne séparément `Not logged in`
(code 1) ; la cause exacte du délai du tour n'est pas déduite de ce seul constat.

Les preuves finales sont conservées dans `.bridge/windows-wsl-core-smoke-final-20261022.json` ;
le premier smoke est conservé dans `.bridge/windows-wsl-core-smoke-20261022.json`.
Les autres preuves se trouvent dans
`.bridge/windows-wsl-invoke-smoke-20261022.json` et
`.bridge/windows-wsl-native-smoke-20261022/`. La variante Linux de vérification est extraite
dans un dossier temporaire WSL et ne constitue pas une installation durable pour le projet.
Un tour modèle complet, une reprise avec génération et une délégation MCP complète ne sont
donc pas validés. Le test de lancement ne remplace pas ces contrôles.

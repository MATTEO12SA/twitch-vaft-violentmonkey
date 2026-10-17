# TwitchAD VAFT MATTEO12SA

Userscript indépendant issu de [TwitchAdSolutions / vaft](https://github.com/pixeltris/TwitchAdSolutions), destiné à **Violentmonkey sur Chrome et Edge**, pour les directs de Twitch.

## Version en préparation : 37.0.3

Cette branche fiabilise les requêtes, les playlists et le cycle de vie du lecteur. **La validation en lecture réelle reste nécessaire avant fusion et distribution automatique.** Les tests automatisés utilisent des réponses simulées : ils ne démontrent pas que tous les formats publicitaires actuels de Twitch sont bloqués.

- Les opérations GraphQL explicitement destinées au direct sont les seules réécrites. Les opérations VOD et inconnues restent intactes, y compris dans un lot mixte.
- Une publicité confirmée déclenche la recherche d’un flux alternatif. En l’absence de flux utilisable, VAFT renvoie une playlist d’attente sans segment publicitaire et affiche son état dans le lecteur.
- Les requêtes auxiliaires sont annulées après 8 secondes, corps compris. La recherche complète est également bornée à 8 secondes. Les nouvelles recherches sont espacées de 2, 4, 8, 16 puis 30 secondes ; les relances du lecteur sont séparées d’au moins 8 secondes.
- Les VOD restent inchangées par défaut. Le diagnostic VOD est activable en mode debug ; le saut de plages publicitaires confirmées est **expérimental et désactivé par défaut**.
- Les interceptions de Workers conservent les autres wrappers, dont celui de TwitchNoSub. Des tests simulent les deux ordres d’installation ; la lecture réelle avec TwitchNoSub reste à valider.
- Aucun remplacement global de la visibilité du document ou des méthodes de stockage. Aucun masquage générique de messages d’erreur, bannières, promotions ou fenêtres.

Le script reste distribué sous la forme d’un seul fichier, sans `@require` distant. Son fonctionnement dépend nécessairement de Twitch et de ses interfaces : un dépôt indépendant ne s’adapte pas automatiquement aux évolutions du site.

## Installation stable avec Violentmonkey

1. Installer [Violentmonkey](https://violentmonkey.github.io/get-it/).
2. Désactiver les autres installations de VAFT/TwitchAdSolutions pour éviter les doubles interceptions.
3. Ouvrir **[Installer la version de main](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js)** et confirmer dans Violentmonkey.
4. Recharger les onglets Twitch.

Le nom **TwitchAD VAFT MATTEO12SA**, le `@namespace` et les URL de mise à jour sont conservés. La mise à jour de 37.0.2 vers cette version doit donc modifier l’entrée existante ; ce point figure dans les essais manuels. Les instructions ciblent Violentmonkey sans verrou technique contre les autres gestionnaires.

`@updateURL` et `@downloadURL` continuent de viser **ce dépôt, branche main**. Un push sur une branche de développement n’est pas distribué aux utilisateurs de main.

Pour essayer cette branche, remplacer temporairement le code de **l’entrée existante** dans l’éditeur Violentmonkey avec son `vaft.user.js` généré, puis recharger Twitch. Ne pas laisser deux copies activées. Les essais doivent suivre [TESTING.md](TESTING.md).

## Modifier et vérifier le code

Les sources se trouvent dans `src/`. `vaft.user.js` est généré : toute modification directe de ce fichier sera écrasée au prochain build.

Avec Node.js 22 ou 24 et Git :

```sh
git clone https://github.com/MATTEO12SA/twitch-vaft-violentmonkey.git
cd twitch-vaft-violentmonkey
git switch codex/vaft-robustness
npm run build
npm run check
```

Aucune installation de dépendances npm n’est nécessaire. Après modification des sources, relancer les deux dernières commandes et enregistrer aussi le fichier généré dans le commit. Après fusion de cette branche, le développement courant pourra se faire depuis `main`.

| Fichier | Responsabilité |
| --- | --- |
| `src/config.js` | Version, délais, sélecteurs et options ; `debug` et `vodAdSkipping` sont désactivés |
| `src/network.js` | Interface `fetch`, opérations GraphQL, lecture bornée, délais et réponses |
| `src/hls.js` | Parsing des attributs, variantes, marqueurs publicitaires et plages VOD |
| `src/worker.js` | Filtrage des playlists, alternatives, récupération et registres du Worker |
| `src/player.js` | Lecteur, SPA, observation du DOM, réglages et saut VOD expérimental |
| `src/runtime.js` | Installation des interceptions, chaîne de Workers et relais contrôlé |
| `tools/build.js` | Génération reproductible du userscript et de ses métadonnées |
| `test/` | Tests Node et fixtures synthétiques sans données de session |

## Diagnostic et limites

Dans `src/config.js`, `debug: true` active des codes d’événement et compteurs limités, ainsi que `window.__VAFT_MATTEO_DEBUG__.snapshot()` et `.simulateAds(true/false)`. Ces commandes n’existent pas dans la distribution normale. La simulation ne prouve pas l’efficacité contre une publicité réelle.

VAFT n’enregistre pas les en-têtes d’authentification, jetons, signatures ou URL signées. Les en-têtes utiles au relais restent en mémoire privée pendant la session. Ne pas joindre une capture réseau brute à un signalement : retirer cookies, jetons, signatures et identifiants de session. Indiquer plutôt navigateur, versions, scénario, code d’erreur visible et codes de diagnostic VAFT.

- Le mode VOD n’accepte que des plages confirmées dont la chronologie est complète et cohérente, avec une fin accessible dans `seekable`. Il ne supprime aucun segment de la playlist. Les sessions publicitaires séparées, mappings ambigus, playlists partielles et discontinuités ne déclenchent aucun saut.
- Aucun exemple réel de publicité VOD n’a été fourni : les fixtures VOD sont synthétiques. Le mode doit rester désactivé tant que des essais réels n’ont pas validé ses hypothèses.
- TwitchNoSub reste un projet séparé, à installer et maintenir séparément. VAFT ne l’importe pas et ne réplique pas son mécanisme de lecture.
- Les Workers de type module ne sont pas instrumentés. VAFT conserve leur construction et signale que le blocage n’a pas pu s’initialiser. Le userscript TwitchNoSub 1.2.1 perd lui-même les options de constructeur : la combinaison module + TwitchNoSub n’est pas prise en charge. Les tests de coexistence concernent les Workers classiques.
- Les Workers classiques construits depuis un Blob sont copiés avant que l’appelant puisse révoquer son URL. Cette lecture synchrone concerne leur amorçage ; son coût doit être mesuré lors des essais de performance. Les URL créées par VAFT sont libérées après le signal de démarrage ou un échec explicite.
- La récupération React reste dépendante des interfaces internes de Twitch. Si plusieurs lecteurs sont ambigus, aucune commande n’est envoyée. Une playlist vide d’attente peut être traitée différemment selon la version du lecteur : c’est un point de validation préalable à la publication.
- Pas de prise en charge nouvelle des iframes ou lecteurs intégrés à des sites tiers. Injection uniquement sur les pages HTTPS `www.twitch.tv` et `twitch.tv`.

## Publication et retour arrière

La référence Git `baseline-37.0.2` conserve la version de départ. La version 37.0.3 est réservée à cette livraison et ne doit rejoindre `main` qu’après validation de [TESTING.md](TESTING.md). GitHub Actions vérifie la syntaxe, les métadonnées, le fichier généré et les tests sur Node 22 et 24.

Pour annuler une version déjà distribuée, repartir du comportement validé, conserver le nom et le namespace et publier un numéro **supérieur** à la version retirée : un simple retour à un ancien numéro peut ne pas déclencher la mise à jour dans Violentmonkey.

## Crédits et licence

Base issue de VAFT 37.0.0, avec les [crédits de VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits). La [licence MIT d’origine](LICENSE) et le copyright des contributeurs TwitchAdSolutions sont conservés. Projet indépendant de Twitch, Violentmonkey et TwitchNoSub.

# TwitchAD VAFT MATTEO12SA

**VAFT pour les directs Twitch, avec un ajout pour bloquer les publicités avant les rediffusions.**

Ce projet indépendant reprend le moteur VAFT de TwitchAdSolutions et ajoute le blocage des **pré-rolls VOD VAST 3 pris en charge**. Il s'installe avec **Violentmonkey** et reçoit ses mises à jour depuis ce dépôt.

**[Installer ou mettre à jour le script](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js)** · [Nouveautés](CHANGELOG.md) · [Signaler un problème](https://github.com/MATTEO12SA/twitch-vaft-violentmonkey/issues)

## Ce qu'apporte la version 37.0.4

Le [projet d'origine](https://github.com/pixeltris/TwitchAdSolutions) est archivé. Ce dépôt poursuit une évolution indépendante : la 37.0.4 intègre le traitement VOD validé séparément, tout en conservant le code existant des directs.

| Fonction | Prise en charge |
| --- | --- |
| Publicités des directs | Moteur VAFT conservé, avec le bandeau « Pub bloquée ». |
| Publicités avant une rediffusion | Blocage du format VAST 3 identifié, sans restriction de chaîne ou d'annonceur. |
| Publicités en cours de rediffusion | Pas de prise en charge ajoutée dans cette version. |
| Bannières et autres formats | Hors du périmètre de cet ajout. |

Sur les VOD concernées, le lecteur reçoit une réponse sans annonce et peut démarrer normalement. **Aucun bandeau « Pub bloquée » n'est affiché sur les VOD.** Le ciblage est volontairement précis : cette version ne garantit pas l'absence de toute publicité dans tous les cas.

**TwitchNoSub reste distinct.** Conservez-le si votre lecture des rediffusions en dépend ; il n'est ni inclus ni remplacé par VAFT.

## Installation

1. Installer [Violentmonkey](https://violentmonkey.github.io/get-it/).
2. Désactiver les autres scripts VAFT ou TwitchAdSolutions pour ne garder qu'une version active.
3. Ouvrir **[le fichier installable](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js)** et confirmer l'installation dans Violentmonkey. Si le navigateur affiche uniquement le code, enregistrer le fichier `vaft.user.js` puis l'importer dans Violentmonkey.
4. Vérifier l'entrée **TwitchAD VAFT MATTEO12SA**, version **37.0.4**, puis recharger les onglets Twitch.

Si cette entrée existe déjà, la mettre à jour ou la remplacer. Une installation de TwitchAdSolutions portant un autre nom reste distincte : désactivez-la pour éviter les doublons. Les instructions ciblent Violentmonkey ; aucun verrou contre les autres gestionnaires n'est ajouté.

### Vous utilisiez le complément de test VOD ?

Après avoir installé **VAFT 37.0.4**, désactivez ou supprimez **TwitchAD VOD VAST - test MATTEO12SA**, puis rechargez Twitch. Son traitement est désormais intégré au script principal. Une protection commune évite de l'installer deux fois si le complément reste temporairement actif. Gardez TwitchNoSub actif si nécessaire.

## Mises à jour

Le script conserve son nom et son identifiant afin de mettre à jour la même entrée. Ses adresses `@updateURL` et `@downloadURL` pointent vers [le fichier de la branche `main`](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js) de **ce dépôt**, indépendamment du dépôt archivé.

Laissez les mises à jour automatiques activées dans Violentmonkey. Le gestionnaire recherche périodiquement une version supérieure : une publication sur GitHub n'est pas nécessairement installée immédiatement. Vous pouvez aussi utiliser le lien d'installation ci-dessus pour mettre à jour manuellement. Rechargez Twitch après une mise à jour.

## Validation et contributions

Le module VOD a été testé séparément sous **Edge avec Violentmonkey et TwitchNoSub** : les essais répétés ont montré une publicité lorsqu'il était désactivé, puis son absence lorsqu'il était activé. Les captures réseau ont confirmé une réponse locale XML sans annonce et l'accès à la rediffusion.

Les tests automatisés utilisent des requêtes fictives pour vérifier le ciblage et le comportement réseau. Ils complètent ces observations sans valider tous les formats publicitaires de Twitch. Les commandes, les limites et les scénarios de vérification sont décrits dans [TESTING.md](TESTING.md).

Pour signaler un problème, indiquez la version du script, le navigateur, les autres scripts actifs et les étapes permettant de le reproduire. Ne publiez pas de cookies, de jetons de connexion ni d'export réseau contenant ces données. Les améliorations passent par une PR, des tests et une nouvelle version avant publication sur `main`.

## Origine et licence

Ce projet reprend le travail de [TwitchAdSolutions et de ses contributeurs](https://github.com/pixeltris/TwitchAdSolutions). Les [crédits de VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits) et la [licence MIT d'origine](LICENSE) sont conservés.

Le traitement VOD et les publications de ce dépôt sont propres à **TwitchAD VAFT MATTEO12SA**. Le projet est indépendant de Twitch et de Violentmonkey.

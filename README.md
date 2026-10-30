# Twitch Ad Block — Directs & VOD

**Par MATTEO12SA · Pour Violentmonkey · Version 37.0.4**

Un userscript pour bloquer les publicités des directs Twitch avec VAFT et certains pré-rolls avant les rediffusions.

**[Installer ou mettre à jour le script](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js)** · [Signaler un problème](https://github.com/MATTEO12SA/twitch-vaft-violentmonkey/issues) · [Historique des versions](.github/CHANGELOG.md)

## Installation

1. Installer [Violentmonkey](https://violentmonkey.github.io/get-it/).
2. Désactiver les autres scripts VAFT ou TwitchAdSolutions pour garder une seule version active.
3. Cliquer sur **Installer ou mettre à jour le script** ci-dessus, puis confirmer dans Violentmonkey.
4. Recharger Twitch.

Si le lien affiche uniquement du code, enregistrer le fichier `vaft.user.js` puis l'importer dans Violentmonkey. L'entrée du gestionnaire conserve le nom **TwitchAD VAFT MATTEO12SA** : mettre à jour cette entrée si elle existe déjà.

## Ce qui est pris en charge

- **Directs :** blocage avec le moteur VAFT et affichage du bandeau « Pub bloquée ».
- **Rediffusions :** blocage ciblé de certains pré-rolls VAST 3, sans bandeau supplémentaire.
- **Limites :** les autres formats, les publicités en cours de VOD et les bannières ne sont pas couverts par l'ajout VOD. Certaines publicités peuvent encore passer.

**TwitchNoSub est un script distinct.** Le garder actif si la lecture de vos rediffusions en dépend ; il n'est pas inclus ici.

## Mises à jour et aide

Laisser les mises à jour automatiques activées dans Violentmonkey. Elles proviennent de ce dépôt et sont recherchées périodiquement. Le lien d'installation permet aussi une mise à jour manuelle ; recharger Twitch ensuite.

Pour [signaler un problème](https://github.com/MATTEO12SA/twitch-vaft-violentmonkey/issues), préciser la version, le navigateur, les scripts actifs et les étapes du problème. Pour une publicité, indiquer s'il s'agit d'un direct ou d'une VOD, et à quel moment elle apparaît. Ne pas publier de cookies ni de jetons de connexion.

## Crédits

Projet indépendant fondé sur [TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions), avec un ajout pour les VOD. [Crédits d'origine](https://github.com/cleanlock/VideoAdBlockForTwitch#credits) · [Licence MIT](LICENSE).

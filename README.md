# TwitchAD VAFT MATTEO12SA

Version personnalisée du script **TwitchAdSolutions (vaft)** pour une installation avec **Violentmonkey**, avec des mises à jour distribuées depuis le dépôt **MATTEO12SA/twitch-vaft-violentmonkey**.

## Version actuelle : 37.0.3

- Basée sur la version **37.0.0** de [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions), dont le dépôt est archivé depuis le 5 mars 2026.
- Le fonctionnement du bloqueur et ses réglages d’origine sont conservés.
- Le nom **TwitchAD VAFT MATTEO12SA** permet de distinguer ce projet dans Violentmonkey. Son identifiant (`@namespace`), ses liens de support et ses adresses de mise à jour correspondent à ce dépôt.
- La **37.0.3** traduit uniquement le texte du bandeau publicitaire en **« Pub bloquée »** par rapport à la 37.0.2. Ses conditions d’affichage restent identiques.

## Installation avec Violentmonkey

1. Installer [Violentmonkey](https://violentmonkey.github.io/get-it/).
2. Si un autre script VAFT ou TwitchAdSolutions est actif, le désactiver pour ne garder qu’une seule version active.
3. Ouvrir **[Installer VAFT depuis ce dépôt](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js)**, puis confirmer dans Violentmonkey.
4. Si l’entrée **TwitchAD VAFT MATTEO12SA** existe déjà, choisir sa mise à jour ou son remplacement.
5. Recharger les onglets Twitch pour utiliser le script installé.

Le nom affiché et le `@namespace` sont propres à ce projet. Si vous aviez installé une version portant l’ancien nom, désactivez-la ou supprimez-la, puis installez la version renommée via ce lien pour éviter les doublons. Les instructions sont destinées à **Violentmonkey** ; aucun verrou contre les autres gestionnaires n’a été ajouté.

## Mises à jour de ce projet

`@updateURL` et `@downloadURL` pointent tous deux vers [notre fichier `vaft.user.js`](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js), sur la branche **`main`**. Les mises à jour proviennent donc de **ce dépôt GitHub**.

Pour recevoir les nouvelles versions automatiquement, laisser les mises à jour activées dans Violentmonkey, y compris pour ce script. Le gestionnaire recherche périodiquement une version dont le numéro `@version` est supérieur à celui installé : une publication sur GitHub n’est donc pas nécessairement installée immédiatement. Après une mise à jour, recharger les onglets Twitch.

Pour publier une future évolution du script, modifier `vaft.user.js` sur `main` et augmenter `@version`. Conserver son nom et son `@namespace` pour que Violentmonkey reconnaisse la même entrée. Les références au projet d’origine servent à conserver la provenance et les crédits.

## Crédits et licence

Code d’origine : [TwitchAdSolutions et ses contributeurs](https://github.com/pixeltris/TwitchAdSolutions), avec les [crédits de VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits) conservés dans le script.

La [licence MIT d’origine](LICENSE) est conservée. Ce projet est indépendant de Twitch et de Violentmonkey.

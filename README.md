# Twitch VAFT — MATTEO12SA

Base indépendante du script **TwitchAdSolutions (vaft)**, maintenue dans le dépôt **MATTEO12SA/twitch-vaft-violentmonkey** pour préparer de futures améliorations.

## État de cette base

- Basée sur la version **37.0.0** de [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions), dont le dépôt est archivé depuis le 5 mars 2026.
- Le fonctionnement du bloqueur et ses réglages d’origine sont conservés. **Aucune amélioration fonctionnelle n’est incluse à ce stade.**
- Seules les métadonnées du userscript ont été adaptées : identifiant du projet (`@namespace`), adresses de mise à jour, page du projet, lien de signalement et version de distribution.
- La version **37.0.2** affiche le nom **TwitchAD VAFT MATTEO12SA** dans Violentmonkey pour distinguer ce projet du script d’origine ; le fonctionnement reste inchangé.

## Installation avec Violentmonkey

1. Installer [Violentmonkey](https://violentmonkey.github.io/get-it/).
2. Si une ancienne installation de VAFT est présente, la désactiver ou la supprimer dans Violentmonkey pour éviter d’exécuter deux versions.
3. Ouvrir **[Installer VAFT depuis ce dépôt](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js)**, puis confirmer dans Violentmonkey.
4. Recharger les onglets Twitch.

Le nom affiché et le `@namespace` sont propres à ce projet. Si vous aviez installé une version portant l’ancien nom, désactivez-la ou supprimez-la, puis installez la version renommée via ce lien pour éviter les doublons. Les instructions sont destinées à **Violentmonkey** ; aucun verrou contre les autres gestionnaires n’a été ajouté.

## Mises à jour de ce projet

`@updateURL` et `@downloadURL` pointent tous deux vers [notre fichier `vaft.user.js`](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js), sur la branche `main`. Les futures versions seront donc récupérées depuis **ce dépôt**, selon les réglages de mise à jour de Violentmonkey.

Pour publier une future évolution, modifier `vaft.user.js` et augmenter `@version`. Les références au projet d’origine servent à conserver la provenance et les crédits.

## Crédits et licence

Code d’origine : [TwitchAdSolutions et ses contributeurs](https://github.com/pixeltris/TwitchAdSolutions), avec les [crédits de VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits) conservés dans le script.

La [licence MIT d’origine](LICENSE) est conservée. Ce projet est indépendant de Twitch et de Violentmonkey.

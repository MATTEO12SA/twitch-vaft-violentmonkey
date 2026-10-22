# TwitchAD VAFT MATTEO12SA

Base indépendante du script **TwitchAdSolutions (vaft)**, maintenue dans le dépôt **MATTEO12SA/twitch-vaft-violentmonkey** pour préparer de futures améliorations.

## Candidate 37.0.6 — branche `test`

**Version expérimentale, non validée.** La branche `main` distribue toujours la 37.0.2 pendant les essais. Cette candidate repart de cette base et contient deux changements :

- Le bandeau existant affiche **« Pub bloquée »**, avec les mêmes conditions d'affichage.
- Sur les pages `/videos/<identifiant>`, un ajout ciblé répond avec une liste JSON vide aux demandes publicitaires `GET` vers `https://edge.ads.twitch.tv/2018-01-01/3p/ads`. Les contextes ambigus sont laissés intacts. Les directs, playlists, qualités, Workers et le fonctionnement de TwitchNoSub ne sont pas modifiés.

### Installer la candidate pour tes essais

1. Ouvrir **[VAFT 37.0.6 depuis la branche test](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/test/vaft.user.js)** dans Violentmonkey.
2. Remplacer l'entrée **TwitchAD VAFT MATTEO12SA** ; garder une seule version VAFT active et conserver TwitchNoSub actif.
3. Recharger Twitch, puis essayer une rediffusion, ses qualités, la pause/reprise et le déplacement. Vérifier aussi un direct et une navigation direct → rediffusion → direct.

Le nom, le namespace et les URL de mise à jour sont conservés. Ces URL continuent de pointer vers `main` : les prochaines candidates de `test` devront être installées manuellement. Pour revenir à la base, réinstaller manuellement le [fichier stable 37.0.2](https://raw.githubusercontent.com/MATTEO12SA/twitch-vaft-violentmonkey/main/vaft.user.js) en remplacement de la candidate.

### État de validation

Les tests sont laissés à l'utilisateur à sa demande. Les tests automatisés ajoutés dans `test/vod-ads.test.cjs` **n'ont pas été exécutés** ; ils peuvent être lancés avec `node --test test/vod-ads.test.cjs` depuis une copie Git du dépôt avec Node.js 22 ou ultérieur.

L'interception reste à vérifier sur un vrai pré-roll. Une absence fortuite de publicité ne prouve pas son efficacité. Les réponses locales XHR doivent également être acceptées par les restrictions du navigateur et par Twitch. Elles exposent une URL `data:` ; la réponse synthétique fetch n'a pas d'URL réseau. Aucun masquage d'erreur ni relancement forcé du lecteur n'est ajouté. La PR reste en brouillon jusqu'à validation.

## Historique de la base 37.0.2

- Basée sur la version **37.0.0** de [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions), dont le dépôt est archivé depuis le 5 mars 2026.
- Dans cette base, le fonctionnement du bloqueur et ses réglages d’origine étaient conservés, sans amélioration fonctionnelle.
- Seules les métadonnées du userscript avaient été adaptées : identifiant du projet (`@namespace`), adresses de mise à jour, page du projet, lien de signalement et version de distribution.
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

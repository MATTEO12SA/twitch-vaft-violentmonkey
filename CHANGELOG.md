# Historique

## 37.0.5 — candidate, validation utilisateur attendue

- Report des commandes de qualité pendant un blocage publicitaire confirmé du direct : le dernier choix manuel ou Auto est conservé jusqu’à la fin confirmée du blocage et la disponibilité du lecteur récupéré.
- Conservation du secours utilisable pendant le blocage, sans promotion automatique vers une meilleure résolution. Une recherche de remplacement reste possible si le secours devient inutilisable.
- Protection du choix en attente lors d’un remplacement du lecteur sur la même chaîne ; abandon de ce choix au changement de chaîne ou au passage à une VOD. Conservation de la pause volontaire et nettoyage des interceptions de qualité.
- Confirmation de reprise limitée au contexte publicitaire concerné, pour éviter qu’une réponse périmée ou sans segments libère prématurément le changement de qualité.
- Indication « Pub bloquée », nom Violentmonkey, namespace et URL de mise à jour conservés. Le traitement publicitaire VOD reste désactivé par défaut.

Les essais Edge du 19 octobre ont montré des interruptions temporaires et l’application du choix de qualité pendant l’affichage « Pub bloquée » ; 37.0.4 était la version annoncée par l’utilisateur, sans vérification des octets exécutés. Le cas complet « offline avec son seul » et la fin du blocage n’ont pas été établis. Les nouveaux essais réels doivent être effectués par l’utilisateur avant fusion ; main distribue toujours 37.0.2.

## 37.0.4 — candidate précédente, non distribuée sur main

- Recherche bornée de plusieurs résolutions compatibles, avec priorité à un secours propre disponible rapidement, même en faible qualité.
- Secours réduit conservé entre demandes de qualité compatibles ; amélioration en arrière-plan sans interrompre sa lecture. Résultats devenus obsolètes après changement de média, de qualité ou fin de publicité ignorés.
- Reprise des tentatives publicitaires après remplacement du lecteur sur la même chaîne ; récupération du démarrage encore sans média, sans reprendre une pause volontaire.
- Association React incomplète réessayée à cadence limitée. Pause conservée lors du remplacement d’une vidéo sur la même route ; une reprise manuelle récente prime sur l’ancienne pause mémorisée pendant une restauration.
- Indication publicitaire raccourcie à « Pub bloquée ». Erreurs techniques distinctes et absence de masquage des erreurs Twitch.
- Numéro de version chargé lisible sans debug ; identité Violentmonkey et URL de mise à jour inchangées.

Les tests automatisés de cette version couvraient ces régressions. Le maintien d’un secours compatible ne gelait pas les commandes de qualité du lecteur : les essais ultérieurs ont motivé le correctif 37.0.5. L’amélioration en arrière-plan décrite ci-dessus est le comportement de 37.0.4 et est retirée pendant le blocage en 37.0.5. Aucun blocage publicitaire VOD n’est annoncé.

## 37.0.3 — candidate précédente, non distribuée sur main

- Modules locaux et build reproductible vers un userscript unique, sans dépendance distante.
- Requêtes compatibles avec `Request`, `URL` et `Headers`, lecture et annulation bornées ; modifications GraphQL limitées au direct.
- Parsing HLS défensif, URL relatives, reconnaissance des masters avant les playlists média, suppression effective des URL de suivi.
- Publicités reconnues à partir de marqueurs explicites ; absence de `,live` insuffisante pour bloquer du contenu.
- Recherche d’alternatives et attente sans renvoi volontaire des segments publicitaires confirmés ; récupération bornée et espacée.
- Préservation des wrappers de Workers, isolation des contextes, nettoyage des ressources et diagnostic des formats non instrumentés.
- Cycle de vie du lecteur avec observation ciblée, surveillance adaptative et conservation des réglages, sans anciens hooks globaux de visibilité/stockage.
- Timers du lecteur liés à `window` pour éviter l'erreur de démarrage `Illegal invocation` reproduite dans un navigateur ; test de distribution renforcé.
- VOD inchangées par défaut ; diagnostic et saut expérimental de plages confirmées opt-in, non validés sur publicité réelle.
- Tests Node, fixtures synthétiques, contrôles GitHub Actions et procédure manuelle préalable à publication.

La compatibilité réelle Chrome/Edge/TwitchNoSub, l’efficacité sur les publicités Twitch actuelles et le budget de performance restent à valider. Aucun masquage générique d’anti-adblock ou de publicité dans le DOM n’est ajouté.

## 37.0.2

- Nom personnalisé « TwitchAD VAFT MATTEO12SA » et métadonnées de publication propres au dépôt.
- Comportement VAFT original conservé. Instantané Git : `baseline-37.0.2`.

# Historique

## 37.0.3 — en validation

- Modules locaux et build reproductible vers un userscript unique, sans dépendance distante.
- Requêtes compatibles avec `Request`, `URL` et `Headers`, lecture et annulation bornées ; modifications GraphQL limitées au direct.
- Parsing HLS défensif, URL relatives, reconnaissance des masters avant les playlists média, suppression effective des URL de suivi.
- Publicités reconnues à partir de marqueurs explicites ; absence de `,live` insuffisante pour bloquer du contenu.
- Recherche d’alternatives et attente sans renvoi volontaire des segments publicitaires confirmés ; récupération bornée et espacée.
- Préservation des wrappers de Workers, isolation des contextes, nettoyage des ressources et diagnostic des formats non instrumentés.
- Cycle de vie du lecteur avec observation ciblée, surveillance adaptative et conservation des réglages, sans anciens hooks globaux de visibilité/stockage.
- VOD inchangées par défaut ; diagnostic et saut expérimental de plages confirmées opt-in, non validés sur publicité réelle.
- Tests Node, fixtures synthétiques, contrôles GitHub Actions et procédure manuelle préalable à publication.

La compatibilité réelle Chrome/Edge/TwitchNoSub, l’efficacité sur les publicités Twitch actuelles et le budget de performance restent à valider. Aucun masquage générique d’anti-adblock ou de publicité dans le DOM n’est ajouté.

## 37.0.2

- Nom personnalisé « TwitchAD VAFT MATTEO12SA » et métadonnées de publication propres au dépôt.
- Comportement VAFT original conservé. Instantané Git : `baseline-37.0.2`.

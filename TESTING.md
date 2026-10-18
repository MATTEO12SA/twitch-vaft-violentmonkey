# Validation de 37.0.3

Les cases cochées de la section Automatisation concernent exclusivement les tests exécutés dans Node. Les essais Chrome/Edge **avec installation dans Violentmonkey** restent à effectuer. Des essais complémentaires par injection temporaire dans un navigateur intégré sont décrits séparément ci-dessous ; ils ne remplacent pas cette validation.

## Automatisation

Exécuter `npm run build`, puis `npm run check`. Aucune dépendance à installer. Les fixtures utilisent `example.invalid` et ne contiennent aucune donnée de compte Twitch.

- [x] Corps GraphQL mixtes direct/VOD, `Request`, `URL`, `Headers`, options absentes et immutabilité.
- [x] Pas d’intervention hors de l’endpoint GraphQL exact ; dernier état d’authentification prioritaire malgré des lectures asynchrones.
- [x] Délai couvrant en-têtes et corps, annulation et nettoyage ; limite de 1 MiB pour les textes auxiliaires.
- [x] Absence de `SERVER-TIME`, `CODECS` ou résolution, CRLF, URL relatives et paramètres.
- [x] Absence de `,live` sans faux positif ; suivi publicitaire réellement réécrit ; dates et durées ambiguës sans saut VOD.
- [x] Réponses inchangées conservées et réponses réécrites avec métadonnées HTTP cohérentes.
- [x] Publicité confirmée sans alternative : réponse d’attente finie et aucune URI de segment publicitaire exposée.
- [x] Une recherche en cours, tentatives espacées et délais ; récupération même si le lecteur cesse de demander sa playlist.
- [x] Annulation au changement de contexte ; résultats et messages périmés ignorés.
- [x] Pas de substitution de segments AVC dans une variante déclarée HEVC ; basculement du manifeste avant reprise.
- [x] Événements du lecteur, observation regroupée, cache React, pause volontaire et réglages audio.
- [x] Cycle pagehide/pageshow, lecteurs ambigus, remplacement vidéo, vingt changements de média et heure simulée sans croissance des registres propres au script.
- [x] Plages VOD désactivées par défaut, contexte/chronologie vérifiés, un saut par passage, attente si la fin est inaccessible.
- [x] Chaîne de Workers avec wrapper reproduisant la structure du userscript TwitchNoSub 1.2.1 dans les deux ordres ; conservation des options dans VAFT et module non instrumenté.
- [x] Exécution du bootstrap dans une VM JavaScript, révocation immédiate du Blob de l’appelant, handshake et nettoyage des Blob URL VAFT.
- [x] Relais Worker limité à l’opération prévue, identifiants dupliqués et messages étrangers ignorés.

Les tests VM utilisent un environnement navigateur simulé. Ils ne testent pas les politiques CSP/CORS réelles ni le décodage média matériel.

## Essai complémentaire dans le navigateur intégré

Compte rendu établi le 18 octobre 2026, pour les observations de la session du 17 octobre. Le navigateur intégré sous Windows annonçait `Chrome/155.0.0.0` dans son user-agent : il ne s'agit pas d'un essai dans les applications Chrome ou Edge avec leur profil d'extensions.

Le fichier généré `vaft.user.js` et le code du userscript TwitchNoSub 1.2.1 ont été exécutés temporairement dans le contexte de la page via les outils de développement. **Violentmonkey n'a pas été utilisé pour ces essais.** Aucun script n'a été enregistré dans un gestionnaire. L'injection avait lieu après le chargement de la page, avant les navigations SPA examinées ; les chargements complets suivants supprimaient ces injections. Le chargement à `document-start` n'est donc pas validé par cet essai.

| Vérification | Observation | Portée |
| --- | --- | --- |
| Démarrage du bundle de la PR au commit `0bef292` | Échec `TypeError: Illegal invocation` dans `scheduleTick` | Défaut réel : les timers natifs étaient appelés avec l'objet d'environnement comme receiver |
| Démarrage après liaison des deux timers à `window` | Exécution sans exception ; interceptions actives | Correction reproduite dans le même navigateur ; test Node renforcé, rouge avant correction puis vert |
| Direct Locklear vers ow_esports par navigation SPA avec VAFT | Lecture observée à 1280 × 720, `readyState=4`, aucune erreur média | Fonctionnement ordinaire ; aucun cycle publicitaire confirmé |
| Pause manuelle puis reprise du direct | Pause conservée jusqu'à l'action manuelle ; lecture reprise ensuite | Contrôle de lecture élémentaire, pas une récupération après publicité |
| VAFT puis TwitchNoSub, et ordre inverse | Un vrai Worker Blob de test répond au ping et émet le message `ready` de VAFT dans les deux ordres, malgré révocation immédiate de l'URL d'entrée | Amorçage et chaîne de constructeurs dans un navigateur réel ; charge utile du Worker synthétique, pas validation complète du lecteur Twitch |
| Direct avec les deux codes injectés | Lecture observée sans erreur média | Coexistence élémentaire après navigation SPA |
| VOD publique ow_esports `2898046132`, sans injections | Lecture normale, durée observée 30 460,753 s | Référence de comparaison seulement |
| VOD vers direct avec TwitchNoSub puis VAFT injectés | Direct en progression, `readyState=4`, aucune erreur média | Sens VOD vers direct observé ; retour VOD, déplacement et qualité non validés dans cet essai |

Le test n'établit ni l'installation/mise à jour Violentmonkey, ni l'efficacité publicitaire, ni la compatibilité complète des VOD avec TwitchNoSub. Les pre-roll/mid-roll, l'attente suivie d'une reprise, HEVC, la session d'une heure et le budget de performance restent à valider. Aucune case Chrome/Edge ci-dessous n'est cochée sur la base de cet essai. La PR reste en brouillon.

## Validation manuelle avant fusion

Préparer un profil de test Chrome puis Edge, avec Violentmonkey. Tester d’abord VAFT seul, puis avec le userscript TwitchNoSub. Désactiver les autres bloqueurs pour isoler le résultat, puis refaire les scénarios principaux avec la configuration habituelle.

Consigner pour chaque essai : date, navigateur/version, Violentmonkey/version, TwitchNoSub/version, scénario, résultat attendu, résultat observé et erreur éventuelle. Les chaînes et VOD testées ne doivent pas être accompagnées de leurs URL de flux signées.

| Scénario | Résultat attendu | Chrome | Edge |
| --- | --- | --- | --- |
| Direct sans pub, entrée directe puis navigation SPA | Lecture normale, aucun blocage du chat | À tester | À tester |
| Pre-roll, mid-roll, coupures successives | Alternative propre ou attente explicite, jamais retour volontaire à la pub connue | À tester | À tester |
| Alternatives indisponibles puis rétablies | Pas de boucle rapide, reprise et qualité restaurée | À tester | À tester |
| H.264 / HEVC, 1440p et 4K si disponibles | Pas d’erreur de décodage lors des transitions | À tester | À tester |
| Pause volontaire, volume, muet, plein écran, PiP | Intention utilisateur et réglages conservés | À tester | À tester |
| TwitchNoSub seul puis avec VAFT, deux ordres | VOD lisible, pause, déplacement et qualité fonctionnels | À tester | À tester |
| Direct → VOD → direct sans rechargement | Contexte correct, aucune réécriture live dans la VOD | À tester | À tester |
| Retour arrière/avant navigateur avec BFCache | Une seule surveillance active, lecture utilisable | À tester | À tester |
| Réseau lent, hors connexion puis retour | Requêtes auxiliaires terminées/annulées, page utilisable | À tester | À tester |
| Message anti-adblock ou erreur de lecture | Diagnostic Twitch visible ; VAFT n’annonce pas une lecture réparée à tort | À tester | À tester |
| Session 1 h avec 20 changements de média | Registres VAFT stables, pas d’accumulation monotone | À tester | À tester |
| Profil de performance DevTools | Pas de longue tâche > 50 ms attribuable à VAFT dans le scénario de référence, notamment amorçage Blob/React | À tester | À tester |
| Installation puis mise à jour depuis main | Une seule entrée avec même nom/namespace | À tester | À tester |

## VOD expérimentale : étape distincte

Ne pas activer `vodAdSkipping` dans la version publique avant ces essais. Les marqueurs observés doivent être documentés avec de petits exemples de playlists expurgés, sans téléchargement de vidéo complète.

- [ ] Confirmer sur une VOD réelle le lien entre le temps HLS et `video.currentTime`.
- [ ] Identifier si la publicité est une plage de la VOD ou une session séparée.
- [ ] Vérifier déplacement avant/pendant/après la plage, durée totale, pause, reprise et changement de qualité.
- [ ] Vérifier un second passage après retour arrière et l’absence de sauts répétés au même endroit.
- [ ] Confirmer qu’une plage inconnue ou ambiguë n’est jamais sautée.
- [ ] Vérifier l’attente si la fin n’est pas accessible et l’absence de reprise d’une pause volontaire.

Les sessions séparées restent hors prise en charge. Les limites détectées doivent rester visibles dans README et changelog, sans annoncer un blocage universel.

## Validation de distribution

- [ ] Tous les contrôles GitHub Actions passent sur le commit destiné à la fusion.
- [ ] Les essais réels ci-dessus sont consignés ; en cas d’échec, corriger et refaire les scénarios affectés.
- [ ] Nom, namespace, licence et URL de mise à jour inchangés ; nouvelle version disponible.
- [ ] Référence de la version précédente conservée ; procédure de retour arrière avec numéro supérieur vérifiée.

La branche d’implémentation reste une proposition tant que ces étapes ne sont pas terminées.

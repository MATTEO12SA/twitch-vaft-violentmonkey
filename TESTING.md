# Validation de 37.0.5

Les cases cochées de la section Automatisation concernent exclusivement les tests exécutés dans Node sur 37.0.5. Les essais Chrome/Edge **de la candidate 37.0.5 installée dans Violentmonkey** seront effectués par l’utilisateur. Les observations précédentes dans Edge et les essais plus anciens par injection temporaire sont décrits séparément ; ils ne valident pas les modifications ultérieures. La PR reste non fusionnée et main distribue toujours 37.0.2.

## Essais prioritaires de la candidate

Remplacer le code de l’entrée VAFT existante, y compris si elle a été renommée localement. Si l’import crée une seconde entrée, désactiver l’ancienne : **un seul VAFT doit être actif**. Vérifier la version 37.0.5, garder TwitchNoSub installé séparément, puis recharger Twitch avant de commencer. Ne pas recharger pendant un scénario de blocage, sinon la sélection en attente ne peut pas être évaluée.

1. **Pendant « Pub bloquée »**, choisir successivement 160p, 720p, puis une dernière qualité disponible. L’image du secours doit continuer sans arrêt provoqué par ces choix ; sa résolution ne doit pas suivre le menu pendant le blocage. Relever les choix et les éventuels messages, plutôt que conclure à partir de la seule coche du menu.
2. **Attendre la fin du blocage**, sans recharger : seul le dernier choix doit être appliqué après récupération du lecteur. Refaire une coupure en terminant par Auto, puis une autre en terminant par une qualité manuelle après Auto. Si la fin n’est pas observée, marquer ce point « non testé ».
3. **Mettre volontairement en pause pendant le blocage**, changer le choix, puis reprendre manuellement. Le script ne doit pas reprendre la lecture à la place de l’utilisateur ; le choix doit rester en attente tant que le blocage est actif. Vérifier aussi volume et muet.
4. **Hors blocage**, vérifier que les changements de qualité et Auto fonctionnent normalement. Pendant un autre blocage, changer de chaîne : aucun ancien choix en attente ne doit s’appliquer à la nouvelle chaîne.
5. **Avec TwitchNoSub actif**, naviguer direct → VOD accessible → direct, puis tester pause, déplacement et qualité de la VOD. Une VOD sans publicité ne valide pas le blocage publicitaire VOD, qui reste désactivé par défaut.

Pour chaque problème, communiquer : navigateur et versions des extensions/scripts, chaîne ou URL publique de la VOD, présence de « Pub bloquée », ordre des qualités choisies, choix final, image figée/noire/offline ou en progression, son confirmé par écoute, durée approximative et mode de reprise. Préciser toute pause, navigation ou recharge manuelle. Une capture du message exact est utile ; ne pas transmettre de jeton ni d’URL de flux signée.

## Automatisation

Exécuter `npm run build`, puis `npm run check`. Aucune dépendance à installer. Les fixtures utilisent `example.invalid` et ne contiennent aucune donnée de compte Twitch.

Vérification locale du 21 octobre 2026 : syntaxe, build reproductible, métadonnées et **150 tests réussis** sous Node 24.15.0.

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
- [x] Secours de basse résolution, deux sondes concurrentes au maximum, quatre variantes par profil et rotation des niveaux.
- [x] Sondes hautes/basses bloquées libérées après 2 secondes pour essayer l’intermédiaire ; budget global de 8 secondes préservé ; rotation des profils après échec.
- [x] Résultat d’un job partagé revérifié avant retour : aucun mélange AV1/AVC lors de demandes concurrentes.
- [x] Reprise des tentatives après changement d’epoch sur la même chaîne ; protection de la pause, y compris remplacement vidéo différé et pause/reprise pendant une restauration.
- [x] Pendant un blocage confirmé, les commandes manuelles/Auto sont retenues ; seule la dernière sélection est appliquée après confirmation de fin et récupération du lecteur.
- [x] Secours utilisable conservé sans promotion automatique ; remplacement possible s’il devient inutilisable, sans mélange de codecs.
- [x] Réponse vide, périmée ou provenant d’un autre contexte insuffisante pour annoncer la fin du blocage.
- [x] Sélection en attente conservée sur remplacement du lecteur de la même chaîne, abandonnée sur nouvelle chaîne/VOD ; aucune reprise forcée d’une pause.
- [x] Nettoyage des interceptions de qualité sans écraser une interception installée ultérieurement par un autre script.
- [x] Initialisation synchrone ou asynchrone de la source sans écrasement du choix retenu pendant le blocage ; qualité devenue indisponible après reprise : déverrouillage après huit secondes, sans nouvelle relance.
- [x] Remplacement de l’instance React ou de sa racine avec le même élément vidéo : interceptions transférées ; ancien événement `playing` insuffisant pour confirmer la nouvelle source.
- [x] Rotation des URL signées sans perte de la surveillance de fin ; session publicitaire active protégée de l’éviction du cache.

Les tests VM utilisent un environnement navigateur simulé. Ils ne testent pas les politiques CSP/CORS réelles ni le décodage média matériel.

Pendant la brève initialisation de la source après la fin du blocage, les setters SDK ne précisent pas l’origine de leurs appels. Le choix retenu pendant le blocage est donc protégé des valeurs d’initialisation ; un nouveau choix fait exactement pendant cette initialisation peut être remplacé par le choix précédemment retenu. Les commandes redeviennent ordinaires après restauration. L’association React et la fréquence de ses changements restent à mesurer dans le profil de performance réel.

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

## Essais Edge du 18 octobre 2026 — candidate précédente 37.0.3

L’utilisateur a signalé l’installation du paquet VAFT 37.0.3 et TwitchNoSub 1.2.1. Un nouvel onglet Edge a été créé pour ces essais, sans injection manuelle de code. Le marqueur d’activation VAFT, l’interception de `Worker` et la signature du wrapper TwitchNoSub étaient présents. L’ancien marqueur VAFT était absent. Le tableau de bord de Violentmonkey n’a pas pu être inspecté : le numéro exact et l’intégrité des scripts installés ne sont donc pas certifiés par cet essai. Le profil contenait également 7TV. Le marqueur de version ajouté en 37.0.4 peut aider à vérifier le numéro chargé lorsqu’il est accessible ; il n’a pas pu être relevé dans les essais du 19 octobre.

| Vérification | Observation | Limite |
| --- | --- | --- |
| Gotaga en direct, nouvelle page | État d’attente publicitaire VAFT puis reprise automatique en 2560 × 1440, temps en progression, aucune erreur média | Le statut provient du script ; ni type de coupure ni contenu des playlists capturés indépendamment |
| Pause et changement de qualité du direct | Pause conservée ; après choix 720p60/reprise, vidéo restée à zéro avec métadonnées seules | Échec à reproduire et résoudre sur la nouvelle candidate ; ne pas déclarer ce scénario réussi |
| VOD publique ow_esports `2898046132` | Lecture en 1280 × 720, durée 30 460,753 s, aucune erreur média | Aucune publicité VOD identifiée ; ne prouve aucun blocage publicitaire |
| Pause/reprise de cette VOD | Temps stable en pause, progression après reprise manuelle | Fonctionnement élémentaire |
| Déplacement et qualité de cette VOD | Flèches de déplacement reçues ; lecture ensuite en 852 × 480, durée inchangée | Delta exact du déplacement non isolé du temps écoulé |
| Retour VOD → Gotaga par lien SPA | Même document conservé, attente puis environ 46 s de lecture en 640 × 360 ; arrêt ultérieur avec buffer épuisé et sans erreur média | Navigation complète non validée : cause de l’arrêt indéterminée, profil avec 7TV |
| Gotaga après rechargement, 1440p → 720p → 160p → 1440p | Lecture continue observée à chaque résolution, `readyState=4`, aucune erreur média ; temps en progression en 720p et 160p avant retour source | Aucun cycle publicitaire confirmé pendant ces changements ; ne résout pas à lui seul l’arrêt précédent ni ne valide 37.0.4 |

Les correctifs 37.0.4 ont des régressions automatisées distinctes (ancien état de pause restauré, cache React négatif persistant, tentatives perdues au changement de lecteur et réutilisation du secours). Ils ne sont pas à eux seuls une preuve de résolution de tous les arrêts observés dans Edge. Les VOD Gotaga réservées aux abonnés n’ont pas été testées ; leur lecture exige un accès autorisé. Chrome, les ordres d’extensions réellement installées, HEVC, les coupures successives, le test d’une heure et la performance restent non validés.

## Essais Edge du 19 octobre 2026 — version 37.0.4 annoncée

L’utilisateur indiquait avoir installé VAFT 37.0.4, renommé localement, avec TwitchNoSub actif. L’identité exacte, la version et les octets exécutés n’ont pas été vérifiés dans Violentmonkey ; le contrôle de version par les outils de développement était indisponible. Le statut « Pub bloquée » provient du script : aucune playlist n’a été capturée indépendamment pour confirmer les limites du cycle publicitaire. Le son n’a pas été vérifié par écoute.

| Scénario sur otplol_ | Observation | Conclusion permise |
| --- | --- | --- |
| 1440p Source → 160p pendant « Pub bloquée » | Immédiatement : temps vidéo 0, pause et métadonnées seules. Plus tard : 284 × 160, temps 48,537 s, lecture active, aucune erreur média, bandeau toujours visible. | Interruption temporaire, puis choix appliqué avant disparition du statut. Délai exact de reprise non mesuré. |
| 160p → 720p pendant le même statut | Immédiatement : temps 0, pause et métadonnées seules. Relevé suivant, 23,765 s plus tard : 1280 × 720, temps 4,328 s, lecture active, aucune erreur média, bandeau toujours visible. | Nouvelle interruption, puis choix appliqué pendant le statut. L’intervalle entre relevés n’est pas la durée exacte d’arrêt. |
| Retour au choix initial 1440p Source | Réinitialisation temporaire, puis 2560 × 1440 ; temps passant de 13,636 s à 39,447 s, lecture active sans erreur média, statut encore présent. | Réglage initial rétabli et image laissée en progression. |

Le défaut complet rapporté par l’utilisateur (« offline » avec son maintenu) n’a pas été établi. La fin du blocage n’a pas été observée : l’application différée du dernier choix à cette fin reste non testée. Ces constats motivent le gel de qualité de 37.0.5 ; ils ne valident ni cette nouvelle candidate, ni les VOD, ni une fusion.

## Validation manuelle avant fusion

Préparer un profil de test Chrome puis Edge, avec Violentmonkey. Tester d’abord VAFT seul, puis avec le userscript TwitchNoSub. Désactiver les autres bloqueurs pour isoler le résultat, puis refaire les scénarios principaux avec la configuration habituelle.

Consigner pour chaque essai : date, navigateur/version, Violentmonkey/version, TwitchNoSub/version, scénario, résultat attendu, résultat observé et erreur éventuelle. Les chaînes et VOD testées ne doivent pas être accompagnées de leurs URL de flux signées.

| Scénario | Résultat attendu | Chrome | Edge |
| --- | --- | --- | --- |
| Direct sans pub, entrée directe puis navigation SPA | Lecture normale, aucun blocage du chat | À tester | À tester |
| Pre-roll, mid-roll, coupures successives | Alternative propre ou attente explicite, jamais retour volontaire à la pub connue | À tester | À tester |
| Alternatives indisponibles puis rétablies | Pas de boucle rapide, reprise et qualité restaurée | À tester | À tester |
| Haute qualité publicitaire, basse qualité propre | Image propre dès qu’un secours est disponible ; secours utilisable conservé pendant le blocage | À tester | À tester |
| Choix manuels successifs pendant « Pub bloquée » | Aucun changement de flux provoqué par les choix ; dernier choix seulement après fin confirmée et récupération | À tester | À tester |
| Auto puis manuel, et manuel puis Auto pendant le blocage | Dernier mode retenu ; application à la fin seulement | À tester | À tester |
| Qualité manuelle et Auto hors blocage | Fonctionnement habituel du menu sans report | À tester | À tester |
| Remplacement du lecteur sur même chaîne ; puis autre chaîne/VOD | Choix en attente conservé dans le premier cas et abandonné dans le second | À tester | À tester |
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

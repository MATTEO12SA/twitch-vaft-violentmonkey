# Validation et contribution

## Résultats de la version 37.0.4

Contrôles exécutés le 26 octobre 2026 :

| Vérification | Résultat | Portée |
| --- | --- | --- |
| Syntaxe du userscript | Réussie | Fichier distribuable complet |
| Tests Node.js | 38 réussis | Ciblage, compatibilité du complément, métadonnées et conservation du moteur des directs |
| Edge 156.0.4314.42 | 24 scénarios réussis | Userscript complet et XHR natif sur des pages de test locales |
| Chrome 156.0.8078.48 | 24 scénarios réussis | Mêmes scénarios sur des pages de test locales |
| Essais utilisateur sur Twitch | Pré-roll observé bloqué | Complément 0.1.0, Edge, Violentmonkey et TwitchNoSub |

Les essais utilisateur ont alterné complément désactivé (pré-roll visible) et activé (démarrage de la VOD sans ce pré-roll). Les captures réseau montrent des réponses locales `200`, de type XML, contenant `<VAST version="3.0"></VAST>`. Elles confirment le fonctionnement pour ce format, sans prouver la couverture de toutes les publicités Twitch.

La version intégrée reprend le code du complément : un test vérifie cette équivalence, à l'exception du contrôle d'origine qui reproduit ses anciennes règles `@match`. Le code JavaScript préexistant de la 37.0.3 est vérifié par empreinte après normalisation des fins de ligne. Les modifications des métadonnées sont contrôlées séparément.

Les tests de navigateur injectent le fichier complet dans un contexte isolé, sans profil personnel ni extension. Toutes les requêtes HTTP(S) sont servies par des données fictives. Ils ne contactent pas Twitch et ne remplacent pas un essai avec Violentmonkey et TwitchNoSub.

## Reproduire les contrôles

Avec Node.js 22 ou une version supérieure, depuis la racine du dépôt :

```sh
npm run check
npm test
```

Ces commandes ne demandent aucune dépendance supplémentaire. GitHub Actions les exécute sur les pushes et les pull requests.

Pour les tests de navigateur, installer Playwright comme outil de développement local :

```sh
npm install --no-save --package-lock=false playwright
npm run test:browser
```

Sous Windows, la suite utilise Chrome et Edge s'ils sont présents aux emplacements standards. Sinon, elle utilise le Chromium fourni par Playwright, à installer avec `npx playwright install chromium`. Un navigateur précis peut être choisi avec la variable d'environnement `VAFT_TEST_EXECUTABLE`. `VAFT_TEST_NODE_MODULES` permet d'utiliser une installation existante de Playwright.

La sortie Node compte aussi les deux tests parents : avec Chrome et Edge, **50 tests** correspondent à **48 scénarios et 2 groupes**.

## Ce qui est testé

- Ciblage de la requête XHR GET VAST 3 de pré-roll pour la VOD actuellement affichée.
- Passage inchangé des directs, mid-rolls, bannières, autres domaines, autres formats et données ambiguës ou invalides.
- Réponse XML vide, statut 200, événements natifs, en-têtes personnalisés et type de réponse `document`.
- Annulation avant et après l'envoi, réutilisation d'un XHR, appels synchrones et arguments de la méthode native `open`.
- Navigation VOD → direct → VOD sans rechargement.
- Coexistence du complément et du script intégré dans les deux ordres de chargement, sans empilement des interceptions.
- Conservation des nom, identifiant et URL de mise à jour, de `@grant none` et de l'absence de dépendance distante `@require`.

La réponse locale utilise une URL `data:`. Son `responseURL` est donc local. Une politique CSP interdisant `data:` dans `connect-src` entraîne une erreur native : la suite vérifie cette limite, elle ne la contourne pas. Les captures utilisateur confirment l'acceptation de cette réponse dans la session Twitch testée.

## Pour signaler un problème

Ouvrir une [issue](https://github.com/MATTEO12SA/twitch-vaft-violentmonkey/issues) en précisant la version du script, le navigateur, le gestionnaire, les autres scripts actifs et si le problème concerne un direct ou une VOD. Décrire les étapes et le résultat attendu ; un lien public vers la vidéo peut aider.

Pour une publicité VOD, les informations utiles sont la méthode et le chemin de la requête, son format de réponse, les marqueurs `rt`, `bp` et `pj.v`, et l'effet de l'activation/désactivation du script après rechargement. Ne pas publier de cookies, jetons, URL signées, HAR brut ou en-têtes de connexion. Les tests du dépôt utilisent exclusivement des valeurs fictives.

Un changement doit rester limité au problème reproduit, passer les contrôles et être décrit dans le journal des versions. Les nouveaux formats publicitaires doivent être validés avant d'élargir le ciblage.

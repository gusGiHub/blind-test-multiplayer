# Connexion Spotify et playlists

La connexion permet de parcourir les playlists, en sélectionner une et préparer automatiquement les questions au démarrage. La lecture chez l’hôte et le rythme automatique sont décrits dans [gameplay.md](gameplay.md). Voir aussi docs/game-engine.md pour le moteur de partie.

## Configuration locale

1. Copier `.env.example` vers `.env.local` sans écraser un fichier existant.
2. Renseigner le Client ID de ton application Spotify :

```dotenv
APP_URL=http://127.0.0.1:3000
SPOTIFY_CLIENT_ID=ton_client_id
```

3. Dans Spotify for Developers, enregistrer exactement cette Redirect URI :

```text
http://127.0.0.1:3000/api/spotify/callback
```

4. Ajouter les comptes testeurs à la liste des utilisateurs autorisés dans le tableau de bord Spotify. Vérifier les limites actuelles du mode développement et l’exigence Premium pour le propriétaire de l’application.
5. Redémarrer `npm run dev`, puis utiliser **http://127.0.0.1:3000** pour toute l’application, y compris les parties.
6. Ouvrir `/spotify`, cliquer sur « Connecter mon compte Spotify » et accepter ou refuser la demande dans Spotify.

PKCE ne nécessite pas de Client Secret. Aucun jeton ne doit être ajouté dans une variable `NEXT_PUBLIC_*`, envoyé dans un message ou commité. `.env.local` reste ignoré par Git ; `.env.example` ne contient que des valeurs d’exemple.

`localhost` est refusé par Spotify comme Redirect URI. Les cookies de `localhost` et de `127.0.0.1` sont distincts : une partie créée sur une adresse ne donne pas automatiquement accès à son joueur sur l’autre. Recréer ou rejoindre la partie depuis l’adresse choisie.

En production, définir `APP_URL` sur l’origine HTTPS réellement utilisée. La configuration des origines Socket.IO et le démarrage de production du serveur personnalisé restent à adapter avant déploiement.

## Fonctionnement

- OAuth Authorization Code avec PKCE S256 et `state` aléatoire lié à la session, valable dix minutes et à usage unique.
- Cookie de session HttpOnly existant, créé si nécessaire avant la connexion Spotify.
- Permissions demandées : `playlist-read-private`, `playlist-read-collaborative`, `streaming`, `user-read-email`, `user-read-private` et `user-modify-playback-state`. Le lecteur nécessite les permissions de profil et d’adresse e-mail ; notre code ne demande pas ces données à l’API et ne les conserve pas. Aucune modification de playlist.
- Refresh token et vérificateur PKCE conservés sur le serveur. Le jeton d’accès est aussi transmis en mémoire au SDK dans le navigateur de l’hôte, via une route protégée, pour lire la musique.
- Renouvellement automatique du jeton avant expiration, avec une seule demande de renouvellement simultanée par connexion.
- Liste paginée de vingt playlists ; seules les métadonnées nécessaires à l’écran sont renvoyées.
- Sélection limitée aux playlists réellement récupérées dans la session ; aucun identifiant arbitraire n’est accepté.
- Déconnexion locale supprimant les jetons et la sélection, sans supprimer les joueurs ou la session de jeu. Elle ne révoque pas les autorisations dans Spotify : l’utilisateur peut les retirer dans son compte Spotify.
- Un redémarrage complet du serveur ou l’expiration de la session efface l’accès local. Aucun compte persistant n’est encore créé en base de données.

## Tests automatisés

Exécuter `npm run test:spotify`. Les échanges Spotify sont simulés ; aucun jeton réel ni réseau Spotify n’est utilisé. Les cas couvrent PKCE, state à usage unique, refus de consentement, séparation des sessions, pagination, sélection, déconnexion et renouvellement.

## Vérifications manuelles

- Sans Client ID : message de configuration, sans redirection vers Spotify.
- Avec configuration : demande Spotify puis affichage des playlists.
- Refus du consentement : message clair et possibilité de réessayer.
- Choix d’une playlist puis rechargement : sélection conservée.
- Plus de vingt playlists : bouton « Afficher la suite ».
- Autre navigateur ou navigation privée : aucune connexion ni sélection héritée.
- Déconnexion : disparition de la sélection ; les parties existantes restent accessibles avec leur session.
- Dans les réponses de nos API, vérifier l’absence de `access_token`, `refresh_token` et de vérificateur PKCE.

La validation réelle nécessite un Client ID configuré et un compte Spotify autorisé ; les tests automatisés ne soumettent aucun identifiant réel à Spotify.

## Limite du projet

Premium ne rend pas l’usage de Spotify dans un blind test autorisé : Spotify interdit les intégrations dans les jeux et quiz. Cette étape n’implémente que la connexion et l’exploration des playlists ; elle ne valide pas un futur usage dans le jeu.

Sources officielles :
- https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens
- https://developer.spotify.com/documentation/web-api/concepts/redirect_uri
- https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists
- https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- https://developer.spotify.com/compliance-tips
## Pochettes et morceaux

Les playlists affichent leur pochette, avec un visuel de remplacement si l’image manque ou ne charge pas. Le bouton « Voir les morceaux » charge vingt éléments à la fois ; le bouton de pagination permet de poursuivre. Les titres, artistes, albums et durées sont affichés avec un lien vers Spotify, sans lecteur audio.

Le contenu est demandé via `GET /api/spotify/playlists/[playlistId]/tracks`. La route vérifie la session et refuse les playlists absentes de la liste déjà récupérée pour ce compte. L’API Spotify actuelle utilise `/v1/playlists/{id}/items` et peut refuser les playlists simplement suivies : il faut en être propriétaire ou collaborateur. Le message est affiché dans le panneau concerné.

Les morceaux indisponibles, les fichiers locaux et les contenus non musicaux gardent leur position ; les doublons restent visibles. La fermeture et la réouverture du panneau réutilisent les éléments déjà chargés jusqu’à l’actualisation de la page.

## Aperçu automatique depuis la playlist sélectionnée

Après avoir choisi une playlist dans `/spotify`, sélectionner 5, 10 ou 15 questions, puis cliquer sur « Générer l’aperçu ». Aucune question ni réponse n’est saisie manuellement : chaque morceau tiré produit une question d’identification et une réponse issue de son titre et de ses artistes.

Le serveur parcourt la playlist par pages de cinquante éléments avant le tirage. Il élimine les doublons par identifiant Spotify, les fichiers locaux, les contenus non musicaux, les morceaux indiqués indisponibles et ceux dont les métadonnées de réponse sont incomplètes. La présence des métadonnées ne garantit pas un droit ni une possibilité de lecture audio.

Le tirage utilise `crypto.randomInt` et un mélange partiel sans remise. Si le nombre de morceaux distincts utilisables est insuffisant, une erreur explicite est affichée ; aucun morceau n’est répété pour compléter l’aperçu.

La route `POST /api/spotify/questions/preview` reçoit `{ playlistId, questionCount }`. Elle vérifie l’origine de la requête, la session et la correspondance avec la sélection actuelle. Elle utilise uniquement le jeton du compte connecté et ne renvoie aucun secret. La sélection doit rester la même pendant toute la génération ; une déconnexion ou un changement de playlist invalide le résultat.

Pour borner les appels à Spotify, un aperçu parcourt au plus cent pages (5 000 éléments) et dispose de vingt-cinq secondes au total. Une playlist dépassant la limite est refusée plutôt que de tirer silencieusement dans sa première partie. Les erreurs et quotas Spotify sont conservés dans la réponse. Une seule génération est autorisée à la fois par connexion Spotify.

L’aperçu affiche les réponses et les liens Spotify au demandeur. Il reste un exemple indépendant et ne détermine jamais les questions d’une partie. Le rendu disparaît au rechargement. Aucun aperçu complet n’est diffusé aux joueurs ; le moteur ne révèle que la réponse courante. Cette préparation ne télécharge pas d’extrait et n’ajoute aucune lecture audio.

Vérifier manuellement :

1. Connecter Spotify et choisir une playlist dont le compte est propriétaire ou collaborateur.
2. Demander un aperçu de cinq questions et vérifier les réponses par rapport aux morceaux présents dans cette playlist.
3. Régénérer pour obtenir un nouveau tirage possible ; deux tirages peuvent légitimement partager des morceaux.
4. Essayer une playlist avec moins de cinq morceaux distincts : une erreur doit apparaître, sans questions répétées.
5. Changer de playlist : l’ancien aperçu doit disparaître.

Les tests `npm run test:spotify` couvrent ces cas avec les réponses Spotify simulées, ainsi que le formulaire d’aperçu et les accès entre sessions.
## Tirage propre à chaque lancement

Le démarrage relit les morceaux de la playlist sélectionnée et effectue un nouveau tirage aléatoire, même si un aperçu existe ou si la partie précédente utilisait la même playlist. Il n’est pas nécessaire de générer l’aperçu avant de jouer. Des parties indépendantes peuvent naturellement partager des morceaux ; il n’y a pas d’historique d’exclusion entre les parties.

En QCM, le serveur complète les candidats issus de la playlist avec des recherches Spotify `artist:"nom"`, limitées à dix résultats pour au plus cinq artistes principaux des morceaux tirés. Les résultats de recherche sont filtrés sur les artistes effectivement présents dans leurs métadonnées. Ils servent uniquement de propositions : seuls les morceaux tirés dans la playlist sont joués. Les résultats de recherche sont conservés dix minutes dans la connexion, avec cent artistes au maximum ; ce cache contient des métadonnées, jamais le tirage de la partie.

La préparation reste limitée à vingt-cinq secondes. Chaque recherche supplémentaire dispose de deux secondes. Une erreur de recherche permet un repli sur les candidats de la playlist ; un refus d’accès ou un quota arrête les recherches supplémentaires. Si le réservoir final ne contient pas trois titres distincts hors de tous les morceaux tirés, le démarrage est refusé sans modifier le lobby. Aucune nouvelle permission Spotify n’est demandée. Le mode libre n’effectue pas ces recherches.

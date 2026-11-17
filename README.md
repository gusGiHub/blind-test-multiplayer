# Blind Test Multiplayer

Application de blind test musical multijoueur en temps réel : Next.js (App Router), React, TypeScript, Socket.IO et Tailwind CSS.

## Fonctionnalités

- Création et accès par code de salle, lobby synchronisé et confirmation des joueurs prêts.
- Sélection des playlists Spotify dans le lobby, avec pochettes et consultation des titres.
- Lecture chez l’hôte, extraits et durées configurables, progression automatique.
- QCM modifiable avant validation ou réponse libre avec tolérance limitée aux fautes.
- Barème classique ou bonus de rapidité, corrections après chaque titre ou à la fin.
- Classement, correction personnelle privée et revanche avec les mêmes joueurs.

## Développement local

Utiliser Node.js 24. Après installation des dépendances, copier `.env.example` vers `.env.local` et renseigner le Client ID Spotify. Configurer l’URL de retour selon [le guide Spotify](docs/spotify.md).

```sh
npm run dev
```

Ouvrir [http://127.0.0.1:3000](http://127.0.0.1:3000). L’hôte utilise son lecteur Spotify Premium ; les invités écoutent dans la même pièce. `.env.local` ne doit pas être publié dans le dépôt.

## Vérifications et production

```sh
npm test
npm run lint
npm run build
npm run test:production
```

`npm start` lance le serveur personnalisé compilé en production, avec Socket.IO. L’hébergement doit fournir une origine HTTPS dans `APP_URL` et son port dans `PORT`.

Voir [le guide de déploiement Render](docs/deployment.md) et [render.yaml](render.yaml) pour les commandes, variables et réglages Spotify. Aucune base de données ni installation supplémentaire n’est requise pour cette première version.

## Architecture et limites

- `src/app` : pages, composants et routes HTTP Next.js.
- `src/lib` : moteur de jeu, services, sessions et intégration Spotify.
- `src/server` : relais Socket.IO et progression automatique.
- `server.ts` : serveur HTTP partagé entre Next.js et Socket.IO.
- `tests` : moteur, API, composants, sessions et échanges Socket.IO ; les appels Spotify sont simulés.

Les collections en mémoire appartiennent aux routes Next.js. Socket.IO appelle ces routes et diffuse leurs vues publiques ; les réponses et jetons restent séparés des diffusions publiques.

Cette version utilise une seule instance. Les parties, sessions et connexions Spotify disparaissent après un redémarrage ou une mise en veille. La lecture Spotify réelle nécessite un essai dans un navigateur compatible ; les tests automatisés ne prouvent pas son fonctionnement avec un compte réel.

Documentation : [déroulement du jeu](docs/gameplay.md), [moteur et synchronisation](docs/game-engine.md), [Spotify](docs/spotify.md), [déploiement](docs/deployment.md).

La [charte graphique](docs/charte-graphique.md) décrit les couleurs, composants et règles responsive. Ses valeurs partagées sont définies dans `src/app/design-tokens.css`.

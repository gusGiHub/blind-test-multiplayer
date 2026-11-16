# Démarrage depuis une playlist et progression multijoueur

## Parcours

1. Utiliser `http://127.0.0.1:3000` pour toute l’application.
2. Connecter Spotify dans `/spotify` et sélectionner une playlist accessible dont le compte est propriétaire ou collaborateur.
3. Facultatif : générer un aperçu de 5, 10 ou 15 questions. Les réponses de cet aperçu sont visibles pour le demandeur.
4. Créer une partie avec le même navigateur, puis inviter les joueurs. Une partie déjà créée dans cette session convient aussi.
5. Cliquer sur « Démarrer la partie ». Le serveur effectue toujours un nouveau tirage depuis la playlist, indépendamment de l’aperçu.
6. Révéler les réponses et passer aux questions suivantes avec les commandes de l’hôte, jusqu’à la fin.

Aucun catalogue local ne doit être rempli pour ce parcours. La lecture audio, les réponses, les minuteries et les points sont décrits dans [gameplay.md](gameplay.md).

## Préparation et isolation

L’aperçu conservé dans la session reste un exemple indépendant. Le navigateur ne fournit jamais lui-même les réponses au démarrage et aucun lancement ne réutilise cet aperçu. Chaque partie relit la playlist et tire ses propres questions.

Le démarrage est verrouillé par partie et garde le statut `lobby` tant que la génération ne réussit pas. Il revérifie la session, le compte, la playlist et la partie avant de valider. Une erreur libère le verrou et laisse le lobby intact pour une nouvelle tentative.

Au lancement, le moteur copie les questions. Changer de playlist, régénérer un aperçu ou déconnecter Spotify ne change pas les questions de cette partie déjà lancée. La source et les informations de playlist sont associées à la partie ; la liste des réponses reste privée.

Le catalogue local reste un repli de développement si aucune playlist Spotify n’est sélectionnée et que de vrais extraits locaux existent. S’il est vide, le message invite désormais à connecter Spotify et sélectionner une playlist, sans demander de saisir des morceaux à la main.

## Moteur

- `createGameEngine` tire les questions depuis les extraits locaux de développement.
- `createGameEngineFromSpotifyPreview` copie la sélection préparée, sans refaire le tirage ni inventer de chemin audio local.
- Progression : `question → result → question`, puis `result → finished` après le dernier résultat.
- Les commandes portent le numéro de question pour refuser les actions périmées.
- Une révélation répétée, un saut du résultat ou une action après la fin est refusé sans mutation.

Pendant une question Spotify, l’état public contient le numéro, le total, la consigne et les échéances. Le QCM ajoute quatre propositions sans identifier la bonne ; le mode libre ne transmet aucun titre. Le résultat révèle la correction courante, sauf avec le réglage « Tout à la fin ». Le récapitulatif complet est disponible après la fin. Les réponses futures restent dans la fermeture JavaScript du moteur. Les états locaux peuvent aussi contenir un chemin audio.

## Routes et synchronisation

| Commande Socket.IO | Route API | Diffusion réussie |
| --- | --- | --- |
| `start_game` | `POST /api/games/[code]/start` | `game_started` |
| `reveal_answer` | `POST /api/games/[code]/reveal` | `game_updated` |
| `next_question` | `POST /api/games/[code]/next` | `game_updated` |

Le corps contient `playerId` et, pour révéler ou avancer, `questionNumber`. Les réponses réussies contiennent `{ game, progress }`. Le relais Socket.IO attend jusqu’à 35 secondes pour le démarrage, afin de couvrir la préparation Spotify bornée à 25 secondes, et 10 secondes pour les autres commandes.

`gameCommand.ts` vérifie la propriété du joueur par la session. `gameActions.ts` vérifie le rôle de l’hôte, prépare les questions et synchronise le statut. `gameStore.ts` conserve séparément les moteurs privés et les verrous de préparation. `src/server/gameSockets.ts` autorise l’entrée dans la room, relaie les commandes aux routes et diffuse les états publics sans importer les collections mémoire.

`POST /api/games/[code]/access` récupère `{ game, players, progress }` pour la session autorisée. Les reconnexions retrouvent l’étape courante. Le client ignore les événements plus anciens que son état actuel. La route publique `GET /api/games/[code]` ne renvoie ni progression ni réponses.

Les erreurs sont envoyées par `start_game_error` ou `game_action_error`. Un appel HTTP direct retourne l’état mais ne déclenche pas lui-même de diffusion Socket.IO : le client passe par les commandes socket.

## Vérification

`npm run test:game` vérifie le moteur, les routes, les composants et les gestionnaires avec de vrais clients Socket.IO. `npm test` ajoute les tests Spotify. Les réponses Spotify sont simulées, aucun compte réel n’est utilisé dans ces tests.

Les cas couvrent notamment le démarrage avec une playlist et un catalogue local vide, l’indépendance du tirage par rapport à l’aperçu, les échecs sans perte du lobby, les démarrages concurrents, le changement de playlist pendant la préparation et l’isolation des réponses.

Dans le navigateur : sélectionner une playlist contenant au moins cinq morceaux distincts utilisables, créer une partie de cinq questions et démarrer sans préparer d’aperçu. Vérifier aussi le démarrage après génération d’un aperçu correspondant et le suivi depuis une fenêtre privée.

Le stockage est temporaire : un redémarrage complet efface parties, sessions et connexion Spotify. Le singleton préserve les collections lors de la réévaluation des modules dans le même runtime.

Premium ne supprime pas la restriction Spotify concernant les jeux et quiz ; ce branchement technique ne vaut pas validation de cet usage par Spotify.

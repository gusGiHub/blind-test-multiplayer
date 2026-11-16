# Déployer sur Render

Le projet s’exécute dans **un seul service Node.js**, qui sert Next.js et Socket.IO. Le stockage des salles, joueurs, sessions et jetons Spotify est en mémoire : ne pas activer plusieurs instances. Une mise en veille, un redémarrage ou un déploiement efface ces données. PostgreSQL seul ne partagerait pas les minuteries et sockets entre plusieurs instances.

## Vérifications locales

Avec Node.js 24 et les dépendances déjà installées :

```sh
npm test
npm run lint
npm run build
npm run test:production
```

Le build produit `.next` pour Next et `dist` pour le serveur personnalisé. `npm start` lance ce serveur en production, y compris Socket.IO. `tsx` n’est utilisé qu’en développement. Le test de production lance un processus isolé sur un port disponible avec un Client ID fictif : il vérifie HTTP, cookies sécurisés, page de lobby, WebSocket et construction du retour OAuth. Il ne connecte aucun compte et ne teste pas la lecture Spotify réelle.

## 1. Dépôt GitHub

Créer un dépôt GitHub pour ce projet puis y envoyer les sources, les tests, `package-lock.json`, `render.yaml` et la documentation. Vérifier les fichiers sélectionnés avant le premier commit. `.env.local`, `node_modules`, `.next` et `dist` sont ignorés. Le dépôt peut être privé pour le déploiement, ou public pour le portfolio.

Le dossier contenant `package.json` doit être la racine du service Render. Si le dépôt contient plusieurs projets, définir **Root Directory** sur le dossier de cette application ; sinon laisser ce champ vide.

## 2. Service Render

Dans Render : **New → Web Service**, connecter le dépôt et renseigner :

| Paramètre | Valeur |
| --- | --- |
| Language | Node |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Instances | 1 |

Variables d’environnement :

| Nom | Valeur |
| --- | --- |
| `NODE_VERSION` | `24` |
| `NODE_ENV` | `production` |
| `APP_URL` | L’URL HTTPS exacte du service, par exemple `https://mon-blind-test.onrender.com` |
| `SPOTIFY_CLIENT_ID` | Le Client ID de ton application Spotify |

Render fournit `PORT` ; ne pas le fixer à 3000. `APP_URL` ne contient aucun chemin, paramètre ou fragment. Vérifier l’adresse réellement attribuée après création du service et corriger `APP_URL` si nécessaire, puis redémarrer le service.

Le fichier `render.yaml` décrit ces mêmes réglages pour une création via **Blueprint**. Il ne contient ni identifiant de compte ni valeur Spotify personnelle ; les deux valeurs propres au projet sont demandées par Render. Choisir et vérifier l’offre dans le tableau de bord avant de créer le service. L’offre gratuite peut démarrer lentement après une mise en veille et reste soumise aux limites affichées par Render ; elle peut aussi être insuffisante pour un build selon les ressources disponibles.

## 3. Retour Spotify

Dans Spotify for Developers, dans les paramètres de l’application, ajouter exactement :

```text
https://mon-blind-test.onrender.com/api/spotify/callback
```

Remplacer le domaine par celui réellement utilisé dans `APP_URL`. Conserver le retour local si le développement continue. Aucun Client Secret n’est nécessaire : l’application utilise PKCE. Ne pas envoyer `.env.local` à GitHub ; les valeurs de production se renseignent dans Render. Si les comptes sont restreints par la configuration Spotify de l’application, autoriser les comptes utilisés pour les essais dans son tableau de bord.

## 4. Vérifier après publication

1. Ouvrir `/api/health` : la réponse attendue est `{"status":"ok"}`.
2. Ouvrir l’application en HTTPS, créer une salle puis la rejoindre dans un autre profil de navigateur.
3. Vérifier les joueurs et les statuts « prêt » sans recharger.
4. Connecter Spotify depuis le lobby, vérifier le retour dans la salle, sélectionner une playlist et activer le lecteur.
5. Jouer, vérifier les réponses et scores, puis lancer une revanche et recharger une page.

Un nom de domaine personnalisé doit être ajouté dans Render, reporté dans `APP_URL` et dans l’URL de retour Spotify. Les cookies de l’ancien domaine ne sont pas transférés : se reconnecter depuis la nouvelle adresse.

## Documentation de l’hébergeur

- [Déployer une application Node](https://render.com/docs/deploy-node-express-app)
- [Port, HTTPS et configuration du service](https://render.com/docs/web-services)
- [WebSockets](https://render.com/docs/websocket)
- [Limites de l’offre gratuite](https://render.com/docs/free)

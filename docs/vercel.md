# Déployer sur Vercel avec Supabase

L’interface et les API tournent sur Vercel. PostgreSQL conserve les sessions, la préparation Spotify, les joueurs, les réponses et l’état privé du moteur. Aucun serveur Render ni SDK Supabase supplémentaire n’est nécessaire.

## 1. Préparer Supabase

Créer ou utiliser un projet Supabase. Dans **SQL Editor**, exécuter le fichier [202611190001_game_state.sql](../supabase/migrations/202611190001_game_state.sql). Il crée une table technique et trois fonctions de lecture/écriture protégées. Il ne supprime aucune table existante et peut être exécuté à nouveau.

La table a RLS activé et n’accorde aucun accès aux rôles `anon` et `authenticated`. Les fonctions sont également réservées à `service_role` : les jetons Spotify et les bonnes réponses restent côté serveur. Ne pas créer de politique publique pour cette table.

Récupérer l’URL du projet et sa **clé secrète serveur** (`sb_secret_…`) depuis les paramètres Supabase. La clé publique/publishable/anon ne convient pas. L’ancienne clé JWT `service_role` est aussi acceptée via `SUPABASE_SERVICE_ROLE_KEY`.

## 2. Configurer Vercel

Importer le dépôt avec le preset **Next.js**. Le dossier contenant `package.json` est la racine. `vercel.json` fixe l’installation et le build ; ne pas configurer `npm start` sur Vercel : le serveur personnalisé est réservé à l’hébergement Node classique et au développement local.

Dans **Settings → Environment Variables**, renseigner pour **Production** :

```dotenv
APP_URL=https://blind-test-multiplayer.vercel.app
SPOTIFY_CLIENT_ID=le_client_id_de_l_application_spotify
SUPABASE_URL=https://ton-projet.supabase.co
SUPABASE_SECRET_KEY=ta_cle_secrete_serveur
DATABASE_STATE_NAMESPACE=production
```

Ne jamais préfixer la clé secrète par `NEXT_PUBLIC_`, la mettre dans le code, ni la publier dans Git. L’application appelle Supabase par HTTPS depuis ses fonctions serveur.

Après ajout ou modification des variables, redéployer. La variable `VERCEL=1`, fournie par Vercel, active automatiquement le stockage partagé et la synchronisation HTTP. Aucune valeur supplémentaire n’est nécessaire pour le transport.

Conserver les identifiants de production hors des déploiements Preview. Pour tester une Preview, utiliser une base de test ou un `DATABASE_STATE_NAMESPACE` distinct et une `APP_URL` correspondant exactement à cette Preview, également autorisée dans Spotify. Ne pas partager le namespace de production avec les tests ou le développement.

## 3. Configurer Spotify

Ajouter exactement cette Redirect URI dans Spotify for Developers :

```text
https://blind-test-multiplayer.vercel.app/api/spotify/callback
```

Conserver l’URL de retour locale si nécessaire. Le changement de domaine ne transfère pas les anciens cookies : se reconnecter à Spotify et créer une nouvelle partie depuis Vercel. Les anciennes parties en mémoire sur Render ne sont pas importées.

## 4. Vérifier

1. `/api/health` doit répondre en HTTP 200. Ce contrôle confirme le démarrage, pas à lui seul l’accès à la base.
2. `/api/spotify/status` doit répondre avec `configured: true` ; une erreur 503 indique une configuration Supabase absente, une migration manquante, une clé incorrecte ou une base indisponible.
3. Connecter Spotify, sélectionner une playlist puis recharger : la connexion doit rester présente.
4. Créer une salle et la rejoindre depuis un autre profil de navigateur. Vérifier l’arrivée des joueurs, les statuts prêts et la playlist sans rechargement.
5. Jouer avec des réponses simultanées, attendre les transitions automatiques, vérifier les scores et lancer une revanche.
6. Recharger une page en cours de question : conserver les mêmes cartes, l’échéance et la réponse déjà envoyée.

Les tests `npm run test:serverless` simulent plusieurs instances indépendantes et les RPC PostgreSQL. Ils vérifient la concurrence, OAuth, les transitions, les corrections privées et les erreurs de stockage. Ils ne remplacent pas l’exécution de la migration et un essai sur le vrai projet Supabase, ni l’essai du lecteur Spotify avec un compte Premium.

## Fonctionnement et limites

Sur Vercel, le lobby relit son état environ une fois par seconde, après la fin de la requête précédente. Les commandes passent par les mêmes API authentifiées. La saisie QCM n’est pas réinitialisée par la mise à jour du nombre de réponses. Une coupure temporaire déclenche une nouvelle tentative, sans renvoyer automatiquement une commande.

Les échéances sont enregistrées côté serveur. Une lecture authentifiée de la salle applique une transition arrivée à échéance, une seule fois sous verrou. Aucun minuteur ne doit continuer après la fin d’une fonction Vercel. Si tous les joueurs ferment leur page, la progression reprend à la prochaine lecture ; l’extrait suivant démarre alors avec une nouvelle échéance.

Pour garder cette première migration simple, l’état est un snapshot JSON privé par namespace. Un verrou PostgreSQL avec bail et vérification à l’écriture empêche les mises à jour perdues et les points comptés deux fois. Il se libère après la requête ; après une interruption brutale, il peut mettre jusqu’à 90 secondes à expirer. Une requête qui ne peut pas obtenir le verrou renvoie 503 plutôt qu’une fausse confirmation.

Ce format convient aux essais et à un petit nombre de salles de portfolio. Les appels Spotify lents peuvent retarder d’autres requêtes ; chaque lecture transfère l’état du namespace et les requêtes de synchronisation consomment les quotas Vercel/Supabase. Avant une ouverture à beaucoup de joueurs, séparer les données et verrous par salle/session et utiliser une diffusion des changements adaptée. Cette migration ne prétend pas régler la montée en charge.

Les sessions expirent après huit heures et sont retirées lors de la lecture suivante. Le snapshot a également une expiration logique après huit heures sans requête. Les données expirées peuvent rester physiquement dans la table jusqu’à la prochaine écriture : elles ne constituent pas un historique de parties. Pour effacer immédiatement les données d’un environnement, supprimer uniquement sa ligne `namespace` depuis l’administration Supabase, hors partie active.

Sans variables Supabase et hors Vercel, `npm run dev` conserve le stockage mémoire et Socket.IO. Avec Supabase configuré localement, le transport HTTP est activé ; utiliser un namespace de développement distinct.

Documentation : [fonctions PostgreSQL Supabase](https://supabase.com/docs/guides/database/functions), [clés Supabase](https://supabase.com/docs/guides/getting-started/api-keys), [variables Vercel](https://vercel.com/docs/environment-variables).

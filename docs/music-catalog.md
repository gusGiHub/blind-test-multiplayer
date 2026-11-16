# Catalogue musical local

Le catalogue est défini dans `src/lib/musicCatalog.ts`. Il est volontairement vide : aucun extrait audio ni morceau fictif n’est fourni.

## Ajouter un extrait

1. Préparer un extrait que tu es autorisé à utiliser et à rendre accessible aux joueurs.
2. Créer le dossier `public/audio` et y placer le fichier avec un nom neutre, par exemple `track-001.mp3`.
3. Ajouter une entrée dans le tableau `tracks` de `src/lib/musicCatalog.ts` :

```ts
const tracks: readonly MusicTrack[] = Object.freeze([
    {
        id: "track-001",
        title: "Le titre réel du morceau",
        artist: "Le nom réel de l’artiste",
        audioPath: "/audio/track-001.mp3",
    },
]);
```

Ce bloc est un modèle à renseigner, pas un morceau de démonstration. Chaque identifiant doit être unique. Le chemin `/audio/track-001.mp3` correspond au fichier `public/audio/track-001.mp3` et doit fonctionner directement dans le navigateur.

Utiliser une forme audio prise en charge par les navigateurs visés et préparer les limites de l’extrait dans le fichier lui-même. Conserver la source, la licence et les éventuelles mentions d’attribution avec les ressources du projet.

## Frontière serveur / navigateur

Le moteur appelle `getMusicCatalog()` côté serveur. Le module porte la protection `server-only` de Next.js : son import depuis un composant client est refusé à la compilation.

En réponse libre, le titre et l’artiste restent cachés avant la correction. En QCM, seules les quatre propositions sont transmises, sans indiquer la bonne. Le catalogue complet et les questions futures restent sur le serveur.

Les fichiers de `public/audio` sont publics et téléchargeables sans session. Un nom neutre évite de donner la réponse dans l’URL, mais ne constitue pas une protection contre la triche. Vérifier également que les métadonnées du fichier ne révèlent pas le titre ou l’artiste.

## Rôle actuel

- Le type `MusicTrack` définit un identifiant, un titre, un artiste et un chemin audio local.
- `getMusicCatalog()` est le point d’accès au catalogue ; aucune API publique ne l’expose.
- Le catalogue local sert de source alternative au moteur et de support au développement ; le parcours utilisateur utilise Spotify, sans fichier local à renseigner.
- Le tirage, la validation des réponses et les scores sont implémentés dans le moteur. Le lecteur de l’interface utilise Spotify : il ne lit pas actuellement les fichiers audio locaux.

Le moteur refuse un catalogue insuffisant et les routes conservent le lobby si le lancement échoue. En QCM, prévoir aussi suffisamment de titres distincts hors du tirage pour les trois mauvaises propositions.

Voir [gameplay.md](gameplay.md) pour le parcours actuel et [spotify.md](spotify.md) pour la connexion et la lecture Spotify.

# Charte graphique — Blind Test

## Identité

Une interface de jeu musical : fond crème, aplats vifs, contours noirs et ombres franches. Le logo est une note jaune, dessinée en SVG, sans fond. Les illustrations restent décoratives et ne remplacent pas les libellés des actions.

Les valeurs communes sont définies dans **`src/app/design-tokens.css`**, importé par `globals.css`. Les composants utilisent ces variables pour que la charte soit appliquée dans toute l’application.

## Couleurs

- Fond général : crème `#fff8e9` (`--background`).
- Surfaces et champs : papier `#fffdf6` (`--paper`).
- Texte et contours : noir `#191919` (`--ink`).
- Texte secondaire : gris `#55534c` (`--muted`).
- Action principale : jaune `#ffd43b` (`--yellow`).
- Spotify et accents musicaux : turquoise `#00aa9b` et sa version claire (`--teal`, `--teal-soft`).
- Éléments décoratifs : bleu `#409cde` et rouge `#f34135`.
- Bonne réponse ou état prêt : fond vert clair, texte vert foncé (`--success-bg`, `--success-text`, `--success-border`).
- Mauvaise réponse ou erreur : fond rouge clair, texte rouge foncé (`--error-bg`, `--error-text`, `--error-border`).
- Focus clavier : contour bleu `--accent`, visible même sur les surfaces jaunes.

La couleur n’est jamais le seul indicateur : conserver les libellés, coches et croix. Les cartes non sélectionnées restent neutres pendant la correction.

## Typographie

Geist pour les textes et titres ; Geist Mono pour les codes, durées et compteurs. Utiliser les polices déjà chargées dans `layout.tsx`.

- Titres : graisse 800 à 900, interligne court.
- Boutons : graisse 800, texte centré et retour à la ligne autorisé.
- Champs : au moins 16 px pour éviter le zoom automatique sur mobile.
- Aides : 12 à 14 px, phrases courtes, gris lisible.
- Valeurs numériques : chiffres tabulaires, 28 à 32 px.

Éviter les slogans et les explications répétées. Un libellé précis suffit lorsqu’une action est évidente.

## Formes et espacements

- Contours des contrôles : 2 px (`--border-control`). Actions principales et panneaux : 3 px (`--border-strong`).
- Rayon des contrôles : 12 px ; cartes : 14 px ; panneaux : 22 px.
- Ombre des contrôles : décalage de 4 px, sans flou. Ombre des panneaux : 7 px.
- Échelle d’espacement : 4, 8, 12, 16, 20, 24 et 32 px (`--space-*`).
- Prévoir au moins 20 à 24 px entre actions voisines lorsque leurs ombres sont visibles.
- Garder 32 px entre les cartes QCM et leur bouton de validation, 24 px entre les actions de fin de partie.

## Composants

### Actions et navigation

Utiliser `.btn` avec `.btn-primary` pour l’action principale, `.btn-secondary` pour les autres. Les liens Spotify utilisent `.music-link` ; les liens intégrés à une phrase utilisent `.inline-link`. Ne pas donner à tous les liens la même importance qu’au bouton principal.

Les contrôles principaux mesurent au moins 52 px de haut ; les actions compactes restent à 44 px minimum. Au survol, éclaircir la surface ; à l’appui, rapprocher le bouton de son ombre. Un bouton désactivé perd son ombre et s’atténue. Le focus clavier reste visible.

### Formulaires

- Pseudo, code et réponse libre : champs `.field`, fond papier, contour noir, libellé associé.
- Choix parmi quelques options : `SettingChoices`, cartes radio avec sélection jaune et indicateur rond.
- Durées : `components/NumberField.tsx`, avec boutons moins/plus, chiffre centré et unité « s ». La saisie directe, les flèches du clavier et la validation native restent disponibles.
- Le bouton moins se désactive au minimum ; le plus au maximum. Les valeurs invalides ne sont pas corrigées silencieusement lors de la saisie.
- Les menus déroulants restants reprennent les contours, rayons, focus et couleurs de la charte.

Conserver les contraintes réelles : extrait de 1 à 30 secondes, réponse au moins aussi longue que l’extrait et au plus 120 secondes, pause de 0 à 30 secondes. Le serveur valide toujours ces valeurs.

### Lobby, partie et résultats

Les joueurs, playlists et manches utilisent les mêmes surfaces papier et contours. Le code de salle et le compte à rebours sont mis en évidence en jaune. Les statuts prêts utilisent le vert.

En QCM, montrer la correction sur les quatre cartes : bonne réponse verte, mauvais choix personnel rouge. Le temps et le détail des points apparaissent sous les cartes dans le récapitulatif. En réponse libre, afficher séparément le titre attendu et le texte envoyé.

Les erreurs restent proches de l’action concernée. Les aides et états de chargement ne doivent pas créer de cadres vides.

## Mobile et accessibilité

- À 980 px et moins, placer les informations de salle au-dessus du jeu.
- À 640 px et moins, afficher les réponses QCM sur une colonne.
- Sur mobile, empiler les boutons longs et garder des marges latérales suffisantes pour leurs ombres.
- Les noms, titres et liens longs doivent revenir à la ligne, sans masquer le débordement de la page.
- Utiliser des boutons natifs, des labels associés aux champs et les radios natives pour le clavier.
- Désactiver les transitions lorsque `prefers-reduced-motion` est actif.

## Vérification avant publication

Parcourir accueil, création, accès par code, lobby, Spotify, question et correction. Vérifier à 320, 375, 768 et 1280 px : absence de défilement horizontal, boutons espacés, titres longs et focus visible. Tester les champs de durée avec les boutons, la saisie directe et les flèches ; vérifier les limites et le lien entre temps d’écoute et temps de réponse.

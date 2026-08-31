// MATRICE — routage d'une commune vers le service des impôts fonciers compétent
//
// Fonction pure, sans base ni réseau : on lui donne une commune et le
// référentiel corrigé, elle rend un destinataire ou un motif d'attente. C'est
// le cœur de la décision, donc c'est la partie qui doit être testable seule.
//
// LA RÈGLE, dont tout le reste découle : on n'envoie jamais une demande à une
// boîte dont on n'est pas sûr qu'elle traite le périmètre de la commune.
// Un rabattement silencieux sur « l'autre adresse du département » est pire
// qu'une absence d'envoi : la demande part, personne ne répond, et on croit
// l'avoir faite.
//
// CE QUI CHANGE AVEC corrections.json v4 (19/08/2026)
//
// L'ancienne version décidait par DÉPARTEMENT : un seul service muet suffisait
// à mettre toutes les communes du département en attente, parce que le
// référentiel moissonné ne disait pas quel service couvrait quelle commune.
//
// Le jeu « compétence géographique des services locaux » de la DILA le dit
// désormais, pour les 36 223 communes. La décision devient donc précise à la
// commune. Conséquence chiffrée : 22 452 communes routables là où l'ancienne
// logique en bloquait la quasi-totalité.
//
// La contrepartie est que la forme du fichier a changé. Les services sont
// désignés par leur INDICE dans le tableau `services[]`, et seules les
// communes qui font exception à la règle de leur département sont figées —
// cinq sur 36 223. C'est ce qui fait passer le fichier de 11,4 Mo à 100 ko.
//
// SURCOUCHE DES COMMUNES APPRISES (31/08/2026)
//
// Une commune dont le service compétent a été établi par une RÉPONSE REÇUE est
// enregistrée dans la table `matrice_routage_appris`. Cette table est passée en
// quatrième paramètre par l'appelant — le module reste pur, sans accès base.
// Elle prime sur tout le reste : une réponse effective d'un service est une
// preuve plus forte qu'une exception du référentiel DILA.
//
// CE QUI N'EST PAS ICI
//
// La déduction par voisinage — les cinq communes référencées les plus proches —
// vit dans lib/voisinage.js et est appelée par api/importer.js en SECONDE PASSE,
// sur les seules communes que ce module a mises en attente. C'est un mécanisme
// de rattrapage, pas la règle normale : le garder séparé rend l'ordre lisible,
// et permet de le couper d'un seul endroit.
//
// ORDRE DE RÉSOLUTION
//   0. appris[code]                           -> envoi autorisé, adresse confirmée
//   1. corrections.communesExceptions[code]   -> indices de services
//   2. sinon corrections.departements[dep].services
//   3. un seul service ET son courriel non nul ET aucune réserve non levée
//      -> envoi autorisé
//   4. tout autre cas -> file d'attente. Jamais de rabattement.
//
//

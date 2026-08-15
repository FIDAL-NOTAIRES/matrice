# MATRICE — file d'attente et relances

Livré le 15 août 2026. Met en œuvre la décision de JFD : **on envoie ce qui peut partir**,
et les communes sans destinataire fiable entrent dans une file relancée régulièrement.

## Les quatre fichiers

| Fichier | Rôle |
|---|---|
| `sql/001_matrice_attente.sql` | Schéma Neon : demandes, envois, journal d'audit |
| `lib/jours-ouvres.js` | Calcul J+7 jours ouvrés, fériés mobiles compris |
| `lib/courriel.js` | Dépôt de brouillon via Graph, repli `.eml` |
| `lib/verrou.js` | Contrôle du jeton Entra : ferme l'application déployée |
| `api/relance.js` | Le cron du matin : rappelle ce qui n'est pas parti |
| `api/mettre-en-attente.js` | Entrée en file, sortie de file, abandon |
| `vercel.json` | Déclaration des deux fonctions **et** du cron |
| `package.json` | `type: module` — sans lui, tous les imports échouent |

## À faire avant que ça tourne

1. Jouer la migration : console Neon, onglet SQL Editor, coller
   `sql/001_matrice_attente.sql`. Attendre le `COMMIT`. Rejouable sans risque.
2. Poser les variables d'environnement, **en Production ET en Preview** :

   | Variable | Rôle |
   |---|---|
   | `DATABASE_URL` | chaîne Neon |
   | `CRON_SECRET` | jeton du cron Vercel ; sans lui `/api/relance` rend 401 |
   | `MATRICE_RELANCE_A` | destinataires du rappel interne, séparés par des virgules |
   | `AZURE_TENANT_ID` | tenant FIDAL |
   | `AZURE_CLIENT_ID` | inscription d'application — sert d'audience au verrou |
   | `AZURE_CLIENT_SECRET` | secret client, pour le régime application du cron |
   | `MATRICE_BOITE_SERVICE` | UPN de la boîte où le cron dépose ses rappels |

3. Côté Entra, l'inscription d'application a besoin de `Mail.ReadWrite`
   **en permission d'application** (consentement administrateur) pour que le cron
   dépose dans la boîte de service, et de `Mail.ReadWrite` **déléguée** pour que
   l'envoi depuis l'écran parte de la boîte du collaborateur.

## Le verrou

`lib/verrou.js` refuse tout appel sans jeton valide du tenant. Il vérifie
l'audience et l'émetteur, pas seulement la signature : un jeton émis pour une
autre application du même tenant est parfaitement valide et ne doit pas ouvrir
celle-ci. Si les variables `AZURE_*` manquent, il rend **503**, pas 200 — une
variable oubliée ne doit jamais se traduire par « tout le monde entre ».

Enveloppez chaque route ainsi :

```js
import { protege, auteurDepuis } from '../lib/verrou.js';
export default protege(async (req, res, utilisateur, jetonDelegue) => { … });
```

Le jeton délégué est passé plus loin pour que le brouillon soit déposé dans la
boîte du collaborateur et que le journal porte son nom, plutôt que « MATRICE ».

⚠️ `api/relance.js` n'est **pas** enveloppé : il est appelé par le cron, qui n'a
pas d'utilisateur. Il est protégé autrement, par `CRON_SECRET`.

## Ce que le code garantit, et pourquoi

**Une demande sans destinataire ne peut pas être marquée envoyée.** C'est une contrainte
`CHECK` en base, pas un test applicatif. La règle « jamais de rabattement sur une autre
boîte » est trop importante pour dépendre d'une ligne de JavaScript qu'un futur correctif
pourrait déplacer.

**Le journal est en écriture seule.** Un trigger refuse `UPDATE` et `DELETE`. Un dossier
d'audit dont on peut réécrire l'historique ne vaut rien.

**Aucun extrait reçu n'est stocké.** Le bloc confidentialité du Cerfa impose de ne pas
conserver les informations communiquées : la base enregistre le fait de la demande et de
la réponse, le contenu va au dossier client.

**Une relance par dossier, pas une par commune.** Sept courriels pour sept communes du même
dossier, personne ne les lit.

**Le cron est authentifié.** Sans l'en-tête signé de Vercel, `/api/relance` serait un bouton
« relancer tout le monde » ouvert sur l'internet.

## Le rythme

J+7 jours ouvrés, le même que celui des pièces — inutile d'avoir deux calendriers dans la
maison. Les fériés mobiles sont calculés depuis Pâques, jamais tabulés : une table finit
par manquer une année, et l'erreur ne se voit pas — le rappel tomberait un jour trop tôt,
sans rien signaler.

Vérifié sur le cas réel : un envoi le lundi 17 août 2026 relance le **26 août**, puis les
**4, 15, 24 septembre** et le **5 octobre**. Ce sont les dates portées à l'écran
récapitulatif.

Réserve connue : l'Alsace-Moselle (57, 67, 68) ajoute le Vendredi saint et le 26 décembre.
Ils ne sont pas comptés, la relance étant un rappel interne à l'office, à Paris. Si un jour
elle devait se caler sur le calendrier du service destinataire, il faudrait les ajouter.

## Le cron

`0 6 * * 1-5` — 6 h UTC, du lundi au vendredi. Le rappel est donc dans la boîte avant
l'arrivée au bureau, et jamais le week-end.

## Le courriel

`deposerBrouillon()` **dépose**, il n'envoie jamais. La machine propose, l'humain
relit et clique. Si Graph est indisponible ou mal configuré, la fonction ne lève
pas : elle rend un `.eml` conforme, à ouvrir dans Outlook — le comportement de
COUNTDOWN. On ne perd pas un envoi parce qu'un jeton a expiré.

Le repli écrit un `console.warn`. Si tous les brouillons partent en `.eml`
pendant trois semaines, il faut que ça se voie ailleurs qu'à l'œil.

Le `.eml` a été vérifié en relisant le message produit avec un parseur
indépendant : objet accentué, corps UTF-8 et pièce jointe PDF restitués à
l'identique.

## Ce qui reste à faire

- Envelopper `api/mettre-en-attente.js` avec `protege()` — c'est une ligne, mais
  elle n'est pas encore posée, la route est ouverte en l'état.
- Poser le verrou côté écran : acquisition du jeton MSAL dans le navigateur.
- Les deux PNG signature et cachet, en variables d'environnement base64.

## Ordre de déploiement

Comme pour PAINT et REDPAR : **la migration d'abord, le code ensuite**. Une fonction qui
écrit dans une table absente échoue en silence côté cron — personne ne remarque un rappel
qui n'arrive pas.

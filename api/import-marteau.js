// MATRICE — POST /api/import-marteau
//
// LA PORTE MACHINE, ET RIEN D'AUTRE.
//
// MARTEAU photographie un portefeuille, en tire une liste de communes, et veut
// savoir vers quels services les matrices seront demandées. Ce calcul vit dans
// MATRICE — routage, référentiel, déduction par voisinage, apprentissage — et
// nulle part ailleurs. MARTEAU appelle donc, il ne recopie pas.
//
// Cette route existe pour que ce raccord n'ait pas à emprunter le verrou des
// humains : elle a son propre secret (lib/verrou-machine.js), qui n'ouvre
// qu'elle. Le verrou de recette MATRICE_MOT_DE_PASSE reste absent, et doit le
// rester — il ouvrirait tout.
//
// SIMULATION FORCÉE. Ce que l'appelant a mis dans `simulation` n'est pas lu :
// la route l'impose. Engager un portefeuille dans la file — donc préparer des
// courriels au nom de l'office — reste un geste fait dans MATRICE, à l'écran,
// sous Entra, par un humain qui voit ce qu'il engage. La sécurité tient ainsi à
// la ROUTE, pas à ce que l'appelant a bien voulu envoyer.
//
// La logique d'import n'est pas dupliquée : c'est celle d'api/importer.js,
// exportée sous le nom `executerImport`. Une règle écrite en deux endroits
// dérive.

import { protegeMachine } from '../lib/verrou-machine.js';
import { executerImport } from './importer.js';

export default protegeMachine(async (req, res, appelant) => {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  const recu = req.body || {};

  // On écrase, on ne complète pas : `simulation: false` envoyé par erreur (ou
  // par quelqu'un qui aurait le jeton) ne doit rien pouvoir écrire.
  req.body = { ...recu, simulation: true };

  // En simulation rien n'est journalisé en base — la trace de qui a demandé quoi
  // n'existe donc que dans les journaux Vercel. Elle y est.
  console.log('[MATRICE] import-marteau', {
    auteur: appelant.auteur,
    dossier: recu.dossier || null,
    societe: recu.societe || null,
    communes: Array.isArray(recu.communes) ? recu.communes.length : 0,
  });

  // `executerImport` lit l'auteur par `auteurDepuis(utilisateur)`, qui rend
  // l'UPN tel quel quand il est présent. On lui passe donc « marteau:ND » comme
  // UPN : c'est exactement ce qu'on veut voir au journal le jour où cette route
  // écrirait — et aujourd'hui, en simulation, cela n'écrit rien.
  return executerImport(req, res, { upn: appelant.auteur });
});

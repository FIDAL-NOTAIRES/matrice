// MATRICE — verrou machine (raccord MARTEAU → MATRICE)
//
// POURQUOI UN SECOND VERROU
//
// lib/verrou.js ferme MATRICE aux HUMAINS : jeton Entra en production, mot de
// passe partagé en recette. Ces deux modes ouvrent TOUTE l'application — les
// envois sous le timbre de l'office compris. Les donner à une machine pour lui
// permettre de faire router un portefeuille serait accorder mille fois trop.
//
// D'où un secret SÉPARÉ, qui n'ouvre QU'UNE porte : /api/import-marteau, en
// simulation. S'il fuite, l'inconnu fait calculer un routage. Il n'écrit rien,
// n'envoie rien, ne lit aucun dossier. C'est tout l'intérêt de ne pas réutiliser
// MATRICE_MOT_DE_PASSE ici : le verrou de recette, lui, reste absent, et doit
// le rester.
//
// La règle Entra / recette n'est PAS recopiée ici : ce fichier ne connaît qu'un
// secret machine et rien d'autre. Deux verrous distincts pour deux portes
// distinctes, ce n'est pas la même règle écrite deux fois.
//
// Si MATRICE_JETON_MARTEAU est absent, on rend 503. Jamais 200 : une variable
// oubliée ne doit pas se traduire par « tout le monde entre ».

import { timingSafeEqual } from 'crypto';

// Un secret machine se colle une fois dans deux consoles et ne se retient pas :
// il n'y a aucune raison qu'il soit court. En refuser un court à la lecture
// évite qu'un « test » posé un soir devienne le secret de production.
const LONGUEUR_MINIMALE = 24;

const jetonAttendu = () => process.env.MATRICE_JETON_MARTEAU;

/** Comparaison à durée constante : une comparaison naïve fuit le secret caractère par caractère. */
function memeSecret(fourni, attendu) {
  const a = Buffer.from(String(fourni));
  const b = Buffer.from(String(attendu));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Vérifie un appel machine.
 * @returns {{ok:true, appelant:{auteur:string, initiales:string}}
 *          |{ok:false, statut:number, motif:string}}
 */
export function verifierMachine(req) {
  const attendu = jetonAttendu();

  if (!attendu) {
    return {
      ok: false, statut: 503,
      motif: 'raccord machine non configuré (MATRICE_JETON_MARTEAU absente)',
    };
  }
  if (String(attendu).length < LONGUEUR_MINIMALE) {
    return {
      ok: false, statut: 503,
      motif: `secret machine trop court (${LONGUEUR_MINIMALE} caractères au moins)`,
    };
  }

  const jeton = req.headers?.['x-matrice-jeton'];
  if (!jeton) {
    return { ok: false, statut: 401, motif: 'jeton machine absent (en-tête x-matrice-jeton)' };
  }
  if (!memeSecret(jeton, attendu)) {
    return { ok: false, statut: 401, motif: 'jeton machine incorrect' };
  }

  // L'appelant est une machine, mais quelqu'un a cliqué. On exige ses initiales :
  // « MARTEAU a demandé ce routage » ne dit rien d'utile six mois après, alors
  // que « marteau:ND » se relit.
  const initiales = String(req.headers?.['x-matrice-auteur'] || '').trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(initiales)) {
    return {
      ok: false, statut: 400,
      motif: 'initiales du demandeur requises (en-tête x-matrice-auteur, 2 à 4 lettres)',
    };
  }

  return { ok: true, appelant: { initiales, auteur: `marteau:${initiales}` } };
}

/**
 * Enveloppe un handler machine. Le handler reçoit (req, res, appelant).
 *
 * Aucun en-tête CORS n'est posé, volontairement : cette porte est faite pour un
 * serveur, pas pour un navigateur. Un secret qui doit traverser un navigateur
 * n'est plus un secret.
 */
export function protegeMachine(handler) {
  return async (req, res) => {
    const v = verifierMachine(req);
    if (!v.ok) return res.status(v.statut).json({ erreur: v.motif });
    res.setHeader('X-Matrice-Mode', 'machine');
    return handler(req, res, v.appelant);
  };
}

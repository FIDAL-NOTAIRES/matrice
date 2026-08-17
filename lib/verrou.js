// MATRICE — verrou d'accès
//
// L'application appose la signature et le cachet du notaire côté serveur, puis
// adresse des demandes à l'administration au nom d'un client. Une URL ouverte,
// c'est un inconnu qui déclenche des envois sous ce timbre. Le dépôt privé n'y
// change rien : c'est l'application déployée qu'il faut fermer, pas le code.
//
// DEUX MODES, dans cet ordre de préférence.
//
//   1. JETON ENTRA — le mode de production. On vérifie l'audience et l'émetteur,
//      pas seulement la signature : un jeton émis pour une AUTRE application du
//      même tenant est un jeton parfaitement valide, et ne doit pas ouvrir
//      celle-ci. L'auteur vient du jeton, personne ne le déclare.
//
//   2. MOT DE PASSE PARTAGÉ — le mode de recette, en attendant l'inscription
//      Entra. L'auteur est déclaré par l'appelant, ce qui suffit : le journal
//      sert à reconstituer un dossier, pas à établir qui engage l'office —
//      c'est la signature du notaire qui le fait, et elle vient après.
//
//      Réserve à tenir : un mot de passe partagé ne se révoque pas personne par
//      personne. Acceptable le temps d'une recette, pas au-delà. Pour le
//      désactiver, supprimer la variable MATRICE_MOT_DE_PASSE — le code n'a pas
//      à être touché.
//
// Si AUCUN des deux n'est configuré, on rend 503. Jamais 200 : une variable
// oubliée ne doit pas se traduire par « tout le monde entre ».

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { timingSafeEqual } from 'crypto';

const tenant = () => process.env.AZURE_TENANT_ID;
const audience = () => process.env.AZURE_CLIENT_ID;
const passeAttendu = () => process.env.MATRICE_MOT_DE_PASSE;

let jwks = null;
function clefs() {
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenant()}/discovery/v2.0/keys`),
      { cacheMaxAge: 10 * 60 * 1000 },
    );
  }
  return jwks;
}

/** Comparaison à durée constante : une comparaison naïve fuit le mot de passe caractère par caractère. */
function memeSecret(fourni, attendu) {
  const a = Buffer.from(String(fourni));
  const b = Buffer.from(String(attendu));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Vérifie l'appel.
 * @returns {Promise<{ok:true, mode:'entra'|'recette', utilisateur:object, jeton:string|null}
 *                  |{ok:false, statut:number, motif:string}>}
 */
export async function verifier(req) {
  const entraConfigure = Boolean(tenant() && audience());
  const passeConfigure = Boolean(passeAttendu());

  if (!entraConfigure && !passeConfigure) {
    return {
      ok: false, statut: 503,
      motif: 'verrou non configuré (AZURE_TENANT_ID / AZURE_CLIENT_ID, ou MATRICE_MOT_DE_PASSE)',
    };
  }

  // ------------------------------------------------------------ mode Entra
  const entete = req.headers?.authorization || '';
  if (entraConfigure && entete.startsWith('Bearer ')) {
    const jeton = entete.slice(7);
    try {
      const { payload } = await jwtVerify(jeton, clefs(), {
        audience: audience(),
        issuer: [
          `https://login.microsoftonline.com/${tenant()}/v2.0`,
          `https://sts.windows.net/${tenant()}/`, // jetons v1, encore émis par certains clients
        ],
        clockTolerance: 60,
      });

      if (payload.tid !== tenant()) {
        return { ok: false, statut: 403, motif: 'jeton émis par un autre tenant' };
      }

      return {
        ok: true, mode: 'entra', jeton,
        utilisateur: {
          upn: payload.preferred_username || payload.upn || null,
          nom: payload.name || null,
          oid: payload.oid || null,
        },
      };
    } catch (e) {
      return { ok: false, statut: 401, motif: `jeton invalide : ${e.code || e.message}` };
    }
  }

  // ---------------------------------------------------------- mode recette
  if (passeConfigure) {
    const passe = req.headers?.['x-matrice-passe'];
    if (!passe) {
      return {
        ok: false, statut: 401,
        motif: entraConfigure
          ? 'jeton absent'
          : 'mot de passe absent (en-tête x-matrice-passe)',
      };
    }
    if (!memeSecret(passe, passeAttendu())) {
      return { ok: false, statut: 401, motif: 'mot de passe incorrect' };
    }

    // En mode recette l'auteur est déclaré. On l'exige quand même : une ligne
    // de journal sans auteur ne vaut rien, et « inconnu » se remarque.
    const auteur = String(req.headers?.['x-matrice-auteur'] || '').trim().toUpperCase();
    if (!/^[A-Z]{2,4}$/.test(auteur)) {
      return {
        ok: false, statut: 400,
        motif: 'initiales requises en mode recette (en-tête x-matrice-auteur, 2 à 4 lettres)',
      };
    }

    return {
      ok: true, mode: 'recette', jeton: null,
      utilisateur: { upn: null, nom: null, oid: null, initiales: auteur },
    };
  }

  return { ok: false, statut: 401, motif: 'jeton absent' };
}

/**
 * Enveloppe un handler. Le handler reçoit (req, res, utilisateur, jetonDelegue).
 * Le jeton est passé plus loin pour que le brouillon soit déposé dans la boîte
 * du collaborateur ; en mode recette il vaut null, et lib/courriel.js bascule
 * alors sur le repli .eml.
 */
export function protege(handler) {
  return async (req, res) => {
    const v = await verifier(req);
    if (!v.ok) return res.status(v.statut).json({ erreur: v.motif });
    res.setHeader('X-Matrice-Mode', v.mode);
    return handler(req, res, v.utilisateur, v.jeton);
  };
}

/**
 * Auteur pour la colonne `auteur` du journal.
 *
 * En mode Entra, l'UPN — unique, et qui évite la collision d'initiales « ND »
 * (Diradourian ou Deblecker) toujours non tranchée au mémo MARTEAU.
 * En mode recette, les initiales déclarées, préfixées pour que la lecture du
 * journal distingue d'un coup d'œil ce qui a été authentifié de ce qui a été
 * affirmé.
 */
export function auteurDepuis(utilisateur) {
  if (utilisateur?.upn) return utilisateur.upn;
  if (utilisateur?.initiales) return `recette:${utilisateur.initiales}`;
  return utilisateur?.oid || 'inconnu';
}

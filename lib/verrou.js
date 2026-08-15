// MATRICE — verrou d'accès
//
// L'application appose la signature et le cachet du notaire côté serveur, puis
// adresse des demandes à l'administration au nom d'un client. Une URL ouverte,
// c'est un inconnu qui déclenche des envois sous ce timbre. Le dépôt privé n'y
// change rien : c'est l'application déployée qu'il faut fermer, pas le code.
//
// Le verrou vérifie un jeton Microsoft Entra du tenant FIDAL. Deux contrôles
// que l'on oublie souvent, et qui rendent le reste inutile s'ils manquent :
//   • l'audience — un jeton émis pour une AUTRE application du même tenant est
//     un jeton parfaitement valide, et ne doit pas ouvrir celle-ci ;
//   • l'émetteur — dont le tenant, sinon n'importe quel compte Microsoft
//     personnel du monde entier présente un jeton signé et bien formé.
//
// Dépendance : `jose` (npm i jose). Vérifier une signature RS256 à la main
// est faisable et c'est exactement le genre de code qu'on écrit une fois,
// mal, et qu'on ne relit jamais.

import { createRemoteJWKSet, jwtVerify } from 'jose';

const tenant = process.env.AZURE_TENANT_ID;
const audience = process.env.AZURE_CLIENT_ID;

let jwks = null;
function clefs() {
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`),
      { cacheMaxAge: 10 * 60 * 1000 },
    );
  }
  return jwks;
}

/**
 * Vérifie le jeton porté par la requête.
 * @returns {Promise<{ok:true, utilisateur:{upn,nom,oid},jeton:string}|{ok:false,statut:number,motif:string}>}
 */
export async function verifier(req) {
  if (!tenant || !audience) {
    // Refus franc plutôt qu'ouverture silencieuse : une variable oubliée ne
    // doit jamais se traduire par « tout le monde entre ».
    return { ok: false, statut: 503, motif: 'verrou non configuré (AZURE_TENANT_ID / AZURE_CLIENT_ID)' };
  }

  const entete = req.headers?.authorization || '';
  if (!entete.startsWith('Bearer ')) return { ok: false, statut: 401, motif: 'jeton absent' };
  const jeton = entete.slice(7);

  try {
    const { payload } = await jwtVerify(jeton, clefs(), {
      audience,
      issuer: [
        `https://login.microsoftonline.com/${tenant}/v2.0`,
        `https://sts.windows.net/${tenant}/`, // jetons v1, encore émis par certains clients
      ],
      clockTolerance: 60,
    });

    if (payload.tid !== tenant) {
      return { ok: false, statut: 403, motif: 'jeton émis par un autre tenant' };
    }

    return {
      ok: true,
      jeton,
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

/**
 * Enveloppe un handler. Le handler reçoit (req, res, utilisateur, jetonDelegue) :
 * le jeton est passé plus loin pour que le brouillon soit déposé dans la boîte
 * du collaborateur, et que la piste d'audit porte son nom plutôt que « MATRICE ».
 */
export function protege(handler) {
  return async (req, res) => {
    const v = await verifier(req);
    if (!v.ok) return res.status(v.statut).json({ erreur: v.motif });
    return handler(req, res, v.utilisateur, v.jeton);
  };
}

/**
 * Initiales du collaborateur, pour la colonne `auteur` du journal.
 * Rappel du mémo MARTEAU : la liste COLLABS_INITIALES est au format
 * « XX — Prénom Nom », et la collision « ND » (Diradourian ou Deblecker)
 * n'est toujours pas tranchée. Tant qu'elle ne l'est pas, on journalise
 * l'UPN, qui lui est unique.
 */
export function auteurDepuis(utilisateur) {
  return utilisateur?.upn || utilisateur?.oid || 'inconnu';
}

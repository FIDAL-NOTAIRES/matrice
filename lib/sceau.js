// MATRICE — la signature manuscrite, scellée
//
// Le fac-similé de la signature d'un notaire et l'empreinte de son cachet ne
// sont pas des données de configuration : ce sont les marques qui engagent
// l'office. Les ranger en clair dans une variable d'environnement revient à
// dire que quiconque accède un jour à la configuration peut signer à sa place.
//
// On les range donc CHIFFRÉES. La phrase secrète n'est pas un mot de passe
// qu'on vérifie — c'est la clé qui déchiffre. Sans elle, la variable ne
// contient qu'un bloc inexploitable : ni le dépôt, ni Vercel, ni personne
// ayant lu la configuration ne peut reconstituer l'image.
//
// Elle n'est jamais stockée, jamais journalisée, jamais renvoyée. Elle arrive
// avec la demande d'envoi, sert à dériver la clé, et disparaît avec la requête.
//
// Le scellement se fait sur le poste, hors ligne, par outils/sceller-signature.html
// — l'image en clair ne quitte donc jamais la machine du notaire.
//
// Format du bloc (base64) :
//   « MATRICE1 » (8 octets) | sel (16) | vecteur (12) | chiffré + sceau GCM
//
// PBKDF2-SHA256, 600 000 itérations, AES-256-GCM. Ces paramètres sont les
// mêmes des deux côtés : les changer ici rendrait illisibles les blocs déjà
// scellés. C'est à cela que sert le nombre « 1 » dans l'en-tête.

import { pbkdf2Sync, createDecipheriv } from 'crypto';

const MAGIE = Buffer.from('MATRICE1', 'ascii');
export const ITERATIONS = 600_000;
const TAILLE_SEL = 16;
const TAILLE_VECTEUR = 12;
const TAILLE_SCEAU = 16;

/**
 * Déchiffre un bloc scellé.
 * @throws {Error} phrase fausse, bloc altéré, ou format inconnu — sans distinguer
 *   lequel : la différence n'aiderait qu'à deviner.
 */
export function descelle(bloc, phrase) {
  const brut = Buffer.from(String(bloc).replace(/\s+/g, ''), 'base64');

  if (brut.length < MAGIE.length + TAILLE_SEL + TAILLE_VECTEUR + TAILLE_SCEAU
      || !brut.subarray(0, MAGIE.length).equals(MAGIE)) {
    throw new Error('bloc scellé illisible : en-tête absent ou tronqué');
  }

  let i = MAGIE.length;
  const sel = brut.subarray(i, i += TAILLE_SEL);
  const vecteur = brut.subarray(i, i += TAILLE_VECTEUR);
  const reste = brut.subarray(i);
  const sceau = reste.subarray(reste.length - TAILLE_SCEAU);
  const chiffre = reste.subarray(0, reste.length - TAILLE_SCEAU);

  const cle = pbkdf2Sync(String(phrase), sel, ITERATIONS, 32, 'sha256');
  const dechiffreur = createDecipheriv('aes-256-gcm', cle, vecteur);
  dechiffreur.setAuthTag(sceau);

  // Si la phrase est fausse, final() lève : le sceau GCM ne concorde pas.
  // On ne rend donc jamais une image « à peu près » déchiffrée.
  return Buffer.concat([dechiffreur.update(chiffre), dechiffreur.final()]);
}

/** Présence des blocs, sans jamais les déchiffrer. */
export function sceauConfigure() {
  return {
    signature: Boolean(process.env.MATRICE_SIGNATURE_SCELLEE),
    cachet: Boolean(process.env.MATRICE_CACHET_SCELLE),
  };
}

/**
 * Les images à apposer sur le Cerfa.
 *
 * Trois issues, et une seule est une erreur :
 *   • aucun bloc configuré        → formulaires non signés, c'est l'état de recette
 *   • bloc présent, phrase absente → formulaires non signés, choix délibéré de l'appelant
 *   • bloc présent, phrase fausse  → REFUS. Rendre des formulaires non signés parce que
 *     la phrase était mal tapée ferait partir à l'administration des demandes que
 *     leur auteur croit signées.
 *
 * @param {string|undefined} phrase
 * @returns {{etat:'non_configure'|'sans_phrase'|'signe', images:{signature?:Buffer,cachet?:Buffer}}}
 * @throws {Error} avec .phraseFausse = true si le déchiffrement échoue
 */
export function imagesScellees(phrase) {
  const presents = sceauConfigure();
  if (!presents.signature && !presents.cachet) {
    return { etat: 'non_configure', images: {} };
  }
  if (!phrase) {
    return { etat: 'sans_phrase', images: {} };
  }

  const images = {};
  try {
    if (presents.signature) images.signature = descelle(process.env.MATRICE_SIGNATURE_SCELLEE, phrase);
    if (presents.cachet) images.cachet = descelle(process.env.MATRICE_CACHET_SCELLE, phrase);
  } catch (e) {
    const erreur = new Error('phrase de signature refusée : le bloc scellé n’a pas pu être ouvert');
    erreur.phraseFausse = true;
    throw erreur;
  }

  // Un PNG commence par 89 50 4E 47. Une phrase fausse aurait déjà été
  // arrêtée par le sceau GCM ; ceci n'attrape qu'un bloc scellé par erreur
  // à partir d'un JPEG, que pdf-lib refuserait plus loin avec un message
  // incompréhensible.
  for (const [nom, img] of Object.entries(images)) {
    if (img.length < 8 || img[0] !== 0x89 || img[1] !== 0x50) {
      throw new Error(`le bloc « ${nom} » ne contient pas un PNG`);
    }
  }

  return { etat: 'signe', images };
}

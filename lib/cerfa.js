js
// MATRICE — remplissage du Cerfa 11565*04 / imprimé 6815-EM-SD
//
// Le formulaire comporte de vrais champs AcroForm : pas de calage de
// coordonnées pour le texte, setText() suffit. Les pointillés à l'écran
// laissaient croire le contraire — c'est le piège noté en annexe du mémo
// du 29 juillet, et il a déjà coûté une demi-journée.
//
// Le gabarit vierge n'est pas dans ce fichier : il se dépose une fois dans
// data/6815-em-sd_31.pdf. Il vient de
// https://www.impots.gouv.fr/sites/default/files/formulaires/6815-em-sd/2012/6815-em-sd_31.pdf
//
// La signature et le cachet ne sont PAS des champs du formulaire — ils
// n'existent pas. On les dessine en image, dans la zone mesurée, et
// uniquement côté serveur : un fac-similé de sceau notarial servi en
// statique serait téléchargeable par quiconque devine l'URL.

import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'fs';
import { join } from 'path';

// Zone libre sous « Signature du demandeur », mesurée sur le gabarit.
// Repère PDF : origine en bas à gauche, page A4 595 × 842 pt.
export const ZONE_SIGNATURE = { x: 385, y: 18, largeur: 172, hauteur: 88 }; // ≈ 6,1 × 3,1 cm

const CM = 28.3465; // points par centimètre
export const CACHET_MAX_CM = 3; // un cachet rond de 4 cm ne rentre pas

let gabarit = null;
function lireGabarit() {
  if (!gabarit) {
    gabarit = readFileSync(join(process.cwd(), 'data', '6815-em-sd_31.pdf'));
  }
  return gabarit;
}

/**
 * @param {object} d
 *   demandeur   {nom, adresse, codePostal, commune}
 *   mandant     string|null — « le cas échéant, mandaté par »
 *   departement string — département de situation des biens
 *   commune     string — commune ou arrondissement de situation
 *   inscrit     {ligne1, ligne2} — cadre 2, la personne inscrite à la matrice
 *   date        Date
 *   images      {signature?: Buffer|string, cachet?: Buffer|string} PNG, base64 accepté
 * @returns {Promise<Uint8Array>}
 */
export async function remplirCerfa(d) {
  const pdf = await PDFDocument.load(lireGabarit());
  const form = pdf.getForm();

  const poser = (nom, valeur) => {
    if (valeur === undefined || valeur === null || valeur === '') return;
    try { form.getTextField(nom).setText(String(valeur)); }
    catch { throw new Error(`champ « ${nom} » absent du gabarit — le millésime a-t-il changé ?`); }
  };

  // Le demandeur, c'est l'office.
  poser('a1', d.demandeur?.nom);
  poser('a2', d.demandeur?.adresse);
  poser('a3', d.demandeur?.codePostal);
  poser('a4', d.demandeur?.commune);

  // Le mandant. C'est lui qui rend le plafond de l'article L. 107 A inopposable :
  // sans cette mention, la demande redevient un accès ponctuel de tiers.
  poser('a4b', d.mandant);

  poser('a5', d.departement);
  poser('a6', d.commune);

  // Cadre 1 — section, plan, adresse, lots : délibérément vides.
  // Il n'accepte qu'une seule parcelle, alors que la matrice s'interroge par
  // compte. Le laisser vide ramène TOUS les biens du titulaire dans la commune,
  // ce qui est exactement le besoin. Il n'existe pas de champ a7.
  //   a8, a9, a10, a11 — ne rien poser.

  // Cadre 2 — la personne inscrite à la matrice.
  poser('a12', d.inscrit?.ligne1);
  poser('a13', d.inscrit?.ligne2);

  // Les DEUX cases. Le formulaire l'autorise expressément (« cochez l'une des
  // deux cases ou bien les deux cases »). Cocher cac1 seule ne ramènerait que
  // la propriété exclusive : toutes les indivisions passeraient à la trappe.
  cocher(form, 'cac1');
  cocher(form, 'cac2');

  const date = d.date instanceof Date ? d.date : new Date();
  poser('a14', String(date.getUTCDate()).padStart(2, '0'));
  poser('a15', String(date.getUTCMonth() + 1).padStart(2, '0'));
  poser('a16', String(date.getUTCFullYear()));

  // Le champ « Enregister sous » est un bouton JavaScript du formulaire, et sa
  // faute de frappe est d'origine. On n'y touche pas, et surtout on ne la
  // corrige pas : le nom doit rester tel quel pour correspondre au gabarit.

  await apposer(pdf, d.images || {});

  // En dernier, toujours : sans aplatissement, le service reçoit un formulaire
  // encore modifiable, avec le cachet dessus.
  form.flatten();
  return pdf.save();
}

function cocher(form, nom) {
  try { form.getCheckBox(nom).check(); }
  catch { throw new Error(`case « ${nom} » absente du gabarit`); }
}

/** Signature et cachet, côte à côte dans la zone mesurée. */
async function apposer(pdf, images) {
  const page = pdf.getPages()[0];
  const z = ZONE_SIGNATURE;

  const sig = await charger(pdf, images.signature);
  const cac = await charger(pdf, images.cachet);
  if (!sig && !cac) return; // recette sans images : le formulaire sort non signé, et c'est visible

  // Le cachet à droite, plafonné à 3 cm ; la signature occupe ce qui reste.
  const largeurCachet = cac ? Math.min(CACHET_MAX_CM * CM, z.largeur * 0.5) : 0;
  const largeurSig = z.largeur - largeurCachet - (cac && sig ? 6 : 0);

  if (sig) dessiner(page, sig, z.x, z.y, largeurSig, z.hauteur);
  if (cac) dessiner(page, cac, z.x + z.largeur - largeurCachet, z.y, largeurCachet, z.hauteur);
}

async function charger(pdf, source) {
  if (!source) return null;
  const octets = typeof source === 'string' ? Buffer.from(source, 'base64') : source;
  // PNG imposé : un JPEG à fond blanc masquerait les lignes du formulaire.
  return pdf.embedPng(octets);
}

/** Dessine en respectant les proportions, centré dans la boîte offerte. */
function dessiner(page, image, x, y, largeurMax, hauteurMax) {
  const ratio = image.width / image.height;
  let l = largeurMax, h = l / ratio;
  if (h > hauteurMax) { h = hauteurMax; l = h * ratio; }
  page.drawImage(image, { x: x + (largeurMax - l) / 2, y: y + (hauteurMax - h) / 2, width: l, height: h });
}

/** Les images depuis les variables d'environnement, jamais depuis le dépôt. */
export function imagesDepuisEnv() {
  return {
    signature: process.env.MATRICE_SIGNATURE_PNG || null,
    cachet: process.env.MATRICE_CACHET_PNG || null,
  };
}

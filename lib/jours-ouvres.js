// MATRICE — calcul des jours ouvrés
//
// Le rythme de relance retenu est J+7 jours ouvrés, le même que celui des pièces.
// « Ouvré » = du lundi au vendredi, hors jours fériés légaux français.
//
// Les fériés mobiles dépendent de Pâques. On les calcule, on ne les tabule pas :
// une table finirait par manquer une année, et c'est le genre d'erreur qui ne se
// voit pas — la relance tomberait simplement un jour trop tôt, sans rien signaler.
//
// Réserve connue : l'Alsace-Moselle (57, 67, 68) ajoute le Vendredi saint et le
// 26 décembre. Ces deux jours ne sont PAS pris en compte ici, parce que la relance
// est un rappel interne à l'office, à Paris. Si un jour la relance devait être
// calée sur le calendrier du service destinataire, il faudrait les ajouter.

/** Dimanche de Pâques (algorithme de Meeus, calendrier grégorien). */
function paques(annee) {
  const a = annee % 19;
  const b = Math.floor(annee / 100);
  const c = annee % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31);      // 3 = mars, 4 = avril
  const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(annee, mois - 1, jour));
}

const JOUR = 86400000;
const cleISO = (d) => d.toISOString().slice(0, 10);
const decale = (d, n) => new Date(d.getTime() + n * JOUR);

const cacheFeries = new Map();

/** Ensemble des jours fériés légaux (métropole) d'une année, en clés AAAA-MM-JJ. */
export function feriesDe(annee) {
  if (cacheFeries.has(annee)) return cacheFeries.get(annee);
  const P = paques(annee);
  const set = new Set([
    `${annee}-01-01`, // Jour de l'an
    `${annee}-05-01`, // Fête du travail
    `${annee}-05-08`, // Victoire 1945
    `${annee}-07-14`, // Fête nationale
    `${annee}-08-15`, // Assomption
    `${annee}-11-01`, // Toussaint
    `${annee}-11-11`, // Armistice 1918
    `${annee}-12-25`, // Noël
    cleISO(decale(P, 1)),  // Lundi de Pâques
    cleISO(decale(P, 39)), // Ascension
    cleISO(decale(P, 50)), // Lundi de Pentecôte
  ]);
  cacheFeries.set(annee, set);
  return set;
}

/** Vrai si la date est un jour ouvré (lun-ven, hors férié légal). */
export function estOuvre(date) {
  const j = date.getUTCDay();
  if (j === 0 || j === 6) return false;
  return !feriesDe(date.getUTCFullYear()).has(cleISO(date));
}

/**
 * Ajoute n jours ouvrés à une date.
 * Le jour de départ n'est jamais compté, qu'il soit ouvré ou non :
 * une demande envoyée un vendredi et une envoyée le samedi suivant
 * ont la même échéance, ce qui est le comportement attendu.
 */
export function ajouteJoursOuvres(depart, n) {
  let d = new Date(Date.UTC(depart.getUTCFullYear(), depart.getUTCMonth(), depart.getUTCDate()));
  let restants = n;
  while (restants > 0) {
    d = decale(d, 1);
    if (estOuvre(d)) restants--;
  }
  return d;
}

/** Échéance de relance : 7 jours ouvrés après la dernière action. */
export const DELAI_RELANCE_JOURS_OUVRES = 7;
export function prochaineRelance(depuis) {
  return ajouteJoursOuvres(depuis, DELAI_RELANCE_JOURS_OUVRES);
}

export const _interne = { paques, cleISO };

// MATRICE — état d'une ligne de suivi (un envoi, une commune)
//
// Partagé par l'écran (api/dossier.js), l'action de relance
// (api/mettre-en-attente.js) et la tâche du matin (api/relance.js) : la même
// ligne doit dire la même chose partout. Fonction pure, sans base ni réseau.
//
// Arbitrages appliqués :
//   • 13/10/2026 : premier rappel QUINZE JOURS calendaires après l'envoi, puis le
//     même délai entre deux relances ;
//   • 29/08/2026 : après deux relances écrites, on APPELLE le service avant la
//     troisième — et ainsi de suite pour chacune des suivantes ;
//   • 24/09/2026 : dès qu'un autre guichet a délivré l'extrait de la commune, la
//     ligne est SUSPENDUE (plus de relance) mais reste ouverte ; à SOIXANTE
//     JOURS après l'envoi sans réponse, elle se ferme et le guichet est
//     disqualifié pour cette commune.

export const DELAI_RELANCE_SERVICE_JOURS = 15;
export const DELAI_DISQUALIFICATION_JOURS = 60;
export const RELANCES_ECRITES_AVANT_APPEL = 2;

const JOUR = 86_400_000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const plusJours = (d, n) => new Date(new Date(d).getTime() + n * JOUR);

/**
 * @param {object} l  ligne : envoye_le, recu_le, ferme_le, autre_recue,
 *                    nb_relances_service, derniere_relance_service, appels
 * @returns {{etat:'recue'|'fermee'|'suspendue'|'a_relancer'|'en_cours',
 *            echeance:string|null, rang:number, appelRequis:boolean, fermeture:string|null}}
 */
export function etatLigne(l, aujourdhui = new Date()) {
  const rang = (l.nb_relances_service || 0) + 1;
  if (l.recu_le) return { etat: 'recue', echeance: null, rang, appelRequis: false, fermeture: null };
  if (l.ferme_le) return { etat: 'fermee', echeance: null, rang, appelRequis: false, fermeture: null };
  if (l.autre_recue) {
    return { etat: 'suspendue', echeance: null, rang, appelRequis: false,
             fermeture: iso(plusJours(l.envoye_le, DELAI_DISQUALIFICATION_JOURS)) };
  }
  const depuis = l.derniere_relance_service || l.envoye_le;
  const echeance = plusJours(depuis, DELAI_RELANCE_SERVICE_JOURS);
  const appels = Array.isArray(l.appels) ? l.appels : [];
  const dernierAppel = appels.length ? appels[appels.length - 1].le : null;
  const appelRequis = rang > RELANCES_ECRITES_AVANT_APPEL
    && !(dernierAppel && (!l.derniere_relance_service || new Date(dernierAppel) > new Date(l.derniere_relance_service)));
  return {
    etat: iso(echeance) <= iso(aujourdhui) ? 'a_relancer' : 'en_cours',
    echeance: iso(echeance), rang, appelRequis, fermeture: null,
  };
}

/** La ligne doit-elle être fermée et son guichet disqualifié ? */
export function aDisqualifier(l, aujourdhui = new Date()) {
  return !l.recu_le && !l.ferme_le && l.autre_recue
    && iso(plusJours(l.envoye_le, DELAI_DISQUALIFICATION_JOURS)) <= iso(aujourdhui);
}

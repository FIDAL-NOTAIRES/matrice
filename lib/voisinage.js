// MATRICE — déduction du service compétent par voisinage géographique
//
// À quoi ça sert : environ 10 000 communes sur 34 969 ne sont pas routables
// par `corrections.json` — le référentiel est incomplet, ce n'est pas un choix.
// Plutôt que de mettre ces communes en attente et d'attendre un appel
// téléphonique, on regarde les cinq communes RÉFÉRENCÉES les plus proches et on
// en déduit le service.
//
// POURQUOI LE MÊME DÉPARTEMENT UNIQUEMENT
//
// La compétence des SDIF/PTGC est départementale. Or 4 % des communes ont la
// majorité de leurs cinq plus proches voisines dans le département d'à côté
// (mesuré sur échantillon). Ces cinq-là convergeraient parfaitement vers un
// service qui n'est pas compétent : la pire des erreurs, parce qu'elle est
// silencieuse. On restreint donc la recherche au département de la commune,
// que le code INSEE donne toujours.
//
// POURQUOI CINQ ET PAS TROIS
//
// Sur trois voisines, une seule commune limitrophe d'une sectorisation interne
// suffit à emporter la majorité. Sur cinq, la majorité se dégage plus
// nettement. Le coût de calcul est nul : on trie quelques centaines de
// communes, pas 35 000.
//
// CE QUE LE MODULE NE FAIT PAS
//
// Il ne décide pas d'envoyer. Il rend une déduction, avec les voisines qui
// l'ont produite, pour que l'appelant l'écrive dans matrice_journal.detail —
// dans six mois, on doit pouvoir dire POURQUOI MATRICE a écrit à ce service.
// Et une adresse déduite n'est jamais `confirmee` : seule une réponse reçue
// du service confirme une adresse.

import { departementDe, servicesCompetents } from './routage.js';

const NB_VOISINES = 5;
const RAYON_TERRE_KM = 6371;

/**
 * Distance à vol d'oiseau, en kilomètres. Équirectangulaire plutôt que
 * haversine : sur des distances de quelques dizaines de kilomètres l'écart est
 * négligeable, et on ne cherche pas une distance mais un classement.
 */
export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const x = ((lon2 - lon1) * Math.PI / 180) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  const y = (lat2 - lat1) * Math.PI / 180;
  return RAYON_TERRE_KM * Math.hypot(x, y);
}

/**
 * Les N communes référencées les plus proches, dans le même département.
 * @param {string} codeInsee
 * @param {object} centres     communes-centres.json -> .centres
 * @param {object} corrections corrections.json v4
 */
export function voisinesReferencees(codeInsee, centres = {}, corrections = {}, n = NB_VOISINES) {
  const code = String(codeInsee || '').trim();
  const dep = departementDe(code);
  const origine = centres[code];
  if (!dep || !origine) return [];

  const candidates = [];
  for (const autre of Object.keys(centres)) {
    if (autre === code) continue;
    if (departementDe(autre) !== dep) continue;
    const { indices } = servicesCompetents(autre, corrections);
    if (!indices.length) continue;
    candidates.push({ code: autre, km: distanceKm(origine, centres[autre]) });
  }

  candidates.sort((a, b) => a.km - b.km);
  return candidates.slice(0, n);
}

/**
 * Déduit le service compétent d'une commune absente du référentiel.
 *
 * @returns {{
 *   statut: 'deduit' | 'divergent' | 'impossible',
 *   destinataire: string|null,
 *   serviceNom: string|null,
 *   telephone: string|null,
 *   destinatairesAlternatifs: string[],
 *   voisines: Array<{code:string, km:number, destinataire:string|null}>,
 *   motif: string|null
 * }}
 */
export function deduireParVoisinage(codeInsee, centres = {}, corrections = {}) {
  const code = String(codeInsee || '').trim();
  const services = corrections.services || [];

  const vide = (motif) => ({
    statut: 'impossible',
    destinataire: null, serviceNom: null, telephone: null,
    destinatairesAlternatifs: [], voisines: [], motif,
  });

  if (!centres[code]) {
    return vide(`Commune ${code} absente du fichier des centres : pas de coordonnées, pas de déduction possible.`);
  }

  const voisines = voisinesReferencees(code, centres, corrections);
  if (!voisines.length) {
    return vide(
      `Aucune commune référencée dans le département ${departementDe(code)} pour déduire par voisinage. `
      + `Le service doit être saisi à la main.`,
    );
  }

  // Une voisine ne compte que si elle mène à UNE adresse unique. Une voisine
  // ambiguë n'apporte pas d'information : on la garde pour la trace, mais elle
  // ne vote pas.
  const detail = voisines.map((v) => {
    const { indices } = servicesCompetents(v.code, corrections);
    const fiches = indices.map((i) => services[i]).filter(Boolean);
    const adresses = [...new Set(fiches.map((s) => s.courriel).filter(Boolean))];
    return {
      code: v.code,
      km: Math.round(v.km * 10) / 10,
      destinataire: adresses.length === 1 ? adresses[0] : null,
      serviceNom: adresses.length === 1 ? (fiches[0]?.nom || null) : null,
      telephone: adresses.length === 1 ? (fiches[0]?.telephone || null) : null,
    };
  });

  const votants = detail.filter((v) => v.destinataire);
  if (!votants.length) {
    return {
      ...vide(
        `Les ${detail.length} communes voisines référencées mènent toutes à plusieurs adresses possibles. `
        + `Le voisinage ne tranche pas.`,
      ),
      voisines: detail,
    };
  }

  const comptes = new Map();
  for (const v of votants) comptes.set(v.destinataire, (comptes.get(v.destinataire) || 0) + 1);
  const classement = [...comptes.entries()].sort((a, b) => b[1] - a[1]);
  const [gagnant, voix] = classement[0];
  const exAequo = classement.filter(([, n]) => n === voix).length > 1;
  const porteur = votants.find((v) => v.destinataire === gagnant);

  // Convergence : une seule adresse ressort, ou une majorité nette. On route
  // directement — décision prise le 31/08/2026, l'objectif est d'aller vite.
  if (classement.length === 1 || (!exAequo && voix > votants.length / 2)) {
    return {
      statut: 'deduit',
      destinataire: gagnant,
      serviceNom: porteur.serviceNom,
      telephone: porteur.telephone,
      destinatairesAlternatifs: [],
      voisines: detail,
      motif: null,
    };
  }

  // Divergence : on ne tranche pas, on saisit toutes les adresses qui
  // remontent. Un courriel distinct part vers chacune, chaque service ignorant
  // les autres. Le coût d'un mail en trop est nul ; celui d'attendre quinze
  // jours pour découvrir qu'on a écrit au mauvais service ne l'est pas.
  const toutes = classement.map(([adresse]) => adresse);
  return {
    statut: 'divergent',
    destinataire: gagnant,
    serviceNom: porteur.serviceNom,
    telephone: porteur.telephone,
    destinatairesAlternatifs: toutes.filter((a) => a !== gagnant),
    voisines: detail,
    motif:
      `Les ${votants.length} communes voisines référencées ne convergent pas : `
      + `${classement.map(([a, n]) => `${a} (${n})`).join(', ')}. `
      + `Une demande distincte part vers chaque service.`,
  };
}

/**
 * Trace à écrire dans matrice_journal.detail. Séparé de la déduction pour que
 * la forme du journal puisse changer sans toucher à la décision.
 */
export function traceDeduction(codeInsee, resultat) {
  return {
    methode: 'voisinage',
    commune: codeInsee,
    statut: resultat.statut,
    retenu: resultat.destinataire,
    alternatifs: resultat.destinatairesAlternatifs,
    voisines: resultat.voisines.map((v) => ({ c: v.code, km: v.km, dest: v.destinataire })),
  };
}

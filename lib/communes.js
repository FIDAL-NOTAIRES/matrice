// MATRICE — résolution d'un nom de commune en code INSEE
//
// Nécessaire uniquement quand le portefeuille arrive sans code : noms de
// dossiers Drive, liste tapée à la main. Un tableau REDPAR porte ses codes et
// ne passe pas par ici.
//
// Source : l'API Découpage administratif de l'État (geo.api.gouv.fr), adossée
// au Code officiel géographique de l'INSEE. Publique, sans clef, et surtout
// tenue à jour — c'est ce qui permet d'attraper les communes disparues.
//
// LA RÈGLE : on ne devine jamais.
//
// Un nom qui ne correspond exactement à aucune commune, ou qui en désigne
// plusieurs, n'est PAS résolu. Il ressort tel quel, à charge pour l'humain de
// trancher. C'est le prolongement de l'arbitrage du 15 août — plutôt une
// commune en attente qu'une demande adressée au mauvais service.
//
// C'est ce contrôle qui aurait arrêté LOMME : commune absorbée par Lille le
// 27 février 2000, dont le nom subsiste dans les dossiers Drive. L'API ne
// renvoie aucune commune de ce nom ; le portefeuille l'aurait fait passer.

import { normaliser } from './portefeuille.js';

const API = 'https://geo.api.gouv.fr/communes';

// Un portefeuille répète les mêmes communes, et un même dossier se relit
// plusieurs fois. Le cache vit le temps de l'instance, pas au-delà : le Code
// officiel géographique change une fois l'an, on ne cherche pas à le figer.
const cache = new Map();

/**
 * @param {string[]} noms
 * @returns {Promise<Map<string, {code:string, nom:string} | {motif:string, candidats?:Array}>>}
 *   clef = le nom fourni, tel quel.
 */
export async function resoudre(noms) {
  const sortie = new Map();
  const uniques = [...new Set(noms.filter(Boolean))];

  for (const nom of uniques) {
    const cible = normaliser(nom);
    if (!cible) { sortie.set(nom, { motif: 'nom vide' }); continue; }
    if (cache.has(cible)) { sortie.set(nom, cache.get(cible)); continue; }

    let reponse;
    try {
      const r = await fetch(`${API}?nom=${encodeURIComponent(nom)}&fields=code,nom,departement&limit=20`, {
        headers: { Accept: 'application/json', 'User-Agent': 'MATRICE/1.0 (FIDAL Notaires)' },
      });
      if (!r.ok) { sortie.set(nom, { motif: `annuaire des communes indisponible (${r.status})` }); continue; }
      reponse = await r.json();
    } catch (e) {
      sortie.set(nom, { motif: `annuaire des communes injoignable : ${e.message}` });
      continue;
    }

    // Correspondance EXACTE sur le nom normalisé. L'API classe par pertinence
    // et renvoie volontiers des approchants : « LOMME » lui inspire
    // « Lommerange ». Accepter le premier résultat serait accepter n'importe quoi.
    const exacts = (Array.isArray(reponse) ? reponse : []).filter((c) => normaliser(c.nom) === cible);

    if (exacts.length === 1) {
      sortie.set(nom, { code: exacts[0].code, nom: exacts[0].nom });
    } else if (exacts.length === 0) {
      sortie.set(nom, {
        motif: 'aucune commune de ce nom — commune fusionnée ou disparue, ou nom incomplet',
        candidats: propositions(reponse, 8),
      });
    } else {
      sortie.set(nom, {
        motif: `${exacts.length} communes portent ce nom`,
        candidats: propositions(exacts, 8),
      });
    }
  }

  // Seules les résolutions abouties sont mémorisées : une indisponibilité de
  // l'annuaire ne doit pas se figer en « introuvable » pour le reste de la journée.
  for (const [nom, r] of sortie) if (r.code) cache.set(normaliser(nom), r);

  return sortie;
}

/**
 * Les candidats proposés à l'humain quand la résolution échoue.
 *
 * Le département accompagne chaque nom : « Marquette-lez-Lille » et
 * « Marquette-en-Ostrevant » sont toutes deux dans le Nord, et deux
 * « Saint-André » ne se distinguent que par là. Un choix qu'on ne peut pas
 * faire en connaissance de cause n'est pas un choix.
 */
function propositions(liste, max) {
  return (Array.isArray(liste) ? liste : []).slice(0, max).map((c) => ({
    code: c.code,
    nom: c.nom,
    departement: c.departement ? `${c.departement.nom} (${c.departement.code})` : null,
  }));
}

/**
 * Vérifie que des codes INSEE désignent encore une commune.
 *
 * Sans ce contrôle, un code périmé passe : LOMME (59355), absorbée par Lille le
 * 27 février 2000, traverse tout le routage sans qu'on la remarque, et la
 * demande part au nom d'une commune qui n'existe plus. C'est arrivé.
 *
 * Distinction essentielle : l'annuaire qui RÉPOND « ce code n'existe pas » est
 * un motif de blocage ; l'annuaire qui NE RÉPOND PAS ne l'est pas. Confondre
 * les deux ferait dépendre tout import de la disponibilité d'un service tiers.
 *
 * Rend aussi le NOM OFFICIEL de chaque code. C'est indispensable : quand le
 * notaire précise que LOMME vaut 59350, la ligne porte encore « LOMME », et le
 * formulaire partirait au nom d'une commune supprimée — alors qu'on vient
 * justement de la corriger. Le nom qui figure sur le Cerfa doit être celui du
 * Code officiel géographique, pas celui du dossier Drive.
 *
 * @returns {Promise<{perimes:Array, noms:Map<string,string>, controleImpossible:boolean}>}
 */
export async function verifierCodes(codes) {
  const perimes = [];
  const noms = new Map();
  let controleImpossible = false;

  for (const code of [...new Set(codes.filter(Boolean))]) {
    if (cache.has(`#${code}`)) { noms.set(code, cache.get(`#${code}`).nom); continue; }
    try {
      const r = await fetch(`${API}/${encodeURIComponent(code)}?fields=code,nom`, {
        headers: { Accept: 'application/json', 'User-Agent': 'MATRICE/1.0 (FIDAL Notaires)' },
      });
      if (r.status === 404) { perimes.push(code); continue; }
      if (!r.ok) { controleImpossible = true; continue; }
      const c = await r.json();
      if (!c || !c.code) { perimes.push(code); continue; }
      cache.set(`#${code}`, { code: c.code, nom: c.nom });
      noms.set(code, c.nom);
    } catch {
      controleImpossible = true;
    }
  }

  return { perimes, noms, controleImpossible };
}

/**
 * Complète les lignes d'un portefeuille dont le code manque.
 * Rend les lignes résolues d'un côté, les autres de l'autre — jamais mélangées.
 */
export async function completer(lignes) {
  const aResoudre = lignes.filter((l) => !l.code_insee && l.nom_commune);
  const sansRien = lignes.filter((l) => !l.code_insee && !l.nom_commune);
  if (aResoudre.length === 0) {
    return { resolues: lignes.filter((l) => l.code_insee), nonResolues: sansRien.map((l) => ({ ...l, motif: 'ligne vide' })) };
  }

  const table = await resoudre(aResoudre.map((l) => l.nom_commune));
  const resolues = lignes.filter((l) => l.code_insee);
  const nonResolues = sansRien.map((l) => ({ ...l, motif: 'ligne vide' }));

  for (const l of aResoudre) {
    const r = table.get(l.nom_commune);
    if (r && r.code) resolues.push({ ...l, code_insee: r.code, nom_commune: r.nom });
    else nonResolues.push({ ...l, motif: r?.motif || 'non résolu', candidats: r?.candidats || [] });
  }

  return { resolues, nonResolues };
}

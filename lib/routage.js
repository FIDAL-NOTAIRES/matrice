// MATRICE — routage d'une commune vers le service des impôts fonciers compétent
//
// Fonction pure, sans base ni réseau : on lui donne une commune et les deux
// référentiels, elle rend un destinataire ou un motif d'attente. C'est le
// cœur de la décision, donc c'est la partie qui doit être testable seule.
//
// LA RÈGLE, dont tout le reste découle : on n'envoie jamais une demande à une
// boîte dont on n'est pas sûr qu'elle traite le périmètre de la commune.
// Un rabattement silencieux sur « l'autre adresse du département » est pire
// qu'une absence d'envoi : la demande part, personne ne répond, et on croit
// l'avoir faite.
//
// Conséquence assumée : dans un département où au moins un service n'a pas
// d'adresse publiée, TOUTES les communes attendent — parce que le référentiel
// ne dit pas quel service couvre quelle commune dans ces départements-là.
// C'est le cas du Pas-de-Calais, où Arras, Lens et Saint-Omer sont muets.
// Le pointage téléphonique lève cette réserve département par département,
// en posant `fiable: true` dans corrections.json.

/** Département d'un code INSEE. Trois caractères en outre-mer, deux ailleurs. */
export function departementDe(codeInsee) {
  const c = String(codeInsee || '').trim();
  if (c.length !== 5) return null;
  return c.startsWith('97') || c.startsWith('98') ? c.slice(0, 3) : c.slice(0, 2);
}

/**
 * @param {object} commune      {code_insee, nom_commune, nb_lots}
 * @param {object} referentiel  sdif-departements.json
 * @param {object} corrections  corrections.json
 * @returns {{statut:'a_envoyer'|'en_attente', destinataire:string|null,
 *            serviceNom:string|null, telephone:string|null, motif:string|null,
 *            departement:string|null}}
 */
export function router(commune, referentiel, corrections = {}) {
  const code = String(commune.code_insee || '').trim();
  const dep = departementDe(code);

  const attente = (motif, extra = {}) => ({
    statut: 'en_attente', destinataire: null, serviceNom: null,
    telephone: null, motif, departement: dep, ...extra,
  });

  if (!dep) return attente(`Code INSEE mal formé : « ${code} ». Attendu 5 caractères.`);

  // 1. Une correction au niveau de la commune prime sur tout le reste.
  const corrCommune = corrections.communes?.[code];
  if (corrCommune) {
    if (corrCommune.courriel) {
      return {
        statut: 'a_envoyer', destinataire: corrCommune.courriel,
        serviceNom: corrCommune.service || null, telephone: null,
        motif: null, departement: dep,
      };
    }
    return attente(
      corrCommune.note
        || `Commune rattachée au service « ${corrCommune.service || 'non identifié'} », dont l'adresse n'est pas encore pointée.`,
      { serviceNom: corrCommune.service || null },
    );
  }

  const refDep = referentiel.departements?.[dep];
  if (!refDep) return attente(`Département ${dep} absent du référentiel du ${referentiel.pivoteLe || '?'}.`);

  const nomDep = refDep.nom || (refDep.nomsRencontres || []).join(' / ') || dep;
  const corrDep = corrections.departements?.[dep] || {};

  // 2. Une correction au niveau du département : un service pointé, une adresse.
  const servicesPointes = (corrDep.services || []).filter((s) => s.courriel);
  if (servicesPointes.length === 1 && (refDep.nbServices === 1 || corrDep.fiable)) {
    const s = servicesPointes[0];
    return {
      statut: 'a_envoyer', destinataire: s.courriel, serviceNom: s.nom || null,
      telephone: null, motif: null, departement: dep,
    };
  }

  // 3. Le département est-il sûr ? Un seul service muet suffit à le disqualifier,
  //    sauf si le pointage a explicitement levé la réserve.
  const muets = (refDep.services || []).filter((s) => !s.courriels?.length);
  const reserves = refDep.reserves || {};
  const reserveNonLevee = Object.keys(reserves).filter(
    (mail) => corrections.reserves?.[mail]?.levee !== true,
  );

  if (!corrDep.fiable) {
    if (reserveNonLevee.length) {
      const premier = muets[0];
      return attente(
        `Réserve non levée sur ${reserveNonLevee[0]} : ${reserves[reserveNonLevee[0]]}`,
        {
          serviceNom: premier ? premier.nom : (refDep.services?.[0]?.nom || null),
          telephone: premier?.telephone?.[0] || refDep.services?.[0]?.telephone?.[0] || null,
        },
      );
    }
    if (muets.length) {
      return attente(
        `${muets.length} service${muets.length > 1 ? 's' : ''} du département ${nomDep} sans adresse publiée `
        + `(${muets.map((s) => court(s.nom)).join(', ')}). Le référentiel ne dit pas quelle commune relève de qui : `
        + `envoyer reviendrait à rabattre au hasard.`,
        { serviceNom: muets[0].nom, telephone: muets[0].telephone?.[0] || null },
      );
    }
  }

  // 4. Routage normal.
  if (refDep.statut === 'plusieurs_boites') {
    const boites = referentiel.communesParBoite?.[code];
    if (!boites?.length) {
      return attente(`Commune absente de la table de répartition du département ${nomDep}, qui compte plusieurs guichets.`);
    }
    if (boites.length > 1) {
      return attente(`Plusieurs boîtes possibles pour cette commune : ${boites.join(', ')}. À trancher.`);
    }
    const svc = (refDep.services || []).find((s) => s.courriels?.includes(boites[0]));
    return {
      statut: 'a_envoyer', destinataire: boites[0],
      serviceNom: svc?.nom || null, telephone: null, motif: null, departement: dep,
    };
  }

  const mail = refDep.courriels?.[0] || corrDep.services?.find((s) => s.courriel)?.courriel;
  if (!mail) {
    const premier = refDep.services?.[0];
    return attente(
      `Aucune adresse publiée pour le département ${nomDep}. Pointage en cours.`,
      { serviceNom: premier?.nom || null, telephone: premier?.telephone?.[0] || null },
    );
  }

  return {
    statut: 'a_envoyer', destinataire: mail,
    serviceNom: refDep.services?.[0]?.nom || null,
    telephone: null, motif: null, departement: dep,
  };
}

const court = (nom) => String(nom || '').replace(/^.*?\((?:SDIF|CDIF)\)\s*/, '');

/**
 * Route un portefeuille entier et le regroupe par destinataire.
 * Un courriel par service, pas un par commune : sept messages au même
 * guichet le même jour, c'est six de trop.
 */
export function routerPortefeuille(communes, referentiel, corrections) {
  const lignes = communes.map((c) => ({ ...c, ...router(c, referentiel, corrections) }));

  const envois = new Map();
  for (const l of lignes.filter((l) => l.statut === 'a_envoyer')) {
    if (!envois.has(l.destinataire)) {
      envois.set(l.destinataire, { destinataire: l.destinataire, serviceNom: l.serviceNom, communes: [] });
    }
    envois.get(l.destinataire).communes.push(l);
  }

  return {
    lignes,
    envois: [...envois.values()],
    enAttente: lignes.filter((l) => l.statut === 'en_attente'),
    resume: {
      communes: lignes.length,
      lots: lignes.reduce((n, l) => n + (l.nb_lots || 0), 0),
      courriels: envois.size,
      formulaires: lignes.filter((l) => l.statut === 'a_envoyer').length,
      enAttente: lignes.filter((l) => l.statut === 'en_attente').length,
    },
  };
}

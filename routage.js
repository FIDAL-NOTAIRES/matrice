// MATRICE — routage d'une commune vers le service des impôts fonciers compétent
//
// Fonction pure, sans base ni réseau : on lui donne une commune et le
// référentiel corrigé, elle rend un destinataire ou un motif d'attente. C'est
// le cœur de la décision, donc c'est la partie qui doit être testable seule.
//
// LA RÈGLE, dont tout le reste découle : on n'envoie jamais une demande à une
// boîte dont on n'est pas sûr qu'elle traite le périmètre de la commune.
// Un rabattement silencieux sur « l'autre adresse du département » est pire
// qu'une absence d'envoi : la demande part, personne ne répond, et on croit
// l'avoir faite.
//
// CE QUI CHANGE AVEC corrections.json v4 (19/08/2026)
//
// L'ancienne version décidait par DÉPARTEMENT : un seul service muet suffisait
// à mettre toutes les communes du département en attente, parce que le
// référentiel moissonné ne disait pas quel service couvrait quelle commune.
//
// Le jeu « compétence géographique des services locaux » de la DILA le dit
// désormais, pour les 36 223 communes. La décision devient donc précise à la
// commune. Conséquence chiffrée : 22 452 communes routables là où l'ancienne
// logique en bloquait la quasi-totalité.
//
// La contrepartie est que la forme du fichier a changé. Les services sont
// désignés par leur INDICE dans le tableau `services[]`, et seules les
// communes qui font exception à la règle de leur département sont figées —
// cinq sur 36 223. C'est ce qui fait passer le fichier de 11,4 Mo à 100 ko.
//
// ORDRE DE RÉSOLUTION
//   1. corrections.communesExceptions[code]   -> indices de services
//   2. sinon corrections.departements[dep].services
//   3. un seul service ET son courriel non nul ET aucune réserve non levée
//      -> envoi autorisé
//   4. tout autre cas -> file d'attente. Jamais de rabattement.
//
// `sdif-departements.json` n'intervient plus dans la décision. Il n'est
// conservé en second paramètre que pour libeller les départements, et parce
// que les appelants le passent déjà.

const VERSION_ATTENDUE = 4;

/** Département d'un code INSEE. Trois caractères en outre-mer, deux ailleurs. */
export function departementDe(codeInsee) {
  const c = String(codeInsee || '').trim();
  if (c.length !== 5) return null;
  return c.startsWith('97') || c.startsWith('98') ? c.slice(0, 3) : c.slice(0, 2);
}

const court = (nom) => String(nom || '').replace(/^.*?\((?:SDIF|CDIF|PTGC)\)\s*/, '');

/**
 * Indices des services compétents pour une commune, et d'où vient la réponse.
 * Fonction exportée parce qu'elle est utile à l'écran de dossier, et parce
 * qu'un test unitaire dessus vaut mieux qu'un test sur tout `router`.
 */
export function servicesCompetents(codeInsee, corrections = {}) {
  const code = String(codeInsee || '').trim();
  const dep = departementDe(code);
  if (!dep) return { indices: [], source: null, departement: null };

  const exception = corrections.communesExceptions?.[code];
  if (Array.isArray(exception)) {
    return { indices: exception, source: 'exception', departement: dep };
  }
  const parDefaut = corrections.departements?.[dep]?.services;
  if (Array.isArray(parDefaut)) {
    return { indices: parDefaut, source: 'departement', departement: dep };
  }
  return { indices: [], source: null, departement: dep };
}

/** Une adresse sous réserve non levée est traitée comme absente. */
function sousReserve(courriel, corrections) {
  if (!courriel) return null;
  const r = corrections.reserves?.[courriel];
  if (!r || r.levee === true) return null;
  return r.motif || 'réserve non levée sur cette adresse';
}

/**
 * @param {object} commune      {code_insee, nom_commune, nb_lots}
 * @param {object} referentiel  sdif-departements.json — libellés seulement
 * @param {object} corrections  corrections.json v4
 * @returns {{statut:'a_envoyer'|'en_attente', destinataire:string|null,
 *            serviceNom:string|null, telephone:string|null, motif:string|null,
 *            departement:string|null, etatAdresse:string|null}}
 */
export function router(commune, referentiel = {}, corrections = {}) {
  const code = String(commune.code_insee || '').trim();
  const dep = departementDe(code);

  const attente = (motif, extra = {}) => ({
    statut: 'en_attente', destinataire: null, serviceNom: null,
    telephone: null, motif, departement: dep, etatAdresse: null, ...extra,
  });

  if (!dep) return attente(`Code INSEE mal formé : « ${code} ». Attendu 5 caractères.`);

  // Garde-fou de version. Un code v4 nourri d'un fichier v1 router​ait faux en
  // silence : le fichier v1 n'a ni `communesExceptions` ni indices, donc tout
  // partirait en attente sans qu'on sache pourquoi. Mieux vaut le dire.
  const version = Number(corrections.version || 0);
  if (version !== VERSION_ATTENDUE) {
    return attente(
      `corrections.json en version ${version || 'inconnue'}, attendu ${VERSION_ATTENDUE}. `
      + `Le fichier déployé n'est pas celui que ce code sait lire : aucun envoi n'est autorisé.`,
    );
  }

  const services = corrections.services || [];
  const { indices, source } = servicesCompetents(code, corrections);
  const infoDep = corrections.departements?.[dep];
  const nomDep = referentiel.departements?.[dep]?.nom
    || (referentiel.departements?.[dep]?.nomsRencontres || []).join(' / ')
    || dep;

  if (!indices.length) {
    return attente(
      `Commune ${code} absente du référentiel de compétence du ${corrections.misAJourLe || '?'}. `
      + `Ni exception, ni règle départementale pour le département ${nomDep}.`,
    );
  }

  const fiches = indices.map((i) => services[i]).filter(Boolean);
  if (fiches.length !== indices.length) {
    return attente(
      `Indice de service hors du tableau services[] pour la commune ${code}. Fichier incohérent.`,
    );
  }

  // Plusieurs guichets compétents, mais UNE SEULE adresse : il n'y a pas
  // d'ambiguïté de destination. La règle 4.1 porte sur la boîte, pas sur le
  // guichet — peu importe lequel des trois instruit, le message arrive au même
  // endroit. C'est le cas de six départements, 2 469 communes, dont tout le
  // Nord : bloquer ici aurait fait régresser le cas de contrôle LOGIS
  // MÉTROPOLE, qui produisait un courriel vers sdif.nord@ et 23 formulaires.
  if (fiches.length > 1) {
    const adresses = [...new Set(fiches.map((s) => s.courriel).filter(Boolean))];
    if (adresses.length === 1 && fiches.every((s) => s.courriel)) {
      const reserveCommune = sousReserve(adresses[0], corrections);
      if (!reserveCommune) {
        const porteur = fiches[0];
        return {
          statut: 'a_envoyer',
          destinataire: adresses[0],
          serviceNom: porteur.nom || null,
          telephone: porteur.telephone || null,
          motif: null,
          departement: dep,
          etatAdresse: porteur.etatAdresse || 'connue',
          origineAdresse: porteur.origineCourriel || null,
          resolution: `${source}, ${fiches.length} guichets convergeant vers une adresse unique`,
        };
      }
    }
  }

  // Plusieurs guichets et plusieurs boîtes possibles : on n'arbitre pas, on met
  // en attente. Le motif diffère selon que la source connaît réellement la
  // répartition ou qu'elle déclare la compétence au niveau du département —
  // parce que la question à poser au téléphone n'est pas la même.
  if (fiches.length > 1) {
    const sansAdresse = fiches.filter((s) => !s.courriel);
    const pourAppel = sansAdresse[0] || fiches[0];
    const noms = fiches.map((s) => court(s.nom)).join(', ');
    const motif = infoDep?.repartitionReelle
      ? `Compétence réellement partagée entre ${fiches.length} guichets pour cette commune (${noms}). À trancher.`
      : `${fiches.length} guichets compétents dans le département ${nomDep} (${noms}), et la source `
        + `déclare la compétence au niveau du département, pas de la commune. Envoyer reviendrait à `
        + `rabattre au hasard. Question à poser : quelles communes relèvent de votre guichet.`;
    return attente(motif, {
      serviceNom: pourAppel.nom || null,
      telephone: pourAppel.telephone || null,
    });
  }

  const s = fiches[0];

  if (!s.courriel) {
    return attente(
      `Guichet unique pour cette commune — ${court(s.nom)} — mais aucune adresse connue. `
      + `Un seul appel débloque toutes les communes de ce guichet.`,
      { serviceNom: s.nom || null, telephone: s.telephone || null, etatAdresse: 'absente' },
    );
  }

  const reserve = sousReserve(s.courriel, corrections);
  if (reserve) {
    return attente(
      `Réserve non levée sur ${s.courriel} : ${reserve}`,
      { serviceNom: s.nom || null, telephone: s.telephone || null, etatAdresse: 'absente' },
    );
  }

  return {
    statut: 'a_envoyer',
    destinataire: s.courriel,
    serviceNom: s.nom || null,
    telephone: s.telephone || null,
    motif: null,
    departement: dep,
    // `connue` tant que le service ne l'a pas confirmée par retour de message.
    // Ce n'est pas bloquant, mais l'écran doit pouvoir le dire.
    etatAdresse: s.etatAdresse || 'connue',
    origineAdresse: s.origineCourriel || null,
    resolution: source,
  };
}

/**
 * Route un portefeuille entier et le regroupe par destinataire.
 * Un courriel par service, pas un par commune : sept messages au même
 * guichet le même jour, c'est six de trop.
 */
export function routerPortefeuille(communes, referentiel, corrections) {
  const lignes = communes.map((c) => ({ ...c, ...router(c, referentiel, corrections) }));

  const envois = new Map();
  for (const l of lignes.filter((x) => x.statut === 'a_envoyer')) {
    if (!envois.has(l.destinataire)) {
      envois.set(l.destinataire, {
        destinataire: l.destinataire,
        serviceNom: l.serviceNom,
        etatAdresse: l.etatAdresse,
        communes: [],
      });
    }
    envois.get(l.destinataire).communes.push(l);
  }

  const aEnvoyer = lignes.filter((l) => l.statut === 'a_envoyer');

  return {
    lignes,
    envois: [...envois.values()],
    enAttente: lignes.filter((l) => l.statut === 'en_attente'),
    resume: {
      communes: lignes.length,
      lots: lignes.reduce((n, l) => n + (l.nb_lots || 0), 0),
      courriels: envois.size,
      formulaires: aEnvoyer.length,
      enAttente: lignes.length - aEnvoyer.length,
      // Aucune adresse n'est confirmée à ce jour : la campagne du 19/08 est en
      // cours. Compté ici pour que le compte rendu puisse le dire.
      adressesNonConfirmees: aEnvoyer.filter((l) => l.etatAdresse !== 'confirmee').length,
    },
  };
}

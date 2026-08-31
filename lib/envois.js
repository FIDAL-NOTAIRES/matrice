// MATRICE — groupement des envois quand une commune vise plusieurs services
//
// POURQUOI CE MODULE EXISTE
//
// Jusqu'ici, une commune avait un destinataire et un seul : `routage.js`,
// `vue-dossier.js` et `envoyer.js` faisaient chacun leur `Map` par destinataire,
// trois fois la même boucle. Tant qu'il n'y avait qu'une adresse par commune,
// c'était sans conséquence.
//
// Depuis la déduction par voisinage (31/08/2026), une commune dont les cinq
// voisines divergent est adressée à PLUSIEURS services, un courriel distinct par
// service, chacun ignorant les autres. Trois boucles à faire évoluer de la même
// façon, c'est deux occasions de se tromper : on n'en garde qu'une, ici.
//
// LE MODÈLE
//
// `matrice_demande` reste une ligne par commune : c'est l'unité de travail, et
// son `statut` est l'AGRÉGAT de ses envois — `envoyee` signifie « au moins un
// courriel est parti », et la première réponse reçue clôt la demande, quel que
// soit le service qui répond. Le détail vit dans `matrice_envoi_demande`, dont
// la clé primaire (envoi_id, demande_id) autorise déjà une commune dans
// plusieurs envois. Aucune refonte n'a été nécessaire.
//
// `destinataire` porte le service RETENU — le majoritaire parmi les voisines.
// `services_alternatifs` porte les autres, avec leur nom et leur téléphone :
// sans le nom, `matrice_envoi.service_nom` étant NOT NULL, le courriel partirait
// sous un libellé de repli ; sans le téléphone, la troisième relance par appel
// serait impossible sur cette branche.

/**
 * Tous les services à qui cette commune doit être adressée, le retenu d'abord.
 * Accepte indifféremment une ligne de base (colonnes en serpent) ou une ligne
 * de routage (clés en chameau) : les deux formes circulent dans le code.
 *
 * @returns {Array<{destinataire:string, serviceNom:string|null, telephone:string|null, retenu:boolean}>}
 */
export function destinatairesDe(ligne) {
  const principal = ligne.destinataire;
  if (!principal) return [];

  const sortie = [{
    destinataire: principal,
    serviceNom: ligne.serviceNom ?? ligne.service_nom ?? null,
    telephone: ligne.telephone ?? ligne.telephone_relance ?? null,
    retenu: true,
  }];

  const bruts = ligne.servicesAlternatifs ?? ligne.services_alternatifs ?? null;
  const alternatifs = typeof bruts === 'string' ? tenter(bruts) : bruts;
  if (!Array.isArray(alternatifs)) return sortie;

  const vus = new Set([principal]);
  for (const a of alternatifs) {
    const adresse = a?.destinataire;
    if (!adresse || vus.has(adresse)) continue;
    vus.add(adresse);
    sortie.push({
      destinataire: adresse,
      serviceNom: a.service_nom ?? a.serviceNom ?? null,
      telephone: a.telephone ?? null,
      retenu: false,
    });
  }
  return sortie;
}

function tenter(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** Une commune est-elle adressée à plusieurs services ? */
export function estDivergente(ligne) {
  return destinatairesDe(ligne).length > 1;
}

/**
 * Constitue les groupes d'envoi : un groupe par destinataire, une commune
 * pouvant figurer dans plusieurs groupes.
 *
 * @param {Array}    lignes    lignes à grouper (routage ou base)
 * @param {function} habiller  mise en forme d'une commune dans le groupe
 */
export function grouperEnvois(lignes, habiller = (l) => l) {
  const groupes = new Map();

  for (const l of lignes) {
    for (const d of destinatairesDe(l)) {
      if (!groupes.has(d.destinataire)) {
        groupes.set(d.destinataire, {
          destinataire: d.destinataire,
          serviceNom: d.serviceNom,
          etatAdresse: l.etatAdresse ?? l.etat_adresse ?? null,
          // Vrai dès qu'au moins une commune du groupe y est adressée en
          // second choix : l'écran doit pouvoir le dire, et le rapport d'envoi
          // aussi.
          issuDeDivergence: !d.retenu,
          communes: [],
        });
      }
      const g = groupes.get(d.destinataire);
      if (!d.retenu) g.issuDeDivergence = true;
      // Le nom du service du groupe vient du premier qui le renseigne : une
      // ligne alternative peut le connaître là où la retenue l'ignore.
      if (!g.serviceNom && d.serviceNom) g.serviceNom = d.serviceNom;
      g.communes.push(habiller(l));
    }
  }

  return [...groupes.values()];
}

/**
 * Nombre de formulaires réellement produits : une commune adressée à deux
 * services donne DEUX Cerfa. Le compte des communes et celui des formulaires
 * ne coïncident plus, et l'écran doit afficher les deux.
 */
export function compterFormulaires(lignes) {
  return lignes.reduce((n, l) => n + destinatairesDe(l).length, 0);
}

// MATRICE — mise en forme d'un dossier pour l'écran récapitulatif
//
// Fonction pure : elle prend les lignes de matrice_demande et rend exactement
// ce que l'écran affiche. Aucune règle métier ne descend dans le navigateur —
// il n'y a qu'un seul endroit où l'on décide si l'envoi est possible, et c'est ici.
//
// DEPUIS LA DÉDUCTION PAR VOISINAGE (31/08/2026)
//
// Une commune peut viser PLUSIEURS services : quand les cinq communes voisines
// ne convergent pas, une demande distincte part vers chacun. Le groupement est
// donc délégué à lib/envois.js, partagé avec routage.js et envoyer.js.
//
// Conséquence sur les comptes : `formulaires` compte les Cerfa, pas les
// communes. Une commune divergente en produit deux. L'écran doit afficher les
// deux nombres, sinon le collaborateur croit à un doublon.

import { grouperEnvois, compterFormulaires, destinatairesDe, estDivergente } from './envois.js';

/** On ne renvoie au navigateur que ce qu'il affiche. */
export function sobre(l) {
  const tous = destinatairesDe(l);
  return {
    id: l.id,
    code: l.code_insee,
    commune: l.nom_commune,
    departement: l.departement,
    lots: l.nb_lots,
    statut: l.statut,
    service: l.service_nom,
    destinataire: l.destinataire,
    motif: l.motif_attente,
    telephone: l.telephone_relance,
    // Routage incertain : les cinq voisines ont divergé, la demande part vers
    // plusieurs services. L'écran doit le dire — deux courriels pour une seule
    // commune ressemble sinon à une erreur.
    divergente: tous.length > 1,
    services: tous.length > 1
      ? tous.map((d) => ({ destinataire: d.destinataire, service: d.serviceNom, retenu: d.retenu }))
      : null,
    // Mise en forme côté serveur : la base rend un objet date, que JSON
    // sérialiserait en 2026-08-26T00:00:00.000Z. C'est ici que les dates se
    // formatent, pas dans l'écran — sinon deux endroits décident du rendu.
    prochaineRelance: l.prochaine_relance
      ? new Date(l.prochaine_relance).toLocaleDateString('fr-FR',
          { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      : null,
    relances: l.nb_relances,
  };
}

/**
 * @param {Array}  lignes        lignes de matrice_demande pour un dossier
 * Le contrôle « mandat » a été retiré le 17 août 2026 : le BOFiP dispense les
 * notaires de produire un mandat pour leurs demandes d'extraits de matrice
 * (BOI-CAD-DIFF-20-20-10-10, § 120). Un contrôle qui vérifie ce que
 * l'administration n'exige pas ne protège de rien et coûte un geste.
 */
export function vueDossier(lignes) {
  // Un envoi par destinataire, jamais un par commune — mais une commune peut
  // désormais figurer dans plusieurs envois.
  const pretes = lignes.filter((l) => l.statut === 'a_envoyer');
  const envois = grouperEnvois(pretes, sobre).map((g) => ({
    destinataire: g.destinataire,
    service: g.serviceNom,
    issuDeDivergence: g.issuDeDivergence,
    communes: g.communes,
  }));

  const enAttente = lignes.filter((l) => l.statut === 'en_attente').map(sobre);
  const dejaParties = lignes.filter((l) => ['envoyee', 'recue'].includes(l.statut)).map(sobre);
  const divergentes = pretes.filter(estDivergente);
  const formulaires = compterFormulaires(pretes);

  // Seuls les contrôles bloquants empêchent l'envoi. Une commune en attente est
  // un avertissement, pas un verrou : c'est l'arbitrage du 15 août — on envoie
  // ce qui peut partir, le reste est relancé.
  const controles = [
    {
      cle: 'destinataires',
      libelle: 'Tous les destinataires sont établis',
      etat: enAttente.length === 0 ? 'ok' : 'avertissement',
      bloquant: false,
      detail: enAttente.length === 0 ? null
        : `${enAttente.length} commune${enAttente.length > 1 ? 's' : ''} sur ${lignes.length} sans service identifié — `
          + `mise${enAttente.length > 1 ? 's' : ''} en file, n'empêche pas l'envoi des autres`,
    },
    {
      cle: 'rien_a_envoyer',
      libelle: 'Au moins une demande prête',
      etat: pretes.length > 0 ? 'ok' : 'echec',
      bloquant: true,
      detail: pretes.length > 0 ? null : 'Toutes les communes sont en attente ou déjà parties.',
    },
  ];

  // Avertissement et non blocage : le routage incertain est une décision
  // assumée — le coût d'un courriel en trop est nul, celui d'attendre quinze
  // jours pour découvrir qu'on a écrit au mauvais service ne l'est pas. Mais le
  // collaborateur doit savoir pourquoi il voit deux courriels pour une commune.
  if (divergentes.length) {
    controles.push({
      cle: 'routage_incertain',
      libelle: 'Routage certain pour toutes les communes',
      etat: 'avertissement',
      bloquant: false,
      detail: `${divergentes.length} commune${divergentes.length > 1 ? 's' : ''} `
        + `au routage déduit du voisinage sans convergence : `
        + divergentes.map((l) => `${l.nom_commune} (${destinatairesDe(l).length} services)`).join(', ')
        + `. Une demande distincte part vers chaque service, aucun ne sait que les autres sont saisis.`,
    });
  }

  const bloquants = controles.filter((c) => c.bloquant && c.etat === 'echec');

  return {
    societe: lignes[0]?.societe || null,
    siren: lignes[0]?.siren || null,
    resume: {
      communes: lignes.length,
      lots: lignes.reduce((n, l) => n + (l.nb_lots || 0), 0),
      courriels: envois.length,
      // Nombre de Cerfa réellement produits. Peut dépasser `communesPretes`
      // quand une commune vise plusieurs services.
      formulaires,
      communesPretes: pretes.length,
      divergentes: divergentes.length,
      enAttente: enAttente.length,
      dejaParties: dejaParties.length,
    },
    envois,
    enAttente,
    dejaParties,
    controles,
    envoiPossible: bloquants.length === 0,
    bloquants: bloquants.map((c) => c.libelle),
  };
}

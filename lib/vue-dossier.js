// MATRICE — mise en forme d'un dossier pour l'écran récapitulatif
//
// Fonction pure : elle prend les lignes de matrice_demande et rend exactement
// ce que l'écran affiche. Aucune règle métier ne descend dans le navigateur —
// il n'y a qu'un seul endroit où l'on décide si l'envoi est possible, et c'est ici.

/** On ne renvoie au navigateur que ce qu'il affiche. */
export function sobre(l) {
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
  // Un envoi par destinataire, jamais un par commune.
  const parService = new Map();
  for (const l of lignes.filter((l) => l.statut === 'a_envoyer')) {
    if (!parService.has(l.destinataire)) {
      parService.set(l.destinataire, {
        destinataire: l.destinataire, service: l.service_nom, communes: [],
      });
    }
    parService.get(l.destinataire).communes.push(sobre(l));
  }

  const enAttente = lignes.filter((l) => l.statut === 'en_attente').map(sobre);
  const dejaParties = lignes.filter((l) => ['envoyee', 'recue'].includes(l.statut)).map(sobre);
  const pretes = lignes.filter((l) => l.statut === 'a_envoyer').length;

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
      etat: pretes > 0 ? 'ok' : 'echec',
      bloquant: true,
      detail: pretes > 0 ? null : 'Toutes les communes sont en attente ou déjà parties.',
    },
  ];

  const bloquants = controles.filter((c) => c.bloquant && c.etat === 'echec');

  return {
    societe: lignes[0]?.societe || null,
    siren: lignes[0]?.siren || null,
    resume: {
      communes: lignes.length,
      lots: lignes.reduce((n, l) => n + (l.nb_lots || 0), 0),
      courriels: parService.size,
      formulaires: pretes,
      enAttente: enAttente.length,
      dejaParties: dejaParties.length,
    },
    envois: [...parService.values()],
    enAttente,
    dejaParties,
    controles,
    envoiPossible: bloquants.length === 0,
    bloquants: bloquants.map((c) => c.libelle),
  };
}

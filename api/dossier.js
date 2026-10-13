// MATRICE — lecture d'un dossier pour l'écran récapitulatif
//
// Rend tout ce que l'écran affiche, déjà regroupé. La mise en forme et les
// contrôles vivent dans lib/vue-dossier.js, testables sans base : ici on ne
// fait que lire et déléguer.
import { neon } from '@neondatabase/serverless';
import { protege } from '../lib/verrou.js';
import { vueDossier } from '../lib/vue-dossier.js';
import { sceauConfigure } from '../lib/sceau.js';
import { etatLigne } from '../lib/suivi.js';

export default protege(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ erreur: 'GET attendu' });
  const dossier = req.query?.dossier;
  const sql = neon(process.env.DATABASE_URL);

  // ?prochain=1 — le numéro que l'écran d'import proposera. Proposé, pas imposé :
  // le numéro fait le lien avec la gestion de l'étude, c'est le notaire qui sait.
  // Calculé sur le seul millésime courant, pour qu'un vieux dossier mal numéroté
  // ne fasse pas dériver la série.
  if (req.query?.prochain) {
    const annee = new Date().getFullYear();
    const [d] = await sql`
      SELECT max(substring(dossier from '\\d{4}$'))::int AS dernier
        FROM matrice_demande
       WHERE dossier LIKE ${`${annee}-%`}
    `;
    const suivant = (d?.dernier || 0) + 1;
    return res.status(200).json({ propose: `${annee}-${String(suivant).padStart(4, '0')}` });
  }

  if (!dossier) return res.status(400).json({ erreur: 'paramètre dossier obligatoire' });

  try {
    // `services_alternatifs` est indispensable ici : sans lui, vue-dossier.js ne
    // peut pas voir qu'une commune vise plusieurs services, et l'écran
    // afficherait un seul courriel là où deux partent.
    const lignes = await sql`
      SELECT id, code_insee, nom_commune, departement, nb_lots, statut,
             motif_attente, service_nom, destinataire, telephone_relance,
             services_alternatifs,
             prochaine_relance, nb_relances, societe, siren
        FROM matrice_demande
       WHERE dossier = ${dossier}
       ORDER BY statut, nb_lots DESC, nom_commune
    `;
    if (lignes.length === 0) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

    // L'écran doit savoir s'il faut réclamer la phrase de signature. Deux
    // booléens, jamais le contenu : la présence d'un sceau n'est pas un secret,
    // sa clé si.
    const sceau = sceauConfigure();

    // SUIVI DES DEMANDES PARTIES (13/10/2026) — une ligne par envoi et par
    // commune : une commune adressée à deux guichets donne deux lignes, chacune
    // avec sa propre réception (arbitrage du 24/09/2026). Tant que la
    // migration 004 n'est pas passée, les colonnes de réception manquent : le
    // récapitulatif reste lisible, et l'écran dit ce qui manque.
    let suivi = null, suiviErreur = null;
    try {
      suivi = await sql`
        SELECT e.id AS envoi_id, e.service_nom, e.destinataire, e.envoye_le, e.envoye_par,
               d.id AS demande_id, d.code_insee, d.nom_commune, d.departement, d.nb_lots, d.statut,
               ed.recu_le, ed.recu_par,
               ed.nb_relances_service, ed.derniere_relance_service, ed.appels, ed.ferme_le, ed.motif_fermeture,
               EXISTS (SELECT 1 FROM matrice_envoi_demande y
                        WHERE y.demande_id = d.id AND y.envoi_id <> e.id AND y.recu_le IS NOT NULL) AS autre_recue,
               (SELECT count(*) FROM matrice_envoi_demande x WHERE x.demande_id = d.id)::int AS nb_envois
          FROM matrice_envoi e
          JOIN matrice_envoi_demande ed ON ed.envoi_id = e.id
          JOIN matrice_demande d ON d.id = ed.demande_id
         WHERE e.dossier = ${dossier} AND d.statut <> 'abandonnee'
         ORDER BY e.envoye_le, e.id, d.nom_commune
      `;
      // L'état (reçue, à relancer, suspendue, fermée) est calculé ici, par la
      // même règle que la tâche du matin : l'écran ne fait que l'afficher.
      suivi = suivi.map((l) => ({ ...l, ...etatLigne(l) }));
    } catch (err) {
      suiviErreur = /recu_le|recu_par/.test(err.message)
        ? 'migration 004 non passée : le suivi des réceptions n\'est pas encore disponible'
        : /nb_relances_service|derniere_relance_service|appels|ferme_le|motif_fermeture/.test(err.message)
        ? 'migration 005 non passée : la relance des services n\'est pas encore disponible'
        : err.message;
    }

    return res.status(200).json({
      dossier,
      sceau,
      ...vueDossier(lignes),
      suivi,
      suiviErreur,
    });
  } catch (e) {
    console.error('[MATRICE] dossier', e);
    return res.status(500).json({ erreur: e.message });
  }
});

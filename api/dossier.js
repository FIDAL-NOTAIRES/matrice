// MATRICE — lecture d'un dossier pour l'écran récapitulatif
//
// Rend tout ce que l'écran affiche, déjà regroupé. La mise en forme et les
// contrôles vivent dans lib/vue-dossier.js, testables sans base : ici on ne
// fait que lire et déléguer.

import { neon } from '@neondatabase/serverless';
import { protege } from '../lib/verrou.js';
import { vueDossier } from '../lib/vue-dossier.js';
import { sceauConfigure } from '../lib/sceau.js';

export default protege(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ erreur: 'GET attendu' });

  const dossier = req.query?.dossier;
  if (!dossier) return res.status(400).json({ erreur: 'paramètre dossier obligatoire' });

  const sql = neon(process.env.DATABASE_URL);

  try {
    const lignes = await sql`
      SELECT id, code_insee, nom_commune, departement, nb_lots, statut,
             motif_attente, service_nom, destinataire, telephone_relance,
             prochaine_relance, nb_relances, societe, siren
        FROM matrice_demande
       WHERE dossier = ${dossier}
       ORDER BY statut, nb_lots DESC, nom_commune
    `;

    if (lignes.length === 0) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

    // Le mandat est un fait du dossier, pas une case à cocher de l'écran :
    // on le lit sur le dernier envoi réellement parti.
    const [precedent] = await sql`
      SELECT mandat_joint FROM matrice_envoi WHERE dossier = ${dossier}
       ORDER BY envoye_le DESC LIMIT 1
    `;

    // L'écran doit savoir s'il faut réclamer la phrase de signature. Deux
    // booléens, jamais le contenu : la présence d'un sceau n'est pas un secret,
    // sa clé si.
    const sceau = sceauConfigure();

    return res.status(200).json({
      dossier,
      sceau,
      ...vueDossier(lignes, { mandatJoint: precedent?.mandat_joint === true }),
    });
  } catch (e) {
    console.error('[MATRICE] dossier', e);
    return res.status(500).json({ erreur: e.message });
  }
});

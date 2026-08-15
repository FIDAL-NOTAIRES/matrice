// MATRICE — bascule d'une commune en file d'attente, et sortie de file
//
// Appelée par l'écran récapitulatif au moment de l'envoi : les communes dont
// le destinataire n'est pas établi ne partent pas, elles entrent ici.
// Appelée à nouveau quand une adresse est consignée dans corrections.json :
// la commune sort de file et repart dans un envoi de rattrapage.
//
// Déclarer cette fonction dans vercel.json, sans quoi elle rend 404.

import { neon } from '@neondatabase/serverless';
import { prochaineRelance } from '../lib/jours-ouvres.js';

const iso = (d) => d.toISOString().slice(0, 10);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  const sql = neon(process.env.DATABASE_URL);
  const { action, demandeId, motif, serviceNom, telephone, destinataire, auteur } = req.body || {};

  if (!auteur) return res.status(400).json({ erreur: 'auteur obligatoire (initiales)' });

  try {
    // ------------------------------------------------------- mise en attente
    if (action === 'attendre') {
      if (!motif) return res.status(400).json({ erreur: 'motif obligatoire' });

      const echeance = prochaineRelance(new Date());
      const [maj] = await sql`
        UPDATE matrice_demande
           SET statut = 'en_attente',
               motif_attente = ${motif},
               service_nom = ${serviceNom || null},
               telephone_relance = ${telephone || null},
               destinataire = NULL,
               prochaine_relance = ${iso(echeance)}
         WHERE id = ${demandeId}
        RETURNING id, dossier, nom_commune
      `;
      if (!maj) return res.status(404).json({ erreur: 'demande introuvable' });

      await sql`
        INSERT INTO matrice_journal (demande_id, dossier, evenement, detail, auteur)
        VALUES (${maj.id}, ${maj.dossier}, 'attente',
                ${JSON.stringify({ motif, prochaine: iso(echeance) })}::jsonb, ${auteur})
      `;
      return res.status(200).json({ statut: 'en attente', commune: maj.nom_commune, prochaine: iso(echeance) });
    }

    // ------------------------------------------------------------ déblocage
    if (action === 'debloquer') {
      // Une adresse a été trouvée. On ne devine jamais : elle doit être fournie.
      if (!destinataire) return res.status(400).json({ erreur: 'destinataire obligatoire' });

      const [maj] = await sql`
        UPDATE matrice_demande
           SET statut = 'a_envoyer',
               destinataire = ${destinataire},
               service_nom = ${serviceNom || null},
               motif_attente = NULL,
               prochaine_relance = NULL
         WHERE id = ${demandeId} AND statut = 'en_attente'
        RETURNING id, dossier, nom_commune, nb_relances
      `;
      if (!maj) return res.status(409).json({ erreur: 'demande absente de la file' });

      await sql`
        INSERT INTO matrice_journal (demande_id, dossier, evenement, detail, auteur)
        VALUES (${maj.id}, ${maj.dossier}, 'deblocage',
                ${JSON.stringify({ destinataire, apres_relances: maj.nb_relances })}::jsonb, ${auteur})
      `;
      return res.status(200).json({ statut: 'prête à repartir', commune: maj.nom_commune });
    }

    // ------------------------------------------------------------- abandon
    if (action === 'abandonner') {
      if (!motif) return res.status(400).json({ erreur: 'motif obligatoire' });

      const [maj] = await sql`
        UPDATE matrice_demande
           SET statut = 'abandonnee', prochaine_relance = NULL, motif_attente = ${motif}
         WHERE id = ${demandeId}
        RETURNING id, dossier, nom_commune
      `;
      if (!maj) return res.status(404).json({ erreur: 'demande introuvable' });

      await sql`
        INSERT INTO matrice_journal (demande_id, dossier, evenement, detail, auteur)
        VALUES (${maj.id}, ${maj.dossier}, 'abandon', ${JSON.stringify({ motif })}::jsonb, ${auteur})
      `;
      return res.status(200).json({ statut: 'abandonnée', commune: maj.nom_commune });
    }

    return res.status(400).json({ erreur: "action inconnue : attendre | debloquer | abandonner" });
  } catch (e) {
    console.error('[MATRICE] mettre-en-attente', e);
    return res.status(500).json({ erreur: e.message });
  }
}

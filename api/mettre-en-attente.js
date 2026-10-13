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
import { protege, auteurDepuis } from '../lib/verrou.js';
import { destinatairesDe } from '../lib/envois.js';

const iso = (d) => d.toISOString().slice(0, 10);

export default protege(async (req, res, utilisateur) => {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  const sql = neon(process.env.DATABASE_URL);
  const { action, demandeId, motif, serviceNom, telephone, destinataire, envoiId, mode } = req.body || {};

  // L'auteur n'est plus déclaré par l'appelant : il vient du jeton.
  // Une piste d'audit où chacun signe du nom qu'il veut ne prouve rien.
  const auteur = auteurDepuis(utilisateur);

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

    // ------------------------------------------------------- extrait reçu
    // 13/10/2026, arbitrages des 21 et 24/09/2026. Le clic porte sur UNE ligne
    // de suivi, c'est-à-dire un envoi pour une commune. Il :
    //   • pose la réception sur cette ligne et passe la commune en « reçue » ;
    //   • inscrit le service dans matrice_routage_appris — premier arrivé en
    //     tête, un second guichet qui délivre aussi est ajouté à la trace
    //     (`autres_services`) sans jamais prendre la main ;
    //   • journalise CHAQUE clic, auteur et heure.
    // Si une autre ligne de la même commune est déjà marquée reçue, l'écran
    // doit dire ce que vaut ce nouveau clic : « correction » (l'autre clic
    // était une erreur de ligne : le dernier fait foi) ou « seconde » (les
    // deux guichets ont délivré). Sans `mode`, on renvoie 409 avec le choix.
    if (action === 'recu') {
      if (!envoiId || !demandeId) return res.status(400).json({ erreur: 'envoiId et demandeId obligatoires' });
      const [l] = await sql`
        SELECT ed.envoi_id, ed.demande_id, ed.recu_le, e.service_nom, e.destinataire AS envoi_destinataire,
               d.dossier, d.code_insee, d.nom_commune, d.departement, d.destinataire, d.service_nom AS demande_service,
               d.telephone_relance, d.services_alternatifs
          FROM matrice_envoi_demande ed
          JOIN matrice_envoi e ON e.id = ed.envoi_id
          JOIN matrice_demande d ON d.id = ed.demande_id
         WHERE ed.envoi_id = ${envoiId} AND ed.demande_id = ${demandeId}
      `;
      if (!l) return res.status(404).json({ erreur: 'ligne de suivi introuvable' });
      if (l.recu_le) return res.status(409).json({ erreur: 'cette ligne est déjà marquée reçue' });

      const autres = await sql`
        SELECT ed.envoi_id, e.service_nom, e.destinataire
          FROM matrice_envoi_demande ed JOIN matrice_envoi e ON e.id = ed.envoi_id
         WHERE ed.demande_id = ${demandeId} AND ed.envoi_id <> ${envoiId} AND ed.recu_le IS NOT NULL
      `;
      if (autres.length && !['correction', 'seconde'].includes(mode)) {
        return res.status(409).json({
          choix: true,
          erreur: 'une autre ligne de cette commune est déjà marquée reçue',
          autre: autres.map((a) => a.service_nom || a.destinataire).join(', '),
        });
      }
      const modeRetenu = autres.length ? mode : 'premiere';

      // Le service, tel qu'il a été saisi : nom de l'envoi, téléphone retrouvé
      // parmi les destinataires de la commune (retenu ou alternatif).
      const svc = destinatairesDe(l).find((x) => x.destinataire === l.envoi_destinataire) || {};
      const service = {
        service_nom: l.service_nom || svc.serviceNom || null,
        destinataire: l.envoi_destinataire,
        telephone: svc.telephone || null,
      };

      if (modeRetenu === 'correction') {
        await sql`
          UPDATE matrice_envoi_demande SET recu_le = NULL, recu_par = NULL
           WHERE demande_id = ${demandeId} AND envoi_id <> ${envoiId}
        `;
      }
      await sql`
        UPDATE matrice_envoi_demande SET recu_le = now(), recu_par = ${auteur}
         WHERE envoi_id = ${envoiId} AND demande_id = ${demandeId}
      `;
      await sql`UPDATE matrice_demande SET statut = 'recue', prochaine_relance = NULL WHERE id = ${demandeId}`;

      // Routage appris. Pas de ligne pour la commune : ce service devient le
      // premier. Une ligne existe : il reste premier s'il l'est déjà ; une
      // CORRECTION remplace le premier s'il venait de ce même dossier (le clic
      // fautif), sinon le nouveau service rejoint la trace des autres guichets.
      const [appris] = await sql`
        SELECT destinataire, appris_de, autres_services FROM matrice_routage_appris WHERE code_insee = ${l.code_insee}
      `;
      let routage;
      if (!appris) {
        await sql`
          INSERT INTO matrice_routage_appris
            (code_insee, nom_commune, departement, service_nom, destinataire, telephone, appris_de)
          VALUES (${l.code_insee}, ${l.nom_commune}, ${l.departement}, ${service.service_nom || service.destinataire},
                  ${service.destinataire}, ${service.telephone}, ${demandeId})
        `;
        routage = 'premier service inscrit pour la commune';
      } else if (appris.destinataire === service.destinataire) {
        routage = 'service déjà inscrit en tête pour la commune';
      } else if (modeRetenu === 'correction' && Number(appris.appris_de) === Number(demandeId)) {
        const reste = (appris.autres_services || []).filter((a) => a.destinataire !== service.destinataire);
        await sql`
          UPDATE matrice_routage_appris
             SET service_nom = ${service.service_nom || service.destinataire}, destinataire = ${service.destinataire},
                 telephone = ${service.telephone}, appris_le = now(), appris_de = ${demandeId},
                 autres_services = ${JSON.stringify(reste)}::jsonb
           WHERE code_insee = ${l.code_insee}
        `;
        routage = 'premier service corrigé pour la commune';
      } else {
        const trace = (appris.autres_services || []);
        if (!trace.some((a) => a.destinataire === service.destinataire)) {
          trace.push({ ...service, appris_le: new Date().toISOString(), appris_de: Number(demandeId) });
          await sql`
            UPDATE matrice_routage_appris SET autres_services = ${JSON.stringify(trace)}::jsonb
             WHERE code_insee = ${l.code_insee}
          `;
        }
        routage = 'service ajouté à la trace des autres guichets compétents';
      }

      await sql`
        INSERT INTO matrice_journal (demande_id, dossier, evenement, detail, auteur)
        VALUES (${demandeId}, ${l.dossier}, 'reception',
                ${JSON.stringify({ envoi: Number(envoiId), mode: modeRetenu, ...service, routage,
                                   annule: modeRetenu === 'correction' ? autres.map((a) => a.envoi_id) : undefined })}::jsonb,
                ${auteur})
      `;
      return res.status(200).json({ statut: 'reçue', commune: l.nom_commune, mode: modeRetenu, routage });
    }

    return res.status(400).json({ erreur: "action inconnue : attendre | debloquer | abandonner | recu" });
  } catch (e) {
    console.error('[MATRICE] mettre-en-attente', e);
    return res.status(500).json({ erreur: e.message });
  }
});

// MATRICE — relance des demandes en attente
//
// Déclenché par le cron Vercel, chaque matin. Voir vercel.json : une fonction
// non déclarée n'est pas servie, et rend 404 sans rien dire. Le piège a déjà
// été payé sur REDPAR, on ne le repaie pas.
//
// Ce que fait la relance : elle rappelle à l'office ce qui n'est pas parti et
// pourquoi, avec le numéro à appeler. Elle ne relance PAS l'administration, et
// elle n'envoie jamais une demande dont le destinataire n'est pas établi.
// Le rythme est J+7 jours ouvrés, le même que celui des pièces.

import { neon } from '@neondatabase/serverless';
import { prochaineRelance, DELAI_RELANCE_JOURS_OUVRES } from '../lib/jours-ouvres.js';
import { deposerBrouillon } from '../lib/courriel.js';

const iso = (d) => d.toISOString().slice(0, 10);

export default async function handler(req, res) {
  // Le cron Vercel présente un en-tête signé. Sans lui, l'URL serait un bouton
  // « relancer tout le monde » ouvert sur l'internet.
  const attendu = process.env.CRON_SECRET;
  if (!attendu || req.headers.authorization !== `Bearer ${attendu}`) {
    return res.status(401).json({ erreur: 'non autorisé' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const aujourdhui = new Date();
  const simulation = req.query?.simulation === '1';

  try {
    const dues = await sql`
      SELECT id, dossier, societe, siren, code_insee, nom_commune, departement,
             nb_lots, motif_attente, service_nom, telephone_relance,
             nb_relances, prochaine_relance
        FROM matrice_demande
       WHERE statut = 'en_attente'
         AND prochaine_relance <= ${iso(aujourdhui)}
       ORDER BY dossier, departement, nom_commune
    `;

    if (dues.length === 0) {
      return res.status(200).json({ statut: 'rien à relancer', le: iso(aujourdhui) });
    }

    // Une relance par dossier, pas une par commune : sept courriels pour sept
    // communes du même dossier, personne ne les lit.
    const parDossier = new Map();
    for (const d of dues) {
      if (!parDossier.has(d.dossier)) parDossier.set(d.dossier, []);
      parDossier.get(d.dossier).push(d);
    }

    const echeance = prochaineRelance(aujourdhui);
    const compte = [];

    for (const [dossier, lignes] of parDossier) {
      const corps = redigerRelance(dossier, lignes, aujourdhui, echeance);

      if (!simulation) {
        await deposerBrouillon({
          objet: `MATRICE — ${lignes.length} demande${lignes.length > 1 ? 's' : ''} en attente · dossier ${dossier}`,
          corps,
          // Rappel interne : il part à l'office, jamais à l'administration.
          destinataires: (process.env.MATRICE_RELANCE_A || '').split(',').filter(Boolean),
        });

        for (const d of lignes) {
          await sql`
            UPDATE matrice_demande
               SET nb_relances = nb_relances + 1,
                   derniere_relance = now(),
                   prochaine_relance = ${iso(echeance)}
             WHERE id = ${d.id}
          `;
          await sql`
            INSERT INTO matrice_journal (demande_id, dossier, evenement, detail, auteur)
            VALUES (${d.id}, ${dossier}, 'relance',
                    ${JSON.stringify({
                      rang: d.nb_relances + 1,
                      motif: d.motif_attente,
                      prochaine: iso(echeance),
                    })}::jsonb,
                    'MATRICE')
          `;
        }
      }

      compte.push({ dossier, communes: lignes.length, prochaine: iso(echeance) });
    }

    return res.status(200).json({
      statut: simulation ? 'simulation' : 'relancé',
      le: iso(aujourdhui),
      delai: `${DELAI_RELANCE_JOURS_OUVRES} jours ouvrés`,
      dossiers: compte,
    });
  } catch (e) {
    // Un échec de relance est silencieux par nature : personne ne remarque
    // un rappel qui n'arrive pas. On le rend donc bruyant côté logs.
    console.error('[MATRICE] échec de la relance', e);
    return res.status(500).json({ erreur: 'échec de la relance', message: e.message });
  }
}

/** Le corps du rappel. Court, et il dit quoi faire. */
function redigerRelance(dossier, lignes, le, echeance) {
  const societe = lignes[0].societe;
  const lots = lignes.reduce((n, l) => n + (l.nb_lots || 0), 0);

  const details = lignes
    .map((l) => {
      const rang = l.nb_relances === 0 ? 'premier rappel' : `${l.nb_relances + 1}ᵉ rappel`;
      const tel = l.telephone_relance ? ` — appeler le ${l.telephone_relance}` : '';
      return [
        `• ${l.nom_commune} (${l.code_insee}, dép. ${l.departement}) — ${l.nb_lots} lot${l.nb_lots > 1 ? 's' : ''}, ${rang}`,
        `    ${l.motif_attente}`,
        `    ${l.service_nom || 'service non identifié'}${tel}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    `Dossier ${dossier} — ${societe}`,
    ``,
    `${lignes.length} demande${lignes.length > 1 ? 's' : ''} d'extrait de matrice ${lignes.length > 1 ? 'ne sont' : "n'est"} pas partie${lignes.length > 1 ? 's' : ''}, pour ${lots} lot${lots > 1 ? 's' : ''}.`,
    `Le reste du dossier a été envoyé : seules les communes ci-dessous restent en file.`,
    ``,
    details,
    ``,
    `Pour débloquer : obtenir l'adresse du service par téléphone, puis la consigner`,
    `dans corrections.json. La commune repart alors d'elle-même dans un envoi de`,
    `rattrapage, et ce rappel s'éteint.`,
    ``,
    `Sans action, prochain rappel le ${echeance.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.`,
    ``,
    `— MATRICE, ${le.toLocaleDateString('fr-FR', { timeZone: 'UTC' })}`,
  ].join('\n');
}

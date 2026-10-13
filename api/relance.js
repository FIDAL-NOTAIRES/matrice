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
import { etatLigne, aDisqualifier, DELAI_DISQUALIFICATION_JOURS } from '../lib/suivi.js';

// Le rappel des services à relancer part les MARDIS et JEUDIS (rythme commun
// avec MARTEAU) ; la fermeture des lignes à soixante jours tourne chaque matin.
const JOURS_RAPPEL = [2, 4];
const ADRESSE_MATRICE = process.env.MATRICE_URL || 'https://matrice-black.vercel.app';

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
    // Suivi des demandes PARTIES (13/10/2026) — indépendant des communes en
    // attente : il tourne même quand la file d'attente est vide. Une panne
    // ici ne doit pas empêcher le rappel de la file : on la rend, on continue.
    let suivi;
    try { suivi = await suiviDesEnvois(sql, aujourdhui, simulation); }
    catch (e) { console.error('[MATRICE] suivi des envois', e); suivi = { erreur: e.message }; }

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
      return res.status(200).json({ statut: 'rien à relancer', le: iso(aujourdhui), suivi });
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
      suivi,
    });
  } catch (e) {
    // Un échec de relance est silencieux par nature : personne ne remarque
    // un rappel qui n'arrive pas. On le rend donc bruyant côté logs.
    console.error('[MATRICE] échec de la relance', e);
    return res.status(500).json({ erreur: 'échec de la relance', message: e.message });
  }
}

/**
 * Suivi des demandes parties : (1) chaque matin, ferme les lignes suspendues
 * depuis soixante jours et disqualifie leur guichet pour la commune ; (2) les
 * mardis et jeudis, rappelle à l'office les services à relancer, dossier par
 * dossier, avec le lien vers l'écran où se trouvent les boutons « Extrait
 * reçu » et « Relancer le service ». Rien ne part vers l'administration.
 */
async function suiviDesEnvois(sql, aujourdhui, simulation) {
  const lignes = await sql`
    SELECT ed.envoi_id, ed.demande_id, ed.recu_le, ed.ferme_le, ed.nb_relances_service,
           ed.derniere_relance_service, ed.appels,
           e.envoye_le, e.service_nom, e.destinataire, e.dossier,
           d.nom_commune, d.code_insee, d.societe,
           EXISTS (SELECT 1 FROM matrice_envoi_demande y
                    WHERE y.demande_id = d.id AND y.envoi_id <> e.id AND y.recu_le IS NOT NULL) AS autre_recue
      FROM matrice_envoi_demande ed
      JOIN matrice_envoi e ON e.id = ed.envoi_id
      JOIN matrice_demande d ON d.id = ed.demande_id
     WHERE ed.recu_le IS NULL AND ed.ferme_le IS NULL AND d.statut <> 'abandonnee'
     ORDER BY e.dossier, e.id, d.nom_commune
  `;

  // (1) disqualification à soixante jours — définitive, commune par commune.
  const fermees = [];
  for (const l of lignes.filter((x) => aDisqualifier(x, aujourdhui))) {
    fermees.push({ dossier: l.dossier, commune: l.nom_commune, guichet: l.destinataire });
    if (simulation) continue;
    const motif = `aucune réponse ${DELAI_DISQUALIFICATION_JOURS} jours après l'envoi, un autre guichet ayant délivré l'extrait`;
    await sql`
      UPDATE matrice_envoi_demande SET ferme_le = now(), motif_fermeture = ${motif}
       WHERE envoi_id = ${l.envoi_id} AND demande_id = ${l.demande_id}
    `;
    const [a] = await sql`SELECT disqualifies FROM matrice_routage_appris WHERE code_insee = ${l.code_insee}`;
    if (a && !(a.disqualifies || []).some((x) => x.destinataire === l.destinataire)) {
      const liste = [...(a.disqualifies || []), { service_nom: l.service_nom, destinataire: l.destinataire, le: new Date().toISOString(), motif }];
      await sql`UPDATE matrice_routage_appris SET disqualifies = ${JSON.stringify(liste)}::jsonb WHERE code_insee = ${l.code_insee}`;
    }
    await sql`
      INSERT INTO matrice_journal (demande_id, dossier, evenement, detail, auteur)
      VALUES (${l.demande_id}, ${l.dossier}, 'disqualification',
              ${JSON.stringify({ envoi: l.envoi_id, destinataire: l.destinataire, service: l.service_nom, motif })}::jsonb, 'MATRICE')
    `;
  }

  // (2) rappel des services à relancer, les mardis et jeudis seulement.
  // jour de la semaine à Paris (0 = dimanche, 2 = mardi, 4 = jeudi)
  const jour = new Date(aujourdhui.toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getDay();
  const aRelancer = lignes.map((l) => ({ ...l, ...etatLigne(l, aujourdhui) })).filter((l) => l.etat === 'a_relancer');
  let rappels = 0;
  if (JOURS_RAPPEL.includes(jour) && aRelancer.length) {
    const parDossier = new Map();
    for (const l of aRelancer) {
      if (!parDossier.has(l.dossier)) parDossier.set(l.dossier, new Map());
      const env = parDossier.get(l.dossier);
      if (!env.has(l.envoi_id)) env.set(l.envoi_id, []);
      env.get(l.envoi_id).push(l);
    }
    for (const [dossier, envois] of parDossier) {
      const blocs = [...envois.values()].map((ls) => {
        const t = ls[0], rang = Math.max(...ls.map((x) => x.rang));
        return [
          `• ${t.service_nom || t.destinataire} — ${t.destinataire}`,
          `    parti le ${new Date(t.envoye_le).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}, ${rang > 1 ? `${rang}ᵉ relance` : 'première relance'} due`,
          `    ${ls.map((x) => x.nom_commune).join(', ')}`,
          ls.some((x) => x.appelRequis) ? `    APPELER LE SERVICE D'ABORD : l'appel se consigne au moment de préparer la relance.` : null,
        ].filter(Boolean).join('\n');
      });
      const lien = `${ADRESSE_MATRICE}/?dossier=${encodeURIComponent(dossier)}`;
      const corps = [
        `Dossier ${dossier} — ${[...envois.values()][0][0].societe}`, '',
        `Des demandes d'extrait de matrice sont parties sans réponse depuis plus de quinze jours :`, '',
        blocs.join('\n\n'), '',
        `Extrait arrivé ? Ouvrez le dossier et cliquez « Extrait reçu » sur la commune.`,
        `Toujours rien ? Ouvrez le dossier et cliquez « Relancer le service » : MATRICE prépare le brouillon, vous l'envoyez.`, '',
        lien, '',
        `— MATRICE, ${aujourdhui.toLocaleDateString('fr-FR', { timeZone: 'UTC' })}`,
      ].join('\n');
      if (!simulation) {
        await deposerBrouillon({
          objet: `MATRICE — services à relancer · dossier ${dossier}`,
          corps,
          destinataires: (process.env.MATRICE_RELANCE_A || '').split(',').filter(Boolean),
        });
      }
      rappels++;
    }
  }
  return { fermees, aRelancer: aRelancer.length, rappels, jourDeRappel: JOURS_RAPPEL.includes(jour) };
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

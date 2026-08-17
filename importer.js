// MATRICE — import d'un portefeuille dans la file
//
// Reçoit la liste des communes d'un dossier (issue de l'export REDPAR), route
// chacune vers son service, et écrit le résultat dans matrice_demande :
// celles qui ont un destinataire sûr passent en `a_envoyer`, les autres entrent
// en file d'attente avec le motif en clair et une échéance de relance.
//
// Rien n'est envoyé ici. L'écran récapitulatif relit ensuite ces lignes,
// les présente, et c'est un humain qui déclenche.

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join } from 'path';
import { routerPortefeuille } from '../lib/routage.js';
import { prochaineRelance } from '../lib/jours-ouvres.js';
import { protege, auteurDepuis } from '../lib/verrou.js';

const iso = (d) => d.toISOString().slice(0, 10);

// Les référentiels sont lus une fois par instance, pas à chaque appel :
// 500 ko de JSON relus à chaque demande, c'est du gaspillage pur.
let REF = null, CORR = null;
function referentiels() {
  if (!REF) {
    const dossier = join(process.cwd(), 'data');
    REF = JSON.parse(readFileSync(join(dossier, 'sdif-departements.json'), 'utf8'));
    CORR = JSON.parse(readFileSync(join(dossier, 'corrections.json'), 'utf8'));
  }
  return { REF, CORR };
}

export default protege(async (req, res, utilisateur) => {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  const { dossier, societe, siren, communes, simulation } = req.body || {};
  if (!dossier || !societe) return res.status(400).json({ erreur: 'dossier et societe obligatoires' });
  if (!Array.isArray(communes) || communes.length === 0) {
    return res.status(400).json({ erreur: 'communes attendu : [{code_insee, nom_commune, nb_lots}]' });
  }

  const auteur = auteurDepuis(utilisateur);
  const { REF, CORR } = referentiels();
  const resultat = routerPortefeuille(communes, REF, CORR);

  // La simulation rend exactement ce que l'écran affichera, sans rien écrire.
  // C'est ce qui permet de relire un portefeuille avant de l'engager.
  if (simulation) {
    return res.status(200).json({
      simulation: true,
      referentielDu: REF.pivoteLe,
      ...resultat,
    });
  }

  const sql = neon(process.env.DATABASE_URL);
  const echeance = iso(prochaineRelance(new Date()));
  let creees = 0, majs = 0;

  try {
    for (const l of resultat.lignes) {
      const enAttente = l.statut === 'en_attente';
      const [ligne] = await sql`
        INSERT INTO matrice_demande
          (dossier, societe, siren, code_insee, nom_commune, departement, nb_lots,
           statut, motif_attente, service_nom, destinataire, telephone_relance, prochaine_relance)
        VALUES
          (${dossier}, ${societe}, ${siren || null}, ${l.code_insee}, ${l.nom_commune},
           ${l.departement || '??'}, ${l.nb_lots || 0},
           ${l.statut}, ${l.motif}, ${l.serviceNom}, ${l.destinataire}, ${l.telephone},
           ${enAttente ? echeance : null})
        ON CONFLICT (dossier, code_insee) DO UPDATE SET
           nb_lots = EXCLUDED.nb_lots,
           statut = CASE WHEN matrice_demande.statut IN ('envoyee','recue')
                         THEN matrice_demande.statut ELSE EXCLUDED.statut END,
           motif_attente = EXCLUDED.motif_attente,
           service_nom = EXCLUDED.service_nom,
           destinataire = EXCLUDED.destinataire,
           telephone_relance = EXCLUDED.telephone_relance,
           prochaine_relance = CASE WHEN matrice_demande.statut IN ('envoyee','recue')
                                    THEN matrice_demande.prochaine_relance ELSE EXCLUDED.prochaine_relance END
        RETURNING id, (xmax = 0) AS creee
      `;
      ligne.creee ? creees++ : majs++;

      await sql`
        INSERT INTO matrice_journal (demande_id, dossier, evenement, detail, auteur)
        VALUES (${ligne.id}, ${dossier}, ${ligne.creee ? 'creation' : 'maj'},
                ${JSON.stringify({
                  commune: l.nom_commune, code: l.code_insee, lots: l.nb_lots,
                  statut: l.statut, destinataire: l.destinataire, motif: l.motif,
                  referentielDu: REF.pivoteLe,
                })}::jsonb, ${auteur})
      `;
    }

    return res.status(200).json({
      dossier, societe,
      referentielDu: REF.pivoteLe,
      creees, majs,
      resume: resultat.resume,
      envois: resultat.envois.map((e) => ({
        destinataire: e.destinataire, service: e.serviceNom, formulaires: e.communes.length,
      })),
      enAttente: resultat.enAttente.map((l) => ({
        commune: l.nom_commune, code: l.code_insee, departement: l.departement,
        motif: l.motif, telephone: l.telephone, prochaineRelance: echeance,
      })),
    });
  } catch (e) {
    console.error('[MATRICE] import', e);
    return res.status(500).json({ erreur: e.message });
  }
});

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
import { analyser } from '../lib/portefeuille.js';
import { completer, verifierCodes } from '../lib/communes.js';

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

  const { dossier, societe, siren, communes, texte, simulation, precisions } = req.body || {};
  if (!dossier || !societe) return res.status(400).json({ erreur: 'dossier et societe obligatoires' });

  // Deux entrées possibles. `communes` est le contrat machine — c'est par là
  // qu'un orchestrateur poussera un portefeuille. `texte` est l'entrée humaine :
  // ce qu'on colle depuis Excel, depuis REDPAR, ou les noms des dossiers Drive.
  //
  // La lecture du texte se fait ICI et non dans le navigateur : interpréter des
  // données est une décision, et les décisions ne descendent pas dans l'écran.
  let lecture = null;
  let entree = communes;

  if (!Array.isArray(entree) || entree.length === 0) {
    if (!texte || !String(texte).trim()) {
      return res.status(400).json({
        erreur: 'portefeuille absent',
        detail: 'Fournissez `communes` : [{code_insee, nom_commune, nb_lots}], ou `texte` à analyser.',
      });
    }
    lecture = analyser(texte);
    if (lecture.lignes.length === 0) {
      return res.status(400).json({ erreur: 'aucune commune reconnue', anomalies: lecture.anomalies });
    }
    entree = lecture.lignes;
  }

  // Les précisions sont les arbitrages de l'humain sur les noms que l'annuaire
  // n'a pas su trancher : « SAINT ANDRE » vaut 59527. Elles s'appliquent AVANT
  // la résolution, et le code fourni passe ensuite le même contrôle que les
  // autres — préciser n'est pas contourner.
  const arbitrages = new Map(Object.entries(precisions || {})
    .filter(([, code]) => /^(?:\d{5}|2[AB]\d{3})$/i.test(String(code || '').trim()))
    .map(([nom, code]) => [String(nom), String(code).trim().toUpperCase()]));

  // Les lignes sans code INSEE doivent être résolues avant tout routage : le
  // référentiel SDIF se lit par code, jamais par nom.
  const { resolues, nonResolues } = await completer(entree.map((l) => ({
    code_insee: l.code_insee || arbitrages.get(String(l.nom_commune)) || null,
    nom_commune: l.nom_commune || null,
    nb_lots: Number(l.nb_lots) || 0,
  })));

  // Un code fourni n'est pas un code valide. Le contrôle des communes disparues
  // ne doit pas s'appliquer aux seuls noms : c'est un code périmé, LOMME 59355,
  // qui avait traversé tout le routage sans être vu.
  const { perimes, noms, controleImpossible } = await verifierCodes(resolues.map((l) => l.code_insee));
  const perimesSet = new Set(perimes);
  const valides = resolues.filter((l) => !perimesSet.has(l.code_insee));
  for (const l of resolues.filter((l) => perimesSet.has(l.code_insee))) {
    nonResolues.push({
      ...l,
      motif: `code INSEE ${l.code_insee} inconnu du Code officiel géographique — commune fusionnée, `
        + 'supprimée, ou code erroné',
    });
  }

  if (valides.length === 0) {
    return res.status(422).json({
      erreur: 'aucune commune n’a pu être identifiée',
      format: lecture?.format || 'fourni',
      nonResolues,
      anomalies: lecture?.anomalies || [],
    });
  }

  // Deux lignes peuvent désigner la même commune une fois les précisions
  // appliquées : LOMME précisée en 59350 rejoint LILLE. Il faut les FUSIONNER
  // avant tout routage — l'écriture en base se fait sur (dossier, code_insee),
  // et la seconde ligne écraserait silencieusement les lots de la première.
  const parCode = new Map();
  for (const l of valides) {
    const e = parCode.get(l.code_insee);
    if (e) { e.nb_lots += l.nb_lots || 0; continue; }
    // Le nom retenu est celui du Code officiel géographique, pas celui qui
    // figurait dans le portefeuille — c'est lui qui sera imprimé sur le Cerfa.
    parCode.set(l.code_insee, { ...l, nom_commune: noms.get(l.code_insee) || l.nom_commune });
  }
  const fusionnees = [...parCode.values()];

  const auteur = auteurDepuis(utilisateur);
  const { REF, CORR } = referentiels();
  const resultat = routerPortefeuille(fusionnees, REF, CORR);

  // La simulation rend exactement ce que l'écran affichera, sans rien écrire.
  // C'est ce qui permet de relire un portefeuille avant de l'engager.
  if (simulation) {
    return res.status(200).json({
      simulation: true,
      referentielDu: REF.pivoteLe,
      format: lecture?.format || 'fourni',
      anomalies: lecture?.anomalies || [],
      nonResolues,
      controleCommunes: controleImpossible
        ? 'NON EFFECTUÉ — annuaire des communes injoignable ; les codes n’ont pas été vérifiés'
        : 'codes vérifiés contre le Code officiel géographique',
      ...resultat,
    });
  }

  // Écriture refusée tant qu'une commune reste non identifiée. Importer les
  // autres en silence donnerait un dossier incomplet dont personne ne saurait
  // qu'il l'est — c'est exactement ce que la règle du 15 août interdit.
  if (nonResolues.length) {
    return res.status(422).json({
      erreur: 'communes non identifiées',
      detail: 'Corrigez ces lignes, ou donnez leur code INSEE, puis relancez l’import.',
      nonResolues,
      anomalies: lecture?.anomalies || [],
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
                  ...(arbitrages.has(String(l.nom_commune))
                    ? { codePrecisePar: auteur } : {}),
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

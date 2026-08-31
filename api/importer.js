// MATRICE — import d'un portefeuille dans la file
//
// Reçoit la liste des communes d'un dossier (issue de l'export REDPAR), route
// chacune vers son service, et écrit le résultat dans matrice_demande :
// celles qui ont un destinataire sûr passent en `a_envoyer`, les autres entrent
// en file d'attente avec le motif en clair et une échéance de relance.
//
// Rien n'est envoyé ici. L'écran récapitulatif relit ensuite ces lignes,
// les présente, et c'est un humain qui déclenche.
//
// DEUX PASSES DE ROUTAGE (31/08/2026)
//
// 1. `routerPortefeuille` décide sur le référentiel — corrections.json v4 — et
//    sur les communes déjà APPRISES par une réponse reçue d'un service.
// 2. `deduireParVoisinage` rattrape ensuite les communes revenues en attente,
//    en regardant les cinq communes référencées les plus proches DANS LE MÊME
//    DÉPARTEMENT. Environ 10 000 communes sur 34 969 ne sont pas routables par
//    le référentiel : c'est un référentiel incomplet, pas un choix.
//
// La déduction est ici et non dans lib/routage.js à dessein : c'est un
// mécanisme de rattrapage, pas la règle normale. L'ordre reste lisible, et la
// couper tient en une constante.
//
// Sur convergence des cinq voisines, on route directement — objectif de JFD :
// aller vite. Sur divergence, toutes les adresses qui remontent sont retenues
// et un courriel distinct partira vers chacune, aucun service ne sachant que
// les autres sont saisis. Le coût d'un courriel en trop est nul ; celui
// d'attendre quinze jours pour découvrir qu'on a écrit au mauvais service ne
// l'est pas.
//
// Une adresse déduite n'est JAMAIS `confirmee` : seule une réponse reçue
// confirme une adresse.

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join } from 'path';
import { routerPortefeuille } from '../lib/routage.js';
import { deduireParVoisinage, traceDeduction } from '../lib/voisinage.js';
import { grouperEnvois, compterFormulaires } from '../lib/envois.js';
import { prochaineRelance } from '../lib/jours-ouvres.js';
import { protege, auteurDepuis } from '../lib/verrou.js';
import { analyser } from '../lib/portefeuille.js';
import { completer, verifierCodes } from '../lib/communes.js';

const iso = (d) => d.toISOString().slice(0, 10);

// Passer à false coupe la seconde passe : les communes absentes du référentiel
// repartent en attente, comme avant le 31/08/2026.
const DEDUCTION_PAR_VOISINAGE = true;

// Les référentiels sont lus une fois par instance, pas à chaque appel :
// 500 ko de JSON relus à chaque demande, c'est du gaspillage pur.
let REF = null, CORR = null, CENTRES = null;
function referentiels() {
  if (!REF) {
    const dossier = join(process.cwd(), 'data');
    REF = JSON.parse(readFileSync(join(dossier, 'sdif-departements.json'), 'utf8'));
    CORR = JSON.parse(readFileSync(join(dossier, 'corrections.json'), 'utf8'));
    // 870 ko. Chargé même quand la déduction est coupée : le coût est payé une
    // fois par instance, et un chargement conditionnel rendrait le code moins
    // lisible pour une économie qu'on ne mesurerait pas.
    CENTRES = JSON.parse(readFileSync(join(dossier, 'communes-centres.json'), 'utf8')).centres;
  }
  return { REF, CORR, CENTRES };
}

/**
 * Communes dont le service a été établi par une réponse reçue. Indexées par
 * code INSEE pour que lib/routage.js les consulte en O(1). Une panne de lecture
 * ne doit pas empêcher un import : on repart sur le référentiel seul.
 */
async function communesApprises(sql) {
  try {
    const lignes = await sql`
      SELECT code_insee, service_nom, destinataire, telephone, appris_le
        FROM matrice_routage_appris
    `;
    return Object.fromEntries(lignes.map((l) => [l.code_insee, l]));
  } catch (e) {
    console.error('[MATRICE] lecture matrice_routage_appris', e);
    return {};
  }
}

/**
 * Regroupe et recompte après la seconde passe. Les lignes ont été modifiées sur
 * place : on ne re-route pas, on regroupe. Même logique de groupement que
 * routerPortefeuille — celle de lib/envois.js, partagée avec vue-dossier.js et
 * envoyer.js.
 */
function regrouper(resultat) {
  const lignes = resultat.lignes;
  const aEnvoyer = lignes.filter((l) => l.statut === 'a_envoyer');
  const envois = grouperEnvois(aEnvoyer, (l) => l);

  return {
    lignes,
    envois,
    enAttente: lignes.filter((l) => l.statut === 'en_attente'),
    resume: {
      communes: lignes.length,
      lots: lignes.reduce((n, l) => n + (l.nb_lots || 0), 0),
      courriels: envois.length,
      formulaires: compterFormulaires(aEnvoyer),
      communesPretes: aEnvoyer.length,
      enAttente: lignes.length - aEnvoyer.length,
      adressesNonConfirmees: aEnvoyer.filter((l) => l.etatAdresse !== 'confirmee').length,
    },
  };
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
  const { REF, CORR, CENTRES } = referentiels();
  const sql = neon(process.env.DATABASE_URL);
  const appris = await communesApprises(sql);

  // ---------------------------------------------------------- première passe
  const premiere = routerPortefeuille(fusionnees, REF, CORR, appris);

  // ---------------------------------------------------------- seconde passe
  // Rattrapage par voisinage sur les seules communes mises en attente. La trace
  // de chaque déduction est conservée pour être écrite dans matrice_journal :
  // dans six mois, on doit pouvoir dire POURQUOI MATRICE a écrit à ce service.
  const deductions = new Map();
  if (DEDUCTION_PAR_VOISINAGE) {
    for (const l of premiere.lignes) {
      if (l.statut !== 'en_attente') continue;

      const d = deduireParVoisinage(l.code_insee, CENTRES, CORR);
      if (d.statut === 'impossible') continue;

      deductions.set(l.code_insee, d);
      l.statut = 'a_envoyer';
      l.destinataire = d.destinataire;
      l.serviceNom = d.serviceNom;
      l.telephone = d.telephone;
      // Déduite, jamais confirmée : l'écran doit pouvoir le dire, et le
      // compteur `adressesNonConfirmees` reste juste.
      l.etatAdresse = 'deduite';
      l.origineAdresse = 'déduction par voisinage';
      l.resolution = `voisinage (${d.statut})`;
      // Le motif d'attente disparaît sur convergence ; sur divergence il
      // devient l'explication du routage multiple, et reste affiché.
      l.motif = d.statut === 'divergent' ? d.motif : null;
      l.servicesAlternatifs = d.statut === 'divergent'
        ? d.voisines
            .filter((v) => v.destinataire && v.destinataire !== d.destinataire)
            .filter((v, i, t) => t.findIndex((x) => x.destinataire === v.destinataire) === i)
            .map((v) => ({ destinataire: v.destinataire, service_nom: v.serviceNom, telephone: v.telephone }))
        : null;
    }
  }

  // Les comptes de la première passe sont périmés dès qu'une commune a changé
  // de statut : on regroupe et on recompte sur les lignes telles qu'elles sont.
  const resultat = deductions.size ? regrouper(premiere) : premiere;

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
      deduites: [...deductions.entries()].map(([code, d]) => ({
        code, statut: d.statut, retenu: d.destinataire,
        voisines: d.voisines.map((v) => ({ code: v.code, km: v.km, service: v.destinataire })),
      })),
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

  const echeance = iso(prochaineRelance(new Date()));
  let creees = 0, majs = 0;

  try {
    for (const l of resultat.lignes) {
      const enAttente = l.statut === 'en_attente';
      const [ligne] = await sql`
        INSERT INTO matrice_demande
          (dossier, societe, siren, code_insee, nom_commune, departement, nb_lots,
           statut, motif_attente, service_nom, destinataire, telephone_relance,
           services_alternatifs, prochaine_relance)
        VALUES
          (${dossier}, ${societe}, ${siren || null}, ${l.code_insee}, ${l.nom_commune},
           ${l.departement || '??'}, ${l.nb_lots || 0},
           ${l.statut}, ${l.motif}, ${l.serviceNom}, ${l.destinataire}, ${l.telephone},
           ${l.servicesAlternatifs ? JSON.stringify(l.servicesAlternatifs) : null},
           ${enAttente ? echeance : null})
        ON CONFLICT (dossier, code_insee) DO UPDATE SET
           nb_lots = EXCLUDED.nb_lots,
           statut = CASE WHEN matrice_demande.statut IN ('envoyee','recue')
                         THEN matrice_demande.statut ELSE EXCLUDED.statut END,
           motif_attente = EXCLUDED.motif_attente,
           service_nom = EXCLUDED.service_nom,
           destinataire = EXCLUDED.destinataire,
           telephone_relance = EXCLUDED.telephone_relance,
           services_alternatifs = EXCLUDED.services_alternatifs,
           prochaine_relance = CASE WHEN matrice_demande.statut IN ('envoyee','recue')
                                    THEN matrice_demande.prochaine_relance ELSE EXCLUDED.prochaine_relance END
        RETURNING id, (xmax = 0) AS creee
      `;
      ligne.creee ? creees++ : majs++;

      const deduction = deductions.get(l.code_insee);

      await sql`
        INSERT INTO matrice_journal (demande_id, dossier, evenement, detail, auteur)
        VALUES (${ligne.id}, ${dossier}, ${ligne.creee ? 'creation' : 'maj'},
                ${JSON.stringify({
                  commune: l.nom_commune, code: l.code_insee, lots: l.nb_lots,
                  statut: l.statut, destinataire: l.destinataire, motif: l.motif,
                  referentielDu: REF.pivoteLe,
                  ...(arbitrages.has(String(l.nom_commune))
                    ? { codePrecisePar: auteur } : {}),
                  // La trace de la déduction : les cinq voisines consultées et
                  // le service qu'elles portaient. C'est ce qui rend le routage
                  // explicable après coup.
                  ...(deduction ? { deduction: traceDeduction(l.code_insee, deduction) } : {}),
                })}::jsonb, ${auteur})
      `;
    }

    return res.status(200).json({
      dossier, societe,
      referentielDu: REF.pivoteLe,
      creees, majs,
      resume: resultat.resume,
      deduites: deductions.size,
      envois: resultat.envois.map((e) => ({
        destinataire: e.destinataire, service: e.serviceNom,
        formulaires: e.communes.length, issuDeDivergence: e.issuDeDivergence,
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

// MATRICE — génération des formulaires et dépôt des brouillons
//
// Dernier maillon : prend les demandes prêtes d'un dossier, fabrique un Cerfa
// par commune, groupe par service, et dépose un brouillon par service dans la
// boîte du collaborateur connecté. Il ne clique jamais sur « Envoyer » — c'est
// l'humain qui relit et qui envoie.
//
// Arbitrage de JFD : le dépôt du brouillon vaut envoi. Les demandes passent
// donc en `envoyee` ici même. Contrepartie assumée, et compensée dans
// api/relance.js : un brouillon jamais expédié ne serait plus relancé, alors
// le rappel du matin signale séparément les envois sans réponse au-delà de
// 7 jours ouvrés.

import { neon } from '@neondatabase/serverless';
import { protege, auteurDepuis } from '../lib/verrou.js';
import { remplirCerfa } from '../lib/cerfa.js';
import { imagesScellees } from '../lib/sceau.js';
import { deposerBrouillon } from '../lib/courriel.js';
import { envelopper, e as ech, p, vide } from '../lib/signature-mail.js';

// L'identité du demandeur, c'est l'office. Elle ne vient pas de l'appelant :
// un écran qui choisit qui demande pourrait demander au nom de n'importe qui.
//
// Aucune valeur par défaut. Un espace réservé qui ressemble à une vraie donnée
// est exactement ce qu'on finit par ne plus voir — et il partirait à
// l'administration sous le timbre de l'office.
const OFFICE = {
  nom: process.env.MATRICE_OFFICE_NOM,
  adresse: process.env.MATRICE_OFFICE_ADRESSE,
  codePostal: process.env.MATRICE_OFFICE_CP,
  commune: process.env.MATRICE_OFFICE_COMMUNE,
};

/** Les quatre champs du cadre « demandeur » sont obligatoires, sans exception. */
function officeIncomplet() {
  const manquants = Object.entries(OFFICE)
    .filter(([, v]) => !String(v || '').trim())
    .map(([k]) => `MATRICE_OFFICE_${{ nom: 'NOM', adresse: 'ADRESSE', codePostal: 'CP', commune: 'COMMUNE' }[k]}`);
  return manquants.length ? manquants : null;
}

export default protege(async (req, res, utilisateur, jetonDelegue) => {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  const { dossier, simulation, passeSignature } = req.body || {};
  if (!dossier) return res.status(400).json({ erreur: 'dossier obligatoire' });

  // Refus franc plutôt qu'un formulaire à moitié rempli. Le cadre « demandeur »
  // du Cerfa identifie l'office auprès de l'administration : incomplet, la
  // demande n'est plus celle qu'on croit faire.
  const manquants = officeIncomplet();
  if (manquants) {
    return res.status(503).json({
      erreur: "identité de l'office incomplète",
      detail: 'Le cadre « demandeur » du formulaire serait lacunaire. Posez ces variables :',
      variables: manquants,
    });
  }

  const sql = neon(process.env.DATABASE_URL);
  const auteur = auteurDepuis(utilisateur);

  try {
    const pretes = await sql`
      SELECT id, code_insee, nom_commune, departement, nb_lots,
             service_nom, destinataire, societe, siren
        FROM matrice_demande
       WHERE dossier = ${dossier} AND statut = 'a_envoyer'
       ORDER BY nom_commune
    `;
    if (pretes.length === 0) return res.status(409).json({ erreur: 'aucune demande prête dans ce dossier' });

    // Ceinture et bretelles : la base l'interdit déjà par contrainte CHECK,
    // on ne veut pas découvrir le problème au moment de l'INSERT.
    const orphelines = pretes.filter((l) => !l.destinataire);
    if (orphelines.length) {
      return res.status(409).json({
        erreur: 'demandes sans destinataire',
        communes: orphelines.map((l) => l.nom_commune),
      });
    }

    // La signature manuscrite est scellée : la phrase secrète de l'appelant est
    // la clé qui l'ouvre, pas un mot de passe qu'on compare. Une phrase fausse
    // arrête l'envoi — rendre des formulaires non signés à quelqu'un qui croit
    // les avoir signés serait la pire des issues.
    let sceau;
    try {
      sceau = imagesScellees(passeSignature);
    } catch (e) {
      if (e.phraseFausse) {
        return res.status(403).json({
          erreur: 'phrase de signature refusée',
          detail: "Le bloc scellé n'a pas pu être ouvert. Rien n'a été généré ni envoyé.",
        });
      }
      throw e;
    }
    const images = sceau.images;
    const maintenant = new Date();
    const groupes = new Map();
    for (const l of pretes) {
      if (!groupes.has(l.destinataire)) groupes.set(l.destinataire, { service: l.service_nom, lignes: [] });
      groupes.get(l.destinataire).lignes.push(l);
    }

    const rapport = [];

    for (const [destinataire, g] of groupes) {
      // Un formulaire par commune, un courriel par service.
      //
      // Aucun mandat n'est joint, et c'est conforme : le BOFiP, § 120 de
      // BOI-CAD-DIFF-20-20-10-10, dispense « les notaires, les géomètres experts
      // et les avocats en raison de leurs obligations professionnelles » de la
      // production d'un mandat POUR TOUTES leurs demandes d'extraits de matrice.
      // Le même paragraphe écarte pour eux le plafond de cinq par semaine.
      //
      // Le mandat n'est exigé que du mandataire ordinaire (§ 60). Exiger ici ce
      // que l'administration n'exige pas ajouterait une pièce à réunir, un
      // refus à contourner, et une phrase inexacte dans le courriel.
      const pieces = [];
      for (const l of g.lignes) {
        const pdf = await remplirCerfa({
          demandeur: OFFICE,
          mandant: l.societe,
          departement: l.departement,
          commune: l.nom_commune,
          inscrit: { ligne1: l.societe, ligne2: l.siren ? `SIREN ${l.siren}` : '' },
          date: maintenant,
          images,
        });
        pieces.push({
          nom: `6815-EM-SD_${l.code_insee}_${assainir(l.nom_commune)}.pdf`,
          type: 'application/pdf',
          contenu: Buffer.from(pdf),
        });
      }

      const objet = `Demandes d'extrait de matrice cadastrale — ${g.lignes.length} commune${g.lignes.length > 1 ? 's' : ''} — ${dossier}`;
      const corps = redigerTexte(g);
      const { html: corpsHtml, images: imagesEnLigne } = envelopper(redigerHtml(g));

      if (simulation) {
        rapport.push({ destinataire, service: g.service, formulaires: g.lignes.length, voie: 'simulation' });
        continue;
      }

      const envoi = await deposerBrouillon({
        objet, corps, corpsHtml, imagesEnLigne, destinataires: [destinataire], pieces, jetonDelegue,
      });

      const [ligneEnvoi] = await sql`
        INSERT INTO matrice_envoi (dossier, service_nom, destinataire, nb_formulaires, mandat_joint, envoye_par, message_id)
        VALUES (${dossier}, ${g.service || 'service'}, ${destinataire}, ${g.lignes.length}, false, ${auteur}, ${envoi.id || null})
        RETURNING id
      `;

      for (const l of g.lignes) {
        await sql`INSERT INTO matrice_envoi_demande (envoi_id, demande_id) VALUES (${ligneEnvoi.id}, ${l.id})`;
        await sql`
          UPDATE matrice_demande SET statut = 'envoyee', prochaine_relance = NULL WHERE id = ${l.id}
        `;
        await sql`
          INSERT INTO matrice_journal (demande_id, dossier, evenement, detail, auteur)
          VALUES (${l.id}, ${dossier}, 'envoi',
                  ${JSON.stringify({
                    destinataire, service: g.service, voie: envoi.voie,
                    envoiId: ligneEnvoi.id,
                    signe: sceau.etat === 'signe',
                  })}::jsonb, ${auteur})
        `;
      }

      rapport.push({
        destinataire, service: g.service, formulaires: g.lignes.length,
        voie: envoi.voie, lien: envoi.webLink || null,
        motifRepli: envoi.motif || null,
        eml: envoi.voie === 'eml' ? envoi.eml : undefined,
      });
    }

    return res.status(200).json({
      dossier,
      simulation: Boolean(simulation),
      brouillons: rapport.length,
      formulaires: pretes.length,
      signature: {
        signe: 'apposée — formulaires signés',
        sans_phrase: 'ABSENTE — formulaires non signés (aucune phrase de signature fournie)',
        non_configure: 'ABSENTE — aucune signature scellée n’est déposée',
      }[sceau.etat],
      envois: rapport,
    });
  } catch (e) {
    console.error('[MATRICE] envoyer', e);
    return res.status(500).json({ erreur: e.message });
  }
});

// Les ligatures ne se décomposent pas en NFD : sans ce passage, MARCQ-EN-BARŒUL
// devenait MARCQ-EN-BAR-UL dans le nom du fichier joint.
const LIGATURES = { 'Œ': 'OE', 'œ': 'oe', 'Æ': 'AE', 'æ': 'ae', 'ß': 'ss' };
const assainir = (s) => String(s)
  .replace(/[Œœ Æ æ ß]/g, (c) => LIGATURES[c] ?? c)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase();

// ------------------------------------------------------------- rédaction
//
// Le message existe en deux versions qui doivent dire la même chose : le HTML,
// que tout le monde verra, et le texte, que verra le client qui ne sait pas
// lire le HTML. Une seule source pour les deux — les phrases ci-dessous —
// afin qu'on ne corrige pas l'une en oubliant l'autre.
//
// Le bloc « FIDAL NOTAIRES / adresse / dossier » qui terminait le message a
// disparu : la signature de l'office porte déjà l'adresse, et la mention de
// confidentialité qu'elle contient dit ce que disait le paragraphe sur
// l'usage des informations. Les écrire deux fois les affaiblit.

// Texte arrêté par JFD le 17 août. Il est à la première personne : c'est le
// notaire qui écrit, pas une machine au nom d'un office — et la signature qui
// suit est la sienne.
//
// La référence est R* 107 A-3 du LPF, et non L. 107 A : le I de cet article
// pose le plafond de cinq demandes par semaine et par service, et son II, 1°
// en exempte les titulaires de droits réels et leurs mandataires.
//
// Aucun mandat n'est joint, et ce n'est pas un oubli. Le BOFiP dispense les
// notaires de le produire pour TOUTES leurs demandes d'extraits de matrice
// (BOI-CAD-DIFF-20-20-10-10, § 120). Vérifié le 17 août 2026 — l'exigence
// figurait dans les premières versions de MATRICE et n'avait pas lieu d'être.

function phrases(g) {
  const l0 = g.lignes[0];
  const n = g.lignes.length;
  return {
    communes: g.lignes.map((l) => ({ nom: l.nom_commune, code: l.code_insee })),
    ouverture: 'Madame, Monsieur,',
    objet: `Je vous écris en qualité de notaire, à la demande et pour le compte de ${l0.societe}`
      + `${l0.siren ? ` (SIREN ${l0.siren})` : ''}. Pour les besoins du traitement d'un dossier `
      + `en cours, je vous serai reconnaissant de bien vouloir faire retour à la présente demande `
      + `de délivrance d'extraits de matrice cadastrale pour les communes suivantes, relevant de `
      + `votre service :`,
    pieces: `En conséquence je vous prie de trouver ci-joint ${n} formulaire${n > 1 ? 's' : ''} `
      + `6815-EM-SD, un par commune concernée. Ces demandes étant présentées par un notaire pour `
      + `le compte du titulaire de droits réels susvisé, elles ne sont soumises ni à la production `
      + `d’un mandat, ni aux limites fixées au I de l’article R 107 A-3 du livre des procédures `
      + `fiscales.`,
    politesse: 'Vous remerciant par avance pour votre retour, je vous assure de mon profond respect.',
  };
}

export function redigerTexte(g) {
  const t = phrases(g);
  return [
    t.ouverture, '',
    t.objet, '',
    ...t.communes.map((c) => `  • ${c.nom} (${c.code})`), '',
    t.pieces, '',
    t.politesse,
  ].join('\n');
}

export function redigerHtml(g) {
  const t = phrases(g);
  // Un paragraphe indenté par commune, et non une <ul> : Outlook réindente
  // les listes à sa façon et l'alignement saute d'un client à l'autre.
  const lignes = t.communes
    .map((c) => p(`•&nbsp;&nbsp;${ech(c.nom)} (${ech(c.code)})`, 'margin-left:18.0pt'))
    .join('\n');

  return [
    p(ech(t.ouverture)), vide(),
    p(ech(t.objet)), vide(),
    lignes, vide(),
    p(ech(t.pieces)), vide(),
    p(ech(t.politesse)), vide(),
  ].join('\n');
}

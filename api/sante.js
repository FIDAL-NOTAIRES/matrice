// MATRICE — état de santé
//
// Répond en une seconde à la question « est-ce que c'est branché ? ».
// Sans elle, une chaîne de connexion mal collée ne se découvre que le
// lendemain matin, quand le cron échoue — en silence.
//
// Ne renvoie AUCUN secret et AUCUNE donnée client : des booléens, des noms
// de tables, des comptes. Rien qui aide qui que ce soit à faire du mal,
// rien qui relève du secret professionnel.

import { neon } from '@neondatabase/serverless';
import { existsSync } from 'fs';
import { join } from 'path';
import { prochaineRelance } from '../lib/jours-ouvres.js';
import { signatureMail } from '../lib/signature-mail.js';

const TABLES = ['matrice_demande', 'matrice_envoi', 'matrice_envoi_demande', 'matrice_journal'];

export default async function handler(req, res) {
  const t0 = Date.now();

  // Présence des variables, jamais leur valeur.
  const config = {
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    MATRICE_RELANCE_A: Boolean(process.env.MATRICE_RELANCE_A),
    AZURE_TENANT_ID: Boolean(process.env.AZURE_TENANT_ID),
    AZURE_CLIENT_ID: Boolean(process.env.AZURE_CLIENT_ID),
    AZURE_CLIENT_SECRET: Boolean(process.env.AZURE_CLIENT_SECRET),
    MATRICE_BOITE_SERVICE: Boolean(process.env.MATRICE_BOITE_SERVICE),
    MATRICE_MOT_DE_PASSE: Boolean(process.env.MATRICE_MOT_DE_PASSE),
    MATRICE_OFFICE_NOM: Boolean(process.env.MATRICE_OFFICE_NOM),
    MATRICE_OFFICE_ADRESSE: Boolean(process.env.MATRICE_OFFICE_ADRESSE),
    MATRICE_OFFICE_CP: Boolean(process.env.MATRICE_OFFICE_CP),
    MATRICE_OFFICE_COMMUNE: Boolean(process.env.MATRICE_OFFICE_COMMUNE),
  };

  const officeComplet = config.MATRICE_OFFICE_NOM && config.MATRICE_OFFICE_ADRESSE
    && config.MATRICE_OFFICE_CP && config.MATRICE_OFFICE_COMMUNE;

  const graphPret = config.AZURE_TENANT_ID && config.AZURE_CLIENT_ID
    && config.AZURE_CLIENT_SECRET && config.MATRICE_BOITE_SERVICE;

  const rapport = {
    service: 'MATRICE',
    le: new Date().toISOString(),
    node: process.version,
    config,
    courriel: graphPret ? 'Graph configuré' : 'repli .eml (AZURE_* incomplets)',
    verrou: (config.AZURE_TENANT_ID && config.AZURE_CLIENT_ID) ? 'Entra'
      : config.MATRICE_MOT_DE_PASSE ? 'mot de passe (recette)'
      : 'NON CONFIGURÉ — les routes protégées rendront 503',
    office: officeComplet ? 'complet'
      : "INCOMPLET — /api/envoyer refusera de générer (cadre « demandeur » lacunaire)",
    gabaritCerfa: existsSync(join(process.cwd(), 'data', '6815-em-sd_31.pdf'))
      ? 'présent' : 'ABSENT — data/6815-em-sd_31.pdf',
    // Une signature absente ne casse rien : le courriel part sans habillage.
    // C'est précisément pour ça qu'il faut le dire ici — personne ne le
    // remarquerait autrement avant que le brouillon soit relu.
    signatureCourriel: (() => {
      const s = signatureMail();
      if (!s.presente) return 'ABSENTE — data/signature/signature.html';
      if (s.manquantes.length) return `INCOMPLÈTE — images manquantes : ${s.manquantes.join(', ')}`;
      return `présente (${s.images.length} images)`;
    })(),
    base: null,
    tables: null,
    file: null,
    prochaineRelanceSiEnvoiAujourdhui: prochaineRelance(new Date()).toISOString().slice(0, 10),
  };

  if (!config.DATABASE_URL) {
    rapport.base = 'DATABASE_URL absente';
    rapport.etat = 'incomplet';
    rapport.ms = Date.now() - t0;
    return res.status(503).json(rapport);
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    const presentes = await sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY(${TABLES})
    `;
    const trouvees = presentes.map((r) => r.table_name);
    const manquantes = TABLES.filter((t) => !trouvees.includes(t));

    rapport.base = 'joignable';
    rapport.tables = manquantes.length
      ? { etat: 'migration non jouée', manquantes }
      : { etat: 'complètes', nombre: trouvees.length };

    if (manquantes.length === 0) {
      const [f] = await sql`
        SELECT count(*)::int AS en_attente,
               count(*) FILTER (WHERE prochaine_relance <= current_date)::int AS dues_aujourdhui,
               min(prochaine_relance) AS prochaine
          FROM matrice_demande WHERE statut = 'en_attente'
      `;
      rapport.file = f;
    }

    rapport.etat = (manquantes.length === 0 && config.CRON_SECRET) ? 'operationnel' : 'incomplet';
    rapport.ms = Date.now() - t0;
    return res.status(rapport.etat === 'operationnel' ? 200 : 503).json(rapport);
  } catch (e) {
    // Le message d'erreur Postgres peut contenir l'hôte : on ne renvoie que le code.
    rapport.base = `injoignable (${e.code || 'erreur'})`;
    rapport.etat = 'en panne';
    rapport.ms = Date.now() - t0;
    console.error('[MATRICE] santé — base injoignable', e);
    return res.status(503).json(rapport);
  }
}

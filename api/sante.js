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
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { prochaineRelance } from '../lib/jours-ouvres.js';
import { signatureMail } from '../lib/signature-mail.js';
import { sceauConfigure } from '../lib/sceau.js';
// Importé pour que Vercel embarque le gabarit dans CETTE fonction. Le traçage
// suit les imports : un existsSync sur le chemin ne fait rien embarquer, et le
// témoin annonçait « ABSENT » sur une chaîne qui générait très bien. Voir le
// préambule de lib/cerfa.js.
import { gabaritPresent, FICHIER as CERFA_FICHIER } from '../lib/cerfa.js';

const TABLES = ['matrice_demande', 'matrice_envoi', 'matrice_envoi_demande', 'matrice_journal'];

// Version de corrections.json que lib/routage.js sait lire. Un écart ici
// bloque tous les envois, volontairement : mieux vaut une file d'attente
// visible qu'un routage faux en silence.
const CORRECTIONS_VERSION_ATTENDUE = 4;

// Le 19 août, un déploiement portait encore le squelette du 15 : 44,6 ko au
// lieu de 103. Rien ne le signalait, et la production routait avec l'ancien
// référentiel. D'où ce bloc — l'écart se voit maintenant en deux secondes.
function referentielCorrige() {
  const chemin = join(process.cwd(), 'data', 'corrections.json');
  if (!existsSync(chemin)) return { etat: 'ABSENT — data/corrections.json' };
  try {
    const brut = readFileSync(chemin, 'utf8');
    const c = JSON.parse(brut);
    const version = Number(c.version || 0);
    const compatible = version === CORRECTIONS_VERSION_ATTENDUE;
    const s = c.synthese || {};
    return {
      etat: compatible ? 'compatible' : `INCOMPATIBLE — version ${version || 'inconnue'}, `
        + `attendu ${CORRECTIONS_VERSION_ATTENDUE} : aucun envoi ne sera autorisé`,
      version: version || null,
      misAJourLe: c.misAJourLe || null,
      octets: brut.length,
      services: s.services ?? null,
      servicesAvecAdresse: s.servicesAvecAdresse ?? null,
      communes: s.communes ?? null,
      communesExploitables: s.communesExploitables ?? null,
      communesATrouver: s.communesATrouver ?? null,
      communesARepartir: s.communesARepartir ?? null,
      exceptionsFigees: s.exceptionsFigees ?? null,
      reservesNonLevees: Object.entries(c.reserves || {})
        .filter(([, r]) => r?.levee !== true).length,
    };
  } catch (e) {
    return { etat: `ILLISIBLE — ${e.name}` };
  }
}

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

  // Deux régimes distincts, et il ne faut pas les confondre dans le diagnostic :
  //   • l'ENVOI part de l'écran, sous l'identité du collaborateur — échange
  //     on-behalf-of, qui n'a besoin ni de boîte de service ni de consentement
  //     administrateur ;
  //   • la RELANCE tourne sous cron, sans personne : régime application, qui
  //     exige une boîte de service et un consentement administrateur.
  const echangePret = config.AZURE_TENANT_ID && config.AZURE_CLIENT_ID && config.AZURE_CLIENT_SECRET;
  const graphPret = echangePret && config.MATRICE_BOITE_SERVICE;

  const referentiel = referentielCorrige();

  const rapport = {
    service: 'MATRICE',
    le: new Date().toISOString(),
    node: process.version,
    // La région ne se constate pas depuis l'interface Vercel autrement qu'en
    // croyant un réglage. Ici, elle est lue à l'exécution. La région de BUILD
    // reste iad1 et n'est pas modifiable : ne pas la confondre avec celle-ci.
    execution: {
      region: process.env.VERCEL_REGION || null,
      environnement: process.env.VERCEL_ENV || null,
      // Le commit designe le CODE : un Redeploy rejoue le meme, donc il ne dit
      // jamais si un redeploiement a eu lieu. Une demi-heure a ete perdue
      // la-dessus le 20/08 en cherchant si une variable modifiee avait ete prise.
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      // Celui-ci change a CHAQUE deploiement, rejeu compris. C'est lui qu'il
      // faut regarder apres avoir modifie une variable d'environnement.
      deploiement: process.env.VERCEL_DEPLOYMENT_ID || null,
    },
    config,
    referentielCorrige: referentiel,
    courriel: {
      envoi: echangePret
        ? 'Graph — brouillon déposé dans la boîte du collaborateur (on-behalf-of)'
        : 'repli .eml (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET)',
      relance: graphPret
        ? 'Graph — brouillon déposé dans la boîte de service'
        : 'repli .eml (MATRICE_BOITE_SERVICE ou AZURE_* manquants)',
    },
    verrou: (config.AZURE_TENANT_ID && config.AZURE_CLIENT_ID) ? 'Entra'
      : config.MATRICE_MOT_DE_PASSE ? 'mot de passe (recette)'
      : 'NON CONFIGURÉ — les routes protégées rendront 503',
    office: officeComplet ? 'complet'
      : "INCOMPLET — /api/envoyer refusera de générer (cadre « demandeur » lacunaire)",
    gabaritCerfa: gabaritPresent() ? 'présent' : `ABSENT — data/${CERFA_FICHIER}`,
    // Une signature absente ne casse rien : le courriel part sans habillage.
    // C'est précisément pour ça qu'il faut le dire ici — personne ne le
    // remarquerait autrement avant que le brouillon soit relu.
    // Présence seule : on ne déchiffre rien ici, et aucune phrase ne circule.
    signatureManuscrite: (() => {
      const s = sceauConfigure();
      if (!s.signature && !s.cachet) return 'aucune — formulaires non signés';
      return `scellée (${[s.signature && 'signature', s.cachet && 'cachet'].filter(Boolean).join(' + ')})`
        + ' — phrase requise à chaque envoi';
    })(),
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

  // Chronometre a part : la duree de la tentative distingue les causes de panne
  // mieux que le code d'erreur, souvent absent. Voir le catch en fin de fonction.
  const tBase = Date.now();
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

    // Un référentiel incompatible n'empêche pas la base de répondre, mais il
    // empêche tout envoi : il compte donc dans l'état d'ensemble.
    const referentielOk = referentiel.etat === 'compatible';
    rapport.etat = (manquantes.length === 0 && config.CRON_SECRET && referentielOk)
      ? 'operationnel' : 'incomplet';
    rapport.ms = Date.now() - t0;
    return res.status(rapport.etat === 'operationnel' ? 200 : 503).json(rapport);
  } catch (e) {
    // Le message d'erreur Postgres peut contenir l'hôte : on ne renvoie que le
    // code. Mais un code manque souvent, et « injoignable (erreur) » n'oriente
    // vers rien. La DURÉE, elle, désigne la cause :
    //
    //   quelques ms, sans code   -> la chaîne est mal formée, le pilote refuse
    //                               avant tout appel réseau. Le cas du 20/08 :
    //                               le format .env de Neon collé au lieu de
    //                               l'URL de connexion.
    //   centaines de ms, 28P01   -> authentification refusée : mot de passe
    //                               faux, ou variable modifiée sans redéploiement.
    //   long, code réseau        -> hôte injoignable : région, pare-feu, veille.
    //
    // Un témoin doit dire ce qu'il constate, pas ce qu'il conclut.
    const msBase = Date.now() - tBase;
    rapport.base = e.code
      ? `injoignable (${e.code}) après ${msBase} ms`
      : `injoignable, sans code Postgres, après ${msBase} ms`
        + (msBase < 50 ? ' — rejet avant tout appel réseau : la chaîne de connexion est probablement mal formée' : '');
    rapport.etat = 'en panne';
    rapport.ms = Date.now() - t0;
    console.error('[MATRICE] santé — base injoignable', e);
    return res.status(503).json(rapport);
  }
}

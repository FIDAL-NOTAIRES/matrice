// MATRICE — dépôt de brouillons et repli .eml
//
// Deux usages, deux régimes d'authentification, et il ne faut pas les confondre :
//
//   • la RELANCE tourne sous cron, sans personne devant l'écran. Elle ne peut pas
//     emprunter l'identité d'un utilisateur : elle s'authentifie en application
//     (client credentials) et dépose dans une boîte de service désignée.
//
//   • l'ENVOI des demandes part de l'écran récapitulatif, avec un collaborateur
//     identifié. Il utilise SON jeton délégué, pour que le brouillon apparaisse
//     dans SA boîte et que la piste d'audit porte son nom. Passer l'envoi en
//     application ferait disparaître l'auteur — exactement ce que la piste d'audit
//     est censée retenir.
//
// Repli : si Graph est indisponible ou non configuré, on rend un .eml conforme,
// que l'utilisateur ouvre dans Outlook. C'est le comportement de COUNTDOWN.
// On ne perd jamais un envoi parce qu'un jeton a expiré.

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ---------------------------------------------------------------- jeton
let cacheJeton = null; // { valeur, expireLe }

/** Jeton applicatif (client credentials). Mis en cache jusqu'à 60 s de sa fin. */
async function jetonApplication() {
  const { AZURE_TENANT_ID: tenant, AZURE_CLIENT_ID: client, AZURE_CLIENT_SECRET: secret } = process.env;
  if (!tenant || !client || !secret) return null;

  if (cacheJeton && Date.now() < cacheJeton.expireLe - 60_000) return cacheJeton.valeur;

  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!r.ok) throw new Error(`jeton refusé (${r.status}) : ${await r.text()}`);

  const j = await r.json();
  cacheJeton = { valeur: j.access_token, expireLe: Date.now() + j.expires_in * 1000 };
  return cacheJeton.valeur;
}

// --------------------------------------------------------------- .eml
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const plier = (s, n = 76) => (s.match(new RegExp(`.{1,${n}}`, 'g')) || []).join('\r\n');

/** En-tête non-ASCII : encodage MIME « encoded-word » (RFC 2047). */
function enteteEncodee(txt) {
  return /^[\x20-\x7E]*$/.test(txt) ? txt : `=?UTF-8?B?${b64(txt)}?=`;
}

/**
 * Construit un message .eml conforme (RFC 5322 / 2045).
 * Corps en UTF-8 base64 : le quoted-printable est illisible dès qu'il y a
 * des accents, et un rappel qu'on n'arrive pas à lire ne sert à rien.
 */
export function construireEml({ objet, corps, destinataires = [], expediteur, pieces = [] }) {
  const limite = `----matrice-${Math.abs(hachage(objet + corps)).toString(36)}`;
  const entetes = [
    `Date: ${new Date().toUTCString()}`,
    expediteur ? `From: ${expediteur}` : null,
    destinataires.length ? `To: ${destinataires.join(', ')}` : null,
    `Subject: ${enteteEncodee(objet)}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  if (pieces.length === 0) {
    return [
      ...entetes,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      plier(b64(corps)),
      '',
    ].join('\r\n');
  }

  const parties = [
    `--${limite}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    plier(b64(corps)),
  ];
  for (const p of pieces) {
    parties.push(
      `--${limite}`,
      `Content-Type: ${p.type || 'application/octet-stream'}; name="${p.nom}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${p.nom}"`,
      '',
      plier(typeof p.contenuBase64 === 'string' ? p.contenuBase64 : p.contenu.toString('base64')),
    );
  }
  parties.push(`--${limite}--`, '');

  return [...entetes, `Content-Type: multipart/mixed; boundary="${limite}"`, '', ...parties].join('\r\n');
}

function hachage(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return h;
}

// ------------------------------------------------------------- Graph
function versGraph({ objet, corps, destinataires, pieces }) {
  return {
    subject: objet,
    body: { contentType: 'Text', content: corps },
    toRecipients: destinataires.map((a) => ({ emailAddress: { address: a.trim() } })),
    attachments: pieces.map((p) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: p.nom,
      contentType: p.type || 'application/octet-stream',
      contentBytes: typeof p.contenuBase64 === 'string' ? p.contenuBase64 : p.contenu.toString('base64'),
    })),
  };
}

/**
 * Dépose un brouillon. Ne l'envoie jamais : c'est le principe posé au mémo —
 * la machine propose, l'humain valide. Le collaborateur relit et clique.
 *
 * @param {object}   o
 * @param {string}   o.objet
 * @param {string}   o.corps
 * @param {string[]} o.destinataires
 * @param {Array}    [o.pieces]       [{nom, type, contenu|contenuBase64}]
 * @param {string}   [o.jetonDelegue] jeton de l'utilisateur ; sinon régime application
 * @returns {Promise<{voie:'graph'|'eml', id?:string, webLink?:string, eml?:string, motif?:string}>}
 */
export async function deposerBrouillon({ objet, corps, destinataires = [], pieces = [], jetonDelegue }) {
  if (!objet || !corps) throw new Error('objet et corps obligatoires');

  const boite = process.env.MATRICE_BOITE_SERVICE; // UPN de la boîte, régime application
  let jeton = jetonDelegue || null;
  let cible = '/me/messages';

  if (!jeton) {
    try {
      jeton = await jetonApplication();
    } catch (e) {
      return repli({ objet, corps, destinataires, pieces }, `jeton indisponible : ${e.message}`);
    }
    if (!jeton || !boite) {
      return repli({ objet, corps, destinataires, pieces },
        'Graph non configuré (AZURE_* ou MATRICE_BOITE_SERVICE manquants)');
    }
    cible = `/users/${encodeURIComponent(boite)}/messages`;
  }

  try {
    const r = await fetch(GRAPH + cible, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(versGraph({ objet, corps, destinataires, pieces })),
    });
    if (!r.ok) {
      return repli({ objet, corps, destinataires, pieces }, `Graph ${r.status} : ${(await r.text()).slice(0, 300)}`);
    }
    const m = await r.json();
    return { voie: 'graph', id: m.id, webLink: m.webLink };
  } catch (e) {
    return repli({ objet, corps, destinataires, pieces }, `Graph injoignable : ${e.message}`);
  }
}

function repli(msg, motif) {
  // Un repli n'est pas un échec, mais il ne doit pas passer inaperçu :
  // si tous les brouillons partent en .eml pendant trois semaines, il faut
  // que quelqu'un s'en aperçoive autrement qu'en le remarquant à l'œil.
  console.warn('[MATRICE] repli .eml —', motif);
  return { voie: 'eml', eml: construireEml(msg), motif };
}

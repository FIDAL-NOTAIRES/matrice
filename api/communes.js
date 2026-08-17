// MATRICE — recherche d'une commune, pour l'écran d'import
//
// Les propositions automatiques suffisent quand le nom est simplement
// incomplet. Elles ne suffisent pas dans deux cas, tous deux rencontrés sur le
// portefeuille LOGIS METROPOLE :
//
//   • la commune n'existe plus — LOMME ne ressemble à rien puisqu'elle a été
//     absorbée par Lille ; il faut chercher « Lille » ;
//   • le nom du dossier est trop court — « SAINT ANDRE » ressemble d'abord à
//     des dizaines de Saint-André de toute la France, et Saint-André-lez-Lille
//     se perd dans le nombre.
//
// D'où cette route : le notaire cherche lui-même, et choisit. On ne devine
// toujours pas — on l'outille pour trancher.
//
// Elle ne touche à rien : ni base, ni écriture, ni état. Elle relaie une
// question à l'annuaire de l'État et rend la réponse.

import { protege } from '../lib/verrou.js';

const API = 'https://geo.api.gouv.fr/communes';
const API_ASSOCIEES = 'https://geo.api.gouv.fr/communes_associees_deleguees';
const CODE = /^(?:\d{5}|2[AB]\d{3})$/i;

async function interroger(url) {
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'MATRICE/1.0 (FIDAL Notaires)' },
    });
    if (r.status === 404) return [];
    if (!r.ok) return null;
    const brut = await r.json();
    return Array.isArray(brut) ? brut : [brut].filter(Boolean);
  } catch { return null; }
}

const forme = (c) => ({
  code: c.code,
  nom: c.nom,
  departement: [
    c.departement ? `${c.departement.nom} (${c.departement.code})` : null,
    c.type === 'commune-associee' ? 'commune associée' : null,
    c.type === 'commune-deleguee' ? 'commune déléguée' : null,
  ].filter(Boolean).join(', ') || null,
});

export default protege(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ erreur: 'GET attendu' });

  const q = String(req.query?.q || '').trim();
  if (q.length < 2) return res.status(400).json({ erreur: 'recherche trop courte' });

  // Deux annuaires, et il faut les deux. Les communes ASSOCIÉES et DÉLÉGUÉES
  // — LOMME, rattachée à Lille — ne figurent pas dans le premier, alors que le
  // cadastre les distingue et que les parcelles y sont référencées sous leur
  // propre nom. Les omettre reviendrait à faire écrire LILLE là où le service
  // attend LOMME.
  const parCode = CODE.test(q);
  const code = q.toUpperCase();

  const [communes, associees] = await Promise.all([
    interroger(parCode
      ? `${API}/${encodeURIComponent(code)}?fields=code,nom,departement`
      : `${API}?nom=${encodeURIComponent(q)}&fields=code,nom,departement&boost=population&limit=25`),
    interroger(parCode
      ? `${API_ASSOCIEES}?code=${encodeURIComponent(code)}&fields=code,nom,chefLieu,type,departement`
      : `${API_ASSOCIEES}?nom=${encodeURIComponent(q)}&fields=code,nom,chefLieu,type,departement&limit=15`),
  ]);

  if (communes === null && associees === null) {
    return res.status(502).json({ erreur: 'annuaire des communes indisponible' });
  }

  const vues = new Set();
  const liste = [...(communes || []), ...(associees || [])]
    .filter((c) => c && c.code && !vues.has(c.code) && vues.add(c.code));

  return res.status(200).json({ q, communes: liste.map(forme) });
});

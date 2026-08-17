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
const CODE = /^(?:\d{5}|2[AB]\d{3})$/i;

export default protege(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ erreur: 'GET attendu' });

  const q = String(req.query?.q || '').trim();
  if (q.length < 2) return res.status(400).json({ erreur: 'recherche trop courte' });

  // Un code INSEE saisi directement se vérifie plutôt qu'il ne se cherche.
  const url = CODE.test(q)
    ? `${API}/${encodeURIComponent(q.toUpperCase())}?fields=code,nom,departement`
    : `${API}?nom=${encodeURIComponent(q)}&fields=code,nom,departement&boost=population&limit=25`;

  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'MATRICE/1.0 (FIDAL Notaires)' },
    });
    if (r.status === 404) return res.status(200).json({ q, communes: [] });
    if (!r.ok) return res.status(502).json({ erreur: `annuaire des communes indisponible (${r.status})` });

    const brut = await r.json();
    const liste = Array.isArray(brut) ? brut : [brut];

    return res.status(200).json({
      q,
      communes: liste.filter(Boolean).map((c) => ({
        code: c.code,
        nom: c.nom,
        departement: c.departement ? `${c.departement.nom} (${c.departement.code})` : null,
      })),
    });
  } catch (e) {
    return res.status(502).json({ erreur: `annuaire des communes injoignable : ${e.message}` });
  }
});

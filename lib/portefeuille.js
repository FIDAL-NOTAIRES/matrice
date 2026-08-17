// MATRICE — lecture d'un portefeuille collé
//
// Fonction pure : du texte entre, une liste de communes sort. Aucune écriture,
// aucun réseau, aucune règle de routage — elle ne fait que comprendre ce qui a
// été collé.
//
// Trois formes acceptées, parce qu'un portefeuille arrive de trois endroits :
//
//   1. TABLEAU — copié depuis Excel ou REDPAR. Colonnes séparées par tabulation,
//      point-virgule ou virgule, en-tête facultatif, ordre des colonnes libre.
//      C'est la forme la plus sûre : elle porte les codes INSEE.
//
//   2. DOSSIERS DRIVE — les noms des sous-dossiers du client,
//      « 0199_ATTICHES_6 PLACE DES LANDAUS ». Un dossier = un lot ; le nombre de
//      lots par commune se compte. Cette forme ne porte PAS de code INSEE : les
//      noms devront être résolus, et c'est là qu'on attrape les communes
//      disparues — c'est de cette source que venait l'erreur LOMME.
//
//   3. LISTE SIMPLE — une commune par ligne, ou un code INSEE par ligne.
//
// Ce qui n'est pas compris n'est jamais jeté en silence : chaque ligne
// incomprise ressort dans `anomalies`, avec son numéro. Un portefeuille amputé
// de trois lignes sans que personne ne le voie est pire qu'un refus.

const CODE_INSEE = /^(?:\d{5}|2[AB]\d{3})$/i;
const LIGNE_DRIVE = /^\s*(\d{2,5})\s*_\s*([^_]+?)\s*_(.*)$/;

/** Uniformise un nom pour la comparaison. Les ligatures ne se décomposent pas en NFD. */
export function normaliser(nom) {
  return String(nom ?? '')
    .replace(/[Œœ]/g, 'OE').replace(/[Ææ]/g, 'AE')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

const estEntier = (s) => /^\d{1,5}$/.test(String(s).trim());

function decouper(lignes) {
  // Le séparateur est celui qui découpe le plus de lignes en un même nombre
  // de colonnes — pas simplement le plus fréquent : une adresse pleine de
  // virgules ferait gagner la virgule à tous les coups.
  let meilleur = { sep: null, colonnes: 1, score: 0 };
  for (const sep of ['\t', ';', ',', '|']) {
    const tailles = lignes.map((l) => l.split(sep).length);
    const compte = new Map();
    for (const t of tailles) if (t > 1) compte.set(t, (compte.get(t) || 0) + 1);
    for (const [colonnes, score] of compte) {
      if (score > meilleur.score || (score === meilleur.score && colonnes > meilleur.colonnes)) {
        meilleur = { sep, colonnes, score };
      }
    }
  }
  return meilleur.sep && meilleur.score >= Math.max(2, lignes.length * 0.6) ? meilleur : null;
}

/**
 * @param {string} texte
 * @returns {{format:string, lignes:Array<{code_insee:string|null,nom_commune:string,nb_lots:number}>,
 *            anomalies:Array<{ligne:number, texte:string, motif:string}>}}
 */
export function analyser(texte) {
  const brutes = String(texte ?? '').split(/\r?\n/).map((l) => l.trim());
  const lignes = brutes.map((t, i) => ({ n: i + 1, t })).filter((l) => l.t !== '');
  if (lignes.length === 0) return { format: 'vide', lignes: [], anomalies: [] };

  const anomalies = [];
  const parCle = new Map();

  const ajouter = (code, nom, lots) => {
    const cle = code || normaliser(nom);
    if (!cle) return false;
    if (!parCle.has(cle)) {
      parCle.set(cle, { code_insee: code || null, nom_commune: nom || null, nb_lots: 0 });
    }
    const e = parCle.get(cle);
    e.nb_lots += lots;
    // Un code croisé plus tard l'emporte sur son absence ; un nom aussi.
    if (!e.code_insee && code) e.code_insee = code;
    if (!e.nom_commune && nom) e.nom_commune = nom;
    return true;
  };

  // ---------------------------------------------------------------- 2. Drive
  const drive = lignes.filter((l) => LIGNE_DRIVE.test(l.t));
  if (drive.length >= Math.max(2, lignes.length * 0.6)) {
    for (const l of lignes) {
      const m = l.t.match(LIGNE_DRIVE);
      if (!m) { anomalies.push({ ligne: l.n, texte: l.t, motif: 'ne suit pas la forme NNNN_COMMUNE_ADRESSE' }); continue; }
      ajouter(null, m[2].trim(), 1); // un dossier = un lot
    }
    return { format: 'dossiers Drive', lignes: [...parCle.values()], anomalies };
  }

  // -------------------------------------------------------------- 1. Tableau
  const tab = decouper(lignes.map((l) => l.t));
  if (tab) {
    const cellules = lignes.map((l) => ({ n: l.n, t: l.t, c: l.t.split(tab.sep).map((x) => x.trim()) }));
    const nbCol = Math.max(...cellules.map((x) => x.c.length));

    const proportion = (j, test) => {
      const vues = cellules.map((x) => x.c[j]).filter((v) => v !== undefined && v !== '');
      if (!vues.length) return 0;
      return vues.filter(test).length / vues.length;
    };

    let colCode = -1, colLots = -1, colNom = -1;
    for (let j = 0; j < nbCol; j++) if (proportion(j, (v) => CODE_INSEE.test(v)) >= 0.6) { colCode = j; break; }
    for (let j = 0; j < nbCol; j++) {
      if (j === colCode) continue;
      if (proportion(j, (v) => estEntier(v)) >= 0.6) { colLots = j; break; }
    }
    for (let j = 0; j < nbCol; j++) {
      if (j === colCode || j === colLots) continue;
      if (proportion(j, (v) => /[A-Za-zÀ-ÿ]{2}/.test(v)) >= 0.6) { colNom = j; break; }
    }

    if (colCode >= 0 || colNom >= 0) {
      for (const x of cellules) {
        const code = colCode >= 0 ? String(x.c[colCode] || '').toUpperCase() : '';
        const nom = colNom >= 0 ? String(x.c[colNom] || '') : '';
        const lots = colLots >= 0 && estEntier(x.c[colLots]) ? Number(x.c[colLots]) : 1;

        // La ligne d'en-tête ne porte ni code valide ni rien de numérique.
        const entete = colCode >= 0 && !CODE_INSEE.test(code);
        if (entete && x.n === lignes[0].n) continue;

        if (!CODE_INSEE.test(code) && !nom) {
          anomalies.push({ ligne: x.n, texte: x.t, motif: 'ni code INSEE ni nom de commune' });
          continue;
        }
        ajouter(CODE_INSEE.test(code) ? code : null, nom || null, lots);
      }
      return { format: 'tableau', lignes: [...parCle.values()], anomalies };
    }
  }

  // ---------------------------------------------------------- 3. Liste simple
  for (const l of lignes) {
    const v = l.t.replace(/^[-•*\s]+/, '').trim();
    if (CODE_INSEE.test(v)) { ajouter(v.toUpperCase(), null, 1); continue; }
    // « LA MADELEINE (59368) » ou « LA MADELEINE 59368 »
    const m = v.match(/^(.*?)[\s(]+((?:\d{5}|2[AB]\d{3}))\)?\s*$/i);
    if (m) { ajouter(m[2].toUpperCase(), m[1].trim(), 1); continue; }
    if (/[A-Za-zÀ-ÿ]{2}/.test(v)) { ajouter(null, v, 1); continue; }
    anomalies.push({ ligne: l.n, texte: l.t, motif: 'ni code INSEE ni nom de commune' });
  }

  return { format: 'liste', lignes: [...parCle.values()], anomalies };
}

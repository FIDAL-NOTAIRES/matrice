// MATRICE — la signature de courriel de l'office
//
// Un brouillon créé par l'API Graph n'hérite pas de la signature Outlook :
// Outlook ne l'insère que dans une fenêtre de rédaction ouverte à la main.
// Le message partirait donc nu. On rapporte donc ici la signature exacte,
// telle qu'Outlook la stocke sur le poste, et on écrit le message DEDANS.
//
// Le fichier data/signature/signature.html est le .htm d'origine (%APPDATA%\
// Microsoft\Signatures), converti de windows-1252 en UTF-8, débarrassé des
// liens vers le disque local, et dont les <img> pointent vers cid:sig001,
// cid:sig002, cid:sig003. Le balisage Word n'a pas été retouché : c'est ce
// qui garantit que le rendu est celui qu'attend le destinataire.
//
// Rien ici n'est confidentiel — cette signature figure au bas de chaque
// courriel de l'office. Contrairement au fac-similé de signature manuscrite
// du Cerfa, elle a donc sa place dans le dépôt.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const IMAGES = [
  { cid: 'sig001', fichier: 'image001.png' }, // logo FIDAL NOTAIRES, 145 × 72
  { cid: 'sig002', fichier: 'image002.png' }, // Notaires de France pleine taille (recadré par VML sous Outlook Windows)
  { cid: 'sig003', fichier: 'image003.png' }, // le même, déjà rogné, pour tous les autres clients
];

// Word ouvre le contenu visible par ce div ; c'est là qu'on insère le message.
const ANCRE = /<div class=WordSection1>/i;

let cache = null;

/** @returns {{presente:boolean, manquantes:string[], images:Array}} */
export function signatureMail() {
  if (cache) return cache;

  const dossier = join(process.cwd(), 'data', 'signature');
  const gabarit = join(dossier, 'signature.html');

  if (!existsSync(gabarit)) {
    cache = { presente: false, manquantes: ['signature.html'], html: null, images: [] };
    return cache;
  }

  const html = readFileSync(gabarit, 'utf8');
  const images = [];
  const manquantes = [];
  for (const i of IMAGES) {
    const chemin = join(dossier, i.fichier);
    if (!existsSync(chemin)) { manquantes.push(i.fichier); continue; }
    images.push({ cid: i.cid, nom: i.fichier, type: 'image/png', contenu: readFileSync(chemin) });
  }

  cache = { presente: true, manquantes, html, images };
  return cache;
}

/**
 * Insère le message dans le document de signature.
 * Le message hérite ainsi des styles Word (MsoNormal, Calibri 11 pt) —
 * il ressemble à un courriel écrit à la main depuis Outlook, ce qu'il est
 * pour son destinataire.
 *
 * @param {string} messageHtml  paragraphes du message, sans <html> ni <body>
 * @returns {{html:string, images:Array}}
 */
export function envelopper(messageHtml) {
  const s = signatureMail();

  if (!s.presente) {
    // Pas de signature déposée : on rend un document autonome plutôt que rien.
    return {
      html: `<html><head><meta charset="utf-8"></head><body style="font-family:Calibri,sans-serif;font-size:11pt">${messageHtml}</body></html>`,
      images: [],
    };
  }

  const html = ANCRE.test(s.html)
    ? s.html.replace(ANCRE, (m) => `${m}\n\n${messageHtml}\n`)
    : s.html.replace(/<body([^>]*)>/i, (m) => `${m}\n${messageHtml}\n`);

  return { html, images: s.images };
}

/** Échappe le texte destiné à du HTML. Une commune s'appelle L'ÎLE-D'ELLE. */
export function e(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Paragraphe au style du message Outlook. */
export function p(contenu, style = '') {
  return `<p class=MsoNormal${style ? ` style='${style}'` : ''}>${contenu}<o:p></o:p></p>`;
}

/** Ligne vide — Word en met une vraie, pas une marge. */
export const vide = () => '<p class=MsoNormal><o:p>&nbsp;</o:p></p>';

-- MATRICE — migration 004 (13/10/2026). Suivi des demandes parties : « extrait reçu ».
-- Idempotente.
--
-- Arbitrages appliqués (21 et 24/09/2026) :
--   • le bouton « extrait reçu » ALIMENTE matrice_routage_appris : le service
--     qui a répondu est inscrit comme compétent pour la commune ;
--   • une commune adressée à deux guichets donne DEUX lignes de suivi, une par
--     envoi : la réception se pose donc sur le lien envoi ↔ demande ;
--   • si les deux guichets délivrent, le PREMIER arrivé garde la priorité ; le
--     second est TRACÉ, au journal ET dans la table de routage ;
--   • une erreur de ligne se corrige par un nouveau clic : le dernier fait foi,
--     chaque clic est journalisé (auteur et heure).

BEGIN;

ALTER TABLE matrice_envoi_demande ADD COLUMN IF NOT EXISTS recu_le  timestamptz;
ALTER TABLE matrice_envoi_demande ADD COLUMN IF NOT EXISTS recu_par text;

-- Les autres guichets dont une réponse a établi la compétence pour la commune,
-- après le premier : [{service_nom, destinataire, telephone, appris_le, appris_de}].
-- Ils ne prennent jamais la main sur le premier arrivé.
ALTER TABLE matrice_routage_appris
  ADD COLUMN IF NOT EXISTS autres_services jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;

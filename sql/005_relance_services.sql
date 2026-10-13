-- MATRICE — migration 005 (13/10/2026). Relance des services et disqualification.
-- Idempotente.
--
-- Arbitrages appliqués :
--   • 29/08/2026 : jamais de relance silencieuse — MATRICE prépare le brouillon,
--     un humain l'envoie ; après deux relances écrites sans réponse, on APPELLE
--     le service d'abord, l'appel est consigné, et la troisième relance est
--     rédigée à partir de ce compte rendu ;
--   • 13/10/2026 : premier rappel QUINZE JOURS calendaires après l'envoi, puis
--     le même délai entre deux relances ;
--   • 24/09/2026 : une commune adressée à deux guichets — dès qu'un extrait est
--     reçu, la relance de l'autre ligne est SUSPENDUE mais la ligne reste
--     ouverte ; à SOIXANTE JOURS sans réponse elle se ferme et ce guichet est
--     DISQUALIFIÉ, définitivement, pour cette seule commune.

BEGIN;

ALTER TABLE matrice_envoi_demande ADD COLUMN IF NOT EXISTS nb_relances_service      integer NOT NULL DEFAULT 0;
ALTER TABLE matrice_envoi_demande ADD COLUMN IF NOT EXISTS derniere_relance_service timestamptz;
-- Compte rendu des appels avant la troisième relance :
-- [{le, par, joint, interlocuteur, annonce}]
ALTER TABLE matrice_envoi_demande ADD COLUMN IF NOT EXISTS appels   jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE matrice_envoi_demande ADD COLUMN IF NOT EXISTS ferme_le timestamptz;
ALTER TABLE matrice_envoi_demande ADD COLUMN IF NOT EXISTS motif_fermeture text;

-- Guichets disqualifiés pour la commune : [{service_nom, destinataire, le, motif}].
ALTER TABLE matrice_routage_appris
  ADD COLUMN IF NOT EXISTS disqualifies jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;

-- MATRICE — file d'attente et relances
-- Postgres (Neon). Migration 001. Idempotente.
--
-- Principe posé au mémo : la machine ratisse large, détecte et propose ;
-- l'humain décide, nomme et valide. Rien ici ne décide à sa place :
-- la relance rappelle, elle n'envoie jamais d'elle-même une demande
-- dont le destinataire n'est pas établi.
--
-- Confidentialité : le bloc du Cerfa 11565*04 impose de ne pas conserver
-- les informations communiquées. On enregistre donc le FAIT de la demande
-- et de la réponse, jamais le contenu de l'extrait reçu. Les extraits vont
-- au dossier client, pas en base.

BEGIN;

-- ---------------------------------------------------------------- demandes
-- Unité de travail : une commune d'un dossier. C'est le découpage retenu
-- (une demande par commune, groupée par service à l'envoi).

DO $$ BEGIN
  CREATE TYPE matrice_statut AS ENUM (
    'a_envoyer',   -- destinataire établi, pas encore parti
    'envoyee',     -- courriel parti, en attente de réponse du service
    'en_attente',  -- pas de destinataire fiable : ne part pas, est relancée
    'recue',       -- extrait reçu, versé au dossier client
    'abandonnee'   -- retirée du dossier par décision humaine
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS matrice_demande (
  id                bigserial PRIMARY KEY,
  dossier           text        NOT NULL,
  societe           text        NOT NULL,
  siren             char(9),
  code_insee        char(5)     NOT NULL,
  nom_commune       text        NOT NULL,
  departement       char(3)     NOT NULL,
  nb_lots           integer     NOT NULL DEFAULT 0 CHECK (nb_lots >= 0),

  statut            matrice_statut NOT NULL DEFAULT 'a_envoyer',
  motif_attente     text,          -- pourquoi elle ne part pas, en clair
  service_id        text,          -- id annuaire du service visé, si connu
  service_nom       text,
  destinataire      text,          -- courriel retenu ; NULL tant qu'il n'est pas établi
  telephone_relance text,          -- numéro à appeler pour débloquer le pointage

  prochaine_relance date,          -- NULL si la demande n'est pas en file
  nb_relances       integer     NOT NULL DEFAULT 0,
  derniere_relance  timestamptz,

  cree_le           timestamptz NOT NULL DEFAULT now(),
  maj_le            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (dossier, code_insee),

  -- Une demande sans destinataire ne peut pas être marquée envoyée.
  -- C'est la règle « jamais de rabattement » écrite en contrainte plutôt
  -- qu'en commentaire : le code applicatif peut se tromper, pas la base.
  CONSTRAINT destinataire_obligatoire_si_envoyee
    CHECK (statut <> 'envoyee' OR destinataire IS NOT NULL),

  -- Une demande en attente doit dire pourquoi et être dans la file.
  CONSTRAINT attente_motivee
    CHECK (statut <> 'en_attente' OR (motif_attente IS NOT NULL AND prochaine_relance IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_demande_file
  ON matrice_demande (prochaine_relance)
  WHERE statut = 'en_attente';

CREATE INDEX IF NOT EXISTS idx_demande_dossier ON matrice_demande (dossier);

-- ------------------------------------------------------------------ envois
-- Un courriel réellement parti, vers un service, portant n formulaires.

CREATE TABLE IF NOT EXISTS matrice_envoi (
  id            bigserial PRIMARY KEY,
  dossier       text        NOT NULL,
  service_id    text,
  service_nom   text        NOT NULL,
  destinataire  text        NOT NULL,
  nb_formulaires integer    NOT NULL CHECK (nb_formulaires > 0),
  mandat_joint  boolean     NOT NULL,
  envoye_le     timestamptz NOT NULL DEFAULT now(),
  envoye_par    text        NOT NULL,     -- initiales du collaborateur
  message_id    text                       -- identifiant du message, pour retrouver le fil
);

CREATE TABLE IF NOT EXISTS matrice_envoi_demande (
  envoi_id   bigint NOT NULL REFERENCES matrice_envoi(id)   ON DELETE CASCADE,
  demande_id bigint NOT NULL REFERENCES matrice_demande(id) ON DELETE CASCADE,
  PRIMARY KEY (envoi_id, demande_id)
);

-- ----------------------------------------------------------------- journal
-- Piste d'audit. Append-only : pas de mise à jour, pas de suppression.
-- Un dossier d'audit dont on peut réécrire l'historique ne vaut rien.

CREATE TABLE IF NOT EXISTS matrice_journal (
  id         bigserial PRIMARY KEY,
  demande_id bigint REFERENCES matrice_demande(id) ON DELETE RESTRICT,
  dossier    text        NOT NULL,
  evenement  text        NOT NULL,   -- 'creation','envoi','relance','reception','abandon','deblocage'
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  auteur     text        NOT NULL,   -- initiales, ou 'MATRICE' pour un acte automatique
  survenu_le timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journal_dossier ON matrice_journal (dossier, survenu_le);

CREATE OR REPLACE FUNCTION matrice_journal_immuable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'matrice_journal est en écriture seule : ni UPDATE ni DELETE';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_immuable ON matrice_journal;
CREATE TRIGGER trg_journal_immuable
  BEFORE UPDATE OR DELETE ON matrice_journal
  FOR EACH ROW EXECUTE FUNCTION matrice_journal_immuable();

-- ------------------------------------------------------------ horodatage
CREATE OR REPLACE FUNCTION matrice_touch() RETURNS trigger AS $$
BEGIN NEW.maj_le := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_demande_touch ON matrice_demande;
CREATE TRIGGER trg_demande_touch
  BEFORE UPDATE ON matrice_demande
  FOR EACH ROW EXECUTE FUNCTION matrice_touch();

COMMIT;

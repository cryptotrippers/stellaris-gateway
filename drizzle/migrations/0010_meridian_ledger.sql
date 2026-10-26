-- Sprint 1 E03 — persistence for the Meridian (Rail B) project ledger.
--
-- The rules live in src/lib/financial-ledger.shared.ts; these tables make the
-- stored ledger tamper-evident and append-only so the database can't be used
-- to rewrite history behind the rules:
--  * ledger_entries is append-only for every API role (no UPDATE, DELETE or
--    TRUNCATE) and each row carries a hash chain (prev_hash -> entry_hash)
--    computed by src/lib/ledger-hash.shared.ts. Appends are serialised per
--    project and must continue the chain exactly (seq + prev_hash), which is
--    also the compare-and-swap: two writers computed from the same head can't
--    both land.
--  * a source reference books once per project (I-B4 / I-B8), entries post
--    only into an OPEN period (I-B11), and Rail A ids / TSRA units are refused
--    (I-B9).
--  * periods only move open -> closed -> approved; the approver must differ
--    from the person who closed it (maker-checker); an approved period is
--    immutable and stores the Merkle root of its entries.
--  * nobody reads or writes these tables through the public API yet: there
--    are no client write grants, admins may read, and the server writes with
--    the service role through src/lib/ledger-store.server.ts.

CREATE TABLE public.ledger_projects (
  id text PRIMARY KEY,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_projects_rail_b_id CHECK (id !~* '^tessera[:/]' AND length(trim(id)) > 0),
  CONSTRAINT ledger_projects_rail_b_currency CHECK (upper(currency) NOT IN ('TSRA', 'STSRA'))
);

CREATE TABLE public.ledger_periods (
  project_id text NOT NULL REFERENCES public.ledger_projects(id),
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('regular', 'adjustment')),
  adjusts_period_id text,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'approved')),
  closed_by text,
  approved_by text,
  approved_at timestamptz,
  period_root text CHECK (period_root IS NULL OR period_root ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, adjusts_period_id) REFERENCES public.ledger_periods (project_id, id),
  CHECK ((kind = 'adjustment') = (adjusts_period_id IS NOT NULL)),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE public.ledger_entries (
  project_id text NOT NULL REFERENCES public.ledger_projects(id),
  seq bigint NOT NULL CHECK (seq > 0),
  period_id text NOT NULL,
  ref text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'invoice_issued', 'receipt_settled', 'invoice_written_off', 'expense_accrued',
    'expense_paid', 'obligation_due', 'obligation_paid', 'reserve_contribution',
    'reserve_release', 'valuation_recorded')),
  amount numeric(40, 0) NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  entry jsonb NOT NULL,
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq),
  UNIQUE (project_id, ref),
  UNIQUE (project_id, entry_hash),
  FOREIGN KEY (project_id, period_id) REFERENCES public.ledger_periods (project_id, id),
  CHECK (ref !~* '^tessera[:/]')
);

CREATE INDEX ledger_entries_period_idx ON public.ledger_entries (project_id, period_id, seq);

-- ---------------------------------------------------------------------------
-- Entries: append-only, chained, open periods only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ledger_entries_guard_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  proj_currency text;
  per_status text;
  head_seq bigint;
  head_hash text;
BEGIN
  -- Serialise appends per project (the chain head is the CAS token).
  SELECT currency INTO proj_currency FROM public.ledger_projects
   WHERE id = NEW.project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger project % does not exist', NEW.project_id;
  END IF;
  IF NEW.currency IS DISTINCT FROM proj_currency THEN
    RAISE EXCEPTION 'entry currency % does not match project currency %', NEW.currency, proj_currency;
  END IF;

  SELECT status INTO per_status FROM public.ledger_periods
   WHERE project_id = NEW.project_id AND id = NEW.period_id;
  IF per_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'period % is %; entries post only to an open period', NEW.period_id,
      coalesce(per_status, 'missing');
  END IF;

  -- Columns must agree with the hashed entry document.
  IF NEW.entry->>'ref' IS DISTINCT FROM NEW.ref
     OR NEW.entry->>'kind' IS DISTINCT FROM NEW.kind
     OR NEW.entry->>'periodId' IS DISTINCT FROM NEW.period_id
     OR (NEW.entry->>'amount')::numeric IS DISTINCT FROM NEW.amount THEN
    RAISE EXCEPTION 'entry columns do not match the entry document';
  END IF;

  SELECT seq, entry_hash INTO head_seq, head_hash FROM public.ledger_entries
   WHERE project_id = NEW.project_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq IS DISTINCT FROM coalesce(head_seq, 0) + 1 THEN
    RAISE EXCEPTION 'ledger_version_conflict: expected seq %, got %', coalesce(head_seq, 0) + 1, NEW.seq;
  END IF;
  IF NEW.prev_hash IS DISTINCT FROM coalesce(head_hash, repeat('0', 64)) THEN
    RAISE EXCEPTION 'ledger_version_conflict: prev_hash does not continue the chain';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_guard_insert
  BEFORE INSERT ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.ledger_entries_guard_insert();

CREATE OR REPLACE FUNCTION public.ledger_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.ledger_append_only();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON public.ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_append_only();

CREATE TRIGGER ledger_projects_append_only
  BEFORE UPDATE OR DELETE ON public.ledger_projects
  FOR EACH ROW EXECUTE FUNCTION public.ledger_append_only();
CREATE TRIGGER ledger_projects_no_truncate
  BEFORE TRUNCATE ON public.ledger_projects
  FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_append_only();

-- ---------------------------------------------------------------------------
-- Periods: open -> closed -> approved, maker-checker, approved is final
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ledger_periods_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  target_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger periods cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.closed_by IS NOT NULL OR NEW.approved_by IS NOT NULL
       OR NEW.period_root IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new period starts open, unclosed and unapproved';
    END IF;
    IF NEW.adjusts_period_id IS NOT NULL THEN
      SELECT status INTO target_status FROM public.ledger_periods
       WHERE project_id = NEW.project_id AND id = NEW.adjusts_period_id;
      IF target_status IS DISTINCT FROM 'approved' THEN
        RAISE EXCEPTION 'only an approved period needs an adjustment period';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.adjusts_period_id IS DISTINCT FROM OLD.adjusts_period_id
     OR NEW.starts_on IS DISTINCT FROM OLD.starts_on OR NEW.ends_on IS DISTINCT FROM OLD.ends_on
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a period''s identity and dates cannot change';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    IF coalesce(trim(NEW.closed_by), '') = '' THEN
      RAISE EXCEPTION 'closing a period needs a named preparer';
    END IF;
    IF NEW.approved_by IS NOT NULL OR NEW.period_root IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'closing a period does not approve it';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'closed' AND NEW.status = 'approved' THEN
    IF NEW.closed_by IS DISTINCT FROM OLD.closed_by THEN
      RAISE EXCEPTION 'the preparer of a closed period cannot change';
    END IF;
    IF coalesce(trim(NEW.approved_by), '') = '' THEN
      RAISE EXCEPTION 'approving a period needs a named approver';
    END IF;
    IF NEW.approved_by = OLD.closed_by THEN
      RAISE EXCEPTION 'maker-checker: the approver must differ from the preparer';
    END IF;
    IF NEW.period_root IS NULL THEN
      RAISE EXCEPTION 'an approved period must record its Merkle root';
    END IF;
    NEW.approved_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'period % cannot move from % to %', OLD.id, OLD.status, NEW.status;
END;
$$;

CREATE TRIGGER ledger_periods_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.ledger_periods
  FOR EACH ROW EXECUTE FUNCTION public.ledger_periods_guard();
CREATE TRIGGER ledger_periods_no_truncate
  BEFORE TRUNCATE ON public.ledger_periods
  FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_append_only();

-- ---------------------------------------------------------------------------
-- Access: server-only writes, admin reads
-- ---------------------------------------------------------------------------
ALTER TABLE public.ledger_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ledger_projects, public.ledger_periods, public.ledger_entries FROM anon, authenticated;
GRANT SELECT ON public.ledger_projects, public.ledger_periods, public.ledger_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ledger_projects, public.ledger_periods, public.ledger_entries TO service_role;

CREATE POLICY "Admins read ledger projects" ON public.ledger_projects
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins read ledger periods" ON public.ledger_periods
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins read ledger entries" ON public.ledger_entries
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON FUNCTION public.ledger_entries_guard_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_periods_guard() FROM PUBLIC, anon, authenticated;

-- Phase 14 additive migration: allow reversible archival. No data changed.
CREATE OR REPLACE FUNCTION guard_memory_lifecycle() RETURNS trigger AS $$
DECLARE allowed boolean := false;
BEGIN
  IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle THEN
    allowed := (OLD.lifecycle, NEW.lifecycle) IN (
      ('HYPOTHESIS','SUPPORTED'), ('HYPOTHESIS','REJECTED'), ('HYPOTHESIS','DISPUTED'),
      ('SUPPORTED','VERIFIED'), ('SUPPORTED','OUTDATED'), ('SUPPORTED','DISPUTED'), ('SUPPORTED','REJECTED'),
      ('VERIFIED','OUTDATED'), ('VERIFIED','DISPUTED'), ('VERIFIED','ARCHIVED'),
      ('DISPUTED','VERIFIED'), ('DISPUTED','SUPPORTED'), ('DISPUTED','REJECTED'), ('DISPUTED','ARCHIVED'),
      ('OUTDATED','SUPPORTED'), ('OUTDATED','ARCHIVED'), ('REJECTED','ARCHIVED'),
      ('ARCHIVED','HYPOTHESIS'), ('ARCHIVED','SUPPORTED'), ('ARCHIVED','REJECTED')
    );
    IF NOT allowed THEN RAISE EXCEPTION 'invalid lifecycle transition % -> %', OLD.lifecycle, NEW.lifecycle; END IF;
    IF NEW.lifecycle='VERIFIED' AND NEW.verified IS NOT true THEN
      RAISE EXCEPTION 'VERIFIED lifecycle requires independent verified evidence';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

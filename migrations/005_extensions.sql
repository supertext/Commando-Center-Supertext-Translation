-- The other plugins installed on the site (Plugin Health 0.3, field extensions): the latest list on the
-- installation, when it was received, and the list of each report that carried one.
ALTER TABLE installations ADD COLUMN extensions jsonb;
ALTER TABLE installations ADD COLUMN extensions_at timestamptz;
ALTER TABLE reports ADD COLUMN extensions jsonb;

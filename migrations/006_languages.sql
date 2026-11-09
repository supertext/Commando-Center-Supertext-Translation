-- The plugin's language mapping (Plugin Health 0.4, field languages: [{code, supertext}]): the latest list
-- on the installation, when it was received, and the list of each report that carried one.
ALTER TABLE installations ADD COLUMN languages jsonb;
ALTER TABLE installations ADD COLUMN languages_at timestamptz;
ALTER TABLE reports ADD COLUMN languages jsonb;

-- Plugins with several API keys report each one by name (protocol field api_keys). Stored as a JSON
-- list [{name, configured, status, checked_at, http_status, error_code}]; NULL: the plugin uses the
-- single-key fields. The api_key_* columns then hold the summary (any key configured, the worst check).
ALTER TABLE installations ADD COLUMN api_keys jsonb;
ALTER TABLE reports ADD COLUMN api_keys jsonb;

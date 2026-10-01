ALTER TABLE sources ADD COLUMN domains text[] NOT NULL DEFAULT '{}';
ALTER TABLE analyses ADD COLUMN domains text[] NOT NULL DEFAULT '{}';
ALTER TABLE publications ADD COLUMN domains text[] NOT NULL DEFAULT '{}';

UPDATE sources SET domains = ARRAY['ai'];
UPDATE analyses SET domains = ARRAY['ai'];
UPDATE publications SET domains = ARRAY['ai'];
UPDATE selected_ledger SET payload = payload || '{"domains":["ai"]}'::jsonb WHERE op = 'upsert';

ALTER TABLE sources ADD CONSTRAINT sources_domains_check CHECK (domains <@ ARRAY['ai', 'medical', 'legal', 'military', 'policy']::text[]);
ALTER TABLE analyses ADD CONSTRAINT analyses_domains_check CHECK (domains <@ ARRAY['ai', 'medical', 'legal', 'military', 'policy']::text[]);
ALTER TABLE publications ADD CONSTRAINT publications_domains_check CHECK (domains <@ ARRAY['ai', 'medical', 'legal', 'military', 'policy']::text[]);
CREATE INDEX publications_domains_idx ON publications USING gin (domains);

ALTER TABLE reports ADD COLUMN scope text;
UPDATE reports SET scope = 'ai';
ALTER TABLE reports ALTER COLUMN scope SET NOT NULL;
ALTER TABLE reports ADD CONSTRAINT reports_scope_check CHECK (scope IN ('all', 'ai', 'medical', 'legal', 'military', 'policy'));
ALTER TABLE reports DROP CONSTRAINT reports_kind_key_key;
ALTER TABLE reports ADD CONSTRAINT reports_kind_scope_key_key UNIQUE (kind, scope, key);

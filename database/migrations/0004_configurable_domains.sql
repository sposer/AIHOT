-- decision: validate domain membership in the application taxonomy; not repeat the registry in SQL
-- because configuration changes and disabled historical identities do not change storage structure.
ALTER TABLE sources DROP CONSTRAINT sources_domains_check;
ALTER TABLE analyses DROP CONSTRAINT analyses_domains_check;
ALTER TABLE publications DROP CONSTRAINT publications_domains_check;
ALTER TABLE reports DROP CONSTRAINT reports_scope_check;

#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --set=juris_password="$JURIS_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE mock_juris LOGIN PASSWORD %L', :'juris_password') \gexec
CREATE DATABASE mock_juris OWNER mock_juris;
REVOKE CONNECT ON DATABASE mock_juris FROM PUBLIC;
GRANT CONNECT ON DATABASE mock_juris TO mock_juris;
REVOKE CONNECT ON DATABASE claims FROM PUBLIC;
GRANT CONNECT ON DATABASE claims TO claims;
SQL

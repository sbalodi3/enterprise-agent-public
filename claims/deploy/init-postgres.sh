#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=claims_password="$CLAIMS_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE claims LOGIN PASSWORD %L', :'claims_password') \gexec
CREATE DATABASE claims OWNER claims;
SQL

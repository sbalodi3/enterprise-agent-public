FROM ghcr.io/cmaneu/entra-local:0.1.1@sha256:70584ef110914d100409cb3d63a63548ccdde10ca780f9751755f1482dec5d7e
WORKDIR /app
# Keep the upstream passwordless picker visible for all rostered demo employees.
RUN node --input-type=module -e "import fs from 'node:fs'; const p='dist/identity/signinPage.js'; const source=fs.readFileSync(p,'utf8'); const match='MANY_USERS_THRESHOLD = 3;'; if (source.split(match).length !== 2) throw Error('Unexpected upstream picker'); fs.writeFileSync(p,source.replace(match,'MANY_USERS_THRESHOLD = Infinity;'))"
COPY roster.mjs entra/start.mjs ./
CMD ["node", "start.mjs"]

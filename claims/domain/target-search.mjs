// Candidates contain record metadata only. The caller supplies the same employee/dataset
// predicate and evidence source used by protected claim reads.
export async function searchChatTargets(db, identity, { associated, evidenceTable }, {
  text, terms, documents, references, parents, excludedClaimIds, excludedDocumentIds, subsets,
}) {
  const from = documents
    ? `JOIN ${evidenceTable} e ON e.item_id=i.id AND e.document IS NOT NULL` : ''
  const fields = documents
    ? `e.id AS "documentId", (e.document->>'version')::int AS "documentVersion", e.title`
    : `i.title, concat_ws(' · ', s.facts->>'incidentDate', i.reason) AS detail`
  const targetId = documents ? 'e.id' : 'i.id'
  const title = documents ? 'e.title' : 'i.title'
  const metadata = documents ? 'e.title' : "concat_ws(' ',i.title,i.reason,i.policy_number,i.line_of_business,s.facts->>'insured',s.facts->>'client',s.facts->>'claimant',s.facts->>'employer',s.facts->>'incidentDate')"
  const restricted = documents
    ? `AND NOT(e.id=ANY($9)) AND (NOT($10::jsonb ? i.id) OR ($10::jsonb -> i.id) ? e.id)`
    : `AND (($10::jsonb ? i.id) OR NOT EXISTS(SELECT 1 FROM ${evidenceTable} rejected WHERE rejected.item_id=i.id AND rejected.id=ANY($9)))`
  const { rows } = await db.query(`WITH candidates AS (
    SELECT i.id AS "claimId", i.version AS "claimVersion", ${fields},
      regexp_replace(lower(${title}),'[^[:alnum:]]+',' ','g') AS normalized_title,
      regexp_split_to_array(lower(${metadata}),'[^[:alnum:]]+') AS tokens,
      lower(${targetId}) AS target_id
    FROM cw_items i ${from} ${documents ? '' : 'LEFT JOIN cw_showcase_records s ON s.item_id=i.id'}
    WHERE ${associated} AND (cardinality($7::text[])=0 OR i.id=ANY($7))
      AND NOT(i.id=ANY($8)) ${restricted}
  ), scored AS (
    SELECT candidates.*, (target_id=ANY($6)) AS exact_id,
      (trim(normalized_title)<>'' AND position(' '||trim(normalized_title)||' ' IN ' '||$4||' ')>0) AS exact_title,
      (SELECT count(*)::int FROM unnest($5::text[]) term WHERE term=ANY(tokens)) AS matches
    FROM candidates
  )
    SELECT "claimId","claimVersion",${documents ? '"documentId","documentVersion",' : 'detail,'}title,
      exact_id AS "exactId", exact_title AS "exactTitle", matches
    FROM scored WHERE exact_id OR exact_title OR matches>0
    ORDER BY exact_id DESC, exact_title DESC, matches DESC, target_id LIMIT 24`,
    [...identity, text, terms, references, parents, excludedClaimIds, excludedDocumentIds, JSON.stringify(subsets)])
  return rows
}

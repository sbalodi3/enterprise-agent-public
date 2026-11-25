// SQL predicates use the cw_items alias i. Keep portfolio, document and citation reads in sync.
export const activeDataset = "(i.external_claim_number IS NULL OR EXISTS (SELECT 1 FROM cw_datasets WHERE id='cms-mcp' AND active))"
export const supervisesClaims = role => role === 'supervisor' || role === 'claims_admin'
export const claimLines = ['PC', 'AUTO', 'COMM_AUTO', 'HOME', 'WC', 'HEALTH']
export const claimSourceStatuses = ['Open', 'Under Investigation', 'Paid', 'Denied', 'Closed']

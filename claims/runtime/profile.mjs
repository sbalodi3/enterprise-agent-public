const supported = new Set(['timeline', 'compare_evidence', 'explain_priority', 'prepare_handoff'])
const chatTools = new Set([
  'search_claims',
  'portfolio_summary',
  'get_claim_brief',
  'list_evidence',
  'read_evidence',
  'claim_timeline',
  'review_wage_evidence', 'list_claim_actions', 'check_action_status', 'read_juris_record', 'prepare_claim_action',
])
export function validateProfile(profile) {
  const hasChat = profile?.chatTools !== undefined || profile?.chatInstructions !== undefined
  if (
    !profile ||
    typeof profile.id !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(profile.release) ||
    !Array.isArray(profile.subjectTypes) ||
    !profile.subjectTypes.length ||
    !Array.isArray(profile.capabilities) ||
    !profile.capabilities.length ||
    profile.capabilities.some((name) => !supported.has(name)) ||
    (hasChat &&
      (!Array.isArray(profile.chatTools) ||
        !profile.chatTools.length ||
        profile.chatTools.some((name) => !chatTools.has(name)) ||
        new Set(profile.chatTools).size !== profile.chatTools.length ||
        typeof profile.chatInstructions !== 'string' ||
        !profile.chatInstructions.trim())) ||
    !Array.isArray(profile.workflows) ||
    profile.workflows.some((name) => name !== 'wage-evidence-v1') ||
    !Array.isArray(profile.procedures) ||
    profile.procedures.some((p) => !['portfolio-triage', 'review-before-write'].includes(p)) ||
    profile.evidencePolicy !== 'assigned-record-at-current-revision' ||
    profile.evaluation !== 'portfolio-review-v1' ||
    typeof profile.model !== 'string' ||
    !profile.model ||
    typeof profile.instructions !== 'string' ||
    typeof profile.owner !== 'string'
  ) {
    throw new Error('Invalid department profile release or unsupported capability')
  }
  return Object.freeze({
    ...profile,
    chatTools: Object.freeze([...(profile.chatTools ?? [])]),
    procedures: Object.freeze([...profile.procedures]),
    capabilities: Object.freeze([...profile.capabilities]),
    subjectTypes: Object.freeze([...profile.subjectTypes]),
    workflows: Object.freeze([...profile.workflows]),
  })
}

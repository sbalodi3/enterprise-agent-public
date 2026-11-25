import { randomUUID } from 'node:crypto'
import { DomainError } from './index.mjs'

const invalid = () => { throw new DomainError(400, 'invalid_question_answer') }
const plain = (s, limit) => typeof s === 'string' && s.trim() && s.length <= limit

// Only the candidate resolver can supply a reference. Model questions may contain
// employee-visible text but their options can never select a database identifier.
export function checkedQuestion(input, origin) {
  const text = input?.text ?? input?.question
  const options = input?.options ?? []
  if (!plain(text, 1200) || !Array.isArray(options) || options.length > 8)
    throw new DomainError(422, 'invalid_clarification')
  const choices = options.map((option, i) => {
    if (!plain(option?.label, 180) || (option.description !== undefined && !plain(option.description, 400)))
      throw new DomainError(422, 'invalid_clarification')
    const id = option.id ?? String(i + 1)
    if (!plain(id, 128)) throw new DomainError(422, 'invalid_clarification')
    return { id, label: option.label, ...(option.description && { description: option.description }) }
  })
  if (new Set(choices.map(c => c.id)).size !== choices.length) throw new DomainError(422, 'invalid_clarification')
  return { id: randomUUID(), origin, kind: origin === 'planner' ? input.kind ?? 'clarification' : 'clarification',
    question: text, options: choices, allowOther: input.allowOther !== false,
    ...(origin === 'planner' && input.candidate && { candidate: input.candidate }) }
}

export function publicQuestion(question) {
  const { origin, candidate, ...display } = question
  return display
}

export function checkedReply(input, question) {
  if (input.cancel === true && !input.answer) return { cancel: true }
  const a = input.answer
  if (input.cancel || !a || !Array.isArray(a.selected) || a.selected.length > 1) invalid()
  if (a.custom !== undefined) {
    if (a.selected.length || !question.allowOther || !plain(a.custom, 1200)) invalid()
    return { answer: { selected: [], custom: a.custom.trim() } }
  }
  if (a.selected.length !== 1 || !question.options.some(option => option.id === a.selected[0])) invalid()
  return { answer: { selected: a.selected } }
}

export function candidateScope(candidate) {
  return candidate.documentId
    ? { kind: 'document', claimIds: [candidate.claimId], documentId: candidate.documentId }
    : { kind: 'claim', claimIds: [candidate.claimId] }
}

export function continuation(replies, exclusions = {}) {
  const clarify = replies.filter(r => r.answer)
  const last = clarify.at(-1)
  const rejected = clarify.filter(r => r.question.candidate && r.answer.selected[0] !== 'yes')
  return {
    clarifications: clarify.map(r => ({ question: { ...publicQuestion(r.question), text: r.question.question }, answer: r.answer })),
    excludedClaimIds: [...new Set([...(exclusions.excludedClaimIds || []), ...rejected.filter(r => !r.question.candidate.documentId).map(r => r.question.candidate.claimId)])],
    excludedDocumentIds: [...new Set([...(exclusions.excludedDocumentIds || []), ...rejected.filter(r => r.question.candidate.documentId).map(r => r.question.candidate.documentId)])],
    correction: clarify.findLast(r => r.answer.custom)?.answer.custom,
    chooseCandidate: last?.answer.selected[0] === 'yes' ? last.question.candidate : undefined,
    modelClarifications: clarify.filter(r => r.question.origin === 'model')
      .map(r => ({ question: { ...publicQuestion(r.question), text: r.question.question }, answer: r.answer })),
    resumeModel: last?.question.origin === 'model',
  }
}

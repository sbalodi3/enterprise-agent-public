const dayMs = 86400000
function day(value) {
  if (!/^\d{4}-\d\d-\d\d$/.test(value)) throw RangeError('Invalid payroll calendar date')
  const stamp = Date.parse(value + 'T00:00:00Z')
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) throw RangeError('Invalid payroll calendar date')
  return stamp / dayMs
}
const date = number => new Date(number * dayMs).toISOString().slice(0, 10)

/** Intersect documented periods with the inclusive request and merge overlaps before counting days. */
export function wageCoverage(periods, start, end) {
  const first = day(start), last = day(end)
  if (last < first) throw RangeError('Reversed requested period')
  const intervals = periods.map(p => {
    const from = day(p.periodStart), to = day(p.periodEnd)
    if (to < from) throw RangeError('Reversed pay period')
    return [Math.max(from, first), Math.min(to, last)]
  }).filter(([from, to]) => from <= to).sort((a, b) => a[0] - b[0])
  const union = []
  for (const [from, to] of intervals) {
    const previous = union.at(-1)
    if (previous && from <= previous[1] + 1) previous[1] = Math.max(previous[1], to)
    else union.push([from, to])
  }
  const gaps = []
  let cursor = first
  for (const [from, to] of union) {
    if (cursor < from) gaps.push([date(cursor), date(from - 1)])
    cursor = to + 1
  }
  if (cursor <= last) gaps.push([date(cursor), date(last)])
  return { requested: last - first + 1, days: union.reduce((n, [a,b]) => n + b - a + 1, 0),
    covered: union.map(([a,b]) => [date(a), date(b)]), gaps }
}

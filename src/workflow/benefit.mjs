/**
 * 3.7: оценка пользы по фактическим метрикам до/после.
 */
export function evaluateBenefit({ before, after, metric, higherIsBetter = true, note } = {}) {
  const a = Number(before?.value)
  const b = Number(after?.value)
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { metric, verdict: 'no_data', delta: undefined, evidence: { before, after }, memory: undefined }
  }
  const delta = b - a
  const improved = higherIsBetter ? delta > 0 : delta < 0
  const verdict = delta === 0 ? 'unchanged' : improved ? 'improved' : 'regressed'
  return {
    metric,
    verdict,
    delta,
    evidence: { before, after, higherIsBetter },
    memory: note ? { kind: 'result', epistemic: 'fact', title: note, detail: `метрика ${metric}: ${a} → ${b} (${verdict})` } : undefined,
  }
}

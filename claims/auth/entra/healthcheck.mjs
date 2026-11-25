const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(2500) })
if (!response.ok || (await response.json()).status !== 'ok') {
  throw new Error('Entra Local is not ready')
}

const azureSettings = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_KEY']

function azureBaseURL(value) {
  const endpoint = URL.parse(value)
  if (!endpoint || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !['/', '/openai/v1', '/openai/v1/'].includes(endpoint.pathname)) {
    throw Error('AZURE_OPENAI_ENDPOINT must be an HTTPS resource endpoint or end in /openai/v1.')
  }
  return endpoint.origin + '/openai/v1'
}

export function appModel(settings, flags) {
  const llama = flags.has('--model')
  const ollama = flags.has('--ollama')
  if (llama && ollama) throw Error('Select one local model service: --model or --ollama.')

  const [endpoint, deployment, key] = azureSettings.map(name => settings[name]?.trim())
  if (endpoint || deployment || key) {
    const missing = azureSettings.filter(name => !settings[name]?.trim())
    if (missing.length) throw Error('Set all Azure OpenAI settings. Missing: ' + missing.join(', '))
    if (llama || ollama) throw Error('Remove --model or --ollama to use Azure OpenAI.')
    return {
      environment: {
        CLAIMS_MODEL_URL: azureBaseURL(endpoint),
        CLAIMS_MODEL_ID: deployment,
        CLAIMS_AZURE_OPENAI_API_KEY: key,
        CLAIMS_MODEL_DISABLED: '0',
      },
    }
  }

  const profile = llama ? 'model' : ollama ? 'ollama' : undefined
  const url = ollama ? 'http://ollama:11434/v1' : settings.CLAIMS_MODEL_URL
  const id = settings.CLAIMS_MODEL_ID?.trim()
  return {
    profile,
    environment: {
      ...(url && { CLAIMS_MODEL_URL: url }),
      ...(id && { CLAIMS_MODEL_ID: id }),
      CLAIMS_AZURE_OPENAI_API_KEY: '',
      CLAIMS_MODEL_DISABLED: llama || (url && (!ollama || id)) ? '0' : '1',
    },
  }
}

export function inferenceProvider(env, desktop) {
  if (env.CLAIMS_MODEL_DISABLED === '1') return undefined
  const azure = Boolean(env.CLAIMS_AZURE_OPENAI_API_KEY)
  return {
    api: 'openai-completions',
    baseURL: env.CLAIMS_MODEL_URL || (desktop ? 'http://127.0.0.1:3082/v1' : 'http://model:8080/v1'),
    apiKeyEnv: azure ? 'CLAIMS_AZURE_OPENAI_API_KEY' : 'CLAIMS_LOCAL_MODEL_KEY',
    ...(azure && { displayName: 'Azure OpenAI' }),
    models: [
      {
        id: env.CLAIMS_MODEL_ID || 'claims-local',
        name: azure ? env.CLAIMS_MODEL_ID : 'Local claims assistant',
        contextWindow: 8192,
        maxTokens: 1024,
        ...(azure && { compat: { supportsStore: false, maxTokensField: 'max_completion_tokens' } }),
      },
    ],
    retryPolicy: { mode: 'normal', maxRetries: 0 },
  }
}

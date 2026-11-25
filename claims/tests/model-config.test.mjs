import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appModel, inferenceProvider } from '../runtime/model-config.mjs'

const endpoint = 'https://showcase-resource.openai.azure.com'
const deployment = 'my-chat-deployment'
const key = 'test-only-key'
const azure = {
  AZURE_OPENAI_ENDPOINT: endpoint,
  AZURE_OPENAI_DEPLOYMENT: deployment,
  AZURE_OPENAI_API_KEY: key,
}
const defaults = new Set()

test('bare app launch registers no inference provider or model service', () => {
  const model = appModel({}, defaults)
  assert.equal(model.profile, undefined)
  assert.equal(inferenceProvider(model.environment), undefined)
})

test('Azure registers the deployment as the managed Chat Completions model with a server-side credential', () => {
  for (const address of [endpoint, endpoint + '/openai/v1/']) {
    const model = appModel({
      ...azure,
      AZURE_OPENAI_ENDPOINT: address,
      CLAIMS_MODEL_URL: 'http://previous-local:8080/v1',
      CLAIMS_MODEL_ID: 'previous-model',
    }, defaults)
    assert.equal(model.profile, undefined)
    assert.equal(model.environment.CLAIMS_MODEL_ID, deployment)
    assert.equal(model.environment.CLAIMS_AZURE_OPENAI_API_KEY, key)
    const provider = inferenceProvider(model.environment)
    assert.equal(provider.api, 'openai-completions')
    assert.equal(provider.baseURL, endpoint + '/openai/v1')
    assert.equal(provider.apiKeyEnv, 'CLAIMS_AZURE_OPENAI_API_KEY')
    assert.equal(provider.models[0].id, deployment)
    assert.equal(provider.models[0].compat.maxTokensField, 'max_completion_tokens')
    assert.ok(!JSON.stringify(provider).includes(key))
  }
})

test('partial Azure settings fail and only HTTPS v1 endpoints are accepted', () => {
  assert.throws(() => appModel({ AZURE_OPENAI_API_KEY: key }, defaults), /Missing: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT/)
  for (const address of [
    'http://showcase-resource.openai.azure.com',
    'https://user:password@showcase-resource.openai.azure.com',
    endpoint + '/openai/deployments/legacy',
    endpoint + '/openai/v1?api-version=old',
  ]) {
    assert.throws(() => appModel({ ...azure, AZURE_OPENAI_ENDPOINT: address }, defaults), /AZURE_OPENAI_ENDPOINT/)
  }
  assert.throws(() => appModel(azure, new Set(['--ollama'])), /Remove --model or --ollama/)
})

test('Ollama can start empty and only routes Chat when its model is selected', () => {
  const flags = new Set(['--ollama'])
  const empty = appModel({}, flags)
  assert.equal(empty.profile, 'ollama')
  assert.equal(inferenceProvider(empty.environment), undefined)
  const model = appModel({ CLAIMS_MODEL_ID: 'local:chosen' }, flags)
  const provider = inferenceProvider(model.environment)
  assert.equal(provider.baseURL, 'http://ollama:11434/v1')
  assert.equal(provider.models[0].id, 'local:chosen')
  assert.equal(provider.apiKeyEnv, 'CLAIMS_LOCAL_MODEL_KEY')
  assert.throws(() => appModel({}, new Set(['--ollama', '--model'])), /Select one local model/)
})

test('llama.cpp and existing external model settings remain selectable', () => {
  const llama = appModel({}, new Set(['--model']))
  assert.equal(llama.profile, 'model')
  assert.equal(inferenceProvider(llama.environment).models[0].id, 'claims-local')
  const external = appModel({ CLAIMS_MODEL_URL: 'http://local-server:8080/v1' }, defaults)
  assert.equal(external.profile, undefined)
  assert.equal(inferenceProvider(external.environment).baseURL, 'http://local-server:8080/v1')
})

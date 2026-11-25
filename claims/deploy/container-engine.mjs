import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function containerEngine(env = process.env) {
  const engine = env.CONTAINER_ENGINE || 'docker'
  if (engine !== 'docker' && engine !== 'podman') throw new Error('CONTAINER_ENGINE must be docker or podman.')
  return engine
}

export function containerEnvironment(engine, overrides = {}) {
  const env = { ...process.env, ...overrides }
  if (engine === 'podman') {
    // Podman compose otherwise honors a Docker endpoint from the shell.
    delete env.DOCKER_HOST
    delete env.DOCKER_CONTEXT
  }
  return env
}

export function composeConfig(engine, args, options) {
  return JSON.parse(execFileSync(engine, [...args, 'config', '--format', 'json'], {
    ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }))
}

function buildPodmanImage({ image, context, dockerfile = 'Dockerfile', platform, args = {}, target }, options) {
  const recipe = resolve(context, dockerfile)
  // Docker normally discovers this relative to the recipe. Pass it explicitly to Podman.
  const ignore = recipe + '.dockerignore'
  // Limit temporary disk use on Podman machines during the workspace build.
  const build = ['build', '--layers=false', '--disable-compression=false', '-t', image, '-f', recipe]
  if (existsSync(ignore)) build.push('--ignorefile', ignore)
  if (platform) build.push('--platform', platform)
  if (target) build.push('--target', target)
  for (const [key, value] of Object.entries(args)) build.push('--build-arg', key + '=' + value)
  execFileSync('podman', [...build, context], options)
}

export function buildComposeImages(engine, args, options, services, config) {
  if (engine === 'docker') {
    execFileSync(engine, [...args, 'build', ...(services ?? [])], options)
    return
  }
  const project = config ?? composeConfig(engine, args, options)
  const names = services ?? Object.keys(project.services).filter(name => project.services[name].build)
  const built = new Set()
  for (const name of names) {
    const { image, build, platform } = project.services[name] ?? {}
    if (!image || !build) throw new Error('Missing image or build configuration for ' + name)
    const unsupported = Object.keys(build).filter(key => !['context', 'dockerfile', 'args', 'target'].includes(key))
    if (unsupported.length) throw new Error('Podman build configuration for ' + name + ' needs support for ' + unsupported.join(', '))
    if (built.has(image)) continue
    buildPodmanImage({ image, platform, ...build }, options)
    built.add(image)
  }
}

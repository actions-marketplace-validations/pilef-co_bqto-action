import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const READY_TIMEOUT = 5 * 60_000
const PRO_PACKAGE = 'bqto-pro'
const PRO_VERSION = /^(\d+\.\d+\.\d+)-ends(\d{8})-\d+$/

const input = name => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim()

// Same format as @actions/core: a random delimiter, so a value cannot inject another line.
const write = (file, name, value) => {
  const eof = `ghadelimiter_${randomUUID()}`
  appendFileSync(process.env[file], `${name}<<${eof}\n${value}\n${eof}\n`)
}

const escape = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

const fail = message => {
  console.log(`::error::${escape(message)}`)
  process.exit(1)
}

const tail = file => readFileSync(file, 'utf8').split('\n').slice(-30).join('\n')

// Splits like a shell, with single and double quotes and backslashes, and without expansion.
const split = s => {
  const words = []
  let word = null
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) word += s[++i]
      else word += c
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word)
      word = null
    } else {
      word ??= ''
      if (c === "'" || c === '"') quote = c
      else if (c === '\\' && i + 1 < s.length) word += s[++i]
      else word += c
    }
  }
  if (quote) fail(`args has an unclosed ${quote} quote`)
  if (word !== null) words.push(word)
  return words
}

const gcloud = args => {
  const r = spawnSync('gcloud', [...args, '--quiet'], { encoding: 'utf8', maxBuffer: 16 << 20 })
  if (r.error?.code === 'ENOENT') {
    fail('gcloud is not on PATH\nFix: add google-github-actions/setup-gcloud before this step')
  }
  if (r.error) fail(`cannot run gcloud: ${r.error.message}`)
  return r
}

const gcloudFail = (r, what, repository) => {
  const err = r.stderr ?? ''
  if (/PERMISSION_DENIED|does not have permission|\b403\b/i.test(err)) {
    fail(
      `cannot ${what}: the job's Google account cannot read ${repository}\n` +
        "Fix: grant roles/artifactregistry.reader on that repository to the service account of google-github-actions/auth; in the beta, send that account's email to Pilef through https://bqto.dev",
    )
  }
  if (/active account|credential|reauthenticat|UNAUTHENTICATED|\b401\b/i.test(err)) {
    fail(
      `cannot ${what}: gcloud is not signed in\n` +
        'Fix: add google-github-actions/auth with service_account, and setup-gcloud, before this step',
    )
  }
  if (/NOT_FOUND|\b404\b/i.test(err)) {
    if (what.startsWith('download')) fail(`cannot ${what}: the build has no such file\nFix: run the job again later; if it fails again, open an issue at https://github.com/pilef-co/bqto/issues`)
    fail(`cannot ${what}: ${repository} has no ${PRO_PACKAGE} package\nFix: check the pro-project, pro-location and pro-repository inputs`)
  }
  console.log(err.split('\n').slice(-20).join('\n'))
  fail(`cannot ${what}: gcloud exited with ${r.status}`)
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

const proBinary = arch => {
  const where = {}
  for (const name of ['project', 'location', 'repository']) {
    where[name] = input(`pro-${name}`)
    if (!/^[a-z0-9][a-z0-9.:_-]*$/i.test(where[name])) fail(`pro-${name} is not a valid ${name}: ${where[name]}`)
  }
  const repository = `projects/${where.project}/locations/${where.location}/repositories/${where.repository}`
  const flags = [`--project=${where.project}`, `--location=${where.location}`, `--repository=${where.repository}`, `--package=${PRO_PACKAGE}`]

  let r = gcloud(['artifacts', 'versions', 'list', ...flags, '--format=json'])
  if (r.status !== 0) gcloudFail(r, 'list the bqto Pro builds', repository)
  let versions
  try {
    versions = JSON.parse(r.stdout)
  } catch {
    fail('cannot list the bqto Pro builds: gcloud did not print JSON')
  }
  const [newest] = (Array.isArray(versions) ? versions : [])
    .map(v => ({ id: String(v?.name ?? '').split('/').pop(), time: Date.parse(v?.createTime) }))
    .filter(v => PRO_VERSION.test(v.id) && !Number.isNaN(v.time))
    .sort((a, b) => b.time - a.time || Number(BigInt(b.id.split('-').pop()) - BigInt(a.id.split('-').pop())))
  if (!newest) fail(`${repository} has no bqto Pro build\nFix: check the pro-project, pro-location and pro-repository inputs`)
  const [, release, ends] = newest.id.match(PRO_VERSION)

  const dir = mkdtempSync(join(process.env.RUNNER_TEMP, 'bqto-pro-'))
  const archive = `bqto-pro_${release}_linux_${arch}.tar.gz`
  for (const name of ['checksums.txt', archive]) {
    r = gcloud(['artifacts', 'generic', 'download', ...flags, `--version=${newest.id}`, `--name=${name}`, `--destination=${dir}`])
    if (r.status !== 0) gcloudFail(r, `download ${name} of bqto Pro ${newest.id}`, repository)
  }
  const sums = readFileSync(join(dir, 'checksums.txt'), 'utf8')
    .split('\n')
    .map(line => line.match(/^([0-9a-f]{64}) [ *]?(\S+)$/))
    .filter(m => m && m[2] === archive)
  if (sums.length !== 1 || sums[0][1] !== sha256(join(dir, archive))) {
    fail(`${archive} of bqto Pro ${newest.id} does not match its checksums.txt\nFix: run the job again; if it fails again, open an issue at https://github.com/pilef-co/bqto/issues`)
  }
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  r = spawnSync('tar', ['-xzf', join(dir, archive), '-C', bin, 'bqto'], { encoding: 'utf8' })
  if (r.status !== 0) fail(`cannot extract bqto from ${archive}: ${r.stderr || r.error?.message}`)
  if (!lstatSync(join(bin, 'bqto')).isFile()) fail(`bqto in ${archive} is not a regular file`)
  chmodSync(join(bin, 'bqto'), 0o755)

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  if (ends < today) console.log(`::warning::the newest bqto Pro beta build ended after ${ends}; it works as the free bqto`)
  console.log(`bqto Pro ${newest.id}, ${archive} matches its checksums.txt`)
  return { path: join(bin, 'bqto'), live: ends >= today }
}

const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
if (process.platform !== 'linux' || !arch) {
  fail(`bqto-action runs on Linux runners, amd64 or arm64, not ${process.platform} ${process.arch}`)
}

const edition = input('edition') || 'free'
if (edition !== 'free' && edition !== 'pro') fail(`edition is ${edition}, not free or pro`)
const pro = edition === 'pro' ? proBinary(arch) : null
const bqto = pro?.path ?? join(import.meta.dirname, 'bin', `bqto_linux_${arch}`)

const env = { ...process.env }
const config = input('config')
if (config) {
  const home = mkdtempSync(join(process.env.RUNNER_TEMP, 'bqto-config-'))
  mkdirSync(join(home, 'bqto'))
  try {
    copyFileSync(config, join(home, 'bqto', 'config.toml'))
  } catch (e) {
    fail(`cannot read config ${config}: ${e.message}`)
  }
  env.XDG_CONFIG_HOME = home
}
const runEnv = config ? (process.env.XDG_CONFIG_HOME ? ['env', `XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}`] : ['env', '-u', 'XDG_CONFIG_HOME']) : []

const args = ['connect']
for (const name of ['service', 'project', 'instance', 'profile', 'stack', 'network', 'region', 'zone', 'duration', 'port']) {
  if (input(name)) args.push(`--${name}`, input(name))
}
// A re-run with debug logging debugs bqto too.
if (process.env.RUNNER_DEBUG === '1') args.push('--debug')
const extra = split(input('args'))
if (extra.includes('--')) fail('args cannot hold --; put the command in run')
args.push(...extra, '--no-input')

const run = input('run')
const webOff = ['0', 'f', 'F', 'false', 'FALSE', 'False']
if (run && extra.some(a => /^--?web(=|$)/.test(a) && !webOff.includes(a.split('=')[1]))) {
  fail('--web with run would print the web proxy secret in the job log\nFix: drop --web; the command reaches Cloud Run through ALL_PROXY and HTTPS_PROXY')
}
if (run && pro?.live) args.push('--web=false')
if (run) {
  // The command's exit code is bqto's, and the runner's cancel signal goes to node only.
  const child = spawn(bqto, [...args, '--', ...runEnv, 'bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
    stdio: 'inherit',
    env,
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('error', err => fail(`cannot start bqto: ${err.message}`))
  child.on('close', (code, signal) => process.exit(code ?? 128 + constants.signals[signal]))
} else {
  // Output goes to files: a child that holds the step's stdout open delays the end of the step.
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP, 'bqto-'))
  const out = join(dir, 'stdout.log')
  const err = join(dir, 'stderr.log')
  const child = spawn(bqto, [...args, '--output', 'json'], {
    detached: true,
    stdio: ['ignore', openSync(out, 'w'), openSync(err, 'w')],
    env,
  })
  child.unref()
  let exited = false
  child.on('exit', () => (exited = true))
  child.on('error', e => fail(`cannot start bqto: ${e.message}`))
  // Saved first, so the post step ends the session even if this step fails or is cancelled.
  write('GITHUB_STATE', 'pid', child.pid)
  write('GITHUB_STATE', 'log', err)

  let sessions
  for (const deadline = Date.now() + READY_TIMEOUT; ; await sleep(1000)) {
    sessions = readFileSync(out, 'utf8')
      .split('\n')
      .slice(0, -1)
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line))
      .filter(e => e.event === 'ready')
    if (sessions.length) break
    if (exited) {
      console.log(tail(err))
      fail('bqto ended before the session was ready')
    }
    if (Date.now() > deadline) {
      console.log(tail(err))
      fail(`the session was not ready after ${READY_TIMEOUT / 60_000} minutes`)
    }
  }

  for (const s of sessions) if (s.web_token) console.log(`::add-mask::${escape(s.web_token)}`)
  const [ready] = sessions
  for (const name of ['host', 'port', 'remote', 'bastion', 'expires', 'proxy']) write('GITHUB_OUTPUT', name, ready[name] ?? '')
  write('GITHUB_OUTPUT', 'sessions', JSON.stringify(sessions))
  write('GITHUB_ENV', 'BQTO_HOST', ready.host)
  write('GITHUB_ENV', 'BQTO_PORT', ready.port)
  if (ready.proxy === 'socks5') write('GITHUB_ENV', 'BQTO_PROXY', `socks5h://${ready.host}:${ready.port}`)
  if (ready.service === 'cloudsql' || ready.service === 'alloydb') {
    write('GITHUB_ENV', 'PGHOST', ready.host)
    write('GITHUB_ENV', 'PGPORT', ready.port)
  }
  console.log(`session ready on ${ready.host}:${ready.port}, bastion ${ready.bastion}, expires ${ready.expires}`)
}

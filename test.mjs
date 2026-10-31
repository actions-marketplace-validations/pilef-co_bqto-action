// Runs main.mjs and post.mjs against a fake bqto and a fake gcloud. Linux only: node test.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE = `#!/bin/sh
printf '%s\\n' "$@" >"$RUNNER_TEMP/args"
echo "$0" >"$RUNNER_TEMP/bqto-path"
if [ -n "$XDG_CONFIG_HOME" ] && [ -f "$XDG_CONFIG_HOME/bqto/config.toml" ]; then
	cp "$XDG_CONFIG_HOME/bqto/config.toml" "$RUNNER_TEMP/config-seen"
fi
case " $* " in
*" --instance gone "*)
	echo 'instance not found' >&2
	exit 1
	;;
*" --instance stubborn "*" --output json "*)
	trap '' INT
	trap 'sleep 1; echo terminated after cleanup >&2; exit 0' TERM
	echo '{"event":"ready","service":"cloudsql","instance":"db","host":"127.0.0.1","port":15432}'
	while :; do sleep 1; done
	;;
*" --service cloudrun "*" --output json "*)
	trap 'exit 0' INT
	echo '{"event":"ready","service":"cloudrun","instance":"europe-west1/app","host":"127.0.0.1","port":1080,"proxy":"socks5","remote":"app.run.app:443","web":"http://127.0.0.1:8080","web_token":"s3cret-token","bastion":"bqto-y","expires":"2026-10-24T00:00:00Z"}'
	while :; do sleep 1; done
	;;
*" --output json "*)
	trap 'echo deleted the bastion >&2; exit 0' INT
	echo '{"event":"ready","service":"cloudsql","instance":"db","host":"127.0.0.1","port":15432,"remote":"10.0.0.3:5432","bastion":"bqto-x","expires":"2026-10-24T00:00:00Z"}'
	while :; do sleep 1; done
	;;
esac
while [ "$1" != -- ]; do shift; done
shift
PGPORT=15432 exec "$@"
`

const GCLOUD = `#!/bin/sh
echo "$*" >>"$RUNNER_TEMP/gcloud.log"
if [ "$FAKE_GCLOUD" = denied ]; then
	echo "ERROR: (gcloud.artifacts.versions.list) PERMISSION_DENIED: Permission 'artifactregistry.versions.list' denied on resource (or it may not exist)." >&2
	exit 1
fi
case "$1 $2 $3" in
"artifacts versions list")
	cat "$FAKE_STORE/versions.json"
	;;
"artifacts generic download")
	for a; do
		case $a in
		--version=*) v=\${a#*=} ;;
		--name=*) n=\${a#*=} ;;
		--destination=*) d=\${a#*=} ;;
		esac
	done
	[ -f "$FAKE_STORE/$v/$n" ] || { echo "ERROR: NOT_FOUND: $v/$n" >&2; exit 1; }
	cp "$FAKE_STORE/$v/$n" "$d/"
	;;
*) exit 2 ;;
esac
`

const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
const dir = mkdtempSync(join(tmpdir(), 'bqto-action-'))
for (const file of ['main.mjs', 'post.mjs']) copyFileSync(file, join(dir, file))
mkdirSync(join(dir, 'bin'))
writeFileSync(join(dir, 'bin', `bqto_linux_${arch}`), FAKE, { mode: 0o755 })
mkdirSync(join(dir, 'gcloud'))
writeFileSync(join(dir, 'gcloud', 'gcloud'), GCLOUD, { mode: 0o755 })

// Two Artifact Registry stores: the newest build holds the files, and the bad one has a wrong checksum.
const NEWEST = '0.8.0-ends20991130-5'
const store = (name, sum, newest = NEWEST, extra = []) => {
  const root = join(dir, name)
  const files = join(root, newest)
  mkdirSync(files, { recursive: true })
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'bqto'), FAKE, { mode: 0o755 })
  const archive = `bqto-pro_0.8.0_linux_${arch}.tar.gz`
  assert.equal(spawnSync('tar', ['-czf', join(files, archive), '-C', join(root, 'src'), 'bqto']).status, 0)
  const real = createHash('sha256').update(readFileSync(join(files, archive))).digest('hex')
  writeFileSync(join(files, 'checksums.txt'), `${'0'.repeat(64)}  bqto-pro_0.8.0_darwin_arm64.tar.gz\n${sum(real)}  ${archive}\n`)
  writeFileSync(
    join(root, 'versions.json'),
    JSON.stringify([
      { name: 'projects/p/locations/l/repositories/r/packages/bqto-pro/versions/0.7.0-ends20991130-1', createTime: '2026-10-01T10:00:00.123456Z' },
      { name: `projects/p/locations/l/repositories/r/packages/bqto-pro/versions/${newest}`, createTime: '2026-10-20T10:00:00.5Z' },
      { name: 'projects/p/locations/l/repositories/r/packages/bqto-pro/versions/0.9.0-ends20991130-1', createTime: '2026-10-05T10:00:00Z' },
      { name: 'projects/p/locations/l/repositories/r/packages/bqto-pro/versions/0.9.0-ends20991130-2', createTime: 'not a time' },
      ...extra,
      { name: 'projects/p/locations/l/repositories/r/packages/bqto-pro/versions/0.8.0-ends20991130-3', createTime: '2026-10-10T10:00:00Z' },
      { name: 'projects/p/locations/l/repositories/r/packages/bqto-pro/versions/latest', createTime: '2026-12-01T10:00:00Z' },
    ]),
  )
  return root
}
const good = store('good', real => real)
const bad = store('bad', real => real.replace(/^./, c => (c === 'a' ? 'b' : 'a')))
const ended = store('ended', real => real, '0.8.0-ends20200101-10', [
  { name: 'projects/p/locations/l/repositories/r/packages/bqto-pro/versions/0.8.0-ends20200101-9', createTime: '2026-10-20T10:00:00.5Z' },
])

const files = Object.fromEntries(['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_STATE'].map(name => [name, join(dir, name)]))
const baseEnv = () => {
  const env = { ...process.env, RUNNER_TEMP: dir, RUNNER_DEBUG: '', ...files }
  delete env.XDG_CONFIG_HOME
  for (const name of Object.keys(env)) if (name.startsWith('INPUT_')) delete env[name]
  return env
}
const action = (script, env) => {
  for (const file of Object.values(files)) writeFileSync(file, '')
  for (const file of ['args', 'bqto-path', 'gcloud.log', 'config-seen']) rmSync(join(dir, file), { force: true })
  return spawnSync('node', [join(dir, script)], { env: { ...baseEnv(), ...env }, encoding: 'utf8' })
}
const pro = env => ({
  INPUT_EDITION: 'pro',
  'INPUT_PRO-PROJECT': 'prj-builds',
  'INPUT_PRO-LOCATION': 'us-central1',
  'INPUT_PRO-REPOSITORY': 'builds',
  PATH: `${join(dir, 'gcloud')}:${process.env.PATH}`,
  FAKE_STORE: good,
  ...env,
})
const read = name =>
  Object.fromEntries([...readFileSync(files[name], 'utf8').matchAll(/^(\w+)<<(\S+)\n(.*)\n\2$/gm)].map(m => [m[1], m[3]]))
const args = () => readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')

// run: the command sees the session, and its exit code is the step's.
let r = action('main.mjs', {
  INPUT_INSTANCE: 'db',
  INPUT_DURATION: '15m',
  INPUT_RUN: 'test "$PGPORT" = 15432 && exit 3',
  RUNNER_DEBUG: '1',
})
assert.equal(r.status, 3, r.stdout + r.stderr)
assert.match(args().join(' '), /^connect --instance db --duration 15m --debug --no-input -- bash --noprofile --norc -eo pipefail -c test/)
assert.equal(readFileSync(join(dir, 'bqto-path'), 'utf8').trim(), join(dir, 'bin', `bqto_linux_${arch}`))

// args splits as a shell does, with quotes, and refuses --.
r = action('main.mjs', { INPUT_INSTANCE: 'db', INPUT_RUN: 'true', INPUT_ARGS: ` --labels "team=a b" 'x "y"' z\\ w "a\\"b" '' ` })
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.deepEqual(args().slice(0, 9), ['connect', '--instance', 'db', '--labels', 'team=a b', 'x "y"', 'z w', 'a"b', ''])
r = action('main.mjs', { INPUT_INSTANCE: 'db', INPUT_RUN: 'true', INPUT_ARGS: '--labels "a b' })
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::args has an unclosed " quote/)
r = action('main.mjs', { INPUT_INSTANCE: 'db', INPUT_RUN: 'true', INPUT_ARGS: '-- rm -rf /' })
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::args cannot hold --/)
assert.equal(existsSync(join(dir, 'args')), false)

// Without run: the step returns once the session is ready, with outputs and env for later steps.
r = action('main.mjs', { INPUT_INSTANCE: 'db', INPUT_ZONE: 'us-east1-b', INPUT_PORT: '15432', INPUT_ARGS: ' --debug  --network n ' })
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.equal(args().join(' '), 'connect --instance db --zone us-east1-b --port 15432 --debug --network n --no-input --output json')
const { sessions, ...out } = read('GITHUB_OUTPUT')
assert.deepEqual(out, { host: '127.0.0.1', port: '15432', remote: '10.0.0.3:5432', bastion: 'bqto-x', expires: '2026-10-24T00:00:00Z', proxy: '' })
const { proxy, ...ready } = out
assert.deepEqual(JSON.parse(sessions), [{ event: 'ready', service: 'cloudsql', instance: 'db', ...ready, port: 15432 }])
assert.deepEqual(read('GITHUB_ENV'), { BQTO_HOST: '127.0.0.1', BQTO_PORT: '15432', PGHOST: '127.0.0.1', PGPORT: '15432' })
let state = read('GITHUB_STATE')

// The post step ends the session and waits for bqto to clean up.
r = action('post.mjs', { STATE_pid: state.pid, STATE_log: state.log })
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /deleted the bastion/)
assert.doesNotMatch(r.stdout, /::warning::/)

// A bqto that ignores SIGINT gets SIGTERM, and the post step waits for it before printing the log.
r = action('main.mjs', { INPUT_INSTANCE: 'stubborn' })
assert.equal(r.status, 0, r.stdout + r.stderr)
state = read('GITHUB_STATE')
const stubborn = new Promise(resolve => {
  const child = spawn('node', [join(dir, 'post.mjs')], { env: { ...baseEnv(), STATE_pid: state.pid, STATE_log: state.log } })
  let stdout = ''
  child.stdout.on('data', d => (stdout += d))
  child.on('close', status => resolve({ status, stdout }))
})

// bqto ending before ready fails the step and shows why.
r = action('main.mjs', { INPUT_INSTANCE: 'gone' })
assert.equal(r.status, 1)
assert.match(r.stdout, /instance not found[\s\S]*::error::bqto ended before the session was ready/)

// Pro: the newest build by create time, checked against checksums.txt, runs a Cloud Run session with a profile file.
writeFileSync(join(dir, 'profiles.toml'), '[profiles.app]\nservice = "cloudrun"\n')
r = action('main.mjs', pro({ INPUT_SERVICE: 'cloudrun', INPUT_INSTANCE: 'europe-west1/app', INPUT_CONFIG: join(dir, 'profiles.toml'), INPUT_ARGS: '--web' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(readFileSync(join(dir, 'bqto-path'), 'utf8'), /\/bqto-pro-[^/]+\/bin\/bqto\n$/)
assert.match(r.stdout, new RegExp(`bqto Pro ${NEWEST}, bqto-pro_0.8.0_linux_${arch}.tar.gz matches its checksums.txt`))
assert.match(r.stdout, /^::add-mask::s3cret-token$/m)
assert.equal(readFileSync(join(dir, 'config-seen'), 'utf8'), '[profiles.app]\nservice = "cloudrun"\n')
const calls = readFileSync(join(dir, 'gcloud.log'), 'utf8').trim().split('\n')
const where = '--project=prj-builds --location=us-central1 --repository=builds --package=bqto-pro'
assert.equal(calls.length, 3)
assert.equal(calls[0], `artifacts versions list ${where} --format=json --quiet`)
for (const [i, name] of ['checksums.txt', `bqto-pro_0.8.0_linux_${arch}.tar.gz`].entries()) {
  assert.ok(calls[i + 1].startsWith(`artifacts generic download ${where} --version=${NEWEST} --name=${name} --destination=${dir}/bqto-pro-`), calls[i + 1])
}
assert.equal(read('GITHUB_OUTPUT').proxy, 'socks5')
assert.deepEqual(read('GITHUB_ENV'), { BQTO_HOST: '127.0.0.1', BQTO_PORT: '1080', BQTO_PROXY: 'socks5h://127.0.0.1:1080' })
state = read('GITHUB_STATE')
r = action('post.mjs', { STATE_pid: state.pid, STATE_log: state.log })
assert.equal(r.status, 0, r.stdout + r.stderr)

// Pro: with run, --web is refused, and config reaches bqto but not the command.
r = action('main.mjs', pro({ INPUT_SERVICE: 'cloudrun', INPUT_INSTANCE: 'europe-west1/app', INPUT_RUN: 'true', INPUT_ARGS: '--web' }))
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::--web with run would print the web proxy secret/)
assert.equal(existsSync(join(dir, 'args')), false)
r = action('main.mjs', pro({ INPUT_SERVICE: 'cloudrun', INPUT_INSTANCE: 'europe-west1/app', INPUT_RUN: 'true', INPUT_ARGS: '-web=1' }))
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::--web with run/)
r = action('main.mjs', pro({ INPUT_PROFILE: 'app', INPUT_CONFIG: join(dir, 'profiles.toml'), INPUT_RUN: 'test -z "$XDG_CONFIG_HOME" && echo clean' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /^clean$/m)
assert.equal(readFileSync(join(dir, 'config-seen'), 'utf8'), '[profiles.app]\nservice = "cloudrun"\n')
assert.match(args().join(' '), /^connect --profile app --no-input --web=false -- env -u XDG_CONFIG_HOME bash /)
r = action('main.mjs', pro({ INPUT_PROFILE: 'app', INPUT_CONFIG: join(dir, 'profiles.toml'), INPUT_RUN: 'echo "xdg=$XDG_CONFIG_HOME"', XDG_CONFIG_HOME: '/x' }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /^xdg=\/x$/m)

// Pro: of two builds made at the same time, the higher run id; a build past its last day warns.
r = action('main.mjs', pro({ INPUT_INSTANCE: 'db', INPUT_RUN: 'true', FAKE_STORE: ended }))
assert.equal(r.status, 0, r.stdout + r.stderr)
assert.match(r.stdout, /bqto Pro 0.8.0-ends20200101-10,/)
assert.equal(args().join(' '), 'connect --instance db --no-input -- bash --noprofile --norc -eo pipefail -c true')
assert.match(r.stdout, /::warning::the newest bqto Pro beta build ended after 20200101/)

// Pro: a missing reader role fails with the cause and a Fix line, before bqto runs.
r = action('main.mjs', pro({ INPUT_INSTANCE: 'db', INPUT_RUN: 'true', FAKE_GCLOUD: 'denied' }))
assert.equal(r.status, 1)
assert.match(
  r.stdout,
  /^::error::cannot list the bqto Pro builds: the job's Google account cannot read projects\/prj-builds\/locations\/us-central1\/repositories\/builds%0AFix: grant roles\/artifactregistry.reader on that repository/m,
)
assert.equal(existsSync(join(dir, 'args')), false)

// Pro: an archive that does not match checksums.txt never runs.
r = action('main.mjs', pro({ INPUT_INSTANCE: 'db', INPUT_RUN: 'true', FAKE_STORE: bad }))
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::bqto-pro_0.8.0_linux_\w+.tar.gz of bqto Pro 0.8.0-ends20991130-5 does not match its checksums.txt%0AFix:/)
assert.equal(existsSync(join(dir, 'args')), false)

// Pro: an input that is not a plain name never reaches gcloud.
r = action('main.mjs', pro({ INPUT_INSTANCE: 'db', INPUT_RUN: 'true', 'INPUT_PRO-PROJECT': '--impersonate-service-account=x' }))
assert.equal(r.status, 1)
assert.match(r.stdout, /::error::pro-project is not a valid project/)
assert.equal(existsSync(join(dir, 'gcloud.log')), false)

r = await stubborn
assert.equal(r.status, 0, r.stdout)
assert.match(r.stdout, /sending SIGTERM[\s\S]*terminated after cleanup/)

console.log('ok')

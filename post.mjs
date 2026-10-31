import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const STOP_TIMEOUT = 60
const TERM_TIMEOUT = 5

const pid = Number(process.env.STATE_pid)
const log = process.env.STATE_log

// bqto outlives main's node, so it is not our child: read its state from /proc. A zombie has ended.
const alive = () => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()[0] !== 'Z'
  } catch {
    return false
  }
}

// Only the background mode saves a pid; with run, the session ended with the command.
if (pid) {
  if (!alive()) {
    console.log('::warning::the bqto session ended before the post step; its log is below')
  } else {
    // SIGINT makes bqto delete the bastion. It may end on its own in between.
    try {
      process.kill(pid, 'SIGINT')
    } catch {}
    for (let i = 0; i < STOP_TIMEOUT && alive(); i++) await sleep(1000)
    if (alive()) {
      console.log(`::warning::bqto did not end ${STOP_TIMEOUT} s after SIGINT; sending SIGTERM. --duration deletes the bastion if bqto cannot.`)
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
      for (let i = 0; i < TERM_TIMEOUT && alive(); i++) await sleep(1000)
    }
  }
  console.log('::group::bqto log')
  try {
    console.log(readFileSync(log, 'utf8'))
  } catch (e) {
    console.log(`cannot read the bqto log: ${e.message}`)
  }
  console.log('::endgroup::')
}

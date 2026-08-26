// Text that tells somebody else's scheduler when to tick. No timers, no process, no daemon.
//
// THERE IS NO DAEMON, AND THAT IS THE DESIGN RATHER THAN AN OMISSION.
//
// A long running watcher needs a real clock and real timers. The moment either is inside the core,
// two things this project depends on stop being true. First, the house contract tests forbid a
// testable core from reading a clock or arming a timer, and every function in `tick.ts` takes `now`
// as a parameter precisely so a test can state the instant it is asserting about. Second, and more
// important, A DRIFT-OVER-TIME SEQUENCE MUST BE REPLAYABLE DETERMINISTICALLY IN VITEST. The
// interesting properties of this package are all about ORDER: that an alarm raised on tick 41 is not
// a confirmation, that a confirmation needs a second independently collected round, that forty quiet
// rounds do not manufacture an alarm the way a fixed-alpha test would. Those are assertions about a
// sixty element sequence, and a test that had to wait for wall time to advance to make them would
// either take an hour or be written against a faked clock, and a faked clock is a second
// implementation of the thing under test.
//
// So `tick` is a pure fold over one already collected round, and running it on a schedule is a
// SEPARATE CONCERN THAT THE OPERATING SYSTEM ALREADY SOLVES BETTER THAN THIS PACKAGE COULD. cron,
// launchd, systemd timers and GitHub Actions all restart after a reboot, all log, all serialize
// overlapping invocations or let you ask them to, and all can be inspected by somebody who has never
// read this repository. A daemon here would reimplement that badly and would additionally own state
// that has to survive a restart, which the watch file already is, so the daemon would be a second
// copy of the truth with no way to notice when the two disagreed.
//
// WHAT THIS FILE IS NOT: an installer. Nothing here executes, spawns, writes a plist or edits a
// crontab. It returns strings a person reads, edits and pastes. A library that installs a recurring
// job on the user's machine as a side effect of being imported is a library that has to be trusted
// rather than read, and the whole argument of this project is that the tool should be checkable.
//
// ONE HONEST CAVEAT, STATED HERE BECAUSE IT AFFECTS THE STATISTICS. A tick is the unit of evidence,
// and A MISSED TICK IS NOT A QUIET TICK. The e-process only accumulates wealth from rounds that were
// actually collected, so a scheduler that silently skips runs makes the watch slower rather than
// wrong, which is the safe direction. GitHub Actions in particular delays and sometimes drops
// scheduled runs under load, so a canary that must not miss a look belongs on a machine you control.

/**
 * A crontab line that ticks every `everyMinutes` minutes.
 *
 * Sub-hour intervals use a step expression, which is what cron actually offers, and a step that does
 * not divide 60 produces one short gap per hour: a seven minute step fires at :00 through :56 and
 * then waits eleven minutes for the top of the next hour. That is harmless for a drift watch, where
 * the ticks are not required to be evenly spaced, and it is stated here so nobody discovers it from
 * a graph of tick intervals. Intervals above an hour are
 * rounded to whole hours because cron has no notion of a 90 minute period, and anything from a day
 * upward becomes a daily job at midnight.
 *
 * The path is a placeholder on purpose. Guessing the user's checkout location and writing it into a
 * line they are about to paste into a root crontab is a worse default than an obvious blank.
 */
export function cronSuggestion(everyMinutes: number): string {
  const minutes = Math.max(1, Math.floor(everyMinutes));
  const schedule = cronSchedule(minutes);
  return `${schedule} cd /path/to/your/repo && sentinel watch --tick >> /var/log/sentinel-watch.log 2>&1`;
}

function cronSchedule(minutes: number): string {
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes >= 1440) return "0 0 * * *";
  const hours = Math.max(1, Math.min(23, Math.round(minutes / 60)));
  return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
}

/**
 * launchd, for macOS, where cron is deprecated and a laptop is asleep half the day.
 *
 * `StartInterval` rather than `StartCalendarInterval` because a drift watch cares about the interval
 * between looks and not about landing on the hour, and because launchd runs a missed
 * `StartCalendarInterval` job immediately on wake, which would fire a burst of ticks against the
 * provider the moment the lid opens. `AbandonProcessGroup` is false so a hung tick cannot leave an
 * orphan holding the watch file, which is the one file this package requires a single writer for.
 */
export const LAUNCHD_HINT = `Save as ~/Library/LaunchAgents/com.example.sentinel-watch.plist, then:
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.sentinel-watch.plist

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.example.sentinel-watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>cd /path/to/your/repo && sentinel watch --tick</string>
  </array>
  <key>StartInterval</key>    <integer>900</integer>
  <key>RunAtLoad</key>        <false/>
  <key>AbandonProcessGroup</key> <false/>
  <key>StandardOutPath</key>  <string>/tmp/sentinel-watch.log</string>
  <key>StandardErrorPath</key><string>/tmp/sentinel-watch.err</string>
</dict>
</plist>`;

/**
 * GitHub Actions, for a watch that lives beside the code it protects.
 *
 * The three lines that matter and are easy to leave out. `concurrency` with
 * `cancel-in-progress: false` keeps two scheduled runs from writing the watch file at once, which is
 * the single failure mode this package cannot recover from. Committing the updated watch file is
 * what carries the accumulated wealth to the next run, since a fresh runner starts with nothing and
 * a watch that restarts its martingale every tick is the fixed-alpha test this package exists to
 * avoid. And a non-zero exit is allowed to fail the job only on 1, because 2 means the runner could
 * not reach the provider and that is an infrastructure alert rather than a regression.
 */
export const GITHUB_ACTIONS_HINT = `# .github/workflows/sentinel-watch.yml
name: sentinel watch
on:
  schedule:
    - cron: "*/15 * * * *"   # note: Actions delays and sometimes drops scheduled runs under load
  workflow_dispatch:
concurrency:
  group: sentinel-watch      # one writer for the watch file, always
  cancel-in-progress: false
jobs:
  tick:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # the updated watch file is the accumulated evidence and must be kept
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: tick
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          set +e
          sentinel watch --tick
          code=$?
          # 0 quiet, alarm or identity change. 1 confirmed drift. 2 could not look at all.
          if [ "$code" = "2" ]; then echo "::warning::the watcher could not reach the provider"; fi
          exit $([ "$code" = "1" ] && echo 1 || echo 0)
      - name: carry the wealth forward
        run: |
          git config user.name "sentinel"
          git config user.email "sentinel@users.noreply.github.com"
          git add watch.json && git diff --cached --quiet || git commit -m "watch tick"
          git push`;

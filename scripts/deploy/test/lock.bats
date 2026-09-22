#!/usr/bin/env bats
# take_lock: one holder at a time, a bounded wait, the lock released when its holder exits.

bats_require_minimum_version 1.5.0

setup() {
  load helper
  L=$BATS_TEST_TMPDIR/test.lock
}

@test "take_lock takes a free lock at once" {
  run take_lock "$L" 0 "a test holder"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "take_lock gives up with exit 1 when the lock is held longer than the timeout" {
  flock "$L" sleep 4 &
  sleep 0.5
  run take_lock "$L" 1 "a test holder"
  [ "$status" -eq 1 ]
  [[ $output == *"a test holder has held $L for 1s"* ]]
  wait
}

@test "take_lock waits for a holder that finishes in time" {
  flock "$L" sleep 2 &
  sleep 0.5
  run take_lock "$L" 10 "a test holder"
  [ "$status" -eq 0 ]
  [[ $output == *"waiting for a test holder"* ]]
  wait
}

@test "lock_held tells a held lock from a free one" {
  run lock_held "$BATS_TEST_TMPDIR/missing.lock"
  [ "$status" -eq 1 ]
  : >"$L"
  run lock_held "$L"
  [ "$status" -eq 1 ]
  flock "$L" sleep 3 &
  sleep 0.5
  run lock_held "$L"
  [ "$status" -eq 0 ]
  wait
}

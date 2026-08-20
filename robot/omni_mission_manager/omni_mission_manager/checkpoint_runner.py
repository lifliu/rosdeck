"""Checkpoint action runner (pure; injectable executors and clock).

Runs one checkpoint's actions in order on behalf of a mission:

* dwell      -> sleep the requested milliseconds (abort/pause aware);
                temporal only, produces no evidence record.
* photo      -> executor.photo(count)      (attempts with retry)
* record     -> executor.record(seconds)   (attempts with retry)
* recognize  -> executor.recognize(target) (attempts with retry)

Evidence actions are retried up to the checkpoint's `attempts`. When they
still fail, `spec.on_failure` decides: "fail" ends the checkpoint failed
(the node takes the mission to FAILED); "skip" writes a SKIPPED record and
continues with the next action.

The runner is pure: it knows nothing about ROS, services, or the mission
machine. The node injects:

* executors  -- photo/record/recognize callables returning CaptureOutcome;
  they block until the perception service answers or the node's
  interruptible wait gives up (see cancel_wait.wait_with_cancel).
* is_paused  -- callable -> bool; while paused the runner idles (without
  consuming dwell time or retries).
* should_abort -- callable -> bool; when it fires the remaining actions are
  recorded as SKIPPED ("mission interrupted") and the run stops.
* on_record  -- called with each completed evidence ActionRecord (the node
  persists it to SQLite and publishes CheckpointResult).

`time.sleep` / `time.monotonic` are injectable so tests are deterministic.
"""

import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional

from .checkpoints import (ACTION_DWELL, ACTION_PHOTO, ACTION_RECORD,
                          ACTION_RECOGNIZE, ActionSpec, CheckpointSpec)

# Mirror of CheckpointResult.msg STATUS_* (the node maps to the msg
# constants; keeping the values local keeps this module ROS-free).
STATUS_SUCCEEDED = 0
STATUS_FAILED = 1
STATUS_SKIPPED = 2


@dataclass(frozen=True)
class CaptureOutcome:
    """One perception service call's result (node-side)."""

    ok: bool
    reason: str = ""
    artifact_path: str = ""
    result_json: str = ""


@dataclass(frozen=True)
class ActionRecord:
    """One evidence action's outcome (dwell never produces one)."""

    action_type: str
    status: int            # STATUS_* above
    attempts: int          # tries actually used
    reason: str            # "" on success
    artifact_path: str
    result_json: str


@dataclass
class CheckpointOutcome:
    checkpoint_id: str
    records: List[ActionRecord] = field(default_factory=list)
    failed: bool = False
    fail_reason: str = ""
    aborted: bool = False


class CheckpointRunner:
    def __init__(self, executors, *, is_paused: Optional[Callable[[], bool]] = None,
                 should_abort: Optional[Callable[[], bool]] = None,
                 on_record: Optional[Callable[[ActionRecord], None]] = None,
                 sleep=time.sleep, now=time.monotonic, poll_sec=0.1):
        self._ex = executors
        self._is_paused = is_paused or (lambda: False)
        self._should_abort = should_abort or (lambda: False)
        self._on_record = on_record
        self._sleep = sleep
        self._now = now
        self._poll = poll_sec

    # -- public ------------------------------------------------------------

    def run(self, spec: CheckpointSpec) -> CheckpointOutcome:
        outcome = CheckpointOutcome(checkpoint_id=spec.id)
        pending = list(spec.actions)
        while pending:
            action = pending.pop(0)
            if self._should_abort():
                outcome.aborted = True
                for skipped in [action] + pending:
                    self._record(outcome, ActionRecord(
                        action_type=skipped.type, status=STATUS_SKIPPED,
                        attempts=0, reason="mission interrupted",
                        artifact_path="", result_json=""))
                break
            self._wait_until_resumed(outcome)
            if outcome.aborted:
                break
            if action.type == ACTION_DWELL:
                if self._dwell(action.value):
                    outcome.aborted = True
                    for skipped in pending:
                        self._record(outcome, ActionRecord(
                            action_type=skipped.type, status=STATUS_SKIPPED,
                            attempts=0, reason="mission interrupted",
                            artifact_path="", result_json=""))
                    break
                continue  # dwell done: no evidence record, next action
            record = self._run_evidence(spec, action, outcome)
            self._record(outcome, record)
            if record.status == STATUS_FAILED and \
                    spec.on_failure == "fail":
                outcome.failed = True
                outcome.fail_reason = "checkpoint action %s failed: %s" % (
                    action.type, record.reason)
                break
            # "skip" policy: the FAILED record is already written; continue.
        return outcome

    # -- internals ---------------------------------------------------------

    def _record(self, outcome: CheckpointOutcome, record: ActionRecord):
        outcome.records.append(record)
        if self._on_record is not None:
            self._on_record(record)

    def _wait_until_resumed(self, outcome: CheckpointOutcome):
        """Idle (without consuming time) until the mission is unpaused."""
        while self._is_paused():
            if self._should_abort():
                outcome.aborted = True
                return
            self._sleep(self._poll)

    def _dwell(self, ms) -> bool:
        """Sleep `ms` milliseconds in poll-sized chunks. True if aborted."""
        remaining = float(ms) / 1000.0
        while remaining > 0:
            if self._should_abort():
                return True
            if self._is_paused():
                # Paused: wait, but do not consume dwell time.
                self._sleep(self._poll)
                continue
            chunk = min(self._poll, remaining)
            self._sleep(chunk)
            remaining -= chunk
        return False

    def _run_evidence(self, spec: CheckpointSpec, action: ActionSpec,
                      outcome: CheckpointOutcome) -> ActionRecord:
        last_reason = "perception call failed"
        for attempt in range(1, spec.attempts + 1):
            if self._should_abort():
                outcome.aborted = True
                return ActionRecord(
                    action_type=action.type, status=STATUS_SKIPPED,
                    attempts=attempt - 1, reason="mission interrupted",
                    artifact_path="", result_json="")
            result = self._call(action)
            if result.ok:
                return ActionRecord(
                    action_type=action.type, status=STATUS_SUCCEEDED,
                    attempts=attempt, reason="",
                    artifact_path=result.artifact_path,
                    result_json=result.result_json)
            last_reason = result.reason or "perception call failed"
            if attempt < spec.attempts:
                self._wait_until_resumed(outcome)
        return ActionRecord(
            action_type=action.type, status=STATUS_FAILED,
            attempts=spec.attempts, reason=last_reason,
            artifact_path="", result_json="")

    def _call(self, action: ActionSpec) -> CaptureOutcome:
        if action.type == ACTION_PHOTO:
            return self._ex.photo(int(action.value))
        if action.type == ACTION_RECORD:
            return self._ex.record(action.value)
        if action.type == ACTION_RECOGNIZE:
            return self._ex.recognize(action.target)
        raise ValueError("unknown action type %r" % action.type)

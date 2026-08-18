"""Interruptible deadline wait (pure; mirrors omni_slam_manager.cancel_wait).

The perception services (/omni/capture/photo, /omni/capture/record,
/omni/recognize) are blocking calls on a camera bridge that may be slow or
stuck. The checkpoint worker must not block mission teardown: a cancel or
mission abort during the wait has to be acted on immediately, not after the
full timeout expires.

`wait_with_cancel` polls a done-future against a monotonic deadline and
returns as soon as any of:
  * the future completes      -> True
  * the deadline elapses      -> False
  * cancel_requested() -> True -> False   (caller distinguishes the reason)

`cancel_requested` is called once per poll. It must be a **callable
returning bool**, not a bool: passing the raw `goal_handle.is_cancel_requested`
value (a rclpy property) captures the state at call time and defeats the
whole point. The guard below also catches that exact mistake: `bool` is not
callable, so `cancel_requested()` raises TypeError -> we report it instead of
crashing the wait loop.
"""

import time


def wait_with_cancel(
    done,
    cancel_requested,
    timeout,
    *,
    poll_sec=0.1,
    sleep=time.sleep,
    now=time.monotonic,
):
    """Poll `done()` until it is true, the deadline hits, or cancel fires.

    Args:
      done: zero-arg callable -> bool. True when the awaited future/result
        is available.
      cancel_requested: zero-arg callable -> bool. True when the wait must
        stop early (cancel / mission abort). Passing a non-callable (e.g. a
        captured bool) is a programming error and is reported via TypeError.
      timeout: total deadline in seconds. 0 (or negative) means "cancel-only
        wait": no deadline; the wait ends on `done()` or cancel.
      poll_sec: polling interval; also the max wake-up latency.
      sleep / now: injectable for deterministic tests.

    Returns:
      True if `done()` went first; False on deadline or cancel.
    """
    if not callable(cancel_requested):
        raise TypeError(
            "cancel_requested must be a zero-arg callable returning bool, got "
            "%r" % type(cancel_requested).__name__
        )
    if timeout is None or timeout <= 0:
        deadline = None
    else:
        deadline = now() + timeout
    while not done():
        if cancel_requested():
            return False
        if deadline is not None and now() >= deadline:
            return False
        # Sleep only as far as the deadline so a tight timeout is honored.
        chunk = poll_sec
        if deadline is not None:
            remaining = deadline - now()
            if remaining > 0 and remaining < chunk:
                chunk = remaining
        if chunk > 0:
            sleep(chunk)
    return True
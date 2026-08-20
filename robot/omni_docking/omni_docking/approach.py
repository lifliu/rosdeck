"""Pure-pursuit docking servo (map frame, dock axes).

Both controllers are stateless-per-step pure functions of (dock pose,
robot pose) -> (linear.x, angular.z). The node feeds them the freshest
pose at 20 Hz and publishes the resulting Twist; the core owns
timeouts/cancellation.

Geometry (see dock_config.DockPose): the robot is docked at the dock
pose, facing the dock face (he = 0). The approach side is behind the
dock pose (e_x < 0); the standoff park point is
approach_distance back.

ApproachController (Dock): drive from the approach side (e_x < 0) to
the final docked pose, slowing inside the final band. The robot faces
the dock the whole way (no 180 deg flip at the face).

UndockController (Undock): hold the dock heading and back up along the
axis until the standoff clearance is cleared (behind the dock pose).
Backing up (negative linear.x) is the safe direction: a fault while
reversing only loses a few centimeters, and the dock face is the only
hard object in the clearance cone.
"""

import math

from .dock_config import _wrap_angle

DEFAULT_STANDOFF_SPEED = 0.15   # m/s outside the final band
DEFAULT_FINAL_SPEED = 0.05      # m/s inside the final band
DEFAULT_FINAL_BAND = 0.3        # m from the dock pose
DEFAULT_POS_TOL = 0.15          # m
DEFAULT_YAW_TOL = 0.25          # rad
DEFAULT_LOOK_AHEAD = 0.25       # m
DEFAULT_KP_POS = 1.0
DEFAULT_KP_YAW = 1.2
DEFAULT_MAX_ANGULAR = 0.35      # rad/s
ALIGN_THRESHOLD = 0.45          # rad; hold position until aligned


def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class ApproachTick:
    __slots__ = ("linear", "angular", "progress", "remaining", "done")

    def __init__(self, linear, angular, progress, remaining, done):
        self.linear = linear
        self.angular = angular
        self.progress = progress
        self.remaining = remaining
        self.done = done


class ApproachController:
    """Servo the robot onto the dock pose from the approach side."""

    def __init__(self, dock, pos_tolerance=DEFAULT_POS_TOL,
                 yaw_tolerance=DEFAULT_YAW_TOL, look_ahead=DEFAULT_LOOK_AHEAD,
                 standoff_speed=DEFAULT_STANDOFF_SPEED,
                 final_speed=DEFAULT_FINAL_SPEED,
                 final_band=DEFAULT_FINAL_BAND,
                 kp_pos=DEFAULT_KP_POS, kp_yaw=DEFAULT_KP_YAW,
                 max_angular=DEFAULT_MAX_ANGULAR):
        self.dock = dock
        self.pos_tolerance = float(pos_tolerance)
        self.yaw_tolerance = float(yaw_tolerance)
        self.look_ahead = float(look_ahead)
        self.standoff_speed = float(standoff_speed)
        self.final_speed = float(final_speed)
        self.final_band = float(final_band)
        self.kp_pos = float(kp_pos)
        self.kp_yaw = float(kp_yaw)
        self.max_angular = float(max_angular)
        self._initial_remaining = None

    def step(self, pose):
        """One servo tick. pose = (x, y, yaw) in the map frame."""
        e_x, e_y, he = self.dock.error(pose)
        remaining = math.hypot(e_x, e_y)
        if self._initial_remaining is None:
            self._initial_remaining = remaining
        progress = 1.0
        if self._initial_remaining > 1e-6:
            progress = _clamp(1.0 - remaining / self._initial_remaining, 0.0, 1.0)

        done = (abs(e_x) <= self.pos_tolerance
                and abs(e_y) <= self.pos_tolerance
                and abs(he) <= self.yaw_tolerance)
        if done:
            return ApproachTick(0.0, 0.0, 1.0, remaining, True)

        # Target point: a look-ahead point on the approach axis between
        # the robot and the dock pose (the dock pose itself once within
        # look_ahead). Expressed in the dock frame.
        t_x = min(e_x + self.look_ahead, 0.0) if e_x < 0.0 else 0.0
        t_y = 0.0
        # Desired heading in the dock frame: face the target point.
        desired = math.atan2(t_y - e_y, t_x - e_x)
        heading_err = _wrap_angle(desired - _wrap_angle(he))

        if abs(heading_err) > ALIGN_THRESHOLD:
            # Misaligned: rotate in place until within the cone, then
            # drive. (Never crab into the dock face.)
            angular = _clamp(self.kp_yaw * heading_err,
                             -self.max_angular, self.max_angular)
            return ApproachTick(0.0, angular, progress, remaining, False)

        if abs(e_x) < self.final_band:
            speed_cap = self.final_speed
        else:
            speed_cap = self.standoff_speed
        # Drive toward the target point; stop pressure vanishes at the
        # pose (a small deadband avoids chatter).
        gap = math.hypot(t_x - e_x, t_y - e_y)
        linear = _clamp(self.kp_pos * max(gap - 0.02, 0.0), 0.0, speed_cap)
        if abs(e_y) > 2.0 * self.pos_tolerance:
            # Lateral error still large: do not commit to the full speed
            # until the track is clean.
            linear = min(linear, 0.5 * speed_cap)
        angular = _clamp(self.kp_yaw * heading_err,
                         -self.max_angular, self.max_angular)
        return ApproachTick(linear, angular, progress, remaining, False)


class UndockTick:
    __slots__ = ("linear", "angular", "progress", "clearance", "done")

    def __init__(self, linear, angular, progress, clearance, done):
        self.linear = linear
        self.angular = angular
        self.progress = progress
        self.clearance = clearance
        self.done = done


class UndockController:
    """Back off the dock along the approach axis until the standoff
    clearance is cleared (at least approach_distance - margin behind
    the dock pose)."""

    def __init__(self, dock, yaw_tolerance=DEFAULT_YAW_TOL,
                 standoff_speed=DEFAULT_STANDOFF_SPEED,
                 kp_yaw=DEFAULT_KP_YAW, max_angular=DEFAULT_MAX_ANGULAR,
                 clearance_margin=0.05):
        self.dock = dock
        self.yaw_tolerance = float(yaw_tolerance)
        self.standoff_speed = float(standoff_speed)
        self.kp_yaw = float(kp_yaw)
        self.max_angular = float(max_angular)
        self.clearance_margin = float(clearance_margin)
        self._initial_clearance = None

    def step(self, pose):
        """One tick. Returns a negative linear.x (backing up).

        The docked pose sits at e_x = 0 (facing the dock); backing up
        drives e_x negative. Clearance is -e_x, the distance behind the
        dock pose.
        """
        e_x, _e_y, he = self.dock.error(pose)
        target = -(self.dock.approach_distance - self.clearance_margin)
        clearance = -e_x  # distance behind the dock pose (>= 0)
        if self._initial_clearance is None:
            self._initial_clearance = clearance
        span = max(-target - self._initial_clearance, 1e-6)
        progress = _clamp((clearance - self._initial_clearance) / span,
                          0.0, 1.0)

        if e_x <= target:
            return UndockTick(0.0, 0.0, 1.0, clearance, True)

        # Keep the robot square to the dock while reversing.
        heading_err = _wrap_angle(-he)  # zero when facing the dock
        if abs(heading_err) > ALIGN_THRESHOLD:
            angular = _clamp(self.kp_yaw * heading_err,
                             -self.max_angular, self.max_angular)
            return UndockTick(0.0, angular, progress, clearance, False)
        angular = _clamp(0.5 * self.kp_yaw * heading_err,
                         -self.max_angular, self.max_angular)
        return UndockTick(-self.standoff_speed, angular, progress,
                          clearance, False)

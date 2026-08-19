"""Freshness-gated BMS charge verification.

sensor_msgs/BatteryState has no explicit "charging" flag, so charging is
confirmed in priority order:

  1. power_supply_status (authoritative when the BMS reports a known
     state): CHARGING confirms; FULL counts as charge-confirmed (the
     battery is at capacity); DISCHARGING / NOT_CHARGING / EMPTY do not.
  2. current  > threshold  -> charging (the primary electrical signal)
  3. current invalid and power > 0 -> charging (fallback; note
     sensor_msgs/BatteryState carries no power field, so this only fires
     for feeds that supply it directly)

UNKNOWN status (0) falls through to the electrical inferences, so BMSes
that do not report a status behave exactly as before. "invalid" means
NaN or non-finite (some BMS drivers publish NaN for unsupported
channels). A sample only counts if it is fresh: ``verify()`` rejects
samples older than max_age_sec so a dead battery bus cannot confirm a
charge that never happened.
"""

import math

DEFAULT_MAX_AGE_SEC = 2.0
DEFAULT_CHARGE_CURRENT_A = 0.05  # |current| above this while signed = charging
DEFAULT_CHARGE_CURRENT_SIGN = 1.0
# sensor_msgs convention: current positive while charging. Some BMS
# drivers report the opposite; flip the sign parameter on the robot if
# VerifyCharge says "not charging" while the BMS shows a charge.

# sensor_msgs/msg/BatteryState.power_supply_status values.
STATUS_UNKNOWN = 0
STATUS_FULL = 1
STATUS_CHARGING = 2
STATUS_DISCHARGING = 3
STATUS_NOT_CHARGING = 4
STATUS_EMPTY = 5

# BMS states that settle the charge question on their own.
_STATUS_AUTHORITATIVE = (STATUS_FULL, STATUS_CHARGING, STATUS_DISCHARGING,
                         STATUS_NOT_CHARGING, STATUS_EMPTY)
_STATUS_NAMES = {
    STATUS_UNKNOWN: "unknown",
    STATUS_FULL: "full",
    STATUS_CHARGING: "charging",
    STATUS_DISCHARGING: "discharging",
    STATUS_NOT_CHARGING: "not_charging",
    STATUS_EMPTY: "empty",
}


def _status_name(status):
    return _STATUS_NAMES.get(int(status), "unknown")


class BatterySample:
    """One normalized /battery_state reading.

    stamp is the monotonic age baseline the node assigns (time.monotonic
    at reception); voltage/percentage/current/power are NaN when the
    BMS does not publish them; power_supply_status defaults to UNKNOWN.
    """

    __slots__ = ("voltage", "percentage", "current", "power",
                 "power_supply_status", "stamp")

    def __init__(self, voltage=math.nan, percentage=math.nan,
                 current=math.nan, power=math.nan,
                 power_supply_status=STATUS_UNKNOWN, stamp=0.0):
        self.voltage = float(voltage)
        self.percentage = float(percentage)
        self.current = float(current)
        self.power = float(power)
        self.power_supply_status = int(power_supply_status)
        self.stamp = float(stamp)

    def age_sec(self, now):
        return max(0.0, now - self.stamp)


class ChargeVerdict:
    __slots__ = ("ok", "charging", "age_sec", "message",
                 "voltage", "percentage", "current")

    def __init__(self, ok, charging, message, age_sec=math.nan,
                 voltage=math.nan, percentage=math.nan,
                 current=math.nan):
        self.ok = ok
        self.charging = charging
        self.message = message
        self.age_sec = age_sec
        self.voltage = voltage
        self.percentage = percentage
        self.current = current


class ChargeMonitor:
    """Holds the freshest BatteryState sample and answers verify()."""

    def __init__(self, charge_current_a=DEFAULT_CHARGE_CURRENT_A,
                 charge_current_sign=DEFAULT_CHARGE_CURRENT_SIGN):
        self.charge_current_a = float(charge_current_a)
        # Sign of the BMS current channel while charging (+1 per the
        # sensor_msgs convention, -1 if the driver reports negative).
        self.charge_current_sign = float(charge_current_sign)
        self._sample = None

    @property
    def sample(self):
        return self._sample

    def update(self, sample):
        """Store a fresh sample (the node calls this per /battery_state)."""
        self._sample = sample

    def clear(self):
        self._sample = None

    def verify(self, now, max_age_sec=0.0):
        """Charge verdict for the current moment.

        max_age_sec <= 0 uses the default window. ok=True means a fresh
        sample exists; charging is the inferred sign. When ok=False the
        verdict still carries the last-known values for diagnostics.
        """
        window = float(max_age_sec) if max_age_sec and max_age_sec > 0 \
            else DEFAULT_MAX_AGE_SEC
        s = self._sample
        if s is None:
            return ChargeVerdict(False, False, "no battery sample received")
        age = s.age_sec(now)
        if age > window:
            last = ChargeVerdict(False, False,
                                 "battery sample stale (age {:.2f}s)".format(age),
                                 age_sec=age, voltage=s.voltage,
                                 percentage=s.percentage, current=s.current)
            return last
        if s.power_supply_status in _STATUS_AUTHORITATIVE:
            # The BMS status is the authoritative electrical state: it
            # wins over the current/power sign inference. FULL counts as
            # charge-confirmed — the battery is at capacity, so the
            # docked-robot's reason to be on the dock is met.
            charging = s.power_supply_status in (STATUS_CHARGING, STATUS_FULL)
            basis = "status"
        elif not math.isnan(s.current) and math.isfinite(s.current):
            charging = (self.charge_current_sign * s.current
                        >= self.charge_current_a)
            basis = "current"
        elif not math.isnan(s.power) and math.isfinite(s.power):
            charging = s.power > 0.0
            basis = "power"
        else:
            charging = False
            basis = "unknown"
        if basis == "status":
            if s.power_supply_status == STATUS_FULL:
                message = "battery full per BMS status"
            elif charging:
                message = "charging per BMS status"
            else:
                message = "BMS status {}, not charging".format(
                    _status_name(s.power_supply_status))
        elif basis == "current":
            message = "charging via current ({:.3f} A)".format(s.current) \
                if charging else "current negative/zero, not charging"
        elif basis == "power":
            message = "charging via power ({:.3f} W)".format(s.power) \
                if charging else "power negative/zero, not charging"
        else:
            message = "current/power unavailable, charging unconfirmed"
        return ChargeVerdict(True, charging, message, age_sec=age,
                             voltage=s.voltage, percentage=s.percentage,
                             current=s.current)

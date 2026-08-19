"""Freshness-gated BMS charge verification.

sensor_msgs/BatteryState carries no explicit charging flag; charging is
inferred from the electrical signs the BMS publishes:

  current  > threshold  -> charging (the primary signal)
  current invalid and power > 0 -> charging (fallback)

"invalid" means NaN or non-finite (some BMS drivers publish NaN for
unsupported channels). A sample only counts if it is fresh:
``verify()`` rejects samples older than max_age_sec so a dead battery
bus cannot confirm a charge that never happened.
"""

import math

DEFAULT_MAX_AGE_SEC = 2.0
DEFAULT_CHARGE_CURRENT_A = 0.05  # |current| above this while signed = charging
DEFAULT_CHARGE_CURRENT_SIGN = 1.0
# sensor_msgs convention: current positive while charging. Some BMS
# drivers report the opposite; flip the sign parameter on the robot if
# VerifyCharge says "not charging" while the BMS shows a charge.


class BatterySample:
    """One normalized /battery_state reading.

    stamp is the monotonic age baseline the node assigns (time.monotonic
    at reception); voltage/percentage/current/power are NaN when the
    BMS does not publish them.
    """

    __slots__ = ("voltage", "percentage", "current", "power", "stamp")

    def __init__(self, voltage=math.nan, percentage=math.nan,
                 current=math.nan, power=math.nan, stamp=0.0):
        self.voltage = float(voltage)
        self.percentage = float(percentage)
        self.current = float(current)
        self.power = float(power)
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
        if not math.isnan(s.current) and math.isfinite(s.current):
            charging = (self.charge_current_sign * s.current
                        >= self.charge_current_a)
            basis = "current"
        elif not math.isnan(s.power) and math.isfinite(s.power):
            charging = s.power > 0.0
            basis = "power"
        else:
            charging = False
            basis = "unknown"
        message = "charging via {} ({:.3f} A)".format(
            basis, s.current) if basis == "current" else \
            "charging via {} ({:.3f} W)".format(
                basis, s.power) if basis == "power" else \
            "current/power unavailable, charging unconfirmed"
        if not charging and basis != "unknown":
            message = "{} negative/zero, not charging".format(basis)
        return ChargeVerdict(True, charging, message, age_sec=age,
                             voltage=s.voltage, percentage=s.percentage,
                             current=s.current)
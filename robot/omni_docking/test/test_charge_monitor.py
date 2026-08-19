"""charge_monitor tests — pure Python, no ROS required.

Run: python3 -m unittest discover -s test -v
"""

import math
import os
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_docking.charge_monitor import (  # noqa: E402
    BatterySample, ChargeMonitor, STATUS_CHARGING, STATUS_DISCHARGING,
    STATUS_EMPTY, STATUS_FULL, STATUS_NOT_CHARGING, STATUS_UNKNOWN)


class NoSampleTest(unittest.TestCase):
    def test_no_sample(self):
        v = ChargeMonitor().verify(now=1.0)
        self.assertFalse(v.ok)
        self.assertFalse(v.charging)
        self.assertIn("no battery sample", v.message)
        self.assertTrue(math.isnan(v.voltage))

    def test_clear(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=2.0, stamp=1.0))
        self.assertIsNotNone(m.sample)
        m.clear()
        self.assertIsNone(m.sample)
        self.assertFalse(m.verify(now=1.0).ok)


class FreshnessTest(unittest.TestCase):
    def _mon(self, **kw):
        return ChargeMonitor(**kw)

    def test_fresh_sample_ok(self):
        m = self._mon()
        m.update(BatterySample(current=2.0, stamp=10.0))
        v = m.verify(now=10.5)
        self.assertTrue(v.ok)
        self.assertAlmostEqual(v.age_sec, 0.5)

    def test_stale_sample_rejected(self):
        m = self._mon()
        m.update(BatterySample(current=2.0, stamp=10.0))
        v = m.verify(now=13.0)  # 3 s old > 2 s default window
        self.assertFalse(v.ok)
        self.assertFalse(v.charging)
        self.assertIn("stale", v.message)
        # last-known values still carried for diagnostics
        self.assertAlmostEqual(v.current, 2.0)
        self.assertAlmostEqual(v.age_sec, 3.0)

    def test_explicit_window(self):
        m = self._mon()
        m.update(BatterySample(current=2.0, stamp=10.0))
        # 0.6 s old: fresh under the 2 s default, stale under 0.5 s
        self.assertTrue(m.verify(now=10.6).ok)
        self.assertFalse(m.verify(now=10.6, max_age_sec=0.5).ok)
        self.assertTrue(m.verify(now=10.5, max_age_sec=0.5).ok)

    def test_zero_window_uses_default(self):
        m = self._mon()
        m.update(BatterySample(current=2.0, stamp=10.0))
        self.assertTrue(m.verify(now=11.0).ok)  # 1 s < 2 s default
        self.assertFalse(m.verify(now=13.0).ok)  # 3 s > 2 s default


class CurrentBasisTest(unittest.TestCase):
    def test_charging_positive_current(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=1.8, stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertTrue(v.charging)
        self.assertIn("current", v.message)

    def test_discharge_current_not_charging(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=-1.0, stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertFalse(v.charging)
        self.assertIn("not charging", v.message)

    def test_below_threshold_not_charging(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=0.01, stamp=0.0))
        self.assertFalse(m.verify(now=0.0).charging)

    def test_at_threshold_charging(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=0.05, stamp=0.0))
        self.assertTrue(m.verify(now=0.0).charging)

    def test_flipped_sign_convention(self):
        # BMS driver that reports negative current while charging
        m = ChargeMonitor(charge_current_sign=-1.0)
        m.update(BatterySample(current=-2.0, stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertTrue(v.charging)
        m.update(BatterySample(current=2.0, stamp=0.0))
        self.assertFalse(m.verify(now=0.0).charging)


class PowerFallbackTest(unittest.TestCase):
    def test_nan_current_falls_back_to_power(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=float("nan"), power=40.0,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertTrue(v.charging)
        self.assertIn("power", v.message)

    def test_nan_current_negative_power_not_charging(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=float("nan"), power=-12.0,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertFalse(v.charging)

    def test_current_takes_precedence_over_power(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=1.0, power=-99.0, stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.charging)
        self.assertIn("current", v.message)

    def test_inf_current_uses_power(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=float("inf"), power=30.0,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertTrue(v.charging)
        self.assertIn("power", v.message)

    def test_both_invalid(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=float("nan"),
                               power=float("nan"), stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)  # fresh sample exists
        self.assertFalse(v.charging)
        self.assertIn("unconfirmed", v.message)


class StatusBasisTest(unittest.TestCase):
    def test_charging_status_confirms(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=float("nan"),
                               power_supply_status=STATUS_CHARGING,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertTrue(v.charging)
        self.assertIn("status", v.message)

    def test_full_status_confirms_charge(self):
        # A full battery on the dock means the charge objective is met,
        # even though no current is flowing.
        m = ChargeMonitor()
        m.update(BatterySample(current=0.0,
                               power_supply_status=STATUS_FULL, stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertTrue(v.charging)
        self.assertIn("full", v.message)

    def test_discharging_status_not_charging(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=float("nan"),
                               power_supply_status=STATUS_DISCHARGING,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertFalse(v.charging)
        self.assertIn("not charging", v.message)

    def test_not_charging_and_empty_status(self):
        for status in (STATUS_NOT_CHARGING, STATUS_EMPTY):
            m = ChargeMonitor()
            m.update(BatterySample(power_supply_status=status, stamp=0.0))
            self.assertFalse(m.verify(now=0.0).charging)

    def test_unknown_status_falls_back_to_current(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=1.8,
                               power_supply_status=STATUS_UNKNOWN,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.charging)
        self.assertIn("current", v.message)

    def test_unknown_status_falls_back_to_power(self):
        m = ChargeMonitor()
        m.update(BatterySample(current=float("nan"), power=40.0,
                               power_supply_status=STATUS_UNKNOWN,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.charging)
        self.assertIn("power", v.message)

    def test_unknown_status_all_invalid_unconfirmed(self):
        m = ChargeMonitor()
        m.update(BatterySample(power_supply_status=STATUS_UNKNOWN,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.ok)
        self.assertFalse(v.charging)
        self.assertIn("unconfirmed", v.message)

    def test_status_overrides_conflicting_current(self):
        # BMS says CHARGING; the (flipped-sign) current would say
        # otherwise. The status is authoritative.
        m = ChargeMonitor(charge_current_sign=-1.0)
        m.update(BatterySample(current=2.0,
                               power_supply_status=STATUS_CHARGING,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.charging)
        self.assertIn("status", v.message)
        # And the reverse: DISCHARGING status beats a "charging" current.
        m.update(BatterySample(current=-2.0,
                               power_supply_status=STATUS_DISCHARGING,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertFalse(v.charging)
        self.assertIn("status", v.message)

    def test_garbage_status_falls_through(self):
        # A status value outside the enum is treated as unavailable,
        # not as "not charging" — the electrical inferences still apply.
        m = ChargeMonitor()
        m.update(BatterySample(current=1.8, power_supply_status=99,
                               stamp=0.0))
        v = m.verify(now=0.0)
        self.assertTrue(v.charging)
        self.assertIn("current", v.message)

    def test_stale_status_sample_rejected(self):
        m = ChargeMonitor()
        m.update(BatterySample(power_supply_status=STATUS_CHARGING,
                               stamp=10.0))
        v = m.verify(now=13.0)
        self.assertFalse(v.ok)
        self.assertFalse(v.charging)
        self.assertIn("stale", v.message)


class VerdictValuesTest(unittest.TestCase):
    def test_values_carried(self):
        m = ChargeMonitor()
        m.update(BatterySample(voltage=52.8, percentage=87.5, current=1.9,
                               power=100.0, stamp=0.0))
        v = m.verify(now=0.0)
        self.assertAlmostEqual(v.voltage, 52.8)
        self.assertAlmostEqual(v.percentage, 87.5)
        self.assertAlmostEqual(v.current, 1.9)


if __name__ == "__main__":
    unittest.main()
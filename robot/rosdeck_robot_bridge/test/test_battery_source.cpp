// Unit tests for the pure (no ROS, no vendor SDK) BMS helpers in
// battery_source.hpp: sysfs parsing (fail-closed), device auto-detection,
// SOC-trend charger inference and the merged publish-ready state.

#include "rosdeck_robot_bridge/battery_source.hpp"

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

namespace bridge = rosdeck_robot_bridge;
using bridge::BatteryMergedState;
using bridge::PowerSupplyHealth;
using bridge::PowerSupplyReading;
using bridge::PowerSupplyStatus;
using bridge::SocTrendCharger;

namespace
{

// One throwaway /sys/class/power_supply-style directory tree.
class SysfsRoot
{
public:
  SysfsRoot()
  {
    static int counter = 0;
    root_ = std::filesystem::temp_directory_path() /
      ("test_battery_source_" + std::to_string(counter++));
    std::filesystem::create_directories(root_);
  }

  ~SysfsRoot()
  {
    std::error_code ec;
    std::filesystem::remove_all(root_, ec);
  }

  SysfsRoot(const SysfsRoot &) = delete;
  SysfsRoot & operator=(const SysfsRoot &) = delete;

  const std::filesystem::path & root() const {return root_;}

  // Create (or reuse) one device directory and return its path.
  std::filesystem::path device(const std::string & name)
  {
    const auto dir = root_ / name;
    std::filesystem::create_directories(dir);
    return dir;
  }

  static void write(const std::filesystem::path & dir, const std::string & attr,
    const std::string & value)
  {
    std::ofstream out(dir / attr);
    out << value;
  }

private:
  std::filesystem::path root_;
};

void write_battery(
  const std::filesystem::path & dir,
  const std::string & type = "Battery",
  const std::string & present = "1",
  const std::string & voltage_now = "4190000",
  const std::string & current_now = "-1500000",
  const std::string & temp = "255",
  const std::string & capacity = "87",
  const std::string & status = "Discharging",
  const std::string & health = "Good")
{
  SysfsRoot::write(dir, "type", type);
  SysfsRoot::write(dir, "present", present);
  SysfsRoot::write(dir, "voltage_now", voltage_now);
  SysfsRoot::write(dir, "current_now", current_now);
  SysfsRoot::write(dir, "temp", temp);
  SysfsRoot::write(dir, "capacity", capacity);
  SysfsRoot::write(dir, "status", status);
  SysfsRoot::write(dir, "health", health);
}

}  // namespace

// --------------------------------------------------------------------- //
// parse_sysfs_double / read_sysfs_line
// --------------------------------------------------------------------- //

TEST(BatterySource, ParseSysfsDouble)
{
  const auto parse = bridge::parse_sysfs_double;

  ASSERT_TRUE(parse("4190000\n").has_value());
  EXPECT_DOUBLE_EQ(*parse("4190000\n"), 4190000.0);
  ASSERT_TRUE(parse(" 12.5 \t").has_value());
  EXPECT_DOUBLE_EQ(*parse(" 12.5 \t"), 12.5);
  ASSERT_TRUE(parse("-3.25").has_value());
  EXPECT_DOUBLE_EQ(*parse("-3.25"), -3.25);
  ASSERT_TRUE(parse("0").has_value());
  EXPECT_DOUBLE_EQ(*parse("0"), 0.0);

  // Fail-closed: no parse, no throw.
  EXPECT_FALSE(parse("").has_value());
  EXPECT_FALSE(parse("   \n").has_value());
  EXPECT_FALSE(parse("abc").has_value());
  EXPECT_FALSE(parse("12.5xyz").has_value());
  EXPECT_FALSE(parse("12.5 34").has_value());
  EXPECT_FALSE(parse("1e400").has_value());  // ERANGE overflow
  EXPECT_FALSE(parse("-1e400").has_value());
  EXPECT_FALSE(parse("inf").has_value());
  EXPECT_FALSE(parse("-inf").has_value());
  EXPECT_FALSE(parse("nan").has_value());
}

TEST(BatterySource, ReadSysfsLine)
{
  SysfsRoot fs;
  const auto dir = fs.device("dev");

  EXPECT_FALSE(bridge::read_sysfs_line(dir / "missing").has_value());

  SysfsRoot::write(dir, "value", "42\nsecond line\n");
  ASSERT_TRUE(bridge::read_sysfs_line(dir / "value").has_value());
  EXPECT_EQ(*bridge::read_sysfs_line(dir / "value"), "42");

  SysfsRoot::write(dir, "nonewline", "7");
  ASSERT_TRUE(bridge::read_sysfs_line(dir / "nonewline").has_value());
  EXPECT_EQ(*bridge::read_sysfs_line(dir / "nonewline"), "7");
}

// --------------------------------------------------------------------- //
// status / health mapping
// --------------------------------------------------------------------- //

TEST(BatterySource, MapStatus)
{
  using S = PowerSupplyStatus;
  // Kernel strings are title case; mapping is case/whitespace tolerant.
  EXPECT_EQ(bridge::map_power_supply_status("Charging"), S::charging);
  EXPECT_EQ(bridge::map_power_supply_status("  FULL \n"), S::full);
  EXPECT_EQ(bridge::map_power_supply_status("discharging"), S::discharging);
  EXPECT_EQ(bridge::map_power_supply_status("not charging"), S::not_charging);
  EXPECT_EQ(bridge::map_power_supply_status("not_charging"), S::not_charging);
  EXPECT_EQ(bridge::map_power_supply_status("Empty"), S::empty);
  EXPECT_EQ(bridge::map_power_supply_status("Unknown"), S::unknown);
  EXPECT_EQ(bridge::map_power_supply_status("bogus"), S::unknown);
  EXPECT_EQ(bridge::map_power_supply_status(""), S::unknown);
}

TEST(BatterySource, MapHealth)
{
  using H = PowerSupplyHealth;
  EXPECT_EQ(bridge::map_power_supply_health("Good"), H::good);
  // The kernel prints "Overheated"; some drivers emit the token form.
  EXPECT_EQ(bridge::map_power_supply_health("Overheated"), H::overheat);
  EXPECT_EQ(bridge::map_power_supply_health("overheat"), H::overheat);
  EXPECT_EQ(bridge::map_power_supply_health("Dead"), H::dead);
  EXPECT_EQ(bridge::map_power_supply_health("Overcharged"), H::overcharged);
  EXPECT_EQ(bridge::map_power_supply_health("Not full"), H::not_full);
  EXPECT_EQ(bridge::map_power_supply_health("not_full"), H::not_full);
  EXPECT_EQ(bridge::map_power_supply_health("Cold"), H::cold);
  EXPECT_EQ(bridge::map_power_supply_health("Failure"), H::failure);
  EXPECT_EQ(
    bridge::map_power_supply_health("Unsupported chemistry"),
    H::unsupported_chemistry);
  EXPECT_EQ(bridge::map_power_supply_health("Stale"), H::stale);
  EXPECT_EQ(bridge::map_power_supply_health("bogus"), H::unknown);
  EXPECT_EQ(bridge::map_power_supply_health(""), H::unknown);
}

TEST(BatterySource, StatusHealthNames)
{
  EXPECT_STREQ(bridge::power_supply_status_name(PowerSupplyStatus::charging),
    "charging");
  EXPECT_STREQ(bridge::power_supply_status_name(PowerSupplyStatus::unknown),
    "unknown");
  EXPECT_STREQ(bridge::power_supply_health_name(PowerSupplyHealth::not_full),
    "not_full");
  EXPECT_STREQ(bridge::power_supply_health_name(PowerSupplyHealth::unknown),
    "unknown");
}

// --------------------------------------------------------------------- //
// read_power_supply
// --------------------------------------------------------------------- //

TEST(BatterySource, ReadPowerSupplyFull)
{
  SysfsRoot fs;
  const auto dir = fs.device("battery0");
  write_battery(dir);

  const auto r = bridge::read_power_supply(fs.root(), "battery0");
  EXPECT_TRUE(r.present_known);
  EXPECT_TRUE(r.present);
  EXPECT_TRUE(r.type_known);
  EXPECT_EQ(r.type, "Battery");
  // Sysfs units: microvolts -> volts, microamperes -> amps, 0.1 C -> C.
  ASSERT_TRUE(r.voltage_v.has_value());
  EXPECT_DOUBLE_EQ(*r.voltage_v, 4.19);
  ASSERT_TRUE(r.current_a.has_value());
  EXPECT_DOUBLE_EQ(*r.current_a, -1.5);
  ASSERT_TRUE(r.temperature_c.has_value());
  EXPECT_DOUBLE_EQ(*r.temperature_c, 25.5);
  ASSERT_TRUE(r.capacity_percent.has_value());
  EXPECT_DOUBLE_EQ(*r.capacity_percent, 87.0);
  ASSERT_TRUE(r.status.has_value());
  EXPECT_EQ(*r.status, PowerSupplyStatus::discharging);
  ASSERT_TRUE(r.health.has_value());
  EXPECT_EQ(*r.health, PowerSupplyHealth::good);
}

TEST(BatterySource, ReadPowerSupplyAbsent)
{
  SysfsRoot fs;

  // Missing device directory: everything unknown, nothing thrown.
  const auto missing = bridge::read_power_supply(fs.root(), "nope");
  EXPECT_FALSE(missing.present_known);
  EXPECT_FALSE(missing.type_known);
  EXPECT_FALSE(missing.voltage_v.has_value());
  EXPECT_FALSE(missing.current_a.has_value());
  EXPECT_FALSE(missing.temperature_c.has_value());
  EXPECT_FALSE(missing.capacity_percent.has_value());
  EXPECT_FALSE(missing.status.has_value());
  EXPECT_FALSE(missing.health.has_value());

  // Empty device name is a no-op.
  const auto empty = bridge::read_power_supply(fs.root(), "");
  EXPECT_FALSE(empty.present_known);
  EXPECT_FALSE(empty.voltage_v.has_value());
}

TEST(BatterySource, ReadPowerSupplyPartial)
{
  SysfsRoot fs;

  // present=0 is a known-absent battery, distinct from a missing file.
  {
    const auto dir = fs.device("out");
    SysfsRoot::write(dir, "type", "Battery");
    SysfsRoot::write(dir, "present", "0");
    const auto r = bridge::read_power_supply(fs.root(), "out");
    EXPECT_TRUE(r.present_known);
    EXPECT_FALSE(r.present);
    EXPECT_FALSE(r.voltage_v.has_value());
  }

  // Garbage attributes degrade to nullopt; clean attributes still parse.
  {
    const auto dir = fs.device("dirty");
    write_battery(dir, "Battery", "1", "N/A", "-1500000", "2000", "101",
      "Unknown", "???");
    const auto r = bridge::read_power_supply(fs.root(), "dirty");
    EXPECT_FALSE(r.voltage_v.has_value());  // "N/A" is not a number
    EXPECT_FALSE(r.temperature_c.has_value());  // 200.0 C is out of [-50,150]
    EXPECT_FALSE(r.capacity_percent.has_value());  // 101 is out of [0,100]
    EXPECT_FALSE(r.status.has_value());  // unmapped status stays absent
    EXPECT_FALSE(r.health.has_value());
    ASSERT_TRUE(r.current_a.has_value());  // clean sibling attribute survives
    EXPECT_DOUBLE_EQ(*r.current_a, -1.5);
  }

  // Negative capacity is out of range.
  {
    const auto dir = fs.device("negcap");
    write_battery(dir, "Battery", "1", "4190000", "-1500000", "255", "-1");
    const auto r = bridge::read_power_supply(fs.root(), "negcap");
    EXPECT_FALSE(r.capacity_percent.has_value());
  }

  // A temperature at the sanity boundary is accepted.
  {
    const auto dir = fs.device("cold");
    write_battery(dir, "Battery", "1", "4190000", "-1500000", "-500");  // -50.0 C
    const auto r = bridge::read_power_supply(fs.root(), "cold");
    ASSERT_TRUE(r.temperature_c.has_value());
    EXPECT_DOUBLE_EQ(*r.temperature_c, -50.0);
  }
}

// --------------------------------------------------------------------- //
// find_power_supply_device
// --------------------------------------------------------------------- //

TEST(BatterySource, FindDevicePrefersVoltage)
{
  SysfsRoot fs;
  // One battery with the full electrical set, one capacity-only battery.
  write_battery(fs.device("bat_full"));
  const auto dir = fs.device("bat_cap");
  SysfsRoot::write(dir, "type", "Battery");
  SysfsRoot::write(dir, "capacity", "50");
  // A non-battery that also has voltage_now must be ignored.
  const auto ac = fs.device("ac");
  SysfsRoot::write(ac, "type", "Mains");
  SysfsRoot::write(ac, "voltage_now", "12000000");

  EXPECT_EQ(bridge::find_power_supply_device(fs.root()), "bat_full");
}

TEST(BatterySource, FindDevicePrefersCapacityOverBare)
{
  SysfsRoot fs;
  const auto cap = fs.device("bat_cap");
  SysfsRoot::write(cap, "type", "Battery");
  SysfsRoot::write(cap, "capacity", "50");
  const auto bare = fs.device("bat_bare");
  SysfsRoot::write(bare, "type", "Battery");

  EXPECT_EQ(bridge::find_power_supply_device(fs.root()), "bat_cap");
}

TEST(BatterySource, FindDeviceNone)
{
  SysfsRoot fs;
  // Only non-battery devices.
  const auto ac = fs.device("ac");
  SysfsRoot::write(ac, "type", "Mains");
  // A plain file named like a battery is skipped.
  SysfsRoot::write(fs.root(), "battery0", "Battery");

  EXPECT_EQ(bridge::find_power_supply_device(fs.root()), "");
  EXPECT_EQ(bridge::find_power_supply_device(fs.root() / "missing"), "");
  EXPECT_EQ(bridge::find_power_supply_device(""), "");
}

// --------------------------------------------------------------------- //
// SocTrendCharger
// --------------------------------------------------------------------- //

TEST(BatterySource, SocTrendInsufficientHistory)
{
  SocTrendCharger trend;  // 30 s window, 1.0 % min delta
  const SocTrendCharger::TimePoint t0{};

  EXPECT_FALSE(trend.status().has_value());
  EXPECT_EQ(trend.point_count(), 0u);

  trend.update(50.0, t0);
  EXPECT_EQ(trend.point_count(), 1u);
  EXPECT_FALSE(trend.status().has_value());  // one point: nothing to compare

  // NaN samples and same-or-older timestamps do not add history.
  trend.update(std::nan(""), t0 + std::chrono::seconds(5));
  trend.update(55.0, t0);
  EXPECT_EQ(trend.point_count(), 1u);

  // A newer sample is accepted (re-feeding the same 10 s SDK sample on
  // every 1 s tick only appends once the sample timestamp advances).
  trend.update(55.0, t0 + std::chrono::seconds(5));
  trend.update(55.0, t0 + std::chrono::seconds(5));
  EXPECT_EQ(trend.point_count(), 2u);

  trend.update(55.0, t0 + std::chrono::seconds(10));
  EXPECT_EQ(trend.point_count(), 3u);
}

TEST(BatterySource, SocTrendDirection)
{
  SocTrendCharger trend;
  const SocTrendCharger::TimePoint t0{};

  // A rise of at least min_delta over a full window -> charging.
  trend.update(50.0, t0);
  trend.update(55.0, t0 + std::chrono::seconds(30));
  ASSERT_TRUE(trend.status().has_value());
  EXPECT_EQ(*trend.status(), PowerSupplyStatus::charging);

  // Re-run for discharging with a fresh instance.
  SocTrendCharger falling;
  falling.update(55.0, t0);
  falling.update(50.0, t0 + std::chrono::seconds(30));
  ASSERT_TRUE(falling.status().has_value());
  EXPECT_EQ(*falling.status(), PowerSupplyStatus::discharging);

  // Flat within the min-delta dead band -> not_charging.
  SocTrendCharger flat;
  flat.update(50.0, t0);
  flat.update(50.0, t0 + std::chrono::seconds(40));
  ASSERT_TRUE(flat.status().has_value());
  EXPECT_EQ(*flat.status(), PowerSupplyStatus::not_charging);

  // A sub-threshold rise (0.5 % < 1.0 %) is still flat.
  SocTrendCharger tiny;
  tiny.update(50.0, t0);
  tiny.update(50.5, t0 + std::chrono::seconds(40));
  ASSERT_TRUE(tiny.status().has_value());
  EXPECT_EQ(*tiny.status(), PowerSupplyStatus::not_charging);
}

TEST(BatterySource, SocTrendSpanGuards)
{
  const SocTrendCharger::TimePoint t0{};

  // Span shorter than the window: not enough history yet.
  {
    SocTrendCharger trend;
    trend.update(50.0, t0);
    trend.update(55.0, t0 + std::chrono::seconds(10));
    EXPECT_FALSE(trend.status().has_value());
  }

  // Span beyond 2x the window: the anchor fell out of range (long sample
  // gap after a bridge restart), refuse to guess.
  {
    SocTrendCharger trend;
    trend.update(50.0, t0);
    trend.update(55.0, t0 + std::chrono::seconds(70));
    EXPECT_FALSE(trend.status().has_value());
  }

  // A span of exactly 2x the window is still usable.
  {
    SocTrendCharger trend;
    trend.update(50.0, t0);
    trend.update(55.0, t0 + std::chrono::seconds(60));
    ASSERT_TRUE(trend.status().has_value());
    EXPECT_EQ(*trend.status(), PowerSupplyStatus::charging);
  }
}

TEST(BatterySource, SocTrendPrunesAndResets)
{
  SocTrendCharger trend;
  const SocTrendCharger::TimePoint t0{};
  // Five samples at 20 s spacing: pruning keeps the anchor plus the points
  // within one window of the newest, so the anchor slides forward.
  trend.update(50.0, t0);
  trend.update(51.0, t0 + std::chrono::seconds(20));
  trend.update(52.0, t0 + std::chrono::seconds(40));
  trend.update(53.0, t0 + std::chrono::seconds(60));
  trend.update(54.0, t0 + std::chrono::seconds(80));
  EXPECT_EQ(trend.point_count(), 3u);
  // Newest 54.0 vs retained anchor 52.0 (t0+40 s): 2 % rise over 40 s.
  ASSERT_TRUE(trend.status().has_value());
  EXPECT_EQ(*trend.status(), PowerSupplyStatus::charging);

  trend.reset();
  EXPECT_EQ(trend.point_count(), 0u);
  EXPECT_FALSE(trend.status().has_value());
}

// --------------------------------------------------------------------- //
// merge_battery_state
// --------------------------------------------------------------------- //

TEST(BatterySource, MergePercentage)
{
  // SDK sample is primary, sysfs capacity is the fallback.
  {
    PowerSupplyReading ps;
    ps.capacity_percent = 99.0;
    const auto m = bridge::merge_battery_state(
      true, 0.42, ps, std::nullopt, 1.0, 0.05);
    ASSERT_TRUE(m.percentage_known);
    EXPECT_FLOAT_EQ(m.percentage, 42.0F);
  }
  {
    PowerSupplyReading ps;
    ps.capacity_percent = 99.0;
    const auto m = bridge::merge_battery_state(
      false, 0.42, ps, std::nullopt, 1.0, 0.05);
    ASSERT_TRUE(m.percentage_known);
    EXPECT_FLOAT_EQ(m.percentage, 99.0F);
  }
  // No source at all -> unknown (published as NaN downstream).
  {
    const auto m = bridge::merge_battery_state(
      false, 0.0, {}, std::nullopt, 1.0, 0.05);
    EXPECT_FALSE(m.percentage_known);
  }
  // Out-of-range SDK fractions are clamped, never published raw.
  {
    const auto m = bridge::merge_battery_state(
      true, 1.2, {}, std::nullopt, 1.0, 0.05);
    ASSERT_TRUE(m.percentage_known);
    EXPECT_FLOAT_EQ(m.percentage, 100.0F);
  }
  {
    const auto m = bridge::merge_battery_state(
      true, -0.2, {}, std::nullopt, 1.0, 0.05);
    ASSERT_TRUE(m.percentage_known);
    EXPECT_FLOAT_EQ(m.percentage, 0.0F);
  }
  // A non-finite SDK sample is ignored in favour of sysfs.
  {
    PowerSupplyReading ps;
    ps.capacity_percent = 41.0;
    const auto m = bridge::merge_battery_state(
      true, std::nan(""), ps, std::nullopt, 1.0, 0.05);
    ASSERT_TRUE(m.percentage_known);
    EXPECT_FLOAT_EQ(m.percentage, 41.0F);
  }
}

TEST(BatterySource, MergeElectrical)
{
  PowerSupplyReading ps;
  ps.voltage_v = 12.34;
  ps.current_a = -1.5;  // raw driver sign
  ps.temperature_c = 26.0;
  ps.present_known = true;
  ps.present = false;
  ps.health = PowerSupplyHealth::good;

  // current_sign = +1 passes the driver sign through.
  const auto m = bridge::merge_battery_state(
    false, 0.0, ps, std::nullopt, 1.0, 0.05);
  ASSERT_TRUE(m.voltage_known);
  EXPECT_FLOAT_EQ(m.voltage, 12.34F);
  ASSERT_TRUE(m.current_known);
  EXPECT_FLOAT_EQ(m.current, -1.5F);
  ASSERT_TRUE(m.temperature_known);
  EXPECT_FLOAT_EQ(m.temperature, 26.0F);
  EXPECT_TRUE(m.present_known);
  EXPECT_FALSE(m.present);
  ASSERT_TRUE(m.health_known);
  EXPECT_EQ(m.health, PowerSupplyHealth::good);

  // current_sign = -1 flips a driver that reports positive while
  // discharging into the sensor_msgs convention.
  const auto flipped = bridge::merge_battery_state(
    false, 0.0, ps, std::nullopt, -1.0, 0.05);
  ASSERT_TRUE(flipped.current_known);
  EXPECT_FLOAT_EQ(flipped.current, 1.5F);

  // Nothing read -> nothing known.
  const auto empty = bridge::merge_battery_state(
    false, 0.0, {}, std::nullopt, 1.0, 0.05);
  EXPECT_FALSE(empty.voltage_known);
  EXPECT_FALSE(empty.current_known);
  EXPECT_FALSE(empty.temperature_known);
  EXPECT_FALSE(empty.present_known);
  EXPECT_FALSE(empty.health_known);
}

TEST(BatterySource, MergeStatusPriority)
{
  // sysfs status is authoritative even when a trend is available.
  {
    PowerSupplyReading ps;
    ps.status = PowerSupplyStatus::full;
    const auto m = bridge::merge_battery_state(
      false, 0.0, ps, PowerSupplyStatus::discharging, 1.0, 0.05);
    ASSERT_TRUE(m.status_known);
    EXPECT_EQ(m.status, PowerSupplyStatus::full);
    EXPECT_EQ(m.status_source, "sysfs");
  }

  // No sysfs status: the SOC trend fills in.
  {
    const auto m = bridge::merge_battery_state(
      false, 0.0, {}, PowerSupplyStatus::charging, 1.0, 0.05);
    ASSERT_TRUE(m.status_known);
    EXPECT_EQ(m.status, PowerSupplyStatus::charging);
    EXPECT_EQ(m.status_source, "soc_trend");
  }

  // No sysfs status and an unknown trend -> no status at all.
  {
    const auto m = bridge::merge_battery_state(
      false, 0.0, {}, PowerSupplyStatus::unknown, 1.0, 0.05);
    EXPECT_FALSE(m.status_known);
    EXPECT_EQ(m.status_source, "none");
    EXPECT_EQ(m.status, PowerSupplyStatus::unknown);
  }
  {
    const auto m = bridge::merge_battery_state(
      false, 0.0, {}, std::nullopt, 1.0, 0.05);
    EXPECT_FALSE(m.status_known);
    EXPECT_EQ(m.status_source, "none");
  }
}

TEST(BatterySource, MergeChargerAndCharging)
{
  // charger_connected is derived: the status must imply an attached charger.
  for (const auto status : {PowerSupplyStatus::charging,
           PowerSupplyStatus::full, PowerSupplyStatus::not_charging})
  {
    PowerSupplyReading ps;
    ps.status = status;
    const auto m = bridge::merge_battery_state(
      false, 0.0, ps, std::nullopt, 1.0, 0.05);
    EXPECT_TRUE(m.charger_connected) << bridge::power_supply_status_name(status);
  }
  for (const auto status : {PowerSupplyStatus::discharging,
           PowerSupplyStatus::empty, PowerSupplyStatus::unknown})
  {
    PowerSupplyReading ps;
    ps.status = status;
    const auto m = bridge::merge_battery_state(
      false, 0.0, ps, std::nullopt, 1.0, 0.05);
    EXPECT_FALSE(m.charger_connected) << bridge::power_supply_status_name(status);
  }

  // Charging with a known status: the status is authoritative (FULL is not
  // "charging" even if a charger is attached).
  {
    PowerSupplyReading ps;
    ps.status = PowerSupplyStatus::full;
    const auto m = bridge::merge_battery_state(
      false, 0.0, ps, std::nullopt, 1.0, 0.05);
    EXPECT_FALSE(m.charging);
  }
  {
    PowerSupplyReading ps;
    ps.status = PowerSupplyStatus::charging;
    const auto m = bridge::merge_battery_state(
      false, 0.0, ps, std::nullopt, 1.0, 0.05);
    EXPECT_TRUE(m.charging);
  }
  {
    PowerSupplyReading ps;
    ps.status = PowerSupplyStatus::discharging;
    // A big positive current must not override the authoritative status.
    ps.current_a = 5.0;
    const auto m = bridge::merge_battery_state(
      false, 0.0, ps, std::nullopt, 1.0, 0.05);
    EXPECT_FALSE(m.charging);
  }

  // No status: the signed-current threshold is the fallback.
  {
    PowerSupplyReading ps;
    ps.current_a = 0.1;  // above the 0.05 A threshold
    const auto m = bridge::merge_battery_state(
      false, 0.0, ps, std::nullopt, 1.0, 0.05);
    EXPECT_TRUE(m.charging);
  }
  {
    PowerSupplyReading ps;
    ps.current_a = 0.03;  // below the threshold: trickling / float charge
    const auto m = bridge::merge_battery_state(
      false, 0.0, ps, std::nullopt, 1.0, 0.05);
    EXPECT_FALSE(m.charging);
  }
  {
    PowerSupplyReading ps;
    ps.current_a = -2.0;  // discharging
    const auto m = bridge::merge_battery_state(
      false, 0.0, ps, std::nullopt, 1.0, 0.05);
    EXPECT_FALSE(m.charging);
  }
  {
    // No status, no current: fail closed.
    const auto m = bridge::merge_battery_state(
      false, 0.0, {}, std::nullopt, 1.0, 0.05);
    EXPECT_FALSE(m.charging);
  }
}
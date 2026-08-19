#pragma once

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace rosdeck_robot_bridge
{

/**
 * Pure (no ROS, no vendor SDK) source for the real BMS signals the Phase 0
 * adapter does not expose: voltage, current, temperature, physical presence,
 * power-supply status and health.
 *
 * The vendor SDK only reports SOC (``getBatteryPower``), so the electrical
 * fields of ``sensor_msgs/msg/BatteryState`` and the ``RobotState`` charging
 * bit have to come from somewhere else. On the robot the BMS is exposed by the
 * Linux power-supply class under ``/sys/class/power_supply/<device>/``. This
 * module reads that directory fail-closed: a missing or unparsable attribute
 * yields ``std::nullopt`` (reported downstream as NaN / UNKNOWN), it never
 * throws, and an absent BMS degrades the bridge back to SOC-only behavior.
 *
 * When no power-supply device is available at all, the charging *direction*
 * is still recoverable from the SDK SOC alone: :class:`SocTrendCharger`
 * infers CHARGING / DISCHARGING from the net SOC movement over a sliding
 * window. That is a diagnostic fallback, not a control signal.
 */

// Mirrors sensor_msgs::msg::BatteryState::POWER_SUPPLY_STATUS_*. The numeric
// values must stay in lockstep with the message definition; bridge_node.cpp
// casts the enum straight into the message field.
enum class PowerSupplyStatus : uint8_t
{
  unknown = 0,
  full = 1,
  charging = 2,
  discharging = 3,
  not_charging = 4,
  empty = 5,
};

// Mirrors sensor_msgs::msg::BatteryState::POWER_SUPPLY_HEALTH_*.
enum class PowerSupplyHealth : uint8_t
{
  unknown = 0,
  good = 1,
  overheat = 2,
  dead = 3,
  overcharged = 4,
  not_full = 5,
  cold = 6,
  failure = 7,
  unsupported_chemistry = 8,
  stale = 9,
};

inline const char * power_supply_status_name(PowerSupplyStatus status)
{
  switch (status) {
    case PowerSupplyStatus::full: return "full";
    case PowerSupplyStatus::charging: return "charging";
    case PowerSupplyStatus::discharging: return "discharging";
    case PowerSupplyStatus::not_charging: return "not_charging";
    case PowerSupplyStatus::empty: return "empty";
    case PowerSupplyStatus::unknown:
    default: return "unknown";
  }
}

inline const char * power_supply_health_name(PowerSupplyHealth health)
{
  switch (health) {
    case PowerSupplyHealth::good: return "good";
    case PowerSupplyHealth::overheat: return "overheat";
    case PowerSupplyHealth::dead: return "dead";
    case PowerSupplyHealth::overcharged: return "overcharged";
    case PowerSupplyHealth::not_full: return "not_full";
    case PowerSupplyHealth::cold: return "cold";
    case PowerSupplyHealth::failure: return "failure";
    case PowerSupplyHealth::unsupported_chemistry: return "unsupported_chemistry";
    case PowerSupplyHealth::stale: return "stale";
    case PowerSupplyHealth::unknown:
    default: return "unknown";
  }
}

/**
 * One fail-closed read of a ``/sys/class/power_supply/<device>`` directory.
 * Every field that could not be read or parsed stays ``std::nullopt`` (or,
 * for the presence flag, ``present_known == false``).
 */
struct PowerSupplyReading
{
  bool present_known{false};
  bool present{false};
  bool type_known{false};
  std::string type;  // "Battery" | "Mains" | "USB" | ...

  std::optional<double> voltage_v;        // volts
  std::optional<double> current_a;        // amps, raw driver sign
  std::optional<double> temperature_c;    // celsius
  std::optional<double> capacity_percent; // 0..100
  std::optional<PowerSupplyStatus> status;
  std::optional<PowerSupplyHealth> health;
};

inline std::string trim_string(std::string value)
{
  const char * whitespace = " \t\r\n";
  const auto begin = value.find_first_not_of(whitespace);
  if (begin == std::string::npos) {
    return "";
  }
  const auto end = value.find_last_not_of(whitespace);
  return value.substr(begin, end - begin + 1);
}

inline std::string to_lower_string(std::string value)
{
  for (char & character : value) {
    character = static_cast<char>(
      std::tolower(static_cast<unsigned char>(character)));
  }
  return value;
}

/** Parse a sysfs numeric attribute. Fail-closed: empty, partial, non-finite
 * or range-overflowing input returns ``std::nullopt`` rather than throwing. */
inline std::optional<double> parse_sysfs_double(const std::string & text)
{
  const auto token = trim_string(text);
  if (token.empty()) {
    return std::nullopt;
  }
  errno = 0;
  char * parse_end = nullptr;
  const double value = std::strtod(token.c_str(), &parse_end);
  if (parse_end == token.c_str() || *parse_end != '\0') {
    return std::nullopt;
  }
  if (errno == ERANGE || !std::isfinite(value)) {
    return std::nullopt;
  }
  return value;
}

inline std::optional<std::string> read_sysfs_line(const std::filesystem::path & path)
{
  std::ifstream input(path);
  if (!input) {
    return std::nullopt;
  }
  std::string line;
  std::getline(input, line);
  return line;
}

inline PowerSupplyStatus map_power_supply_status(const std::string & status)
{
  const auto normalized = to_lower_string(trim_string(status));
  if (normalized == "full") {
    return PowerSupplyStatus::full;
  }
  if (normalized == "charging") {
    return PowerSupplyStatus::charging;
  }
  if (normalized == "discharging") {
    return PowerSupplyStatus::discharging;
  }
  if (normalized == "not charging" || normalized == "not_charging") {
    return PowerSupplyStatus::not_charging;
  }
  if (normalized == "empty") {
    return PowerSupplyStatus::empty;
  }
  return PowerSupplyStatus::unknown;
}

inline PowerSupplyHealth map_power_supply_health(const std::string & health)
{
  const auto normalized = to_lower_string(trim_string(health));
  if (normalized == "good") {
    return PowerSupplyHealth::good;
  }
  // The kernel power_supply class prints "Overheated"; some drivers emit the
  // token form. Accept both.
  if (normalized == "overheat" || normalized == "overheated") {
    return PowerSupplyHealth::overheat;
  }
  if (normalized == "dead") {
    return PowerSupplyHealth::dead;
  }
  if (normalized == "overcharged") {
    return PowerSupplyHealth::overcharged;
  }
  if (normalized == "not full" || normalized == "not_full") {
    return PowerSupplyHealth::not_full;
  }
  if (normalized == "cold") {
    return PowerSupplyHealth::cold;
  }
  if (normalized == "failure") {
    return PowerSupplyHealth::failure;
  }
  if (normalized == "unsupported chemistry") {
    return PowerSupplyHealth::unsupported_chemistry;
  }
  if (normalized == "stale") {
    return PowerSupplyHealth::stale;
  }
  return PowerSupplyHealth::unknown;
}

/**
 * Read one power-supply device directory fail-closed.
 *
 * Attribute units follow the Linux power-supply class: ``voltage_now`` is
 * microvolts, ``current_now`` is microamperes (driver sign, not yet the
 * sensor_msgs convention) and ``temp`` is 0.1 degrees Celsius. Out-of-sanity
 * ranges are treated as absent rather than published.
 */
inline PowerSupplyReading read_power_supply(
  const std::filesystem::path & root, const std::string & device)
{
  PowerSupplyReading reading;
  if (device.empty()) {
    return reading;
  }
  const std::filesystem::path directory = root / device;
  std::error_code ec;
  if (!std::filesystem::is_directory(directory, ec) || ec) {
    return reading;
  }

  if (const auto text = read_sysfs_line(directory / "present")) {
    const auto token = trim_string(*text);
    if (token == "1") {
      reading.present_known = true;
      reading.present = true;
    } else if (token == "0") {
      reading.present_known = true;
      reading.present = false;
    }
  }
  if (const auto text = read_sysfs_line(directory / "type")) {
    const auto token = trim_string(*text);
    if (!token.empty()) {
      reading.type_known = true;
      reading.type = token;
    }
  }
  if (const auto text = read_sysfs_line(directory / "voltage_now")) {
    if (const auto raw = parse_sysfs_double(*text)) {
      reading.voltage_v = *raw / 1000000.0;
    }
  }
  if (const auto text = read_sysfs_line(directory / "current_now")) {
    if (const auto raw = parse_sysfs_double(*text)) {
      reading.current_a = *raw / 1000000.0;
    }
  }
  if (const auto text = read_sysfs_line(directory / "temp")) {
    if (const auto raw = parse_sysfs_double(*text)) {
      const double celsius = *raw / 10.0;
      if (celsius >= -50.0 && celsius <= 150.0) {
        reading.temperature_c = celsius;
      }
    }
  }
  if (const auto text = read_sysfs_line(directory / "capacity")) {
    if (const auto raw = parse_sysfs_double(*text)) {
      if (*raw >= 0.0 && *raw <= 100.0) {
        reading.capacity_percent = *raw;
      }
    }
  }
  if (const auto text = read_sysfs_line(directory / "status")) {
    const auto status = map_power_supply_status(*text);
    if (status != PowerSupplyStatus::unknown) {
      reading.status = status;
    }
  }
  if (const auto text = read_sysfs_line(directory / "health")) {
    const auto health = map_power_supply_health(*text);
    if (health != PowerSupplyHealth::unknown) {
      reading.health = health;
    }
  }
  return reading;
}

/**
 * Deterministic auto-detection of the battery device under ``root``.
 *
 * Prefers a ``TYPE=Battery`` entry that exposes ``voltage_now`` (the full
 * electrical set), then one exposing ``capacity``, then any battery. Returns
 * an empty string when no suitable device exists. An explicitly configured
 * device name always wins over auto-detection (the node checks for an empty
 * device before calling this).
 */
inline std::string find_power_supply_device(const std::filesystem::path & root)
{
  std::error_code ec;
  if (!std::filesystem::is_directory(root, ec) || ec) {
    return "";
  }
  std::string with_voltage;
  std::string with_capacity;
  std::string any_battery;
  for (const auto & entry : std::filesystem::directory_iterator(root, ec)) {
    std::error_code entry_ec;
    if (!entry.is_directory(entry_ec) || entry_ec) {
      continue;
    }
    std::string type;
    if (const auto text = read_sysfs_line(entry.path() / "type")) {
      type = trim_string(*text);
    }
    if (type != "Battery") {
      continue;
    }
    const auto name = entry.path().filename().string();
    std::error_code probe_ec;
    const bool has_voltage =
      std::filesystem::exists(entry.path() / "voltage_now", probe_ec) && !probe_ec;
    const bool has_capacity =
      std::filesystem::exists(entry.path() / "capacity", probe_ec) && !probe_ec;
    if (has_voltage && with_voltage.empty()) {
      with_voltage = name;
    }
    if (has_capacity && with_capacity.empty()) {
      with_capacity = name;
    }
    if (any_battery.empty()) {
      any_battery = name;
    }
  }
  if (!with_voltage.empty()) {
    return with_voltage;
  }
  if (!with_capacity.empty()) {
    return with_capacity;
  }
  return any_battery;
}

/**
 * Sliding-window charger-direction inference from SDK SOC samples.
 *
 * The adapter refreshes SOC on its diagnostic cadence (10 s by default), so a
 * ~30 s window holds a handful of distinct points. The direction is the net
 * SOC change between the oldest retained point and the newest: a rise of at
 * least ``min_delta_percent`` means CHARGING, a fall of that size means
 * DISCHARGING, and anything flatter is reported as NOT_CHARGING. When the
 * history is too short or the anchor fell far outside the window (a long
 * sample gap) the state is ``std::nullopt`` rather than a guess.
 *
 * ``update`` dedupes on the sample timestamp so re-feeding the same 10 s SDK
 * sample on every 1 s tick does not create phantom history.
 */
class SocTrendCharger
{
public:
  using Clock = std::chrono::steady_clock;
  using TimePoint = Clock::time_point;

  struct Point
  {
    TimePoint at;
    double soc_percent;
  };

  SocTrendCharger()
  : SocTrendCharger(std::chrono::seconds(30), 1.0) {}

  SocTrendCharger(std::chrono::seconds window, double min_delta_percent)
  : window_(window), min_delta_(std::max(0.0, min_delta_percent)) {}

  void update(double soc_percent, TimePoint sample_at)
  {
    if (!std::isfinite(soc_percent)) {
      return;
    }
    if (!points_.empty() && sample_at <= points_.back().at) {
      return;  // same or older sample: no new history
    }
    points_.push_back(Point{sample_at, soc_percent});
    prune(sample_at);
  }

  /** Inferred direction, or ``std::nullopt`` when there is not enough
   * distinct, recent history to judge. */
  std::optional<PowerSupplyStatus> status() const
  {
    if (points_.size() < 2) {
      return std::nullopt;
    }
    const Point & newest = points_.back();
    const Point & anchor = points_.front();
    if (anchor.at == newest.at) {
      return std::nullopt;
    }
    const auto span = newest.at - anchor.at;
    if (span < window_ || span > window_ * 2) {
      return std::nullopt;
    }
    const double delta = newest.soc_percent - anchor.soc_percent;
    if (delta >= min_delta_) {
      return PowerSupplyStatus::charging;
    }
    if (delta <= -min_delta_) {
      return PowerSupplyStatus::discharging;
    }
    return PowerSupplyStatus::not_charging;
  }

  std::size_t point_count() const {return points_.size();}

  void reset() {points_.clear();}

private:
  void prune(TimePoint now)
  {
    // Keep the anchor plus every point still within the window of ``now``.
    while (points_.size() > 2 && (now - points_[1].at) > window_) {
      points_.erase(points_.begin());
    }
  }

  std::chrono::seconds window_;
  double min_delta_;
  std::vector<Point> points_;
};

/**
 * Merged, publish-ready battery state. ``*_known`` flags distinguish a real
 * zero from an absent measurement; the node maps unknown fields to NaN /
 * UNKNOWN on the wire.
 */
struct BatteryMergedState
{
  bool percentage_known{false};
  float percentage{0.0F};  // 0..100

  bool voltage_known{false};
  float voltage{0.0F};  // volts

  bool current_known{false};
  float current{0.0F};  // amps, sensor_msgs sign (positive while charging)

  bool temperature_known{false};
  float temperature{0.0F};  // celsius

  bool present_known{false};
  bool present{false};

  PowerSupplyStatus status{PowerSupplyStatus::unknown};
  bool status_known{false};
  std::string status_source;  // "sysfs" | "soc_trend" | "none"

  PowerSupplyHealth health{PowerSupplyHealth::unknown};
  bool health_known{false};

  // Derived: a charger is attached when the status implies one.
  bool charger_connected{false};
  // Derived: actively charging per status (authoritative) or, when no status
  // is available, per the signed current threshold.
  bool charging{false};
};

/**
 * Merge the SDK SOC with a power-supply read and (optionally) the SOC-trend
 * direction into a publish-ready state.
 *
 * Priority, per field:
 *  - percentage: SDK sample (primary) -> sysfs ``capacity`` -> unknown.
 *  - voltage / temperature: sysfs only -> unknown.
 *  - current: sysfs only, rescaled by ``current_sign`` into the sensor_msgs
 *    convention (positive while charging) -> unknown.
 *  - status: sysfs ``status`` (authoritative) -> SOC trend -> unknown.
 *  - charging: the merged status when known, else the signed current
 *    crossing ``charge_current_threshold_a``.
 *
 * ``current_sign`` is a deployment knob: the Linux ``current_now`` sign is
 * driver-dependent, so a field engineer flips this to -1.0 when the BMS
 * reports positive while discharging.
 */
inline BatteryMergedState merge_battery_state(
  bool sdk_soc_known, double sdk_soc_fraction,
  const PowerSupplyReading & ps,
  std::optional<PowerSupplyStatus> trend_status,
  double current_sign, double charge_current_threshold_a)
{
  BatteryMergedState merged;

  if (sdk_soc_known && std::isfinite(sdk_soc_fraction)) {
    merged.percentage_known = true;
    merged.percentage =
      static_cast<float>(std::clamp(sdk_soc_fraction, 0.0, 1.0) * 100.0);
  } else if (ps.capacity_percent) {
    merged.percentage_known = true;
    merged.percentage =
      static_cast<float>(std::clamp(*ps.capacity_percent, 0.0, 100.0));
  }

  if (ps.voltage_v && std::isfinite(*ps.voltage_v)) {
    merged.voltage_known = true;
    merged.voltage = static_cast<float>(*ps.voltage_v);
  }

  if (ps.current_a && std::isfinite(*ps.current_a)) {
    merged.current_known = true;
    merged.current = static_cast<float>(current_sign * *ps.current_a);
  }

  if (ps.temperature_c && std::isfinite(*ps.temperature_c)) {
    merged.temperature_known = true;
    merged.temperature = static_cast<float>(*ps.temperature_c);
  }

  merged.present_known = ps.present_known;
  merged.present = ps.present;

  if (ps.status) {
    merged.status = *ps.status;
    merged.status_known = true;
    merged.status_source = "sysfs";
  } else if (trend_status && *trend_status != PowerSupplyStatus::unknown) {
    merged.status = *trend_status;
    merged.status_known = true;
    merged.status_source = "soc_trend";
  } else {
    merged.status_source = "none";
  }

  if (ps.health) {
    merged.health = *ps.health;
    merged.health_known = true;
  }

  merged.charger_connected =
    merged.status == PowerSupplyStatus::charging ||
    merged.status == PowerSupplyStatus::full ||
    merged.status == PowerSupplyStatus::not_charging;

  if (merged.status_known) {
    merged.charging = merged.status == PowerSupplyStatus::charging;
  } else if (merged.current_known) {
    merged.charging = merged.current >= charge_current_threshold_a;
  }

  return merged;
}

}  // namespace rosdeck_robot_bridge
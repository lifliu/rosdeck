#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>

namespace rosdeck_robot_bridge
{

using AdapterSteadyClock = std::chrono::steady_clock;
using AdapterSteadyTime = AdapterSteadyClock::time_point;

/**
 * Immutable-by-convention copy of adapter-owned cached telemetry.
 *
 * A snapshot getter may lock adapter memory, but must never perform I/O or call
 * a vendor SDK. Unknown values are represented by their explicit `*_known`
 * flags; false/zero alone must never be interpreted as a healthy sample.
 */
struct AdapterSnapshot
{
  std::string adapter_name{"unknown"};

  bool connection_known{false};
  bool connected{false};
  bool telemetry_sample_known{false};
  AdapterSteadyTime telemetry_sample_at{};

  // Physical presence and percentage validity are independent. A robot may
  // certainly have a battery while its telemetry source is unavailable.
  bool battery_presence_known{false};
  bool battery_present{false};
  bool battery_known{false};
  float battery_fraction{0.0F};
  bool battery_sample_known{false};
  AdapterSteadyTime battery_sample_at{};

  bool control_mode_known{false};
  std::string control_mode{"unknown"};
  bool posture_known{false};
  std::string posture{"unknown"};

  bool authority_known{false};
  std::string authority_state{"unknown"};
  std::string authority_owner;

  // Motion-lease timing, when the adapter tracks a lease deadline. Unknown
  // adapters (vbot has no lease concept) leave the known flag false; the
  // aggregator then reports a held lease with unknown timing (0.0 in the
  // RobotState contract).
  bool authority_lease_remaining_known{false};
  double authority_lease_remaining_sec{0.0};

  bool last_sdk_result_known{false};
  uint32_t last_sdk_result_code{0};
  std::string last_sdk_result{"unknown"};
  bool last_error_active{false};
  std::string last_error_domain{"none"};
  std::string last_error;
  bool last_error_sample_known{false};
  AdapterSteadyTime last_error_at{};

  uint64_t sequence{0};
};

struct AdapterBuildSupport
{
  bool vbot{false};
  bool zsibot{false};
};

inline std::optional<std::string> adapter_selection_error(
  const std::string & requested, AdapterBuildSupport support)
{
  if (requested == "vbot") {
    return support.vbot ? std::nullopt :
           std::optional<std::string>{"requested_vbot_adapter_not_built"};
  }
  if (requested == "zsibot") {
    return support.zsibot ? std::nullopt :
           std::optional<std::string>{"requested_zsibot_adapter_not_built"};
  }
  if (requested == "unavailable") {
    return std::nullopt;
  }
  return "unsupported_adapter_" + requested;
}

inline std::optional<float> battery_fraction_from_percent(uint32_t percent)
{
  if (percent > 100U) {
    return std::nullopt;
  }
  return static_cast<float>(percent) / 100.0F;
}

inline bool battery_state_present(const AdapterSnapshot & snapshot)
{
  // sensor_msgs/BatteryState.present is a bool, so an unknown physical
  // presence must use false while the separate diagnostic known bit preserves
  // the distinction from a confirmed-absent battery.
  return snapshot.battery_presence_known && snapshot.battery_present;
}

inline int64_t adapter_sample_age_ms(
  bool sample_known, AdapterSteadyTime sampled_at, AdapterSteadyTime now)
{
  if (!sample_known || now < sampled_at) {
    return -1;
  }
  return std::chrono::duration_cast<std::chrono::milliseconds>(now - sampled_at).count();
}

inline bool adapter_sample_fresh(
  bool sample_known, AdapterSteadyTime sampled_at, AdapterSteadyTime now,
  std::chrono::milliseconds timeout)
{
  if (timeout <= std::chrono::milliseconds::zero()) {
    return false;
  }
  const int64_t age = adapter_sample_age_ms(sample_known, sampled_at, now);
  return age >= 0 && age < timeout.count();
}

enum class AdapterHealthLevel
{
  ok,
  warning,
  error,
};

struct AdapterHealth
{
  AdapterHealthLevel level{AdapterHealthLevel::warning};
  const char * reason{"adapter_state_unknown"};
};

inline AdapterHealth assess_adapter_health(
  const AdapterSnapshot & snapshot, AdapterSteadyTime now,
  std::chrono::milliseconds telemetry_timeout,
  std::chrono::milliseconds battery_timeout)
{
  if (snapshot.last_error_active) {
    return {AdapterHealthLevel::error, "adapter_error_active"};
  }
  if (snapshot.battery_presence_known && !snapshot.battery_present) {
    return {AdapterHealthLevel::error, "adapter_battery_not_present"};
  }
  if (snapshot.connection_known && !snapshot.connected) {
    return {AdapterHealthLevel::error, "adapter_disconnected"};
  }
  if (snapshot.connection_known && !adapter_sample_fresh(
      snapshot.telemetry_sample_known, snapshot.telemetry_sample_at, now, telemetry_timeout))
  {
    return {AdapterHealthLevel::error, "adapter_telemetry_stale"};
  }
  if (!snapshot.connection_known) {
    return {AdapterHealthLevel::warning, "adapter_connection_unknown"};
  }
  if (!snapshot.control_mode_known) {
    return {AdapterHealthLevel::warning, "adapter_mode_unknown"};
  }
  if (!snapshot.posture_known) {
    return {AdapterHealthLevel::warning, "adapter_posture_unknown"};
  }
  if (!snapshot.authority_known) {
    return {AdapterHealthLevel::warning, "adapter_authority_unknown"};
  }
  if (!snapshot.battery_presence_known) {
    return {AdapterHealthLevel::warning, "adapter_battery_presence_unknown"};
  }
  if (!snapshot.battery_known) {
    return {AdapterHealthLevel::warning, "adapter_battery_unknown"};
  }
  if (!adapter_sample_fresh(
      snapshot.battery_sample_known, snapshot.battery_sample_at, now, battery_timeout))
  {
    return {AdapterHealthLevel::warning, "adapter_battery_stale"};
  }
  return {AdapterHealthLevel::ok, "adapter_telemetry_ok"};
}

}  // namespace rosdeck_robot_bridge

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <string_view>

#include "rosdeck_robot_bridge/adapter_observability.hpp"
#include "rosdeck_robot_bridge/cmd_vel_arbiter.hpp"

#include <omni_robot_interfaces/msg/mission_status.hpp>
#include <omni_robot_interfaces/msg/robot_state.hpp>
#include <omni_slam_interfaces/msg/slam_status.hpp>

namespace rosdeck_robot_bridge
{

/**
 * Pure aggregation of the whole-robot snapshot published on /omni/robot_state.
 *
 * Merges gateway-local observability (adapter snapshot, adapter health,
 * E-stop latch, mapping process, control lease) with the SLAM status and
 * mission status relays into a single RobotState message.
 *
 * The class never touches the ROS graph: freshness is decided by the caller,
 * which passes explicit `*_fresh` flags based on its own steady clock. All
 * mappings are static so they can be unit tested without a node.
 */
class RobotStateAggregator
{
public:
  using RobotState = omni_robot_interfaces::msg::RobotState;
  using MissionStatus = omni_robot_interfaces::msg::MissionStatus;
  using SlamStatus = omni_slam_interfaces::msg::SlamStatus;

  /** Relay inputs. Unfresh relays must leave their payload fields untouched. */
  struct Relay
  {
    bool slam_fresh{false};
    uint8_t slam_mode{SlamStatus::MODE_STOPPED};
    uint8_t slam_state{SlamStatus::STATE_STOPPED};
    std::string slam_map_id;
    std::string slam_map_version;
    float slam_fitness{std::numeric_limits<float>::quiet_NaN()};

    bool mission_fresh{false};
    uint8_t mission_state{MissionStatus::MISSION_NONE};
    std::string mission_id;
    float mission_progress{std::numeric_limits<float>::quiet_NaN()};
  };

  /**
   * Assemble the RobotState message.
   *
   * @param battery_percentage 0..100, NaN when unknown or stale.
   * @param estop_latched      the arbiter's fail-closed software E-stop latch
   *                           (false when the arbiter is disabled).
   * @param mapping_active     the bridge's mapping process is running.
   * @param control_status     adapter control-lease string ("acquired:<owner>").
   */
  static RobotState build(
    const AdapterSnapshot & snapshot, const AdapterHealth & health,
    float battery_percentage, bool estop_latched, bool mapping_active,
    const std::string & control_status, const Relay & relay)
  {
    RobotState message;
    message.control_authority = map_authority(control_status, message.authority_client_id);
    message.operational_mode = map_operational_mode(
      estop_latched, mapping_active, message.control_authority, relay);
    message.authority_lease_remaining_sec =
      lease_remaining(snapshot, message.control_authority);
    message.localization_state =
      map_localization(relay.slam_mode, relay.slam_state, relay.slam_fresh);
    if (relay.slam_fresh) {
      message.map_id = relay.slam_map_id;
      message.map_version = relay.slam_map_version;
      message.localization_fitness_score = relay.slam_fitness;
    }
    message.health_level = map_health(health, estop_latched);
    message.health_summary = health_summary(health, estop_latched);
    message.estop_latched = estop_latched;
    message.motion_authorized = !estop_latched &&
      message.control_authority != RobotState::AUTHORITY_NONE;
    if (relay.mission_fresh && relay.mission_state != MissionStatus::MISSION_NONE) {
      message.mission_state = relay.mission_state;
      message.mission_id = relay.mission_id;
      message.mission_progress = relay.mission_progress;
    }
    // V1 has no voltage or charging source yet; both stay explicitly unknown.
    message.battery_voltage = std::numeric_limits<float>::quiet_NaN();
    message.battery_percentage = battery_percentage;
    message.charging = false;
    return message;
  }

  /** SlamStatus (mode, state) -> RobotState.LOC_*; stale relay is UNKNOWN. */
  static uint8_t map_localization(uint8_t slam_mode, uint8_t slam_state, bool fresh)
  {
    if (!fresh || slam_mode != SlamStatus::MODE_LOCALIZATION) {
      return RobotState::LOC_UNKNOWN;
    }
    switch (slam_state) {
      case SlamStatus::STATE_LOCALIZED:
        return RobotState::LOC_LOCALIZED;
      case SlamStatus::STATE_STARTING_LOCALIZATION:
      case SlamStatus::STATE_RELOCALIZING:
      case SlamStatus::STATE_DEGRADED:
        return RobotState::LOC_DEGRADED;
      case SlamStatus::STATE_LOST:
      case SlamStatus::STATE_ERROR:
        return RobotState::LOC_LOST;
      default:
        return RobotState::LOC_UNKNOWN;
    }
  }

  /**
   * Operational mode priority:
   * E-stop > mapping > mission > docking lease > localizing > idle.
   */
  static uint8_t map_operational_mode(
    bool estop_latched, bool mapping_active,
    uint8_t control_authority, const Relay & relay)
  {
    if (estop_latched) {
      return RobotState::MODE_ESTOP;
    }
    if (mapping_active) {
      return RobotState::MODE_MAPPING;
    }
    if (relay.mission_fresh &&
      (relay.mission_state == MissionStatus::MISSION_PENDING ||
       relay.mission_state == MissionStatus::MISSION_EXECUTING ||
       relay.mission_state == MissionStatus::MISSION_PAUSED))
    {
      return RobotState::MODE_MISSION;
    }
    if (control_authority == RobotState::AUTHORITY_DOCKING) {
      return RobotState::MODE_DOCKING;
    }
    if (relay.slam_fresh && relay.slam_mode == SlamStatus::MODE_LOCALIZATION) {
      return RobotState::MODE_LOCALIZING;
    }
    return RobotState::MODE_IDLE;
  }

  /**
   * Control-lease string -> RobotState.AUTHORITY_*.
   * Only an acquired lease grants authority; acquiring/releasing/cooldown
   * report AUTHORITY_NONE. The client id is extracted for the message.
   */
  static uint8_t map_authority(const std::string & control_status, std::string & client_id)
  {
    client_id.clear();
    const auto kind = cmd_vel_arbiter::parse_owner_kind(control_status);
    if (kind != cmd_vel_arbiter::OwnerKind::app &&
      kind != cmd_vel_arbiter::OwnerKind::mission &&
      kind != cmd_vel_arbiter::OwnerKind::docking)
    {
      return RobotState::AUTHORITY_NONE;
    }
    constexpr std::string_view acquired_prefix = "acquired:";
    client_id = control_status.substr(acquired_prefix.size());
    switch (kind) {
      case cmd_vel_arbiter::OwnerKind::app:
        return RobotState::AUTHORITY_APP;
      case cmd_vel_arbiter::OwnerKind::mission:
        return RobotState::AUTHORITY_MISSION;
      case cmd_vel_arbiter::OwnerKind::docking:
        return RobotState::AUTHORITY_DOCKING;
      default:
        return RobotState::AUTHORITY_NONE;
    }
  }

  /** Adapter health -> RobotState.HEALTH_*; a latched E-stop is always a fault. */
  static uint8_t map_health(const AdapterHealth & health, bool estop_latched)
  {
    if (estop_latched) {
      return RobotState::HEALTH_FAULT;
    }
    switch (health.level) {
      case AdapterHealthLevel::error:
        return RobotState::HEALTH_FAULT;
      case AdapterHealthLevel::warning:
        return RobotState::HEALTH_WARN;
      case AdapterHealthLevel::ok:
        return RobotState::HEALTH_OK;
    }
    return RobotState::HEALTH_FAULT;
  }

  static std::string health_summary(const AdapterHealth & health, bool estop_latched)
  {
    std::string summary = sanitize_field(health.reason);
    if (estop_latched) {
      summary = "estop_latched;" + summary;
    }
    return summary;
  }

  /**
   * Lease remaining seconds for the message. -1.0 means no lease. 0.0 means a
   * lease is held but the adapter does not report timing. A known remaining
   * time is quantized up to whole seconds so sub-second drift does not make
   * every snapshot look changed.
   */
  static float lease_remaining(const AdapterSnapshot & snapshot, uint8_t authority)
  {
    if (authority == RobotState::AUTHORITY_NONE) {
      return -1.0F;
    }
    if (!snapshot.authority_lease_remaining_known) {
      return 0.0F;
    }
    const int64_t seconds = static_cast<int64_t>(
      std::max(0.0, std::ceil(snapshot.authority_lease_remaining_sec)));
    return static_cast<float>(seconds);
  }

  /**
   * True when a freshly built message differs from the previous one in any
   * informational field. NaN-valued floats compare equal when both are
   * non-finite so unknown fields do not defeat the 1 Hz heartbeat cadence.
   */
  static bool effectively_changed(const RobotState & previous, const RobotState & current)
  {
    return previous.operational_mode != current.operational_mode ||
           previous.control_authority != current.control_authority ||
           previous.authority_client_id != current.authority_client_id ||
           previous.authority_lease_remaining_sec != current.authority_lease_remaining_sec ||
           previous.localization_state != current.localization_state ||
           previous.map_id != current.map_id ||
           previous.map_version != current.map_version ||
           !floats_equivalent(
             previous.localization_fitness_score, current.localization_fitness_score) ||
           previous.health_level != current.health_level ||
           previous.health_summary != current.health_summary ||
           previous.estop_latched != current.estop_latched ||
           previous.motion_authorized != current.motion_authorized ||
           previous.mission_state != current.mission_state ||
           previous.mission_id != current.mission_id ||
           !floats_equivalent(previous.mission_progress, current.mission_progress) ||
           !floats_equivalent(previous.battery_voltage, current.battery_voltage) ||
           !floats_equivalent(previous.battery_percentage, current.battery_percentage) ||
           previous.charging != current.charging;
  }

  static bool floats_equivalent(float a, float b)
  {
    return (!std::isfinite(a) && !std::isfinite(b)) || a == b;
  }

private:
  static std::string sanitize_field(const std::string & value)
  {
    std::string sanitized = value;
    for (char & character : sanitized) {
      if (character == ';' || character == '=' || character == '\n' || character == '\r') {
        character = '_';
      }
    }
    return sanitized.empty() ? "none" : sanitized;
  }
};

}  // namespace rosdeck_robot_bridge
#include "rosdeck_robot_bridge/robot_state_aggregator.hpp"

#include <cmath>

#include <gtest/gtest.h>

#include <omni_robot_interfaces/msg/mission_status.hpp>
#include <omni_robot_interfaces/msg/robot_state.hpp>
#include <omni_slam_interfaces/msg/slam_status.hpp>

namespace bridge = rosdeck_robot_bridge;
using bridge::RobotStateAggregator;

namespace
{

omni_robot_interfaces::msg::RobotState build_message(
  const bridge::AdapterSnapshot & snapshot = {},
  const bridge::AdapterHealth & health = {},
  float battery_percentage = std::numeric_limits<float>::quiet_NaN(),
  bool estop_latched = false, bool mapping_active = false,
  const std::string & control_status = "",
  const RobotStateAggregator::Relay & relay = {})
{
  return RobotStateAggregator::build(
    snapshot, health, battery_percentage, estop_latched, mapping_active,
    control_status, relay);
}

RobotStateAggregator::Relay executing_mission_relay()
{
  RobotStateAggregator::Relay relay;
  relay.mission_fresh = true;
  relay.mission_state = omni_robot_interfaces::msg::MissionStatus::MISSION_EXECUTING;
  relay.mission_id = "m-1";
  relay.mission_progress = 0.25F;
  return relay;
}

}  // namespace

TEST(RobotStateAggregator, OperationalModePriority)
{
  using RobotState = omni_robot_interfaces::msg::RobotState;

  // E-stop wins over mapping and an active mission.
  {
    RobotStateAggregator::Relay relay = executing_mission_relay();
    EXPECT_EQ(
      RobotStateAggregator::map_operational_mode(
        true, true, RobotState::AUTHORITY_MISSION, relay),
      RobotState::MODE_ESTOP);
  }
  // Mapping beats a mission.
  {
    RobotStateAggregator::Relay relay = executing_mission_relay();
    EXPECT_EQ(
      RobotStateAggregator::map_operational_mode(
        false, true, RobotState::AUTHORITY_MISSION, relay),
      RobotState::MODE_MAPPING);
  }
  // A fresh pending/executing/paused mission beats a docking lease.
  for (auto state : {
           omni_robot_interfaces::msg::MissionStatus::MISSION_PENDING,
           omni_robot_interfaces::msg::MissionStatus::MISSION_EXECUTING,
           omni_robot_interfaces::msg::MissionStatus::MISSION_PAUSED})
  {
    RobotStateAggregator::Relay relay;
    relay.mission_fresh = true;
    relay.mission_state = state;
    EXPECT_EQ(
      RobotStateAggregator::map_operational_mode(
        false, false, RobotState::AUTHORITY_DOCKING, relay),
      RobotState::MODE_MISSION);
  }
  // Docking lease.
  EXPECT_EQ(
    RobotStateAggregator::map_operational_mode(
      false, false, RobotState::AUTHORITY_DOCKING, {}),
    RobotState::MODE_DOCKING);
  // Localizing beats idle.
  {
    RobotStateAggregator::Relay relay;
    relay.slam_fresh = true;
    relay.slam_mode = omni_slam_interfaces::msg::SlamStatus::MODE_LOCALIZATION;
    EXPECT_EQ(
      RobotStateAggregator::map_operational_mode(
        false, false, RobotState::AUTHORITY_APP, relay),
      RobotState::MODE_LOCALIZING);
  }
  // Idle: no lease, no mission, no localizing.
  EXPECT_EQ(
    RobotStateAggregator::map_operational_mode(
      false, false, RobotState::AUTHORITY_APP, {}),
    RobotState::MODE_IDLE);
  // A finished mission (SUCCEEDED) does not keep the mode in MISSION.
  {
    RobotStateAggregator::Relay relay;
    relay.mission_fresh = true;
    relay.mission_state =
      omni_robot_interfaces::msg::MissionStatus::MISSION_SUCCEEDED;
    EXPECT_EQ(
      RobotStateAggregator::map_operational_mode(
        false, false, RobotState::AUTHORITY_NONE, relay),
      RobotState::MODE_IDLE);
  }
}

TEST(RobotStateAggregator, AuthorityParsing)
{
  using RobotState = omni_robot_interfaces::msg::RobotState;
  std::string client_id;

  EXPECT_EQ(
    RobotStateAggregator::map_authority("acquired:app-123", client_id),
    RobotState::AUTHORITY_APP);
  EXPECT_EQ(client_id, "app-123");

  EXPECT_EQ(
    RobotStateAggregator::map_authority("acquired:mission-m1", client_id),
    RobotState::AUTHORITY_MISSION);
  EXPECT_EQ(client_id, "mission-m1");

  EXPECT_EQ(
    RobotStateAggregator::map_authority("acquired:docking-d1", client_id),
    RobotState::AUTHORITY_DOCKING);
  EXPECT_EQ(client_id, "docking-d1");

  // Unknown owner kind and non-acquired states report no authority.
  EXPECT_EQ(
    RobotStateAggregator::map_authority("acquired:weird-owner", client_id),
    RobotState::AUTHORITY_NONE);
  EXPECT_TRUE(client_id.empty());
  EXPECT_EQ(
    RobotStateAggregator::map_authority("acquiring:app-1", client_id),
    RobotState::AUTHORITY_NONE);
  EXPECT_TRUE(client_id.empty());
  EXPECT_EQ(
    RobotStateAggregator::map_authority("cooldown:app-1", client_id),
    RobotState::AUTHORITY_NONE);
  EXPECT_TRUE(client_id.empty());
  EXPECT_EQ(RobotStateAggregator::map_authority("", client_id),
    RobotState::AUTHORITY_NONE);
  EXPECT_TRUE(client_id.empty());
}

TEST(RobotStateAggregator, LeaseRemaining)
{
  using RobotState = omni_robot_interfaces::msg::RobotState;
  bridge::AdapterSnapshot snapshot;

  // No lease -> -1.
  EXPECT_FLOAT_EQ(
    RobotStateAggregator::lease_remaining(snapshot, RobotState::AUTHORITY_NONE),
    -1.0F);

  // Held lease without adapter timing -> 0.0 (unknown, but held).
  EXPECT_FLOAT_EQ(
    RobotStateAggregator::lease_remaining(snapshot, RobotState::AUTHORITY_APP),
    0.0F);

  // Known remaining time is quantized up to whole seconds.
  snapshot.authority_lease_remaining_known = true;
  snapshot.authority_lease_remaining_sec = 4.3;
  EXPECT_FLOAT_EQ(
    RobotStateAggregator::lease_remaining(snapshot, RobotState::AUTHORITY_APP),
    5.0F);
  snapshot.authority_lease_remaining_sec = 0.2;
  EXPECT_FLOAT_EQ(
    RobotStateAggregator::lease_remaining(snapshot, RobotState::AUTHORITY_APP),
    1.0F);
  snapshot.authority_lease_remaining_sec = 0.0;
  EXPECT_FLOAT_EQ(
    RobotStateAggregator::lease_remaining(snapshot, RobotState::AUTHORITY_APP),
    0.0F);
}

TEST(RobotStateAggregator, LocalizationMapping)
{
  using RobotState = omni_robot_interfaces::msg::RobotState;
  using SlamStatus = omni_slam_interfaces::msg::SlamStatus;

  EXPECT_EQ(
    RobotStateAggregator::map_localization(
      SlamStatus::MODE_LOCALIZATION, SlamStatus::STATE_LOCALIZED, true),
    RobotState::LOC_LOCALIZED);
  for (auto state : {SlamStatus::STATE_STARTING_LOCALIZATION,
      SlamStatus::STATE_RELOCALIZING, SlamStatus::STATE_DEGRADED})
  {
    EXPECT_EQ(
      RobotStateAggregator::map_localization(SlamStatus::MODE_LOCALIZATION, state, true),
      RobotState::LOC_DEGRADED);
  }
  for (auto state : {SlamStatus::STATE_LOST, SlamStatus::STATE_ERROR})
  {
    EXPECT_EQ(
      RobotStateAggregator::map_localization(SlamStatus::MODE_LOCALIZATION, state, true),
      RobotState::LOC_LOST);
  }
  // Not localizing, or a stale relay -> unknown.
  EXPECT_EQ(
    RobotStateAggregator::map_localization(SlamStatus::MODE_MAPPING,
      SlamStatus::STATE_MAPPING, true),
    RobotState::LOC_UNKNOWN);
  EXPECT_EQ(
    RobotStateAggregator::map_localization(
      SlamStatus::MODE_LOCALIZATION, SlamStatus::STATE_LOCALIZED, false),
    RobotState::LOC_UNKNOWN);
}

TEST(RobotStateAggregator, HealthMapping)
{
  using RobotState = omni_robot_interfaces::msg::RobotState;
  const bridge::AdapterHealth ok{bridge::AdapterHealthLevel::ok, "adapter_telemetry_ok"};
  const bridge::AdapterHealth warn{bridge::AdapterHealthLevel::warning, "adapter_battery_stale"};
  const bridge::AdapterHealth error{bridge::AdapterHealthLevel::error, "adapter_disconnected"};

  EXPECT_EQ(RobotStateAggregator::map_health(ok, false), RobotState::HEALTH_OK);
  EXPECT_EQ(RobotStateAggregator::map_health(warn, false), RobotState::HEALTH_WARN);
  EXPECT_EQ(RobotStateAggregator::map_health(error, false), RobotState::HEALTH_FAULT);
  // A latched E-stop is always a fault, even with healthy telemetry.
  EXPECT_EQ(RobotStateAggregator::map_health(ok, true), RobotState::HEALTH_FAULT);

  EXPECT_EQ(RobotStateAggregator::health_summary(ok, false), "adapter_telemetry_ok");
  EXPECT_EQ(RobotStateAggregator::health_summary(ok, true),
    "estop_latched;adapter_telemetry_ok");
}

TEST(RobotStateAggregator, BuildAppliesRelaysAndMotionAuthorization)
{
  using RobotState = omni_robot_interfaces::msg::RobotState;

  // Fresh slam relay populates map fields and localization.
  {
    RobotStateAggregator::Relay relay;
    relay.slam_fresh = true;
    relay.slam_mode = omni_slam_interfaces::msg::SlamStatus::MODE_LOCALIZATION;
    relay.slam_state = omni_slam_interfaces::msg::SlamStatus::STATE_LOCALIZED;
    relay.slam_map_id = "floor1";
    relay.slam_map_version = "12";
    relay.slam_fitness = 0.8F;
    const auto message = build_message({}, {}, 50.0F, false, false,
      "acquired:app-1", relay);
    EXPECT_EQ(message.map_id, "floor1");
    EXPECT_EQ(message.map_version, "12");
    EXPECT_FLOAT_EQ(message.localization_fitness_score, 0.8F);
    EXPECT_EQ(message.localization_state, RobotState::LOC_LOCALIZED);
    EXPECT_EQ(message.operational_mode, RobotState::MODE_LOCALIZING);
    EXPECT_EQ(message.control_authority, RobotState::AUTHORITY_APP);
    EXPECT_EQ(message.authority_client_id, "app-1");
    EXPECT_TRUE(message.motion_authorized);
    EXPECT_FALSE(message.estop_latched);
  }

  // Stale slam relay leaves map fields empty and localization unknown.
  {
    RobotStateAggregator::Relay relay;
    relay.slam_fresh = false;
    relay.slam_map_id = "floor1";
    relay.slam_fitness = 0.8F;
    const auto message = build_message({}, {}, 50.0F, false, false, "", relay);
    EXPECT_TRUE(message.map_id.empty());
    EXPECT_TRUE(message.map_version.empty());
    EXPECT_TRUE(std::isnan(message.localization_fitness_score));
    EXPECT_EQ(message.localization_state, RobotState::LOC_UNKNOWN);
    EXPECT_EQ(message.operational_mode, RobotState::MODE_IDLE);
    EXPECT_FALSE(message.motion_authorized);
  }

  // Fresh executing mission populates mission fields; stale relay does not.
  {
    RobotStateAggregator::Relay relay = executing_mission_relay();
    const auto message = build_message({}, {}, 50.0F, false, false, "", relay);
    EXPECT_EQ(message.mission_state, RobotState::MISSION_EXECUTING);
    EXPECT_EQ(message.mission_id, "m-1");
    EXPECT_FLOAT_EQ(message.mission_progress, 0.25F);
    EXPECT_EQ(message.operational_mode, RobotState::MODE_MISSION);
  }
  {
    RobotStateAggregator::Relay relay = executing_mission_relay();
    relay.mission_fresh = false;
    const auto message = build_message({}, {}, 50.0F, false, false, "", relay);
    EXPECT_EQ(message.mission_state, RobotState::MISSION_NONE);
    EXPECT_TRUE(message.mission_id.empty());
    EXPECT_TRUE(std::isnan(message.mission_progress));
  }

  // E-stop latch: fault, no motion, MODE_ESTOP.
  {
    const auto message = build_message({}, {}, 50.0F, true, false,
      "acquired:app-1", {});
    EXPECT_EQ(message.health_level, RobotState::HEALTH_FAULT);
    EXPECT_FALSE(message.motion_authorized);
    EXPECT_EQ(message.operational_mode, RobotState::MODE_ESTOP);
    EXPECT_EQ(message.health_summary, "estop_latched;adapter_state_unknown");
  }

  // V1 has no voltage source: always NaN, charging always false.
  {
    const auto message = build_message({}, {}, 50.0F, false, false, "", {});
    EXPECT_TRUE(std::isnan(message.battery_voltage));
    EXPECT_FLOAT_EQ(message.battery_percentage, 50.0F);
    EXPECT_FALSE(message.charging);
  }
}

TEST(RobotStateAggregator, EffectivelyChanged)
{
  using RobotState = omni_robot_interfaces::msg::RobotState;
  const auto previous = build_message();

  // Identical message -> no change.
  EXPECT_FALSE(RobotStateAggregator::effectively_changed(previous, previous));

  // Both-NaN floats are equivalent, so unknown fields do not thrash.
  {
    const auto current = build_message();
    EXPECT_TRUE(std::isnan(previous.localization_fitness_score));
    EXPECT_TRUE(std::isnan(current.localization_fitness_score));
    EXPECT_FALSE(
      RobotStateAggregator::effectively_changed(previous, current));
  }

  // Mode change -> changed.
  {
    const auto current = build_message({}, {}, 50.0F, false, false,
      "acquired:app-1", {});
    EXPECT_TRUE(RobotStateAggregator::effectively_changed(previous, current));
  }

  // Fitness value change -> changed.
  {
    RobotStateAggregator::Relay relay;
    relay.slam_fresh = true;
    relay.slam_fitness = 0.5F;
    const auto current = build_message({}, {}, 50.0F, false, false, "", relay);
    EXPECT_TRUE(RobotStateAggregator::effectively_changed(previous, current));
  }

  // Header-only differences are not informational fields.
  {
    auto current = previous;
    current.header.stamp.sec += 1;
    EXPECT_FALSE(RobotStateAggregator::effectively_changed(previous, current));
  }
}
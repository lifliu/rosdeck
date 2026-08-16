#include "rosdeck_robot_bridge/adapter_observability.hpp"

#include <chrono>

#include <gtest/gtest.h>

namespace observability = rosdeck_robot_bridge;
using namespace std::chrono_literals;

TEST(AdapterObservability, BatteryPercentIsNormalizedOnlyWhenValid)
{
  ASSERT_TRUE(observability::battery_fraction_from_percent(0).has_value());
  EXPECT_FLOAT_EQ(*observability::battery_fraction_from_percent(0), 0.0F);
  EXPECT_FLOAT_EQ(*observability::battery_fraction_from_percent(50), 0.5F);
  EXPECT_FLOAT_EQ(*observability::battery_fraction_from_percent(100), 1.0F);
  EXPECT_FALSE(observability::battery_fraction_from_percent(101).has_value());
}

TEST(AdapterObservability, PhysicalBatteryPresenceIsIndependentOfPercentageFreshness)
{
  observability::AdapterSnapshot snapshot;
  EXPECT_FALSE(observability::battery_state_present(snapshot));

  snapshot.battery_presence_known = true;
  snapshot.battery_present = true;
  snapshot.battery_known = false;
  EXPECT_TRUE(observability::battery_state_present(snapshot));

  snapshot.battery_present = false;
  snapshot.battery_known = true;
  EXPECT_FALSE(observability::battery_state_present(snapshot));
}

TEST(AdapterObservability, ProductAdapterSelectionFailsWhenBinarySupportIsMissing)
{
  observability::AdapterBuildSupport none;
  EXPECT_EQ(
    *observability::adapter_selection_error("vbot", none),
    "requested_vbot_adapter_not_built");
  EXPECT_EQ(
    *observability::adapter_selection_error("zsibot", none),
    "requested_zsibot_adapter_not_built");
  EXPECT_TRUE(observability::adapter_selection_error("unavailable", none) == std::nullopt);

  observability::AdapterBuildSupport all{true, true};
  EXPECT_TRUE(observability::adapter_selection_error("vbot", all) == std::nullopt);
  EXPECT_TRUE(observability::adapter_selection_error("zsibot", all) == std::nullopt);
  EXPECT_EQ(
    *observability::adapter_selection_error("typo", all),
    "unsupported_adapter_typo");
}

TEST(AdapterObservability, UnknownTelemetryCannotBeReportedHealthy)
{
  observability::AdapterSnapshot snapshot;
  const auto health = observability::assess_adapter_health(
    snapshot, observability::AdapterSteadyTime{}, 1500ms, 15s);
  EXPECT_EQ(health.level, observability::AdapterHealthLevel::warning);
  EXPECT_STREQ(health.reason, "adapter_connection_unknown");
}

TEST(AdapterObservability, ActiveErrorAndDisconnectionAreErrors)
{
  const auto now = observability::AdapterSteadyTime{} + 2s;
  observability::AdapterSnapshot snapshot;
  snapshot.last_error_active = true;
  EXPECT_EQ(
    observability::assess_adapter_health(snapshot, now, 1500ms, 15s).level,
    observability::AdapterHealthLevel::error);

  snapshot.last_error_active = false;
  snapshot.connection_known = true;
  snapshot.connected = false;
  EXPECT_EQ(
    observability::assess_adapter_health(snapshot, now, 1500ms, 15s).level,
    observability::AdapterHealthLevel::error);
}

TEST(AdapterObservability, StaleConnectionTelemetryIsAnError)
{
  const auto sampled_at = observability::AdapterSteadyTime{};
  observability::AdapterSnapshot snapshot;
  snapshot.connection_known = true;
  snapshot.connected = true;
  snapshot.telemetry_sample_known = true;
  snapshot.telemetry_sample_at = sampled_at;

  const auto health = observability::assess_adapter_health(
    snapshot, sampled_at + 1500ms, 1500ms, 15s);
  EXPECT_EQ(health.level, observability::AdapterHealthLevel::error);
  EXPECT_STREQ(health.reason, "adapter_telemetry_stale");
}

TEST(AdapterObservability, FullyKnownFreshSnapshotIsHealthy)
{
  const auto sampled_at = observability::AdapterSteadyTime{};
  observability::AdapterSnapshot snapshot;
  snapshot.connection_known = true;
  snapshot.connected = true;
  snapshot.telemetry_sample_known = true;
  snapshot.telemetry_sample_at = sampled_at;
  snapshot.battery_known = true;
  snapshot.battery_presence_known = true;
  snapshot.battery_present = true;
  snapshot.battery_fraction = 0.75F;
  snapshot.battery_sample_known = true;
  snapshot.battery_sample_at = sampled_at;
  snapshot.control_mode_known = true;
  snapshot.control_mode = "1(standing)";
  snapshot.posture_known = true;
  snapshot.posture = "standing";
  snapshot.authority_known = true;
  snapshot.authority_state = "acquired";

  const auto health = observability::assess_adapter_health(
    snapshot, sampled_at + 100ms, 1500ms, 15s);
  EXPECT_EQ(health.level, observability::AdapterHealthLevel::ok);
  EXPECT_STREQ(health.reason, "adapter_telemetry_ok");
}

TEST(AdapterObservability, StaleBatteryNeverLooksHealthy)
{
  const auto sampled_at = observability::AdapterSteadyTime{};
  observability::AdapterSnapshot snapshot;
  snapshot.connection_known = true;
  snapshot.connected = true;
  snapshot.telemetry_sample_known = true;
  snapshot.telemetry_sample_at = sampled_at + 20s;
  snapshot.battery_known = true;
  snapshot.battery_presence_known = true;
  snapshot.battery_present = true;
  snapshot.battery_fraction = 0.75F;
  snapshot.battery_sample_known = true;
  snapshot.battery_sample_at = sampled_at;
  snapshot.control_mode_known = true;
  snapshot.posture_known = true;
  snapshot.authority_known = true;

  const auto health = observability::assess_adapter_health(
    snapshot, sampled_at + 20s, 1500ms, 15s);
  EXPECT_EQ(health.level, observability::AdapterHealthLevel::warning);
  EXPECT_STREQ(health.reason, "adapter_battery_stale");
}

TEST(AdapterObservability, UnrecognizedPostureNeverLooksHealthy)
{
  const auto now = observability::AdapterSteadyTime{} + 100ms;
  observability::AdapterSnapshot snapshot;
  snapshot.connection_known = true;
  snapshot.connected = true;
  snapshot.telemetry_sample_known = true;
  snapshot.telemetry_sample_at = observability::AdapterSteadyTime{};
  snapshot.battery_presence_known = true;
  snapshot.battery_present = true;
  snapshot.battery_known = true;
  snapshot.battery_sample_known = true;
  snapshot.battery_sample_at = observability::AdapterSteadyTime{};
  snapshot.control_mode_known = true;
  snapshot.control_mode = "999(unknown)";
  snapshot.posture_known = false;
  snapshot.authority_known = true;

  const auto health = observability::assess_adapter_health(snapshot, now, 1500ms, 15s);
  EXPECT_EQ(health.level, observability::AdapterHealthLevel::warning);
  EXPECT_STREQ(health.reason, "adapter_posture_unknown");
}

TEST(AdapterObservability, ConfirmedAbsentBatteryIsNeverMaskedByUnknownFields)
{
  observability::AdapterSnapshot snapshot;
  snapshot.battery_presence_known = true;
  snapshot.battery_present = false;

  const auto health = observability::assess_adapter_health(
    snapshot, observability::AdapterSteadyTime{}, 1500ms, 15s);
  EXPECT_EQ(health.level, observability::AdapterHealthLevel::error);
  EXPECT_STREQ(health.reason, "adapter_battery_not_present");
}

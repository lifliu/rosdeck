#include "rosdeck_robot_bridge/velocity_safety.hpp"

#include <chrono>
#include <initializer_list>
#include <limits>
#include <optional>

#include <gtest/gtest.h>

namespace velocity_safety = rosdeck_robot_bridge::velocity_safety;
using namespace std::chrono_literals;

TEST(VelocitySafety, RejectsNonFiniteValues)
{
  const velocity_safety::Limits limits;
  EXPECT_EQ(
    velocity_safety::condition(
      std::numeric_limits<double>::quiet_NaN(), 0.0, 0.0, limits).decision,
    velocity_safety::Decision::invalid);
  EXPECT_EQ(
    velocity_safety::condition(
      0.0, std::numeric_limits<double>::infinity(), 0.0, limits).decision,
    velocity_safety::Decision::invalid);
  EXPECT_EQ(
    velocity_safety::condition(
      0.0, 0.0, -std::numeric_limits<double>::infinity(), limits).decision,
    velocity_safety::Decision::invalid);
}

TEST(VelocitySafety, AppliesProductLimitsIncludingReverseLimit)
{
  velocity_safety::Limits limits;
  limits.max_forward = 0.6;
  limits.max_reverse = 0.25;
  limits.max_lateral = 0.3;
  limits.max_yaw = 0.8;

  const auto positive = velocity_safety::condition(3.0, -2.0, 4.0, limits);
  EXPECT_EQ(positive.decision, velocity_safety::Decision::motion);
  EXPECT_DOUBLE_EQ(positive.vx, 0.6);
  EXPECT_DOUBLE_EQ(positive.vy, -0.3);
  EXPECT_DOUBLE_EQ(positive.yaw, 0.8);
  EXPECT_TRUE(positive.limited);

  const auto reverse = velocity_safety::condition(-3.0, 0.0, 0.0, limits);
  EXPECT_DOUBLE_EQ(reverse.vx, -0.25);
}

TEST(VelocitySafety, ConvertsZeroAndDeadbandOnlyCommandsToStop)
{
  const velocity_safety::Limits limits;

  const auto zero = velocity_safety::condition(0.0, 0.0, 0.0, limits);
  EXPECT_EQ(zero.decision, velocity_safety::Decision::stop);
  EXPECT_FALSE(zero.stopped_by_deadband);

  const auto deadband = velocity_safety::condition(0.04, -0.09, 0.09, limits);
  EXPECT_EQ(deadband.decision, velocity_safety::Decision::stop);
  EXPECT_TRUE(deadband.stopped_by_deadband);
  EXPECT_DOUBLE_EQ(deadband.vx, 0.0);
  EXPECT_DOUBLE_EQ(deadband.vy, 0.0);
  EXPECT_DOUBLE_EQ(deadband.yaw, 0.0);
}

TEST(VelocitySafety, CanDisableAnAxisWithAZeroLimit)
{
  velocity_safety::Limits limits;
  limits.max_lateral = 0.0;

  const auto command = velocity_safety::condition(0.0, 1.0, 0.0, limits);
  EXPECT_EQ(command.decision, velocity_safety::Decision::stop);
  EXPECT_TRUE(command.stopped_by_deadband);
  EXPECT_DOUBLE_EQ(command.vy, 0.0);
}

TEST(VelocitySafety, WatchdogOnlyExpiresForActiveMotion)
{
  const auto start = std::chrono::steady_clock::time_point{};
  const std::optional<std::chrono::steady_clock::time_point> last_command{start};

  EXPECT_FALSE(velocity_safety::watchdog_expired(true, last_command, start + 249ms, 250ms));
  EXPECT_TRUE(velocity_safety::watchdog_expired(true, last_command, start + 250ms, 250ms));
  EXPECT_FALSE(velocity_safety::watchdog_expired(false, last_command, start + 1s, 250ms));
  EXPECT_FALSE(velocity_safety::watchdog_expired(true, std::nullopt, start + 1s, 250ms));
}

TEST(VelocitySafety, IdleZeroIsEdgeTriggeredButWatchdogStillRetriesFailedStop)
{
  const auto start = std::chrono::steady_clock::time_point{};
  const std::optional<std::chrono::steady_clock::time_point> failed_stop_at{start};

  EXPECT_FALSE(velocity_safety::idle_zero_requires_sdk_stop(false, false));
  EXPECT_TRUE(velocity_safety::idle_zero_requires_sdk_stop(true, false));
  EXPECT_FALSE(velocity_safety::idle_zero_requires_sdk_stop(true, true));

  // Suppressing repeated periodic zeros does not clear possible motion. A
  // failed SDK stop therefore remains eligible for the independent watchdog.
  EXPECT_TRUE(velocity_safety::watchdog_expired(
      true, failed_stop_at, start + 250ms, 250ms));
}

TEST(VelocitySafety, AnySdkMoveFailureRequiresImmediateStop)
{
  const auto success = velocity_safety::sdk_move_result_policy(0);
  EXPECT_TRUE(success.accepted);
  EXPECT_FALSE(success.force_stop);
  EXPECT_FALSE(success.arm_watchdog_until_stop_confirmed);

  for (const uint32_t failure : {0x3013U, 0xFFFFFFFFU}) {
    const auto policy = velocity_safety::sdk_move_result_policy(failure);
    EXPECT_FALSE(policy.accepted);
    EXPECT_TRUE(policy.force_stop);
    EXPECT_TRUE(policy.arm_watchdog_until_stop_confirmed);
  }
}

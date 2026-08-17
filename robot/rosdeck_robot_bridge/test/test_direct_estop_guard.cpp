#include "rosdeck_robot_bridge/direct_estop_guard.hpp"

#include <chrono>

#include <gtest/gtest.h>

namespace direct_estop = rosdeck_robot_bridge::direct_estop;
using namespace std::chrono_literals;

TEST(DirectEstopGuard, ThirdSuccessfulAttemptConfirmsIncident)
{
  direct_estop::Guard guard;
  const direct_estop::Time start{};
  guard.begin(start);

  const auto first = guard.start_attempt(start);
  ASSERT_TRUE(first.has_value());
  EXPECT_EQ(
    guard.complete_attempt(*first, false, start, 200ms),
    direct_estop::Completion::retry_scheduled);
  EXPECT_FALSE(guard.start_attempt(start + 199ms).has_value());

  const auto second = guard.start_attempt(start + 200ms);
  ASSERT_TRUE(second.has_value());
  EXPECT_EQ(
    guard.complete_attempt(*second, false, start + 200ms, 200ms),
    direct_estop::Completion::retry_scheduled);

  const auto third = guard.start_attempt(start + 400ms);
  ASSERT_TRUE(third.has_value());
  EXPECT_EQ(
    guard.complete_attempt(*third, true, start + 400ms, 200ms),
    direct_estop::Completion::confirmed);
  EXPECT_TRUE(guard.reset_allowed(true));
  EXPECT_EQ(guard.attempts(), 3U);
}

TEST(DirectEstopGuard, ExhaustedAndPendingStopsCannotBeReset)
{
  direct_estop::Guard guard;
  const direct_estop::Time start{};
  guard.begin(start);
  EXPECT_FALSE(guard.reset_allowed(true));

  for (uint32_t index = 0; index < direct_estop::Guard::max_attempts; ++index) {
    const auto at = start + std::chrono::milliseconds(index * 200);
    const auto token = guard.start_attempt(at);
    ASSERT_TRUE(token.has_value());
    EXPECT_FALSE(guard.reset_allowed(true));
    guard.complete_attempt(*token, false, at, 200ms);
  }

  EXPECT_FALSE(guard.retry_pending());
  EXPECT_FALSE(guard.in_flight());
  EXPECT_FALSE(guard.confirmed());
  EXPECT_FALSE(guard.reset_allowed(true));
}

TEST(DirectEstopGuard, StaleCompletionCannotConfirmNewIncident)
{
  direct_estop::Guard guard;
  const direct_estop::Time start{};
  guard.begin(start);
  const auto old_attempt = guard.start_attempt(start);
  ASSERT_TRUE(old_attempt.has_value());

  const auto new_incident = guard.begin(start + 1ms);
  EXPECT_EQ(
    guard.complete_attempt(*old_attempt, true, start + 1ms, 200ms),
    direct_estop::Completion::stale);
  EXPECT_EQ(guard.incident(), new_incident);
  EXPECT_FALSE(guard.confirmed());
  EXPECT_FALSE(guard.reset_allowed(true));

  const auto current_attempt = guard.start_attempt(start + 1ms);
  ASSERT_TRUE(current_attempt.has_value());
  EXPECT_EQ(*current_attempt, new_incident);
  EXPECT_EQ(
    guard.complete_attempt(*current_attempt, true, start + 1ms, 200ms),
    direct_estop::Completion::confirmed);
  EXPECT_TRUE(guard.reset_allowed(true));
}

TEST(DirectEstopGuard, NewControlSessionInvalidatesStartupConfirmation)
{
  direct_estop::Guard guard;
  const direct_estop::Time start{};
  guard.begin(start);
  const auto startup_attempt = guard.start_attempt(start);
  ASSERT_TRUE(startup_attempt.has_value());
  EXPECT_EQ(
    guard.complete_attempt(*startup_attempt, true, start, 200ms),
    direct_estop::Completion::confirmed);
  ASSERT_TRUE(guard.reset_allowed(true));

  const auto session_incident = guard.restart_for_control_session(start + 1ms);
  EXPECT_FALSE(guard.reset_allowed(true));
  const auto session_attempt = guard.start_attempt(start + 1ms);
  ASSERT_TRUE(session_attempt.has_value());
  EXPECT_EQ(*session_attempt, session_incident);
  EXPECT_EQ(
    guard.complete_attempt(*session_attempt, true, start + 1ms, 200ms),
    direct_estop::Completion::confirmed);
  EXPECT_TRUE(guard.reset_allowed(true));
}

TEST(DirectEstopGuard, LatchedStopAllowsAuthorizationOnlyAcquire)
{
  EXPECT_TRUE(direct_estop::control_action_allowed_while_estop_latched("acquire"));
  EXPECT_TRUE(direct_estop::control_action_allowed_while_estop_latched("heartbeat"));
  EXPECT_TRUE(direct_estop::control_action_allowed_while_estop_latched("release"));
  EXPECT_TRUE(direct_estop::control_action_allowed_while_estop_latched("status"));
  EXPECT_FALSE(direct_estop::control_action_allowed_while_estop_latched("move"));
}

TEST(DirectEstopGuard, ResetRequiresAnAcquiredLeaseWhenAdapterUsesControlSessions)
{
  EXPECT_FALSE(direct_estop::control_session_ready_for_estop_reset(true, "available"));
  EXPECT_FALSE(direct_estop::control_session_ready_for_estop_reset(true, "acquiring:app-1"));
  EXPECT_FALSE(direct_estop::control_session_ready_for_estop_reset(true, "acquired:"));
  EXPECT_TRUE(direct_estop::control_session_ready_for_estop_reset(true, "acquired:app-1"));
  EXPECT_TRUE(direct_estop::control_session_ready_for_estop_reset(false, "unsupported"));
}

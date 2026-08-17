#include "rosdeck_robot_bridge/cmd_vel_arbiter.hpp"

#include <chrono>
#include <limits>

#include <gtest/gtest.h>

namespace arbiter = rosdeck_robot_bridge::cmd_vel_arbiter;
using namespace std::chrono_literals;

namespace
{

constexpr int64_t kRosNowNs = 1'700'000'000'000'000'000LL;

arbiter::RawTwist moving_twist()
{
  arbiter::RawTwist twist;
  twist.linear_x = 0.4;
  twist.angular_z = 0.5;
  return twist;
}

}  // namespace

TEST(CmdVelArbiter, SourceTimeoutForcesZero)
{
  arbiter::Arbiter subject;
  const auto now = arbiter::SteadyTime{};
  EXPECT_EQ(
    subject.ingest_stamped(
      arbiter::Source::teleop, moving_twist(), kRosNowNs, kRosNowNs, now),
    arbiter::SourceHealth::ready);
  EXPECT_EQ(subject.decide(now + 249ms, "acquired:app-test").source, arbiter::Source::teleop);
  const auto expired = subject.decide(now + 250ms, "acquired:app-test");
  EXPECT_EQ(expired.source, arbiter::Source::none);
  EXPECT_EQ(expired.reason, arbiter::DecisionReason::no_fresh_authorized_source);
}

TEST(CmdVelArbiter, FixedPriorityIsTeleopThenDockingThenNavigation)
{
  EXPECT_EQ(
    arbiter::select_highest_priority_source(true, true, true), arbiter::Source::teleop);
  EXPECT_EQ(
    arbiter::select_highest_priority_source(false, true, true), arbiter::Source::docking);
  EXPECT_EQ(
    arbiter::select_highest_priority_source(false, false, true), arbiter::Source::navigation);
}

TEST(CmdVelArbiter, OwnerPrefixOnlyAllowsItsMatchingSource)
{
  arbiter::Arbiter subject;
  const auto now = arbiter::SteadyTime{};
  subject.ingest_stamped(
    arbiter::Source::teleop, moving_twist(), kRosNowNs, kRosNowNs, now);
  subject.ingest_stamped(
    arbiter::Source::docking, moving_twist(), kRosNowNs, kRosNowNs, now);
  subject.ingest_navigation(moving_twist(), now);

  EXPECT_EQ(subject.decide(now, "acquired:app-123").source, arbiter::Source::teleop);
  EXPECT_EQ(subject.decide(now, "acquired:mission-123").source, arbiter::Source::navigation);
  EXPECT_EQ(subject.decide(now, "acquired:docking-123").source, arbiter::Source::docking);
  EXPECT_EQ(subject.decide(now, "available").source, arbiter::Source::none);
  EXPECT_EQ(subject.decide(now, "acquired:operator-123").source, arbiter::Source::none);
}

TEST(CmdVelArbiter, EstopLatchesAndResetCannotResumeAnOldCommand)
{
  arbiter::Arbiter subject;
  const auto now = arbiter::SteadyTime{};
  subject.ingest_stamped(
    arbiter::Source::teleop, moving_twist(), kRosNowNs, kRosNowNs, now);
  subject.set_estop(true);
  EXPECT_TRUE(subject.estop_latched());
  EXPECT_EQ(
    subject.decide(now, "acquired:app-test").reason,
    arbiter::DecisionReason::estop_latched);

  subject.ingest_stamped(
    arbiter::Source::teleop, moving_twist(), kRosNowNs, kRosNowNs, now);
  subject.set_estop(false);
  EXPECT_FALSE(subject.estop_latched());
  EXPECT_EQ(subject.decide(now, "acquired:app-test").source, arbiter::Source::none);
}

TEST(CmdVelArbiter, InvalidInputImmediatelyInvalidatesPriorSource)
{
  arbiter::Arbiter subject;
  const auto now = arbiter::SteadyTime{};
  subject.ingest_stamped(
    arbiter::Source::teleop, moving_twist(), kRosNowNs, kRosNowNs, now);
  auto invalid = moving_twist();
  invalid.angular_x = std::numeric_limits<double>::quiet_NaN();
  EXPECT_EQ(
    subject.ingest_stamped(
      arbiter::Source::teleop, invalid, kRosNowNs, kRosNowNs, now + 1ms),
    arbiter::SourceHealth::invalid_non_finite);
  EXPECT_EQ(subject.decide(now + 1ms, "acquired:app-test").source, arbiter::Source::none);
  EXPECT_EQ(
    subject.ingest_stamped(
      arbiter::Source::teleop, moving_twist(), 0, kRosNowNs, now + 2ms),
    arbiter::SourceHealth::invalid_stamp);
  EXPECT_EQ(subject.stamp_rejections(arbiter::Source::teleop), 1U);
}

TEST(CmdVelArbiter, PublisherConflictImmediatelyInvalidatesPriorSource)
{
  arbiter::Arbiter subject;
  const auto now = arbiter::SteadyTime{};
  subject.ingest_navigation(moving_twist(), now);
  EXPECT_EQ(subject.decide(now, "acquired:mission-test").source, arbiter::Source::navigation);

  subject.invalidate_source(
    arbiter::Source::navigation, arbiter::SourceHealth::publisher_conflict);
  EXPECT_EQ(
    subject.source_health(arbiter::Source::navigation, now),
    arbiter::SourceHealth::publisher_conflict);
  EXPECT_EQ(subject.decide(now, "acquired:mission-test").source, arbiter::Source::none);
}

TEST(CmdVelArbiter, DefaultModeReportsClockSkewButUsesArrivalTimeout)
{
  arbiter::Arbiter subject;
  const auto now = arbiter::SteadyTime{};
  EXPECT_EQ(
    subject.ingest_stamped(
      arbiter::Source::teleop, moving_twist(), kRosNowNs - 1'000'000'000LL,
      kRosNowNs, now),
    arbiter::SourceHealth::ready);
  EXPECT_EQ(
    subject.stamp_health(arbiter::Source::teleop), arbiter::SourceHealth::stale_stamp);
  EXPECT_EQ(subject.stamp_skew_events(arbiter::Source::teleop), 1U);
  EXPECT_EQ(subject.stamp_rejections(arbiter::Source::teleop), 0U);
  EXPECT_EQ(subject.decide(now, "acquired:app-test").source, arbiter::Source::teleop);
  EXPECT_EQ(subject.decide(now + 250ms, "acquired:app-test").source, arbiter::Source::none);
}

TEST(CmdVelArbiter, StrictStampModeRejectsStaleAndFutureMessages)
{
  arbiter::Config config;
  config.enforce_stamp_freshness = true;
  arbiter::Arbiter subject(config);
  const auto now = arbiter::SteadyTime{};
  EXPECT_EQ(
    subject.ingest_stamped(
      arbiter::Source::teleop, moving_twist(), kRosNowNs - 1'000'000'000LL,
      kRosNowNs, now),
    arbiter::SourceHealth::stale_stamp);
  EXPECT_EQ(
    subject.ingest_stamped(
      arbiter::Source::docking, moving_twist(), kRosNowNs + 501'000'000LL,
      kRosNowNs, now),
    arbiter::SourceHealth::future_stamp);
  EXPECT_EQ(subject.stamp_rejections(arbiter::Source::teleop), 1U);
  EXPECT_EQ(subject.stamp_rejections(arbiter::Source::docking), 1U);
}

TEST(CmdVelArbiter, NavigationUsesFiniteCheckAndArrivalTimeout)
{
  arbiter::Arbiter subject;
  const auto now = arbiter::SteadyTime{};
  EXPECT_EQ(
    subject.ingest_navigation(moving_twist(), now), arbiter::SourceHealth::ready);
  EXPECT_EQ(
    subject.decide(now + 249ms, "acquired:mission-test").source,
    arbiter::Source::navigation);

  auto invalid = moving_twist();
  invalid.linear_y = std::numeric_limits<double>::infinity();
  EXPECT_EQ(
    subject.ingest_navigation(invalid, now + 1ms),
    arbiter::SourceHealth::invalid_non_finite);
  EXPECT_EQ(subject.decide(now + 1ms, "acquired:mission-test").source, arbiter::Source::none);
}

TEST(CmdVelArbiter, DockingTwistUsesFiniteCheckAndArrivalTimeout)
{
  arbiter::Arbiter subject;
  const auto now = arbiter::SteadyTime{};
  EXPECT_EQ(
    subject.ingest_unstamped(arbiter::Source::docking, moving_twist(), now),
    arbiter::SourceHealth::ready);
  EXPECT_EQ(
    subject.decide(now + 249ms, "acquired:docking-test").source,
    arbiter::Source::docking);
  EXPECT_EQ(
    subject.decide(now + 250ms, "acquired:docking-test").source,
    arbiter::Source::none);
}

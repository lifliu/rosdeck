#include "rosdeck_robot_bridge/safety_supervisor.hpp"

#include <chrono>

#include <gtest/gtest.h>

namespace supervisor = rosdeck_robot_bridge::safety_supervisor;
using namespace std::chrono_literals;

TEST(SafetySupervisor, StartsLatchedAndOnlyExplicitArmClearsIt)
{
  supervisor::StateMachine subject;
  const auto now = supervisor::SteadyTime{};

  EXPECT_TRUE(subject.estop_active());
  EXPECT_EQ(subject.reason(), supervisor::LatchReason::startup);
  EXPECT_FALSE(subject.arm(now).success);

  subject.heartbeat(now);
  const auto armed = subject.arm(now + 1ms);
  EXPECT_TRUE(armed.success);
  EXPECT_FALSE(subject.estop_active());
  EXPECT_EQ(subject.reason(), supervisor::LatchReason::armed);
}

TEST(SafetySupervisor, FalseRequestNeverClearsButTrueImmediatelyRelatches)
{
  supervisor::StateMachine subject;
  const auto now = supervisor::SteadyTime{};
  subject.heartbeat(now);
  ASSERT_TRUE(subject.arm(now + 1ms).success);

  EXPECT_FALSE(subject.observe_estop_request(false));
  EXPECT_FALSE(subject.estop_active());
  EXPECT_TRUE(subject.observe_estop_request(true));
  EXPECT_TRUE(subject.estop_active());
  EXPECT_EQ(subject.reason(), supervisor::LatchReason::estop_request);
  EXPECT_EQ(subject.estop_request_count(), 1U);

  EXPECT_FALSE(subject.observe_estop_request(false));
  EXPECT_TRUE(subject.estop_active());
}

TEST(SafetySupervisor, MissedHeartbeatLatchesAndRequiresAnotherArm)
{
  supervisor::StateMachine subject;
  const auto now = supervisor::SteadyTime{};
  subject.heartbeat(now);
  ASSERT_TRUE(subject.arm(now + 1ms).success);

  EXPECT_FALSE(subject.heartbeat(now + 499ms));
  EXPECT_FALSE(subject.estop_active());
  EXPECT_TRUE(subject.heartbeat(now + 999ms));
  EXPECT_TRUE(subject.estop_active());
  EXPECT_EQ(subject.reason(), supervisor::LatchReason::heartbeat_deadline_missed);

  // The resumed heartbeat makes the monitor healthy, but never auto-clears.
  EXPECT_TRUE(subject.heartbeat_fresh(now + 1000ms));
  EXPECT_TRUE(subject.estop_active());
  EXPECT_TRUE(subject.arm(now + 1000ms).success);
  EXPECT_FALSE(subject.estop_active());
}

TEST(SafetySupervisor, StaleMonitorRejectsArmUntilHeartbeatResumes)
{
  supervisor::StateMachine subject;
  const auto now = supervisor::SteadyTime{};
  subject.heartbeat(now);

  const auto stale = subject.arm(now + 500ms);
  EXPECT_FALSE(stale.success);
  EXPECT_TRUE(subject.estop_active());
  EXPECT_EQ(subject.reason(), supervisor::LatchReason::heartbeat_deadline_missed);

  subject.heartbeat(now + 501ms);
  EXPECT_TRUE(subject.arm(now + 502ms).success);
}

TEST(SafetySupervisor, ManualLatchNeedsExplicitRearm)
{
  supervisor::StateMachine subject;
  const auto now = supervisor::SteadyTime{};
  subject.heartbeat(now);
  ASSERT_TRUE(subject.arm(now + 1ms).success);

  subject.manual_latch();
  EXPECT_TRUE(subject.estop_active());
  EXPECT_EQ(subject.reason(), supervisor::LatchReason::manual_latch);
  EXPECT_EQ(subject.latch_count(), 2U);
  EXPECT_FALSE(subject.observe_estop_request(false));
  EXPECT_TRUE(subject.estop_active());
}

TEST(SafetySupervisor, ShutdownReturnsOutputToFailClosedState)
{
  supervisor::StateMachine subject;
  const auto now = supervisor::SteadyTime{};
  subject.heartbeat(now);
  ASSERT_TRUE(subject.arm(now + 1ms).success);

  subject.shutdown_latch();
  EXPECT_TRUE(subject.estop_active());
  EXPECT_EQ(subject.reason(), supervisor::LatchReason::shutdown);
}

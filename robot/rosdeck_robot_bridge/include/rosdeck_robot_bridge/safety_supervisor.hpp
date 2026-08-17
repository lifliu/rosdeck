#pragma once

#include <chrono>
#include <cstdint>

namespace rosdeck_robot_bridge
{
namespace safety_supervisor
{

using SteadyClock = std::chrono::steady_clock;
using SteadyTime = SteadyClock::time_point;

enum class LatchReason
{
  startup,
  armed,
  estop_request,
  manual_latch,
  heartbeat_deadline_missed,
  shutdown,
};

inline const char * reason_name(LatchReason reason)
{
  switch (reason) {
    case LatchReason::startup:
      return "startup";
    case LatchReason::armed:
      return "armed";
    case LatchReason::estop_request:
      return "estop_request";
    case LatchReason::manual_latch:
      return "manual_latch";
    case LatchReason::heartbeat_deadline_missed:
      return "heartbeat_deadline_missed";
    case LatchReason::shutdown:
      return "shutdown";
  }
  return "unknown";
}

struct Config
{
  std::chrono::milliseconds heartbeat_deadline{500};
};

struct ArmResult
{
  bool success{false};
  const char * message{"supervisor_monitor_not_started"};
};

/**
 * Pure safety state machine used by the ROS-facing supervisor node.
 *
 * False request messages are deliberately ignored: only the explicit arm
 * operation may clear the supervisor latch.  The downstream Bridge maintains
 * its own latch and must be reset separately after the supervisor is armed.
 */
class StateMachine
{
public:
  explicit StateMachine(Config config = {})
  : config_(config) {}

  bool estop_active() const {return latched_;}
  LatchReason reason() const {return reason_;}
  uint64_t heartbeat_sequence() const {return heartbeat_sequence_;}
  uint64_t estop_request_count() const {return estop_request_count_;}
  uint64_t arm_count() const {return arm_count_;}
  uint64_t latch_count() const {return latch_count_;}
  std::chrono::milliseconds last_heartbeat_gap() const {return last_heartbeat_gap_;}

  /** Record one periodic supervisor tick and latch if its deadline was missed. */
  bool heartbeat(SteadyTime now)
  {
    bool missed = false;
    if (heartbeat_started_) {
      const auto gap = std::chrono::duration_cast<std::chrono::milliseconds>(
        now - last_heartbeat_);
      last_heartbeat_gap_ = gap;
      if (gap < std::chrono::milliseconds::zero() || gap >= config_.heartbeat_deadline) {
        latch(LatchReason::heartbeat_deadline_missed);
        missed = true;
      }
    }
    last_heartbeat_ = now;
    heartbeat_started_ = true;
    ++heartbeat_sequence_;
    return missed;
  }

  /** Any true request immediately asserts E-stop. False can never clear it. */
  bool observe_estop_request(bool active)
  {
    if (!active) {
      return false;
    }
    ++estop_request_count_;
    latch(LatchReason::estop_request);
    return true;
  }

  ArmResult arm(SteadyTime now)
  {
    if (!heartbeat_started_) {
      latch(LatchReason::heartbeat_deadline_missed);
      return {false, "supervisor_monitor_not_started"};
    }
    const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(
      now - last_heartbeat_);
    if (age < std::chrono::milliseconds::zero() || age >= config_.heartbeat_deadline) {
      latch(LatchReason::heartbeat_deadline_missed);
      return {false, "supervisor_heartbeat_stale"};
    }
    if (!latched_) {
      return {true, "supervisor_already_armed_bridge_reset_still_required"};
    }
    latched_ = false;
    reason_ = LatchReason::armed;
    ++arm_count_;
    return {true, "supervisor_armed_bridge_reset_still_required"};
  }

  void manual_latch() {latch(LatchReason::manual_latch);}
  void shutdown_latch() {latch(LatchReason::shutdown);}

  bool heartbeat_fresh(SteadyTime now) const
  {
    if (!heartbeat_started_) {
      return false;
    }
    const auto age = now - last_heartbeat_;
    return age >= SteadyClock::duration::zero() && age < config_.heartbeat_deadline;
  }

  int64_t heartbeat_age_ms(SteadyTime now) const
  {
    if (!heartbeat_started_) {
      return -1;
    }
    return std::chrono::duration_cast<std::chrono::milliseconds>(
      now - last_heartbeat_).count();
  }

private:
  void latch(LatchReason reason)
  {
    if (!latched_) {
      ++latch_count_;
    }
    latched_ = true;
    reason_ = reason;
  }

  Config config_;
  bool latched_{true};
  bool heartbeat_started_{false};
  LatchReason reason_{LatchReason::startup};
  SteadyTime last_heartbeat_{};
  std::chrono::milliseconds last_heartbeat_gap_{0};
  uint64_t heartbeat_sequence_{0};
  uint64_t estop_request_count_{0};
  uint64_t arm_count_{0};
  uint64_t latch_count_{1};
};

}  // namespace safety_supervisor
}  // namespace rosdeck_robot_bridge

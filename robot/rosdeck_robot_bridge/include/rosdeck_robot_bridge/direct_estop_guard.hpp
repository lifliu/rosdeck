#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>

namespace rosdeck_robot_bridge::direct_estop
{

using Clock = std::chrono::steady_clock;
using Time = Clock::time_point;

enum class Completion
{
  stale,
  confirmed,
  retry_scheduled,
  exhausted,
};

/**
 * Executor-owned state for a bounded direct adapter stop.
 *
 * The incident token prevents an asynchronous completion from an older latch
 * from confirming a newer one. The class performs no I/O and is intentionally
 * usable in deterministic unit tests.
 */
class Guard
{
public:
  static constexpr uint32_t max_attempts = 3;

  uint64_t begin(Time now)
  {
    ++incident_;
    attempts_ = 0;
    confirmed_ = false;
    retry_pending_ = true;
    retry_at_ = now;
    return incident_;
  }

  /**
   * Invalidate every stop confirmation obtained before a control session was
   * created (or before an acquiring session became connected).
   *
   * A startup E-stop is commonly confirmed while the vendor SDK is idle. That
   * confirmation says nothing about a later SDK session, so it must never be
   * reused to clear the latch after control acquisition.
   */
  uint64_t restart_for_control_session(Time now)
  {
    return begin(now);
  }

  void cancel()
  {
    ++incident_;
    attempts_ = 0;
    confirmed_ = false;
    retry_pending_ = false;
  }

  std::optional<uint64_t> start_attempt(Time now)
  {
    if (!retry_pending_ || in_flight_incident_.has_value() || now < retry_at_ ||
      attempts_ >= max_attempts)
    {
      return std::nullopt;
    }
    retry_pending_ = false;
    in_flight_incident_ = incident_;
    ++attempts_;
    return incident_;
  }

  Completion complete_attempt(
    uint64_t incident, bool success, Time now,
    std::chrono::milliseconds retry_period)
  {
    if (!in_flight_incident_ || *in_flight_incident_ != incident) {
      return Completion::stale;
    }
    in_flight_incident_.reset();
    if (incident != incident_) {
      return Completion::stale;
    }
    if (success) {
      confirmed_ = true;
      retry_pending_ = false;
      return Completion::confirmed;
    }
    confirmed_ = false;
    if (attempts_ < max_attempts) {
      retry_pending_ = true;
      retry_at_ = now + retry_period;
      return Completion::retry_scheduled;
    }
    retry_pending_ = false;
    return Completion::exhausted;
  }

  bool reset_allowed(bool confirmation_required) const
  {
    return !confirmation_required ||
           (confirmed_ && !retry_pending_ && !in_flight_incident_.has_value());
  }

  uint64_t incident() const {return incident_;}
  uint32_t attempts() const {return attempts_;}
  bool confirmed() const {return confirmed_;}
  bool retry_pending() const {return retry_pending_;}
  bool in_flight() const {return in_flight_incident_.has_value();}

private:
  uint64_t incident_{0};
  uint32_t attempts_{0};
  bool confirmed_{false};
  bool retry_pending_{false};
  Time retry_at_{};
  std::optional<uint64_t> in_flight_incident_;
};

inline bool control_action_allowed_while_estop_latched(const std::string & action)
{
  // The control plane remains available for safe recovery, including creation
  // of an authorization-only lease. Motion stays blocked by the arbiter and
  // actuator gates, and acquire must restart direct-stop confirmation.
  return action == "acquire" || action == "heartbeat" || action == "release" ||
         action == "status";
}

inline bool control_session_ready_for_estop_reset(
  bool lease_required, const std::string & control_status)
{
  constexpr char acquired_prefix[] = "acquired:";
  return !lease_required ||
         (control_status.rfind(acquired_prefix, 0) == 0 &&
          control_status.size() > sizeof(acquired_prefix) - 1);
}

}  // namespace rosdeck_robot_bridge::direct_estop

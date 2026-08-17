#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <optional>

namespace rosdeck_robot_bridge
{
namespace velocity_safety
{

constexpr double kMotionEpsilon = 0.0001;

struct Limits
{
  double forward_deadband{0.05};
  double lateral_deadband{0.1};
  double yaw_deadband{0.1};
  double max_forward{0.6};
  double max_reverse{0.3};
  double max_lateral{0.3};
  double max_yaw{0.8};
};

enum class Decision
{
  motion,
  stop,
  invalid,
};

struct Command
{
  Decision decision{Decision::invalid};
  double vx{0.0};
  double vy{0.0};
  double yaw{0.0};
  bool limited{false};
  bool stopped_by_deadband{false};
};

inline bool has_motion(double vx, double vy, double yaw)
{
  return std::abs(vx) > kMotionEpsilon || std::abs(vy) > kMotionEpsilon ||
         std::abs(yaw) > kMotionEpsilon;
}

inline double condition_axis(double value, double deadband, double negative_limit,
  double positive_limit)
{
  if (std::abs(value) < deadband) {
    return 0.0;
  }
  return std::clamp(value, -negative_limit, positive_limit);
}

inline Command condition(double requested_vx, double requested_vy, double requested_yaw,
  const Limits & limits)
{
  Command command;
  if (!std::isfinite(requested_vx) || !std::isfinite(requested_vy) ||
    !std::isfinite(requested_yaw))
  {
    return command;
  }

  const bool requested_motion = has_motion(requested_vx, requested_vy, requested_yaw);
  command.vx = condition_axis(
    requested_vx, limits.forward_deadband, limits.max_reverse, limits.max_forward);
  command.vy = condition_axis(
    requested_vy, limits.lateral_deadband, limits.max_lateral, limits.max_lateral);
  command.yaw = condition_axis(
    requested_yaw, limits.yaw_deadband, limits.max_yaw, limits.max_yaw);
  command.limited =
    command.vx != requested_vx || command.vy != requested_vy || command.yaw != requested_yaw;

  if (has_motion(command.vx, command.vy, command.yaw)) {
    command.decision = Decision::motion;
  } else {
    command.decision = Decision::stop;
    command.stopped_by_deadband = requested_motion;
  }
  return command;
}

inline bool watchdog_expired(
  bool motion_active,
  const std::optional<std::chrono::steady_clock::time_point> & last_command,
  std::chrono::steady_clock::time_point now,
  std::chrono::milliseconds timeout)
{
  return motion_active && last_command.has_value() && now - *last_command >= timeout;
}

/**
 * Ordinary zero commands are an edge-triggered transition out of motion.
 *
 * The arbiter publishes its selected output periodically, including while it
 * is zero. Forwarding every idle sample into the vendor SDK can interfere with
 * posture transitions. A failed first stop deliberately leaves
 * `motion_active` true, but the periodic velocity watchdog (and the independent
 * direct E-stop path) owns subsequent retries instead of the idle stream.
 */
inline bool idle_zero_requires_sdk_stop(bool motion_active, bool stop_already_attempted)
{
  return motion_active && !stop_already_attempted;
}

struct SdkMoveResultPolicy
{
  bool accepted{false};
  bool force_stop{true};
  bool arm_watchdog_until_stop_confirmed{true};
};

constexpr SdkMoveResultPolicy sdk_move_result_policy(uint32_t result)
{
  return result == 0 ? SdkMoveResultPolicy{true, false, false} : SdkMoveResultPolicy{};
}

static_assert(
  sdk_move_result_policy(0).accepted && !sdk_move_result_policy(0).force_stop,
  "A successful SDK move must remain accepted without forcing stop");
static_assert(
  sdk_move_result_policy(0xFFFFFFFFU).force_stop &&
  sdk_move_result_policy(0xFFFFFFFFU).arm_watchdog_until_stop_confirmed,
  "An SDK move failure or exception sentinel must force stop and retain watchdog recovery");

}  // namespace velocity_safety
}  // namespace rosdeck_robot_bridge

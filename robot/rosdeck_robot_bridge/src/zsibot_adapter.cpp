#include "rosdeck_robot_bridge/robot_adapter.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <utility>

#ifdef ROSDECK_HAS_ZSIBOT_SDK
#include <geometry_msgs/msg/twist.hpp>
#if defined(ROSDECK_ZSIBOT_MODEL_ZSL1)
#include "zsl-1/highlevel.h"
#elif defined(ROSDECK_ZSIBOT_MODEL_ZSL1W)
#include "zsl-1w/highlevel.h"
#endif
#endif

namespace rosdeck_robot_bridge
{
namespace
{

#ifdef ROSDECK_HAS_ZSIBOT_SDK

using namespace std::chrono_literals;

#if defined(ROSDECK_ZSIBOT_MODEL_ZSL1)
using ZsibotHighLevel = mc_sdk::zsl_1::HighLevel;
constexpr char kZsibotModel[] = "zsl-1";
constexpr float kMinimumYawRate = 0.02F;
constexpr float kMaximumForwardVelocity = 3.0F;
#elif defined(ROSDECK_ZSIBOT_MODEL_ZSL1W)
using ZsibotHighLevel = mc_sdk::zsl_1w::HighLevel;
constexpr char kZsibotModel[] = "zsl-1w";
constexpr float kMinimumYawRate = 0.1F;
constexpr float kMaximumForwardVelocity = 3.7F;
#endif

constexpr float kMinimumForwardVelocity = 0.05F;
constexpr float kMinimumLateralVelocity = 0.1F;
constexpr float kMaximumLateralVelocity = 1.0F;
constexpr float kMaximumYawRate = 3.0F;
constexpr float kZeroEpsilon = 0.0001F;

std::string sdk_result(uint32_t code)
{
  const char * description = "unknown";
  switch (code) {
    case 0:
      description = "ok";
      break;
    case 0x3007:
      description = "state_machine_transition_failed";
      break;
    case 0x3009:
      description = "motor_angle_limit_exceeded";
      break;
    case 0x3010:
      description = "motor_disabled";
      break;
    case 0x3011:
      description = "motor_fault";
      break;
    case 0x3012:
      description = "motor_data_lost";
      break;
    case 0x3013:
      description = "velocity_command_out_of_range";
      break;
    default:
      break;
  }

  std::ostringstream stream;
  stream << "sdk_0x" << std::hex << std::setfill('0') << std::setw(4) << code << '_' <<
    description;
  return stream.str();
}

std::string control_mode(uint32_t mode)
{
#if defined(ROSDECK_ZSIBOT_MODEL_ZSL1W)
  switch (mode) {
    case 0:
      return "0(passive)";
    case 1:
      return "1(standing)";
    case 3:
      return "3(moving)";
    default:
      break;
  }
#else
  switch (mode) {
    case 0:
      return "0(passive)";
    case 1:
      return "1(standing)";
    case 10:
      return "10(free)";
    case 18:
      return "18(moving)";
    case 21:
      return "21(action)";
    case 51:
      return "51(lying_down)";
    default:
      break;
  }
#endif
  return std::to_string(mode) + "(unknown)";
}

bool is_ready_for_velocity(uint32_t mode)
{
#if defined(ROSDECK_ZSIBOT_MODEL_ZSL1W)
  return mode == 1 || mode == 3;
#else
  return mode == 1 || mode == 18;
#endif
}

bool is_standing_mode(uint32_t mode)
{
  return mode == 1;
}

bool is_moving_mode(uint32_t mode)
{
#if defined(ROSDECK_ZSIBOT_MODEL_ZSL1W)
  return mode == 3;
#else
  return mode == 18;
#endif
}

float condition_velocity(float value, float minimum, float maximum)
{
  if (std::abs(value) < minimum) {
    return 0.0F;
  }
  return std::clamp(value, -maximum, maximum);
}

bool has_motion(float vx, float vy, float yaw_rate)
{
  return std::abs(vx) > kZeroEpsilon || std::abs(vy) > kZeroEpsilon ||
         std::abs(yaw_rate) > kZeroEpsilon;
}

class ZsibotAdapter final : public RobotAdapter
{
public:
  explicit ZsibotAdapter(rclcpp::Node & node)
  : logger_(node.get_logger()), clock_(node.get_clock())
  {
    const auto local_ip = node.declare_parameter<std::string>(
      "zsibot.local_ip", "192.168.234.234");
    const auto local_port = node.declare_parameter<int64_t>(
      "zsibot.local_port", 43988);
    const auto dog_ip = node.declare_parameter<std::string>(
      "zsibot.dog_ip", "192.168.234.1");
    const auto velocity_topic = node.declare_parameter<std::string>(
      "zsibot.velocity_topic", "/vel_cmd");
    auto_stand_on_locomotion_ = node.declare_parameter<bool>(
      "zsibot.auto_stand_on_locomotion", true);
    const auto stand_timeout_sec = node.declare_parameter<int64_t>(
      "zsibot.stand_timeout_sec", 8);
    const auto stop_settle_ms = node.declare_parameter<int64_t>(
      "zsibot.stop_settle_ms", 300);
    const auto diagnostics_period_sec = node.declare_parameter<int64_t>(
      "zsibot.diagnostics_period_sec", 10);
    stand_timeout_ = std::chrono::seconds(std::max<int64_t>(1, stand_timeout_sec));
    stop_settle_time_ = std::chrono::milliseconds(std::max<int64_t>(0, stop_settle_ms));
    diagnostics_period_ =
      std::chrono::seconds(std::max<int64_t>(1, diagnostics_period_sec));

    RCLCPP_INFO(
      logger_,
      "Initializing Zsibot SDK: model=%s local=%s:%ld robot=%s velocity_topic=%s "
      "auto_stand=%s",
      kZsibotModel, local_ip.c_str(), static_cast<long>(local_port), dog_ip.c_str(),
      velocity_topic.c_str(), auto_stand_on_locomotion_ ? "true" : "false");
    highlevel_.initRobot(local_ip, static_cast<int>(local_port), dog_ip);

    velocity_subscription_ = node.create_subscription<geometry_msgs::msg::Twist>(
      velocity_topic, 10,
      [this](const geometry_msgs::msg::Twist::SharedPtr message) {
        handle_velocity(*message);
      });
    diagnostics_timer_ = node.create_wall_timer(250ms, [this]() {poll_sdk();});
    next_diagnostics_ = std::chrono::steady_clock::now();
  }

  std::string name() const override {return "zsibot";}

  void request_locomotion(CommandResult callback) override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    const bool connected = highlevel_.checkConnect();
    if (!connected) {
      RCLCPP_ERROR(
        logger_, "LOCO request rejected: model=%s SDK is not connected", kZsibotModel);
      callback(false, "sdk_not_connected");
      return;
    }

    const uint32_t mode = highlevel_.getCurrentCtrlmode();
    RCLCPP_INFO(
      logger_, "LOCO request received: model=%s connected=true mode=%s",
      kZsibotModel, control_mode(mode).c_str());
    if (is_ready_for_velocity(mode)) {
      callback(true, "already_ready");
      return;
    }
    if (!auto_stand_on_locomotion_) {
      callback(false, "not_standing_mode_" + std::to_string(mode));
      return;
    }

    const uint32_t result = highlevel_.standUp();
    RCLCPP_INFO(
      logger_, "LOCO auto-stand sent: before_mode=%s result=%s",
      control_mode(mode).c_str(), sdk_result(result).c_str());
    if (result != 0) {
      callback(false, sdk_result(result));
      return;
    }

    pending_locomotion_ = std::move(callback);
    locomotion_deadline_ = std::chrono::steady_clock::now() + stand_timeout_;
  }

  void request_posture(const std::string & command, CommandResult callback) override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    if (!highlevel_.checkConnect()) {
      RCLCPP_ERROR(
        logger_, "Posture request rejected: command=%s model=%s SDK is not connected",
        command.c_str(), kZsibotModel);
      callback(false, "sdk_not_connected");
      return;
    }

    const uint32_t before_mode = highlevel_.getCurrentCtrlmode();
    RCLCPP_INFO(
      logger_, "Posture request received: command=%s model=%s mode=%s motion_active=%s",
      command.c_str(), kZsibotModel, control_mode(before_mode).c_str(),
      motion_active_ ? "true" : "false");

    if (command == "stand" && is_standing_mode(before_mode)) {
      RCLCPP_INFO(logger_, "Posture command stand skipped: robot is already ready");
      callback(true, "already_standing");
      return;
    }

    if (motion_active_ || is_moving_mode(before_mode)) {
      const uint32_t stop_result = highlevel_.move(0.0F, 0.0F, 0.0F);
      RCLCPP_INFO(
        logger_, "Stop before posture: command=%s result=%s settle_ms=%ld",
        command.c_str(), sdk_result(stop_result).c_str(),
        static_cast<long>(stop_settle_time_.count()));
      if (stop_result != 0) {
        callback(false, "stop_before_posture_" + sdk_result(stop_result));
        return;
      }
      motion_active_ = false;
      std::this_thread::sleep_for(stop_settle_time_);
    }

    const uint32_t result = command == "stand" ? highlevel_.standUp() : highlevel_.lieDown();
    const uint32_t after_mode = highlevel_.getCurrentCtrlmode();
    RCLCPP_INFO(
      logger_, "Posture SDK result: command=%s before_mode=%s immediate_mode=%s result=%s",
      command.c_str(), control_mode(before_mode).c_str(), control_mode(after_mode).c_str(),
      sdk_result(result).c_str());
    callback(result == 0, result == 0 ? "ok" : sdk_result(result));
  }

private:
  void handle_velocity(const geometry_msgs::msg::Twist & message)
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    ++velocity_received_;

    const float requested_vx = static_cast<float>(message.linear.x);
    const float requested_vy = static_cast<float>(message.linear.y);
    const float requested_yaw = static_cast<float>(message.angular.z);
    const bool requested_motion = has_motion(requested_vx, requested_vy, requested_yaw);

    if (!requested_motion && !motion_active_) {
      ++zero_velocity_ignored_;
      return;
    }
    if (!highlevel_.checkConnect()) {
      RCLCPP_ERROR_THROTTLE(
        logger_, *clock_, 2000,
        "Velocity rejected: SDK disconnected requested=(%.3f, %.3f, %.3f)",
        requested_vx, requested_vy, requested_yaw);
      last_move_result_ = 0xFFFFFFFFU;
      return;
    }

    const float vx = condition_velocity(
      requested_vx, kMinimumForwardVelocity, kMaximumForwardVelocity);
    const float vy = condition_velocity(
      requested_vy, kMinimumLateralVelocity, kMaximumLateralVelocity);
    const float yaw = condition_velocity(requested_yaw, kMinimumYawRate, kMaximumYawRate);
    const bool conditioned_motion = has_motion(vx, vy, yaw);

    if (requested_motion && !conditioned_motion) {
      ++velocity_deadband_ignored_;
      RCLCPP_INFO_THROTTLE(
        logger_, *clock_, 2000,
        "Velocity ignored inside %s SDK deadband: requested=(%.3f, %.3f, %.3f)",
        kZsibotModel, requested_vx, requested_vy, requested_yaw);
      return;
    }

    const uint32_t result = highlevel_.move(vx, vy, yaw);
    ++velocity_forwarded_;
    last_move_result_ = result;
    if (result == 0) {
      motion_active_ = conditioned_motion;
      RCLCPP_INFO_THROTTLE(
        logger_, *clock_, 1000,
        "Velocity accepted: requested=(%.3f, %.3f, %.3f) sdk=(%.3f, %.3f, %.3f) mode=%s",
        requested_vx, requested_vy, requested_yaw, vx, vy, yaw,
        control_mode(highlevel_.getCurrentCtrlmode()).c_str());
      return;
    }

    RCLCPP_ERROR_THROTTLE(
      logger_, *clock_, 1000,
      "Velocity SDK failure: requested=(%.3f, %.3f, %.3f) sdk=(%.3f, %.3f, %.3f) "
      "mode=%s result=%s",
      requested_vx, requested_vy, requested_yaw, vx, vy, yaw,
      control_mode(highlevel_.getCurrentCtrlmode()).c_str(), sdk_result(result).c_str());
  }

  void poll_sdk()
  {
    CommandResult completed_callback;
    bool callback_success = false;
    std::string callback_reason;

    {
      std::lock_guard<std::mutex> lock(sdk_mutex_);
      const auto now = std::chrono::steady_clock::now();
      const bool connected = highlevel_.checkConnect();
      if (!last_connected_.has_value() || connected != *last_connected_) {
        if (connected) {
          RCLCPP_INFO(logger_, "Zsibot SDK connection state: connected model=%s", kZsibotModel);
        } else {
          RCLCPP_WARN(logger_, "Zsibot SDK connection state: disconnected model=%s", kZsibotModel);
        }
        last_connected_ = connected;
      }

      uint32_t mode = 0;
      if (connected) {
        mode = highlevel_.getCurrentCtrlmode();
      }

      if (pending_locomotion_) {
        if (!connected) {
          completed_callback = std::move(pending_locomotion_);
          callback_reason = "sdk_disconnected_while_standing";
        } else if (is_ready_for_velocity(mode)) {
          completed_callback = std::move(pending_locomotion_);
          callback_success = true;
          callback_reason = "standing_ready";
          RCLCPP_INFO(
            logger_, "LOCO auto-stand completed: model=%s mode=%s",
            kZsibotModel, control_mode(mode).c_str());
        } else if (now >= locomotion_deadline_) {
          completed_callback = std::move(pending_locomotion_);
          callback_reason = "stand_timeout_mode_" + std::to_string(mode);
          RCLCPP_ERROR(
            logger_, "LOCO auto-stand timed out: model=%s mode=%s timeout_sec=%ld",
            kZsibotModel, control_mode(mode).c_str(),
            static_cast<long>(stand_timeout_.count()));
        }
      }

      if (now >= next_diagnostics_) {
        const uint32_t battery = connected ? highlevel_.getBatteryPower() : 0;
        RCLCPP_INFO(
          logger_,
          "Zsibot diagnostics: model=%s connected=%s mode=%s battery=%s "
          "cmd_vel_publishers=%zu received=%llu forwarded=%llu ignored_zero=%llu "
          "ignored_deadband=%llu last_move=%s",
          kZsibotModel, connected ? "true" : "false",
          connected ? control_mode(mode).c_str() : "unavailable",
          connected ? std::to_string(battery).c_str() : "unavailable",
          velocity_subscription_->get_publisher_count(),
          static_cast<unsigned long long>(velocity_received_),
          static_cast<unsigned long long>(velocity_forwarded_),
          static_cast<unsigned long long>(zero_velocity_ignored_),
          static_cast<unsigned long long>(velocity_deadband_ignored_),
          sdk_result(last_move_result_).c_str());
        next_diagnostics_ = now + diagnostics_period_;
      }
    }

    if (completed_callback) {
      completed_callback(callback_success, callback_reason);
    }
  }

  rclcpp::Logger logger_;
  rclcpp::Clock::SharedPtr clock_;
  ZsibotHighLevel highlevel_;
  std::mutex sdk_mutex_;
  bool auto_stand_on_locomotion_{true};
  bool motion_active_{false};
  std::optional<bool> last_connected_;
  CommandResult pending_locomotion_;
  std::chrono::steady_clock::time_point locomotion_deadline_{};
  std::chrono::steady_clock::time_point next_diagnostics_{};
  std::chrono::seconds stand_timeout_{8};
  std::chrono::milliseconds stop_settle_time_{300};
  std::chrono::seconds diagnostics_period_{10};
  uint32_t last_move_result_{0};
  uint64_t velocity_received_{0};
  uint64_t velocity_forwarded_{0};
  uint64_t zero_velocity_ignored_{0};
  uint64_t velocity_deadband_ignored_{0};
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr velocity_subscription_;
  rclcpp::TimerBase::SharedPtr diagnostics_timer_;
};

#else

class ZsibotAdapter final : public RobotAdapter
{
public:
  explicit ZsibotAdapter(rclcpp::Logger logger)
  : logger_(std::move(logger)) {}

  std::string name() const override {return "zsibot";}

  void request_locomotion(CommandResult callback) override
  {
    RCLCPP_WARN(logger_, "Zsibot SDK adapter is not included in this bundle");
    callback(false, "zsibot_sdk_not_built");
  }

  void request_posture(const std::string &, CommandResult callback) override
  {
    RCLCPP_WARN(logger_, "Zsibot SDK adapter is not included in this bundle");
    callback(false, "zsibot_sdk_not_built");
  }

private:
  rclcpp::Logger logger_;
};

#endif

}  // namespace

std::unique_ptr<RobotAdapter> make_zsibot_adapter(rclcpp::Node & node)
{
#ifdef ROSDECK_HAS_ZSIBOT_SDK
  return std::make_unique<ZsibotAdapter>(node);
#else
  return std::make_unique<ZsibotAdapter>(node.get_logger());
#endif
}

}  // namespace rosdeck_robot_bridge

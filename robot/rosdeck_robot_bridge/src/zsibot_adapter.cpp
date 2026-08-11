#include "rosdeck_robot_bridge/robot_adapter.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <exception>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <utility>

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <netinet/in.h>

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

bool local_ipv4_available(const std::string & requested_ip)
{
  if (requested_ip == "0.0.0.0") {
    return true;
  }

  ifaddrs * addresses = nullptr;
  if (::getifaddrs(&addresses) != 0) {
    return false;
  }

  bool found = false;
  for (auto * entry = addresses; entry != nullptr && !found; entry = entry->ifa_next) {
    if (entry->ifa_addr == nullptr || entry->ifa_addr->sa_family != AF_INET) {
      continue;
    }
    char buffer[INET_ADDRSTRLEN]{};
    const auto * address = reinterpret_cast<const sockaddr_in *>(entry->ifa_addr);
    if (::inet_ntop(AF_INET, &address->sin_addr, buffer, sizeof(buffer)) != nullptr &&
      requested_ip == buffer)
    {
      found = true;
    }
  }
  ::freeifaddrs(addresses);
  return found;
}

enum class ControlState
{
  available,
  acquiring,
  acquired,
  releasing,
  cooldown,
};

enum class ReleasePhase
{
  none,
  wait_for_stop,
  wait_for_lie_down,
  wait_after_passive,
};

class ZsibotAdapter final : public RobotAdapter
{
public:
  explicit ZsibotAdapter(rclcpp::Node & node)
  : logger_(node.get_logger()), clock_(node.get_clock())
  {
    local_ip_ = node.declare_parameter<std::string>(
      "zsibot.local_ip", "192.168.234.234");
    local_port_ = node.declare_parameter<int64_t>(
      "zsibot.local_port", 43988);
    dog_ip_ = node.declare_parameter<std::string>(
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
    const auto acquire_timeout_sec = node.declare_parameter<int64_t>(
      "zsibot.control.acquire_timeout_sec", 10);
    const auto lease_timeout_sec = node.declare_parameter<int64_t>(
      "zsibot.control.lease_timeout_sec", 5);
    const auto release_timeout_sec = node.declare_parameter<int64_t>(
      "zsibot.control.release_timeout_sec", 8);
    const auto remote_recovery_sec = node.declare_parameter<int64_t>(
      "zsibot.control.remote_recovery_sec", 3);
    release_safe_posture_ = node.declare_parameter<bool>(
      "zsibot.control.lie_down_on_release", true);
    stand_timeout_ = std::chrono::seconds(std::max<int64_t>(1, stand_timeout_sec));
    stop_settle_time_ = std::chrono::milliseconds(std::max<int64_t>(0, stop_settle_ms));
    diagnostics_period_ =
      std::chrono::seconds(std::max<int64_t>(1, diagnostics_period_sec));
    acquire_timeout_ =
      std::chrono::seconds(std::max<int64_t>(3, acquire_timeout_sec));
    lease_timeout_ =
      std::chrono::seconds(std::max<int64_t>(3, lease_timeout_sec));
    release_timeout_ =
      std::chrono::seconds(std::max<int64_t>(2, release_timeout_sec));
    remote_recovery_ =
      std::chrono::seconds(std::max<int64_t>(3, remote_recovery_sec));

    RCLCPP_INFO(
      logger_,
      "Zsibot SDK is idle until control is acquired: model=%s local=%s:%ld robot=%s "
      "velocity_topic=%s lease_timeout=%lds remote_recovery=%lds",
      kZsibotModel, local_ip_.c_str(), static_cast<long>(local_port_), dog_ip_.c_str(),
      velocity_topic.c_str(), static_cast<long>(lease_timeout_.count()),
      static_cast<long>(remote_recovery_.count()));

    velocity_subscription_ = node.create_subscription<geometry_msgs::msg::Twist>(
      velocity_topic, 10,
      [this](const geometry_msgs::msg::Twist::SharedPtr message) {
        handle_velocity(*message);
      });
    diagnostics_timer_ = node.create_wall_timer(250ms, [this]() {poll_sdk();});
    next_diagnostics_ = std::chrono::steady_clock::now();
  }

  ~ZsibotAdapter() override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    if (highlevel_) {
      RCLCPP_WARN(logger_, "Bridge is shutting down; stopping and releasing Zsibot SDK control");
      highlevel_->move(0.0F, 0.0F, 0.0F);
      highlevel_->passive();
      highlevel_.reset();
    }
  }

  std::string name() const override {return "zsibot";}

  bool requires_control_lease() const override {return true;}

  std::string control_status() const override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    switch (control_state_) {
      case ControlState::available:
        return "available";
      case ControlState::acquiring:
        return "acquiring:" + control_owner_;
      case ControlState::acquired:
        return "acquired:" + control_owner_;
      case ControlState::releasing:
        return "releasing:" + control_owner_;
      case ControlState::cooldown: {
          const auto remaining = std::max(
            std::chrono::steady_clock::duration::zero(),
            cooldown_until_ - std::chrono::steady_clock::now());
          const auto milliseconds =
            std::chrono::duration_cast<std::chrono::milliseconds>(remaining).count();
          return "cooldown:" + std::to_string((milliseconds + 999) / 1000);
        }
    }
    return "available";
  }

  void request_control(
    const std::string & action, const std::string & client_id, CommandResult callback) override
  {
    if (action == "acquire") {
      acquire_control(client_id, std::move(callback));
      return;
    }
    if (action == "release") {
      release_control(client_id, "client_request", std::move(callback));
      return;
    }
    if (action == "heartbeat") {
      heartbeat_control(client_id, std::move(callback));
      return;
    }
    callback(false, "unsupported_control_action");
  }

  void request_locomotion(CommandResult callback) override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    if (control_state_ != ControlState::acquired || !highlevel_) {
      RCLCPP_WARN(logger_, "LOCO request rejected: mobile control has not been acquired");
      callback(false, "control_not_acquired");
      return;
    }
    const bool connected = highlevel_->checkConnect();
    if (!connected) {
      RCLCPP_ERROR(
        logger_, "LOCO request rejected: model=%s SDK is not connected", kZsibotModel);
      callback(false, "sdk_not_connected");
      return;
    }

    const uint32_t mode = highlevel_->getCurrentCtrlmode();
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

    const uint32_t result = highlevel_->standUp();
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
    if (control_state_ != ControlState::acquired || !highlevel_) {
      RCLCPP_WARN(
        logger_, "Posture request rejected: command=%s mobile control has not been acquired",
        command.c_str());
      callback(false, "control_not_acquired");
      return;
    }
    if (!highlevel_->checkConnect()) {
      RCLCPP_ERROR(
        logger_, "Posture request rejected: command=%s model=%s SDK is not connected",
        command.c_str(), kZsibotModel);
      callback(false, "sdk_not_connected");
      return;
    }

    const uint32_t before_mode = highlevel_->getCurrentCtrlmode();
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
      const uint32_t stop_result = highlevel_->move(0.0F, 0.0F, 0.0F);
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

    const uint32_t result = command == "stand" ? highlevel_->standUp() : highlevel_->lieDown();
    const uint32_t after_mode = highlevel_->getCurrentCtrlmode();
    RCLCPP_INFO(
      logger_, "Posture SDK result: command=%s before_mode=%s immediate_mode=%s result=%s",
      command.c_str(), control_mode(before_mode).c_str(), control_mode(after_mode).c_str(),
      sdk_result(result).c_str());
    callback(result == 0, result == 0 ? "ok" : sdk_result(result));
  }

private:
  void acquire_control(const std::string & client_id, CommandResult callback)
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    const auto now = std::chrono::steady_clock::now();
    if (control_state_ == ControlState::cooldown && now >= cooldown_until_) {
      control_state_ = ControlState::available;
    }
    if (control_state_ == ControlState::acquired && control_owner_ == client_id) {
      lease_deadline_ = now + lease_timeout_;
      callback(true, "already_acquired");
      return;
    }
    if (control_state_ == ControlState::acquiring && control_owner_ == client_id) {
      lease_deadline_ = now + lease_timeout_;
      callback(true, "acquire_in_progress");
      return;
    }
    if (control_state_ != ControlState::available) {
      callback(false, control_state_ == ControlState::cooldown ?
        "remote_recovery_in_progress" : "control_unavailable");
      return;
    }
    if (!local_ipv4_available(local_ip_)) {
      RCLCPP_ERROR(
        logger_, "Control acquisition rejected: local address %s is not assigned",
        local_ip_.c_str());
      callback(false, "local_ip_not_ready_" + local_ip_);
      return;
    }

    RCLCPP_INFO(
      logger_, "Acquiring mobile control: owner=%s model=%s local=%s:%ld robot=%s",
      client_id.c_str(), kZsibotModel, local_ip_.c_str(), static_cast<long>(local_port_),
      dog_ip_.c_str());
    try {
      highlevel_ = std::make_unique<ZsibotHighLevel>();
      highlevel_->initRobot(local_ip_, static_cast<int>(local_port_), dog_ip_);
    } catch (const std::exception & error) {
      highlevel_.reset();
      RCLCPP_ERROR(logger_, "Zsibot SDK initialization failed: %s", error.what());
      callback(false, "sdk_init_failed");
      return;
    } catch (...) {
      highlevel_.reset();
      RCLCPP_ERROR(logger_, "Zsibot SDK initialization failed with an unknown exception");
      callback(false, "sdk_init_failed");
      return;
    }

    control_owner_ = client_id;
    control_state_ = ControlState::acquiring;
    pending_control_ = std::move(callback);
    acquire_deadline_ = now + acquire_timeout_;
    lease_deadline_ = now + lease_timeout_;
    last_connected_.reset();
    disconnected_since_.reset();
  }

  void release_control(
    const std::string & client_id, const std::string & reason, CommandResult callback)
  {
    CommandResult cancelled_acquire;
    {
      std::lock_guard<std::mutex> lock(sdk_mutex_);
      if (control_state_ == ControlState::available || control_state_ == ControlState::cooldown) {
        callback(true, "already_released");
        return;
      }
      if (client_id != control_owner_) {
        callback(false, "not_control_owner");
        return;
      }
      if (control_state_ == ControlState::releasing) {
        callback(true, "release_in_progress");
        return;
      }
      if (control_state_ == ControlState::acquiring && pending_control_) {
        cancelled_acquire = std::move(pending_control_);
      }
      begin_release_locked(reason, std::move(callback));
    }
    if (cancelled_acquire) {
      cancelled_acquire(false, "acquire_cancelled");
    }
  }

  void heartbeat_control(const std::string & client_id, CommandResult callback)
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    if ((control_state_ != ControlState::acquired &&
      control_state_ != ControlState::acquiring) || client_id != control_owner_)
    {
      callback(false, "not_control_owner");
      return;
    }
    lease_deadline_ = std::chrono::steady_clock::now() + lease_timeout_;
    callback(true, "lease_renewed");
  }

  void begin_release_locked(const std::string & reason, CommandResult callback)
  {
    RCLCPP_WARN(
      logger_, "Releasing mobile control: owner=%s reason=%s safe_posture=%s",
      control_owner_.c_str(), reason.c_str(), release_safe_posture_ ? "lie_down" : "passive");
    control_state_ = ControlState::releasing;
    release_reason_ = reason;
    release_phase_ = ReleasePhase::wait_for_stop;
    release_step_at_ = std::chrono::steady_clock::now() + stop_settle_time_;
    release_deadline_ = std::chrono::steady_clock::now() + release_timeout_;
    pending_control_ = std::move(callback);
    if (pending_locomotion_) {
      pending_locomotion_(false, "control_released");
      pending_locomotion_ = {};
    }
    if (highlevel_ && highlevel_->checkConnect()) {
      const uint32_t stop_result = highlevel_->move(0.0F, 0.0F, 0.0F);
      RCLCPP_INFO(logger_, "Release step stop: result=%s", sdk_result(stop_result).c_str());
    }
    motion_active_ = false;
  }

  void finish_release_locked(CommandResult & completed_callback, std::string & completed_reason)
  {
    highlevel_.reset();
    last_connected_.reset();
    disconnected_since_.reset();
    release_phase_ = ReleasePhase::none;
    control_state_ = ControlState::cooldown;
    cooldown_until_ = std::chrono::steady_clock::now() + remote_recovery_;
    completed_callback = std::move(pending_control_);
    completed_reason = "released_" + release_reason_;
    RCLCPP_INFO(
      logger_, "Zsibot SDK destroyed; vendor remote recovery window started: %lds",
      static_cast<long>(remote_recovery_.count()));
    control_owner_.clear();
  }

  void handle_velocity(const geometry_msgs::msg::Twist & message)
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    ++velocity_received_;

    const float requested_vx = static_cast<float>(message.linear.x);
    const float requested_vy = static_cast<float>(message.linear.y);
    const float requested_yaw = static_cast<float>(message.angular.z);
    const bool requested_motion = has_motion(requested_vx, requested_vy, requested_yaw);

    if (control_state_ != ControlState::acquired || !highlevel_) {
      ++velocity_not_owned_ignored_;
      if (requested_motion) {
        RCLCPP_WARN_THROTTLE(
          logger_, *clock_, 2000,
          "Velocity ignored: mobile control is not acquired requested=(%.3f, %.3f, %.3f)",
          requested_vx, requested_vy, requested_yaw);
      }
      return;
    }

    if (!requested_motion && !motion_active_) {
      ++zero_velocity_ignored_;
      return;
    }
    if (!highlevel_->checkConnect()) {
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

    const uint32_t result = highlevel_->move(vx, vy, yaw);
    ++velocity_forwarded_;
    last_move_result_ = result;
    if (result == 0) {
      motion_active_ = conditioned_motion;
      RCLCPP_INFO_THROTTLE(
        logger_, *clock_, 1000,
        "Velocity accepted: requested=(%.3f, %.3f, %.3f) sdk=(%.3f, %.3f, %.3f) mode=%s",
        requested_vx, requested_vy, requested_yaw, vx, vy, yaw,
        control_mode(highlevel_->getCurrentCtrlmode()).c_str());
      return;
    }

    RCLCPP_ERROR_THROTTLE(
      logger_, *clock_, 1000,
      "Velocity SDK failure: requested=(%.3f, %.3f, %.3f) sdk=(%.3f, %.3f, %.3f) "
      "mode=%s result=%s",
      requested_vx, requested_vy, requested_yaw, vx, vy, yaw,
      control_mode(highlevel_->getCurrentCtrlmode()).c_str(), sdk_result(result).c_str());
  }

  void poll_sdk()
  {
    CommandResult completed_callback;
    bool callback_success = false;
    std::string callback_reason;

    {
      std::lock_guard<std::mutex> lock(sdk_mutex_);
      const auto now = std::chrono::steady_clock::now();
      if (control_state_ == ControlState::cooldown && now >= cooldown_until_) {
        control_state_ = ControlState::available;
        release_reason_.clear();
        RCLCPP_INFO(logger_, "Vendor remote recovery window complete; mobile control is available");
      }

      const bool connected = highlevel_ && highlevel_->checkConnect();
      if (highlevel_ && (!last_connected_.has_value() || connected != *last_connected_)) {
        if (connected) {
          RCLCPP_INFO(logger_, "Zsibot SDK connection state: connected model=%s", kZsibotModel);
        } else {
          RCLCPP_WARN(logger_, "Zsibot SDK connection state: disconnected model=%s", kZsibotModel);
        }
        last_connected_ = connected;
      } else if (!highlevel_) {
        last_connected_.reset();
      }

      uint32_t mode = 0;
      if (connected) {
        mode = highlevel_->getCurrentCtrlmode();
      }

      if (control_state_ == ControlState::acquiring) {
        if (connected) {
          control_state_ = ControlState::acquired;
          lease_deadline_ = now + lease_timeout_;
          completed_callback = std::move(pending_control_);
          callback_success = true;
          callback_reason = "control_acquired";
          RCLCPP_INFO(
            logger_, "Mobile control acquired: owner=%s model=%s mode=%s",
            control_owner_.c_str(), kZsibotModel, control_mode(mode).c_str());
        } else if (now >= acquire_deadline_) {
          highlevel_.reset();
          control_state_ = ControlState::cooldown;
          cooldown_until_ = now + remote_recovery_;
          control_owner_.clear();
          completed_callback = std::move(pending_control_);
          callback_reason = "sdk_connect_timeout";
          RCLCPP_ERROR(
            logger_, "Mobile control acquisition timed out after %lds",
            static_cast<long>(acquire_timeout_.count()));
        }
      } else if (control_state_ == ControlState::acquired) {
        if (connected) {
          disconnected_since_.reset();
        } else if (!disconnected_since_) {
          disconnected_since_ = now;
        } else if (now - *disconnected_since_ >= 2s) {
          begin_release_locked("sdk_disconnected", {});
        }
        if (control_state_ == ControlState::acquired && now >= lease_deadline_) {
          begin_release_locked("heartbeat_timeout", {});
        }
      }

      if (control_state_ == ControlState::releasing && now >= release_step_at_) {
        if (release_phase_ == ReleasePhase::wait_for_stop) {
          if (!connected || !highlevel_) {
            finish_release_locked(completed_callback, callback_reason);
            callback_success = true;
          } else if (!release_safe_posture_ || mode == 0) {
            if (!release_safe_posture_) {
              const uint32_t passive_result = highlevel_->passive();
              RCLCPP_INFO(
                logger_, "Release step passive: result=%s", sdk_result(passive_result).c_str());
            }
            finish_release_locked(completed_callback, callback_reason);
            callback_success = true;
          } else {
            const uint32_t lie_result = highlevel_->lieDown();
            RCLCPP_INFO(
              logger_, "Release step lie_down: mode=%s result=%s",
              control_mode(mode).c_str(), sdk_result(lie_result).c_str());
            if (lie_result == 0) {
              release_phase_ = ReleasePhase::wait_for_lie_down;
              release_step_at_ = now + 250ms;
            } else {
              const uint32_t passive_result = highlevel_->passive();
              RCLCPP_WARN(
                logger_, "Lie-down failed; passive fallback sent: result=%s",
                sdk_result(passive_result).c_str());
              release_phase_ = ReleasePhase::wait_after_passive;
              release_step_at_ = now + 500ms;
            }
          }
        } else if (release_phase_ == ReleasePhase::wait_for_lie_down) {
          if (!connected || mode == 0) {
            finish_release_locked(completed_callback, callback_reason);
            callback_success = true;
          } else if (now >= release_deadline_) {
            const uint32_t passive_result = highlevel_->passive();
            RCLCPP_WARN(
              logger_, "Lie-down timed out in mode=%s; passive fallback sent: result=%s",
              control_mode(mode).c_str(), sdk_result(passive_result).c_str());
            release_phase_ = ReleasePhase::wait_after_passive;
            release_step_at_ = now + 500ms;
          } else {
            release_step_at_ = now + 250ms;
          }
        } else if (release_phase_ == ReleasePhase::wait_after_passive) {
          finish_release_locked(completed_callback, callback_reason);
          callback_success = true;
        }
      }

      if (pending_locomotion_ && control_state_ == ControlState::acquired) {
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
        const bool diagnostic_connected = highlevel_ && highlevel_->checkConnect();
        const uint32_t diagnostic_mode =
          diagnostic_connected ? highlevel_->getCurrentCtrlmode() : 0;
        const uint32_t battery = diagnostic_connected ? highlevel_->getBatteryPower() : 0;
        RCLCPP_INFO(
          logger_,
          "Zsibot diagnostics: model=%s authority=%s connected=%s mode=%s battery=%s "
          "cmd_vel_publishers=%zu received=%llu forwarded=%llu ignored_zero=%llu "
          "ignored_deadband=%llu ignored_not_owned=%llu last_move=%s",
          kZsibotModel, control_status_locked().c_str(),
          diagnostic_connected ? "true" : "false",
          diagnostic_connected ? control_mode(diagnostic_mode).c_str() : "unavailable",
          diagnostic_connected ? std::to_string(battery).c_str() : "unavailable",
          velocity_subscription_->get_publisher_count(),
          static_cast<unsigned long long>(velocity_received_),
          static_cast<unsigned long long>(velocity_forwarded_),
          static_cast<unsigned long long>(zero_velocity_ignored_),
          static_cast<unsigned long long>(velocity_deadband_ignored_),
          static_cast<unsigned long long>(velocity_not_owned_ignored_),
          sdk_result(last_move_result_).c_str());
        next_diagnostics_ = now + diagnostics_period_;
      }
    }

    if (completed_callback) {
      completed_callback(callback_success, callback_reason);
    }
  }

  std::string control_status_locked() const
  {
    switch (control_state_) {
      case ControlState::available:
        return "available";
      case ControlState::acquiring:
        return "acquiring:" + control_owner_;
      case ControlState::acquired:
        return "acquired:" + control_owner_;
      case ControlState::releasing:
        return "releasing:" + control_owner_;
      case ControlState::cooldown:
        return "cooldown";
    }
    return "available";
  }

  rclcpp::Logger logger_;
  rclcpp::Clock::SharedPtr clock_;
  std::unique_ptr<ZsibotHighLevel> highlevel_;
  mutable std::mutex sdk_mutex_;
  std::string local_ip_;
  int64_t local_port_{43988};
  std::string dog_ip_;
  bool auto_stand_on_locomotion_{true};
  bool release_safe_posture_{true};
  bool motion_active_{false};
  std::optional<bool> last_connected_;
  std::optional<std::chrono::steady_clock::time_point> disconnected_since_;
  ControlState control_state_{ControlState::available};
  ReleasePhase release_phase_{ReleasePhase::none};
  std::string control_owner_;
  std::string release_reason_;
  CommandResult pending_control_;
  CommandResult pending_locomotion_;
  std::chrono::steady_clock::time_point acquire_deadline_{};
  std::chrono::steady_clock::time_point lease_deadline_{};
  std::chrono::steady_clock::time_point release_deadline_{};
  std::chrono::steady_clock::time_point release_step_at_{};
  std::chrono::steady_clock::time_point cooldown_until_{};
  std::chrono::steady_clock::time_point locomotion_deadline_{};
  std::chrono::steady_clock::time_point next_diagnostics_{};
  std::chrono::seconds stand_timeout_{8};
  std::chrono::milliseconds stop_settle_time_{300};
  std::chrono::seconds diagnostics_period_{10};
  std::chrono::seconds acquire_timeout_{10};
  std::chrono::seconds lease_timeout_{5};
  std::chrono::seconds release_timeout_{8};
  std::chrono::seconds remote_recovery_{3};
  uint32_t last_move_result_{0};
  uint64_t velocity_received_{0};
  uint64_t velocity_forwarded_{0};
  uint64_t zero_velocity_ignored_{0};
  uint64_t velocity_deadband_ignored_{0};
  uint64_t velocity_not_owned_ignored_{0};
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

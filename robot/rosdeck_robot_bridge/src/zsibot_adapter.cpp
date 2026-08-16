#include "rosdeck_robot_bridge/robot_adapter.hpp"
#include "rosdeck_robot_bridge/cmd_vel_arbiter.hpp"
#include "rosdeck_robot_bridge/velocity_safety.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
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
constexpr int64_t kMinimumCmdVelTimeoutMs = 200;
constexpr int64_t kMaximumCmdVelTimeoutMs = 300;
constexpr int64_t kDefaultCmdVelTimeoutMs = 250;
constexpr int64_t kMaximumStopSettleMs = 500;

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

bool posture_is_known(uint32_t mode)
{
#if defined(ROSDECK_ZSIBOT_MODEL_ZSL1W)
  return mode == 0 || mode == 1 || mode == 3;
#else
  return mode == 0 || mode == 1 || mode == 10 || mode == 18 || mode == 21 || mode == 51;
#endif
}

std::string posture_from_mode(uint32_t mode)
{
  if (mode == 0) {
    return "passive";
  }
  if (mode == 1) {
    return "standing";
  }
  if (is_moving_mode(mode)) {
    return "moving";
  }
#if !defined(ROSDECK_ZSIBOT_MODEL_ZSL1W)
  if (mode == 10) {
    return "free";
  }
  if (mode == 21) {
    return "action";
  }
  if (mode == 51) {
    return "lying_down";
  }
#endif
  return "unknown";
}

int control_client_priority(const std::string & client_id)
{
  if (client_id.rfind("app-", 0) == 0) {
    return 30;
  }
  if (client_id.rfind("docking-", 0) == 0) {
    return 20;
  }
  if (client_id.rfind("mission-", 0) == 0) {
    return 10;
  }
  return 0;
}

double validated_product_limit(
  const rclcpp::Logger & logger, const char * parameter_name, double requested,
  double fallback, double sdk_minimum, double sdk_maximum)
{
  if (!std::isfinite(requested) || requested < 0.0) {
    RCLCPP_WARN(
      logger, "Invalid %s=%.3f; using safe default %.3f", parameter_name, requested, fallback);
    requested = fallback;
  }
  if (requested > sdk_maximum) {
    RCLCPP_WARN(
      logger, "%s=%.3f exceeds the %s SDK limit %.3f; clamping",
      parameter_name, requested, kZsibotModel, sdk_maximum);
    requested = sdk_maximum;
  }
  if (requested > 0.0 && requested < sdk_minimum) {
    RCLCPP_WARN(
      logger, "%s=%.3f is below the %s SDK minimum %.3f; disabling this direction",
      parameter_name, requested, kZsibotModel, sdk_minimum);
    return 0.0;
  }
  return requested;
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

enum class FaultDomain : std::size_t
{
  telemetry,
  battery,
  motion_input,
  motion_sdk,
  stop,
  release,
  locomotion,
  posture,
  authority,
  other,
  count,
};

constexpr std::size_t fault_domain_count = static_cast<std::size_t>(FaultDomain::count);

const char * fault_domain_name(FaultDomain domain)
{
  switch (domain) {
    case FaultDomain::telemetry:
      return "telemetry";
    case FaultDomain::battery:
      return "battery";
    case FaultDomain::motion_input:
      return "motion_input";
    case FaultDomain::motion_sdk:
      return "motion_sdk";
    case FaultDomain::stop:
      return "stop";
    case FaultDomain::release:
      return "release";
    case FaultDomain::locomotion:
      return "locomotion";
    case FaultDomain::posture:
      return "posture";
    case FaultDomain::authority:
      return "authority";
    case FaultDomain::other:
      return "other";
    case FaultDomain::count:
      break;
  }
  return "other";
}

FaultDomain fault_domain_for_context(const std::string & context)
{
  if (context == "poll" || context.rfind("poll_", 0) == 0 ||
    context.find("check_connect") != std::string::npos ||
    context.find("get_mode") != std::string::npos)
  {
    return FaultDomain::telemetry;
  }
  if (context.rfind("battery", 0) == 0) {
    return FaultDomain::battery;
  }
  if (context == "cmd_vel") {
    return FaultDomain::motion_input;
  }
  if (context.rfind("velocity_", 0) == 0) {
    return FaultDomain::motion_sdk;
  }
  if (context.rfind("stop_", 0) == 0 || context.find("_stop") != std::string::npos) {
    return FaultDomain::stop;
  }
  if (context.rfind("release_", 0) == 0) {
    return FaultDomain::release;
  }
  if (context.rfind("locomotion", 0) == 0) {
    return FaultDomain::locomotion;
  }
  if (context.rfind("posture", 0) == 0) {
    return FaultDomain::posture;
  }
  if (context.rfind("control_", 0) == 0 || context.rfind("authority_", 0) == 0 ||
    context == "sdk_init")
  {
    return FaultDomain::authority;
  }
  return FaultDomain::other;
}

struct ActiveFault
{
  bool active{false};
  std::string message;
  AdapterSteadyTime at{};
  uint64_t ordinal{0};
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
      "zsibot.velocity_topic", cmd_vel_arbiter::kFinalTopic);
    const auto requested_cmd_vel_timeout_ms = node.declare_parameter<int64_t>(
      "zsibot.safety.cmd_vel_timeout_ms", kDefaultCmdVelTimeoutMs);
    if (requested_cmd_vel_timeout_ms < kMinimumCmdVelTimeoutMs ||
      requested_cmd_vel_timeout_ms > kMaximumCmdVelTimeoutMs)
    {
      RCLCPP_WARN(
        logger_, "zsibot.safety.cmd_vel_timeout_ms=%ld is outside [%ld, %ld]; clamping",
        static_cast<long>(requested_cmd_vel_timeout_ms),
        static_cast<long>(kMinimumCmdVelTimeoutMs),
        static_cast<long>(kMaximumCmdVelTimeoutMs));
    }
    cmd_vel_timeout_ = std::chrono::milliseconds(std::clamp(
        requested_cmd_vel_timeout_ms, kMinimumCmdVelTimeoutMs, kMaximumCmdVelTimeoutMs));
    velocity_limits_.forward_deadband = kMinimumForwardVelocity;
    velocity_limits_.lateral_deadband = kMinimumLateralVelocity;
    velocity_limits_.yaw_deadband = kMinimumYawRate;
    velocity_limits_.max_forward = validated_product_limit(
      logger_, "zsibot.safety.max_forward_velocity_mps",
      node.declare_parameter<double>("zsibot.safety.max_forward_velocity_mps", 0.6),
      0.6, kMinimumForwardVelocity, kMaximumForwardVelocity);
    velocity_limits_.max_reverse = validated_product_limit(
      logger_, "zsibot.safety.max_reverse_velocity_mps",
      node.declare_parameter<double>("zsibot.safety.max_reverse_velocity_mps", 0.3),
      0.3, kMinimumForwardVelocity, kMaximumForwardVelocity);
    velocity_limits_.max_lateral = validated_product_limit(
      logger_, "zsibot.safety.max_lateral_velocity_mps",
      node.declare_parameter<double>("zsibot.safety.max_lateral_velocity_mps", 0.3),
      0.3, kMinimumLateralVelocity, kMaximumLateralVelocity);
    velocity_limits_.max_yaw = validated_product_limit(
      logger_, "zsibot.safety.max_yaw_rate_radps",
      node.declare_parameter<double>("zsibot.safety.max_yaw_rate_radps", 0.8),
      0.8, kMinimumYawRate, kMaximumYawRate);
    auto_stand_on_locomotion_ = node.declare_parameter<bool>(
      "zsibot.auto_stand_on_locomotion", true);
    const auto stand_timeout_sec = node.declare_parameter<int64_t>(
      "zsibot.stand_timeout_sec", 8);
    const auto stop_settle_ms = node.declare_parameter<int64_t>(
      "zsibot.stop_settle_ms", 300);
    if (stop_settle_ms < 0 || stop_settle_ms > kMaximumStopSettleMs) {
      throw std::invalid_argument("zsibot.stop_settle_ms must be in [0, 500]");
    }
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
    stop_settle_time_ = std::chrono::milliseconds(stop_settle_ms);
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
      "velocity_topic=%s lease_timeout=%lds cmd_vel_timeout=%ldms remote_recovery=%lds "
      "limits=(forward=%.2f reverse=%.2f lateral=%.2f yaw=%.2f)",
      kZsibotModel, local_ip_.c_str(), static_cast<long>(local_port_), dog_ip_.c_str(),
      velocity_topic.c_str(), static_cast<long>(lease_timeout_.count()),
      static_cast<long>(cmd_vel_timeout_.count()), static_cast<long>(remote_recovery_.count()),
      velocity_limits_.max_forward, velocity_limits_.max_reverse,
      velocity_limits_.max_lateral, velocity_limits_.max_yaw);

    // Keep only the newest command. Replaying a reliable backlog after a
    // network stall would defeat the wall-clock watchdog.
    const auto velocity_qos =
      rclcpp::QoS(rclcpp::KeepLast(1)).best_effort().durability_volatile();
    velocity_subscription_ = node.create_subscription<geometry_msgs::msg::Twist>(
      velocity_topic, velocity_qos,
      [this](const geometry_msgs::msg::Twist::SharedPtr message) {
        handle_velocity(*message);
      });
    diagnostics_timer_ = node.create_wall_timer(250ms, [this]() {poll_sdk();});
    velocity_watchdog_timer_ = node.create_wall_timer(25ms, [this]() {watch_velocity_timeout();});
    next_diagnostics_ = std::chrono::steady_clock::now();
  }

  ~ZsibotAdapter() override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    if (highlevel_) {
      RCLCPP_WARN(logger_, "Bridge is shutting down; stopping and releasing Zsibot SDK control");
      send_stop_locked("bridge_shutdown");
      try {
        highlevel_->passive();
      } catch (const std::exception & error) {
        RCLCPP_ERROR(logger_, "Passive command during shutdown threw: %s", error.what());
      } catch (...) {
        RCLCPP_ERROR(logger_, "Passive command during shutdown threw an unknown exception");
      }
      highlevel_.reset();
    }
  }

  std::string name() const override {return "zsibot";}

  AdapterSnapshot snapshot() const override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    AdapterSnapshot value;
    value.adapter_name = "zsibot";
    value.connection_known = last_connected_.has_value();
    value.connected = last_connected_.value_or(false);
    value.telemetry_sample_known = telemetry_sample_known_;
    value.telemetry_sample_at = telemetry_sample_at_;
    value.battery_presence_known = true;
    value.battery_present = true;
    value.battery_known = battery_fraction_.has_value();
    value.battery_fraction = battery_fraction_.value_or(0.0F);
    value.battery_sample_known = battery_sample_known_;
    value.battery_sample_at = battery_sample_at_;
    value.control_mode_known = control_mode_cache_.has_value();
    if (control_mode_cache_) {
      value.control_mode = control_mode(*control_mode_cache_);
      value.posture_known = posture_is_known(*control_mode_cache_);
      value.posture = posture_from_mode(*control_mode_cache_);
    }
    value.authority_known = true;
    value.authority_state = authority_state_locked();
    value.authority_owner = control_owner_;
    value.last_sdk_result_known = last_sdk_result_known_;
    value.last_sdk_result_code = last_sdk_result_code_;
    value.last_sdk_result = last_sdk_result_;
    const ActiveFault * newest_active_fault = nullptr;
    FaultDomain newest_active_domain = FaultDomain::other;
    for (std::size_t index = 0; index < active_faults_.size(); ++index) {
      const auto & fault = active_faults_[index];
      if (fault.active &&
        (!newest_active_fault || fault.ordinal > newest_active_fault->ordinal))
      {
        newest_active_fault = &fault;
        newest_active_domain = static_cast<FaultDomain>(index);
      }
    }
    value.last_error_active = newest_active_fault != nullptr;
    if (newest_active_fault) {
      value.last_error_domain = fault_domain_name(newest_active_domain);
      value.last_error = newest_active_fault->message;
      value.last_error_sample_known = true;
      value.last_error_at = newest_active_fault->at;
    } else {
      value.last_error_domain = last_error_domain_;
      value.last_error = last_error_;
      value.last_error_sample_known = last_error_sample_known_;
      value.last_error_at = last_error_at_;
    }
    value.sequence = state_sequence_;
    return value;
  }

  bool requires_control_lease() const override {return true;}

  void emergency_stop(CommandResult callback) override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    if (!highlevel_) {
      motion_active_ = false;
      last_velocity_command_.reset();
      callback(true, "sdk_idle");
      return;
    }
    const uint32_t result = send_stop_locked("software_estop");
    callback(result == 0, result == 0 ? "stopped" : "sdk_stop_failed");
  }

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
    bool connected = false;
    try {
      connected = highlevel_->checkConnect();
    } catch (const std::exception & error) {
      enter_sdk_fault_locked("locomotion_check_connect", error.what());
      callback(false, "sdk_exception");
      return;
    } catch (...) {
      enter_sdk_fault_locked("locomotion_check_connect", "unknown_exception");
      callback(false, "sdk_exception");
      return;
    }
    if (!connected) {
      record_error_locked("locomotion_check_connect", "sdk_not_connected");
      RCLCPP_ERROR(
        logger_, "LOCO request rejected: model=%s SDK is not connected", kZsibotModel);
      callback(false, "sdk_not_connected");
      return;
    }

    uint32_t mode = 0;
    try {
      mode = highlevel_->getCurrentCtrlmode();
    } catch (const std::exception & error) {
      enter_sdk_fault_locked("locomotion_get_mode", error.what());
      callback(false, "sdk_exception");
      return;
    } catch (...) {
      enter_sdk_fault_locked("locomotion_get_mode", "unknown_exception");
      callback(false, "sdk_exception");
      return;
    }
    RCLCPP_INFO(
      logger_, "LOCO request received: model=%s connected=true mode=%s",
      kZsibotModel, control_mode(mode).c_str());
    if (is_ready_for_velocity(mode)) {
      clear_fault_domain_locked(FaultDomain::locomotion);
      callback(true, "already_ready");
      return;
    }
    if (!auto_stand_on_locomotion_) {
      callback(false, "not_standing_mode_" + std::to_string(mode));
      return;
    }

    uint32_t result = 0xFFFFFFFFU;
    try {
      result = highlevel_->standUp();
    } catch (const std::exception & error) {
      enter_sdk_fault_locked("locomotion_stand", error.what());
      callback(false, "sdk_exception");
      return;
    } catch (...) {
      enter_sdk_fault_locked("locomotion_stand", "unknown_exception");
      callback(false, "sdk_exception");
      return;
    }
    record_sdk_result_locked("locomotion_stand", result);
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
    bool connected = false;
    try {
      connected = highlevel_->checkConnect();
    } catch (const std::exception & error) {
      enter_sdk_fault_locked("posture_check_connect", error.what());
      callback(false, "sdk_exception");
      return;
    } catch (...) {
      enter_sdk_fault_locked("posture_check_connect", "unknown_exception");
      callback(false, "sdk_exception");
      return;
    }
    if (!connected) {
      record_error_locked("posture_check_connect", "sdk_not_connected");
      RCLCPP_ERROR(
        logger_, "Posture request rejected: command=%s model=%s SDK is not connected",
        command.c_str(), kZsibotModel);
      callback(false, "sdk_not_connected");
      return;
    }

    uint32_t before_mode = 0;
    try {
      before_mode = highlevel_->getCurrentCtrlmode();
    } catch (const std::exception & error) {
      enter_sdk_fault_locked("posture_get_mode", error.what());
      callback(false, "sdk_exception");
      return;
    } catch (...) {
      enter_sdk_fault_locked("posture_get_mode", "unknown_exception");
      callback(false, "sdk_exception");
      return;
    }
    RCLCPP_INFO(
      logger_, "Posture request received: command=%s model=%s mode=%s motion_active=%s",
      command.c_str(), kZsibotModel, control_mode(before_mode).c_str(),
      motion_active_ ? "true" : "false");

    if (command == "stand" && is_standing_mode(before_mode)) {
      clear_fault_domain_locked(FaultDomain::posture);
      RCLCPP_INFO(logger_, "Posture command stand skipped: robot is already ready");
      callback(true, "already_standing");
      return;
    }

    if (motion_active_ || is_moving_mode(before_mode)) {
      const uint32_t stop_result = send_stop_locked("before_posture_" + command);
      if (stop_result != 0) {
        callback(false, "stop_before_posture_" + sdk_result(stop_result));
        return;
      }
      motion_active_ = false;
      std::this_thread::sleep_for(stop_settle_time_);
    }

    uint32_t result = 0xFFFFFFFFU;
    uint32_t after_mode = before_mode;
    try {
      result = command == "stand" ? highlevel_->standUp() : highlevel_->lieDown();
      after_mode = highlevel_->getCurrentCtrlmode();
    } catch (const std::exception & error) {
      enter_sdk_fault_locked("posture_command", error.what());
      callback(false, "sdk_exception");
      return;
    } catch (...) {
      enter_sdk_fault_locked("posture_command", "unknown_exception");
      callback(false, "sdk_exception");
      return;
    }
    record_sdk_result_locked("posture_" + command, result);
    RCLCPP_INFO(
      logger_, "Posture SDK result: command=%s before_mode=%s immediate_mode=%s result=%s",
      command.c_str(), control_mode(before_mode).c_str(), control_mode(after_mode).c_str(),
      sdk_result(result).c_str());
    callback(result == 0, result == 0 ? "ok" : sdk_result(result));
  }

private:
  std::string authority_state_locked() const
  {
    switch (control_state_) {
      case ControlState::available:
        return "available";
      case ControlState::acquiring:
        return "acquiring";
      case ControlState::acquired:
        return "acquired";
      case ControlState::releasing:
        return "releasing";
      case ControlState::cooldown:
        return "cooldown";
    }
    return "unknown";
  }

  void clear_cached_telemetry_locked()
  {
    last_connected_.reset();
    control_mode_cache_.reset();
    battery_fraction_.reset();
    telemetry_sample_known_ = false;
    battery_sample_known_ = false;
    ++state_sequence_;
  }

  void cache_telemetry_locked(
    bool connected, std::optional<uint32_t> mode, AdapterSteadyTime now)
  {
    last_connected_ = connected;
    control_mode_cache_ = connected ? mode : std::nullopt;
    telemetry_sample_known_ = true;
    telemetry_sample_at_ = now;
    if (!connected) {
      battery_fraction_.reset();
      battery_sample_known_ = false;
    }
    ++state_sequence_;
  }

  void record_error_locked(const std::string & context, const std::string & detail)
  {
    const FaultDomain domain = fault_domain_for_context(context);
    const auto now = AdapterSteadyClock::now();
    const std::string message = context + ':' + (detail.empty() ? "unknown" : detail);
    auto & fault = active_faults_[static_cast<std::size_t>(domain)];
    fault.active = true;
    fault.message = message;
    fault.at = now;
    fault.ordinal = ++fault_ordinal_;
    last_error_ = message;
    last_error_domain_ = fault_domain_name(domain);
    last_error_sample_known_ = true;
    last_error_at_ = now;
    ++state_sequence_;
  }

  void clear_fault_domain_locked(FaultDomain domain)
  {
    auto & fault = active_faults_[static_cast<std::size_t>(domain)];
    if (fault.active) {
      fault.active = false;
      ++state_sequence_;
    }
  }

  void record_sdk_result_locked(const std::string & context, uint32_t result)
  {
    last_sdk_result_known_ = true;
    last_sdk_result_code_ = result;
    last_sdk_result_ = context + ':' + sdk_result(result);
    ++state_sequence_;
    if (result != 0) {
      record_error_locked(context, sdk_result(result));
    } else {
      const FaultDomain domain = fault_domain_for_context(context);
      if (domain != FaultDomain::release || !release_degraded_) {
        clear_fault_domain_locked(domain);
      }
    }
  }

  void mark_poll_healthy_locked()
  {
    // A healthy connection/mode sample proves only that the telemetry domain
    // recovered. It must not erase motion, stop, authority, posture or battery
    // faults that happen to share this adapter.
    clear_fault_domain_locked(FaultDomain::telemetry);
  }

  void enter_sdk_fault_locked(const std::string & context, const std::string & detail)
  {
    record_error_locked(context, detail);
    RCLCPP_ERROR(
      logger_, "Zsibot SDK fault: context=%s detail=%s; forcing stop and releasing authority",
      context.c_str(), detail.c_str());
    if (highlevel_) {
      send_stop_locked("sdk_exception_" + context);
      highlevel_.reset();
    }
    clear_cached_telemetry_locked();
    motion_active_ = false;
    last_velocity_command_.reset();
    release_phase_ = ReleasePhase::none;
    release_reason_ = "sdk_exception_" + context;
    control_state_ = ControlState::cooldown;
    cooldown_until_ = std::chrono::steady_clock::now() + remote_recovery_;
    control_owner_.clear();
    if (pending_locomotion_) {
      auto callback = std::move(pending_locomotion_);
      callback(false, "sdk_exception");
    }
    if (pending_control_) {
      auto callback = std::move(pending_control_);
      callback(false, "sdk_exception");
    }
  }

  uint32_t send_stop_locked(const std::string & reason)
  {
    if (!highlevel_) {
      motion_active_ = false;
      last_velocity_command_.reset();
      return 0xFFFFFFFFU;
    }

    ++stop_commands_sent_;
    ++velocity_forwarded_;
    uint32_t result = 0xFFFFFFFFU;
    std::string exception_detail;
    try {
      result = highlevel_->move(0.0F, 0.0F, 0.0F);
    } catch (const std::exception & error) {
      exception_detail = error.what();
      RCLCPP_ERROR(
        logger_, "Safety stop threw: reason=%s error=%s", reason.c_str(), error.what());
    } catch (...) {
      exception_detail = "unknown_exception";
      RCLCPP_ERROR(logger_, "Safety stop threw: reason=%s unknown exception", reason.c_str());
    }
    last_move_result_ = result;
    record_sdk_result_locked("stop_" + reason, result);
    if (!exception_detail.empty()) {
      record_error_locked("stop_" + reason, exception_detail);
    }
    if (result == 0) {
      motion_active_ = false;
      last_velocity_command_.reset();
      RCLCPP_INFO_THROTTLE(
        logger_, *clock_, 1000, "Explicit safety stop sent: reason=%s", reason.c_str());
    } else {
      ++stop_command_failures_;
      if (motion_active_) {
        // Keep the watchdog armed so a failed stop is retried instead of being
        // mistaken for a confirmed stationary state.
        last_velocity_command_ = std::chrono::steady_clock::now();
      } else {
        last_velocity_command_.reset();
      }
      RCLCPP_ERROR_THROTTLE(
        logger_, *clock_, 1000, "Safety stop failed: reason=%s result=%s",
        reason.c_str(), sdk_result(result).c_str());
    }
    return result;
  }

  void watch_velocity_timeout()
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    if (control_state_ != ControlState::acquired || !highlevel_) {
      return;
    }

    const auto now = std::chrono::steady_clock::now();
    if (!velocity_safety::watchdog_expired(
        motion_active_, last_velocity_command_, now, cmd_vel_timeout_))
    {
      return;
    }

    ++cmd_vel_watchdog_stops_;
    record_error_locked("cmd_vel", "watchdog_timeout");
    const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(
      now - *last_velocity_command_);
    RCLCPP_ERROR(
      logger_, "cmd_vel watchdog expired after %ldms (limit=%ldms); forcing zero velocity",
      static_cast<long>(age.count()), static_cast<long>(cmd_vel_timeout_.count()));
    send_stop_locked("cmd_vel_timeout");
  }

  void acquire_control(const std::string & client_id, CommandResult callback)
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    const auto now = std::chrono::steady_clock::now();
    const int requested_priority = control_client_priority(client_id);
    if (requested_priority == 0) {
      callback(false, "unsupported_owner_prefix");
      return;
    }
    if (control_state_ == ControlState::cooldown && now >= cooldown_until_) {
      control_state_ = ControlState::available;
    }
    if (control_state_ == ControlState::acquired && control_owner_ == client_id) {
      lease_deadline_ = now + lease_timeout_;
      clear_fault_domain_locked(FaultDomain::authority);
      callback(true, "already_acquired");
      return;
    }
    if (control_state_ == ControlState::acquiring && control_owner_ == client_id) {
      lease_deadline_ = now + lease_timeout_;
      callback(true, "acquire_in_progress");
      return;
    }
    if (control_state_ == ControlState::acquired &&
      requested_priority > control_client_priority(control_owner_))
    {
      const std::string previous_owner = control_owner_;
      const uint32_t stop_result = send_stop_locked("authority_preempt");
      if (stop_result != 0) {
        enter_sdk_fault_locked("authority_preempt_stop", sdk_result(stop_result));
        callback(false, "preempt_stop_failed");
        return;
      }
      if (pending_locomotion_) {
        auto locomotion_callback = std::move(pending_locomotion_);
        locomotion_callback(false, "authority_preempted");
      }
      control_owner_ = client_id;
      lease_deadline_ = now + lease_timeout_;
      clear_fault_domain_locked(FaultDomain::authority);
      RCLCPP_WARN(
        logger_, "Control authority preempted: previous=%s new=%s",
        previous_owner.c_str(), client_id.c_str());
      callback(true, "control_preempted");
      return;
    }
    if (control_state_ != ControlState::available) {
      callback(false, control_state_ == ControlState::cooldown ?
        "remote_recovery_in_progress" : "control_unavailable");
      return;
    }
    if (!local_ipv4_available(local_ip_)) {
      record_error_locked("control_acquire", "local_ip_not_ready_" + local_ip_);
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
      record_error_locked("sdk_init", error.what());
      RCLCPP_ERROR(logger_, "Zsibot SDK initialization failed: %s", error.what());
      callback(false, "sdk_init_failed");
      return;
    } catch (...) {
      highlevel_.reset();
      record_error_locked("sdk_init", "unknown_exception");
      RCLCPP_ERROR(logger_, "Zsibot SDK initialization failed with an unknown exception");
      callback(false, "sdk_init_failed");
      return;
    }

    control_owner_ = client_id;
    control_state_ = ControlState::acquiring;
    pending_control_ = std::move(callback);
    acquire_deadline_ = now + acquire_timeout_;
    lease_deadline_ = now + lease_timeout_;
    clear_cached_telemetry_locked();
    motion_active_ = false;
    last_velocity_command_.reset();
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
    clear_fault_domain_locked(FaultDomain::authority);
    callback(true, "lease_renewed");
  }

  void begin_release_locked(const std::string & reason, CommandResult callback)
  {
    if (reason != "client_request") {
      record_error_locked("control_release", reason);
    }
    RCLCPP_WARN(
      logger_, "Releasing mobile control: owner=%s reason=%s safe_posture=%s",
      control_owner_.c_str(), reason.c_str(), release_safe_posture_ ? "lie_down" : "passive");
    control_state_ = ControlState::releasing;
    release_reason_ = reason;
    release_degraded_ = false;
    release_degraded_reason_.clear();
    release_phase_ = ReleasePhase::wait_for_stop;
    release_step_at_ = std::chrono::steady_clock::now() + stop_settle_time_;
    release_deadline_ = std::chrono::steady_clock::now() + release_timeout_;
    pending_control_ = std::move(callback);
    if (pending_locomotion_) {
      pending_locomotion_(false, "control_released");
      pending_locomotion_ = {};
    }
    if (highlevel_) {
      // This is deliberately attempted even when checkConnect() is false: the
      // last zero datagram may still reach the controller during a transient
      // link failure, and releasing authority must never silently skip stop.
      const uint32_t stop_result = send_stop_locked("control_release_" + reason);
      if (stop_result != 0) {
        mark_release_degraded_locked("initial_stop_failed_" + sdk_result(stop_result));
      }
    }
  }

  void mark_release_degraded_locked(const std::string & reason)
  {
    release_degraded_ = true;
    if (release_degraded_reason_.empty()) {
      release_degraded_reason_ = reason;
    }
    record_error_locked("release_safety", reason);
  }

  void finish_release_locked(
    CommandResult & completed_callback, bool & completed_success,
    std::string & completed_reason)
  {
    highlevel_.reset();
    clear_cached_telemetry_locked();
    motion_active_ = false;
    last_velocity_command_.reset();
    release_phase_ = ReleasePhase::none;
    control_state_ = ControlState::cooldown;
    cooldown_until_ = std::chrono::steady_clock::now() + remote_recovery_;
    completed_callback = std::move(pending_control_);
    completed_success = !release_degraded_;
    if (release_degraded_) {
      record_error_locked("release_safety", release_degraded_reason_);
    } else {
      clear_fault_domain_locked(FaultDomain::release);
    }
    completed_reason = release_degraded_ ?
      "released_degraded_" + release_degraded_reason_ : "released_" + release_reason_;
    RCLCPP_INFO(
      logger_, "Zsibot SDK destroyed; vendor remote recovery window started: %lds",
      static_cast<long>(remote_recovery_.count()));
    control_owner_.clear();
  }

  void handle_velocity(const geometry_msgs::msg::Twist & message)
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    ++velocity_received_;

    const std::size_t publisher_count = velocity_subscription_->get_publisher_count();
    if (publisher_count != 1) {
      ++velocity_publisher_conflicts_;
      record_error_locked(
        "cmd_vel", "publisher_count_" + std::to_string(publisher_count));
      RCLCPP_ERROR_THROTTLE(
        logger_, *clock_, 1000,
        "Final cmd_vel rejected: expected exactly one in-process arbiter publisher, found %zu",
        publisher_count);
      if (control_state_ == ControlState::acquired && highlevel_) {
        send_stop_locked("cmd_vel_publisher_conflict");
      }
      return;
    }

    const double requested_vx = message.linear.x;
    const double requested_vy = message.linear.y;
    const double requested_yaw = message.angular.z;
    const bool all_twist_fields_finite =
      std::isfinite(message.linear.x) && std::isfinite(message.linear.y) &&
      std::isfinite(message.linear.z) && std::isfinite(message.angular.x) &&
      std::isfinite(message.angular.y) && std::isfinite(message.angular.z);
    const auto command = all_twist_fields_finite ?
      velocity_safety::condition(requested_vx, requested_vy, requested_yaw, velocity_limits_) :
      velocity_safety::Command{};
    const bool requested_motion = all_twist_fields_finite &&
      velocity_safety::has_motion(requested_vx, requested_vy, requested_yaw);

    if (command.decision == velocity_safety::Decision::invalid) {
      ++velocity_invalid_rejected_;
      record_error_locked("cmd_vel", "non_finite_input");
      RCLCPP_ERROR_THROTTLE(
        logger_, *clock_, 1000,
        "Velocity rejected: Twist contains NaN/Inf; forcing zero if control is owned");
      if (control_state_ == ControlState::acquired && highlevel_) {
        send_stop_locked("invalid_cmd_vel");
      }
      return;
    }

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

    bool connected = false;
    try {
      connected = highlevel_->checkConnect();
    } catch (const std::exception & error) {
      enter_sdk_fault_locked("velocity_check_connect", error.what());
      return;
    } catch (...) {
      enter_sdk_fault_locked("velocity_check_connect", "unknown_exception");
      return;
    }
    if (!connected) {
      record_error_locked("velocity_check_connect", "sdk_not_connected");
      RCLCPP_ERROR_THROTTLE(
        logger_, *clock_, 2000,
        "Velocity rejected: SDK disconnected requested=(%.3f, %.3f, %.3f); forcing zero",
        requested_vx, requested_vy, requested_yaw);
      send_stop_locked("sdk_disconnected_on_cmd_vel");
      return;
    }

    if (command.decision == velocity_safety::Decision::stop) {
      if (!velocity_safety::idle_zero_requires_sdk_stop(
          motion_active_, idle_zero_stop_attempted_))
      {
        return;
      }
      idle_zero_stop_attempted_ = true;
      if (command.stopped_by_deadband) {
        ++velocity_deadband_stops_;
        RCLCPP_INFO_THROTTLE(
          logger_, *clock_, 2000,
          "Velocity inside %s SDK deadband; explicit zero sent: requested=(%.3f, %.3f, %.3f)",
          kZsibotModel, requested_vx, requested_vy, requested_yaw);
      } else {
        ++zero_velocity_stops_;
      }
      const uint32_t stop_result =
        send_stop_locked(command.stopped_by_deadband ? "cmd_vel_deadband" : "cmd_vel_zero");
      if (stop_result == 0) {
        clear_fault_domain_locked(FaultDomain::motion_input);
      }
      return;
    }

    if (command.limited) {
      ++velocity_limited_;
    }
    last_velocity_command_ = std::chrono::steady_clock::now();
    const float vx = static_cast<float>(command.vx);
    const float vy = static_cast<float>(command.vy);
    const float yaw = static_cast<float>(command.yaw);
    ++velocity_forwarded_;
    uint32_t result = 0xFFFFFFFFU;
    std::string exception_detail;
    try {
      result = highlevel_->move(vx, vy, yaw);
    } catch (const std::exception & error) {
      exception_detail = error.what();
      RCLCPP_ERROR(logger_, "Velocity SDK call threw: %s", error.what());
    } catch (...) {
      exception_detail = "unknown_exception";
      RCLCPP_ERROR(logger_, "Velocity SDK call threw an unknown exception");
    }
    last_move_result_ = result;
    record_sdk_result_locked("velocity_move", result);
    if (!exception_detail.empty()) {
      record_error_locked("velocity_move", exception_detail);
    }
    const auto move_policy = velocity_safety::sdk_move_result_policy(result);
    if (move_policy.accepted) {
      motion_active_ = true;
      idle_zero_stop_attempted_ = false;
      clear_fault_domain_locked(FaultDomain::motion_input);
      RCLCPP_INFO_THROTTLE(
        logger_, *clock_, 1000,
        "Velocity accepted: requested=(%.3f, %.3f, %.3f) sdk=(%.3f, %.3f, %.3f)",
        requested_vx, requested_vy, requested_yaw, vx, vy, yaw);
      return;
    }

    // A rejected command does not prove that the previous SDK command stopped.
    // Force zero immediately; if this stop also fails, send_stop_locked keeps
    // a conservative possible-motion state armed so the watchdog retries.
    const std::string move_failure = sdk_result(result);
    motion_active_ = move_policy.arm_watchdog_until_stop_confirmed;
    if (move_policy.force_stop) {
      // This is already the first stop attempt for the failed motion update.
      // Repeated arbiter zeros must not hammer the SDK; watchdog/direct E-stop
      // retries remain independent of this ordinary idle-stream gate.
      idle_zero_stop_attempted_ = true;
      send_stop_locked("motion_command_failed");
    }
    RCLCPP_ERROR_THROTTLE(
      logger_, *clock_, 1000,
      "Velocity SDK failure: requested=(%.3f, %.3f, %.3f) sdk=(%.3f, %.3f, %.3f) result=%s",
      requested_vx, requested_vy, requested_yaw, vx, vy, yaw, move_failure.c_str());
  }

  void poll_sdk()
  {
    CommandResult completed_callback;
    bool callback_success = false;
    std::string callback_reason;

    try {
      std::lock_guard<std::mutex> lock(sdk_mutex_);
      const auto now = std::chrono::steady_clock::now();
      if (control_state_ == ControlState::cooldown && now >= cooldown_until_) {
        control_state_ = ControlState::available;
        release_reason_.clear();
        RCLCPP_INFO(logger_, "Vendor remote recovery window complete; mobile control is available");
      }

      const auto previous_connection = last_connected_;
      const bool connected = highlevel_ && highlevel_->checkConnect();
      if (highlevel_ && (!previous_connection.has_value() || connected != *previous_connection)) {
        if (connected && highlevel_) {
          RCLCPP_INFO(logger_, "Zsibot SDK connection state: connected model=%s", kZsibotModel);
        } else {
          RCLCPP_WARN(logger_, "Zsibot SDK connection state: disconnected model=%s", kZsibotModel);
        }
      }

      uint32_t mode = 0;
      if (connected) {
        mode = highlevel_->getCurrentCtrlmode();
        cache_telemetry_locked(true, mode, now);
        mark_poll_healthy_locked();
      } else if (highlevel_) {
        cache_telemetry_locked(false, std::nullopt, now);
        if (!previous_connection.has_value() || *previous_connection) {
          record_error_locked("poll_connection", "sdk_disconnected");
        }
      } else if (last_connected_.has_value() || control_mode_cache_.has_value() ||
        battery_fraction_.has_value())
      {
        clear_cached_telemetry_locked();
      }

      if (control_state_ == ControlState::acquiring) {
        if (connected) {
          control_state_ = ControlState::acquired;
          lease_deadline_ = now + lease_timeout_;
          motion_active_ = false;
          last_velocity_command_.reset();
          clear_fault_domain_locked(FaultDomain::authority);
          completed_callback = std::move(pending_control_);
          callback_success = true;
          callback_reason = "control_acquired";
          RCLCPP_INFO(
            logger_, "Mobile control acquired: owner=%s model=%s mode=%s",
            control_owner_.c_str(), kZsibotModel, control_mode(mode).c_str());
        } else if (now >= acquire_deadline_) {
          record_error_locked("control_acquire", "sdk_connect_timeout");
          highlevel_.reset();
          control_state_ = ControlState::cooldown;
          cooldown_until_ = now + remote_recovery_;
          control_owner_.clear();
          motion_active_ = false;
          last_velocity_command_.reset();
          completed_callback = std::move(pending_control_);
          callback_reason = "sdk_connect_timeout";
          RCLCPP_ERROR(
            logger_, "Mobile control acquisition timed out after %lds",
            static_cast<long>(acquire_timeout_.count()));
        }
      } else if (control_state_ == ControlState::acquired) {
        if (!connected) {
          // Do not keep a two-second grace period while the controller may be
          // executing its last command. Stop and give up authority immediately.
          begin_release_locked("sdk_disconnected", {});
        }
        if (control_state_ == ControlState::acquired && now >= lease_deadline_) {
          begin_release_locked("heartbeat_timeout", {});
        }
      }

      if (control_state_ == ControlState::releasing && now >= release_step_at_) {
        if (release_phase_ == ReleasePhase::wait_for_stop) {
          if (!connected || !highlevel_) {
            mark_release_degraded_locked("connection_lost_before_release_confirmation");
            finish_release_locked(completed_callback, callback_success, callback_reason);
          } else if (!release_safe_posture_ || mode == 0) {
            if (!release_safe_posture_) {
              const uint32_t passive_result = highlevel_->passive();
              record_sdk_result_locked("release_passive", passive_result);
              if (passive_result != 0) {
                mark_release_degraded_locked("passive_failed_" + sdk_result(passive_result));
              }
              RCLCPP_INFO(
                logger_, "Release step passive: result=%s", sdk_result(passive_result).c_str());
            }
            finish_release_locked(completed_callback, callback_success, callback_reason);
          } else {
            const uint32_t lie_result = highlevel_->lieDown();
            record_sdk_result_locked("release_lie_down", lie_result);
            RCLCPP_INFO(
              logger_, "Release step lie_down: mode=%s result=%s",
              control_mode(mode).c_str(), sdk_result(lie_result).c_str());
            if (lie_result == 0) {
              release_phase_ = ReleasePhase::wait_for_lie_down;
              release_step_at_ = now + 250ms;
            } else {
              const uint32_t passive_result = highlevel_->passive();
              record_sdk_result_locked("release_passive_fallback", passive_result);
              mark_release_degraded_locked(
                "lie_down_failed_" + sdk_result(lie_result) + "_fallback_" +
                sdk_result(passive_result));
              RCLCPP_WARN(
                logger_, "Lie-down failed; passive fallback sent: result=%s",
                sdk_result(passive_result).c_str());
              release_phase_ = ReleasePhase::wait_after_passive;
              release_step_at_ = now + 500ms;
            }
          }
        } else if (release_phase_ == ReleasePhase::wait_for_lie_down) {
          if (!connected || mode == 0) {
            if (!connected) {
              mark_release_degraded_locked("connection_lost_before_lie_down_confirmation");
            }
            finish_release_locked(completed_callback, callback_success, callback_reason);
          } else if (now >= release_deadline_) {
            const uint32_t passive_result = highlevel_->passive();
            record_sdk_result_locked("release_passive_timeout", passive_result);
            mark_release_degraded_locked(
              "lie_down_timeout_mode_" + std::to_string(mode) + "_fallback_" +
              sdk_result(passive_result));
            RCLCPP_WARN(
              logger_, "Lie-down timed out in mode=%s; passive fallback sent: result=%s",
              control_mode(mode).c_str(), sdk_result(passive_result).c_str());
            release_phase_ = ReleasePhase::wait_after_passive;
            release_step_at_ = now + 500ms;
          } else {
            release_step_at_ = now + 250ms;
          }
        } else if (release_phase_ == ReleasePhase::wait_after_passive) {
          finish_release_locked(completed_callback, callback_success, callback_reason);
        }
      }

      if (pending_locomotion_ && control_state_ == ControlState::acquired) {
        if (!connected) {
          completed_callback = std::move(pending_locomotion_);
          callback_reason = "sdk_disconnected_while_standing";
        } else if (is_ready_for_velocity(mode)) {
          clear_fault_domain_locked(FaultDomain::locomotion);
          completed_callback = std::move(pending_locomotion_);
          callback_success = true;
          callback_reason = "standing_ready";
          RCLCPP_INFO(
            logger_, "LOCO auto-stand completed: model=%s mode=%s",
            kZsibotModel, control_mode(mode).c_str());
        } else if (now >= locomotion_deadline_) {
          record_error_locked(
            "locomotion_stand", "timeout_mode_" + std::to_string(mode));
          completed_callback = std::move(pending_locomotion_);
          callback_reason = "stand_timeout_mode_" + std::to_string(mode);
          RCLCPP_ERROR(
            logger_, "LOCO auto-stand timed out: model=%s mode=%s timeout_sec=%ld",
            kZsibotModel, control_mode(mode).c_str(),
            static_cast<long>(stand_timeout_.count()));
        }
      }

      if (now >= next_diagnostics_) {
        std::optional<uint32_t> battery;
        if (connected && highlevel_) {
          battery = highlevel_->getBatteryPower();
          const auto fraction = battery_fraction_from_percent(*battery);
          if (fraction) {
            battery_fraction_ = *fraction;
            battery_sample_known_ = true;
            battery_sample_at_ = now;
            clear_fault_domain_locked(FaultDomain::battery);
            ++state_sequence_;
          } else {
            battery_fraction_.reset();
            battery_sample_known_ = false;
            record_error_locked(
              "battery_sample", "percent_out_of_range_" + std::to_string(*battery));
          }
        }
        RCLCPP_INFO(
          logger_,
          "Zsibot diagnostics: model=%s authority=%s connected=%s mode=%s battery=%s "
          "cmd_vel_publishers=%zu received=%llu forwarded=%llu zero_stops=%llu "
          "deadband_stops=%llu invalid_rejected=%llu limited=%llu not_owned=%llu "
          "publisher_conflicts=%llu "
          "watchdog_stops=%llu stop_sent=%llu stop_failures=%llu last_move=%s",
          kZsibotModel, control_status_locked().c_str(),
          connected ? "true" : "false",
          connected ? control_mode(mode).c_str() : "unavailable",
          battery ? std::to_string(*battery).c_str() : "unavailable",
          velocity_subscription_->get_publisher_count(),
          static_cast<unsigned long long>(velocity_received_),
          static_cast<unsigned long long>(velocity_forwarded_),
          static_cast<unsigned long long>(zero_velocity_stops_),
          static_cast<unsigned long long>(velocity_deadband_stops_),
          static_cast<unsigned long long>(velocity_invalid_rejected_),
          static_cast<unsigned long long>(velocity_limited_),
          static_cast<unsigned long long>(velocity_not_owned_ignored_),
          static_cast<unsigned long long>(velocity_publisher_conflicts_),
          static_cast<unsigned long long>(cmd_vel_watchdog_stops_),
          static_cast<unsigned long long>(stop_commands_sent_),
          static_cast<unsigned long long>(stop_command_failures_),
          sdk_result(last_move_result_).c_str());
        next_diagnostics_ = now + diagnostics_period_;
      }
    } catch (const std::exception & error) {
      std::lock_guard<std::mutex> lock(sdk_mutex_);
      enter_sdk_fault_locked("poll", error.what());
      callback_success = false;
      callback_reason = "sdk_exception";
    } catch (...) {
      std::lock_guard<std::mutex> lock(sdk_mutex_);
      enter_sdk_fault_locked("poll", "unknown_exception");
      callback_success = false;
      callback_reason = "sdk_exception";
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
  bool idle_zero_stop_attempted_{false};
  velocity_safety::Limits velocity_limits_;
  std::optional<bool> last_connected_;
  std::optional<uint32_t> control_mode_cache_;
  std::optional<float> battery_fraction_;
  bool telemetry_sample_known_{false};
  AdapterSteadyTime telemetry_sample_at_{};
  bool battery_sample_known_{false};
  AdapterSteadyTime battery_sample_at_{};
  bool last_sdk_result_known_{false};
  uint32_t last_sdk_result_code_{0};
  std::string last_sdk_result_{"unknown"};
  std::array<ActiveFault, fault_domain_count> active_faults_{};
  uint64_t fault_ordinal_{0};
  std::string last_error_domain_{"none"};
  std::string last_error_;
  bool last_error_sample_known_{false};
  AdapterSteadyTime last_error_at_{};
  uint64_t state_sequence_{0};
  std::optional<std::chrono::steady_clock::time_point> last_velocity_command_;
  ControlState control_state_{ControlState::available};
  ReleasePhase release_phase_{ReleasePhase::none};
  std::string control_owner_;
  std::string release_reason_;
  bool release_degraded_{false};
  std::string release_degraded_reason_;
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
  std::chrono::milliseconds cmd_vel_timeout_{kDefaultCmdVelTimeoutMs};
  std::chrono::seconds diagnostics_period_{10};
  std::chrono::seconds acquire_timeout_{10};
  std::chrono::seconds lease_timeout_{5};
  std::chrono::seconds release_timeout_{8};
  std::chrono::seconds remote_recovery_{3};
  uint32_t last_move_result_{0};
  uint64_t velocity_received_{0};
  uint64_t velocity_forwarded_{0};
  uint64_t zero_velocity_stops_{0};
  uint64_t velocity_deadband_stops_{0};
  uint64_t velocity_invalid_rejected_{0};
  uint64_t velocity_limited_{0};
  uint64_t velocity_not_owned_ignored_{0};
  uint64_t velocity_publisher_conflicts_{0};
  uint64_t cmd_vel_watchdog_stops_{0};
  uint64_t stop_commands_sent_{0};
  uint64_t stop_command_failures_{0};
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr velocity_subscription_;
  rclcpp::TimerBase::SharedPtr diagnostics_timer_;
  rclcpp::TimerBase::SharedPtr velocity_watchdog_timer_;
};

#else

class ZsibotAdapter final : public RobotAdapter
{
public:
  explicit ZsibotAdapter(rclcpp::Logger logger)
  : logger_(std::move(logger)) {}

  std::string name() const override {return "zsibot";}

  AdapterSnapshot snapshot() const override
  {
    AdapterSnapshot value;
    value.adapter_name = "zsibot";
    value.battery_presence_known = true;
    value.battery_present = true;
    value.authority_known = true;
    value.authority_state = "unavailable";
    value.last_error_active = true;
    value.last_error_domain = "adapter";
    value.last_error = "zsibot_sdk_not_built";
    return value;
  }

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

#include "rosdeck_robot_bridge/robot_adapter.hpp"

#include <atomic>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>

#include <function_msgs/srv/set_run_mode.hpp>
#include <software_msgs/srv/lowlevel_action.hpp>

namespace rosdeck_robot_bridge
{
namespace
{

using namespace std::chrono_literals;

std::string make_request_id()
{
  static std::atomic_uint64_t sequence{0};
  std::ostringstream stream;
  stream << "rosdeck-" << rclcpp::Clock(RCL_SYSTEM_TIME).now().nanoseconds()
         << '-' << sequence.fetch_add(1);
  return stream.str();
}

std::string response_reason(const std::string & message, std::int32_t error_code)
{
  return message.empty() ? "error_code_" + std::to_string(error_code) : message;
}

enum class CommandDomain : std::size_t
{
  locomotion,
  posture,
  count,
};

const char * command_domain_name(CommandDomain domain)
{
  switch (domain) {
    case CommandDomain::locomotion:
      return "locomotion_service";
    case CommandDomain::posture:
      return "posture_service";
    case CommandDomain::count:
      break;
  }
  return "command_service";
}

struct CommandFault
{
  bool active{false};
  std::string message;
  AdapterSteadyTime at{};
  uint64_t ordinal{0};
};

class VbotAdapter final : public RobotAdapter
{
public:
  VbotAdapter(
    rclcpp::Node & node,
    std::string locomotion_service,
    std::string posture_service)
  : node_(node),
    locomotion_service_(std::move(locomotion_service)),
    posture_service_(std::move(posture_service))
  {
    locomotion_client_ = node_.create_client<function_msgs::srv::SetRunMode>(
      locomotion_service_);
    if (!posture_service_.empty()) {
      posture_client_ = node_.create_client<software_msgs::srv::LowlevelAction>(
        posture_service_);
    }
  }

  std::string name() const override {return "vbot";}

  AdapterSnapshot snapshot() const override
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    AdapterSnapshot value;
    value.adapter_name = "vbot";
    // This adapter exposes command services only. It has no authoritative
    // connection, battery, control-mode, or posture telemetry source.
    value.battery_presence_known = true;
    value.battery_present = true;
    value.authority_known = true;
    value.authority_state = "unsupported";
    const CommandFault * newest_active_fault = nullptr;
    CommandDomain newest_active_domain = CommandDomain::locomotion;
    for (std::size_t index = 0; index < command_faults_.size(); ++index) {
      const auto & fault = command_faults_[index];
      if (fault.active &&
        (!newest_active_fault || fault.ordinal > newest_active_fault->ordinal))
      {
        newest_active_fault = &fault;
        newest_active_domain = static_cast<CommandDomain>(index);
      }
    }
    value.last_error_active = newest_active_fault != nullptr;
    if (newest_active_fault) {
      value.last_error_domain = command_domain_name(newest_active_domain);
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

  void request_locomotion(CommandResult callback) override
  {
    if (!locomotion_client_->wait_for_service(1s)) {
      record_result(CommandDomain::locomotion, false, "locomotion_service_not_ready");
      callback(false, "service_not_ready");
      return;
    }

    auto request = std::make_shared<function_msgs::srv::SetRunMode::Request>();
    request->target_state = 1;
    request->mode = 2;  // MODE_LOCO
    request->req_id = make_request_id();
    request->pre_check = false;
    request->has_is_traction_user_param = false;
    request->is_traction_user_param = false;

    locomotion_client_->async_send_request(
      request,
      [this, callback = std::move(callback)](
        rclcpp::Client<function_msgs::srv::SetRunMode>::SharedFuture future)
      {
        try {
          const auto response = future.get();
          const std::string reason = response->success ? "ok" :
            response_reason(response->message, response->error_code);
          record_result(CommandDomain::locomotion, response->success, "locomotion_" + reason);
          callback(
            response->success,
            reason);
        } catch (const std::exception & error) {
          const std::string reason = std::string("service_call_failed_") + error.what();
          record_result(CommandDomain::locomotion, false, "locomotion_" + reason);
          callback(false, reason);
        } catch (...) {
          record_result(
            CommandDomain::locomotion, false,
            "locomotion_service_call_failed_unknown_exception");
          callback(false, "service_call_failed_unknown_exception");
        }
      });
  }

  void request_posture(const std::string & command, CommandResult callback) override
  {
    const std::uint8_t mode = command == "stand" ? 1 : command == "lie_down" ? 2 : command == "emergency_stop" ? 4 : 0;
    if (mode == 0) {
      record_result(CommandDomain::posture, false, "posture_unsupported_command");
      callback(false, "unsupported_command");
      return;
    }
    if (!ensure_posture_client()) {
      record_result(CommandDomain::posture, false, "posture_service_not_found");
      callback(false, "lowlevel_action_service_not_found");
      return;
    }
    if (!posture_client_->wait_for_service(1s)) {
      record_result(CommandDomain::posture, false, "posture_service_not_ready");
      callback(false, "service_not_ready");
      return;
    }

    auto request = std::make_shared<software_msgs::srv::LowlevelAction::Request>();
    request->target_state = 1;
    request->mode = mode;
    request->req_id = make_request_id();
    request->pre_check = false;
    request->action_path = "";
    request->action_params_json = "{}";

    posture_client_->async_send_request(
      request,
      [this, command, callback = std::move(callback)](
        rclcpp::Client<software_msgs::srv::LowlevelAction>::SharedFuture future)
      {
        try {
          const auto response = future.get();
          const std::string reason = response->success ? "ok" :
            response_reason(response->message, response->error_code);
          record_result(
            CommandDomain::posture, response->success,
            "posture_" + command + '_' + reason);
          callback(
            response->success,
            reason);
        } catch (const std::exception & error) {
          const std::string reason = std::string("service_call_failed_") + error.what();
          record_result(
            CommandDomain::posture, false, "posture_" + command + '_' + reason);
          callback(false, reason);
        } catch (...) {
          record_result(
            CommandDomain::posture, false,
            "posture_" + command + "_service_call_failed_unknown_exception");
          callback(false, "service_call_failed_unknown_exception");
        }
      });
  }

private:
  void record_result(CommandDomain domain, bool success, const std::string & context)
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    ++state_sequence_;
    auto & fault = command_faults_[static_cast<std::size_t>(domain)];
    if (!success) {
      const auto now = AdapterSteadyClock::now();
      fault.active = true;
      fault.message = context;
      fault.at = now;
      fault.ordinal = ++fault_ordinal_;
      last_error_ = context;
      last_error_domain_ = command_domain_name(domain);
      last_error_sample_known_ = true;
      last_error_at_ = now;
    } else {
      fault.active = false;
    }
  }

  bool ensure_posture_client()
  {
    if (posture_client_) {
      return true;
    }
    constexpr const char * expected_type = "software_msgs/srv/LowlevelAction";
    for (const auto & [service_name, service_types] : node_.get_service_names_and_types()) {
      for (const auto & service_type : service_types) {
        if (service_type == expected_type) {
          posture_service_ = service_name;
          posture_client_ = node_.create_client<software_msgs::srv::LowlevelAction>(service_name);
          RCLCPP_INFO(
            node_.get_logger(), "Discovered LowlevelAction service: %s",
            service_name.c_str());
          return true;
        }
      }
    }
    return false;
  }

  rclcpp::Node & node_;
  mutable std::mutex state_mutex_;
  std::array<CommandFault, static_cast<std::size_t>(CommandDomain::count)> command_faults_{};
  uint64_t fault_ordinal_{0};
  bool last_error_sample_known_{false};
  std::string last_error_domain_{"none"};
  std::string last_error_;
  AdapterSteadyTime last_error_at_{};
  uint64_t state_sequence_{0};
  std::string locomotion_service_;
  std::string posture_service_;
  rclcpp::Client<function_msgs::srv::SetRunMode>::SharedPtr locomotion_client_;
  rclcpp::Client<software_msgs::srv::LowlevelAction>::SharedPtr posture_client_;
};

}  // namespace

std::unique_ptr<RobotAdapter> make_vbot_adapter(
  rclcpp::Node & node,
  const std::string & locomotion_service,
  const std::string & posture_service)
{
  return std::make_unique<VbotAdapter>(node, locomotion_service, posture_service);
}

}  // namespace rosdeck_robot_bridge

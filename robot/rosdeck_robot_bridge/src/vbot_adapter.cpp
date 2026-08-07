#include "rosdeck_robot_bridge/robot_adapter.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <exception>
#include <memory>
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

  void request_locomotion(CommandResult callback) override
  {
    if (!locomotion_client_->wait_for_service(1s)) {
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
      [callback = std::move(callback)](
        rclcpp::Client<function_msgs::srv::SetRunMode>::SharedFuture future)
      {
        try {
          const auto response = future.get();
          callback(
            response->success,
            response->success ? "ok" : response_reason(response->message, response->error_code));
        } catch (const std::exception & error) {
          callback(false, std::string("service_call_failed_") + error.what());
        }
      });
  }

  void request_posture(const std::string & command, CommandResult callback) override
  {
    const std::uint8_t mode = command == "stand" ? 1 : command == "lie_down" ? 2 : 0;
    if (mode == 0) {
      callback(false, "unsupported_command");
      return;
    }
    if (!ensure_posture_client()) {
      callback(false, "lowlevel_action_service_not_found");
      return;
    }
    if (!posture_client_->wait_for_service(1s)) {
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
      [callback = std::move(callback)](
        rclcpp::Client<software_msgs::srv::LowlevelAction>::SharedFuture future)
      {
        try {
          const auto response = future.get();
          callback(
            response->success,
            response->success ? "ok" : response_reason(response->message, response->error_code));
        } catch (const std::exception & error) {
          callback(false, std::string("service_call_failed_") + error.what());
        }
      });
  }

private:
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
          RCLCPP_INFO(node_.get_logger(), "Discovered LowlevelAction service: %s", service_name.c_str());
          return true;
        }
      }
    }
    return false;
  }

  rclcpp::Node & node_;
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

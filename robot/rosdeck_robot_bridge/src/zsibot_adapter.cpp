#include "rosdeck_robot_bridge/robot_adapter.hpp"

#include <cstdint>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
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

#if defined(ROSDECK_ZSIBOT_MODEL_ZSL1)
using ZsibotHighLevel = mc_sdk::zsl_1::HighLevel;
#elif defined(ROSDECK_ZSIBOT_MODEL_ZSL1W)
using ZsibotHighLevel = mc_sdk::zsl_1w::HighLevel;
#endif

std::string sdk_error(uint32_t code)
{
  std::ostringstream stream;
  stream << "sdk_error_0x" << std::hex << std::setfill('0') << std::setw(4) << code;
  return stream.str();
}

class ZsibotAdapter final : public RobotAdapter
{
public:
  explicit ZsibotAdapter(rclcpp::Node & node)
  : logger_(node.get_logger())
  {
    const auto local_ip = node.declare_parameter<std::string>(
      "zsibot.local_ip", "127.0.0.1");
    const auto local_port = node.declare_parameter<int64_t>(
      "zsibot.local_port", 43988);
    const auto dog_ip = node.declare_parameter<std::string>(
      "zsibot.dog_ip", "192.168.234.1");
    const auto velocity_topic = node.declare_parameter<std::string>(
      "zsibot.velocity_topic", "/vel_cmd");

    highlevel_.initRobot(local_ip, static_cast<int>(local_port), dog_ip);
    velocity_subscription_ = node.create_subscription<geometry_msgs::msg::Twist>(
      velocity_topic, 10,
      [this](const geometry_msgs::msg::Twist::SharedPtr message) {
        std::lock_guard<std::mutex> lock(sdk_mutex_);
        const uint32_t result = highlevel_.move(
          static_cast<float>(message->linear.x),
          static_cast<float>(message->linear.y),
          static_cast<float>(message->angular.z));
        if (result != 0 && result != last_move_error_) {
          RCLCPP_WARN(
            logger_, "Zsibot move command failed: %s", sdk_error(result).c_str());
        }
        last_move_error_ = result;
      });
    RCLCPP_INFO(
      logger_, "Zsibot SDK initialized: local=%s:%ld robot=%s velocity=%s",
      local_ip.c_str(), static_cast<long>(local_port), dog_ip.c_str(), velocity_topic.c_str());
  }

  std::string name() const override {return "zsibot";}

  void request_locomotion(CommandResult callback) override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    callback(highlevel_.checkConnect(), "sdk_not_connected");
  }

  void request_posture(const std::string & command, CommandResult callback) override
  {
    std::lock_guard<std::mutex> lock(sdk_mutex_);
    if (!highlevel_.checkConnect()) {
      callback(false, "sdk_not_connected");
      return;
    }
    const uint32_t result = command == "stand" ? highlevel_.standUp() : highlevel_.lieDown();
    callback(result == 0, result == 0 ? "ok" : sdk_error(result));
  }

private:
  rclcpp::Logger logger_;
  ZsibotHighLevel highlevel_;
  std::mutex sdk_mutex_;
  uint32_t last_move_error_{0};
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr velocity_subscription_;
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

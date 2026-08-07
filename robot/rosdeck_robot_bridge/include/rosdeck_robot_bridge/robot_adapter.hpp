#pragma once

#include <functional>
#include <memory>
#include <string>

#include <rclcpp/rclcpp.hpp>

namespace rosdeck_robot_bridge
{

using CommandResult = std::function<void(bool, const std::string &)>;

class RobotAdapter
{
public:
  virtual ~RobotAdapter() = default;
  virtual std::string name() const = 0;
  virtual void request_locomotion(CommandResult callback) = 0;
  virtual void request_posture(const std::string & command, CommandResult callback) = 0;
};

#ifdef ROSDECK_HAS_VBOT_ADAPTER
std::unique_ptr<RobotAdapter> make_vbot_adapter(
  rclcpp::Node & node,
  const std::string & locomotion_service,
  const std::string & posture_service);
#endif

std::unique_ptr<RobotAdapter> make_zsibot_adapter(rclcpp::Node & node);

}  // namespace rosdeck_robot_bridge

#pragma once

#include "rosdeck_robot_bridge/adapter_observability.hpp"

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
  // This getter may copy cached state under a mutex, but must never perform
  // transport I/O or call into a vendor SDK.
  virtual AdapterSnapshot snapshot() const = 0;
  virtual void request_locomotion(CommandResult callback) = 0;
  virtual void request_posture(const std::string & command, CommandResult callback) = 0;
  virtual void emergency_stop(CommandResult callback)
  {
    callback(false, "emergency_stop_not_supported");
  }

  // Adapters such as Zsibot must explicitly arbitrate control with the vendor
  // remote.  The default implementation keeps existing VBot deployments
  // compatible: no ownership protocol is exposed and commands remain direct.
  virtual bool requires_control_lease() const {return false;}
  virtual std::string control_status() const {return "unsupported";}
  virtual void request_control(
    const std::string &, const std::string &, CommandResult callback)
  {
    callback(false, "control_lease_not_supported");
  }
};

#ifdef ROSDECK_HAS_VBOT_ADAPTER
std::unique_ptr<RobotAdapter> make_vbot_adapter(
  rclcpp::Node & node,
  const std::string & locomotion_service,
  const std::string & posture_service);
#endif

std::unique_ptr<RobotAdapter> make_zsibot_adapter(rclcpp::Node & node);

}  // namespace rosdeck_robot_bridge

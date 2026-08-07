#include "rosdeck_robot_bridge/robot_adapter.hpp"

#include <memory>
#include <string>
#include <utility>

namespace rosdeck_robot_bridge
{
namespace
{

// Protocol placeholder for the next robot family. Phone-facing topics are
// already stable; only these two methods need to be connected to Zsibot's
// native services/actions once its SDK definitions are available.
class ZsibotAdapter final : public RobotAdapter
{
public:
  explicit ZsibotAdapter(rclcpp::Logger logger)
  : logger_(std::move(logger)) {}

  std::string name() const override {return "zsibot";}

  void request_locomotion(CommandResult callback) override
  {
    RCLCPP_WARN(logger_, "Zsibot locomotion interface is not configured yet");
    callback(false, "zsibot_adapter_not_configured");
  }

  void request_posture(const std::string &, CommandResult callback) override
  {
    RCLCPP_WARN(logger_, "Zsibot posture interface is not configured yet");
    callback(false, "zsibot_adapter_not_configured");
  }

private:
  rclcpp::Logger logger_;
};

}  // namespace

std::unique_ptr<RobotAdapter> make_zsibot_adapter(rclcpp::Node & node)
{
  return std::make_unique<ZsibotAdapter>(node.get_logger());
}

}  // namespace rosdeck_robot_bridge

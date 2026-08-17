#include "rosdeck_robot_bridge/safety_supervisor.hpp"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/string.hpp>
#include <std_srvs/srv/trigger.hpp>

namespace rosdeck_robot_bridge
{
namespace
{

using namespace std::chrono_literals;

constexpr char kEstopOutputTopic[] = "/omni/safety/estop";
constexpr char kEstopRequestTopic[] = "/omni/safety/estop_request";
constexpr char kSupervisorStatusTopic[] = "/omni/safety/supervisor_status";
constexpr char kArmService[] = "/omni/safety/arm_supervisor";
constexpr char kLatchService[] = "/omni/safety/latch_estop";
constexpr char kDefaultLockPath[] = "/run/lock/omni/safety_supervisor.lock";

class SupervisorInstanceLock
{
public:
  SupervisorInstanceLock()
  {
    const char * override_path = std::getenv("OMNI_SAFETY_SUPERVISOR_LOCK");
    path_ = override_path && override_path[0] != '\0' ? override_path : kDefaultLockPath;
    ensure_lock_directory(path_);
    fd_ = ::open(path_.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0640);
    if (fd_ < 0) {
      throw std::runtime_error(
              "cannot open safety supervisor lock " + path_ + ": " + std::strerror(errno));
    }
    if (::flock(fd_, LOCK_EX | LOCK_NB) != 0) {
      const int error = errno;
      close_fd();
      throw std::runtime_error(
              "another safety supervisor already owns " + path_ + ": " +
              std::strerror(error));
    }
    struct stat status {};
    if (::fstat(fd_, &status) != 0 || !S_ISREG(status.st_mode) ||
      status.st_uid != ::geteuid() || status.st_nlink != 1 ||
      (status.st_mode & 0022) != 0)
    {
      unlock_and_close();
      throw std::runtime_error("safety supervisor lock is not a safe owner-controlled file");
    }
    const std::string identity = "rosdeck_safety_supervisor pid=" +
      std::to_string(::getpid()) + "\n";
    if (::ftruncate(fd_, 0) != 0) {
      const int error = errno;
      unlock_and_close();
      throw std::runtime_error(
              "cannot record safety supervisor owner: " + std::string(std::strerror(error)));
    }
    const ssize_t written = ::write(fd_, identity.data(), identity.size());
    if (written != static_cast<ssize_t>(identity.size())) {
      const int error = written < 0 ? errno : EIO;
      unlock_and_close();
      throw std::runtime_error(
              "cannot record safety supervisor owner: " + std::string(std::strerror(error)));
    }
  }

  SupervisorInstanceLock(const SupervisorInstanceLock &) = delete;
  SupervisorInstanceLock & operator=(const SupervisorInstanceLock &) = delete;

  ~SupervisorInstanceLock() {unlock_and_close();}

private:
  static void ensure_lock_directory(const std::string & path)
  {
    const auto separator = path.find_last_of('/');
    if (path.empty() || path.front() != '/' || separator == std::string::npos || separator == 0) {
      throw std::runtime_error(
              "safety supervisor lock path must be absolute and inside a protected directory");
    }
    const std::string directory = path.substr(0, separator);
    if (path == kDefaultLockPath && ::mkdir(directory.c_str(), 0750) != 0 && errno != EEXIST) {
      throw std::runtime_error(
              std::string("cannot create safety lock directory: ") + std::strerror(errno));
    }
    struct stat status {};
    if (::lstat(directory.c_str(), &status) != 0 || !S_ISDIR(status.st_mode) ||
      status.st_uid != ::geteuid() || (status.st_mode & 0022) != 0)
    {
      throw std::runtime_error(
              "safety lock directory is not a protected owner-controlled directory");
    }
  }

  void close_fd()
  {
    if (fd_ >= 0) {
      (void)::close(fd_);
      fd_ = -1;
    }
  }

  void unlock_and_close()
  {
    if (fd_ >= 0) {
      (void)::flock(fd_, LOCK_UN);
      close_fd();
    }
  }

  std::string path_;
  int fd_{-1};
};

class SafetySupervisorNode final : public rclcpp::Node
{
public:
  SafetySupervisorNode()
  : Node("rosdeck_safety_supervisor"), instance_lock_(std::make_unique<SupervisorInstanceLock>())
  {
    const auto bounded_milliseconds =
      [this](const std::string & name, int64_t fallback, int64_t minimum, int64_t maximum) {
        const auto requested = declare_parameter<int64_t>(name, fallback);
        if (requested < minimum || requested > maximum) {
          RCLCPP_WARN(
            get_logger(), "%s=%ld is outside [%ld, %ld]; clamping",
            name.c_str(), static_cast<long>(requested), static_cast<long>(minimum),
            static_cast<long>(maximum));
        }
        return std::chrono::milliseconds(std::clamp(requested, minimum, maximum));
      };

    output_period_ = bounded_milliseconds(
      "safety_supervisor.output_period_ms", 100, 20, 250);
    const auto requested_heartbeat_deadline = declare_parameter<int64_t>(
      "safety_supervisor.heartbeat_deadline_ms", 500);
    if (requested_heartbeat_deadline < 100 || requested_heartbeat_deadline > 500) {
      throw std::invalid_argument(
              "safety_supervisor.heartbeat_deadline_ms must be in [100, 500]");
    }
    heartbeat_deadline_ = std::chrono::milliseconds(requested_heartbeat_deadline);
    status_period_ = bounded_milliseconds(
      "safety_supervisor.status_period_ms", 1000, 100, 5000);
    if (heartbeat_deadline_ < output_period_ * 2) {
      throw std::invalid_argument(
              "safety_supervisor.heartbeat_deadline_ms must be at least two output periods");
    }
    state_ = std::make_unique<safety_supervisor::StateMachine>(
      safety_supervisor::Config{heartbeat_deadline_});

    const auto output_topic = declare_parameter<std::string>(
      "safety_supervisor.topics.estop", kEstopOutputTopic);
    const auto request_topic = declare_parameter<std::string>(
      "safety_supervisor.topics.request", kEstopRequestTopic);
    const auto status_topic = declare_parameter<std::string>(
      "safety_supervisor.topics.status", kSupervisorStatusTopic);
    const auto arm_service = declare_parameter<std::string>(
      "safety_supervisor.services.arm", kArmService);
    const auto latch_service = declare_parameter<std::string>(
      "safety_supervisor.services.latch", kLatchService);

    const auto heartbeat_qos =
      rclcpp::QoS(rclcpp::KeepLast(1)).reliable().durability_volatile();
    const auto request_qos =
      rclcpp::QoS(rclcpp::KeepLast(10)).reliable().durability_volatile();
    const auto status_qos =
      rclcpp::QoS(rclcpp::KeepLast(1)).reliable().transient_local();
    estop_output_ = create_publisher<std_msgs::msg::Bool>(output_topic, heartbeat_qos);
    status_ = create_publisher<std_msgs::msg::String>(status_topic, status_qos);
    estop_request_ = create_subscription<std_msgs::msg::Bool>(
      request_topic, request_qos,
      [this](const std_msgs::msg::Bool::SharedPtr message) {
        receive_estop_request(message->data);
      });
    arm_ = create_service<std_srvs::srv::Trigger>(
      arm_service,
      [this](const std_srvs::srv::Trigger::Request::SharedPtr,
      std_srvs::srv::Trigger::Response::SharedPtr response) {
        arm_supervisor(*response);
      });
    latch_ = create_service<std_srvs::srv::Trigger>(
      latch_service,
      [this](const std_srvs::srv::Trigger::Request::SharedPtr,
      std_srvs::srv::Trigger::Response::SharedPtr response) {
        latch_supervisor(*response);
      });

    // The safety contract is deliberately fixed. Remapping the sole output can
    // leave the Bridge watching an unrelated topic and is therefore rejected.
    if (estop_output_->get_topic_name() != std::string(kEstopOutputTopic) ||
      estop_request_->get_topic_name() != std::string(kEstopRequestTopic))
    {
      throw std::invalid_argument(
              "safety supervisor estop/request topics must use the canonical absolute names");
    }

    heartbeat_tick();
    heartbeat_timer_ = create_wall_timer(output_period_, [this]() {heartbeat_tick();});
    RCLCPP_WARN(
      get_logger(),
      "Safety supervisor started fail-closed: output=%s request=%s arm=%s latch=%s "
      "period=%ldms deadline=%ldms; explicit arm and Bridge reset are both required",
      kEstopOutputTopic, kEstopRequestTopic, arm_service.c_str(), latch_service.c_str(),
      static_cast<long>(output_period_.count()), static_cast<long>(heartbeat_deadline_.count()));
  }

  ~SafetySupervisorNode() override
  {
    if (!state_ || !estop_output_) {
      return;
    }
    state_->shutdown_latch();
    try {
      publish_output();
      publish_status(true);
    } catch (...) {
      // The downstream Bridge also latches when this heartbeat disappears.
    }
  }

private:
  void heartbeat_tick()
  {
    const auto now = safety_supervisor::SteadyClock::now();
    const bool missed = state_->heartbeat(now);
    if (missed) {
      RCLCPP_ERROR(
        get_logger(), "Safety heartbeat deadline missed (gap=%ldms limit=%ldms); latching E-stop",
        static_cast<long>(state_->last_heartbeat_gap().count()),
        static_cast<long>(heartbeat_deadline_.count()));
    }
    publish_output();
    publish_status(missed);
  }

  void receive_estop_request(bool active)
  {
    if (!state_->observe_estop_request(active)) {
      return;
    }
    RCLCPP_ERROR(get_logger(), "E-stop request asserted; supervisor latched immediately");
    publish_output();
    publish_status(true);
  }

  void arm_supervisor(std_srvs::srv::Trigger::Response & response)
  {
    const auto result = state_->arm(safety_supervisor::SteadyClock::now());
    response.success = result.success;
    response.message = result.message;
    publish_output();
    publish_status(true);
    if (result.success) {
      RCLCPP_WARN(
        get_logger(), "Supervisor armed and publishing false; Bridge E-stop remains latched "
        "until /omni/safety/reset_estop is explicitly called");
    } else {
      RCLCPP_ERROR(get_logger(), "Supervisor arm rejected: %s", result.message);
    }
  }

  void latch_supervisor(std_srvs::srv::Trigger::Response & response)
  {
    state_->manual_latch();
    publish_output();
    publish_status(true);
    response.success = true;
    response.message = "supervisor_latched_explicit_arm_required";
    RCLCPP_ERROR(get_logger(), "Supervisor manually latched");
  }

  void publish_output()
  {
    std_msgs::msg::Bool message;
    message.data = state_->estop_active();
    estop_output_->publish(message);
  }

  void publish_status(bool force)
  {
    const auto now = safety_supervisor::SteadyClock::now();
    if (!force && last_status_publish_.has_value() &&
      now - *last_status_publish_ < status_period_)
    {
      return;
    }
    std::ostringstream value;
    value << "state=" << (state_->estop_active() ? "latched" : "armed") <<
      ";output_estop=" << (state_->estop_active() ? "true" : "false") <<
      ";reason=" << safety_supervisor::reason_name(state_->reason()) <<
      ";heartbeat_fresh=" << (state_->heartbeat_fresh(now) ? "true" : "false") <<
      ";heartbeat_age_ms=" << state_->heartbeat_age_ms(now) <<
      ";last_gap_ms=" << state_->last_heartbeat_gap().count() <<
      ";heartbeat_seq=" << state_->heartbeat_sequence() <<
      ";request_true_count=" << state_->estop_request_count() <<
      ";arm_count=" << state_->arm_count() <<
      ";latch_count=" << state_->latch_count() <<
      ";request_publishers=" << estop_request_->get_publisher_count() <<
      // The supervisor cannot observe whether the independently latched Bridge
      // has already been reset. Report the boundary, rather than claiming a
      // reset is still required after some other orchestrator may have done it.
      ";bridge_reset_is_separate=true" <<
      ";reset_protocol=arm_supervisor_then_reset_bridge" <<
      ";next_action=" << (state_->estop_active() ? "arm_supervisor" : "bridge_reset_or_run");
    std_msgs::msg::String message;
    message.data = value.str();
    status_->publish(message);
    last_status_publish_ = now;
  }

  // Lock is declared first so every ROS endpoint is destroyed before another
  // supervisor process can acquire the publisher role.
  std::unique_ptr<SupervisorInstanceLock> instance_lock_;
  std::unique_ptr<safety_supervisor::StateMachine> state_;
  std::chrono::milliseconds output_period_{100};
  std::chrono::milliseconds heartbeat_deadline_{500};
  std::chrono::milliseconds status_period_{1000};
  std::optional<safety_supervisor::SteadyTime> last_status_publish_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr estop_output_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr status_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr estop_request_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr arm_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr latch_;
  rclcpp::TimerBase::SharedPtr heartbeat_timer_;
};

}  // namespace
}  // namespace rosdeck_robot_bridge

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<rosdeck_robot_bridge::SafetySupervisorNode>());
  rclcpp::shutdown();
  return 0;
}

#include "rosdeck_robot_bridge/robot_adapter.hpp"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

#include <fcntl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/string.hpp>

namespace rosdeck_robot_bridge
{
namespace
{

using namespace std::chrono_literals;

std::string safe_reason(std::string value)
{
  for (char & character : value) {
    if (character == ':' || character == '\n' || character == '\r') {
      character = '_';
    }
  }
  return value.empty() ? "unknown_error" : value;
}

class UnavailableAdapter final : public RobotAdapter
{
public:
  explicit UnavailableAdapter(std::string adapter_name)
  : adapter_name_(std::move(adapter_name)) {}

  std::string name() const override {return adapter_name_;}

  void request_locomotion(CommandResult callback) override
  {
    callback(false, "adapter_not_available");
  }

  void request_posture(const std::string &, CommandResult callback) override
  {
    callback(false, "adapter_not_available");
  }

private:
  std::string adapter_name_;
};

class BridgeNode final : public rclcpp::Node
{
public:
  BridgeNode()
  : Node("rosdeck_robot_bridge")
  {
    const auto adapter_name = declare_parameter<std::string>("adapter", "vbot");
    mapping_enabled_ = declare_parameter<bool>("mapping.enabled", true);
    posture_enabled_ = declare_parameter<bool>("posture.enabled", true);
    locomotion_enabled_ = declare_parameter<bool>("locomotion.enabled", true);
    mapping_script_ = declare_parameter<std::string>(
      "mapping.script", "/userdata/2_slam/1_mapping.sh");
    mapping_log_ = declare_parameter<std::string>(
      "mapping.log", "/tmp/rosdeck_3d_mapping.log");
    const auto mapping_stop_timeout = declare_parameter<int64_t>(
      "mapping.stop_timeout_sec", 30);
    const auto mapping_kill_timeout = declare_parameter<int64_t>(
      "mapping.kill_timeout_sec", 5);
    mapping_stop_timeout_ =
      std::chrono::seconds(std::max<int64_t>(0, mapping_stop_timeout));
    mapping_kill_timeout_ =
      std::chrono::seconds(std::max<int64_t>(0, mapping_kill_timeout));
    const auto locomotion_service = declare_parameter<std::string>(
      "vbot.locomotion_service", "/locomotion/set_run_mode");
    const auto posture_service = declare_parameter<std::string>(
      "vbot.posture_service", "");

    const auto mapping_command_topic = declare_parameter<std::string>(
      "topics.mapping_command", "/rosdeck/start_3d_mapping");
    const auto mapping_status_topic = declare_parameter<std::string>(
      "topics.mapping_status", "/rosdeck/mapping_status");
    const auto posture_command_topic = declare_parameter<std::string>(
      "topics.posture_command", "/rosdeck/posture_command");
    const auto posture_status_topic = declare_parameter<std::string>(
      "topics.posture_status", "/rosdeck/posture_status");
    const auto locomotion_command_topic = declare_parameter<std::string>(
      "topics.locomotion_command", "/rosdeck/locomotion_command");
    const auto locomotion_status_topic = declare_parameter<std::string>(
      "topics.locomotion_status", "/rosdeck/locomotion_status");

#ifdef ROSDECK_HAS_VBOT_ADAPTER
    if (adapter_name == "vbot") {
      adapter_ = make_vbot_adapter(*this, locomotion_service, posture_service);
    }
#endif
    if (adapter_name == "zsibot") {
      adapter_ = make_zsibot_adapter(*this);
    }
    if (!adapter_) {
      adapter_ = std::make_unique<UnavailableAdapter>(adapter_name);
      RCLCPP_WARN(
        get_logger(), "Adapter '%s' is not available in this build", adapter_name.c_str());
    }

    if (mapping_enabled_) {
      mapping_status_ = create_publisher<std_msgs::msg::String>(mapping_status_topic, 10);
      mapping_command_ = create_subscription<std_msgs::msg::Bool>(
        mapping_command_topic, 10,
        [this](const std_msgs::msg::Bool::SharedPtr message) {
          message->data ? start_mapping() : stop_mapping();
        });
    }
    if (posture_enabled_) {
      posture_status_ = create_publisher<std_msgs::msg::String>(posture_status_topic, 10);
      posture_command_ = create_subscription<std_msgs::msg::String>(
        posture_command_topic, 10,
        [this](const std_msgs::msg::String::SharedPtr message) {
          request_posture(message->data);
        });
    }
    if (locomotion_enabled_) {
      locomotion_status_ = create_publisher<std_msgs::msg::String>(locomotion_status_topic, 10);
      locomotion_command_ = create_subscription<std_msgs::msg::String>(
        locomotion_command_topic, 10,
        [this](const std_msgs::msg::String::SharedPtr message) {
          request_locomotion(message->data);
        });
    }

    RCLCPP_INFO(
      get_logger(),
      "Ready: adapter=%s mapping=%s posture=%s locomotion=%s",
      adapter_->name().c_str(), mapping_enabled_ ? "on" : "off",
      posture_enabled_ ? "on" : "off", locomotion_enabled_ ? "on" : "off");
  }

  ~BridgeNode() override
  {
    shutdown_mapping();
  }

private:
  void publish(
    const rclcpp::Publisher<std_msgs::msg::String>::SharedPtr & publisher,
    const std::string & value)
  {
    std_msgs::msg::String message;
    message.data = value;
    publisher->publish(message);
  }

  void request_locomotion(std::string command)
  {
    if (command != "loco") {
      publish(locomotion_status_, "error:" + safe_reason(command) + ":unsupported_command");
      return;
    }
    if (locomotion_busy_.exchange(true)) {
      publish(locomotion_status_, "error:loco:request_in_progress");
      return;
    }
    adapter_->request_locomotion(
      [this](bool success, const std::string & reason) {
        locomotion_busy_ = false;
        publish(
          locomotion_status_,
          success ? "success:loco" : "error:loco:" + safe_reason(reason));
      });
  }

  void request_posture(std::string command)
  {
    if (command != "stand" && command != "lie_down") {
      publish(posture_status_, "error:" + safe_reason(command) + ":unsupported_command");
      return;
    }
    if (posture_busy_.exchange(true)) {
      publish(posture_status_, "error:" + command + ":action_in_progress");
      return;
    }
    adapter_->request_posture(
      command,
      [this, command](bool success, const std::string & reason) {
        posture_busy_ = false;
        publish(
          posture_status_,
          success ? "success:" + command :
          "error:" + command + ':' + safe_reason(reason));
      });
  }

  void start_mapping()
  {
    {
      std::lock_guard<std::mutex> lock(mapping_mutex_);
      if (mapping_pid_ > 0) {
        publish(mapping_status_, "already_running");
        return;
      }
    }
    if (mapping_waiter_.joinable()) {
      mapping_waiter_.join();
    }

    std::lock_guard<std::mutex> lock(mapping_mutex_);
    if (!std::filesystem::is_regular_file(mapping_script_)) {
      publish(mapping_status_, "error:script_not_found:" + mapping_script_);
      return;
    }

    const int log_fd = ::open(mapping_log_.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (log_fd < 0) {
      publish(mapping_status_, "error:log_open_failed:" + safe_reason(std::strerror(errno)));
      return;
    }

    const auto working_directory = std::filesystem::path(mapping_script_).parent_path().string();
    const pid_t child = ::fork();
    if (child == 0) {
      if (::setsid() < 0) {
        ::_exit(126);
      }
      ::dup2(log_fd, STDOUT_FILENO);
      ::dup2(log_fd, STDERR_FILENO);
      ::close(log_fd);
      if (!working_directory.empty() && ::chdir(working_directory.c_str()) != 0) {
        ::_exit(125);
      }
      ::execl("/bin/bash", "bash", mapping_script_.c_str(), static_cast<char *>(nullptr));
      ::_exit(127);
    }
    ::close(log_fd);
    if (child < 0) {
      publish(mapping_status_, "error:launch_failed:" + safe_reason(std::strerror(errno)));
      return;
    }

    mapping_pid_ = child;
    mapping_stop_requested_ = false;
    mapping_stop_requested_at_ = {};
    publish(mapping_status_, "started:" + std::to_string(child));
    RCLCPP_INFO(get_logger(), "Started mapping process group %d", child);
    mapping_waiter_ = std::thread([this, child]() {wait_for_mapping(child);});
  }

  void stop_mapping()
  {
    std::lock_guard<std::mutex> lock(mapping_mutex_);
    if (mapping_pid_ <= 0) {
      publish(mapping_status_, "not_running");
      return;
    }
    if (mapping_stop_requested_) {
      publish(mapping_status_, "stopping:" + std::to_string(mapping_pid_));
      return;
    }
    mapping_stop_requested_ = true;
    mapping_stop_requested_at_ = std::chrono::steady_clock::now();
    if (::kill(-mapping_pid_, SIGINT) != 0) {
      mapping_stop_requested_ = false;
      publish(mapping_status_, "error:stop_failed:" + safe_reason(std::strerror(errno)));
      return;
    }
    publish(mapping_status_, "stopping:" + std::to_string(mapping_pid_));
    RCLCPP_INFO(get_logger(), "Sent SIGINT to mapping process group %d", mapping_pid_);
  }

  void wait_for_mapping(pid_t child)
  {
    int status = 0;
    bool child_reaped = false;
    bool term_sent = false;
    bool kill_sent = false;
    int code = -1;

    while (true) {
      if (!child_reaped) {
        const pid_t result = ::waitpid(child, &status, WNOHANG);
        if (result == child) {
          child_reaped = true;
          code = WIFEXITED(status) ? WEXITSTATUS(status) :
            WIFSIGNALED(status) ? 128 + WTERMSIG(status) : status;
        } else if (result < 0 && errno != EINTR) {
          child_reaped = true;
          code = -1;
          RCLCPP_WARN(
            get_logger(), "waitpid failed for mapping process %d: %s",
            child, std::strerror(errno));
        }
      }

      bool stop_requested = false;
      std::chrono::steady_clock::time_point stop_requested_at;
      {
        std::lock_guard<std::mutex> lock(mapping_mutex_);
        stop_requested = mapping_stop_requested_;
        stop_requested_at = mapping_stop_requested_at_;
      }

      const bool group_alive = mapping_process_group_exists(child);
      if (stop_requested && group_alive) {
        const auto elapsed = std::chrono::steady_clock::now() - stop_requested_at;
        if (!term_sent && elapsed >= mapping_stop_timeout_) {
          RCLCPP_WARN(
            get_logger(),
            "Mapping process group %d did not exit after SIGINT; sending SIGTERM", child);
          ::kill(-child, SIGTERM);
          term_sent = true;
          publish(mapping_status_, "terminating:" + std::to_string(child));
        }
        if (!kill_sent && elapsed >= mapping_stop_timeout_ + mapping_kill_timeout_) {
          RCLCPP_ERROR(
            get_logger(),
            "Mapping process group %d did not exit after SIGTERM; sending SIGKILL", child);
          ::kill(-child, SIGKILL);
          kill_sent = true;
          publish(mapping_status_, "killing:" + std::to_string(child));
        }
      }

      if (child_reaped && !group_alive) {
        break;
      }
      std::this_thread::sleep_for(100ms);
    }

    bool stop_requested = false;
    {
      std::lock_guard<std::mutex> lock(mapping_mutex_);
      stop_requested = mapping_stop_requested_;
      if (mapping_pid_ == child) {
        mapping_pid_ = -1;
        mapping_stop_requested_ = false;
        mapping_stop_requested_at_ = {};
      }
    }
    RCLCPP_INFO(
      get_logger(), "Mapping process group %d fully exited with code %d", child, code);
    if (rclcpp::ok()) {
      publish(
        mapping_status_,
        std::string(stop_requested ? "stopped:" : "exited:") + std::to_string(code));
    }
  }

  void shutdown_mapping()
  {
    pid_t child = -1;
    {
      std::lock_guard<std::mutex> lock(mapping_mutex_);
      child = mapping_pid_;
      if (child > 0) {
        mapping_stop_requested_ = true;
        mapping_stop_requested_at_ = std::chrono::steady_clock::now();
        ::kill(-child, SIGINT);
      }
    }
    if (mapping_waiter_.joinable()) {
      mapping_waiter_.join();
    }
  }

  static bool mapping_process_group_exists(pid_t group)
  {
    if (::kill(-group, 0) == 0) {
      return true;
    }
    return errno == EPERM;
  }

  bool mapping_enabled_{false};
  bool posture_enabled_{false};
  bool locomotion_enabled_{false};
  std::string mapping_script_;
  std::string mapping_log_;
  std::chrono::seconds mapping_stop_timeout_{30};
  std::chrono::seconds mapping_kill_timeout_{5};
  std::unique_ptr<RobotAdapter> adapter_;
  std::atomic_bool posture_busy_{false};
  std::atomic_bool locomotion_busy_{false};
  std::mutex mapping_mutex_;
  pid_t mapping_pid_{-1};
  bool mapping_stop_requested_{false};
  std::chrono::steady_clock::time_point mapping_stop_requested_at_{};
  std::thread mapping_waiter_;

  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr mapping_status_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr posture_status_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr locomotion_status_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr mapping_command_;
  rclcpp::Subscription<std_msgs::msg::String>::SharedPtr posture_command_;
  rclcpp::Subscription<std_msgs::msg::String>::SharedPtr locomotion_command_;
};

}  // namespace

std::shared_ptr<rclcpp::Node> make_bridge_node()
{
  return std::make_shared<BridgeNode>();
}

}  // namespace rosdeck_robot_bridge

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(rosdeck_robot_bridge::make_bridge_node());
  rclcpp::shutdown();
  return 0;
}

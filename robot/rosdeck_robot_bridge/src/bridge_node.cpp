#include "rosdeck_robot_bridge/battery_source.hpp"
#include "rosdeck_robot_bridge/robot_adapter.hpp"
#include "rosdeck_robot_bridge/cmd_vel_arbiter.hpp"
#include "rosdeck_robot_bridge/direct_estop_guard.hpp"
#include "rosdeck_robot_bridge/robot_state_aggregator.hpp"
#include "rosdeck_robot_bridge/sdk_owner_lock.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <memory>
#include <mutex>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#include <fcntl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <geometry_msgs/msg/twist.hpp>
#include <geometry_msgs/msg/twist_stamped.hpp>
#include <omni_robot_interfaces/msg/mission_status.hpp>
#include <omni_robot_interfaces/msg/robot_state.hpp>
#include <omni_slam_interfaces/msg/slam_status.hpp>
#include <diagnostic_msgs/msg/diagnostic_array.hpp>
#include <diagnostic_msgs/msg/diagnostic_status.hpp>
#include <diagnostic_msgs/msg/key_value.hpp>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/battery_state.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/string.hpp>
#include <std_srvs/srv/trigger.hpp>

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

std::string safe_status_field(std::string value)
{
  for (char & character : value) {
    if (character == ';' || character == '=' || character == '\n' || character == '\r') {
      character = '_';
    }
  }
  return value.empty() ? "none" : value;
}

bool valid_client_id(const std::string & value)
{
  if (value.empty() || value.size() > 64) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](const char character) {
    return (character >= 'a' && character <= 'z') ||
           (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') || character == '-' || character == '_';
  });
}

class UnavailableAdapter final : public RobotAdapter
{
public:
  explicit UnavailableAdapter(std::string adapter_name)
  : adapter_name_(std::move(adapter_name)) {}

  std::string name() const override {return adapter_name_;}

  AdapterSnapshot snapshot() const override
  {
    AdapterSnapshot value;
    value.adapter_name = adapter_name_;
    value.authority_known = true;
    value.authority_state = "unavailable";
    value.last_error_active = true;
    value.last_error_domain = "adapter";
    value.last_error = "adapter_not_available";
    return value;
  }

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

// Freshness-tracked relay of an upstream status topic. Only the single
// executor thread of this node touches these states, so no synchronization
// is needed; staleness is judged against the steady clock at tick time.
struct SlamRelayState
{
  bool known{false};
  AdapterSteadyTime received_at{};
  uint8_t mode{omni_slam_interfaces::msg::SlamStatus::MODE_STOPPED};
  uint8_t state{omni_slam_interfaces::msg::SlamStatus::STATE_STOPPED};
  std::string map_id;
  std::string map_version;
  float fitness{std::numeric_limits<float>::quiet_NaN()};
};

struct MissionRelayState
{
  bool known{false};
  AdapterSteadyTime received_at{};
  uint8_t state{omni_robot_interfaces::msg::MissionStatus::MISSION_NONE};
  std::string mission_id;
  float progress{std::numeric_limits<float>::quiet_NaN()};
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
    control_enabled_ = declare_parameter<bool>("control.enabled", adapter_name == "zsibot");
    const auto default_mapping_script = adapter_name == "vbot" ?
      "/userdata/2_slam/1_mapping.sh" : "";
    mapping_script_ = declare_parameter<std::string>(
      "mapping.script", default_mapping_script);
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
    const auto control_command_topic = declare_parameter<std::string>(
      "topics.control_command", "/rosdeck/control_command");
    const auto control_status_topic = declare_parameter<std::string>(
      "topics.control_status", "/rosdeck/control_status");
    const auto battery_state_topic = declare_parameter<std::string>(
      "adapter_status.topics.battery", "/battery_state");
    const auto diagnostics_topic = declare_parameter<std::string>(
      "adapter_status.topics.diagnostics", "/diagnostics");
    const auto adapter_connection_topic = declare_parameter<std::string>(
      "adapter_status.topics.connection", "/omni/robot/connection");
    const auto adapter_mode_topic = declare_parameter<std::string>(
      "adapter_status.topics.mode", "/omni/robot/mode");
    const auto adapter_sdk_error_topic = declare_parameter<std::string>(
      "adapter_status.topics.sdk_error", "/omni/robot/sdk_error");
    const auto adapter_summary_topic = declare_parameter<std::string>(
      "adapter_status.topics.summary", "/omni/robot/adapter_status");

    cmd_vel_arbiter_enabled_ = declare_parameter<bool>(
      "cmd_vel_arbiter.enabled", adapter_name == "zsibot");
    if (adapter_name == "zsibot" && !cmd_vel_arbiter_enabled_) {
      throw std::invalid_argument(
              "cmd_vel_arbiter.enabled=false is forbidden for the ZsiBot product adapter");
    }
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
    adapter_status_period_ = bounded_milliseconds(
      "adapter_status.publish_period_ms", 1000, 100, 5000);
    adapter_telemetry_timeout_ = bounded_milliseconds(
      "adapter_status.telemetry_stale_ms", 1500, 500, 10000);
    adapter_battery_timeout_ = bounded_milliseconds(
      "adapter_status.battery_stale_ms", 15000, 1000, 120000);
    power_supply_root_ = declare_parameter<std::string>(
      "adapter_status.battery.power_supply_root", "/sys/class/power_supply");
    power_supply_device_ = declare_parameter<std::string>(
      "adapter_status.battery.power_supply_device", "");
    battery_current_sign_ = declare_parameter<double>(
      "adapter_status.battery.current_sign", 1.0);
    charge_current_threshold_a_ = declare_parameter<double>(
      "adapter_status.battery.charge_current_threshold_a", 0.05);
    const auto soc_trend_window_sec = declare_parameter<int64_t>(
      "adapter_status.battery.soc_trend_window_sec", 30);
    const auto soc_trend_min_delta_percent = declare_parameter<double>(
      "adapter_status.battery.soc_trend_min_delta_percent", 1.0);
    soc_trend_charger_ = SocTrendCharger(
      std::chrono::seconds(std::max<int64_t>(1, soc_trend_window_sec)),
      soc_trend_min_delta_percent);
    cmd_vel_arbiter::Config arbiter_config;
    arbiter_config.teleop_timeout = bounded_milliseconds(
      "cmd_vel_arbiter.teleop_timeout_ms", 250, 100, 300);
    arbiter_config.docking_timeout = bounded_milliseconds(
      "cmd_vel_arbiter.docking_timeout_ms", 250, 100, 300);
    arbiter_config.navigation_timeout = bounded_milliseconds(
      "cmd_vel_arbiter.navigation_timeout_ms", 250, 100, 300);
    arbiter_config.stamped_max_age = bounded_milliseconds(
      "cmd_vel_arbiter.stamped_max_age_ms", 1000, 100, 5000);
    arbiter_config.stamped_future_tolerance = bounded_milliseconds(
      "cmd_vel_arbiter.stamped_future_tolerance_ms", 500, 0, 2000);
    arbiter_config.enforce_stamp_freshness = declare_parameter<bool>(
      "cmd_vel_arbiter.enforce_stamp_freshness", false);
    const auto arbiter_period = bounded_milliseconds(
      "cmd_vel_arbiter.output_period_ms", 25, 10, 100);
    arbiter_status_period_ = bounded_milliseconds(
      "cmd_vel_arbiter.status_period_ms", 1000, 100, 1000);
    const auto teleop_topic = declare_parameter<std::string>(
      "cmd_vel_arbiter.topics.teleop", "/omni/cmd_vel/teleop");
    const auto navigation_topic = declare_parameter<std::string>(
      "cmd_vel_arbiter.topics.navigation", "/scan_planner/cmd_vel");
    const auto docking_topic = declare_parameter<std::string>(
      "cmd_vel_arbiter.topics.docking", "/omni/cmd_vel/docking");
    const auto estop_topic = declare_parameter<std::string>(
      "cmd_vel_arbiter.topics.estop", "/omni/safety/estop");
    const auto arbiter_status_topic = declare_parameter<std::string>(
      "cmd_vel_arbiter.topics.status", "/omni/cmd_vel/arbiter_status");
    const auto estop_reset_service = declare_parameter<std::string>(
      "cmd_vel_arbiter.services.estop_reset", "/omni/safety/reset_estop");
    require_estop_monitor_ = declare_parameter<bool>(
      "cmd_vel_arbiter.require_estop_monitor", adapter_name == "zsibot");
    if (adapter_name == "zsibot" && !require_estop_monitor_) {
      throw std::invalid_argument(
              "cmd_vel_arbiter.require_estop_monitor=false is forbidden for the ZsiBot "
              "product adapter");
    }
    const auto requested_estop_monitor_timeout = declare_parameter<int64_t>(
      "cmd_vel_arbiter.estop_monitor_timeout_ms", 500);
    if (adapter_name == "zsibot" &&
      (requested_estop_monitor_timeout < 100 || requested_estop_monitor_timeout > 500))
    {
      throw std::invalid_argument(
              "ZsiBot cmd_vel_arbiter.estop_monitor_timeout_ms must be in [100, 500]");
    }
    estop_monitor_timeout_ = std::chrono::milliseconds(std::clamp<int64_t>(
        requested_estop_monitor_timeout, 100, adapter_name == "zsibot" ? 500 : 5000));

    robot_state_enabled_ = declare_parameter<bool>("robot_state.enabled", true);
    const auto robot_state_topic = declare_parameter<std::string>(
      "robot_state.topics.robot_state", "/omni/robot_state");
    const auto slam_status_topic = declare_parameter<std::string>(
      "robot_state.topics.slam_status", "/omni/slam/status");
    const auto mission_status_topic = declare_parameter<std::string>(
      "robot_state.topics.mission_status", "/omni/mission/status");
    robot_state_period_ = bounded_milliseconds(
      "robot_state.publish_period_ms", 1000, 200, 5000);
    robot_state_tick_ = bounded_milliseconds("robot_state.tick_period_ms", 250, 50, 1000);
    robot_state_slam_stale_ = bounded_milliseconds(
      "robot_state.slam_status_stale_ms", 2000, 500, 30000);
    robot_state_mission_stale_ = bounded_milliseconds(
      "robot_state.mission_status_stale_ms", 5000, 1000, 60000);

    const AdapterBuildSupport build_support{
#ifdef ROSDECK_HAS_VBOT_ADAPTER
      true,
#else
      false,
#endif
#ifdef ROSDECK_HAS_ZSIBOT_SDK
      true,
#else
      false,
#endif
    };
    if (const auto selection_error = adapter_selection_error(adapter_name, build_support)) {
      throw std::invalid_argument(*selection_error);
    }

#ifdef ROSDECK_HAS_VBOT_ADAPTER
    if (adapter_name == "vbot") {
      adapter_ = make_vbot_adapter(*this, locomotion_service, posture_service);
    }
#endif
#ifdef ROSDECK_HAS_ZSIBOT_SDK
    if (adapter_name == "zsibot") {
      sdk_owner_lock_ = std::make_unique<SdkOwnerLock>("rosdeck_robot_bridge");
      adapter_ = make_zsibot_adapter(*this);
    }
#endif
    if (adapter_name == "unavailable") {
      adapter_ = std::make_unique<UnavailableAdapter>(adapter_name);
    }
    if (!adapter_) {
      throw std::logic_error("validated adapter selection did not construct an adapter");
    }

    const auto adapter_state_qos =
      rclcpp::QoS(rclcpp::KeepLast(1)).reliable().transient_local();
    const auto adapter_stream_qos =
      rclcpp::QoS(rclcpp::KeepLast(10)).reliable().durability_volatile();
    battery_state_ = create_publisher<sensor_msgs::msg::BatteryState>(
      battery_state_topic, adapter_stream_qos);
    adapter_diagnostics_ = create_publisher<diagnostic_msgs::msg::DiagnosticArray>(
      diagnostics_topic, adapter_stream_qos);
    adapter_connection_ = create_publisher<std_msgs::msg::String>(
      adapter_connection_topic, adapter_state_qos);
    adapter_mode_ = create_publisher<std_msgs::msg::String>(
      adapter_mode_topic, adapter_state_qos);
    adapter_sdk_error_ = create_publisher<std_msgs::msg::String>(
      adapter_sdk_error_topic, adapter_state_qos);
    adapter_summary_ = create_publisher<std_msgs::msg::String>(
      adapter_summary_topic, adapter_state_qos);
    const std::array<std::string, 6> resolved_adapter_topics{
      battery_state_->get_topic_name(),
      adapter_diagnostics_->get_topic_name(),
      adapter_connection_->get_topic_name(),
      adapter_mode_->get_topic_name(),
      adapter_sdk_error_->get_topic_name(),
      adapter_summary_->get_topic_name(),
    };
    for (std::size_t index = 0; index < resolved_adapter_topics.size(); ++index) {
      if (resolved_adapter_topics[index] == "/omni/safety/estop" ||
        resolved_adapter_topics[index] == "/omni/safety/estop_request")
      {
        throw std::invalid_argument(
                "adapter observability topics must not use Safety Supervisor channels");
      }
      for (std::size_t other = index + 1; other < resolved_adapter_topics.size(); ++other) {
        if (resolved_adapter_topics[index] == resolved_adapter_topics[other]) {
          throw std::invalid_argument("resolved adapter observability topics must be unique");
        }
      }
    }

    if (cmd_vel_arbiter_enabled_) {
      constexpr const char * output_topic = cmd_vel_arbiter::kFinalTopic;
      const std::array<std::string, 3> velocity_inputs{
        teleop_topic, docking_topic, navigation_topic};
      for (std::size_t index = 0; index < velocity_inputs.size(); ++index) {
        if (velocity_inputs[index].empty() || velocity_inputs[index] == output_topic) {
          throw std::invalid_argument(
                  "cmd_vel arbiter inputs must be non-empty and must not use the final output");
        }
        for (std::size_t other = index + 1; other < velocity_inputs.size(); ++other) {
          if (velocity_inputs[index] == velocity_inputs[other]) {
            throw std::invalid_argument("cmd_vel arbiter input topics must be unique");
          }
        }
      }
      std::string adapter_velocity_topic;
      if (adapter_name == "zsibot" && has_parameter("zsibot.velocity_topic") &&
        get_parameter("zsibot.velocity_topic", adapter_velocity_topic) &&
        adapter_velocity_topic != output_topic)
      {
        throw std::invalid_argument(
                "zsibot.velocity_topic must be /omni/cmd_vel/final when arbiter is enabled");
      }

      cmd_vel_arbiter_ = std::make_unique<cmd_vel_arbiter::Arbiter>(arbiter_config);
      const auto velocity_qos =
        rclcpp::QoS(rclcpp::KeepLast(1)).best_effort().durability_volatile();
      const auto estop_qos =
        rclcpp::QoS(rclcpp::KeepLast(1)).reliable().durability_volatile();
      const auto status_qos =
        rclcpp::QoS(rclcpp::KeepLast(1)).reliable().transient_local();
      cmd_vel_output_ = create_publisher<geometry_msgs::msg::Twist>(output_topic, velocity_qos);
      cmd_vel_arbiter_status_ =
        create_publisher<std_msgs::msg::String>(arbiter_status_topic, status_qos);
      cmd_vel_teleop_ = create_subscription<geometry_msgs::msg::TwistStamped>(
        teleop_topic, velocity_qos,
        [this](const geometry_msgs::msg::TwistStamped::SharedPtr message) {
          receive_stamped_velocity(cmd_vel_arbiter::Source::teleop, *message);
        });
      // OpenNav Docking publishes Twist. Safety freshness for this source is
      // enforced with steady receipt time, identical to navigation.
      cmd_vel_docking_ = create_subscription<geometry_msgs::msg::Twist>(
        docking_topic, velocity_qos,
        [this](const geometry_msgs::msg::Twist::SharedPtr message) {
          receive_docking_velocity(*message);
        });
      cmd_vel_navigation_ = create_subscription<geometry_msgs::msg::Twist>(
        navigation_topic, velocity_qos,
        [this](const geometry_msgs::msg::Twist::SharedPtr message) {
          receive_navigation_velocity(*message);
        });
      software_estop_ = create_subscription<std_msgs::msg::Bool>(
        estop_topic, estop_qos,
        [this](const std_msgs::msg::Bool::SharedPtr message) {
          receive_software_estop(message->data);
        });
      estop_reset_ = create_service<std_srvs::srv::Trigger>(
        estop_reset_service,
        [this](const std_srvs::srv::Trigger::Request::SharedPtr,
        std_srvs::srv::Trigger::Response::SharedPtr response) {
          reset_software_estop(*response);
        });

      // Parameter text is insufficient here: namespaces and ROS remap rules
      // can resolve two different strings to the same graph name. Validate the
      // endpoints after rclcpp has applied all resolution/remapping.
      const std::string resolved_output = cmd_vel_output_->get_topic_name();
      const std::array<std::string, 4> resolved_inputs{
        cmd_vel_teleop_->get_topic_name(),
        cmd_vel_docking_->get_topic_name(),
        cmd_vel_navigation_->get_topic_name(),
        software_estop_->get_topic_name(),
      };
      for (std::size_t index = 0; index < resolved_inputs.size(); ++index) {
        if (resolved_inputs[index] == resolved_output) {
          throw std::invalid_argument(
                  "resolved cmd_vel/estop input must not equal the final output topic");
        }
        for (std::size_t other = index + 1; other < resolved_inputs.size(); ++other) {
          if (resolved_inputs[index] == resolved_inputs[other]) {
            throw std::invalid_argument("resolved cmd_vel/estop input topics must be unique");
          }
        }
      }
      if (cmd_vel_arbiter_status_->get_topic_name() == resolved_output) {
        throw std::invalid_argument("arbiter status must not resolve to the final output topic");
      }
      if (adapter_name == "zsibot" &&
        software_estop_->get_topic_name() != std::string("/omni/safety/estop"))
      {
        throw std::invalid_argument(
                "ZsiBot E-stop monitor must resolve to canonical /omni/safety/estop");
      }
      if (adapter_name == "zsibot" &&
        std::string(estop_reset_->get_service_name()) != "/omni/safety/reset_estop")
      {
        throw std::invalid_argument(
                "ZsiBot E-stop reset must resolve to canonical /omni/safety/reset_estop");
      }
      cmd_vel_arbiter_timer_ = create_wall_timer(
        arbiter_period, [this]() {publish_arbiter_output();});
      publish_arbiter_output();
      RCLCPP_INFO(
        get_logger(),
        "cmd_vel arbiter enabled: teleop=%s docking=%s navigation=%s estop=%s "
        "output=%s status=%s period=%ldms status_period=%ldms source_timeout=(%ld,%ld,%ld)ms "
        "stamp_max_age=%ldms stamp_future_tolerance=%ldms stamp_enforce=%s (NTP required)",
        teleop_topic.c_str(), docking_topic.c_str(), navigation_topic.c_str(),
        estop_topic.c_str(), output_topic, arbiter_status_topic.c_str(),
        static_cast<long>(arbiter_period.count()),
        static_cast<long>(arbiter_status_period_.count()),
        static_cast<long>(arbiter_config.teleop_timeout.count()),
        static_cast<long>(arbiter_config.docking_timeout.count()),
        static_cast<long>(arbiter_config.navigation_timeout.count()),
        static_cast<long>(arbiter_config.stamped_max_age.count()),
        static_cast<long>(arbiter_config.stamped_future_tolerance.count()),
        arbiter_config.enforce_stamp_freshness ? "true" : "false");
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
    if (control_enabled_) {
      control_status_ = create_publisher<std_msgs::msg::String>(control_status_topic, 10);
      control_command_ = create_subscription<std_msgs::msg::String>(
        control_command_topic, 10,
        [this](const std_msgs::msg::String::SharedPtr message) {
          request_control(message->data);
        });
      // Periodically repeat the authority state. A phone may advertise and
      // publish its first status request before foxglove_bridge has finished
      // creating the corresponding ROS publisher, so relying on a single
      // startup/status-change message leaves late subscribers undetected.
      control_status_timer_ = create_wall_timer(
        500ms, [this]() {publish_control_status_if_changed(true);});
      publish_control_status_if_changed(true);
    }

    RCLCPP_INFO(
      get_logger(),
      "battery source: power_supply_root=%s device=%s current_sign=%g "
      "trend_window=%lds trend_min_delta=%g%% charge_current_threshold=%gA",
      power_supply_root_.c_str(),
      power_supply_device_.empty() ? "auto" : power_supply_device_.c_str(),
      battery_current_sign_,
      static_cast<long>(soc_trend_window_sec), soc_trend_min_delta_percent,
      charge_current_threshold_a_);

    adapter_status_timer_ = create_wall_timer(
      adapter_status_period_, [this]() {publish_adapter_observability();});
    publish_adapter_observability();

    if (robot_state_enabled_) {
      // Reliable + transient_local keep-last 1, matching both the SLAM
      // manager's SlamStatus profile and the RobotState topic contract.
      const auto robot_state_qos =
        rclcpp::QoS(rclcpp::KeepLast(1)).reliable().transient_local();
      robot_state_ = create_publisher<omni_robot_interfaces::msg::RobotState>(
        robot_state_topic, robot_state_qos);
      slam_status_ = create_subscription<omni_slam_interfaces::msg::SlamStatus>(
        slam_status_topic, robot_state_qos,
        [this](const omni_slam_interfaces::msg::SlamStatus::SharedPtr message) {
          slam_relay_.known = true;
          slam_relay_.received_at = AdapterSteadyClock::now();
          slam_relay_.mode = message->mode;
          slam_relay_.state = message->state;
          slam_relay_.map_id = message->map_id;
          // SlamStatus carries map_version as uint32; RobotState as string.
          // An empty map_id means "no map" regardless of the version counter.
          slam_relay_.map_version =
            message->map_id.empty() ? "" : std::to_string(message->map_version);
          slam_relay_.fitness = message->fitness_score;
        });
      mission_status_ = create_subscription<omni_robot_interfaces::msg::MissionStatus>(
        mission_status_topic, robot_state_qos,
        [this](const omni_robot_interfaces::msg::MissionStatus::SharedPtr message) {
          mission_relay_.known = true;
          mission_relay_.received_at = AdapterSteadyClock::now();
          mission_relay_.state = message->state;
          mission_relay_.mission_id = message->mission_id;
          mission_relay_.progress = message->progress;
        });

      const std::array<std::string, 3> resolved_robot_state_topics{
        robot_state_->get_topic_name(),
        slam_status_->get_topic_name(),
        mission_status_->get_topic_name(),
      };
      for (std::size_t index = 0; index < resolved_robot_state_topics.size(); ++index) {
        if (resolved_robot_state_topics[index].empty()) {
          throw std::invalid_argument("robot_state topics must be non-empty");
        }
        for (std::size_t other = index + 1; other < resolved_robot_state_topics.size();
          ++other)
        {
          if (resolved_robot_state_topics[index] == resolved_robot_state_topics[other]) {
            throw std::invalid_argument("resolved robot_state topics must be unique");
          }
        }
        if (index == 0) {
          for (const auto & adapter_topic : resolved_adapter_topics) {
            if (resolved_robot_state_topics[0] == adapter_topic) {
              throw std::invalid_argument(
                      "resolved robot_state output must not alias an adapter topic");
            }
          }
        }
      }

      robot_state_timer_ = create_wall_timer(
        robot_state_tick_, [this]() {publish_robot_state();});
      publish_robot_state();
      RCLCPP_INFO(
        get_logger(),
        "robot_state aggregator enabled: output=%s slam=%s mission=%s period=%ldms "
        "tick=%ldms stale=(%ld,%ld)ms",
        robot_state_topic.c_str(), slam_status_topic.c_str(),
        mission_status_topic.c_str(),
        static_cast<long>(robot_state_period_.count()),
        static_cast<long>(robot_state_tick_.count()),
        static_cast<long>(robot_state_slam_stale_.count()),
        static_cast<long>(robot_state_mission_stale_.count()));
    }

    RCLCPP_INFO(
      get_logger(),
      "Ready: adapter=%s mapping=%s posture=%s locomotion=%s control_lease=%s arbiter=%s",
      adapter_->name().c_str(), mapping_enabled_ ? "on" : "off",
      posture_enabled_ ? "on" : "off", locomotion_enabled_ ? "on" : "off",
      control_enabled_ && adapter_->requires_control_lease() ? "on" : "off",
      cmd_vel_arbiter_enabled_ ? "on" : "off");
  }

  ~BridgeNode() override
  {
    shutdown_mapping();
  }

private:
  static diagnostic_msgs::msg::KeyValue diagnostic_value(
    const std::string & key, const std::string & value)
  {
    diagnostic_msgs::msg::KeyValue item;
    item.key = key;
    item.value = value;
    return item;
  }

  void publish_adapter_observability()
  {
    const AdapterSnapshot snapshot = adapter_->snapshot();
    const auto steady_now = AdapterSteadyClock::now();
    const auto ros_now = get_clock()->now();
    const int64_t telemetry_age = adapter_sample_age_ms(
      snapshot.telemetry_sample_known, snapshot.telemetry_sample_at, steady_now);
    const int64_t battery_age = adapter_sample_age_ms(
      snapshot.battery_sample_known, snapshot.battery_sample_at, steady_now);
    const int64_t error_age = adapter_sample_age_ms(
      snapshot.last_error_sample_known, snapshot.last_error_at, steady_now);
    const bool telemetry_fresh = adapter_sample_fresh(
      snapshot.telemetry_sample_known, snapshot.telemetry_sample_at,
      steady_now, adapter_telemetry_timeout_);
    const bool battery_fresh = snapshot.battery_known && adapter_sample_fresh(
      snapshot.battery_sample_known, snapshot.battery_sample_at,
      steady_now, adapter_battery_timeout_);
    const auto health = assess_adapter_health(
      snapshot, steady_now, adapter_telemetry_timeout_, adapter_battery_timeout_);

    const BatteryMergedState battery_state =
      compute_battery_state(snapshot, steady_now);
    const float unknown = std::numeric_limits<float>::quiet_NaN();
    sensor_msgs::msg::BatteryState battery;
    battery.header.stamp = ros_now;
    battery.voltage = battery_state.voltage_known ? battery_state.voltage : unknown;
    battery.temperature =
      battery_state.temperature_known ? battery_state.temperature : unknown;
    battery.current = battery_state.current_known ? battery_state.current : unknown;
    battery.charge = unknown;
    battery.capacity = unknown;
    battery.design_capacity = unknown;
    // Phase 0 wire convention kept: this field carries the normalized 0..1
    // fraction (merged.percentage is 0..100 per the sensor_msgs scale).
    battery.percentage = battery_state.percentage_known ?
      battery_state.percentage / 100.0F : unknown;
    battery.power_supply_status = static_cast<uint8_t>(battery_state.status);
    battery.power_supply_health = static_cast<uint8_t>(battery_state.health);
    battery.power_supply_technology =
      sensor_msgs::msg::BatteryState::POWER_SUPPLY_TECHNOLOGY_UNKNOWN;
    // BatteryState has no tri-state presence field. False is therefore used
    // for unknown presence, while diagnostics carries the explicit known bit.
    // Percentage freshness never changes physical-presence reporting.
    battery.present = battery_state_present(snapshot);
    battery.location = snapshot.adapter_name;
    battery_state_->publish(battery);

    diagnostic_msgs::msg::DiagnosticStatus adapter_status;
    adapter_status.name = "omni/robot_adapter";
    adapter_status.hardware_id = snapshot.adapter_name;
    switch (health.level) {
      case AdapterHealthLevel::ok:
        adapter_status.level = diagnostic_msgs::msg::DiagnosticStatus::OK;
        break;
      case AdapterHealthLevel::warning:
        adapter_status.level = diagnostic_msgs::msg::DiagnosticStatus::WARN;
        break;
      case AdapterHealthLevel::error:
        adapter_status.level = diagnostic_msgs::msg::DiagnosticStatus::ERROR;
        break;
    }
    adapter_status.message = health.reason;
    const auto boolean = [](bool value) {return value ? "true" : "false";};
    adapter_status.values = {
      diagnostic_value("adapter", snapshot.adapter_name),
      diagnostic_value("connection_known", boolean(snapshot.connection_known)),
      diagnostic_value(
        "connected", snapshot.connection_known ? boolean(snapshot.connected) : "unknown"),
      diagnostic_value("telemetry_fresh", boolean(telemetry_fresh)),
      diagnostic_value("telemetry_age_ms", std::to_string(telemetry_age)),
      diagnostic_value("battery_known", boolean(snapshot.battery_known)),
      diagnostic_value(
        "battery_presence_known", boolean(snapshot.battery_presence_known)),
      diagnostic_value(
        "battery_present", snapshot.battery_presence_known ?
        boolean(snapshot.battery_present) : "unknown"),
      diagnostic_value(
        "battery_fraction", snapshot.battery_known ?
        std::to_string(snapshot.battery_fraction) : "unknown"),
      diagnostic_value("battery_fresh", boolean(battery_fresh)),
      diagnostic_value("battery_age_ms", std::to_string(battery_age)),
      diagnostic_value(
        "power_supply_device", power_supply_resolved_device_.empty() ?
        "none" : power_supply_resolved_device_),
      diagnostic_value(
        "power_supply_present", !power_supply_reading_.has_value() ||
        !power_supply_reading_->present_known ? "unknown" :
        boolean(power_supply_reading_->present)),
      diagnostic_value(
        "power_supply_type", power_supply_reading_.has_value() &&
        power_supply_reading_->type_known ?
        power_supply_reading_->type : "unknown"),
      diagnostic_value(
        "battery_status", power_supply_status_name(battery_state.status)),
      diagnostic_value("battery_status_source", battery_state.status_source),
      diagnostic_value("battery_charging", boolean(battery_state.charging)),
      diagnostic_value("charger_connected", boolean(battery_state.charger_connected)),
      diagnostic_value(
        "battery_voltage_v", battery_state.voltage_known ?
        std::to_string(battery_state.voltage) : "unknown"),
      diagnostic_value(
        "battery_current_a", battery_state.current_known ?
        std::to_string(battery_state.current) : "unknown"),
      diagnostic_value(
        "battery_current_raw_a", power_supply_reading_.has_value() &&
        power_supply_reading_->current_a ?
        std::to_string(*power_supply_reading_->current_a) : "unknown"),
      diagnostic_value(
        "battery_temperature_c", battery_state.temperature_known ?
        std::to_string(battery_state.temperature) : "unknown"),
      diagnostic_value("control_mode_known", boolean(snapshot.control_mode_known)),
      diagnostic_value("control_mode", snapshot.control_mode),
      diagnostic_value("posture_known", boolean(snapshot.posture_known)),
      diagnostic_value("posture", snapshot.posture),
      diagnostic_value("authority_known", boolean(snapshot.authority_known)),
      diagnostic_value("authority_state", snapshot.authority_state),
      diagnostic_value(
        "authority_owner", snapshot.authority_owner.empty() ? "none" : snapshot.authority_owner),
      diagnostic_value("last_sdk_result_known", boolean(snapshot.last_sdk_result_known)),
      diagnostic_value(
        "last_sdk_result_code", snapshot.last_sdk_result_known ?
        std::to_string(snapshot.last_sdk_result_code) : "unknown"),
      diagnostic_value("last_sdk_result", snapshot.last_sdk_result),
      diagnostic_value("last_error_active", boolean(snapshot.last_error_active)),
      diagnostic_value("last_error_domain", snapshot.last_error_domain),
      diagnostic_value(
        "last_error", snapshot.last_error.empty() ? "none" : snapshot.last_error),
      diagnostic_value("last_error_age_ms", std::to_string(error_age)),
      diagnostic_value("snapshot_sequence", std::to_string(snapshot.sequence)),
    };
    diagnostic_msgs::msg::DiagnosticArray diagnostics;
    diagnostics.header.stamp = ros_now;
    diagnostics.status.push_back(std::move(adapter_status));
    adapter_diagnostics_->publish(diagnostics);

    std::ostringstream connection;
    connection << "known=" << boolean(snapshot.connection_known) <<
      ";connected=" << (snapshot.connection_known ? boolean(snapshot.connected) : "unknown") <<
      ";fresh=" << boolean(telemetry_fresh) <<
      ";age_ms=" << telemetry_age;
    publish(adapter_connection_, connection.str());

    std::ostringstream mode;
    mode << "fresh=" << boolean(telemetry_fresh) <<
      ";control_mode_known=" << boolean(snapshot.control_mode_known) <<
      ";control_mode=" << (telemetry_fresh ?
      safe_status_field(snapshot.control_mode) : "unknown") <<
      ";posture_known=" << boolean(snapshot.posture_known) <<
      ";posture=" << (telemetry_fresh ? safe_status_field(snapshot.posture) : "unknown");
    publish(adapter_mode_, mode.str());

    std::ostringstream sdk_error;
    sdk_error << "active=" << boolean(snapshot.last_error_active) <<
      ";domain=" << safe_status_field(snapshot.last_error_domain) <<
      ";last_error=" << safe_status_field(snapshot.last_error) <<
      ";age_ms=" << error_age <<
      ";last_result_known=" << boolean(snapshot.last_sdk_result_known) <<
      ";last_result=" << safe_status_field(snapshot.last_sdk_result);
    publish(adapter_sdk_error_, sdk_error.str());

    std::ostringstream summary;
    summary << "adapter=" << safe_status_field(snapshot.adapter_name) <<
      ";health=" << health.reason <<
      ";connection=" << (!snapshot.connection_known ? "unknown" :
      !snapshot.connected ? "disconnected" : !telemetry_fresh ? "stale" : "connected") <<
      ";battery_fresh=" << boolean(battery_fresh) <<
      ";battery_present=" << (!snapshot.battery_presence_known ? "unknown" :
      boolean(snapshot.battery_present)) <<
      ";battery=" << (battery_fresh ?
      std::to_string(snapshot.battery_fraction) : "unknown") <<
      ";mode=" << (telemetry_fresh ? safe_status_field(snapshot.control_mode) : "unknown") <<
      ";posture=" << (telemetry_fresh ? safe_status_field(snapshot.posture) : "unknown") <<
      ";authority=" << safe_status_field(snapshot.authority_state) <<
      ";owner=" << safe_status_field(snapshot.authority_owner) <<
      ";last_error_active=" << boolean(snapshot.last_error_active) <<
      ";last_error_domain=" << safe_status_field(snapshot.last_error_domain) <<
      ";sequence=" << snapshot.sequence;
    publish(adapter_summary_, summary.str());
  }

  /**
   * Merged battery state shared by /battery_state and /omni/robot_state.
   *
   * Real BMS electrical data (voltage / current / temperature / status /
   * health) comes from the Linux power-supply class, cached with a 1 s TTL so
   * the 1 Hz adapter timer and the 4 Hz robot_state tick share one read. The
   * vendor SDK only provides SOC: it stays the primary percentage source and
   * feeds the SOC-trend fallback for the charging direction. The read is
   * fail-closed: an absent or broken power-supply device degrades back to the
   * Phase 0 SOC-only behavior instead of erroring.
   */
  BatteryMergedState compute_battery_state(
    const AdapterSnapshot & snapshot, AdapterSteadyTime steady_now)
  {
    if (!power_supply_reading_.has_value() ||
      steady_now - power_supply_read_at_.value() >= battery_sysfs_ttl_)
    {
      const std::string device = power_supply_device_.empty() ?
        find_power_supply_device(power_supply_root_) : power_supply_device_;
      power_supply_resolved_device_ = device;
      power_supply_reading_ = read_power_supply(power_supply_root_, device);
      power_supply_read_at_ = steady_now;
    }
    const bool battery_fresh = snapshot.battery_known && adapter_sample_fresh(
      snapshot.battery_sample_known, snapshot.battery_sample_at,
      steady_now, adapter_battery_timeout_);
    const bool sdk_soc_known = battery_fresh && std::isfinite(snapshot.battery_fraction);
    if (sdk_soc_known) {
      // The adapter re-exposes the same 10 s SDK sample on each poll; the
      // charger dedupes on the sample timestamp, so this is safe to call per
      // tick.
      soc_trend_charger_.update(
        snapshot.battery_fraction * 100.0, snapshot.battery_sample_at);
    }
    std::optional<PowerSupplyStatus> trend_status;
    if (!power_supply_reading_->status.has_value()) {
      trend_status = soc_trend_charger_.status();
    }
    return merge_battery_state(
      sdk_soc_known, static_cast<double>(snapshot.battery_fraction),
      *power_supply_reading_, trend_status,
      battery_current_sign_, charge_current_threshold_a_);
  }

  // Whole-robot snapshot on /omni/robot_state: adapter observability + E-stop
  // latch + mapping state + control lease, relayed from /omni/slam/status and
  // /omni/mission/status. Publishes on change plus a 1 Hz heartbeat so a
  // static robot still announces liveness.
  void publish_robot_state()
  {
    if (!robot_state_) {
      return;
    }
    const auto steady_now = AdapterSteadyClock::now();
    const AdapterSnapshot snapshot = adapter_->snapshot();
    const auto health = assess_adapter_health(
      snapshot, steady_now, adapter_telemetry_timeout_, adapter_battery_timeout_);
    const BatteryMergedState battery_state =
      compute_battery_state(snapshot, steady_now);
    const float unknown = std::numeric_limits<float>::quiet_NaN();
    // The merged percentage falls back to the sysfs capacity when the SDK
    // sample is stale, so a dead SDK poller no longer blanks the robot
    // state percentage while a real BMS is still reporting.
    const float battery_percentage = battery_state.percentage_known ?
      battery_state.percentage : unknown;
    bool mapping_active = false;
    {
      std::lock_guard<std::mutex> lock(mapping_mutex_);
      mapping_active = mapping_pid_ > 0;
    }
    RobotStateAggregator::Relay relay;
    relay.slam_fresh = adapter_sample_fresh(
      slam_relay_.known, slam_relay_.received_at, steady_now, robot_state_slam_stale_);
    if (relay.slam_fresh) {
      relay.slam_mode = slam_relay_.mode;
      relay.slam_state = slam_relay_.state;
      relay.slam_map_id = slam_relay_.map_id;
      relay.slam_map_version = slam_relay_.map_version;
      relay.slam_fitness = slam_relay_.fitness;
    }
    relay.mission_fresh = adapter_sample_fresh(
      mission_relay_.known, mission_relay_.received_at, steady_now,
      robot_state_mission_stale_);
    if (relay.mission_fresh) {
      relay.mission_state = mission_relay_.state;
      relay.mission_id = mission_relay_.mission_id;
      relay.mission_progress = mission_relay_.progress;
    }

    const omni_robot_interfaces::msg::RobotState message = RobotStateAggregator::build(
      snapshot, health,
      battery_state.voltage_known ? battery_state.voltage : unknown,
      battery_percentage, battery_state.charging,
      cmd_vel_arbiter_ && cmd_vel_arbiter_->estop_latched(),
      mapping_active, adapter_->control_status(), relay);
    auto stamped = message;
    stamped.header.stamp = get_clock()->now();
    stamped.header.frame_id = "base_link";
    const bool changed = !last_robot_state_.has_value() ||
      RobotStateAggregator::effectively_changed(*last_robot_state_, stamped);
    const bool heartbeat_due = !last_robot_state_publish_.has_value() ||
      steady_now - *last_robot_state_publish_ >= robot_state_period_;
    if (changed || heartbeat_due) {
      last_robot_state_ = stamped;
      last_robot_state_publish_ = steady_now;
      robot_state_->publish(stamped);
    }
  }

  static cmd_vel_arbiter::RawTwist raw_twist(const geometry_msgs::msg::Twist & message)
  {
    return {
      message.linear.x,
      message.linear.y,
      message.linear.z,
      message.angular.x,
      message.angular.y,
      message.angular.z,
    };
  }

  static int64_t stamp_nanoseconds(const builtin_interfaces::msg::Time & stamp)
  {
    if (stamp.sec < 0) {
      return -1;
    }
    return static_cast<int64_t>(stamp.sec) * 1'000'000'000LL +
           static_cast<int64_t>(stamp.nanosec);
  }

  void synchronize_arbiter_control_status()
  {
    if (!cmd_vel_arbiter_) {
      return;
    }
    const std::string current = adapter_->control_status();
    if (current == arbiter_control_status_) {
      return;
    }
    // Commands captured before an authority transition must never start moving
    // after a different owner acquires control.
    cmd_vel_arbiter_->clear_sources();
    arbiter_control_status_ = current;
  }

  void receive_stamped_velocity(
    cmd_vel_arbiter::Source source,
    const geometry_msgs::msg::TwistStamped & message)
  {
    if (!cmd_vel_arbiter_) {
      return;
    }
    if (!velocity_source_has_unique_publisher(source)) {
      publish_arbiter_output();
      return;
    }
    synchronize_arbiter_control_status();
    const auto health = cmd_vel_arbiter_->ingest_stamped(
      source, raw_twist(message.twist), stamp_nanoseconds(message.header.stamp),
      get_clock()->now().nanoseconds(), cmd_vel_arbiter::SteadyClock::now());
    if (health != cmd_vel_arbiter::SourceHealth::ready) {
      RCLCPP_WARN_THROTTLE(
        get_logger(), *get_clock(), 1000,
        "cmd_vel arbiter rejected %s input: %s",
        cmd_vel_arbiter::source_name(source), cmd_vel_arbiter::health_name(health));
    } else {
      const auto stamp_health = cmd_vel_arbiter_->stamp_health(source);
      if (stamp_health == cmd_vel_arbiter::SourceHealth::stale_stamp ||
        stamp_health == cmd_vel_arbiter::SourceHealth::future_stamp)
      {
        RCLCPP_WARN_THROTTLE(
          get_logger(), *get_clock(), 2000,
          "cmd_vel arbiter accepted %s by arrival timeout but detected %s skew=%ldms; "
          "enable stamp enforcement after NTP verification",
          cmd_vel_arbiter::source_name(source), cmd_vel_arbiter::health_name(stamp_health),
          static_cast<long>(cmd_vel_arbiter_->last_stamp_skew_ms(source)));
      }
    }
    publish_arbiter_output();
  }

  void receive_navigation_velocity(const geometry_msgs::msg::Twist & message)
  {
    if (!cmd_vel_arbiter_) {
      return;
    }
    if (!velocity_source_has_unique_publisher(cmd_vel_arbiter::Source::navigation)) {
      publish_arbiter_output();
      return;
    }
    synchronize_arbiter_control_status();
    const auto health = cmd_vel_arbiter_->ingest_navigation(
      raw_twist(message), cmd_vel_arbiter::SteadyClock::now());
    if (health != cmd_vel_arbiter::SourceHealth::ready) {
      RCLCPP_WARN_THROTTLE(
        get_logger(), *get_clock(), 1000,
        "cmd_vel arbiter rejected navigation input: %s",
        cmd_vel_arbiter::health_name(health));
    }
    publish_arbiter_output();
  }

  void receive_docking_velocity(const geometry_msgs::msg::Twist & message)
  {
    if (!cmd_vel_arbiter_) {
      return;
    }
    if (!velocity_source_has_unique_publisher(cmd_vel_arbiter::Source::docking)) {
      publish_arbiter_output();
      return;
    }
    synchronize_arbiter_control_status();
    const auto health = cmd_vel_arbiter_->ingest_unstamped(
      cmd_vel_arbiter::Source::docking, raw_twist(message),
      cmd_vel_arbiter::SteadyClock::now());
    if (health != cmd_vel_arbiter::SourceHealth::ready) {
      RCLCPP_WARN_THROTTLE(
        get_logger(), *get_clock(), 1000,
        "cmd_vel arbiter rejected docking input: %s",
        cmd_vel_arbiter::health_name(health));
    }
    publish_arbiter_output();
  }

  void receive_software_estop(bool active)
  {
    if (!cmd_vel_arbiter_) {
      return;
    }
    const std::size_t publisher_count = software_estop_->get_publisher_count();
    if (publisher_count != 1) {
      const bool newly_faulted = !estop_monitor_fault_;
      const bool newly_latched = !cmd_vel_arbiter_->estop_latched();
      RCLCPP_ERROR_THROTTLE(
        get_logger(), *get_clock(), 1000,
        "Software E-stop publisher conflict: expected exactly one, found %zu; latching stop",
        publisher_count);
      cmd_vel_arbiter_->set_estop(true);
      estop_monitor_fault_ = true;
      if (newly_faulted || newly_latched) {
        begin_direct_emergency_stop();
      }
      publish_arbiter_output();
      return;
    }
    last_estop_message_ = std::chrono::steady_clock::now();
    last_estop_input_active_ = active;
    if (active) {
      const bool changed = !cmd_vel_arbiter_->estop_latched();
      cmd_vel_arbiter_->set_estop(true);
      if (changed) {
        RCLCPP_ERROR(get_logger(), "Software emergency stop latched; all motion is blocked");
        begin_direct_emergency_stop();
      }
    }
    publish_arbiter_output();
  }

  void reset_software_estop(std_srvs::srv::Trigger::Response & response)
  {
    if (!cmd_vel_arbiter_ || !software_estop_) {
      response.success = false;
      response.message = "cmd_vel_arbiter_not_enabled";
      return;
    }
    const auto now = std::chrono::steady_clock::now();
    const bool unique_publisher = software_estop_->get_publisher_count() == 1;
    const bool fresh = last_estop_message_.has_value() &&
      now - *last_estop_message_ < estop_monitor_timeout_;
    const bool control_session_ready = direct_estop::control_session_ready_for_estop_reset(
      adapter_->requires_control_lease(), adapter_->control_status());
    const bool direct_stop_ready = direct_estop_guard_.reset_allowed(
      adapter_->requires_control_lease());
    if (!unique_publisher || (require_estop_monitor_ && !fresh) || last_estop_input_active_ ||
      !control_session_ready || !direct_stop_ready)
    {
      response.success = false;
      response.message = !unique_publisher ? "estop_publisher_not_unique" :
        !fresh ? "estop_monitor_not_fresh" : last_estop_input_active_ ?
        "estop_input_still_active" : !control_session_ready ?
        "control_session_not_acquired" : "direct_adapter_stop_not_confirmed";
      return;
    }
    estop_monitor_fault_ = false;
    cmd_vel_arbiter_->set_estop(false);
    direct_estop_guard_.cancel();
    publish_arbiter_output();
    response.success = true;
    response.message = "estop_reset_new_command_required";
    RCLCPP_WARN(get_logger(), "Software E-stop explicitly reset; cached commands remain cleared");
  }

  void begin_direct_emergency_stop()
  {
    direct_estop_guard_.begin(direct_estop::Clock::now());
  }

  bool restart_direct_emergency_stop_for_control_session()
  {
    if (!cmd_vel_arbiter_ || !cmd_vel_arbiter_->estop_latched() ||
      !adapter_->requires_control_lease())
    {
      return false;
    }
    direct_estop_guard_.restart_for_control_session(direct_estop::Clock::now());
    return true;
  }

  void service_direct_emergency_stop_retry(
    const std::chrono::steady_clock::time_point now)
  {
    constexpr auto retry_period = 200ms;
    if (!cmd_vel_arbiter_ || !cmd_vel_arbiter_->estop_latched()) {
      return;
    }
    const auto incident = direct_estop_guard_.start_attempt(now);
    if (!incident) {
      return;
    }

    adapter_->emergency_stop(
      [this, incident = *incident, retry_period](bool success, const std::string & reason) {
        const auto completion = direct_estop_guard_.complete_attempt(
          incident, success, direct_estop::Clock::now(), retry_period);
        if (completion == direct_estop::Completion::stale ||
          completion == direct_estop::Completion::confirmed)
        {
          return;
        }
        RCLCPP_ERROR(
          get_logger(), "Direct adapter emergency stop attempt %u failed: %s",
          direct_estop_guard_.attempts(), reason.c_str());
        if (completion == direct_estop::Completion::exhausted) {
          RCLCPP_ERROR(
            get_logger(),
            "Direct adapter emergency stop is unconfirmed; ordinary E-stop reset remains blocked");
        }
      });
  }

  void enforce_estop_monitor(const std::chrono::steady_clock::time_point now)
  {
    if (!require_estop_monitor_ || !software_estop_) {
      return;
    }
    const bool unique_publisher = software_estop_->get_publisher_count() == 1;
    const bool fresh = last_estop_message_.has_value() &&
      now - *last_estop_message_ < estop_monitor_timeout_;
    if (unique_publisher && fresh) {
      return;
    }
    const bool newly_latched = !cmd_vel_arbiter_->estop_latched();
    estop_monitor_fault_ = true;
    cmd_vel_arbiter_->set_estop(true);
    if (newly_latched) {
      begin_direct_emergency_stop();
    }
    RCLCPP_ERROR_THROTTLE(
      get_logger(), *get_clock(), 1000,
      "E-stop monitor unhealthy: publishers=%zu fresh=%s; explicit reset required",
      software_estop_->get_publisher_count(), fresh ? "true" : "false");
  }

  bool velocity_source_has_unique_publisher(cmd_vel_arbiter::Source source)
  {
    std::size_t publisher_count = 0;
    switch (source) {
      case cmd_vel_arbiter::Source::teleop:
        publisher_count = cmd_vel_teleop_->get_publisher_count();
        break;
      case cmd_vel_arbiter::Source::docking:
        publisher_count = cmd_vel_docking_->get_publisher_count();
        break;
      case cmd_vel_arbiter::Source::navigation:
        publisher_count = cmd_vel_navigation_->get_publisher_count();
        break;
      case cmd_vel_arbiter::Source::none:
        return false;
    }
    if (publisher_count == 1) {
      return true;
    }
    cmd_vel_arbiter_->invalidate_source(
      source, cmd_vel_arbiter::SourceHealth::publisher_conflict);
    RCLCPP_ERROR_THROTTLE(
      get_logger(), *get_clock(), 1000,
      "cmd_vel arbiter rejected %s: expected exactly one publisher, found %zu",
      cmd_vel_arbiter::source_name(source), publisher_count);
    return false;
  }

  void publish_arbiter_output()
  {
    if (!cmd_vel_arbiter_ || !cmd_vel_output_) {
      return;
    }
    synchronize_arbiter_control_status();
    const auto now = cmd_vel_arbiter::SteadyClock::now();
    enforce_estop_monitor(now);
    const auto decision = cmd_vel_arbiter_->decide(now, arbiter_control_status_);

    geometry_msgs::msg::Twist output;
    output.linear.x = decision.command.vx;
    output.linear.y = decision.command.vy;
    output.angular.z = decision.command.yaw;
    cmd_vel_output_->publish(output);
    // Publish the arbiter's zero command before entering a vendor SDK call.
    // The SDK path remains software-only and may block, but it can no longer
    // delay this ROS-side stop publication within the same callback.
    service_direct_emergency_stop_retry(now);

    std::ostringstream status;
    status << "selected=" << cmd_vel_arbiter::source_name(decision.source) <<
      ";reason=" << cmd_vel_arbiter::reason_name(decision.reason) <<
      ";owner_kind=" << cmd_vel_arbiter::owner_name(decision.owner) <<
      ";authority=" << arbiter_control_status_ <<
      ";estop=" << (cmd_vel_arbiter_->estop_latched() ? "true" : "false") <<
      ";estop_monitor_fault=" << (estop_monitor_fault_ ? "true" : "false") <<
      ";direct_stop_confirmed=" << (direct_estop_guard_.confirmed() ? "true" : "false") <<
      ";direct_stop_attempts=" << direct_estop_guard_.attempts() <<
      ";stamp_enforce=" <<
      (cmd_vel_arbiter_->stamp_freshness_enforced() ? "true" : "false") <<
      ";teleop=" << cmd_vel_arbiter::health_name(
      cmd_vel_arbiter_->source_health(cmd_vel_arbiter::Source::teleop, now)) <<
      ";docking=" << cmd_vel_arbiter::health_name(
      cmd_vel_arbiter_->source_health(cmd_vel_arbiter::Source::docking, now)) <<
      ";navigation=" << cmd_vel_arbiter::health_name(
      cmd_vel_arbiter_->source_health(cmd_vel_arbiter::Source::navigation, now)) <<
      ";teleop_stamp=" << cmd_vel_arbiter::health_name(
      cmd_vel_arbiter_->stamp_health(cmd_vel_arbiter::Source::teleop)) <<
      ";teleop_skew_ms=" << cmd_vel_arbiter_->last_stamp_skew_ms(
      cmd_vel_arbiter::Source::teleop) <<
      ";teleop_skew_events=" << cmd_vel_arbiter_->stamp_skew_events(
      cmd_vel_arbiter::Source::teleop) <<
      ";teleop_stamp_rejects=" << cmd_vel_arbiter_->stamp_rejections(
      cmd_vel_arbiter::Source::teleop) <<
      ";docking_stamp=" << cmd_vel_arbiter::health_name(
      cmd_vel_arbiter_->stamp_health(cmd_vel_arbiter::Source::docking)) <<
      ";docking_skew_ms=" << cmd_vel_arbiter_->last_stamp_skew_ms(
      cmd_vel_arbiter::Source::docking) <<
      ";docking_skew_events=" << cmd_vel_arbiter_->stamp_skew_events(
      cmd_vel_arbiter::Source::docking) <<
      ";docking_stamp_rejects=" << cmd_vel_arbiter_->stamp_rejections(
      cmd_vel_arbiter::Source::docking);
    const std::string base_status = status.str();
    const bool changed = base_status != last_arbiter_status_;
    const bool heartbeat_due = !last_arbiter_status_publish_.has_value() ||
      now - *last_arbiter_status_publish_ >= arbiter_status_period_;
    if (changed || heartbeat_due) {
      last_arbiter_status_ = base_status;
      last_arbiter_status_publish_ = now;
      ++arbiter_status_sequence_;
      const std::string heartbeat_status =
        base_status + ";status_seq=" + std::to_string(arbiter_status_sequence_);
      publish(cmd_vel_arbiter_status_, heartbeat_status);
      if (changed) {
        RCLCPP_INFO(get_logger(), "cmd_vel arbiter: %s", heartbeat_status.c_str());
      }
    }
  }

  void publish(
    const rclcpp::Publisher<std_msgs::msg::String>::SharedPtr & publisher,
    const std::string & value)
  {
    if (!publisher) {
      return;
    }
    std_msgs::msg::String message;
    message.data = value;
    publisher->publish(message);
  }

  void request_control(const std::string & command)
  {
    const auto separator = command.find(':');
    const std::string action = command.substr(0, separator);
    const std::string client_id = separator == std::string::npos ? "" :
      command.substr(separator + 1);
    if ((action != "acquire" && action != "release" && action != "heartbeat" &&
      action != "status") || !valid_client_id(client_id))
    {
      RCLCPP_WARN(
        get_logger(), "Control command rejected: malformed action=%s client=%s",
        safe_reason(action).c_str(), safe_reason(client_id).c_str());
      publish(control_status_, "error:command:unknown:malformed_request");
      return;
    }

    if (action == "status") {
      publish_control_status_if_changed(true);
      return;
    }

    if (cmd_vel_arbiter_ && cmd_vel_arbiter_->estop_latched() &&
      !direct_estop::control_action_allowed_while_estop_latched(action))
    {
      RCLCPP_ERROR(
        get_logger(),
        "Control action rejected while software E-stop is latched: action=%s client=%s",
        action.c_str(), client_id.c_str());
      publish(control_status_, "error:" + action + ':' + client_id + ":estop_latched");
      return;
    }

    if (action != "heartbeat") {
      RCLCPP_INFO(
        get_logger(), "Control command received: action=%s client=%s current=%s",
        action.c_str(), client_id.c_str(), adapter_->control_status().c_str());
    }
    adapter_->request_control(
      action, client_id,
      [this, action, client_id](bool success, const std::string & reason) {
        // An acquire completion can mean that a previously unconnected SDK
        // session is now live. Invalidate any stop confirmation obtained while
        // it was idle/acquiring before another callback can reset the latch.
        // Do not call the adapter again here: immediate callbacks may still be
        // running under an adapter mutex. The arbiter timer performs the stop.
        if (action == "acquire" && success) {
          restart_direct_emergency_stop_for_control_session();
        }
        if (action == "heartbeat") {
          if (!success) {
            RCLCPP_WARN_THROTTLE(
              get_logger(), *get_clock(), 2000,
              "Control heartbeat rejected: client=%s reason=%s",
              client_id.c_str(), reason.c_str());
          }
          return;
        }
        if (success) {
          RCLCPP_INFO(
            get_logger(), "Control command completed: action=%s client=%s reason=%s",
            action.c_str(), client_id.c_str(), reason.c_str());
        } else {
          RCLCPP_ERROR(
            get_logger(), "Control command failed: action=%s client=%s reason=%s",
            action.c_str(), client_id.c_str(), reason.c_str());
          publish(
            control_status_,
            "error:" + action + ':' + client_id + ':' + safe_reason(reason));
        }
      });
    // Initial SDK construction happens synchronously inside request_control(),
    // before an asynchronous acquire callback reports a connected session.
    // Start a fresh incident now and publish zero before directly stopping the
    // newly created session. A later successful completion restarts it again.
    if (action == "acquire" && restart_direct_emergency_stop_for_control_session()) {
      publish_arbiter_output();
    }
    publish_control_status_if_changed();
  }

  void publish_control_status_if_changed(bool force = false)
  {
    if (!control_status_) {
      return;
    }
    const std::string status = adapter_->control_status();
    if (!force && status == last_control_status_) {
      return;
    }
    last_control_status_ = status;
    publish(control_status_, status);
  }

  bool actuator_command_is_authorized(
    const std::string & wire_command, std::string & command, std::string & client_id)
  {
    const auto separator = wire_command.find(':');
    command = wire_command.substr(0, separator);
    client_id = separator == std::string::npos ? "" : wire_command.substr(separator + 1);
    if (!adapter_->requires_control_lease()) {
      return true;
    }
    return valid_client_id(client_id) &&
           adapter_->control_status() == "acquired:" + client_id;
  }

  void request_locomotion(std::string wire_command)
  {
    std::string command;
    std::string client_id;
    if (!actuator_command_is_authorized(wire_command, command, client_id)) {
      RCLCPP_ERROR(
        get_logger(), "Locomotion request rejected: client does not own control: %s",
        safe_reason(client_id).c_str());
      publish(locomotion_status_, "error:loco:not_control_owner");
      return;
    }
    RCLCPP_INFO(get_logger(), "Locomotion command received: command=%s", command.c_str());
    if (command != "loco") {
      RCLCPP_WARN(
        get_logger(), "Locomotion command rejected: unsupported command=%s", command.c_str());
      publish(locomotion_status_, "error:" + safe_reason(command) + ":unsupported_command");
      return;
    }
    if (cmd_vel_arbiter_ && cmd_vel_arbiter_->estop_latched()) {
      RCLCPP_ERROR(get_logger(), "Locomotion request rejected while software E-stop is latched");
      publish(locomotion_status_, "error:loco:estop_latched");
      return;
    }
    if (locomotion_busy_.exchange(true)) {
      RCLCPP_WARN(get_logger(), "Locomotion command rejected: request already in progress");
      publish(locomotion_status_, "error:loco:request_in_progress");
      return;
    }
    adapter_->request_locomotion(
      [this](bool success, const std::string & reason) {
        locomotion_busy_ = false;
        if (success) {
          RCLCPP_INFO(
            get_logger(), "Locomotion command completed: success reason=%s", reason.c_str());
        } else {
          RCLCPP_ERROR(get_logger(), "Locomotion command failed: reason=%s", reason.c_str());
        }
        publish(
          locomotion_status_,
          success ? "success:loco" : "error:loco:" + safe_reason(reason));
      });
  }

  void request_posture(std::string wire_command)
  {
    std::string command;
    std::string client_id;
    if (!actuator_command_is_authorized(wire_command, command, client_id)) {
      RCLCPP_ERROR(
        get_logger(), "Posture request rejected: client does not own control: %s",
        safe_reason(client_id).c_str());
      publish(posture_status_, "error:" + safe_reason(command) + ":not_control_owner");
      return;
    }
    RCLCPP_INFO(get_logger(), "Posture command received: command=%s", command.c_str());
    if (command != "stand" && command != "lie_down" && command != "emergency_stop") {
      RCLCPP_WARN(
        get_logger(), "Posture command rejected: unsupported command=%s", command.c_str());
      publish(posture_status_, "error:" + safe_reason(command) + ":unsupported_command");
      return;
    }
    // A stop command must remain deliverable after the software latch is set;
    // stand/lie-down transitions stay blocked until the explicit reset path.
    if (command != "emergency_stop" && cmd_vel_arbiter_ &&
      cmd_vel_arbiter_->estop_latched())
    {
      RCLCPP_ERROR(
        get_logger(), "Posture request rejected while software E-stop is latched: %s",
        command.c_str());
      publish(posture_status_, "error:" + command + ":estop_latched");
      return;
    }
    if (posture_busy_.exchange(true)) {
      RCLCPP_WARN(
        get_logger(), "Posture command rejected: action already in progress command=%s",
        command.c_str());
      publish(posture_status_, "error:" + command + ":action_in_progress");
      return;
    }
    adapter_->request_posture(
      command,
      [this, command](bool success, const std::string & reason) {
        posture_busy_ = false;
        if (success) {
          RCLCPP_INFO(
            get_logger(), "Posture command completed: command=%s reason=%s",
            command.c_str(), reason.c_str());
        } else {
          RCLCPP_ERROR(
            get_logger(), "Posture command failed: command=%s reason=%s",
            command.c_str(), reason.c_str());
        }
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
  bool control_enabled_{false};
  bool cmd_vel_arbiter_enabled_{false};
  bool require_estop_monitor_{false};
  bool estop_monitor_fault_{false};
  bool last_estop_input_active_{true};
  bool robot_state_enabled_{false};
  direct_estop::Guard direct_estop_guard_;
  std::string mapping_script_;
  std::string mapping_log_;
  std::chrono::seconds mapping_stop_timeout_{30};
  std::chrono::seconds mapping_kill_timeout_{5};
  std::chrono::milliseconds estop_monitor_timeout_{500};
  std::chrono::milliseconds arbiter_status_period_{1000};
  std::chrono::milliseconds adapter_status_period_{1000};
  std::chrono::milliseconds adapter_telemetry_timeout_{1500};
  std::chrono::milliseconds adapter_battery_timeout_{15000};
  std::chrono::milliseconds battery_sysfs_ttl_{1000};
  std::filesystem::path power_supply_root_;
  std::string power_supply_device_;  // "" = auto-detect the Battery device
  std::string power_supply_resolved_device_;
  double battery_current_sign_{1.0};
  double charge_current_threshold_a_{0.05};
  SocTrendCharger soc_trend_charger_;
  std::optional<PowerSupplyReading> power_supply_reading_;
  std::optional<AdapterSteadyTime> power_supply_read_at_;
  std::chrono::milliseconds robot_state_period_{1000};
  std::chrono::milliseconds robot_state_tick_{250};
  std::chrono::milliseconds robot_state_slam_stale_{2000};
  std::chrono::milliseconds robot_state_mission_stale_{5000};
  SlamRelayState slam_relay_;
  MissionRelayState mission_relay_;
  std::optional<omni_robot_interfaces::msg::RobotState> last_robot_state_;
  std::optional<std::chrono::steady_clock::time_point> last_robot_state_publish_;
  std::optional<std::chrono::steady_clock::time_point> last_estop_message_;
  // Declared before adapter_ so adapter SDK teardown runs before lock release.
  std::unique_ptr<SdkOwnerLock> sdk_owner_lock_;
  std::unique_ptr<RobotAdapter> adapter_;
  std::atomic_bool posture_busy_{false};
  std::atomic_bool locomotion_busy_{false};
  std::mutex mapping_mutex_;
  pid_t mapping_pid_{-1};
  bool mapping_stop_requested_{false};
  std::chrono::steady_clock::time_point mapping_stop_requested_at_{};
  std::thread mapping_waiter_;
  std::string last_control_status_;
  std::string arbiter_control_status_;
  std::string last_arbiter_status_;
  std::optional<std::chrono::steady_clock::time_point> last_arbiter_status_publish_;
  uint64_t arbiter_status_sequence_{0};
  std::unique_ptr<cmd_vel_arbiter::Arbiter> cmd_vel_arbiter_;

  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr cmd_vel_output_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr mapping_status_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr posture_status_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr locomotion_status_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr control_status_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr cmd_vel_arbiter_status_;
  rclcpp::Publisher<sensor_msgs::msg::BatteryState>::SharedPtr battery_state_;
  rclcpp::Publisher<diagnostic_msgs::msg::DiagnosticArray>::SharedPtr adapter_diagnostics_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr adapter_connection_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr adapter_mode_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr adapter_sdk_error_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr adapter_summary_;
  rclcpp::Publisher<omni_robot_interfaces::msg::RobotState>::SharedPtr robot_state_;
  rclcpp::Subscription<omni_slam_interfaces::msg::SlamStatus>::SharedPtr slam_status_;
  rclcpp::Subscription<omni_robot_interfaces::msg::MissionStatus>::SharedPtr mission_status_;
  rclcpp::Subscription<geometry_msgs::msg::TwistStamped>::SharedPtr cmd_vel_teleop_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr cmd_vel_docking_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr cmd_vel_navigation_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr software_estop_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr estop_reset_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr mapping_command_;
  rclcpp::Subscription<std_msgs::msg::String>::SharedPtr posture_command_;
  rclcpp::Subscription<std_msgs::msg::String>::SharedPtr locomotion_command_;
  rclcpp::Subscription<std_msgs::msg::String>::SharedPtr control_command_;
  rclcpp::TimerBase::SharedPtr control_status_timer_;
  rclcpp::TimerBase::SharedPtr cmd_vel_arbiter_timer_;
  rclcpp::TimerBase::SharedPtr adapter_status_timer_;
  rclcpp::TimerBase::SharedPtr robot_state_timer_;
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

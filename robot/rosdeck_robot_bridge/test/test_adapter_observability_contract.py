from pathlib import Path
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def _source(relative_path):
    return (PACKAGE_ROOT / relative_path).read_text(encoding="utf-8")


class AdapterObservabilityContractStaticTest(unittest.TestCase):
    def test_robot_adapter_requires_cached_snapshot(self):
        interface = _source("include/rosdeck_robot_bridge/robot_adapter.hpp")
        self.assertIn("virtual AdapterSnapshot snapshot() const = 0", interface)
        self.assertIn("must never perform", interface)

    def test_bridge_publishes_standard_battery_and_diagnostics(self):
        bridge = _source("src/bridge_node.cpp")
        self.assertIn("sensor_msgs::msg::BatteryState", bridge)
        self.assertIn("diagnostic_msgs::msg::DiagnosticArray", bridge)
        self.assertIn('"/battery_state"', bridge)
        self.assertIn('"/diagnostics"', bridge)
        self.assertIn('"/omni/robot/adapter_status"', bridge)

    def test_bridge_publisher_only_consumes_snapshot(self):
        bridge = _source("src/bridge_node.cpp")
        start = bridge.index("void publish_adapter_observability()")
        end = bridge.index("static cmd_vel_arbiter::RawTwist", start)
        publisher = bridge[start:end]
        self.assertIn("adapter_->snapshot()", publisher)
        for forbidden in (
            "checkConnect",
            "getBatteryPower",
            "getCurrentCtrlmode",
            "highlevel_",
        ):
            self.assertNotIn(forbidden, publisher)

    def test_zsibot_snapshot_is_mutex_protected_and_io_free(self):
        adapter = _source("src/zsibot_adapter.cpp")
        start = adapter.index("AdapterSnapshot snapshot() const override")
        end = adapter.index("bool requires_control_lease() const override", start)
        snapshot = adapter[start:end]
        self.assertIn("std::lock_guard<std::mutex> lock(sdk_mutex_)", snapshot)
        self.assertIn("battery_fraction_", snapshot)
        self.assertIn("control_mode_cache_", snapshot)
        self.assertNotIn("highlevel_->", snapshot)

    def test_unknown_adapters_do_not_claim_healthy_telemetry(self):
        bridge = _source("src/bridge_node.cpp")
        vbot = _source("src/vbot_adapter.cpp")
        no_sdk_zsibot = _source("src/zsibot_adapter.cpp")
        self.assertIn('value.last_error = "adapter_not_available"', bridge)
        self.assertIn('value.authority_state = "unsupported"', vbot)
        self.assertNotIn("value.connection_known = true", vbot)
        self.assertIn('value.last_error = "zsibot_sdk_not_built"', no_sdk_zsibot)

    def test_sdk_exception_paths_feed_last_error_cache(self):
        adapter = _source("src/zsibot_adapter.cpp")
        self.assertIn("record_error_locked(context, detail)", adapter)
        self.assertIn('record_error_locked("sdk_init", error.what())', adapter)
        self.assertIn('record_error_locked("velocity_move", exception_detail)', adapter)
        self.assertIn('"battery_sample", "percent_out_of_range_"', adapter)

    def test_fault_domains_cannot_be_cleared_by_unrelated_success(self):
        adapter = _source("src/zsibot_adapter.cpp")
        vbot = _source("src/vbot_adapter.cpp")
        start = adapter.index("void mark_poll_healthy_locked()")
        end = adapter.index("void enter_sdk_fault_locked", start)
        healthy_poll = adapter[start:end]
        self.assertIn("clear_fault_domain_locked(FaultDomain::telemetry)", healthy_poll)
        self.assertNotIn("last_error_active_ = false", healthy_poll)
        self.assertIn("std::array<ActiveFault, fault_domain_count>", adapter)
        self.assertIn("FaultDomain::motion_input", adapter)
        self.assertIn("FaultDomain::stop", adapter)
        self.assertIn("FaultDomain::release", adapter)
        self.assertIn("std::array<CommandFault", vbot)
        self.assertIn("CommandDomain::locomotion", vbot)
        self.assertIn("CommandDomain::posture", vbot)

    def test_battery_presence_is_independent_from_percentage_freshness(self):
        helper = _source("include/rosdeck_robot_bridge/adapter_observability.hpp")
        bridge = _source("src/bridge_node.cpp")
        self.assertIn("battery_presence_known", helper)
        self.assertIn("battery_state_present(snapshot)", bridge)
        self.assertIn("battery_fresh && std::isfinite", bridge)
        self.assertIn('"battery_presence_known"', bridge)
        self.assertIn('"battery_present"', bridge)

    def test_unknown_posture_cannot_be_reported_healthy(self):
        helper = _source("include/rosdeck_robot_bridge/adapter_observability.hpp")
        self.assertIn('"adapter_posture_unknown"', helper)

    def test_degraded_release_is_not_reported_as_success(self):
        adapter = _source("src/zsibot_adapter.cpp")
        self.assertIn("mark_release_degraded_locked", adapter)
        self.assertIn("initial_stop_failed_", adapter)
        self.assertIn("lie_down_timeout_mode_", adapter)
        self.assertIn("completed_success = !release_degraded_", adapter)
        self.assertIn("released_degraded_", adapter)
        self.assertIn("zsibot.stop_settle_ms must be in [0, 500]", adapter)

    def test_zsibot_estop_contract_is_fail_closed(self):
        bridge = _source("src/bridge_node.cpp")
        self.assertIn(
            '"cmd_vel_arbiter.require_estop_monitor=false is forbidden', bridge
        )
        self.assertIn("requested_estop_monitor_timeout > 500", bridge)
        self.assertIn(
            'software_estop_->get_topic_name() != std::string("/omni/safety/estop")',
            bridge,
        )
        self.assertIn("estop_reset_->get_service_name()", bridge)
        self.assertIn("direct_estop_guard_.reset_allowed", bridge)
        self.assertIn('"direct_adapter_stop_not_confirmed"', bridge)
        self.assertIn('"control_session_not_acquired"', bridge)
        self.assertIn("const bool newly_faulted = !estop_monitor_fault_", bridge)
        self.assertIn("control_action_allowed_while_estop_latched", bridge)
        self.assertIn("restart_direct_emergency_stop_for_control_session", bridge)

        guard = _source("include/rosdeck_robot_bridge/direct_estop_guard.hpp")
        self.assertIn("static constexpr uint32_t max_attempts = 3", guard)
        self.assertIn("incident != incident_", guard)
        self.assertIn('action == "acquire"', guard)
        self.assertIn("restart_for_control_session", guard)
        self.assertIn("control_session_ready_for_estop_reset", guard)

        reset_start = bridge.index("void reset_software_estop(")
        reset_end = bridge.index("void begin_direct_emergency_stop()", reset_start)
        reset_body = bridge[reset_start:reset_end]
        self.assertLess(
            reset_body.index("control_session_ready_for_estop_reset"),
            reset_body.index("cmd_vel_arbiter_->set_estop(false)"),
        )

        callback_start = bridge.index("[this, action, client_id](bool success")
        callback_end = bridge.index('if (action == "heartbeat")', callback_start)
        acquire_callback_prelude = bridge[callback_start:callback_end]
        self.assertIn(
            "restart_direct_emergency_stop_for_control_session",
            acquire_callback_prelude,
        )
        self.assertNotIn("publish_arbiter_output", acquire_callback_prelude)
        self.assertNotIn("adapter_->", acquire_callback_prelude)

        request_start = bridge.index("adapter_->request_control(", callback_start - 100)
        initial_session_refresh = bridge.index(
            'if (action == "acquire" && restart_direct_emergency_stop_for_control_session())',
            request_start,
        )
        self.assertLess(request_start, initial_session_refresh)
        self.assertLess(
            initial_session_refresh,
            bridge.index("publish_arbiter_output();", initial_session_refresh),
        )

        actuator_gate_start = bridge.index("bool actuator_command_is_authorized(")
        locomotion_start = bridge.index("void request_locomotion(", actuator_gate_start)
        locomotion_end = bridge.index("void request_posture(", locomotion_start)
        posture_end = bridge.index("void start_mapping()", locomotion_end)
        self.assertIn("cmd_vel_arbiter_->estop_latched()", bridge[locomotion_start:locomotion_end])
        self.assertIn("cmd_vel_arbiter_->estop_latched()", bridge[locomotion_end:posture_end])

        publish_start = bridge.index("void publish_arbiter_output()")
        publish_end = bridge.index("void publish(", publish_start)
        publish_body = bridge[publish_start:publish_end]
        self.assertLess(
            publish_body.index("cmd_vel_output_->publish(output)"),
            publish_body.index("service_direct_emergency_stop_retry(now)"),
        )

    def test_vbot_emergency_stop_survives_gateway_latch_merge(self):
        bridge = _source("src/bridge_node.cpp")
        vbot = _source("src/vbot_adapter.cpp")
        posture_start = bridge.index("void request_posture(std::string wire_command)")
        posture_end = bridge.index("void start_mapping()", posture_start)
        posture = bridge[posture_start:posture_end]

        self.assertIn(
            'command != "stand" && command != "lie_down" && '
            'command != "emergency_stop"',
            posture,
        )
        latch_call = posture.index("cmd_vel_arbiter_->estop_latched()")
        latch_gate_start = posture.rfind("if (", 0, latch_call)
        latch_gate_end = posture.index("{", latch_call)
        latch_gate = posture[latch_gate_start:latch_gate_end]
        self.assertIn('command != "emergency_stop"', latch_gate)
        self.assertRegex(
            vbot,
            r'command\s*==\s*"emergency_stop"\s*\?\s*4\s*:\s*0',
        )

    def test_sdk_owner_lock_override_must_be_absolute(self):
        lock = _source("include/rosdeck_robot_bridge/sdk_owner_lock.hpp")
        self.assertIn("path.empty() || path.front() != '/'", lock)
        self.assertIn('"SDK lock path must be absolute"', lock)

    def test_arbiter_status_has_bounded_monotonic_heartbeat(self):
        bridge = _source("src/bridge_node.cpp")
        config = _source("config/zsibot.yaml")
        self.assertIn(
            '"cmd_vel_arbiter.status_period_ms", 1000, 100, 1000', bridge
        )
        self.assertIn('";status_seq=" + std::to_string', bridge)
        self.assertIn("++arbiter_status_sequence_", bridge)
        self.assertIn("cmd_vel_arbiter.status_period_ms: 1000", config)

    def test_product_adapter_request_fails_if_binary_support_is_missing(self):
        bridge = _source("src/bridge_node.cpp")
        helper = _source("include/rosdeck_robot_bridge/adapter_observability.hpp")
        self.assertIn("adapter_selection_error(adapter_name, build_support)", bridge)
        self.assertIn("requested_vbot_adapter_not_built", helper)
        self.assertIn("requested_zsibot_adapter_not_built", helper)
        self.assertIn('adapter_name == "unavailable"', bridge)

    def test_supervisor_deadline_cannot_be_relaxed_past_500ms(self):
        supervisor = _source("src/safety_supervisor_node.cpp")
        self.assertIn("requested_heartbeat_deadline > 500", supervisor)
        self.assertIn("must be at least two output periods", supervisor)

    def test_both_product_configs_declare_observability_topics(self):
        for config in ("config/zsibot.yaml", "config/vbot.yaml"):
            with self.subTest(config=config):
                source = _source(config)
                self.assertIn("adapter_status.topics.battery: /battery_state", source)
                self.assertIn("adapter_status.topics.diagnostics: /diagnostics", source)
                self.assertIn(
                    "adapter_status.topics.summary: /omni/robot/adapter_status", source
                )


if __name__ == "__main__":
    unittest.main()

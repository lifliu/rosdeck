from pathlib import Path
import ast
import os
import subprocess
import tempfile
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PRODUCT_LAUNCH = PACKAGE_ROOT / "launch" / "product_bringup.launch.py"
BRIDGE_LAUNCH = PACKAGE_ROOT / "launch" / "bridge.launch.py"
LEGACY_GUARD = PACKAGE_ROOT / "scripts" / "assert-no-legacy-zsibot-owner.sh"
PRODUCT_HEALTH = PACKAGE_ROOT / "scripts" / "assert-product-bringup-health.sh"


def _source(path):
    return path.read_text(encoding="utf-8")


def _write_executable(path, source):
    path.write_text(source, encoding="utf-8")
    path.chmod(0o755)


def _load_docking_contract(package_lookup):
    """Execute the real launch validation function without requiring ROS locally."""

    tree = ast.parse(_source(PRODUCT_LAUNCH), filename=str(PRODUCT_LAUNCH))
    selected = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in ("_as_bool", "_launch_optional_docking")
    ]

    class FakePackageNotFoundError(Exception):
        pass

    class FakeLaunchConfiguration:
        def __init__(self, name):
            self.name = name

        def perform(self, context):
            return context[self.name]

    class FakeAction:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

    namespace = {
        "os": os,
        "PackageNotFoundError": FakePackageNotFoundError,
        "get_package_prefix": package_lookup,
        "LaunchConfiguration": FakeLaunchConfiguration,
        "GroupAction": type("GroupAction", (FakeAction,), {}),
        "Node": type("Node", (FakeAction,), {}),
        "SetRemap": type("SetRemap", (FakeAction,), {}),
        "Shutdown": type("Shutdown", (FakeAction,), {}),
        "DOCKING_INPUT_TOPIC": "/omni/cmd_vel/docking",
    }
    isolated_module = ast.Module(body=selected, type_ignores=[])
    exec(compile(isolated_module, str(PRODUCT_LAUNCH), "exec"), namespace)
    return namespace, FakePackageNotFoundError


class ProductBringupStaticTest(unittest.TestCase):
    def test_python_launch_files_parse(self):
        ast.parse(_source(PRODUCT_LAUNCH), filename=str(PRODUCT_LAUNCH))
        ast.parse(_source(BRIDGE_LAUNCH), filename=str(BRIDGE_LAUNCH))

    def test_product_bringup_defaults_to_safety_supervisor(self):
        product = _source(PRODUCT_LAUNCH)
        bridge = _source(BRIDGE_LAUNCH)

        self.assertIn(
            'DeclareLaunchArgument("enable_safety_supervisor", default_value="true")',
            product,
        )
        self.assertIn('"enable_safety_supervisor": enable_safety_supervisor', product)
        self.assertIn("rosdeck_safety_supervisor_node", bridge)
        self.assertIn("rosdeck_robot_bridge_node", bridge)
        self.assertNotIn("respawn=True", bridge)
        self.assertEqual(bridge.count("on_exit=Shutdown"), 2)

        unit = _source(
            PACKAGE_ROOT / "systemd" / "rosdeck-robot-bridge.service.in"
        )
        self.assertIn("Restart=always", unit)
        self.assertNotIn("Restart=on-failure", unit)

    def test_units_run_hardened_non_root(self):
        for unit_name in (
            "rosdeck-robot-bridge.service.in",
            "omni-mission-manager.service.in",
            "rosdeck-foxglove-bridge.service.in",
        ):
            with self.subTest(unit=unit_name):
                unit = _source(PACKAGE_ROOT / "systemd" / unit_name)
                self.assertIn("User=rosdeck", unit)
                self.assertIn("Group=rosdeck", unit)
                self.assertNotIn("User=root", unit)
                self.assertIn("NoNewPrivileges=yes", unit)
                self.assertIn("ProtectSystem=strict", unit)
                self.assertIn("RestrictAddressFamilies=", unit)
                self.assertIn("Restart=always", unit)

        bridge = _source(
            PACKAGE_ROOT / "systemd" / "rosdeck-robot-bridge.service.in"
        )
        self.assertIn("RuntimeDirectory=lock/omni", bridge)
        self.assertIn("@VBOT_ONLY@ReadWritePaths=/userdata", bridge)
        self.assertIn("MemoryMax=4G", bridge)
        # Motion-loop cgroup: deliberately no CPU cap (see unit comment).
        self.assertNotIn("CPUQuota=", bridge)

        manager = _source(
            PACKAGE_ROOT / "systemd" / "omni-mission-manager.service.in"
        )
        self.assertIn("StateDirectory=omni", manager)
        self.assertIn(
            "ExecStartPre=+mkdir -p /var/lib/omni/routes "
            "/var/lib/omni/mission_manager",
            manager,
        )
        self.assertIn("CapabilityBoundingSet=", manager)
        self.assertIn("CPUQuota=200%", manager)

    def test_deployers_prepare_non_root_service_account(self):
        # Both deploy paths (in-place deploy.sh and the A/B core used by
        # deploy-prebuilt.sh / ota.sh) must create the dedicated account,
        # own the mission-manager state, and render the profile-conditional
        # @VBOT_ONLY@ unit directives.
        for deployer in ("deploy.sh", "deploy-core.sh"):
            with self.subTest(deployer=deployer):
                source = _source(PACKAGE_ROOT / "scripts" / deployer)
                self.assertIn("groupadd --system rosdeck", source)
                self.assertIn("useradd --system --gid rosdeck", source)
                self.assertIn("chown -R rosdeck:rosdeck /var/lib/omni", source)
                self.assertIn("s#@VBOT_ONLY@#", source)

        core = _source(PACKAGE_ROOT / "scripts" / "deploy-core.sh")
        self.assertIn("rosdeck_user_prepare", core)
        self.assertIn("ROSDECK_SKIP_USER_PREPARE", core)

    def test_docking_output_is_scoped_to_gateway_input(self):
        product = _source(PRODUCT_LAUNCH)

        self.assertIn('DOCKING_INPUT_TOPIC = "/omni/cmd_vel/docking"', product)
        self.assertIn("SetRemap(src=cmd_vel_source, dst=DOCKING_INPUT_TOPIC)", product)
        self.assertIn(
            'DeclareLaunchArgument("use_opennav_docking", default_value="false")',
            product,
        )
        self.assertIn(
            'DeclareLaunchArgument("docking_cmd_vel_source", default_value="cmd_vel")',
            product,
        )
        self.assertIn('package="opennav_docking"', product)
        self.assertIn('package="nav2_lifecycle_manager"', product)

    def test_docking_enablement_requires_real_absolute_params_and_relative_source(self):
        product = _source(PRODUCT_LAUNCH)

        self.assertIn("if not params_file:", product)
        self.assertIn("if not os.path.isabs(params_file):", product)
        self.assertIn("if not os.path.isfile(params_file):", product)
        self.assertIn('cmd_vel_source.startswith("/")', product)
        self.assertIn('(\"opennav_docking\", \"opennav_docking\")', product)
        self.assertIn('(\"nav2_lifecycle_manager\", \"lifecycle_manager\")', product)
        self.assertIn("get_package_prefix(required_package)", product)
        self.assertIn("os.access(executable_path, os.X_OK)", product)

    def test_boolean_launch_arguments_are_strict(self):
        product = _source(PRODUCT_LAUNCH)

        self.assertIn('if normalized in ("0", "false", "no", "off"):', product)
        self.assertIn("must be a boolean, got:", product)

        contract, _ = _load_docking_contract(lambda _: "/unused")
        self.assertTrue(contract["_as_bool"]("YES", "value"))
        self.assertFalse(contract["_as_bool"]("off", "value"))
        with self.assertRaisesRegex(RuntimeError, "must be a boolean"):
            contract["_as_bool"]("ture", "value")

    def test_docking_contract_builds_real_scoped_remap(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            params = root / "docking.yaml"
            params.write_text("/**:\n  ros__parameters: {}\n", encoding="utf-8")
            executables = {
                "opennav_docking": "opennav_docking",
                "nav2_lifecycle_manager": "lifecycle_manager",
            }
            for package, executable in executables.items():
                path = root / "lib" / package / executable
                path.parent.mkdir(parents=True)
                path.write_text("#!/bin/sh\n", encoding="utf-8")
                path.chmod(0o755)

            contract, _ = _load_docking_contract(lambda _: str(root))
            actions = contract["_launch_optional_docking"](
                {
                    "use_opennav_docking": "true",
                    "docking_params_file": str(params),
                    "docking_cmd_vel_source": "cmd_vel",
                    "use_sim_time": "false",
                    "docking_autostart": "true",
                }
            )

            self.assertEqual(1, len(actions))
            scoped_actions = actions[0].kwargs["actions"]
            self.assertEqual("cmd_vel", scoped_actions[0].kwargs["src"])
            self.assertEqual(
                "/omni/cmd_vel/docking", scoped_actions[0].kwargs["dst"]
            )
            self.assertEqual("opennav_docking", scoped_actions[1].kwargs["package"])
            self.assertEqual("opennav_docking", scoped_actions[1].kwargs["executable"])
            self.assertIsInstance(scoped_actions[1].kwargs["on_exit"], contract["Shutdown"])
            self.assertEqual(
                "nav2_lifecycle_manager", scoped_actions[2].kwargs["package"]
            )
            self.assertEqual("lifecycle_manager", scoped_actions[2].kwargs["executable"])
            self.assertIsInstance(scoped_actions[2].kwargs["on_exit"], contract["Shutdown"])

    def test_docking_contract_rejects_absolute_source_topic(self):
        with tempfile.NamedTemporaryFile(suffix=".yaml") as params:
            contract, _ = _load_docking_contract(lambda _: "/unused")
            with self.assertRaisesRegex(RuntimeError, "relative OpenNav output"):
                contract["_launch_optional_docking"](
                    {
                        "use_opennav_docking": "true",
                        "docking_params_file": params.name,
                        "docking_cmd_vel_source": "/cmd_vel",
                        "use_sim_time": "false",
                        "docking_autostart": "true",
                    }
                )

    def test_runtime_templates_use_product_bringup(self):
        for template in ("run-bridge.in", "run-prebuilt.in"):
            with self.subTest(template=template):
                source = _source(PACKAGE_ROOT / "scripts" / template)
                self.assertIn(
                    "ros2 launch rosdeck_robot_bridge product_bringup.launch.py",
                    source,
                )
                self.assertIn("bridge_node_name:=@NODE_NAME@", source)
                self.assertNotIn("rosdeck_robot_bridge_node --ros-args", source)
                self.assertIn("assert-no-legacy-zsibot-owner.sh", source)
                self.assertIn('if [[ "${PROFILE}" == "zsibot" ]]', source)
                self.assertIn('PROFILE="@PROFILE@"', source)
                self.assertIn("enable_safety_supervisor:", source)

        # The in-place deployer still renders the glue itself; the A/B front
        # ends (deploy-prebuilt.sh, ota.sh) delegate to the shared core,
        # which renders @PROFILE@ and the A/B @CURRENT@ slot path.
        deploy = _source(PACKAGE_ROOT / "scripts" / "deploy.sh")
        core = _source(PACKAGE_ROOT / "scripts" / "deploy-core.sh")
        self.assertIn('s#@PROFILE@#${PROFILE}#g', deploy)
        self.assertIn('-e "s#@PROFILE@#${profile}#g"', core)
        self.assertIn('s#@CURRENT@#${prefix}/current#', core)
        for front_end in ("deploy-prebuilt.sh", "ota.sh"):
            with self.subTest(front_end=front_end):
                self.assertIn(
                    "rosdeck_install_bundle",
                    _source(PACKAGE_ROOT / "scripts" / front_end),
                )

    def test_deployment_requires_continuous_in_cgroup_product_health(self):
        health = _source(PRODUCT_HEALTH)
        self.assertIn("STABLE_SAMPLES", health)
        self.assertIn("systemctl show --property=MainPID", health)
        self.assertIn("systemd-cgls --no-pager -l", health)
        self.assertIn("rosdeck_robot_bridge_node", health)
        self.assertIn("rosdeck_safety_supervisor_node", health)
        self.assertIn("heartbeat_seq=", health)
        self.assertIn("sequence_second <= sequence_first", health)
        self.assertIn("estop_monitor_fault=false", health)
        self.assertIn('if [[ "${PROFILE}" == "zsibot" ]]', health)

        # The in-place deployer runs the probe inline; the A/B front ends go
        # through rosdeck_install_bundle in the shared core, which runs the
        # same probe against the active release slot.
        for deploy_name in ("deploy.sh", "deploy-core.sh"):
            with self.subTest(deployer=deploy_name):
                deploy = _source(PACKAGE_ROOT / "scripts" / deploy_name)
                self.assertIn("assert-product-bringup-health.sh", deploy)
                self.assertIn("timeout 50 bash -c", deploy)
                self.assertNotIn("for expected_node in", deploy)

    def test_product_health_probe_checks_live_zsibot_epoch_and_keeps_vbot_compatible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            sequence_file = root / "sequence"
            _write_executable(
                fake_bin / "systemctl",
                "#!/bin/bash\n"
                "case \"$*\" in\n"
                "  *MainPID*) echo 4242 ;;\n"
                "  *ControlGroup*) echo /system.slice/rosdeck.service ;;\n"
                "  *is-active*) exit 0 ;;\n"
                "  *) exit 1 ;;\n"
                "esac\n",
            )
            _write_executable(
                fake_bin / "systemd-cgls",
                "#!/bin/bash\n"
                "echo '4243 /runtime/rosdeck_robot_bridge_node'\n"
                "if [[ \"${FAKE_PROFILE:-zsibot}\" == zsibot ]]; then\n"
                "  echo '4244 /runtime/rosdeck_safety_supervisor_node'\n"
                "fi\n",
            )
            _write_executable(
                fake_bin / "ros2",
                "#!/bin/bash\n"
                "if [[ \"$1 $2\" == 'node list' ]]; then\n"
                "  echo /gateway\n"
                "  [[ \"${FAKE_PROFILE:-zsibot}\" == zsibot ]] && "
                "echo /rosdeck_safety_supervisor\n"
                "elif [[ \"$1 $2\" == 'topic echo' ]]; then\n"
                "  if [[ \"$3\" == /omni/safety/supervisor_status ]]; then\n"
                "    sequence=1\n"
                "    if [[ \"${FAKE_FREEZE:-0}\" != 1 ]]; then\n"
                "      sequence=$(($(cat \"${FAKE_SEQUENCE_FILE}\" 2>/dev/null || echo 0) + 1))\n"
                "      echo \"${sequence}\" > \"${FAKE_SEQUENCE_FILE}\"\n"
                "    fi\n"
                "    echo \"data: state=latched;output_estop=true;heartbeat_fresh=true;heartbeat_seq=${sequence}\"\n"
                "  else\n"
                "    echo 'data: selected=none;estop=true;estop_monitor_fault=false'\n"
                "  fi\n"
                "else\n"
                "  exit 1\n"
                "fi\n",
            )
            _write_executable(
                fake_bin / "timeout",
                "#!/bin/bash\nshift\nexec \"$@\"\n",
            )
            _write_executable(fake_bin / "sleep", "#!/bin/bash\nexit 0\n")

            base_environment = {
                **os.environ,
                "PATH": f"{fake_bin}:/usr/bin:/bin",
                "PRODUCT_HEALTH_STABLE_SAMPLES": "2",
                "PRODUCT_HEALTH_MAX_ATTEMPTS": "3",
                "FAKE_SEQUENCE_FILE": str(sequence_file),
            }
            for profile in ("zsibot", "vbot"):
                with self.subTest(profile=profile):
                    environment = {**base_environment, "FAKE_PROFILE": profile}
                    result = subprocess.run(
                        ["/bin/bash", str(PRODUCT_HEALTH), profile, "/gateway"],
                        env=environment,
                        check=False,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                    )
                    self.assertEqual(0, result.returncode, result.stderr)

            frozen = subprocess.run(
                ["/bin/bash", str(PRODUCT_HEALTH), "zsibot", "/gateway"],
                env={
                    **base_environment,
                    "FAKE_PROFILE": "zsibot",
                    "FAKE_FREEZE": "1",
                },
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertEqual(9, frozen.returncode)
            self.assertIn("heartbeat sequence is not advancing", frozen.stderr)

    def test_legacy_process_guard_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            fake_pgrep = Path(directory) / "pgrep"
            fake_pgrep.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"${FAKE_PGREP_OUTPUT:-}\"\n"
                "exit \"${FAKE_PGREP_STATUS:-1}\"\n",
                encoding="utf-8",
            )
            fake_pgrep.chmod(0o755)
            environment = os.environ.copy()
            environment["PATH"] = f"{directory}:/usr/bin:/bin"

            for status, expected in (("1", 0), ("0", 4), ("2", 5)):
                with self.subTest(pgrep_status=status):
                    environment["FAKE_PGREP_STATUS"] = status
                    environment["FAKE_PGREP_OUTPUT"] = "fake process result"
                    result = subprocess.run(
                        ["/bin/bash", str(LEGACY_GUARD), "--processes-only"],
                        env=environment,
                        check=False,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                    )
                    self.assertEqual(expected, result.returncode, result.stderr)

    def test_legacy_artifact_guard_rejects_stale_sdk_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            stale = (
                Path(directory)
                / "lib"
                / "zsibot_cmd_bridge"
                / "zsibot_sdk_proxy"
            )
            stale.parent.mkdir(parents=True)
            stale.touch()
            result = subprocess.run(
                [
                    "/bin/bash",
                    str(LEGACY_GUARD),
                    "--artifacts-only",
                    directory,
                ],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertEqual(3, result.returncode, result.stderr)


if __name__ == "__main__":
    unittest.main()

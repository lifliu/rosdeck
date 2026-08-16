from pathlib import Path
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SUPERVISOR_NODE = PACKAGE_ROOT / "src" / "safety_supervisor_node.cpp"


class SafetySupervisorLockContractStaticTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SUPERVISOR_NODE.read_text(encoding="utf-8")

    def test_uses_canonical_host_wide_lock(self):
        self.assertIn(
            '"/run/lock/omni/safety_supervisor.lock"', self.source
        )
        self.assertIn("ensure_lock_directory(path_)", self.source)

    def test_override_parent_must_be_protected(self):
        self.assertIn("path.front() != '/'", self.source)
        self.assertIn("::lstat(directory.c_str(), &status)", self.source)
        self.assertIn("status.st_uid != ::geteuid()", self.source)
        self.assertIn("(status.st_mode & 0022) != 0", self.source)
        self.assertLess(
            self.source.index("ensure_lock_directory(path_)"),
            self.source.index("::open(path_.c_str()"),
        )

    def test_lock_file_rejects_symlinks_links_and_unsafe_modes(self):
        self.assertIn("O_NOFOLLOW", self.source)
        self.assertIn("::fstat(fd_, &status)", self.source)
        self.assertIn("status.st_nlink != 1", self.source)
        self.assertIn("(status.st_mode & 0022) != 0", self.source)

    def test_short_identity_write_reports_io_error(self):
        self.assertIn("written < 0 ? errno : EIO", self.source)

    def test_estop_output_is_canonical_reliable_bool_heartbeat(self):
        self.assertIn('constexpr char kEstopOutputTopic[] = "/omni/safety/estop"', self.source)
        self.assertIn("create_publisher<std_msgs::msg::Bool>", self.source)
        self.assertIn(".reliable().durability_volatile()", self.source)
        self.assertIn("create_wall_timer(output_period_", self.source)

    def test_supervisor_cannot_reset_the_bridge(self):
        self.assertNotIn("create_client<", self.source)


if __name__ == "__main__":
    unittest.main()

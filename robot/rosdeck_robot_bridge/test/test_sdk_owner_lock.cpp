#include "rosdeck_robot_bridge/sdk_owner_lock.hpp"

#include <cstdlib>
#include <stdexcept>

#include <gtest/gtest.h>
#include <sys/wait.h>
#include <unistd.h>

TEST(SdkOwnerLock, RejectsRelativeOverridePath)
{
  EXPECT_THROW(
    rosdeck_robot_bridge::ensure_sdk_lock_directory("relative/owner.lock"),
    std::runtime_error);
}

TEST(SdkOwnerLock, RejectsSecondProcessUntilFirstReleases)
{
  char directory[] = "/tmp/rosdeck_sdk_owner_lock_test_XXXXXX";
  ASSERT_NE(::mkdtemp(directory), nullptr);
  const std::string path = std::string(directory) + "/owner.lock";
  ASSERT_EQ(::setenv("OMNI_ZSIBOT_SDK_OWNER_LOCK", path.c_str(), 1), 0);

  int to_child[2]{};
  int from_child[2]{};
  ASSERT_EQ(::pipe(to_child), 0);
  ASSERT_EQ(::pipe(from_child), 0);
  const pid_t child = ::fork();
  ASSERT_GE(child, 0);
  if (child == 0) {
    ::close(to_child[1]);
    ::close(from_child[0]);
    char signal = 0;
    if (::read(to_child[0], &signal, 1) != 1) {
      ::_exit(10);
    }
    bool rejected = false;
    try {
      rosdeck_robot_bridge::SdkOwnerLock competing("test_child_competing");
    } catch (const std::runtime_error &) {
      rejected = true;
    }
    char result = rejected ? '1' : '0';
    if (::write(from_child[1], &result, 1) != 1) {
      ::_exit(11);
    }
    if (::read(to_child[0], &signal, 1) != 1) {
      ::_exit(12);
    }
    bool acquired = false;
    try {
      rosdeck_robot_bridge::SdkOwnerLock after_release("test_child_after_release");
      acquired = true;
    } catch (const std::runtime_error &) {
    }
    result = acquired ? '1' : '0';
    if (::write(from_child[1], &result, 1) != 1) {
      ::_exit(13);
    }
    ::_exit(0);
  }

  ::close(to_child[0]);
  ::close(from_child[1]);
  char result = 0;
  {
    rosdeck_robot_bridge::SdkOwnerLock first("test_first");
    ASSERT_EQ(::write(to_child[1], "A", 1), 1);
    ASSERT_EQ(::read(from_child[0], &result, 1), 1);
    EXPECT_EQ(result, '1');
  }
  ASSERT_EQ(::write(to_child[1], "B", 1), 1);
  ASSERT_EQ(::read(from_child[0], &result, 1), 1);
  EXPECT_EQ(result, '1');

  int child_status = 0;
  ASSERT_EQ(::waitpid(child, &child_status, 0), child);
  EXPECT_TRUE(WIFEXITED(child_status));
  EXPECT_EQ(WEXITSTATUS(child_status), 0);
  ::close(to_child[1]);
  ::close(from_child[0]);

  ::unsetenv("OMNI_ZSIBOT_SDK_OWNER_LOCK");
  ::unlink(path.c_str());
  ::rmdir(directory);
}

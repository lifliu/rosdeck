#pragma once

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

namespace rosdeck_robot_bridge
{

inline std::string sdk_owner_lock_path()
{
  const char * configured = std::getenv("OMNI_ZSIBOT_SDK_OWNER_LOCK");
  return configured && configured[0] != '\0' ? configured :
         "/run/lock/omni/zsibot_sdk_owner.lock";
}

inline void ensure_sdk_lock_directory(const std::string & path)
{
  if (path.empty() || path.front() != '/') {
    throw std::runtime_error("SDK lock path must be absolute");
  }
  const auto separator = path.find_last_of('/');
  if (separator == std::string::npos || separator == 0) {
    throw std::runtime_error("SDK lock path must be inside a protected directory");
  }
  const std::string directory = path.substr(0, separator);
  if (path == "/run/lock/omni/zsibot_sdk_owner.lock" &&
    ::mkdir(directory.c_str(), 0750) != 0 && errno != EEXIST)
  {
    throw std::runtime_error(
            std::string("cannot create SDK lock directory: ") + std::strerror(errno));
  }
  struct stat status {};
  if (::lstat(directory.c_str(), &status) != 0 || !S_ISDIR(status.st_mode) ||
    status.st_uid != ::geteuid() || (status.st_mode & 0022) != 0)
  {
    throw std::runtime_error("SDK lock directory is not a protected owner-controlled directory");
  }
}

/** Holds the host-wide exclusive vendor-SDK ownership lock. */
class SdkOwnerLock
{
public:
  explicit SdkOwnerLock(const std::string & owner)
  : path_(sdk_owner_lock_path())
  {
    ensure_sdk_lock_directory(path_);
    fd_ = ::open(path_.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0640);
    if (fd_ < 0) {
      throw std::runtime_error(
              "cannot open ZsiBot SDK owner lock " + path_ + ": " + std::strerror(errno));
    }
    if (::flock(fd_, LOCK_EX | LOCK_NB) != 0) {
      const int error = errno;
      ::close(fd_);
      fd_ = -1;
      throw std::runtime_error(
              "another ZsiBot SDK owner already holds " + path_ + ": " +
              std::strerror(error));
    }
    struct stat status {};
    if (::fstat(fd_, &status) != 0 || !S_ISREG(status.st_mode) ||
      status.st_uid != ::geteuid() || status.st_nlink != 1 ||
      (status.st_mode & 0022) != 0)
    {
      (void)::flock(fd_, LOCK_UN);
      ::close(fd_);
      fd_ = -1;
      throw std::runtime_error("ZsiBot SDK owner lock is not a safe owner-controlled file");
    }
    const std::string identity = owner + " pid=" + std::to_string(::getpid()) + "\n";
    if (::ftruncate(fd_, 0) != 0) {
      const int error = errno;
      (void)::flock(fd_, LOCK_UN);
      ::close(fd_);
      fd_ = -1;
      throw std::runtime_error(
              "cannot record ZsiBot SDK lock owner: " + std::string(std::strerror(error)));
    }
    const ssize_t written = ::write(fd_, identity.data(), identity.size());
    if (written != static_cast<ssize_t>(identity.size())) {
      const int error = written < 0 ? errno : EIO;
      (void)::flock(fd_, LOCK_UN);
      ::close(fd_);
      fd_ = -1;
      throw std::runtime_error(
              "cannot record ZsiBot SDK lock owner: " + std::string(std::strerror(error)));
    }
  }

  SdkOwnerLock(const SdkOwnerLock &) = delete;
  SdkOwnerLock & operator=(const SdkOwnerLock &) = delete;

  ~SdkOwnerLock()
  {
    if (fd_ >= 0) {
      (void)::flock(fd_, LOCK_UN);
      (void)::close(fd_);
    }
  }

private:
  std::string path_;
  int fd_{-1};
};

}  // namespace rosdeck_robot_bridge

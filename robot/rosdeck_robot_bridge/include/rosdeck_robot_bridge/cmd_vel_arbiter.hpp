#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <string_view>

namespace rosdeck_robot_bridge
{
namespace cmd_vel_arbiter
{

using SteadyClock = std::chrono::steady_clock;
using SteadyTime = SteadyClock::time_point;
inline constexpr char kFinalTopic[] = "/omni/cmd_vel/final";

enum class Source
{
  none,
  navigation,
  docking,
  teleop,
};

enum class OwnerKind
{
  none,
  app,
  mission,
  docking,
  unknown,
};

enum class SourceHealth
{
  never_received,
  ready,
  timeout,
  invalid_non_finite,
  publisher_conflict,
  invalid_stamp,
  stale_stamp,
  future_stamp,
};

enum class DecisionReason
{
  selected,
  estop_latched,
  no_control_owner,
  unknown_control_owner,
  no_fresh_authorized_source,
};

struct RawTwist
{
  double linear_x{0.0};
  double linear_y{0.0};
  double linear_z{0.0};
  double angular_x{0.0};
  double angular_y{0.0};
  double angular_z{0.0};
};

struct Command
{
  double vx{0.0};
  double vy{0.0};
  double yaw{0.0};
};

struct Config
{
  std::chrono::milliseconds teleop_timeout{250};
  std::chrono::milliseconds docking_timeout{250};
  std::chrono::milliseconds navigation_timeout{250};
  std::chrono::milliseconds stamped_max_age{1000};
  std::chrono::milliseconds stamped_future_tolerance{500};
  bool enforce_stamp_freshness{false};
};

struct Decision
{
  Command command;
  Source source{Source::none};
  OwnerKind owner{OwnerKind::none};
  DecisionReason reason{DecisionReason::no_control_owner};
};

constexpr int source_priority(Source source)
{
  switch (source) {
    case Source::teleop:
      return 30;
    case Source::docking:
      return 20;
    case Source::navigation:
      return 10;
    case Source::none:
      return 0;
  }
  return 0;
}

constexpr Source select_highest_priority_source(
  bool teleop_available, bool docking_available, bool navigation_available)
{
  return teleop_available ? Source::teleop :
         docking_available ? Source::docking :
         navigation_available ? Source::navigation : Source::none;
}

static_assert(source_priority(Source::teleop) > source_priority(Source::docking));
static_assert(source_priority(Source::docking) > source_priority(Source::navigation));
static_assert(select_highest_priority_source(true, true, true) == Source::teleop);

inline bool has_prefix(std::string_view value, std::string_view prefix)
{
  return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

inline OwnerKind parse_owner_kind(std::string_view control_status)
{
  constexpr std::string_view acquired_prefix = "acquired:";
  if (!has_prefix(control_status, acquired_prefix)) {
    return OwnerKind::none;
  }

  const auto owner = control_status.substr(acquired_prefix.size());
  if (has_prefix(owner, "app-")) {
    return OwnerKind::app;
  }
  if (has_prefix(owner, "mission-")) {
    return OwnerKind::mission;
  }
  if (has_prefix(owner, "docking-")) {
    return OwnerKind::docking;
  }
  return OwnerKind::unknown;
}

constexpr bool owner_allows(OwnerKind owner, Source source)
{
  return (owner == OwnerKind::app && source == Source::teleop) ||
         (owner == OwnerKind::mission && source == Source::navigation) ||
         (owner == OwnerKind::docking && source == Source::docking);
}

inline bool finite(const RawTwist & twist)
{
  return std::isfinite(twist.linear_x) && std::isfinite(twist.linear_y) &&
         std::isfinite(twist.linear_z) && std::isfinite(twist.angular_x) &&
         std::isfinite(twist.angular_y) && std::isfinite(twist.angular_z);
}

inline const char * source_name(Source source)
{
  switch (source) {
    case Source::teleop:
      return "teleop";
    case Source::docking:
      return "docking";
    case Source::navigation:
      return "navigation";
    case Source::none:
      return "none";
  }
  return "none";
}

inline const char * owner_name(OwnerKind owner)
{
  switch (owner) {
    case OwnerKind::app:
      return "app";
    case OwnerKind::mission:
      return "mission";
    case OwnerKind::docking:
      return "docking";
    case OwnerKind::unknown:
      return "unknown";
    case OwnerKind::none:
      return "none";
  }
  return "none";
}

inline const char * health_name(SourceHealth health)
{
  switch (health) {
    case SourceHealth::never_received:
      return "never";
    case SourceHealth::ready:
      return "fresh";
    case SourceHealth::timeout:
      return "timeout";
    case SourceHealth::invalid_non_finite:
      return "invalid_non_finite";
    case SourceHealth::publisher_conflict:
      return "publisher_conflict";
    case SourceHealth::invalid_stamp:
      return "invalid_stamp";
    case SourceHealth::stale_stamp:
      return "stale_stamp";
    case SourceHealth::future_stamp:
      return "future_stamp";
  }
  return "unknown";
}

inline const char * reason_name(DecisionReason reason)
{
  switch (reason) {
    case DecisionReason::selected:
      return "selected";
    case DecisionReason::estop_latched:
      return "estop_latched";
    case DecisionReason::no_control_owner:
      return "no_control_owner";
    case DecisionReason::unknown_control_owner:
      return "unknown_control_owner";
    case DecisionReason::no_fresh_authorized_source:
      return "no_fresh_authorized_source";
  }
  return "unknown";
}

class Arbiter
{
public:
  explicit Arbiter(Config config = {})
  : config_(config) {}

  SourceHealth ingest_stamped(
    Source source, const RawTwist & twist, int64_t stamp_ns, int64_t ros_now_ns,
    SteadyTime received_at)
  {
    auto & state = state_for(source);
    if (source != Source::teleop && source != Source::docking) {
      return invalidate(state, SourceHealth::invalid_stamp);
    }
    if (!finite(twist)) {
      return invalidate(state, SourceHealth::invalid_non_finite);
    }
    if (stamp_ns <= 0 || ros_now_ns <= 0) {
      state.last_stamp_health = SourceHealth::invalid_stamp;
      ++state.stamp_rejections;
      return invalidate(state, SourceHealth::invalid_stamp);
    }

    const int64_t age_ns = ros_now_ns - stamp_ns;
    const int64_t max_age_ns =
      std::chrono::duration_cast<std::chrono::nanoseconds>(config_.stamped_max_age).count();
    const int64_t future_tolerance_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
      config_.stamped_future_tolerance).count();
    state.last_stamp_skew_ms = age_ns / 1'000'000LL;
    SourceHealth stamp_health = SourceHealth::ready;
    if (age_ns >= max_age_ns) {
      stamp_health = SourceHealth::stale_stamp;
    } else if (age_ns < -future_tolerance_ns) {
      stamp_health = SourceHealth::future_stamp;
    }
    state.last_stamp_health = stamp_health;
    if (stamp_health != SourceHealth::ready) {
      ++state.stamp_skew_events;
      if (config_.enforce_stamp_freshness) {
        ++state.stamp_rejections;
        return invalidate(state, stamp_health);
      }
    }

    const auto receipt_lifetime = std::chrono::duration_cast<std::chrono::nanoseconds>(
      timeout_for(source));
    auto lifetime = receipt_lifetime;
    if (config_.enforce_stamp_freshness) {
      const int64_t consumed_stamp_age_ns = std::max<int64_t>(0, age_ns);
      const auto stamp_lifetime = std::chrono::nanoseconds(max_age_ns - consumed_stamp_age_ns);
      lifetime = std::min(stamp_lifetime, receipt_lifetime);
    }
    accept(state, twist, received_at + lifetime);
    return SourceHealth::ready;
  }

  SourceHealth ingest_navigation(const RawTwist & twist, SteadyTime received_at)
  {
    return ingest_unstamped(Source::navigation, twist, received_at);
  }

  SourceHealth ingest_unstamped(
    Source source, const RawTwist & twist, SteadyTime received_at)
  {
    auto & state = state_for(source);
    if (source != Source::navigation && source != Source::docking) {
      return invalidate(state, SourceHealth::invalid_stamp);
    }
    if (!finite(twist)) {
      return invalidate(state, SourceHealth::invalid_non_finite);
    }
    accept(state, twist, received_at + timeout_for(source));
    return SourceHealth::ready;
  }

  void set_estop(bool active)
  {
    if (estop_latched_ == active) {
      return;
    }
    estop_latched_ = active;
    // Never resume a command that arrived before an emergency-stop transition.
    clear_sources();
  }

  bool estop_latched() const {return estop_latched_;}
  bool stamp_freshness_enforced() const {return config_.enforce_stamp_freshness;}

  void clear_sources()
  {
    clear_source(teleop_);
    clear_source(docking_);
    clear_source(navigation_);
    clear_source(none_);
  }

  void invalidate_source(Source source, SourceHealth reason)
  {
    invalidate(state_for(source), reason);
  }

  SourceHealth source_health(Source source, SteadyTime now) const
  {
    const auto & state = state_for(source);
    if (state.health == SourceHealth::ready && now >= state.expires_at) {
      return SourceHealth::timeout;
    }
    return state.health;
  }

  SourceHealth stamp_health(Source source) const
  {
    return state_for(source).last_stamp_health;
  }

  int64_t last_stamp_skew_ms(Source source) const
  {
    return state_for(source).last_stamp_skew_ms;
  }

  uint64_t stamp_skew_events(Source source) const
  {
    return state_for(source).stamp_skew_events;
  }

  uint64_t stamp_rejections(Source source) const
  {
    return state_for(source).stamp_rejections;
  }

  Decision decide(SteadyTime now, std::string_view control_status) const
  {
    Decision decision;
    decision.owner = parse_owner_kind(control_status);
    if (estop_latched_) {
      decision.reason = DecisionReason::estop_latched;
      return decision;
    }
    if (decision.owner == OwnerKind::none) {
      decision.reason = DecisionReason::no_control_owner;
      return decision;
    }
    if (decision.owner == OwnerKind::unknown) {
      decision.reason = DecisionReason::unknown_control_owner;
      return decision;
    }

    const bool teleop_available = owner_allows(decision.owner, Source::teleop) &&
      is_fresh(teleop_, now);
    const bool docking_available = owner_allows(decision.owner, Source::docking) &&
      is_fresh(docking_, now);
    const bool navigation_available = owner_allows(decision.owner, Source::navigation) &&
      is_fresh(navigation_, now);
    decision.source = select_highest_priority_source(
      teleop_available, docking_available, navigation_available);
    if (decision.source == Source::none) {
      decision.reason = DecisionReason::no_fresh_authorized_source;
      return decision;
    }

    decision.command = state_for(decision.source).command;
    decision.reason = DecisionReason::selected;
    return decision;
  }

private:
  struct SourceState
  {
    Command command;
    SourceHealth health{SourceHealth::never_received};
    SteadyTime expires_at{};
    SourceHealth last_stamp_health{SourceHealth::never_received};
    int64_t last_stamp_skew_ms{0};
    uint64_t stamp_skew_events{0};
    uint64_t stamp_rejections{0};
  };

  std::chrono::milliseconds timeout_for(Source source) const
  {
    switch (source) {
      case Source::teleop:
        return config_.teleop_timeout;
      case Source::docking:
        return config_.docking_timeout;
      case Source::navigation:
        return config_.navigation_timeout;
      case Source::none:
        return std::chrono::milliseconds(0);
    }
    return std::chrono::milliseconds(0);
  }

  static bool is_fresh(const SourceState & state, SteadyTime now)
  {
    return state.health == SourceHealth::ready && now < state.expires_at;
  }

  static SourceHealth invalidate(SourceState & state, SourceHealth reason)
  {
    state.command = {};
    state.health = reason;
    state.expires_at = {};
    return reason;
  }

  static void clear_source(SourceState & state)
  {
    state.command = {};
    state.health = SourceHealth::never_received;
    state.expires_at = {};
  }

  static void accept(SourceState & state, const RawTwist & twist, SteadyTime expires_at)
  {
    state.command = {twist.linear_x, twist.linear_y, twist.angular_z};
    state.health = SourceHealth::ready;
    state.expires_at = expires_at;
  }

  SourceState & state_for(Source source)
  {
    switch (source) {
      case Source::teleop:
        return teleop_;
      case Source::docking:
        return docking_;
      case Source::navigation:
        return navigation_;
      case Source::none:
        return none_;
    }
    return navigation_;
  }

  const SourceState & state_for(Source source) const
  {
    switch (source) {
      case Source::teleop:
        return teleop_;
      case Source::docking:
        return docking_;
      case Source::navigation:
        return navigation_;
      case Source::none:
        return none_;
    }
    return navigation_;
  }

  Config config_;
  bool estop_latched_{false};
  SourceState teleop_;
  SourceState docking_;
  SourceState navigation_;
  SourceState none_;
};

}  // namespace cmd_vel_arbiter
}  // namespace rosdeck_robot_bridge

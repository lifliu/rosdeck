#!/usr/bin/env bash
# deploy-core.sh — userland A/B release management for the rosdeck robot bridge.
#
# Source-only library (no top-level side effects). Sourced by
# deploy-prebuilt.sh (first install / bundle deploy) and ota.sh (OTA install,
# rollback, status).
#
# The pure layout functions (rosdeck_ab_*) only touch the filesystem under
# $PREFIX — no root, systemd, or ROS needed — so they are unit tested in
# test/test_ab_layout.sh. The live functions (validate/service/health) run
# on the robot as root.
#
# On-robot layout (created by the first A/B deploy):
#
#   $PREFIX/releases/<release-id>/  one full release: bin/ node, runtime/,
#                                   config/bridge.yaml, tools/, manifest
#   $PREFIX/current    -> releases/<id>  active release (atomic swap)
#   $PREFIX/previous   -> releases/<id>  the release that was active
#                                   immediately before current
#   $PREFIX/bin/       generated launchers + ota.sh (shared across releases)
#   $PREFIX/config/    bridge.env / foxglove.env (shared operator settings)
#   $PREFIX/lib/       copy of this library (shared)
#   $PREFIX/log/
#   $PREFIX/systemd/   generated units (shared)
#
# Upgrading and rolling back are both a single atomic symlink swap of
# `current` plus a service restart, so a broken release can never leave a
# half-written install tree behind.

# --- Release identity ------------------------------------------------------

rosdeck_core_die() {
  echo "rosdeck: $*" >&2
  exit 1
}

rosdeck_ab_release_id_is_safe() {
  # A release id becomes a path component; reject anything that could
  # escape $PREFIX/releases/ (../, absolute paths, empty).
  local id="$1"
  [[ "${id}" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "${#id}" -le 128 ]]
}

rosdeck_ab_release_id() {
  # $1 = bundle directory.
  # Prints the deterministic release id <version>[-<model>]-<source_epoch>
  # read from release-manifest.json. Bundles built before the manifest
  # existed fall back to legacy-<version>-<wall-clock>, which is unique per
  # deploy but not reproducible (that is the point: legacy bundles are
  # never rebuilt, so identity only has to be unique).
  local bundle_dir="$1"
  local manifest="${bundle_dir}/release-manifest.json"
  local version="" model="" epoch=""
  if [[ -f "${manifest}" ]] && command -v python3 >/dev/null 2>&1; then
    {
      IFS= read -r version || true
      IFS= read -r model || true
      IFS= read -r epoch || true
    } < <(python3 - "${manifest}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    manifest = json.load(handle)
print(manifest["version"])
print(manifest.get("model") or "")
print(manifest["source_epoch"])
PY
)
  fi
  if [[ -z "${version}" || -z "${epoch}" ]]; then
    # No manifest: pre-release-tooling bundle. Legacy bundles are never
    # rebuilt, so the id only has to be unique, not reproducible.
    version="unknown"
    if [[ -f "${bundle_dir}/manifest.env" ]]; then
      # shellcheck disable=SC1090
      . "${bundle_dir}/manifest.env"
      version="${BUNDLE_VERSION:-unknown}"
      model="${BUNDLE_ZSIBOT_MODEL:-}"
    fi
    epoch="$(date +%s)"
    version="legacy-${version}"
  fi
  local id="${version}"
  if [[ -n "${model}" ]]; then
    id="${id}-${model}"
  fi
  printf '%s\n' "${id}-${epoch}"
}

# --- Slot layout (pure filesystem; safe to run without root) ---------------

rosdeck_ab_stage() {
  # $1 = bundle dir, $2 = prefix, $3 = release id.
  # Copies the bundle into $PREFIX/releases/<id> as a fresh full slot.
  local bundle_dir="$1" prefix="$2" release_id="$3"
  rosdeck_ab_release_id_is_safe "${release_id}" \
    || rosdeck_core_die "unsafe release id: ${release_id}"
  local slot="${prefix}/releases/${release_id}"
  if [[ -e "${slot}" ]]; then
    rosdeck_core_die "release slot already exists: ${slot}"
  fi
  install -d "${slot}"
  cp -a "${bundle_dir}/." "${slot}/"
}

rosdeck_ab_point_current() {
  # $1 = prefix, $2 = release id.
  # Atomic swap: build a temporary symlink in the same directory, then
  # rename() it over `current`. rename is atomic, so `current` always
  # resolves to a complete slot.
  local prefix="$1" release_id="$2"
  local tmp_link
  tmp_link="$(mktemp -u "${prefix}/.current-XXXXXX")"
  ln -s "releases/${release_id}" "${tmp_link}"
  if ! mv -T "${tmp_link}" "${prefix}/current" 2>/dev/null; then
    # GNU coreutils (robot, CI): the rename above is atomic.
    # BSD mv has no -T: fall back to unlink + rename (not atomic, but
    # only reached off-robot, e.g. in local tests).
    rm -f -- "${prefix}/current"
    mv -- "${tmp_link}" "${prefix}/current"
  fi
}

rosdeck_ab_activate() {
  # $1 = prefix, $2 = release id, $3 = slots to keep incl. current/previous
  # (default 3). Points `current` at releases/<id>, records the outgoing
  # release as `previous`, prunes excess slots.
  local prefix="$1" release_id="$2" keep="${3:-3}"
  rosdeck_ab_release_id_is_safe "${release_id}" \
    || rosdeck_core_die "unsafe release id: ${release_id}"
  if [[ ! -d "${prefix}/releases/${release_id}" ]]; then
    rosdeck_core_die "release slot is missing: ${prefix}/releases/${release_id}"
  fi
  local old_current=""
  if [[ -L "${prefix}/current" ]]; then
    old_current="$(basename "$(readlink "${prefix}/current")")"
  fi
  if [[ -n "${old_current}" && "${old_current}" != "${release_id}" ]]; then
    ln -sfn "releases/${old_current}" "${prefix}/previous"
  elif [[ -z "${old_current}" && -L "${prefix}/previous" ]]; then
    rm -f -- "${prefix}/previous"
  fi
  rosdeck_ab_point_current "${prefix}" "${release_id}"
  rosdeck_ab_prune "${prefix}" "${keep}"
}

rosdeck_ab_active_id() {
  # $1 = prefix. Prints the active release id; fails when there is none.
  local prefix="$1"
  local target
  [[ -L "${prefix}/current" ]] || return 1
  target="$(readlink "${prefix}/current")"
  case "${target}" in
    releases/*) printf '%s\n' "${target#releases/}" ;;
    *) printf '%s\n' "$(basename "${target}")" ;;
  esac
}

rosdeck_ab_has_previous() {
  # $1 = prefix. Succeeds when `previous` points at an existing slot.
  local prefix="$1"
  local prev_id=""
  if [[ -L "${prefix}/previous" ]]; then
    prev_id="$(basename "$(readlink "${prefix}/previous")")"
  fi
  [[ -n "${prev_id}" && -d "${prefix}/releases/${prev_id}" ]]
}

rosdeck_ab_rollback() {
  # $1 = prefix. Swaps `current` and `previous` atomically.
  local prefix="$1"
  local current_id
  current_id="$(rosdeck_ab_active_id "${prefix}")" \
    || rosdeck_core_die "no active release under ${prefix}"
  local prev_id=""
  if [[ -L "${prefix}/previous" ]]; then
    prev_id="$(basename "$(readlink "${prefix}/previous")")"
  fi
  if [[ -z "${prev_id}" ]] || ! rosdeck_ab_release_id_is_safe "${prev_id}"; then
    rosdeck_core_die "no valid previous release to roll back to"
  fi
  if [[ ! -d "${prefix}/releases/${prev_id}" ]]; then
    rosdeck_core_die "previous release slot is missing: ${prefix}/releases/${prev_id}"
  fi
  ln -sfn "releases/${current_id}" "${prefix}/previous"
  rosdeck_ab_point_current "${prefix}" "${prev_id}"
}

rosdeck_ab_prune() {
  # $1 = prefix, $2 = total slots to keep incl. current/previous (default 3).
  # Never removes the slots behind `current` or `previous`; among the rest,
  # keeps the newest (by trailing source epoch) and removes the old ones.
  local prefix="$1" keep="${2:-3}"
  local current_id="" previous_id=""
  current_id="$(rosdeck_ab_active_id "${prefix}" || true)"
  if [[ -L "${prefix}/previous" ]]; then
    previous_id="$(basename "$(readlink "${prefix}/previous")")"
  fi
  local protected=0
  if [[ -n "${current_id}" ]]; then
    protected=$((protected + 1))
  fi
  if [[ -n "${previous_id}" && "${previous_id}" != "${current_id}" ]]; then
    protected=$((protected + 1))
  fi
  local retain=$((keep - protected))
  if ((retain < 0)); then
    retain=0
  fi
  local entries=()
  local slot id
  for slot in "${prefix}"/releases/*/; do
    [[ -d "${slot}" ]] || continue
    id="${slot%/}"
    id="${id##*/}"
    if [[ "${id}" == "${current_id}" || "${id}" == "${previous_id}" ]]; then
      continue
    fi
    entries+=("${id##*-} ${id}")
  done
  if [[ "${#entries[@]}" -gt "${retain}" ]]; then
    local sorted
    sorted="$(printf '%s\n' "${entries[@]}" | sort -k1,1nr)"
    local kept=0 epoch
    while read -r epoch id; do
      if [[ "${kept}" -ge "${retain}" ]]; then
        rm -rf -- "${prefix}/releases/${id}"
      else
        kept=$((kept + 1))
      fi
    done <<< "${sorted}"
  fi
}

rosdeck_ab_status() {
  # $1 = prefix. Prints the A/B state: current, previous, retained slots.
  local prefix="$1"
  local current_id="" previous_id=""
  current_id="$(rosdeck_ab_active_id "${prefix}" || true)"
  if [[ -L "${prefix}/previous" ]]; then
    previous_id="$(basename "$(readlink "${prefix}/previous")")"
  fi
  echo "prefix:   ${prefix}"
  echo "current:  ${current_id:-<none>}"
  echo "previous: ${previous_id:-<none>}"
  local slot id marker detail
  for slot in "${prefix}"/releases/*/; do
    [[ -d "${slot}" ]] || continue
    id="${slot%/}"
    id="${id##*/}"
    marker=""
    if [[ "${id}" == "${current_id}" ]]; then
      marker=" (current)"
    elif [[ "${id}" == "${previous_id}" ]]; then
      marker=" (previous)"
    fi
    detail=""
    if [[ -f "${slot}/release-manifest.json" ]] \
      && command -v python3 >/dev/null 2>&1; then
      detail="$(python3 - "${slot}/release-manifest.json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    manifest = json.load(handle)
print("version=%s model=%s source_epoch=%s"
      % (manifest["version"],
         manifest.get("model") or "-",
         manifest["source_epoch"]))
PY
)"
    fi
    echo "slot:     ${id}${marker} ${detail}"
  done
}

# --- Legacy in-place install ----------------------------------------------

rosdeck_ab_adopt_legacy() {
  # $1 = prefix, $2 = new bundle dir.
  # First A/B conversion on a robot that was deployed in place
  # ($PREFIX/runtime, $PREFIX/bin/rosdeck_robot_bridge_node). The legacy
  # tree is moved into a normal release slot, so the very first A/B
  # upgrade can roll back to it with a plain symlink swap.
  local prefix="$1" bundle_dir="$2"
  if [[ ! -d "${prefix}/runtime" \
    && ! -f "${prefix}/bin/rosdeck_robot_bridge_node" ]]; then
    return 0
  fi
  local legacy_id="legacy-$(date +%Y%m%d%H%M%S)"
  local legacy_slot="${prefix}/releases/${legacy_id}"
  install -d "${legacy_slot}"
  if [[ -d "${prefix}/runtime" ]]; then
    mv -- "${prefix}/runtime" "${legacy_slot}/runtime"
  fi
  if [[ -f "${prefix}/bin/rosdeck_robot_bridge_node" ]]; then
    install -d "${legacy_slot}/bin"
    mv -- "${prefix}/bin/rosdeck_robot_bridge_node" "${legacy_slot}/bin/"
  fi
  if [[ -f "${prefix}/config/bridge.yaml" ]]; then
    install -d "${legacy_slot}/config"
    cp -a "${prefix}/config/bridge.yaml" "${legacy_slot}/config/bridge.yaml"
  fi
  # A modern verifier inside the legacy slot keeps `ota.sh install` usable
  # even after rolling back onto it.
  if [[ -d "${bundle_dir}/tools" ]]; then
    cp -a "${bundle_dir}/tools" "${legacy_slot}/tools"
  fi
  ln -sfn "releases/${legacy_id}" "${prefix}/previous"
  echo "Adopted the in-place (legacy) install as release ${legacy_id}."
}

# --- Glue, config, units (shared across releases) --------------------------

rosdeck_glue_render() {
  # $1 = bundle dir, $2 = prefix, $3 = ros setup, $4 = profile,
  # $5 = node name, $6 = foxglove (0|1).
  # Regenerates the shared launchers and units. They reference
  # $PREFIX/current/... for release-specific paths, so switching the
  # symlink is enough to change what the service runs.
  local bundle_dir="$1" prefix="$2" ros_setup="$3" profile="$4"
  local node_name="$5" foxglove="$6"
  local templates="${bundle_dir}/templates"
  for template in run-bridge.in bootstrap-service.in \
    rosdeck-robot-bridge.service.in; do
    if [[ ! -f "${templates}/${template}" ]]; then
      rosdeck_core_die "bundle is missing template: ${templates}/${template}"
    fi
  done
  if [[ "${foxglove}" -eq 1 ]]; then
    [[ -f "${templates}/run-foxglove.in" ]] \
      || rosdeck_core_die "bundle is missing template: ${templates}/run-foxglove.in"
    [[ -f "${templates}/rosdeck-foxglove-bridge.service.in" ]] \
      || rosdeck_core_die "bundle is missing template: ${templates}/rosdeck-foxglove-bridge.service.in"
    [[ -f "${templates}/run-gateway.in" ]] \
      || rosdeck_core_die "bundle is missing template: ${templates}/run-gateway.in"
    [[ -f "${templates}/omni-ws-gateway.service.in" ]] \
      || rosdeck_core_die "bundle is missing template: ${templates}/omni-ws-gateway.service.in"
  fi
  install -d "${prefix}/bin" "${prefix}/systemd"
  sed \
    -e "s#@ROS_SETUP@#${ros_setup}#g" \
    -e "s#@INSTALL_PREFIX@#${prefix}#g" \
    -e "s#@CURRENT@#${prefix}/current#g" \
    -e "s#@NODE_NAME@#${node_name}#g" \
    -e "s#@PROFILE@#${profile}#g" \
    "${templates}/run-bridge.in" > "${prefix}/bin/run-rosdeck-robot-bridge"
  chmod 0755 "${prefix}/bin/run-rosdeck-robot-bridge"
  if [[ "${foxglove}" -eq 1 ]]; then
    sed \
      -e "s#@ROS_SETUP@#${ros_setup}#g" \
      -e "s#@INSTALL_PREFIX@#${prefix}#g" \
      -e "s#@CURRENT@#${prefix}/current#g" \
      "${templates}/run-foxglove.in" > "${prefix}/bin/run-rosdeck-foxglove-bridge"
    chmod 0755 "${prefix}/bin/run-rosdeck-foxglove-bridge"
    sed \
      -e "s#@ROS_SETUP@#${ros_setup}#g" \
      -e "s#@INSTALL_PREFIX@#${prefix}#g" \
      -e "s#@CURRENT@#${prefix}/current#g" \
      "${templates}/run-gateway.in" > "${prefix}/bin/run-omni-ws-gateway"
    chmod 0755 "${prefix}/bin/run-omni-ws-gateway"
  fi
  sed "s#@INSTALL_PREFIX@#${prefix}#g" \
    "${templates}/bootstrap-service.in" \
    > "${prefix}/bin/bootstrap-rosdeck-service"
  chmod 0755 "${prefix}/bin/bootstrap-rosdeck-service"
  # @VBOT_ONLY@ marks profile-conditional unit directives (e.g. the vbot
  # ReadWritePaths=/userdata). For non-vbot profiles the token is replaced
  # with a leading '#' so the line renders as a comment; for vbot it is
  # dropped entirely, activating the directive.
  local vbot_only=""
  if [[ "${profile}" != "vbot" ]]; then
    vbot_only="#"
  fi
  sed -e "s#@INSTALL_PREFIX@#${prefix}#g" \
      -e "s#@VBOT_ONLY@#${vbot_only}#g" \
    "${templates}/rosdeck-robot-bridge.service.in" \
    > "${prefix}/systemd/rosdeck-robot-bridge.service"
  if [[ "${foxglove}" -eq 1 ]]; then
    sed -e "s#@INSTALL_PREFIX@#${prefix}#g" \
        -e "s#@VBOT_ONLY@#${vbot_only}#g" \
      "${templates}/rosdeck-foxglove-bridge.service.in" \
      > "${prefix}/systemd/rosdeck-foxglove-bridge.service"
    sed -e "s#@INSTALL_PREFIX@#${prefix}#g" \
        -e "s#@VBOT_ONLY@#${vbot_only}#g" \
      "${templates}/omni-ws-gateway.service.in" \
      > "${prefix}/systemd/omni-ws-gateway.service"
  fi
}

rosdeck_config_prepare() {
  # $1 = prefix, $2 = profile, $3 = foxglove (0|1).
  # Creates/updates the shared env files. Never clobbers operator edits:
  # existing keys are left alone, missing keys are appended once. The
  # caller must have sourced the ROS environment (RMW_IMPLEMENTATION,
  # ROS_DOMAIN_ID).
  local prefix="$1" profile="$2" foxglove="$3"
  install -d "${prefix}/config"
  local env_file="${prefix}/config/bridge.env"
  if [[ ! -f "${env_file}" ]]; then
    if [[ "${profile}" == "vbot" ]]; then
      echo "RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION:-rmw_zenoh_cpp}" \
        > "${env_file}"
    else
      install -m 0644 /dev/null "${env_file}"
    fi
  fi
  local default_domain_id="${ROS_DOMAIN_ID:-0}"
  local default_rmw="${RMW_IMPLEMENTATION:-rmw_zenoh_cpp}"
  if [[ "${profile}" == "zsibot" ]]; then
    default_domain_id="${ROS_DOMAIN_ID:-24}"
  fi
  if ! grep -Eq '^[[:space:]]*ROS_DOMAIN_ID=' "${env_file}"; then
    echo "ROS_DOMAIN_ID=${default_domain_id}" >> "${env_file}"
  fi
  if ! grep -Eq '^[[:space:]]*ROS_LOCALHOST_ONLY=' "${env_file}"; then
    echo "ROS_LOCALHOST_ONLY=${ROS_LOCALHOST_ONLY:-0}" >> "${env_file}"
  fi
  if ! grep -Eq '^[[:space:]]*RMW_IMPLEMENTATION=' "${env_file}"; then
    echo "RMW_IMPLEMENTATION=${default_rmw}" >> "${env_file}"
  fi
  chmod 0644 "${env_file}"
  if [[ "${foxglove}" -eq 1 ]]; then
    # The TLS gateway (omni-ws-gateway) owns the app-facing 0.0.0.0:8765, so
    # foxglove_bridge must listen on loopback:8766. This is a product
    # invariant, not operator config: rewrite it idempotently so upgrades
    # from pre-gateway installs (0.0.0.0:8765) converge. One awk pass
    # (portable; no in-place sed).
    local fx_env="${prefix}/config/foxglove.env"
    local fx_tmp
    fx_tmp="$(mktemp "${fx_env}.XXXXXX")"
    if [[ -f "${fx_env}" ]]; then
      awk '
        /^[[:space:]]*FOXGLOVE_ADDRESS=/ { seen_addr = 1; print "FOXGLOVE_ADDRESS=127.0.0.1"; next }
        /^[[:space:]]*FOXGLOVE_PORT=/    { seen_port = 1; print "FOXGLOVE_PORT=8766"; next }
        { print }
        END {
          if (!seen_addr) print "FOXGLOVE_ADDRESS=127.0.0.1"
          if (!seen_port) print "FOXGLOVE_PORT=8766"
        }
      ' "${fx_env}" > "${fx_tmp}"
    else
      printf '%s\n' 'FOXGLOVE_ADDRESS=127.0.0.1' 'FOXGLOVE_PORT=8766' \
        > "${fx_tmp}"
    fi
    mv -- "${fx_tmp}" "${fx_env}"
    chmod 0644 "${fx_env}"
  fi
}

rosdeck_user_prepare() {
  # $1 = profile. Creates the dedicated service account and the persistent
  # state directories the non-root units need. Runs as root (deploy
  # context) and is idempotent, so re-deploys are a no-op.
  #
  # The units run as User=rosdeck. The release tree itself stays
  # root-owned and world-readable (0644/0755 installs); only the state the
  # services write at runtime needs the service account as owner:
  #   /var/lib/omni/          mission manager routes + SQLite DB
  #   /var/lib/omni/tls/      WS gateway device certificate (provisioned
  #                           once by omni-auth init; preserved on upgrade)
  #   /var/lib/omni/auth/     WS gateway users.json + policy.json
  #   /var/lib/omni/audit/    WS gateway JSONL audit trail
  #   /run/lock/omni/         created per start by RuntimeDirectory=lock/omni
  # Existing root-owned state from earlier (root-run) deploys is chowned
  # into the service account so upgrades do not strand it.
  #
  # ROSDECK_SKIP_USER_PREPARE=1 (test-only) bypasses this entirely; the
  # offline E2E harness runs as an unprivileged user with a stubbed
  # systemctl, where groupadd/useradd would fail.
  local profile="$1"
  if [[ "${ROSDECK_SKIP_USER_PREPARE:-0}" == "1" ]]; then
    return 0
  fi
  if ! getent group rosdeck >/dev/null; then
    groupadd --system rosdeck
  fi
  if ! getent passwd rosdeck >/dev/null; then
    useradd --system --gid rosdeck --home-dir /nonexistent \
      --shell /usr/sbin/nologin --comment "Rosdeck robot services" rosdeck
  fi
  install -d /var/lib/omni/routes /var/lib/omni/mission_manager \
    /var/lib/omni/tls /var/lib/omni/auth /var/lib/omni/audit
  chown -R rosdeck:rosdeck /var/lib/omni
}

rosdeck_gateway_provision() {
  # $1 = slot runtime dir, $2 = foxglove (0|1).
  # Generates the TLS device certificate + SPKI pin under /var/lib/omni/tls
  # by running `omni-auth init` from the slot being installed (NOT the
  # active `current`), so the first gateway release can self-provision on a
  # robot whose previous release predates the package. Idempotent: existing
  # device.crt/device.key are kept so the app's certificate pin survives
  # every upgrade. Fail-closed: if the cert cannot be generated the install
  # aborts rather than serving plaintext.
  local runtime_dir="$1" foxglove="$2"
  if [[ "${foxglove}" -ne 1 ]]; then
    return 0
  fi
  if [[ "${ROSDECK_SKIP_USER_PREPARE:-0}" == "1" ]]; then
    return 0  # offline test harness: no /var/lib/omni, no real ROS
  fi
  local tls_dir="/var/lib/omni/tls"
  if [[ -f "${tls_dir}/device.crt" && -f "${tls_dir}/device.key" ]]; then
    return 0
  fi
  if [[ ! -f "${runtime_dir}/local_setup.bash" ]]; then
    rosdeck_core_die "gateway provisioning requires the slot runtime: ${runtime_dir}"
  fi
  echo "Provisioning the WS gateway TLS certificate..."
  bash -c '
    set +u
    source "$1"
    set -u
    exec ros2 run omni_ws_gateway omni-auth init
  ' _ "${runtime_dir}/local_setup.bash"
}

rosdeck_units_install() {
  # $1 = prefix, $2 = profile, $3 = foxglove (0|1).
  # Installs the shared units into /etc/systemd/system (and, for vbot, the
  # per-boot /run copy that the startup hook re-asserts).
  local prefix="$1" profile="$2" foxglove="$3"
  local units=(rosdeck-robot-bridge.service)
  if [[ "${foxglove}" -eq 1 ]]; then
    units+=(rosdeck-foxglove-bridge.service omni-ws-gateway.service)
  fi
  # ROSDECK_ETC_ROOT/ROSDECK_RUN_ROOT allow installing into a chroot or in
  # tests without root.
  local etc_root="${ROSDECK_ETC_ROOT:-/etc}"
  local run_root="${ROSDECK_RUN_ROOT:-/run}"
  local unit
  if [[ "${profile}" == "vbot" ]]; then
    install -d "${run_root}/systemd/system" "${etc_root}/systemd/system"
    for unit in "${units[@]}"; do
      install -m 0644 "${prefix}/systemd/${unit}" \
        "${run_root}/systemd/system/${unit}"
      install -m 0644 "${prefix}/systemd/${unit}" \
        "${etc_root}/systemd/system/${unit}"
    done
  else
    install -d "${etc_root}/systemd/system"
    for unit in "${units[@]}"; do
      install -m 0644 "${prefix}/systemd/${unit}" \
        "${etc_root}/systemd/system/${unit}"
    done
  fi
}

rosdeck_vbot_init_hook() {
  # $1 = prefix. Registers the per-boot bootstrap in the robot's startup
  # script (/userdata/startup.sh on vbot). ROSDECK_USERDATA_DIR redirects
  # it for chroot installs and tests.
  local prefix="$1"
  local userdata_dir="${ROSDECK_USERDATA_DIR:-/userdata}"
  local init_script="${userdata_dir}/startup.sh"
  local marker="# ROSDECK ROBOT BRIDGE"
  local invocation="${prefix}/bin/bootstrap-rosdeck-service >>${prefix}/log/bootstrap.log 2>&1 &"

  if [[ -f "${init_script}" ]] && grep -Fq "${marker}" "${init_script}"; then
    return 0
  fi

  install -d "${userdata_dir}" "${prefix}/log"
  if [[ ! -f "${init_script}" ]]; then
    printf '%s\n' '#!/usr/bin/env bash' '' "${marker}" "${invocation}" \
      > "${init_script}"
  elif grep -Eq '^[[:space:]]*exit[[:space:]]+0[[:space:]]*$' "${init_script}"; then
    cp -a "${init_script}" "${init_script}.before-rosdeck"
    local temp_script
    temp_script="$(mktemp "${init_script}.XXXXXX")"
    awk -v marker="${marker}" -v invocation="${invocation}" '
      !inserted && $0 ~ /^[[:space:]]*exit[[:space:]]+0[[:space:]]*$/ {
        print marker
        print invocation
        inserted = 1
      }
      { print }
    ' "${init_script}" > "${temp_script}"
    install -m 0755 "${temp_script}" "${init_script}"
    rm -f -- "${temp_script}"
  else
    printf '%s\n' '' "${marker}" "${invocation}" >> "${init_script}"
  fi
  chmod 0755 "${init_script}"
}

# --- Live checks (root + robot environment) --------------------------------

rosdeck_validate_bundle() {
  # $1 = bundle dir, $2 = arch, $3 = profile, $4 = ros distro,
  # $5 = ros setup, $6 = foxglove (0|1).
  # Every check that can run before a single robot file is touched.
  local bundle_dir="$1" arch="$2" profile="$3" distro="$4"
  local ros_setup="$5" foxglove="$6"
  if [[ "$(uname -m)" != "${arch}" ]]; then
    rosdeck_core_die "architecture mismatch: bundle=${arch}, robot=$(uname -m)"
  fi
  set +u
  source "${ros_setup}"
  if [[ -f "${bundle_dir}/runtime/local_setup.bash" ]]; then
    source "${bundle_dir}/runtime/local_setup.bash"
  fi
  set -u
  if [[ "${ROS_DISTRO:-}" != "${distro}" ]]; then
    rosdeck_core_die "ROS mismatch: bundle=${distro}, robot=${ROS_DISTRO:-unknown}"
  fi
  if [[ "${foxglove}" -eq 1 ]]; then
    if ! ros2 pkg prefix foxglove_bridge >/dev/null 2>&1; then
      rosdeck_core_die "foxglove_bridge is required for mobile connections but is not installed (apt install ros-${distro}-foxglove-bridge)"
    fi
    if [[ ! -x "${bundle_dir}/runtime/lib/omni_ws_gateway/omni-ws-gateway" ]]; then
      rosdeck_core_die "bundle is missing the WS gateway runtime (install/lib/omni_ws_gateway/omni-ws-gateway); rebuild with a build.sh that selects omni_ws_gateway"
    fi
  fi
  if [[ "${profile}" == "vbot" ]]; then
    ros2 pkg prefix function_msgs >/dev/null 2>&1 \
      || rosdeck_core_die "Robot runtime is missing function_msgs."
    ros2 pkg prefix software_msgs >/dev/null 2>&1 \
      || rosdeck_core_die "Robot runtime is missing software_msgs."
  fi
  local runtime_executable
  for runtime_executable in \
    "${bundle_dir}/runtime/lib/rosdeck_robot_bridge/rosdeck_robot_bridge_node" \
    "${bundle_dir}/runtime/lib/rosdeck_robot_bridge/rosdeck_safety_supervisor_node"; do
    if [[ ! -x "${runtime_executable}" ]]; then
      rosdeck_core_die "invalid bundle: product runtime executable is missing: ${runtime_executable}"
    fi
    if LD_LIBRARY_PATH="${bundle_dir}/runtime/lib:${LD_LIBRARY_PATH:-}" \
      ldd "${runtime_executable}" | grep -q 'not found'; then
      echo "The robot is missing shared libraries required by this bundle:" >&2
      LD_LIBRARY_PATH="${bundle_dir}/runtime/lib:${LD_LIBRARY_PATH:-}" \
        ldd "${runtime_executable}" >&2
      rosdeck_core_die "unresolved shared-library dependencies (see above)"
    fi
  done
}

rosdeck_service_apply() {
  # $1 = profile, $2 = foxglove (0|1), $3 = prefix (A/B root; enables the
  # gateway only when the active release ships omni_ws_gateway).
  # (Re)starts the units and fails unless the bridge reports active.
  local profile="$1" foxglove="$2" prefix="${3:-}"
  local gateway=0
  if [[ "${foxglove}" -eq 1 && -n "${prefix}" ]]; then
    local active_id slot
    active_id="$(rosdeck_ab_active_id "${prefix}" || true)"
    slot="${prefix}/releases/${active_id:-}"
    if [[ -n "${slot}" \
      && -f "${slot}/runtime/lib/omni_ws_gateway/omni-ws-gateway" ]]; then
      gateway=1
    fi
  fi
  systemctl daemon-reload
  if [[ "${profile}" == "vbot" ]]; then
    systemctl restart rosdeck-robot-bridge.service
  else
    systemctl enable --now rosdeck-robot-bridge.service
  fi
  if [[ "${foxglove}" -eq 1 ]]; then
    systemctl enable --now rosdeck-foxglove-bridge.service
  fi
  if [[ "${gateway}" -eq 1 ]]; then
    systemctl enable --now omni-ws-gateway.service
  fi
  sleep 2
  if ! systemctl is-active --quiet rosdeck-robot-bridge.service; then
    echo "Bridge failed to stay active. Recent logs:" >&2
    journalctl -u rosdeck-robot-bridge.service -n 80 --no-pager >&2 || true
    return 1
  fi
  if [[ "${foxglove}" -eq 1 ]] \
    && ! systemctl is-active --quiet rosdeck-foxglove-bridge.service; then
    echo "Foxglove Bridge failed to stay active. Recent logs:" >&2
    journalctl -u rosdeck-foxglove-bridge.service -n 80 --no-pager >&2 || true
    return 1
  fi
  if [[ "${gateway}" -eq 1 ]] \
    && ! systemctl is-active --quiet omni-ws-gateway.service; then
    echo "WS gateway failed to stay active. Recent logs:" >&2
    journalctl -u omni-ws-gateway.service -n 80 --no-pager >&2 || true
    return 1
  fi
}

rosdeck_gateway_unit_withdraw() {
  # $1 = prefix.
  # After a rollback onto a release that predates the gateway package, the
  # shared unit file would crash-loop against a runtime that no longer has
  # omni_ws_gateway. Withdraw it (disable + remove from /etc and /run) when
  # the active slot lacks the package; a no-op otherwise.
  local prefix="$1"
  local active_id slot
  active_id="$(rosdeck_ab_active_id "${prefix}" || true)"
  slot="${prefix}/releases/${active_id:-}"
  if [[ -n "${slot}" \
    && -f "${slot}/runtime/lib/omni_ws_gateway/omni-ws-gateway" ]]; then
    return 0
  fi
  local etc_root="${ROSDECK_ETC_ROOT:-/etc}"
  local run_root="${ROSDECK_RUN_ROOT:-/run}"
  systemctl disable --now omni-ws-gateway.service 2>/dev/null || true
  rm -f -- "${etc_root}/systemd/system/omni-ws-gateway.service" \
    "${run_root}/systemd/system/omni-ws-gateway.service"
  systemctl daemon-reload
}

rosdeck_health_check() {
  # $1 = prefix, $2 = ros setup, $3 = node name, $4 = profile.
  # Runs the continuous graph/cgroup/status health check against the ACTIVE
  # release slot.
  local prefix="$1" ros_setup="$2" node_name="$3" profile="$4"
  timeout 50 bash -c '
    set -e
    set -a
    [[ -f "$4" ]] && source "$4"
    set +a
    source "$1"
    [[ -f "$2" ]] && source "$2"
    "$5" "$6" "$3" rosdeck-robot-bridge.service
  ' _ "${ros_setup}" "${prefix}/current/runtime/local_setup.bash" \
    "/${node_name}" "${prefix}/config/bridge.env" \
    "${prefix}/current/runtime/lib/rosdeck_robot_bridge/assert-product-bringup-health.sh" \
    "${profile}"
}

# --- Orchestrator ------------------------------------------------------------

rosdeck_install_bundle() {
  # $1 = bundle dir (extracted, already integrity-checked), $2 = prefix,
  # $3 = ros setup, $4 = profile, $5 = arch, $6 = ros distro, $7 = node name,
  # $8 = foxglove (0|1), $9 = slots to keep, $10 = start service (0|1).
  #
  # Stages the bundle as a release slot, regenerates the shared glue and
  # config, swaps the `current` symlink atomically, restarts the service
  # and runs the bringup health check. On a failed check the switch is
  # reverted automatically (when a previous release exists).
  local bundle_dir="$1" prefix="$2" ros_setup="$3" profile="$4"
  local arch="$5" distro="$6" node_name="$7" foxglove="$8"
  local keep="$9" start="${10}"

  rosdeck_validate_bundle "${bundle_dir}" "${arch}" "${profile}" \
    "${distro}" "${ros_setup}" "${foxglove}"

  local release_id
  release_id="$(rosdeck_ab_release_id "${bundle_dir}")"
  echo "Release: ${release_id}"

  local first_conversion=0
  if [[ ! -L "${prefix}/current" ]]; then
    first_conversion=1
  fi

  local slot="${prefix}/releases/${release_id}"
  # Same id means same pinned content (deterministic build); a leftover
  # slot from an interrupted install is replaced.
  if [[ -e "${slot}" ]]; then
    rm -rf -- "${slot}"
  fi
  rosdeck_ab_stage "${bundle_dir}" "${prefix}" "${release_id}"

  if [[ "${first_conversion}" -eq 1 ]]; then
    rosdeck_ab_adopt_legacy "${prefix}" "${bundle_dir}"
    # A bridge.yaml tuned by an operator in the pre-A/B layout carries over
    # into the new slot (the shared file stays put; slots own their copy).
    if [[ -f "${prefix}/config/bridge.yaml" ]]; then
      install -d "${slot}/config"
      cp -a "${prefix}/config/bridge.yaml" "${slot}/config/bridge.yaml"
    fi
  fi

  rosdeck_glue_render "${bundle_dir}" "${prefix}" "${ros_setup}" \
    "${profile}" "${node_name}" "${foxglove}"
  rosdeck_config_prepare "${prefix}" "${profile}" "${foxglove}"
  rosdeck_user_prepare "${profile}"
  rosdeck_gateway_provision "${slot}/runtime" "${foxglove}"
  rosdeck_units_install "${prefix}" "${profile}" "${foxglove}"
  if [[ "${profile}" == "vbot" ]]; then
    rosdeck_vbot_init_hook "${prefix}"
  fi
  # The A/B machinery itself is shared and refreshed with every release so
  # ota.sh keeps working after an upgrade (or a rollback onto a legacy slot).
  install -d "${prefix}/lib"
  install -m 0644 "${BASH_SOURCE[0]}" "${prefix}/lib/deploy-core.sh"
  if [[ -f "${bundle_dir}/ota.sh" ]]; then
    install -m 0755 "${bundle_dir}/ota.sh" "${prefix}/bin/ota.sh"
  fi

  local active_id=""
  active_id="$(rosdeck_ab_active_id "${prefix}" || true)"
  if [[ "${active_id}" == "${release_id}" ]]; then
    echo "Release ${release_id} is already active; re-applied glue, config and units."
    if [[ "${start}" -eq 1 ]]; then
      rosdeck_service_apply "${profile}" "${foxglove}" "${prefix}" \
        || rosdeck_core_die "service did not come up"
    fi
    return 0
  fi

  rosdeck_ab_activate "${prefix}" "${release_id}" "${keep}"
  echo "Active release switched to: ${release_id}"

  if [[ "${start}" -ne 1 ]]; then
    echo "Installed without starting the service in this boot."
    return 0
  fi

  local healthy=0
  if rosdeck_service_apply "${profile}" "${foxglove}" "${prefix}" \
    && rosdeck_health_check "${prefix}" "${ros_setup}" "${node_name}" \
       "${profile}"; then
    healthy=1
  fi

  if [[ "${healthy}" -ne 1 ]]; then
    echo "" >&2
    echo "!! New release ${release_id} failed its startup/health check." >&2
    if ! rosdeck_ab_has_previous "${prefix}"; then
      echo "No previous release exists to roll back to." >&2
      rosdeck_core_die "new release failed and there is nothing to roll back to"
    fi
    echo "!! Rolling back to the previous release..." >&2
    if rosdeck_ab_rollback "${prefix}" \
      && rosdeck_gateway_unit_withdraw "${prefix}" \
      && rosdeck_service_apply "${profile}" "${foxglove}" "${prefix}" \
      && rosdeck_health_check "${prefix}" "${ros_setup}" "${node_name}" \
         "${profile}"; then
      echo "Rollback succeeded; the previous release is active again." >&2
      # The robot is healthy, but the new release was rejected — callers
      # (ota.sh, CI pipelines) need a non-zero exit to know it did not take.
      rosdeck_core_die "new release ${release_id} failed; robot restored to the previous release"
    fi
    echo "ROLLBACK FAILED — the robot may be down. Current state:" >&2
    rosdeck_ab_status "${prefix}" >&2
    rosdeck_core_die "automatic rollback did not restore the service"
  fi

  if [[ "${profile}" == "vbot" ]]; then
    echo "Boot autostart: registered in /userdata/startup.sh"
  else
    echo "Boot autostart: enabled with persistent systemd (${prefix})"
  fi
  echo "Logs: journalctl -u rosdeck-robot-bridge -f"
  if [[ "${foxglove}" -eq 1 ]]; then
    echo "Mobile access: wss://<orin-ip>:8765 (TLS gateway; token users via"
    echo "  ros2 run omni_ws_gateway omni-auth, cert pin via omni-auth show-pairing)"
    echo "  systemctl status rosdeck-foxglove-bridge omni-ws-gateway"
  fi
}
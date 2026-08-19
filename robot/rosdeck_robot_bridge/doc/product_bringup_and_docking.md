# 统一产品 Bringup 与 OpenNav Docking 接入

## 1. 运行边界

产品运行时只有 `rosdeck_robot_bridge` 可以持有 ZsiBot SDK。规划、手机遥控和
回充控制器都只能向 Gateway 的仲裁输入发布速度：

```text
手机遥控 TwistStamped  -> /omni/cmd_vel/teleop       --+
SCAN-Planner Twist      -> /scan_planner/cmd_vel       +--> Gateway arbiter
OpenNav Docking Twist   -> /omni/cmd_vel/docking      --+         |
安全监督 Bool 心跳       -> /omni/safety/estop          -----------+
                                                                  |
                                      /omni/cmd_vel/final -> ZsiBot SDK
```

任何模块都不得直接发布 `/omni/cmd_vel/final`，Docking 也不得链接或初始化厂商
SDK。Gateway 会拒绝同一仲裁输入存在多个 publisher 的情况，并在输入超过
250 ms 未刷新时输出零速度。

## 2. 启动 Gateway 与安全监督器

默认产品入口为：

```bash
source /opt/ros/humble/setup.bash
source /path/to/workspace/install/setup.bash

ros2 launch rosdeck_robot_bridge product_bringup.launch.py
```

它会 include `bridge.launch.py`，由后者同时启动：

- `rosdeck_robot_bridge_node`（Gateway、控制权和速度仲裁）；
- `rosdeck_safety_supervisor_node`（独立安全心跳和软件急停锁存）。

启动完成不等于允许运动。产品默认保持 fail-closed，操作员确认现场安全后按顺序
执行：

```bash
# 1. 允许 supervisor 开始发布“健康/未触发”的 false 心跳。
ros2 service call /omni/safety/arm_supervisor std_srvs/srv/Trigger '{}'

# 2. 在 fresh supervisor 心跳存在且急停请求已解除后，显式清除 Gateway 锁存。
ros2 service call /omni/safety/reset_estop std_srvs/srv/Trigger '{}'
```

`false` 心跳本身不会自动清除已锁存的急停。任意 `true` 请求、监督器消失、心跳
超时或 publisher 数量不为 1，都会让 Gateway 保持或重新进入锁存状态。

## 3. 启动 OpenNav Docking

仓库中的 Humble 版 `opennav_docking` 没有可直接复用的 docking launch；其
`docking_server` 是生命周期节点，原生向相对话题 `cmd_vel` 发布
`geometry_msgs/msg/Twist`。产品入口因此直接启动该 executable 和独立 lifecycle
manager，并在同一个 scoped launch group 内完成重映射：

```text
OpenNav relative cmd_vel -> /omni/cmd_vel/docking
```

启用方式：

```bash
# 两个包必须能从当前 ROS 环境/overlay 发现。
ros2 pkg executables opennav_docking
ros2 pkg executables nav2_lifecycle_manager

ros2 launch rosdeck_robot_bridge product_bringup.launch.py \
  use_opennav_docking:=true \
  docking_params_file:=/absolute/path/to/omni_docking.yaml
```

`package.xml` 已声明 `opennav_docking` 和 `nav2_lifecycle_manager` 为运行依赖；
离线 tar 包仍不会自动复制另一个源码工作区。目标机必须通过系统安装或在启动前
source 一个包含这两个包的 overlay，否则产品 launch 会明确报错并拒绝启用
Docking。

`docking_params_file` 必须存在，并包含实机 dock plugin、dock database、坐标系、
碰撞检测、充电检测和控制器参数。项目目前没有一份可安全套用到所有机器狗的默认
参数，因此启用 Docking 时不允许省略该文件。

相关 launch 参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `config` | 包内 `config/zsibot.yaml` | Gateway 与 supervisor 参数 |
| `bridge_node_name` | `rosdeck_robot_bridge` | Gateway 节点名；部署脚本用于兼容既有 profile 命名 |
| `use_opennav_docking` | `false` | 是否启动 OpenNav Docking |
| `docking_params_file` | 空 | 启用 Docking 时必填的绝对路径 |
| `docking_cmd_vel_source` | `cmd_vel` | OpenNav 的相对输出名；绝对名字会被拒绝 |
| `docking_autostart` | `true` | 是否由 lifecycle manager 自动激活 docking server |
| `use_sim_time` | `false` | 仅仿真时设置为 `true` |

目标话题固定为 `/omni/cmd_vel/docking`，不提供改成 `/cmd_vel` 或 final topic 的
产品参数，避免绕开控制权、急停和 watchdog。

## 4. Docking 控制权协议

速度话题接通后仍不能直接运动。Docking 任务必须使用 `docking-` 前缀的唯一
client id 获取 Gateway 控制权，并在任务期间持续续租：

```bash
ros2 topic pub --once /rosdeck/control_command std_msgs/msg/String \
  "{data: 'acquire:docking-opennav'}"

# 任务运行期间保持；默认 lease 为 5 秒。
ros2 topic pub --rate 1 /rosdeck/control_command std_msgs/msg/String \
  "{data: 'heartbeat:docking-opennav'}"
```

只有 `/rosdeck/control_status` 返回 `acquired:docking-opennav` 后，仲裁器才会选择
Docking 输入。任务成功、失败或取消后都要停止 heartbeat 并释放控制权：

```bash
ros2 topic pub --once /rosdeck/control_command std_msgs/msg/String \
  "{data: 'release:docking-opennav'}"
```

任务管理器最终应自动完成 acquire、heartbeat、cancel、zero command 和 release，
以上命令只用于接口联调。

## 5. 使用第三方自带 launch 时的复用方式

如果后续 OpenNav 或自研 Docking 包提供了完整 launch，不要修改其源码，也不要把
它的输出改到 final topic。在产品 launch 中用 scoped remap 包住第三方 include：

```python
GroupAction(
    actions=[
        SetRemap(src="cmd_vel", dst="/omni/cmd_vel/docking"),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource("/absolute/path/to/docking.launch.py")
        ),
    ]
)
```

前提是第三方节点使用相对 `cmd_vel`。若其代码发布绝对 `/cmd_vel`，必须先通过其
官方参数或 launch remapping 改造并验证；不能假定上述相对 remap 会拦截绝对话题。

## 6. 启动前检查

1. systemd 运行脚本会先执行 fail-closed legacy guard：`pgrep` 不可用、进程枚举
   失败、发现 `zsibot_cmd_bridge`/`zsibot_sdk_proxy` 进程，或 active ROS install
   prefix 残留旧 SDK-owner binary 时都拒绝启动。
2. `flock` 只负责同一主机的进程互斥。RK3588 上的 legacy UDP proxy 与 Orin
   Gateway 不共享锁；产品运行前必须停止 RK proxy 和官方 SDK demo。
3. 确认 `/omni/safety/estop` 恰好有 1 个 supervisor publisher，且心跳频率高于
   Gateway 的 500 ms 监控超时。
4. 启动 Docking 后确认 `/omni/cmd_vel/docking` 恰好有 1 个 publisher；
   `/omni/cmd_vel/final` 只能由 Gateway 发布。
5. 确认 OpenNav 使用的 odom/base/dock frames 存在，时间同步正常，充电检测输入
   可用；任何一项未满足都不要 arm supervisor。

源码部署和离线包的 systemd 服务都必须执行 `product_bringup.launch.py`。不要把运行
脚本改回直接执行 `rosdeck_robot_bridge_node`，否则 safety supervisor 不会启动，
Gateway 会按 fail-closed 规则持续拒绝运动。

常用检查命令：

```bash
ros2 node list
ros2 topic info -v /omni/safety/estop
ros2 topic info -v /omni/cmd_vel/docking
ros2 topic info -v /omni/cmd_vel/final
ros2 topic echo /omni/cmd_vel/arbiter_status
ros2 topic echo /omni/safety/supervisor_status
```

## 7. 电池状态与充电确认

`/battery_state` 由 Bridge 合并内核 BMS 与厂商 SDK：

- 电压、电流、温度、`power_supply_status`、`power_supply_health` 和 sysfs
  `present` 来自 `/sys/class/power_supply`（1 秒 TTL 缓存；设备默认自动探测
  带 `voltage_now` 的 `Battery`，可用 `adapter_status.battery.power_supply_device`
  固定）；
- SDK 只提供 0–100 SOC，仍是 `percentage` 的主来源；SDK 采样过期时回落到
  sysfs `capacity`，而不是置空；
- `charging` 的判定优先级：BMS `power_supply_status`（CHARGING 确认，FULL
  视为已充满）> 带符号电流（阈值 `adapter_status.battery.charge_current_threshold_a`，
  符号 `adapter_status.battery.current_sign`）> SOC 趋势
  （`adapter_status.battery.soc_trend_*`，仅当 BMS 不报 status 时启用）；
- 充电连接状态由 BMS status 推导（CHARGING / FULL / NOT_CHARGING 表示充电器
  已连接）；
- 读取 fail-closed：power-supply 设备缺失或损坏时退回 SOC-only 行为
  （电气字段 NaN/UNKNOWN），不会报错。

Docking 的充电确认（`omni_docking` 的 ChargeMonitor）优先采用
`power_supply_status`：回桩后 BMS 报 CHARGING（或 FULL）即判定“确认充电”成功；
status 为 UNKNOWN 时回落到电流/功率推断，与旧行为一致。

实机验证步骤：

```bash
# 1. 确认 BMS 被读到（voltage/current/temperature 非 NaN，status 非 unknown）。
ros2 topic echo /battery_state --once

# 2. 诊断里核对电流符号：charging 时 battery_current_a 的符号应与
#    current_sign 一致；若 BMS 界面显示在充电而 VerifyCharge 报
#    “not charging”，把 adapter_status.battery.current_sign 翻为 -1.0。
ros2 topic echo /diagnostics --once

# 3. 自动探测到错误设备时固定设备名。
#    ros2 param set /rosdeck_robot_bridge adapter_status.battery.power_supply_device bat0
```

回桩—确认充电的验收：Docking 任务停稳后，在 `charge_window_sec`（默认 30 秒）
阶段窗口内等待一个新鲜（≤2 秒）的 `/battery_state` 采样确认充电，CHARGING/FULL
即成功；阶段窗口耗尽仍未确认，任务以 `CHARGE_NOT_CONFIRMED`（3005）失败，不会
无限重试。失败时先看 `/battery_state` 是否有新鲜采样（诊断里的 `battery_fresh`），
再看 `battery_status_source`（`sysfs` / `soc_trend` / `none`）定位是 BMS 未报
status 还是电流符号问题。

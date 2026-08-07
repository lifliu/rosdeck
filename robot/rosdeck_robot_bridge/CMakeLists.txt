cmake_minimum_required(VERSION 3.16)
project(rosdeck_robot_bridge)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(std_msgs REQUIRED)
option(ROSDECK_BUILD_VBOT_ADAPTER "Build the VBot service adapter" ON)

if(ROSDECK_BUILD_VBOT_ADAPTER)
  find_package(function_msgs QUIET)
  find_package(software_msgs QUIET)
endif()

add_executable(rosdeck_robot_bridge_node
  src/bridge_node.cpp
  src/zsibot_adapter.cpp
)
target_include_directories(rosdeck_robot_bridge_node PRIVATE include)
ament_target_dependencies(rosdeck_robot_bridge_node rclcpp std_msgs)

if(ROSDECK_BUILD_VBOT_ADAPTER AND function_msgs_FOUND AND software_msgs_FOUND)
  target_sources(rosdeck_robot_bridge_node PRIVATE src/vbot_adapter.cpp)
  target_compile_definitions(rosdeck_robot_bridge_node PRIVATE ROSDECK_HAS_VBOT_ADAPTER=1)
  ament_target_dependencies(rosdeck_robot_bridge_node function_msgs software_msgs)
  message(STATUS "Building Rosdeck VBot adapter")
elseif(ROSDECK_BUILD_VBOT_ADAPTER)
  message(FATAL_ERROR "VBot adapter requested, but function_msgs/software_msgs were not found")
else()
  message(STATUS "VBot adapter disabled for this build")
endif()

target_compile_options(rosdeck_robot_bridge_node PRIVATE -Wall -Wextra -Wpedantic)

install(TARGETS rosdeck_robot_bridge_node
  DESTINATION lib/${PROJECT_NAME}
)
install(DIRECTORY config launch
  DESTINATION share/${PROJECT_NAME}
)

ament_package()

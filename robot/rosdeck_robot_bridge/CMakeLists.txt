cmake_minimum_required(VERSION 3.16)
project(rosdeck_robot_bridge)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(std_msgs REQUIRED)
option(ROSDECK_BUILD_VBOT_ADAPTER "Build the VBot service adapter" ON)
option(ROSDECK_BUILD_ZSIBOT_ADAPTER "Build the Zsibot native SDK adapter" OFF)
set(ROSDECK_ZSIBOT_SDK_ROOT "" CACHE PATH "Path to the Zsibot SDK root")
set(ROSDECK_ZSIBOT_MODEL "zsl-1" CACHE STRING "Zsibot model: zsl-1 or zsl-1w")

if(ROSDECK_BUILD_VBOT_ADAPTER)
  find_package(function_msgs QUIET)
  find_package(software_msgs QUIET)
endif()

if(ROSDECK_BUILD_ZSIBOT_ADAPTER)
  if(NOT ROSDECK_ZSIBOT_MODEL MATCHES "^(zsl-1|zsl-1w)$")
    message(FATAL_ERROR "ROSDECK_ZSIBOT_MODEL must be zsl-1 or zsl-1w")
  endif()
  if(NOT ROSDECK_ZSIBOT_SDK_ROOT)
    message(FATAL_ERROR "ROSDECK_ZSIBOT_SDK_ROOT is required for the Zsibot adapter")
  endif()
  find_package(geometry_msgs REQUIRED)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64)$")
    set(ROSDECK_ZSIBOT_ARCH "aarch64")
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|amd64)$")
    set(ROSDECK_ZSIBOT_ARCH "x86_64")
  else()
    message(FATAL_ERROR "Unsupported Zsibot SDK architecture: ${CMAKE_SYSTEM_PROCESSOR}")
  endif()
  string(REPLACE "-" "_" ROSDECK_ZSIBOT_MODEL_LIB "${ROSDECK_ZSIBOT_MODEL}")
  find_library(ROSDECK_ZSIBOT_SDK_LIBRARY
    NAMES "mc_sdk_${ROSDECK_ZSIBOT_MODEL_LIB}_${ROSDECK_ZSIBOT_ARCH}"
    PATHS "${ROSDECK_ZSIBOT_SDK_ROOT}/lib/${ROSDECK_ZSIBOT_MODEL}/${ROSDECK_ZSIBOT_ARCH}"
    NO_DEFAULT_PATH
    REQUIRED
  )
  if(NOT EXISTS "${ROSDECK_ZSIBOT_SDK_ROOT}/include/${ROSDECK_ZSIBOT_MODEL}/highlevel.h")
    message(FATAL_ERROR "Zsibot HighLevel header is missing for ${ROSDECK_ZSIBOT_MODEL}")
  endif()
endif()

add_executable(rosdeck_robot_bridge_node
  src/bridge_node.cpp
  src/zsibot_adapter.cpp
)
target_include_directories(rosdeck_robot_bridge_node PRIVATE include)
ament_target_dependencies(rosdeck_robot_bridge_node rclcpp std_msgs)

if(ROSDECK_BUILD_ZSIBOT_ADAPTER)
  target_include_directories(rosdeck_robot_bridge_node PRIVATE
    "${ROSDECK_ZSIBOT_SDK_ROOT}/include"
  )
  target_link_libraries(rosdeck_robot_bridge_node "${ROSDECK_ZSIBOT_SDK_LIBRARY}")
  target_compile_definitions(rosdeck_robot_bridge_node PRIVATE ROSDECK_HAS_ZSIBOT_SDK=1)
  if(ROSDECK_ZSIBOT_MODEL STREQUAL "zsl-1")
    target_compile_definitions(rosdeck_robot_bridge_node PRIVATE ROSDECK_ZSIBOT_MODEL_ZSL1=1)
  else()
    target_compile_definitions(rosdeck_robot_bridge_node PRIVATE ROSDECK_ZSIBOT_MODEL_ZSL1W=1)
  endif()
  ament_target_dependencies(rosdeck_robot_bridge_node geometry_msgs)
  install(FILES "${ROSDECK_ZSIBOT_SDK_LIBRARY}" DESTINATION lib)
  message(STATUS "Building Rosdeck Zsibot adapter: ${ROSDECK_ZSIBOT_MODEL}/${ROSDECK_ZSIBOT_ARCH}")
else()
  message(STATUS "Zsibot SDK adapter disabled")
endif()

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

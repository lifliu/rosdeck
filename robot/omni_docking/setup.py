from glob import glob

from setuptools import setup

package_name = "omni_docking"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages",
            ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/launch", glob("launch/*.launch.py")),
        ("share/" + package_name + "/config", glob("config/*")),
        ("share/" + package_name + "/test", glob("test/*.py")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Rosdeck Maintainers",
    maintainer_email="maintainer@example.com",
    description="Charging-dock controller: Dock/Undock actions, DOCKING "
                "lease, /omni/cmd_vel/docking (V1).",
    license="Apache-2.0",
    tests_require=["unittest"],
    entry_points={
        "console_scripts": [
            "docking_node = omni_docking.docking_node:main",
        ],
    },
)
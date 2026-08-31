from glob import glob

from setuptools import setup

package_name = "omni_ws_gateway"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/test", glob("test/*.py")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Rosdeck Maintainers",
    maintainer_email="maintainer@example.com",
    description="TLS/WSS gateway for mobile access: device TLS, login, RBAC, audit.",
    license="Apache-2.0",
    tests_require=["unittest"],
    entry_points={
        "console_scripts": [
            "omni-ws-gateway = omni_ws_gateway.gateway_main:main",
            "omni-auth = omni_ws_gateway.omni_auth_cli:main",
        ],
    },
)

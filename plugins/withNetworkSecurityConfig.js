const {
  AndroidConfig,
  withDangerousMod,
  withAndroidManifest,
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = "network_security_config.xml";
const META_NAME = "android.net.http.NetworkSecurityConfig";

/**
 * Expo config plugin: trust user-installed certificates on Android.
 *
 * The omni_ws_gateway presents a self-signed device certificate. Android
 * 7+ ignores CAs the user adds in system settings unless the app opts in
 * via a network security config, so without this plugin the phone can
 * never trust the robot certificate. The plugin:
 *   1. writes res/xml/network_security_config.xml trusting system + user CAs
 *   2. references it from the <application> element of AndroidManifest.xml
 */
const CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

function withNetworkSecurityConfig(config) {
  config = withAndroidManifest(config, (config) => {
    const application =
      AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      META_NAME,
      `@xml/${CONFIG_FILE.replace(/\.xml$/, "")}`,
      "resource"
    );
    return config;
  });

  return withDangerousMod(config, [
    "android",
    async (config) => {
      const resDir = path.join(
        config.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml"
      );
      fs.mkdirSync(resDir, { recursive: true });
      fs.writeFileSync(path.join(resDir, CONFIG_FILE), CONFIG_XML);
      return config;
    },
  ]);
}

module.exports = withNetworkSecurityConfig;

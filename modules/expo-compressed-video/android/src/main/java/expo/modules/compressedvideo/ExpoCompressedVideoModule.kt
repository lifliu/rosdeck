package expo.modules.compressedvideo

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoCompressedVideoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoCompressedVideo")

    View(CompressedVideoView::class) {
      Prop("format") { view: CompressedVideoView, format: String ->
        view.setFormat(format)
      }

      AsyncFunction("pushFrame") { view: CompressedVideoView, data: String, presentationTimeUs: Double ->
        view.pushFrame(data, presentationTimeUs.toLong())
      }

      AsyncFunction("reset") { view: CompressedVideoView ->
        view.resetDecoder()
      }
    }
  }
}

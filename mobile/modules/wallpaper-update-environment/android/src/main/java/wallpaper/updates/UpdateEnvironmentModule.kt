package wallpaper.updates

import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.MessageDigest

class UpdateEnvironmentModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WallpaperUpdateEnvironment")

    AsyncFunction("getEnvironment") {
      val context = requireNotNull(appContext.reactContext) { "Android context is unavailable" }
      val info = context.packageManager.getPackageInfo(
        context.packageName,
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
      )
      @Suppress("DEPRECATION")
      val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
      val certificates = signatures.orEmpty().map { signature ->
        MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
          .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
      }.distinct().sorted()
      @Suppress("DEPRECATION")
      val versionCode = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
      mapOf(
        "platform" to "android",
        "applicationId" to context.packageName,
        "version" to info.versionName,
        "versionCode" to versionCode,
        "supportedAbis" to Build.SUPPORTED_ABIS.toList(),
        "sdkVersion" to Build.VERSION.SDK_INT,
        "certificateSha256" to certificates
      )
    }
  }
}

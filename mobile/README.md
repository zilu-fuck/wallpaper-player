# Wallpaper Player Mobile

Android-first React Native client for the Wallpaper Player remote API.

Current test build: `0.1.4`.

## Scope

This app matches `docs/mobile-client-remote-access-plan.md` stage 3 and assumes the desktop app exposes:

```text
GET  /v1/info
GET  /v1/library
GET  /v1/videos/:videoId/thumbnail
GET  /v1/videos/:videoId/stream
GET  /v1/videos/:videoId/metadata
GET  /v1/playback/:videoId
PUT  /v1/playback/:videoId
POST /v1/pairing/claim
DELETE /v1/devices/current
PUT  /v1/videos/:videoId/favorite
PUT  /v1/videos/:videoId/tags
PUT  /v1/videos/tags/bulk
POST /v1/videos/:videoId/play-on-desktop
POST /v1/videos/:videoId/reveal-on-desktop
POST /v1/videos/:videoId/transcode
GET  /v1/videos/:videoId/transcode
DELETE /v1/videos/:videoId/transcode
GET  /v1/transcodes
DELETE /v1/transcodes/cache
GET  /v1/videos/:videoId/transcoded-stream
GET  /v1/network-resources/:networkId/stream
GET  /v1/network-resources/:networkId/proxy
```

The scanner supports one-time QR pairing from the desktop settings panel. A scan creates a pending request on the desktop; the phone receives its device token only after the desktop user approves it. Manual endpoint + token pairing is kept for compatibility with older desktop builds.

The app can check for APK updates before pairing with a desktop. The player defaults to a black video background and can switch to cover background in mobile settings. Library filters support multi-tag intersection, including desktop system tags such as `R18` and custom tags confirmed from VLM analysis.

Desktop 1.4 network resources are visible in the mobile library as a virtual `网络资源` directory. The mobile player can stream direct and resolved network videos through the paired desktop, including proxied HLS segments. Desktop-only resource management still lives on the PC: adding network resources, webpage fallback playback, download center tasks, aria2, magnet selection, and Xunlei takeover are not built into the mobile app.

## Development

Source dependencies use Expo 58.0.17, React Native 0.88.0 and React 19.3.0. Use Node 22.13+ on the 22 line, 24.3+ on the 24 line, 26, or 27+; CI uses Node24. Existing APK files under `dist` are separate historical artifacts. After dependency changes, run `node ../scripts/run-verify.cjs node_modules/expo/bin/cli install --check` from this folder and regenerate the native project in an isolated ASCII checkout. SDK58 enables Android release minification by default, so validate a new release build and its actual playback before distribution.

The SDK58 patch checkpoint verifies a test-signed x86_64 APK upgrade from Expo58.0.14 to58.0.17 with the same retained binding and fresh authenticated requests after restart. It also rebuilds the changed native ABI and exercises video/fullscreen and an emulated camera. Expo's Xcode4 consumer no longer needs the previous scoped UUID override. See `../docs/evidence/r8-sdk58-patches.json` for the exact source snapshot: concurrent DeepSeek frontend changes made after the build are preserved and need their own rebuild/validation. This checkpoint does not accept production signing, physical-device or iOS native delivery.

```bash
cd mobile
npm install
npm run android
```

For a native Android project:

```bash
cd mobile
npx expo prebuild --platform android
```

`mobile/android/` is ignored because it is generated.

Node build tooling carries local node-forge signature and braces depth patches in `patches/dependency-patches.json`. Normal `npm install` / `npm ci` applies them through `postinstall`; `prestart` and `preandroid` verify the reviewed source digests. After installing with `--ignore-scripts`, run `npm run patch:dependencies` before starting or invoking Expo CLI directly. Keep `scripts/` and `patches/` with this package when copying a build checkout. Version, integrity or unexpected source changes fail installation and need patch review; upstream updates must pass the full signature/depth regressions before retiring the local checks. Restart existing Node development processes to load changed dependency code. Packages keep their official versions, so npm audit still reports the advisories. See `../docs/dependency-governance.md` for evidence and remaining work.

The braces patch deliberately rejects brace/parenthesis patterns and supplied ASTs beyond100 container levels. `maxDepth` may lower that cap; callers must handle its validation errors. Expansion derives queues from actual child traversal and ignores external `parent` metadata. It does not prove general regex or cartesian-expansion resource bounds. The isolated tooling export uses the preceding verified application snapshot; concurrent DeepSeek frontend work is preserved for separate validation.

## Verification

Run the automated desktop/mobile LAN checks from the repository root:

```bash
npm run verify:mobile-lan
npm run verify:remote-pressure
npm run build
cd mobile && npm run typecheck
```

`verify:mobile-lan` also runs the transcode command and transcode concurrency checks.

Release mode, signing policy and artifact checks are documented in [release delivery](../docs/release-delivery.md). The retained0.1.4 APK uses an Android Debug certificate and versionCode5; the joint-release gate remains blocked pending a reviewed production identity/upgrade migration and versionCode increment. Local QA signing is separate from production upgrade acceptance.

The update selector now consumes schemaVersion1 manifests and searches older stable releases when newer desktop releases contain no APK. It matches the actual installed Android application/signing identity, versionCode, supported ABI and SDK through the local `modules/wallpaper-update-environment` Expo module. Keep `modules/` with build checkouts and regenerate/rebuild the native application after this change; Expo Go or a previously built APK cannot supply this module. No dependency version or native package identity was changed for this feature.

Historical0.1.4 uses a pinned metadata record checked against the public asset SHA256/size. Unknown newer APKs, invalid manifests, incompatible identities and incomplete scans return errors. iOS receives no APK recommendation. Metadata requests share a15-second deadline, bounded streaming bodies and optional caller cancellation. This checks update metadata and opens an official URL; it does not download, hash or install the APK.

Checks automatically capture the current subscribed navigation device/binding, load only that credential and freshly confirm the PC identity/authorization. The result must satisfy both `APK.minServerProtocol <= PC.protocolVersion` and `APK.clientProtocol >= PC.minClientProtocol`. The publisher derives `clientProtocol` from the built shared contract; older manifests without it conservatively count as1. An outdated client can inspect an authenticated update context without relaxing ordinary playback connection negotiation. No protocol/endpoint result is persisted or reused as another device's context.

Switches, removal/re-pairing and navigation unmount invalidate a pending check; returning to the same PC does not revive it. Same-PC screen transitions retain the scope, and a departing shared confirmation consumer does not cancel the others. Global/device-list checks retain a fixed protocol1 baseline and do not scan all paired computers. Explicit protocol values cannot override a focused PC's fresh proof. Existing screen components and call signatures are unchanged; `npm run verify:update-context` covers ownership and real localhost HTTP races. The isolated native checkpoint uses synthetic future-protocol metadata, not a deployed protocol3 client/server upgrade.

Run `npm run verify:mobile-updates` at the repository root for the real release-producer/consumer contract, desktop-only fallback, platform/identity/protocol/version checks, cancellation and local HTTP streaming regressions. Its public release snapshot is committed under `scripts/fixtures/`, so CI does not require live GitHub access.

Real-device acceptance, including Android/iOS safe areas, native fullscreen, low-memory behavior, and 60-minute LAN playback pressure, is tracked in `docs/mobile-real-device-qa.md`.

For Android evidence capture with `adb`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\qa-mobile-real-device.ps1 -DurationMinutes 60 -DesktopBaseUrl http://PC_LAN_IP:38127
```

# Wallpaper Player Mobile

Android-first React Native client for the Wallpaper Player remote API.

## Scope

This app matches `docs/mobile-client-remote-access-plan.md` stage 3 and assumes the desktop app exposes:

```text
GET  /v1/info
GET  /v1/library
GET  /v1/videos/:videoId/thumbnail
GET  /v1/videos/:videoId/stream
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
GET  /v1/videos/:videoId/transcoded-stream
```

The scanner supports one-time QR pairing from the desktop settings panel. A scan creates a pending request on the desktop; the phone receives its device token only after the desktop user approves it. Manual endpoint + token pairing is kept for compatibility with older desktop builds.

## Development

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

## Verification

Run the automated desktop/mobile LAN checks from the repository root:

```bash
npm run verify:mobile-lan
npm run verify:remote-pressure
npm run build
cd mobile && npm run typecheck
```

`verify:mobile-lan` also runs the transcode command and transcode concurrency checks.

Real-device acceptance, including Android/iOS safe areas, native fullscreen, low-memory behavior, and 60-minute LAN playback pressure, is tracked in `docs/mobile-real-device-qa.md`.

For Android evidence capture with `adb`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\qa-mobile-real-device.ps1 -DurationMinutes 60 -DesktopBaseUrl http://PC_LAN_IP:38127
```

# Dependency Governance

Last recorded dependency checks: 2026-10-23. Results below are phase-specific; local backports do not change official audit metadata.

## Commands

Run checks against the official npm registry from both project roots:

```powershell
npm audit --json --registry=https://registry.npmjs.org/
npm audit --omit=dev --json --registry=https://registry.npmjs.org/
cd mobile
npm audit --json --registry=https://registry.npmjs.org/
npm audit --omit=dev --json --registry=https://registry.npmjs.org/
```

The configured npmmirror registry does not implement audit endpoints. Audit totals count affected packages, including propagated dependency findings; they do not by themselves prove exploitability or shipment in an artifact.

## R1 Result

Root js-yaml was updated from 4.2.0 to 4.3.2 without changing the Electron or Vite runtime. The lockfile changed only that dependency. It is used by electron-updater as well as packaging tools.

- Root production audit after the update: 0 vulnerabilities.
- Root full audit after the update: 21 affected packages, including 1 critical, 11 high, and 9 moderate.
- Mobile review baseline: 34 affected packages, including 1 critical, 25 high, and 8 moderate, for both full and omit-dev scopes. No mobile dependency updates have been applied in R1.

The full root tree includes tar tooling risks. The mobile tree includes Expo / Metro / prebuild tooling and shell-quote risks; assess the native bundle and CI execution paths separately. Electron is a devDependency but ships as the desktop runtime and must remain in the runtime risk assessment.

Run `npm run verify:update-metadata` to verify release YAML parsing and the patched empty merge-source work limit. The CI core job now runs this verification.

## R8 compatible transitive patches, first batch

On 2026-10-19, selected leaf dependencies were updated within their existing parent ranges: 20 installed package paths in the desktop tree and 15 in the mobile tree. Direct dependency declarations and versions, including Electron 35.7.5, Vite 6, Expo 56.0.12, React Native 0.85.3 and the native Expo modules, remain unchanged. No overrides or forced audit repair were used. The two new root npm scripts are verification entry points.

| Scope | Before: critical / high / moderate / total | After: critical / high / moderate / total |
| --- | --- | --- |
| Desktop full tree | 1 / 11 / 9 / 21 | 0 / 2 / 8 / 10 |
| Desktop omit-dev | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Mobile full tree | 1 / 25 / 8 / 34 | 0 / 17 / 7 / 24 |
| Mobile omit-dev | 1 / 25 / 8 / 34 | 0 / 17 / 7 / 24 |

The desktop tar dependency moved from 7.5.16 to 7.5.22; mobile shell-quote moved from 1.8.4 to 1.12.0 and js-yaml from 4.2.0 to 4.3.2. Other changes include the compatible XML parsers, brace expansion, PostCSS, source-map-js, browserslist data and HTTP tooling patches. See the [tar advisory](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) and [shell-quote advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) for the upstream threat conditions; audit counts are affected package counts, not demonstrated application exploits.

`npm run verify:dependency-security` exercises the actual electron-builder/node-gyp tar resolution, gzip archives with Unicode paths, a bounded numeric PAX/negative-size extraction in a timed child, and YAML merge work limits. `npm run verify:dependency-security-mobile` checks the React Native devtools quoting dependency (four line terminators after comment tokens), both plist consumers and the mobile YAML parser. Both are guarded and now run in CI after the corresponding dependency installation.

Installed versions were checked against the lockfiles and both `npm ls --all` trees passed. The first install attempt trusted a stale npm hidden lock despite older files still being present. Only the two hidden metadata files were moved into the isolated evidence directory; installation was rerun and all 35 changed installed paths were verified. No changed dependency has an install lifecycle script. Desktop build, actual Electron ASAR smoke, remote library, privacy passwords, update metadata, mobile typecheck, Expo prebuild config and freshly generated Android/iOS Hermes bundles passed. This does not establish native decoding, signed installation or physical-device stability.

Remaining desktop findings include the unsupported Electron 35 runtime, extract-zip and the packaging download/proxy chain. Remaining mobile findings include Metro/braces/image-size, node-forge and the xcode/uuid prebuild chain. Some audit `fixAvailable: true` entries are propagated repair suggestions, not proof that updating that leaf within every existing parent range resolves the issue; the targeted image-size update did not change its locked 1.2.1 version. Wrapper/runtime upgrades and parent constraints still require separate review. Do not downgrade Expo/RN/builder to make the counter disappear.

Electron's [support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines#version-support-policy) covers the latest three stable major versions. Official npm metadata checked on this date lists 44.9.0 as stable latest, with 42/43/44 as the supported lines. The [Electron 44 release notes](https://www.electronjs.org/blog/electron-44-0) include asynchronous clipboard APIs and removal of Windows ia32 binaries; the runtime upgrade must review application APIs and supported architectures before adoption. No Electron upgrade is claimed in this batch.

Frozen totals, package-path changes, installed version checks, source and raw audit digests, bundle measurements and the unchanged 42-file fallback inventory are recorded in [R8 dependency evidence](evidence/r8-dependency-patches.json).

## R8 Electron runtime upgrade

Electron is now pinned to **44.9.0**, upgraded from 35.7.5. The installed Windows x64 runtime reports Chromium 152.0.7977.167, Node 24.22.0 and V8 15.2.124.43-electron.0. Vite, electron-builder, mobile dependencies and their lockfile were not upgraded in this batch. The full desktop audit is now **8 moderate / 0 high / 0 critical**; omit-dev remains 0. The eight remaining findings concern the builder download/proxy dependency chain. The first-batch table above is historical; the mobile audit was not rerun because its dependency tree did not change.

The [versioned upstream change list](https://raw.githubusercontent.com/electron/electron/v44.9.0/docs/breaking-changes.md) was reviewed for versions 36–44. Remote endpoint, legacy-token and pairing-code IPC handlers now wait for clipboard completion before returning success. Native write rejection reaches the existing error path; tray copying handles its rejected promise. Renderer logging uses the current console event fields. No first-party renderer directly imports clipboard APIs. Node.js 22.12+ is required for development, with Node 24 in CI. `npm run electron:install` explicitly prepares the binary before CI verification; normal first use can still acquire it through Electron's own loader.

`verify:electron-runtime` tests delayed/rejected clipboard promises, disabled legacy copying and invalid pairing input, then starts the real `main/index`, window, preload and current frontend in a fresh Chinese/space profile. It verifies bridge calls, the actual settings worker, current console fields, native rendering and persisted primary/backup after graceful exit. It never reads or changes the user's native clipboard. Core CI and the release verification job run it after the frontend build. Source/frame/installer/player, settings recovery, plugins, API types, remote library, identity/passwords, updater and mobile service/type regressions passed locally; CI jobs themselves were not dispatched.

An actual Windows x64 directory build used the production package configuration and existing vendor resources in a new ASCII QA directory, with publication and signing/resource-branding disabled. The executable loaded its real ASAR, discovered a generated five-second silent H.264 file, advanced mpv playback, captured a 320×180 decoded video frame into its own portable data directory, stopped playback, saved settings/progress and exited with code 0. The shipped application modules were checked against current sources. The existing `release/` artifacts were not replaced. This is an unsigned directory build, not a signed installer, coverage of all codecs or a long-running performance result.

The first source screenshot attempt had no hidden-window Viz surface; rendering without taking focus corrected the probe. A first packaged diagnostic attempt also showed that packaged Electron ignores arbitrary `NODE_OPTIONS --require` preloads. The final packaged check therefore uses the real portable entry, CDP over localhost and persisted profile files; it does not claim packaged test-guard preload protection. Only the owned failed QA process tree was terminated, and the final run exited normally. All 42 original project fallback files remain byte-identical.

Windows ia32 is no longer offered by upstream Electron 44. The local evidence covers Windows x64; native macOS/Linux/arm64, dialog UX changes, physical mobile decoding, signing, update delivery and long-running resource budgets remain outside this check. See the [frozen runtime evidence](evidence/r8-electron44.json), [packaged frontend capture](evidence/r8-electron44-packaged-window.png) and [actual decoded video frame](evidence/r8-electron44-video-frame.png).

## R8 Vite 8 build-chain upgrade

Vite is pinned to **8.3.4** (from 6.4.3) and `@vitejs/plugin-react` to **6.1.2** (from 4.7.0). React, React DOM, Electron, mobile dependencies and native modules retain their versions. `@babel/core@7.29.7`, already used by the profiling verifier, is now an explicit devDependency rather than an accidental React-plugin transitive dependency. React Compiler was not enabled.

The [v6-to-v7](https://v7.vite.dev/guide/migration) and [v7-to-v8 migration guidance](https://vite.dev/guide/migration) informed the change. Build options now use `rolldownOptions`; obsolete CommonJS include options were removed from production and the two programmatic UI builds. Production remains relative-base output for Electron file/ASAR loading.

The new real development probe exposed a shared CommonJS named-export failure. Listing absolute files in prebundling did not fix relative imports. Four desktop runtime modules now import the existing package names `@wallpaper/contracts` and `@wallpaper/domain`; one shared TypeScript paths file and its small resolver feed Vite, typechecks and the test loader. Vite explicitly prebundles these names, following the [linked CommonJS dependency guidance](https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies). This introduces neither workspaces nor a package-directory move, and Node/mobile keep their existing CommonJS entry points.

`verify:vite-dev` runs the real project config, both shared packages and a React counter in isolated Electron over a loopback dev server. Editing its own component updates the label while preserving counter state; it is now a core CI gate. The existing full-runtime gate additionally imports all six production lazy modules from file URLs. API types, profiler/settings/initialization/feed/responsive/player tests, shared contracts, query/media/HTTP/privacy/update and mobile correctness/type checks passed locally. An actual new Windows x64 directory build loaded the current ASAR, displayed its generated library item, played silent H.264, captured a decoded frame, saved and stopped normally. Remote CI was not dispatched.

| Production asset | Before bytes | After bytes |
| --- | ---: | ---: |
| Main JavaScript | 418,306 | 404,018 |
| Main CSS | 183,515 | 177,702 |
| All JS/CSS assets | 776,366 | 753,600 |

The initial workspace old-dist snapshot was unavailable. The old bundle above was instead recovered from the previous Electron-44 directory-build ASAR only after its whole-file SHA256 matched frozen evidence; the before package/lock snapshots also match that stage. These are artifact byte comparisons, not a startup/frame-rate or controlled build-speed claim. The current [packaged frontend capture](evidence/r8-vite8-packaged-window.png) was inspected.

The official desktop audit remains 8 moderate, 0 high, 0 critical, and omit-dev 0. Mobile audit was not repeated; its lock and generated shared modules are unchanged. The original 42 fallback files remain byte-identical. No release artifacts were replaced or published, and signing, other dependencies, physical-device/native budgets and the rest of R8 remain open. Full conditions, raw digests and before/after files are in [the Vite 8 evidence](evidence/r8-vite8.json).

## R8 Expo 57 intermediate checkpoint

On 2026-10-19 the mobile app moved from SDK56 to exact Expo 57.0.30 / React Native 0.86.3, with the SDK's compatible native modules and React 19.2.3. This is the verified intermediate step recommended by the [incremental upgrade guide](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/); SDK58 remains the migration target. Desktop dependencies did not change in this step. Official full-tree mobile audit changed from 24 (17 high / 7 moderate) to 22 (15 high / 7 moderate), with zero critical. The remaining build/native dependency findings are not closed.

Typecheck, Expo install compatibility, Doctor 21/21, eight mobile behavior checks and both current-source Hermes exports passed. An isolated Android API36 / x86_64 native release build using Gradle9.3.1 and JDK21 passed 353 tasks. Its distinct QA package uses a debug test certificate. On the owned emulator, the actual app paired with an isolated loopback production desktop server, loaded an authenticated library and decoded silent H264; progress advanced, pause worked, and after force-stop SecureStore credentials authenticated new library requests. Final UI verification reused the real preceding binding across helper retries, with no injected credentials. [Checkpoint evidence](evidence/r8-expo57.json) contains artifact/source digests and the exact scope.

The original 42 fallback files remain identical. Prebuild's missing expo-system-ui warning for dark appearance is pending SDK58 evaluation. Physical devices, arm64/performance budgets, iOS native builds, production signing and upgrade-install remain unaccepted. The SDK58 migration and the rest of R8 continue.

## R8 Expo 58 optimized native checkpoint

After the verified SDK57 step, mobile source now pins Expo58.0.14 / React Native0.88.0 / React19.3.0 with its compatible native modules and supported Node engines. expo-system-ui58.0.6 satisfies the dark-appearance prebuild requirement. Default strict RN types remain enabled. Removed APIs were migrated to bounded/cancellable idle sorting, current public list tokens, boolean application activity and one Expo status-bar owner. Actual component/HTTP checks verify latest-sort dispatch and unmount cancellation. SDK dependency compatibility checks now run after installation in core CI and both release verification/APK paths; remote CI was not dispatched.

Typecheck, compatibility, Doctor20/20, 11 behavior/security checks and both current-source Hermes exports passed. A real x86_64 Android release APK retains default R8 minification and a nonempty mapping, using JDK21, checksum-verified Gradle9.4.1, compile API37 and target API36. Its 387 tasks passed; the 35,945,277-byte APK uses a separate QA id and Android Debug test key. A Windows-only config plugin sets CMake object path max250, fixing Ninja failures from the upstream1024 bound; the first220 attempt was too small for generated directory/hash/file names. Actual regeneration and repeat prebuild produce the exact successful APK Gradle configuration without changing OS policy.

On the owned API36 emulator the optimized app opened/cancelled the emulated camera, paired with a private loopback production server, authenticated the library, decoded/paused silent H264, entered actual landscape and returned to portrait, then restored SecureStore credentials after force-stop for fresh authenticated requests. First camera authorization currently needs another scan tap because the permission Activity triggers existing background cancellation; that UX remains open. Device display settings were restored, the fixture/AVD stopped, and the original42 files are unchanged. [SDK58 evidence](evidence/r8-expo58.json) records artifact/input digests, exact checks and limitations.

Official complete-tree mobile audit stays22 (15high / 7moderate / 0critical), including build-tool paths; SDK58 did not clear these findings. Physical arm64/performance, production signing/upgrade-install, iOS27 native/scene/window resizing and other R6/R7/R8 conditions remain unaccepted. Existing distribution artifacts were not replaced or published.

## R8 scoped Xcode UUID fix and bundle boundary

On2026-10-19, SDK58's22 entries resolve to three underlying advisories: braces, node-forge and UUID. The first two have no official patched release at this checkpoint. UUID11.1.1 is patched and retains CommonJS. Because xcode3.0.1 only invokes uuid.v4 without arguments, mobile now scopes an exact uuid11.1.1 override to xcode@3.0.1. Only node_modules/uuid changes from7.0.3 to11.1.1; direct SDK/native dependencies stay as verified. Official full-tree audit changes22→15, removing7moderate parent/direct entries for one UUID advisory, with15high and0critical remaining. [UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [patched release](https://github.com/uuidjs/uuid/releases/tag/v11.1.1).

The installed Expo/Xcode consumer passes128 reference generations,18 invalid Buffer/Uint8Array bounds cases and6 valid writes preserving sentinels. An actual Expo iOS Xcode mod/compiler modifies the official SDK58 template with Swift source, a resource and build phase; five generated references survive serialization and reparsing. This is project generation, not Xcode/native/signing acceptance. Typecheck, SDK compatibility, Doctor20/20, desktop security and library/privacy/update/mobile regressions pass.

Both current-source Hermes exports contain none of braces/node-forge/xcode/uuid. The bundle verifier now rejects shipping the two unresolved advisory packages; core CI runs it alongside the consumer gate, and release verification/APK jobs now run mobile consumer security checks. This does not close the Node development/build-tool exposure. No replacement APK was built:76 native code/plugin/shared inputs and app.json match the previous native checkpoint. Original42 files and desktop package/lock hashes remain unchanged. Remote CI and publishing were not invoked. [Evidence](evidence/r8-xcode-uuid.json).

Remaining15high findings are propagated from [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) and [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv); their risk remains open pending further remediation/backport and input-path review. Device, signature, iOS native and other R6/R7/R8 conditions also remain open.

## R8 node-forge local backport and install persistence

This batch started2026-10-19 and completed checks2026-10-23. The registry still reports node-forge1.4.0 latest and the [advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) has no fixed release. The referenced [unmerged candidate](https://github.com/digitalbazaar/forge/pull/1152), commit ceba34402e329f0365134f23fe19898756527d65, adds nested element-count checks. Generated-key experiments showed it still accepts nonempty NULL values and noncanonical OID bytes; the local patch adds those two checks explicitly. This is locally reviewed hardening, not an upstream release or an assertion that every cryptographic path is proven safe.

The installed source changed from SHA256 fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50 to c8faa8c5791709964268836ba90d3f7ac47311fccc0b6b52b6fc09f2a34112fd. The manifest pins version/integrity and before/after digests; postinstall applies atomically and checks reject unknown sources, versions, nested copies and linked paths. Normal npm start/android entry checks prevent using a missing backport. Explicit ignore-scripts/direct-CLI workflows must apply it manually. Fresh complete mobile npm ci, missing-patch rejection, repeated application, path/ADS/junction and hardlink preservation checks pass through the existing CI security gate.

Tests use only in-memory generated2048-bit keys with exponents3/65537. They reject36 malformed encodings, preserve6 outer rejections, reject12 actual Expo certificate/CSR cases, and preserve6 canonical Node/OpenSSL signature interop,2 PSS and2 normal Expo signing flows. Six omitted-NULL inputs retain existing Forge API acceptance but are rejected by OpenSSL; they are not counted as canonical interoperability. No user credential files were used. [Evidence](evidence/r8-forge-backport.json) records both earlier candidate behavior and final results.

Typecheck, relevant desktop/mobile regressions and both Hermes exports pass; braces/node-forge remain excluded from the current device bundles. No dependency versions or native application code changed, no replacement APK was made, and the original42 files and desktop manifest/lock remain identical. Audit still reports15high because official versions are unchanged; braces and upstream metadata remain open. On2026-10-23 Doctor is19/20 and install compatibility reports five newer SDK58 patch requirements (Expo17, camera12, clipboard4, status-bar4, video12). Those checks are explicitly pending a separate runtime/native patch phase, not ignored or presented as passing. Other native/signing/device and R6/R7/R8 conditions remain open.

## R8 SDK58 recommended patches and test-signed upgrade

On2026-10-23, Expo is pinned to58.0.17 and its recommended camera12, clipboard4, status-bar4 and video12 patches are aligned. React Native0.88.0 and React19.3.0 stay unchanged. The lock changes41 package paths, including added/removed optional tools and Expo/config/Metro/native transitive dependencies; this is not merely five isolated leaf updates. expo-modules-core58.0.24 and jsi58.0.17 require a new native build. Full differences and actual installed versions are frozen in [patch evidence](evidence/r8-sdk58-patches.json).

The official parent now brings xcode4.0.0, which uses node:crypto.randomUUID and has removed its UUID package dependency. The obsolete xcode3 scoped override and tests of its retired UUID buffer APIs are removed. The current consumer still generates128 unique24-hex references, and the actual Expo iOS mod/compiler adds Swift source, a resource and a build phase to the official template; five new references survive serialization/reparse. This is engineering-file validation, not an iOS native build. The complete Forge signature and patch-installer checks remain and pass; normal installation reapplies the same reviewed c8faa8c5… file digest.

Compatibility, Doctor20/20, typecheck, npm ls --all,11 mobile/service regressions, dependency consumers and both Hermes exports passed before the concurrent frontend work. Android/iOS bytecode sizes are3,093,068 /3,088,260; one React19.3.0 per bundle, with braces/node-forge excluded. The configured mirror did not implement audit; an explicit official-registry retry reports15high/0moderate/0critical. The local Forge patch does not falsify package versions or remove advisory metadata; braces remains unresolved.

An isolated JDK21 / Gradle9.4.1 build executes387 tasks, including real R8 minification, for compile API37/target36 and x86_64. The35,964,737-byte APK is verified against the installed APK hash. On the retained owned API36 AVD, package-manager upgrade5→6 uses the same Android Debug test certificate. The original binding authenticates fresh protected library requests without pairing; H264 playback/pause, actual landscape/back, emulated camera open/cancel and restart authentication pass, with a new acknowledged playback checkpoint. Clipboard contents were neither read nor written; new iOS-only APIs are not directly covered.

The APK uses80 frozen native inputs, including the unchanged76 prior code/plugin/shared inputs and the new install-patch files; its QA config overrides only name/id/versionCode. The user confirmed DeepSeek is concurrently optimizing the frontend. Those later edits are preserved and recorded as drift from the tested snapshot, not folded into this APK acceptance. Original42 data files and desktop manifest/lock hashes remain identical; the fixture flushed/stopped and owned AVD/display were restored. Distribution artifacts and remote CI were not replaced/dispatched. Production signing/upgrade, physical arm64 budgets, iOS native, first camera-permission UX and the rest of R6/R7/R8 remain open.

## R8 braces depth and supplied-AST queue isolation

On2026-10-23, [the advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) still has no patched release and the official registry latest is3.0.3. The local patch adapts the five runtime files from [unmerged PR87](https://github.com/micromatch/braces/pull/87), commit d44b9b1ee12e7804d4232d5a47a4a0c61d2fbefe. Brace/parenthesis input and recursive AST depth are capped at100; maxDepth can lower the cap. String inputs raise a deliberate SyntaxError and AST walkers a deliberate RangeError. Callers must handle those errors. This intentionally rejects nesting beyond100 and is not an upstream release.

Independent bounded children reproduced26 native stack errors and one parent-cycle timeout in the original41-case control. The referenced candidate guarded38 cases but still overflowed when an external parent queue contained nested arrays. The local extension derives expansion queues only from actual child traversal, so foreign parent cycles, getters and queues are not consulted. [PR82's discussion](https://github.com/micromatch/braces/pull/82) describes the related queue-ownership approach; its separate range/expansion changes are not imported. Final strict checks pass44 probes with a reduced512KiB Node stack:41 deliberate depth rejections and3 safe metadata-isolation returns, plus boundary/options/ordinary API checks.

The official3.0.3 tag's12 test files pass764 tests with0pending/0failures using the five patched runtime files. Their Bash reference tables use stored expected values; no separate Bash oracle was spawned.660 bounded ordinary patterns yield15,840 API comparisons and1,980 existing-AST sequence comparisons against pristine npm3.0.3, with no unexpected difference. Full results and before/after hashes are in [the phase evidence](evidence/r8-braces-depth.json); the original [MIT notice](../mobile/patches/licenses/braces-MIT.txt) is retained.

The installer now verifies installation paths for every managed package, preflights all files before the first atomic replacement and preserves literal dollar tokens via a replacement callback. Existing link/path/hardlink checks remain; multi-file idempotence, late-source rejection and nested braces-copy rejection are added. Full isolated npm ci with ignore-scripts rejects missing patches; normal npm ci automatically applies all6 files (5braces plus the unchanged Forge patch), and check/repeated application pass. Both packages' consumer checks pass again in that fresh tree.

The declared path is Metro-file-map→micromatch→braces. Actual tested Metro watcher matching uses micromatch.some/picomatch without invoking braces, while direct micromatch parse/braces/braceExpand probes exercise the patched dependency. No direct application imports were found in the inspected main/mobile sources. This is Node tooling hardening, not evidence of a remotely exploitable product endpoint or general regex/expansion-resource bounds. Fresh patched Metro exports Android/iOS Hermes from the preceding verified UI snapshot; typecheck and SDK compatibility pass, and both advisory packages remain absent from the runtime bundles. DeepSeek's ongoing frontend changes are preserved and excluded from that acceptance.

Desktop/mobile manifests and locks, plus the original42 data files, remain identical. Official audit remains15high/0moderate/0critical because package versions are unchanged. Existing development processes were not restarted; cached dependency code needs a new Node process. No APK, release artifact, publishing or remote CI was produced. Broader input/resource boundaries, upstream official fixes, frontend integration, physical/native/signing and remaining R6/R7/R8 gates stay open.

## R8 complete-candidate release and signing readiness

On2026-10-23, release.yml now performs tag/signing preflight, reuses the entire core/LAN CI at the same commit, builds Windows and requested Android artifacts independently, and grants write permission only to the final publisher. Requested Android failure prevents publication; desktop-only mode explicitly accepts a skipped native Android job. The runtime status gate covers512 combinations, with actionlint1.7.12 and107 PowerShell script parses. CI's remaining bare download verifiers now use the data-protected runner.

Windows collection checks PE/version/Authenticode, update YAML SHA512/size and all three plugin archive hashes; packaging explicitly targets x64. Android uses JDK21/API37/arm64, regenerated contracts, temporary release-key signing and actual APK certificate/application/versionCode/ABI checks. The publisher rechecks transferred files and generates a platform/version/protocol/hash/signature manifest, creates an owned draft, downloads every asset to verify it, then publishes. Identical candidates can resume or be read-only verified after publication; unowned releases are not clobbered. GitHub transport is tested through an injected adapter, not a real release.

Read-only historical checks found Windows1.4.0 artifacts unsigned, and the retained Android0.1.4 APK uses Android Debug certificate fac61745… with versionCode5. The current source also has code5. Android policy remains migration-required; a desktop preflight passes and the current joint preflight deliberately rejects. Windows signing is record-only by existing policy, with optional required identity enforcement implemented. Neither platform has production signing/upgrade acceptance. Actual Java re-signing with a new two-day QA key, bad-certificate/tamper rejection and temporary-key deletion pass; no user key was used.

The original42 data files, retained artifacts, mobile manifest/config and both locks remain identical; the root manifest only adds a guarded verification alias. Release/data isolation/update/plugin checks pass. No new production app, cloud CI, draft or release was created. The manifest producer does not fix mobile update discovery/selection yet; frontend ownership remains with DeepSeek. [Operator documentation](release-delivery.md) and [frozen evidence](evidence/r8-release-gate.json) describe the limits and pending real signing, cloud/native/device and local packaging work.

## Upgrade Policy

- Apply compatible security patches separately and verify their actual consumers.
- Electron, Vite, and Expo / React Native major upgrades each need a separate change and runtime smoke tests. Select supported Electron releases and an SDK-compatible Expo module set when implementing R8.
- Do not automatically accept npm audit repair suggestions that downgrade Expo, React Native, or electron-builder, or force a major runtime change.
- Retain the lockfiles and rerun audit after each dependency change; do not replace an audit result with an inferred clean status.
- Local security backports pin the package integrity and reviewed source hashes, must survive fresh install, and retain advisory metadata. Reassess upstream changes and the complete signature regressions before changing or retiring the patch; do not silently accept unknown sources.
- Build, remote library flows, privacy, update metadata parsing, and mobile typecheck are the minimum checks appropriate to the relevant dependency change. Packaging and real-device checks are required for runtime or native upgrades.

The current desktop/mobile review and phased implementation status are recorded in [the refactor plan](desktop-mobile-review-and-refactor-plan.md) and [implementation record](refactor-progress.md).

# Dependency Governance

Last checked: 2026-07-02

## Commands

Run dependency drift checks from both project roots:

```powershell
npm outdated --json
npm audit --omit=dev --json --registry=https://registry.npmjs.org/
cd mobile
npm outdated --json
npm audit --omit=dev --json --registry=https://registry.npmjs.org/
```

The configured `npmmirror` registry does not implement npm audit endpoints, so audit checks must use the official npm registry explicitly.

## Current Status

Root app:
- Production audit: 0 vulnerabilities.
- Outdated major toolchain packages: `electron` 35.7.5 -> 43.0.0, `vite` 6.4.3 -> 8.1.3, `@vitejs/plugin-react` 4.7.0 -> 6.0.3.

Mobile app:
- Production audit: 10 moderate advisories, all through Expo CLI/config/prebuild transitive tooling. `npm audit fix` suggests an invalid downgrade path to Expo 46, so do not apply it automatically.
- Outdated Expo/RN stack packages include `expo` 56.0.12 -> 57.0.1, Expo modules 56.x -> 57.x, `react-native` 0.85.3 -> 0.86.0, `lucide-react-native` 1.21.0 -> 1.23.0, `react-native-svg` 15.15.4 -> 15.15.5.

## Upgrade Policy

- Patch and minor updates can be batched after `npm run build`, `npm run verify:mobile-lan`, and `cd mobile && npm run typecheck` stay green.
- Major toolchain updates must be split by runtime: Electron, Vite, and Expo/React Native should each get a separate branch with smoke tests.
- Do not run automatic audit fixes when npm proposes a downgrade or a semver-major runtime change.

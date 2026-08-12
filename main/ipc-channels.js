// IPC 通道名的唯一事实来源。
// handler（main/ipc/*）、preload.js 必须引用这里的常量，禁止手写字符串。
// 注意：官方插件（video-analysis / ai-search）的通道定义在其插件目录内，
// 插件打包时目录外文件不可达，故插件通道不在本表中，由插件自带。

const IPC = {
  // 扫描与媒体
  SCAN_DIRECTORY: 'scan-directory',
  GENERATE_THUMBNAIL: 'generate-thumbnail',
  GET_THUMBNAIL_URL: 'get-thumbnail-url',
  GENERATE_PREVIEW_FRAME: 'generate-preview-frame',
  GET_VIDEO_METADATA: 'get-video-metadata',
  CHECK_FFMPEG: 'check-ffmpeg',
  GET_APP_VERSION: 'get-app-version',

  // 设置
  GET_SETTINGS: 'get-settings',
  SAVE_SETTINGS: 'save-settings',

  // 网络资源
  NETWORK_RESOURCE_ADD: 'network-resource-add',
  NETWORK_RESOURCE_UPDATE: 'network-resource-update',
  NETWORK_RESOURCE_RESOLVE: 'network-resource-resolve',
  NETWORK_RESOURCE_REMOVE: 'network-resource-remove',
  NETWORK_RESOURCES_REMOVE: 'network-resources-remove',

  // 下载中心
  DOWNLOAD_SELECT_DIRECTORY: 'download-select-directory',
  DOWNLOAD_GET_STATE: 'download-get-state',
  DOWNLOAD_ADD_NETWORK_RESOURCE: 'download-add-network-resource',
  DOWNLOAD_ADD_URL: 'download-add-url',
  DOWNLOAD_ADD_MAGNET: 'download-add-magnet',
  DOWNLOAD_ADD_XUNLEI: 'download-add-xunlei',
  DOWNLOAD_SELECT_FILES: 'download-select-files',
  DOWNLOAD_PAUSE: 'download-pause',
  DOWNLOAD_RESUME: 'download-resume',
  DOWNLOAD_REMOVE: 'download-remove',
  DOWNLOAD_OPEN_DIRECTORY: 'download-open-directory',

  // 插件
  PLUGINS_LIST: 'plugins-list',
  PLUGINS_SET_ENABLED: 'plugins-set-enabled',
  PLUGINS_INSTALL: 'plugins-install',
  PLUGINS_UNINSTALL: 'plugins-uninstall',
  PLUGINS_OPEN_DIRECTORY: 'plugins-open-directory',
  PLUGINS_SAVE_CONFIG: 'plugins-save-config',

  // 隐私
  PRIVACY_SET_PASSWORD: 'privacy-set-password',
  PRIVACY_UNLOCK: 'privacy-unlock',

  // 远程访问（手机端）
  REMOTE_GET_STATE: 'remote-get-state',
  REMOTE_SAVE_SETTINGS: 'remote-save-settings',
  REMOTE_COPY_ENDPOINT: 'remote-copy-endpoint',
  REMOTE_COPY_TOKEN: 'remote-copy-token',
  REMOTE_ROTATE_TOKEN: 'remote-rotate-token',
  REMOTE_CREATE_PAIRING_CODE: 'remote-create-pairing-code',
  REMOTE_COPY_PAIRING_CODE: 'remote-copy-pairing-code',
  REMOTE_REMOVE_PAIRED_DEVICE: 'remote-remove-paired-device',
  REMOTE_APPROVE_PAIRING_REQUEST: 'remote-approve-pairing-request',
  REMOTE_REJECT_PAIRING_REQUEST: 'remote-reject-pairing-request',

  // 文件与目录
  SELECT_DIRECTORY: 'select-directory',
  SELECT_VIDEO_DIRECTORY: 'select-video-directory',
  OPEN_VIDEO_FILE: 'open-video-file',
  ALLOW_VIDEO_FILE: 'allow-video-file',
  SHOW_IN_FOLDER: 'show-in-folder',
  GET_FILE_URL: 'get-file-url',
  GET_PLAYBACK_STATE: 'get-playback-state',
  SAVE_PLAYBACK_STATE: 'save-playback-state',

  // 更新
  UPDATER_GET_STATUS: 'updater-get-status',
  UPDATER_CHECK: 'updater-check',
  UPDATER_DOWNLOAD: 'updater-download',
  UPDATER_INSTALL: 'updater-install',

  // mpv 播放
  CHECK_MPV: 'check-mpv',
  DOWNLOAD_MPV: 'download-mpv',
  MPV_PLAY: 'mpv-play',
  MPV_PLAY_URL: 'mpv-play-url',
  SET_MEDIA_PLAYBACK_ACTIVE: 'set-media-playback-active',
  MPV_SET_HOST_BOUNDS: 'mpv-set-host-bounds',
  MPV_STOP: 'mpv-stop',
  MPV_GET_STATE: 'mpv-get-state',
  MPV_COMMAND: 'mpv-command',
  SELECT_MPV_PATH: 'select-mpv-path'
}

// 主进程 → 渲染进程事件通道
const EVENT = {
  SETTINGS_CHANGED: 'settings-changed',
  REMOTE_ACCESS_STATE: 'remote-access-state',
  REMOTE_PLAY_ON_DESKTOP: 'remote-play-on-desktop',
  PLAYER_SHORTCUT: 'player-shortcut',
  UPDATER_STATUS: 'updater-status',
  MPV_STATE: 'mpv-state',
  MPV_ENDED: 'mpv-ended',
  MPV_ERROR: 'mpv-error',
  MPV_DOWNLOAD_PROGRESS: 'mpv-download-progress'
}

module.exports = { IPC, EVENT }

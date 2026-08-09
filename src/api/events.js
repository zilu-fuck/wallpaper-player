// 跨组件 window 自定义事件名的唯一事实来源。
// 事件名是魔法字符串，拼错会静默失效；统一在此定义。

export const WINDOW_EVENTS = {
  OPEN_LOCAL_LIBRARY: 'wallpaper-player-open-local-library',
  OPEN_NETWORK_LIBRARY: 'wallpaper-player-open-network-library',
  OPEN_DOWNLOAD_CENTER: 'wallpaper-player-open-download-center',
  OPEN_RESOURCE_DIALOG: 'wallpaper-player-open-resource-dialog',
  LIBRARY_DIRECTORY_ADDED: 'wallpaper-player-library-directory-added',
  CHECK_UPDATE: 'wallpaper-player-check-update',
  PRIVATE_DIRECTORY_PASSWORD_REQUIRED: 'wallpaper-player-private-directory-password-required',
  CLOSE_DOWNLOAD_DIALOGS: 'wallpaper-player-close-download-dialogs',
  DOWNLOAD_ADD_LIBRARY_DIRECTORY: 'wallpaper-player-download-add-library-directory',
  AI_SEARCH: 'wallpaper-player-ai-search'
}

export function dispatchWindowEvent(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

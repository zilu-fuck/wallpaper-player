function directoryKey(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function isPrivateDirectory(value, privateDirectories = []) {
  const target = directoryKey(value)
  return privateDirectories.some(directory => {
    const root = directoryKey(directory)
    return root && (target === root || target.startsWith(root + '/'))
  })
}

export function getPublicDirectories(directories = [], privateDirectories = []) {
  return directories.filter(directory => !isPrivateDirectory(directory, privateDirectories))
}

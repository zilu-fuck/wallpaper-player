import AsyncStorage from '@react-native-async-storage/async-storage'
import { librarySchema } from '../../../packages/contracts'
import type { LibraryResponse, StoredDevice } from '../types'
import { runWithCurrentDevice } from './devices'

const PREFIX = 'wallpaper-player.library-pages.'
export const LIBRARY_CACHE_BYTES = 4 * 1024 * 1024
export const LIBRARY_CACHE_ENTRIES = 6
const MAX_ITEMS = 1200
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
type Entry = { key: string, savedAt: number, response: LibraryResponse }
type Book = { version: 1, bindingId: string, entries: Entry[] }
const storageKey = (device: StoredDevice) => PREFIX + device.id

async function read(device: StoredDevice): Promise<Book> {
  const empty: Book = { version: 1, bindingId: device.bindingId || '', entries: [] }
  const raw = await AsyncStorage.getItem(storageKey(device))
  if (!raw || raw.length * 2 > LIBRARY_CACHE_BYTES) return empty
  try {
    const parsed = JSON.parse(raw)
    if (parsed.version !== 1 || parsed.bindingId !== device.bindingId || !Array.isArray(parsed.entries)) return empty
    return { ...empty, entries: parsed.entries.slice(0, LIBRARY_CACHE_ENTRIES).flatMap((entry: Entry) => {
      if (typeof entry.key !== 'string' || !Number.isFinite(entry.savedAt) || Date.now() - entry.savedAt > MAX_AGE_MS) return []
      const response = librarySchema.parse(entry.response)
      return response.items.length <= MAX_ITEMS ? [{ key: entry.key, savedAt: entry.savedAt, response }] : []
    }) }
  } catch { return empty }
}
export async function readLibraryPageCache(device: StoredDevice, key: string) {
  return runWithCurrentDevice(device, async () => (await read(device)).entries.find(entry => entry.key === key)?.response || null)
}
export async function writeLibraryPageCache(device: StoredDevice, key: string, response: LibraryResponse) {
  // Retain an entire prefix, including its cursor. Never truncate a response at an arbitrary item.
  if (response.items.length > MAX_ITEMS) return
  await runWithCurrentDevice(device, async () => {
    const book = await read(device)
    book.entries = [{ key, savedAt: Date.now(), response }, ...book.entries.filter(entry => entry.key !== key &&
      (!response.revision || entry.response.revision === response.revision))].slice(0, LIBRARY_CACHE_ENTRIES)
    let raw = JSON.stringify(book)
    while (raw.length * 2 > LIBRARY_CACHE_BYTES && book.entries.length) {
      book.entries.pop(); raw = JSON.stringify(book)
    }
    await AsyncStorage.setItem(storageKey(device), raw)
  })
}
export async function clearLibraryPageCache(device: StoredDevice) {
  await runWithCurrentDevice(device, () => AsyncStorage.removeItem(storageKey(device)))
}

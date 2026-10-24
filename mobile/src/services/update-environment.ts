import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo'
import { validateUpdateEnvironment, type AndroidUpdateEnvironment } from './update-manifest'

type EnvironmentModule = { getEnvironment(): Promise<unknown> }

export async function readUpdateEnvironment(): Promise<AndroidUpdateEnvironment> {
  if (Platform.OS !== 'android') throw new Error('此更新通道暂未提供适用于当前平台的安装包')
  const module = requireOptionalNativeModule<EnvironmentModule>('WallpaperUpdateEnvironment')
  if (!module) throw new Error('当前安装包缺少更新环境模块，请重新构建并安装手机应用')
  return validateUpdateEnvironment(await module.getEnvironment())
}

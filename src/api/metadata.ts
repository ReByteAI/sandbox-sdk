import platform from 'platform'

import { version } from '../../package.json'
import { runtime, runtimeVersion } from '../utils'

export { version }

export const defaultHeaders = {
  browser: (typeof window !== 'undefined' && platform.name) || 'unknown',
  lang: 'js',
  lang_version: runtimeVersion,
  package_version: version,
  publisher: 'rebyte',
  sdk_runtime: runtime,
  system: platform.os?.family || 'unknown',
}

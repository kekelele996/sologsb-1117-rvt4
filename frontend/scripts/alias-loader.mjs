// ESM resolve 钩子：把 TS 源码里的 '@/...' 别名解析到 src/...，供 node 直跑验证脚本
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = pathResolve(here, '..', 'src')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = pathResolve(srcDir, `${specifier.slice(2)}.ts`)
    return nextResolve(pathToFileURL(target).href, context)
  }
  return nextResolve(specifier, context)
}

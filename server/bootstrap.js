import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirnameLocal = path.dirname(__filename)

const mainObj = {}
globalThis.require = { main: mainObj }
globalThis.module = mainObj

await import(pathToFileURL(path.join(__dirnameLocal, 'index.js')).href)

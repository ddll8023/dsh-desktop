#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { dump, load } from 'js-yaml'

const root = path.resolve(process.argv[2] || 'dist')

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(fullPath) : [fullPath]
  })
}

function mergeManifest(name) {
  const candidates = walk(root).filter((file) => path.basename(file) === name)
  if (candidates.length === 0) return

  const documents = candidates.map((file) => {
    const document = load(fs.readFileSync(file, 'utf8'))
    if (!document || typeof document !== 'object') throw new Error(`invalid updater manifest: ${file}`)
    return { file, document }
  })
  const versions = new Set(documents.map(({ document }) => document.version).filter(Boolean))
  if (versions.size > 1) throw new Error(`${name} contains multiple versions: ${[...versions].join(', ')}`)

  const files = new Map()
  for (const { document } of documents) {
    const entries = Array.isArray(document.files)
      ? document.files
      : document.path
        ? [{ url: document.path, sha512: document.sha512, size: document.size, blockMapSize: document.blockMapSize }]
        : []
    for (const file of entries) {
      if (!file.url) throw new Error(`${name} contains an updater file without url`)
      files.set(file.url, file)
    }
  }
  if (files.size === 0) throw new Error(`${name} contains no updater files`)

  const merged = { ...documents[0].document, files: [...files.values()] }
  delete merged.path
  delete merged.sha2
  delete merged.sha512
  delete merged.size
  delete merged.blockMapSize

  const output = path.join(root, name)
  fs.writeFileSync(output, dump(merged, { lineWidth: -1, noRefs: true }))
  for (const { file } of documents) {
    if (path.resolve(file) !== path.resolve(output)) fs.rmSync(file, { force: true })
  }
  console.log(`[release] merged ${name} from ${documents.length} files -> ${output}`)
}

mergeManifest('latest-mac.yml')
mergeManifest('latest.yml')

import { Readable } from 'node:stream'
import { env } from '../env'
import { pipeline } from 'node:stream/promises'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync
} from 'node:fs'
import { getCacheClient } from './utils'
import { cacheVersion, getCacheKey, getFsCachePath } from '../constants'

type RequestContext = {
  log: {
    info: (message: string) => void
  }
}

//* Cache API
export async function saveCache(
  ctx: RequestContext,
  hash: string,
  tag: string,
  stream: Readable
): Promise<void> {
  if (!env.valid) {
    ctx.log.info(
      `Using filesystem cache because cache API env vars are not set`
    )
    await pipeline(stream, createWriteStream(getFsCachePath(hash)))
    return
  }
  const client = getCacheClient()
  const existingCacheResponse = await client.reserve(
    getCacheKey(hash, tag),
    cacheVersion
  )

  // Silently exit when we have not been able to receive a cache-hit
  if (existingCacheResponse.success === false) {
    return
  }

  const id = existingCacheResponse.data?.cacheId
  const uploadId = existingCacheResponse.data?.uploadId
  const uploadUrls = existingCacheResponse.data?.uploadUrls
  if (!id || !uploadId || !uploadUrls) {
    throw new Error(
      `Unable to reserve cache (received: ${JSON.stringify(
        existingCacheResponse.data
      )})`
    )
  }
  ctx.log.info(`Reserved cache ${id}`)
  await client.save(parseInt(id), uploadId, uploadUrls, stream)
  ctx.log.info(`Saved cache ${id} for ${hash}`)
}

export async function getCache(
  ctx: RequestContext,
  hash: string
): Promise<
  [number | undefined, Readable | ReadableStream, string | undefined] | null
> {
  //* Get cache from filesystem if cache API env vars are not set
  if (!env.valid) {
    const path = getFsCachePath(hash)
    if (!existsSync(path)) return null
    const size = statSync(path).size
    return [size, createReadStream(path), undefined]
  }
  //* Get cache from cache API
  const client = getCacheClient()
  const cacheKey = getCacheKey(hash)
  const { data } = await client.query(cacheKey, cacheVersion)
  ctx.log.info(`Cache lookup for ${cacheKey}`)
  if (!data) {
    ctx.log.info(`Cache lookup did not return data`)
    return null
  }
  const [foundCacheKey, artifactTag] = String(data.cacheKey).split('#')
  if (foundCacheKey !== cacheKey) {
    ctx.log.info(`Cache key mismatch: ${foundCacheKey} !== ${cacheKey}`)
    return null
  }
  const resp = await fetch(data.archiveLocation)
  const size = +(resp.headers.get('content-length') || 0)
  const readableStream = resp.body
  if (!readableStream) {
    throw new Error('Failed to retrieve cache stream')
  }
  return [size, readableStream, artifactTag]
}

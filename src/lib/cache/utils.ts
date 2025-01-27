import { Readable } from 'node:stream'
import { env } from '../env'
import * as core from '@actions/core'
import * as cacheHttpClient from '@actions/cache/lib/internal/cacheHttpClient'
import streamToPromise from 'stream-to-promise'
import { createWriteStream } from 'node:fs'
import { getTempCachePath } from '../constants'

class HandledError extends Error {
  status: number
  statusText: string
  data: unknown
  constructor(status: number, statusText: string, data: unknown) {
    super(`${status}: ${statusText}`)
    this.status = status
    this.statusText = statusText
    this.data = data
  }
}

function handleFetchError(message: string) {
  return (error: unknown) => {
    if (error instanceof HandledError) {
      core.error(`${message}: ${error.status} ${error.statusText}`)
      core.error(JSON.stringify(error.data))
      throw error
    }
    core.error(`${message}: ${error}`)
    throw error
  }
}

export function getCacheClient() {
  if (!env.valid) {
    throw new Error('Cache API env vars are not set')
  }

  const reserve = async (
    key: string,
    version: string,
    size: number
  ): Promise<{
    success: boolean
    data?: { cacheId: number; uploadId: string; uploadUrls: string[] }
  }> => {
    try {
      const reserveCacheResponse = await cacheHttpClient.reserveCache(
        key,
        [version],
        {
          cacheSize: size
        }
      )
      if (reserveCacheResponse?.result?.cacheId) {
        core.info(`Reserved cache ${reserveCacheResponse.result.cacheId}`)
        return {
          success: true,
          data: {
            cacheId: reserveCacheResponse.result.cacheId,
            uploadId: reserveCacheResponse.result.uploadId,
            uploadUrls: reserveCacheResponse.result.uploadUrls
          }
        }
      } else if (reserveCacheResponse?.statusCode === 409) {
        return { success: false }
      } else {
        const { statusCode, statusText } = reserveCacheResponse
        const data = reserveCacheResponse.result
        const buildedError = new HandledError(statusCode, statusText, data)
        return handleFetchError('Unable to reserve cache')(buildedError)
      }
    } catch (error) {
      return handleFetchError('Unable to reserve cache')(error)
    }
  }

  const save = async (
    cacheId: number,
    uploadId: string,
    uploadUrls: string[],
    tempFile: string
  ): Promise<void> => {
    try {
      await cacheHttpClient.saveCache(cacheId, tempFile, uploadUrls, uploadId)
      core.info(`Saved cache ${cacheId}`)
    } catch (error) {
      handleFetchError('Unable to upload cache')(error)
    }
  }

  const query = async (
    keys: string,
    version: string
  ): Promise<{
    success: boolean
    data?: { cacheKey: string; archiveLocation: string }
  }> => {
    try {
      const queryCacheResponse = await cacheHttpClient.getCacheEntry(
        [keys],
        [version]
      )
      if (queryCacheResponse?.archiveLocation) {
        return {
          success: true,
          data: {
            cacheKey: keys,
            archiveLocation: queryCacheResponse.archiveLocation
          }
        }
      } else {
        return {
          success: false
        }
      }
    } catch (error) {
      if (error instanceof Error && error.toString().includes('404')) {
        return { success: false }
      }
      return handleFetchError('Unable to query cache')(error)
    }
  }

  return {
    reserve,
    save,
    query
  }
}

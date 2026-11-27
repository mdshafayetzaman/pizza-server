import { ObjectId } from 'mongodb'

export function isValidObjectId(value) {
  return typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toString() === value
}

export function toObjectId(value) {
  if (value instanceof ObjectId) return value
  if (!isValidObjectId(String(value))) return null
  return new ObjectId(String(value))
}

export function parsePagination(query) {
  const pageRaw = query.page ?? 1
  const limitRaw = query.limit ?? 10
  const page = Number.parseInt(pageRaw, 10)
  const limit = Number.parseInt(limitRaw, 10)

  if (!Number.isFinite(page) || page < 1) {
    return { error: 'page must be a positive integer' }
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    return { error: 'limit must be an integer between 1 and 100' }
  }

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  }
}

export function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

export function pick(obj, keys) {
  const out = {}
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key]
  }
  return out
}

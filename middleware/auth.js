import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'
import { ObjectId } from 'mongodb'
import { collections } from '../config/db.js'
import { sendError } from '../utils/response.js'

const BETTER_AUTH_URL = (process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')
const JWKS_URL = process.env.BETTER_AUTH_JWKS_URL || process.env.JWKS_URL || new URL('/api/auth/jwks', `${BETTER_AUTH_URL}/`).toString()

function normalizeAuthValue(value) {
  const v = String(value || '').trim()
  if (!v) return []
  // Accept both with and without trailing slash for URL-like values
  if (/^https?:\/\//i.test(v)) {
    const noSlash = v.replace(/\/+$/, '')
    return noSlash === v ? [v, `${v}/`] : [noSlash, v]
  }
  return [v]
}

const issuerEnv = process.env.BETTER_AUTH_JWT_ISSUER || process.env.JWT_ISSUER || BETTER_AUTH_URL
const audienceEnv = process.env.BETTER_AUTH_JWT_AUDIENCE || process.env.JWT_AUDIENCE || BETTER_AUTH_URL
const issuerValues = [...new Set(issuerEnv.split(',').flatMap((v) => normalizeAuthValue(v)).filter(Boolean))]
const audienceValues = [...new Set(audienceEnv.split(',').flatMap((v) => normalizeAuthValue(v)).filter(Boolean))]
const issuer = issuerValues.length <= 1 ? (issuerValues[0] || BETTER_AUTH_URL) : issuerValues
const audience = audienceValues.length <= 1 ? (audienceValues[0] || BETTER_AUTH_URL) : audienceValues

let jwksResolver
let jwksInitError
function getJwks() {
  if (jwksResolver) return jwksResolver
  if (jwksInitError) throw jwksInitError
  try {
    jwksResolver = createRemoteJWKSet(new URL(JWKS_URL), {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    })
    return jwksResolver
  } catch (err) {
    jwksInitError = err
    throw err
  }
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization
  if (typeof authHeader !== 'string') return null
  const [type, ...rest] = authHeader.trim().split(/\s+/)
  const token = rest.join(' ').trim()
  if (type?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

function getUserIdFromPayload(payload) {
  return (
    payload?.sub ||
    payload?.id ||
    payload?.userId ||
    payload?.user?.id ||
    null
  )
}

function normalizeRole(role) {
  const value = String(role || '').toLowerCase()
  if (value === 'admin' || value === 'vendor' || value === 'customer') return value
  return 'customer'
}

async function findUserById(userId) {
  const { users } = collections()
  const id = String(userId)

  let user = null
  if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) {
    user = await users.findOne({ _id: new ObjectId(id) })
  }
  if (!user) {
    user = await users.findOne({ id })
  }
  if (!user && ObjectId.isValid(id)) {
    user = await users.findOne({ _id: new ObjectId(id) })
  }
  if (!user) {
    user = await users.findOne({ _id: id })
  }
  return user
}

function isLikelyJwt(token) {
  return typeof token === 'string' && token.split('.').length === 3
}

function isJwtValidationError(err) {
  const code = String(err?.code || '')
  const name = String(err?.name || '')
  return (
    code.startsWith('ERR_JWT_') ||
    code.startsWith('ERR_JWS_') ||
    code === 'ERR_JWE_INVALID' ||
    name === 'JWTExpired' ||
    name === 'JWTClaimValidationFailed' ||
    name === 'JWTInvalid' ||
    name === 'JWSInvalid' ||
    name === 'JWSSignatureVerificationFailed'
  )
}

function isJwksOrConfigError(err) {
  const code = String(err?.code || '')
  const name = String(err?.name || '')
  const message = String(err?.message || '').toLowerCase()
  const causeCode = String(err?.cause?.code || '')
  return (
    code.startsWith('ERR_JWKS_') ||
    name.startsWith('JWKS') ||
    code === 'ERR_JOSE_ALG_NOT_ALLOWED' ||
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ENOTFOUND' ||
    causeCode === 'ETIMEDOUT' ||
    causeCode === 'ECONNRESET' ||
    message.includes('fetch failed') ||
    message.includes('failed to fetch') ||
    message.includes('network')
  )
}

export async function getAuthenticatedUser(req) {
  const token = getBearerToken(req)
  if (!token) {
    return { error: { status: 401, message: 'Authentication required. Please sign in.' } }
  }

  if (!isLikelyJwt(token)) {
    return {
      error: {
        status: 401,
        message: 'Invalid authentication token format. Provide a valid Bearer JWT.',
      },
    }
  }

  try {
    decodeProtectedHeader(token)
  } catch {
    return { error: { status: 401, message: 'Invalid or malformed authentication token.' } }
  }

  let payload
  try {
    const verifyOptions = {
      issuer,
      clockTolerance: 60,
    }
    if (Array.isArray(audience) ? audience.length > 0 : Boolean(audience)) {
      verifyOptions.audience = audience
    }
    const verified = await jwtVerify(token, getJwks(), verifyOptions)
    payload = verified.payload
  } catch (err) {
    const code = String(err?.code || '')
    const name = String(err?.name || '')
    if (isJwtValidationError(err)) {
      const expired = code === 'ERR_JWT_EXPIRED' || name === 'JWTExpired'
      return {
        error: {
          status: 401,
          message: expired ? 'Authentication token has expired. Please sign in again.' : 'Invalid or expired authentication token.',
        },
      }
    }
    if (isJwksOrConfigError(err)) {
      console.error('Auth JWKS/config error:', { code: err?.code, name: err?.name, message: err?.message, jwksUrl: JWKS_URL })
      return {
        error: {
          status: 500,
          message: 'Authentication service configuration error. Verify BETTER_AUTH_URL/JWKS issuer/audience settings.',
        },
      }
    }
    console.error('Auth token verification error:', { code: err?.code, name: err?.name, message: err?.message })
    return { error: { status: 401, message: 'Authentication token verification failed.' } }
  }

  const userId = getUserIdFromPayload(payload)
  if (!userId) {
    return { error: { status: 401, message: 'Invalid token payload: missing user identifier.' } }
  }

  let dbUser
  try {
    dbUser = await findUserById(userId)
  } catch (err) {
    console.error('Auth user lookup error:', { message: err?.message, code: err?.code })
    return { error: { status: 500, message: 'Authentication user lookup failed.' } }
  }

  if (!dbUser) {
    return { error: { status: 401, message: 'Authenticated user not found.' } }
  }

  const role = normalizeRole(dbUser.role)
  const isBlocked = Boolean(dbUser.isBlocked ?? dbUser.blocked ?? dbUser.status === 'blocked')
  const rawPlan = String(dbUser.subscriptionPlan || 'free').toLowerCase()
  const expiresAt = dbUser.subscriptionExpiresAt ? new Date(dbUser.subscriptionExpiresAt) : null
  const premiumActive = rawPlan === 'premium' && (!expiresAt || (!Number.isNaN(expiresAt.getTime()) && expiresAt > new Date()))
  const effectivePlan = premiumActive ? 'premium' : 'free'

  return {
    user: {
      id: dbUser._id?.toString?.() || String(userId),
      _id: dbUser._id,
      name: dbUser.name || '',
      email: dbUser.email || '',
      image: dbUser.image || null,
      role,
      isBlocked,
      businessName: dbUser.businessName || '',
      subscriptionPlan: effectivePlan,
      subscriptionExpiresAt: dbUser.subscriptionExpiresAt || null,
      raw: dbUser,
    },
  }
}

export function requireAuth(options = {}) {
  const { allowBlocked = false } = options

  return async (req, res, next) => {
    try {
      const result = await getAuthenticatedUser(req)
      if (result.error) {
        return sendError(res, result.error.status, result.error.message)
      }

      if (!allowBlocked && result.user.isBlocked) {
        return sendError(res, 403, 'Your account is blocked. Please contact support.')
      }

      req.auth = result.user
      req.user = result.user
      next()
    } catch (error) {
      console.error('Auth middleware unexpected error:', { message: error?.message, code: error?.code, stack: error?.stack })
      return sendError(res, 500, 'Authentication verification failed.')
    }
  }
}

export function optionalAuth() {
  return async (req, _res, next) => {
    try {
      const token = getBearerToken(req)
      if (!token) return next()
      const result = await getAuthenticatedUser(req)
      if (!result.error) {
        req.auth = result.user
        req.user = result.user
      }
    } catch (error) {
      console.warn('Optional auth ignored:', { message: error?.message, code: error?.code })
    }
    next()
  }
}

export function requireRole(...roles) {
  const allowed = roles.flat().map(normalizeRole)
  return (req, res, next) => {
    if (!req.auth) {
      return sendError(res, 401, 'Authentication required. Please sign in.')
    }
    if (!allowed.includes(req.auth.role)) {
      return sendError(res, 403, 'You do not have permission to access this resource.')
    }
    next()
  }
}

export const requireAdmin = [requireAuth(), requireRole('admin')]
export const requireVendor = [requireAuth(), requireRole('vendor')]
export const requireCustomer = [requireAuth(), requireRole('customer')]
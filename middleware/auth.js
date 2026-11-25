import { createRemoteJWKSet, jwtVerify } from 'jose'
import { ObjectId } from 'mongodb'
import { collections } from '../config/db.js'
import { sendError } from '../utils/response.js'

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || 'http://localhost:3000'
const JWKS_URL = new URL('/api/auth/jwks', BETTER_AUTH_URL)
const jwks = createRemoteJWKSet(JWKS_URL)

function getBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization
  if (typeof authHeader !== 'string') return null
  const [type, token] = authHeader.split(' ')
  if (type !== 'Bearer' || !token) return null
  return token.trim()
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
  if (ObjectId.isValid(id)) {
    user = await users.findOne({ _id: new ObjectId(id) })
  }
  if (!user) {
    user = await users.findOne({ id })
  }
  if (!user) {
    user = await users.findOne({ _id: id })
  }
  return user
}

export async function getAuthenticatedUser(req) {
  const token = getBearerToken(req)
  if (!token) {
    return { error: { status: 401, message: 'Authentication required. Please sign in.' } }
  }

  let payload
  try {
    const verified = await jwtVerify(token, jwks, {
      issuer: BETTER_AUTH_URL,
      audience: BETTER_AUTH_URL,
    })
    payload = verified.payload
  } catch {
    try {
      const verified = await jwtVerify(token, jwks)
      payload = verified.payload
    } catch (error) {
      return {
        error: {
          status: 401,
          message: 'Invalid or expired token.',
        },
      }
    }
  }

  const userId = getUserIdFromPayload(payload)
  if (!userId) {
    return { error: { status: 401, message: 'Invalid token payload.' } }
  }

  const dbUser = await findUserById(userId)
  if (!dbUser) {
    return { error: { status: 401, message: 'Authenticated user not found.' } }
  }

  const role = normalizeRole(dbUser.role ?? payload.role)
  const isBlocked = Boolean(dbUser.isBlocked ?? dbUser.blocked ?? dbUser.status === 'blocked')

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
      subscriptionPlan: dbUser.subscriptionPlan || 'free',
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
      console.error('Auth middleware error:', error)
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
    } catch {
      // Ignore optional auth failures.
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

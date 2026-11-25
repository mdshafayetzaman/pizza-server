import express from 'express'
import { ObjectId } from 'mongodb'
import { collections } from '../config/db.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { asyncHandler, sendError } from '../utils/response.js'
import { escapeRegex, isValidObjectId } from '../utils/validate.js'

const router = express.Router()

function sanitizeUser(user = {}) {
  const role = String(user.role || 'customer').toLowerCase()
  return {
    ...user,
    _id: user._id,
    id: user._id?.toString?.() || user.id,
    name: user.name || '',
    email: user.email || '',
    image: user.image || null,
    role: ['admin', 'vendor', 'customer'].includes(role) ? role : 'customer',
    isBlocked: Boolean(user.isBlocked ?? user.blocked ?? user.status === 'blocked'),
    status: (user.isBlocked ?? user.blocked ?? user.status === 'blocked') ? 'blocked' : 'active',
    businessName: user.businessName || '',
    subscriptionPlan: user.subscriptionPlan || 'free',
    subscriptionExpiresAt: user.subscriptionExpiresAt || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

router.get('/users/me', requireAuth(), asyncHandler(async (req, res) => {
  const { users } = collections()
  const user = await users.findOne({ _id: new ObjectId(req.auth.id) })
  if (!user) return sendError(res, 404, 'User not found')
  res.status(200).send({ success: true, data: sanitizeUser(user), user: sanitizeUser(user) })
}))

router.patch('/users/profile', requireAuth(), asyncHandler(async (req, res) => {
  const { users } = collections()
  const body = req.body || {}
  if ('role' in body || 'subscriptionPlan' in body || 'isBlocked' in body || 'status' in body) {
    return sendError(res, 403, 'You cannot modify role, subscription, or blocked status')
  }
  const update = { updatedAt: new Date() }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return sendError(res, 400, 'Name must be a non-empty string')
    update.name = body.name.trim()
  }
  if (body.image !== undefined) {
    if (body.image !== null && typeof body.image !== 'string') return sendError(res, 400, 'Image must be a string')
    update.image = body.image
  }
  if (body.businessName !== undefined && req.auth.role === 'vendor') {
    if (typeof body.businessName !== 'string') return sendError(res, 400, 'businessName must be a string')
    update.businessName = body.businessName.trim()
  }

  await users.updateOne({ _id: new ObjectId(req.auth.id) }, { $set: update })
  const updated = await users.findOne({ _id: new ObjectId(req.auth.id) })
  res.status(200).send({ success: true, message: 'Profile updated successfully', data: sanitizeUser(updated), user: sanitizeUser(updated) })
}))

router.get('/users', requireAuth(), requireRole('admin'), asyncHandler(async (req, res) => {
  const { users } = collections()
  const query = {}
  if (req.query.role) query.role = String(req.query.role).toLowerCase()
  if (req.query.search || req.query.q) {
    const regex = { $regex: escapeRegex(String(req.query.search || req.query.q)), $options: 'i' }
    query.$or = [{ name: regex }, { email: regex }]
  }
  const docs = await users.find(query).sort({ createdAt: -1 }).toArray()
  const data = docs.map(sanitizeUser)
  res.status(200).send(data)
}))

router.get('/users/all', requireAuth(), requireRole('admin'), asyncHandler(async (req, res) => {
  const { users } = collections()
  const docs = await users.find({}).sort({ createdAt: -1 }).toArray()
  res.status(200).send({ success: true, data: docs.map(sanitizeUser), users: docs.map(sanitizeUser) })
}))

router.get('/users/:id', requireAuth(), requireRole('admin'), asyncHandler(async (req, res) => {
  const { users } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid user ID')
  const user = await users.findOne({ _id: new ObjectId(id) })
  if (!user) return sendError(res, 404, 'User not found')
  res.status(200).send({ success: true, data: sanitizeUser(user), user: sanitizeUser(user) })
}))

async function setBlockStatus(req, res, isBlocked) {
  const { users } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid user ID')
  const user = await users.findOne({ _id: new ObjectId(id) })
  if (!user) return sendError(res, 404, 'User not found')
  if (String(user.role).toLowerCase() === 'admin') {
    return sendError(res, 403, 'Admin accounts cannot be blocked or modified through this endpoint')
  }
  await users.updateOne({ _id: user._id }, { $set: { isBlocked, status: isBlocked ? 'blocked' : 'active', updatedAt: new Date() } })
  const updated = await users.findOne({ _id: user._id })
  res.status(200).send({ success: true, message: isBlocked ? 'User blocked successfully' : 'User unblocked successfully', data: sanitizeUser(updated) })
}

router.patch('/users/:id/block', requireAuth(), requireRole('admin'), asyncHandler((req, res) => setBlockStatus(req, res, true)))
router.patch('/users/block/:id', requireAuth(), requireRole('admin'), asyncHandler((req, res) => setBlockStatus(req, res, true)))
router.patch('/users/:id/unblock', requireAuth(), requireRole('admin'), asyncHandler((req, res) => setBlockStatus(req, res, false)))
router.patch('/users/unblock/:id', requireAuth(), requireRole('admin'), asyncHandler((req, res) => setBlockStatus(req, res, false)))

export default router

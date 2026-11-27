import express from 'express'
import { ObjectId } from 'mongodb'
import { collections } from '../config/db.js'
import { optionalAuth, requireAuth, requireRole } from '../middleware/auth.js'
import { asyncHandler, sendError } from '../utils/response.js'
import { escapeRegex, isValidHttpUrl, isValidObjectId, parsePagination, toNumber } from '../utils/validate.js'

const router = express.Router()

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected']
const PUBLISH_STATUSES = ['active', 'inactive']

function normalizeMenuItem(doc = {}) {
  const itemName = doc.itemName || doc.pizzaName || doc.name || ''
  const imageUrl = doc.imageUrl || doc.image || (Array.isArray(doc.images) ? doc.images[0] : '') || ''
  const images = Array.isArray(doc.images) ? doc.images.filter(Boolean) : imageUrl ? [imageUrl] : []
  const rawStatus = String(doc.status || '').toLowerCase()
  const hasApprovalField = doc.approvalStatus !== undefined || APPROVAL_STATUSES.includes(rawStatus)
  const approvalStatus = String(
    doc.approvalStatus || (APPROVAL_STATUSES.includes(rawStatus) ? rawStatus : (hasApprovalField ? 'pending' : 'approved'))
  ).toLowerCase()
  const availability = doc.availability ?? doc.isAvailable ?? (rawStatus === 'inactive' ? 'inactive' : 'active')
  const status = rawStatus || approvalStatus || 'pending'

  return {
    ...doc,
    _id: doc._id,
    id: doc._id?.toString?.() || doc.id,
    vendorId: doc.vendorId?.toString?.() || doc.vendorId || '',
    itemName,
    pizzaName: doc.pizzaName || itemName,
    name: doc.name || itemName,
    category: doc.category || '',
    description: doc.description || '',
    price: Number(doc.price ?? 0),
    location: doc.location || '',
    images,
    imageUrl,
    image: doc.image || imageUrl,
    approvalStatus: APPROVAL_STATUSES.includes(approvalStatus) ? approvalStatus : 'pending',
    status,
    availability,
    isActive: availability === 'active' || availability === true,
    isAvailable: availability === 'active' || availability === true,
    preparationTime: doc.preparationTime || '',
    availableDate: doc.availableDate || '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

function canViewNonPublic(req) {
  const role = req.auth?.role
  return role === 'admin'
}

function buildMenuQuery(req) {
  const query = {}
  const isPrivileged = canViewNonPublic(req)
  const { category, location, status, approvalStatus, search, q, minPrice, maxPrice, vendorId } = req.query

  if (category) query.category = String(category)
  if (location) query.location = { $regex: escapeRegex(String(location)), $options: 'i' }
  if (vendorId && isPrivileged) query.vendorId = String(vendorId)

  const searchTerm = search || q
  if (searchTerm) {
    const regex = { $regex: escapeRegex(String(searchTerm)), $options: 'i' }
    query.$or = [{ itemName: regex }, { pizzaName: regex }, { name: regex }, { description: regex }]
  }

  const min = minPrice !== undefined ? toNumber(minPrice) : null
  const max = maxPrice !== undefined ? toNumber(maxPrice) : null
  if (minPrice !== undefined && min === null) return { error: 'minPrice must be a number' }
  if (maxPrice !== undefined && max === null) return { error: 'maxPrice must be a number' }
  if (min !== null || max !== null) {
    query.price = {}
    if (min !== null) query.price.$gte = min
    if (max !== null) query.price.$lte = max
  }

  const requestedApproval = String(approvalStatus || '').toLowerCase()
  const requestedStatus = String(status || '').toLowerCase()

  if (isPrivileged) {
    if (requestedApproval) {
      if (!APPROVAL_STATUSES.includes(requestedApproval)) return { error: 'Invalid approval status' }
      query.approvalStatus = requestedApproval
    }
    if (requestedStatus) {
      if ([...APPROVAL_STATUSES, ...PUBLISH_STATUSES].includes(requestedStatus)) {
        if (PUBLISH_STATUSES.includes(requestedStatus)) query.availability = requestedStatus
        else query.approvalStatus = requestedStatus
      } else {
        return { error: 'Invalid status filter' }
      }
    }
  } else {
    query.$and = [
      ...(query.$and || []),
      {
        $or: [
          { approvalStatus: 'approved' },
          { approvalStatus: { $exists: false }, status: { $nin: ['pending', 'rejected', 'inactive'] } },
          { approvalStatus: { $exists: false }, status: { $exists: false } },
        ],
      },
      { $or: [{ availability: 'active' }, { availability: true }, { availability: { $exists: false } }, { status: { $nin: ['inactive', 'rejected'] } }] },
    ]
  }

  return { query }
}

function buildSort(query) {
  const sortRaw = String(query.sort || '').toLowerCase()
  const orderRaw = String(query.order || '').toLowerCase()
  if (sortRaw === 'price_asc' || (sortRaw === 'price' && orderRaw === 'asc') || orderRaw === 'asc') return { price: 1, createdAt: -1 }
  if (sortRaw === 'price_desc' || (sortRaw === 'price' && orderRaw === 'desc') || orderRaw === 'desc') return { price: -1, createdAt: -1 }
  return { createdAt: -1 }
}

async function getVendorMenuCount(vendorId, activeOnly = false) {
  const { menuItems } = collections()
  const query = { vendorId: String(vendorId) }
  if (activeOnly) {
    query.approvalStatus = { $ne: 'rejected' }
    query.$or = [{ availability: 'active' }, { availability: true }, { availability: { $exists: false } }]
  }
  return menuItems.countDocuments(query)
}

router.get('/menuItem', optionalAuth(), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const { query, error } = buildMenuQuery(req)
  if (error) return sendError(res, 400, error)

  const pagination = req.query.page || req.query.limit ? parsePagination(req.query) : null
  if (pagination?.error) return sendError(res, 400, pagination.error)

  const sort = buildSort(req.query)
  let cursor = menuItems.find(query).sort(sort)
  if (pagination) cursor = cursor.skip(pagination.skip).limit(pagination.limit)

  const items = (await cursor.toArray()).map(normalizeMenuItem)

  if (pagination) {
    const total = await menuItems.countDocuments(query)
    return res.status(200).send({
      success: true,
      data: items,
      items,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit) || 1,
      },
    })
  }

  return res.status(200).send(items)
}))

router.get('/menuItem/my-menu', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const query = { vendorId: req.auth.id }
  const { category, status, search } = req.query
  if (category) query.category = String(category)
  if (status) {
    const s = String(status).toLowerCase()
    if (PUBLISH_STATUSES.includes(s)) query.availability = s
    else if (APPROVAL_STATUSES.includes(s)) query.approvalStatus = s
  }
  if (search) {
    const regex = { $regex: escapeRegex(String(search)), $options: 'i' }
    query.$or = [{ itemName: regex }, { pizzaName: regex }, { name: regex }]
  }
  const sort = buildSort(req.query)
  const items = (await menuItems.find(query).sort(sort).toArray()).map(normalizeMenuItem)
  res.status(200).send({ success: true, data: items, items })
}))

router.get('/menuItem/my-items', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const items = (await menuItems.find({ vendorId: req.auth.id }).sort({ createdAt: -1 }).toArray()).map(normalizeMenuItem)
  res.status(200).send({ success: true, data: items, items })
}))

router.get('/menuItem/admin/all', requireAuth(), requireRole('admin'), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const { query, error } = buildMenuQuery({ ...req, auth: req.auth })
  if (error) return sendError(res, 400, error)
  // Admin should see all, override public restriction
  delete query.approvalStatus
  if (query.$and) query.$and = query.$and.filter((c) => !c.$or)
  if (req.query.approvalStatus) query.approvalStatus = String(req.query.approvalStatus).toLowerCase()
  if (req.query.status) {
    const s = String(req.query.status).toLowerCase()
    if (PUBLISH_STATUSES.includes(s)) query.availability = s
    else if (APPROVAL_STATUSES.includes(s)) query.approvalStatus = s
  }
  const items = (await menuItems.find(query).sort(buildSort(req.query)).toArray()).map(normalizeMenuItem)
  res.status(200).send({ success: true, data: items, items })
}))

router.get('/menuItem/:id', optionalAuth(), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid menu item ID')

  const item = await menuItems.findOne({ _id: new ObjectId(id) })
  if (!item) return sendError(res, 404, 'Menu item not found')

  const normalized = normalizeMenuItem(item)
  const isOwner = req.auth?.role === 'vendor' && String(item.vendorId) === req.auth.id
  const isAdmin = req.auth?.role === 'admin'
  if (normalized.approvalStatus !== 'approved' && !isOwner && !isAdmin) {
    return sendError(res, 404, 'Menu item not found')
  }

  res.status(200).send(normalized)
}))

router.post('/menuItem', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const body = req.body || {}
  const itemName = String(body.itemName || body.pizzaName || body.name || '').trim()
  const category = String(body.category || '').trim()
  const description = String(body.description || '').trim()
  const location = String(body.location || '').trim()
  const imageUrl = String(body.imageUrl || body.image || (Array.isArray(body.images) ? body.images[0] : '') || '').trim()
  let images = Array.isArray(body.images)
    ? body.images.filter((i) => typeof i === 'string' && i.trim()).map((i) => i.trim())
    : imageUrl ? [imageUrl] : []
  if (images.length === 0 && imageUrl) images = [imageUrl]
  const price = toNumber(body.price)

  if (!itemName || !category || !description || !location || !imageUrl || price === null) {
    return sendError(res, 400, 'Please provide all required fields: itemName, category, description, price, location, and image')
  }
  if (!isValidHttpUrl(imageUrl)) {
    return sendError(res, 400, 'Image must be a valid HTTP/HTTPS URL')
  }
  if (images.some((img) => !isValidHttpUrl(img))) {
    return sendError(res, 400, 'All image URLs must be valid HTTP/HTTPS URLs')
  }
  if (price < 0) return sendError(res, 400, 'Price must be a valid non-negative number')

  const plan = String(req.auth.subscriptionPlan || 'free').toLowerCase()
  if (plan !== 'premium') {
    const activeCount = await getVendorMenuCount(req.auth.id, true)
    if (activeCount >= 3) {
      return sendError(res, 403, 'Free plan vendors can create up to 3 active menu items. Upgrade to Premium for unlimited items.')
    }
  }

  const now = new Date()
  const doc = {
    vendorId: req.auth.id,
    itemName,
    pizzaName: itemName,
    name: itemName,
    category,
    description,
    price,
    location,
    images,
    imageUrl: images[0],
    image: images[0],
    status: 'pending',
    approvalStatus: 'pending',
    availability: body.availability === 'inactive' ? 'inactive' : 'active',
    isActive: body.availability !== 'inactive',
    preparationTime: body.preparationTime || '',
    availableDate: body.availableDate || '',
    createdAt: now,
    updatedAt: now,
  }

  const result = await menuItems.insertOne(doc)
  res.status(201).send({ success: true, message: 'Menu item created successfully', insertedId: result.insertedId, data: normalizeMenuItem({ ...doc, _id: result.insertedId }) })
}))

router.put('/menuItem/:id', requireAuth(), requireRole('vendor', 'admin'), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid menu item ID')

  const existing = await menuItems.findOne({ _id: new ObjectId(id) })
  if (!existing) return sendError(res, 404, 'Menu item not found')
  if (req.auth.role === 'vendor' && String(existing.vendorId) !== req.auth.id) {
    return sendError(res, 403, 'You can only update your own menu items')
  }

  const body = req.body || {}
  const itemName = String(body.itemName || body.pizzaName || body.name || existing.itemName || existing.pizzaName || '').trim()
  const category = String(body.category ?? existing.category ?? '').trim()
  const description = String(body.description ?? existing.description ?? '').trim()
  const location = String(body.location ?? existing.location ?? '').trim()
  const imageUrl = String(body.imageUrl || body.image || (Array.isArray(body.images) ? body.images[0] : '') || existing.imageUrl || '').trim()
  const images = Array.isArray(body.images) ? body.images.filter((i) => typeof i === 'string' && i.trim()) : imageUrl ? [imageUrl] : existing.images || []
  const price = body.price !== undefined ? toNumber(body.price) : Number(existing.price)

  if (!itemName || !category || !description || !location || !images.length || price === null || price < 0) {
    return sendError(res, 400, 'Please provide valid menu item fields')
  }

  const update = {
    itemName,
    pizzaName: itemName,
    name: itemName,
    category,
    description,
    price,
    location,
    images,
    imageUrl: images[0],
    image: images[0],
    preparationTime: body.preparationTime ?? existing.preparationTime ?? '',
    availableDate: body.availableDate ?? existing.availableDate ?? '',
    updatedAt: new Date(),
  }

  if (body.availability !== undefined || body.isActive !== undefined) {
    const availability = body.availability === 'inactive' || body.isActive === false ? 'inactive' : 'active'
    update.availability = availability
    update.isActive = availability === 'active'
  }

  await menuItems.updateOne({ _id: existing._id }, { $set: update })
  res.status(200).send({ success: true, message: 'Menu item updated successfully' })
}))

router.patch('/menuItem/:id', requireAuth(), requireRole('vendor', 'admin'), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid menu item ID')
  const existing = await menuItems.findOne({ _id: new ObjectId(id) })
  if (!existing) return sendError(res, 404, 'Menu item not found')
  if (req.auth.role === 'vendor' && String(existing.vendorId) !== req.auth.id) {
    return sendError(res, 403, 'You can only update your own menu items')
  }

  const body = req.body || {}
  const update = { updatedAt: new Date() }

  if (body.itemName || body.pizzaName || body.name) {
    const name = String(body.itemName || body.pizzaName || body.name).trim()
    if (name) { update.itemName = name; update.pizzaName = name; update.name = name }
  }
  if (body.category !== undefined) update.category = String(body.category).trim()
  if (body.description !== undefined) update.description = String(body.description).trim()
  if (body.location !== undefined) update.location = String(body.location).trim()
  if (body.price !== undefined) {
    const price = toNumber(body.price)
    if (price === null || price < 0) return sendError(res, 400, 'Price must be a valid non-negative number')
    update.price = price
  }
  if (body.imageUrl || body.image || body.images) {
    const imageUrl = String(body.imageUrl || body.image || (Array.isArray(body.images) ? body.images[0] : '') || '').trim()
    const images = Array.isArray(body.images) ? body.images.filter(Boolean) : imageUrl ? [imageUrl] : undefined
    if (images?.length) { update.images = images; update.imageUrl = images[0]; update.image = images[0] }
  }
  if (body.availability !== undefined || body.isActive !== undefined || body.isAvailable !== undefined) {
    const inactive = body.availability === 'inactive' || body.isActive === false || body.isAvailable === false
    update.availability = inactive ? 'inactive' : 'active'
    update.isActive = !inactive
  }
  if (body.preparationTime !== undefined) update.preparationTime = body.preparationTime
  if (body.availableDate !== undefined) update.availableDate = body.availableDate

  if (req.auth.role === 'admin') {
    if (body.approvalStatus && APPROVAL_STATUSES.includes(String(body.approvalStatus).toLowerCase())) {
      update.approvalStatus = String(body.approvalStatus).toLowerCase()
      update.status = update.approvalStatus
    }
    if (body.status && [...APPROVAL_STATUSES, ...PUBLISH_STATUSES].includes(String(body.status).toLowerCase())) {
      const s = String(body.status).toLowerCase()
      if (APPROVAL_STATUSES.includes(s)) { update.approvalStatus = s; update.status = s }
      if (PUBLISH_STATUSES.includes(s)) { update.availability = s; update.isActive = s === 'active' }
    }
  }

  await menuItems.updateOne({ _id: existing._id }, { $set: update })
  const updated = await menuItems.findOne({ _id: existing._id })
  res.status(200).send({ success: true, message: 'Menu item updated successfully', data: normalizeMenuItem(updated) })
}))

router.delete('/menuItem/:id', requireAuth(), requireRole('vendor', 'admin'), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid menu item ID')
  const existing = await menuItems.findOne({ _id: new ObjectId(id) })
  if (!existing) return sendError(res, 404, 'Menu item not found')
  if (req.auth.role === 'vendor' && String(existing.vendorId) !== req.auth.id) {
    return sendError(res, 403, 'You can only delete your own menu items')
  }
  await menuItems.deleteOne({ _id: existing._id })
  res.status(200).send({ success: true, message: 'Menu item deleted successfully' })
}))

router.patch('/menuItem/:id/approve', requireAuth(), requireRole('admin'), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid menu item ID')
  const result = await menuItems.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { approvalStatus: 'approved', status: 'approved', updatedAt: new Date() } },
    { returnDocument: 'after' }
  )
  if (!result) return sendError(res, 404, 'Menu item not found')
  res.status(200).send({ success: true, message: 'Menu item approved', data: normalizeMenuItem(result) })
}))

router.patch('/menuItem/:id/reject', requireAuth(), requireRole('admin'), asyncHandler(async (req, res) => {
  const { menuItems } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid menu item ID')
  const result = await menuItems.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { approvalStatus: 'rejected', status: 'rejected', updatedAt: new Date() } },
    { returnDocument: 'after' }
  )
  if (!result) return sendError(res, 404, 'Menu item not found')
  res.status(200).send({ success: true, message: 'Menu item rejected', data: normalizeMenuItem(result) })
}))

export default router

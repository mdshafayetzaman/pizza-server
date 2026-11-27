import express from 'express'
import { ObjectId } from 'mongodb'
import { collections } from '../config/db.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { asyncHandler, sendError } from '../utils/response.js'
import { escapeRegex, isValidObjectId, parsePagination } from '../utils/validate.js'

const router = express.Router()

const ORDER_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled', 'confirmed', 'preparing', 'ready', 'completed', 'delivered', 'out_for_delivery']
const DEMO_VENDOR_ID = 'demo-vendor'

function normalizeStatus(status) {
  return String(status || 'pending').toLowerCase().trim()
}

function isDemoOrder(order = {}) {
  return Boolean(order.isDemo) || String(order.vendorId || '') === DEMO_VENDOR_ID
}

function vendorOrderAccessQuery(vendorId) {
  return { $or: [{ vendorId: String(vendorId) }, { isDemo: true }, { vendorId: DEMO_VENDOR_ID }] }
}

function normalizeOrder(doc = {}) {
  const status = normalizeStatus(doc.status)
  return {
    ...doc,
    _id: doc._id,
    id: doc._id?.toString?.() || doc.id,
    itemId: doc.itemId?.toString?.() || doc.itemId || doc.menuItemId || '',
    vendorId: doc.vendorId?.toString?.() || doc.vendorId || '',
    customerId: doc.customerId?.toString?.() || doc.customerId || '',
    status,
    deliveryDate: doc.deliveryDate || doc.orderDate || null,
    deliveryAddress: doc.deliveryAddress || '',
    message: doc.message ?? doc.additionalMessage ?? doc.notes ?? '',
    isDemo: Boolean(doc.isDemo),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

async function getMenuItemByAnyId(id) {
  const { menuItems } = collections()
  if (id === undefined || id === null) return null
  const str = String(id).trim()
  if (!str) return null

  if (isValidObjectId(str)) {
    const byId = await menuItems.findOne({ _id: new ObjectId(str) })
    if (byId) return byId
  }

  const numericId = Number(str)
  const or = [{ id: str }, { legacyId: str }]
  if (Number.isFinite(numericId)) {
    or.push({ id: numericId }, { legacyId: numericId })
  }
  return menuItems.findOne({ $or: or })
}

async function getUserById(id) {
  const { users } = collections()
  const str = String(id)
  if (ObjectId.isValid(str)) {
    const byObj = await users.findOne({ _id: new ObjectId(str) })
    if (byObj) return byObj
  }
  return users.findOne({ _id: str }) || users.findOne({ id: str })
}

async function enrichOrders(orders) {
  const { menuItems, users } = collections()
  const itemIds = [...new Set(orders.map((o) => String(o.itemId || o.menuItemId || '')).filter(Boolean))]
  const userIds = [...new Set(orders.flatMap((o) => [o.customerId, o.vendorId]).filter(Boolean).map(String))]

  const itemObjectIds = itemIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id))
  const userObjectIds = userIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id))

  const [itemDocs, userDocs] = await Promise.all([
    itemObjectIds.length ? menuItems.find({ _id: { $in: itemObjectIds } }).toArray() : [],
    userObjectIds.length ? users.find({ _id: { $in: userObjectIds } }).toArray() : [],
  ])

  const itemMap = new Map(itemDocs.map((d) => [d._id.toString(), d]))
  const userMap = new Map(userDocs.map((d) => [d._id.toString(), d]))

  return orders.map((order) => {
    const o = normalizeOrder(order)
    const item = itemMap.get(String(o.itemId || ''))
    const customer = userMap.get(String(o.customerId || ''))
    const vendor = userMap.get(String(o.vendorId || ''))
    const itemName = item?.itemName || item?.pizzaName || item?.name || o.itemName || o.pizzaName || o.menuItemName || ''
    const imageUrl = item?.imageUrl || item?.image || (Array.isArray(item?.images) ? item.images[0] : '') || o.imageUrl || o.pizzaImage || ''
    const isDemo = Boolean(o.isDemo || item?.isDemo)
    return {
      ...o,
      isDemo,
      itemName,
      pizzaName: o.pizzaName || itemName,
      menuItemName: o.menuItemName || itemName,
      imageUrl,
      pizzaImage: o.pizzaImage || imageUrl,
      price: o.price ?? item?.price,
      customerName: o.customerName || customer?.name || o.customer?.name || '',
      customerEmail: o.customerEmail || customer?.email || o.customer?.email || '',
      vendorName: o.vendorName || vendor?.businessName || vendor?.name || (isDemo ? 'PizzaHub Demo' : ''),
      vendorEmail: o.vendorEmail || vendor?.email || '',
      item: item ? { _id: item._id, itemName, pizzaName: itemName, price: item.price, imageUrl, category: item.category, location: item.location, isDemo: Boolean(item.isDemo) } : o.item,
      customer: customer ? { _id: customer._id, name: customer.name, email: customer.email, image: customer.image } : o.customer,
    }
  })
}

const SIZE_MULTIPLIERS = { Small: 1, Medium: 1.25, Large: 1.5 }
const TOPPING_PRICE = 1.5
const DELIVERY_CHARGE = 3
const ALLOWED_TOPPINGS = new Set([
  'Extra Cheese', 'Mushrooms', 'Olives', 'Jalapeños', 'Pepperoni', 'Onions', 'Bell Peppers'
])

function roundMoney(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100 }

router.post('/orders', requireAuth(), requireRole('customer'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const body = req.body || {}

  const rawItemId = body.itemId ?? body.menuItemId ?? body.menuId ?? body._id ?? body.item?._id ?? body.item?.id
  const itemId = String(rawItemId ?? '').trim()
  if (!itemId) {
    return sendError(res, 400, 'A valid menu item ID is required')
  }
  if (!isValidObjectId(itemId)) {
    return sendError(res, 400, 'A valid menu item ID is required. Must be a 24-character MongoDB ObjectId.')
  }

  const { menuItems } = collections()
  const item = await menuItems.findOne({ _id: new ObjectId(itemId) })
  if (!item) return sendError(res, 404, 'Menu item not found')

  const approvalStatus = String(item.approvalStatus || 'pending').toLowerCase()
  const availability = String(item.availability || 'active').toLowerCase()
  if (approvalStatus !== 'approved' || availability !== 'active') {
    return sendError(res, 400, 'This menu item is not available for ordering')
  }

  const vendorId = String(item.vendorId || '').trim()
  if (!vendorId) return sendError(res, 400, 'Menu item vendor information is missing')
  if (vendorId === req.auth.id) return sendError(res, 403, 'Vendors cannot order their own items')

  const dbItemName = String(item.itemName || item.pizzaName || item.name || '').trim()
  const dbBasePrice = Number(item.price)
  const dbImage = String(item.imageUrl || item.image || (Array.isArray(item.images) ? item.images[0] : '') || '')
  const dbCategory = String(item.category || '')

  if (!dbItemName || !Number.isFinite(dbBasePrice) || dbBasePrice < 0) {
    return sendError(res, 400, 'Menu item data is invalid')
  }

  const isRichOrder = body.size !== undefined || body.quantity !== undefined || body.phone !== undefined || body.city !== undefined || body.area !== undefined
  const now = new Date()

  let doc
  if (!isRichOrder) {
    const deliveryDateRaw = body.deliveryDate || body.orderDate
    const deliveryAddress = body.deliveryAddress
    const message = typeof body.message === 'string' ? body.message.trim() : typeof body.additionalMessage === 'string' ? body.additionalMessage.trim() : typeof body.notes === 'string' ? body.notes.trim() : ''

    if (!deliveryDateRaw) return sendError(res, 400, 'deliveryDate is required')
    const deliveryDate = new Date(deliveryDateRaw)
    if (Number.isNaN(deliveryDate.getTime())) return sendError(res, 400, 'deliveryDate must be a valid date')
    if (deliveryAddress === undefined || deliveryAddress === null || (typeof deliveryAddress === 'string' && !deliveryAddress.trim())) {
      return sendError(res, 400, 'deliveryAddress is required')
    }

    const dayStart = new Date(deliveryDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayStart)
    dayEnd.setDate(dayEnd.getDate() + 1)

    const duplicate = await orders.findOne({
      customerId: req.auth.id,
      itemId,
      status: { $in: ['pending', 'accepted', 'confirmed', 'preparing', 'ready', 'out_for_delivery'] },
      $or: [
        { deliveryDate: { $gte: dayStart, $lt: dayEnd } },
        { orderDate: { $gte: dayStart, $lt: dayEnd } },
      ],
    })
    if (duplicate) return sendError(res, 409, 'You already have an active order for this item on the selected delivery date')

    doc = {
      itemId,
      menuItemId: itemId,
      vendorId,
      customerId: req.auth.id,
      customerName: req.auth.name,
      customerEmail: req.auth.email,
      deliveryDate,
      orderDate: deliveryDate,
      deliveryAddress: typeof deliveryAddress === 'string' ? deliveryAddress.trim() : deliveryAddress,
      message,
      additionalMessage: message,
      notes: message,
      status: 'pending',
      paymentStatus: 'unpaid',
      itemName: dbItemName,
      pizzaName: dbItemName,
      imageUrl: dbImage,
      pizzaImage: dbImage,
      category: dbCategory,
      price: roundMoney(dbBasePrice),
      totalAmount: roundMoney(dbBasePrice),
      quantity: 1,
      items: [{ menuItemId: itemId, name: dbItemName, quantity: 1, price: roundMoney(dbBasePrice) }],
      createdAt: now,
      updatedAt: now,
    }
  } else {
    const customerName = String(body.customerName || req.auth.name || '').trim()
    const customerEmail = String(body.customerEmail || req.auth.email || '').trim().toLowerCase()
    const phone = String(body.phone || '').trim()
    const address = String(body.deliveryAddress || '').trim()
    const city = String(body.city || '').trim()
    const area = String(body.area || '').trim()
    const quantity = Number(body.quantity)
    const size = String(body.size || '').trim()
    const extraToppings = Array.isArray(body.extraToppings) ? body.extraToppings.map((t) => String(t).trim()).filter(Boolean) : []
    const specialInstructions = String(body.specialInstructions || '').trim()
    const deliveryDateRaw = body.deliveryDate || body.orderDate

    if (!customerName) return sendError(res, 400, 'Customer name is required')
    if (!customerEmail) return sendError(res, 400, 'Email is required')
    if (!phone) return sendError(res, 400, 'Phone number is required')
    if (!address) return sendError(res, 400, 'Delivery address is required')
    if (!city) return sendError(res, 400, 'City is required')
    if (!area) return sendError(res, 400, 'Area is required')
    if (!deliveryDateRaw) return sendError(res, 400, 'deliveryDate is required')
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return sendError(res, 400, 'Quantity must be between 1 and 20')
    if (!Object.prototype.hasOwnProperty.call(SIZE_MULTIPLIERS, size)) return sendError(res, 400, 'Invalid pizza size')
    for (const t of extraToppings) {
      if (!ALLOWED_TOPPINGS.has(t)) return sendError(res, 400, `Invalid topping: ${t}`)
    }

    const deliveryDate = new Date(deliveryDateRaw)
    if (Number.isNaN(deliveryDate.getTime())) return sendError(res, 400, 'deliveryDate must be a valid date')

    const dayStart = new Date(deliveryDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayStart)
    dayEnd.setDate(dayEnd.getDate() + 1)
    const duplicate = await orders.findOne({
      customerId: req.auth.id,
      itemId,
      status: { $in: ['pending', 'accepted', 'confirmed', 'preparing', 'ready', 'out_for_delivery'] },
      $or: [
        { deliveryDate: { $gte: dayStart, $lt: dayEnd } },
        { orderDate: { $gte: dayStart, $lt: dayEnd } },
      ],
    })
    if (duplicate) return sendError(res, 409, 'You already have an active order for this item on the selected delivery date')

    const sizeMultiplier = SIZE_MULTIPLIERS[size]
    const unitPrice = roundMoney(dbBasePrice * sizeMultiplier)
    const toppingsTotal = roundMoney(extraToppings.length * TOPPING_PRICE)
    const subtotal = roundMoney(unitPrice * quantity + toppingsTotal)
    const deliveryCharge = roundMoney(DELIVERY_CHARGE)
    const totalAmount = roundMoney(subtotal + deliveryCharge)
    const fullAddress = `${address}, ${area}, ${city}`

    doc = {
      itemId,
      menuItemId: itemId,
      vendorId,
      customerId: req.auth.id,
      customerName,
      customerEmail,
      phone,
      city,
      area,
      deliveryAddress: fullAddress,
      address,
      specialInstructions,
      message: specialInstructions,
      additionalMessage: specialInstructions,
      notes: specialInstructions,
      size,
      extraToppings,
      basePrice: roundMoney(dbBasePrice),
      unitPrice,
      toppingsTotal,
      subtotal,
      deliveryCharge,
      totalAmount,
      quantity,
      status: 'pending',
      paymentStatus: 'unpaid',
      itemName: dbItemName,
      pizzaName: dbItemName,
      pizzaImage: dbImage,
      imageUrl: dbImage,
      category: dbCategory,
      price: totalAmount,
      items: [{ menuItemId: itemId, name: dbItemName, quantity, price: unitPrice, size, extraToppings, toppingsTotal }],
      ...(deliveryDate ? { deliveryDate, orderDate: deliveryDate } : {}),
      createdAt: now,
      updatedAt: now,
    }
  }

  doc.isDemo = Boolean(item.isDemo)
  if (doc.isDemo) {
    doc.demoVendorVisible = true
  }

  const result = await orders.insertOne(doc)
  const created = await orders.findOne({ _id: result.insertedId })
  const [enriched] = await enrichOrders([created])
  return res.status(201).send({ success: true, message: 'Order created successfully', insertedId: result.insertedId, data: enriched, order: enriched })
}))

router.get('/orders', requireAuth(), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const query = {}
  const role = req.auth.role

  if (role === 'customer') query.customerId = req.auth.id
  if (role === 'vendor') Object.assign(query, vendorOrderAccessQuery(req.auth.id))
  if (role === 'admin' && req.query.vendorId) query.vendorId = String(req.query.vendorId)
  if (role === 'admin' && req.query.customerId) query.customerId = String(req.query.customerId)
  if (req.query.status) query.status = normalizeStatus(req.query.status)

  const pagination = req.query.page || req.query.limit ? parsePagination(req.query) : null
  if (pagination?.error) return sendError(res, 400, pagination.error)

  let cursor = orders.find(query).sort({ createdAt: -1, orderDate: -1 })
  if (pagination) cursor = cursor.skip(pagination.skip).limit(pagination.limit)
  const docs = await cursor.toArray()
  const data = await enrichOrders(docs)
  if (pagination) {
    const total = await orders.countDocuments(query)
    return res.status(200).send({ success: true, data, orders: data, pagination: { page: pagination.page, limit: pagination.limit, total, totalPages: Math.ceil(total / pagination.limit) || 1 } })
  }
  res.status(200).send(data)
}))

router.get('/orders/vendor', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const docs = await orders.find(vendorOrderAccessQuery(req.auth.id)).sort({ createdAt: -1 }).toArray()
  const data = await enrichOrders(docs)
  res.status(200).send({ success: true, data, orders: data })
}))

router.get('/orders/my-vendor-orders', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const docs = await orders.find(vendorOrderAccessQuery(req.auth.id)).sort({ createdAt: -1 }).toArray()
  const data = await enrichOrders(docs)
  res.status(200).send({ success: true, data, orders: data })
}))

router.get('/orders/my-orders', requireAuth(), requireRole('customer'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const docs = await orders.find({ customerId: req.auth.id }).sort({ createdAt: -1 }).toArray()
  const data = await enrichOrders(docs)
  res.status(200).send({ success: true, data, orders: data })
}))

router.get('/orders/customer', requireAuth(), requireRole('customer'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const docs = await orders.find({ customerId: req.auth.id }).sort({ createdAt: -1 }).toArray()
  const data = await enrichOrders(docs)
  res.status(200).send({ success: true, data, orders: data })
}))

router.get('/vendor/orders', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const docs = await orders.find(vendorOrderAccessQuery(req.auth.id)).sort({ createdAt: -1 }).toArray()
  const data = await enrichOrders(docs)
  res.status(200).send(data)
}))

router.get('/vendor/orders/:id', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid order ID')
  const order = await orders.findOne({ _id: new ObjectId(id), ...vendorOrderAccessQuery(req.auth.id) })
  if (!order) return sendError(res, 404, 'Order not found')
  const [enriched] = await enrichOrders([order])
  res.status(200).send(enriched)
}))

router.patch('/vendor/orders/:id/status', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const { id } = req.params
  const status = normalizeStatus(req.body?.status)
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid order ID')
  if (!ORDER_STATUSES.includes(status)) return sendError(res, 400, `Invalid order status. Allowed: ${ORDER_STATUSES.join(', ')}`)

  const existing = await orders.findOne({ _id: new ObjectId(id), ...vendorOrderAccessQuery(req.auth.id) })
  if (!existing) return sendError(res, 404, 'Order not found')

  const current = normalizeStatus(existing.status)
  if (['accepted', 'rejected'].includes(status) && current !== 'pending') {
    return sendError(res, 400, 'Only pending orders can be accepted or rejected')
  }

  await orders.updateOne({ _id: existing._id }, { $set: { status, updatedAt: new Date(), statusUpdatedAt: new Date() } })
  res.status(200).send({ success: true, message: 'Order status updated successfully', orderId: id, status })
}))

router.get('/orders/:id', requireAuth(), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid order ID')
  const order = await orders.findOne({ _id: new ObjectId(id) })
  if (!order) return sendError(res, 404, 'Order not found')

  const role = req.auth.role
  if (role === 'customer' && String(order.customerId) !== req.auth.id) return sendError(res, 403, 'You do not have access to this order')
  if (role === 'vendor' && String(order.vendorId) !== req.auth.id && !isDemoOrder(order)) return sendError(res, 403, 'You do not have access to this order')

  const [enriched] = await enrichOrders([order])
  res.status(200).send({ success: true, data: enriched, order: enriched })
}))

async function vendorOrderAction(req, res, nextStatus) {
  const { orders } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid order ID')
  const order = await orders.findOne({ _id: new ObjectId(id), ...vendorOrderAccessQuery(req.auth.id) })
  if (!order) return sendError(res, 404, 'Order not found or you do not have access to this order')
  if (normalizeStatus(order.status) !== 'pending') {
    return sendError(res, 400, `Only pending orders can be ${nextStatus}`)
  }
  const now = new Date()
  await orders.updateOne({ _id: order._id }, { $set: { status: nextStatus, updatedAt: now, statusUpdatedAt: now } })
  const updated = await orders.findOne({ _id: order._id })
  const [enriched] = await enrichOrders([updated])
  res.status(200).send({ success: true, message: `Order ${nextStatus} successfully`, data: enriched, order: enriched })
}

router.patch('/orders/:id/accept', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => vendorOrderAction(req, res, 'accepted')))
router.patch('/orders/:id/reject', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => vendorOrderAction(req, res, 'rejected')))

router.patch('/orders/:id/cancel', requireAuth(), requireRole('customer'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const { id } = req.params
  if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid order ID')
  const order = await orders.findOne({ _id: new ObjectId(id), customerId: req.auth.id })
  if (!order) return sendError(res, 404, 'Order not found')
  if (normalizeStatus(order.status) !== 'pending') {
    return sendError(res, 400, 'Only pending orders can be cancelled')
  }
  const now = new Date()
  await orders.updateOne({ _id: order._id }, { $set: { status: 'cancelled', updatedAt: now, statusUpdatedAt: now } })
  const updated = await orders.findOne({ _id: order._id })
  const [enriched] = await enrichOrders([updated])
  res.status(200).send({ success: true, message: 'Order cancelled successfully', data: enriched, order: enriched })
}))

router.patch('/orders/:id', requireAuth(), asyncHandler(async (req, res) => {
  const status = normalizeStatus(req.body?.status)
  if (status === 'accepted' || status === 'rejected') {
    if (req.auth.role !== 'vendor') return sendError(res, 403, 'Only vendors can accept or reject orders')
    return vendorOrderAction(req, res, status)
  }
  if (status === 'cancelled') {
    if (req.auth.role !== 'customer') return sendError(res, 403, 'Only customers can cancel orders')
    // reuse cancel logic
    req.params.id = req.params.id
    const { orders } = collections()
    const { id } = req.params
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid order ID')
    const order = await orders.findOne({ _id: new ObjectId(id), customerId: req.auth.id })
    if (!order) return sendError(res, 404, 'Order not found')
    if (normalizeStatus(order.status) !== 'pending') return sendError(res, 400, 'Only pending orders can be cancelled')
    const now = new Date()
    await orders.updateOne({ _id: order._id }, { $set: { status: 'cancelled', updatedAt: now, statusUpdatedAt: now } })
    const updated = await orders.findOne({ _id: order._id })
    const [enriched] = await enrichOrders([updated])
    return res.status(200).send({ success: true, message: 'Order cancelled successfully', data: enriched, order: enriched })
  }
  return sendError(res, 400, 'Unsupported order status update')
}))

export default router

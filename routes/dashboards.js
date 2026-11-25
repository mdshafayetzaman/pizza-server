import express from 'express'
import { collections } from '../config/db.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { asyncHandler } from '../utils/response.js'

const router = express.Router()

router.get('/dashboard/vendor', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const { menuItems, orders, users } = collections()
  const vendorId = req.auth.id
  const [totalMenuItems, activeMenuItems, pendingOrders, acceptedOrders, user] = await Promise.all([
    menuItems.countDocuments({ vendorId }),
    menuItems.countDocuments({ vendorId, $or: [{ availability: 'active' }, { availability: true }, { availability: { $exists: false } }], approvalStatus: { $ne: 'rejected' } }),
    orders.countDocuments({ vendorId, status: 'pending' }),
    orders.countDocuments({ vendorId, status: 'accepted' }),
    users.findOne({ _id: req.auth._id }),
  ])

  const plan = String(user?.subscriptionPlan || 'free').toLowerCase() === 'premium' ? 'premium' : 'free'
  const data = {
    totalMenuItems,
    activeMenuItems,
    pendingCustomerOrders: pendingOrders,
    pendingOrders,
    acceptedOrders,
    currentSubscriptionPlan: plan,
    subscriptionPlan: plan,
  }
  res.status(200).send({ success: true, data })
}))

router.get('/vendor/dashboard', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  req.url = '/dashboard/vendor'
  return router.handle(req, res)
}))

router.get('/dashboard/customer', requireAuth(), requireRole('customer'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const customerId = req.auth.id
  const [totalOrders, pendingOrders, acceptedOrders, rejectedOrders] = await Promise.all([
    orders.countDocuments({ customerId }),
    orders.countDocuments({ customerId, status: 'pending' }),
    orders.countDocuments({ customerId, status: 'accepted' }),
    orders.countDocuments({ customerId, status: 'rejected' }),
  ])
  res.status(200).send({ success: true, data: { totalOrders, pendingOrders, acceptedOrders, rejectedOrders } })
}))

router.get('/customer/dashboard', requireAuth(), requireRole('customer'), asyncHandler(async (req, res) => {
  const { orders } = collections()
  const customerId = req.auth.id
  const [totalOrders, pendingOrders, acceptedOrders, rejectedOrders] = await Promise.all([
    orders.countDocuments({ customerId }),
    orders.countDocuments({ customerId, status: 'pending' }),
    orders.countDocuments({ customerId, status: 'accepted' }),
    orders.countDocuments({ customerId, status: 'rejected' }),
  ])
  res.status(200).send({ success: true, data: { totalOrders, pendingOrders, acceptedOrders, rejectedOrders } })
}))

router.get('/dashboard/admin', requireAuth(), requireRole('admin'), asyncHandler(async (req, res) => {
  const { users, menuItems, transactions } = collections()
  const [totalUsers, totalVendors, totalCustomers, totalMenuItems, pendingMenuItems, totalTransactions] = await Promise.all([
    users.countDocuments({}),
    users.countDocuments({ role: 'vendor' }),
    users.countDocuments({ role: 'customer' }),
    menuItems.countDocuments({}),
    menuItems.countDocuments({ $or: [{ approvalStatus: 'pending' }, { status: 'pending' }] }),
    transactions.countDocuments({}),
  ])
  res.status(200).send({ success: true, data: { totalRegisteredUsers: totalUsers, totalUsers, totalVendors, totalCustomers, totalMenuItems, pendingMenuItems, totalTransactions } })
}))

router.get('/admin/dashboard', requireAuth(), requireRole('admin'), asyncHandler(async (req, res) => {
  const { users, menuItems, transactions } = collections()
  const [totalUsers, totalVendors, totalCustomers, totalMenuItems, pendingMenuItems, totalTransactions] = await Promise.all([
    users.countDocuments({}),
    users.countDocuments({ role: 'vendor' }),
    users.countDocuments({ role: 'customer' }),
    menuItems.countDocuments({}),
    menuItems.countDocuments({ $or: [{ approvalStatus: 'pending' }, { status: 'pending' }] }),
    transactions.countDocuments({}),
  ])
  res.status(200).send({ success: true, data: { totalRegisteredUsers: totalUsers, totalUsers, totalVendors, totalCustomers, totalMenuItems, pendingMenuItems, totalTransactions } })
}))

export default router

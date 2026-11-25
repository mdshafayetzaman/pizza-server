import express from 'express'
import { ObjectId } from 'mongodb'
import { collections } from '../config/db.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { asyncHandler } from '../utils/response.js'
import { isValidObjectId } from '../utils/validate.js'

const router = express.Router()

function normalizeTransaction(doc = {}) {
  return {
    ...doc,
    _id: doc._id,
    id: doc._id?.toString?.() || doc.id,
    vendorId: doc.vendorId?.toString?.() || doc.vendorId || '',
    plan: doc.plan || doc.subscriptionPlan || '',
    amount: Number(doc.amount ?? doc.price ?? 0),
    currency: doc.currency || 'usd',
    stripeSessionId: doc.stripeSessionId || '',
    stripeSubscriptionId: doc.stripeSubscriptionId || '',
    status: doc.status || doc.paymentStatus || 'unknown',
    paymentStatus: doc.paymentStatus || doc.status || 'unknown',
    createdAt: doc.createdAt,
  }
}

async function listTransactions(req, res) {
  const { transactions, users } = collections()
  const query = {}
  if (req.query.status) query.status = String(req.query.status)
  if (req.query.vendorId && isValidObjectId(String(req.query.vendorId))) {
    query.vendorId = String(req.query.vendorId)
  }

  const docs = await transactions.find(query).sort({ createdAt: -1 }).toArray()
  const vendorIds = [...new Set(docs.map((d) => String(d.vendorId)).filter((id) => isValidObjectId(id)))]
  const vendorDocs = vendorIds.length
    ? await users.find({ _id: { $in: vendorIds.map((id) => new ObjectId(id)) } }).toArray()
    : []
  const vendorMap = new Map(vendorDocs.map((v) => [v._id.toString(), v]))

  let data = docs.map((doc) => {
    const t = normalizeTransaction(doc)
    const vendor = vendorMap.get(String(t.vendorId))
    return {
      ...t,
      vendorName: vendor?.businessName || vendor?.name || t.vendorName || '',
      vendorEmail: vendor?.email || t.vendorEmail || '',
      vendor: vendor
        ? { _id: vendor._id, name: vendor.name, email: vendor.email, businessName: vendor.businessName }
        : null,
    }
  })

  const search = req.query.search || req.query.q
  if (search) {
    const s = String(search).toLowerCase()
    data = data.filter((t) =>
      [t.vendorName, t.vendorEmail, t.plan, t.status, t.stripeSessionId, t.stripeSubscriptionId, t.currency]
        .some((v) => String(v || '').toLowerCase().includes(s))
    )
  }

  res.status(200).send({ success: true, data, transactions: data })
}

router.get('/transactions', requireAuth(), requireRole('admin'), asyncHandler(listTransactions))
router.get('/payments', requireAuth(), requireRole('admin'), asyncHandler(listTransactions))

export default router

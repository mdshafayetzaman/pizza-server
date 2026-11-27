import express from 'express'
import Stripe from 'stripe'
import { ObjectId } from 'mongodb'
import { collections } from '../config/db.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { asyncHandler, sendError } from '../utils/response.js'

const router = express.Router()

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key)
}

function normalizePlan(user = {}) {
  const plan = String(user.subscriptionPlan || 'free').toLowerCase()
  return plan === 'premium' ? 'premium' : 'free'
}

function isPremiumActive(user = {}) {
  const plan = normalizePlan(user)
  if (plan !== 'premium') return false
  const expiresAt = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : null
  if (!expiresAt) return true
  return !Number.isNaN(expiresAt.getTime()) && expiresAt > new Date()
}

async function getCurrentUserDoc(req) {
  const { users } = collections()
  return users.findOne({ _id: req.auth._id })
}

router.get('/subscriptions/me', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const user = await getCurrentUserDoc(req)
  if (!user) return sendError(res, 404, 'User not found')
  const premiumActive = isPremiumActive(user)
  const data = {
    plan: premiumActive ? 'premium' : 'free',
    subscriptionPlan: premiumActive ? 'premium' : 'free',
    status: premiumActive ? 'active' : 'inactive',
    subscriptionStatus: premiumActive ? 'active' : 'inactive',
    isPremium: premiumActive,
    expiresAt: user.subscriptionExpiresAt || null,
    subscriptionExpiresAt: user.subscriptionExpiresAt || null,
  }
  res.status(200).send({ success: true, data, subscription: data })
}))

router.get('/users/subscription', requireAuth(), requireRole('vendor'), asyncHandler(async (req, res) => {
  const user = await getCurrentUserDoc(req)
  if (!user) return sendError(res, 404, 'User not found')
  const premiumActive = isPremiumActive(user)
  const data = {
    plan: premiumActive ? 'premium' : 'free',
    status: premiumActive ? 'active' : 'inactive',
    isPremium: premiumActive,
    expiresAt: user.subscriptionExpiresAt || null,
  }
  res.status(200).send({ success: true, data, subscription: data })
}))

const createCheckoutSessionHandler = asyncHandler(async (req, res) => {
  const stripe = getStripe()
  if (!stripe) return sendError(res, 500, 'Stripe is not configured on the server')

  const { users } = collections()
  const user = await users.findOne({ _id: req.auth._id })
  if (!user) return sendError(res, 404, 'User not found')

  const frontendBase = (
    process.env.CLIENT_URL ||
    process.env.FRONTEND_URL ||
    process.env.PRODUCTION_FRONTEND_URL ||
    'https://pizza-client-lyart.vercel.app'
  ).replace(/\/+$/, '')
  const successUrl = process.env.STRIPE_SUCCESS_URL || `${frontendBase}/dashboard/vendor/subscription?success=true&session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl = process.env.STRIPE_CANCEL_URL || `${frontendBase}/dashboard/vendor/subscription?cancelled=true`

  const priceId = process.env.STRIPE_PREMIUM_PRICE_ID || process.env.STRIPE_PRICE_ID
  const amount = Number(process.env.STRIPE_PREMIUM_AMOUNT || 999)
  const currency = process.env.STRIPE_CURRENCY || 'usd'

  const lineItems = priceId
    ? [{ price: priceId, quantity: 1 }]
    : [{
        price_data: {
          currency,
          product_data: { name: 'PizzaHub Premium Vendor Subscription' },
          unit_amount: Number.isFinite(amount) ? amount : 999,
          recurring: { interval: process.env.STRIPE_PREMIUM_INTERVAL || 'month' },
        },
        quantity: 1,
      }]

  let session
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: user.email || undefined,
      client_reference_id: user._id.toString(),
      metadata: {
        vendorId: user._id.toString(),
        userId: user._id.toString(),
        plan: 'premium',
      },
      subscription_data: {
        metadata: {
          vendorId: user._id.toString(),
          userId: user._id.toString(),
          plan: 'premium',
        },
      },
    })
  } catch (error) {
    const stripeCode = error?.code || error?.raw?.code
    const stripeType = error?.type || error?.raw?.type
    const statusCode = Number(error?.statusCode || error?.raw?.statusCode) || 500
    console.error('Stripe checkout session creation failed:', {
      message: error?.message,
      type: stripeType,
      code: stripeCode,
      statusCode,
      vendorId: user._id.toString(),
      hasPriceId: Boolean(priceId),
      endpoint: req.originalUrl,
    })

    const clientMessage =
      statusCode >= 400 && statusCode < 500
        ? `Stripe checkout request failed: ${error?.message || 'Invalid Stripe configuration or request.'}`
        : 'Failed to create Stripe checkout session. Please check Stripe server configuration.'

    return sendError(res, statusCode >= 400 && statusCode < 600 ? statusCode : 500, clientMessage)
  }

  if (!session?.url) {
    console.error('Stripe checkout session created without URL:', { sessionId: session?.id, vendorId: user._id.toString() })
    return sendError(res, 500, 'Stripe checkout session was created but no checkout URL was returned.')
  }

  res.status(200).send({ success: true, url: session.url, sessionId: session.id, data: { url: session.url, sessionId: session.id } })
})

router.post('/subscriptions/create-checkout-session', requireAuth(), requireRole('vendor'), createCheckoutSessionHandler)
router.post('/create-checkout-session', requireAuth(), requireRole('vendor'), createCheckoutSessionHandler)

export async function stripeWebhookHandler(req, res) {
  const stripe = getStripe()
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!stripe || !webhookSecret) {
    return sendError(res, 500, 'Stripe webhook is not configured')
  }

  const sig = req.headers['stripe-signature']
  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message)
    return sendError(res, 400, `Webhook signature verification failed: ${err.message}`)
  }

  try {
    await handleStripeEvent(event, stripe)
    res.status(200).send({ received: true })
  } catch (error) {
    console.error('Stripe webhook handling error:', error)
    res.status(500).send({ received: false })
  }
}

async function handleStripeEvent(event, stripe) {
  const { transactions, users } = collections()

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    if (session.payment_status !== 'paid' && session.status !== 'complete') return

    const vendorId = session.metadata?.vendorId || session.metadata?.userId || session.client_reference_id
    if (!vendorId) return

    const existing = await transactions.findOne({ stripeSessionId: session.id })
    if (existing) return

    let subscriptionId = session.subscription || ''
    let expiresAt = null
    if (subscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(String(subscriptionId))
        const periodEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end
        if (periodEnd) expiresAt = new Date(periodEnd * 1000)
        subscriptionId = sub.id
      } catch (e) {
        console.error('Failed to retrieve subscription:', e.message)
      }
    }

    await transactions.insertOne({
      vendorId: String(vendorId),
      plan: 'premium',
      amount: Number(session.amount_total ?? 0) / 100,
      currency: session.currency || 'usd',
      stripeSessionId: session.id,
      stripeSubscriptionId: String(subscriptionId || ''),
      status: 'paid',
      paymentStatus: 'paid',
      createdAt: new Date(),
    })

    if (ObjectId.isValid(String(vendorId))) {
      await users.updateOne(
        { _id: new ObjectId(String(vendorId)) },
        {
          $set: {
            subscriptionPlan: 'premium',
            subscriptionStatus: 'active',
            ...(expiresAt ? { subscriptionExpiresAt: expiresAt } : {}),
            updatedAt: new Date(),
          },
        }
      )
    }
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object
    const vendorId = sub.metadata?.vendorId || sub.metadata?.userId
    const status = String(sub.status || '').toLowerCase()
    const periodEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end
    const expiresAt = periodEnd ? new Date(periodEnd * 1000) : null

    let userQuery = null
    if (vendorId && ObjectId.isValid(String(vendorId))) {
      userQuery = { _id: new ObjectId(String(vendorId)) }
    } else if (sub.id) {
      userQuery = { stripeSubscriptionId: String(sub.id) }
    }

    const update = { updatedAt: new Date() }
    if (['active', 'trialing'].includes(status)) {
      update.subscriptionPlan = 'premium'
      update.subscriptionStatus = status
      if (expiresAt) update.subscriptionExpiresAt = expiresAt
    } else if (['canceled', 'unpaid', 'past_due', 'incomplete_expired'].includes(status)) {
      update.subscriptionPlan = 'free'
      update.subscriptionStatus = status
      update.subscriptionExpiresAt = expiresAt || new Date()
    }

    if (userQuery) {
      await users.updateOne(userQuery, { $set: update })
    }

    if (sub.id) {
      await transactions.updateMany(
        { stripeSubscriptionId: String(sub.id) },
        { $set: { subscriptionStatus: status, updatedAt: new Date() } }
      )
    }
  }
}

export default router

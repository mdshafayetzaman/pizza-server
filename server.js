import http from 'http'
import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { connectDB } from './config/db.js'
import menuRoutes from './routes/menu.js'
import orderRoutes from './routes/orders.js'
import userRoutes from './routes/users.js'
import transactionRoutes from './routes/transactions.js'
import subscriptionRoutes, { stripeWebhookHandler } from './routes/subscriptions.js'
import dashboardRoutes from './routes/dashboards.js'
import { sendError } from './utils/response.js'

const app = express()
const port = process.env.PORT || 5001

const requiredOrigins = [
  'http://localhost:3000',
  'https://pizza-client-lyart.vercel.app',
]

const configuredOrigins = [
  process.env.CLIENT_URL,
  process.env.BETTER_AUTH_URL,
  process.env.FRONTEND_URL,
  process.env.PRODUCTION_FRONTEND_URL,
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : []),
]
  .map((origin) => String(origin || '').trim().replace(/\/+$/, ''))
  .filter(Boolean)

const devOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
]

const allowedOrigins = new Set([...requiredOrigins, ...configuredOrigins, ...devOrigins])
const isProduction = process.env.NODE_ENV === 'production'

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser/server-to-server requests with no Origin header.
    if (!origin) return callback(null, true)

    const normalized = String(origin).trim().replace(/\/+$/, '')
    if (allowedOrigins.has(normalized)) return callback(null, true)

    // In non-production, allow any localhost/127.0.0.1 port for dev convenience.
    if (!isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) {
      return callback(null, true)
    }

    console.warn('CORS blocked origin:', normalized)
    return callback(null, false)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
}

app.use(cors(corsOptions))
app.options(/(.*)/, cors(corsOptions))

// Ensure DB connection for serverless environments (e.g. Vercel).
app.use(async (_req, _res, next) => {
  try {
    await connectDB()
    next()
  } catch (error) {
    next(error)
  }
})

app.post('/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler)
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get('/', (req, res) => {
  res.status(200).send({
    success: true,
    message: 'PizzaHub API is working',
  })
})

app.get('/health', (req, res) => {
  res.status(200).send({ success: true, status: 'ok' })
})

app.use(menuRoutes)
app.use(orderRoutes)
app.use(userRoutes)
app.use(transactionRoutes)
app.use(subscriptionRoutes)
app.use(dashboardRoutes)

app.use((req, res) => {
  return sendError(res, 404, 'API route not found')
})

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err)
  if (res.headersSent) return next(err)
  const status = err.status || 500
  const message = status >= 500 ? 'Internal server error' : err.message || 'Request failed'
  return sendError(res, status, message)
})

const startServer = async () => {
  try {
    await connectDB()
    console.log('MongoDB Connected')

    const maxHeaderSize = Number(process.env.MAX_HTTP_HEADER_SIZE || 32768)
    const server = http.createServer({ maxHeaderSize }, app)
    server.listen(port, () => {
      console.log(`Server is running on port ${port}`)
    })
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error)
    process.exit(1)
  }
}

if (!process.env.VERCEL) {
  startServer()
}

export default app;

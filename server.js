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

const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.BETTER_AUTH_URL,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
].filter(Boolean)

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
      if (/^http:\/\/localhost:\d+$/.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
        return callback(null, true)
      }
      return callback(null, true) // Keep compatibility for deployed frontends; tighten via env if needed.
    },
    credentials: true,
  })
)

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

startServer()

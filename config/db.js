import { MongoClient } from 'mongodb'
import { seedDemoMenuItems } from '../utils/seedDemoMenuItems.js'

const mongoUri =
  process.env.MONGO_DB_URL ||
  `mongodb://${process.env.MONGO_DB_USER}:${process.env.MONGO_DB_PASS}@ac-djrpurl-shard-00-00.7xnwnzw.mongodb.net:27017,ac-djrpurl-shard-00-01.7xnwnzw.mongodb.net:27017,ac-djrpurl-shard-00-02.7xnwnzw.mongodb.net:27017/?ssl=true&replicaSet=atlas-viv4el-shard-0&authSource=admin`

const dbName = process.env.MONGO_DB_NAME || 'pizza-hut'
const legacyDbName = process.env.LEGACY_MONGO_DB_NAME || 'pizza-hub'

export const client = new MongoClient(mongoUri)

let database
let legacyDatabase

export async function connectDB() {
  if (database) return database

  await client.connect()
  database = client.db(dbName)
  legacyDatabase = client.db(legacyDbName)

  await ensureCollections(database)
  await migrateLegacyBusinessData(database, legacyDatabase)
  await seedDemoMenuItems(database)

  return database
}

export function getDB() {
  if (!database) {
    throw new Error('Database not connected')
  }
  return database
}

export function getLegacyDB() {
  return legacyDatabase
}

export function collections() {
  const db = getDB()
  return {
    users: db.collection('user'),
    menuItems: db.collection('menuItems'),
    orders: db.collection('orders'),
    transactions: db.collection('transactions'),
  }
}

async function ensureCollections(db) {
  const existing = await db.listCollections({}, { nameOnly: true }).toArray()
  const names = new Set(existing.map((c) => c.name))

  for (const name of ['menuItems', 'orders', 'transactions']) {
    if (!names.has(name)) {
      await db.createCollection(name)
      console.log(`Created ${name} collection`)
    }
  }

  try {
    await db.collection('menuItems').createIndex({ vendorId: 1, createdAt: -1 })
    await db.collection('menuItems').createIndex({ approvalStatus: 1, availability: 1 })
    await db.collection('orders').createIndex({ customerId: 1, createdAt: -1 })
    await db.collection('orders').createIndex({ vendorId: 1, createdAt: -1 })
    await db.collection('orders').createIndex({ itemId: 1, customerId: 1, status: 1 })
    await db.collection('transactions').createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true })
    await db.collection('transactions').createIndex({ vendorId: 1, createdAt: -1 })
  } catch (error) {
    console.error('Index creation warning:', error.message)
  }
}

async function migrateLegacyBusinessData(db, legacyDb) {
  if (!legacyDb || db.databaseName === legacyDb.databaseName) return

  for (const name of ['menuItems', 'orders', 'transactions']) {
    try {
      const targetCount = await db.collection(name).countDocuments()
      if (targetCount > 0) continue

      const legacyExists = await legacyDb
        .listCollections({ name }, { nameOnly: true })
        .toArray()
      if (legacyExists.length === 0) continue

      const docs = await legacyDb.collection(name).find({}).toArray()
      if (docs.length === 0) continue

      await db.collection(name).insertMany(docs, { ordered: false })
      console.log(`Migrated ${docs.length} ${name} document(s) from ${legacyDb.databaseName}`)
    } catch (error) {
      if (error?.code === 11000) continue
      console.error(`Legacy migration warning for ${name}:`, error.message)
    }
  }
}

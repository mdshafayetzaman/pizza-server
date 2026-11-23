import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { MongoClient } from 'mongodb'

const app = express()

app.use(express.json())
app.use(cors())

const port = process.env.PORT || 5001

const client = new MongoClient(
  `mongodb://${process.env.MONGO_DB_USER}:${process.env.MONGO_DB_PASS}@ac-djrpurl-shard-00-00.7xnwnzw.mongodb.net:27017,ac-djrpurl-shard-00-01.7xnwnzw.mongodb.net:27017,ac-djrpurl-shard-00-02.7xnwnzw.mongodb.net:27017/?ssl=true&replicaSet=atlas-viv4el-shard-0&authSource=admin`,
)

export async function connectToMongoDB() {
  try {
    await client.connect()
    console.log('You successfully connected to MongoDB!')
    return client
  } catch (err) {
    console.log(err)
    throw err
  }
}

const connectionClient = await connectToMongoDB()

const database = connectionClient.db('pizza-hub')

const users = database.collection('user')
const menuItems = database.collection('menuItems')

console.log('MongoDB Connected')

app.get('/', (req, res) => {
  res.send({ msg: 'API is working' })
})

app.get('/users', async (req, res) => {
  try {
    const result = await users.find({}).toArray()
    res.send(result)
  } catch (error) {
    res.status(500).send({ message: 'Failed to get users' })
  }
})

app.get('/menuItem', async (req, res) => {
  try {
    const result = await menuItems.find({}).toArray()
    res.send(result)
  } catch (error) {
    res.status(500).send({ message: 'Failed to get menu items' })
  }
})

app.post('/menuItem', async (req, res) => {
  try {
    const menu = req.body

    const result = await menuItems.insertOne(menu)

    res.send(result)
  } catch (error) {
    res.status(500).send({ message: 'Failed to create menu item' })
  }
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})

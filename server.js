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
const database = connectionClient.db('pizza-hut')
const users = database.collection('user')
const menuItems = database.collection('menuItems')
console.log('MongoDB Connected')

app.get('/', (req, res) => {
  res.send({ msg: 'api is working' })
})
app.get('/users', async (req, res) => {
  const cursor = users.find({})
  const result = await cursor.toArray()
  res.send(result)
})
app.listen(port, () => {
  console.log(`server is running ${port}`)
})

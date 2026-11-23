import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb'

const app = express()

app.use(express.json())
app.use(cors())

const port = process.env.PORT || 5001

const client = new MongoClient(
  `mongodb://${process.env.MONGO_DB_USER}:${process.env.MONGO_DB_PASS}@ac-djrpurl-shard-00-00.7xnwnzw.mongodb.net:27017,ac-djrpurl-shard-00-01.7xnwnzw.mongodb.net:27017,ac-djrpurl-shard-00-02.7xnwnzw.mongodb.net:27017/?ssl=true&replicaSet=atlas-viv4el-shard-0&authSource=admin`,
)

const connectionClient = await client.connect()

console.log('You successfully connected to MongoDB!')

const database = connectionClient.db('pizza-hub')

const users = database.collection('user')
const menuItems = database.collection('menuItems')

console.log('MongoDB Connected')

app.get('/', (req, res) => {
  res.send({
    success: true,
    message: 'PizzaHub API is working',
  })
})

app.get('/users', async (req, res) => {
  try {
    const result = await users.find({}).toArray()
    res.status(200).send(result)
  } catch (error) {
    console.log(error)
    res.status(500).send({
      success: false,
      message: 'Failed to get users',
    })
  }
})

app.get('/menuItem', async (req, res) => {
  try {
    const result = await menuItems.find({}).toArray()
    res.status(200).send(result)
  } catch (error) {
    console.log(error)
    res.status(500).send({
      success: false,
      message: 'Failed to get menu items',
    })
  }
})

app.post('/menuItem', async (req, res) => {
  try {
    const menu = req.body

    if (
      !menu.pizzaName ||
      !menu.category ||
      menu.price === undefined ||
      !menu.preparationTime ||
      !menu.availableDate ||
      !menu.imageUrl ||
      !menu.description
    ) {
      return res.status(400).send({
        success: false,
        message: 'Please provide all menu information',
      })
    }

    const result = await menuItems.insertOne(menu)

    res.status(201).send({
      success: true,
      message: 'Menu item created successfully',
      insertedId: result.insertedId,
    })
  } catch (error) {
    console.log(error)
    res.status(500).send({
      success: false,
      message: 'Failed to create menu item',
    })
  }
})

app.put('/menuItem/:id', async (req, res) => {
  try {
    const { id } = req.params

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: 'Invalid menu item ID',
      })
    }

    const {
      pizzaName,
      category,
      price,
      preparationTime,
      availableDate,
      imageUrl,
      description,
    } = req.body

    const result = await menuItems.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          pizzaName,
          category,
          price: Number(price),
          preparationTime,
          availableDate,
          imageUrl,
          description,
        },
      },
    )

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: 'Menu item not found',
      })
    }

    res.status(200).send({
      success: true,
      message: 'Menu item updated successfully',
    })
  } catch (error) {
    console.log(error)
    res.status(500).send({
      success: false,
      message: 'Failed to update menu item',
    })
  }
})

app.delete('/menuItem/:id', async (req, res) => {
  try {
    const { id } = req.params

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: 'Invalid menu item ID',
      })
    }

    const result = await menuItems.deleteOne({
      _id: new ObjectId(id),
    })

    if (result.deletedCount === 0) {
      return res.status(404).send({
        success: false,
        message: 'Menu item not found',
      })
    }

    res.status(200).send({
      success: true,
      message: 'Menu item deleted successfully',
    })
  } catch (error) {
    console.log(error)
    res.status(500).send({
      success: false,
      message: 'Failed to delete menu item',
    })
  }
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})

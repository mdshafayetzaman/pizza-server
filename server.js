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

const startServer = async () => {
  try {
    const connectionClient = await client.connect()

    console.log('You successfully connected to MongoDB!')

    const database = connectionClient.db('pizza-hub')

    const users = database.collection('user')
    const menuItems = database.collection('menuItems')

    console.log('MongoDB Connected')

    app.get('/', (req, res) => {
      res.status(200).send({
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
        const query = {}

        if (req.query.menuType) {
          query.menuType = req.query.menuType
        }

        if (req.query.category) {
          query.category = req.query.category
        }

        if (req.query.search) {
          query.pizzaName = {
            $regex: req.query.search,
            $options: 'i',
          }
        }

        const result = await menuItems.find(query).toArray()

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

        const price = Number(menu.price)

        if (!Number.isFinite(price) || price < 0) {
          return res.status(400).send({
            success: false,
            message: 'Please provide a valid price',
          })
        }

        const newMenu = {
          ...menu,
          pizzaName: menu.pizzaName.trim(),
          category: menu.category.trim(),
          price,
          createdAt: new Date(),
        }

        const result = await menuItems.insertOne(newMenu)

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

        if (
          !pizzaName?.trim() ||
          !category?.trim() ||
          price === undefined ||
          !preparationTime ||
          !availableDate ||
          !imageUrl ||
          !description?.trim()
        ) {
          return res.status(400).send({
            success: false,
            message: 'Please provide all menu information',
          })
        }

        const numericPrice = Number(price)

        if (!Number.isFinite(numericPrice) || numericPrice < 0) {
          return res.status(400).send({
            success: false,
            message: 'Please provide a valid price',
          })
        }

        const result = await menuItems.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              pizzaName: pizzaName.trim(),
              category: category.trim(),
              price: numericPrice,
              preparationTime,
              availableDate,
              imageUrl,
              description: description.trim(),
              updatedAt: new Date(),
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
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error)
    process.exit(1)
  }
}

startServer()

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'


const app = express();
const port = 5001;
app.get('/', (req, res) => {
  send.res({msg:"api is working"})
})
app.listen(port, () => {
  console.log(`server is running ${port}`)
})

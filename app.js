const express = require('express');
const cors = require('cors');
const routes = require('./routes');  // Import your routes
const app = express();
app.use(cors());
const port = 3000;
require('dotenv').config();

app.use('/', routes);  // Use your routes as middleware

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`)
});

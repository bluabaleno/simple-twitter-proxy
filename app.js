// app.js
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors({ origin: true }));
require('dotenv').config();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "https://myfrens.xyz",
    methods: ["GET", "POST"]
  }
});

// Set io on app
app.set('io', io);

// Pass app to routes
const routes = require('./routes')(app);  // Import your routes

app.use('/', routes);  // Use your routes as middleware

io.on('connection', (socket) => {
  console.log('a user connected');
});

const PORT = process.env.PORT || 3001; // default to 3001 if process.env.PORT is not set
http.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
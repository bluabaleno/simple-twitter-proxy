// app.js
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
require('dotenv').config();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "http://192.168.43.235:3001",
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

http.listen(3000, '0.0.0.0', () => {
  console.log('Server running at http://0.0.0.0:3000');
});

require('dotenv').config();

// routes.js
module.exports = function(app) {
  const express = require('express');
  const session = require('express-session');
  const router = express.Router();
  router.use(express.json()); // Add this line
  const Twit = require('twit');
  const db = require('./auradb');  // Import your database operations
  const { saveCommonUsersToNeo4j, addParticipantToSession, checkIfUserExistsInAuraDB, addFollowsRelationships } = require('./auradb');
  const axios = require('axios'); // Import axios if not done yet
  const graphql_endpoint = "https://master.graphql.knn3.xyz/graphql";

  const passport = require('passport');
  const TwitterStrategy = require('passport-twitter').Strategy;

  // Configure the session
  app.use(session({
    secret: 'testing kitties',  // A random string do not disclose this to anyone
    resave: false,
    saveUninitialized: true,
    cookie: { secure: true }
  }));

  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(new TwitterStrategy({
    consumerKey: process.env.TWITTER_CONSUMER_KEY,
    consumerSecret: process.env.TWITTER_CONSUMER_SECRET,
    callbackURL: "https://simple-twitter-server.herokuapp.com/twitter/callback",
  },
  function(token, tokenSecret, profile, done) {
    console.log('Your access token:', token);
    console.log('Your token secret:', tokenSecret);
    done(null, profile);
  }
));

  passport.serializeUser(function(user, done) {
    done(null, user);
  });

  passport.deserializeUser(function(user, done) {
    done(null, user);
  });

  // Initiate the login process
  router.get('/twitter/login', passport.authenticate('twitter'));

  // Handle the callback from Twitter
  router.get('/twitter/callback', 
    passport.authenticate('twitter', { failureRedirect: '/login' }),
    function(req, res) {
      // Successful authentication, redirect home.
      res.redirect('/');
    });

  const T = new Twit({
    consumer_key:         process.env.TWITTER_CONSUMER_KEY,
    consumer_secret:      process.env.TWITTER_CONSUMER_SECRET,
    access_token:         process.env.TWITTER_ACCESS_TOKEN,
    access_token_secret:  process.env.TWITTER_ACCESS_TOKEN_SECRET,
    bearer_token:         process.env.TWITTER_BEARER_TOKEN,
    timeout_ms:           60*1000,  // optional HTTP request timeout to apply to all requests.
  });

  async function query_data(address) {
    const query = `
    {
      addrs(where:{address:"${address}"}, options:{limit:30}) {
          address
          ens
          holdNfts(options:{limit:30}) {
              name
              contract
              symbol
          }
          holdTokens(options:{limit:30}) {
              name
              symbol
          }
          attendEvents(options:{limit:30}) {
              name
              id
          }
          holdPolygonNfts(options:{limit:30}){
              name
              symbol
              nftCount
              contract
          }
          holdPolygonTokens(options:{limit:30}){
              name
              symbol
              tokenCount
              contract
          }
      }
  }`
  ;
  
    try {
      const response = await axios.post(
        graphql_endpoint, 
        { query: query },
        { headers: { 'Content-Type': 'application/json' } }
      );
      if (response.status != 200) {
        throw new Error(`HTTP error: ${response.status}`);
      }
      return response.data.data.addrs;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  router.get('/userInfo/:username', (req, res) => {
    T.get('users/show', { screen_name: req.params.username }, function(err, data, response) {
      if (err) {
        res.status(500).send(err);
      } else {
        const userFields = {
          id: data.id,
          name: data.name,
          screen_name: data.screen_name,
          description: data.description,
          profile_image_url: data.profile_image_url.replace('_normal', ''),
          created_at: data.created_at,
          verified: data.verified,
          followers_count: data.followers_count,
          friends_count: data.friends_count
        };
        res.send(userFields);
      }
    });
  });

  function getFriends(username) {
    return new Promise((resolve, reject) => {
      let friends = [];
  
      function fetch(cursor) {
        T.get('friends/ids', { screen_name: username, cursor: cursor }, function(err, data, response) {
          if (err) {
            reject(err);
          } else {
            friends = friends.concat(data.ids);
  
            if (data.next_cursor) {
              fetch(data.next_cursor);
            } else {
              resolve(friends);
            }
          }
        });
      }
  
      fetch(-1);  // Start with the first page
    });
  }
  
  function getFollowers(username) {
    return new Promise((resolve, reject) => {
      let followers = [];
  
      function fetch(cursor) {
        T.get('followers/ids', { screen_name: username, cursor: cursor }, function(err, data, response) {
          if (err) {
            reject(err);
          } else {
            followers = followers.concat(data.ids);
  
            if (data.next_cursor) {
              fetch(data.next_cursor);
            } else {
              resolve(followers);
            }
          }
        });
      }
  
      fetch(-1);  // Start with the first page
    });
  }


  async function getCommonData(username) {
    const [friends, followers] = await Promise.all([
      getFriends(username),
      getFollowers(username)
    ]);
  
    const friendsSet = new Set(friends);
    const common = followers.filter(id => friendsSet.has(id));
  
    console.log('common', common.length);
  
    const commonData = [];
    for (let i = 0; i < common.length; i += 100) {
      const ids = common.slice(i, i + 100).join(',');
      try {
        const usersRes = await T.get('users/lookup', { user_id: ids });
        commonData.push(...usersRes.data.map(data => ({
          id: data.id_str,
          name: data.name,
          screen_name: data.screen_name,
          description: data.description,
          profile_image_url: data.profile_image_url_https.replace('_normal', ''),
          created_at: data.created_at,
          verified: data.verified,
          followers_count: data.followers_count,
          friends_count: data.friends_count
        })));
      } catch (err) {
        console.error(`Error getting user data for IDs: ${ids}`);
        console.error(err);
      }
    }
  
    await saveCommonUsersToNeo4j(commonData);
    return commonData;
  }

  async function sendToJSONBin(data) {
    try {
      const res = await axios.post('https://api.jsonbin.io/v3/b', data, {
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': process.env.JSONBIN_SECRET_KEY,
          'X-Bin-Private': 'false',
        },
      });
      return res.data;
    } catch (err) {
      console.error(`Error sending data to JSONBin: ${err.message}`);
      throw err;
    }
  }

  router.post('/jsonbin', async (req, res) => {
    try {
      const data = req.body;
      const response = await sendToJSONBin(data);
      // Construct the URL of the bin and send it back to the client
      const binUrl = `https://api.jsonbin.io/v3/b/${response.metadata.id}`;
      res.send(binUrl);
    } catch (err) {
      res.status(500).send(`Error sending data to JSONBin: ${err.message}`);
    }
  });
  
  

router.get('/common/:username', async (req, res) => {
    try {
      await getCommonData(req.params.username);
      res.status(200).send('Data fetched successfully');
    } catch (err) {
      console.error(`Error getting friend or follower IDs for user: ${req.params.username}`);
      console.error(err);
      res.status(500).send(err);
    }
  });
  
  router.get('/session/')

  router.get('/session/:sessionName', async (req, res) => {
    try {
      const initialGraph = await db.newInitialGraph(req.params.sessionName);
      res.send(initialGraph);
    } catch (err) {
      console.error(`Error getting initial graph for session: ${req.params.sessionName}`);
      console.error(err);
      res.status(500).send(err);
    }
  });

router.post('/session/:sessionName/addAddress', async (req, res) => {
  console.log('route reached', req.query);
  const sessionName = req.params.sessionName;
  const io = app.get('io');
  try {
    console.log(`Adding user ${req.query.address} to session ${sessionName}`);

    // Ensure the session exists in the database
    await db.ensureSessionExists(sessionName);

    const data = await query_data(req.query.address);
    console.log('processing KNN3 data')
    
    // Assuming data contains all the necessary entities in the right format
    await db.addEntitiesToAddress(data);

    const address = data[0].address;
    await db.addAddressToSession(address, sessionName);
      
    res.status(200).send(`User ${req.query.address} added to session ${sessionName}`); 
  } catch (err) {
    console.error(`Error adding user ${req.query.address} to session ${sessionName}`);
    res.status(500).send(`Error adding user ${req.query.address} to session ${sessionName}`);
  }
  const newData = await db.newInitialGraph(sessionName);
  io.emit('new data', newData);
});

router.get('/session/:sessionName/addUser', async (req, res) => {
  try {
    const sessionName = req.params.sessionName;
    console.log(`Adding user ${req.query.username} to session ${sessionName}`);

    // Ensure the session exists in the database
    await db.ensureSessionExists(sessionName);

    const userInfo = await T.get('users/lookup', { screen_name: req.query.username });
    const userId = userInfo.data[0].id_str;
    const io = app.get('io');

    const ifUserExists = await db.checkIfUserExistsInAuraDB(userId);
    if (!ifUserExists) {
      const userData = {
        id: userInfo.data[0].id_str,
        name: userInfo.data[0].name,
        screen_name: userInfo.data[0].screen_name,
        description: userInfo.data[0].description,
        profile_image_url: userInfo.data[0].profile_image_url_https.replace('_normal', ''),
        created_at: userInfo.data[0].created_at,
        verified: userInfo.data[0].verified,
        followers_count: userInfo.data[0].followers_count,
        friends_count: userInfo.data[0].friends_count
      };
      await db.addUserToAuraDB(userData);
      
      // Emit the event to the client side to update the user interface
      io.emit('user data', userData);
      
      const commonFriends = await getCommonData(req.query.username);
      const friendIds = commonFriends.map(friend => friend.id);
      await db.addFollowsRelationships(userData.id, friendIds);
      
      console.log('Data fetched and saved');
    }

    await db.addParticipantToSession(userId, sessionName);
    const newData = await db.newInitialGraph(sessionName);
    io.emit('new data', newData);
    res.status(200).send(`User ${req.query.username} added to session ${sessionName}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('An error occurred while adding the user to the session.');
  }
});


return router;

};

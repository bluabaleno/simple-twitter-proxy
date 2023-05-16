require('dotenv').config();
const express = require('express');
const router = express.Router();
const Twit = require('twit');
const db = require('./auradb');  // Import your database operations
const { saveCommonUsersToNeo4j, addParticipantToSession } = require('./auradb');


const T = new Twit({
  consumer_key:         process.env.TWITTER_CONSUMER_KEY,
  consumer_secret:      process.env.TWITTER_CONSUMER_SECRET,
  access_token:         process.env.TWITTER_ACCESS_TOKEN,
  access_token_secret:  process.env.TWITTER_ACCESS_TOKEN_SECRET,
  bearer_token:         process.env.TWITTER_BEARER_TOKEN,
  timeout_ms:           60*1000,  // optional HTTP request timeout to apply to all requests.
});

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

router.get('/friends/:username', (req, res) => {
  let friends = [];

  function getFriends(cursor) {
    T.get('friends/ids', { screen_name: req.params.username, cursor: cursor }, function(err, data, response) {
      if (err) {
        res.status(500).send(err);
      } else {
        friends = friends.concat(data.ids);

        if (data.next_cursor) {
          getFriends(data.next_cursor);
        } else {
          res.send(friends);
        }
      }
    });
  }

  getFriends(-1);  // Start with the first page
});


router.get('/followers/:username', (req, res) => {
  let followers = [];

  function getFollowers(cursor) {
    T.get('followers/ids', { screen_name: req.params.username, cursor: cursor }, function(err, data, response) {
      if (err) {
        res.status(500).send(err);
      } else {
        followers = followers.concat(data.ids);

        if (data.next_cursor) {
          getFollowers(data.next_cursor);
        } else {
          res.send(followers);
        }
      }
    });
  }

  getFollowers(-1);  // Start with the first page
});

router.get('/common/:username', async (req, res) => {
  try {
    const friendsRes = await T.get('friends/ids', { screen_name: req.params.username, stringify_ids: true });
    const followersRes = await T.get('followers/ids', { screen_name: req.params.username, stringify_ids: true });

    const friends = friendsRes.data.ids;
    const followers = followersRes.data.ids;

    const common = friends.filter(id => followers.includes(id));

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
    console.log(`Saved ${commonData.length} common users to Neo4j`);
  } catch (err) {
    console.error(`Error getting friend or follower IDs for user: ${req.params.username}`);
    console.error(err);
    res.status(500).send(err);
  }
});

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

router.get('/session/:sessionName/addUser', async (req, res) => {
  try {
    console.log(`Adding user ${req.query.username} to session ${req.params.sessionName}`);
    const userInfo = await T.get('users/lookup', { screen_name: req.query.username });
    const userId = userInfo.data[0].id_str;  // Note the change here
    console.log(`User ID: ${userId}`);
    await db.addParticipantToSession(userId, req.params.sessionName);
    res.status(200).send(`User ${req.query.username} added to session ${req.params.sessionName}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('An error occurred while adding the user to the session.');
  }
});



router.get('/session/')


module.exports = router;

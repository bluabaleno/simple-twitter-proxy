require('dotenv').config();

const neo4j = require('neo4j-driver');

const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic('neo4j', process.env.NEO4J_PASSWORD));

async function addParticipantToSession(participantId, sessionName) {
  const session = driver.session();
  const cypherQuery = `
  MATCH (p:Person {id: $participantId}), (s:Session {name: $sessionName})
  MERGE (s)-[:HAS_PARTICIPANT]->(p)
  `;

  try {
    await session.run(cypherQuery, { participantId, sessionName });
  } catch (error) {
    console.error('Error adding participant to session:', error);
  } finally {
    await session.close();
  }
  console.log('Participant added to session', participantId, sessionName);
}

// Merged addParticipantAndFetchNewData function
async function addParticipantAndFetchNewData(participantId, sessionName) {
  const session = driver.session();
  const cypherQuery = `
  MATCH (p:Person {id: $participantId}), (s:Session {name: $sessionName})
  MATCH (s)-[:HAS_PARTICIPANT]->(otherParticipant:Person)
  WHERE otherParticipant <> p
  MATCH (p)-[:FOLLOWS]->(commonFriend:Person)<-[:FOLLOWS]-(otherParticipant)
  RETURN p, otherParticipant, commonFriend  
  `;

  try {
    const result = await session.run(cypherQuery, { participantId, sessionName });
    const newData = result.records.map((record) => ({
      participant: {
        ...record.get('p').properties,
        id: record.get('p').identity.toInt(),
      },
      otherParticipant: {
        ...record.get('otherParticipant').properties,
        id: record.get('otherParticipant').identity.toInt(),
      },
      commonFriend: {
        ...record.get('commonFriend').properties,
        id: record.get('commonFriend').identity.toInt(),
      },
    }));

    return newData;
  } catch (error) {
    console.error(error);
  } finally {
    session.close();
  }
}

const saveCommonUsersToNeo4j = async (commonUsersInfo) => {
  const session = driver.session();
  const lastUpdated = Math.floor(Date.now() / 1000); // Get current UNIX timestamp
  const lastUpdatedLocal = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  try {
    await session.writeTransaction(async (tx) => {
      const commonUsersParams = commonUsersInfo.map((userInfo) => {
        return {
          id: String(userInfo.id),
          name: userInfo.name,
          screen_name: userInfo.screen_name.toLowerCase(),
          description: userInfo.description,
          profile_image_url: userInfo.profile_image_url,
          created_at: userInfo.created_at,
          verified: userInfo.verified,
          followers_count: userInfo.followers_count,
          friends_count: userInfo.friends_count,
          lastUpdated: lastUpdated,
          lastUpdatedLocal: lastUpdatedLocal,
        };
      });

      await tx.run(
        `
          UNWIND $commonUsersParams AS param
          MERGE (user:Person {id: param.id})
          SET user += {
            name: param.name,
            screen_name: param.screen_name,
            description: param.description,
            profile_image_url: param.profile_image_url,
            created_at: param.created_at,
            verified: param.verified,
            followers_count: param.followers_count,
            friends_count: param.friends_count,
            lastUpdated: $lastUpdated,
            lastUpdatedLocal: $lastUpdatedLocal
          }
        `,
        { commonUsersParams, lastUpdated, lastUpdatedLocal }
      );
    });

  } catch (error) {
    console.error('An error occurred while saving data to Neo4j:', error);
  } finally {
    await session.close();
  }
};

async function getSessionEndDate(sessionName) {
  if (!sessionName || typeof sessionName !== 'string') {
    throw new Error('Invalid session name');
  }

  const session = driver.session();
  const getSessionEndDateCypher = 'MATCH (s:Session {name: $sessionName}) RETURN s.endDate';

  try {
    const endDate = await session.run(getSessionEndDateCypher, { sessionName }).then(result => {
      if (result.records.length === 0) {
        throw new Error('No session found with the given name');
      }
      return result.records[0].get('s.endDate'); // Reverted back to 's.endDate'
    });
    console.log('endDate:', endDate);
    return endDate;
  } catch (error) {
    console.error('Error fetching session end date:', error);
    throw error;
  } finally {
    await session.close();
  }
}

const logUserAddressAndScreenName = async (address, screenName) => {
  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  const formattedTimestampLocal = now.toISOString().replace('T', ' ').substr(0, 19);
  const userAddressInfo = { address, screenName, timestamp, timestampLocal: formattedTimestampLocal };
  const createUserAddressCypher = 'CREATE (:SearchAddress $userAddressInfo)';

  const session = driver.session();
  try {
    await session.writeTransaction(async (tx) => {
      return await tx.run(createUserAddressCypher, { userAddressInfo });
    });
  } catch (error) {
    console.error('An error occurred while logging the user address and screen name in Neo4j AuraDB:', error);
  } finally {
    await session.close();
  }
};

const checkIfUserExistsInAuraDB = async (screenName) => {
  const session = driver.session();
  let userExists = false;

  screenName = screenName.toLowerCase();

  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  const formattedTimestampLocal = now.toISOString().replace('T', ' ').substr(0, 19);
  const searchQuery = { text: screenName, timestamp, timestampLocal: formattedTimestampLocal };
  const createSearchQueryCypher = 'CREATE (:SearchQuery $searchQuery)';

  const updateThreshold = 86400; // 2 weeks in seconds

  try {
    const result = await session.readTransaction(async (tx) => {
      const query = `
        MATCH (p:Person {screen_name: $screenName})
        RETURN p.screen_name AS screen_name, p.lastUpdated AS lastUpdated
      `;
      return await tx.run(query, { screenName });
    });
    console.log('result.records', result.records);
    if (result.records.length > 0) {
      const lastUpdated = result.records[0].get('lastUpdated');
      const timeSinceLastUpdate = timestamp - lastUpdated;
      userExists = timeSinceLastUpdate < updateThreshold;
    }

    // Run the createSearchQueryCypher regardless of userExists
    await session.writeTransaction(async (tx) => {
      return await tx.run(createSearchQueryCypher, { searchQuery });
    });

  } catch (error) {
    console.error('An error occurred while checking if the user exists in Neo4j AuraDB:', error);
  } finally {
    await session.close();
  }

  return userExists;
};

async function newInitialGraph(sessionName) {
  console.log('newInitialGraph called');
  const session = driver.session();
  const cypherQuery = `
  MATCH (s:Session {name: $sessionName})-[:HAS_PARTICIPANT]->(p:Person)
  WITH collect(p) as participants
  UNWIND participants as p1
  UNWIND participants as p2
  WITH p1, p2
  WHERE p1 <> p2
  OPTIONAL MATCH (p1)-[:FOLLOWS]->(commonFriend:Person)<-[:FOLLOWS]-(p2)
  WITH p1, p2, commonFriend
  RETURN p1, p2, commonFriend
  `;

  const fetchedData = [];

  try {
    const result = await session.run(cypherQuery, { sessionName: sessionName });
    console.log('result.records', result.records);

    result.records.forEach((record) => {
      const participant1Id = record.get('p1').identity.toInt();
      const participant2Id = record.get('p2').identity.toInt();
      const commonFriendNode = record.get('commonFriend');
    
      let commonFriend = null;
      if (commonFriendNode) {
        const commonFriendId = commonFriendNode.identity.toInt();
        commonFriend = {
          id: commonFriendId,
          name: commonFriendNode.properties.name,
          screen_name: commonFriendNode.properties.screen_name,
          description: commonFriendNode.properties.description,
          friends_count: commonFriendNode.properties.friends_count,
          followers_count: commonFriendNode.properties.followers_count,
          profile_image_url: commonFriendNode.properties.profile_image_url || 'src/twitter.png',
        };
      }
    
      fetchedData.push({
        participant: {
          id: participant1Id,
          name: record.get('p1').properties.name,
          screen_name: record.get('p1').properties.screen_name,
          description: record.get('p1').properties.description,
          friends_count: record.get('p1').properties.friends_count,
          followers_count: record.get('p1').properties.followers_count,
          profile_image_url: record.get('p1').properties.profile_image_url || 'src/twitter.png',
        },
        otherParticipant: {
          id: participant2Id,
          name: record.get('p2').properties.name,
          screen_name: record.get('p2').properties.screen_name,
          description: record.get('p2').properties.description,
          friends_count: record.get('p2').properties.friends_count,
          followers_count: record.get('p2').properties.followers_count,
          profile_image_url: record.get('p2').properties.profile_image_url || 'src/twitter.png',
        },
        commonFriend: commonFriend,
      });
    });
  } catch (error) {
    console.log('Error executing cypher query');
    console.error(error);
  } finally {
    session.close();
  }
  return fetchedData;
}

module.exports = { saveCommonUsersToNeo4j, getSessionEndDate, logUserAddressAndScreenName, checkIfUserExistsInAuraDB, newInitialGraph, addParticipantToSession, addParticipantAndFetchNewData };

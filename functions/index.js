/**
 * functions/index.js
 * Backend logic for Loch Lomond Travel App
 * Updated for Cloud Functions Gen 2 (v2) - Region Fix
 */

const { onValueCreated, onValueUpdated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
const { Expo } = require("expo-server-sdk");

// Initialize Firebase Admin
admin.initializeApp();

// Initialize Expo SDK
const expo = new Expo();

/**
 * Trigger: When a new message is added to /chats/{tourId}/messages/{messageId}
 */
exports.sendChatNotification = onValueCreated(
  {
    // 1. Configuration Object
    ref: "/chats/{tourId}/messages/{messageId}",
    
    // FIX: Match the region of your Realtime Database (Belgium)
    region: "europe-west1", 
    
    // FIX: Explicitly target your specific database instance 
    // (This matches the ID found in your firebase.js config)
    instance: "loch-lomond-travel-default-rtdb",
    
    maxInstances: 10,
  },
  async (event) => {
    // 2. Data Access
    const snapshot = event.data;
    if (!snapshot) {
        console.log("No data associated with the event");
        return;
    }
    
    const messageData = snapshot.val();
    
    // 3. Params Access
    const tourId = event.params.tourId;
    
    const senderId = messageData.senderId;
    const messageText = messageData.text;
    const senderName = messageData.senderName;

    console.log(`New message in tour ${tourId} from ${senderName} (Gen 2)`);

    try {
      // 1. Get Tour Details
      const tourSnapshot = await admin.database().ref(`/tours/${tourId}`).once("value");
      const tourData = tourSnapshot.val();
      const tourName = tourData?.name || "Tour Chat";

      // 2. Get Participants
      const participantsSnapshot = await admin.database()
        .ref(`/tours/${tourId}/participants`)
        .once("value");

      if (!participantsSnapshot.exists()) {
        console.log("No participants found for this tour.");
        return null;
      }

      const participants = participantsSnapshot.val();
      const pushMessages = [];

      // 3. Loop through participants
      const participantIds = Object.keys(participants);
      
      const userFetchPromises = participantIds.map(async (userId) => {
        // A. Don't notify sender
        if (userId === senderId) return;

        // B. Fetch User Profile
        const userSnapshot = await admin.database().ref(`/users/${userId}`).once("value");
        const userData = userSnapshot.val();

        if (!userData || !userData.pushToken) {
          console.log(`No token for user ${userId}`);
          return;
        }

        // C. Check Preferences
        const wantsChatUpdates = userData.preferences?.ops?.group_chat ?? true;

        if (!wantsChatUpdates) {
          console.log(`User ${userId} has muted chat notifications.`);
          return;
        }

        // D. Validate Token
        if (!Expo.isExpoPushToken(userData.pushToken)) {
          console.error(`Push token ${userData.pushToken} is invalid`);
          return;
        }

        pushMessages.push({
          to: userData.pushToken,
          sound: "default",
          title: `New message in ${tourName}`,
          body: `${senderName}: ${messageText}`,
          data: { 
            tourId: tourId,
            screen: "Chat" 
          },
        });
      });

      await Promise.all(userFetchPromises);

      // 4. Send via Expo
      if (pushMessages.length > 0) {
        const chunks = expo.chunkPushNotifications(pushMessages);
        const tickets = [];

        for (let chunk of chunks) {
          try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            tickets.push(...ticketChunk);
          } catch (error) {
            console.error("Error sending chunk", error);
          }
        }
        console.log(`Sent ${tickets.length} notifications successfully.`);
      } else {
        console.log("No valid recipients found.");
      }
      
      return null;

    } catch (error) {
      console.error("Error in sendChatNotification:", error);
      return null;
    }
  }
);
/**
 * Trigger: When the itinerary is updated at /tours/{tourId}/itinerary
 */
exports.sendItineraryNotification = onValueUpdated(
  {
    ref: "/tours/{tourId}/itinerary",
    region: "europe-west1",
    instance: "loch-lomond-travel-default-rtdb",
    maxInstances: 10,
  },
  async (event) => {
    // 1. Data Access
    const tourId = event.params.tourId;
    
    // We don't necessarily need the full itinerary data for the alert, 
    // just knowing it changed is enough.
    console.log(`Itinerary updated for tour ${tourId}`);

    try {
      // 2. Get Tour Name (for a nice alert title)
      const nameSnapshot = await admin.database().ref(`/tours/${tourId}/name`).once("value");
      const tourName = nameSnapshot.val() || "Your Tour";

      // 3. Get List of Participants
      const participantsSnapshot = await admin.database()
        .ref(`/tours/${tourId}/participants`)
        .once("value");

      if (!participantsSnapshot.exists()) {
        console.log("No participants found for this tour.");
        return null;
      }

      const participants = participantsSnapshot.val();
      const pushMessages = [];

      // 4. Loop through participants
      const participantIds = Object.keys(participants);
      
      const userFetchPromises = participantIds.map(async (userId) => {
        // A. Fetch User Profile
        const userSnapshot = await admin.database().ref(`/users/${userId}`).once("value");
        const userData = userSnapshot.val();

        if (!userData || !userData.pushToken) return;

        // B. Check Preferences (Default to TRUE if not set)
        // matches keys in NotificationPreferencesScreen.js
        const wantsUpdates = userData.preferences?.ops?.itinerary_changes ?? true; 

        if (!wantsUpdates) {
          console.log(`User ${userId} opted out of itinerary updates.`);
          return;
        }

        // C. Validate Token
        if (!Expo.isExpoPushToken(userData.pushToken)) {
          console.error(`Invalid token for user ${userId}`);
          return;
        }

        pushMessages.push({
          to: userData.pushToken,
          sound: "default",
          title: "📅 Itinerary Update",
          body: `The schedule for ${tourName} has been updated. Tap to see the changes.`,
          data: { 
            tourId: tourId,
            screen: "Itinerary" // Direct navigation link
          },
        });
      });

      await Promise.all(userFetchPromises);

      // 5. Send via Expo
      if (pushMessages.length > 0) {
        const chunks = expo.chunkPushNotifications(pushMessages);
        const tickets = [];

        for (let chunk of chunks) {
          try {
            await expo.sendPushNotificationsAsync(chunk);
          } catch (error) {
            console.error("Error sending chunk", error);
          }
        }
        console.log(`Sent ${pushMessages.length} itinerary alerts.`);
      }
      
      return null;

    } catch (error) {
      console.error("Error in sendItineraryNotification:", error);
      return null;
    }
  }
);
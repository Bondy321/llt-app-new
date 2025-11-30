/**
 * functions/index.js
 * Backend logic for Loch Lomond Travel App
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { Expo } = require("expo-server-sdk");

// Initialize Firebase Admin
admin.initializeApp();

// Initialize Expo SDK
const expo = new Expo();

/**
 * Trigger: When a new message is added to /chats/{tourId}/messages/{messageId}
 */
exports.sendChatNotification = functions.database
  .ref("/chats/{tourId}/messages/{messageId}")
  .onCreate(async (snapshot, context) => {
    const messageData = snapshot.val();
    const tourId = context.params.tourId;
    const senderId = messageData.senderId;
    const messageText = messageData.text;
    const senderName = messageData.senderName;

    console.log(`New message in tour ${tourId} from ${senderName}`);

    try {
      // 1. Get Tour Details (for the notification title)
      const tourSnapshot = await admin.database().ref(`/tours/${tourId}`).once("value");
      const tourData = tourSnapshot.val();
      const tourName = tourData?.name || "Tour Chat";

      // 2. Get List of Participants for this Tour
      // Based on your joinTour logic, participants are stored at /tours/{tourId}/participants/{userId}
      const participantsSnapshot = await admin.database()
        .ref(`/tours/${tourId}/participants`)
        .once("value");

      if (!participantsSnapshot.exists()) {
        console.log("No participants found for this tour.");
        return null;
      }

      const participants = participantsSnapshot.val();
      const pushMessages = [];

      // 3. Loop through every participant to determine if we should notify them
      const participantIds = Object.keys(participants);
      
      const userFetchPromises = participantIds.map(async (userId) => {
        // A. Don't notify the person who sent the message
        if (userId === senderId) return;

        // B. Fetch their User Profile (Push Token & Preferences)
        const userSnapshot = await admin.database().ref(`/users/${userId}`).once("value");
        const userData = userSnapshot.val();

        if (!userData || !userData.pushToken) {
          console.log(`No token for user ${userId}`);
          return;
        }

        // C. Check Preferences
        // Default to TRUE if the preference hasn't been set yet
        const wantsChatUpdates = userData.preferences?.ops?.group_chat ?? true;

        if (!wantsChatUpdates) {
          console.log(`User ${userId} has muted chat notifications.`);
          return;
        }

        // D. Validate Token and Add to Send List
        if (!Expo.isExpoPushToken(userData.pushToken)) {
          console.error(`Push token ${userData.pushToken} is not a valid Expo push token`);
          return;
        }

        pushMessages.push({
          to: userData.pushToken,
          sound: "default",
          title: `New message in ${tourName}`,
          body: `${senderName}: ${messageText}`,
          data: { 
            tourId: tourId,
            screen: "Chat" // Used for navigation when tapping the alert
          },
        });
      });

      // Wait for all user checks to complete
      await Promise.all(userFetchPromises);

      // 4. Send the Notifications via Expo
      // Expo handles batching automatically, but we use chunks just in case
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
      return null;

    } catch (error) {
      console.error("Error in sendChatNotification:", error);
      return null;
    }
  });
# Security Configuration Guide

This document outlines the security measures implemented in the Loch Lomond Travel application and provides instructions for secure deployment.

## Admin User Setup

The application uses a dynamic admin system instead of hardcoded admin UIDs. To grant admin privileges to a user:

### Step 1: Get the User's Firebase UID

When a user signs into the web admin portal, their Firebase UID can be found:
- In the Firebase Console > Authentication > Users
- The UID is displayed next to each user's email

### Step 2: Add Admin to Database

Using the Firebase Console or Firebase CLI, add the user's UID to the `/admins` path:

```json
{
  "admins": {
    "USER_FIREBASE_UID_HERE": true
  }
}
```

**Example using Firebase CLI:**
```bash
firebase database:set /admins/abc123xyz789 --data '"true"' --project your-project-id
```

**Or via Firebase Console:**
1. Go to Firebase Console > Realtime Database
2. Navigate to the root
3. Add a new child called `admins`
4. Under `admins`, add the user's UID as a key with value `true`

### Important Notes

- Admin status is checked dynamically via database rules
- Only admins added to `/admins` can modify tours, view all user data, or manage drivers
- The `/admins` node has write protection (`.write": false`) - changes must be made via Firebase Console or Admin SDK

## Environment Configuration

### Production Environment

For production builds, ensure the following environment variable is set:

```env
EXPO_PUBLIC_APP_ENV=production
```

This disables verbose console logging that could expose sensitive information in production builds.

### Required Environment Variables

See `.env.example` for all required Firebase configuration variables:

```env
EXPO_PUBLIC_FIREBASE_API_KEY=...
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=...
EXPO_PUBLIC_FIREBASE_DATABASE_URL=...
EXPO_PUBLIC_FIREBASE_PROJECT_ID=...
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=...
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
EXPO_PUBLIC_FIREBASE_APP_ID=...
EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID=...
EXPO_PUBLIC_APP_ENV=production
```

## Database Security Rules

The application uses Firebase Realtime Database rules to enforce security at the database level:

### Key Security Features

1. **Authentication Required**: All paths require authentication (`auth != null`)

2. **Admin-Only Operations**:
   - Creating/modifying tours
   - Reading global safety alerts
   - Viewing all user data
   - Managing driver records

3. **Ownership-Based Access**:
   - Users can only modify their own data
   - Photo deletion requires ownership verification
   - Chat presence/typing only modifiable by owner

4. **Data Validation**:
   - Required fields enforced at database level
   - Type checking (strings, booleans, etc.)
   - Enum validation for status fields
   - Length limits on message content

### Deploying Database Rules

After making changes to `database.rules.json`, deploy with:

```bash
firebase deploy --only database --project your-project-id
```

## File Upload Security

Photo uploads are protected by:

1. **File Type Validation**: Only `image/jpeg`, `image/png`, `image/webp`, and `image/heic` allowed
2. **File Size Limit**: Maximum 10MB per file
3. **Caption Length Limit**: Maximum 500 characters
4. **Ownership Verification**: Users can only delete their own photos

## Rate Limiting

Cloud Functions implement rate limiting to prevent abuse:

- Chat notifications: 20 requests per 60 seconds per user
- Itinerary notifications: 5 updates per 5 minutes per tour

## Security Checklist for Production

Before deploying to production, verify:

- [ ] Environment variables are set (not hardcoded)
- [ ] `EXPO_PUBLIC_APP_ENV=production` is configured
- [ ] Admin users are added to `/admins` in database
- [ ] Database rules are deployed
- [ ] Firebase Authentication is properly configured
- [ ] API keys are restricted in Google Cloud Console
- [ ] HTTPS is enforced for all connections

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly by contacting the development team directly rather than opening a public issue.

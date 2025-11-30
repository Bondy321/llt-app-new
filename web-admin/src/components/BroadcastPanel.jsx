import { useState } from 'react';
import { ref, push, set } from 'firebase/database';
import { db } from '../firebase';

export function BroadcastPanel() {
  const [tourId, setTourId] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSend = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (!tourId || !message) return;

      // 1. Create a reference to the chat messages
      const messagesRef = ref(db, `chats/${tourId}/messages`);
      const newMessageRef = push(messagesRef);

      // 2. Write the message as "HQ" (Headquarters)
      // This will TRIGGER your Cloud Function "sendChatNotification" automatically!
      await set(newMessageRef, {
        text: `📢 ANNOUNCEMENT: ${message}`,
        senderName: "Loch Lomond Travel HQ",
        senderId: "admin_hq_broadcast", // Special ID so it notifies everyone
        timestamp: new Date().toISOString(),
        isDriver: true // Makes it stand out in the app UI
      });

      alert('📢 Announcement Sent! Notifications have been triggered.');
      setMessage('');
    } catch (error) {
      alert(`Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.card}>
      <h2>📢 Broadcast Announcement</h2>
      <p style={{fontSize: '0.9em', color: '#666'}}>This sends a push notification to all passengers on the selected tour.</p>
      <form onSubmit={handleSend} style={styles.form}>
        <input 
          style={styles.input}
          placeholder="Target Tour ID (e.g. tour-123)" 
          value={tourId}
          onChange={e => setTourId(e.target.value)} 
          required 
        />
        <textarea 
          style={{...styles.input, height: '80px'}}
          placeholder="Message (e.g. The bus is arriving in 5 minutes)" 
          value={message}
          onChange={e => setMessage(e.target.value)} 
          required 
        />
        <button type="submit" disabled={loading} style={{...styles.button, background: '#E67E22'}}>
          {loading ? 'Sending...' : 'Send Broadcast'}
        </button>
      </form>
    </div>
  );
}

const styles = {
  card: { border: '1px solid #ddd', padding: '20px', borderRadius: '8px', background: 'white' },
  form: { display: 'flex', flexDirection: 'column', gap: '10px' },
  input: { padding: '10px', fontSize: '16px', borderRadius: '4px', border: '1px solid #ccc' },
  button: { padding: '10px', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }
};
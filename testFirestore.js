// testFirestore.js
import { db } from './firebase';

const testFirestore = async () => {
  try {
    console.log('Testing Firestore connection...');
    const snapshot = await db.collection('tours').get();
    console.log('Found', snapshot.size, 'tours');
    snapshot.forEach(doc => {
      console.log('Tour:', doc.id, doc.data().tourCode);
    });
  } catch (error) {
    console.error('Firestore test error:', error);
  }
};

testFirestore();
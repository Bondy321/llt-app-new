import { useState, useEffect } from 'react';
import { auth } from './firebase';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth';
import { DriversManager } from './components/DriversManager'; // CHANGED IMPORT
import { BroadcastPanel } from './components/BroadcastPanel';
import './App.css';

function App() {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [activeTab, setActiveTab] = useState('drivers'); // 'drivers' or 'broadcast'

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => setUser(user));
  }, []);

  const handleLogin = (e) => {
    e.preventDefault();
    signInWithEmailAndPassword(auth, email, password)
      .catch(err => alert("Login Failed: " + err.message));
  };

  if (!user) {
    return (
      <div style={styles.loginContainer}>
        <div style={styles.loginBox}>
          <h1 style={{color: '#007DC3', textAlign: 'center'}}>Loch Lomond Admin</h1>
          <form onSubmit={handleLogin} style={styles.form}>
            <input type="email" placeholder="Admin Email" onChange={e => setEmail(e.target.value)} style={styles.input} />
            <input type="password" placeholder="Password" onChange={e => setPassword(e.target.value)} style={styles.input} />
            <button type="submit" style={styles.loginButton}>Login</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.appContainer}>
      <header style={styles.header}>
        <h1 style={{margin: 0, fontSize: '1.5em'}}>Loch Lomond Travel Operations</h1>
        <div style={styles.headerRight}>
          <span style={{marginRight: '15px', fontSize: '0.9em'}}>{user.email}</span>
          <button onClick={() => signOut(auth)} style={styles.logoutButton}>Logout</button>
        </div>
      </header>

      {/* Tabs Navigation */}
      <div style={styles.tabs}>
        <button 
          style={activeTab === 'drivers' ? styles.tabActive : styles.tab} 
          onClick={() => setActiveTab('drivers')}
        >
          🚌 Driver Management
        </button>
        <button 
          style={activeTab === 'broadcast' ? styles.tabActive : styles.tab} 
          onClick={() => setActiveTab('broadcast')}
        >
          📢 Broadcast System
        </button>
      </div>
      
      <main style={{padding: '20px'}}>
        {activeTab === 'drivers' ? <DriversManager /> : <BroadcastPanel />}
      </main>
    </div>
  );
}

const styles = {
  loginContainer: { display: 'flex', justifyContent: 'center', marginTop: '100px', fontFamily: 'sans-serif', background: '#f4f4f4', height: '100vh', margin: 0 },
  loginBox: { padding: '40px', background: 'white', borderRadius: '8px', maxWidth: '400px', width: '100%', height: 'fit-content', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' },
  form: { display: 'flex', flexDirection: 'column', gap: '15px' },
  input: { padding: '12px', fontSize: '16px', borderRadius: '4px', border: '1px solid #ccc' },
  loginButton: { padding: '12px', background: '#007DC3', color: 'white', border: 'none', borderRadius: '4px', fontSize: '16px', cursor: 'pointer' },
  
  appContainer: { fontFamily: 'sans-serif', background: '#f0f2f5', minHeight: '100vh' },
  header: { background: '#007DC3', color: 'white', padding: '15px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  logoutButton: { padding: '6px 12px', background: 'rgba(255,255,255,0.2)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' },
  tabs: { background: 'white', borderBottom: '1px solid #ddd', padding: '0 20px' },
  tab: { padding: '15px 20px', background: 'transparent', border: 'none', borderBottom: '3px solid transparent', cursor: 'pointer', fontSize: '1em', color: '#666' },
  tabActive: { padding: '15px 20px', background: 'transparent', border: 'none', borderBottom: '3px solid #007DC3', cursor: 'pointer', fontSize: '1em', color: '#007DC3', fontWeight: 'bold' }
};

export default App;
import { useState, useEffect } from 'react';
import { ref, onValue, update } from 'firebase/database';
import { db } from '../firebase';

export function DriversManager() {
  const [drivers, setDrivers] = useState({});
  const [selectedDriverId, setSelectedDriverId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  
  // New Driver Form State
  const [isCreating, setIsCreating] = useState(false);
  const [newDriverName, setNewDriverName] = useState('');
  const [newDriverCode, setNewDriverCode] = useState('');

  // Edit Driver State
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editActiveTour, setEditActiveTour] = useState('');
  const [newAssignment, setNewAssignment] = useState('');

  // 1. Fetch Drivers on Load
  useEffect(() => {
    const driversRef = ref(db, 'drivers');
    const unsubscribe = onValue(driversRef, (snapshot) => {
      setDrivers(snapshot.val() || {});
    });
    return () => unsubscribe();
  }, []);

  // 2. Handle Selection
  useEffect(() => {
    if (selectedDriverId && drivers[selectedDriverId]) {
      const d = drivers[selectedDriverId];
      setEditName(d.name || '');
      setEditPhone(d.phone || '');
      setEditActiveTour(d.activeTourId || '');
    }
  }, [selectedDriverId, drivers]);

  // 3. Create New Driver
  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newDriverCode || !newDriverName) return;
    
    const code = newDriverCode.trim().toUpperCase();
    const id = code.startsWith('D-') ? code : `D-${code}`;
    
    const updates = {};
    updates[`drivers/${id}`] = {
      name: newDriverName,
      createdAt: new Date().toISOString(),
      assignments: {} 
    };

    try {
      await update(ref(db), updates);
      setIsCreating(false);
      setNewDriverName('');
      setNewDriverCode('');
      setSelectedDriverId(id);
    } catch (error) {
      alert("Error creating driver: " + error.message);
    }
  };

  // 4. Update Driver Details (Syncs name/phone changes to ALL active tours)
  const handleSaveDetails = async () => {
    if (!selectedDriverId) return;
    
    const updates = {};
    // Update the driver profile
    updates[`drivers/${selectedDriverId}/name`] = editName;
    updates[`drivers/${selectedDriverId}/phone`] = editPhone;
    updates[`drivers/${selectedDriverId}/activeTourId`] = editActiveTour;

    // OPTIONAL: If you want name changes to propagate to all assigned tours instantly:
    const currentAssignments = drivers[selectedDriverId]?.assignments || {};
    Object.keys(currentAssignments).forEach(tourId => {
       updates[`tours/${tourId}/driverName`] = editName;
       updates[`tours/${tourId}/driverPhone`] = editPhone;
    });

    try {
      await update(ref(db), updates);
      alert('Details Saved & Synced!');
    } catch (error) {
      alert("Error saving details: " + error.message);
    }
  };

  // 5. Add Tour Assignment (AND update /tours node)
  const handleAddAssignment = async () => {
    if (!newAssignment || !selectedDriverId) return;
    const tourId = newAssignment.trim();
    const driver = drivers[selectedDriverId];

    // Use multi-path updates to ensure consistency
    const updates = {};
    
    // Path 1: Add to Driver's list
    updates[`drivers/${selectedDriverId}/assignments/${tourId}`] = true;
    
    // Path 2: Update the Tour with Driver info
    updates[`tours/${tourId}/driverName`] = driver.name;
    updates[`tours/${tourId}/driverPhone`] = driver.phone || ""; 

    try {
      await update(ref(db), updates);
      setNewAssignment('');
    } catch (error) {
      alert("Error assigning tour: " + error.message);
    }
  };

  // 6. Remove Tour Assignment (AND reset /tours node)
  const handleRemoveAssignment = async (tourId) => {
    if (!window.confirm(`Unassign ${tourId} from this driver? This will reset the tour driver to 'TBA'.`)) return;
    
    const updates = {};
    
    // Path 1: Remove from Driver's list
    updates[`drivers/${selectedDriverId}/assignments/${tourId}`] = null;
    
    // Path 2: Reset the Tour details
    updates[`tours/${tourId}/driverName`] = "TBA";
    updates[`tours/${tourId}/driverPhone`] = "";

    try {
      await update(ref(db), updates);
    } catch (error) {
      alert("Error removing assignment: " + error.message);
    }
  };

  const filteredDriverIds = Object.keys(drivers).filter(id => 
    drivers[id].name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="manager-container">
      {/* LEFT SIDEBAR: DRIVER LIST */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h3>🚌 Drivers ({Object.keys(drivers).length})</h3>
          <button 
            onClick={() => setIsCreating(true)} 
            className="primary" 
            style={{padding: '0.4rem 0.8rem', fontSize: '0.85rem'}}
          >
            + New
          </button>
        </div>
        
        <div className="search-container">
          <input 
            placeholder="Search drivers..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="driver-list">
          {filteredDriverIds.map(id => (
            <div 
              key={id} 
              onClick={() => { setIsCreating(false); setSelectedDriverId(id); }}
              className={`driver-item ${selectedDriverId === id ? 'selected' : ''}`}
            >
              <strong>{drivers[id].name}</strong>
              <small>{id}</small>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT PANEL: EDITOR */}
      <div className="details-panel">
        {isCreating ? (
          <div className="card" style={{ maxWidth: '500px', margin: '0 auto' }}>
            <h2>Add New Driver</h2>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="label">Driver Name</label>
                <input 
                  value={newDriverName} 
                  onChange={e => setNewDriverName(e.target.value)} 
                  placeholder="e.g. John Smith" 
                  required 
                />
              </div>
              <div className="form-group">
                <label className="label">Login Code</label>
                <input 
                  value={newDriverCode} 
                  onChange={e => setNewDriverCode(e.target.value)} 
                  placeholder="e.g. JOHN (will become D-JOHN)" 
                  required 
                />
              </div>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                <button type="button" onClick={() => setIsCreating(false)} className="secondary">Cancel</button>
                <button type="submit" className="primary">Create Driver</button>
              </div>
            </form>
          </div>
        ) : selectedDriverId && drivers[selectedDriverId] ? (
          <div>
            <div className="details-header">
              <h2>Edit Profile: {drivers[selectedDriverId].name}</h2>
              <span className="tag-badge">{selectedDriverId}</span>
            </div>

            {/* MAIN DETAILS CARD */}
            <div className="card">
              <h3>👤 Personal Details</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem' }}>
                <div className="form-group">
                  <label className="label">Full Name</label>
                  <input value={editName} onChange={e => setEditName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="label">Phone Number</label>
                  <input value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="+44..." />
                </div>
                <div className="form-group">
                  <label className="label">Current Active Tour (Live)</label>
                  <input value={editActiveTour} onChange={e => setEditActiveTour(e.target.value)} placeholder="Tour currently being driven" />
                </div>
              </div>
              <div style={{ marginTop: '1rem', textAlign: 'right' }}>
                <button onClick={handleSaveDetails} className="primary">Save Changes</button>
              </div>
            </div>

            {/* TOUR ALLOCATIONS CARD */}
            <div className="card">
              <h3>📅 Allocated Tours</h3>
              <p style={{ color: '#7F8C8D', fontSize: '0.9rem', marginBottom: '1rem' }}>
                Manage the list of tours visible in this driver's history. Adding a tour here will automatically update the tour's "Driver" field.
              </p>
              
              <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', maxWidth: '600px' }}>
                <input 
                  value={newAssignment} 
                  onChange={e => setNewAssignment(e.target.value)} 
                  placeholder="Enter Tour ID (e.g. 5100D_138)"
                />
                <button onClick={handleAddAssignment} className="secondary" style={{ whiteSpace: 'nowrap' }}>
                  Assign Tour
                </button>
              </div>

              <div className="tags-grid">
                {drivers[selectedDriverId].assignments ? (
                  Object.keys(drivers[selectedDriverId].assignments).map(tourId => (
                    <div key={tourId} className="tour-tag">
                      <span>{tourId}</span>
                      <button onClick={() => handleRemoveAssignment(tourId)} className="remove-tag-btn">×</button>
                    </div>
                  ))
                ) : (
                  <p style={{ fontStyle: 'italic', color: '#999' }}>No tours assigned yet.</p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#A0AEC0' }}>
            <h2 style={{ margin: 0, opacity: 0.5 }}>Select a Driver</h2>
            <p>Click on a driver from the sidebar to manage their profile.</p>
          </div>
        )}
      </div>
    </div>
  );
}
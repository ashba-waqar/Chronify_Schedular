/* ============================================================
   StudyFlow — firebase-service.js
   Firebase Integration Layer:
   - Authentication (Google + Anonymous)
   - Real-time Cloud Sync via Firestore onSnapshot
   - Multi-tab IndexedDB Offline Persistence
   - LocalStorage fallback when unconfigured
   ============================================================ */

'use strict';

// Default Firebase Configuration Template
// Replace these values with your actual Firebase Project credentials
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const CloudSync = {
  isInitialized: false,
  isConfigured: false,
  currentUser: null,
  syncStatus: 'offline', // 'synced' | 'syncing' | 'offline' | 'unconfigured' | 'error'
  listeners: [],
  onSyncStatusChange: null,
  onTasksUpdated: null,
  onSettingsUpdated: null,
  onStatsUpdated: null,

  init(customConfig = null, callbacks = {}) {
    this.onSyncStatusChange = callbacks.onSyncStatusChange || null;
    this.onTasksUpdated = callbacks.onTasksUpdated || null;
    this.onSettingsUpdated = callbacks.onSettingsUpdated || null;
    this.onStatsUpdated = callbacks.onStatsUpdated || null;

    // Check if Firebase CDN scripts are loaded
    if (typeof firebase === 'undefined') {
      console.warn('Firebase SDK not loaded. Operating in LocalStorage-only mode.');
      this.updateStatus('unconfigured');
      return false;
    }

    const config = customConfig || DB.load('sf_firebase_config', null) || DEFAULT_FIREBASE_CONFIG;
    
    // Check if config has placeholder values
    if (config.apiKey === 'YOUR_API_KEY' || !config.apiKey) {
      console.info('Firebase credentials unconfigured. Using LocalStorage fallback mode.');
      this.updateStatus('unconfigured');
      return false;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      
      const db = firebase.firestore();
      
      // Enable multi-tab offline persistence
      db.enablePersistence({ synchronizeTabs: true })
        .then(() => {
          console.log('Firestore multi-tab offline persistence enabled.');
        })
        .catch(err => {
          if (err.code === 'failed-precondition') {
            console.warn('Persistence failed: Multiple tabs open simultaneously without multi-tab support.');
          } else if (err.code === 'unimplemented') {
            console.warn('Persistence unsupported in this browser environment.');
          }
        });

      // Track online/offline browser state
      window.addEventListener('online', () => this.handleNetworkChange(true));
      window.addEventListener('offline', () => this.handleNetworkChange(false));

      // Auth State Listener
      firebase.auth().onAuthStateChanged(user => {
        this.currentUser = user;
        if (user) {
          console.log(`Cloud Sync active for User UID: ${user.uid}`);
          this.updateStatus('synced');
          this.attachRealtimeListeners(user.uid);
        } else {
          console.log('User signed out. Unsubscribing cloud listeners.');
          this.detachRealtimeListeners();
          this.updateStatus('offline');
        }
      });

      this.isInitialized = true;
      this.isConfigured = true;
      return true;

    } catch (err) {
      console.error('Firebase initialization error:', err);
      this.updateStatus('error');
      return false;
    }
  },

  handleNetworkChange(isOnline) {
    if (!isOnline) {
      this.updateStatus('offline');
    } else if (this.currentUser) {
      this.updateStatus('synced');
    }
  },

  updateStatus(status) {
    this.syncStatus = status;
    if (typeof this.onSyncStatusChange === 'function') {
      this.onSyncStatusChange(status, this.currentUser);
    }
  },

  // Auth Methods
  signInWithGoogle() {
    if (!this.isConfigured) return Promise.reject(new Error('Firebase not configured'));
    const provider = new firebase.auth.GoogleAuthProvider();
    this.updateStatus('syncing');
    return firebase.auth().signInWithPopup(provider)
      .catch(err => {
        this.updateStatus('error');
        throw err;
      });
  },

  signInWithEmail(email, password) {
    if (!this.isConfigured) return Promise.reject(new Error('Firebase not configured'));
    this.updateStatus('syncing');
    return firebase.auth().signInWithEmailAndPassword(email, password)
      .catch(err => {
        this.updateStatus('error');
        throw err;
      });
  },

  signUpWithEmail(email, password, displayName = '') {
    if (!this.isConfigured) return Promise.reject(new Error('Firebase not configured'));
    this.updateStatus('syncing');
    return firebase.auth().createUserWithEmailAndPassword(email, password)
      .then(cred => {
        if (displayName && cred.user) {
          return cred.user.updateProfile({ displayName }).then(() => cred);
        }
        return cred;
      })
      .catch(err => {
        this.updateStatus('error');
        throw err;
      });
  },

  signInAnonymously() {
    if (!this.isConfigured) return Promise.reject(new Error('Firebase not configured'));
    this.updateStatus('syncing');
    return firebase.auth().signInAnonymously()
      .catch(err => {
        this.updateStatus('error');
        throw err;
      });
  },

  signOut() {
    if (!this.isConfigured) return Promise.resolve();
    return firebase.auth().signOut();
  },

  // Real-time Cloud Listeners
  attachRealtimeListeners(userId) {
    this.detachRealtimeListeners();
    const db = firebase.firestore();

    // 1. Tasks listener
    const unsubTasks = db.collection('users').doc(userId).collection('tasks')
      .onSnapshot(snapshot => {
        const cloudTasks = [];
        snapshot.forEach(doc => {
          cloudTasks.push({ id: doc.id, ...doc.data() });
        });
        if (typeof this.onTasksUpdated === 'function') {
          this.onTasksUpdated(cloudTasks);
        }
        this.updateStatus('synced');
      }, err => {
        console.error('Error listening to tasks collection:', err);
      });

    // 2. Settings listener
    const unsubSettings = db.collection('users').doc(userId).collection('settings').doc('pomodoro')
      .onSnapshot(doc => {
        if (doc.exists && typeof this.onSettingsUpdated === 'function') {
          this.onSettingsUpdated(doc.data());
        }
      }, err => console.error('Error listening to settings:', err));

    // 3. Stats listener
    const unsubStats = db.collection('users').doc(userId).collection('stats').doc('appStats')
      .onSnapshot(doc => {
        if (doc.exists && typeof this.onStatsUpdated === 'function') {
          this.onStatsUpdated(doc.data());
        }
      }, err => console.error('Error listening to stats:', err));

    this.listeners.push(unsubTasks, unsubSettings, unsubStats);
  },

  detachRealtimeListeners() {
    this.listeners.forEach(unsub => unsub());
    this.listeners = [];
  },

  // Firestore Sync Writes
  syncTask(task) {
    if (!this.currentUser || !this.isConfigured) return Promise.resolve();
    this.updateStatus('syncing');
    const db = firebase.firestore();
    const taskRef = db.collection('users').doc(this.currentUser.uid).collection('tasks').doc(task.id);
    
    // Clean task payload for Firestore
    const payload = { ...task, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    return taskRef.set(payload, { merge: true })
      .then(() => this.updateStatus('synced'))
      .catch(err => {
        console.error('Cloud task sync failed:', err);
        this.updateStatus('error');
      });
  },

  deleteTaskFromCloud(taskId) {
    if (!this.currentUser || !this.isConfigured) return Promise.resolve();
    this.updateStatus('syncing');
    const db = firebase.firestore();
    return db.collection('users').doc(this.currentUser.uid).collection('tasks').doc(taskId).delete()
      .then(() => this.updateStatus('synced'))
      .catch(err => {
        console.error('Cloud task delete failed:', err);
        this.updateStatus('error');
      });
  },

  syncSettings(settings) {
    if (!this.currentUser || !this.isConfigured) return Promise.resolve();
    const db = firebase.firestore();
    return db.collection('users').doc(this.currentUser.uid).collection('settings').doc('pomodoro')
      .set(settings, { merge: true });
  },

  syncStats(stats) {
    if (!this.currentUser || !this.isConfigured) return Promise.resolve();
    const db = firebase.firestore();
    return db.collection('users').doc(this.currentUser.uid).collection('stats').doc('appStats')
      .set(stats, { merge: true });
  },

  // Helper to save custom config credentials from UI
  saveConfig(config) {
    DB.save('sf_firebase_config', config);
    return this.init(config, {
      onSyncStatusChange: this.onSyncStatusChange,
      onTasksUpdated: this.onTasksUpdated,
      onSettingsUpdated: this.onSettingsUpdated,
      onStatsUpdated: this.onStatsUpdated
    });
  }
};

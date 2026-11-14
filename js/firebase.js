// Firebase stores player profiles and the small public-room directory.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, serverTimestamp, deleteDoc,
  collection, onSnapshot, Timestamp
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-database.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC2fDuaCFka3q-3MuGoMWCxQnwzXSiaUig',
  authDomain: 'multiplayergame-70906.firebaseapp.com',
  projectId: 'multiplayergame-70906',
  storageBucket: 'multiplayergame-70906.firebasestorage.app',
  messagingSenderId: '449303847814',
  appId: '1:449303847814:web:a5e5915e47aad5e4110207',
  measurementId: 'G-ET0ZR25PQE',
  databaseURL: 'https://multiplayergame-70906-default-rtdb.europe-west1.firebasedatabase.app'
};

let app = null;
let db = null;
let rtdb = null;

try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  rtdb = getDatabase(app, 'https://multiplayergame-70906-default-rtdb.europe-west1.firebasedatabase.app');
} catch (error) {
  console.warn('Firebase init error:', error);
}

export { app as firebaseApp, rtdb };

export async function initProfileStore() {
  try {
    const auth = getAuth(app);
    let user = await waitForAuthState(auth);
    if (!user) user = (await signInAnonymously(auth)).user;

    return {
      ready: true,
      uid: user.uid,
      async loadProfile() {
        try {
          const snapshot = await getDoc(doc(db, 'users', user.uid));
          return snapshot.exists() ? snapshot.data() : null;
        } catch (error) {
          console.warn('Could not load the Firebase profile:', error);
          return null;
        }
      },
      async saveProfile(profile) {
        await setDoc(doc(db, 'users', user.uid), {
          ...sanitizeProfile(profile), updatedAt: serverTimestamp()
        }, { merge: true });
      },
      async publishRoom(room) {
        const code = String(room.code).toUpperCase();
        await setDoc(doc(db, 'publicRooms', code), {
          code,
          name: String(room.name || 'Room').slice(0, 28),
          hostName: String(room.hostName || 'Player').slice(0, 18),
          ownerId: user.uid,
          players: Math.max(1, Math.min(32, Number(room.players) || 1)),
          hasPassword: Boolean(room.hasPassword),
          updatedAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + 90000)
        });
      },
      async removeRoom(code) {
        await deleteDoc(doc(db, 'publicRooms', String(code).toUpperCase()));
      },
      watchPublicRooms(onRooms, onError = console.warn) {
        return onSnapshot(collection(db, 'publicRooms'), snapshot => {
          const now = Date.now();
          const rooms = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
            .filter(room => room.expiresAt?.toMillis?.() > now)
            .sort((a, b) => (b.players || 0) - (a.players || 0));
          onRooms(rooms);
        }, onError);
      }
    };
  } catch (error) {
    console.warn('Firebase unavailable; local profile saving remains enabled.', error);
    return { ready: false, uid: null, loadProfile: async () => null, saveProfile: async () => { throw error; } };
  }
}

function waitForAuthState(auth) {
  return new Promise(resolve => {
    let unsubscribe = () => {};
    unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe(); resolve(user);
    }, error => {
      unsubscribe(); console.warn('Firebase auth state error:', error); resolve(null);
    });
  });
}

function sanitizeProfile(profile) {
  const name = String(profile.name || 'Player').trim().slice(0, 18) || 'Player';
  const color = /^#[0-9a-f]{6}$/i.test(profile.color) ? profile.color : '#72e4c5';
  return { name, color };
}

// Firebase is used for saved profiles only. Trystero handles live room traffic.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC2fDuaCFka3q-3MuGoMWCxQnwzXSiaUig',
  authDomain: 'multiplayergame-70906.firebaseapp.com',
  projectId: 'multiplayergame-70906',
  storageBucket: 'multiplayergame-70906.firebasestorage.app',
  messagingSenderId: '449303847814',
  appId: '1:449303847814:web:a5e5915e47aad5e4110207',
  measurementId: 'G-ET0ZR25PQE'
};

let firebaseServices = null;

export async function initProfileStore() {
  try {
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);
    let user = await waitForAuthState(auth);
    if (!user) user = (await signInAnonymously(auth)).user;

    firebaseServices = { db, uid: user.uid };
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
        const safeProfile = sanitizeProfile(profile);
        await setDoc(doc(db, 'users', user.uid), {
          ...safeProfile,
          updatedAt: serverTimestamp()
        }, { merge: true });
      }
    };
  } catch (error) {
    console.warn('Firebase profile storage is unavailable; local saving remains enabled.', error);
    return { ready: false, uid: null, loadProfile: async () => null, saveProfile: async () => { throw error; } };
  }
}

function waitForAuthState(auth) {
  return new Promise(resolve => {
    let unsubscribe = () => {};
    unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe();
      resolve(user);
    }, error => {
      unsubscribe();
      console.warn('Firebase auth state error:', error);
      resolve(null);
    });
  });
}

function sanitizeProfile(profile) {
  const name = String(profile.name || 'Player').trim().slice(0, 18) || 'Player';
  const color = /^#[0-9a-f]{6}$/i.test(profile.color) ? profile.color : '#72e4c5';
  return { name, color };
}

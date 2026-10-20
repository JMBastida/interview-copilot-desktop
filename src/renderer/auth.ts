import { initializeApp, getApps, getApp } from 'firebase/app'
import {
  getAuth,
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
  User,
  indexedDBLocalPersistence,
  initializeAuth
} from 'firebase/auth'

// Firebase Public Client Configuration
// Can be customized via Vite environment variables or defaults
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyDemoPublicKeyForInterviewCopilot2026',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'interview-copilot-auth.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'interview-copilot-auth',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'interview-copilot-auth.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '1234567890',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:1234567890:web:abcdef123456'
}

const firebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp()

// Initialize Auth with IndexedDB persistence so session survives app restarts
let authInstance
try {
  authInstance = initializeAuth(firebaseApp, {
    persistence: indexedDBLocalPersistence
  })
} catch {
  // If already initialized
  authInstance = getAuth(firebaseApp)
}

export const auth = authInstance

type AuthChangeCallback = (user: User | null) => void
const authSubscribers: AuthChangeCallback[] = []

export function onAuthStatusChanged(callback: AuthChangeCallback): () => void {
  authSubscribers.push(callback)
  // Call immediately with current state
  callback(auth.currentUser)
  return () => {
    const idx = authSubscribers.indexOf(callback)
    if (idx !== -1) authSubscribers.splice(idx, 1)
  }
}

/**
 * Returns a valid JWT ID token.
 * Firebase automatically refreshes the token if expired.
 */
export async function getValidAuthToken(forceRefresh = false): Promise<string | null> {
  const user = auth.currentUser
  if (!user) return null
  try {
    const idToken = await user.getIdToken(forceRefresh)
    // Synchronize fresh token with Electron main process
    if (window.electronAPI && window.electronAPI.syncAuthToken) {
      window.electronAPI.syncAuthToken(idToken)
    }
    return idToken
  } catch (err) {
    console.error('[Auth] Error getting ID token:', err)
    return null
  }
}

/**
 * Signs out current user
 */
export async function logoutUser(): Promise<void> {
  try {
    await signOut(auth)
    if (window.electronAPI && window.electronAPI.syncAuthToken) {
      window.electronAPI.syncAuthToken('')
    }
  } catch (err) {
    console.error('[Auth] Error signing out:', err)
  }
}

/**
 * Initializes deep link listener and Firebase auth state watcher
 */
export function initializeAuthBridge(): void {
  // 1. Listen for auth state changes and sync with Main process
  onAuthStateChanged(auth, async (user) => {
    console.log('[Auth] State changed. User:', user ? user.uid : 'null')
    if (user) {
      const token = await user.getIdToken()
      if (window.electronAPI && window.electronAPI.syncAuthToken) {
        window.electronAPI.syncAuthToken(token)
      }
    }
    authSubscribers.forEach((cb) => {
      try {
        cb(user)
      } catch (e) {
        console.error('[Auth] Subscriber error:', e)
      }
    })
  })

  // 2. Listen for deep link custom token sent from Main Process
  if (window.electronAPI && window.electronAPI.onCustomToken) {
    window.electronAPI.onCustomToken(async (customToken: string) => {
      console.log('[Auth] Received custom token from Main Process via copilot://')
      try {
        const credential = await signInWithCustomToken(auth, customToken)
        const idToken = await credential.user.getIdToken()
        if (window.electronAPI && window.electronAPI.syncAuthToken) {
          window.electronAPI.syncAuthToken(idToken)
        }
        console.log('[Auth] Signed in successfully via custom token. UID:', credential.user.uid)
      } catch (err) {
        console.error('[Auth] Failed to sign in with custom token:', err)
      }
    })
  }
}

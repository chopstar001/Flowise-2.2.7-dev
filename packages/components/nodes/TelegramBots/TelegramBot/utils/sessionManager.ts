// utils/sessionManager.ts

import { IDManager, IdType } from './idManagement';

export interface SessionInfo {
  sessionId: string;
  userId: string;
  chatId: string;
  lastUpdated: number;
  metadata?: Record<string, any>;
}

export class SessionManager {
  private static instance: SessionManager | null = null;
  private sessions: Map<string, SessionInfo>;
  private storage: Storage | null;

  private constructor() {
    this.sessions = new Map<string, SessionInfo>();
    this.storage = typeof window !== 'undefined' ? window.localStorage : null;
    this.loadFromStorage();
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  getSession(sessionId?: string | null): SessionInfo {
    // If no sessionId provided, get the current session
    if (!sessionId && this.storage) {
      sessionId = this.storage.getItem('currentSessionId');
    }

    let session = sessionId ? this.sessions.get(sessionId) : null;

    if (!session) {
      session = this.createNewSession();
    }

    return session;
  }

  private createNewSession(): SessionInfo {
    const session: SessionInfo = {
      sessionId: IDManager.generateNewId('session'),
      userId: IDManager.generateNewId('user'),
      chatId: IDManager.generateNewId('chat'),
      lastUpdated: Date.now()
    };

    this.sessions.set(session.sessionId, session);
    this.saveToStorage();
    this.setCurrentSession(session.sessionId);

    return session;
  }

  updateSession(updates: Partial<SessionInfo> & { sessionId: string }): void {
    const session = this.sessions.get(updates.sessionId);
    if (session) {
      Object.assign(session, updates, { lastUpdated: Date.now() });
      this.saveToStorage();
    }
  }

  private setCurrentSession(sessionId: string): void {
    if (this.storage) {
      this.storage.setItem('currentSessionId', sessionId);
    }
  }

  private saveToStorage(): void {
    if (this.storage) {
      const serialized = JSON.stringify(Array.from(this.sessions.entries()));
      this.storage.setItem('sessions', serialized);
    }
  }

  private loadFromStorage(): void {
    if (this.storage) {
      const serialized = this.storage.getItem('sessions');
      if (serialized) {
        try {
          const entries = JSON.parse(serialized);
          this.sessions = new Map(entries);
        } catch (error) {
          console.error('Error loading sessions from storage:', error);
          this.sessions = new Map();
        }
      }
    }
  }

  // Helper methods
  getCurrentSessionId(): string | null {
    return this.storage?.getItem('currentSessionId') ?? null;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.saveToStorage();
  }

  clearAllSessions(): void {
    this.sessions.clear();
    this.saveToStorage();
    if (this.storage) {
      this.storage.removeItem('currentSessionId');
    }
  }
}